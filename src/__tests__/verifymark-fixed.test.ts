/**
 * Review fixes for 6764f40 (verify keeps candidates on temporary errors).
 *
 * The finding: "never strikes" classes had no cap, and the rate-limit wording
 * matched at any status, so a reworded gateway rejection became an endless
 * retry. Each retry that reaches POST /verify has already paid for two grok-4-7
 * xhigh calls (~$0.13/pass, median untagged grok-4-7 estCost $0.065 since
 * 09-29). These tests pin the three bounds now in src/verify-errors.ts:
 *   1. rate wording counts only on a 429 or a status-less error;
 *   2. an unrecognised GATEWAY 429 strikes (Venice 429s don't);
 *   3. a per-submission retry ceiling plus a loop-level failure streak.
 *
 * [log] = verbatim from ~/.nookplot/logs/bot.log or bot.out.log.
 * [reworded] = hypothetical rewording from the review finding (the gateway has
 * reworded these bodies before: "Reciprocal verification detected" was new on 06-10).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVerifyError,
  decideVerifyFailure,
  feedsVerifyStreak,
  isVeniceError,
  nextVerifyStreak,
  NO_VERIFY_STREAK,
  VERIFY_RETRY_DEFAULTS,
  VERIFY_STREAK_DEFAULTS,
  type VerifyErrorKind,
  type VerifyRetryConfig,
  type VerifyRetryState,
  type VerifyStreakConfig,
  type VerifyStreakState,
} from "../verify-errors.js";
import { verifyStreakPause, VERIFY_STREAK_PAUSE_KEY, verifyBudgetPause, VERIFY_BUDGET_PAUSE_KEY } from "../skip-caches.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const CFG: VerifyRetryConfig = { retryAfterMs: 45 * MIN, strikeLimit: 3, retryMax: 8 };
const STREAK: VerifyStreakConfig = { threshold: 3, basePauseMs: 45 * MIN, maxPauseMs: 6 * HOUR, quietResetMs: 12 * HOUR };

// The three bodies from the finding.
const REWORDED_DIVERSITY = "Gateway request failed (429): You have verified this solver 3 or more times";
const REWORDED_RECIPROCAL = "Gateway request failed (429): Mutual verification pair limit reached";
const FORBIDDEN_COOLDOWN = "Gateway request failed (403): Verifier cooldown: RUBBER_STAMP_DETECTED — verification is blocked for this account";
// An account-level block whose wording DOES look like a rate limit: the case only
// the ceiling + streak can bound.
const ACCOUNT_BLOCK_RATE_WORDED = "Gateway request failed (429): Verifier cooldown: RUBBER_STAMP_DETECTED, verification paused for 7 days";

const VENICE_402 =
  'Venice API 402: {"error":"API key DIEM spend limit exceeded. Your account may still have DIEM balance, but this API key has reached its configured DIEM spending limit."}';
const GATEWAY_COOLDOWN_429 =
  "Gateway request failed (429): Verification cooldown: wait 55s before your next verification or crowd score (anti-spam protection, shared across both paths)";
const VENICE_OVERLOADED_429 = 'Venice API 429: {"error":"The model is currently overloaded. Please try again later."}';
const GATEWAY_502_HTML = "Gateway request failed (502): <!DOCTYPE html>\n<!--[if lt IE 7]> <html class=\"no-js ie6 oldie\" lang=\"en-US\"> <![endif]-->";
const SHARED_CAP_429 = "Gateway request failed (429): Maximum 40 verification challenge per 24-hour epoch. Try again next epoch.";

type Row = { src: string; msg: string; kind: VerifyErrorKind; permanent: boolean; strikes: boolean; ceiling: boolean };

const TABLE: Row[] = [
  // ── The finding's three bodies ──────────────────────────────────────────────
  { src: "[reworded]", msg: REWORDED_DIVERSITY, kind: "unknown-429", permanent: false, strikes: true, ceiling: true },
  { src: "[reworded]", msg: REWORDED_RECIPROCAL, kind: "unknown-429", permanent: false, strikes: true, ceiling: true },
  { src: "[reworded]", msg: FORBIDDEN_COOLDOWN, kind: "client-4xx", permanent: true, strikes: false, ceiling: false },
  // ── Rate wording on a non-429 status keeps the status class ─────────────────
  { src: "[reworded]", msg: "Gateway request failed (500): upstream model overloaded", kind: "server", permanent: false, strikes: true, ceiling: true },
  { src: "[reworded]", msg: "Gateway request failed (503): rate limit on the upstream pinning service", kind: "unavailable", permanent: false, strikes: false, ceiling: true },
  { src: "[reworded]", msg: "Gateway request failed (400): too many requests in one batch", kind: "client-4xx", permanent: true, strikes: false, ceiling: false },
  // ── Known rate limits stay no-strike ────────────────────────────────────────
  { src: "[log]", msg: GATEWAY_COOLDOWN_429, kind: "rate", permanent: false, strikes: false, ceiling: true },
  { src: "[log]", msg: "Gateway request failed (429): Rate limit exceeded: max 10 executions per hour", kind: "rate", permanent: false, strikes: false, ceiling: true },
  { src: "[log]", msg: VENICE_OVERLOADED_429, kind: "rate", permanent: false, strikes: false, ceiling: true },
  // A Venice 429 is never about the submission, whatever its wording.
  { src: "[reworded]", msg: 'Venice API 429: {"error":"Too many concurrent requests for this key"}', kind: "rate", permanent: false, strikes: false, ceiling: true },
  { src: "[reworded]", msg: "Rate limit exceeded", kind: "rate", permanent: false, strikes: false, ceiling: true },
  { src: "[reworded]", msg: ACCOUNT_BLOCK_RATE_WORDED, kind: "rate", permanent: false, strikes: false, ceiling: true },
  // ── Loop-level stops: no per-submission counting ────────────────────────────
  { src: "[log]", msg: VENICE_402, kind: "budget", permanent: false, strikes: false, ceiling: false },
  { src: "[test]", msg: SHARED_CAP_429, kind: "verify-cap", permanent: false, strikes: false, ceiling: false },
  // ── Gateway-permanent 429s still win over the generic 429 rules ─────────────
  { src: "[test]", msg: "Gateway request failed (429): You've verified this solver's work 3+ times in the last 14 days", kind: "diversity", permanent: true, strikes: false, ceiling: false },
  { src: "[test]", msg: "Gateway request failed (429): Reciprocal verification detected: this solver has verified your work 3+ times recently.", kind: "reciprocal", permanent: true, strikes: false, ceiling: false },
];

/** Failures (same message every time) until the submission is marked done; Infinity if never. */
function passesUntilDone(msg: string, cfg: VerifyRetryConfig = CFG): number {
  let state: VerifyRetryState = { strikes: 0, attempts: 0 };
  for (let pass = 1; pass <= 1000; pass++) {
    const d = decideVerifyFailure(msg, state, cfg);
    if (d.action === "mark-done") return pass;
    state = { strikes: d.strikesAfter, attempts: d.attemptsAfter };
  }
  return Infinity;
}

describe("verifymark-fixed: classification bounds", () => {
  for (const row of TABLE) {
    it(`${row.src} ${row.kind}: ${row.msg.slice(0, 70)}`, () => {
      const c = classifyVerifyError(row.msg);
      assert.equal(c.kind, row.kind);
      assert.equal(c.permanent, row.permanent);
      assert.equal(c.strikes, row.strikes);
      assert.equal(c.ceiling, row.ceiling);
    });
  }

  it("isVeniceError tells the two error formats apart", () => {
    assert.ok(isVeniceError(VENICE_OVERLOADED_429));
    assert.ok(isVeniceError(VENICE_402));
    assert.equal(isVeniceError(GATEWAY_COOLDOWN_429), false);
    assert.equal(isVeniceError("fetch failed"), false);
  });

  it("every temporary class either counts toward the ceiling or is a loop-level stop", () => {
    for (const row of TABLE) {
      const c = classifyVerifyError(row.msg);
      if (c.permanent || c.ceiling) continue;
      assert.ok(c.kind === "budget" || c.kind === "verify-cap", `${c.kind} is uncapped: ${row.msg}`);
    }
  });
});

describe("verifymark-fixed: passes before a submission is given up", () => {
  it("the finding's bodies: reworded 429s cost 3 passes (was unbounded), the 403 costs 1", () => {
    assert.equal(passesUntilDone(REWORDED_DIVERSITY), 3);
    assert.equal(passesUntilDone(REWORDED_RECIPROCAL), 3);
    assert.equal(passesUntilDone(FORBIDDEN_COOLDOWN), 1);
  });

  it("no-strike classes stop at the retry ceiling instead of retrying forever", () => {
    for (const msg of [GATEWAY_COOLDOWN_429, VENICE_OVERLOADED_429, ACCOUNT_BLOCK_RATE_WORDED, "fetch failed", GATEWAY_502_HTML]) {
      assert.equal(passesUntilDone(msg), CFG.retryMax, msg);
    }
  });

  it("the ceiling retirement says so, and resets the stored counts", () => {
    const d = decideVerifyFailure(GATEWAY_COOLDOWN_429, { strikes: 0, attempts: CFG.retryMax - 1 }, CFG);
    assert.equal(d.action, "mark-done");
    assert.equal(d.retiredBy, "ceiling");
    assert.deepEqual([d.strikesAfter, d.attemptsAfter], [0, 0]);
    const s = decideVerifyFailure(REWORDED_DIVERSITY, { strikes: 2, attempts: 2 }, CFG);
    assert.equal(s.retiredBy, "strikes");
  });

  it("mixed failures: strikes and attempts both accumulate, whichever runs out first retires", () => {
    // 2 strikes, then no-strike failures until the ceiling.
    const seq = [REWORDED_DIVERSITY, "Gateway request failed (500): x", "fetch failed", GATEWAY_502_HTML, VENICE_OVERLOADED_429, "fetch failed", GATEWAY_COOLDOWN_429, GATEWAY_502_HTML];
    let state: VerifyRetryState = { strikes: 0, attempts: 0 };
    const actions: string[] = [];
    let retiredBy: string | null = null;
    for (const msg of seq) {
      const d = decideVerifyFailure(msg, state, CFG);
      actions.push(d.action);
      if (d.action === "mark-done") { retiredBy = d.retiredBy; break; }
      state = { strikes: d.strikesAfter, attempts: d.attemptsAfter };
    }
    assert.equal(actions.length, CFG.retryMax, "retired on the 8th failure");
    assert.equal(state.strikes, 2, "two strikes were not enough on their own");
    assert.equal(retiredBy, "ceiling");
  });

  it("the 402 and the shared-cap halt never retire a candidate (the loop stop bounds them)", () => {
    assert.equal(passesUntilDone(VENICE_402), Infinity);
    assert.equal(passesUntilDone(SHARED_CAP_429), Infinity);
  });

  it("defaults: ceiling 8 unless BOT_VERIFY_RETRY_MAX is set", () => {
    assert.equal(VERIFY_RETRY_DEFAULTS.retryMax, 8);
  });
});

describe("verifymark-fixed: loop-level failure streak", () => {
  const fail = (s: VerifyStreakState, now: number) => nextVerifyStreak(s, "failure", now, STREAK);

  it("trips on the third consecutive failure with the base pause", () => {
    let s = NO_VERIFY_STREAK;
    let r = fail(s, 1); s = r.state; assert.equal(r.pauseMs, 0);
    r = fail(s, 2); s = r.state; assert.equal(r.pauseMs, 0);
    r = fail(s, 3); s = r.state;
    assert.equal(r.pauseMs, 45 * MIN);
    assert.equal(s.trips, 1);
  });

  it("each further failure after a trip re-trips with a doubled pause, capped at 6h", () => {
    let s: VerifyStreakState = NO_VERIFY_STREAK;
    const pauses: number[] = [];
    let now = 0;
    for (let i = 0; i < 9; i++) {
      now += 10 * MIN;
      const r = fail(s, now);
      s = r.state;
      if (r.pauseMs > 0) pauses.push(r.pauseMs / MIN);
    }
    assert.deepEqual(pauses, [45, 90, 180, 360, 360, 360, 360]);
  });

  it("a success clears the streak and the backoff", () => {
    let s: VerifyStreakState = { count: 2, trips: 4, lastFailureAt: 100 };
    s = nextVerifyStreak(s, "success", 200, STREAK).state;
    assert.deepEqual(s, NO_VERIFY_STREAK);
    assert.equal(fail(s, 300).pauseMs, 0);
  });

  it("a quiet gap longer than quietResetMs starts the streak over", () => {
    const s: VerifyStreakState = { count: 2, trips: 3, lastFailureAt: 0 + 1 };
    const r = fail(s, 1 + STREAK.quietResetMs + 1);
    assert.equal(r.pauseMs, 0);
    assert.deepEqual(r.state, { count: 1, trips: 0, lastFailureAt: 1 + STREAK.quietResetMs + 1 });
    // Within the window it re-trips.
    assert.ok(fail(s, 1 + STREAK.quietResetMs).pauseMs > 0);
  });

  it("threshold 1 pauses on every failure", () => {
    const one: VerifyStreakConfig = { ...STREAK, threshold: 1 };
    const r1 = nextVerifyStreak(NO_VERIFY_STREAK, "failure", 1, one);
    assert.equal(r1.pauseMs, 45 * MIN);
    assert.equal(nextVerifyStreak(r1.state, "failure", 2, one).pauseMs, 90 * MIN);
  });

  it("feeds on temporary per-submission failures only", () => {
    const feeds = (msg: string) => feedsVerifyStreak(decideVerifyFailure(msg, {}, CFG));
    for (const msg of [GATEWAY_COOLDOWN_429, REWORDED_DIVERSITY, "fetch failed", GATEWAY_502_HTML, "Gateway request failed (500): x"]) {
      assert.equal(feeds(msg), true, msg);
    }
    // Retirements still feed (a submission given up on is still a failed pass).
    assert.equal(feedsVerifyStreak(decideVerifyFailure(REWORDED_DIVERSITY, { strikes: 2 }, CFG)), true);
    for (const msg of [VENICE_402, SHARED_CAP_429, FORBIDDEN_COOLDOWN, "Gateway request failed (410): Submission already finalized (status: verified)"]) {
      assert.equal(feeds(msg), false, msg);
    }
  });

  it("defaults: threshold 3, 45m base, 6h cap, 12h quiet reset", () => {
    assert.deepEqual(VERIFY_STREAK_DEFAULTS, { threshold: 3, basePauseMs: 45 * MIN, maxPauseMs: 6 * HOUR, quietResetMs: 12 * HOUR });
  });

  it("the streak pause is its own cache key, separate from the 402 pause", () => {
    verifyStreakPause.markFor(VERIFY_STREAK_PAUSE_KEY, 60_000);
    assert.ok(verifyStreakPause.isSkipped(VERIFY_STREAK_PAUSE_KEY));
    assert.equal(verifyBudgetPause.isSkipped(VERIFY_BUDGET_PAUSE_KEY), false);
    verifyStreakPause.markUntil(VERIFY_STREAK_PAUSE_KEY, Date.now() - 1);
    assert.equal(verifyStreakPause.isSkipped(VERIFY_STREAK_PAUSE_KEY), false);
  });
});

/**
 * Model of the verify loop for one day under a failure that hits EVERY
 * candidate at POST /verify (the finding's scenario): 5-min non-overlapping
 * polls, batch of 5, ~2.5 min per pass (70s pacing + call latency), the real
 * decideVerifyFailure / nextVerifyStreak. `bounded=false` emulates 6764f40
 * (no ceiling, no streak). Counts scoring passes, each ~$0.13.
 */
function simulateDay(msg: string, pool: number, bounded: boolean): number {
  const retryCfg: VerifyRetryConfig = bounded ? CFG : { ...CFG, retryMax: Infinity };
  const streakCfg: VerifyStreakConfig = bounded ? STREAK : { ...STREAK, threshold: Infinity };
  const DAY = 24 * HOUR, PASS_MS = 150_000, POLL_MS = 5 * MIN, BATCH = 5;
  const done = new Set<number>();
  const skipUntil = new Map<number, number>();
  const state = new Map<number, VerifyRetryState>();
  let streak = NO_VERIFY_STREAK;
  let pausedUntil = 0;
  let passes = 0;
  let t = 0;
  while (t < DAY) {
    let pt = t;
    if (pt >= pausedUntil) {
      const batch = [...Array(pool).keys()].filter((i) => !done.has(i) && (skipUntil.get(i) ?? 0) <= pt).slice(0, BATCH);
      for (const i of batch) {
        if (pt >= DAY || pt < pausedUntil) break;
        passes++;
        pt += PASS_MS;
        const d = decideVerifyFailure(msg, state.get(i) ?? {}, retryCfg);
        if (d.action === "mark-done") { done.add(i); state.delete(i); }
        else { state.set(i, { strikes: d.strikesAfter, attempts: d.attemptsAfter }); skipUntil.set(i, pt + d.retryAfterMs); }
        if (d.pauseAllMs > 0) pausedUntil = Math.max(pausedUntil, pt + d.pauseAllMs);
        if (feedsVerifyStreak(d)) {
          const n = nextVerifyStreak(streak, "failure", pt, streakCfg);
          streak = n.state;
          if (n.pauseMs > 0) pausedUntil = Math.max(pausedUntil, pt + n.pauseMs);
        }
      }
    }
    t = Math.max(t + POLL_MS, Math.ceil(pt / POLL_MS) * POLL_MS);
  }
  return passes;
}

describe("verifymark-fixed: one-day spend model of the finding's scenario (30 candidates)", () => {
  it("an account-level block worded like a rate limit: unbounded before, a handful of passes now", () => {
    const before = simulateDay(ACCOUNT_BLOCK_RATE_WORDED, 30, false);
    const after = simulateDay(ACCOUNT_BLOCK_RATE_WORDED, 30, true);
    // Before (measured 480 in this model): the lane runs flat out all day, ~$0.13 a pass.
    assert.ok(before >= 300, `before=${before}`);
    // After (measured 9): 3 passes to trip, then one per escalating pause (45m, 90m, 3h, 6h, 6h, 6h).
    assert.ok(after <= 10, `after=${after}`);
  });

  it("a reworded diversity 429 is bounded the same way", () => {
    assert.ok(simulateDay(REWORDED_DIVERSITY, 30, true) <= 10);
  });

  it("a 403 with 'cooldown' in it costs one pass per candidate at most, then the streak ignores it", () => {
    // Permanent outcomes don't feed the streak, so this is bounded by the pool size.
    assert.equal(simulateDay(FORBIDDEN_COOLDOWN, 30, true), 30);
  });

  it("a Venice 402 day costs passes only at pause expiry and never retires a candidate", () => {
    const passes = simulateDay(VENICE_402, 30, true);
    // One pass per 45-min budget pause (no Venice spend: the key refuses).
    assert.ok(passes <= 33, `passes=${passes}`);
  });
});
