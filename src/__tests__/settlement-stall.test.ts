// Settlement stall cause (2026-10-11): the dashboard blamed a gateway 500 on
// /claim-prepare for a stall whose real cause is that no Merkle root has been
// published since epoch 164 (2026-09-02T02:00Z), which our last on-chain claim
// had already swept. Claim times below are synthetic.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settlementStallCause } from "../dashboard-web.js";

const ROOT_164 = { hasProof: true, epochNumber: 164, publishedAt: "2026-09-02T02:00:16.299Z" };
const LAST_ON_CHAIN = "2026-09-02T03:00:00.000Z";

describe("dashboard-web.settlementStallCause", () => {
  it("the 09-02 → 10-11 stall: newest root predates our last on-chain claim → no new root", () => {
    assert.deepEqual(settlementStallCause(ROOT_164, LAST_ON_CHAIN), { cause: "no-new-root", epoch: 164, publishedAt: ROOT_164.publishedAt });
  });

  it("a root published after our last on-chain claim, still unclaimed → relay problem", () => {
    const r = settlementStallCause({ hasProof: true, epochNumber: 207, publishedAt: "2026-10-12T02:00:00Z" }, LAST_ON_CHAIN);
    assert.equal(r.cause, "relay");
    assert.equal(r.epoch, 207);
  });

  it("a root but no on-chain claim ever → relay problem", () => {
    assert.equal(settlementStallCause(ROOT_164, null).cause, "relay");
  });

  it("no proof data → unknown", () => {
    for (const p of [null, undefined, {}, { hasProof: false, publishedAt: ROOT_164.publishedAt }, { publishedAt: "not a date" }]) {
      assert.equal(settlementStallCause(p, LAST_ON_CHAIN).cause, "unknown", JSON.stringify(p));
    }
  });
});
