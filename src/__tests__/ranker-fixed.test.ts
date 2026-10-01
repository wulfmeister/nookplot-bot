/**
 * Review fixes on the per-challenge EV ranker (2026-10-01):
 *   1. the per-epoch solving cap (1,575,000 NOOK): capped epochs are flagged,
 *      their R-hat is labelled a lower bound, and the cap tally is logged;
 *   2. the starvation guard is bounded (hold from the newest failure,
 *      process-start floor) and no longer latches; in the legacy order it
 *      only cancels preferVerifiable;
 *   3. the visibility gap: paging stops at page 1, so the ranker never sees
 *      the experts one page deeper. Pinned here so a paging change is
 *      deliberate.
 * Fixture numbers are from ~/.nookplot/mining-settlements.jsonl and the live
 * open list read on 2026-10-01.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  verifiableStarvationGuard,
  STARVATION_HOLD_MS_DEFAULT,
  starvationGuardHoldMs,
  rankChallengesByEv,
  formatEvTop,
  formatKindFactors,
  formatEvShadow,
  summarizeCaps,
  priorFactors,
  type KindFactorTable,
  type MiningAttemptRow,
} from "../challenge-ev.js";
import { epochPayoutTotals, rHatByEpoch, EPOCH_SOLVING_CAP } from "../settlements.js";
import { applyStarvationGuardToTilt, fetchOpenChallengesPaged, type Challenge } from "../mining.js";

const H = 3_600_000;
const SPEC_400 =
  "Gateway request failed (400): traceSummary specificity score 22/100 (threshold 35). Sub-scores: numbers +12, techniques +0";

/** The 14-day live factors read on 2026-10-01 (python 73/119 · 62/73 · 0.69;
 *  standard 60/64 · 11/53 · 0.53), as an explicit table. */
function liveTable(): KindFactorTable {
  const t: KindFactorTable = {};
  for (const kind of ["standard", "python_tests", "javascript_tests", "exact_answer"]) t[kind] = priorFactors(kind);
  t.standard = { ...t.standard, submitRate: 0.93, survival: 0.24, compHat: 0.53 };
  t.python_tests = { ...t.python_tests, submitRate: 0.62, survival: 0.84, compHat: 0.69 };
  return t;
}

const paid = (submissionId: string, verifiedAt: string, realizedNook: number, compositeScore: number, baseReward?: number) => ({
  ts: verifiedAt,
  submissionId,
  verifiedAt,
  verifierKind: "python_tests",
  status: "verified",
  realizedNook,
  compositeScore,
  ...(baseReward ? { baseReward } : {}),
});

describe("epoch solving cap (finding 1): capped epochs are flagged, not read as a network rate", () => {
  const NOW = Date.UTC(2026, 8, 30, 12);
  // 09-29: 7 python mediums × 225,000 = exactly the cap. 09-22: 13 rows,
  // 1,000,531 total (uncapped).
  const e0929 = Array.from({ length: 7 }, (_, i) => paid(`a${i}`, "2026-09-29T14:00:00Z", 225_000, 0.72, 50_000));
  const e0922 = [
    ...Array.from({ length: 10 }, (_, i) => paid(`b${i}`, "2026-09-22T19:21:00Z", 88_761, 0.72, 50_000)),
    paid("b10", "2026-09-22T19:21:00Z", 12_722, 0.516),
    paid("b11", "2026-09-22T19:21:00Z", 11_440, 0.464),
    paid("b12", "2026-09-22T19:21:00Z", 88_761, 0.72),
  ];

  it("the cap is the 1,575,000 seen on 8 of 13 non-zero claims since 09-17", () => {
    assert.equal(EPOCH_SOLVING_CAP, 1_575_000);
  });

  it("epochPayoutTotals flags an epoch whose paid total equals the cap, newest first", () => {
    const totals = epochPayoutTotals([...e0922, ...e0929], NOW);
    assert.deepEqual(totals.map((t) => [t.epoch, t.capped, t.n]), [["2026-09-29", true, 7], ["2026-09-22", false, 13]]);
    // the ledger's rows are floats summing to 1,000,531; these rounded ones to 1,000,533
    assert.ok(Math.abs(totals[1].total - 1_000_531) < 5);
    assert.ok(EPOCH_SOLVING_CAP - totals[1].total > 500_000, "uncapped epochs sit 500k+ below the cap");
  });

  it("pro-rata scaled payouts (09-20: 11 × 1.575M/11) still read as capped despite float sums", () => {
    const e0920 = Array.from({ length: 11 }, (_, i) => paid(`c${i}`, "2026-09-20T13:00:00Z", 1_575_000 / 11, 0.72));
    assert.equal(epochPayoutTotals(e0920, NOW)[0].capped, true);
  });

  it("rows without baseReward count toward the cap total; an unpaid→paid pair counts once", () => {
    const rows = [
      { ...paid("x", "2026-09-28T10:00:00Z", 0, 0.72), realizedNook: undefined }, // verified, not yet paid
      paid("x", "2026-09-28T10:00:00Z", 1_575_000, 0.72), // later row: paid, no baseReward
    ];
    const t = epochPayoutTotals(rows, NOW);
    assert.equal(t.length, 1);
    assert.equal(t[0].n, 1);
    assert.equal(t[0].capped, true);
  });

  it("rHatByEpoch tags the capped epoch; there R-hat moves with OUR volume (7 vs 14 solves halves it)", () => {
    const seven = rHatByEpoch(e0929, NOW);
    assert.equal(seven[0].capped, true);
    assert.equal(seven[0].r, 225_000 / (0.72 * 50_000)); // 6.25
    const fourteen = Array.from({ length: 14 }, (_, i) => paid(`d${i}`, "2026-09-29T14:00:00Z", 1_575_000 / 14, 0.72, 50_000));
    const r14 = rHatByEpoch(fourteen, NOW)[0];
    assert.equal(r14.capped, true);
    assert.ok(Math.abs(r14.r - seven[0].r / 2) < 1e-9, "same cap, twice the solves → half the R-hat: not a network rate");
    assert.equal(rHatByEpoch(e0922, NOW)[0].capped, false);
  });

  it("the factors line prints a capped R-hat as a lower bound, the newest uncapped one, and the cap tally", () => {
    const rHat = rHatByEpoch([...e0922, ...e0929], NOW);
    const caps = summarizeCaps(epochPayoutTotals([...e0922, ...e0929], NOW));
    assert.deepEqual(caps, { capped: 1, epochs: 2, cap: 1_575_000 });
    const line = formatKindFactors(liveTable(), 14, rHat, caps);
    assert.match(line, /R̂ ≥6\.250 @2026-09-29 \(n7; CAPPED: R̂ = cap\/Σ ours, not a network rate; 2 epochs with baseReward\)/);
    assert.match(line, /newest uncapped R̂ 2\.466 @2026-09-22/);
    assert.match(line, /solving cap 1575k\/epoch hit 1\/2 paid epochs \(in a capped epoch one more solve adds ~0; EV ∝ base holds only uncapped\)/);
  });

  it("an uncapped newest epoch keeps the plain R-hat format; no cap clause when nothing capped", () => {
    const rHat = rHatByEpoch(e0922, NOW);
    const line = formatKindFactors(liveTable(), 14, rHat, summarizeCaps(epochPayoutTotals(e0922, NOW)));
    assert.match(line, /R̂ 2\.466 @2026-09-22 \(n10; 1 epoch with baseReward\)/);
    assert.match(line, /hit 0\/1 paid epochs$/);
    assert.doesNotMatch(line, /CAPPED|adds ~0/);
  });
});

describe("starvation guard is bounded (finding 2)", () => {
  const T = (iso: string) => Date.parse(iso);
  const fail = (iso: string): MiningAttemptRow => ({ ts: iso, verifierKind: "python_tests", outcome: "error", notes: SPEC_400 });
  const ok = (iso: string): MiningAttemptRow => ({ ts: iso, verifierKind: "python_tests", outcome: "deferred", submissionId: iso });
  // The ledger replay from the review: failures at 08:23, 08:24, 10:10, 12:39 on 09-22.
  const streak = ["2026-09-22T08:23:00Z", "2026-09-22T08:24:00Z", "2026-09-22T10:10:00Z", "2026-09-22T12:39:00Z"].map(fail);

  it("default hold is 2h", () => {
    assert.equal(STARVATION_HOLD_MS_DEFAULT, 2 * H);
  });

  it("fires right after the 4th failure", () => {
    const g = verifiableStarvationGuard(streak, T("2026-09-22T12:45:00Z"));
    assert.equal(g.active, true);
    assert.match(g.reason, /newest 6m ago\) — verifiables yield to standards until 14:39Z/);
  });

  it("clears by itself after the hold with NO new verifiable attempt (the old latch held to ~09-23T08:24)", () => {
    const g = verifiableStarvationGuard(streak, T("2026-09-22T14:40:00Z"));
    assert.equal(g.active, false);
    assert.match(g.reason, /newest is 121m old \(> 120m hold\) — verifiables compete again/);
    // still well inside the 24h window that used to keep it on
    assert.equal(verifiableStarvationGuard(streak, T("2026-09-23T08:00:00Z")).active, false);
  });

  it("after the hold one probe competes: a failure re-arms, a success clears", () => {
    const probeFail = [...streak, fail("2026-09-22T15:00:00Z")];
    assert.equal(verifiableStarvationGuard(probeFail, T("2026-09-22T15:05:00Z")).active, true);
    assert.equal(verifiableStarvationGuard(probeFail, T("2026-09-22T17:01:00Z")).active, false);
    const probeOk = [...streak, ok("2026-09-22T15:00:00Z")];
    assert.equal(verifiableStarvationGuard(probeOk, T("2026-09-22T15:05:00Z")).active, false);
  });

  it("holdMs is configurable; a non-positive hold falls back to the default", () => {
    const at = T("2026-09-22T13:20:00Z"); // newest failure 41m old
    assert.equal(verifiableStarvationGuard(streak, at, 4, { holdMs: 30 * 60_000 }).active, false);
    assert.equal(verifiableStarvationGuard(streak, at, 4, { holdMs: 0 }).active, true);
  });

  it("attempts before process start are ignored, so a restart after a fix starts clean", () => {
    const at = T("2026-09-22T12:45:00Z");
    const g = verifiableStarvationGuard(streak, at, 4, { sinceMs: T("2026-09-22T12:40:00Z") });
    assert.equal(g.active, false);
    assert.match(g.reason, /0\/4 verifiable attempts since restart/);
    // four fresh failures after the restart do arm it
    const fresh = ["12:41", "12:42", "12:43", "12:44"].map((hm) => fail(`2026-09-22T${hm}:00Z`));
    assert.equal(verifiableStarvationGuard([...streak, ...fresh], at, 4, { sinceMs: T("2026-09-22T12:40:00Z") }).active, true);
  });

  it("BOT_VERIFIABLE_STARVATION_HOLD_MIN: default 120, minutes, garbage/non-positive → default", () => {
    const prev = process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN;
    try {
      delete process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN;
      assert.equal(starvationGuardHoldMs(), 2 * H);
      process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN = "30";
      assert.equal(starvationGuardHoldMs(), 30 * 60_000);
      for (const bad of ["0", "-5", "abc"]) {
        process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN = bad;
        assert.equal(starvationGuardHoldMs(), 2 * H, bad);
      }
    } finally {
      if (prev === undefined) delete process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN;
      else process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN = prev;
    }
  });

  it("in the legacy order it only cancels preferVerifiable, and is a no-op otherwise", () => {
    const preferring = { active: true, preferVerifiable: true, reason: "verifiable first" };
    const g = { active: true, reason: "last 4 failed" };
    const out = applyStarvationGuardToTilt(preferring, g);
    assert.equal(out.preferVerifiable, false);
    assert.equal(out.active, true);
    assert.match(out.reason, /verifiable first → overridden by the starvation guard \(last 4 failed\)/);
    assert.equal(applyStarvationGuardToTilt(preferring, { active: false, reason: "" }), preferring);
    assert.equal(applyStarvationGuardToTilt(preferring, undefined), preferring);
    const standardFirst = { active: false, preferVerifiable: false, reason: "standard first" };
    assert.equal(applyStarvationGuardToTilt(standardFirst, g), standardFirst);
  });
});

describe("visibility gap (finding 3): paging stops before the experts", () => {
  // Live 2026-10-01: page 1 = 23 eligible (20 python medium, 3 standard hard)
  // among 100 rows; page 2 = 68 standard expert (500k).
  const pyMedium = (i: number): Challenge => ({ id: `py${String(i).padStart(6, "0")}`, verifierKind: "python_tests", difficulty: "medium", baseReward: "50000", status: "open" });
  const stdHard = (i: number): Challenge => ({ id: `sh${String(i).padStart(6, "0")}`, difficulty: "hard", baseReward: "150000", status: "open" });
  const stdExpert = (i: number): Challenge => ({ id: `se${String(i).padStart(6, "0")}`, difficulty: "expert", baseReward: "500000", status: "open" });
  const filler = (p: number, i: number): Challenge => ({ id: `f${p}-${i}`, status: "closed" });
  const page1 = [
    ...Array.from({ length: 20 }, (_, i) => pyMedium(i)),
    ...Array.from({ length: 3 }, (_, i) => stdHard(i)),
    ...Array.from({ length: 77 }, (_, i) => filler(1, i)),
  ];
  const page2 = [...Array.from({ length: 68 }, (_, i) => stdExpert(i)), pyMedium(99), ...Array.from({ length: 31 }, (_, i) => filler(2, i))];
  const isEligible = (c: Challenge) => c.status === "open";

  it("with pollNeed 3 only page 1 is fetched, so EV's top picks match legacy (python mediums)", async () => {
    const paged = await fetchOpenChallengesPaged(async (offset) => (offset === 0 ? page1 : offset === 100 ? page2 : []), isEligible, 3);
    assert.equal(paged.pages, 1);
    const ranked = rankChallengesByEv(paged.challenges.filter(isEligible), liveTable());
    assert.equal(ranked[0].kind, "python_tests");
    assert.equal(ranked[0].challenge.difficulty, "medium");
    const line = formatEvTop(ranked, { active: false, reason: "off" }, 3, { pages: paged.pages });
    assert.match(line, /saw 23 eligible on 1 page, max base 150k/);
  });

  it("the same ranker over pages 1+2 puts the standard experts first (it is paging depth, not the 'open' gate)", () => {
    const ranked = rankChallengesByEv([...page1, ...page2].filter(isEligible), liveTable());
    assert.equal(ranked[0].challenge.difficulty, "expert");
    assert.match(formatEvTop(ranked, { active: false, reason: "off" }, 3, { pages: 2 }), /saw 92 eligible on 2 pages, max base 500k/);
  });
});

describe("shadow line (default mode)", () => {
  const t = liveTable();
  const a: Challenge = { id: "aaaaaaaa-1", verifierKind: "python_tests", difficulty: "medium", baseReward: "50000" };
  const b: Challenge = { id: "bbbbbbbb-2", difficulty: "hard", baseReward: "150000" };
  const c: Challenge = { id: "cccccccc-3", difficulty: "easy", baseReward: "10000" };

  it("reports 'same' when EV and the active order agree on the first `take`", () => {
    const ranked = rankChallengesByEv([a, b, c], t);
    const active = ranked.map((s) => s.challenge);
    assert.match(formatEvShadow(ranked, active, 2), /would take .* vs active .* — same$/);
  });

  it("reports the overlap when they differ", () => {
    const ranked = rankChallengesByEv([a, b, c], t);
    const active = [c, ranked[0].challenge, ranked[1].challenge];
    const line = formatEvShadow(ranked, active, 2);
    assert.match(line, /BOT_CHALLENGE_EV_RANK=1 activates/);
    assert.match(line, /vs active cccccccc\(standard\/easy\)/);
    assert.match(line, /differs \(1\/2 shared\)$/);
  });
});
