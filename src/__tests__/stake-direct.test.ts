// Unstaking straight from the wallet while the gateway is paused (2026-10-31):
// the planner mirrors MiningStake's own checks so a refusal comes with a reason.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { parseUnstakeAmount, planUnstake, unstakeAvailableAt, type StakeContractState } from "../stake-direct.js";

const NOOK = (n: string) => parseUnits(n, 18);
const NOW = 1_800_000_000; // unix seconds
const WEEK = 7 * 86_400;

// Synthetic: 1,000 NOOK staked, nothing pending.
const idle: StakeContractState = {
  stake: { amount: NOOK("1000"), stakedAt: NOW - 90 * 86_400, unstakeRequestedAt: 0, unstakeAmount: 0n, cooldownSnapshot: 0, slashedAt: 0 },
  tier: 1,
  multiplierBps: 120,
  cooldown: WEEK,
  paused: false,
};
const pending = (requestedAt: number): StakeContractState => ({
  ...idle,
  stake: { ...idle.stake, unstakeRequestedAt: requestedAt, unstakeAmount: NOOK("400"), cooldownSnapshot: WEEK },
});

describe("direct unstake", () => {
  it("amounts: a number of NOOK or 'all'", () => {
    assert.equal(parseUnstakeAmount("all", NOOK("1000")), NOOK("1000"));
    assert.equal(parseUnstakeAmount(" ALL ", NOOK("1000")), NOOK("1000"));
    assert.equal(parseUnstakeAmount("250", NOOK("1000")), NOOK("250"));
    assert.equal(parseUnstakeAmount("1_000.5", NOOK("5000")), NOOK("1000.5"));
    for (const bad of ["0", "-5", "abc", "1e6", "", undefined, "1.1234567890123456789"]) {
      assert.throws(() => parseUnstakeAmount(bad, NOOK("1000")), Error, String(bad));
    }
  });

  it("request: refuses what the contract would revert on, with a reason", () => {
    const why = (c: StakeContractState, amt?: bigint) => {
      const p = planUnstake("request", c, NOW, amt);
      return p.action === "none" ? p.reason : p.action;
    };
    assert.match(why({ ...idle, paused: true }, NOOK("1")), /paused/);
    assert.match(why({ ...idle, stake: { ...idle.stake, amount: 0n } }, NOOK("1")), /nothing is staked/);
    assert.match(why(pending(NOW - 3600), NOOK("1")), /already pending/);
    assert.match(why(idle, NOOK("1000.000000000000000001")), /more than is staked/);
    assert.match(why(idle, 0n), /more than 0/);
  });

  it("request: the cooldown runs from now", () => {
    const p = planUnstake("request", idle, NOW, NOOK("1000"));
    assert.deepEqual(p, { action: "request", amount: NOOK("1000"), availableAt: NOW + WEEK });
  });

  it("cancel: only with a request open", () => {
    assert.equal(planUnstake("cancel", idle, NOW).action, "none");
    assert.deepEqual(planUnstake("cancel", pending(NOW - 3600), NOW), { action: "cancel", amount: NOOK("400") });
  });

  it("complete: not before the cooldown ends; then the rest stays staked", () => {
    assert.equal(planUnstake("complete", idle, NOW).action, "none");
    const early = planUnstake("complete", pending(NOW - 3600), NOW);
    assert.equal(early.action, "none");
    if (early.action === "none") assert.match(early.reason, /cooldown ends .* from now/);
    const due = pending(NOW - WEEK);
    assert.equal(unstakeAvailableAt(due.stake), NOW);
    assert.deepEqual(planUnstake("complete", due, NOW), { action: "complete", amount: NOOK("400"), remaining: NOOK("600") });
  });
});
