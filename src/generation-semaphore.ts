/**
 * Concurrent-generation semaphore.
 *
 * The bot now has 5+ surfaces that may invoke Venice independently (mining
 * solve, swarm subtask solve, clarification answer, teaching lesson, bounty
 * application). Each call buffers a large response (up to 40000 tokens for
 * mining_solve) and holds the connection open. Without coordination we can
 * blow the Node heap or exhaust file descriptors.
 *
 * This module provides a single in-process semaphore with priorities. Higher
 * priority waiters are served before lower ones when slots free up.
 *
 * ENV:
 *   BOT_MAX_CONCURRENT_GENERATIONS — default 3
 *
 * Priorities (higher = served first):
 *   100 — mining_solve (our primary earner)
 *    70 — swarm subtask solve
 *    50 — bounty application generation
 *    40 — teaching lesson generation
 *    30 — clarification answer generation
 */
const MAX = Number(process.env.BOT_MAX_CONCURRENT_GENERATIONS ?? 3);

export type GenerationPriority = "mining" | "swarm" | "bounty" | "teaching" | "clarification";

const PRIORITY_RANK: Record<GenerationPriority, number> = {
  mining: 100,
  swarm: 70,
  bounty: 50,
  teaching: 40,
  clarification: 30,
};

interface Waiter {
  priority: number;
  resolve: () => void;
}

let active = 0;
const waiters: Waiter[] = [];

/** Snapshot for telemetry. */
export interface SemaphoreSnapshot {
  active: number;
  capacity: number;
  queued: number;
}

export function semaphoreSnapshot(): SemaphoreSnapshot {
  return { active, capacity: MAX, queued: waiters.length };
}

/**
 * Acquire a generation slot. Resolves once a slot is free. Caller MUST call
 * the returned release function in a `finally` block.
 *
 * Higher-priority waiters preempt lower-priority ones in queue order — i.e.
 * a mining_solve will be served before a queued clarification, even if the
 * clarification was queued first.
 */
export async function acquireGeneration(priority: GenerationPriority): Promise<() => void> {
  const rank = PRIORITY_RANK[priority];
  if (active < MAX) {
    active += 1;
    return release;
  }
  return new Promise<() => void>((resolve) => {
    waiters.push({
      priority: rank,
      resolve: () => {
        active += 1;
        resolve(release);
      },
    });
  });
}

function release(): void {
  active = Math.max(0, active - 1);
  if (waiters.length === 0) return;
  // Pop the highest-priority waiter.
  let bestIdx = 0;
  for (let i = 1; i < waiters.length; i++) {
    if (waiters[i].priority > waiters[bestIdx].priority) bestIdx = i;
  }
  const w = waiters.splice(bestIdx, 1)[0];
  w.resolve();
}

/**
 * Convenience wrapper: run `fn` inside an acquired slot, always releasing on
 * completion or throw. Most generator callers should use this.
 */
export async function withGenerationSlot<T>(
  priority: GenerationPriority,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireGeneration(priority);
  try {
    return await fn();
  } finally {
    release();
  }
}
