// Wake gate boot check (2026-10-04). This file imports ONLY wake-gate.js, so
// nothing has observed the clock when it runs: the process-wide heartbeat must
// already be running from module load. With a lazy heartbeat (started on the
// first gate check), the first check more than 60s after boot measured the gap
// since import and logged a phantom "host woke from sleep". Kept in its own
// file because each test file runs in its own process: any other import could
// observe the clock and start a lazy heartbeat, hiding the regression.
import { it } from "node:test";
import assert from "node:assert/strict";
import { _wakeGateHeartbeatStartedForTests, wakeGateStatus } from "../wake-gate.js";

it("the process heartbeat starts at module load, before any gate check", () => {
  assert.equal(_wakeGateHeartbeatStartedForTests(), true);
  const st = wakeGateStatus();
  assert.equal(st.closed, false);
  assert.equal(st.wakeId, 0);
});
