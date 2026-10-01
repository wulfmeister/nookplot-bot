/**
 * Process-wide Venice stand-down (2026-10-01).
 *
 * Why: from 03:46Z on 2026-10-01 the API key's configured DIEM spend limit was
 * exhausted and every Venice call 402'd from then on (the next DIEM refill is
 * 00:00Z). chat() rethrew the 402 to every caller and only Jev paused, and
 * only for itself. Mining
 * retried the same 3 challenges every ~15 min (158 402 rows, 17 distinct
 * challenges by 17:32Z), each attempt guild-claiming first, so our guild kept
 * renewing 2h exclusive claims on challenges we could not solve. Each 402 row
 * also aged into a permanent skip after mining's 4h error cooldown, so the
 * outage abandoned real work as well as wasting calls. Verify, artifact verify,
 * challenge posting, observe, grounded sources and learnings all 402'd too.
 * The limit is set on the KEY. The account-balance watch (venice-balance.ts)
 * cannot see it.
 *
 * What this does: a 402 whose body names a spend limit or an insufficient
 * balance stands ALL Venice use down until the next DIEM refill (00:00Z, or the
 * `nextEpochBegins` the balance watch last read), plus a 2-minute grace. A 429
 * "Too many failed attempts" lockout, or a 402 with a body we do not recognise,
 * stands down for 30 minutes. While standing down, chat() throws without
 * making a request, so no failed attempt counts toward Venice's lockout, and
 * the tick loops skip before guild claims, context gathering and comprehension
 * POSTs. When the pause ends, the next call is the probe: a fresh 402 starts a
 * new pause, so a limit that does not reset at 00:00Z costs one failed call a
 * day.
 *
 * Side-effect free: in-memory state only, no disk or network. The only output
 * is one console line per new pause, and one per loop per pause from
 * standDownSkip(). The state does not survive a restart; the first call after
 * a restart re-trips it if the key is still refused.
 *
 * ENV: BOT_VENICE_STANDDOWN=0 disables the breaker (calls go through as before).
 */

export const LOCKOUT_PAUSE_MS = 30 * 60_000;
export const UNKNOWN_402_PAUSE_MS = 30 * 60_000;
/** Added after the refill boundary so the first call doesn't race the refill. */
export const REFILL_GRACE_MS = 2 * 60_000;
/**
 * A spend-limit 402 within this long after 00:00Z may be the refill still
 * propagating. Pausing until the NEXT midnight would cost a whole day, so in
 * this window the pause is LOCKOUT_PAUSE_MS instead.
 */
export const REFILL_LAG_WINDOW_MS = 15 * 60_000;
/** A nextEpochBegins further out than this is ignored (bad data). */
const MAX_EPOCH_LOOKAHEAD_MS = 48 * 3600_000;

export type StandDownKind = "key-spend-limit" | "insufficient-balance" | "payment-required" | "failed-attempt-lockout";

export interface VeniceBillingError {
  kind: StandDownKind;
  status: number;
  /** Human label, used in logs and in the stand-down error message. */
  label: string;
  /** true → pause until the refill boundary; false → a fixed short pause. */
  untilRefill: boolean;
}

export interface StandDownState {
  active: boolean;
  untilMs: number;
  until: string | null;
  reason: string | null;
  kind: StandDownKind | null;
  /** Increments on every inactive → active transition. Loops use it to log once per pause. */
  pauseId: number;
}

/** Message prefix of VeniceStandDownError, matched by isVeniceBillingError. */
export const STAND_DOWN_PREFIX = "Venice stand-down";

/**
 * Pure: classify a Venice error message. Accepts chat()'s
 * `Venice API <status>: <body>` and `HTTP <status>: <body>`. Returns null for
 * anything that is not a billing refusal or lockout. An ordinary 429
 * ("model is currently overloaded") is not a stand-down: it is per-model
 * capacity, handled by failover.
 */
export function classifyVeniceBillingError(message: string | undefined | null): VeniceBillingError | null {
  if (!message) return null;
  const m = /(?:Venice API|HTTP)\s+(\d{3})\b/.exec(message);
  if (!m) return null;
  const status = Number(m[1]);
  if (status === 402) {
    if (/spend(?:ing)? limit/i.test(message)) {
      const which = /\bDIEM spend/i.test(message) ? "DIEM " : /\bUSD spend/i.test(message) ? "USD " : "";
      return { kind: "key-spend-limit", status, label: `API key ${which}spend limit`, untilRefill: true };
    }
    if (/insufficient\s+(?:usd|diem|balance|funds|credits)/i.test(message)) {
      return { kind: "insufficient-balance", status, label: "insufficient USD/DIEM balance", untilRefill: true };
    }
    return { kind: "payment-required", status, label: "payment required (unrecognised 402 body)", untilRefill: false };
  }
  if (status === 429 && /too many failed attempts/i.test(message)) {
    return { kind: "failed-attempt-lockout", status, label: "failed-attempt lockout", untilRefill: false };
  }
  return null;
}

/** Pure: the next 00:00:00Z strictly after nowMs. */
export function nextUtcMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Pure: when a stand-down of this kind should end. A refill-bound pause runs to
 * `nextEpochBegins` when that is a sane future time, else to the next 00:00Z,
 * plus REFILL_GRACE_MS. Exception: inside REFILL_LAG_WINDOW_MS after midnight,
 * where the refill may not have landed yet, it is a short pause.
 */
export function standDownUntilMs(
  err: Pick<VeniceBillingError, "untilRefill" | "kind">,
  nowMs: number,
  nextEpochBegins?: string | number | null,
): number {
  if (!err.untilRefill) {
    return nowMs + (err.kind === "failed-attempt-lockout" ? LOCKOUT_PAUSE_MS : UNKNOWN_402_PAUSE_MS);
  }
  const lastMidnight = nextUtcMidnightMs(nowMs) - 86_400_000;
  if (nowMs - lastMidnight < REFILL_LAG_WINDOW_MS) return nowMs + LOCKOUT_PAUSE_MS;
  const epochMs =
    typeof nextEpochBegins === "number" ? nextEpochBegins : nextEpochBegins ? Date.parse(nextEpochBegins) : NaN;
  const boundary =
    Number.isFinite(epochMs) && epochMs > nowMs && epochMs - nowMs <= MAX_EPOCH_LOOKAHEAD_MS
      ? epochMs
      : nextUtcMidnightMs(nowMs);
  return boundary + REFILL_GRACE_MS;
}

let untilMs = 0;
let reason: string | null = null;
let kind: StandDownKind | null = null;
let pauseId = 0;
let knownNextEpoch: string | null = null;
const loggedPauseByLoop = new Map<string, number>();

function enabled(): boolean {
  return process.env.BOT_VENICE_STANDDOWN !== "0";
}

/** Test hook: clear all breaker state. */
export function _resetVeniceBreakerForTests(): void {
  untilMs = 0;
  reason = null;
  kind = null;
  pauseId = 0;
  knownNextEpoch = null;
  loggedPauseByLoop.clear();
}

/**
 * The balance watch reports Venice's `nextEpochBegins` (the DIEM refill time).
 * Remembered so a later 402 pauses to the real boundary, not an assumed 00:00Z.
 */
export function noteVeniceNextEpoch(iso: string | null | undefined): void {
  if (iso && Number.isFinite(Date.parse(iso))) knownNextEpoch = iso;
}

export function veniceStandingDown(nowMs = Date.now()): StandDownState {
  const active = enabled() && nowMs < untilMs;
  return {
    active,
    untilMs: active ? untilMs : 0,
    until: active ? new Date(untilMs).toISOString() : null,
    reason: active ? reason : null,
    kind: active ? kind : null,
    pauseId,
  };
}

/**
 * Feed a Venice error message in. On a billing refusal or a lockout, starts a
 * pause, or extends one to a later end, and returns the new state. Returns null
 * when the message is not a stand-down trigger, or the current pause already
 * covers it. Concurrent in-flight calls that 402 together produce one log line.
 */
export function noteVeniceError(
  message: string | undefined | null,
  nowMs = Date.now(),
  opts: { nextEpochBegins?: string | number | null; log?: (line: string) => void } = {},
): StandDownState | null {
  if (!enabled()) return null;
  const err = classifyVeniceBillingError(message);
  if (!err) return null;
  // Whole seconds: the ISO time goes into error messages, and a millisecond
  // suffix like ".502Z" must never look like an HTTP status to a classifier.
  const newUntil =
    Math.ceil(standDownUntilMs(err, nowMs, opts.nextEpochBegins !== undefined ? opts.nextEpochBegins : knownNextEpoch) / 1000) * 1000;
  const wasActive = nowMs < untilMs;
  if (wasActive && newUntil <= untilMs) return null;
  untilMs = newUntil;
  reason = err.label;
  kind = err.kind;
  if (!wasActive) pauseId++;
  const iso = new Date(newUntil).toISOString();
  const hours = ((newUntil - nowMs) / 3600_000).toFixed(1);
  const log = opts.log ?? ((line: string) => console.warn(line));
  log(
    wasActive
      ? `🛑 Venice stand-down extended: ${err.label} (HTTP ${err.status}) — now until ${iso} (${hours}h)`
      : `🛑 Venice stand-down: ${err.label} (HTTP ${err.status}) — pausing ALL Venice calls until ${iso} (${hours}h). ` +
          `Mining, verify, posting, observe, knowledge, learnings and crowd-jury ticks skip until then; ` +
          `restart or BOT_VENICE_STANDDOWN=0 to override.`,
  );
  return veniceStandingDown(nowMs);
}

/** Thrown by chat() while standing down. No request was sent. */
export class VeniceStandDownError extends Error {
  readonly untilMs: number;
  readonly reason: string | null;
  constructor(state: StandDownState) {
    // Deliberately avoids words other classifiers treat as transient
    // ("aborted", "timeout", "fetch failed", "429", "overloaded"): a
    // stand-down must not trigger a model failover or a retry.
    super(`${STAND_DOWN_PREFIX} (${state.reason ?? "billing refusal"}) until ${state.until ?? "?"}; no request sent`);
    this.name = "VeniceStandDownError";
    this.untilMs = state.untilMs;
    this.reason = state.reason;
  }
}

export function isVeniceStandDownError(err: unknown): boolean {
  return err instanceof VeniceStandDownError || (err instanceof Error && err.message.startsWith(STAND_DOWN_PREFIX));
}

/**
 * Pure: did this error text come from a billing refusal (any Venice 402), a
 * failed-attempt lockout, or a stand-down? Used to keep such failures from
 * marking work as done. The work was fine; the key could not pay for it.
 */
export function isVeniceBillingError(text: string | undefined | null): boolean {
  if (!text) return false;
  if (text.includes(STAND_DOWN_PREFIX)) return true;
  return classifyVeniceBillingError(text) !== null;
}

/**
 * Tick guard: returns true (skip the tick) while standing down. Logs at most
 * once per loop per pause.
 */
export function standDownSkip(
  loop: string,
  nowMs = Date.now(),
  log: (line: string) => void = (line) => console.log(line),
): boolean {
  const s = veniceStandingDown(nowMs);
  if (!s.active) return false;
  if (loggedPauseByLoop.get(loop) !== s.pauseId) {
    loggedPauseByLoop.set(loop, s.pauseId);
    log(`⏸ ${loop} skipped: Venice standing down (${s.reason}) until ${s.until}`);
  }
  return true;
}
