/**
 * Swarms — distributed work decomposed into subtasks.
 *
 * Browse + log open subtasks matching our specialization. Auto-claim only with
 * BOT_SWARM_AUTO_CLAIM=1. Auto-submit not implemented — a solve generator
 * would be needed for that, and our existing mining solver is single-prompt.
 *
 * Endpoints:
 *   GET  /v1/swarms                                     — list active swarms
 *   GET  /v1/swarms/:id                                 — detail (members, subtasks)
 *   GET  /v1/swarms/subtasks                            — browse open subtasks
 *   POST /v1/swarms/subtasks/:id/claim                  — claim
 *   POST /v1/swarms/subtasks/:id/submit                 — submit result
 *   POST /v1/swarms/subtasks/:id/heartbeat              — keep claim alive
 *
 * Toggle: BOT_SWARM_LOOP=0 disables. Default ON (browse-only).
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { canAutoWriteNow, recordAutoWrite } from "./quotas.js";
import { withGenerationSlot } from "./generation-semaphore.js";
import { recordAudit } from "./audit.js";

const SWARM_SOLVE_COST = Number(process.env.BOT_SWARM_SOLVE_COST ?? 0.10);

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "swarms.jsonl");

const DAILY_CLAIM_CAP = 2;

export interface SubtaskRow {
  id: string;
  swarmId?: string;
  title?: string;
  description?: string;
  skillTags?: string[];
  rewardAmount?: number;
  rewardToken?: string;
  status?: string;
  deadline?: string;
  claimedBy?: string | null;
}

export interface SwarmRow {
  id: string;
  title?: string;
  goal?: string;
  status?: string;
  memberCount?: number;
  openSubtaskCount?: number;
  createdAt?: string;
}

interface LogEntry {
  ts: string;
  kind: "subtask-candidate" | "subtask-claim" | "subtask-submit" | "subtask-error" | "heartbeat" | "heartbeat-dead";
  subtaskId?: string;
  swarmId?: string;
  title?: string;
  matched?: string[];
  notes?: string;
}

function ourSpecializationTags(): string[] {
  return (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function countClaimsToday(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return readJsonl<LogEntry>(LOG).filter(
    (e) => e.kind === "subtask-claim" && e.ts && new Date(e.ts).getTime() >= cutoff,
  ).length;
}

/** Match swarm subtask's skill tags vs our domains. Returns intersecting tags. */
export function matchSkills(skillTags: string[] | undefined, ours: string[]): string[] {
  if (!skillTags || skillTags.length === 0 || ours.length === 0) return [];
  const ourSet = new Set(ours.map((t) => t.toLowerCase()));
  return skillTags.filter((t) => typeof t === "string" && ourSet.has(t.toLowerCase()));
}

/**
 * Browse + log open subtasks. Auto-claim only when BOT_SWARM_AUTO_CLAIM=1.
 */
export async function runSwarmsTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_SWARM_LOOP === "0") return;

  let subtasks: SubtaskRow[];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/swarms/subtasks?status=open&limit=30`,
    )) as { subtasks?: SubtaskRow[]; items?: SubtaskRow[] };
    subtasks = res.subtasks ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return;
    console.warn(`🐝 swarm subtasks fetch failed: ${msg}`);
    return;
  }

  if (subtasks.length === 0) return;

  const our = ourSpecializationTags();
  const seen = new Set(
    readJsonl<LogEntry>(LOG).filter((e) => e.kind === "subtask-candidate").map((e) => e.subtaskId).filter(Boolean),
  );

  // No skill-tag filter — frontier models can handle most topics. Surface
  // ALL open unclaimed subtasks; tag-match is recorded as a SOFT bonus
  // for ranking (and operator visibility).
  const candidates = subtasks
    .filter((s) => !seen.has(s.id))
    .filter((s) => !s.claimedBy)
    .map((s) => ({ row: s, matched: matchSkills(s.skillTags, our) }))
    // Rank: tag-matches first (specialty bonus), then by reward.
    .sort((a, b) => {
      if (a.matched.length !== b.matched.length) return b.matched.length - a.matched.length;
      return (b.row.rewardAmount ?? 0) - (a.row.rewardAmount ?? 0);
    });

  for (const c of candidates) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "subtask-candidate" as const,
      subtaskId: c.row.id,
      swarmId: c.row.swarmId,
      title: c.row.title?.slice(0, 100),
      matched: c.matched,
    });
    const tagNote = c.matched.length > 0 ? ` skills=[${c.matched.join(",")}]` : "";
    console.log(
      `🐝 swarm subtask: "${(c.row.title ?? c.row.id).slice(0, 50)}" ` +
        `reward=${c.row.rewardAmount ?? "?"}${tagNote}`,
    );
  }

  // Auto-claim path
  if (process.env.BOT_SWARM_AUTO_CLAIM !== "1") return;
  if (countClaimsToday() >= DAILY_CLAIM_CAP) return;
  const top = candidates[0];
  if (!top) return;
  try {
    await runtime.connection.request("POST", `/v1/swarms/subtasks/${encodeURIComponent(top.row.id)}/claim`, {});
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "subtask-claim" as const,
      subtaskId: top.row.id,
      swarmId: top.row.swarmId,
      title: top.row.title?.slice(0, 100),
    });
    console.log(`🐝 ✓ claimed subtask ${top.row.id.slice(0, 12)} — "${(top.row.title ?? "").slice(0, 40)}"`);
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "subtask-error" as const,
      subtaskId: top.row.id,
      notes: (err as Error).message.slice(0, 200),
    });
    console.warn(`🐝 claim failed: ${(err as Error).message.slice(0, 150)}`);
  }
}

/** A heartbeat error that means the claim is no longer ours (reassigned, gone,
 *  already completed) — terminal, so we stop heartbeating that id for good.
 *  Anything else (5xx, network) is transient and worth retrying next tick. */
export function isTerminalHeartbeatError(msg: string): boolean {
  return /\b(404|409|410|403)\b|not found|reassigned|gone|expired|already (completed|submitted)|no longer/i.test(msg);
}

/**
 * Heartbeat the subtasks we currently hold. Call every ~2 min — the gateway
 * reassigns a claim after claim_timeout_seconds (≈5 min).
 *
 * The held set is bounded so the loop can't grow without limit (the bug the
 * 30m→2m cadence change would otherwise amplify 15×): we only heartbeat ids
 * that are (a) claimed within BOT_SWARM_HEARTBEAT_WINDOW_MS — default 90 min, a
 * backstop comfortably above the auto-solve cadence — (b) not yet submitted, and
 * (c) not already marked dead by a terminal heartbeat failure. A claim that was
 * reassigned away therefore fails its heartbeat ONCE, is recorded `heartbeat-dead`,
 * and is never polled again — instead of being POSTed every 2 min forever.
 */
export async function heartbeatHeldSubtasks(runtime: RuntimeLike): Promise<number> {
  const all = readJsonl<LogEntry>(LOG);
  const windowMs = Number(process.env.BOT_SWARM_HEARTBEAT_WINDOW_MS ?? 90 * 60_000);
  const cutoff = Date.now() - windowMs;

  // Latest claim timestamp per id (a re-claim refreshes the window).
  const claimedAt = new Map<string, number>();
  for (const e of all) {
    if (e.kind === "subtask-claim" && e.subtaskId && e.ts) {
      claimedAt.set(e.subtaskId, Math.max(claimedAt.get(e.subtaskId) ?? 0, new Date(e.ts).getTime()));
    }
  }
  const submitted = new Set(
    all.filter((e) => e.kind === "subtask-submit").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  const dead = new Set(
    all.filter((e) => e.kind === "heartbeat-dead").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  const open = [...claimedAt.entries()]
    .filter(([id, ts]) => ts >= cutoff && !submitted.has(id) && !dead.has(id))
    .map(([id]) => id);
  if (open.length === 0) return 0;

  let okCount = 0;
  for (const id of open) {
    try {
      await runtime.connection.request("POST", `/v1/swarms/subtasks/${encodeURIComponent(id)}/heartbeat`, {});
      appendJsonl(LOG, { ts: new Date().toISOString(), kind: "heartbeat" as const, subtaskId: id });
      okCount += 1;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 120);
      // Terminal → mark dead so we never heartbeat it again; transient → retry next tick.
      const kind = isTerminalHeartbeatError(msg) ? ("heartbeat-dead" as const) : ("subtask-error" as const);
      appendJsonl(LOG, { ts: new Date().toISOString(), kind, subtaskId: id, notes: msg });
    }
  }
  return okCount;
}

/** Submit a result for a held subtask. Called by external solver (e.g. mining.ts adaptor). */
export async function submitSubtaskResult(
  runtime: RuntimeLike,
  subtaskId: string,
  content: string,
  resultType: "output" | "json" | "code" = "output",
): Promise<void> {
  try {
    await runtime.connection.request("POST", `/v1/swarms/subtasks/${encodeURIComponent(subtaskId)}/submit`, {
      content,
      resultType,
    });
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "subtask-submit" as const,
      subtaskId,
      notes: `${content.length}c ${resultType}`,
    });
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "subtask-error" as const,
      subtaskId,
      notes: (err as Error).message.slice(0, 200),
    });
    throw err;
  }
}

/**
 * Solve a swarm subtask via Venice and submit the result. Default-OFF.
 *
 * Toggle: BOT_SWARM_AUTO_SUBMIT=1 enables. Per-subtask call from the orchestrator
 * after a successful auto-claim (or operator-triggered).
 *
 * Cost guardrail: refuses to solve if the subtask description is empty or
 * shorter than 60 chars (likely garbage / nondescript).
 */
export async function solveAndSubmitSubtask(
  runtime: RuntimeLike,
  subtask: SubtaskRow,
): Promise<{ ok: boolean; reason?: string }> {
  const desc = (subtask.description ?? subtask.title ?? "").trim();
  if (desc.length < 60) return { ok: false, reason: "description too short" };
  if (!canAutoWriteNow(SWARM_SOLVE_COST)) {
    return { ok: false, reason: "auto-write daily cost cap reached" };
  }
  const tags = subtask.skillTags ?? [];
  const model = pickModel("mining_solve");
  const sys = `You are completing one subtask of a larger swarm task. Produce a focused, concrete deliverable — not a long essay.

OUTPUT FORMAT: just the deliverable, no preamble.
- Be specific. Include numbers, code, or step-by-step where appropriate.
- If the subtask asks for an analysis, give the analysis directly.
- If it asks for code, give working code.
- If it asks for a list, give the list.
- Cap output at ~1500 words.

Skill tags: ${tags.join(", ")}`;
  const userMsg = `# Subtask: ${subtask.title ?? subtask.id}\n\n${desc}\n\nProduce the deliverable now.`;
  try {
    const content = await withGenerationSlot("swarm", async () => {
      const res = await chat(
        [
          { role: "system", content: sys },
          { role: "user", content: userMsg },
        ],
        { model, timeoutMs: 600_000, max_tokens: 8000 },
      );
      return (res.content ?? "").trim();
    });
    if (content.length < 150) {
      return { ok: false, reason: `output too short (${content.length}c)` };
    }
    await submitSubtaskResult(runtime, subtask.id, content, "output");
    recordAutoWrite("swarm", SWARM_SOLVE_COST, `subtask=${subtask.id}`);
    recordAudit("swarm_solve", "submitted", (subtask.title ?? "").slice(0, 60), {
      subtaskId: subtask.id,
      chars: content.length,
    });
    console.log(`🐝 ✓ submitted subtask ${subtask.id.slice(0, 12)} — "${(subtask.title ?? "").slice(0, 40)}" (${content.length}c)`);
    return { ok: true };
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "subtask-error" as const,
      subtaskId: subtask.id,
      notes: `solve+submit: ${(err as Error).message.slice(0, 200)}`,
    });
    return { ok: false, reason: (err as Error).message.slice(0, 150) };
  }
}

/**
 * Drive auto-claim → auto-solve → auto-submit if all three toggles are on
 * AND there's a strong candidate. One subtask per tick max — keeps load
 * predictable.
 */
export async function runSwarmsAutoSolveTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_SWARM_AUTO_SOLVE !== "1") return;
  const all = readJsonl<LogEntry>(LOG);
  const claimed = new Set(
    all.filter((e) => e.kind === "subtask-claim").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  const submitted = new Set(
    all.filter((e) => e.kind === "subtask-submit").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  const errored = new Set(
    all.filter((e) => e.kind === "subtask-error").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  // Held = claimed but not submitted AND not previously errored (don't retry forever)
  const heldIds = [...claimed].filter((id) => !submitted.has(id) && !errored.has(id));
  if (heldIds.length === 0) return;
  // Need a fresh fetch to get description (claim log doesn't carry full body).
  let subtasks: SubtaskRow[];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/swarms/subtasks?status=in_progress&limit=30`,
    )) as { subtasks?: SubtaskRow[]; items?: SubtaskRow[] };
    subtasks = res.subtasks ?? res.items ?? [];
  } catch {
    return;
  }
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
  const mine = subtasks.find(
    (s) => heldIds.includes(s.id) && (!s.claimedBy || s.claimedBy.toLowerCase() === me),
  );
  if (!mine) return;
  await solveAndSubmitSubtask(runtime, mine);
}

export interface SwarmSummary {
  candidatesLast24h: number;
  claimsHeld: number;
  submitsToday: number;
}

export function swarmSummary(): SwarmSummary {
  const cutoff = Date.now() - 24 * 3600_000;
  const all = readJsonl<LogEntry>(LOG);
  const claimed = new Set(
    all.filter((e) => e.kind === "subtask-claim").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  const submitted = new Set(
    all.filter((e) => e.kind === "subtask-submit").map((e) => e.subtaskId).filter(Boolean) as string[],
  );
  return {
    candidatesLast24h: all.filter(
      (e) => e.kind === "subtask-candidate" && e.ts && new Date(e.ts).getTime() >= cutoff,
    ).length,
    claimsHeld: [...claimed].filter((id) => !submitted.has(id)).length,
    submitsToday: all.filter(
      (e) => e.kind === "subtask-submit" && e.ts && new Date(e.ts).getTime() >= cutoff,
    ).length,
  };
}
