/**
 * Verify-path failure classification (pure, side-effect-free, unit-tested).
 *
 * Why this exists: both verify catch blocks in index.ts used to run
 * `verifiedSubmissions.add(sub.id)` BEFORE looking at the error. That Set is
 * in-memory and never evicted, so a Venice 402 (key spend limit), a gateway
 * 5xx/429 or a bare "fetch failed" dropped a real candidate until the next
 * restart. Live (2026-09-30/10-01, ~/.nookplot/bot.out.log): 8fc39106 had a
 * fetched trace (source=ipfs len=2700) and was lost to a 402; 34618e81 spent a
 * rerun and was then lost to a 402. Verify supply is scarce (the diversity rule
 * caps us near ~1/day on a 5-solver pool), so every lost candidate matters.
 *
 * The rule now: mark a submission done only on success or a gateway-PERMANENT
 * outcome. Everything else gets a short-TTL skip (no hot retry) and, when the
 * failure could plausibly be deterministic for THIS submission (5xx, timeout,
 * parse fail, unknown), a strike — after `strikeLimit` strikes the submission
 * is retired like before, so a per-submission poison pill costs a bounded
 * number of attempts instead of one-forever or retry-forever.
 *
 * Failures that say nothing about the submission (Venice 402 budget, known 429
 * rate limits, the shared verify cap, 502/503/504 host outages, transport
 * errors such as a laptop waking with no network) never strike. A 402 also
 * pauses the whole verify loop, because it is key-level: every candidate would
 * 402 the same way.
 *
 * Three bounds keep "never strikes" from meaning "retries forever" (review of
 * 6764f40, 2026-10-01). The gateway rewords its permanent 429s over time
 * ("Reciprocal verification detected" was new on 06-10), and a retry that lands
 * at POST /verify has already paid for two grok-4-7 xhigh calls (~$0.13/pass):
 *   1. Rate-limit wording only counts on a 429 or a status-less error. A 403
 *      that says "cooldown" keeps its 4xx class (permanent); a 5xx that says
 *      "overloaded" keeps its 5xx class.
 *   2. A GATEWAY 429 whose body is not a known rate limit is `unknown-429` and
 *      strikes: it may be a reworded diversity/reciprocal block. Venice 429s
 *      stay no-strike (Venice never answers about the submission).
 *   3. Every temporary failure except the loop-level ones (402 pause, shared
 *      cap halt) counts toward a per-submission ceiling (`retryMax`), and a
 *      run of consecutive temporary failures across candidates pauses the whole
 *      loop with an escalating backoff (`nextVerifyStreak`).
 */
import { isDiversityBlockError, isFinalizedError, isReciprocalVerificationError } from "./skip-caches.js";
import { isVerifyCapError } from "./quotas.js";
import { STAND_DOWN_PREFIX } from "./venice-breaker.js";

/** 422 "complete the comprehension challenge before verifying" or ARTIFACT_INSPECTION_REQUIRED. */
export function isComprehensionGateError(msg: string): boolean {
  return /complete the comprehension challenge before verifying/i.test(msg)
    || /ARTIFACT_INSPECTION_REQUIRED/i.test(msg);
}

/**
 * Venice key-level budget exhaustion. Both production bodies are 402s. Also a
 * refused call during a process-wide stand-down (venice-breaker.ts): chat()
 * throws "Venice stand-down (...) ...; no request sent" when ANOTHER loop
 * tripped the breaker while this verify pass sat between its two Venice calls.
 * That says nothing about the submission, so it must not strike it or feed
 * the streak (found merging seven/standdown + seven/verifymark, 2026-10-01).
 */
export function isVeniceBudgetError(msg: string): boolean {
  return msg.startsWith(STAND_DOWN_PREFIX)
    || /Venice API 402\b/.test(msg)
    || /DIEM spend limit exceeded/i.test(msg)
    || /Insufficient USD or Diem balance/i.test(msg);
}

/** Synthetic message for a score response that did not parse (no exception thrown). */
export const SCORE_PARSE_FAIL = "score parse fail";

export type VerifyErrorKind =
  // Gateway-permanent: mark the submission done.
  | "finalized"          // 410 already finalized
  | "diversity"          // 429 we verified this solver 3+ times in 14d
  | "reciprocal"         // 429 this solver verified us 3+ times recently
  | "comprehension-gate" // 422 comprehension / artifact inspection gate
  | "client-4xx"         // any other 4xx (403 own challenge, 404, 422 insight gate, Venice 400...)
  // Temporary and not about this submission: retry later, no strike.
  | "verify-cap"         // shared verify+crowd-jury cap 429
  | "budget"             // Venice 402: key spend limit / balance
  | "rate"               // known rate limits: gateway cooldown / "rate limit" 429, any Venice 429
  | "transport"          // fetch failed / ECONNRESET / DNS / socket errors
  | "unavailable"        // 502/503/504: proxy/host down (Cloudflare HTML pages, blackouts)
  // Temporary but possibly deterministic for this submission: retry later, strike.
  | "unknown-429"        // gateway 429 we don't recognise: maybe a reworded permanent block
  | "server"             // 500 from the gateway, or a Venice 500 "Inference processing failed"
  | "timeout"            // AbortSignal timeout
  | "parse"              // score response did not parse
  | "unknown";           // anything unrecognised (incl. our own TypeErrors)

export interface VerifyErrorClass {
  kind: VerifyErrorKind;
  /** Gateway said this submission can't be verified by us; never retry it this process. */
  permanent: boolean;
  /** Counts toward the per-submission transient strike budget. */
  strikes: boolean;
  /** Key-level failure: pause ALL verify attempts, not just this submission. */
  pauseAll: boolean;
  /**
   * Counts toward the per-submission retry ceiling AND the loop-level failure
   * streak. False for permanent outcomes and for the two loop-level stops
   * (402 pause, shared-cap halt), which already bound the global retry rate.
   */
  ceiling: boolean;
}

const PERMANENT = (kind: VerifyErrorKind): VerifyErrorClass =>
  ({ kind, permanent: true, strikes: false, pauseAll: false, ceiling: false });
const TEMPORARY = (kind: VerifyErrorKind, strikes: boolean): VerifyErrorClass =>
  ({ kind, permanent: false, strikes, pauseAll: false, ceiling: true });
/** Temporary and loop-level: stops the whole loop, so no per-submission counting. */
const LOOP_STOP = (kind: VerifyErrorKind, pauseAll: boolean): VerifyErrorClass =>
  ({ kind, permanent: false, strikes: false, pauseAll, ceiling: false });

/** HTTP status from either error format we see: "Gateway request failed (NNN)" or "Venice API NNN". */
export function errorStatus(msg: string): number | null {
  const m = msg.match(/Gateway request failed \((\d{3})\)/) ?? msg.match(/Venice API (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** Venice error ("Venice API NNN: ..."), as opposed to a gateway one. */
export function isVeniceError(msg: string): boolean {
  return /Venice API \d{3}\b/.test(msg);
}

/** Wording of the rate limits we have actually seen. Only trusted on a 429 or a status-less error. */
const RATE_LIMIT_TEXT = /overloaded|rate limit|cooldown|too many requests/i;

/**
 * Classify a verify-path error message. Order matters: the gateway's permanent
 * 429s (diversity, reciprocal) and the shared-cap 429 must be recognised before
 * the generic 429 rules, and the 402 before the generic 4xx rule. Rate-limit
 * wording is only trusted on a 429 or a status-less error, so a 4xx/5xx that
 * mentions "cooldown" or "overloaded" keeps its status class.
 */
export function classifyVerifyError(rawMsg: string): VerifyErrorClass {
  // A non-Error throw gives `(err as Error).message === undefined`; classify it
  // as unknown instead of crashing inside the catch block.
  const msg = typeof rawMsg === "string" ? rawMsg : String(rawMsg ?? "");
  if (isFinalizedError(msg)) return PERMANENT("finalized");
  if (isDiversityBlockError(msg)) return PERMANENT("diversity");
  if (isReciprocalVerificationError(msg)) return PERMANENT("reciprocal");
  if (isComprehensionGateError(msg)) return PERMANENT("comprehension-gate");
  if (isVerifyCapError(msg)) return LOOP_STOP("verify-cap", false);
  if (isVeniceBudgetError(msg)) return LOOP_STOP("budget", true);

  const status = errorStatus(msg);
  const rateText = RATE_LIMIT_TEXT.test(msg);
  if (status === 429) {
    // A gateway 429 we can't name may be a reworded diversity/reciprocal block
    // (permanent for this submission): strike it so it can't retry forever.
    return isVeniceError(msg) || rateText ? TEMPORARY("rate", false) : TEMPORARY("unknown-429", true);
  }
  if (status == null && rateText) return TEMPORARY("rate", false);
  if (status === 502 || status === 503 || status === 504) return TEMPORARY("unavailable", false);
  if (status != null && status >= 500) return TEMPORARY("server", true);
  if (status === 408) return TEMPORARY("timeout", true);
  if (status != null && status >= 400) return PERMANENT("client-4xx");

  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|UND_ERR|network error/i.test(msg)) {
    return TEMPORARY("transport", false);
  }
  if (/operation was aborted|AbortError|timed? ?out/i.test(msg)) return TEMPORARY("timeout", true);
  if (msg === SCORE_PARSE_FAIL) return TEMPORARY("parse", true);
  if (/Inference processing failed/i.test(msg)) return TEMPORARY("server", true);
  return TEMPORARY("unknown", true);
}

export interface VerifyRetryConfig {
  /** Skip window for a temporarily failed submission (and the 402 loop pause). */
  retryAfterMs: number;
  /** Strikes (strike-counting failures) before the submission is retired. */
  strikeLimit: number;
  /**
   * Ceiling on ALL temporary failures for one submission (strike or not),
   * except the loop-level 402 / shared-cap stops. Without it a no-strike class
   * (rate, unavailable, transport) retried every `retryAfterMs` for as long as
   * the submission stayed in the pool.
   */
  retryMax: number;
}

function envNumber(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export const VERIFY_RETRY_DEFAULTS: VerifyRetryConfig = {
  retryAfterMs: envNumber("BOT_VERIFY_RETRY_MIN", 45, 1) * 60_000,
  strikeLimit: Math.floor(envNumber("BOT_VERIFY_RETRY_STRIKES", 3, 1)),
  retryMax: Math.floor(envNumber("BOT_VERIFY_RETRY_MAX", 8, 1)),
};

/** Per-submission retry bookkeeping. The caller stores it; this module never does. */
export interface VerifyRetryState {
  /** Strike-counting failures so far. */
  strikes: number;
  /** Ceiling-counting failures so far (see `VerifyErrorClass.ceiling`). */
  attempts: number;
}

export interface VerifyFailureDecision {
  /** "mark-done" = add to verifiedSubmissions; "retry-later" = short-TTL skip only. */
  action: "mark-done" | "retry-later";
  cls: VerifyErrorClass;
  /** Skip TTL when action is retry-later; 0 otherwise. */
  retryAfterMs: number;
  /** Pause for the whole verify loop (402); 0 otherwise. */
  pauseAllMs: number;
  /** Strike count to store for this submission after this failure. */
  strikesAfter: number;
  /** Ceiling count to store for this submission after this failure. */
  attemptsAfter: number;
  /** True when a temporary failure exhausted the strike budget or the ceiling. */
  retired: boolean;
  /** Which budget ran out when `retired`; null otherwise. */
  retiredBy: "strikes" | "ceiling" | null;
}

/**
 * Decide what one failure means for this submission, given its prior strikes
 * and attempts. Pure: the caller owns the Set / SkipCache / state Map.
 */
export function decideVerifyFailure(
  msg: string,
  prior: Partial<VerifyRetryState> = {},
  cfg: VerifyRetryConfig = VERIFY_RETRY_DEFAULTS,
): VerifyFailureDecision {
  const cls = classifyVerifyError(msg);
  if (cls.permanent) {
    return { action: "mark-done", cls, retryAfterMs: 0, pauseAllMs: 0, strikesAfter: 0, attemptsAfter: 0, retired: false, retiredBy: null };
  }
  const strikesAfter = (prior.strikes ?? 0) + (cls.strikes ? 1 : 0);
  const attemptsAfter = (prior.attempts ?? 0) + (cls.ceiling ? 1 : 0);
  const pauseAllMs = cls.pauseAll ? cfg.retryAfterMs : 0;
  const retiredBy = cls.strikes && strikesAfter >= cfg.strikeLimit ? "strikes"
    : cls.ceiling && attemptsAfter >= cfg.retryMax ? "ceiling"
    : null;
  if (retiredBy) {
    return { action: "mark-done", cls, retryAfterMs: 0, pauseAllMs, strikesAfter: 0, attemptsAfter: 0, retired: true, retiredBy };
  }
  return { action: "retry-later", cls, retryAfterMs: cfg.retryAfterMs, pauseAllMs, strikesAfter, attemptsAfter, retired: false, retiredBy: null };
}

// ─── Loop-level failure streak ────────────────────────────────────────────
//
// Per-submission bounds don't stop an ACCOUNT-level block from being paid for
// once per candidate: if every POST /verify starts returning the same 429, each
// candidate in the pool still costs a scoring pass before it learns that. A run
// of consecutive temporary failures across candidates, with no success in
// between, says the problem is not the submission: pause the whole loop, and
// double the pause on each further failure until a success.

export interface VerifyStreakState {
  /** Consecutive streak-feeding failures since the last success or trip. */
  count: number;
  /** Times the streak has tripped since the last success (sets the backoff). */
  trips: number;
  /** Epoch ms of the most recent counted failure; 0 = none. */
  lastFailureAt: number;
}

export const NO_VERIFY_STREAK: VerifyStreakState = { count: 0, trips: 0, lastFailureAt: 0 };

export interface VerifyStreakConfig {
  /** Consecutive failures that trip the pause. */
  threshold: number;
  /** First pause; doubles per further trip. */
  basePauseMs: number;
  /** Backoff ceiling. */
  maxPauseMs: number;
  /** A gap this long since the last failure starts the streak over (stale flakiness). */
  quietResetMs: number;
}

export const VERIFY_STREAK_DEFAULTS: VerifyStreakConfig = {
  threshold: Math.floor(envNumber("BOT_VERIFY_FAIL_STREAK", 3, 1)),
  basePauseMs: VERIFY_RETRY_DEFAULTS.retryAfterMs,
  maxPauseMs: 6 * 3600_000,
  quietResetMs: 12 * 3600_000,
};

/** Does this failure feed the loop-level streak? Permanent outcomes and the 402 / shared-cap stops don't. */
export function feedsVerifyStreak(d: VerifyFailureDecision): boolean {
  return !d.cls.permanent && d.cls.ceiling;
}

/**
 * Advance the streak by one verify outcome ("success" = POST /verify accepted).
 * Returns the new state and a loop pause (0 = none). After a trip the count
 * stays one short of the threshold, so one further failure re-trips with a
 * doubled pause; only a success or a `quietResetMs` gap clears it.
 */
export function nextVerifyStreak(
  state: VerifyStreakState,
  outcome: "success" | "failure",
  now: number,
  cfg: VerifyStreakConfig = VERIFY_STREAK_DEFAULTS,
): { state: VerifyStreakState; pauseMs: number } {
  if (outcome === "success") return { state: NO_VERIFY_STREAK, pauseMs: 0 };
  const base = state.lastFailureAt > 0 && now - state.lastFailureAt > cfg.quietResetMs ? NO_VERIFY_STREAK : state;
  const count = base.count + 1;
  if (count < cfg.threshold) return { state: { count, trips: base.trips, lastFailureAt: now }, pauseMs: 0 };
  const pauseMs = Math.min(cfg.basePauseMs * 2 ** base.trips, cfg.maxPauseMs);
  return { state: { count: cfg.threshold - 1, trips: base.trips + 1, lastFailureAt: now }, pauseMs };
}
