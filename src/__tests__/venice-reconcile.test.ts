// Venice reconciliation (2026-10-12): split balance drops into the bot's own
// recorded calls and spend nobody in this repo made.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeWindows, reconcileVenice } from "../venice-reconcile.js";

const SINCE = "2026-10-12T00:00:00.000Z";
// Shape of 10-12's polls (rounded): refill at 00:05, bot work 02:05–04:05,
// then a fall to zero 07:45–08:45 with no bot calls.
const balances = [
  { ts: "2026-10-11T23:35:00.000Z", diem: 0.34 },
  { ts: "2026-10-12T00:05:00.000Z", diem: 4 },
  { ts: "2026-10-12T02:05:00.000Z", diem: 3.96 },
  { ts: "2026-10-12T04:05:00.000Z", diem: 1.97 },
  { ts: "2026-10-12T07:45:00.000Z", diem: 1.79 },
  { ts: "2026-10-12T08:15:00.000Z", diem: 1.0 },
  { ts: "2026-10-12T08:45:00.000Z", diem: 0, usd: 0 },
  { ts: "2026-10-12T09:15:00.000Z", diem: 0, usd: 0 },
];
const costs = [
  { ts: "2026-10-12T01:00:00.000Z", estCost: 0.04 },
  { ts: "2026-10-12T03:00:00.000Z", estCost: 1.0 },
  { ts: "2026-10-12T03:30:00.000Z", estCost: "0.99" },
  { ts: "2026-10-12T07:36:29.000Z", estCost: 0.18 },
];

describe("venice reconcile", () => {
  const r = reconcileVenice(balances, costs, SINCE);

  it("the refill is skipped, not counted as negative spend", () => {
    assert.ok(Math.abs(r.spent - 4.0) < 1e-9, String(r.spent));
  });

  it("bot work is explained by the ledger; the 07:45–08:45 fall is not", () => {
    assert.ok(Math.abs(r.bot - 2.21) < 1e-9, String(r.bot));
    assert.ok(Math.abs(r.other - 1.79) < 1e-6, String(r.other));
  });

  it("lists only the unexplained intervals, and merges adjacent ones", () => {
    assert.deepEqual(r.windows.map((w) => [w.from.slice(11, 16), w.to.slice(11, 16)]), [["07:45", "08:15"], ["08:15", "08:45"]]);
    const m = mergeWindows(r.windows);
    assert.equal(m.length, 1);
    assert.equal(m[0].from.slice(11, 16), "07:45");
    assert.equal(m[0].to.slice(11, 16), "08:45");
    assert.ok(Math.abs(m[0].other - 1.79) < 1e-6);
  });

  it("small gaps between ledger and balance aren't flagged", () => {
    const rr = reconcileVenice(
      [{ ts: "2026-10-12T01:00:00Z", diem: 2 }, { ts: "2026-10-12T01:30:00Z", diem: 1.95 }],
      [{ ts: "2026-10-12T01:10:00Z", estCost: 0.0 }],
      SINCE,
    );
    assert.equal(rr.windows.length, 0);
    assert.ok(Math.abs(rr.other - 0.05) < 1e-9);
  });

  it("a ledger that runs ahead of the balance never makes 'other' negative", () => {
    const rr = reconcileVenice(
      [{ ts: "2026-10-12T01:00:00Z", diem: 2 }, { ts: "2026-10-12T01:30:00Z", diem: 1.9 }],
      [{ ts: "2026-10-12T01:10:00Z", estCost: 0.5 }],
      SINCE,
    );
    assert.equal(rr.other, 0);
    assert.ok(Math.abs(rr.bot - 0.1) < 1e-9, "bot capped at the drop");
  });

  it("polls before `since` are ignored", () => {
    assert.equal(reconcileVenice(balances, costs, "2026-10-12T08:44:00Z").spent, 0);
  });
});
