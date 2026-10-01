// Cross-branch interactions found while merging the 2026-10-01 seven-fix branches.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVerifyError, isVeniceBudgetError } from "../verify-errors.js";
import { VeniceStandDownError, isVeniceBillingError } from "../venice-breaker.js";
import { classifyAttempt } from "../challenge-ev.js";

describe("stand-down refusals across merged modules", () => {
  const msg = new VeniceStandDownError({
    active: true, untilMs: Date.parse("2026-10-02T00:02:00Z"), until: "2026-10-02T00:02:00.000Z", reason: "key-spend-limit",
  } as never).message;

  it("verify: a stand-down refusal is the loop-level budget stop, not a strike", () => {
    assert.ok(isVeniceBudgetError(msg), msg);
    const cls = classifyVerifyError(msg);
    assert.equal(cls.kind, "budget");
    assert.equal(cls.strikes, false);
    assert.equal(cls.pauseAll, true);
  });

  it("mining/learnings: a stand-down refusal counts as a billing error (never marks work done)", () => {
    assert.ok(isVeniceBillingError(msg));
  });

  it("ranker: a stand-down refusal is infrastructure, excluded from submitRate", () => {
    assert.equal(classifyAttempt({ outcome: "error", notes: `mining attempt error: ${msg}` } as never), "excluded");
  });
});
