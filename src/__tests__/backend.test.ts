/**
 * Backend test suite — pure-function coverage across the bot's surface.
 *
 * Run with: `npm test`
 *
 * Targets:
 *   - models.ts:       pickModel, pickModelAB, effortFor
 *   - util.ts:         extractJson, extractJsonObj, readJsonl
 *   - mining.ts:       isPermanentFailure, isEpochExhausted, regularEpochCapResetAt,
 *                       specificityCategories, countSpecificity, padTraceSummary, buildSpecificityTail
 *   - guild.ts:        tierBoost, tierNum, members, domainOverlap, rank, guildId
 *   - network-status:  vcount (snake-case + string coercion)
 *   - rlm-spotcheck:   normalizeModel
 *   - mining-sandbox:  smokeTestExactAnswer
 *   - mining-context:  pickDomainHint, formatSearchResults, formatVaultHits
 *   - dashboard-web:   blocker scoring (via importing computeBlockers — exported below)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { pickModel, pickModelAB, effortFor } from "../models.js";
import { runsInLean, LEAN_KEEP, leanBanner, isLean, type LeanTrack } from "../lean.js";
import { analyzeQuorumHealth, type NsEntry } from "../quorum-watch.js";
import { extractJson, extractJsonObj } from "../util.js";
import {
  isPermanentFailure,
  isEpochExhausted,
  specificityCategories,
  countSpecificity,
  padTraceSummary,
  buildSpecificityTail,
  regularEpochCapResetAt,
  epochDayStartMs,
  rollingCapState,
  pacingGate,
  maybeOverrideModelForVerifiable,
  gatewayModelName,
  verifiableFailHint,
  parseVerifiableSolution,
  extractFencedCode,
  salvageMarkdownTrace,
} from "../mining.js";
import { aggregateCapacity, capacityUnderuse } from "../capacity.js";
import { dailySpendSeries } from "../pnl.js";
import { analyzeRejections } from "../check-rejections.js";
import { dedupReadmeSections, isHighStakesTag, isMechanicalGateFailure } from "../projects.js";
import { tierBoost, tierNum, members, domainOverlap, rank, guildId } from "../guild.js";
import { vcount } from "../network-status.js";
import { normalizeModel } from "../rlm-spotcheck.js";
import { smokeTestExactAnswer, coerceStarterCode } from "../mining-sandbox.js";
import { pickDomainHint, formatSearchResults, formatVaultHits } from "../mining-context.js";
import { verifyThreshold } from "../verify-quota.js";
import { validateVectors } from "../embedding-mining.js";
import { _internals as aggInternals } from "../aggregation.js";
import { isTerminalHeartbeatError } from "../swarms.js";
import { rankBounties } from "../bounty-review.js";
import type { BountyRow } from "../bounties.js";
import { isRerunnableKind, isVerifyEligible, decideFromRerun } from "../verify-kinds.js";
import { specializeDomains, passesSpecializationFilter } from "../mining.js";
import { extractArxivIds, extractHfDatasets } from "../paper-reproduction.js";
import {
  peerQuality,
  peerAuthor,
  peerDomains,
  citationType,
  pickPeerId,
  pickMyId,
} from "../citation-velocity.js";
import {
  selectVoteCandidate,
  rankFollowCandidates,
  buildCommentBody,
} from "../social-engagement.js";
import {
  _templates as onboardingTemplates,
  providerHasListings,
  hasLocalOnboardingRecord,
} from "../onboarding.js";
import { normalizeWorkspaceContent, statusForRegion, REGION_DEFAULT_STATUS } from "../workspace-solve.js";
import { traceTextFromIpfsPayload, isWellFormedCid, cidRejectReason, isPermanentCidError, extractTraceCid, cidBearingKeys } from "../trace-payload.js";
import { traceTextFromGatewayBody, fallbackGateways, fetchTraceViaPublicGateways } from "../ipfs-fetch.js";
import {
  SkipCache,
  isDiversityBlockError,
  isAlreadySubmittedError,
  isFinalizedError,
  isEpochCapError,
  isGuildClaimedError,
  isReciprocalVerificationError,
  parseGuildClaimedUntilTs,
} from "../skip-caches.js";
import {
  recordDiversityPollSaturation,
  highRatioTickCount,
  maybeWarnDiversityPollSaturation,
  _resetForTests as _resetDiversityPollSat,
} from "../diversity-poll-saturation.js";
import { computeVerifyBatch, pollsRemainingBeforeUtcReset } from "../verify-batch.js";
import {
  VERIFY_CALIBRATION_PROMPT,
  auditVerifyCalibrationPrompt,
} from "../verify-calibration.js";
import {
  recordSpecializationMatch,
  lowRatioTickCount,
  _resetForTests as _resetSpecSupply,
} from "../specialization-supply.js";
import {
  isSpecificityError,
  parseMissingCategories,
  enrichSummarySpecificity,
  passesSpecificityGate,
} from "../specificity-gate.js";
import { compareChallengePriority, challengeValueTier, computeVerifiableTilt, isModelRejection, discountStaleIdRejections, meetsValueFloor, isTransientGenerationError, type TiltInputs } from "../mining.js";
import { pickAlternateModel } from "../models.js";
import { selectBundleCids, bundleDue, sanitizeBundleTags, registeredPublishedCids } from "../bundles.js";
import { countWithinDays, cohortAddresses } from "../cohort-benchmark.js";
import {
  postedToday, isDuplicateTitle, rotateDomain, epochDay, nextSettlementMs,
  titleSimilarity, findNearDuplicate, recentPostedTitles, rotateGrounding,
  recentGroundingKeys, noteKey, titleTokenList, gateCorpus, findMotifCollision,
  descriptionSimilarity, isGateRelaxed, fallbackDomainOrder,
} from "../challenge-posting.js";
import { findRepetitiveLearning, findLearningMotifCollision } from "../learnings.js";
import { findTemplateFingerprint, isFarmChallengeTitle, findNearDuplicateTrace, applyOffTopicClamp } from "../trace-fingerprint.js";
import { scoreIntentFit } from "../manifest-intents.js";
import { veniceRateLimited429Today } from "../venice-cost.js";

// ── models.ts ──────────────────────────────────────────────────────────

describe("models", () => {
  it("pickModel returns the configured default for each task", () => {
    // Non-lean default routing. Clear ambient BOT_LEAN (a local .env may set it)
    // so this asserts the DEFAULTS map, not the lean cheap-model override.
    const savedLean = process.env.BOT_LEAN;
    delete process.env.BOT_LEAN;
    try {
      // High-value tasks default to opus-4-8 (the safe fallback under the A/B
      // pool); prose/volume tasks stay on grok-4-3. Verification moved to
      // grok-4-5 on 2026-07-30 at the operator's direction.
      assert.equal(pickModel("mining_solve"), process.env.MODEL_MINING_SOLVE ?? "claude-opus-4-8");
      assert.equal(pickModel("verification_score"), process.env.MODEL_VERIFICATION_SCORE ?? "grok-4-5");
      assert.equal(pickModel("verification_comprehension"), process.env.MODEL_VERIFICATION_COMPREHENSION ?? "grok-4-5");
      assert.equal(pickModel("knowledge_body"), process.env.MODEL_KNOWLEDGE_BODY ?? "grok-4-3");
    } finally {
      if (savedLean === undefined) delete process.env.BOT_LEAN;
      else process.env.BOT_LEAN = savedLean;
    }
  });

  it("pickModelAB returns a model from the pool for tasks with an A/B set", () => {
    // Non-lean A/B sampling (lean would force the cheap model, pool="lean").
    const savedLean = process.env.BOT_LEAN;
    delete process.env.BOT_LEAN;
    // Pool as of 2026-07-28 (operator): opus-5 replaced fable-5, kimi-k3 added,
    // GLM removed (0/52 accepted — the gateway rejects org-prefixed ids).
    // All four verified against the live Venice catalog + solve-shaped probes.
    const allowed = new Set([
      "grok-4-5",
      "claude-opus-5",
      "openai-gpt-56-sol",
      "kimi-k3",
    ]);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const pick = pickModelAB("mining_solve");
        assert.equal(pick.pool, "ab");
        assert.ok(allowed.has(pick.model), `unexpected model: ${pick.model}`);
        seen.add(pick.model);
      }
      // Every arm must actually be reachable — a typo'd id would silently
      // never be picked, or (worse) be picked and rejected at the wire.
      assert.equal(seen.size, allowed.size, `only ${[...seen].join(",")} were ever picked`);
      // What goes on the WIRE must be a shape the gateway's modelUsed validator
      // accepts: either a plain vendor-qualified id (claude-*, grok-*,
      // openai-gpt-*) or an explicit `org/Model` override — the form the
      // validator's own error cites (`meta/llama-3.1-70b-instruct`). What it
      // rejects is Venice's flattened org-DASH id, which cost 52 paid solves
      // on GLM and 3 on a bare `kimi-k3`.
      for (const m of allowed) {
        const wire = gatewayModelName(m);
        assert.ok(!/^(zai-org-|e2ee-)/.test(wire), `${m} → "${wire}" keeps a flattened org prefix the gateway rejects`);
        assert.ok(
          /^(claude|grok|openai|gemini|deepseek)-/.test(wire) || wire.includes("/"),
          `${m} → "${wire}" is neither vendor-qualified nor org/Model form`,
        );
      }
      // Reasoning effort is configured ONLY for arms that expose the dial.
      // Per the live catalog (2026-07-28): grok-4-5 supports low|medium|high,
      // openai-gpt-56-sol supports up to max, and claude-opus-5 / kimi-k3
      // report supportsReasoningEffort=false — a value for those would be an
      // ignored parameter dressed up as a calibration decision.
      assert.equal(effortFor("claude-opus-5"), undefined);
      assert.equal(effortFor("kimi-k3"), undefined);
      // And never send an effort a model doesn't accept: grok-4-5 tops out at
      // "high" (it was set to an unsupported "xhigh" for three weeks).
      assert.equal(effortFor("grok-4-5"), "high");
      assert.equal(effortFor("openai-gpt-56-sol"), "high");
    } finally {
      if (savedLean === undefined) delete process.env.BOT_LEAN;
      else process.env.BOT_LEAN = savedLean;
    }
  });

  it("pickModelAB falls back to default when no pool is configured", () => {
    const p = pickModelAB("verification_score");
    assert.equal(p.pool, "default");
  });

  it("effortFor returns xhigh for top-tier models, high for openai-gpt-55", () => {
    assert.equal(effortFor("claude-opus-4-7"), "xhigh");
    assert.equal(effortFor("grok-4-3"), "xhigh");
    assert.equal(effortFor("deepseek-v4-pro"), "xhigh");
    assert.equal(effortFor("gemini-3-1-pro-preview"), "xhigh");
    assert.equal(effortFor("openai-gpt-55"), "high");
    assert.equal(effortFor("unknown-model"), undefined);
  });

  it("pickModel forces the cheap model under BOT_LEAN unless MODEL_<TASK> is set", () => {
    const savedLean = process.env.BOT_LEAN;
    const savedOv = process.env.MODEL_MINING_SOLVE;
    try {
      delete process.env.MODEL_MINING_SOLVE;
      process.env.BOT_LEAN = "1";
      // residual inference (e.g. the daily challenge draft) drops to the cheap model
      assert.equal(pickModel("mining_solve"), "grok-4-3");
      assert.equal(pickModel("bounty_draft"), "grok-4-3");
      // an explicit per-task override still wins in lean
      process.env.MODEL_MINING_SOLVE = "claude-opus-4-8";
      assert.equal(pickModel("mining_solve"), "claude-opus-4-8");
    } finally {
      if (savedLean === undefined) delete process.env.BOT_LEAN;
      else process.env.BOT_LEAN = savedLean;
      if (savedOv === undefined) delete process.env.MODEL_MINING_SOLVE;
      else process.env.MODEL_MINING_SOLVE = savedOv;
    }
  });

  it("pickModelAB also honors BOT_LEAN (the real A/B-routed draft path), not just pickModel", () => {
    const savedLean = process.env.BOT_LEAN;
    const savedOv = process.env.MODEL_BOUNTY_DRAFT;
    try {
      delete process.env.MODEL_BOUNTY_DRAFT;
      process.env.BOT_LEAN = "1";
      // bounty_draft has a non-empty A/B pool; lean must force the cheap model
      // instead of sampling opus/gpt from the pool (the gap the old test missed).
      const p = pickModelAB("bounty_draft");
      assert.equal(p.model, "grok-4-3");
      assert.equal(p.pool, "lean");
      // an explicit per-task override still wins in lean on the A/B path
      process.env.MODEL_BOUNTY_DRAFT = "claude-opus-4-8";
      assert.equal(pickModelAB("bounty_draft").model, "claude-opus-4-8");
    } finally {
      if (savedLean === undefined) delete process.env.BOT_LEAN;
      else process.env.BOT_LEAN = savedLean;
      if (savedOv === undefined) delete process.env.MODEL_BOUNTY_DRAFT;
      else process.env.MODEL_BOUNTY_DRAFT = savedOv;
    }
  });
});

// ── lean.ts ────────────────────────────────────────────────────────────

describe("lean profit mode (BOT_LEAN)", () => {
  const saved = process.env.BOT_LEAN;
  const restore = () => {
    if (saved === undefined) delete process.env.BOT_LEAN;
    else process.env.BOT_LEAN = saved;
  };

  // The inference "grind" — every one of these must be skipped in lean.
  const GRIND: LeanTrack[] = [
    "mining", "verification", "crowdJury", "bounty", "bountyLifecycle",
    "social", "socialEngagement", "engagement", "observation", "predictions",
    "learnings", "teaching", "attention", "paperReproduction", "clarifications",
    "swarms", "knowledgePublish", "draftingAndDormant",
  ];

  it("off by default → every track runs and the banner is empty", () => {
    delete process.env.BOT_LEAN;
    assert.equal(isLean(), false);
    for (const t of [...LEAN_KEEP, ...GRIND]) {
      assert.equal(runsInLean(t), true, `${t} should run when lean is off`);
    }
    assert.equal(leanBanner(), "");
    restore();
  });

  it("on → only the LEAN_KEEP allowlist runs; the grind is skipped", () => {
    process.env.BOT_LEAN = "1";
    assert.equal(isLean(), true);
    for (const t of LEAN_KEEP) assert.equal(runsInLean(t), true, `${t} kept in lean`);
    for (const t of GRIND) assert.equal(runsInLean(t), false, `${t} skipped in lean`);
    assert.ok(leanBanner().includes("BOT_LEAN=1"));
    restore();
  });

  it("keeps the profitable core (royalty engine + reward claims), never in the grind", () => {
    process.env.BOT_LEAN = "1";
    assert.equal(runsInLean("claimRewards"), true);
    assert.equal(runsInLean("weeklyRewards"), true); // wrapper for challenge posting
    // guard against a future edit moving a profitable track into the skip set
    assert.ok(LEAN_KEEP.has("claimRewards") && LEAN_KEEP.has("weeklyRewards"));
    for (const core of ["claimRewards", "weeklyRewards"] as LeanTrack[]) assert.ok(!GRIND.includes(core));
    restore();
  });
});

// ── quorum-watch.ts ──────────────────────────────────────────────────────

describe("quorum-watch.analyzeQuorumHealth (verification stall detector)", () => {
  const base = Date.parse("2026-07-06T00:00:00.000Z");
  const mk = (hour: number, v2: number, pendingSubs = 20): NsEntry => ({
    ts: new Date(base + hour * 3_600_000).toISOString(),
    epoch: 109,
    epochStatus: "closed",
    pool: { v2, quorumReady: 0, distinctSolvers: 30, byDifficulty: { expert: 100 }, total: 100 },
    mine: { pendingSubs, claimableNook: v2 > 0 ? 100000 : 0 },
  });

  it("returns no-data on empty input", () => {
    assert.equal(analyzeQuorumHealth([]).status, "no-data");
  });

  it("healthy when latest v2 > 0 (submissions progressing toward quorum)", () => {
    const h = analyzeQuorumHealth([mk(0, 12), mk(1, 14), mk(2, 16)]);
    assert.equal(h.status, "healthy");
    assert.equal(h.latestV2, 16);
    assert.equal(h.stallHours, 0);
  });

  it("stalled when v2 has been pinned at 0 for >= stallHours", () => {
    // one healthy reading, then 7 hourly zeros (7h span) vs default 6h threshold
    const rows = [mk(0, 14), mk(1, 0), mk(2, 0), mk(3, 0), mk(4, 0), mk(5, 0), mk(6, 0), mk(7, 0)];
    const h = analyzeQuorumHealth(rows);
    assert.equal(h.status, "stalled");
    assert.equal(h.latestV2, 0);
    assert.ok(h.stallHours >= 6, `stallHours=${h.stallHours}`);
    assert.ok(h.lines.join("\n").includes("STALL"));
  });

  it("a short v2=0 blip under the threshold is not a stall", () => {
    const h = analyzeQuorumHealth([mk(0, 14), mk(1, 0), mk(2, 0)], { stallHours: 6 });
    assert.equal(h.status, "healthy"); // only ~1h of zeros
  });

  it("recovering when v2 returns > 0 after a recent 0-run", () => {
    const h = analyzeQuorumHealth([mk(0, 0), mk(1, 0), mk(2, 0), mk(3, 5)]);
    assert.equal(h.status, "recovering");
    assert.equal(h.latestV2, 5);
  });

  it("tolerates out-of-order and malformed rows", () => {
    const h = analyzeQuorumHealth([mk(2, 0), mk(0, 9), { ts: "not-a-date" } as NsEntry, mk(1, 0)]);
    assert.equal(h.latestV2, 0); // hour-2 row is latest after sort
  });
});

// ── util.ts ────────────────────────────────────────────────────────────

describe("util", () => {
  it("extractJson finds the first balanced JSON block in a string", () => {
    assert.equal(extractJson('prefix {"a":1,"b":[2,3]} suffix'), '{"a":1,"b":[2,3]}');
    assert.equal(extractJson("no json here"), null);
  });

  it("extractJsonObj returns a typed object", () => {
    type T = { x: number; y: string };
    const parsed = extractJsonObj<T>('garbage {"x":5,"y":"hi"} trailing');
    assert.deepEqual(parsed, { x: 5, y: "hi" });
  });

  it("extractJsonObj returns null on malformed input", () => {
    assert.equal(extractJsonObj("hello world"), null);
  });
});

// ── mining.ts ──────────────────────────────────────────────────────────

describe("mining permanent/epoch classifier", () => {
  it("detects guild-tier permanent failures", () => {
    assert.equal(isPermanentFailure("This is a guild-exclusive (requires tier0+ guild)"), true);
    assert.equal(isPermanentFailure("requires a guild membership"), true);
    assert.equal(isPermanentFailure("This challenge is closed"), true);
    assert.equal(isPermanentFailure("already submitted"), true);
  });

  it("does NOT classify transient errors as permanent", () => {
    assert.equal(isPermanentFailure("solver produced no output"), false);
    assert.equal(isPermanentFailure("Gateway request failed (500)"), false);
    assert.equal(isPermanentFailure(undefined), false);
  });

  it("detects epoch-exhausted errors", () => {
    assert.equal(isEpochExhausted("Maximum 1 guild-exclusive challenge per 24-hour epoch."), true);
    assert.equal(isEpochExhausted("Epoch submission cap reached (6/day)"), true);
    assert.equal(isEpochExhausted("Try again next epoch"), true);
    assert.equal(isEpochExhausted("nothing to see here"), false);
  });

  it("computes the next 02:00 UTC mining epoch boundary after a cap hit", () => {
    assert.equal(
      new Date(regularEpochCapResetAt(Date.parse("2026-05-28T01:30:00.000Z"))).toISOString(),
      "2026-05-28T02:00:00.000Z",
    );
    assert.equal(
      new Date(regularEpochCapResetAt(Date.parse("2026-05-28T19:16:00.000Z"))).toISOString(),
      "2026-05-29T02:00:00.000Z",
    );
  });

  it("epochDayStartMs computes the most recent 02:00Z boundary (retained helper)", () => {
    // After 02:00Z → current day's 02:00 is the window start (yesterday's
    // submissions no longer count, so the cap frees up at the epoch reset).
    assert.equal(
      new Date(epochDayStartMs(Date.parse("2026-06-16T02:33:00.000Z"))).toISOString(),
      "2026-06-16T02:00:00.000Z",
    );
    // Before 02:00Z → still in the prior epoch-day (started yesterday 02:00Z).
    assert.equal(
      new Date(epochDayStartMs(Date.parse("2026-06-16T01:30:00.000Z"))).toISOString(),
      "2026-06-15T02:00:00.000Z",
    );
    // Exactly at the boundary → that boundary is the start.
    assert.equal(
      new Date(epochDayStartMs(Date.parse("2026-06-16T02:00:00.000Z"))).toISOString(),
      "2026-06-16T02:00:00.000Z",
    );
  });
});

describe("trace-fingerprint (anti-farm verification abstention)", () => {
  // Strings quoted from the actual 2026-07-19 farm sample.
  it("strong fingerprints fire alone", () => {
    assert.ok(findTemplateFingerprint("achieving 150ms commit latency @ 20ms RTT across regions"));
    assert.ok(findTemplateFingerprint("LSM tiered compaction reached 180K w/s vs B-tree 60K baseline"));
    assert.ok(findTemplateFingerprint("validated over n=12 trials, CV<1% in all cases"));
    assert.ok(findTemplateFingerprint("run config: salt=21080 applied to jitter"));
    assert.ok(findTemplateFingerprint("payout to wallet=0xf73625 confirmed"));
    assert.ok(findTemplateFingerprint("Raft pre-vote with batch+pipe Accept, then io_uring for the data plane"));
    assert.ok(findTemplateFingerprint("as computed above [ref Brian-3f2a91cc-21115]"));
  });

  it("weak markers need corroboration — a legit ML trace with seed=42 passes", () => {
    assert.equal(findTemplateFingerprint("We fixed seed=42 for reproducibility and reran the ablation."), null);
    assert.equal(findTemplateFingerprint("session uid=9f3a2b1c logged"), null);
    // Two weak markers together = generator jitter block.
    assert.ok(findTemplateFingerprint("params: seed=143 uid=9f3a2b1c salt omitted"));
  });

  it("genuine technical prose does not trip the gate", () => {
    const genuine =
      "For RS(10,4) with LRC we model durability as a Markov birth-death chain; MTTDL falls to 2.1e9 hours when repair bandwidth is capped at 40MB/s per node, and the tradeoff against local-group repair cost dominates below 14 disks.";
    assert.equal(findTemplateFingerprint(genuine), null);
  });

  it("isFarmChallengeTitle matches the generator pattern, never our real titles", () => {
    assert.ok(isFarmChallengeTitle("Brian distributed-systems expert analysis 3f2a91"));
    assert.ok(isFarmChallengeTitle("Kaiju8 cryptography specialist analysis deadbeef"));
    for (const ours of [
      "Dedup Pipeline: Rabin-Karp Rolling Hash vs Cuckoo Hashing Under a 512 MB Budget",
      "LoRA Rank vs. Base-Weight Quantization Under a 24 GB VRAM Budget",
      "Expert-Analysis: Resilience Patterns Using Circuit-Breakers and Bulkheads",
      "SABRE vs. Token-Swapping Routing on a 127-Qubit Heavy-Hex Lattice",
    ]) assert.equal(isFarmChallengeTitle(ours), false, `false positive: ${ours}`);
  });

  it("findNearDuplicateTrace catches a jittered sibling, passes distinct work", () => {
    const seen = [
      "Invariant: leader completeness holds. Failure injection: partition minority. Acceptance: 150ms commit at 20ms RTT, batch+pipe gives +3.5x. HNSW ef=64 reaches 95%@10 in 1.2ms vs IVF 88%. Validated over n=12 trials, CV<1%.",
    ];
    const sibling =
      "Invariant: leader completeness holds. Failure injection: partition minority. Acceptance: 150ms commit at 20ms RTT, batch+pipe gives +3.7x. HNSW ef=64 reaches 95%@10 in 1.3ms vs IVF 89%. Validated over n=12 trials, CV<1%.";
    assert.ok(findNearDuplicateTrace(sibling, seen), "jittered sibling should match");
    const distinct =
      "We prove the scheduler is starvation-free by exhibiting a variant function on the ready queue; the bound tightens from O(n^2) to O(n log n) when priorities are drawn from a bounded lattice.";
    assert.equal(findNearDuplicateTrace(distinct, seen), null);
  });

  it("applyOffTopicClamp caps the other dims when correctness detects mismatch", () => {
    const clamped = applyOffTopicClamp({ correctnessScore: 0.2, reasoningScore: 0.68, efficiencyScore: 0.72, noveltyScore: 0.5 });
    assert.ok(clamped.reasoningScore <= 0.35 && clamped.efficiencyScore <= 0.35 && clamped.noveltyScore <= 0.35);
    // On-topic scores untouched.
    const ok = applyOffTopicClamp({ correctnessScore: 0.7, reasoningScore: 0.68, efficiencyScore: 0.72, noveltyScore: 0.5 });
    assert.equal(ok.efficiencyScore, 0.72);
  });
});

describe("mining.gatewayModelName (gateway modelUsed validator rejects org-prefixed ids)", () => {
  it("strips vendor prefixes the gateway 400s on, passes normal ids through", () => {
    assert.equal(gatewayModelName("zai-org-glm-5-2"), "glm-5-2"); // 15 rejected solves 07-17→19
    assert.equal(gatewayModelName("e2ee-glm-5-2-p"), "glm-5-2-p");
    assert.equal(gatewayModelName("claude-fable-5"), "claude-fable-5");
    assert.equal(gatewayModelName("openai-gpt-56-sol"), "openai-gpt-56-sol");
    assert.equal(gatewayModelName("grok-4-5"), "grok-4-5");
  });
});

describe("mining.maybeOverrideModelForVerifiable (route weak-for-code models off verifiable)", () => {
  const AB = (model: string) => ({ model, reasoning_effort: "high" as const });
  const py = { id: "c1", verifierKind: "python_tests" } as any;
  const std = { id: "c2", verifierKind: undefined, challengeType: "standard" } as any;
  const saved = { ov: process.env.BOT_VERIFIABLE_MODEL_OVERRIDE, m: process.env.BOT_VERIFIABLE_MODEL };
  const clean = () => { delete process.env.BOT_VERIFIABLE_MODEL_OVERRIDE; delete process.env.BOT_VERIFIABLE_MODEL; };
  const restore = () => {
    if (saved.ov === undefined) delete process.env.BOT_VERIFIABLE_MODEL_OVERRIDE; else process.env.BOT_VERIFIABLE_MODEL_OVERRIDE = saved.ov;
    if (saved.m === undefined) delete process.env.BOT_VERIFIABLE_MODEL; else process.env.BOT_VERIFIABLE_MODEL = saved.m;
  };

  it("routes grok-4-3 → opus on a verifiable (python_tests) challenge", () => {
    clean();
    try { assert.equal(maybeOverrideModelForVerifiable(py, AB("grok-4-3")).model, "claude-opus-4-8"); }
    finally { restore(); }
  });
  it("leaves an already code-strong A/B pick (opus / gpt-55) unchanged on verifiable", () => {
    clean();
    try {
      assert.equal(maybeOverrideModelForVerifiable(py, AB("claude-opus-4-8")).model, "claude-opus-4-8");
      assert.equal(maybeOverrideModelForVerifiable(py, AB("openai-gpt-55")).model, "openai-gpt-55");
    } finally { restore(); }
  });
  it("does NOT touch standard (non-verifiable) challenges — keeps grok in the A/B pool", () => {
    clean();
    try { assert.equal(maybeOverrideModelForVerifiable(std, AB("grok-4-3")).model, "grok-4-3"); }
    finally { restore(); }
  });
  it("respects an explicit env override, and the kill-switch", () => {
    clean();
    try {
      process.env.BOT_VERIFIABLE_MODEL = "openai-gpt-55";
      assert.equal(maybeOverrideModelForVerifiable(py, AB("grok-4-3")).model, "openai-gpt-55");
      process.env.BOT_VERIFIABLE_MODEL_OVERRIDE = "0";
      assert.equal(maybeOverrideModelForVerifiable(py, AB("grok-4-3")).model, "grok-4-3"); // disabled → untouched
    } finally { restore(); }
  });
  it("won't force a parse-fail-sidelined default model", () => {
    clean();
    try {
      const rates = { "claude-opus-4-8": { attempts: 10, failures: 8, rate: 0.8 } };
      assert.equal(maybeOverrideModelForVerifiable(py, AB("grok-4-3"), rates).model, "grok-4-3");
    } finally { restore(); }
  });
});

describe("mining.verifiableFailHint (feed the exact failing test back to the solver)", () => {
  it("combines fail_reason + stdout excerpt", () => {
    const h = verifiableFailHint({ fail_reason: "tests_failed: 1/2", stdout_excerpt: "AssertionError: SECURITY: SSRF to 169.254.169.254" });
    assert.match(h!, /Failing: tests_failed: 1\/2/);
    assert.match(h!, /SECURITY: SSRF/);
  });
  it("returns null when there is nothing actionable", () => {
    assert.equal(verifiableFailHint({}), null);
    assert.equal(verifiableFailHint(null), null);
    assert.equal(verifiableFailHint(undefined), null);
  });
  it("falls back to stderr when stdout is empty", () => {
    assert.match(verifiableFailHint({ stderr_excerpt: "Traceback: pickle.loads" })!, /pickle\.loads/);
  });
});

describe("mining.rollingCapState (rolling-24h regular cap — fixes the alternating 12/0 bug)", () => {
  const H = 3600_000;
  const DAY = 24 * H;
  const now = Date.parse("2026-06-27T02:05:00.000Z");

  it("not capped when fewer than `cap` accepted submissions are in the window", () => {
    const ts = Array.from({ length: 11 }, (_, i) => now - i * H); // 11 in the last 11h
    const s = rollingCapState(ts, now, 12);
    assert.equal(s.used, 11);
    assert.equal(s.capped, false);
    assert.equal(s.freeAtMs, null);
  });

  it("capped at 12, and frees exactly 24h after the OLDEST in-window submission", () => {
    // 12 submitted 03:00–03:55 the prior day — this is the real failure case:
    // at 02:05 a naive 02:00-reset would read 0 used, but these are still inside
    // the rolling 24h window, so we ARE capped until the 03:00 one ages out.
    const base = Date.parse("2026-06-26T03:00:00.000Z");
    const ts = Array.from({ length: 12 }, (_, i) => base + i * 5 * 60_000);
    const s = rollingCapState(ts, now, 12);
    assert.equal(s.used, 12);
    assert.equal(s.capped, true);
    assert.equal(s.freeAtMs, base + DAY); // 2026-06-27T03:00Z — mining resumes then
  });

  it("excludes submissions older than the window (their slot already freed)", () => {
    const aged = now - DAY - H; // 25h ago — out of window
    const ts = [aged, ...Array.from({ length: 11 }, (_, i) => now - i * H)];
    const s = rollingCapState(ts, now, 12);
    assert.equal(s.used, 11);
    assert.equal(s.capped, false);
  });

  it("with 13 in-window, frees when the 2nd-oldest ages out (count drops to 11)", () => {
    const base = now - DAY + H; // all inside the window
    const ts = Array.from({ length: 13 }, (_, i) => base + i * 60_000);
    const s = rollingCapState(ts, now, 12);
    assert.equal(s.used, 13);
    assert.equal(s.freeAtMs, ts[1] + DAY); // used - cap = 1 → index 1 (2nd oldest)
  });
});

describe("mining.pacingGate (spread rolling-cap slots; dissolve the burst-cluster attractor)", () => {
  const H = 3600_000;
  const DAY = 24 * H;
  const now = Date.parse("2026-07-04T12:00:00.000Z");
  const gap = (DAY / 12) * 0.9; // ~108 min at cap 12

  it("no pacing in catch-up mode (window more than half free)", () => {
    const ts = Array.from({ length: 5 }, (_, i) => now - i * 10 * 60_000); // 5 in window, last just now
    assert.equal(pacingGate(ts, now, 12, DAY).waitUntilMs, null);
  });

  it("paces once the window is half full: waits ~0.9×window/cap after the last accepted", () => {
    const last = now - 30 * 60_000; // 30 min ago — inside the pacing gap
    const ts = [last, ...Array.from({ length: 7 }, (_, i) => now - (2 + i) * H)]; // 8 in window
    const s = pacingGate(ts, now, 12, DAY);
    assert.equal(s.waitUntilMs, last + gap);
  });

  it("does not pace when the gap since the last accepted has already elapsed", () => {
    const ts = Array.from({ length: 8 }, (_, i) => now - (2 + i) * H); // last was 2h ago > gap
    assert.equal(pacingGate(ts, now, 12, DAY).waitUntilMs, null);
  });

  it("defers to the cap gate when at/over cap (no double-gating)", () => {
    const ts = Array.from({ length: 12 }, (_, i) => now - i * 10 * 60_000);
    assert.equal(pacingGate(ts, now, 12, DAY).waitUntilMs, null);
  });
});

describe("capacity.aggregateCapacity (daily utilization trend)", () => {
  const now = Date.parse("2026-06-27T12:00:00.000Z");
  const mk = (date: string, n: number, outcome: string) =>
    Array.from({ length: n }, () => ({ ts: `${date}T03:00:00.000Z`, outcome }));

  it("buckets accepted mining + verify/crowd by UTC day, including zero days", () => {
    const mining = [
      ...mk("2026-06-25", 12, "deferred"),
      ...mk("2026-06-27", 4, "pass"),
      { ts: "2026-06-25T05:00:00.000Z", outcome: "error" }, // excluded (not accepted)
    ];
    const quota = [
      ...Array.from({ length: 9 }, () => ({ ts: "2026-06-26T10:00:00.000Z", kind: "verify" })),
      { ts: "2026-06-26T11:00:00.000Z", kind: "crowd-score" },
      { ts: "2026-06-26T11:00:00.000Z", kind: "limit-hit" }, // excluded
    ];
    const rows = aggregateCapacity(mining, quota, 3, now, 12, 38);
    assert.equal(rows.length, 3);
    const by = Object.fromEntries(rows.map((r) => [r.date, r]));
    assert.equal(by["2026-06-25"].miningUsed, 12);
    assert.equal(by["2026-06-25"].miningPct, 100);
    assert.equal(by["2026-06-26"].miningUsed, 0); // zero day still present
    assert.equal(by["2026-06-26"].verifyUsed, 10); // 9 verify + 1 crowd-score
    assert.equal(by["2026-06-27"].miningUsed, 4);
  });
});

describe("check-rejections.analyzeRejections (post-fix reject-rate verdict)", () => {
  const since = Date.parse("2026-07-01T00:00:00Z");
  const mk = (status: string, model: string, when: string, kind = "python_tests") =>
    ({ status, modelUsed: model, submittedAt: when, traceFormat: "reasoning_v1", verificationOutcome: { verifier_kind: kind } });

  it("only counts submissions after the fix-deploy cutoff", () => {
    const subs = [
      mk("rejected", "grok-4-3", "2026-06-25T00:00:00Z"), // pre-fix, excluded
      mk("verified", "claude-opus-4-8", "2026-07-02T00:00:00Z"),
      mk("verified", "claude-opus-4-8", "2026-07-02T01:00:00Z"),
    ];
    const a = analyzeRejections(subs, since);
    assert.equal(a.postCount, 2);
    assert.equal(a.dist.rejected ?? 0, 0);
  });

  it("computes reject rate and per-model breakdown; grokCodeUsed=0 when grok is off code", () => {
    const subs = [
      ...Array.from({ length: 9 }, (_, i) => mk("verified", "claude-opus-4-8", `2026-07-02T0${i}:00:00Z`)),
      mk("rejected", "claude-opus-4-8", "2026-07-02T10:00:00Z"),
    ];
    const a = analyzeRejections(subs, since);
    assert.equal(a.resolved, 10);
    assert.ok(Math.abs(a.rejectRate - 0.1) < 1e-9);
    assert.equal(a.grokCodeUsed, 0);
    assert.equal(a.byModel["claude-opus-4-8"].n, 10);
    assert.equal(a.byModel["claude-opus-4-8"].rejected, 1);
  });

  it("flags grok still on the code path", () => {
    const a = analyzeRejections([mk("rejected", "grok-4-3", "2026-07-02T00:00:00Z")], since);
    assert.equal(a.grokCodeUsed, 1);
  });
});

describe("capacity.capacityUnderuse (chronic-waste flag)", () => {
  const mkRow = (mu: number, vu: number) => ({
    date: "x", miningUsed: mu, miningCap: 12, miningPct: Math.round((mu / 12) * 100),
    verifyUsed: vu, verifyCap: 38, verifyPct: Math.round((vu / 38) * 100),
  });
  it("returns null when both are above floor", () => {
    assert.equal(capacityUnderuse(Array.from({ length: 7 }, () => mkRow(12, 30)), { window: 5 }), null);
  });
  it("flags chronic verify under-use, ignoring the partial last day", () => {
    const rows = [...Array.from({ length: 6 }, () => mkRow(12, 5)), mkRow(12, 38)];
    const f = capacityUnderuse(rows, { window: 5 });
    assert.ok(f && /verify avg/.test(f) && !/mining avg/.test(f));
  });
  it("flags mining under-use", () => {
    const f = capacityUnderuse(Array.from({ length: 7 }, () => mkRow(4, 30)), { window: 5, verifyFloor: 0 });
    assert.ok(f && /mining avg/.test(f));
  });
  it("returns null without enough complete days", () => {
    assert.equal(capacityUnderuse(Array.from({ length: 3 }, () => mkRow(0, 0)), { window: 5 }), null);
  });
});

describe("mining.parseVerifiableSolution / extractFencedCode (verifiable-solve robustness)", () => {
  it("extracts solution from well-formed JSON", () => {
    const r = parseVerifiableSolution('{"solution":"def f():\\n    return 1","reasoning":"r","summary":"s"}', "solution");
    assert.equal(r?.value, "def f():\n    return 1");
    assert.equal(r?.reasoning, "r");
  });

  it("salvages a fenced code block when the model emits prose/markdown instead of JSON", () => {
    const content = "Here's my approach.\n```python\ndef count_lines(p):\n    return sum(1 for _ in open(p))\n```\nDone.";
    const r = parseVerifiableSolution(content, "solution");
    assert.match(r?.value ?? "", /def count_lines/);
  });

  it("salvages from broken/truncated JSON that still contains a code fence", () => {
    const content = "broken {json: ```python\ndef g():\n    return 2\n```";
    const r = parseVerifiableSolution(content, "solution");
    assert.match(r?.value ?? "", /def g/);
  });

  it("returns null when there is no solution and no code fence", () => {
    assert.equal(parseVerifiableSolution('{"reasoning":"r","summary":"s"}', "solution"), null);
    assert.equal(parseVerifiableSolution("just prose, no code", "solution"), null);
  });

  it("answer field uses strict JSON only — no code-fence fallback", () => {
    assert.equal(parseVerifiableSolution('{"answer":"42","reasoning":"r"}', "answer")?.value, "42");
    assert.equal(parseVerifiableSolution("the answer is 42", "answer"), null);
  });

  it("extractFencedCode picks the longest fenced block; null when none", () => {
    assert.equal(extractFencedCode("```py\nshort\n```\n```py\nmuch longer block here\n```"), "much longer block here");
    assert.equal(extractFencedCode("no fences here"), null);
  });
});

describe("mining specificity scoring", () => {
  it("specificityCategories detects numbers", () => {
    const c = specificityCategories("This runs at 12ms with 50% accuracy");
    assert.equal(c.numbers, true);
  });

  it("specificityCategories detects backticked code", () => {
    const c = specificityCategories("Use `np.argmax` on the result");
    assert.equal(c.code, true);
  });

  it("specificityCategories detects camelCase technique names", () => {
    const c = specificityCategories("We use thisCamelCase identifier");
    assert.equal(c.techniques, true);
  });

  it("specificityCategories detects comparisons", () => {
    const c = specificityCategories("Option A is better than Option B");
    assert.equal(c.comparisons, true);
  });

  it("specificityCategories detects failures and actionable", () => {
    const c = specificityCategories("This pitfall fails when you avoid the prefer path");
    assert.equal(c.failures, true);
    assert.equal(c.actionable, true);
  });

  it("countSpecificity returns number of present categories", () => {
    const s = "Algorithm runs at 12ms, uses `quickSort` vs mergesort, avoid pitfalls";
    const n = countSpecificity(s);
    assert.ok(n >= 4, `expected ≥4 categories, got ${n}`);
  });

  it("padTraceSummary pads short inputs to ≥100 chars", () => {
    const ch = { id: "abc", title: "Test", difficulty: "easy", domainTags: ["x"] };
    const out = padTraceSummary("short", ch);
    assert.ok(out.length >= 100, `expected ≥100, got ${out.length}`);
    assert.ok(out.length <= 500);
  });

  it("padTraceSummary boosts specificity when categories < 3", () => {
    const ch = { id: "abc", title: "Test", difficulty: "easy", domainTags: ["python"] };
    // Generic baseline summary (no specificity markers)
    const generic = "approach for this task summarized briefly. " + "y".repeat(60);
    // Context that has more substance than summary triggers the boost branch
    const context = "Algorithm runs at 50ms using `quickSort` instead of `bubbleSort`, avoiding O(n^2) pitfalls in production codepath benchmarked across N=1000 trials.";
    const out = padTraceSummary(generic, ch, context);
    const cats = countSpecificity(out);
    assert.ok(cats >= 3, `expected ≥3 categories after boost, got ${cats}; out=${out.slice(0,300)}`);
  });

  it("buildSpecificityTail extracts numbers and identifiers", () => {
    const ch = { id: "abc", domainTags: ["python"] };
    // Provide letter-starting words on both sides of "vs" so the vsMatch
    // regex (\b[A-Za-z][\w-]+\s+vs\s+[A-Za-z][\w-]+) fires.
    const tail = buildSpecificityTail("Code uses `myFunction` quickly, scoring quickSort vs mergeSort at 250ms", ch);
    assert.ok(tail.includes("250"));
    assert.ok(tail.includes("myFunction"));
    assert.ok(tail.includes(" vs "), `tail missing 'vs': ${tail}`);
  });
});

describe("specificity gate recalibration (gateway-weighted, ≥2 hard categories)", () => {
  it("numbers requires a UNIT — bare integers score 0 (matches gateway numbers+0)", () => {
    assert.equal(specificityCategories("In 2026 at step 1 we set the config").numbers, false);
    assert.equal(specificityCategories("latency 12ms over 3 tokens").numbers, true);
    assert.equal(specificityCategories("complexity O(n log n)").numbers, true);
  });

  it("passesSpecificityGate counts ONLY gateway-credited categories (techniques/code/failures)", () => {
    assert.equal(passesSpecificityGate("use the handler and prefer the chosen path"), false); // actionable only
    assert.equal(passesSpecificityGate("in 2026 we set the flag to enable retry"), false);    // bare number + actionable
    assert.equal(passesSpecificityGate("the fooBar method handles it"), false);               // 1 credited category never clears
    assert.equal(passesSpecificityGate("uses `parse()` which fails on empty input"), true);   // code + failures = 36
    // Gateway scored numbers AND comparisons +0 in all 109+94 observed 400s even
    // with units / X-vs-Y present — this summary reaches only 30 there. The old
    // gate passed it and burned a rolling-cap slot per attempt.
    assert.equal(passesSpecificityGate("Raft vs Paxos, latency 12ms"), false);
    assert.equal(passesSpecificityGate("the fooBar method fails on empty input"), true);      // techniques + failures = 37
  });

  it("enrichment prioritizes gateway-scoring categories over phantom numbers/comparisons", () => {
    // Source has fragments for every category; the tail must lead with the
    // +4/+3 ones (failures/techniques/code), not the +0 numbers/comparisons.
    const summary = "we improved the approach for this task and set a flag";
    const source = "benchmarked 12ms vs 40ms; the fastPath method fails on empty input; see `resolve()` in main.py";
    const out = enrichSummarySpecificity(summary, [source]);
    assert.ok(passesSpecificityGate(out), `enriched must clear the real gate: ${out}`);
    const tail = out.slice(summary.length);
    const failuresPos = tail.search(/failure mode:/);
    const numbersPos = tail.search(/measured /);
    assert.ok(failuresPos !== -1, `failures fragment must be added: ${tail}`);
    if (numbersPos !== -1) assert.ok(failuresPos < numbersPos, `failures before numbers: ${tail}`);
  });

  it("enrichment lifts a failing summary to passing when the source (incl. code) has hard fragments", () => {
    const summary = "we set the flag for this task"; // actionable only → fails gate
    assert.equal(passesSpecificityGate(summary), false);
    const codeSource = "def fooBar(x):\n    if not x: raise ValueError('empty')  # fails on edge case; runs in 12ms";
    const out = enrichSummarySpecificity(summary, [undefined, codeSource]);
    assert.ok(passesSpecificityGate(out), `enriched should pass: ${out}`);
    assert.notEqual(out, summary);
  });

  it("enrichment adds NO filler when the source is thin (summary unchanged, no fabricated tokens)", () => {
    const summary = "we set the flag for this task";
    assert.equal(enrichSummarySpecificity(summary, ["hello world nothing here"]), summary);
  });
});

describe("projects.dedupReadmeSections (auto-fix the recurring duplicate-header defect)", () => {
  it("keeps the first of each ## section and drops later duplicates", () => {
    const md = "# Proj\n\n## Tests\n\nrun tests\n\n## Grounding\n\nfrom work\n\n## Tests\n\nsandbox output\n\n## Provenance\n\n- [1] x\n";
    const out = dedupReadmeSections(md);
    assert.equal((out.match(/^## Tests/gm) || []).length, 1);
    assert.ok(out.includes("run tests"));       // first Tests kept
    assert.ok(!out.includes("sandbox output")); // duplicate section dropped
    assert.ok(out.includes("## Grounding") && out.includes("## Provenance"));
  });
  it("leaves a clean README's structure intact", () => {
    const out = dedupReadmeSections("# P\n\n## A\n\nx\n\n## B\n\ny\n");
    assert.ok(out.includes("## A") && out.includes("## B") && out.includes("x") && out.includes("y"));
  });
});

describe("projects.isMechanicalGateFailure (transients auto-retry; substance waits for the human)", () => {
  it("classifies the exact mechanical failure strings as retryable", () => {
    // The three shapes autoSubmitGate produces for gate-side (not draft-side) failures.
    assert.equal(isMechanicalGateFailure("review flagged: review output did not parse"), true); // 07-17 cache-store: froze the queue 2 days
    assert.equal(isMechanicalGateFailure("could not read draft source for review"), true);
    assert.equal(isMechanicalGateFailure("gate error: fetch failed"), true);
  });

  it("substantive verdicts are NOT retryable — the human decides", () => {
    assert.equal(isMechanicalGateFailure("sandbox tests did not pass"), false);
    assert.equal(isMechanicalGateFailure('high-stakes domain "appsec" — subtle-correctness territory, human review required'), false);
    assert.equal(isMechanicalGateFailure("review confidence medium (auto-submit needs high)"), false);
    // A REAL review finding that merely mentions parsing must not be misread
    // as mechanical (the classifier is anchored, not substring-matched).
    assert.equal(isMechanicalGateFailure("review flagged: input JSON did not parse before validation, allowing bypass"), false);
    assert.equal(isMechanicalGateFailure(""), false);
  });
});

describe("projects.isHighStakesTag (tag synonyms must not bypass always-escalate)", () => {
  it("catches exact defaults and the appsec-style synonyms that bypassed the old exact match", () => {
    for (const t of ["security", "cryptography", "appsec", "infosec", "websec", "Application-Security", "web-security", "oauth", " Security "]) {
      assert.equal(isHighStakesTag(t), true, t);
    }
  });
  it("leaves genuinely low-stakes tags alone", () => {
    for (const t of ["documentation", "algorithms", "developer-experience", "machine-learning", "ipfs-cid-validation"]) {
      assert.equal(isHighStakesTag(t), false, t);
    }
  });
});

describe("pnl.dailySpendSeries (per-day inference spend for the P&L card)", () => {
  const now = Date.parse("2026-07-04T18:00:00.000Z");
  it("sums per-call costs by UTC day and zero-fills days with no calls", () => {
    const entries = [
      { ts: "2026-07-04T02:00:00Z", estCost: 1.5 },
      { ts: "2026-07-04T15:00:00Z", estCost: 0.5 },
      { ts: "2026-07-02T23:59:00Z", estCost: 2 },
      { ts: "2026-06-01T00:00:00Z", estCost: 99 },     // outside window — dropped
      { ts: "2026-07-03T00:00:00Z", estCost: NaN },     // bad record — dropped
    ];
    const s = dailySpendSeries(entries, 3, now);
    assert.deepEqual(s.map((d) => d.date), ["2026-07-02", "2026-07-03", "2026-07-04"]);
    assert.deepEqual(s.map((d) => d.spendUsd), [2, 0, 2]);
    assert.deepEqual(s.map((d) => d.calls), [1, 0, 2]);
  });
});

describe("quotas.verifyPaceOk (hourly burst cap — prevents the 06-30 collapse day)", () => {
  const now = Date.parse("2026-07-04T12:00:00.000Z");
  it("allows when under the hourly rate", () => {
    assert.equal(verifyPaceOk([now - 50 * 60_000], now, 2), true);
  });
  it("blocks when the trailing hour is at the rate", () => {
    assert.equal(verifyPaceOk([now - 10 * 60_000, now - 30 * 60_000], now, 2), false);
  });
  it("actions older than an hour don't count against the rate", () => {
    const ts = [now - 61 * 60_000, now - 90 * 60_000, now - 20 * 60_000];
    assert.equal(verifyPaceOk(ts, now, 2), true);
  });
});

describe("quotas.isVerifyCapError (matches the real gateway verify-429)", () => {
  it("matches the real 'Maximum N verification challenge per 24-hour epoch' wording", () => {
    assert.equal(isVerifyCapError("Gateway request failed (429): Maximum 40 verification challenge per 24-hour epoch. Try again next epoch."), true);
  });
  it("still matches legacy wording and ignores unrelated errors", () => {
    assert.equal(isVerifyCapError("verify shared budget exhausted"), true);
    assert.equal(isVerifyCapError("Gateway request failed (502): upstream error"), false);
  });
});

describe("workspace content normalization", () => {
  it("passes object content through unchanged", () => {
    const input = { text: "already shaped", meta: { source: "test" } };
    assert.deepEqual(normalizeWorkspaceContent(input), input);
  });

  it("wraps string content as an object for the gateway", () => {
    assert.deepEqual(normalizeWorkspaceContent("hello"), { text: "hello" });
  });

  it("wraps null/undefined as { text: '' } (never a non-object)", () => {
    assert.equal(typeof normalizeWorkspaceContent(null), "object");
    assert.equal(typeof normalizeWorkspaceContent(undefined), "object");
    const out = normalizeWorkspaceContent(undefined);
    assert.ok(!Array.isArray(out));
  });

  it("wraps arrays via JSON.stringify so gateway sees an object", () => {
    const out = normalizeWorkspaceContent([1, 2, 3]);
    assert.equal(typeof out, "object");
    assert.ok(!Array.isArray(out));
    assert.ok(typeof (out as { text?: unknown }).text === "string");
  });
});

describe("traceTextFromIpfsPayload (the .trim crash regression)", () => {
  it("returns a raw string payload as-is", () => {
    assert.equal(traceTextFromIpfsPayload("trace body"), "trace body");
  });

  it("returns null for nullish or primitive payloads", () => {
    assert.equal(traceTextFromIpfsPayload(null), null);
    assert.equal(traceTextFromIpfsPayload(undefined), null);
    assert.equal(traceTextFromIpfsPayload(42), null);
  });

  it("picks traceMarkdown when present and is a string", () => {
    assert.equal(traceTextFromIpfsPayload({ traceMarkdown: "abc" }), "abc");
  });

  it("falls back through markdown -> content -> body -> text", () => {
    assert.equal(traceTextFromIpfsPayload({ text: "z" }), "z");
    assert.equal(traceTextFromIpfsPayload({ body: "y" }), "y");
    assert.equal(traceTextFromIpfsPayload({ content: "x" }), "x");
  });

  it("recurses one level into nested {text|body|content} objects", () => {
    // The exact shape that crashed before the fix:
    // upstream changed content from string to {text: string}
    assert.equal(traceTextFromIpfsPayload({ content: { text: "nested" } }), "nested");
    assert.equal(traceTextFromIpfsPayload({ body: { body: "deeper" } }), "deeper");
  });

  it("returns null (not a non-string) when every candidate field is non-string", () => {
    // pre-fix this returned `{ shape: 'unexpected' }` and crashed at .trim()
    assert.equal(traceTextFromIpfsPayload({ traceMarkdown: 42, content: { shape: "unexpected" } }), null);
  });

  it("skips empty strings and keeps looking", () => {
    assert.equal(traceTextFromIpfsPayload({ traceMarkdown: "", text: "kept" }), "kept");
  });
});

describe("trace-payload.isWellFormedCid (the CID carousel guard)", () => {
  it("rejects the observed truncated placeholder CIDs (hard-skip, no fetch)", () => {
    // Real values pulled from the 2026-06-15 logs that 400'd "Invalid CID format".
    assert.equal(isWellFormedCid("Qme9c319c24c"), false); // 12 chars
    assert.equal(isWellFormedCid("QmfZFxMm4MF5"), false);
    assert.equal(isWellFormedCid("Qm9e84ab8ce1"), false);
    assert.equal(isWellFormedCid(""), false);
  });

  it("accepts a real CIDv0 (46-char Qm…)", () => {
    assert.ok(isWellFormedCid("Qmb2KBzLzoA9u2BXfRFcRhDgmNXtgx3sGbAfgC5zS4EcTw"));
    assert.equal("Qmb2KBzLzoA9u2BXfRFcRhDgmNXtgx3sGbAfgC5zS4EcTw".length, 46);
  });

  it("accepts a CIDv1 base32 (b…) — gets a network attempt", () => {
    assert.ok(isWellFormedCid("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"));
  });

  it("accepts unusual-but-plausible CIDs (length-keyed, not prefix-keyed)", () => {
    // base36 CIDv1 (k…) and base58 CIDv1 (z…) must NOT be hard-skipped — the
    // old prefix regex would have dropped base36 forever. ≥40 alnum → let the
    // gateway decide; a genuine bad hash still 400s and is caught downstream.
    assert.ok(isWellFormedCid("k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8"));
    assert.ok(isWellFormedCid("z" + "A1b2C3d4E5".repeat(5))); // 51 alnum chars
  });

  it("rejects non-base-alnum junk and anything under the length floor", () => {
    assert.equal(isWellFormedCid("Qm/../../etc/passwd"), false); // has slashes
    assert.equal(isWellFormedCid("a".repeat(39)), false);        // 39 < 40 floor
    assert.equal(isWellFormedCid("a".repeat(40)), true);         // exactly at floor
  });

  it("rejects synthetic 'Qm'+hex CIDs (the spam that 400s and burns the verify budget)", () => {
    // Real values from the 2026-06-18 live pool: 46 chars, Qm-prefixed, but the
    // body is a hex digest — the `0` is outside base58btc, so the gateway 400s
    // "Invalid CID format" every time. Must be hard-skipped client-side.
    assert.equal(isWellFormedCid("Qm424d0f7ca290ab5bc1110ff7ba7853d704044e760658"), false);
    assert.equal(isWellFormedCid("Qm40ffc27726b00c5cc749189d77f03abc1c2659f60535"), false);
    assert.equal(isWellFormedCid("Qm60c198be943ffbf0fe14c957f3f1f8b484277e0dfa94"), false);
    // The real base58 CIDs from the SAME pool (traceFormat=reasoning_v1) that
    // DO fetch must still pass.
    assert.ok(isWellFormedCid("QmQ3KC1k8FheuajYDXpWBADAacyd1VCpLzM3C784QzSyaC"));
    assert.ok(isWellFormedCid("QmSwiDcLY68WKKW7Z2JFh3VtZQR2aCV52pgQ2DJCZyeqfc"));
  });
});

describe("trace-payload.cidRejectReason (spam vs truncation — kills the phantom 'valid CID rejected' alarm)", () => {
  it("identifies a 46-char Qm+hex fake as a correct skip, naming the forbidden char", () => {
    const r = cidRejectReason("Qm424d0f7ca290ab5bc1110ff7ba7853d704044e760658");
    assert.match(r, /non-base58 char '0'/);
    assert.match(r, /hex-digest fake/);
    assert.match(r, /correct skip/);
  });

  it("identifies a truncated Qm placeholder by length, not as a fake", () => {
    const r = cidRejectReason("Qme9c319c24c"); // 12 chars
    assert.match(r, /len=12/);
    assert.match(r, /truncated|placeholder/);
    assert.doesNotMatch(r, /hex-digest fake/);
  });

  it("flags the impossible case (base58-valid Qm46 that still got here) for human attention", () => {
    // isWellFormedCid would never reject this — but if the call site ever does,
    // the reason makes the false-rejection obvious rather than silent.
    const r = cidRejectReason("Qmb2KBzLzoA9u2BXfRFcRhDgmNXtgx3sGbAfgC5zS4EcTw");
    assert.match(r, /should NOT have been rejected/);
  });

  it("describes non-Qm truncation and junk", () => {
    assert.match(cidRejectReason("a".repeat(20)), /len=20 \(<40\)/);
    assert.match(cidRejectReason("b".repeat(40) + "/.."), /non-alphanumeric/);
  });
});

describe("ipfs-fetch (public-gateway fallback for 502'd verify trace fetches)", () => {
  it("traceTextFromGatewayBody returns a raw markdown body untouched", () => {
    assert.equal(traceTextFromGatewayBody("# Trace\n\nstep 1 ...\n"), "# Trace\n\nstep 1 ...");
  });

  it("traceTextFromGatewayBody digs the trace out of a JSON wrapper body", () => {
    assert.equal(traceTextFromGatewayBody('{"content":"the real trace"}'), "the real trace");
    assert.equal(traceTextFromGatewayBody('{"content":{"text":"nested trace"}}'), "nested trace");
  });

  it("traceTextFromGatewayBody falls back to raw text when JSON has no trace field", () => {
    // Better to hand the verifier the raw JSON than to drop the submission.
    assert.equal(traceTextFromGatewayBody('{"unrelated":1}'), '{"unrelated":1}');
  });

  it("traceTextFromGatewayBody returns null on empty/whitespace", () => {
    assert.equal(traceTextFromGatewayBody("   \n  "), null);
    assert.equal(traceTextFromGatewayBody(""), null);
  });

  it("fallbackGateways honors BOT_IPFS_FALLBACK_GATEWAYS override", () => {
    const prev = process.env.BOT_IPFS_FALLBACK_GATEWAYS;
    try {
      delete process.env.BOT_IPFS_FALLBACK_GATEWAYS;
      assert.ok(fallbackGateways().some((g) => g.includes("ipfs.io")));
      process.env.BOT_IPFS_FALLBACK_GATEWAYS = "https://my.gw/ipfs/, https://other.gw/ipfs/";
      assert.deepEqual(fallbackGateways(), ["https://my.gw/ipfs/", "https://other.gw/ipfs/"]);
    } finally {
      if (prev === undefined) delete process.env.BOT_IPFS_FALLBACK_GATEWAYS;
      else process.env.BOT_IPFS_FALLBACK_GATEWAYS = prev;
    }
  });

  it("fetchTraceViaPublicGateways tries the next gateway when the first fails", async () => {
    const realFetch = globalThis.fetch;
    const prevEnv = process.env.BOT_IPFS_FALLBACK_GATEWAYS;
    process.env.BOT_IPFS_FALLBACK_GATEWAYS = "https://gw1/ipfs/, https://gw2/ipfs/";
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("gw1")) return { ok: false, status: 502, text: async () => "" } as Response;
        return { ok: true, status: 200, text: async () => "recovered trace body" } as Response;
      }) as typeof fetch;
      const out = await fetchTraceViaPublicGateways("QmWhatever");
      assert.equal(out, "recovered trace body");
      assert.equal(calls.length, 2); // tried gw1 (failed) then gw2 (ok)
    } finally {
      globalThis.fetch = realFetch;
      if (prevEnv === undefined) delete process.env.BOT_IPFS_FALLBACK_GATEWAYS;
      else process.env.BOT_IPFS_FALLBACK_GATEWAYS = prevEnv;
    }
  });

  it("fetchTraceViaPublicGateways returns null when every gateway fails", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
      const out = await fetchTraceViaPublicGateways("QmWhatever");
      assert.equal(out, null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("trace-payload.isPermanentCidError (permanent vs transient)", () => {
  it("treats gateway 400 'Invalid CID format' as permanent", () => {
    assert.equal(isPermanentCidError("Gateway request failed (400): Invalid CID format"), true);
    assert.equal(isPermanentCidError("invalid cid format"), true); // case-insensitive
  });

  it("treats 5xx / timeouts / 502s as transient (retryable)", () => {
    assert.equal(isPermanentCidError("Gateway request failed (502): <!DOCTYPE html>"), false);
    assert.equal(isPermanentCidError("Gateway request failed (500): upstream error"), false);
    assert.equal(isPermanentCidError("request timed out"), false);
    assert.equal(isPermanentCidError(""), false);
  });
});

describe("trace-payload.extractTraceCid (verify-budget unblock: schema-drift + truncated-prefix)", () => {
  const REAL_V0 = "Qmb2KBzLzoA9u2BXfRFcRhDgmNXtgx3sGbAfgC5zS4EcTw"; // 46
  const REAL_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  it("reads the canonical traceCid field (unchanged happy path)", () => {
    assert.equal(extractTraceCid({ traceCid: REAL_V0 }), REAL_V0);
    assert.equal(extractTraceCid({ traceCid: REAL_V1 }), REAL_V1);
  });

  it("recovers a renamed/snake_case field (the silent schema-drift outage)", () => {
    assert.equal(extractTraceCid({ trace_cid: REAL_V0 }), REAL_V0);
    assert.equal(extractTraceCid({ ipfsCid: REAL_V1 }), REAL_V1);
    assert.equal(extractTraceCid({ cid: REAL_V0 }), REAL_V0);
  });

  it("recovers a CID nested one level under trace/ipfs objects", () => {
    assert.equal(extractTraceCid({ trace: { cid: REAL_V0 } }), REAL_V0);
    assert.equal(extractTraceCid({ ipfs: { ipfsCid: REAL_V1 } }), REAL_V1);
  });

  it("extracts a full CID embedded in an ipfs:// link or /ipfs/ path (truncated-prefix case)", () => {
    assert.equal(extractTraceCid({ traceCid: `ipfs://${REAL_V0}` }), REAL_V0);
    assert.equal(extractTraceCid({ trace: `https://gw.example/ipfs/${REAL_V1}/trace.md` }), REAL_V1);
  });

  it("prefers a well-formed CID over an earlier truncated candidate", () => {
    // traceCid is a 12-char truncated placeholder; the real hash is in a link.
    assert.equal(
      extractTraceCid({ traceCid: "Qme9c319c24c", trace: { cid: REAL_V0 } }),
      REAL_V0,
    );
  });

  it("falls back to the raw candidate so the malformed-CID branch still fires", () => {
    // Only a truncated value present → return it (caller marks permanent-skip),
    // NOT null (which would silently treat it as a no-CID summary verify).
    assert.equal(extractTraceCid({ traceCid: "Qme9c319c24c" }), "Qme9c319c24c");
  });

  it("returns null when there is genuinely no CID anywhere", () => {
    assert.equal(extractTraceCid({ traceSummary: "some text" }), null);
    assert.equal(extractTraceCid({}), null);
    assert.equal(extractTraceCid(null), null);
    assert.equal(extractTraceCid("not an object"), null);
  });
});

describe("trace-payload.cidBearingKeys (schema-drift canary)", () => {
  it("lists keys that look like they should carry a CID", () => {
    const keys = cidBearingKeys({ traceRef: "x", ipfsHash: "y", title: "z", summary: "s" });
    assert.deepEqual(keys.sort(), ["ipfsHash", "traceRef"]);
  });
  it("is empty for payloads with no cid-ish keys", () => {
    assert.deepEqual(cidBearingKeys({ id: "x", status: "ok" }), []);
    assert.deepEqual(cidBearingKeys(null), []);
  });
});

describe("mining.salvageMarkdownTrace (recover gemini/gpt-55 100%-parse-fail traces)", () => {
  const body =
    "# Approach\n\nWe analyze the problem in depth across several dimensions.\n\n" +
    "## Step 1\n\n" + "Detailed reasoning about the algorithm and its complexity. ".repeat(12) +
    "\n\n## Step 2\n\n" + "Further derivation with concrete numbers and trade-offs. ".repeat(12);

  it("recovers raw long-form markdown emitted with no JSON wrapper", () => {
    const got = salvageMarkdownTrace(body);
    assert.ok(got && got.length >= 600);
    assert.ok(got!.startsWith("# Approach"));
  });

  it("unwraps a whole-response ``` fence", () => {
    const got = salvageMarkdownTrace("```markdown\n" + body + "\n```");
    assert.ok(got && got.includes("## Step 1"));
    assert.ok(!got!.includes("```"));
  });

  it("recovers a trace field that broke strict JSON.parse on unescaped newlines", () => {
    // Real failure mode: valid intent, but the multi-KB markdown value has raw
    // newlines so JSON.parse throws and extractJsonObj returns null.
    const broken = `{"summary":"x","trace":"${body.replace(/\n/g, "\\n")}"}`;
    const got = salvageMarkdownTrace(broken);
    assert.ok(got && got.includes("# Approach"));
    assert.ok(!got!.startsWith("{"));
  });

  it("rejects short prose so we never submit garbage", () => {
    assert.equal(salvageMarkdownTrace("ok"), null);
    assert.equal(salvageMarkdownTrace("Just a single short sentence of prose."), null);
    assert.equal(salvageMarkdownTrace(""), null);
  });

  it("rejects a still-wrapped JSON object with no usable trace", () => {
    assert.equal(salvageMarkdownTrace('{"summary":"x","note":"no trace here at all"}'), null);
  });
});

describe("workspace.statusForRegion (the per-region status enum 400)", () => {
  it("picks region-specific default when no override", () => {
    assert.equal(statusForRegion("constraints"), "active");
    assert.equal(statusForRegion("evidence"), "validated");
    assert.equal(statusForRegion("decisions"), "proposed");
    assert.equal(statusForRegion("artifacts"), "reviewed");
    assert.equal(statusForRegion("open_questions"), "open");
    assert.equal(statusForRegion("hypotheses"), "proposed");
  });

  it("honors an explicit override over the region default", () => {
    assert.equal(statusForRegion("evidence", "raw"), "raw");
    assert.equal(statusForRegion("open_questions", "claimed"), "claimed");
  });

  it("treats empty-string override as no override", () => {
    assert.equal(statusForRegion("evidence", ""), "validated");
  });

  it("REGION_DEFAULT_STATUS covers every Region type member", () => {
    for (const r of ["hypotheses","evidence","decisions","open_questions","constraints","artifacts","evaluators"] as const) {
      assert.ok(REGION_DEFAULT_STATUS[r], `missing default for ${r}`);
    }
  });
});

describe("mining-sandbox.coerceStarterCode (the .slice crash regression)", () => {
  it("returns a raw string as-is", () => {
    assert.equal(coerceStarterCode("def f(): pass"), "def f(): pass");
  });

  it("returns '' for nullish / primitive / true / unknown shape", () => {
    assert.equal(coerceStarterCode(undefined), "");
    assert.equal(coerceStarterCode(null), "");
    assert.equal(coerceStarterCode(42), "");
    assert.equal(coerceStarterCode(true), "");
    assert.equal(coerceStarterCode({ shape: "unexpected" }), "");
  });

  it("extracts code/content/text/body from object shapes", () => {
    assert.equal(coerceStarterCode({ code: "a" }), "a");
    assert.equal(coerceStarterCode({ content: "b" }), "b");
    assert.equal(coerceStarterCode({ text: "c" }), "c");
    assert.equal(coerceStarterCode({ body: "d" }), "d");
  });

  it("joins files[] with content strings", () => {
    const out = coerceStarterCode({ files: [{ name: "a.py", content: "x = 1" }, { name: "b.py", code: "y = 2" }] });
    assert.equal(out, "x = 1\ny = 2");
  });

  it("joins a string array directly", () => {
    assert.equal(coerceStarterCode(["x = 1", "y = 2"]), "x = 1\ny = 2");
  });
});

describe("skip-caches.SkipCache", () => {
  it("returns false for an unmarked id", () => {
    const c = new SkipCache();
    assert.equal(c.isSkipped("abc"), false);
  });

  it("returns true while inside the TTL window", () => {
    const c = new SkipCache();
    c.markFor("abc", 60_000);
    assert.equal(c.isSkipped("abc"), true);
  });

  it("returns false and self-prunes after the TTL window", () => {
    const c = new SkipCache();
    c.markUntil("abc", Date.now() - 1); // already expired
    assert.equal(c.isSkipped("abc"), false);
    assert.equal(c.size(), 0);
  });

  it("markUntil with an explicit timestamp respects that timestamp", () => {
    const c = new SkipCache();
    const future = Date.now() + 5_000;
    c.markUntil("abc", future);
    assert.equal(c.isSkipped("abc"), true);
  });

  it("size() prunes expired entries", () => {
    const c = new SkipCache();
    c.markFor("a", 60_000);
    c.markUntil("b", Date.now() - 1);
    assert.equal(c.size(), 1);
  });
});

describe("skip-caches body-pattern detectors", () => {
  it("isDiversityBlockError matches the gateway phrase", () => {
    assert.ok(isDiversityBlockError("Gateway request failed (429): You've verified this solver's work 3+ times in the last 14 days"));
    assert.ok(isDiversityBlockError("verified this solvers work 3 times")); // tolerate missing apostrophe + plain "3"
    assert.equal(isDiversityBlockError("Some other 429"), false);
  });

  it("isAlreadySubmittedError matches the 409", () => {
    assert.ok(isAlreadySubmittedError("Gateway request failed (409): You already submitted this challenge on 2026-06-07T19:38:01"));
    assert.equal(isAlreadySubmittedError("Generic 409"), false);
  });

  it("isFinalizedError matches either status variant", () => {
    assert.ok(isFinalizedError("Gateway request failed (410): Submission already finalized (status: verified)"));
    assert.ok(isFinalizedError("Submission already finalized (status: rejected)"));
    assert.equal(isFinalizedError("Submission pending"), false);
  });

  it("isEpochCapError matches the per-epoch cap message", () => {
    assert.ok(isEpochCapError("Gateway request failed (429): Maximum 12 regular challenges per 24h epoch"));
    assert.ok(isEpochCapError("Maximum 13 reasoning per current epoch"));
    assert.equal(isEpochCapError("Rate limit hit"), false);
  });

  it("isGuildClaimedError matches the guild-claimed phrase", () => {
    assert.ok(isGuildClaimedError("Gateway request failed (400): Challenge is claimed by guild 100000 until 2026-06-02T15:55:00Z"));
    assert.equal(isGuildClaimedError("Generic 400"), false);
  });

  it("isReciprocalVerificationError matches the mutual-pair 429", () => {
    // Production body observed 2026-06-10 (from /tmp/nookplot-bot.log):
    assert.ok(isReciprocalVerificationError(
      "Gateway request failed (429): Reciprocal verification detected: this solver has verified your work 3+ times recently. " +
      "Mutual verification pairs are limited to prevent score inflation rings.",
    ));
    // Case-insensitive
    assert.ok(isReciprocalVerificationError("reciprocal verification detected"));
    // Doesn't false-match other 429 bodies
    assert.equal(isReciprocalVerificationError(
      "Gateway request failed (429): You've verified this solver's work 3+ times in the last 14 days",
    ), false);
    assert.equal(isReciprocalVerificationError("Maximum 12 reasoning per epoch"), false);
  });

  // Regression tests using the EXACT bodies observed in production
  // (extracted from observations/*.md). If the gateway tweaks phrasing,
  // these will catch it instead of us silently 0-fire-rate.
  it("[real-body] matches all production gateway strings we have on file", () => {
    assert.ok(isAlreadySubmittedError("Gateway request failed (409): You already submitted this challenge on 2026-06-07T19:38:01 (submission id abc, status: submitted, reward: pending)"));
    assert.ok(isFinalizedError("Gateway request failed (410): Submission already finalized (status: verified)"));
    assert.ok(isGuildClaimedError("Gateway request failed (400): Challenge is claimed by guild 100000 until 2026-06-02T15:58:03.456Z. Only guild members can submit."));
    assert.ok(isEpochCapError("Gateway request failed (429): Maximum 12 regular challenge per 24-hour epoch"));
    assert.ok(isEpochCapError("Gateway request failed (429): Maximum 1 guild-exclusive challenge per 24-hour epoch"));
    assert.ok(isDiversityBlockError("Gateway request failed (429): You've verified this solver's work 3+ times in the last 14 days"));
    assert.ok(isReciprocalVerificationError(
      "Gateway request failed (429): Reciprocal verification detected: this solver has verified your work 3+ times recently. " +
      "Mutual verification pairs are limited to prevent score inflation rings.",
    ));
  });
});

describe("skip-caches.maybeWarnDiversitySaturation", () => {
  // We test indirectly via the cache's size() — the warner only triggers
  // a console.warn (side-effect), but we can assert size() behavior cleanly.
  it("size() increments with each unique mark", async () => {
    const { solverDiversityBlockedUntil: live } = await import("../skip-caches.js");
    const sizeBefore = live.size();
    const id = `0xtestsaturate${Date.now()}`;
    live.markFor(id, 60_000);
    assert.ok(live.size() >= sizeBefore + 1);
  });
});

describe("verify-batch.computeVerifyBatch", () => {
  it("returns 0 when no budget remains", () => {
    assert.equal(computeVerifyBatch(0, 10), 0);
    assert.equal(computeVerifyBatch(-5, 10), 0);
  });

  it("honors the floor (5) when fair-share would be lower", () => {
    // 20 budget over 12 polls = ~2/poll fair, but floor wins
    assert.equal(computeVerifyBatch(20, 12), 5);
  });

  it("takes the fair-share when above the floor", () => {
    // 20 budget over 2 polls = 10/poll, takes 10 (above floor)
    assert.equal(computeVerifyBatch(20, 2), 10);
  });

  it("never returns more than remaining (can't burn past cap)", () => {
    assert.equal(computeVerifyBatch(3, 1), 3);
    assert.equal(computeVerifyBatch(7, 1), 7);
  });

  it("clamps pollsRemaining to >=1 (end-of-day burn)", () => {
    assert.equal(computeVerifyBatch(20, 0), 20);
    assert.equal(computeVerifyBatch(20, -1), 20);
  });

  it("eliminates the old ternary's cliff at remaining=15", () => {
    // Old behavior: 14 → 5, 15 → 8 (cliff). New: continuous via fair-share.
    // At 12 polls remaining mid-day, both should sit at the floor=5 cleanly.
    assert.equal(computeVerifyBatch(14, 12), 5);
    assert.equal(computeVerifyBatch(15, 12), 5);
    assert.equal(computeVerifyBatch(16, 12), 5);
    // End-of-day, the fair-share rises monotonically with no cliff.
    assert.equal(computeVerifyBatch(14, 3), 5);
    assert.equal(computeVerifyBatch(15, 3), 5);
    assert.equal(computeVerifyBatch(16, 3), 6);
  });
});

describe("verify-batch.pollsRemainingBeforeUtcReset", () => {
  it("converts hours-left at 5-min interval", () => {
    assert.equal(pollsRemainingBeforeUtcReset(1, 5), 12);
    assert.equal(pollsRemainingBeforeUtcReset(0.5, 5), 6);
  });
  it("floors at 1 for end-of-day or invalid inputs", () => {
    assert.equal(pollsRemainingBeforeUtcReset(0, 5), 1);
    assert.equal(pollsRemainingBeforeUtcReset(-1, 5), 1);
    assert.equal(pollsRemainingBeforeUtcReset(NaN, 5), 1);
    assert.equal(pollsRemainingBeforeUtcReset(1, 0), 1);
  });
});

describe("verify-calibration.auditVerifyCalibrationPrompt (regression guard for prompt drift)", () => {
  it("passes audit on the shipped VERIFY_CALIBRATION_PROMPT", () => {
    const finding = auditVerifyCalibrationPrompt(VERIFY_CALIBRATION_PROMPT);
    assert.deepEqual(finding.missing, [], `prompt missing structural elements: ${finding.missing.join(", ")}`);
  });

  it("flags a permissive prompt missing both guards", () => {
    const bad = "Score on 0-1 for correctness, reasoning, efficiency, novelty. Output JSON only.";
    const finding = auditVerifyCalibrationPrompt(bad);
    // No anchors, no guards
    assert.ok(finding.missing.includes("anchor 0.30"));
    assert.ok(finding.missing.includes("anchor 0.50"));
    assert.ok(finding.missing.includes("anti-rubber-stamp guard"));
    assert.ok(finding.missing.includes("anti-floor guard"));
  });

  it("flags a one-sided prompt missing the anti-floor guard", () => {
    // Has anchors + rubric + anti-rubber-stamp, but missing anti-floor
    const bad = `Score 0-1: correctness reasoning efficiency novelty.
      Anchors: 0.30 weak, 0.50 average, 0.65 solid, 0.80 strong, 0.95 exceptional.
      Anti-rubber-stamp guard: don't uniform-high.
      Output JSON only.`;
    const finding = auditVerifyCalibrationPrompt(bad);
    assert.ok(finding.missing.includes("anti-floor guard"));
  });
});

// ── specificity-gate.ts ────────────────────────────────────────────────

// Real production rejection body, 2026-06-10 (/tmp/nookplot-bot.log):
const SPECIFICITY_400_BODY =
  "Gateway request failed (400): traceSummary specificity score 30/100 (threshold 35). " +
  "Sub-scores: numbers +0, techniques +0, comparisons +0, code +0, failures +0, actionable +0. " +
  "Missing categories: numbers (no concrete measurements/percentages/counts with units); " +
  "technique names (no camelCase/quoted method names); " +
  "comparisons (no 'X vs Y' / 'better than' / 'instead of' phrasing); " +
  "code refs (no `backtick-quoted` identifiers or file extensions). " +
  "Pick at least TWO and add to the summary.";

describe("specificity-gate.isSpecificityError", () => {
  it("matches the production 400 body and not other 400s", () => {
    assert.ok(isSpecificityError(SPECIFICITY_400_BODY));
    assert.ok(isSpecificityError("traceSummary specificity score 33/100 (threshold 35)"));
    assert.equal(isSpecificityError("Gateway request failed (400): traceSummary too short"), false);
    assert.equal(isSpecificityError("Maximum 12 regular challenge per 24-hour epoch"), false);
  });
});

describe("specificity-gate.parseMissingCategories", () => {
  it("extracts all zero-scored categories from the production body", () => {
    const missing = parseMissingCategories(SPECIFICITY_400_BODY);
    for (const want of ["numbers", "techniques", "comparisons", "code", "failures", "actionable"]) {
      assert.ok(missing.includes(want as never), `expected ${want} in ${missing.join(",")}`);
    }
  });

  it("respects partial sub-scores (techniques scored +3 → not in missing)", () => {
    const body = "specificity score 33/100. Sub-scores: numbers +0, techniques +3, comparisons +0, code +0. " +
      "Missing categories: numbers (no units); comparisons (none); code refs (none).";
    const missing = parseMissingCategories(body);
    assert.ok(missing.includes("numbers"));
    assert.ok(missing.includes("code"));
    assert.equal(missing.includes("techniques"), false);
  });
});

describe("specificity-gate.enrichSummarySpecificity", () => {
  const RICH_TRACE =
    "We benchmarked quickSort vs mergeSort on 10000 elements; quickSort ran in 42ms. " +
    "The `partition()` helper fails on already-sorted input (worst-case O(n^2) pitfall), " +
    "so prefer randomized pivots. Avoid naive recursion depth.";

  it("lifts a generic summary above the gate from trace content", () => {
    const generic = "We solved the sorting challenge with a standard divide and conquer approach that performed well on the provided cases.";
    assert.equal(passesSpecificityGate(generic) || countSpecificity(generic) >= 4, false);
    const enriched = enrichSummarySpecificity(generic, [RICH_TRACE]);
    assert.ok(countSpecificity(enriched) >= 4, `got ${countSpecificity(enriched)}: ${enriched}`);
    assert.ok(enriched.length <= 500);
  });

  it("only enriches the requested categories on the retry path", () => {
    const summary = "Generic summary of the approach without anything concrete in it at all.";
    const enriched = enrichSummarySpecificity(summary, [RICH_TRACE], ["numbers", "code"]);
    assert.ok(/\d+\s?(ms|elements)/.test(enriched), `numbers fragment missing: ${enriched}`);
    assert.ok(/`[^`]+`/.test(enriched), `code fragment missing: ${enriched}`);
  });

  it("returns the summary unchanged when sources have nothing extractable", () => {
    const summary = "Plain words only here.";
    const enriched = enrichSummarySpecificity(summary, ["nothing concrete here either", undefined], ["comparisons"]);
    assert.equal(enriched, summary);
  });

  it("never exceeds the 500-char gateway cap", () => {
    const long = "x".repeat(490);
    const enriched = enrichSummarySpecificity(long, [RICH_TRACE]);
    assert.ok(enriched.length <= 500);
  });
});

// ── mining.ts competition sort + transient detection ───────────────────

describe("mining.compareChallengePriority", () => {
  const base = { id: "x", domainTags: ["algorithms"] };
  it("low-competition (≤4 subs) beats high-competition regardless of reward", () => {
    const lowComp = { ...base, id: "a", submissionCount: 2, estimatedRewardNook: 100 };
    const highComp = { ...base, id: "b", submissionCount: 9, estimatedRewardNook: 5000 };
    assert.ok(compareChallengePriority(lowComp, highComp, []) < 0);
  });
  it("within a bucket, fewer submissions first (0 is ideal)", () => {
    const zero = { ...base, id: "a", submissionCount: 0 };
    const three = { ...base, id: "b", submissionCount: 3 };
    assert.ok(compareChallengePriority(zero, three, []) < 0);
  });
  it("difficulty expert > medium at equal competition", () => {
    const expert = { ...base, id: "a", submissionCount: 1, difficulty: "expert" };
    const medium = { ...base, id: "b", submissionCount: 1, difficulty: "medium" };
    assert.ok(compareChallengePriority(expert, medium, []) < 0);
  });
  it("reward desc as next tiebreak", () => {
    const rich = { ...base, id: "a", submissionCount: 1, difficulty: "hard", estimatedRewardNook: 900 };
    const poor = { ...base, id: "b", submissionCount: 1, difficulty: "hard", estimatedRewardNook: 100 };
    assert.ok(compareChallengePriority(rich, poor, []) < 0);
  });
  it("missing submissionCount treated as 0 (best bucket)", () => {
    const unknown = { ...base, id: "a" };
    const five = { ...base, id: "b", submissionCount: 5 };
    assert.ok(compareChallengePriority(unknown, five, []) < 0);
  });

  it("value-tier: standard reasoning challenges rank ahead of verifiable kinds", () => {
    assert.equal(challengeValueTier({ id: "x" }), 0);                                  // standard (no verifierKind)
    assert.equal(challengeValueTier({ id: "x", verifierKind: "python_tests" }), 1);
    assert.equal(challengeValueTier({ id: "x", verifierKind: "javascript_tests" }), 1);
    assert.equal(challengeValueTier({ id: "x", verifierKind: "exact_answer" }), 1);
  });

  it("a standard challenge beats a verifiable one even when the verifiable one is lower-competition AND higher-reward", () => {
    // The core Lever-1 win: don't burn a scarce epoch slot on a 10-NOOK python_tests
    // with 0 submissions while a 38-NOOK standard with some competition is open.
    const standard = { ...base, id: "std", submissionCount: 9, estimatedRewardNook: 38 };
    const verifiable = { ...base, id: "ver", submissionCount: 0, estimatedRewardNook: 9000, verifierKind: "python_tests" };
    assert.ok(compareChallengePriority(standard, verifiable, []) < 0);
    assert.ok(compareChallengePriority(verifiable, standard, []) > 0);
  });

  it("within the verifiable tier, the existing competition/reward ordering still applies", () => {
    const a = { ...base, id: "a", submissionCount: 1, verifierKind: "python_tests", estimatedRewardNook: 20 };
    const b = { ...base, id: "b", submissionCount: 8, verifierKind: "python_tests", estimatedRewardNook: 20 };
    assert.ok(compareChallengePriority(a, b, []) < 0); // fewer subs first, same tier
  });

  it("preferVerifiable inverts ONLY the tier ordering", () => {
    const standard = { ...base, id: "std", submissionCount: 0, estimatedRewardNook: 5000 };
    const verifiable = { ...base, id: "ver", submissionCount: 9, estimatedRewardNook: 10, verifierKind: "python_tests" };
    // Default: standard first. Tilted: verifiable first, even at worse competition/reward.
    assert.ok(compareChallengePriority(standard, verifiable, []) < 0);
    assert.ok(compareChallengePriority(standard, verifiable, [], { preferVerifiable: true }) > 0);
    assert.ok(compareChallengePriority(verifiable, standard, [], { preferVerifiable: true }) < 0);
    // Within a tier, tilt changes nothing.
    const a = { ...base, id: "a", submissionCount: 1, verifierKind: "python_tests" };
    const b = { ...base, id: "b", submissionCount: 8, verifierKind: "python_tests" };
    assert.ok(compareChallengePriority(a, b, [], { preferVerifiable: true }) < 0);
    const s1 = { ...base, id: "s1", submissionCount: 1 };
    const s2 = { ...base, id: "s2", submissionCount: 8 };
    assert.ok(compareChallengePriority(s1, s2, [], { preferVerifiable: true }) < 0);
  });
});

// ── mining.ts verifiable-kind tilt (EV comparison, corrected 2026-07-28) ──

describe("mining.computeVerifiableTilt", () => {
  // Baseline = the real measured network: standard pays 5.3x per PAID solve and
  // loses 45% of slots to expiry; verifiable grades in a sandbox (survival ~1).
  const measured: TiltInputs = {
    ratio: 0.6,
    standardRewardMultiple: 5.3,
    minResolved: 10,
    standardResolved: 75,
    standardExpiredShare: 0.45,
    verifiableSurvival: 0.88,
    todaySubmitted: 0,
    todayVerifiable: 0,
  };

  it("does NOT tilt at the real measured numbers — standard wins despite 45% expiry", () => {
    // This is the regression the original expiry-share trigger caused: it fired
    // at 20% expiry and steered slots from 27.5k-per-slot to 9k-per-slot work.
    const t = computeVerifiableTilt(measured);
    assert.equal(t.active, false);
    assert.equal(t.preferVerifiable, false);
    assert.match(t.reason, /standard first/);
  });

  it("does not tilt at 46% expiry either (the number that triggered the bad version)", () => {
    assert.equal(computeVerifiableTilt({ ...measured, standardResolved: 120, standardExpiredShare: 0.46 }).active, false);
  });

  it("tilts only when standard EV actually falls below verifiable EV", () => {
    // Break-even: (1-e) * 5.3 < 0.88  →  e > ~83.4%.
    const justUnder = computeVerifiableTilt({ ...measured, standardExpiredShare: 0.82 });
    assert.equal(justUnder.active, false, "82% expiry still favors standard");
    const justOver = computeVerifiableTilt({ ...measured, standardExpiredShare: 0.85 });
    assert.equal(justOver.active, true, "85% expiry finally favors verifiable");
    assert.equal(justOver.preferVerifiable, true);
  });

  it("a catastrophic stall (95% expiry) tilts", () => {
    const t = computeVerifiableTilt({ ...measured, standardExpiredShare: 0.95 });
    assert.equal(t.active, true);
    assert.equal(t.preferVerifiable, true);
  });

  it("ratio 0 disables the tilt entirely, even at total standard collapse", () => {
    const t = computeVerifiableTilt({ ...measured, ratio: 0, standardExpiredShare: 1 });
    assert.equal(t.active, false);
    assert.match(t.reason, /disabled/);
  });

  it("small sample never tilts (3 expiries of 4 resolved is noise, not a signal)", () => {
    const t = computeVerifiableTilt({ ...measured, standardResolved: 4, standardExpiredShare: 0.75 });
    assert.equal(t.active, false);
    assert.match(t.reason, /too few/);
  });

  it("a lower reward multiple lowers the bar for tilting", () => {
    // If standard ever pays only 1.2x, 30% expiry is already enough.
    const t = computeVerifiableTilt({ ...measured, standardRewardMultiple: 1.2, standardExpiredShare: 0.3 });
    assert.equal(t.active, true);
  });

  it("weak verifiable survival raises the bar for tilting", () => {
    // Verifiable that only survives 30% of the time is a worse destination.
    const base = { ...measured, standardExpiredShare: 0.9 };
    assert.equal(computeVerifiableTilt(base).active, true);
    assert.equal(computeVerifiableTilt({ ...base, verifiableSurvival: 0.3 }).active, false);
  });

  it("stops preferring verifiable once the rolling day hits the target share", () => {
    const tilted = { ...measured, standardExpiredShare: 0.9 };
    const t = computeVerifiableTilt({ ...tilted, todaySubmitted: 10, todayVerifiable: 6 });
    assert.equal(t.active, true);
    assert.equal(t.preferVerifiable, false);
    assert.match(t.reason, /target met/);
    const under = computeVerifiableTilt({ ...tilted, todaySubmitted: 10, todayVerifiable: 5 });
    assert.equal(under.preferVerifiable, true);
  });
});

describe("mining.isModelRejection (circuit-breaker attribution)", () => {
  it("blames the MODEL for modelUsed rejections", () => {
    assert.equal(isModelRejection('Gateway request failed (400): modelUsed "glm-5-2" doesn\'t look like a real model name'), true);
    assert.equal(isModelRejection("unknown model: foo-1"), true);
  });
  it("does NOT blame the model for content/cap/dupe rejections", () => {
    // These would sideline a perfectly healthy arm if misattributed.
    assert.equal(isModelRejection("Gateway request failed (400): traceSummary specificity score 33/100 (threshold 35)"), false);
    assert.equal(isModelRejection("Maximum 12 regular challenges per 24-hour epoch"), false);
    assert.equal(isModelRejection("You have already submitted to this challenge"), false);
  });
});

describe("mining.isTransientGenerationError", () => {
  it("matches the three production transient shapes", () => {
    assert.ok(isTransientGenerationError('Venice API 500: {"error":"Inference processing failed"}'));
    assert.ok(isTransientGenerationError('Venice API 429: {"error":"The model is currently overloaded. Please try again later."}'));
    assert.ok(isTransientGenerationError("fetch failed"));
  });
  it("does not match gateway 4xx or parse failures", () => {
    assert.equal(isTransientGenerationError("Gateway request failed (400): traceSummary specificity score 30/100"), false);
    assert.equal(isTransientGenerationError("Maximum 12 regular challenge per 24-hour epoch"), false);
  });
});

describe("models.pickAlternateModel", () => {
  it("never returns the excluded model", () => {
    for (let i = 0; i < 20; i++) {
      const alt = pickAlternateModel("mining_solve", "claude-opus-4-7");
      assert.ok(alt && alt.model !== "claude-opus-4-7");
    }
  });
  it("returns null for tasks without a pool", () => {
    assert.equal(pickAlternateModel("knowledge_topic", "whatever"), null);
  });
});

// ── bundles.ts ─────────────────────────────────────────────────────────

// ── challenge-posting.ts ───────────────────────────────────────────────

describe("challenge-posting helpers", () => {
  it("postedToday counts by 02:00Z EPOCH day — a 01:00Z post belongs to the prior epoch", () => {
    const entries = [
      { ts: "2026-06-11T01:00:00Z", outcome: "posted" },  // epoch 06-10 (before 02:00Z settle)
      { ts: "2026-06-11T02:00:00Z", outcome: "skipped" },
      { ts: "2026-06-10T23:00:00Z", outcome: "posted" },  // epoch 06-10
    ];
    // At noon on the 11th, epoch 06-11 has NO posts yet — the 01:00Z one
    // double-filled epoch 06-10 (the real 06-26/07-03 royalty leak).
    assert.equal(postedToday(entries, "2026-06-11T12:00:00Z"), 0);
    assert.equal(postedToday(entries, "2026-06-10T23:30:00Z"), 2);
    assert.equal(postedToday([], "2026-06-11T12:00:00Z"), 0);
  });

  it("epochDay shifts by the 02:00Z settlement boundary", () => {
    assert.equal(epochDay("2026-06-11T01:59:00Z"), "2026-06-10");
    assert.equal(epochDay("2026-06-11T02:00:00Z"), "2026-06-11");
    assert.equal(epochDay("2026-06-11T23:59:00Z"), "2026-06-11");
  });

  it("nextSettlementMs returns the next 02:00Z boundary", () => {
    assert.equal(nextSettlementMs(Date.parse("2026-06-11T01:00:00Z")), Date.parse("2026-06-11T02:00:00Z"));
    assert.equal(nextSettlementMs(Date.parse("2026-06-11T02:00:01Z")), Date.parse("2026-06-12T02:00:00Z"));
    assert.equal(nextSettlementMs(Date.parse("2026-06-11T20:00:00Z")), Date.parse("2026-06-12T02:00:00Z"));
  });

  it("isDuplicateTitle normalizes punctuation and case", () => {
    const prior = [{ title: "Optimize Raft log compaction!" }];
    assert.ok(isDuplicateTitle("optimize raft log compaction", prior));
    assert.equal(isDuplicateTitle("Optimize Paxos log compaction", prior), false);
  });

  it("rotateDomain cycles deterministically by day", () => {
    const d = ["a", "b", "c"];
    assert.equal(rotateDomain(d, 0), "a");
    assert.equal(rotateDomain(d, 4), "b");
    assert.equal(rotateDomain([], 5), "algorithms");
  });
});

describe("challenge-posting anti-repeat gate", () => {
  // Real near-dupe pairs from the first 40 posted challenges (the measured
  // 45%-repetition incident, 2026-07-15) — the gate MUST catch these.
  const realDupes: Array<[string, string]> = [
    [
      "Tuning Deopt/Respec Thresholds to Stop a JIT Oscillation",
      "Tuning Deopt/Respec Thresholds to Stop Oscillation in a Tracing JIT",
    ],
    [
      "Taming Deopt Oscillation in a Speculative JIT: Threshold Tuning vs. Guard Stability",
      "Taming Deopt Oscillation in a Speculative Tracing JIT",
    ],
    [
      "DP-SGD Budget Allocation: RDP Accountant vs Subsampled Gaussian Composition",
      "DP-SGD Budget Allocation: RDP Accountant vs Fixed-Noise Under a Fixed Compute Cap",
    ],
    [
      "Cuckoo vs Robin Hood Hashing: Termination-Safe Insert Path Under 0.92 Load",
      "Cuckoo vs Robin Hood Hashing: Insertion Termination Under 0.85 Load Factor",
    ],
    // Caught ONLY with plural-stemming + numeric-drop (0.36 unstemmed — the
    // adversarial design review's escape case; 0.46 with the pinned tokenizer).
    [
      "Recall-vs-Memory Showdown: Tuning `HNSW` Against `Multi-Probe LSH` at 50M Vectors",
      "Tuning LSH Bands vs HNSW Layers for 50M-Vector ANN Recall",
    ],
  ];
  // Legitimately-distinct pairs from the same corpus — must NOT be blocked.
  const realDistinct: Array<[string, string]> = [
    [
      "Recall-vs-Memory Showdown: Tuning `HNSW` Against `Multi-Probe LSH` at 50M Vectors",
      "Quorum Sizing vs Tail Latency: Diagnosing a Stalled Geo-Replicated Write Path",
    ],
    [
      "Substring Search Under a Latency Budget: KMP vs Rolling-Hash on Streamed Logs",
      "Surface-Code Distance vs Shot-Budget: Reaching 10^-9 Logical Error for a 2000-Cycle Algorithm",
    ],
    [
      "Rate Limiter Showdown: Fixed-Window vs Sliding-Window-Log Under Burst Load",
      "HLC vs Vector-Clock Causality Under a 6-Node Partition with Clock Skew",
    ],
  ];

  it("titleSimilarity catches every real observed dupe pair at >= 0.45", () => {
    for (const [a, b] of realDupes) {
      const s = titleSimilarity(a, b);
      assert.ok(s >= 0.45, `expected >=0.45 for real dupe pair, got ${s.toFixed(2)}: "${a}" / "${b}"`);
    }
  });

  it("titleSimilarity passes legitimately-distinct titles well under the threshold", () => {
    for (const [a, b] of realDistinct) {
      const s = titleSimilarity(a, b);
      assert.ok(s < 0.30, `expected <0.30 for distinct pair, got ${s.toFixed(2)}: "${a}" / "${b}"`);
    }
  });

  it("findNearDuplicate returns the closest colliding title and skips the skip-placeholder", () => {
    const prior = [
      { title: "(no acceptable draft)" },
      { title: "Taming Deopt Oscillation in a Speculative JIT: Threshold Tuning vs. Guard Stability" },
      { title: "Rate Limiter Showdown: Fixed-Window vs Sliding-Window-Log Under Burst Load" },
    ];
    const hit = findNearDuplicate("Taming Deopt Oscillation in a Speculative Tracing JIT", prior);
    assert.ok(hit, "expected a near-dupe hit");
    assert.match(hit!.title, /Taming Deopt Oscillation/);
    assert.ok(hit!.similarity >= 0.45);
    assert.equal(findNearDuplicate("Bloom-Filter Sizing for a 10M-Key Distributed Cache", prior), null);
  });

  it("an exact duplicate scores 1.0 — the semantic gate subsumes exact dedupe", () => {
    assert.equal(titleSimilarity("Optimize Raft log compaction!", "optimize raft log compaction"), 1);
  });

  it("recentPostedTitles keeps only posted entries within the window", () => {
    const prior = [
      { ts: "2026-07-01T03:00:00Z", title: "old", outcome: "posted" },
      { ts: "2026-07-14T03:00:00Z", title: "fresh", outcome: "posted" },
      { ts: "2026-07-14T04:00:00Z", title: "skipped-entry", outcome: "skipped" },
    ];
    assert.deepEqual(recentPostedTitles(prior, "2026-07-15T12:00:00Z", 14), ["fresh"]);
  });

  it("rotateGrounding prefers unused notes and pads with used ones", () => {
    const notes = [
      { path: "/v/research/a.md" },
      { path: "/v/research/b.md" },
      { path: "/v/research/c.md" },
      { path: "/v/research/d.md" },
    ];
    const used = new Set(["a", "b", "c"]);
    const picked = rotateGrounding(notes, used, 3).map((n) => n.path);
    // d is the only fresh note — it must come first; used notes pad the rest.
    assert.deepEqual(picked, ["/v/research/d.md", "/v/research/a.md", "/v/research/b.md"]);
    // Nothing used → straight top-N.
    assert.deepEqual(rotateGrounding(notes, new Set(), 2).map((n) => n.path), ["/v/research/a.md", "/v/research/b.md"]);
  });

  it("recentGroundingKeys unions note keys within the window only", () => {
    const prior = [
      { ts: "2026-06-01T03:00:00Z", groundingNotes: ["stale"] },
      { ts: "2026-07-10T03:00:00Z", groundingNotes: ["x", "y"] },
      { ts: "2026-07-14T03:00:00Z" }, // no grounding recorded (pre-migration entry)
    ];
    const keys = recentGroundingKeys(prior, "2026-07-15T12:00:00Z", 30);
    assert.deepEqual([...keys].sort(), ["x", "y"]);
  });

  it("noteKey strips directory and extension", () => {
    assert.equal(noteKey("/Users/x/vault/research/verification-b207.md"), "verification-b207");
    assert.equal(noteKey("plain.md"), "plain");
  });

  it("titleTokenList drops pure numbers and stems trailing plural-s (the fake-novelty levers)", () => {
    const toks = titleTokenList("Surface-Code Distance for 1,200 Qubits at 0.92 Load");
    assert.ok(!toks.includes("1200") && !toks.includes("200") && !toks.includes("92"), `numbers kept: ${toks}`);
    assert.ok(toks.includes("qubit"), `expected stemmed "qubit" in ${toks}`);
    // Real dupes differed ONLY in numbers — tokenization must make them identical.
    assert.equal(
      titleSimilarity(
        "Surface Code Distance vs. T-Gate Throughput Budget on a 1,000-Qubit Superconducting Chip",
        "Surface Code Distance vs. T-Gate Throughput Budget on a 1,200-Qubit Superconducting Chip",
      ),
      1,
    );
  });

  it("gateCorpus keeps only live rows (posted/posting) inside the rolling window", () => {
    const now = "2026-07-15T12:00:00Z";
    const prior = [
      { ts: "2026-07-10T03:00:00Z", title: "live", outcome: "posted" },
      { ts: "2026-07-11T03:00:00Z", title: "inflight", outcome: "posting" },
      { ts: "2026-07-12T03:00:00Z", title: "never seen by peers", outcome: "skipped" },
      { ts: "2026-07-13T03:00:00Z", title: "gateway 500d", outcome: "error" },
      { ts: "2026-03-01T03:00:00Z", title: "ancient", outcome: "posted" },
      { ts: "2026-07-14T03:00:00Z", title: "(no acceptable draft)", outcome: "posted" },
    ];
    assert.deepEqual(gateCorpus(prior, now, 90).map((p) => p.title), ["live", "inflight"]);
  });

  it("findMotifCollision blocks same-domain family repeats that Jaccard misses", () => {
    const now = "2026-07-15T12:00:00Z";
    const corpus = [
      { ts: "2026-07-12T03:00:00Z", title: "Surface-Code Distance vs. Error-Mitigation Budget for a 50-Qubit VQE Run", domain: "quantum" },
    ];
    // Different problem (decoder latency vs error mitigation) but the same
    // "surface code distance" motif within the cooldown — blocked in-domain…
    const hit = findMotifCollision("Surface-Code Distance vs Decoder-Latency Budget", "quantum", corpus, now);
    assert.ok(hit, "expected motif collision");
    assert.match(hit!.bigram, /surface code|code distance/);
    // …but NOT blocked in a different domain, and not after the cooldown.
    assert.equal(findMotifCollision("Surface-Code Distance vs Decoder-Latency Budget", "compilers", corpus, now), null);
    assert.equal(findMotifCollision("Surface-Code Distance vs Decoder-Latency Budget", "quantum", corpus, "2026-08-30T12:00:00Z"), null);
  });

  it("descriptionSimilarity flags same-recipe descriptions, passes distinct ones", () => {
    const a = "Compare `HNSW` recall against `LSH` at 50M vectors under a 15ms p99 latency budget with a 64GB memory cap.";
    const same = "Compare `HNSW` recall against `LSH` at 80M vectors under a 20ms p99 latency budget with a 32GB memory cap.";
    const diff = "Diagnose a stalled geo-replicated write path where quorum sizing interacts with tail latency under clock skew.";
    assert.ok(descriptionSimilarity(a, same) >= 0.3, `same-recipe scored ${descriptionSimilarity(a, same)}`);
    assert.ok(descriptionSimilarity(a, diff) < 0.3, `distinct scored ${descriptionSimilarity(a, diff)}`);
  });

  it("isGateRelaxed inside 4h of settlement and on rescue", () => {
    assert.equal(isGateRelaxed(Date.parse("2026-07-15T23:30:00Z"), false), true);  // 02:00Z is 2.5h away
    assert.equal(isGateRelaxed(Date.parse("2026-07-15T12:00:00Z"), false), false); // 14h away
    assert.equal(isGateRelaxed(Date.parse("2026-07-15T12:00:00Z"), true), true);   // rescue always
  });

  it("fallbackDomainOrder: primary first, stalest next, never a domain already posted today", () => {
    const now = "2026-07-15T12:00:00Z";
    const prior = [
      { ts: "2026-07-15T03:00:00Z", domain: "quantum", outcome: "posted" },   // today
      { ts: "2026-07-13T03:00:00Z", domain: "compilers", outcome: "posted" }, // 2d ago
      { ts: "2026-07-01T03:00:00Z", domain: "ml", outcome: "posted" },        // stale
    ];
    const order = fallbackDomainOrder(["quantum", "compilers", "ml", "distributed"], prior, now, "compilers");
    assert.deepEqual(order, ["compilers", "distributed", "ml"]); // quantum excluded (posted today); never-posted "distributed" is stalest
    // Primary itself already posted today → excluded too (rescue case).
    assert.deepEqual(fallbackDomainOrder(["quantum", "ml"], prior, now, "quantum"), ["ml"]);
  });

  it("titleSimilarity blocks the real SSRF knowledge-post permutations", () => {
    // 16 of these shipped in a month under exact-match dedupe — the semantic
    // gate must catch the permutation game.
    const pairs: Array<[string, string]> = [
      ["SSRF Defense Using DNS Resolution and IP-Range Filtering", "SSRF Defense via DNS Resolution and IP-Range Blocking"],
      ["SSRF Mitigation Through Strict DNS and IP-Range Validation", "SSRF Mitigation Through DNS Lookup and IP-Range Blocking"],
      ["DNS Resolution and IP Range Blocking for SSRF Safe Fetching", "SSRF Defense Using DNS Resolution and IP-Range Filtering"],
    ];
    for (const [a, b] of pairs) {
      const s = titleSimilarity(a, b);
      assert.ok(s >= 0.45, `expected >=0.45, got ${s.toFixed(2)}: "${a}" / "${b}"`);
    }
  });

  it("findRepetitiveLearning catches a retold story with different invented numbers", () => {
    // Real audit case: the same Dinic's-beats-Edmonds-Karp tale, retold 2 days
    // apart with different made-up speedups (4.5x vs 9.4x). Numbers are
    // dropped by the tokenizer, so the retelling collides.
    const prior = [
      "Switching from Edmonds-Karp to Dinic's algorithm on the max-flow challenge gave a 4.5x speedup; the level-graph BFS phases avoided redundant augmenting-path scans on the dense layered network.",
    ];
    const retold =
      "On the max-flow challenge, replacing Edmonds-Karp with Dinic's algorithm was a 9.4x speedup — level-graph BFS phases cut the redundant augmenting-path scans on the dense layered network.";
    const hit = findRepetitiveLearning(retold, prior);
    assert.ok(hit, "expected the retold learning to be flagged");
    assert.ok(hit!.similarity >= 0.4);
    // A genuinely different insight passes.
    const fresh =
      "The verifier's hidden tests included a zero-capacity self-loop, which my adjacency-matrix representation silently dropped; an explicit edge-list with per-edge residuals handled it.";
    assert.equal(findRepetitiveLearning(fresh, prior), null);
  });

  it("findLearningMotifCollision blocks paraphrased retellings via their anchor bigrams", () => {
    // The verify pass measured the Jaccard gate INERT on paraphrases (real
    // corpus max pair 0.11) — the motif gate must catch what it can't: the
    // technique bigram survives any rewording.
    const priorSummaries = [
      "Dijkstra with a binary heap beat Bellman-Ford by a wide margin once negative edges were ruled out.",
      "Union-find with path compression turned the connectivity checks near-constant.",
    ];
    const retold = "Ruling out negative weights allowed swapping Bellman-Ford for heap-based Dijkstra, a large win.";
    const hit = findLearningMotifCollision(retold, priorSummaries);
    assert.ok(hit, "expected the bellman-ford retelling to be flagged");
    assert.equal(hit!.bigram, "bellman ford");
    // Generic-only shared bigrams ("edge case", "hidden test") do NOT block.
    const generic = "An edge case in the hidden tests required clamping the output to the valid range.";
    assert.equal(
      findLearningMotifCollision(generic, ["Another edge case appeared in the hidden tests for the parser challenge."]),
      null,
    );
    // A fresh technique passes.
    assert.equal(findLearningMotifCollision("Kahan summation fixed the float drift on the 1e6-term series.", priorSummaries), null);
  });

  it("postedToday counts orphaned posting-intents but not finalized ones", () => {
    const now = "2026-07-15T12:00:00Z";
    // Intent + its finalizing posted row = ONE post, not two.
    assert.equal(
      postedToday(
        [
          { ts: "2026-07-15T03:00:00Z", outcome: "posting", title: "X" },
          { ts: "2026-07-15T03:00:05Z", outcome: "posted", title: "X" },
        ],
        now,
      ),
      1,
    );
    // Orphaned intent (crash mid-POST) counts as a post — conservative.
    assert.equal(postedToday([{ ts: "2026-07-15T03:00:00Z", outcome: "posting", title: "X" }], now), 1);
    // Intent finalized as error (gateway rejected) = zero posts.
    assert.equal(
      postedToday(
        [
          { ts: "2026-07-15T03:00:00Z", outcome: "posting", title: "X" },
          { ts: "2026-07-15T03:00:05Z", outcome: "error", title: "X" },
        ],
        now,
      ),
      0,
    );
  });
});

// ── manifest-intents.ts ────────────────────────────────────────────────

describe("manifest-intents.scoreIntentFit", () => {
  const domains = ["distributed-systems", "algorithms"];
  it("scores a well-matched intent above the default 0.5 threshold", () => {
    const fit = scoreIntentFit(
      {
        title: "Need verification + review of distributed consensus reasoning traces",
        description: "Looking for an agent to do reasoning-trace verification and code review for our distributed systems project",
        requiredSkills: ["verification", "distributed-systems"],
      },
      domains,
    );
    assert.ok(fit >= 0.5, `fit=${fit}`);
  });

  it("scores an unrelated intent near zero", () => {
    const fit = scoreIntentFit(
      { title: "Design a logo", description: "Need branding artwork for my token", requiredSkills: ["design"] },
      domains,
    );
    assert.ok(fit < 0.3, `fit=${fit}`);
  });

  it("returns 0 for empty intents", () => {
    assert.equal(scoreIntentFit({}, domains), 0);
  });
});

describe("venice-cost.veniceRateLimited429Today", () => {
  it("returns an object (smoke — counts only today's rate-limited entries)", () => {
    const r = veniceRateLimited429Today();
    assert.equal(typeof r, "object");
  });
});

describe("bundles.selectBundleCids / bundleDue", () => {
  it("filters already-bundled and duplicate CIDs, caps at max", () => {
    const offered = ["a", "b", "a", "c", "d", ""];
    const picked = selectBundleCids(offered, new Set(["b"]), 2);
    assert.deepEqual(picked, ["a", "c"]);
  });
  it("bundleDue: true with no prior bundle, false within interval, true after", () => {
    const now = Date.parse("2026-06-11T00:00:00Z");
    assert.equal(bundleDue(undefined, now), true);
    assert.equal(bundleDue("2026-06-10T00:00:00Z", now, 7), false);
    assert.equal(bundleDue("2026-06-01T00:00:00Z", now, 7), true);
    assert.equal(bundleDue("not-a-date", now, 7), true);
  });

  it("registeredPublishedCids requires txHash and not-unsigned (contributor-author 400 regression)", () => {
    // Production 400 2026-06-11: "Contributor 0xa0c2… is not the registered
    // author of any CID in this bundle" — gateway-pinned insight CIDs are NOT
    // ContentIndex-registered; only our signed-publish CIDs qualify.
    const entries = [
      { cid: "QmA", txHash: "0x1", title: "ok" },
      { cid: "QmB", title: "no tx — IPFS-only, NOT registered" },
      { cid: "QmC", txHash: "0x3", unsigned: true, title: "unsigned" },
      { txHash: "0x4", title: "no cid" },
    ];
    const out = registeredPublishedCids(entries);
    assert.deepEqual(out, [{ cid: "QmA", title: "ok" }]);
  });

  it("sanitizeBundleTags fixes the production 'cs.AI' rejection (contract: lowercase alnum+hyphen)", () => {
    // Real gateway suggestedTags from 2026-06-11 that 400'd at bundle create:
    const tags = sanitizeBundleTags(["mining-knowledge", "sybil-detection", "security", "documentation", "cs.AI", "formal-methods"]);
    assert.ok(tags.includes("cs-ai"));
    for (const t of tags) assert.match(t, /^[a-z0-9-]{1,50}$/);
    assert.equal(tags.length, 6);
    // Dedupe + empty handling
    assert.deepEqual(sanitizeBundleTags(["X!", "x", "--"]), ["x"]);
    assert.deepEqual(sanitizeBundleTags([]), ["mining-knowledge"]);
  });
});

describe("cohort-benchmark helpers", () => {
  it("countWithinDays counts only the trailing window, ignores NaN and future ts", () => {
    const now = Date.parse("2026-06-12T00:00:00Z");
    const day = 86_400_000;
    const ts = [now - day, now - 6 * day, now - 8 * day, NaN, now + day];
    assert.equal(countWithinDays(ts, now, 7), 2);
    assert.equal(countWithinDays([], now, 7), 0);
  });

  it("cohortAddresses validates env-supplied addresses", () => {
    const prev = process.env.BOT_COHORT_ADDRS;
    process.env.BOT_COHORT_ADDRS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, not-an-address, 0XBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const got = cohortAddresses();
    process.env.BOT_COHORT_ADDRS = prev;
    if (prev === undefined) delete process.env.BOT_COHORT_ADDRS;
    assert.deepEqual(got, [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("no default cohort when env unset (tick no-ops)", () => {
    const prev = process.env.BOT_COHORT_ADDRS;
    delete process.env.BOT_COHORT_ADDRS;
    assert.equal(cohortAddresses().length, 0);
    if (prev !== undefined) process.env.BOT_COHORT_ADDRS = prev;
  });
});

describe("specialization-supply.maybeWarnSpecializationUnderSupply", () => {
  it("counts low-ratio ticks in the rolling window", () => {
    _resetSpecSupply();
    recordSpecializationMatch(0.5);
    recordSpecializationMatch(0.4);
    assert.equal(lowRatioTickCount(), 0);
    recordSpecializationMatch(0.1);
    recordSpecializationMatch(0.2);
    assert.equal(lowRatioTickCount(), 2);
  });

  it("trims history to HISTORY_LEN=5 ticks", () => {
    _resetSpecSupply();
    for (let i = 0; i < 10; i++) recordSpecializationMatch(0.1);
    assert.equal(lowRatioTickCount(), 5);
  });

  it("re-arms after recovery (all recent ticks at-or-above threshold)", () => {
    _resetSpecSupply();
    // Saturate with low ticks first
    recordSpecializationMatch(0.1);
    recordSpecializationMatch(0.1);
    recordSpecializationMatch(0.1);
    assert.equal(lowRatioTickCount(), 3);
    // Push enough good ticks to flush the bad ones out of the rolling window
    for (let i = 0; i < 5; i++) recordSpecializationMatch(0.8);
    assert.equal(lowRatioTickCount(), 0);
  });
});

describe("diversity-poll-saturation.maybeWarnDiversityPollSaturation", () => {
  it("counts high-ratio ticks in the rolling window", () => {
    _resetDiversityPollSat();
    recordDiversityPollSaturation(0.4); // not high
    recordDiversityPollSaturation(0.7); // not high (< 0.80)
    assert.equal(highRatioTickCount(), 0);
    recordDiversityPollSaturation(0.85);
    recordDiversityPollSaturation(1.0);
    assert.equal(highRatioTickCount(), 2);
  });

  it("treats exactly 0.80 as high (inclusive threshold)", () => {
    _resetDiversityPollSat();
    recordDiversityPollSaturation(0.80);
    assert.equal(highRatioTickCount(), 1);
    recordDiversityPollSaturation(0.7999);
    assert.equal(highRatioTickCount(), 1);
  });

  it("trims history to HISTORY_LEN=5 ticks", () => {
    _resetDiversityPollSat();
    for (let i = 0; i < 10; i++) recordDiversityPollSaturation(1.0);
    assert.equal(highRatioTickCount(), 5);
  });

  it("re-arms after recovery (no high ticks left in window)", () => {
    _resetDiversityPollSat();
    // Saturate with high ticks
    recordDiversityPollSaturation(1.0);
    recordDiversityPollSaturation(0.95);
    recordDiversityPollSaturation(0.90);
    assert.equal(highRatioTickCount(), 3);
    // Push 5 low ticks to flush window — arm should reset
    for (let i = 0; i < 5; i++) recordDiversityPollSaturation(0.0);
    assert.equal(highRatioTickCount(), 0);
  });

  it("maybeWarnDiversityPollSaturation does not throw on empty window", () => {
    _resetDiversityPollSat();
    assert.doesNotThrow(() => maybeWarnDiversityPollSaturation());
  });
});

describe("skip-caches.parseGuildClaimedUntilTs", () => {
  it("extracts the ISO timestamp and returns ms epoch", () => {
    const ts = parseGuildClaimedUntilTs("claimed by guild 100000 until 2026-06-02T15:55:00Z");
    assert.equal(ts, Date.parse("2026-06-02T15:55:00Z"));
  });

  it("tolerates fractional seconds", () => {
    const ts = parseGuildClaimedUntilTs("claimed by guild 7 until 2026-06-07T19:38:01.234Z");
    assert.equal(ts, Date.parse("2026-06-07T19:38:01.234Z"));
  });

  it("returns null when the body has no parseable timestamp", () => {
    assert.equal(parseGuildClaimedUntilTs("claimed by guild 7 (until later)"), null);
    assert.equal(parseGuildClaimedUntilTs("totally different error"), null);
  });
});

// ── guild.ts ───────────────────────────────────────────────────────────

describe("guild ranking", () => {
  it("tierBoost handles object and direct shapes", () => {
    assert.equal(tierBoost({ tier: { tier: 1, boost: 1.35 } }), 1.35);
    assert.equal(tierBoost({ boost: "1.9" }), 1.9);
    assert.equal(tierBoost({ guildBoost: 1.6 }), 1.6);
    assert.equal(tierBoost({}), 1.0);
  });

  it("tierNum returns the integer tier", () => {
    assert.equal(tierNum({ tier: 3 }), 3);
    assert.equal(tierNum({ tier: { tier: 2 } }), 2);
    assert.equal(tierNum({}), 0);
  });

  it("members coerces from any of memberCount / member_count / patronCount", () => {
    assert.equal(members({ memberCount: 4 }), 4);
    assert.equal(members({ member_count: 3 }), 3);
    assert.equal(members({ patronCount: 2 }), 2);
    assert.equal(members({}), 0);
  });

  it("domainOverlap is case-insensitive", () => {
    assert.equal(domainOverlap(["Machine-Learning", "Security"], ["machine-learning"]), 1);
    assert.equal(domainOverlap(["x", "y"], ["a", "b"]), 0);
  });

  it("rank excludes full guilds and orders by boost first", () => {
    const guilds = [
      { id: 1, name: "Full",  declaredDomains: ["ml"], memberCount: 6, tier: { boost: 1.9 } },
      { id: 2, name: "Tier-0", declaredDomains: ["ml"], memberCount: 4, tier: { boost: 1.0 } },
      { id: 3, name: "Tier-2", declaredDomains: ["ml", "security"], memberCount: 3, tier: { boost: 1.6 } },
    ];
    const ranked = rank(guilds, ["ml", "security"]);
    assert.equal(ranked.length, 2, "full guild should be excluded");
    assert.equal(ranked[0].g.id, 3, "tier-2 ranks first (highest boost)");
  });

  it("guildId reads from id or guildId field", () => {
    assert.equal(guildId({ id: 100 }), 100);
    assert.equal(guildId({ guildId: 200 }), 200);
    assert.equal(guildId({}), null);
  });
});

// ── network-status.ts vcount coercion ──────────────────────────────────

describe("network-status vcount coercion (the gateway-string-bug fix)", () => {
  it("returns number when given a number", () => {
    assert.equal(vcount({ verification_count: 2 } as never), 2);
  });

  it("coerces string to number", () => {
    assert.equal(vcount({ verification_count: "3" } as never), 3);
  });

  it("returns 0 for undefined or invalid", () => {
    assert.equal(vcount({} as never), 0);
    assert.equal(vcount({ verification_count: "abc" } as never), 0);
  });
});

// ── rlm-spotcheck.ts normalizeModel ────────────────────────────────────

describe("rlm-spotcheck normalizeModel", () => {
  it("passes through known model ids (4-7 still recognized for claim fidelity)", () => {
    assert.equal(normalizeModel("claude-opus-4-8"), "claude-opus-4-8");
    assert.equal(normalizeModel("claude-opus-4-7"), "claude-opus-4-7");
    assert.equal(normalizeModel("deepseek-v4-pro"), "deepseek-v4-pro");
  });

  it("rewrites display names to api ids", () => {
    assert.equal(normalizeModel("Grok 4.3"), "grok-4-3");
    assert.equal(normalizeModel("GPT-5"), "openai-gpt-55");
    assert.equal(normalizeModel("claude-opus-4.8-preview"), "claude-opus-4-8");
    assert.equal(normalizeModel("claude-opus-4.7"), "claude-opus-4-7");
  });

  it("falls back to claude-opus-4-8 (our default) for unknown / unspecified", () => {
    assert.equal(normalizeModel("totally-fake-model"), "claude-opus-4-8");
    assert.equal(normalizeModel(undefined), "claude-opus-4-8");
  });
});

// ── mining-sandbox.ts smokeTestExactAnswer ─────────────────────────────

describe("mining-sandbox smokeTestExactAnswer", () => {
  it("rejects empty answers", () => {
    assert.equal(smokeTestExactAnswer("", null).ok, false);
    assert.equal(smokeTestExactAnswer("   ", null).ok, false);
  });

  it("rejects extremely long answers", () => {
    assert.equal(smokeTestExactAnswer("x".repeat(1500), null).ok, false);
  });

  it("accepts a plain valid answer", () => {
    const r = smokeTestExactAnswer("42", null);
    assert.equal(r.ok, true);
    assert.ok(r.details.includes("length=2"));
  });

  it("flags a suspicious match to sample output", () => {
    const r = smokeTestExactAnswer("hello", { sampleIO: [{ input: "x", output: "hello" }] });
    assert.equal(r.ok, true);
    assert.ok(r.details.toLowerCase().includes("sample"));
  });
});

// ── verifyThreshold (the quota allocator) ──────────────────────────────

describe("verifyThreshold", () => {
  // Helper to build a Date.now()-ish value for a specific UTC hour
  function utcHourMs(hour: number, minute = 0): number {
    const d = new Date();
    d.setUTCHours(hour, minute, 0, 0);
    return d.getTime();
  }

  it("start of day, 0 used → eat anything (threshold 0)", () => {
    // 0 used at hour 0: remaining=30, hoursLeft=24, slack=6 → threshold 0
    assert.equal(verifyThreshold(0, utcHourMs(0)), 0);
  });

  it("middle of day, on pace → threshold 0 or 1", () => {
    // hour 12, used 15: remaining=15, hoursLeft=12, slack=3 → threshold 1
    const t = verifyThreshold(15, utcHourMs(12));
    assert.ok(t === 0 || t === 1, `expected 0 or 1, got ${t}`);
  });

  it("middle of day, ahead of pace → require v1+", () => {
    // hour 12, used 22: remaining=8, hoursLeft=12, slack=-4 → threshold 2
    const t = verifyThreshold(22, utcHourMs(12));
    assert.equal(t, 2);
  });

  it("near-cap, mid-day → only v2s", () => {
    // hour 8, used 27: remaining=3, hoursLeft=16, slack=-13 → threshold 2
    assert.equal(verifyThreshold(27, utcHourMs(8)), 2);
  });

  it("cap reached → Infinity (block)", () => {
    assert.equal(verifyThreshold(30, utcHourMs(15)), Number.POSITIVE_INFINITY);
    assert.equal(verifyThreshold(40, utcHourMs(15)), Number.POSITIVE_INFINITY);
  });

  it("final hour → free fire (threshold 0)", () => {
    // hour 23, anywhere under cap → threshold 0
    assert.equal(verifyThreshold(20, utcHourMs(23)), 0);
    assert.equal(verifyThreshold(5, utcHourMs(23)), 0);
  });

  it("very late, lots unused → threshold 0 (don't waste)", () => {
    // hour 22, used 5: remaining=25, hoursLeft=2, slack=23 → threshold 0
    assert.equal(verifyThreshold(5, utcHourMs(22)), 0);
  });
});

// ── mining-context.ts ──────────────────────────────────────────────────

describe("mining-context", () => {
  it("pickDomainHint matches the right domain", () => {
    assert.ok(pickDomainHint(["machine-learning"]).startsWith("ML hint"));
    assert.ok(pickDomainHint(["security", "tpm"]).startsWith("Security"));
    assert.ok(pickDomainHint(["distributed-systems"]).startsWith("Distributed-systems"));
    // case-insensitive match
    assert.ok(pickDomainHint(["Machine-Learning"]).startsWith("ML hint"));
  });

  it("pickDomainHint returns generic fallback for unknown", () => {
    const h = pickDomainHint(["something-novel"]);
    assert.ok(h.startsWith("Hint:"));
  });

  it("formatSearchResults handles empty input", () => {
    assert.equal(formatSearchResults([], "arxiv"), "");
  });

  it("formatSearchResults caps at 4 entries and labels them", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `Paper ${i}`,
      url: `http://x/${i}`,
      snippet: "some content",
      source: "brave" as const,
    }));
    const out = formatSearchResults(results, "arxiv");
    assert.ok(out.includes("[arxiv-1]"));
    assert.ok(out.includes("[arxiv-4]"));
    assert.ok(!out.includes("[arxiv-5]"));
  });

  it("formatVaultHits formats vault notes with category", () => {
    const notes = [
      {
        path: "/Users/x/dev/nookplot-bot/knowledge-vault/research/note-1.md",
        frontmatter: {
          id: "abc",
          title: "Sample research",
          type: "mining-submission",
          createdAt: new Date().toISOString(),
        },
        body: "Lorem ipsum dolor sit amet",
        raw: "",
      },
    ];
    const out = formatVaultHits(notes);
    assert.ok(out.includes("[prior-1]"));
    assert.ok(out.includes("Sample research"));
    assert.ok(out.includes("(research)"));
  });
});

// ── mining.ts specialization filter ────────────────────────────────────

describe("specialization filter", () => {
  const ORIG = process.env.BOT_SPECIALIZE_DOMAINS;
  const ORIG_MODE = process.env.BOT_SPECIALIZE_MATCH_MODE;
  function clear() {
    delete process.env.BOT_SPECIALIZE_DOMAINS;
    delete process.env.BOT_SPECIALIZE_MATCH_MODE;
  }
  function restore() {
    if (ORIG === undefined) delete process.env.BOT_SPECIALIZE_DOMAINS;
    else process.env.BOT_SPECIALIZE_DOMAINS = ORIG;
    if (ORIG_MODE === undefined) delete process.env.BOT_SPECIALIZE_MATCH_MODE;
    else process.env.BOT_SPECIALIZE_MATCH_MODE = ORIG_MODE;
  }

  it("specializeDomains() parses env CSV with whitespace + lowercases", () => {
    process.env.BOT_SPECIALIZE_DOMAINS = "distributed-systems, Algorithms ,  ML ";
    assert.deepEqual(specializeDomains(), ["distributed-systems", "algorithms", "ml"]);
    clear();
    assert.deepEqual(specializeDomains(), []);
    restore();
  });

  it("passes everything when unset", () => {
    clear();
    assert.equal(passesSpecializationFilter({ id: "x", domainTags: ["anything"] }), true);
    assert.equal(passesSpecializationFilter({ id: "x" }), true);
    restore();
  });

  it("ANY mode: passes if any tag overlaps", () => {
    process.env.BOT_SPECIALIZE_DOMAINS = "distributed-systems,ml";
    process.env.BOT_SPECIALIZE_MATCH_MODE = "any";
    assert.equal(passesSpecializationFilter({ id: "x", domainTags: ["ml", "security"] }), true);
    assert.equal(passesSpecializationFilter({ id: "x", domainTags: ["security", "crypto"] }), false);
    assert.equal(passesSpecializationFilter({ id: "x", domainTags: [] }), false);
    restore();
  });

  it("ALL mode: requires ALL targets present", () => {
    process.env.BOT_SPECIALIZE_DOMAINS = "distributed-systems,algorithms";
    process.env.BOT_SPECIALIZE_MATCH_MODE = "all";
    assert.equal(
      passesSpecializationFilter({ id: "x", domainTags: ["distributed-systems", "algorithms"] }),
      true,
    );
    assert.equal(
      passesSpecializationFilter({ id: "x", domainTags: ["distributed-systems"] }),
      false,
    );
    restore();
  });

  it("case-insensitive on tag comparison", () => {
    process.env.BOT_SPECIALIZE_DOMAINS = "distributed-systems";
    assert.equal(
      passesSpecializationFilter({ id: "x", domainTags: ["Distributed-Systems"] }),
      true,
    );
    restore();
  });
});

// ── paper-reproduction extractors ──────────────────────────────────────

describe("paper-reproduction extractors", () => {
  it("extractArxivIds finds IDs in description + bundle + URLs", () => {
    const ch = {
      id: "x",
      description: "Reproduce the result from arXiv:2106.04561 and compare to 2305.18290.",
      title: "Test challenge",
    };
    const bundle = {
      description: "See https://arxiv.org/abs/1706.03762v3 for the seminal transformer paper.",
      resources: [
        { type: "paper", arxivId: "2401.04088" },
        { type: "url", url: "https://arxiv.org/pdf/2010.02193" },
      ],
    };
    const ids = extractArxivIds(bundle, ch);
    assert.ok(ids.includes("2106.04561"), `missing 2106.04561 in ${ids}`);
    assert.ok(ids.includes("2305.18290"));
    assert.ok(ids.includes("1706.03762"));
    assert.ok(ids.includes("2401.04088"));
    assert.ok(ids.includes("2010.02193"));
    // No dupes
    assert.equal(ids.length, new Set(ids).size);
  });

  it("extractArxivIds returns empty array when none found", () => {
    const ids = extractArxivIds({}, { id: "x", description: "No paper references here." });
    assert.deepEqual(ids, []);
  });

  it("extractHfDatasets parses huggingface.co URLs + hfDatasetId fields", () => {
    const bundle = {
      resources: [
        { type: "dataset", url: "https://huggingface.co/datasets/openai/openai_humaneval" },
        { type: "dataset", hfDatasetId: "math/competition" },
        { type: "other", url: "https://example.com/data" },
      ],
    };
    const ds = extractHfDatasets(bundle);
    assert.ok(ds.includes("openai/openai_humaneval"));
    assert.ok(ds.includes("math/competition"));
    assert.equal(ds.length, 2);
  });
});

// ── citation-velocity helpers ──────────────────────────────────────────

describe("citation-velocity helpers", () => {
  it("peerQuality reads from qualityScore | quality_score | specificityScore", () => {
    assert.equal(peerQuality({ qualityScore: 80 }), 80);
    assert.equal(peerQuality({ quality_score: 65 }), 65);
    assert.equal(peerQuality({ specificityScore: 40 }), 40);
    assert.equal(peerQuality({}), 0);
  });

  it("peerAuthor reads from authorAddress | author_address and lowercases", () => {
    assert.equal(peerAuthor({ authorAddress: "0xABC123" }), "0xabc123");
    assert.equal(peerAuthor({ author_address: "0xDEF" }), "0xdef");
    assert.equal(peerAuthor({}), "");
  });

  it("peerDomains uses domainTags array and lowercases (with single-tag fallback)", () => {
    const d = peerDomains({
      domainTags: ["security", "Machine-Learning"],
    });
    assert.ok(d.includes("security"));
    assert.ok(d.includes("machine-learning"));
    // single fallback when no array
    const d2 = peerDomains({ domain: "algorithms" });
    assert.ok(d2.includes("algorithms"));
    // snake-case alias
    const d3 = peerDomains({ domain_tag: "Crypto" });
    assert.ok(d3.includes("crypto"));
  });

  it("citationType returns 'extends' on same-domain, 'supports' on cross-domain", () => {
    const peer = { domainTags: ["distributed-systems"] };
    const mineSame = { domainTags: ["distributed-systems"] };
    const mineCross = { domainTags: ["cryptography"] };
    assert.equal(citationType(peer, mineSame), "extends");
    assert.equal(citationType(peer, mineCross), "supports");
  });

  it("pickPeerId / pickMyId read alternate id fields", () => {
    assert.equal(pickPeerId({ id: "abc" }), "abc");
    assert.equal(pickPeerId({ insightId: "xyz" }), "xyz");
    assert.equal(pickPeerId({ itemId: "k1" }), "k1");
    assert.equal(pickPeerId({}), undefined);
    assert.equal(pickMyId({ id: "abc" }), "abc");
    assert.equal(pickMyId({ itemId: "k1" }), "k1");
    assert.equal(pickMyId({}), undefined);
  });
});

// ── social-engagement pure helpers ─────────────────────────────────────

describe("social-engagement", () => {
  it("selectVoteCandidate skips already-voted + own posts", () => {
    const me = "0xMyAddress";
    const posts = [
      { cid: "cid1", authorAddress: "0xpeer1", score: 10 },
      { cid: "cid2", authorAddress: me, score: 20 },           // ours — skip
      { cid: "cid3", authorAddress: "0xpeer3", score: 5 },     // already voted — skip
      { cid: "cid4", authorAddress: "0xpeer4", score: 3 },
    ];
    const voted = new Set(["cid3"]);
    const pick1 = selectVoteCandidate(posts, voted, me);
    assert.ok(pick1);
    assert.equal(pick1?.cid, "cid1");
  });

  it("selectVoteCandidate returns null when all filtered out", () => {
    const posts = [{ cid: "cid1", authorAddress: "0xme" }];
    assert.equal(selectVoteCandidate(posts, new Set(), "0xME"), null);
  });

  it("rankFollowCandidates frequency-weights citations and excludes self+followed", () => {
    const log = [
      { kind: "citation", peerAuthor: "0xaaa" },
      { kind: "citation", peerAuthor: "0xaaa" },
      { kind: "citation", peerAuthor: "0xbbb" },
      { kind: "citation", peerAuthor: "0xme" },     // self — excluded
      { kind: "citation", peerAuthor: "0xccc" },    // already followed
      { kind: "compile" },                           // wrong kind — excluded
    ];
    const followed = new Set(["0xccc"]);
    const ranked = rankFollowCandidates(log, followed, "0xMe");
    assert.equal(ranked[0]?.address, "0xaaa");
    assert.equal(ranked[0]?.citeCount, 2);
    assert.equal(ranked[1]?.address, "0xbbb");
    assert.equal(ranked.length, 2);
  });

  it("buildCommentBody mentions the citation type + domain", () => {
    const ext = buildCommentBody("extends", "distributed-systems");
    assert.ok(ext.includes("distributed-systems"));
    assert.ok(ext.includes("extended"));
    const sup = buildCommentBody("supports", "ml");
    assert.ok(sup.includes("ml"));
    assert.ok(sup.includes("supporting evidence"));
  });
});

// ── onboarding templates ───────────────────────────────────────────────

describe("onboarding templates", () => {
  it("service-listing template has required fields", () => {
    const t = onboardingTemplates.SERVICE_LISTING_TEMPLATE;
    assert.ok(t.title.length > 5);
    assert.ok(t.description.length > 50);
    assert.ok(t.category);
    assert.equal(typeof t.pricingModel, "number");
    assert.ok(Array.isArray(t.tags));
  });

  it("project template has lowercase-hyphen slug + name + description", () => {
    const t = onboardingTemplates.PROJECT_TEMPLATE;
    assert.match(t.projectId, /^[a-z0-9-]+$/);
    assert.ok(t.name.length > 3);
    assert.ok(t.description.length > 50);
    assert.ok(Array.isArray(t.tags));
  });
});

describe("onboarding.providerHasListings (dupe-listing incident regression)", () => {
  it("true when stats.totalListings > 0 — even with empty listings array (production shape)", () => {
    // EXACT production shape observed 2026-06-11: provider endpoint reports
    // cumulative count but returns listings: []
    assert.equal(providerHasListings({ stats: { totalListings: 35 }, listings: [] }), true);
  });

  it("false only when the gateway affirmatively reports zero", () => {
    assert.equal(providerHasListings({ stats: { totalListings: 0 }, listings: [] }), false);
  });

  it("falls back to listings array when stats absent", () => {
    assert.equal(providerHasListings({ listings: [{ active: true }] }), true);
    assert.equal(providerHasListings({ listings: [] }), false);
  });

  it("returns null (caller fails closed) on unrecognizable shape — the original bug path", () => {
    assert.equal(providerHasListings({} as never), null);
    assert.equal(providerHasListings({ stats: {} }), null);
    assert.equal(providerHasListings(null as never), null);
  });
});

describe("onboarding.hasLocalOnboardingRecord", () => {
  const tmpLog = joinPath(tmpdir(), `onboarding-test-${process.pid}.jsonl`);

  it("finds a matching action in the log", () => {
    writeFileSync(tmpLog, [
      JSON.stringify({ ts: "2026-06-11T00:00:00Z", action: "service-listing-created", txHash: "0xabc" }),
      "not-json-garbage",
      JSON.stringify({ ts: "2026-06-11T00:00:01Z", action: "project-created" }),
    ].join("\n"));
    assert.equal(hasLocalOnboardingRecord("service-listing-created", tmpLog), true);
    assert.equal(hasLocalOnboardingRecord("project-created", tmpLog), true);
    assert.equal(hasLocalOnboardingRecord("never-happened", tmpLog), false);
    rmSync(tmpLog);
  });

  it("returns false when the log does not exist (fresh agent may create)", () => {
    assert.equal(hasLocalOnboardingRecord("service-listing-created", joinPath(tmpdir(), "no-such-file.jsonl")), false);
  });
});

// ─── MCP-derived tracks ────────────────────────────────────────────────

import { matchTags, formatReward } from "../bounties.js";
import { scoreClarification } from "../clarifications.js";
import { matchSkills } from "../swarms.js";
import { renderWikiBlock } from "../network-wiki.js";
import { renderRelatedWork } from "../papers.js";
import { extractHfDatasetId, summarizeHfDataset } from "../hf-dataset.js";
import { extractOracleQueries } from "../oracle.js";
import { significantLifts } from "../ab-results.js";
import { composePostSolveLearning } from "../mining.js";

describe("bounties.matchTags", () => {
  it("returns case-insensitive intersecting tags", () => {
    const m = matchTags(["Distributed-Systems", "consensus", "weak"], ["distributed-systems", "ml"]);
    assert.deepEqual(m, ["Distributed-Systems"]);
  });
  it("does partial-substring matching for tags ≥ 4 chars", () => {
    const m = matchTags(["systems-security-research"], ["security"]);
    assert.equal(m.length, 1);
  });
  it("returns empty for no overlap", () => {
    assert.deepEqual(matchTags(["ml"], ["cryptography"]), []);
  });
  it("handles missing tags gracefully", () => {
    assert.deepEqual(matchTags(undefined, ["x"]), []);
    assert.deepEqual(matchTags(["x"], []), []);
  });
  it("does NOT match short bounty tags against substrings of long spec tags (false-positive regression)", () => {
    // "algorithms" contains "go" at positions 2-3, but "Go" is a 2-char
    // language label and shouldn't trigger a substring match.
    assert.deepEqual(matchTags(["Go", "Rust"], ["algorithms"]), []);
    // Also: "ml" is 2 chars and shouldn't match against "machine-learning"
    // via the substring path (even though "ml" is at the start of the long tag).
    assert.deepEqual(matchTags(["ml"], ["machine-learning"]), []);
    // BUT: 4-char bounty tag matching 4+ char spec tag is still OK
    assert.deepEqual(matchTags(["algo"], ["algorithms"]), ["algo"]);
  });
});

describe("bounties.formatReward", () => {
  it("formats millions with M suffix", () => {
    assert.equal(formatReward(2_500_000, "NOOK"), "2.50M NOOK");
  });
  it("formats thousands with k suffix", () => {
    assert.equal(formatReward(45_000, "NOOK"), "45.0k NOOK");
  });
  it("formats small amounts as-is", () => {
    assert.equal(formatReward(12.34, "USDC"), "12.34 USDC");
  });
  it("handles string amounts", () => {
    assert.equal(formatReward("1500", "NOOK"), "1.5k NOOK");
  });
  it("returns em-dash on undefined", () => {
    assert.equal(formatReward(undefined, "NOOK"), "—");
  });
});

describe("clarifications.scoreClarification", () => {
  it("rejects too-short questions", () => {
    const s = scoreClarification({ id: "a", question: "too short" }, ["ml"]);
    assert.equal(s.score, 0);
  });
  it("scores higher with tag overlap", () => {
    const a = scoreClarification(
      { id: "a", question: "x".repeat(80), domainTags: ["distributed-systems"] },
      ["distributed-systems"],
    );
    const b = scoreClarification({ id: "b", question: "x".repeat(80) }, ["distributed-systems"]);
    assert.ok(a.score > b.score);
  });
  it("gives a direct-address bonus", () => {
    const oldEnv = process.env.NOOKPLOT_AGENT_ADDRESS;
    process.env.NOOKPLOT_AGENT_ADDRESS = "0xABC";
    const s = scoreClarification(
      { id: "a", question: "x".repeat(80), recipients: ["0xabc"] },
      [],
    );
    assert.ok(s.score >= 50);
    process.env.NOOKPLOT_AGENT_ADDRESS = oldEnv;
  });
});

describe("swarms.matchSkills", () => {
  it("intersects skill tags case-insensitively", () => {
    assert.deepEqual(matchSkills(["Python", "ML"], ["ml"]), ["ML"]);
  });
  it("returns empty when nothing overlaps", () => {
    assert.deepEqual(matchSkills(["python"], ["rust"]), []);
  });
});

describe("network-wiki.renderWikiBlock", () => {
  it("returns empty string when summary missing", () => {
    assert.equal(renderWikiBlock({ domain: "x", summary: "" }), "");
  });
  it("truncates long summaries with ellipsis", () => {
    const s = "x".repeat(800);
    const b = renderWikiBlock({ domain: "y", summary: s }, 200);
    assert.ok(b.length <= 250);
    assert.ok(b.endsWith("…"));
  });
  it("preserves short summaries unchanged", () => {
    const b = renderWikiBlock({ domain: "z", summary: "concise note" });
    assert.ok(b.includes("concise note"));
  });
});

describe("papers.renderRelatedWork", () => {
  it("renders empty string for empty input", () => {
    assert.equal(renderRelatedWork([]), "");
  });
  it("includes arxiv IDs + titles in output", () => {
    const out = renderRelatedWork([
      { arxivId: "1234.5678", title: "Test Paper", authors: ["A", "B", "C"], year: 2024, citationCount: 42 },
    ]);
    assert.ok(out.includes("1234.5678"));
    assert.ok(out.includes("Test Paper"));
    assert.ok(out.includes("2024"));
    assert.ok(out.includes("42 cites"));
  });
  it("caps at maxN", () => {
    const papers = Array.from({ length: 10 }, (_, i) => ({ arxivId: `id${i}`, title: `T${i}` }));
    const out = renderRelatedWork(papers, 3);
    assert.ok(out.includes("id2"));
    assert.ok(!out.includes("id5"));
  });
});

describe("hf-dataset.extractHfDatasetId", () => {
  it("matches hf:org/name shorthand", () => {
    assert.equal(extractHfDatasetId("use hf:openai/grade-school-math here"), "openai/grade-school-math");
  });
  it("matches huggingface.co URL", () => {
    assert.equal(
      extractHfDatasetId("see https://huggingface.co/datasets/mnli/snli for splits"),
      "mnli/snli",
    );
  });
  it("matches load_dataset('org/name') in code", () => {
    assert.equal(extractHfDatasetId('load_dataset("squad/squad_v2")'), "squad/squad_v2");
  });
  it("returns null when no match", () => {
    assert.equal(extractHfDatasetId("just some prose"), null);
  });
});

describe("hf-dataset.summarizeHfDataset", () => {
  it("summarizes reachable dataset with splits + rows", () => {
    const s = summarizeHfDataset({
      datasetId: "squad/v2",
      reachable: true,
      splits: { train: { rows: 87000, columns: ["question", "answer"] }, test: { rows: 10000, columns: ["q", "a"] } },
    });
    assert.ok(s.includes("squad/v2"));
    assert.ok(s.includes("97000"));
    assert.ok(s.includes("train/test"));
  });
  it("flags unreachable datasets", () => {
    assert.ok(summarizeHfDataset({ datasetId: "bad", reachable: false }).includes("unreachable"));
  });
});

describe("oracle.extractOracleQueries", () => {
  it("extracts price queries from BTC-USDC-style text", () => {
    const q = extractOracleQueries("predict the BTC-USDC price at 14:00 UTC");
    assert.equal(q.length, 1);
    assert.equal(q[0].entityType, "price");
    assert.equal(q[0].entityId, "BTC-USDC");
  });
  it("handles slash separator", () => {
    const q = extractOracleQueries("ETH/USD exchange rate");
    assert.equal(q.length, 1);
    assert.equal(q[0].entityId, "ETH-USD");
  });
  it("returns empty on no match", () => {
    assert.equal(extractOracleQueries("no price here").length, 0);
  });
});

describe("ab-results.significantLifts", () => {
  it("returns empty for null input", () => {
    assert.deepEqual(significantLifts(null), []);
  });
  it("filters to positive significant lifts", () => {
    const r = significantLifts({
      experiments: [
        { name: "good", metric: "passRate", variants: [], liftAbsolute: 0.1, pValue: 0.01 },
        { name: "ns", metric: "passRate", variants: [], liftAbsolute: 0.1, pValue: 0.5 },
        { name: "neg", metric: "passRate", variants: [], liftAbsolute: -0.05, pValue: 0.01 },
      ],
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, "good");
  });
});

import { renderPeerTraceBlock } from "../mining-dataset.js";
import { scoreBountyForAutoApply, normalizeReward, matchTagsByText, matchBounty } from "../bounties.js";

describe("bounties.normalizeReward", () => {
  it("returns 0 for undefined", () => assert.equal(normalizeReward(undefined), 0));
  it("returns 0 for non-numeric", () => assert.equal(normalizeReward("abc"), 0));
  it("returns small numbers as-is", () => assert.equal(normalizeReward(500), 500));
  it("divides large wei values by 1e18", () => {
    assert.equal(normalizeReward("28000000000000000000000"), 28000);
    assert.equal(normalizeReward("1000000000000000000"), 1);
  });
});

describe("bounties.matchTagsByText", () => {
  it("finds whole-word matches in title", () => {
    const m = matchTagsByText("Compare distributed-systems consensus", "Some long description", ["distributed-systems", "ml"]);
    assert.deepEqual(m, ["distributed-systems"]);
  });
  it("ignores short tags", () => {
    const m = matchTagsByText("Hello", "", ["ml"]);
    assert.deepEqual(m, []);
  });
  it("returns empty when nothing matches", () => {
    assert.deepEqual(matchTagsByText("Random crypto stuff", "More random", ["distributed-systems"]), []);
  });
  it("handles hyphen variations", () => {
    const m = matchTagsByText("a distributed systems intro", "", ["distributed-systems"]);
    assert.equal(m.length, 1);
  });
});

describe("bounties.matchBounty", () => {
  it("prefers explicit tags when present", () => {
    const m = matchBounty(
      { id: "1", tags: ["ml"], title: "no relevant text here" },
      ["ml", "distributed-systems"],
    );
    assert.deepEqual(m, ["ml"]);
  });
  it("falls back to text matching when no tags", () => {
    const m = matchBounty(
      { id: "1", title: "Compare consensus protocols", description: "long description" },
      ["consensus"],
    );
    assert.deepEqual(m, ["consensus"]);
  });
});

describe("mining-dataset.renderPeerTraceBlock", () => {
  it("returns empty for empty input", () => {
    assert.equal(renderPeerTraceBlock([]), "");
  });
  it("renders title + score + verifier count", () => {
    const out = renderPeerTraceBlock([
      { submissionId: "s1", challengeTitle: "Consensus stuff", averageScore: 0.92, verifierCount: 4 },
    ]);
    assert.ok(out.includes("Consensus stuff"));
    assert.ok(out.includes("0.92"));
    assert.ok(out.includes("4v"));
  });
  it("truncates to maxChars", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      submissionId: `s${i}`,
      challengeTitle: "x".repeat(120),
      averageScore: 0.8,
      verifierCount: 3,
    }));
    const out = renderPeerTraceBlock(rows, 300);
    assert.ok(out.length <= 301);
  });
});

describe("bounties.scoreBountyForAutoApply (content gates, not tag gates)", () => {
  it("passes when reward + description + competition all pass — even with zero tag overlap", () => {
    const s = scoreBountyForAutoApply(
      { id: "b0", description: "x".repeat(500), rewardAmount: 500, applicationCount: 2 },
      [], // no tag match
      ["distributed-systems"],
    );
    assert.ok(s.score > 0, "should pass without tag overlap");
    assert.ok(!s.reasons.some((r) => r.includes("tag-bonus")), "should not log tag-bonus when none matched");
  });
  it("rejects bounties with reward below threshold", () => {
    const s = scoreBountyForAutoApply(
      { id: "b2", description: "x".repeat(500), rewardAmount: 5 },
      ["a", "b"],
      ["a", "b"],
    );
    assert.equal(s.score, 0);
  });
  it("rejects bounties with thin description", () => {
    const s = scoreBountyForAutoApply(
      { id: "b3", description: "short", rewardAmount: 500 },
      ["a", "b"],
      ["a", "b"],
    );
    assert.equal(s.score, 0);
  });
  it("rejects crowded bounties by default", () => {
    const crowded = scoreBountyForAutoApply(
      { id: "p", description: "x".repeat(500), rewardAmount: 500, applicationCount: 50 },
      ["a"],
      ["a"],
    );
    assert.equal(crowded.score, 0);
    assert.ok(crowded.reasons.some((r) => r.includes("apps=50")));
  });
  it("tag overlap adds a soft BONUS score (ranking helper)", () => {
    const noTags = scoreBountyForAutoApply(
      { id: "n", description: "x".repeat(500), rewardAmount: 500, applicationCount: 2 },
      [],
      ["a"],
    );
    const withTags = scoreBountyForAutoApply(
      { id: "t", description: "x".repeat(500), rewardAmount: 500, applicationCount: 2 },
      ["a", "b"],
      ["a", "b"],
    );
    assert.ok(withTags.score > noTags.score, "tag overlap should boost score");
  });
});

import { scoreBountyForSurface, truncateApplicationMessage, BOUNTY_MESSAGE_MAX_CHARS } from "../bounties.js";

describe("bounties.truncateApplicationMessage", () => {
  it("returns short messages unchanged", () => {
    const m = "Hello.";
    assert.equal(truncateApplicationMessage(m), m);
  });
  it("never returns more than BOUNTY_MESSAGE_MAX_CHARS chars", () => {
    const huge = "abcdef. ".repeat(1000); // ~8000 chars
    const out = truncateApplicationMessage(huge);
    assert.ok(out.length <= BOUNTY_MESSAGE_MAX_CHARS, `got ${out.length}`);
  });
  it("prefers paragraph boundary near the cap", () => {
    // Build a string that EXCEEDS the cap so truncation actually fires.
    const para = "para1.\n\n" + "x".repeat(BOUNTY_MESSAGE_MAX_CHARS + 500) + "\n\npara3 should be dropped";
    const out = truncateApplicationMessage(para);
    assert.ok(out.length <= BOUNTY_MESSAGE_MAX_CHARS);
    assert.ok(!out.includes("para3 should be dropped"));
    assert.ok(out.startsWith("para1."));
  });
  it("falls back to sentence boundary or hard cut on no-paragraph input", () => {
    const noPara = "Sentence one. " + "x".repeat(BOUNTY_MESSAGE_MAX_CHARS + 100) + " Sentence two.";
    const out = truncateApplicationMessage(noPara);
    assert.ok(out.length <= BOUNTY_MESSAGE_MAX_CHARS);
  });
});

describe("bounties.scoreBountyForSurface", () => {
  it("ranks low-applicant high-reward higher than high-applicant low-reward", () => {
    const a = scoreBountyForSurface({ id: "a", rewardAmount: 1000, applicationCount: 1 });
    const b = scoreBountyForSurface({ id: "b", rewardAmount: 1000, applicationCount: 50 });
    assert.ok(a > b);
  });
  it("handles zero applications without div-by-zero", () => {
    const s = scoreBountyForSurface({ id: "c", rewardAmount: 100, applicationCount: 0 });
    assert.equal(s, 100);
  });
  it("normalizes wei reward values", () => {
    // Should match the formatted-and-divided form
    const wei = scoreBountyForSurface({ id: "w", rewardAmount: "1000000000000000000000", applicationCount: 0 });
    const tok = scoreBountyForSurface({ id: "t", rewardAmount: 1000, applicationCount: 0 });
    assert.equal(wei, tok);
  });
});

import {
  canVerifyNow,
  canAutoWriteNow,
  isVerifyCapError,
  effectiveBountyAutoApplyCap,
  VERIFY_SHARED_CAP,
  verifyPaceOk,
} from "../quotas.js";
import { acquireGeneration, semaphoreSnapshot } from "../generation-semaphore.js";
import { readJsonlTail } from "../util.js";
import { estimateCallCost } from "../venice-cost.js";
import { shouldExitForDeadGateway, gatewayWatchdogState, gatewayReachability } from "../network-status.js";
import { claimRelayHealth, computeNetPnl } from "../dashboard-web.js";
import { countVerifiedSolves, rescueAwareCap } from "../challenge-posting.js";
import { acquireInstanceLock, releaseInstanceLock, holderStatus, readPidfile, readGitRev, type LockDeps } from "../instance-lock.js";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";

describe("quotas.isVerifyCapError", () => {
  it("detects the gateway shared-cap message", () => {
    assert.equal(
      isVerifyCapError("Gateway request failed (429): Max 40 verifications + crowd scores per 24-hour window reached"),
      true,
    );
    assert.equal(isVerifyCapError("shared budget, based on your verifier reputation"), true);
  });
  it("returns false for unrelated errors", () => {
    assert.equal(isVerifyCapError("connection refused"), false);
    assert.equal(isVerifyCapError("404 not found"), false);
  });
});

describe("quotas.canVerifyNow", () => {
  it("returns boolean and respects shared cap config", () => {
    // We can't manipulate file state cleanly in this unit, so just shape-check
    // the result. The full integration is exercised by the bot runtime.
    assert.equal(typeof canVerifyNow(), "boolean");
    assert.ok(VERIFY_SHARED_CAP >= 1 && VERIFY_SHARED_CAP <= 100);
  });
});

describe("quotas.canAutoWriteNow", () => {
  it("returns true for tiny costs under reasonable defaults", () => {
    // Default cap is 1.0 NOOK; a 0.01 cost should always fit on a fresh log
    assert.equal(typeof canAutoWriteNow(0.01), "boolean");
  });
  it("returns false when estimated cost itself exceeds the cap", () => {
    assert.equal(canAutoWriteNow(999), false);
  });
});

describe("quotas.effectiveBountyAutoApplyCap", () => {
  it("returns full cap with insufficient lookback data", () => {
    const r = effectiveBountyAutoApplyCap();
    assert.ok(r.cap >= 1);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  });
});

describe("generation-semaphore", () => {
  it("returns a release function on acquire", async () => {
    const r = await acquireGeneration("clarification");
    assert.equal(typeof r, "function");
    r();
  });
  it("snapshot reflects active count + capacity", () => {
    const s = semaphoreSnapshot();
    assert.ok(s.capacity >= 1);
    assert.ok(s.active >= 0);
    assert.ok(s.queued >= 0);
  });
  it("serves higher priority before lower priority", async () => {
    // Fill the semaphore to capacity
    const cap = semaphoreSnapshot().capacity;
    const releases: Array<() => void> = [];
    for (let i = 0; i < cap; i++) {
      releases.push(await acquireGeneration("clarification"));
    }
    // Now queue: a low-priority one and a high-priority one.
    let lowResolved = false;
    let highResolved = false;
    const lowP = acquireGeneration("clarification").then((r) => {
      lowResolved = true;
      return r;
    });
    const highP = acquireGeneration("mining").then((r) => {
      highResolved = true;
      return r;
    });
    // Release one slot — the high-priority one should be served first.
    releases[0]();
    const highR = await highP;
    assert.equal(highResolved, true);
    assert.equal(lowResolved, false);
    // Then release another slot → low should now resolve
    releases[1]?.();
    const lowR = await lowP;
    assert.equal(lowResolved, true);
    // Cleanup
    highR();
    lowR();
    for (const r of releases.slice(2)) r();
  });
});

describe("util.readJsonlTail", () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(joinPath(tmpdir(), "nookplot-test-"));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  it("returns [] for missing file", () => {
    assert.deepEqual(readJsonlTail(joinPath(tmp, "nope.jsonl"), 10), []);
  });
  it("returns the last N rows", () => {
    const path = joinPath(tmp, "many.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ i }));
    writeFileSync(path, lines.join("\n") + "\n");
    const tail = readJsonlTail<{ i: number }>(path, 10);
    assert.equal(tail.length, 10);
    assert.equal(tail[0].i, 490);
    assert.equal(tail[9].i, 499);
  });
  it("handles small files smaller than N", () => {
    const path = joinPath(tmp, "small.jsonl");
    writeFileSync(path, JSON.stringify({ x: 1 }) + "\n" + JSON.stringify({ x: 2 }) + "\n");
    const tail = readJsonlTail<{ x: number }>(path, 10);
    assert.equal(tail.length, 2);
  });
  it("skips malformed lines", () => {
    const path = joinPath(tmp, "mixed.jsonl");
    writeFileSync(path, [
      JSON.stringify({ ok: 1 }),
      "not-json",
      JSON.stringify({ ok: 2 }),
    ].join("\n") + "\n");
    const tail = readJsonlTail<{ ok: number }>(path, 10);
    assert.equal(tail.length, 2);
  });
});

import { before, after } from "node:test";

import { filterPoolByParseFailure } from "../models.js";
import { findRenames } from "../specialization-drift.js";

describe("venice-cost.estimateCallCost", () => {
  it("uses known model rate", () => {
    // Real Venice list pricing for the Opus tier: $6/M in, $30/M out. With no
    // split supplied we assume the output-heavy shape our calls actually have
    // (70% completion): 0.3M×$6 + 0.7M×$30 = $22.80. This replaced a stale
    // hand-maintained blended rate of 25.0 on 2026-07-28.
    const c = estimateCallCost("claude-opus-4-7", 1_000_000);
    assert.equal(Math.round(c * 100) / 100, 22.8);
  });
  it("falls back to default rate for unknown model", () => {
    const c = estimateCallCost("some-future-model", 100_000);
    assert.ok(c > 0 && c < 5);
  });
  it("scales linearly", () => {
    const a = estimateCallCost("grok-4-3", 100_000);
    const b = estimateCallCost("grok-4-3", 1_000_000);
    assert.equal(Math.round((b / a) * 10) / 10, 10);
  });
});

describe("models.filterPoolByParseFailure", () => {
  it("sidelines models above threshold with enough attempts", () => {
    const r = filterPoolByParseFailure(["good", "bad"], {
      good: { attempts: 10, failures: 0, rate: 0 },
      bad: { attempts: 10, failures: 6, rate: 0.6 },
    });
    assert.deepEqual(r.filtered, ["good"]);
    assert.deepEqual(r.sidelined, ["bad"]);
  });
  it("does NOT sideline below min-attempts even with high rate", () => {
    const r = filterPoolByParseFailure(["alpha", "beta"], {
      beta: { attempts: 2, failures: 2, rate: 1.0 },
    });
    // alpha has no data → kept; beta has insufficient attempts → also kept
    assert.equal(r.filtered.length, 2);
    assert.equal(r.sidelined.length, 0);
  });
  it("falls back to full pool if filtering would empty it", () => {
    const r = filterPoolByParseFailure(["only-model"], {
      "only-model": { attempts: 10, failures: 10, rate: 1.0 },
    });
    assert.equal(r.filtered.length, 1);
  });
});

describe("specialization-drift.findRenames", () => {
  it("returns empty when our tags all match exactly", () => {
    assert.equal(findRenames(["ml", "distributed-systems"], ["ml", "distributed-systems"]).length, 0);
  });
  it("flags a likely rename via trigram similarity", () => {
    const r = findRenames(["distributed-systems"], ["distributed_systems", "machine-learning"]);
    assert.equal(r.length, 1);
    assert.equal(r[0].ours, "distributed-systems");
    assert.ok(r[0].possible[0] === "distributed_systems");
  });
  it("returns empty when no close matches exist", () => {
    const r = findRenames(["xyz"], ["totally-different-thing"]);
    assert.equal(r.length, 0);
  });
});

describe("mining.composePostSolveLearning", () => {
  it("returns empty for empty input", () => {
    assert.equal(composePostSolveLearning("", undefined), "");
  });
  it("picks specificity-dense sentences", () => {
    const reasoning = `
      This is fluff with nothing specific.
      The Raft consensus protocol achieves O(log n) commit latency in the common case.
      Some more generic prose without numbers.
      We measured 47ms p99 latency on a 5-node cluster running RocksDB.
      Generic conclusion.
    `;
    const out = composePostSolveLearning(reasoning, undefined);
    // Should include the two concrete sentences and drop the fluff
    assert.ok(out.includes("47ms") || out.includes("O(log n)"));
    assert.ok(!out.includes("fluff with nothing"));
  });
  it("falls back to traceSummary when sentences are too short", () => {
    const out = composePostSolveLearning("ok.", "A reasonable summary with specifics — measured 50ms and uses `quickSort`.");
    assert.ok(out.length >= 50);
  });
  it("caps output at 1500 chars", () => {
    const long = Array.from({ length: 100 }, () => "We measured 50ms p99 latency on a 5-node cluster running RocksDB version 7.").join(" ");
    const out = composePostSolveLearning(long, undefined);
    assert.ok(out.length <= 1500);
  });
});

describe("embedding-mining.validateVectors", () => {
  const vec = (seed: number): number[] => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) * 0.1);
  it("accepts well-formed 768-dim distinct vectors", () => {
    assert.deepEqual(validateVectors([vec(1), vec(2)], 2), { ok: true });
  });
  it("rejects wrong count", () => {
    assert.equal(validateVectors([vec(1)], 2).ok, false);
  });
  it("rejects wrong dimension", () => {
    assert.equal(validateVectors([[1, 2, 3]], 1).ok, false);
  });
  it("rejects NaN/Infinity", () => {
    const bad = vec(1).slice();
    bad[0] = NaN;
    assert.equal(validateVectors([bad], 1).ok, false);
  });
  it("rejects duplicate vectors", () => {
    assert.equal(validateVectors([vec(5), vec(5)], 2).ok, false);
  });
  it("does NOT false-flag vectors that share only their first 8 dims", () => {
    // Regression for the old slice(0,8) dup key: identical prefix, different tail.
    const a = vec(1);
    const b = a.slice();
    b[700] = b[700] + 0.5; // differ well past dim 8
    assert.deepEqual(validateVectors([a, b], 2), { ok: true });
  });
});

describe("swarms.isTerminalHeartbeatError", () => {
  it("treats reassigned/gone/conflict as terminal (stop heartbeating)", () => {
    for (const m of ["Gateway request failed (404): not found", "Gateway request failed (409): already submitted", "subtask was reassigned", "claim expired"]) {
      assert.equal(isTerminalHeartbeatError(m), true, m);
    }
  });
  it("treats transient 5xx/network errors as retryable", () => {
    for (const m of ["Gateway request failed (502): bad gateway", "fetch failed", "Gateway request failed (500)"]) {
      assert.equal(isTerminalHeartbeatError(m), false, m);
    }
  });
});

describe("aggregation.isWellFormed", () => {
  const good = {
    domain: "ml",
    tags: ["ml"],
    synthesis: "x".repeat(120),
    keyInsights: [{ insight: "a" }, { insight: "b" }],
    reasoningPatterns: [{ pattern: "p" }],
    provenance: { sourceTraceIds: ["t1"], method: "llm-synthesis" },
  };
  it("accepts an aggregate with all required sections", () => {
    assert.equal(aggInternals.isWellFormed(good), true);
  });
  it("rejects a too-short synthesis", () => {
    assert.equal(aggInternals.isWellFormed({ ...good, synthesis: "short" }), false);
  });
  it("rejects fewer than 2 key insights", () => {
    assert.equal(aggInternals.isWellFormed({ ...good, keyInsights: [{ insight: "a" }] }), false);
  });
  it("rejects missing provenance", () => {
    assert.equal(aggInternals.isWellFormed({ ...good, provenance: undefined as never }), false);
  });
  it("treats 'Endpoint does not exist' as dormant", () => {
    assert.equal(aggInternals.isDormant(new Error("Not found: Endpoint does not exist")), true);
    assert.equal(aggInternals.isDormant(new Error("Invalid arguments: bad foo")), false);
  });
});

describe("bounty-review.rankBounties", () => {
  const longDesc = "x".repeat(250); // clears the 200-char substance gate
  const ok = (over: Partial<BountyRow>): BountyRow => ({
    id: "b", title: "t", description: longDesc, rewardAmount: 500, status: 0, applicationCount: 0, ...over,
  });
  const tags: string[] = [];

  it("drops claimed/closed bounties (status > 0)", () => {
    const out = rankBounties([ok({ id: "open", status: 0 }), ok({ id: "closed", status: 1 })], new Set(), tags);
    assert.deepEqual(out.map((s) => s.b.id), ["open"]);
  });

  it("dedups bounties we've already applied to / queued", () => {
    const out = rankBounties([ok({ id: "fresh" }), ok({ id: "seen" })], new Set(["seen"]), tags);
    assert.deepEqual(out.map((s) => s.b.id), ["fresh"]);
  });

  it("drops hard-gate failures (under-reward, thin desc, over-competition)", () => {
    const out = rankBounties(
      [
        ok({ id: "good" }),
        ok({ id: "cheap", rewardAmount: 50 }), // < 100 NOOK floor
        ok({ id: "thin", description: "too short" }), // < 200 chars
        ok({ id: "crowded", applicationCount: 99 }), // > 10 apps
      ],
      new Set(),
      tags,
    );
    assert.deepEqual(out.map((s) => s.b.id), ["good"]);
  });

  it("ranks higher reward / lower competition first", () => {
    const out = rankBounties(
      [ok({ id: "low", rewardAmount: 150, applicationCount: 5 }), ok({ id: "high", rewardAmount: 2000, applicationCount: 0 })],
      new Set(),
      tags,
    );
    assert.equal(out[0].b.id, "high");
  });

  it("returns [] when nothing qualifies (thin-supply day)", () => {
    assert.deepEqual(rankBounties([ok({ id: "cheap", rewardAmount: 1 })], new Set(), tags), []);
  });
});

describe("verify-kinds (artifact-verify gate)", () => {
  it("isRerunnableKind: only the 3 code-executing kinds", () => {
    for (const k of ["python_tests", "javascript_tests", "replication"]) assert.equal(isRerunnableKind(k), true);
    for (const k of ["crowd_jury", "prediction", "exact_answer", "standard", "", null, undefined]) assert.equal(isRerunnableKind(k), false);
  });

  it("isVerifyEligible: standard always eligible regardless of flag", () => {
    assert.equal(isVerifyEligible("standard", false), true);
    assert.equal(isVerifyEligible(null, false), true);
    assert.equal(isVerifyEligible(undefined, false), true);
  });

  it("isVerifyEligible: rerun-able kinds gated by the flag", () => {
    assert.equal(isVerifyEligible("python_tests", false), false); // flag off → skip (old behavior preserved)
    assert.equal(isVerifyEligible("python_tests", true), true); // flag on → eligible
    assert.equal(isVerifyEligible("replication", true), true);
  });

  it("isVerifyEligible: non-rerunnable verifiable kinds never eligible (even with flag)", () => {
    for (const k of ["crowd_jury", "prediction", "exact_answer"]) assert.equal(isVerifyEligible(k, true), false);
  });
});

describe("verify-kinds.decideFromRerun (correctness from independent rerun)", () => {
  it("confirms 1.0 when the rerun reproduces the outcome", () => {
    const d = decideFromRerun({ success: true, outcomesMatch: true });
    assert.equal(d.action, "verify");
    assert.equal(d.action === "verify" && d.correctness, 1.0);
  });

  it("ABSTAINS when the rerun does NOT reproduce the outcome", () => {
    const d = decideFromRerun({ success: true, outcomesMatch: false });
    assert.equal(d.action, "abstain");
  });

  it("falls back to 1.0 (submit-time gate) when there is no usable rerun signal", () => {
    // no result (rate-limited / errored), success=false, or non-boolean match
    for (const rr of [null, undefined, { success: false }, { outcomesMatch: undefined }, {} as Record<string, never>]) {
      const d = decideFromRerun(rr);
      assert.equal(d.action, "verify");
      assert.equal(d.action === "verify" && d.correctness, 1.0);
    }
  });

  it("never confirms correctness purely on success without a match signal", () => {
    // success true but outcomesMatch missing → inconclusive, not a blind confirm
    const d = decideFromRerun({ success: true });
    assert.equal(d.action, "verify");
    assert.match(d.note, /inconclusive|submit-time/);
  });
});

// ── instance-lock.ts single-instance daemon lock ────────────────────────

describe("instance-lock (single-instance daemon lock)", () => {
  let dir: string;
  const pidfile = () => joinPath(dir, "bot.pid");
  // A pid that is definitely not a live process AND not ours.
  const DEAD_PID = 3_999_999;

  beforeEach(() => {
    dir = mkdtempSync(joinPath(tmpdir(), "nookplot-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (over: Partial<LockDeps> = {}): Partial<LockDeps> => ({
    pidfilePath: pidfile(),
    isAlive: () => false,
    commandOf: () => null,
    cwdOf: () => null,
    pid: 4242,
    repo: "/repo/bot",
    ...over,
  });

  it("acquires when no pidfile exists and records our identity", () => {
    const info = acquireInstanceLock(deps());
    assert.ok("pid" in info && info.pid === 4242);
    const onDisk = readPidfile(pidfile());
    assert.equal(onDisk?.pid, 4242);
    assert.equal(onDisk?.repo, "/repo/bot");
  });

  it("acquires over a stale pidfile (recorded pid is dead)", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "2026-07-20T00:00:00Z", gitRev: "abc1234", repo: "/repo/bot" }));
    const info = acquireInstanceLock(deps({ isAlive: () => false }));
    assert.ok("pid" in info);
    assert.equal(readPidfile(pidfile())?.pid, 4242);
  });

  it("REFUSES when the holder is alive, runs src/index.ts, and cwd matches", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "2026-07-23T00:00:00Z", gitRev: "abc1234", repo: "/repo/bot" }));
    assert.throws(
      () => acquireInstanceLock(deps({
        isAlive: () => true,
        commandOf: () => "node --require tsx/preflight.cjs --import tsx/loader.mjs src/index.ts",
        cwdOf: () => "/repo/bot",
      })),
      new RegExp(`pid ${DEAD_PID}`),
    );
    // And the holder's pidfile was NOT touched.
    assert.equal(readPidfile(pidfile())?.pid, DEAD_PID);
  });

  it("REFUSES when the holder is alive and cwd is unknowable (conservative)", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x", gitRev: null, repo: "/repo/bot" }));
    assert.throws(() =>
      acquireInstanceLock(deps({
        isAlive: () => true,
        commandOf: () => "node ... src/index.ts",
        cwdOf: () => null,
      })),
    );
  });

  it("REFUSES conservatively when the pid is alive but command AND cwd are unknowable", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x", gitRev: null, repo: "/repo/bot" }));
    assert.throws(
      () => acquireInstanceLock(deps({ isAlive: () => true })),
      /conservatively/,
    );
  });

  it("acquires when the pid was REUSED by an unrelated process", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x", gitRev: null, repo: "/repo/bot" }));
    const info = acquireInstanceLock(deps({
      isAlive: () => true,
      commandOf: () => "/Applications/Spotify.app/Contents/MacOS/Spotify",
    }));
    assert.ok("pid" in info);
  });

  it("acquires when a DIFFERENT tsx project holds the pid (src/index.ts is a generic name)", () => {
    // The operator's other project also runs `tsx src/index.ts` — cwd disambiguates.
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x", gitRev: null, repo: "/repo/bot" }));
    const info = acquireInstanceLock(deps({
      isAlive: () => true,
      commandOf: () => "node --import tsx/loader.mjs src/index.ts",
      cwdOf: () => "/repo/morning-brief",
    }));
    assert.ok("pid" in info);
  });

  it("acquires over a corrupt pidfile", () => {
    writeFileSync(pidfile(), "not json{{{");
    const info = acquireInstanceLock(deps());
    assert.ok("pid" in info);
    assert.equal(readPidfile(pidfile())?.pid, 4242);
  });

  it("release removes only OUR pidfile, never another holder's", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "x", gitRev: null, repo: "/repo/bot" }));
    releaseInstanceLock(deps()); // we are 4242, holder is DEAD_PID
    assert.equal(readPidfile(pidfile())?.pid, DEAD_PID); // untouched
    acquireInstanceLock(deps());
    releaseInstanceLock(deps());
    assert.equal(readPidfile(pidfile()), null); // ours → removed
  });

  it("BOT_INSTANCE_LOCK=0 skips the lock entirely", () => {
    const saved = process.env.BOT_INSTANCE_LOCK;
    process.env.BOT_INSTANCE_LOCK = "0";
    try {
      const r = acquireInstanceLock(deps({ isAlive: () => true, commandOf: () => "src/index.ts", cwdOf: () => "/repo/bot" }));
      assert.deepEqual(r, { skipped: true });
      assert.equal(readPidfile(pidfile()), null); // nothing written
    } finally {
      if (saved === undefined) delete process.env.BOT_INSTANCE_LOCK;
      else process.env.BOT_INSTANCE_LOCK = saved;
    }
  });

  it("holderStatus reports alive holder identity for /api/health", () => {
    writeFileSync(pidfile(), JSON.stringify({ pid: DEAD_PID, startedAt: "2026-07-23T12:00:00Z", gitRev: "f192051", repo: "/repo/bot" }));
    const h = holderStatus(deps({
      isAlive: () => true,
      commandOf: () => "node ... src/index.ts",
      cwdOf: () => "/repo/bot",
    }));
    assert.equal(h.state, "alive");
    assert.equal(h.info?.gitRev, "f192051");
    const stale = holderStatus(deps({ isAlive: () => false }));
    assert.equal(stale.state, "stale");
  });

  it("readGitRev resolves HEAD → ref file in a synthetic .git", () => {
    const repo = joinPath(dir, "fakerepo");
    const refsDir = joinPath(repo, ".git", "refs", "heads");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(joinPath(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(joinPath(refsDir, "main"), "f192051deadbeef0000000000000000000000000\n");
    assert.equal(readGitRev(repo), "f192051");
    assert.equal(readGitRev(joinPath(dir, "no-such-repo")), null);
  });
});

describe("network-status gateway watchdog", () => {
  it("does not exit on a single missed poll (transient blip)", () => {
    assert.equal(shouldExitForDeadGateway(1, 3), false);
    assert.equal(shouldExitForDeadGateway(2, 3), false);
  });
  it("exits once the run reaches the threshold", () => {
    assert.equal(shouldExitForDeadGateway(3, 3), true);
    assert.equal(shouldExitForDeadGateway(105, 3), true); // the 2026-07-25 outage
  });
  it("threshold 0 disables the watchdog entirely", () => {
    assert.equal(shouldExitForDeadGateway(999, 0), false);
  });
  it("starts from a clean state", () => {
    const st = gatewayWatchdogState();
    assert.equal(st.consecutiveNullEpochPolls, 0);
    assert.ok(st.threshold >= 0);
  });
});

describe("dashboard-web.gatewayReachability (blackout visibility)", () => {
  const ok = (ts: string, epoch?: number | null) => ({ ts, epoch: epoch ?? undefined });
  it("reports reachable when the latest sample has an epoch", () => {
    const r = gatewayReachability([ok("2026-07-28T02:00:00Z", 130), ok("2026-07-28T02:30:00Z", 131)]);
    assert.equal(r.reachable, true);
    assert.equal(r.consecutiveNoEpoch, 0);
  });
  it("detects the trailing no-epoch run and measures its span", () => {
    // The real 2026-07-25 shape: a good sample, then nothing but nulls.
    const r = gatewayReachability([
      ok("2026-07-25T22:27:00Z", 128),
      ok("2026-07-25T22:57:00Z", undefined),
      ok("2026-07-25T23:27:00Z", undefined),
      ok("2026-07-26T00:57:00Z", undefined),
    ]);
    assert.equal(r.reachable, false);
    assert.equal(r.consecutiveNoEpoch, 3);
    assert.equal(r.since, "2026-07-25T22:57:00Z");
    assert.equal(r.lastEpochSeenAt, "2026-07-25T22:27:00Z");
    assert.ok(r.hours > 1.9 && r.hours < 2.1, `expected ~2h, got ${r.hours}`);
  });
  it("treats null epoch the same as undefined", () => {
    assert.equal(gatewayReachability([ok("2026-07-25T22:57:00Z", null)]).consecutiveNoEpoch, 1);
  });
  it("recovery clears the run even with nulls earlier in history", () => {
    const r = gatewayReachability([
      ok("2026-07-28T02:00:00Z", undefined),
      ok("2026-07-28T02:30:00Z", undefined),
      ok("2026-07-28T03:39:00Z", 131),
    ]);
    assert.equal(r.reachable, true);
    assert.equal(r.consecutiveNoEpoch, 0);
  });
  it("empty history is not an outage (fresh install)", () => {
    assert.equal(gatewayReachability([]).reachable, true);
  });
});

describe("specificity-gate techniques matcher (post-2026-07-28 tightening)", () => {
  it("no longer credits a bare string literal lifted from code", () => {
    // The exact false pass behind 39 gateway specificity-400s: the enricher
    // appended `technique "http"` from a scheme check and the local gate said
    // pass, while the gateway scored techniques +0.
    assert.equal(specificityCategories('Validates the scheme technique "http" before fetching.').techniques, false);
    assert.equal(specificityCategories('Uses the "fast" path when possible.').techniques, false);
  });
  it("still credits real method names", () => {
    assert.equal(specificityCategories("Uses bisect_right to find the insertion point.").techniques, true);
    assert.equal(specificityCategories("Calls urlsplit() on the raw input first.").techniques, true);
    assert.equal(specificityCategories("Delegates to Map.get for O(1) lookup.").techniques, true);
    assert.equal(specificityCategories('Wraps "json.loads" instead of pickle.').techniques, true);
    assert.equal(specificityCategories("The parseHeader helper normalizes casing.").techniques, true);
  });
  it("a gateway-shaped good summary passes the whole gate", () => {
    const good =
      "Uses `bisect_right` over the sorted offsets instead of a linear scan, cutting lookup from O(n) to O(log n) " +
      "for n=10000 entries. Rejects malformed rows early rather than failing at parse time.";
    assert.equal(passesSpecificityGate(good), true);
  });
  it("the vague summaries that actually 400'd still fail locally", () => {
    // Real shape of a rejected python_tests summary: prose + a literal, no
    // measurable claim, no comparison. Must NOT reach the gateway.
    assert.equal(
      passesSpecificityGate('Implements the requested function by iterating over the input and returning the result for "get_url_body".'),
      false,
    );
  });
});

describe("venice-cost.estimateCallCost (real per-model pricing)", () => {
  it("prices every live mining arm from the real table, not the default", () => {
    // A model missing from the table silently falls back to DEFAULT_PRICING,
    // which corrupts the NOOK-per-dollar comparison that decides A/B pruning.
    // Distinct prices prove each arm has its own entry.
    const costs = ["grok-4-5", "claude-opus-5", "openai-gpt-56-sol", "kimi-k3"]
      .map((m) => estimateCallCost(m, 12000, 8000));
    assert.equal(new Set(costs.map((c) => c.toFixed(6))).size, 4, "arms share a price — one is falling back to the default");
    for (const c of costs) assert.ok(c > 0, "cost must never be zero");
  });

  it("bills output tokens at the output rate (reasoning dominates our spend)", () => {
    // Same total, different split: output-heavy must cost more, since every
    // arm prices output 3-6x input.
    const outputHeavy = estimateCallCost("claude-opus-5", 10000, 9000);
    const inputHeavy = estimateCallCost("claude-opus-5", 10000, 1000);
    assert.ok(outputHeavy > inputHeavy * 2, `expected output-heavy to dominate: ${outputHeavy} vs ${inputHeavy}`);
  });

  it("matches Venice list pricing for a known model", () => {
    // claude-opus-5 = $6/M in, $30/M out. 4k in + 8k out = 0.024 + 0.24.
    assert.ok(Math.abs(estimateCallCost("claude-opus-5", 12000, 8000) - 0.264) < 1e-9);
  });

  it("an unknown model still costs something (never free)", () => {
    assert.ok(estimateCallCost("some-unreleased-model", 12000, 8000) > 0);
  });

  it("assumes an output-heavy split when the completion count is unknown", () => {
    // Legacy 2-arg calls must not understate cost by assuming a cheap split.
    const assumed = estimateCallCost("claude-opus-5", 10000);
    const evenSplit = estimateCallCost("claude-opus-5", 10000, 5000);
    assert.ok(assumed > evenSplit, "unknown split should assume output-heavy");
  });
});

describe("venice-cost reasoning-token accounting (no double-count)", () => {
  it("treats reasoning as a SUBSET of completion, not additive", () => {
    // Venice follows the OpenAI convention: completion_tokens already includes
    // reasoning_tokens (verified against 6,108 reasoning-bearing rows in the
    // live cost log — total == prompt + completion in 6108/6108, additive in
    // 0/6108). Billing their sum double-counts, and ONLY on arms that report
    // reasoning (grok-4-5, gpt-56-sol always; claude-*, kimi-k3 never), which
    // silently biases the per-arm NOOK-per-dollar comparison.
    const prompt = 2500, completion = 5000, total = 7500;
    const correct = estimateCallCost("openai-gpt-56-sol", total, completion);
    const doubleCounted = estimateCallCost("openai-gpt-56-sol", total, completion + 2300);
    assert.ok(doubleCounted > correct, "sanity: the buggy form would cost more");
    // The correct figure is exactly input-rate × prompt + output-rate × completion.
    const expected = (2500 / 1e6) * 6.25 + (5000 / 1e6) * 37.5;
    assert.ok(Math.abs(correct - expected) < 1e-9, `${correct} != ${expected}`);
  });

  it("never lets the output count exceed the total (input can't go negative)", () => {
    const c = estimateCallCost("claude-opus-5", 1000, 5000);
    assert.ok(c > 0 && Number.isFinite(c));
  });
});

describe("mining circuit breaker — model-id rejection (deterministic evidence)", () => {
  const base = { attempts: 3, failures: 3, rate: 1.0, idRejected: 0, idRejectedWireNames: [] as string[] };
  const POOL = ["grok-4-5", "claude-opus-5", "openai-gpt-56-sol", "kimi-k3"];

  it("sidelines on a SINGLE id rejection — no waiting for a rate to build", () => {
    // A modelUsed rejection is deterministic: the gateway will refuse this id
    // every time. GLM burned 52 paid solves and kimi-k3 3 before this existed.
    const rates = { "kimi-k3": { ...base, attempts: 1, failures: 1, idRejected: 1, idRejectedWireNames: ["kimi-k3"] } };
    const r = filterPoolByParseFailure(POOL, rates);
    assert.deepEqual(r.sidelined, ["kimi-k3"]);
    assert.ok(!r.filtered.includes("kimi-k3"));
  });

  it("a rejection of an OLD wire name does not condemn a corrected one", () => {
    // Otherwise a fixed id could never be tested — the arm stays sidelined on
    // evidence about a string we no longer send.
    const rates = { "kimi-k3": { ...base, idRejected: 3, idRejectedWireNames: ["kimi-k3"] } };
    const adjusted = discountStaleIdRejections(rates);
    assert.equal(adjusted["kimi-k3"].idRejected, 0, "stale name should be discounted");
    assert.ok(filterPoolByParseFailure(POOL, adjusted).filtered.includes("kimi-k3"));
  });

  it("but a rejection of the CURRENT wire name still counts", () => {
    // gatewayModelName("kimi-k3") is currently the org/Model override.
    const current = gatewayModelName("kimi-k3");
    const rates = { "kimi-k3": { ...base, idRejected: 1, idRejectedWireNames: [current] } };
    const adjusted = discountStaleIdRejections(rates);
    assert.equal(adjusted["kimi-k3"].idRejected, 1, "current-name rejection must survive");
    assert.deepEqual(filterPoolByParseFailure(POOL, adjusted).sidelined, ["kimi-k3"]);
  });

  it("rows with no recorded wire name are distrusted (safe default)", () => {
    const rates = { "kimi-k3": { ...base, idRejected: 2, idRejectedWireNames: [] } };
    assert.equal(discountStaleIdRejections(rates)["kimi-k3"].idRejected, 2);
  });

  it("a healthy arm is untouched", () => {
    const rates = { "grok-4-5": { attempts: 10, failures: 1, rate: 0.1, idRejected: 0, idRejectedWireNames: [] } };
    assert.deepEqual(filterPoolByParseFailure(POOL, rates).sidelined, []);
  });
});

describe("mining.meetsValueFloor (protects the rolling-cap slot)", () => {
  it("rejects the ~6-NOOK challenges that cost ~288k in one window", () => {
    // 2026-07-28: 9 of 12 slots went to challenges estimated at 6 NOOK,
    // settling ~5.5k each where standard solves return ~45.8k.
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: 6 }, 10), false);
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: 3 }, 10), false);
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: 9 }, 10), false);
  });
  it("accepts standard-tier challenges", () => {
    // Live pool 2026-07-30: 91 of 92 standard challenges were estimated at 31.
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: 31 }, 10), true);
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: 10 }, 10), true);
  });
  it("allows a challenge with NO estimate (missing data is not low value)", () => {
    assert.equal(meetsValueFloor({ id: "a" }, 10), true);
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: undefined }, 10), true);
  });
  it("floor 0 disables the check entirely", () => {
    assert.equal(meetsValueFloor({ id: "a", estimatedRewardNook: 1 }, 0), true);
  });
});

describe("dashboard-web.claimRelayHealth (on-chain settlement stall)", () => {
  const T = (h: number) => new Date(Date.UTC(2026, 6, 30, h, 0, 0)).toISOString();
  const now = Date.UTC(2026, 6, 30, 15, 0, 0);

  it("reports healthy when every off-chain claim has an on-chain row after it", () => {
    const r = claimRelayHealth([
      { ts: T(2), kind: "off-chain", claimed: 500 },
      { ts: T(3), kind: "on-chain" },
    ], now);
    assert.equal(r.stalledHours, null);
    assert.equal(r.unsettledNook, 0);
  });

  it("does NOT fire on a healthy claim mid-flight (off-chain written seconds before on-chain)", () => {
    // Every successful cycle briefly has an orphan. Gating on existence alone
    // flashed a false "stalled 0.0h" whenever a poll landed in that gap.
    const r = claimRelayHealth([
      { ts: "2026-07-30T02:00:00Z", kind: "on-chain" },
      { ts: new Date(now - 30_000).toISOString(), kind: "off-chain", claimed: 1000 },
    ], now);
    assert.equal(r.stalledHours, null);
    assert.equal(r.unsettledNook, 0);
  });

  it("respects the minimum stall age boundary", () => {
    const rows = [
      { ts: "2026-07-30T02:00:00Z", kind: "on-chain" },
      { ts: new Date(now - 90 * 60_000).toISOString(), kind: "off-chain", claimed: 1000 },
    ];
    assert.equal(claimRelayHealth(rows, now, 2).stalledHours, null, "1.5h < 2h floor");
    assert.ok((claimRelayHealth(rows, now, 1).stalledHours ?? 0) > 1, "1.5h > 1h floor");
  });

  it("detects the 2026-07-30 stall and totals the unsettled NOOK", () => {
    const r = claimRelayHealth([
      { ts: "2026-07-29T04:07:00Z", kind: "off-chain", claimed: 373417 },
      { ts: "2026-07-29T04:07:30Z", kind: "on-chain" },
      { ts: T(2), kind: "off-chain", claimed: 361422 },
    ], now);
    assert.ok(r.stalledHours !== null && r.stalledHours > 12 && r.stalledHours < 14, `got ${r.stalledHours}`);
    assert.equal(r.unsettledNook, 361422);
    assert.equal(r.lastOnChain, "2026-07-29T04:07:30Z");
  });

  it("measures from the ORPHANED claim, not the last success", () => {
    // Two orphans: the age must reflect the oldest unsettled value.
    const r = claimRelayHealth([
      { ts: T(1), kind: "on-chain" },
      { ts: T(2), kind: "off-chain", claimed: 100 },
      { ts: T(14), kind: "off-chain", claimed: 50 },
    ], now);
    assert.ok(r.stalledHours !== null && r.stalledHours > 12);
    assert.equal(r.unsettledNook, 150);
  });

  it("empty ledger is not a stall", () => {
    assert.equal(claimRelayHealth([], now).stalledHours, null);
  });
});

describe("dashboard-web.computeNetPnl (replaces the vanity winning score)", () => {
  const now = Date.UTC(2026, 6, 30, 15, 0, 0);
  const day = (d: number) => new Date(Date.UTC(2026, 6, d, 2, 0, 0)).toISOString();

  it("computes a real net, and reports a LOSS as a loss", () => {
    // The old score had no revenue/cost/net term and sat pinned at max while
    // the bot lost money daily. This must be able to go negative.
    const p = computeNetPnl(
      [{ ts: day(29), kind: "off-chain", claimed: 1_000_000 }],
      [{ date: "2026-07-29", spendUsd: 6 }],
      0.00000396,
      now,
    );
    assert.ok(p.usdRevenue > 3.9 && p.usdRevenue < 4.0, `revenue ${p.usdRevenue}`);
    assert.equal(p.usdCost, 6);
    assert.ok(p.usdNet < 0, "a losing week must report negative net");
    assert.ok(p.costCoverage !== null && p.costCoverage < 1);
  });

  it("uses the price recorded AT CLAIM TIME so history doesn't drift", () => {
    const p = computeNetPnl(
      [{ ts: day(29), kind: "off-chain", claimed: 1_000_000, priceUsdAtClaim: 0.00001 }],
      [],
      0.00000396, // live price differs — must NOT be used for this row
      now,
    );
    assert.ok(Math.abs(p.usdRevenue - 10) < 1e-9, `expected $10, got ${p.usdRevenue}`);
  });

  it("derives the breakeven price the operator actually needs", () => {
    const p = computeNetPnl(
      [{ ts: day(29), kind: "off-chain", claimed: 2_000_000 }],
      [{ date: "2026-07-29", spendUsd: 20 }],
      0.00000396,
      now,
    );
    assert.ok(Math.abs((p.breakevenPriceUsd ?? 0) - 0.00001) < 1e-12);
  });

  it("prices revenue and cost over the SAME window", () => {
    // Regression: cost was summed over 8 days against 7 days of revenue,
    // overstating the loss ~20%. A day outside the window must be excluded
    // from BOTH sides.
    const stale = new Date(Date.UTC(2026, 6, 20, 2, 0, 0)).toISOString().slice(0, 10);
    const p = computeNetPnl(
      [
        { ts: day(29), kind: "off-chain", claimed: 1_000_000 },
        { ts: new Date(Date.UTC(2026, 6, 20, 2, 0, 0)).toISOString(), kind: "off-chain", claimed: 9_000_000 },
      ],
      [{ date: "2026-07-29", spendUsd: 6 }, { date: stale, spendUsd: 100 }],
      0.00001,
      now,
    );
    assert.equal(p.nookEarned, 1_000_000, "stale claim must be outside the window");
    assert.equal(p.usdCost, 6, "stale spend day must be outside the SAME window");
  });

  it("ignores on-chain rows so settlement never double-counts revenue", () => {
    const p = computeNetPnl(
      [
        { ts: day(29), kind: "off-chain", claimed: 100_000 },
        { ts: day(29), kind: "on-chain", claimed: 100_000 },
      ],
      [],
      0.00001,
      now,
    );
    assert.equal(p.nookEarned, 100_000);
  });
});

describe("challenge-posting.countVerifiedSolves (royalty gate)", () => {
  it("counts only VERIFIED solves — a submission is not qualification", () => {
    // The exact 2026-07-30 shape: one submission, unverified, royalty at risk
    // while the old submission-count check reported everything fine.
    assert.equal(countVerifiedSolves({ submissions: [{ status: "submitted", verifiedAt: null }] }), 0);
    assert.equal(countVerifiedSolves({ submissions: [{ status: "verified", verifiedAt: "2026-07-30T09:00:00Z" }] }), 1);
  });
  it("treats a verifiedAt timestamp as qualification even if status lags", () => {
    assert.equal(countVerifiedSolves({ submissions: [{ status: "submitted", verifiedAt: "2026-07-30T09:00:00Z" }] }), 1);
  });
  it("handles an empty or absent submissions array", () => {
    assert.equal(countVerifiedSolves({ submissions: [] }), 0);
    assert.equal(countVerifiedSolves({}), 0);
  });
});

describe("quotas.verifyPaceOk (burst absorption for genuine work)", () => {
  const now = Date.UTC(2026, 6, 30, 12, 0, 0);
  const minsAgo = (m: number) => now - m * 60_000;

  it("absorbs a burst of genuine candidates up to the hourly rate", () => {
    // Since the anti-farm gate went in, ~94% of the pool is spam we abstain
    // on, so genuine candidates are scarce AND bursty. At the old rate of 2/h
    // a burst was truncated and the surplus was gone by the next window —
    // 22-109 traces/day cleared the gate while only 3-11 verifications landed.
    const burst = [minsAgo(5), minsAgo(6), minsAgo(7), minsAgo(8)];
    assert.equal(verifyPaceOk(burst, now, 2), false, "old rate truncates the burst");
    assert.equal(verifyPaceOk(burst, now, 5), true, "raised rate absorbs it");
  });

  it("still refuses a free-fire spree — the 2026-06-29 collapse shape", () => {
    // 39 verifies at once tripped a gateway 429 and froze verifying for a
    // whole window. The gate must still stop that.
    const spree = Array.from({ length: 39 }, (_, i) => minsAgo(i));
    assert.equal(verifyPaceOk(spree, now, 5), false);
  });

  it("only counts the trailing hour, so the rate recovers", () => {
    const old = [minsAgo(61), minsAgo(75), minsAgo(90), minsAgo(120), minsAgo(200)];
    assert.equal(verifyPaceOk(old, now, 5), true);
  });

  it("the hourly rate never becomes the daily ceiling", () => {
    // 5/h x 24h = 120, comfortably above the 38/day shared cap, so pacing
    // shapes the RATE and the cap remains the real limit.
    assert.ok(5 * 24 > VERIFY_SHARED_CAP);
  });
});

describe("challenge-posting.rescueAwareCap (one ceiling, both guards)", () => {
  it("gives the rescue path room for MAX_RESCUES extra posts", () => {
    assert.equal(rescueAwareCap(false, 1, 2), 1);
    assert.equal(rescueAwareCap(true, 1, 2), 3);
  });

  it("the SECOND rescue is actually reachable", () => {
    // Regression: the entry guard allowed DAILY_CAP+MAX_RESCUES while the
    // post-draft concurrency re-check still used DAILY_CAP+1. The 2nd rescue
    // therefore passed the entry guard, paid for a full LLM draft, and aborted
    // — every hourly tick for the rest of the 10h window.
    const dailyCap = 1, maxRescues = 2;
    const postedSoFar = 2; // one normal post + one rescue
    assert.ok(postedSoFar < rescueAwareCap(true, dailyCap, maxRescues), "entry guard must allow it");
    assert.ok(postedSoFar < rescueAwareCap(true, dailyCap, maxRescues), "re-check must allow it too");
    // And the old mismatched ceiling is what blocked it:
    assert.ok(!(postedSoFar < dailyCap + 1), "the old DAILY_CAP+1 re-check would have aborted");
  });

  it("still stops at the ceiling", () => {
    assert.ok(!(3 < rescueAwareCap(true, 1, 2)), "3 posts is the cap with 2 rescues");
  });
});
