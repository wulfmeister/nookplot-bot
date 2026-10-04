// Wake gate (2026-10-04): no Venice work in the first BOT_WAKE_GATE_SEC after
// the host wakes from sleep; no retry of a call the host slept through.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HostSleepInterruptError,
  VeniceWakeGateError,
  WAKE_GAP_MS,
  WAKE_SETTLE_MS_DEFAULT,
  _resetWakeGateForTests,
  freshWakeGateState,
  isWakeGateOrSleepError,
  observeClock,
  observeNow,
  sleptSinceOf,
  wakeGateStatus,
  wakeGateStatusOf,
  wakeSettleMs,
} from "../wake-gate.js";
import { chat } from "../venice.js";
import { isVeniceBillingError, standDownSkip } from "../venice-breaker.js";
import { classifyVerifyError, decideVerifyFailure } from "../verify-errors.js";
import { classifyAttempt } from "../challenge-ev.js";
import { isTransientGenerationError } from "../mining.js";

const T0 = Date.parse("2026-10-03T05:58:00Z");
const SETTLE = WAKE_SETTLE_MS_DEFAULT;

describe("wake gate: clock observations", () => {
  it("regular beats are not a wake", () => {
    let s = freshWakeGateState(T0);
    for (let i = 1; i <= 10; i++) s = observeClock(s, T0 + i * 15_000);
    assert.equal(s.wakeId, 0);
    assert.equal(s.lastWakeMs, Number.NEGATIVE_INFINITY);
    assert.equal(wakeGateStatusOf(s, T0 + 150_000, SETTLE).closed, false, "no wake since start → open");
  });

  it("a wall-clock gap past WAKE_GAP_MS is a wake, and closes the gate for the settle time", () => {
    const s0 = freshWakeGateState(T0);
    const woke = T0 + 2 * 3600_000; // slept 2h (the 10-03 DarkWake cycle)
    const s1 = observeClock(s0, woke);
    assert.equal(s1.wakeId, 1);
    assert.equal(s1.lastWakeMs, woke);
    const st = wakeGateStatusOf(s1, woke + 8_000, SETTLE); // a DarkWake lasts ~8s
    assert.equal(st.closed, true);
    assert.equal(st.remainingMs, SETTLE - 8_000);
    assert.equal(wakeGateStatusOf(s1, woke + SETTLE, SETTLE).closed, false, "open after the settle time");
  });

  it("exactly WAKE_GAP_MS is not a wake (strictly greater)", () => {
    const s = observeClock(freshWakeGateState(T0), T0 + WAKE_GAP_MS);
    assert.equal(s.wakeId, 0);
  });

  it("a backwards clock step is ignored, not a wake", () => {
    const s = observeClock(freshWakeGateState(T0), T0 - 3600_000);
    assert.equal(s.wakeId, 0);
    assert.equal(s.lastBeatMs, T0);
  });

  it("repeated DarkWakes keep the gate closed: each blip re-arms it", () => {
    let s = freshWakeGateState(T0);
    for (let h = 1; h <= 5; h++) {
      const wake = T0 + h * 3600_000;
      s = observeClock(s, wake);
      s = observeClock(s, wake + 8_000);
      assert.equal(wakeGateStatusOf(s, wake + 8_000, SETTLE).closed, true, `blip ${h} must stay gated`);
    }
    assert.equal(s.wakeId, 5);
  });

  it("settle 0 disables the gate", () => {
    const s = observeClock(freshWakeGateState(T0), T0 + 3600_000);
    assert.equal(wakeGateStatusOf(s, T0 + 3600_000, 0).closed, false);
  });

  it("sleptSinceOf: true only when a wake happened after the call started", () => {
    const start = T0 + 1000;
    const s = observeClock(freshWakeGateState(T0), T0 + 3600_000);
    assert.equal(sleptSinceOf(s, start), true);
    assert.equal(sleptSinceOf(s, T0 + 3600_000 + 1), false);
    assert.equal(sleptSinceOf(freshWakeGateState(T0), start), false);
  });

  it("BOT_WAKE_GATE_SEC parsing", () => {
    assert.equal(wakeSettleMs({}), SETTLE);
    assert.equal(wakeSettleMs({ BOT_WAKE_GATE_SEC: "" }), SETTLE);
    assert.equal(wakeSettleMs({ BOT_WAKE_GATE_SEC: "0" }), 0);
    assert.equal(wakeSettleMs({ BOT_WAKE_GATE_SEC: "120" }), 120_000);
    assert.equal(wakeSettleMs({ BOT_WAKE_GATE_SEC: "-5" }), SETTLE);
    assert.equal(wakeSettleMs({ BOT_WAKE_GATE_SEC: "abc" }), SETTLE);
  });
});

describe("wake gate: errors are never the work's fault, never transient", () => {
  const gated = new VeniceWakeGateError({ closed: true, remainingMs: 292_000, wokeAgoMs: 8_000, wakeId: 3 }).message;
  const slept = new HostSleepInterruptError(7_319_000).message;

  for (const [name, msg] of [["wake-gate refusal", gated], ["host-sleep interrupt", slept]] as const) {
    it(`${name}: recognised everywhere it matters`, () => {
      assert.ok(isWakeGateOrSleepError(msg), msg);
      // mining loadCaches / learnings: must not mark the challenge or learning done
      assert.equal(isVeniceBillingError(msg), true);
      // no model failover, no same-model retry
      assert.equal(isTransientGenerationError(msg), false);
      // verify: retry later, no strike, no ceiling (no streak), no loop pause
      const cls = classifyVerifyError(msg);
      assert.equal(cls.kind, "host-sleep");
      assert.equal(cls.strikes, false);
      assert.equal(cls.ceiling, false);
      assert.equal(cls.pauseAll, false);
      assert.equal(cls.permanent, false);
      const d = decideVerifyFailure(msg, { strikes: 2, attempts: 7 });
      assert.equal(d.action, "retry-later");
      assert.equal(d.retired, false);
      // ranker: infrastructure, excluded from submitRate
      assert.equal(classifyAttempt({ outcome: "error", notes: `mining attempt error: ${msg}` } as never), "excluded");
    });
  }
});

describe("wake gate: process-wide wiring", () => {
  beforeEach(() => _resetWakeGateForTests());
  afterEach(() => _resetWakeGateForTests());

  it("fresh process: gate open", () => {
    assert.equal(wakeGateStatus().closed, false);
  });

  it("chat() refuses right after a wake, before the key check and any request", async () => {
    // A wall-clock jump of 2h on the next observation = the host just woke.
    observeNow(Date.now() + 2 * 3600_000);
    // npm test blanks VENICE_API_KEY: if the gate check were missing or late,
    // chat() would fail on the key instead (still with no request).
    await assert.rejects(
      chat([{ role: "user", content: "hi" }]),
      (err: unknown) => err instanceof VeniceWakeGateError && /no request sent/.test((err as Error).message),
    );
  });

  it("standDownSkip skips loops while the gate is closed, logging once per loop per wake", () => {
    observeNow(Date.now() + 2 * 3600_000);
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    assert.equal(standDownSkip("mining", Date.now(), log), true);
    assert.equal(standDownSkip("mining", Date.now(), log), true);
    assert.equal(standDownSkip("verify", Date.now(), log), true);
    assert.equal(lines.length, 2, lines.join("\n"));
    assert.match(lines[0], /mining skipped: host woke .* \(wake gate\)/);
  });

  it("standDownSkip is unaffected by an injected fake nowMs (stand-down tests pass fake times)", () => {
    assert.equal(standDownSkip("mining", Date.now() + 10 * 3600_000, () => {}), false);
    assert.equal(wakeGateStatus().closed, false);
  });
});
