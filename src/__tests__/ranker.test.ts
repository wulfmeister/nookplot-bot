/**
 * Per-challenge EV ranker (items 4+6, 2026-10-01): challenge-ev.ts, the
 * settlement-epoch batch count + R-hat in settlements.ts, and the baseReward
 * stamping on mining rows. Fixtures use the live numbers measured that day
 * (open list + 14 challenge-detail GETs joined to our settlement ledger).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  challengeBaseReward,
  parseBaseRewardField,
  classifyAttempt,
  kindFactors,
  priorFactors,
  verifiableStarvationGuard,
  scoreChallenge,
  rankChallengesByEv,
  compareScoredChallenges,
  formatEvTop,
  formatKindFactors,
  challengeRankerMode,
  starvationGuardN,
  SUBMIT_RATE_PRIOR,
  SUBMIT_RATE_STRENGTH,
  SURVIVAL_PRIOR,
  SURVIVAL_STRENGTH,
  COMP_PRIOR,
  COMP_STRENGTH,
  type KindFactorTable,
  type MiningAttemptRow,
} from "../challenge-ev.js";
import { challengeRowMeta, compareChallengePriority, computeVerifiableTilt, type Challenge } from "../mining.js";
import { kHatByKind, rHatByEpoch, reconcileSettlements, settlementEpochKey, settlementEpochLabel } from "../settlements.js";

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0); // 2026-10-01T18:00Z
const iso = (ms: number) => new Date(ms).toISOString();
const hoursAgo = (h: number) => iso(NOW - h * 3_600_000);
const daysAgo = (d: number) => iso(NOW - d * 86_400_000);

/** A factor table with explicit numbers (bypasses shrinkage). */
function table(f: Record<string, { submitRate: number; survival: number; compHat: number }>): KindFactorTable {
  const t: KindFactorTable = {};
  for (const kind of ["standard", "python_tests", "javascript_tests", "exact_answer"]) t[kind] = priorFactors(kind);
  for (const [kind, v] of Object.entries(f)) t[kind] = { ...priorFactors(kind), ...v };
  return t;
}

const DIEM_402 =
  'Venice API 402: {"error":"API key DIEM spend limit exceeded. Your account may still have DIEM balance, but this API key has reached its configured DIEM spending limit."}';
const SPEC_400 =
  "Gateway request failed (400): traceSummary specificity score 22/100 (threshold 35). Sub-scores: numbers +12, techniques +0";

describe("challenge-ev: baseReward", () => {
  it("parses the wire field, which is a STRING (\"50000\")", () => {
    assert.deepEqual(challengeBaseReward({ baseReward: "50000", difficulty: "medium" }), { value: 50_000, source: "field" });
    assert.deepEqual(challengeBaseReward({ baseReward: 500_000 }), { value: 500_000, source: "field" });
  });
  it("falls back to difficulty multipliers 1/5/15/50 in 10k-NOOK units (the observed ladder)", () => {
    assert.equal(challengeBaseReward({ difficulty: "easy" }).value, 10_000);
    assert.equal(challengeBaseReward({ difficulty: "Medium" }).value, 50_000);
    assert.equal(challengeBaseReward({ difficulty: "hard" }).value, 150_000);
    assert.equal(challengeBaseReward({ difficulty: "expert" }).value, 500_000);
    assert.equal(challengeBaseReward({ difficulty: "expert" }).source, "difficulty");
  });
  it("garbage or missing field never yields NaN/0 — difficulty, then medium", () => {
    for (const bad of ["", "abc", "0", "-5", null, undefined]) {
      assert.equal(parseBaseRewardField(bad), null, String(bad));
    }
    assert.deepEqual(challengeBaseReward({ baseReward: "abc", difficulty: "hard" }), { value: 150_000, source: "difficulty" });
    assert.deepEqual(challengeBaseReward({}), { value: 50_000, source: "default" });
  });
  it("challengeRowMeta stamps the raw field + difficulty, never an inferred price", () => {
    assert.deepEqual(challengeRowMeta({ baseReward: "150000", difficulty: "hard" }), { baseReward: 150_000, difficulty: "hard" });
    assert.deepEqual(challengeRowMeta({ difficulty: "hard" }), { difficulty: "hard" });
    assert.deepEqual(challengeRowMeta({}), {});
  });
});

describe("challenge-ev: attempt classification (submit rate excludes infrastructure)", () => {
  it("accepted = a submissionId, whatever the outcome", () => {
    assert.equal(classifyAttempt({ outcome: "deferred", submissionId: "s1" }), "accepted");
  });
  it("Venice spend caps, network, aborts, gateway 5xx, IPFS are excluded (production strings)", () => {
    for (const notes of [
      DIEM_402,
      'Venice API 402: {"error":"API key USD spend limit exceeded. Your account may still have USD balance"}',
      'Venice API 402: {"error":"Insufficient USD or Diem balance to complete request."}',
      'Venice API 500: {"error":"Inference processing failed"}',
      "fetch failed",
      "This operation was aborted",
      "Gateway request failed (502): <!DOCTYPE html>",
      "Gateway request failed (500): The gateway hit an unexpected error while recording the submission",
      "IPFS upload failed",
      "venice budget stand-down until 00:00Z",
    ]) {
      assert.equal(classifyAttempt({ outcome: "error", notes }), "excluded", notes);
    }
  });
  it("availability refusals (cap, duplicate, guild lock, model id) are excluded too", () => {
    for (const notes of [
      "Gateway request failed (429): Maximum 12 regular challenge per 24-hour epoch. Try again later",
      "Gateway request failed (409): You already submitted this challenge on 2026-09-30T02:00:00Z",
      "Gateway request failed (400): Challenge is claimed by guild 100002 until 2026-10-01T04:00:00.000Z. Only guild members",
      'Gateway request failed (400): modelUsed "glm-5-1" doesn\'t look like a real model name',
    ]) {
      assert.equal(classifyAttempt({ outcome: "error", notes }), "excluded", notes);
    }
  });
  it("quality failures count against the kind", () => {
    for (const notes of [
      SPEC_400,
      "specificity gate: summary unfixable locally (submit skipped)",
      "dryrun hard-fail (retryable): ImportError",
      "solver produced no output",
      "Gateway request failed (400): traceSummary is required (minimum 100 characters).",
    ]) {
      assert.equal(classifyAttempt({ outcome: "error", notes }), "failed", notes);
    }
  });
  it("'understanding downstream' is not a stand-down", () => {
    assert.equal(classifyAttempt({ outcome: "error", notes: "model misread understanding downstream" }), "failed");
  });
});

describe("challenge-ev: per-kind factors", () => {
  it("shrinks each rate toward its prior and counts only non-excluded attempts", () => {
    const mining: MiningAttemptRow[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ ts: hoursAgo(i + 1), verifierKind: "python_tests", outcome: "deferred", submissionId: `p${i}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ ts: hoursAgo(i + 1), verifierKind: "python_tests", outcome: "error", notes: SPEC_400 })),
      ...Array.from({ length: 50 }, (_, i) => ({ ts: hoursAgo(i % 20), verifierKind: "python_tests", outcome: "error", notes: DIEM_402 })),
      { ts: daysAgo(30), verifierKind: "python_tests", outcome: "error", notes: SPEC_400 }, // outside the window
    ];
    const t = kindFactors([], mining, NOW, 14);
    assert.equal(t.python_tests.attempts, 10, "the 50 DIEM 402s and the 30-day-old row are not attempts");
    assert.equal(t.python_tests.accepted, 6);
    const want = (6 + SUBMIT_RATE_STRENGTH * SUBMIT_RATE_PRIOR) / (10 + SUBMIT_RATE_STRENGTH);
    assert.ok(Math.abs(t.python_tests.submitRate - want) < 1e-12);
  });
  it("survival + compHat come from the LATEST settlement row per submission, windowed on resolution time", () => {
    const settlements = [
      { ts: daysAgo(3), submissionId: "a", verifierKind: "standard", status: "verified", compositeScore: 0.5, verifiedAt: daysAgo(3) },
      { ts: daysAgo(2), submissionId: "b", verifierKind: "standard", status: "rejected", compositeScore: 0 },
      { ts: daysAgo(1), submissionId: "c", verifierKind: "standard", status: "expired", compositeScore: 0 },
      // superseded: verified-unpaid then verified-paid → one resolution, not two
      { ts: daysAgo(2), submissionId: "d", verifierKind: "standard", status: "verified", compositeScore: 0.7, verifiedAt: daysAgo(2) },
      { ts: daysAgo(1), submissionId: "d", verifierKind: "standard", status: "verified", compositeScore: 0.7, verifiedAt: daysAgo(2) },
      // backfilled today but verified 20 days ago → outside a 14d window
      { ts: daysAgo(0), submissionId: "e", verifierKind: "standard", status: "verified", compositeScore: 0.9, verifiedAt: daysAgo(20) },
      { ts: daysAgo(1), submissionId: "f", status: "submitted" }, // non-terminal
    ];
    const t = kindFactors(settlements, [], NOW, 14);
    assert.equal(t.standard.resolved, 4);
    assert.equal(t.standard.verified, 2);
    assert.ok(Math.abs(t.standard.survival - (2 + SURVIVAL_STRENGTH * SURVIVAL_PRIOR) / (4 + SURVIVAL_STRENGTH)) < 1e-12);
    assert.ok(Math.abs(t.standard.compHat - (1.2 + COMP_STRENGTH * COMP_PRIOR) / (2 + COMP_STRENGTH)) < 1e-12);
  });
  it("every kind is present; kinds without evidence carry the priors (finite, middling EV)", () => {
    const t = kindFactors([], [], NOW);
    for (const k of ["standard", "python_tests", "javascript_tests", "exact_answer"]) {
      assert.deepEqual(t[k], priorFactors(k));
    }
  });
  it("'?' kind on mining rows (standard without challengeType) maps to standard", () => {
    const t = kindFactors([], [{ ts: hoursAgo(1), verifierKind: "?", outcome: "deferred", submissionId: "x" }], NOW);
    assert.equal(t.standard.accepted, 1);
  });
});

describe("challenge-ev: R cancels — difficulty is not kind (the 09-27 batch)", () => {
  // 09-27: python medium (base 50k) K=88,654 and standard expert (base 500k)
  // K=886,545 in ONE epoch → R = 1.7731 for both. Equal kind factors → the
  // EV ratio is exactly the baseReward ratio, 10x.
  const flat = table({ standard: { submitRate: 1, survival: 1, compHat: 1 }, python_tests: { submitRate: 1, survival: 1, compHat: 1 } });
  it("with equal kind factors the EV ratio is the baseReward ratio", () => {
    const py = scoreChallenge({ id: "py", verifierKind: "python_tests", difficulty: "medium", baseReward: "50000" }, flat);
    const std = scoreChallenge({ id: "std", difficulty: "expert", baseReward: "500000" }, flat);
    assert.equal(std.ev / py.ev, 10);
  });

  // The kind factors behind the evidence item: standard 0.98 × 0.25 × 0.38,
  // python 0.73 × 0.88 × 0.875 — numbers chosen to reproduce its ~13.9k / ~28.1k / ~46.5k.
  const live = table({
    standard: { submitRate: 0.98, survival: 0.25, compHat: 0.38 },
    python_tests: { submitRate: 0.73, survival: 0.88, compHat: 0.875 },
  });
  const stdHard: Challenge = { id: "std-hard", difficulty: "hard", baseReward: "150000", submissionCount: 0 };
  const stdExpert: Challenge = { id: "std-expert", difficulty: "expert", baseReward: "500000", submissionCount: 0 };
  const pyMedium = (i: number): Challenge => ({ id: `py-${i}`, verifierKind: "python_tests", difficulty: "medium", baseReward: "50000", submissionCount: 0 });

  it("a python medium outranks a standard hard (legacy 'standard first' picked the hard)", () => {
    const ranked = rankChallengesByEv([stdHard, pyMedium(0)], live);
    assert.equal(ranked[0].challenge.id, "py-0");
    // and the legacy comparator, at its no-evidence default, did the opposite
    assert.ok(compareChallengePriority(stdHard, pyMedium(0), []) < 0);
  });
  it("a standard expert is NOT buried under 23 python mediums (legacy preferVerifiable did that)", () => {
    const pool = [...Array.from({ length: 23 }, (_, i) => pyMedium(i)), stdExpert];
    const ranked = rankChallengesByEv(pool, live);
    assert.equal(ranked[0].challenge.id, "std-expert");
    const legacy = [...pool].sort((a, b) => compareChallengePriority(a, b, [], { preferVerifiable: true }));
    assert.equal(legacy[legacy.length - 1].id, "std-expert", "legacy tilt put the expert last");
  });
  it("a missing baseReward ranks by the same scale via difficulty (no unit mismatch)", () => {
    const field = scoreChallenge({ id: "a", difficulty: "hard", baseReward: "150000" }, live);
    const inferred = scoreChallenge({ id: "b", difficulty: "hard" }, live);
    assert.equal(field.ev, inferred.ev);
    assert.equal(compareScoredChallenges(field, inferred), 0);
  });
});

describe("challenge-ev: starvation guard (item 6)", () => {
  const v = (h: number, ok: boolean, notes = SPEC_400): MiningAttemptRow =>
    ok
      ? { ts: hoursAgo(h), verifierKind: "python_tests", outcome: "deferred", submissionId: `s${h}` }
      : { ts: hoursAgo(h), verifierKind: "python_tests", outcome: "error", notes };

  it("fires when the last 4 verifiable attempts in 24h all failed locally", () => {
    const g = verifiableStarvationGuard([v(10, true), v(4, false), v(3, false), v(2, false), v(1, false)], NOW);
    assert.equal(g.active, true);
  });
  it("one acceptance among the last 4 keeps it off", () => {
    assert.equal(verifiableStarvationGuard([v(4, false), v(3, true), v(2, false), v(1, false)], NOW).active, false);
  });
  it("infrastructure failures are invisible to it (a DIEM outage is not starvation)", () => {
    const rows = [v(9, true), v(8, false), v(7, false), v(6, false), v(5, false, DIEM_402), v(4, false, DIEM_402), v(3, false, "fetch failed")];
    // last 4 NON-infra attempts: 9 ok, 8 fail, 7 fail, 6 fail → off
    assert.equal(verifiableStarvationGuard(rows, NOW).active, false);
  });
  it("only the rolling 24h counts; fewer than 4 attempts never fires; n=0 disables", () => {
    assert.equal(verifiableStarvationGuard([v(30, false), v(3, false), v(2, false), v(1, false)], NOW).active, false);
    assert.equal(verifiableStarvationGuard([v(3, false), v(2, false), v(1, false)], NOW).active, false);
    assert.equal(verifiableStarvationGuard([v(4, false), v(3, false), v(2, false), v(1, false)], NOW, 0).active, false);
  });
  it("standard rows don't count toward it", () => {
    const std = (h: number): MiningAttemptRow => ({ ts: hoursAgo(h), verifierKind: "standard", outcome: "error", notes: SPEC_400 });
    assert.equal(verifiableStarvationGuard([std(4), std(3), std(2), std(1)], NOW).active, false);
  });
  it("while active, every standard outranks every verifiable — but verifiable is still ranked (sort, not filter)", () => {
    const t = table({ standard: { submitRate: 0.9, survival: 0.2, compHat: 0.5 }, python_tests: { submitRate: 0.9, survival: 0.9, compHat: 0.7 } });
    const pool: Challenge[] = [
      { id: "py-hard", verifierKind: "python_tests", baseReward: "150000" },
      { id: "std-easy", difficulty: "easy", baseReward: "10000" },
    ];
    assert.equal(rankChallengesByEv(pool, t)[0].challenge.id, "py-hard");
    const guarded = rankChallengesByEv(pool, t, { guardActive: true });
    assert.deepEqual(guarded.map((s) => s.challenge.id), ["std-easy", "py-hard"]);
    assert.equal(guarded[1].demoted, true);
  });
  it("persistent local failures lower a kind's submitRate; the same count of infra failures does not", () => {
    const fails = Array.from({ length: 8 }, (_, i) => v(i + 1, false));
    const infra = Array.from({ length: 8 }, (_, i) => v(i + 1, false, DIEM_402));
    assert.ok(kindFactors([], fails, NOW).python_tests.submitRate < SUBMIT_RATE_PRIOR / 2);
    assert.equal(kindFactors([], infra, NOW).python_tests.submitRate, SUBMIT_RATE_PRIOR);
  });
  it("BOT_VERIFIABLE_STARVATION_N: default 4, 0 disables, garbage → 4", () => {
    const prev = process.env.BOT_VERIFIABLE_STARVATION_N;
    try {
      delete process.env.BOT_VERIFIABLE_STARVATION_N;
      assert.equal(starvationGuardN(), 4);
      process.env.BOT_VERIFIABLE_STARVATION_N = "0";
      assert.equal(starvationGuardN(), 0);
      process.env.BOT_VERIFIABLE_STARVATION_N = "abc";
      assert.equal(starvationGuardN(), 4);
    } finally {
      if (prev === undefined) delete process.env.BOT_VERIFIABLE_STARVATION_N;
      else process.env.BOT_VERIFIABLE_STARVATION_N = prev;
    }
  });
});

describe("challenge-ev: the comparator is a total order", () => {
  it("is antisymmetric and transitive over a mixed pool, with and without the guard", () => {
    const t = table({
      standard: { submitRate: 0.93, survival: 0.27, compHat: 0.53 },
      python_tests: { submitRate: 0.62, survival: 0.84, compHat: 0.69 },
    });
    const kinds = [undefined, "python_tests", "javascript_tests"];
    const bases = [undefined, "10000", "50000", "150000", "500000"];
    const diffs = ["easy", "medium", "hard", "expert", undefined];
    const pool: Challenge[] = [];
    let i = 0;
    for (const verifierKind of kinds) for (const baseReward of bases) for (const difficulty of diffs) {
      pool.push({ id: `c${i}`, verifierKind, baseReward, difficulty, submissionCount: i % 7, domainTags: i % 2 ? ["algorithms"] : [] });
      i++;
    }
    for (const guardActive of [false, true]) {
      const s = pool.map((c) => scoreChallenge(c, t, { guardActive, specMatch: (c) => (c.domainTags ?? []).length > 0 }));
      const cmp = compareScoredChallenges;
      for (const a of s) for (const b of s) {
        assert.equal(Math.sign(cmp(a, b)), -Math.sign(cmp(b, a)) || 0);
        if (cmp(a, b) > 0) continue;
        for (const c of s) {
          if (cmp(b, c) <= 0) assert.ok(cmp(a, c) <= 0, `cycle: ${a.challenge.id} ${b.challenge.id} ${c.challenge.id}`);
        }
      }
    }
  });
  it("EV ties fall through to competition, then fewer submissions, then specialization", () => {
    const t = table({});
    const s = (c: Challenge, spec = false) => scoreChallenge(c, t, { specMatch: () => spec });
    const lowSubs = s({ id: "a", baseReward: "150000", submissionCount: 2 });
    const highSubs = s({ id: "b", baseReward: "150000", submissionCount: 9 });
    assert.ok(compareScoredChallenges(lowSubs, highSubs) < 0);
    const zero = s({ id: "c", baseReward: "150000", submissionCount: 0 });
    assert.ok(compareScoredChallenges(zero, lowSubs) < 0);
    assert.ok(compareScoredChallenges(s({ id: "d", baseReward: "150000" }, true), s({ id: "e", baseReward: "150000" }, false)) < 0);
    assert.equal(compareScoredChallenges(s({ id: "f", baseReward: "150000", estimatedRewardNook: 900 }), s({ id: "g", baseReward: "150000", estimatedRewardNook: 2 })), 0);
  });
  it("a NaN-producing input scores 0 rather than poisoning the sort", () => {
    const t = table({ standard: { submitRate: Number.NaN, survival: 0.5, compHat: 0.5 } });
    assert.equal(scoreChallenge({ id: "x", baseReward: "150000" }, t).ev, 0);
  });
});

describe("challenge-ev: kill switch + log lines", () => {
  it("BOT_CHALLENGE_EV_RANK=0 selects legacy, =1 makes EV active, anything else is shadow (legacy active)", () => {
    // Default flipped ev → shadow in review (2026-10-01): the per-epoch
    // solving cap breaks "R cancels" on most days; activation is the operator's.
    assert.equal(challengeRankerMode({ BOT_CHALLENGE_EV_RANK: "0" }), "legacy");
    assert.equal(challengeRankerMode({}), "shadow");
    assert.equal(challengeRankerMode({ BOT_CHALLENGE_EV_RANK: "1" }), "ev");
  });
  it("the top-3 line carries every EV component and the guard state", () => {
    const t = table({ python_tests: { submitRate: 0.62, survival: 0.84, compHat: 0.69 } });
    const ranked = rankChallengesByEv(
      [
        { id: "aaaaaaaa-1", verifierKind: "python_tests", difficulty: "hard", baseReward: "150000" },
        { id: "bbbbbbbb-2", verifierKind: "python_tests", difficulty: "medium", baseReward: "50000" },
        { id: "cccccccc-3", difficulty: "hard" },
        { id: "dddddddd-4", difficulty: "easy", baseReward: "10000" },
      ],
      t,
    );
    const line = formatEvTop(ranked, { active: false, reason: "2/4 failed" });
    assert.match(line, /1\) aaaaaaaa python_tests\/hard 150k × sub 0\.62 × surv 0\.84 × comp 0\.69 = 53\.\dk·R/);
    assert.match(line, /cccccccc standard\/hard 150k\(difficulty\)/);
    assert.doesNotMatch(line, /dddddddd/, "only the top 3");
    assert.match(line, /starvation guard off \(2\/4 failed\)/);
  });
  it("the factors line shows evidence counts and R-hat (or that none is available yet)", () => {
    const t = kindFactors([], [{ ts: hoursAgo(1), verifierKind: "python_tests", outcome: "deferred", submissionId: "x" }], NOW);
    assert.match(formatKindFactors(t, 14), /python_tests sub 0\.80 \(1\/1\).*R̂ n\/a/);
    assert.match(formatKindFactors(t, 14, [{ epoch: "2026-09-27", r: 1.7731, n: 9 }]), /R̂ 1\.773 @2026-09-27 \(n9; 1 epoch with baseReward\)/);
  });
  it("the legacy tilt reason now shows the batch counts next to the multiple", () => {
    const tl = computeVerifiableTilt({
      ratio: 0.6, standardRewardMultiple: 2.84, standardRewardMultipleSource: "measured",
      standardRewardMultipleBatches: "python_tests b9 vs standard b4",
      minResolved: 10, standardResolved: 53, standardLossShare: 42 / 53, verifiableSurvival: 0.86, todaySubmitted: 9, todayVerifiable: 5,
    });
    assert.match(tl.reason, /2\.84x measured reward, python_tests b9 vs standard b4\)/);
  });
});

describe("settlements: batches = settlement epochs, not distinct K (item 4.2)", () => {
  // 09-18T13:21 paid a python medium (K 218,750) and a python hard (K 656,250):
  // two K values, ONE epoch, one R (4.375).
  const r = (verifiedAt: string, realizedNook: number, compositeScore: number, extra: Record<string, unknown> = {}) => ({
    ts: verifiedAt, verifiedAt, verifierKind: "python_tests", status: "verified", realizedNook, compositeScore, ...extra,
  });
  const NOW2 = Date.UTC(2026, 8, 20, 0, 0, 0);

  it("difficulty variants in one epoch are ONE batch (it used to be two — passing the 2-batch bar alone)", () => {
    const rows = [
      r("2026-09-18T13:21:00Z", 0.72 * 218_750, 0.72, { baseReward: 50_000 }),
      r("2026-09-18T13:21:30Z", 0.72 * 656_250, 0.72, { baseReward: 150_000 }),
    ];
    const k = kHatByKind(rows, NOW2);
    assert.equal(k.python_tests.n, 2);
    assert.equal(k.python_tests.batches, 1);
    assert.ok(Math.abs((k.python_tests.rHat ?? 0) - 4.375) < 1e-9);
    assert.equal(k.python_tests.rN, 2);
  });
  it("two settlement passes inside one 02:00Z epoch are one batch; across the boundary are two", () => {
    // 09-21T19:21 and 09-22T01:21 paid the same K (243,056) — same epoch.
    assert.equal(settlementEpochKey(Date.parse("2026-09-21T19:21:00Z")), settlementEpochKey(Date.parse("2026-09-22T01:21:00Z")));
    assert.notEqual(settlementEpochKey(Date.parse("2026-09-22T01:59:59Z")), settlementEpochKey(Date.parse("2026-09-22T02:00:00Z")));
    assert.equal(settlementEpochLabel(settlementEpochKey(Date.parse("2026-09-22T01:21:00Z"))), "2026-09-21");
    const rows = [r("2026-09-18T13:21:00Z", 157_500, 0.72), r("2026-09-19T19:21:00Z", 264_622, 0.72)];
    assert.equal(kHatByKind(rows, NOW2).python_tests.batches, 2);
  });
  it("rHatByEpoch reproduces the measured 09-27 R across kinds (python medium + standard expert)", () => {
    const rows = [
      { ts: "x", verifiedAt: "2026-09-27T22:18:00Z", verifierKind: "python_tests", status: "verified", realizedNook: 37_093, compositeScore: 0.4184, baseReward: 50_000 },
      { ts: "x", verifiedAt: "2026-09-27T22:20:00Z", verifierKind: "standard", status: "verified", realizedNook: 454_620, compositeScore: 0.5128, baseReward: 500_000 },
      { ts: "x", verifiedAt: "2026-09-27T22:20:00Z", verifierKind: "standard", status: "verified", realizedNook: 454_620, compositeScore: 0.5128 }, // no base → not in R-hat
    ];
    const out = rHatByEpoch(rows, Date.UTC(2026, 8, 30), 14);
    assert.equal(out.length, 1);
    assert.equal(out[0].epoch, "2026-09-27");
    assert.equal(out[0].n, 2);
    assert.ok(Math.abs(out[0].r - 1.7731) < 0.001, `R=${out[0].r}`);
  });
  it("reconcileSettlements copies baseReward + difficulty from the local row when present", () => {
    const local = new Map([
      ["s1", { verifierKind: "python_tests", model: "grok-4-7", baseReward: 50_000, difficulty: "medium" }],
      ["s2", { verifierKind: "standard", model: "grok-4-7" }],
    ]);
    const out = reconcileSettlements(
      [
        { id: "s1", status: "verified", rewardStatus: "paid", rewardNook: "88654", compositeScore: "0.5" },
        { id: "s2", status: "rejected", compositeScore: "0" },
      ],
      local,
      [],
      daysAgo(0),
    );
    assert.equal(out[0].baseReward, 50_000);
    assert.equal(out[0].difficulty, "medium");
    assert.equal("baseReward" in out[1], false);
    assert.equal("difficulty" in out[1], false);
  });
});
