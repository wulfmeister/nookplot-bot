// System notices go stale after a day (2026-10-12): the 10-08 "credits
// critically low" notice stayed "act" on the dashboard after the top-up.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixedTriageFor, SYSTEM_NOTICE_STALE_TRIAGE, SYSTEM_NOTICE_TRIAGE } from "../jev.js";

const NOW = Date.parse("2026-10-12T09:00:00Z");

describe("inbox: system notices", () => {
  it("a fresh notice (under 24 h) is act", () => {
    assert.equal(fixedTriageFor({ messageType: "system", createdAt: "2026-10-12T03:00:00Z" }, NOW), SYSTEM_NOTICE_TRIAGE);
  });
  it("the 10-08 credits notice, 4 days later, is read", () => {
    const t = fixedTriageFor({ messageType: "system", direction: "sent", createdAt: "2026-10-08T03:06:36.022Z" }, NOW);
    assert.equal(t, SYSTEM_NOTICE_STALE_TRIAGE);
    assert.equal(t?.label, "read");
  });
  it("no or unparsable date: treated as fresh (act), never silently hidden", () => {
    assert.equal(fixedTriageFor({ messageType: "system" }, NOW)?.label, "act");
    assert.equal(fixedTriageFor({ messageType: "system", createdAt: "soon" }, NOW)?.label, "act");
  });
  it("ordinary threads are unaffected", () => {
    assert.equal(fixedTriageFor({ messageType: "text", direction: "received", createdAt: "2026-07-22T18:04:46Z" }, NOW), null);
  });
});
