// Waiting out a Nookplot maintenance pause (2026-10-31): the daemon used to
// exit after 30 failed connects and relaunch every ~25 min.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeVersionChange, isMaintenanceError, maintenancePollMs, nextMaintenanceState } from "../gateway-maintenance.js";

// The exact error the runtime threw for every connect since 2026-10-22.
const REAL = 'Gateway request failed (503): Nookplot is paused while it is rebuilt. On-chain assets are unaffected; see https://nookplot.com';

describe("gateway maintenance", () => {
  it("recognises the real maintenance reply, and the raw JSON body", () => {
    assert.equal(isMaintenanceError(REAL), true);
    assert.equal(isMaintenanceError('{"error":"maintenance","message":"…"}'), true);
  });

  it("ordinary outages are not maintenance (they keep the 30-attempt limit)", () => {
    for (const m of ["fetch failed", "Gateway request failed (502): Bad Gateway", "getaddrinfo ENOTFOUND gateway.nookplot.com", "", null, undefined]) {
      assert.equal(isMaintenanceError(m as string), false, String(m));
    }
  });

  it("the pause's start survives restarts; a return records backAt", () => {
    const a = nextMaintenanceState(null, true, "2026-10-31T22:00:00Z", REAL);
    assert.equal(a.since, "2026-10-31T22:00:00Z");
    const b = nextMaintenanceState({ ...a, since: "2026-10-22T17:15:44Z" }, true, "2026-10-31T22:10:00Z");
    assert.equal(b.since, "2026-10-22T17:15:44Z");
    assert.equal(b.lastCheck, "2026-10-31T22:10:00Z");
    const up = nextMaintenanceState(b, false, "2026-11-03T09:00:00Z");
    assert.equal(up.state, "up");
    assert.equal(up.backAt, "2026-11-03T09:00:00Z");
    assert.equal(up.since, "2026-10-22T17:15:44Z");
    // A normal boot with no pause leaves backAt alone.
    assert.equal(nextMaintenanceState(up, false, "2026-11-04T00:00:00Z").backAt, "2026-11-03T09:00:00Z");
  });

  it("poll interval: default 10 min, BOT_MAINTENANCE_POLL_MIN overrides, junk falls back", () => {
    assert.equal(maintenancePollMs({}), 600_000);
    assert.equal(maintenancePollMs({ BOT_MAINTENANCE_POLL_MIN: "30" }), 1_800_000);
    assert.equal(maintenancePollMs({ BOT_MAINTENANCE_POLL_MIN: "0" }), 600_000);
    assert.equal(maintenancePollMs({ BOT_MAINTENANCE_POLL_MIN: "x" }), 600_000);
  });

  it("version line flags a change and stays quiet when unchanged", () => {
    assert.match(describeVersionChange({ version: "0.5.32", savedAt: "2026-10-12" }, "0.6.0"), /changed: 0\.5\.32 → 0\.6\.0/);
    assert.match(describeVersionChange({ version: "0.5.32", savedAt: "2026-10-12" }, "0.5.32"), /unchanged/);
    assert.match(describeVersionChange(null, null), /unchanged \(unknown\)/);
  });
});
