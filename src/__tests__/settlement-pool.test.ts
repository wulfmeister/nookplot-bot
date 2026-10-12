// MiningRewardPool (2026-10-12): why no root since 09-02, and when a direct
// claim from our own wallet may be sent. Amounts in NOOK base units.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planDirectClaim, rootWouldPass } from "../settlement-pool.js";

const N = (x: number) => BigInt(Math.round(x)) * 10n ** 18n;
const ROOT = "0x12e5ec3b743730e6d73351406ee5ae5853694fe260d38f46610a9ccee80541d5";
const OTHER = "0x" + "ab".repeat(32);

describe("settlement pool: could a root be published?", () => {
  // Live state on 10-12: 4,849,967 NOOK spare, 50M per-root cap.
  const live = { headroom: N(4_849_967), maxEpochPayout: N(50_000_000), paused: false };

  it("one day of credits (~4.85M) is already over the spare balance: InsolventRoot", () => {
    const r = rootWouldPass(N(4_850_000), live);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(), /InsolventRoot/);
  });

  it("a catch-up root over 50M fails the cap as well", () => {
    const r = rootWouldPass(N(190_000_000), { ...live, headroom: N(500_000_000) });
    assert.deepEqual(r.reasons, ["over the per-root cap (ExceedsMaxEpochPayout)"]);
  });

  it("a funded pool accepts a root within both limits", () => {
    assert.equal(rootWouldPass(N(45_000_000), { ...live, headroom: N(200_000_000) }).ok, true);
  });

  it("a cap of 0 means no cap", () => {
    assert.equal(rootWouldPass(N(190_000_000), { headroom: N(500_000_000), maxEpochPayout: 0n, paused: false }).ok, true);
  });

  it("a paused pool accepts nothing", () => {
    assert.equal(rootWouldPass(1n, { ...live, paused: true }).ok, false);
  });
});

describe("settlement pool: direct claim plan", () => {
  const base = { proofRoot: ROOT, onChainRoot: ROOT, paused: false, claimable: true };

  it("the root's amount is fully claimed already (the 10-12 state): nothing is sent", () => {
    const p = planDirectClaim({ ...base, proofCumulative: N(40_000_000), alreadyClaimed: N(40_000_000) });
    assert.equal(p.action, "none");
  });

  it("a new root covering more than we claimed: claim the difference", () => {
    const p = planDirectClaim({ ...base, proofCumulative: N(85_000_000), alreadyClaimed: N(40_000_000) });
    assert.deepEqual(p, { action: "claim", delta: N(45_000_000) });
  });

  it("the gateway's proof is for a different root than the pool holds: never send (it would revert)", () => {
    const p = planDirectClaim({ ...base, proofRoot: OTHER, proofCumulative: N(85_000_000), alreadyClaimed: N(40_000_000) });
    assert.equal(p.action, "none");
  });

  it("root comparison ignores hex case", () => {
    const p = planDirectClaim({ ...base, proofRoot: ROOT.toUpperCase().replace("0X", "0x"), proofCumulative: N(2), alreadyClaimed: N(1) });
    assert.equal(p.action, "claim");
  });

  it("no proof, a paused pool or claiming switched off: nothing is sent", () => {
    assert.equal(planDirectClaim({ ...base, proofRoot: null, proofCumulative: null, alreadyClaimed: 0n }).action, "none");
    assert.equal(planDirectClaim({ ...base, paused: true, proofCumulative: N(2), alreadyClaimed: N(1) }).action, "none");
    assert.equal(planDirectClaim({ ...base, claimable: false, proofCumulative: N(2), alreadyClaimed: N(1) }).action, "none");
  });
});
