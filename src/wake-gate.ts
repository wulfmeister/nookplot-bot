/**
 * Wake gate (2026-10-04): don't START Venice work until the host has been
 * continuously awake for a few minutes, and don't retry a call the host slept
 * through.
 *
 * Why: while the laptop sleeps, macOS wakes it for ~8s (p50; p90 13s) about
 * once an hour (DarkWake / maintenance). Timers fire, a bot tick starts a
 * chat() call, the host sleeps again mid-generation — and Venice finishes and
 * BILLS the generation anyway. On the next blip the call "times out" (wall
 * clock 1.7-3.2h) and chat()'s one abort-retry starts another billed
 * generation. Measured 10-02→10-04: awake intervals reconcile with our ledger
 * to the cent; the 10-02 06:49Z → 10-03 15:04Z sleep lost $4.13 to 29 such
 * calls — all of 10-03's allowance, so the bot made 0 solves that day.
 *
 * This is sleep-TOLERANT, not sleep prevention (the operator closes the lid
 * on purpose): sleep is detected from the wall clock jumping past a heartbeat,
 * and work simply waits until the host is properly awake.
 *
 * ENV: BOT_WAKE_GATE_SEC (default 300; 0 disables) — continuous uptime
 * required after a detected wake before Venice work may start.
 *
 * No imports: venice-breaker.ts and venice.ts both depend on this.
 */

/** Heartbeat period. Timers freeze during sleep, so a late beat = slept. */
export const WAKE_HEARTBEAT_MS = 15_000;
/** A wall-clock gap this long between beats means the host slept (4 missed beats). */
export const WAKE_GAP_MS = 60_000;
/** Default continuous uptime required after a wake. DarkWakes last ~8-13s; 1 of 160 ran past 300s. */
export const WAKE_SETTLE_MS_DEFAULT = 300_000;

export const WAKE_GATE_PREFIX = "Venice wake-gate";
export const HOST_SLEEP_PREFIX = "Venice call interrupted by host sleep";

export interface WakeGateState {
  /** Wall clock of the last heartbeat (or last observation). */
  lastBeatMs: number;
  /** Wall clock when the most recent wake was detected; -Infinity = none since start. */
  lastWakeMs: number;
  /** Increments per detected wake, so loops can log once per wake. */
  wakeId: number;
}

export function freshWakeGateState(nowMs: number): WakeGateState {
  return { lastBeatMs: nowMs, lastWakeMs: Number.NEGATIVE_INFINITY, wakeId: 0 };
}

/**
 * Pure: fold one wall-clock observation into the state. A gap longer than
 * gapMs since the previous observation means the process was frozen — the
 * host slept — so a wake is recorded at nowMs. A backwards clock step
 * (NTP correction) is ignored rather than treated as a wake.
 */
export function observeClock(s: WakeGateState, nowMs: number, gapMs = WAKE_GAP_MS): WakeGateState {
  if (nowMs - s.lastBeatMs > gapMs) {
    return { lastBeatMs: nowMs, lastWakeMs: nowMs, wakeId: s.wakeId + 1 };
  }
  return nowMs > s.lastBeatMs ? { ...s, lastBeatMs: nowMs } : s;
}

export interface WakeGateStatus {
  closed: boolean;
  /** ms until the gate opens (0 when open). */
  remainingMs: number;
  /** ms since the last detected wake (Infinity when none). */
  wokeAgoMs: number;
  wakeId: number;
}

/** Pure: is new Venice work blocked right now? */
export function wakeGateStatusOf(s: WakeGateState, nowMs: number, settleMs: number): WakeGateStatus {
  const wokeAgoMs = nowMs - s.lastWakeMs;
  const closed = settleMs > 0 && wokeAgoMs < settleMs;
  return { closed, remainingMs: closed ? settleMs - wokeAgoMs : 0, wokeAgoMs, wakeId: s.wakeId };
}

/** Pure: did a wake (hence a sleep) happen after `startMs`? */
export function sleptSinceOf(s: WakeGateState, startMs: number): boolean {
  return s.lastWakeMs > startMs;
}

export function wakeSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOT_WAKE_GATE_SEC;
  if (raw === undefined || raw === "") return WAKE_SETTLE_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : WAKE_SETTLE_MS_DEFAULT;
}

// ── detector: state + heartbeat ────────────────────────────────────────────

export interface WakeGate {
  /** Fold the clock reading into the state (and log a detected wake). */
  observe(nowMs?: number): WakeGateState;
  /** Tests only: start over with no wake recorded. */
  reset(nowMs?: number): void;
  /** Record a wake at nowMs without a clock gap (daemon boot). */
  markWake(nowMs?: number): WakeGateState;
}

/**
 * A wake detector bound to a clock and a timer. The heartbeat starts HERE, at
 * construction — module load for the process-wide one — and never lazily on
 * the first observation.
 *
 * Why (fixed 2026-10-04, the day the gate shipped): the state is seeded with
 * the time of construction, so with a lazy heartbeat the first observation
 * measured the gap since IMPORT. Any first gate check more than 60s after boot
 * (connect retries during a slow gateway, claimRewards, the 30s verify-poll
 * delay) read as a wake: a phantom "🌙 host woke from sleep" and 5 minutes
 * of Venice work held with no sleep at all. Reproduced: import, wait 65s,
 * check → closed, wakeId 1. Phantom wake lines also make the log useless for
 * sleep forensics, which is half of what the 🌙 line is for.
 *
 * Residual (UNVERIFIED in production): a synchronous stall of the event loop
 * past WAKE_GAP_MS also delays the beat and reads as a wake. Nothing in the
 * bot is known to block that long.
 */
export function createWakeGate(
  now: () => number,
  startHeartbeat: (beat: () => void, periodMs: number) => void,
  onWake: (s: WakeGateState) => void = () => {},
): WakeGate {
  let state = freshWakeGateState(now());
  const observe = (nowMs = now()): WakeGateState => {
    const prevWake = state.wakeId;
    state = observeClock(state, nowMs);
    if (state.wakeId !== prevWake) onWake(state);
    return state;
  };
  startHeartbeat(() => { observe(); }, WAKE_HEARTBEAT_MS);
  return {
    observe,
    reset: (nowMs = now()) => { state = freshWakeGateState(nowMs); },
    markWake: (nowMs = now()) => {
      state = { lastBeatMs: nowMs, lastWakeMs: nowMs, wakeId: state.wakeId + 1 };
      return state;
    },
  };
}

// ── process-wide instance ──────────────────────────────────────────────────

// Declared before processGate: createWakeGate starts the heartbeat while it
// constructs, i.e. during this module's evaluation.
let processHeartbeat: ReturnType<typeof setInterval> | null = null;

const processGate = createWakeGate(
  () => Date.now(),
  (beat, periodMs) => {
    processHeartbeat = setInterval(beat, periodMs);
    // unref: never keeps a script (probe, test) alive on its own.
    processHeartbeat.unref?.();
  },
  () => {
    const settle = wakeSettleMs();
    if (settle > 0) {
      console.log(`🌙 host woke from sleep — holding Venice work for ${Math.round(settle / 1000)}s of continuous uptime (wake gate)`);
    }
  },
);

/**
 * Observe the clock now. Every gate check calls this first, so a timer that
 * fires on resume before the heartbeat does still sees the gap.
 */
export function observeNow(nowMs = Date.now()): WakeGateState {
  return processGate.observe(nowMs);
}

export function wakeGateStatus(nowMs = Date.now()): WakeGateStatus {
  return wakeGateStatusOf(observeNow(nowMs), nowMs, wakeSettleMs());
}

/**
 * Daemon boot counts as a wake (2026-10-04 review): launchd restarts the bot
 * on a watchdog exit(70) or a crash, and those have happened INSIDE macOS
 * maintenance wakes. A process born in an ~8s DarkWake would otherwise start
 * with the gate open and launch a generation Venice bills after the host
 * sleeps again. Cost: Venice work waits BOT_WAKE_GATE_SEC after every
 * restart. Called from index.ts main() only, so tests and probes are not
 * held.
 */
export function noteDaemonBoot(nowMs = Date.now()): void {
  processGate.markWake(nowMs);
  const settle = wakeSettleMs();
  if (settle > 0) {
    console.log(`🌙 daemon boot — holding Venice work for ${Math.round(settle / 1000)}s of continuous uptime (wake gate)`);
  }
}

/** Did the host sleep after `startMs`? Observes the clock first. */
export function hostSleptSince(startMs: number, nowMs = Date.now()): boolean {
  return sleptSinceOf(observeNow(nowMs), startMs);
}

export class VeniceWakeGateError extends Error {
  readonly remainingMs: number;
  constructor(s: WakeGateStatus) {
    // Avoids words other classifiers read as transient ("aborted", "timeout",
    // "fetch failed", "429", "overloaded"): no failover, no retry.
    super(`${WAKE_GATE_PREFIX}: host woke ${Math.round(s.wokeAgoMs / 1000)}s ago; waiting ${Math.round(s.remainingMs / 1000)}s more of continuous uptime; no request sent`);
    this.name = "VeniceWakeGateError";
    this.remainingMs = s.remainingMs;
  }
}

export class HostSleepInterruptError extends Error {
  constructor(wallMs: number) {
    super(`${HOST_SLEEP_PREFIX} (${Math.round(wallMs / 1000)}s wall clock); not retried`);
    this.name = "HostSleepInterruptError";
  }
}

/** Pure: is this error text a wake-gate refusal or a sleep interruption? */
export function isWakeGateOrSleepError(text: string | undefined | null): boolean {
  return !!text && (text.includes(WAKE_GATE_PREFIX) || text.includes(HOST_SLEEP_PREFIX));
}

/** Tests only. */
export function _resetWakeGateForTests(nowMs = Date.now()): void {
  processGate.reset(nowMs);
}

/** Tests only: was the process-wide heartbeat started (at module load)? */
export function _wakeGateHeartbeatStartedForTests(): boolean {
  return processHeartbeat !== null;
}
