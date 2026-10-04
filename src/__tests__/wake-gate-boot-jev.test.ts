// 2026-10-04 review follow-ups: daemon boot counts as a wake; Jev's own
// /decisions fetch honours the wake gate.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WAKE_SETTLE_MS_DEFAULT, _resetWakeGateForTests, createWakeGate, noteDaemonBoot, wakeGateStatus, wakeGateStatusOf } from "../wake-gate.js";
import { _resetJevForTests, jevDecide } from "../jev.js";

describe("daemon boot counts as a wake", () => {
  it("markWake closes the gate for the settle time, then it opens", () => {
    let t = Date.parse("2026-10-03T05:58:00Z");
    const g = createWakeGate(() => t, () => {});
    assert.equal(wakeGateStatusOf(g.observe(), t, WAKE_SETTLE_MS_DEFAULT).closed, false, "fresh: open");
    const s = g.markWake(t);
    assert.equal(s.wakeId, 1);
    assert.equal(wakeGateStatusOf(g.observe(t + 8_000), t + 8_000, WAKE_SETTLE_MS_DEFAULT).closed, true, "8s after boot: closed");
    // Continuous uptime = regular beats (a single 300s jump would itself read as another sleep).
    const end = t + WAKE_SETTLE_MS_DEFAULT;
    while (t < end) { t += 15_000; g.observe(t); }
    assert.equal(wakeGateStatusOf(g.observe(t), t, WAKE_SETTLE_MS_DEFAULT).closed, false, "after the settle time awake: open");
    assert.equal(g.observe(t).wakeId, 1, "beats alone add no wake");
  });

  it("noteDaemonBoot closes the process-wide gate", () => {
    _resetWakeGateForTests();
    assert.equal(wakeGateStatus().closed, false);
    noteDaemonBoot();
    assert.equal(wakeGateStatus().closed, true);
    _resetWakeGateForTests();
    assert.equal(wakeGateStatus().closed, false);
  });
});

describe("Jev honours the wake gate", () => {
  const savedKey = process.env.VENICE_API_KEY;
  const savedJev = process.env.BOT_JEV;
  beforeEach(() => {
    _resetJevForTests();
    _resetWakeGateForTests();
    process.env.VENICE_API_KEY = "test-key";
    delete process.env.BOT_JEV;
  });
  afterEach(() => {
    _resetJevForTests();
    _resetWakeGateForTests();
    if (savedKey === undefined) delete process.env.VENICE_API_KEY; else process.env.VENICE_API_KEY = savedKey;
    if (savedJev === undefined) delete process.env.BOT_JEV; else process.env.BOT_JEV = savedJev;
  });

  it("returns null with no request while the gate is closed, and calls through once it is open", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ answers: {} }), { status: 200 }); }) as unknown as typeof fetch;
    noteDaemonBoot();
    assert.equal(await jevDecide({}, {}, { fetchImpl: f, onCost: () => {} }), null);
    assert.equal(calls, 0, "no request while gated");
    _resetWakeGateForTests();
    await jevDecide({}, {}, { fetchImpl: f, onCost: () => {} });
    assert.equal(calls, 1, "open gate: Jev calls through");
  });
});
