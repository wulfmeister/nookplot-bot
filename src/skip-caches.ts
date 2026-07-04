/**
 * In-memory skip caches for permanent / time-bounded gateway failures.
 *
 * Pattern: the gateway returns a 4xx (sometimes a 429) with a body that
 * describes a *permanent* (within some window) condition — e.g. "already
 * submitted this challenge", "already finalized", "claimed by guild X
 * until <ts>", "verified this solver's work 3+ times in last 14 days".
 *
 * The nookplot-runtime SDK retry layer doesn't inspect the body, so each
 * occurrence wastes ~78s of wall time on the 4-retry ladder. Even after
 * the catch fires, the next discover cycle re-surfaces the same id and
 * we hit it again — there's no built-in finalized index sync.
 *
 * This module gives every track a single Map for the relevant id space
 * plus a tiny detector+parser per failure mode. Callers do two things:
 *   - At the top of their per-id loop: `if (cache.isSkipped(id)) return;`
 *   - In the catch handler: `if (isXBlock(msg)) cache.markFor(id, ttlMs)`
 *
 * Everything is in-memory because (a) the bot restarts ~weekly, (b) all
 * windows are <14d, (c) on restart the gateway will re-surface the bad
 * id and we'll re-mark it on first attempt — at worst a 78s tax per
 * restart per id, vs every-tick today.
 */

export class SkipCache {
  private readonly map = new Map<string, number>();

  isSkipped(id: string): boolean {
    const until = this.map.get(id);
    if (until == null) return false;
    if (Date.now() >= until) {
      this.map.delete(id);
      return false;
    }
    return true;
  }

  markFor(id: string, ttlMs: number): void {
    this.map.set(id, Date.now() + ttlMs);
  }

  markUntil(id: string, untilTs: number): void {
    this.map.set(id, untilTs);
  }

  size(): number {
    // Prune expired in-place so size() reflects active gates only.
    const now = Date.now();
    for (const [k, until] of this.map) if (now >= until) this.map.delete(k);
    return this.map.size;
  }
}

// ─── Per-track caches ────────────────────────────────────────────────────────

/** Verify path — submission id that the gateway said is already finalized. */
export const finalizedSubmissionSkip = new SkipCache();

/** Verify path — solver_address blocked by the 14d diversity rule. */
export const solverDiversityBlockedUntil = new SkipCache();

/**
 * The diversity cache is necessary but cuts in two directions: every entry
 * blocks future verifies of that solver for 14d. If a small handful of
 * solvers dominate the verifiable pool, the cache can starve our verify
 * income. Watch for cache saturation and warn once per crossing.
 *
 * Threshold default 20 because:
 *  - The discover endpoint typically surfaces 30-100 verifiable per call.
 *  - At 20 unique solvers blocked, we're likely missing >50% of the pool.
 *  - Tuned with BOT_DIVERSITY_CACHE_WARN_AT env if needed.
 */
const DIVERSITY_CACHE_WARN_AT = Number(process.env.BOT_DIVERSITY_CACHE_WARN_AT ?? 20);
let warnedDiversitySaturation = false;
export function maybeWarnDiversitySaturation(): void {
  const n = solverDiversityBlockedUntil.size();
  if (n >= DIVERSITY_CACHE_WARN_AT && !warnedDiversitySaturation) {
    warnedDiversitySaturation = true;
    console.warn(
      `⚠ diversity cache holds ${n} blocked solvers (>= ${DIVERSITY_CACHE_WARN_AT}) — verify income may be throttled. ` +
      `Inspect verification-stats.jsonl or bump BOT_DIVERSITY_CACHE_WARN_AT to silence.`,
    );
  } else if (n < DIVERSITY_CACHE_WARN_AT * 0.5) {
    // Re-arm the warn once we drop to half the threshold so a new spike re-fires.
    warnedDiversitySaturation = false;
  }
}

/**
 * Verify path — solver_address that has verified OUR work 3+ times recently,
 * triggering the gateway's mutual-pair rate limit. Distinct from the diversity
 * cache (we-verified-them) — this is the inverse direction (they-verified-us).
 */
export const reciprocalVerifierSkipUntil = new SkipCache();

/** Mining path — challenge id we've already submitted, gateway 409 told us. */
export const alreadySubmittedChallenges = new SkipCache();

/**
 * Mining path — challenge whose summary failed the specificity gate twice
 * (initial + one enriched retry). Per operator playbooks, failed submissions
 * burn epoch slots and some gateway 400s shadow-mask rate limits — never
 * loop. 24h cooldown, then the challenge may be retried with fresh content.
 */
export const specificityRejectedChallenges = new SkipCache();

/** Mining path — challenge id claimed by another guild until a known ts. */
export const guildClaimedUntil = new SkipCache();

// ─── TTL constants ───────────────────────────────────────────────────────────

const HOUR_MS = 3600_000;
export const FINALIZED_TTL_MS = 24 * HOUR_MS;
export const DIVERSITY_TTL_MS = 14 * 24 * HOUR_MS;
export const ALREADY_SUBMITTED_TTL_MS = 24 * HOUR_MS;
/**
 * Reciprocal mutual-pair TTL. The gateway body says "recently" without
 * specifying a window; 7d is a conservative middle ground (long enough that
 * we don't keep re-tripping the 429, short enough that the pair clears on
 * the same rough cadence as a 14d diversity window). Override with
 * BOT_RECIPROCAL_TTL_HOURS if observed behavior differs.
 */
export const RECIPROCAL_TTL_MS =
  Number(process.env.BOT_RECIPROCAL_TTL_HOURS ?? 168) * HOUR_MS;

// ─── Body-pattern detectors (single source of truth) ─────────────────────────

/** 429 — "verified this solver's work 3+ times in the last 14 days" */
export function isDiversityBlockError(msg: string): boolean {
  return /verified this solver'?s work 3\+? times/i.test(msg);
}

/**
 * 429 — "Reciprocal verification detected: this solver has verified your
 * work 3+ times recently. Mutual verification pairs are limited..."
 * Distinct from diversity (we → them): this is them → us. Same TTL family
 * but a separate cache + body pattern so detectors stay single-purpose.
 */
export function isReciprocalVerificationError(msg: string): boolean {
  return /reciprocal verification detected/i.test(msg);
}

/** 409 — "You already submitted this challenge on <ts>" */
export function isAlreadySubmittedError(msg: string): boolean {
  return /already submitted this challenge/i.test(msg);
}

/** 410 — "Submission already finalized" (status: verified|rejected) */
export function isFinalizedError(msg: string): boolean {
  return /already finalized/i.test(msg);
}

/** 429 — "Maximum N challenges per epoch" / "Maximum N reasoning per current epoch" (epoch cap) */
export function isEpochCapError(msg: string): boolean {
  return /maximum \d+ .*?(?:challenges?|reasoning).*?epoch/i.test(msg);
}

/** 400 — "Challenge is claimed by guild X until <ts>" */
export function isGuildClaimedError(msg: string): boolean {
  return /claimed by guild [^ ]+ until/i.test(msg);
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Pull the ISO timestamp out of the guild-claimed body.
 * Returns the timestamp in ms, or null if the body doesn't have one we can parse.
 */
export function parseGuildClaimedUntilTs(msg: string): number | null {
  const m = msg.match(/until\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}
