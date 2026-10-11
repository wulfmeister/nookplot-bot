// 2026-10-11 operator-approved fixes: citation loop dedupe/exclusions,
// self-audit skip, gateway system notices in the inbox.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { citationAllowed, citedTargetsFromLog, excludedAuthorPrefixes } from "../citation-velocity.js";
import { namesOwnAgent } from "../mining.js";
import { fixedTriageFor, REPLIED_TRIAGE, SYSTEM_NOTICE_TRIAGE } from "../jev.js";

const ME = "0x00000000000000000000000000000000000a11ce"; // synthetic stand-in for our address

describe("citation loop: one citation per target, farm authors excluded", () => {
  it("collects lifetime cited targets from the log (citations only)", () => {
    const s = citedTargetsFromLog([
      { kind: "citation", targetItemId: "t1" },
      { kind: "citation", targetItemId: "t1" },
      { kind: "citation-error", targetItemId: "t2" },
      { kind: "compile" },
    ]);
    assert.deepEqual([...s], ["t1"]);
  });
  it("refuses a target already cited, allows a new one", () => {
    const cited = new Set(["12fbfe56"]);
    assert.deepEqual(citationAllowed("0xabc", "12fbfe56", cited, []), { ok: false, reason: "already cited" });
    assert.equal(citationAllowed("0xabc", "new-item", cited, []).ok, true);
  });
  it("refuses the three farm accounts by default, case-insensitively, plus env extras", () => {
    const ex = excludedAuthorPrefixes({ BOT_CITATION_EXCLUDE_AUTHORS: " 0xDEAD , " });
    for (const a of ["0x2677E9EDf5aa", "0x7354b0ac00", "0x8432a8c4ff", "0xdeadbeef"]) {
      assert.deepEqual(citationAllowed(a, "x", new Set(), ex), { ok: false, reason: "excluded author" });
    }
    assert.equal(citationAllowed("0x1234abcd", "x", new Set(), ex).ok, true);
  });
});

describe("mining: skip challenges that name our own agent", () => {
  const audit = { title: "Citation audit", description: `Agent ${ME.toUpperCase().replace("0X", "0x")} has 2847 citations across 407 insights` };
  it("matches our full address in the description, any case", () => {
    assert.equal(namesOwnAgent(audit, ME), true);
  });
  it("ignores other agents and a malformed own address", () => {
    assert.equal(namesOwnAgent({ title: "audit", description: "Agent 0x1111111111111111111111111111111111111111 ..." }, ME), false);
    assert.equal(namesOwnAgent(audit, "not-an-address"), false);
  });
  it("BOT_SKIP_SELF_AUDITS=0 re-enables", () => {
    const saved = process.env.BOT_SKIP_SELF_AUDITS;
    process.env.BOT_SKIP_SELF_AUDITS = "0";
    try { assert.equal(namesOwnAgent(audit, ME), false); }
    finally { if (saved === undefined) delete process.env.BOT_SKIP_SELF_AUDITS; else process.env.BOT_SKIP_SELF_AUDITS = saved; }
  });
});

describe("inbox: gateway system notices are alerts, not our replies", () => {
  it("system → act; our sent message → replied; inbound → Jev decides", () => {
    assert.equal(fixedTriageFor({ direction: "sent", messageType: "system" }), SYSTEM_NOTICE_TRIAGE);
    assert.equal(SYSTEM_NOTICE_TRIAGE.label, "act");
    assert.equal(fixedTriageFor({ direction: "sent", messageType: "text" }), REPLIED_TRIAGE);
    assert.equal(fixedTriageFor({ direction: "received", messageType: "text" }), null);
  });
});
