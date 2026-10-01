/**
 * Venice stand-down (venice-breaker.ts) and failed-call ledger rows
 * (venice-cost.ts), 2026-10-01. Pure functions and in-memory state only:
 * nothing here writes to ~/.nookplot or reaches the network.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVeniceBillingError,
  nextUtcMidnightMs,
  standDownUntilMs,
  noteVeniceError,
  noteVeniceNextEpoch,
  veniceStandingDown,
  standDownSkip,
  VeniceStandDownError,
  isVeniceStandDownError,
  isVeniceBillingError,
  _resetVeniceBreakerForTests,
  LOCKOUT_PAUSE_MS,
  REFILL_GRACE_MS,
} from "../venice-breaker.js";
import {
  buildFailedCallEntry,
  findTaggableIndex,
  summarizeFailedCalls,
  computeParseFailureRates,
  type CostEntry,
} from "../venice-cost.js";
import { chat, classifyChatError, failureCause } from "../venice.js";
import { isTransientGenerationError } from "../mining.js";
import { jevDecide, _resetJevForTests } from "../jev.js";
import { assessVeniceBalance } from "../venice-balance.js";
import { dailySpendSeries } from "../pnl.js";
import { learningLogDoneIds } from "../learnings.js";

// Real 402 bodies from ~/.nookplot/logs/bot.log (2026-09-28 and 2026-10-01).
const DIEM_LIMIT =
  'Venice API 402: {"error":"API key DIEM spend limit exceeded. Your account may still have DIEM balance, but this API key has reached its configured DIEM spending limit."}';
const USD_LIMIT =
  'Venice API 402: {"error":"API key USD spend limit exceeded. Your account may still have USD balance, but this API key has reached its configured USD spending limit."}';
const INSUFFICIENT =
  'Venice API 402: {"error":"Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits."}';
const OVERLOADED = 'Venice API 429: {"error":"The model is currently overloaded. Please try again later."}';
const LOCKOUT = 'Venice API 429: {"error":"Too many failed attempts (> 50). Try again later."}';

const T_0346 = Date.parse("2026-10-01T03:46:24.194Z");
const NEXT_MIDNIGHT = Date.parse("2026-10-02T00:00:00.000Z");

const silent = () => {};

describe("venice-breaker: classifying refusals", () => {
  it("spend-limit and balance 402s pause until the refill; an overloaded 429 does not pause", () => {
    assert.equal(classifyVeniceBillingError(DIEM_LIMIT)?.kind, "key-spend-limit");
    assert.match(classifyVeniceBillingError(DIEM_LIMIT)!.label, /DIEM/);
    assert.equal(classifyVeniceBillingError(USD_LIMIT)?.kind, "key-spend-limit");
    assert.match(classifyVeniceBillingError(USD_LIMIT)!.label, /USD/);
    assert.equal(classifyVeniceBillingError(INSUFFICIENT)?.kind, "insufficient-balance");
    for (const m of [DIEM_LIMIT, USD_LIMIT, INSUFFICIENT]) assert.equal(classifyVeniceBillingError(m)?.untilRefill, true);
    assert.equal(classifyVeniceBillingError(LOCKOUT)?.kind, "failed-attempt-lockout");
    assert.equal(classifyVeniceBillingError(OVERLOADED), null);
    assert.equal(classifyVeniceBillingError('Venice API 400: {"error":"bad max_tokens"}'), null);
    assert.equal(classifyVeniceBillingError("fetch failed (UND_ERR_HEADERS_TIMEOUT)"), null);
    assert.equal(classifyVeniceBillingError(undefined), null);
  });

  it("an unrecognised 402 body still pauses, for 30 min; Jev's HTTP form is understood", () => {
    const unknown = classifyVeniceBillingError("Venice API 402: Payment Required");
    assert.equal(unknown?.kind, "payment-required");
    assert.equal(unknown?.untilRefill, false);
    assert.equal(classifyVeniceBillingError('HTTP 402: {"error":"API key DIEM spend limit exceeded."}')?.kind, "key-spend-limit");
  });

  it("isVeniceBillingError matches the mining-log note even after its 200-char slice", () => {
    assert.equal(isVeniceBillingError(DIEM_LIMIT.slice(0, 200)), true);
    assert.equal(isVeniceBillingError(DIEM_LIMIT.slice(0, 20)), true, "a bare 'Venice API 402' still counts");
    assert.equal(isVeniceBillingError("Venice stand-down (API key DIEM spend limit) until 2026-10-02T00:02:00.000Z; no request sent"), true);
    assert.equal(isVeniceBillingError(OVERLOADED), false);
    assert.equal(isVeniceBillingError("Gateway request failed (409): already submitted"), false);
    assert.equal(isVeniceBillingError(undefined), false);
  });
});

describe("venice-breaker: when a pause ends", () => {
  it("a refill pause runs to the next 00:00Z plus grace", () => {
    assert.equal(nextUtcMidnightMs(T_0346), NEXT_MIDNIGHT);
    const err = classifyVeniceBillingError(DIEM_LIMIT)!;
    assert.equal(standDownUntilMs(err, T_0346), NEXT_MIDNIGHT + REFILL_GRACE_MS);
  });

  it("honours a sane nextEpochBegins and ignores a past or far-future one", () => {
    const err = classifyVeniceBillingError(DIEM_LIMIT)!;
    const epoch = "2026-10-01T23:30:00.000Z";
    assert.equal(standDownUntilMs(err, T_0346, epoch), Date.parse(epoch) + REFILL_GRACE_MS);
    assert.equal(standDownUntilMs(err, T_0346, "2026-09-30T00:00:00.000Z"), NEXT_MIDNIGHT + REFILL_GRACE_MS);
    assert.equal(standDownUntilMs(err, T_0346, "2026-10-09T00:00:00.000Z"), NEXT_MIDNIGHT + REFILL_GRACE_MS);
    assert.equal(standDownUntilMs(err, T_0346, "garbage"), NEXT_MIDNIGHT + REFILL_GRACE_MS);
  });

  it("just after midnight a spend-limit 402 pauses 30 min, not a whole day (refill may still be landing)", () => {
    const err = classifyVeniceBillingError(DIEM_LIMIT)!;
    const t = Date.parse("2026-10-02T00:05:00Z");
    assert.equal(standDownUntilMs(err, t), t + LOCKOUT_PAUSE_MS);
    const later = Date.parse("2026-10-02T00:20:00Z");
    assert.equal(standDownUntilMs(err, later), Date.parse("2026-10-03T00:00:00Z") + REFILL_GRACE_MS);
  });

  it("a lockout pauses 30 min", () => {
    assert.equal(standDownUntilMs(classifyVeniceBillingError(LOCKOUT)!, T_0346), T_0346 + LOCKOUT_PAUSE_MS);
  });
});

describe("venice-breaker: state and logging", () => {
  const savedFlag = process.env.BOT_VENICE_STANDDOWN;
  beforeEach(() => {
    _resetVeniceBreakerForTests();
    delete process.env.BOT_VENICE_STANDDOWN;
  });
  afterEach(() => {
    _resetVeniceBreakerForTests();
    if (savedFlag === undefined) delete process.env.BOT_VENICE_STANDDOWN;
    else process.env.BOT_VENICE_STANDDOWN = savedFlag;
  });

  it("trips once on a spend-limit 402; concurrent 402s add no log lines; it lifts at the refill", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    assert.equal(veniceStandingDown(T_0346).active, false);
    const s = noteVeniceError(DIEM_LIMIT, T_0346, { log });
    assert.equal(s?.active, true);
    assert.equal(s?.untilMs, NEXT_MIDNIGHT + REFILL_GRACE_MS);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /pausing ALL Venice calls until 2026-10-02T00:02:00.000Z/);
    // Two more in-flight calls 402 a moment later: already covered.
    assert.equal(noteVeniceError(DIEM_LIMIT, T_0346 + 1000, { log }), null);
    assert.equal(noteVeniceError(USD_LIMIT, T_0346 + 2000, { log }), null);
    assert.equal(lines.length, 1);
    assert.equal(veniceStandingDown(NEXT_MIDNIGHT + REFILL_GRACE_MS - 1).active, true);
    assert.equal(veniceStandingDown(NEXT_MIDNIGHT + REFILL_GRACE_MS).active, false);
  });

  it("ignores errors that are not refusals", () => {
    const lines: string[] = [];
    assert.equal(noteVeniceError(OVERLOADED, T_0346, { log: (l) => lines.push(l) }), null);
    assert.equal(noteVeniceError("fetch failed", T_0346, { log: (l) => lines.push(l) }), null);
    assert.equal(veniceStandingDown(T_0346).active, false);
    assert.equal(lines.length, 0);
  });

  it("a lockout during a short pause extends it; a later refill pause extends again", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    noteVeniceError("Venice API 402: Payment Required", T_0346, { log });
    const first = veniceStandingDown(T_0346);
    noteVeniceError(DIEM_LIMIT, T_0346 + 60_000, { log });
    const second = veniceStandingDown(T_0346 + 60_000);
    assert.ok(second.untilMs > first.untilMs);
    assert.equal(second.pauseId, first.pauseId, "an extension is the same pause");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /extended/);
  });

  it("uses the refill time the balance watch last saw", () => {
    noteVeniceNextEpoch("2026-10-01T23:00:00.000Z");
    noteVeniceError(DIEM_LIMIT, T_0346, { log: silent });
    assert.equal(veniceStandingDown(T_0346).until, "2026-10-01T23:02:00.000Z");
  });

  it("stand-down end times are whole seconds (a '.502Z' suffix must not read as an HTTP status)", () => {
    noteVeniceError(LOCKOUT, T_0346, { log: silent });
    const until = veniceStandingDown(T_0346).until!;
    assert.match(until, /\.000Z$/);
  });

  it("BOT_VENICE_STANDDOWN=0 disables it", () => {
    process.env.BOT_VENICE_STANDDOWN = "0";
    assert.equal(noteVeniceError(DIEM_LIMIT, T_0346, { log: silent }), null);
    assert.equal(veniceStandingDown(T_0346).active, false);
    assert.equal(standDownSkip("mining", T_0346, silent), false);
  });

  it("standDownSkip logs once per loop per pause, and again for a new pause", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    assert.equal(standDownSkip("mining", T_0346, log), false);
    noteVeniceError(DIEM_LIMIT, T_0346, { log: silent });
    for (let i = 0; i < 5; i++) assert.equal(standDownSkip("mining", T_0346 + i * 900_000, log), true);
    assert.equal(standDownSkip("verify", T_0346, log), true);
    assert.equal(standDownSkip("verify", T_0346 + 1, log), true);
    assert.deepEqual(lines.map((l) => l.split(" skipped")[0]), ["⏸ mining", "⏸ verify"]);
    // Next day: the pause lifted, a fresh 402 starts a new pause → each loop logs once more.
    const nextDay = NEXT_MIDNIGHT + 4 * 3600_000;
    assert.equal(standDownSkip("mining", nextDay, log), false);
    noteVeniceError(DIEM_LIMIT, nextDay, { log: silent });
    assert.equal(standDownSkip("mining", nextDay, log), true);
    assert.equal(standDownSkip("mining", nextDay + 1, log), true);
    assert.equal(lines.length, 3);
  });

  it("the stand-down error is not transient to any retry/failover classifier", () => {
    noteVeniceError(LOCKOUT, T_0346, { log: silent });
    const err = new VeniceStandDownError(veniceStandingDown(T_0346));
    assert.equal(isVeniceStandDownError(err), true);
    assert.equal(isVeniceStandDownError(new Error(err.message)), true);
    assert.equal(isVeniceStandDownError(new Error(OVERLOADED)), false);
    assert.equal(isVeniceBillingError(err.message), true);
    assert.equal(isTransientGenerationError(err.message), false, "must not fail over to another model");
    const cls = classifyChatError(err, 10);
    assert.equal(cls.transient, false);
    assert.equal(cls.isAbort, false);
  });

  it("chat() refuses while standing down, before the key check and any request", async () => {
    // npm test blanks VENICE_API_KEY: if the stand-down check were missing or
    // late, chat() would fail on the key instead (still with no request).
    noteVeniceError(DIEM_LIMIT, Date.now(), { log: silent });
    await assert.rejects(
      chat([{ role: "user", content: "hi" }]),
      (err: unknown) => isVeniceStandDownError(err) && /API key DIEM spend limit/.test((err as Error).message),
    );
  });
});

describe("jev feeds and respects the shared stand-down", () => {
  const savedKey = process.env.VENICE_API_KEY;
  const savedJev = process.env.BOT_JEV;
  beforeEach(() => {
    _resetJevForTests();
    process.env.VENICE_API_KEY = "test-key";
    delete process.env.BOT_JEV;
  });
  afterEach(() => {
    _resetJevForTests();
    if (savedKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = savedKey;
    if (savedJev === undefined) delete process.env.BOT_JEV;
    else process.env.BOT_JEV = savedJev;
  });

  it("a Jev 402 spend limit trips the process-wide stand-down", async () => {
    const now = T_0346;
    const f = (async () =>
      new Response(JSON.stringify({ error: "API key DIEM spend limit exceeded. Your account may still have DIEM balance" }), { status: 402 })) as unknown as typeof fetch;
    assert.equal(await jevDecide({}, {}, { fetchImpl: f, onCost: () => {}, nowMs: now }), null);
    const s = veniceStandingDown(now);
    assert.equal(s.active, true);
    assert.equal(s.kind, "key-spend-limit");
    assert.equal(s.untilMs, NEXT_MIDNIGHT + REFILL_GRACE_MS);
  });

  it("an ordinary Jev 429 pauses Jev only", async () => {
    const f = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    await jevDecide({}, {}, { fetchImpl: f, onCost: () => {}, nowMs: T_0346 });
    assert.equal(veniceStandingDown(T_0346).active, false);
  });

  it("a stand-down tripped by chat() stops Jev without a request", async () => {
    noteVeniceError(DIEM_LIMIT, T_0346, { log: silent });
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await jevDecide({}, {}, { fetchImpl: f, onCost: () => {}, nowMs: T_0346 + 60_000 }), null);
    assert.equal(calls, 0);
  });
});

describe("failed-call ledger rows (venice-cost)", () => {
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const row = (over: Partial<CostEntry>): CostEntry => ({
    ts: new Date(NOW).toISOString(),
    model: "grok-4-7",
    promptTokens: 1000,
    completionTokens: 4000,
    totalTokens: 5000,
    estCost: 0.03,
    ...over,
  });

  it("buildFailedCallEntry is a zero-usage, zero-cost row with timing and cause", () => {
    const e = buildFailedCallEntry(
      { model: "grok-4-7", outcome: "timeout", elapsedMs: 303_412.7, attempts: 2, cause: "UND_ERR_HEADERS_TIMEOUT" },
      NOW,
    );
    assert.equal(e.ts, "2026-10-01T12:00:00.000Z");
    assert.equal(e.outcome, "timeout");
    assert.equal(e.totalTokens, 0);
    assert.equal(e.estCost, 0, "the daily spend sum and the cost alert stay unchanged");
    assert.equal(e.elapsedMs, 303_413);
    assert.equal(e.attempts, 2);
    assert.equal(e.callSite, undefined);
    assert.equal(buildFailedCallEntry({ model: "m", outcome: "other-error", elapsedMs: 1, attempts: 1, cause: "x".repeat(500) }).cause!.length, 160);
  });

  it("a parse tag skips failure and marker rows and lands on the newest real response", () => {
    const entries: CostEntry[] = [
      row({ outcome: "ok" }),
      row({ model: "other-model", outcome: "ok" }),
      row({ outcome: "timeout", totalTokens: 0, estCost: 0 }),
      row({ outcome: "other-error", totalTokens: 0, estCost: 0 }),
      row({ outcome: "rate-limited", totalTokens: 0, estCost: 0 }),
      row({ outcome: "submit-reject", totalTokens: 0, estCost: 0, callSite: "mining_solve" }),
    ];
    assert.equal(findTaggableIndex(entries, "grok-4-7"), 0);
    assert.equal(findTaggableIndex(entries, "other-model"), 1);
    assert.equal(findTaggableIndex(entries.slice(2), "grok-4-7"), -1, "only markers: tag nothing");
    assert.equal(findTaggableIndex([row({ outcome: "parse-ok" })], "grok-4-7"), 0, "re-tagging a tagged response still works");
    assert.equal(findTaggableIndex([], "grok-4-7"), -1);
  });

  it("failure rows never move the parse-fail breaker, even if one carried a callSite", () => {
    const base = [
      row({ outcome: "parse-fail", callSite: "mining_solve" }),
      row({ outcome: "parse-ok", callSite: "mining_solve" }),
    ];
    const withFailures = [
      ...base,
      row({ outcome: "timeout", callSite: "mining_solve", totalTokens: 0, estCost: 0 }),
      row({ outcome: "other-error", callSite: "mining_solve", totalTokens: 0, estCost: 0 }),
    ];
    const a = computeParseFailureRates(base, 10, NOW + 1000)["grok-4-7"];
    const b = computeParseFailureRates(withFailures, 10, NOW + 1000)["grok-4-7"];
    assert.equal(b.attempts, a.attempts);
    assert.equal(b.rate, 0.5);
  });

  it("summarizeFailedCalls counts the day's failures by outcome and model", () => {
    const entries: CostEntry[] = [
      row({ outcome: "ok" }),
      row({ outcome: "rate-limited", totalTokens: 0, estCost: 0 }),
      buildFailedCallEntry({ model: "grok-4-7", outcome: "timeout", elapsedMs: 600_000, attempts: 2, cause: "aborted" }, NOW),
      buildFailedCallEntry({ model: "grok-4-7", outcome: "other-error", elapsedMs: 900, attempts: 1, cause: "http 402 (API key DIEM spend limit)" }, NOW + 5000),
      buildFailedCallEntry({ model: "jev-latest", outcome: "other-error", elapsedMs: 100, attempts: 1, cause: "http 500" }, NOW - 1000),
      buildFailedCallEntry({ model: "grok-4-7", outcome: "timeout", elapsedMs: 1, attempts: 1, cause: "aborted" }, NOW - 86_400_000),
    ];
    const s = summarizeFailedCalls(entries, "2026-10-01");
    assert.equal(s.total, 3);
    assert.deepEqual(s.byOutcome, { timeout: 1, "other-error": 2 });
    assert.deepEqual(s.byModel, { "grok-4-7": 2, "jev-latest": 1 });
    assert.equal(s.elapsedMs, 600_000 + 900 + 100);
    assert.equal(s.last?.cause, "http 402 (API key DIEM spend limit)");
    assert.equal(summarizeFailedCalls(entries, "2026-09-30").total, 1);
    assert.equal(summarizeFailedCalls([], "2026-10-01").last, null);
  });

  it("the P&L call count skips failure rows", () => {
    const entries = [
      { ts: "2026-10-01T01:00:00Z", estCost: 0.05, outcome: "ok" },
      { ts: "2026-10-01T02:00:00Z", estCost: 0, outcome: "timeout" },
      { ts: "2026-10-01T03:00:00Z", estCost: 0, outcome: "other-error" },
    ];
    const [day] = dailySpendSeries(entries, 1, NOW);
    assert.equal(day.calls, 1);
    assert.equal(day.spendUsd, 0.05);
  });

  it("failureCause names the transport code, the HTTP status, or the abort", () => {
    assert.equal(failureCause(new Error("fetch failed (UND_ERR_HEADERS_TIMEOUT)"), "UND_ERR_HEADERS_TIMEOUT"), "UND_ERR_HEADERS_TIMEOUT");
    assert.equal(failureCause(new Error(DIEM_LIMIT)), "http 402 (API key DIEM spend limit)");
    assert.equal(failureCause(new Error('Venice API 500: {"error":"Inference processing failed"}')), "http 500");
    assert.equal(failureCause(new Error("This operation was aborted")), "aborted");
    assert.equal(failureCause(new Error("x".repeat(300))).length, 120);
  });
});

describe("venice-balance says what it cannot see", () => {
  it("the low-balance warning names the per-key spend-limit blind spot", () => {
    const msg = assessVeniceBalance({ usd: 0, diem: 5.78, nextEpochBegins: "2026-10-02T00:00:00.000Z" }, 10);
    assert.ok(msg);
    assert.match(msg!, /cannot see a per-API-key DIEM\/USD spend limit/);
    assert.match(msg!, /balance low/i);
    assert.match(msg!, /2026-10-02T00:00:00.000Z/);
  });
});

describe("billing refusals don't mark work done", () => {
  it("a learnings row written by a 402 leaves the learning owed; every other row marks it done", () => {
    const done = learningLogDoneIds([
      // Real 2026-10-01 shape: the loop's catch wrote the 402 as an error row.
      { submissionId: "f175328a", status: "error", notes: DIEM_LIMIT.slice(0, 200) },
      { submissionId: "aaaa", status: "error", notes: "gen fail" },
      { submissionId: "bbbb", status: "posted" },
      { submissionId: "cccc", status: "rejection-analyzed", notes: "tests_failed 6/7" },
      { submissionId: "dddd", status: "error", notes: "Venice stand-down (API key DIEM spend limit) until 2026-10-02T00:02:00.000Z; no request sent" },
      { submissionId: "eeee", status: "error", notes: DIEM_LIMIT },
      { submissionId: "eeee", status: "posted" },
    ]);
    assert.deepEqual([...done].sort(), ["aaaa", "bbbb", "cccc", "eeee"]);
  });
});
