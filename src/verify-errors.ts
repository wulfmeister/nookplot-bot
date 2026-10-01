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
 * Failures that say nothing about the submission (Venice 402 budget, 429 rate
 * limits, the shared verify cap, 502/503/504 host outages, transport errors
 * such as a laptop waking with no network) never strike. A 402 also pauses the whole verify loop, because
 * it is key-level: every candidate would 402 the same way.
 */
import { isDiversityBlockError, isFinalizedError, isReciprocalVerificationError } from "./skip-caches.js";
import { isVerifyCapError } from "./quotas.js";

/** 422 "complete the comprehension challenge before verifying" or ARTIFACT_INSPECTION_REQUIRED. */
export function isComprehensionGateError(msg: string): boolean {
  return /complete the comprehension challenge before verifying/i.test(msg)
    || /ARTIFACT_INSPECTION_REQUIRED/i.test(msg);
}

/** Venice key-level budget exhaustion. Both production bodies are 402s. */
export function isVeniceBudgetError(msg: string): boolean {
  return /Venice API 402\b/.test(msg)
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
  | "rate"               // other 429s: gateway cooldown, Venice overloaded
  | "transport"          // fetch failed / ECONNRESET / DNS / socket errors
  | "unavailable"        // 502/503/504: proxy/host down (Cloudflare HTML pages, blackouts)
  // Temporary but possibly deterministic for this submission: retry later, strike.
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
}

const PERMANENT = (kind: VerifyErrorKind): VerifyErrorClass => ({ kind, permanent: true, strikes: false, pauseAll: false });
const TEMPORARY = (kind: VerifyErrorKind, strikes: boolean, pauseAll = false): VerifyErrorClass =>
  ({ kind, permanent: false, strikes, pauseAll });

/** HTTP status from either error format we see: "Gateway request failed (NNN)" or "Venice API NNN". */
export function errorStatus(msg: string): number | null {
  const m = msg.match(/Gateway request failed \((\d{3})\)/) ?? msg.match(/Venice API (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Classify a verify-path error message. Order matters: the gateway's permanent
 * 429s (diversity, reciprocal) and the shared-cap 429 must be recognised before
 * the generic "429 = rate limit" rule, and the 402 before the generic 4xx rule.
 */
export function classifyVerifyError(rawMsg: string): VerifyErrorClass {
  // A non-Error throw gives `(err as Error).message === undefined`; classify it
  // as unknown instead of crashing inside the catch block.
  const msg = typeof rawMsg === "string" ? rawMsg : String(rawMsg ?? "");
  if (isFinalizedError(msg)) return PERMANENT("finalized");
  if (isDiversityBlockError(msg)) return PERMANENT("diversity");
  if (isReciprocalVerificationError(msg)) return PERMANENT("reciprocal");
  if (isComprehensionGateError(msg)) return PERMANENT("comprehension-gate");
  if (isVerifyCapError(msg)) return TEMPORARY("verify-cap", false);
  if (isVeniceBudgetError(msg)) return TEMPORARY("budget", false, true);

  const status = errorStatus(msg);
  if (status === 429 || /overloaded|rate limit|cooldown|too many requests/i.test(msg)) {
    return TEMPORARY("rate", false);
  }
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
}

function envNumber(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export const VERIFY_RETRY_DEFAULTS: VerifyRetryConfig = {
  retryAfterMs: envNumber("BOT_VERIFY_RETRY_MIN", 45, 1) * 60_000,
  strikeLimit: Math.floor(envNumber("BOT_VERIFY_RETRY_STRIKES", 3, 1)),
};

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
  /** True when a temporary failure exhausted the strike budget. */
  retired: boolean;
}

/**
 * Decide what one failure means for this submission, given how many strikes it
 * already has. Pure: the caller owns the Set / SkipCache / strike Map.
 */
export function decideVerifyFailure(
  msg: string,
  priorStrikes: number,
  cfg: VerifyRetryConfig = VERIFY_RETRY_DEFAULTS,
): VerifyFailureDecision {
  const cls = classifyVerifyError(msg);
  if (cls.permanent) {
    return { action: "mark-done", cls, retryAfterMs: 0, pauseAllMs: 0, strikesAfter: 0, retired: false };
  }
  const strikesAfter = cls.strikes ? priorStrikes + 1 : priorStrikes;
  const pauseAllMs = cls.pauseAll ? cfg.retryAfterMs : 0;
  if (cls.strikes && strikesAfter >= cfg.strikeLimit) {
    return { action: "mark-done", cls, retryAfterMs: 0, pauseAllMs, strikesAfter: 0, retired: true };
  }
  return { action: "retry-later", cls, retryAfterMs: cfg.retryAfterMs, pauseAllMs, strikesAfter, retired: false };
}
