/**
 * Early lift of a refill-bound Venice stand-down (review fix, 2026-10-01).
 *
 * The finding: an `insufficient-balance` or `key-spend-limit` 402 paused ALL
 * Venice use until 00:02Z, and nothing but a restart lifted it. A 04:00Z
 * dry-out topped up at 05:00Z kept mining/verify/posting skipped for ~19h.
 *
 * In-memory state and a stubbed fetch only: nothing here writes to
 * ~/.nookplot or reaches the network (fetchVeniceBalances is driven through a
 * replaced globalThis.fetch; maybeWarnVeniceBalance, which appends the balance
 * log, is not called).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  noteVeniceError,
  noteVeniceBalanceReading,
  liftVeniceStandDown,
  veniceStandingDown,
  standDownSkip,
  standDownRemedy,
  _resetVeniceBreakerForTests,
  LIFT_MIN_SPENDABLE,
  REFILL_GRACE_MS,
  RESTART_HINT,
} from "../venice-breaker.js";
import { feedVeniceBreaker, fetchVeniceBalances } from "../venice-balance.js";

// Real 402 bodies from ~/.nookplot/logs/bot.log (08-05 and 10-01) and a lockout.
const INSUFFICIENT =
  'Venice API 402: {"error":"Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits."}';
const DIEM_LIMIT =
  'Venice API 402: {"error":"API key DIEM spend limit exceeded. Your account may still have DIEM balance, but this API key has reached its configured DIEM spending limit."}';
const LOCKOUT = 'Venice API 429: {"error":"Too many failed attempts (> 50). Try again later."}';

// The finding's scenario: dry at 04:00Z, topped up at 05:00Z.
const T_DRY = Date.parse("2026-10-01T04:00:00.000Z");
const T_TOPUP_READ = Date.parse("2026-10-01T05:20:00.000Z");
const NEXT_REFILL = Date.parse("2026-10-02T00:00:00.000Z") + REFILL_GRACE_MS;
const MIN = 60_000;

const silent = () => {};
const reading = (spendable: number, fetchedAtMs: number, accessPermitted: boolean | null = true) => ({
  spendable,
  fetchedAtMs,
  accessPermitted,
});

describe("venice stand-down: early lift from the balance watch", () => {
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

  it("a top-up lifts an insufficient-balance pause at the next reading, not at 00:02Z", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(veniceStandingDown(T_DRY).untilMs, NEXT_REFILL);
    // Still dry at the first tick after the refusal: no lift.
    assert.equal(noteVeniceBalanceReading(reading(0, T_DRY + 20 * MIN), T_DRY + 20 * MIN, silent), false);
    assert.equal(standDownSkip("mining", T_DRY + 20 * MIN, silent), true);
    // Operator adds $20 at 05:00Z; the 05:20Z tick sees it.
    const lines: string[] = [];
    assert.equal(noteVeniceBalanceReading(reading(20, T_TOPUP_READ), T_TOPUP_READ, (l) => lines.push(l)), true);
    assert.equal(veniceStandingDown(T_TOPUP_READ).active, false);
    assert.equal(standDownSkip("mining", T_TOPUP_READ, silent), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /lifted early \(insufficient USD\/DIEM balance; was until 2026-10-02T00:02:00\.000Z\): balance now reads 20\.00/);
  });

  it("a residue under LIFT_MIN_SPENDABLE does not lift (0.22 was read on 09-28 just before the 402s)", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(0.22, T_TOPUP_READ), T_TOPUP_READ, silent), false);
    assert.equal(noteVeniceBalanceReading(reading(LIFT_MIN_SPENDABLE - 0.01, T_TOPUP_READ), T_TOPUP_READ, silent), false);
    assert.equal(veniceStandingDown(T_TOPUP_READ).active, true);
    assert.equal(noteVeniceBalanceReading(reading(LIFT_MIN_SPENDABLE, T_TOPUP_READ), T_TOPUP_READ, silent), true);
  });

  it("a reading SENT before the refusal cannot lift it, even if it lands after", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(9, T_DRY - 1000), T_DRY + 2000, silent), false);
    assert.equal(veniceStandingDown(T_DRY + 2000).active, true);
  });

  it("accessPermitted=false blocks a lift whatever the balance says", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(25, T_TOPUP_READ, false), T_TOPUP_READ, silent), false);
    assert.equal(veniceStandingDown(T_TOPUP_READ).active, true);
    // A missing field is not a refusal: the balance alone decides.
    assert.equal(noteVeniceBalanceReading(reading(25, T_TOPUP_READ + MIN, null), T_TOPUP_READ + MIN, silent), true);
  });

  it("a lift the next call refuses again doesn't repeat at the same balance; a real top-up still lifts", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(5, T_TOPUP_READ), T_TOPUP_READ, silent), true);
    // The first call after the lift is refused again: Venice won't spend that 5.
    const reTrip = T_TOPUP_READ + MIN;
    noteVeniceError(INSUFFICIENT, reTrip, { log: silent });
    for (let i = 1; i <= 4; i++) {
      const t = reTrip + i * 30 * MIN;
      assert.equal(noteVeniceBalanceReading(reading(5, t), t, silent), false, `tick ${i}: same stuck balance must not lift`);
    }
    // Operator adds $10 more.
    const t = reTrip + 5 * 30 * MIN;
    assert.equal(noteVeniceBalanceReading(reading(15, t), t, silent), true);
  });

  it("the bar clears once spending shows the lift worked, so a later same-size top-up lifts", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(10, T_TOPUP_READ), T_TOPUP_READ, silent), true);
    // Calls are billed: the next readings go down, and the account runs dry again.
    noteVeniceBalanceReading(reading(6.5, T_TOPUP_READ + 30 * MIN), T_TOPUP_READ + 30 * MIN, silent);
    const dryAgain = T_TOPUP_READ + 3 * 3600_000;
    noteVeniceError(INSUFFICIENT, dryAgain, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(10, dryAgain + 30 * MIN), dryAgain + 30 * MIN, silent), true);
  });

  it("a key spend limit is NOT lifted by the account balance (the cap is on the key)", () => {
    noteVeniceError(DIEM_LIMIT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(38.73, T_TOPUP_READ, true), T_TOPUP_READ, silent), false);
    assert.equal(noteVeniceBalanceReading(reading(38.73, T_TOPUP_READ + MIN, null), T_TOPUP_READ + MIN, silent), false);
    assert.equal(veniceStandingDown(T_TOPUP_READ + MIN).active, true);
  });

  it("a key spend limit lifts when accessPermitted flips false → true within the pause", () => {
    noteVeniceError(DIEM_LIMIT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(0, T_DRY + 20 * MIN, false), T_DRY + 20 * MIN, silent), false);
    const lines: string[] = [];
    assert.equal(noteVeniceBalanceReading(reading(0, T_TOPUP_READ, true), T_TOPUP_READ, (l) => lines.push(l)), true);
    assert.match(lines[0], /accessPermitted=true/);
    // A new pause needs its own false reading: the earlier one doesn't carry over.
    const reTrip = T_TOPUP_READ + MIN;
    noteVeniceError(DIEM_LIMIT, reTrip, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(0, reTrip + 30 * MIN, true), reTrip + 30 * MIN, silent), false);
  });

  it("30-minute pauses (lockout) are left to expire", () => {
    noteVeniceError(LOCKOUT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(30, T_DRY + 10 * MIN), T_DRY + 10 * MIN, silent), false);
    assert.equal(veniceStandingDown(T_DRY + 10 * MIN).active, true);
  });

  it("readings outside a pause, bad numbers, and BOT_VENICE_STANDDOWN=0 do nothing", () => {
    assert.equal(noteVeniceBalanceReading(reading(30, T_DRY), T_DRY, silent), false);
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    assert.equal(noteVeniceBalanceReading(reading(Number.NaN, T_TOPUP_READ), T_TOPUP_READ, silent), false);
    assert.equal(veniceStandingDown(T_TOPUP_READ).active, true);
    process.env.BOT_VENICE_STANDDOWN = "0";
    assert.equal(noteVeniceBalanceReading(reading(30, T_TOPUP_READ), T_TOPUP_READ, silent), false);
  });

  it("liftVeniceStandDown lifts once and is a no-op when nothing is paused", () => {
    const lines: string[] = [];
    assert.equal(liftVeniceStandDown("manual", T_DRY, (l) => lines.push(l)), false);
    noteVeniceError(DIEM_LIMIT, T_DRY, { log: silent });
    assert.equal(liftVeniceStandDown("manual", T_DRY + MIN, (l) => lines.push(l)), true);
    assert.equal(liftVeniceStandDown("manual", T_DRY + MIN, (l) => lines.push(l)), false);
    assert.equal(lines.length, 1);
    // The next refusal is a fresh pause, so loops log their skip again.
    const skipLines: string[] = [];
    noteVeniceError(DIEM_LIMIT, T_DRY + 2 * MIN, { log: silent });
    assert.equal(standDownSkip("mining", T_DRY + 2 * MIN, (l) => skipLines.push(l)), true);
    assert.equal(skipLines.length, 1);
  });
});

describe("venice stand-down: the trip line says how to get out", () => {
  beforeEach(() => _resetVeniceBreakerForTests());
  afterEach(() => _resetVeniceBreakerForTests());

  it("insufficient balance → a top-up lifts it; key limit → restart with the launchctl command", () => {
    const lines: string[] = [];
    noteVeniceError(INSUFFICIENT, T_DRY, { log: (l) => lines.push(l) });
    assert.match(lines[0], /A top-up lifts it at the next balance check/);
    _resetVeniceBreakerForTests();
    noteVeniceError(DIEM_LIMIT, T_DRY, { log: (l) => lines.push(l) });
    assert.ok(lines[1].includes(RESTART_HINT), lines[1]);
    assert.match(lines[1], /balance watch cannot see/);
    assert.equal(RESTART_HINT, "launchctl kickstart -k gui/$(id -u)/com.nookplot.bot");
    assert.match(standDownRemedy("failed-attempt-lockout"), /expires by itself/);
  });
});

describe("venice-balance hands readings to the breaker", () => {
  const savedKey = process.env.VENICE_API_KEY;
  const savedFetch = globalThis.fetch;
  beforeEach(() => _resetVeniceBreakerForTests());
  afterEach(() => {
    _resetVeniceBreakerForTests();
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = savedKey;
  });

  const stubRateLimits = (data: Record<string, unknown>) => {
    process.env.VENICE_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }), { status: 200 })) as typeof fetch;
  };

  it("parses accessPermitted from rate_limits (and null when absent or not a boolean)", async () => {
    stubRateLimits({ balances: { USD: 0, DIEM: 0 }, nextEpochBegins: "2026-10-02T00:00:00.000Z", accessPermitted: false });
    assert.deepEqual(await fetchVeniceBalances(), {
      usd: 0,
      diem: 0,
      nextEpochBegins: "2026-10-02T00:00:00.000Z",
      accessPermitted: false,
    });
    stubRateLimits({ balances: { USD: 20, DIEM: 0 }, nextEpochBegins: null });
    assert.equal((await fetchVeniceBalances())?.accessPermitted, null);
    stubRateLimits({ balances: { USD: 20, DIEM: 0 }, accessPermitted: "yes" });
    assert.equal((await fetchVeniceBalances())?.accessPermitted, null);
  });

  it("feedVeniceBreaker lifts an insufficient-balance pause from a funded reading (negative USD doesn't count)", () => {
    noteVeniceError(INSUFFICIENT, T_DRY, { log: silent });
    const dry = { usd: -1.48, diem: 0, nextEpochBegins: "2026-10-02T00:00:00.000Z", accessPermitted: true };
    assert.equal(feedVeniceBreaker(dry, T_DRY + 20 * MIN, T_DRY + 20 * MIN, silent), false);
    const topped = { usd: 20, diem: 0, nextEpochBegins: "2026-10-02T00:00:00.000Z", accessPermitted: true };
    assert.equal(feedVeniceBreaker(topped, T_TOPUP_READ, T_TOPUP_READ, silent), true);
    assert.equal(veniceStandingDown(T_TOPUP_READ).active, false);
  });
});
