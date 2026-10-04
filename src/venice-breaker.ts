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
 * Early lift (review fix, 2026-10-01): a refill-bound pause used to hold until
 * 00:02Z even after the operator fixed the cause, so a 04:00Z dry-out topped up
 * at 05:00Z still skipped mining/verify/posting for ~19h. Before the breaker, a
 * top-up worked on the very next call. The 30-min balance watch
 * (venice-balance.ts) now feeds each reading to noteVeniceBalanceReading():
 *   - `insufficient-balance` lifts when a reading SENT AFTER the refusal shows
 *     at least LIFT_MIN_SPENDABLE. A lift that the next call refuses again
 *     raises the bar to that balance, so a balance Venice still won't spend
 *     can't produce a lift→402→lift cycle every 30 min; the bar clears once a
 *     reading shows the balance going down (calls were billed).
 *   - `key-spend-limit` is set on the KEY, which the balance watch cannot see.
 *     It lifts only when Venice's `accessPermitted` flips false → true within
 *     the pause. On 2026-09-28 rate_limits read `accessPermitted: false` while
 *     the key 402'd; whether it flips back when the key's limit is RAISED is
 *     UNVERIFIED. If it doesn't, the pause holds to the refill, and the trip
 *     log line tells the operator to restart after raising the limit.
 *   - The 30-min pauses (lockout, unrecognised 402) just expire.
 *
 * Side-effect free: in-memory state only, no disk or network. The only output
 * is one console line per new pause or lift, and one per loop per pause from
 * standDownSkip(). The state does not survive a restart; the first call after
 * a restart re-trips it if the key is still refused.
 *
 * ENV: BOT_VENICE_STANDDOWN=0 disables the breaker (calls go through as before).
 */

import { isWakeGateOrSleepError, wakeGateStatus } from "./wake-gate.js";
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
/**
 * The smallest spendable balance that lifts an `insufficient-balance` pause.
 * Residues are real: the watch read 0.22 spendable on 2026-09-28, shortly
 * before the bot's first 402 that day. The refusal says "Insufficient ... to
 * complete request", so a residue may not fund a call (whether Venice refuses
 * above $0 is UNVERIFIED). $1 is roughly four grok-4-7 xhigh calls, and well
 * under any manual top-up.
 */
export const LIFT_MIN_SPENDABLE = 1;
/** Restart command for the launchd-owned daemon (scripts/install-launchd.sh, label com.nookplot.bot). */
export const RESTART_HINT = "launchctl kickstart -k gui/$(id -u)/com.nookplot.bot";

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
const loggedWakeByLoop = new Map<string, number>();
/** When the current pause began (its first refusal). Readings sent earlier may predate it. */
let pauseStartedMs = 0;
/** A reading sent during the current pause reported `accessPermitted: false`. */
let sawAccessDenied = false;
/**
 * Spendable balance at the last balance-triggered lift. A later
 * insufficient-balance lift needs MORE than this, so a balance Venice refuses
 * to spend lifts at most once. Cleared when a reading shows the balance went
 * down, i.e. the lift funded billed calls.
 */
let liftBar: number | null = null;

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
  pauseStartedMs = 0;
  sawAccessDenied = false;
  liftBar = null;
}

/** Pure: what the operator can do about a pause of this kind (appended to the trip log line). */
export function standDownRemedy(k: StandDownKind): string {
  switch (k) {
    case "insufficient-balance":
      return `A top-up lifts it at the next balance check (every 30 min); or restart: ${RESTART_HINT}.`;
    case "key-spend-limit":
      return (
        `This limit is set on the API key, which the balance watch cannot see: after raising it, restart ` +
        `(${RESTART_HINT}) or the pause holds until the refill.`
      );
    default:
      return `It expires by itself; or restart: ${RESTART_HINT}.`;
  }
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
  if (!wasActive) {
    pauseId++;
    pauseStartedMs = nowMs;
    sawAccessDenied = false;
  }
  const iso = new Date(newUntil).toISOString();
  const hours = ((newUntil - nowMs) / 3600_000).toFixed(1);
  const log = opts.log ?? ((line: string) => console.warn(line));
  log(
    wasActive
      ? `🛑 Venice stand-down extended: ${err.label} (HTTP ${err.status}) — now until ${iso} (${hours}h). ${standDownRemedy(err.kind)}`
      : `🛑 Venice stand-down: ${err.label} (HTTP ${err.status}) — pausing ALL Venice calls until ${iso} (${hours}h). ` +
          `Mining, verify, posting, observe, knowledge, learnings and crowd-jury ticks skip until then. ` +
          `${standDownRemedy(err.kind)} BOT_VENICE_STANDDOWN=0 (+ restart) disables the stand-down.`,
  );
  return veniceStandingDown(nowMs);
}

/**
 * End the current pause now. Logs one line naming why. Returns false when
 * nothing was standing down. The next refusal starts a new pause as usual.
 */
export function liftVeniceStandDown(
  why: string,
  nowMs = Date.now(),
  log: (line: string) => void = (line) => console.warn(line),
): boolean {
  const s = veniceStandingDown(nowMs);
  if (!s.active) return false;
  untilMs = 0;
  reason = null;
  kind = null;
  sawAccessDenied = false;
  log(`✅ Venice stand-down lifted early (${s.reason}; was until ${s.until}): ${why}`);
  return true;
}

/** One 30-min balance reading, as the breaker needs it (built in venice-balance.ts). */
export interface VeniceBalanceReading {
  /** DIEM plus any positive USD (venice-balance.ts spendableBalance). */
  spendable: number;
  /** rate_limits' `accessPermitted`; null/undefined when the response omits it. */
  accessPermitted?: boolean | null;
  /** When the balance request was SENT. A reading sent before the refusal can predate it. */
  fetchedAtMs: number;
}

/**
 * Feed a balance reading in; lifts a refill-bound pause when the reading shows
 * the cause is fixed (rules in the module header). Returns true when it lifted.
 */
export function noteVeniceBalanceReading(
  r: VeniceBalanceReading,
  nowMs = Date.now(),
  log: (line: string) => void = (line) => console.warn(line),
): boolean {
  if (!Number.isFinite(r.spendable)) return false;
  // The balance went down since the last balance lift: calls were billed, so
  // that lift worked. A later dry-out must not be held to its bar.
  if (liftBar !== null && r.spendable < liftBar) liftBar = null;
  const s = veniceStandingDown(nowMs);
  if (!s.active) return false;
  if (r.fetchedAtMs < pauseStartedMs) return false;
  if (r.accessPermitted === false) {
    sawAccessDenied = true;
    return false;
  }
  if (s.kind === "insufficient-balance") {
    if (r.spendable < LIFT_MIN_SPENDABLE) return false;
    if (liftBar !== null && r.spendable <= liftBar) return false;
    liftBar = r.spendable;
    return liftVeniceStandDown(`balance now reads ${r.spendable.toFixed(2)} spendable (topped up)`, nowMs, log);
  }
  if (s.kind === "key-spend-limit") {
    if (!sawAccessDenied || r.accessPermitted !== true) return false;
    return liftVeniceStandDown(
      `Venice's rate_limits now reports accessPermitted=true (it read false earlier in this pause)`,
      nowMs,
      log,
    );
  }
  return false;
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
  // Wake-gate refusals and sleep-interrupted calls (wake-gate.ts) say nothing
  // about the work either: the host was asleep, not the challenge bad.
  if (isWakeGateOrSleepError(text)) return true;
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
  // Wake gate (wake-gate.ts): after the host wakes from sleep, hold Venice work
  // until it has been continuously awake for BOT_WAKE_GATE_SEC. Brief
  // maintenance wakes (~8s) then never start a generation that Venice bills
  // after the host sleeps again. Logs once per loop per wake.
  // Real clock on purpose: nowMs is injectable for stand-down tests, and a
  // fake time must never read as a clock jump (a "wake").
  const gate = wakeGateStatus();
  if (gate.closed) {
    if (loggedWakeByLoop.get(loop) !== gate.wakeId) {
      loggedWakeByLoop.set(loop, gate.wakeId);
      log(`⏸ ${loop} skipped: host woke ${Math.round(gate.wokeAgoMs / 1000)}s ago — waiting ${Math.round(gate.remainingMs / 1000)}s more (wake gate)`);
    }
    return true;
  }
  const s = veniceStandingDown(nowMs);
  if (!s.active) return false;
  if (loggedPauseByLoop.get(loop) !== s.pauseId) {
    loggedPauseByLoop.set(loop, s.pauseId);
    log(`⏸ ${loop} skipped: Venice standing down (${s.reason}) until ${s.until}`);
  }
  return true;
}
