import { existsSync, statSync, watch, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, getRuntime } from "./runtime.js";
import { initBotLog } from "./bot-log.js";
import { chat, VENICE_WEB_SEARCH, assertVeniceKey } from "./venice.js";
import { pickModel, pickModelAB } from "./models.js";
import { runsInLean, leanBanner } from "./lean.js";
import { NOOK_DIR, appendJsonl, extractJson, readJsonl, readJsonlTail, sleep } from "./util.js";
import { findTemplateFingerprint, findNearDuplicateTrace, nearDupeCorpus, applyOffTopicClamp } from "./trace-fingerprint.js";
import { webSearch, arxivSearch, formatResultsForPrompt, type SearchResult } from "./research.js";
import { refine } from "./refine.js";
import { traceTextFromIpfsPayload, isWellFormedCid, cidRejectReason, isPermanentCidError, isTransientIpfsGatewayError, extractTraceCid, cidBearingKeys, type CidStatus } from "./trace-payload.js";
import { fetchTraceViaPublicGateways } from "./ipfs-fetch.js";
import { computeVerifyBatch, pollsRemainingBeforeUtcReset } from "./verify-batch.js";
import { VERIFY_CALIBRATION_PROMPT } from "./verify-calibration.js";
import {
  finalizedSubmissionSkip,
  solverDiversityBlockedUntil,
  reciprocalVerifierSkipUntil,
  FINALIZED_TTL_MS,
  DIVERSITY_TTL_MS,
  RECIPROCAL_TTL_MS,
  isDiversityBlockError,
  isFinalizedError,
  isReciprocalVerificationError,
  maybeWarnDiversitySaturation,
} from "./skip-caches.js";
import {
  recordDiversityPollSaturation,
  maybeWarnDiversityPollSaturation,
} from "./diversity-poll-saturation.js";
import { discoverAndSolveMiningChallenges } from "./mining.js";
import { ensureGuildMembership } from "./guild.js";
import { runRlmSpotCheckLoop } from "./rlm-spotcheck.js";
import { startNetworkStatusLoop } from "./network-status.js";
import { startCitationVelocityLoops } from "./citation-velocity.js";
import { startPaperReproductionLoop } from "./paper-reproduction.js";
import { startSocialEngagementLoops } from "./social-engagement.js";
import { runOnboardingActions } from "./onboarding.js";
import { loadConfiguredPresetAtBoot } from "./forge.js";
import { scoreCrowdJurySubmissions } from "./crowd-jury.js";
import { publishPostSolveLearnings } from "./learnings.js";
import { submitPredictions } from "./predictions.js";
import { endorseHelpfulAgents } from "./social.js";
import { findGroundedPost, recordAnchor, lastFallbackDays, type KnowledgePost } from "./knowledge-sources.js";
import { runEngagementLoop } from "./engagement.js";
import { runObservationTick } from "./observe.js";
import { getCreatorStyleProfile } from "./creator-profile.js";
import { search as vaultSearch, writeNote, noteSummary } from "./vault.js";
import { verifyThreshold, isNewUtcDay } from "./verify-quota.js";
import {
  canVerifyNow,
  recordVerify,
  recordVerifyLimitHit,
  verifySharedCount,
  VERIFY_SHARED_CAP,
  isVerifyCapError,
} from "./quotas.js";
import { recordAudit } from "./audit.js";
import { runBountyTick, truncateApplicationMessage } from "./bounties.js";
import { runClarificationsTick, generateClarificationAnswer } from "./clarifications.js";
import { runSwarmsTick, heartbeatHeldSubtasks, runSwarmsAutoSolveTick } from "./swarms.js";
import { runWeeklyRewardsTick } from "./weekly-rewards.js";
import { runBundleTick } from "./bundles.js";
import { runChallengePostTick, findNearDuplicate } from "./challenge-posting.js";
import { runManifestTick, runIntentsTick, pendingSubsFromSnapshot } from "./manifest-intents.js";
import { runInboxWatchTick } from "./inbox-watch.js";
import { runCohortBenchmarkTick } from "./cohort-benchmark.js";
import { runEarningSurfacesTick } from "./earning-surfaces.js";
import { maybeWarnVeniceBalance } from "./venice-balance.js";
import { discoverAndSolveAggregations } from "./aggregation.js";
import { discoverAndSolveEmbeddings } from "./embedding-mining.js";
import { runApiMarketplaceTick } from "./api-marketplace-sell.js";
import { runProjectsReviewTick, runExecScoringTick } from "./projects.js";
import { runPeerReviewTick } from "./peer-review.js";
import { runBountyReviewTick } from "./bounty-review.js";
import { isRerunnableKind, isVerifyEligible, decideFromRerun, type RerunResult } from "./verify-kinds.js";
import { fetchNookPriceUsd } from "./nook-price.js";
import { runTeachingTick } from "./teaching.js";
import { runAttentionTick, runCollabFinderTick } from "./attention-signals.js";
import { runDiagnosticsTick } from "./diagnostics.js";
import { gatherEcosystemSummary } from "./ecosystem.js";
import { bootstrapSubscriptions, autoSpawnTunnel, shutdownTunnel } from "./subscriptions.js";
import { runSpecializationDriftTick } from "./specialization-drift.js";
import { acquireInstanceLock, releaseInstanceLock } from "./instance-lock.js";

const EVENTS_FILE = join(NOOK_DIR, "events.jsonl");
const AB_LOG = join(NOOK_DIR, "ab-applications.jsonl");
const AB_OUTCOMES = join(NOOK_DIR, "ab-outcomes.jsonl");
const KNOWLEDGE_LOG = join(NOOK_DIR, "knowledge-published.jsonl");

// ── Anti-farm verification abstention (2026-07-19) ─────────────────────────
// Quorum is a COUNT: scoring spam low still advances it toward payment, so
// the only real rejection is not verifying at all. Fingerprinted or
// near-duplicate traces are recorded (so future siblings match) and skipped
// WITHOUT a /verify POST. See src/trace-fingerprint.ts for the evidence.
const VERIFY_TRACE_CACHE = join(NOOK_DIR, "verify-trace-cache.jsonl");

// Warn-once registry for malformed (spam) CIDs — the pool re-surfaces the same
// fakes every poll; the skip decision is unchanged, only the log noise is.
const malformedCidWarned = new Set<string>();

/**
 * Permanent CID verdicts, persisted across restarts. All other skip state is
 * in-memory, so every launchd restart re-ran a detail GET (+ often a
 * comprehension POST) against the entire dead-CID spam pool (~770 subs at the
 * 08-05 count). Entries are loaded into finalizedSubmissionSkip at boot — the
 * poll filter and verifyOneSubmission already honor that cache, so no new
 * checks are needed. Append-only; entries older than the TTL are ignored at
 * load, which keeps a restart from resurrecting stale verdicts.
 */
const PERMANENT_CID_SKIPS = join(NOOK_DIR, "permanent-cid-skips.jsonl");
const PERMANENT_CID_SKIP_TTL_MS = 14 * 24 * 3600_000;

function persistPermanentCidSkip(id: string, reason: string): void {
  finalizedSubmissionSkip.markFor(id, PERMANENT_CID_SKIP_TTL_MS);
  appendJsonl(PERMANENT_CID_SKIPS, { ts: new Date().toISOString(), id, reason });
}

function loadPermanentCidSkips(): number {
  let restored = 0;
  for (const e of readJsonl<{ ts?: string; id?: string }>(PERMANENT_CID_SKIPS)) {
    if (!e.id || !e.ts) continue;
    const until = new Date(e.ts).getTime() + PERMANENT_CID_SKIP_TTL_MS;
    if (until > Date.now()) {
      finalizedSubmissionSkip.markUntil(e.id, until);
      restored++;
    }
  }
  return restored;
}

/**
 * Reason to abstain from verifying this trace, or null to proceed. Takes the
 * submission id so the near-dupe check can exclude the submission's OWN cache
 * entries — without that, a sub processed twice (overlapping polls, defer→
 * retry, restart) self-matched at 100% and was falsely abstained (~5/day).
 */
function verifyAbstainReason(subId: string, traceText: string): string | null {
  if (traceText.length < 200) return null; // CID-broken paths handle themselves downstream
  const fp = findTemplateFingerprint(traceText);
  if (fp) return `template fingerprint "${fp}"`;
  const prior = readJsonlTail<{ id?: string; snippet?: string }>(VERIFY_TRACE_CACHE, 60);
  const dupe = findNearDuplicateTrace(traceText, nearDupeCorpus(prior, subId));
  if (dupe) return `${Math.round(dupe.similarity * 100)}% near-dupe of a recently seen trace`;
  return null;
}

/**
 * Remember every trace we saw (clean or abstained) for the near-dupe check.
 * Idempotent per submission id (in-memory): re-processing a sub must not append
 * a second copy — duplicate records crowded genuine traces out of the 60-entry
 * anti-farm window (817 duplicate pairs measured 07-21→08-05).
 */
const recordedTraceIds = new Set<string>();
function recordTraceSeen(subId: string, traceText: string, abstained: string | null): void {
  if (traceText.length < 200) return;
  if (recordedTraceIds.has(subId)) return;
  recordedTraceIds.add(subId);
  appendJsonl(VERIFY_TRACE_CACHE, {
    ts: new Date().toISOString(),
    id: subId,
    snippet: traceText.slice(0, 1500),
    ...(abstained ? { abstained } : {}),
  });
}

// Challenge IDs we posted (royalty engine). The gateway 403s any attempt to
// verify submissions on your own challenge ("conflict of interest") — pre-skip
// them to save the trace fetch + verify attempt (observed 2026-07-15: repeated
// 403 burns against our posted challenges' submissions). 10-min cache; the
// file only grows by ~1 entry/day.
let ownChallengeCache: { ids: Set<string>; at: number } | null = null;
function isOwnChallenge(challengeId: string): boolean {
  if (!ownChallengeCache || Date.now() - ownChallengeCache.at > 10 * 60_000) {
    const ids = new Set(
      readJsonl<{ challengeId?: string; outcome?: string }>(join(NOOK_DIR, "challenges-posted.jsonl"))
        .filter((e) => e.challengeId && (e.outcome === "posted" || e.outcome === "posting"))
        .map((e) => e.challengeId!),
    );
    ownChallengeCache = { ids, at: Date.now() };
  }
  return ownChallengeCache.ids.has(challengeId);
}

interface NookplotEvent {
  type?: string;
  signal?: string;
  action?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  content?: string;
  target?: string;
}

interface OpportunityEvent {
  actionId?: string;
  actionType?: string;
  type?: string;
  bountyId?: number;
  description?: string;
  data?: Record<string, unknown>;
}

const SIGNALS_OF_INTEREST = new Set([
  "verification_opportunity",
  "bounty_application",
  "bounty.new",
  "mining_opportunity",
  "mention",
  "message.received",
]);

let rewardInterval: NodeJS.Timeout | null = null;
let bountyPollInterval: NodeJS.Timeout | null = null;
const seenBounties = new Set<number>();
const unfitBounties = new Set<number>();
const submittedBounties = new Set<number>();
const outcomeLogged = new Set<string>();
const publishedTitles = new Set<string>();
const MAX_APPLICATIONS = Number(process.env.BOT_BOUNTY_LIFECYCLE_MAX_APPS ?? 12);
const BOUNTY_FIT_THRESHOLD = Number(process.env.BOT_BOUNTY_FIT_THRESHOLD ?? 0.75);
let myAddress: string | null = null;
let myGuildId: number | null = null;

async function suggestAction(event: NookplotEvent): Promise<string> {
  const result = await chat(
    [
      {
        role: "system",
        content:
          "You are nookplot-bot's strategy advisor. Given a Nookplot event, decide if and how the agent should engage. Output 2-4 short lines: (1) verdict — ENGAGE/SKIP, (2) why, (3) suggested action if engage. Be concise.",
      },
      {
        role: "user",
        content: `Event:\n${JSON.stringify(event, null, 2).slice(0, 4000)}`,
      },
    ],
    { max_tokens: 250, model: pickModel("action_suggest") },
  );
  return result.content.trim();
}

async function scoreVerification(trace: string): Promise<{ scores: Record<string, number>; justification: string; skip?: boolean }> {
  const result = await chat(
    [
      {
        role: "system",
        content: "Score the reasoning trace on correctness, reasoning, efficiency, novelty (0-10 each). Output JSON: {scores:{correctness,reasoning,efficiency,novelty}, justification, skip:false}. If unscoreable output {skip:true,reason}.",
      },
      { role: "user", content: trace.slice(0, 8000) },
    ],
    { max_tokens: 300, temperature: 0.2, model: pickModel("verification_score") },
  );
  try {
    const parsed = JSON.parse(result.content.trim().replace(/```json|```/g, ""));
    if (parsed.skip) return { scores: {}, justification: parsed.reason || "skip", skip: true };
    return { scores: parsed.scores, justification: parsed.justification || "" };
  } catch {
    return { scores: { correctness: 5, reasoning: 5, efficiency: 5, novelty: 5 }, justification: result.content.trim() };
  }
}

async function evaluateBountyFit(description: string): Promise<{ fit: boolean; confidence: number; reasoning: string }> {
  const result = await chat(
    [
      {
        role: "system",
        content:
          'You evaluate bounty fit. Our agent does: research, technical analysis, code review, writing, knowledge synthesis. Output ONLY a JSON object on a single line, no prose, no code fences. Example: {"fit":true,"confidence":0.8,"reasoning":"matches research/writing skills"}. Confidence 0-1.',
      },
      { role: "user", content: description.slice(0, 4000) },
    ],
    { max_tokens: 200, temperature: 0.1, model: pickModel("fit_evaluate") },
  );
  const json = extractJson(result.content);
  if (!json) {
    console.log(`     [fit raw]: ${result.content.slice(0, 200).replace(/\n/g, " ")}`);
    return { fit: false, confidence: 0, reasoning: "parse error" };
  }
  try {
    const parsed = JSON.parse(json);
    return {
      fit: Boolean(parsed.fit ?? parsed.match ?? false),
      confidence: Number(parsed.confidence ?? parsed.conf ?? 0),
      reasoning: String(parsed.reasoning ?? parsed.reason ?? ""),
    };
  } catch (err) {
    console.log(`     [fit parse fail]: ${(err as Error).message} | raw: ${json.slice(0, 200)}`);
    return { fit: false, confidence: 0, reasoning: "parse error" };
  }
}

type AppVariant = "long" | "short";

const VARIANT_PROMPTS: Record<AppVariant, { system: string; maxTokens: number }> = {
  long: {
    system:
      "Write a focused bounty application (4-6 sentences, under 1900 characters). The message IS the work — show concretely how you'd approach the task, what tools/methods you'd use, and what deliverables you'd produce. Concrete, technical, no fluff, no greetings, no sign-off. Lead with the approach.",
    maxTokens: 320,
  },
  short: {
    system:
      "Write a tight bounty application (2-3 sentences max, ~50 words). State the approach in one sentence, the key deliverable in one sentence, optionally one concrete tool/method. No fluff, no greetings, no sign-off, no padding. Lead with the deliverable.",
    maxTokens: 120,
  },
};

function pickVariant(): AppVariant {
  return Math.random() < 0.5 ? "long" : "short";
}

interface ResearchContext {
  webResults: SearchResult[];
  arxivResults: SearchResult[];
  vaultHits: string[];
  knowledgeHits: string[];
  styleHint?: string;
}

async function gatherResearch(
  runtime: ReturnType<typeof getRuntime>,
  bounty: BountyRow,
  description: string,
): Promise<ResearchContext> {
  const title = bounty.title ?? "";
  const query = title || description.slice(0, 120);
  const [webResults, arxivResults] = await Promise.all([
    webSearch(query, { max: 4 }).catch(() => [] as SearchResult[]),
    arxivSearch(query, { max: 3 }).catch(() => [] as SearchResult[]),
  ]);
  const vaultNotes = vaultSearch(query, { max: 3 });
  const vaultHits = vaultNotes.map((n) => noteSummary(n, 200));
  let knowledgeHits: string[] = [];
  try {
    const res = (await runtime.memory.queryKnowledge?.({ search: query, limit: 5 } as any)) as
      | { items?: Array<{ title?: string; cid?: string; summary?: string }> }
      | undefined;
    knowledgeHits = (res?.items ?? []).map(
      (k) => `[[${k.title ?? "?"}]] cid=${k.cid?.slice(0, 14) ?? ""} — ${(k.summary ?? "").slice(0, 200)}`,
    );
  } catch {}
  let styleHint: string | undefined;
  if (bounty.creator) {
    const profile = await getCreatorStyleProfile(runtime, bounty.creator);
    if (profile) styleHint = profile.styleHint;
  }
  return { webResults, arxivResults, vaultHits, knowledgeHits, styleHint };
}

function formatContext(ctx: ResearchContext): string {
  const parts: string[] = [];
  if (ctx.styleHint) parts.push(`# Creator style preferences\n${ctx.styleHint}`);
  if (ctx.webResults.length) parts.push(`# Current web results\n${formatResultsForPrompt(ctx.webResults)}`);
  if (ctx.arxivResults.length) parts.push(`# Relevant arXiv papers\n${formatResultsForPrompt(ctx.arxivResults)}`);
  if (ctx.knowledgeHits.length) parts.push(`# Our prior knowledge-graph posts (cite these as evidence)\n${ctx.knowledgeHits.join("\n")}`);
  if (ctx.vaultHits.length) parts.push(`# Our local vault notes on related work\n${ctx.vaultHits.join("\n\n")}`);
  return parts.join("\n\n");
}

async function generateBountyApplication(
  description: string,
  variant: AppVariant,
  ctx: ResearchContext,
  model: string,
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
): Promise<{ message: string; critique: string }> {
  const cfg = VARIANT_PROMPTS[variant];
  const grounding = formatContext(ctx);
  const userMsg = grounding
    ? `Bounty brief:\n${description.slice(0, 3000)}\n\nGrounding context (cite specific sources where they sharpen the pitch — use [[wikilinks]] for our own posts, URL/source for external):\n${grounding.slice(0, 6000)}`
    : `Bounty brief:\n${description.slice(0, 4000)}`;
  const draftRes = await chat(
    [
      {
        role: "system",
        content: `${cfg.system} If the grounding context names specific tools, papers, or our prior posts, weave one or two in concretely.`,
      },
      { role: "user", content: userMsg },
    ],
    { max_tokens: cfg.maxTokens, temperature: 0.3, model, venice_parameters: VENICE_WEB_SEARCH, reasoning_effort },
  );
  const draft = draftRes.content.trim();
  const refined = await refine(description, draft, {
    critiqueMaxTokens: 200,
    reviseMaxTokens: cfg.maxTokens,
    lensHint: variant === "short" ? "Length budget is hard — 2-3 sentences max and under 1900 characters." : "Length budget: 4-6 sentences and under 1900 characters.",
    model,
  });
  return { message: truncateApplicationMessage(refined.revised), critique: refined.critique };
}

async function generateBountyWork(
  description: string,
  applicationMessage: string,
  ctx: ResearchContext,
): Promise<{ work: string; critique: string }> {
  const grounding = formatContext(ctx);
  const userContent = `Bounty:\n${description.slice(0, 3000)}\n\nMy proposal was:\n${applicationMessage.slice(0, 1500)}${grounding ? `\n\nGrounding context:\n${grounding.slice(0, 6000)}` : ""}`;
  const draftRes = await chat(
    [
      {
        role: "system",
        content:
          "Write the completed deliverable for this bounty as a structured technical markdown document (use ## headings; 600-1200 words). Concrete, opinionated, well-cited (use the grounding context's URLs/papers, our prior posts as [[wikilinks]]). No greetings, no meta-commentary. End with a short 'Caveats' or 'Open questions' section.",
      },
      { role: "user", content: userContent },
    ],
    { max_tokens: 2500, temperature: 0.25, model: pickModel("bounty_work"), venice_parameters: VENICE_WEB_SEARCH },
  );
  const draft = draftRes.content.trim();
  const refined = await refine(description, draft, {
    critiqueMaxTokens: 280,
    reviseMaxTokens: 2500,
    lensHint: "Output is a markdown deliverable, not a proposal. Length: 600-1200 words.",
    model: pickModel("bounty_work"),
  });
  return { work: refined.revised, critique: refined.critique };
}

function fmtEvent(event: NookplotEvent): string {
  const ts = event.timestamp?.slice(11, 19) ?? "??:??:??";
  const kind = event.signal ?? event.type ?? "?";
  const action = event.action ? ` [${event.action}]` : "";
  return `${ts} ${kind}${action}`;
}

function shouldAct(event: NookplotEvent): boolean {
  if (event.type === "nookplot.action_taken") return false;
  const kind = event.signal ?? event.type ?? "";
  return SIGNALS_OF_INTEREST.has(kind);
}

async function processNewLines(buffer: string[]): Promise<void> {
  for (const raw of buffer) {
    let event: NookplotEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    console.log(`· ${fmtEvent(event)}`);
    if (!shouldAct(event)) continue;
    console.log("  → asking Grok for verdict...");
    try {
      const verdict = await suggestAction(event);
      console.log(verdict.split("\n").map((line) => `    ${line}`).join("\n"));
      if (config.dryRun) {
        console.log("    (DRY_RUN=true — no automatic engagement)");
      }
    } catch (err) {
      console.warn(`  ⚠ verdict error: ${(err as Error).message}`);
    }
  }
}

async function followEventsFile(): Promise<void> {
  if (!existsSync(EVENTS_FILE)) {
    console.warn(`⚠ ${EVENTS_FILE} does not exist yet — start the daemon first (npm run online:start)`);
    return;
  }
  let lastSize = statSync(EVENTS_FILE).size;
  const flushFrom = (from: number): string[] => {
    const buf = readFileSync(EVENTS_FILE, "utf8").slice(from);
    return buf.split("\n").filter((l) => l.trim().length > 0);
  };
  await processNewLines(flushFrom(Math.max(0, lastSize - 4096)));
  watch(EVENTS_FILE, async () => {
    try {
      const size = statSync(EVENTS_FILE).size;
      if (size <= lastSize) {
        lastSize = size;
        return;
      }
      const lines = flushFrom(lastSize);
      lastSize = size;
      await processNewLines(lines);
    } catch (err) {
      console.warn(`watch error: ${(err as Error).message}`);
    }
  });
}

async function handleVerificationOpportunity(runtime: ReturnType<typeof getRuntime>, opp: OpportunityEvent) {
  const actionId = opp.actionId || (opp.data?.actionId as string);
  if (!actionId) return;
  console.log(`💎 verification opportunity: ${actionId}`);
  if (config.dryRun) {
    console.log("   (DRY_RUN — would score + completeAction)");
    return;
  }
  try {
    const trace = JSON.stringify(opp.data || opp, null, 2);
    const { scores, justification, skip } = await scoreVerification(trace);
    if (skip) {
      await runtime.proactive.rejectDelegatedAction(actionId, justification);
      console.log(`   → rejected: ${justification}`);
    } else {
      await runtime.proactive.completeAction(actionId, undefined, { scores, justification });
      console.log(`   ✅ completed: ${JSON.stringify(scores)}`);
    }
  } catch (err) {
    console.warn(`   ⚠ verification error: ${(err as Error).message}`);
  }
}

interface VerifiableSubmission {
  id: string;
  challenge_id?: string;
  solver_address?: string;
  trace_summary?: string;
  verifier_kind?: string | null;
  artifact_cid?: string | null;
  verification_count?: number;
  verification_quorum?: number;
  difficulty?: string;
  domain_tags?: string[];
}

interface SubmissionDetail {
  id?: string;
  traceCid?: string | null;
  traceSummary?: string | null;
  artifactCid?: string | null;
  verificationStatus?: { verificationCount?: number | string; verificationQuorum?: number | string };
}

let verificationInterval: NodeJS.Timeout | null = null;
const verifiedSubmissions = new Set<string>();
// Gate cache for the 422 "complete comprehension before verifying" / 422 ARTIFACT_INSPECTION_REQUIRED
// retry storm — gateway re-surfaces the same id in discover until quorum is hit,
// the in-memory verifiedSubmissions set covers most ticks, but on bot restart we
// re-attempt and burn another 4-5 SDK retries per id. 6h TTL keeps the set
// bounded and lets us catch up if the gateway ever fixes the underlying issue.
const COMPREHENSION_GATE_TTL_MS = 6 * 3600_000;
const comprehensionGateUntil = new Map<string, number>();
function isComprehensionGated(id: string): boolean {
  const until = comprehensionGateUntil.get(id);
  if (until == null) return false;
  if (Date.now() >= until) {
    comprehensionGateUntil.delete(id);
    return false;
  }
  return true;
}
function markComprehensionGated(id: string): void {
  comprehensionGateUntil.set(id, Date.now() + COMPREHENSION_GATE_TTL_MS);
}

// Persistent-502 retirement. A trace CID that fetches with a *deterministic*
// 502 (bad gateway = upstream IPFS never returns the content) is NOT a momentary
// blip — probing shows the same CIDs 502 on every retry across hours. That means
// the trace was never successfully pinned/propagated: it's a base58-valid but
// permanently-dead CID the shape check can't catch. Without this, each one
// re-defers every 6h FOREVER and keeps refilling the verify batch. We count
// transient trace-unavailable strikes per submission and, once a sub has failed
// FETCH_STRIKE_LIMIT times (≈ that many 6h cycles of grace for genuinely-slow
// IPFS propagation), retire it permanently like the hex-fake spam.
const FETCH_STRIKE_LIMIT = Number(process.env.BOT_VERIFY_FETCH_STRIKE_LIMIT ?? 3);
const traceFetchStrikes = new Map<string, number>();
/** Record a transient trace-fetch failure; returns true once the sub should be
 *  retired permanently (strikes exhausted) rather than deferred again. */
function recordFetchStrikeAndShouldRetire(id: string): boolean {
  const n = (traceFetchStrikes.get(id) ?? 0) + 1;
  traceFetchStrikes.set(id, n);
  return n >= FETCH_STRIKE_LIMIT;
}
function isComprehensionGateError(msg: string): boolean {
  return /complete the comprehension challenge before verifying/i.test(msg)
    || /ARTIFACT_INSPECTION_REQUIRED/i.test(msg);
}
// Re-synced from the rolling-24h shared count (verifySharedCount) at the start
// of every verify poll — no midnight/boot reset (the gateway's window is rolling,
// not calendar-day; see quotas.ts). In-poll increments prevent overspend before
// the next re-sync.
let verifyDailyCount = 0;
// Local per-day verify cap. The gateway enforces a *shared* verify+crowd-jury
// budget (VERIFY_SHARED_CAP, observed at 38) via canVerifyNow(); this local cap
// historically reserved headroom for crowd-jury. Crowd-jury is currently dormant
// (0 scores given), so capping pure verifies at 30 leaves ~8 shared slots unused
// each day. Make it tunable and default to the full shared budget so we don't
// idle slots; canVerifyNow() still hard-stops us at the gateway shared cap.
const VERIFY_DAILY_CAP = Number(process.env.BOT_VERIFY_DAILY_CAP ?? 38);
const VERIFY_POOL_FETCH_LIMIT = Number(process.env.BOT_VERIFY_POOL_FETCH_LIMIT ?? 200);

// (verifyDailyCount is re-synced from the rolling shared count each poll; the
// old calendar-midnight maybeResetDailyCount was removed — see quotas.ts.)
const SOLVER_DIVERSITY_WINDOW_MS = 14 * 24 * 3600_000;
const SOLVER_DIVERSITY_CAP = 3; // gateway gate is "3+ times in 14 days"

/**
 * Count how many times we've verified this solver_address in the last 14 days.
 * Reads ~/.nookplot/verification-stats.jsonl. The gateway will 429 us if we
 * try to verify the same solver 3+ times in that window — pre-skip to avoid it.
 */
function recentSolverVerifyCount(solverAddress: string): number {
  const path = join(NOOK_DIR, "verification-stats.jsonl");
  if (!existsSync(path)) return 0;
  const cutoff = Date.now() - SOLVER_DIVERSITY_WINDOW_MS;
  const target = solverAddress.toLowerCase();
  let count = 0;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts?: string; solver?: string | null };
        if (!entry.solver || entry.solver !== target) continue;
        if (!entry.ts || new Date(entry.ts).getTime() < cutoff) continue;
        count += 1;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count;
}

interface ComprehensionQuestion {
  id: string;
  question: string;
}

interface VerificationScore {
  correctnessScore: number;
  reasoningScore: number;
  efficiencyScore: number;
  noveltyScore: number;
  // Structured per-dimension rationales (gateway format change 2026-06-05,
  // ≥80 chars each). Sent alongside justification; unknown-field-tolerant
  // gateways ignore them, newer ones score them.
  correctnessRationale: string;
  reasoningEvaluation: string;
  efficiencyAssessment: string;
  noveltyAssessment: string;
  justification: string;
  knowledgeInsight: string;
  knowledgeDomainTags?: string[];
  skip?: string;
}

/**
 * Ensure a rationale clears the gateway's 80-char minimum by appending a
 * trace excerpt when the LLM's rationale ran short. Extraction-only — the
 * excerpt is verbatim trace content, never filler.
 */
function padRationale(text: string, dimension: string, trace: string): string {
  const t = text.trim();
  if (t.length >= 80) return t.slice(0, 500);
  const excerpt = trace.replace(/\s+/g, " ").trim().slice(0, 160);
  return `${t} For ${dimension}, judged against trace content: "${excerpt}"`.slice(0, 500);
}

async function answerComprehension(
  questions: ComprehensionQuestion[],
  trace: string,
): Promise<Record<string, string>> {
  if (questions.length === 0) return {};
  const qList = questions.map((q) => `${q.id}: ${q.question}`).join("\n");
  const result = await chat(
    [
      {
        role: "system",
        content:
          'Answer each comprehension question about the reasoning trace below. The questions test whether you actually read the trace. Output JSON only — an object keyed by question id with string answers. Each answer should be 1-3 sentences, anchored to specific content in the trace. Example: {"q1":"The author used gradient descent because...","q2":"The key finding was..."}. No prose outside the JSON.',
      },
      { role: "user", content: `# Trace\n\n${trace.slice(0, 6000)}\n\n# Questions\n\n${qList}` },
    ],
    { max_tokens: 600, temperature: 0.2, model: pickModel("verification_comprehension") },
  );
  const json = extractJson(result.content);
  if (!json) return Object.fromEntries(questions.map((q) => [q.id, `Based on the trace: ${trace.slice(0, 180)}`]));
  try {
    const parsed = JSON.parse(json);
    const out: Record<string, string> = {};
    for (const q of questions) {
      const v = parsed[q.id];
      out[q.id] = typeof v === "string" && v.length > 5 ? v : `The trace indicates: ${trace.slice(0, 180)}`;
    }
    return out;
  } catch {
    return Object.fromEntries(questions.map((q) => [q.id, `Based on the trace: ${trace.slice(0, 180)}`]));
  }
}

// traceTextFromIpfsPayload moved to ./trace-payload to keep it side-effect-free
// (importing index.ts triggers main()); see src/trace-payload.ts for unit tests.

/**
 * cidStatus tells the caller whether a missing full trace is worth retrying:
 *   "ok"        — full IPFS trace fetched
 *   "permanent" — malformed CID / gateway "Invalid CID format" 400; never resolves
 *   "transient" — 5xx / timeout; IPFS propagation, worth a 6h re-try
 *   "none"      — submission carries no CID at all
 * The pure classifiers (isWellFormedCid / isPermanentCidError) live in
 * trace-payload.ts so they're unit-testable without importing index.ts.
 */
// One-time schema-drift canary. When a detail payload carries CID-ish keys but
// extractTraceCid can't pull a CID from any of them, the field shape has
// changed — dump the key list + value shapes ONCE so the new schema is visible
// in the logs (and the alias list can be updated) instead of silently deferring
// the whole verify pool. Fires at most once per process.
let cidSchemaDumped = false;
function logCidSchemaOnce(id: string, keys: string[], detail: SubmissionDetail): void {
  if (cidSchemaDumped) return;
  cidSchemaDumped = true;
  const shapes: Record<string, string> = {};
  for (const k of keys) {
    const v = (detail as Record<string, unknown>)[k];
    shapes[k] =
      typeof v === "string" ? `str(${v.length}):${v.slice(0, 24)}`
      : v && typeof v === "object" ? `obj{${Object.keys(v as object).join(",")}}`
      : String(v);
  }
  console.warn(`   🔬 CID schema canary ${id.slice(0, 8)} — cid-ish keys present but none extractable: ${JSON.stringify(shapes)}`);
}

async function fetchSubmissionTrace(
  runtime: ReturnType<typeof getRuntime>,
  sub: VerifiableSubmission,
): Promise<{ trace: string; source: "ipfs" | "detail" | "summary"; hadCid: boolean; cidStatus: CidStatus; detail?: SubmissionDetail }> {
  let detail: SubmissionDetail | undefined;
  try {
    detail = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/${encodeURIComponent(sub.id)}`,
    )) as SubmissionDetail;
  } catch (err) {
    console.warn(`   ⚠ submission detail fetch failed: ${(err as Error).message.slice(0, 140)}`);
  }

  // Defensive multi-field extraction: the gateway has renamed/nested this field
  // before, and a single-field read silently turned every verifiable sub into
  // a no-CID deferral (the 0/30-verify-budget outage). extractTraceCid scans
  // aliases + nesting + embedded ipfs:// links.
  const traceCid = extractTraceCid(detail);
  if (!traceCid && detail) {
    const keys = cidBearingKeys(detail);
    if (keys.length > 0) logCidSchemaOnce(sub.id, keys, detail);
  }
  let cidStatus: CidStatus = traceCid ? "transient" : "none";
  if (traceCid) {
    if (!isWellFormedCid(traceCid)) {
      // Truncated/placeholder CID — don't even spend the round-trip. Warn once
      // per CID: the spam pool re-surfaces the same fakes every poll and each
      // one was a fresh log line (475 in 5 days).
      cidStatus = "permanent";
      if (!malformedCidWarned.has(traceCid)) {
        malformedCidWarned.add(traceCid);
        console.warn(`   ⚠ trace CID malformed (${traceCid.slice(0, 16)}…): ${cidRejectReason(traceCid)} — permanent skip`);
      }
    } else {
      let fullTrace: string | null = null;
      let fetchErr: string | null = null;
      // One bounded retry on a transient 5xx from the primary gateway: a CID
      // pinned only on the Nookplot node is invisible to the public fallback,
      // so a single 502 blip was burning fetch strikes on real submissions.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const payload = await runtime.connection.request("GET", `/v1/ipfs/${encodeURIComponent(traceCid)}`);
          fullTrace = traceTextFromIpfsPayload(payload);
          fetchErr = null;
          break;
        } catch (err) {
          fetchErr = (err as Error).message;
          if (attempt === 0 && isTransientIpfsGatewayError(fetchErr)) {
            await sleep(4000);
            continue;
          }
          break;
        }
      }
      // Gateway 502 / timeout / empty payload → try public IPFS gateways before
      // giving up, so a flaky gateway doesn't leave verify slots unused while
      // the slack-threshold is already free-firing. Skip the fallback only on a
      // permanent "Invalid CID format" (a bad hash won't resolve anywhere — and
      // this keeps our spam-CID load off the public gateways).
      if ((!fullTrace || fullTrace.trim().length === 0) && !(fetchErr && isPermanentCidError(fetchErr))) {
        const recovered = await fetchTraceViaPublicGateways(traceCid);
        if (recovered) {
          fullTrace = recovered;
          console.log(`   ↩ trace CID recovered via public IPFS gateway (${traceCid.slice(0, 12)})`);
        }
      }
      if (fullTrace && fullTrace.trim().length > 0) {
        const summary = detail?.traceSummary ?? sub.trace_summary ?? "";
        const trace = summary
          ? `# Trace summary\n\n${summary}\n\n# Full trace from ${traceCid}\n\n${fullTrace}`
          : fullTrace;
        return { trace, source: "ipfs", hadCid: true, cidStatus: "ok", detail };
      }
      // Still nothing after the fallback — classify for the re-defer decision.
      if (fetchErr) {
        cidStatus = isPermanentCidError(fetchErr) ? "permanent" : "transient";
        // First line only — gateway 502 bodies are multi-line HTML fragments
        // that smeared ~3 raw lines into the log per failure.
        console.warn(`   ⚠ trace CID fetch failed (${traceCid.slice(0, 12)}): ${fetchErr.split("\n")[0].slice(0, 140)}`);
      }
      // else: 200-but-empty and public fallback also empty → leave as transient
      // (the trace may pin/propagate later; a later poll will retry).
    }
  }

  const detailSummary = detail?.traceSummary?.trim();
  if (detailSummary) return { trace: detailSummary, source: "detail", hadCid: Boolean(traceCid), cidStatus, detail };
  return { trace: sub.trace_summary ?? "(no trace summary)", source: "summary", hadCid: Boolean(traceCid), cidStatus, detail };
}

async function scoreSubmissionTrace(trace: string, domainTags: string[] = []): Promise<VerificationScore | null> {
  const result = await chat(
    [
      {
        role: "system",
        content: VERIFY_CALIBRATION_PROMPT,
      },
      { role: "user", content: `Domain tags: ${domainTags.join(", ") || "(none)"}\n\nTrace:\n${trace.slice(0, 12000)}` },
    ],
    { max_tokens: 800, temperature: 0.2, model: pickModel("verification_score") },
  );
  const json = extractJson(result.content);
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (p.skip)
      return {
        correctnessScore: 0,
        reasoningScore: 0,
        efficiencyScore: 0,
        noveltyScore: 0,
        correctnessRationale: "",
        reasoningEvaluation: "",
        efficiencyAssessment: "",
        noveltyAssessment: "",
        justification: "",
        knowledgeInsight: "",
        skip: String(p.skip),
      };
    // Off-topic clamp: when correctness detects a topic mismatch, the other
    // dimensions can't honestly stay high — tables of irrelevant numbers were
    // earning efficiency 0.72 on admitted "no connection to the challenge"
    // traces. Deterministic post-clamp; the scorer prompt/calibration for
    // on-topic traces is untouched.
    return applyOffTopicClamp({
      correctnessScore: clampScore01(p.correctnessScore),
      reasoningScore: clampScore01(p.reasoningScore),
      efficiencyScore: clampScore01(p.efficiencyScore),
      noveltyScore: clampScore01(p.noveltyScore),
      correctnessRationale: padRationale(String(p.correctnessRationale ?? ""), "correctness", trace),
      reasoningEvaluation: padRationale(String(p.reasoningEvaluation ?? ""), "reasoning", trace),
      efficiencyAssessment: padRationale(String(p.efficiencyAssessment ?? ""), "efficiency", trace),
      noveltyAssessment: padRationale(String(p.noveltyAssessment ?? ""), "novelty", trace),
      justification: String(p.justification ?? "").slice(0, 500),
      knowledgeInsight: String(p.knowledgeInsight ?? "").slice(0, 500),
      knowledgeDomainTags: Array.isArray(p.knowledgeDomainTags) ? p.knowledgeDomainTags.slice(0, 5).map(String) : undefined,
    });
  } catch {
    return null;
  }
}

function clampScore01(n: unknown): number {
  const x = Number(n);
  if (Number.isNaN(x)) return 0.5;
  if (x > 1.5) return Math.max(0, Math.min(1, x / 10));
  return Math.max(0, Math.min(1, x));
}

// Successful rerun_submission_artifact calls this process — correlated against
// `exec` movement in the dimension-watch to test the exec hypothesis.
let artifactRerunCount = 0;

/**
 * Returns true when the submission was actually WORKED (any gateway/IPFS call
 * happened — verify, abstain-after-fetch, defer, error), false on a pure-local
 * no-op skip. The caller uses this to decide whether the 70s pacing sleep is
 * owed: sleeping after no-ops let a batch of own-challenge skips burn 11
 * consecutive polls doing nothing (07-31 verify blackout).
 */
async function verifyOneSubmission(runtime: ReturnType<typeof getRuntime>, sub: VerifiableSubmission): Promise<boolean> {
  if (verifiedSubmissions.has(sub.id)) return false;
  if (isComprehensionGated(sub.id)) return false;
  if (finalizedSubmissionSkip.isSkipped(sub.id)) return false;
  if (sub.solver_address && solverDiversityBlockedUntil.isSkipped(sub.solver_address.toLowerCase())) {
    verifiedSubmissions.add(sub.id);
    return false;
  }
  if (sub.solver_address && reciprocalVerifierSkipUntil.isSkipped(sub.solver_address.toLowerCase())) {
    verifiedSubmissions.add(sub.id);
    return false;
  }
  // Honor the shared gateway cap (verifies + crowd-jury combined). Once we've
  // hit the cap or seen a 429 today, we stop attempting to avoid the SDK
  // retry storm visible in the logs.
  if (!canVerifyNow()) {
    verifiedSubmissions.add(sub.id);
    return false;
  }
  if (verifyDailyCount >= VERIFY_DAILY_CAP) return false;
  // EXPERIMENT (additive): when BOT_VERIFY_ARTIFACTS=1, code-executing verifiable
  // kinds get the rerun-based verify path below instead of being skipped. Every
  // other non-standard kind (crowd_jury/prediction/exact_answer) skips as before.
  const tryArtifacts = process.env.BOT_VERIFY_ARTIFACTS === "1" && isRerunnableKind(sub.verifier_kind);
  if (sub.verifier_kind && sub.verifier_kind !== "standard" && !tryArtifacts) return false;
  // Per-solver diversity guard — gateway gates at 3+ verifications of the
  // same solver in 14 days. Pre-skip to avoid the 429 + wasted comprehension call.
  if (sub.solver_address) {
    const recentCount = recentSolverVerifyCount(sub.solver_address);
    if (recentCount >= SOLVER_DIVERSITY_CAP) {
      verifiedSubmissions.add(sub.id);
      console.log(`💎 ${sub.id.slice(0, 8)} — diversity skip (${recentCount} prior on solver ${sub.solver_address.slice(0, 10)})`);
      return false;
    }
  }
  // Own-challenge guard — must precede BOTH verify paths (the artifact rerun
  // path hits the same gateway 403). Normally pre-filtered at poll selection;
  // this is the belt-and-braces backstop for any other caller.
  if (sub.challenge_id && isOwnChallenge(sub.challenge_id)) {
    verifiedSubmissions.add(sub.id);
    console.log(`💎 ${sub.id.slice(0, 8)} — own-challenge skip (we posted ${sub.challenge_id.slice(0, 8)})`);
    return false;
  }
  if (tryArtifacts) {
    await verifyArtifactSubmission(runtime, sub);
    return true;
  }
  try {
    console.log(`💎 verifying submission ${sub.id.slice(0, 8)} (challenge=${sub.challenge_id?.slice(0, 8)}, kind=${sub.verifier_kind ?? "standard"})`);
    const fetchedTrace = await fetchSubmissionTrace(runtime, sub);
    console.log(`   📄 trace source=${fetchedTrace.source} len=${fetchedTrace.trace.length}`);
    // Anti-farm abstention: withhold the quorum increment entirely — a low
    // score would still advance the spam toward payment.
    const abstain = verifyAbstainReason(sub.id, fetchedTrace.trace);
    recordTraceSeen(sub.id, fetchedTrace.trace, abstain);
    if (abstain) {
      verifiedSubmissions.add(sub.id);
      console.log(`   ⛔ abstain — ${abstain}; no quorum credit, no verify slot spent`);
      return true;
    }
    // Probe comprehension FIRST — it decides whether a missing full trace is
    // actually fatal. Comprehension answers are graded by cosine similarity
    // (≥0.30) against the FULL IPFS trace, so a gated submission with no full
    // trace can't pass. But an UN-gated submission can still be verified from
    // the detail summary — the exact path no-CID submissions already take. So
    // we salvage the no-comprehension subset of the CID-broken pool instead of
    // blanket-skipping all of it (the pool is frequently ~all CID-broken).
    let questions: ComprehensionQuestion[] = [];
    try {
      const cRes = (await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/comprehension`, {})) as {
        questions?: ComprehensionQuestion[];
      };
      questions = cRes.questions ?? [];
    } catch (err) {
      console.warn(`   ⚠ comprehension request failed: ${(err as Error).message}`);
      verifiedSubmissions.add(sub.id);
      return true;
    }
    // Full trace unavailable. If comprehension is required (or the salvage is
    // disabled via BOT_VERIFY_DETAIL_FALLBACK=0) we can't pass: skip (permanent
    // CID, never resolves) or defer 6h (transient IPFS 5xx). Otherwise fall
    // through and verify from the detail summary.
    const traceUnavailable = fetchedTrace.hadCid && fetchedTrace.source !== "ipfs";
    if (traceUnavailable && (questions.length > 0 || process.env.BOT_VERIFY_DETAIL_FALLBACK === "0")) {
      const gateNote = questions.length > 0 ? " (comprehension-gated)" : "";
      if (fetchedTrace.cidStatus === "permanent") {
        verifiedSubmissions.add(sub.id);
        persistPermanentCidSkip(sub.id, "malformed/invalid trace CID");
        console.log(`   ⏭ trace CID permanently invalid${gateNote} — skipping ${sub.id.slice(0, 8)} (no re-defer)`);
        return true;
      }
      // Deterministic 502s mean dead/unpinned content — retire after a few
      // strikes instead of re-deferring every 6h indefinitely.
      if (recordFetchStrikeAndShouldRetire(sub.id)) {
        verifiedSubmissions.add(sub.id);
        traceFetchStrikes.delete(sub.id);
        persistPermanentCidSkip(sub.id, `trace unfetchable after ${FETCH_STRIKE_LIMIT} strikes (dead/unpinned CID)`);
        console.log(`   ⏭ trace persistently unfetchable (${FETCH_STRIKE_LIMIT} strikes${gateNote}) — retiring ${sub.id.slice(0, 8)} (dead/unpinned CID)`);
        return true;
      }
      markComprehensionGated(sub.id);
      console.log(`   ⏭ full trace unavailable (CID fetch failed${gateNote}) — deferring ${sub.id.slice(0, 8)} for ${COMPREHENSION_GATE_TTL_MS / 3600_000}h (strike ${traceFetchStrikes.get(sub.id)}/${FETCH_STRIKE_LIMIT})`);
      return true;
    }
    if (traceUnavailable) {
      console.log(`   🩹 no comprehension gate — verifying ${sub.id.slice(0, 8)} from detail summary (full trace unavailable)`);
    }
    if (questions.length > 0) {
      const answers = await answerComprehension(questions, fetchedTrace.trace);
      try {
        await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/comprehension/answers`, {
          answers,
        });
      } catch (err) {
        console.warn(`   ⚠ comprehension answers failed: ${(err as Error).message}`);
        verifiedSubmissions.add(sub.id);
        return true;
      }
    }
    const scored = await scoreSubmissionTrace(fetchedTrace.trace, sub.domain_tags ?? []);
    if (!scored) {
      console.warn(`   ⚠ score parse fail for ${sub.id.slice(0, 8)}`);
      verifiedSubmissions.add(sub.id);
      return true;
    }
    if (scored.skip) {
      console.log(`   → skip: ${scored.skip}`);
      verifiedSubmissions.add(sub.id);
      return true;
    }
    if (scored.justification.length < 50) {
      scored.justification = (scored.justification + " " + fetchedTrace.trace.slice(0, 120)).slice(0, 500);
    }
    if (scored.knowledgeInsight.length < 80) {
      scored.knowledgeInsight = `${scored.knowledgeInsight} The trace covers ${(sub.domain_tags ?? ["general"]).join(", ")} at ${sub.difficulty ?? "unspecified"} difficulty. ${fetchedTrace.trace.slice(0, 200)}`.slice(0, 500);
    }
    const res = await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/verify`, {
      correctnessScore: scored.correctnessScore,
      reasoningScore: scored.reasoningScore,
      efficiencyScore: scored.efficiencyScore,
      noveltyScore: scored.noveltyScore,
      correctnessRationale: scored.correctnessRationale,
      reasoningEvaluation: scored.reasoningEvaluation,
      efficiencyAssessment: scored.efficiencyAssessment,
      noveltyAssessment: scored.noveltyAssessment,
      justification: scored.justification,
      knowledgeInsight: scored.knowledgeInsight,
      knowledgeDomainTags: scored.knowledgeDomainTags ?? sub.domain_tags ?? [],
    });
    verifiedSubmissions.add(sub.id);
    traceFetchStrikes.delete(sub.id); // recovered after transient strikes — free the entry
    verifyDailyCount += 1;
    recordVerify();
    const sc = [scored.correctnessScore, scored.reasoningScore, scored.efficiencyScore, scored.noveltyScore]
      .map((s) => s.toFixed(2))
      .join("/");
    const shared = verifySharedCount();
    recordAudit("verify", "submitted", `scores=${sc}`, {
      submissionId: sub.id,
      domain: (sub.domain_tags ?? [])[0],
      traceSource: fetchedTrace.source,
    });
    console.log(`   ✅ verified ${sub.id.slice(0, 8)} scores=${sc} (${verifyDailyCount}/${VERIFY_DAILY_CAP} loc, ${shared}/${VERIFY_SHARED_CAP} shared)`);
    // Telemetry for variance check — low-variance scoring is also a flag pattern.
    // Also used by the per-solver diversity guard (recentSolverVerifyCount).
    appendJsonl(join(NOOK_DIR, "verification-stats.jsonl"), {
      ts: new Date().toISOString(),
      submissionId: sub.id,
      solver: sub.solver_address?.toLowerCase() ?? null,
      correctness: scored.correctnessScore,
      reasoning: scored.reasoningScore,
      efficiency: scored.efficiencyScore,
      novelty: scored.noveltyScore,
      domain: (sub.domain_tags ?? [])[0] ?? "general",
      traceSource: fetchedTrace.source,
    });
    writeNote(
      "research",
      `verification-${sub.id.slice(0, 12)}`,
      {
        id: `verification-${sub.id}`,
        title: `Verification of ${sub.id.slice(0, 12)}`,
        type: "verification",
        tags: ["verification", ...(sub.domain_tags ?? [])],
        submissionId: sub.id,
        challengeId: sub.challenge_id,
        solver: sub.solver_address,
        scores: [scored.correctnessScore, scored.reasoningScore, scored.efficiencyScore, scored.noveltyScore],
      },
      `## Trace source\n\n${fetchedTrace.source}\n\n## Trace excerpt\n\n${fetchedTrace.trace.slice(0, 2500)}\n\n## Scores (0-1)\n\n- correctness: ${scored.correctnessScore}\n- reasoning: ${scored.reasoningScore}\n- efficiency: ${scored.efficiencyScore}\n- novelty: ${scored.noveltyScore}\n\n## Justification\n\n${scored.justification}\n\n## Insight submitted\n\n${scored.knowledgeInsight}\n\n## Gateway response\n\n\`\`\`\n${JSON.stringify(res, null, 2).slice(0, 800)}\n\`\`\`\n`,
    );
  } catch (err) {
    verifiedSubmissions.add(sub.id);
    const msg = (err as Error).message;
    // If this is the shared-cap 429, mark the limit hit and halt further
    // attempts today (saves the SDK retry storm visible in the logs).
    if (isVerifyCapError(msg)) {
      recordVerifyLimitHit();
      console.warn(`   ⚠ verify shared cap hit (${VERIFY_SHARED_CAP}/day) — halting verify attempts until UTC midnight`);
    } else if (isComprehensionGateError(msg)) {
      markComprehensionGated(sub.id);
      console.warn(`   ⚠ comprehension/artifact gate on ${sub.id.slice(0, 8)} — skipping for ${COMPREHENSION_GATE_TTL_MS / 3600_000}h`);
    } else if (isFinalizedError(msg)) {
      finalizedSubmissionSkip.markFor(sub.id, FINALIZED_TTL_MS);
      console.warn(`   ⚠ ${sub.id.slice(0, 8)} already finalized — skipping for ${FINALIZED_TTL_MS / 3600_000}h`);
    } else if (isDiversityBlockError(msg) && sub.solver_address) {
      solverDiversityBlockedUntil.markFor(sub.solver_address.toLowerCase(), DIVERSITY_TTL_MS);
      console.warn(`   ⚠ solver ${sub.solver_address.slice(0, 10)} hit diversity cap — skipping all its subs for 14d`);
      maybeWarnDiversitySaturation();
    } else if (isReciprocalVerificationError(msg) && sub.solver_address) {
      reciprocalVerifierSkipUntil.markFor(sub.solver_address.toLowerCase(), RECIPROCAL_TTL_MS);
      const ttlH = (RECIPROCAL_TTL_MS / 3600_000).toFixed(0);
      console.warn(`   ⚠ solver ${sub.solver_address.slice(0, 10)} hit reciprocal mutual-pair cap — skipping their subs for ${ttlH}h`);
    } else {
      console.warn(`   ⚠ verify error for ${sub.id.slice(0, 8)}: ${msg.slice(0, 200)}`);
    }
  }
  return true;
}

/**
 * EXPERIMENT (additive, flag-gated by BOT_VERIFY_ARTIFACTS): verify a
 * code-executing verifiable submission — the surface the standard path skips.
 * Flow per the gateway: comprehension → inspect_submission_artifact (REQUIRED
 * gate) → rerun_submission_artifact (the `exec` / `artifactReruns` lever) →
 * POST /verify (deterministic verifier already proved correctness → auto-1.0;
 * we grade reasoning/efficiency/novelty). Hypothesis under test: the rerun moves
 * the `exec` reputation dimension. Standard-trace verification is untouched; a
 * failure anywhere here only skips this one submission.
 */
async function verifyArtifactSubmission(runtime: ReturnType<typeof getRuntime>, sub: VerifiableSubmission): Promise<void> {
  try {
    console.log(`💎🔁 verifying ARTIFACT submission ${sub.id.slice(0, 8)} (kind=${sub.verifier_kind})`);
    const fetchedTrace = await fetchSubmissionTrace(runtime, sub);
    // Anti-farm abstention — same gate as the standard path (the farm posts
    // artifact kinds too, and a rerun of templated junk still grants quorum).
    const abstain = verifyAbstainReason(sub.id, fetchedTrace.trace);
    recordTraceSeen(sub.id, fetchedTrace.trace, abstain);
    if (abstain) {
      verifiedSubmissions.add(sub.id);
      console.log(`   ⛔ abstain — ${abstain}; no quorum credit, no verify slot spent`);
      return;
    }

    // 1. Comprehension — prove we read the trace (same endpoints as standard).
    let questions: ComprehensionQuestion[] = [];
    try {
      const cRes = (await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/comprehension`, {})) as {
        questions?: ComprehensionQuestion[];
      };
      questions = cRes.questions ?? [];
    } catch (err) {
      console.warn(`   ⚠ comprehension request failed: ${(err as Error).message.slice(0, 120)}`);
      verifiedSubmissions.add(sub.id);
      return;
    }
    if (questions.length > 0) {
      const answers = await answerComprehension(questions, fetchedTrace.trace);
      try {
        await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/comprehension/answers`, { answers });
      } catch (err) {
        console.warn(`   ⚠ comprehension answers failed: ${(err as Error).message.slice(0, 120)}`);
        verifiedSubmissions.add(sub.id);
        return;
      }
    }

    // 2. Inspect the artifact — REQUIRED gate before /verify on artifact subs.
    let artifactText = "";
    try {
      const insp = (await runtime.tools.executeTool("inspect_submission_artifact", { submissionId: sub.id }))?.output as {
        artifactType?: string;
        artifact?: unknown;
      };
      artifactText = JSON.stringify(insp?.artifact ?? {}).slice(0, 6000);
      console.log(`   🔍 inspected artifact (${insp?.artifactType ?? "?"}, ${artifactText.length}c)`);
    } catch (err) {
      console.warn(`   ⚠ inspect_submission_artifact failed for ${sub.id.slice(0, 8)}: ${(err as Error).message.slice(0, 120)} — skipping`);
      verifiedSubmissions.add(sub.id);
      return;
    }

    // 3. Rerun the artifact — THE EXPERIMENT (the `exec` / artifactReruns lever)
    //    AND a real trust signal (does the artifact reproduce its claimed pass?).
    //    Optional + rate-limited (5/hr): a failure here must NOT block the verify.
    let rerunResult: RerunResult | null = null;
    try {
      const rr = (await runtime.tools.executeTool("rerun_submission_artifact", { submissionId: sub.id }))?.output as
        | (RerunResult & { exitCode?: number })
        | undefined;
      rerunResult = rr ?? null;
      artifactRerunCount += 1;
      // Capture the actual outcomes (not just the boolean) so a 15/15 match=false
      // run is DIAGNOSABLE: original=pass rerun=fail → env/flaky; original=pass
      // rerun=error → our sandbox couldn't build it; etc.
      const orig = JSON.stringify(rr?.originalOutcome ?? null).slice(0, 160);
      const reran = JSON.stringify(rr?.rerunOutcome ?? null).slice(0, 160);
      console.log(
        `   🔁 RERUN ${sub.id.slice(0, 8)}: match=${rr?.outcomesMatch ?? "?"} original=${orig} rerun=${reran} (rerun #${artifactRerunCount} this proc)`,
      );
      recordAudit("artifact_rerun", "submitted", `kind=${sub.verifier_kind} match=${rr?.outcomesMatch ?? "?"}`, {
        submissionId: sub.id,
        match: rr?.outcomesMatch ?? undefined,
        original: orig,
        rerun: reran,
      });
    } catch (err) {
      const m = (err as Error).message;
      console.warn(`   🔁 rerun skipped (${/429|rate/i.test(m) ? "rate-limited 5/hr" : m.slice(0, 80)})`);
    }

    // Decide correctness from the INDEPENDENT rerun rather than a blind 1.0.
    // If the rerun didn't reproduce the original outcome, abstain (don't vote)
    // instead of vouching either way — that protects our verifier reputation.
    const decision = decideFromRerun(rerunResult);
    if (decision.action === "abstain") {
      verifiedSubmissions.add(sub.id);
      recordAudit("verify", "skipped", decision.note, { submissionId: sub.id, kind: sub.verifier_kind ?? "?" });
      console.warn(`   ⚖️ abstain ${sub.id.slice(0, 8)}: ${decision.note}`);
      return;
    }

    // 4. Grade — correctness comes from the rerun decision above; we grade
    //    reasoning/efficiency/novelty from the trace + artifact code via the LLM.
    const gradeInput = `${fetchedTrace.trace}\n\n## Submitted artifact\n${artifactText}`;
    const scored = await scoreSubmissionTrace(gradeInput, sub.domain_tags ?? []);
    if (!scored || scored.skip) {
      console.log(`   → artifact verify skip${scored?.skip ? `: ${scored.skip}` : " (score parse fail)"}`);
      verifiedSubmissions.add(sub.id);
      return;
    }
    scored.correctnessScore = decision.correctness;
    if (scored.correctnessRationale.length < 30)
      scored.correctnessRationale = `Deterministic ${sub.verifier_kind} verifier — ${decision.note}.`;
    if (scored.justification.length < 50)
      scored.justification = (scored.justification + " " + gradeInput.slice(0, 120)).slice(0, 500);
    if (scored.knowledgeInsight.length < 80)
      scored.knowledgeInsight = `${scored.knowledgeInsight} Verifiable ${sub.verifier_kind} artifact in ${(sub.domain_tags ?? ["general"]).join(", ")}. ${artifactText.slice(0, 200)}`.slice(0, 500);

    await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/verify`, {
      correctnessScore: scored.correctnessScore,
      reasoningScore: scored.reasoningScore,
      efficiencyScore: scored.efficiencyScore,
      noveltyScore: scored.noveltyScore,
      correctnessRationale: scored.correctnessRationale,
      reasoningEvaluation: scored.reasoningEvaluation,
      efficiencyAssessment: scored.efficiencyAssessment,
      noveltyAssessment: scored.noveltyAssessment,
      justification: scored.justification,
      knowledgeInsight: scored.knowledgeInsight,
      knowledgeDomainTags: scored.knowledgeDomainTags ?? sub.domain_tags ?? [],
    });
    verifiedSubmissions.add(sub.id);
    verifyDailyCount += 1;
    recordVerify();
    const sc = [scored.correctnessScore, scored.reasoningScore, scored.efficiencyScore, scored.noveltyScore]
      .map((s) => s.toFixed(2))
      .join("/");
    recordAudit("verify", "submitted", `artifact scores=${sc}`, { submissionId: sub.id, kind: sub.verifier_kind ?? "?" });
    console.log(`   ✅🔁 verified ARTIFACT ${sub.id.slice(0, 8)} scores=${sc} (${verifyDailyCount}/${VERIFY_DAILY_CAP})`);
  } catch (err) {
    verifiedSubmissions.add(sub.id);
    const msg = (err as Error).message;
    if (isVerifyCapError(msg)) {
      recordVerifyLimitHit();
      console.warn(`   ⚠ verify shared cap hit — halting verify attempts until UTC midnight`);
    } else if (isComprehensionGateError(msg)) {
      markComprehensionGated(sub.id);
      console.warn(`   ⚠ comprehension/artifact gate on ${sub.id.slice(0, 8)} — skipping`);
    } else if (isFinalizedError(msg)) {
      finalizedSubmissionSkip.markFor(sub.id, FINALIZED_TTL_MS);
      console.warn(`   ⚠ ${sub.id.slice(0, 8)} already finalized — skipping`);
    } else if (isDiversityBlockError(msg) && sub.solver_address) {
      // Same per-solver 14d cap as the standard path. Mark the solver blocked so
      // we stop burning rate-limited reruns on the rest of their artifact subs.
      solverDiversityBlockedUntil.markFor(sub.solver_address.toLowerCase(), DIVERSITY_TTL_MS);
      console.warn(`   ⚠ solver ${sub.solver_address.slice(0, 10)} hit diversity cap — skipping all its subs for 14d`);
      maybeWarnDiversitySaturation();
    } else if (isReciprocalVerificationError(msg) && sub.solver_address) {
      reciprocalVerifierSkipUntil.markFor(sub.solver_address.toLowerCase(), RECIPROCAL_TTL_MS);
      console.warn(`   ⚠ solver ${sub.solver_address.slice(0, 10)} hit reciprocal mutual-pair cap — skipping their subs`);
    } else {
      console.warn(`   ⚠ artifact verify error for ${sub.id.slice(0, 8)}: ${msg.slice(0, 180)}`);
    }
  }
}

/**
 * Dimension-watch — append the 5 builder reputation dims to a time series so we
 * can ATTRIBUTE movement to the experiments: does `exec` rise as our rerun count
 * grows, and does `collab` rise after a substantive review lands? Read-only
 * (GET /v1/contributions/:addr); never gates anything.
 */
async function recordDimensionSnapshot(runtime: ReturnType<typeof getRuntime>): Promise<void> {
  if (!myAddress) return;
  try {
    const c = (await runtime.connection.request("GET", `/v1/contributions/${myAddress}`)) as {
      score?: number;
      velocityMultiplier?: number;
      breakdown?: Record<string, number>;
    };
    const b = c.breakdown ?? {};
    // All 10 gateway dimensions. The row logged only 5 until 2026-08-05 —
    // mirroring the SDK's stale 5-dim ScoreBreakdown type — which left
    // content=5000, social=2500, citations=3750, marketplace, launches
    // entirely unobserved: three large dims whose movement (or decay, cf. the
    // commits bleed at λ≈0.387%/day) was invisible and would have been
    // mis-attributed to the logged five.
    const row = {
      ts: new Date().toISOString(),
      score: c.score ?? 0,
      velocity: c.velocityMultiplier ?? 1,
      commits: b.commits ?? 0,
      exec: b.exec ?? 0,
      projects: b.projects ?? 0,
      lines: b.lines ?? 0,
      collab: b.collab ?? 0,
      content: b.content ?? 0,
      social: b.social ?? 0,
      marketplace: b.marketplace ?? 0,
      citations: b.citations ?? 0,
      launches: b.launches ?? 0,
      artifactRerunsThisProcess: artifactRerunCount,
    };
    appendJsonl(join(NOOK_DIR, "dimension-watch.jsonl"), row);
    console.log(
      `📐 dims: exec=${row.exec} collab=${row.collab} commits=${row.commits} projects=${row.projects} lines=${row.lines} ` +
      `content=${row.content} social=${row.social} marketplace=${row.marketplace} citations=${row.citations} launches=${row.launches} | reruns(this proc)=${artifactRerunCount}`,
    );
  } catch (err) {
    console.warn(`📐 dimension snapshot failed: ${(err as Error).message.slice(0, 100)}`);
  }
}

/**
 * Re-entrancy guard: the poll runs on a non-awaiting setInterval(5 min), but a
 * batch of ≥5 worked subs takes ≥350s of pacing sleeps — overlap is structural.
 * Overlapping polls re-selected in-flight submissions (invisible to
 * `verifiedSubmissions`, which is only marked at pass END), producing duplicate
 * fetch/comprehension work, 429 self-amplification, and near-dupe SELF-matches
 * (32 of the 74 measured false abstains had a <5min gap between passes).
 */
let verifyPollInFlight = false;

async function pollVerifiableSubmissions(runtime: ReturnType<typeof getRuntime>) {
  if (config.dryRun) {
    console.log("💎 (DRY_RUN — skipping verification poll)");
    return;
  }
  if (verifyPollInFlight) {
    console.log("💎 previous verification poll still running — skipping this tick");
    return;
  }
  // Re-sync the local counter to the rolling-24h shared count (matches the
  // gateway's window; frees slots as entries age out instead of a false midnight
  // reset). In-poll `verifyDailyCount += 1` increments then prevent overspend
  // before the next poll re-syncs.
  verifyDailyCount = verifySharedCount();
  // Shared-cap pre-flight: if we've blown the budget for the day, skip the
  // whole poll (saves the heavy /v1/mining/submissions/verifiable fetch too).
  if (!canVerifyNow()) {
    return;
  }
  if (verifyDailyCount >= VERIFY_DAILY_CAP) return;
  verifyPollInFlight = true;
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/verifiable?limit=${VERIFY_POOL_FETCH_LIMIT}`,
    )) as { submissions?: VerifiableSubmission[] };
    // Exclude already-handled subs AND those currently in their 6h defer
    // window. Without the gate filter, deferred (dead/transient) subs still
    // get selected into the batch and then no-op in verifyOneSubmission —
    // eating batch slots that should go to fetchable submissions. Own-challenge
    // subs are excluded here for the same reason: the in-function guard fires
    // AFTER batch selection, so a pool dominated by our own challenges fills
    // every slot with no-ops (07-31: 11 consecutive polls, 0 verify attempts,
    // self-amplified by the rescue/expert changes raising posts to 3-4/day).
    const raw = res.submissions ?? [];
    const ownChallengeCount = raw.filter((s) => s.challenge_id && isOwnChallenge(s.challenge_id)).length;
    if (ownChallengeCount > 0) {
      console.log(`💎 ${ownChallengeCount} own-challenge sub(s) excluded at poll selection`);
    }
    const subs = raw.filter(
      (s) =>
        !verifiedSubmissions.has(s.id) &&
        !isComprehensionGated(s.id) &&
        !finalizedSubmissionSkip.isSkipped(s.id) &&
        !(s.challenge_id && isOwnChallenge(s.challenge_id)),
    );
    // Standard reasoning traces are the default surface. EXPERIMENT: when
    // BOT_VERIFY_ARTIFACTS=1 we ALSO fold in code-executing verifiable kinds
    // (python_tests/javascript_tests/replication) — the rerun-able pool that
    // scores `exec`. They flow through the same sort/threshold/batch and get the
    // artifact verify path in verifyOneSubmission. Other kinds stay excluded.
    const verifyArtifacts = process.env.BOT_VERIFY_ARTIFACTS === "1";
    const standard = subs.filter((s) => isVerifyEligible(s.verifier_kind, verifyArtifacts));
    if (standard.length === 0) return;
    // Sort: PRIMARY = closest-to-quorum first (network-unblock leverage).
    // SECONDARY = least-prior-verified solver (diversity within tier).
    //
    // Why: the network is verifier-supply starved (81% v0, 9% v2). Pushing
    // a v2 sub to v3 actually clears NOOK to that solver and unsticks
    // the queue. Same effort as verifying a v0, ~3× more useful to the
    // network. Within a tier (e.g. all v2s), prefer solvers we haven't
    // already hit our 3-of-14d cap on — same diversity logic as before.
    //
    // Gateway returns verification_count as STRING — coerce.
    const vcountSub = (s: VerifiableSubmission): number => {
      const v = (s as { verification_count?: number | string }).verification_count;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };
    const solverPrior = new Map<string, number>();
    for (const sub of standard) {
      const addr = sub.solver_address?.toLowerCase();
      if (!addr) continue;
      if (!solverPrior.has(addr)) solverPrior.set(addr, recentSolverVerifyCount(addr));
    }
    standard.sort((a, b) => {
      // EXPERIMENT: when verifying artifacts, front-load the (usually few)
      // rerun-able code subs. They're typically v0 (vcount 0), so the normal
      // closest-to-quorum sort would bury them behind dozens of v1 standard
      // subs and we'd never generate rerun/exec data. Off → identical to before.
      if (verifyArtifacts) {
        const ar = isRerunnableKind(a.verifier_kind) ? 1 : 0;
        const br = isRerunnableKind(b.verifier_kind) ? 1 : 0;
        if (ar !== br) return br - ar;
      }
      const va = vcountSub(a);
      const vb = vcountSub(b);
      if (va !== vb) return vb - va; // higher verification_count first (closer to quorum)
      const ac = solverPrior.get(a.solver_address?.toLowerCase() ?? "") ?? 0;
      const bc = solverPrior.get(b.solver_address?.toLowerCase() ?? "") ?? 0;
      return ac - bc;
    });
    const tiered = { v0: 0, v1: 0, v2: 0, vHigh: 0 };
    for (const s of standard) {
      const v = vcountSub(s);
      if (v === 0) tiered.v0++;
      else if (v === 1) tiered.v1++;
      else if (v === 2) tiered.v2++;
      else tiered.vHigh++;
    }
    // Apply quota-aware threshold: skip low-leverage subs when we're
    // running tight on the daily cap (relative to how many hours of the
    // UTC day remain). Override with BOT_VERIFY_THRESHOLD=0 to disable
    // (free-fire on anything).
    const overrideStr = process.env.BOT_VERIFY_THRESHOLD;
    const threshold = overrideStr !== undefined
      ? Number(overrideStr)
      : verifyThreshold(verifyDailyCount, Date.now());
    // Rerun-able artifact subs (experiment) bypass the quota-aware threshold:
    // they're usually v0 and we want them verified to generate exec data, not
    // held back as "low-leverage." Flag-gated; no effect on the standard path.
    const eligible = standard.filter(
      (s) => vcountSub(s) >= threshold || (verifyArtifacts && isRerunnableKind(s.verifier_kind)),
    );
    const skipped = standard.length - eligible.length;
    const remaining = VERIFY_DAILY_CAP - verifyDailyCount;
    const hoursLeftUtc = (24 - new Date().getUTCHours() - new Date().getUTCMinutes() / 60).toFixed(1);
    console.log(
      `💎 found ${standard.length} verifiable (v2=${tiered.v2} v1=${tiered.v1} v0=${tiered.v0}${tiered.vHigh ? ` v3+=${tiered.vHigh}` : ""}) — threshold=v${threshold} (used ${verifyDailyCount}/${VERIFY_DAILY_CAP}, ${hoursLeftUtc}h left UTC); ${skipped} skipped`,
    );
    // Fallback: if the threshold blocked everything AND there are no v2s
    // anywhere, OR we're running out of hours, drop to threshold 0 so we
    // don't leave the day with unused slots. This is the user's "5 in
    // reserve until last hour, then use them on v0s" intuition,
    // generalized over the full day.
    let toProcess = eligible;
    // Drop threshold if it would idle us. Two triggers:
    //   (a) end-of-day insurance: <6h left and slots still unused
    //   (b) starvation: threshold blocked EVERY available sub right now
    //       (i.e. we'd otherwise idle waiting for v2s that may never appear).
    // Either way, prefer doing some work over hoarding slots for ghosts.
    if (toProcess.length === 0 && remaining > 0 && standard.length > 0) {
      toProcess = standard;
      const reason = Number(hoursLeftUtc) <= 6
        ? `${Number(hoursLeftUtc).toFixed(1)}h left UTC, ${remaining} slots unused`
        : `threshold blocked all ${standard.length} available; no v2s appearing — taking what's here`;
      console.log(`💎 threshold released — ${reason}`);
    }
    // Batch sizing: amortize remaining budget over expected polls before the
    // UTC reset, with a floor of 5/poll. At remaining=20 with 12 polls left,
    // fair-share = 2 → floor wins (5/poll). At remaining=20 with 2 polls
    // left, fair-share = 10 → take 10. Replaces the previous coarse ternary
    // (`remaining > cap/2 ? 8 : 5`) which had a visible cliff at remaining=14.
    const pollsLeft = pollsRemainingBeforeUtcReset(Number(hoursLeftUtc), 5);
    const baseBatch = computeVerifyBatch(remaining, pollsLeft);
    // If the eligible (threshold-passing) pool is thinner than the batch
    // size AND we still have skipped (v0) candidates, top up from those
    // BEFORE waiting for the next poll. Saves a full 5-min cycle when the
    // network is producing mostly v0 submissions.
    if (toProcess === eligible && eligible.length < baseBatch && remaining > 0) {
      const eligibleSet = new Set(eligible);
      const skippedCandidates = standard.filter((s) => !eligibleSet.has(s));
      const fillCount = Math.min(baseBatch - eligible.length, skippedCandidates.length);
      if (fillCount > 0) {
        toProcess = [...eligible, ...skippedCandidates.slice(0, fillCount)];
        console.log(`💎 batch topped up: ${eligible.length} eligible + ${fillCount} v0 fill = ${toProcess.length}`);
      }
    }
    const plannedBatch = toProcess.slice(0, baseBatch);
    // Pre-count solver-side diversity blockage *before* the loop so the metric
    // reflects what the loop will face. Three sources of pre-skip count:
    //   (a) gateway-confirmed diversity cache,
    //   (b) reciprocal mutual-pair cache (them → us),
    //   (c) in-memory recentSolverVerifyCount >= cap (we → them, the dominant path).
    if (plannedBatch.length > 0) {
      let blocked = 0;
      for (const s of plannedBatch) {
        const addr = s.solver_address?.toLowerCase();
        if (!addr) continue;
        if (
          solverDiversityBlockedUntil.isSkipped(addr) ||
          reciprocalVerifierSkipUntil.isSkipped(addr) ||
          (s.solver_address && recentSolverVerifyCount(s.solver_address) >= SOLVER_DIVERSITY_CAP)
        ) {
          blocked++;
        }
      }
      recordDiversityPollSaturation(blocked / plannedBatch.length);
      maybeWarnDiversityPollSaturation();
    }
    for (const sub of plannedBatch) {
      if (verifyDailyCount >= VERIFY_DAILY_CAP) break;
      const worked = await verifyOneSubmission(runtime, sub);
      // Pacing sleep only after real gateway work — a no-op skip must not cost
      // 70s (07-31: a batch of own-challenge no-ops burned every poll's budget).
      if (worked) await sleep(70 * 1000);
    }
    // End-of-poll budget telemetry — surfaces under-utilization at a glance.
    if (Number(hoursLeftUtc) <= 4 && verifyDailyCount < VERIFY_DAILY_CAP - 5) {
      console.warn(`   ⚠ verify budget under-used: ${verifyDailyCount}/${VERIFY_DAILY_CAP} with ${hoursLeftUtc}h left`);
    }
  } catch (err) {
    console.warn(`   ⚠ verification poll error: ${(err as Error).message}`);
  } finally {
    verifyPollInFlight = false;
  }
}

async function startVerificationLoop(runtime: ReturnType<typeof getRuntime>) {
  const restoredSkips = loadPermanentCidSkips();
  if (restoredSkips > 0) console.log(`💎 restored ${restoredSkips} permanent CID skip(s) from disk`);
  setTimeout(() => pollVerifiableSubmissions(runtime), 30 * 1000);
  verificationInterval = setInterval(() => pollVerifiableSubmissions(runtime), 5 * 60 * 1000);
  // Dimension-watch: snapshot the builder dims every 30 min to attribute exec/
  // collab movement to the experiments (read-only, never gates).
  setTimeout(() => safe("dimensionWatch", () => recordDimensionSnapshot(runtime)), 90 * 1000);
  setInterval(() => safe("dimensionWatch", () => recordDimensionSnapshot(runtime)), 30 * 60 * 1000);
  // RLM spot-check verification — separate 10/day cap, separate queue.
  setTimeout(() => runRlmSpotCheckLoop(runtime), 90 * 1000);
  setInterval(() => runRlmSpotCheckLoop(runtime), 8 * 60 * 1000);
}

async function handleBountyOpportunity(runtime: ReturnType<typeof getRuntime>, opp: OpportunityEvent) {
  const bountyId = opp.bountyId || (opp.data?.bountyId as number);
  const description = opp.description || (opp.data?.description as string) || "";
  if (!bountyId) return;
  if (seenBounties.has(bountyId) || unfitBounties.has(bountyId)) return;
  const partial: BountyRow = {
    id: bountyId,
    title: (opp.data?.title as string) ?? "",
    description,
    creator: opp.data?.creator as string | undefined,
    community: opp.data?.community as string | undefined,
  };
  await applyToBountyIfFit(runtime, partial, description);
}

/**
 * Gateway-side mining reward claim. `runtime.economy.*` covers the platform
 * economy (credits/bounties) — the *mining* reward pool is a separate surface
 * served by /v1/mining/stats/agent + /v1/mining/royalties/claim. We hit both.
 *
 * `claimableBalance` is a map of source → NOOK amount, e.g.
 *   { epoch_verification: 9960.09, epoch_solver: 0, rlm_collab: 0, ... }
 * Sources with > 0 are claimed off-chain (gateway records the claim); on-chain
 * settlement happens separately via the Merkle-proof flow which needs gas.
 */
async function claimMiningRewards(runtime: ReturnType<typeof getRuntime>): Promise<void> {
  if (!myAddress) return;
  // Step 1: off-chain ledger claim. Wraps in its own try so on-chain still
  // runs even if the off-chain path errors.
  try {
    const stats = (await runtime.connection.request(
      "GET",
      `/v1/mining/stats/agent/${encodeURIComponent(myAddress)}`,
    )) as {
      claimableBalance?: Record<string, number>;
      pendingRewards?: number;
      totalEarned?: number;
    };
    const balance = stats.claimableBalance ?? {};
    const sources = Object.entries(balance).filter(([, v]) => (v ?? 0) > 0);
    if (sources.length === 0) {
      if ((stats.pendingRewards ?? 0) > 0) {
        console.log(`💎 mining: 0 claimable, ${stats.pendingRewards!.toFixed(1)} pending (awaits epoch settlement)`);
      }
    } else {
      console.log(
        `💎 mining claimable: ${sources.map(([k, v]) => `${k}=${(v as number).toFixed(1)}`).join(", ")}`,
      );
      let totalClaimed = 0;
      for (const [sourceType] of sources) {
        try {
          const res = (await runtime.connection.request("POST", "/v1/mining/royalties/claim", { sourceType })) as { claimed?: number };
          if (res.claimed) totalClaimed += res.claimed;
        } catch (err) {
          console.warn(`   ⚠ claim ${sourceType} failed: ${(err as Error).message}`);
        }
      }
      if (totalClaimed > 0) {
        console.log(`💎 mining claimed off-chain: ${totalClaimed.toFixed(2)} NOOK (recorded on gateway ledger)`);
        // Stamp the NOOK→USD price at claim time so the day's USD value is frozen
        // and doesn't drift retroactively with future price moves. Best-effort —
        // null on fetch failure, in which case the dashboard falls back to live.
        const spot = await fetchNookPriceUsd().catch(() => null);
        appendJsonl(join(NOOK_DIR, "mining-claims.jsonl"), {
          ts: new Date().toISOString(),
          kind: "off-chain",
          claimed: totalClaimed,
          sources: sources.map(([k, v]) => ({ source: k, amount: v })),
          priceUsdAtClaim: spot?.usd,
          priceSourceAtClaim: spot?.source,
        });
      }
    }
  } catch (err) {
    console.warn(`   ⚠ mining reward check failed: ${(err as Error).message}`);
  }
  // Step 2: on-chain Merkle claim. Always runs (so we sweep prior epochs
  // even if there's no new off-chain claimable). Gasless via gateway relay.
  await claimMiningOnChain(runtime);
}

/**
 * On-chain Merkle claim. Once an epoch settles + the gateway publishes the
 * Merkle root, our `cumulativeAmount` becomes claimable on-chain via
 * `MiningRewardPool.claim(amount, proof)`. The flow is:
 *
 *   1. GET /v1/mining/proof/:addr → { cumulativeAmount, proof[], merkleRoot }
 *   2. POST /v1/prepare/mining/claim with { cumulativeAmount, proof }
 *      → returns an unsigned ForwardRequest + EIP-712 context
 *   3. Sign locally with our private key
 *   4. POST /v1/relay → relayer broadcasts, we don't pay gas
 *
 * `runtime.connection.request` + the shared signing helper handle 2-4.
 * Idempotent: gateway returns the same cumulativeAmount until we've claimed
 * more than that on-chain, so calling repeatedly is safe.
 *
 * Toggle off with BOT_AUTO_ONCHAIN_CLAIM=0.
 */
async function claimMiningOnChain(runtime: ReturnType<typeof getRuntime>): Promise<void> {
  if (process.env.BOT_AUTO_ONCHAIN_CLAIM === "0") return;
  if (!myAddress) return;
  try {
    const proof = (await runtime.connection.request(
      "GET",
      `/v1/mining/proof/${encodeURIComponent(myAddress)}`,
    )) as {
      hasProof?: boolean;
      cumulativeAmount?: number | string;
      cumulativeAmountRaw?: string;
      proof?: string[];
      epochNumber?: number;
      merkleRoot?: string;
    };
    // Gateway returns cumulativeAmount as a string sometimes — coerce.
    const cumulative = typeof proof.cumulativeAmount === "string"
      ? Number(proof.cumulativeAmount)
      : (proof.cumulativeAmount ?? 0);
    if (!proof.hasProof || !proof.proof || proof.proof.length === 0 || !cumulative || !Number.isFinite(cumulative)) {
      return; // nothing publishable yet
    }
    const claimLog = readJsonlSafe<{ kind: string; onChainCumulative?: number }>(
      join(NOOK_DIR, "mining-claims.jsonl"),
    );
    const lastOnChain = claimLog
      .filter((e) => e.kind === "on-chain" && typeof e.onChainCumulative === "number")
      .reduce((m, e) => Math.max(m, e.onChainCumulative ?? 0), 0);
    if (cumulative <= lastOnChain + 1e-6) {
      return; // already claimed this epoch's amount
    }
    console.log(
      `💎 on-chain claim available: ${cumulative.toFixed(2)} NOOK cumulative (epoch ${proof.epochNumber ?? "?"})`,
    );
    // CRITICAL: send the raw uint256 wei value if the gateway provides it.
    // JS Numbers lose precision past 2^53 — `29014.9721... * 1e18` does NOT
    // equal `29014972155216056700000` exactly. The on-chain Merkle leaf was
    // built with the exact wei amount, so a rounded value reverts the
    // contract (proof verification fails). We pass BOTH so the gateway can
    // pick whichever it actually uses.
    const claimBody: Record<string, unknown> = {
      proof: proof.proof,
      cumulativeAmount: typeof proof.cumulativeAmount === "string"
        ? proof.cumulativeAmount  // preserve string form to avoid float coercion
        : cumulative,
    };
    if (proof.cumulativeAmountRaw) {
      claimBody.cumulativeAmountRaw = proof.cumulativeAmountRaw;
    }
    const relayRes = (await runtime.connection.request(
      "POST",
      "/v1/prepare/mining/claim",
      claimBody,
    )) as { forwardRequest?: unknown; domain?: unknown; types?: unknown };
    if (!relayRes.forwardRequest) {
      console.warn("   ⚠ on-chain claim prepare returned no ForwardRequest — skipping");
      return;
    }
    // Sign + relay using the runtime's signing helper. Lazy import to avoid
    // top-level coupling (signing is in @nookplot/runtime).
    const { signForwardRequest } = await import("@nookplot/runtime");
    const pk = process.env.NOOKPLOT_AGENT_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY;
    if (!pk || pk.includes("replace")) {
      console.warn("   ⚠ on-chain claim needs NOOKPLOT_AGENT_PRIVATE_KEY — skipping");
      return;
    }
    const fwd = relayRes.forwardRequest as Record<string, string | number>;
    const dom = relayRes.domain as Record<string, unknown>;
    const types = relayRes.types as Record<string, unknown>;
    const signature = await signForwardRequest(pk, dom, types, fwd);
    const tx = (await runtime.connection.request(
      "POST",
      "/v1/relay",
      { ...fwd, signature },
    )) as { txHash?: string; error?: string };
    if (tx.txHash) {
      console.log(`💎 on-chain claim relayed: tx=${tx.txHash} amount=${cumulative.toFixed(2)} NOOK`);
      appendJsonl(join(NOOK_DIR, "mining-claims.jsonl"), {
        ts: new Date().toISOString(),
        kind: "on-chain",
        txHash: tx.txHash,
        onChainCumulative: cumulative,
        epochNumber: proof.epochNumber,
      });
    } else {
      console.warn(`   ⚠ relay returned no txHash: ${JSON.stringify(tx).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`   ⚠ on-chain claim failed: ${(err as Error).message}`);
  }
}

/** Read JSONL but tolerate missing files. */
function readJsonlSafe<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function claimRewards(runtime: ReturnType<typeof getRuntime>) {
  if (config.dryRun) {
    console.log("🏆 (DRY_RUN — would check earnings + claim)");
    return;
  }
  try {
    const earnings = await runtime.economy.getEarnings();
    if (earnings?.claimable > 0) {
      const res = await runtime.economy.claimEarnings();
      console.log(`💎 claimed ${res.claimed} tx=${res.txHash}`);
    }
    const weekly = await runtime.economy.getWeeklyRewards(3);
    console.log(`🏆 weekly rewards: ${weekly?.rewards?.length || 0} epochs`);
  } catch (err) {
    console.warn(`   ⚠ reward error: ${(err as Error).message}`);
  }
  // Mining-pool rewards live on a separate surface — claim those too.
  await claimMiningRewards(runtime);
}

async function startRewardLoop(runtime: ReturnType<typeof getRuntime>) {
  await claimRewards(runtime);
  rewardInterval = setInterval(() => claimRewards(runtime), 30 * 60 * 1000);
}

interface BountyRow {
  id: string | number;
  status?: number;
  title?: string;
  description?: string;
  community?: string;
  creator?: string;
  deadline?: string | number;
  applicationCount?: number;
  submissionCount?: number;
  rewardAmount?: string;
  tokenAddress?: string;
}

// Bounty creators to skip (comma-separated addresses in BOT_CREATOR_BLOCKLIST).
// Use for creators whose bounties you've concluded aren't winnable on merit —
// your judgment, your list; ships empty.
const CREATOR_BLOCKLIST = new Set<string>(
  (process.env.BOT_CREATOR_BLOCKLIST ?? "")
    .split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
);

interface BountyApplication {
  id: string;
  status: "pending" | "approved" | "rejected" | string;
  applicantAddress: string;
  applicantName?: string;
  message?: string;
}

async function fetchMyApplication(
  runtime: ReturnType<typeof getRuntime>,
  bountyId: number,
): Promise<BountyApplication | null> {
  if (!myAddress) return null;
  const res = (await runtime.connection.request(
    "GET",
    `/v1/bounties/${bountyId}/applications?first=100`,
  )) as { applications?: BountyApplication[] };
  const apps = res.applications ?? [];
  const me = myAddress.toLowerCase();
  return apps.find((a) => a.applicantAddress?.toLowerCase() === me) ?? null;
}

async function submitBountyWork(
  runtime: ReturnType<typeof getRuntime>,
  bounty: BountyRow,
  workMarkdown: string,
) {
  const bountyId = typeof bounty.id === "string" ? parseInt(bounty.id, 10) : (bounty.id as number);
  const title = (bounty.title ?? `Bounty #${bountyId}`).slice(0, 180);
  const community = bounty.community || config.defaultCommunity;
  let cid: string | undefined;
  try {
    const pub = await runtime.memory.publishKnowledge({
      title: `${title} — deliverable`,
      body: workMarkdown,
      community,
      tags: ["bounty-deliverable", `bounty-${bountyId}`],
    });
    cid = pub.cid;
    console.log(`   📌 pinned to knowledge graph: cid=${cid} tx=${pub.txHash ?? "(unsigned)"}`);
  } catch (err) {
    console.warn(`   ⚠ publishKnowledge failed (${(err as Error).message}) — submitting without CID`);
  }
  const content = cid
    ? `Deliverable: see CID ${cid} (published to ${community}).\n\n${workMarkdown}`
    : workMarkdown;
  return runtime.connection.request("POST", `/v1/bounties/${bountyId}/submissions`, {
    content,
    deliverableCids: cid ? [cid] : [],
  });
}

async function processBountyLifecycle(runtime: ReturnType<typeof getRuntime>) {
  try {
    const result = (await runtime.bounties.list({ first: 50 })) as
      | { bounties?: BountyRow[]; data?: BountyRow[] }
      | BountyRow[];
    const list: BountyRow[] = Array.isArray(result)
      ? result
      : result.bounties ?? result.data ?? [];
    if (list.length === 0) return;
    const now = Date.now() / 1000;
    const open = list.filter((b) => {
      if (b.status !== 0) return false;
      const deadline = typeof b.deadline === "string" ? parseInt(b.deadline, 10) : b.deadline ?? 0;
      if (deadline && deadline < now) return false;
      if (b.creator && CREATOR_BLOCKLIST.has(b.creator.toLowerCase())) return false;
      return true;
    });
    if (open.length === 0) return;
    console.log(`🔍 lifecycle scan: ${open.length} Open bounties (of ${list.length} total)`);
    for (const b of open) {
      const bid = typeof b.id === "string" ? parseInt(b.id, 10) : (b.id as number);
      if (!bid) continue;
      const description = [b.title, b.description].filter(Boolean).join(" — ");
      const mine = await fetchMyApplication(runtime, bid);

      if (!mine) {
        if (seenBounties.has(bid) || unfitBounties.has(bid)) continue;
        if ((b.applicationCount ?? 0) > MAX_APPLICATIONS) {
          console.log(`   ⏭  #${bid} skip — ${b.applicationCount} applicants (cap ${MAX_APPLICATIONS})`);
          seenBounties.add(bid);
          continue;
        }
        await applyToBountyIfFit(runtime, b, description);
        continue;
      }

      if (mine.status === "rejected") {
        if (!outcomeLogged.has(mine.id)) {
          appendJsonl(AB_OUTCOMES, { ts: new Date().toISOString(), bountyId: bid, appId: mine.id, outcome: "rejected" });
          outcomeLogged.add(mine.id);
        }
        seenBounties.add(bid);
        continue;
      }
      if (mine.status === "pending") {
        console.log(`   ⏳ #${bid} pending creator approval (app ${mine.id.slice(0, 8)})`);
        continue;
      }
      if (mine.status === "approved") {
        if (!outcomeLogged.has(mine.id)) {
          appendJsonl(AB_OUTCOMES, { ts: new Date().toISOString(), bountyId: bid, appId: mine.id, outcome: "approved" });
          outcomeLogged.add(mine.id);
        }
        if (submittedBounties.has(bid)) continue;
        if (config.dryRun) {
          console.log(`   🎉 #${bid} APPROVED — (DRY_RUN, would submit work)`);
          submittedBounties.add(bid);
          continue;
        }
        try {
          console.log(`   🎉 #${bid} APPROVED — gathering research…`);
          const ctx = await gatherResearch(runtime, b, description);
          console.log(`   📚 ctx: web=${ctx.webResults.length} arxiv=${ctx.arxivResults.length} vault=${ctx.vaultHits.length} kg=${ctx.knowledgeHits.length}`);
          const { work, critique } = await generateBountyWork(description, mine.message ?? "", ctx);
          const res = await submitBountyWork(runtime, b, work);
          writeNote(
            "bounties",
            `bounty-${bid}-submission`,
            {
              id: `bounty-${bid}-submission`,
              title: b.title ?? `Bounty #${bid}`,
              type: "bounty-submission",
              tags: ["bounty-submission", b.community ?? "general"],
              bountyId: bid,
              community: b.community,
              applicationId: mine.id,
              webSources: ctx.webResults.map((r) => r.url),
              arxivSources: ctx.arxivResults.map((r) => r.url),
              critique,
            },
            `## Brief\n\n${description}\n\n## My application\n\n${mine.message ?? "(none recorded)"}\n\n## Submission\n\n${work}\n\n## Self-critique that drove the revision\n\n${critique}\n`,
          );
          console.log(`   ✅ submitted work for #${bid}: ${JSON.stringify(res).slice(0, 160)}`);
          submittedBounties.add(bid);
        } catch (err) {
          console.warn(`   ⚠ submit-work error for #${bid}: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`   ⚠ bounty lifecycle error: ${(err as Error).message}`);
  }
}

async function applyToBountyIfFit(
  runtime: ReturnType<typeof getRuntime>,
  bounty: BountyRow,
  description: string,
) {
  const bountyId = typeof bounty.id === "string" ? parseInt(bounty.id, 10) : (bounty.id as number);
  if (!bountyId) return;
  // Hard kill-switch — when creators aren't actioning existing apps, applying
  // to more just burns inference. Re-enable with BOT_BOUNTY_APPLY=1.
  if (process.env.BOT_BOUNTY_APPLY === "0") {
    return; // silent — don't even log discovery
  }
  console.log(`💰 bounty #${bountyId}: ${description.slice(0, 80)}`);
  if (config.dryRun) {
    console.log("   (DRY_RUN — would evaluate + apply)");
    return;
  }
  try {
    const fit = await evaluateBountyFit(description);
    // High-fit only by default. The live bounty queue is saturated and our
    // pending backlog is not converting yet, so weak applications are negative
    // signal even when the relay fee is small.
    if (!fit.fit || fit.confidence < BOUNTY_FIT_THRESHOLD) {
      console.log(`   → skip (fit=${fit.fit}, conf=${fit.confidence}, thr=${BOUNTY_FIT_THRESHOLD}): ${fit.reasoning.slice(0, 100)}`);
      if (fit.reasoning !== "parse error") unfitBounties.add(bountyId);
      return;
    }
    console.log(`   🔎 gathering research…`);
    const ctx = await gatherResearch(runtime, bounty, description);
    console.log(`   📚 ctx: web=${ctx.webResults.length} arxiv=${ctx.arxivResults.length} vault=${ctx.vaultHits.length} kg=${ctx.knowledgeHits.length}${ctx.styleHint ? " creator-style✓" : ""}`);
    const variant = pickVariant();
    const ab = pickModelAB("bounty_draft");
    const { message, critique } = await generateBountyApplication(description, variant, ctx, ab.model, ab.reasoning_effort);
    const finalMessage = truncateApplicationMessage(message);
    const res = (await runtime.connection.request("POST", `/v1/bounties/${bountyId}/apply`, {
      message: finalMessage,
    })) as { application?: { id?: string } };
    const appId = res.application?.id;
    appendJsonl(AB_LOG, {
      ts: new Date().toISOString(),
      bountyId,
      variant,
      model: ab.model,
      modelPool: ab.pool,
      appId,
      messageLen: finalMessage.length,
      message: finalMessage,
      truncated: finalMessage.length < message.length,
    });
    writeNote(
      "bounties",
      `bounty-${bountyId}-application`,
      {
        id: `bounty-${bountyId}-application`,
        title: bounty.title ?? `Bounty #${bountyId}`,
        type: "bounty-application",
        tags: ["bounty-application", bounty.community ?? "general", variant, ab.model],
        bountyId,
        community: bounty.community,
        creator: bounty.creator,
        variant,
        model: ab.model,
        appliedAt: new Date().toISOString(),
        appId,
        webSources: ctx.webResults.map((r) => r.url),
      },
      `## Brief\n\n${description}\n\n## Our application (variant: ${variant}, model: ${ab.model})\n\n${finalMessage}\n\n## Self-critique that drove revision\n\n${critique}\n\n## Sources consulted\n\n${ctx.webResults.map((r) => `- ${r.title} — ${r.url}`).join("\n") || "(none)"}\n`,
    );
    console.log(`   ✅ applied to #${bountyId} [${variant}/${ab.model}, ${finalMessage.length}ch]: app=${appId?.slice(0, 8)}`);
  } catch (err) {
    console.warn(`   ⚠ bounty apply error: ${(err as Error).message}`);
  }
}

async function startBountyPoller(runtime: ReturnType<typeof getRuntime>) {
  await processBountyLifecycle(runtime);
  bountyPollInterval = setInterval(() => processBountyLifecycle(runtime), 2 * 60 * 1000);
}

// Fast-apply path for WebSocket bounty.new events. Skips research + refine for
// minimal latency. Target ~5-10s end-to-end so we beat slow-but-thorough bots
// on simple briefs. Lifecycle scan still does the full pipeline for misses.
async function applyToBountyFast(
  runtime: ReturnType<typeof getRuntime>,
  bounty: BountyRow,
  description: string,
) {
  const bountyId = typeof bounty.id === "string" ? parseInt(bounty.id, 10) : (bounty.id as number);
  if (!bountyId) return;
  if (config.dryRun) {
    console.log(`⚡ (DRY_RUN — would fast-apply to #${bountyId})`);
    return;
  }
  if (seenBounties.has(bountyId) || unfitBounties.has(bountyId)) return;
  if ((bounty.applicationCount ?? 0) > MAX_APPLICATIONS) {
    seenBounties.add(bountyId);
    console.log(`⚡ fast-apply skip #${bountyId} — ${bounty.applicationCount} applicants (cap ${MAX_APPLICATIONS})`);
    return;
  }
  seenBounties.add(bountyId);
  try {
    const startMs = Date.now();
    const fit = await evaluateBountyFit(description);
    if (!fit.fit || fit.confidence < BOUNTY_FIT_THRESHOLD) {
      unfitBounties.add(bountyId);
      console.log(`⚡ fast-apply skip #${bountyId} — fit=${fit.fit} conf=${fit.confidence} thr=${BOUNTY_FIT_THRESHOLD}`);
      return;
    }
    const model = pickModel("bounty_draft");
    const res = await chat(
      [
        {
          role: "system",
          content:
            "Write a 2-3 sentence bounty application (~50-70 words, under 1900 characters). State the approach in one sentence, the deliverable in one sentence, optionally one specific tool/method. No fluff, no greetings, no sign-off, no padding. Lead with the deliverable. Output the message text only, no JSON.",
        },
        { role: "user", content: `Brief:\n${description.slice(0, 2500)}` },
      ],
      { max_tokens: 200, temperature: 0.25, model },
    );
    const message = truncateApplicationMessage(res.content.trim());
    if (message.length < 40) {
      console.warn(`⚡ fast-apply rejected (drafted too short: ${message.length}ch)`);
      return;
    }
    const apply = (await runtime.connection.request("POST", `/v1/bounties/${bountyId}/apply`, {
      message,
    })) as { application?: { id?: string } };
    const appId = apply.application?.id;
    const wallMs = Date.now() - startMs;
    appendJsonl(AB_LOG, {
      ts: new Date().toISOString(),
      bountyId,
      variant: "fast",
      model,
      modelPool: "fast-path",
      appId,
      messageLen: message.length,
      message,
      wallMs,
    });
    writeNote(
      "bounties",
      `bounty-${bountyId}-application`,
      {
        id: `bounty-${bountyId}-application`,
        title: bounty.title ?? `Bounty #${bountyId}`,
        type: "bounty-application",
        tags: ["bounty-application", bounty.community ?? "general", "fast", model],
        bountyId,
        community: bounty.community,
        creator: bounty.creator,
        variant: "fast",
        model,
        appliedAt: new Date().toISOString(),
        appId,
      },
      `## Brief\n\n${description}\n\n## Our application (fast-path, ${wallMs}ms wall, model: ${model})\n\n${message}\n`,
    );
    console.log(`⚡ fast-applied to #${bountyId} in ${wallMs}ms [${model}, ${message.length}ch]: app=${appId?.slice(0, 8)}`);
  } catch (err) {
    console.warn(`   ⚠ fast-apply error #${bountyId}: ${(err as Error).message}`);
  }
}

async function handleNewBountyEvent(runtime: ReturnType<typeof getRuntime>, eventData: Record<string, unknown>) {
  const idRaw = (eventData.id ?? eventData.bountyId ?? eventData.onchainBountyId) as string | number | undefined;
  if (idRaw === undefined) {
    console.log("   ⚠ bounty.new: no id in event payload");
    return;
  }
  const bid = typeof idRaw === "string" ? parseInt(idRaw, 10) : idRaw;
  if (!bid || Number.isNaN(bid)) return;
  if (seenBounties.has(bid) || unfitBounties.has(bid)) return;
  const creator = (eventData.creator as string | undefined)?.toLowerCase();
  if (creator && CREATOR_BLOCKLIST.has(creator)) {
    console.log(`   🚫 bounty.new #${bid} blocked creator`);
    return;
  }
  const title = (eventData.title as string | undefined) ?? "";
  const desc = (eventData.description as string | undefined) ?? "";
  const description = [title, desc].filter(Boolean).join(" — ");
  console.log(`⚡ bounty.new #${bid} — fast-apply path`);
  const bounty: BountyRow = {
    id: bid,
    title,
    description: desc,
    creator: (eventData.creator as string | undefined),
    community: (eventData.community as string | undefined),
    applicationCount: (eventData.applicationCount as number | undefined) ?? 0,
  };
  // FAST path: no research, no refine — race to the apply endpoint.
  // We've already accepted the WebSocket signal; speed beats polish on
  // simple briefs. Lifecycle scan picks up bounties WS missed with the
  // full pipeline.
  await applyToBountyFast(runtime, bounty, description);
}

const KNOWLEDGE_CATEGORIES = [
  "decentralized verification protocols and reputation systems",
  "on-chain agent coordination patterns",
  "knowledge graph design for AI agents",
  "reasoning trace evaluation and scoring rubrics",
  "citation economics in distributed knowledge networks",
  "multi-agent benchmarking methodology",
  "retrieval-augmented generation for technical writing",
  "Constitutional AI vs RLHF: practical tradeoffs",
  "agent memory architectures: episodic, semantic, procedural",
  "ERC-8004 agent identity standards in practice",
  "code review heuristics for AI-generated patches",
  "mining challenge design in proof-of-knowledge networks",
  "skill-graph routing for agent marketplaces",
  "off-chain dispute resolution for bounty platforms",
  "meta-transaction relay design and gas economics",
  "WebSocket reliability patterns for long-lived agent connections",
];

let knowledgeInterval: NodeJS.Timeout | null = null;

async function generateKnowledgeTopic(): Promise<{ title: string; angle: string } | null> {
  const seed = KNOWLEDGE_CATEGORIES[Math.floor(Math.random() * KNOWLEDGE_CATEGORIES.length)];
  const result = await chat(
    [
      {
        role: "system",
        content:
          'Propose one specific, substantive technical topic to write a 1200-1500 word knowledge post about. Output JSON only: {"title":"...","angle":"..."} where title is 5-12 words and angle is one sentence framing the unique perspective (a specific tension, contrarian take, or under-explored aspect).',
      },
      { role: "user", content: `Category: ${seed}\n\nAvoid generic surveys. Pick a specific, opinionated angle.` },
    ],
    { max_tokens: 200, temperature: 0.8, model: pickModel("knowledge_topic") },
  );
  const json = extractJson(result.content);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed.title || !parsed.angle) return null;
    return { title: String(parsed.title).slice(0, 180), angle: String(parsed.angle) };
  } catch {
    return null;
  }
}

async function generateKnowledgeBody(title: string, angle: string): Promise<string> {
  const result = await chat(
    [
      {
        role: "system",
        content:
          "Write a substantive 1200-1500 word technical markdown post. Concrete, opinionated, well-structured. No greeting, no meta-commentary, no 'In conclusion'. Lead with the strongest claim. " +
          "GROUNDING: you have web search — any specific number, benchmark, or measured claim MUST come from a real source found via search and be attributed to it inline (name the source). If you cannot source a number, make the point without one. NEVER invent measurements or present estimates as measured results. " +
          "Vary the structure to fit the argument (do not reuse a fixed heading template). End with a short 'Open questions' section listing 2-3 unresolved threads. Markdown only.",
      },
      { role: "user", content: `Title: ${title}\n\nAngle: ${angle}\n\nWrite the post.` },
    ],
    { max_tokens: 3500, temperature: 0.3, model: pickModel("knowledge_body"), venice_parameters: VENICE_WEB_SEARCH },
  );
  return result.content.trim();
}

async function publishOneKnowledgeItem(runtime: ReturnType<typeof getRuntime>) {
  // Kill-switch (2026-07-15): corpus audit found 96% of the 192 published
  // posts on two rigid scaffolds, ~18% of the vault re-telling 3 security
  // topics (16 SSRF permutations), and identical fabricated benchmark numbers
  // presented as measurements across unrelated domains. Paused via
  // BOT_KNOWLEDGE_PUBLISH=0 until the pipeline gets scaffold variation and an
  // anti-repeat gate.
  if (process.env.BOT_KNOWLEDGE_PUBLISH === "0") return;
  if (config.dryRun) {
    console.log("📚 (DRY_RUN — skipping knowledge publish)");
    return;
  }

  // Try grounded sources first — these cite real network artifacts.
  let post: KnowledgePost | null = null;
  try {
    post = await findGroundedPost(runtime);
  } catch (err) {
    console.warn(`📚 grounded source check failed: ${(err as Error).message}`);
  }

  if (post) {
    console.log(`📚 publishing grounded [${post.source}]: "${post.title}"`);
  } else if (lastFallbackDays() < 1) {
    console.log(`📚 no grounded material; last fallback was ${(lastFallbackDays() * 24).toFixed(1)}h ago, staying silent`);
    return;
  } else {
    // Daily fallback (was weekly): ensure we never go silent for more than ~24h.
    // Grounded sources still preferred — fallback only fires when nothing else has material.
    console.log(`📚 no grounded source; using daily fallback`);
    for (let attempt = 0; attempt < 4; attempt++) {
      const topic = await generateKnowledgeTopic();
      if (!topic) continue;
      const titleKey = topic.title.toLowerCase().trim();
      // Check only — adding to the cache here made the post-generation dup
      // check below ALWAYS fire on our own key, so every fallback post was
      // generated (LLM spend) and then discarded before publish. The cache
      // add happens after all gates pass, below.
      if (publishedTitles.has(titleKey)) continue;
      const body = await generateKnowledgeBody(topic.title, topic.angle);
      post = {
        title: topic.title,
        body,
        tags: ["agent-generated", "research", "weekly-fallback"],
        source: "fallback",
        anchorKey: titleKey,
      };
      break;
    }
    if (!post) {
      console.log("📚 fallback gen failed; skipping");
      return;
    }
  }

  const titleKey = post.title.toLowerCase().trim();
  if (publishedTitles.has(titleKey)) {
    console.log(`📚 dup title (already in cache); skipping`);
    return;
  }
  // Semantic near-dupe gate (2026-07-15): exact-match dedupe let 16 SSRF
  // title-permutations through in a month ("ssrf-defense-using-…-filtering" /
  // "ssrf-defense-via-…-blocking" / "ssrf-mitigation-through-…"), all the same
  // recipe. Same tokenizer+threshold as the challenge poster, vs the last 60
  // days of published titles.
  const priorKnowledge = readJsonl<{ ts: string; title?: string; error?: string }>(KNOWLEDGE_LOG)
    .filter((e) => e.title && !e.error)
    .map((e) => ({ ts: e.ts, title: e.title! }));
  const cutoff = Date.now() - 60 * 86_400_000;
  const knowledgeCorpus = priorKnowledge.filter((e) => new Date(e.ts).getTime() >= cutoff);
  const nearDupe = findNearDuplicate(post.title, knowledgeCorpus);
  if (nearDupe) {
    console.log(`📚 near-dupe of "${nearDupe.title.slice(0, 60)}" (${(nearDupe.similarity * 100).toFixed(0)}%); skipping [${post.source}]`);
    recordAnchor({ source: post.source, key: post.anchorKey, title: post.title });
    return;
  }
  publishedTitles.add(titleKey);

  try {
    const res = await runtime.memory.publishKnowledge({
      title: post.title,
      body: post.body,
      community: config.defaultCommunity,
      tags: post.tags,
    });
    const unsigned = !res.txHash;
    if (unsigned) {
      console.warn(`   ⚠ on-chain anchor missing — cid=${res.cid} (IPFS OK, relay failed).`);
    }
    appendJsonl(KNOWLEDGE_LOG, {
      ts: new Date().toISOString(),
      title: post.title,
      cid: res.cid,
      txHash: res.txHash,
      bodyLen: post.body.length,
      unsigned,
      source: post.source,
      anchorKey: post.anchorKey,
    });
    recordAnchor({ source: post.source, key: post.anchorKey, title: post.title });
    writeNote(
      "posts",
      post.title,
      {
        id: `post-${res.cid?.slice(0, 12)}`,
        title: post.title,
        type: "knowledge-post",
        tags: ["knowledge-post", ...post.tags],
        cid: res.cid,
        txHash: res.txHash,
        community: config.defaultCommunity,
        source: post.source,
        anchorKey: post.anchorKey,
      },
      `## Source\n\n${post.source} (anchor: ${post.anchorKey})\n\n## Post\n\n${post.body}\n`,
    );
    console.log(`   ✅ published cid=${res.cid} tx=${res.txHash ?? "(unsigned)"} [${post.source}]`);
  } catch (err) {
    const e = err as Error & { cause?: unknown; response?: unknown };
    const detail = JSON.stringify(
      { message: e.message, cause: e.cause, response: e.response },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    ).slice(0, 2000);
    console.warn(`   ⚠ knowledge publish error: ${e.message}`);
    console.warn(`     full: ${detail}`);
    appendJsonl(KNOWLEDGE_LOG, {
      ts: new Date().toISOString(),
      title: post.title,
      error: e.message,
      errorDetail: detail,
      source: post.source,
    });
  }
}

async function startKnowledgePublishLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => publishOneKnowledgeItem(runtime), 90 * 1000);
  // 4-hour cadence — most ticks will stay silent if no grounded source is ready,
  // and the weekly fallback gate caps generic posts at 1/week.
  knowledgeInterval = setInterval(() => publishOneKnowledgeItem(runtime), 4 * 60 * 60 * 1000);
}

let miningInterval: NodeJS.Timeout | null = null;
let crowdJuryInterval: NodeJS.Timeout | null = null;
let learningsInterval: NodeJS.Timeout | null = null;
let predictionsInterval: NodeJS.Timeout | null = null;
let socialInterval: NodeJS.Timeout | null = null;

async function startMiningLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(
    () => discoverAndSolveMiningChallenges(runtime, { dryRun: config.dryRun, myAddress, guildId: myGuildId }),
    60 * 1000,
  );
  miningInterval = setInterval(
    () => discoverAndSolveMiningChallenges(runtime, { dryRun: config.dryRun, myAddress, guildId: myGuildId }),
    15 * 60 * 1000,
  );
}

async function startCrowdJuryLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => scoreCrowdJurySubmissions(runtime, { dryRun: config.dryRun }), 2 * 60 * 1000);
  crowdJuryInterval = setInterval(
    () => scoreCrowdJurySubmissions(runtime, { dryRun: config.dryRun }),
    10 * 60 * 1000,
  );
}

async function startLearningsLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => publishPostSolveLearnings(runtime, { dryRun: config.dryRun }), 5 * 60 * 1000);
  learningsInterval = setInterval(
    () => publishPostSolveLearnings(runtime, { dryRun: config.dryRun }),
    30 * 60 * 1000,
  );
}

async function startPredictionsLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => submitPredictions(runtime, { dryRun: config.dryRun }), 8 * 60 * 1000);
  predictionsInterval = setInterval(
    () => submitPredictions(runtime, { dryRun: config.dryRun }),
    60 * 60 * 1000,
  );
}

async function startSocialLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => endorseHelpfulAgents(runtime, { dryRun: config.dryRun, myAddress }), 10 * 60 * 1000);
  socialInterval = setInterval(
    () => endorseHelpfulAgents(runtime, { dryRun: config.dryRun, myAddress }),
    60 * 60 * 1000,
  );
}

let engagementInterval: NodeJS.Timeout | null = null;
let observationInterval: NodeJS.Timeout | null = null;
let bountyInterval: NodeJS.Timeout | null = null;
let clarificationInterval: NodeJS.Timeout | null = null;
let swarmInterval: NodeJS.Timeout | null = null;
let swarmHeartbeatInterval: NodeJS.Timeout | null = null;
let weeklyRewardsInterval: NodeJS.Timeout | null = null;
let teachingInterval: NodeJS.Timeout | null = null;
let attentionInterval: NodeJS.Timeout | null = null;
let diagnosticsInterval: NodeJS.Timeout | null = null;
let ecosystemInterval: NodeJS.Timeout | null = null;

async function startEngagementLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => runEngagementLoop(runtime, { dryRun: config.dryRun, myAddress }), 12 * 60 * 1000);
  engagementInterval = setInterval(
    () => runEngagementLoop(runtime, { dryRun: config.dryRun, myAddress }),
    2 * 60 * 60 * 1000,
  );
}

async function startObservationLoop(runtime: ReturnType<typeof getRuntime>) {
  // Self-introspection. First tick at 20min so we have some signal to observe.
  // Default 4h (was hourly): the observer earns no NOOK, and at hourly-on-opus
  // it was ~25% of total Venice spend (2026-07-04 cost audit).
  const everyMin = Number(process.env.BOT_OBSERVE_INTERVAL_MIN) || 240;
  setTimeout(() => runObservationTick(runtime, { dryRun: config.dryRun }), 20 * 60 * 1000);
  observationInterval = setInterval(
    () => runObservationTick(runtime, { dryRun: config.dryRun }),
    everyMin * 60 * 1000,
  );
}

// ─── MCP-derived tracks ─────────────────────────────────────────────────
// Each loop is independently env-toggleable from its own module; the timers
// here only wire up the cadence. Every callback swallows its own errors so
// one failed track never affects the others.

function safe<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  return fn().catch((err) => {
    console.warn(`⚠ ${label}: ${(err as Error).message.slice(0, 150)}`);
    return undefined;
  });
}

async function startBountyLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("bountyTick", () => runBountyTick(runtime)), 4 * 60_000);
  bountyInterval = setInterval(() => safe("bountyTick", () => runBountyTick(runtime)), 30 * 60_000);
}

async function startClarificationsLoop(runtime: ReturnType<typeof getRuntime>) {
  // Pass a generator only when BOT_CLARIFY_AUTO_OFFER=1; the tick itself
  // ignores the generator unless that flag is set.
  const opts = process.env.BOT_CLARIFY_AUTO_OFFER === "1"
    ? { generateAnswer: generateClarificationAnswer }
    : undefined;
  setTimeout(() => safe("clarifyTick", () => runClarificationsTick(runtime, opts)), 7 * 60_000);
  clarificationInterval = setInterval(
    () => safe("clarifyTick", () => runClarificationsTick(runtime, opts)),
    20 * 60_000,
  );
}

async function startSwarmsLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("swarmTick", () => runSwarmsTick(runtime)), 9 * 60_000);
  swarmInterval = setInterval(() => safe("swarmTick", () => runSwarmsTick(runtime)), 25 * 60_000);
  // Heartbeat any held subtasks every 2 min. The gateway reassigns a claimed
  // subtask after its claim_timeout_seconds (the heartbeat_subtask action wants
  // a ping every 2-5 min); the old 30-min cadence silently lost every claim.
  const heartbeatMs = Number(process.env.BOT_SWARM_HEARTBEAT_MS ?? 2 * 60_000);
  swarmHeartbeatInterval = setInterval(
    () => safe("swarmHeartbeat", () => heartbeatHeldSubtasks(runtime)),
    heartbeatMs,
  );
  // Auto-solve held subtasks (default OFF). Cadence wider — solving is expensive.
  if (process.env.BOT_SWARM_AUTO_SOLVE === "1") {
    setTimeout(() => safe("swarmAutoSolve", () => runSwarmsAutoSolveTick(runtime)), 12 * 60_000);
    setInterval(() => safe("swarmAutoSolve", () => runSwarmsAutoSolveTick(runtime)), 60 * 60_000);
  }
}

async function startWeeklyRewardsLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("weeklyRewardsTick", () => runWeeklyRewardsTick(runtime)), 11 * 60_000);
  weeklyRewardsInterval = setInterval(
    () => safe("weeklyRewardsTick", () => runWeeklyRewardsTick(runtime)),
    6 * 3600_000,
  );
  // Knowledge-bundle pass (royalty flywheel) — daily check, internally
  // throttled to one bundle per 7d and a min-new-CIDs threshold.
  setTimeout(() => safe("bundleTick", () => runBundleTick(runtime, myAddress)), 17 * 60_000);
  setInterval(() => safe("bundleTick", () => runBundleTick(runtime, myAddress)), 24 * 3600_000);
  // Challenge-posting channel (5% poster pool) — HOURLY, tick self-caps at
  // 1/epoch-day. Hourly, not 8h: the royalty needs a verified solve of our
  // challenge before the 02:00Z settlement, so a failed draft must retry in
  // 1h (an 8h gap between attempts cost the 06-22 and 06-29 epochs their full
  // 250k), and the ≤6h-to-settlement rescue path needs ticks to fire in that
  // window at all. Once posted, the tick is a cheap counter check.
  setTimeout(() => safe("challengePostTick", () => runChallengePostTick(runtime)), 23 * 60_000);
  setInterval(() => safe("challengePostTick", () => runChallengePostTick(runtime)), 3600_000);
  // Manifest broadcast + intents browse — every 4h. The manifest declares
  // our verifier-coverage need (direct payout impact if it attracts one).
  setTimeout(() => safe("manifestTick", () => runManifestTick(runtime, pendingSubsFromSnapshot())), 19 * 60_000);
  setInterval(() => safe("manifestTick", () => runManifestTick(runtime, pendingSubsFromSnapshot())), 4 * 3600_000);
  setTimeout(() => safe("intentsTick", () => runIntentsTick(runtime)), 21 * 60_000);
  setInterval(() => safe("intentsTick", () => runIntentsTick(runtime)), 4 * 3600_000);
  // Inbox watch — reads the working /v1/inbox/threads view (the flat list
  // 500s), surfaces new DMs to the log, and refreshes the dashboard snapshot.
  // First run soon after boot so the dashboard inbox panel populates quickly.
  setTimeout(() => safe("inboxWatchTick", () => runInboxWatchTick(runtime)), 2 * 60_000);
  setInterval(() => safe("inboxWatchTick", () => runInboxWatchTick(runtime)), 60 * 60_000);
  // Cohort benchmark — relative throughput vs same-age peers, weekly
  // (observability only; daily check, self-throttles to 7d).
  setTimeout(() => safe("cohortBenchmarkTick", () => runCohortBenchmarkTick(runtime)), 27 * 60_000);
  setInterval(() => safe("cohortBenchmarkTick", () => runCohortBenchmarkTick(runtime)), 24 * 3600_000);
  // Earning-surfaces watch — aggregation/embedding mining + API-marketplace
  // selling are in the 0.5.145 catalog but not yet deployed gateway-side. Probe
  // via real MCP dispatch every 6h and shout the moment any flips live.
  setTimeout(() => safe("earningSurfacesTick", () => runEarningSurfacesTick(runtime)), 28 * 60_000);
  setInterval(() => safe("earningSurfacesTick", () => runEarningSurfacesTick(runtime)), 6 * 3600_000);
  // Venice balance watch — the 08-05 DIEM exhaustion 402'd every inference
  // call for ~5.7h with no signal. Warn-only (no auto-buy; purchases stay
  // manual via npm run buy-credits). 30-min cadence, warn-once per crossing.
  setTimeout(() => safe("veniceBalanceTick", () => maybeWarnVeniceBalance()), 7 * 60_000);
  setInterval(() => safe("veniceBalanceTick", () => maybeWarnVeniceBalance()), 30 * 60_000);
  // ── Inference-y drafting + dormant surfaces ────────────────────────────
  // These either draft with an LLM (project/peer/exec/bounty-review) or probe
  // not-yet-live surfaces (aggregation/embedding/API mining). Lean mode skips
  // the whole block — only the royalty engine + free housekeeping above run.
  if (runsInLean("draftingAndDormant")) {
    // Tier-3 aggregation mining (P2.1). Dormant no-op until the gateway ships the
    // endpoint; submits only when BOT_AGGREGATION_AUTO=1. 2/day cap enforced inside.
    setTimeout(() => safe("aggregationTick", () => discoverAndSolveAggregations(runtime)), 14 * 60_000);
    setInterval(() => safe("aggregationTick", () => discoverAndSolveAggregations(runtime)), 30 * 60_000);
    // Tier-1 embedding mining (P2.2). Dormant until the endpoint ships AND a local
    // Ollama nomic-embed model is reachable; submits only when BOT_EMBEDDING_AUTO=1.
    setTimeout(() => safe("embeddingTick", () => discoverAndSolveEmbeddings(runtime)), 16 * 60_000);
    setInterval(() => safe("embeddingTick", () => discoverAndSolveEmbeddings(runtime)), 30 * 60_000);
    // API-marketplace selling (P2.3). Dormant until the marketplace actions ship;
    // onboards a metered listing only when BOT_API_ONBOARD_AUTO=1 + listing config set.
    setTimeout(() => safe("apiMarketplaceTick", () => runApiMarketplaceTick(runtime)), 18 * 60_000);
    setInterval(() => safe("apiMarketplaceTick", () => runApiMarketplaceTick(runtime)), 30 * 60_000);
    // Projects / reputation (Path A). When BOT_PROJECTS_AUTO_PREVIEW=1, drafts ONE
    // grounded project + peer comparison and enqueues it for your review — never
    // submits. Keeps one pending at a time; you approve/pass via `npm run projects`.
    setTimeout(() => safe("projectsReviewTick", () => runProjectsReviewTick(runtime)), 35 * 60_000);
    // One draft per 24h (slow enough to review + post each before the next) — and it
    // no-ops anyway while one is still pending, so drafts never pile up.
    setInterval(() => safe("projectsReviewTick", () => runProjectsReviewTick(runtime)), 24 * 3600_000);
    // Peer-review (Path B / collab). Drafts ONE review of another agent's commit per
    // day for your approval (BOT_PEER_REVIEW_AUTO=1); never submits on its own.
    setTimeout(() => safe("peerReviewTick", () => runPeerReviewTick(runtime)), 45 * 60_000);
    setInterval(() => safe("peerReviewTick", () => runPeerReviewTick(runtime)), 24 * 3600_000);
    // Exec dimension (Path A cont.). Re-runs each approved project's tests in-project
    // via exec_code({projectId}) to grow `exec` — and logs the gateway keyset so we
    // can see whether project-attributed runs actually move the dimension (it read 0).
    // Gated by BOT_EXEC_SCORING_AUTO=1.
    setTimeout(() => safe("execScoringTick", () => runExecScoringTick(runtime)), 50 * 60_000);
    setInterval(() => safe("execScoringTick", () => runExecScoringTick(runtime)), 8 * 3600_000);
    // Bounties (human-gated apply). When BOT_BOUNTY_REVIEW_AUTO=1, drafts ONE
    // application for a qualifying open native bounty and enqueues it for your
    // review — never submits. Native supply is sporadic, so check more often than
    // daily; one-pending + daily-cap guards keep it from piling up.
    setTimeout(() => safe("bountyReviewTick", () => runBountyReviewTick(runtime)), 25 * 60_000);
    setInterval(() => safe("bountyReviewTick", () => runBountyReviewTick(runtime)), 6 * 3600_000);
  }
}

async function startTeachingLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("teachingTick", () => runTeachingTick(runtime)), 13 * 60_000);
  teachingInterval = setInterval(() => safe("teachingTick", () => runTeachingTick(runtime)), 4 * 3600_000);
}

async function startAttentionLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("attentionTick", () => runAttentionTick(runtime)), 2 * 60_000);
  attentionInterval = setInterval(() => safe("attentionTick", () => runAttentionTick(runtime)), 5 * 60_000);
  // Weekly collaborator-finder pass (idempotent — does nothing if it already ran in the last 7d)
  setTimeout(() => safe("collabFinder", () => runCollabFinderTick(runtime)), 25 * 60_000);
  setInterval(() => safe("collabFinder", () => runCollabFinderTick(runtime)), 24 * 3600_000);
}

async function startDiagnosticsLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("diagnosticsTick", () => runDiagnosticsTick(runtime)), 15 * 60_000);
  diagnosticsInterval = setInterval(
    () => safe("diagnosticsTick", () => runDiagnosticsTick(runtime)),
    2 * 3600_000,
  );
}

async function startEcosystemLoop(runtime: ReturnType<typeof getRuntime>) {
  setTimeout(() => safe("ecosystemTick", () => gatherEcosystemSummary(runtime)), 17 * 60_000);
  ecosystemInterval = setInterval(
    () => safe("ecosystemTick", () => gatherEcosystemSummary(runtime)),
    30 * 60_000,
  );
}

async function main() {
  // Single-instance lock FIRST — before any side effect. A second daemon must
  // exit here, not after it has posted/spent/subscribed (the 5-daemon pileup
  // of 07-11→16 doubled spend and raced the 02:00Z post with pre-gate code).
  try {
    const lock = acquireInstanceLock();
    if ("pid" in lock) console.log(`🔒 instance lock acquired (pid ${lock.pid}, rev ${lock.gitRev ?? "?"})`);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
  // Releases only if the pidfile is OURS — a refused boot can't delete the
  // legitimate holder's lock.
  process.on("exit", () => releaseInstanceLock());
  // Keep bot.log live no matter how we're launched. Without this the log only
  // updates when the operator pipes stdout through `tee`; a bare launch freezes
  // it and the self-observer reads a stale tail (see src/bot-log.ts).
  initBotLog();
  process.on("unhandledRejection", (reason) => {
    console.warn(`⚠ unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    console.warn(`⚠ uncaughtException: ${err.message}`);
  });
  // Fail fast on a missing/placeholder Venice key at BOOT (clear error now
  // beats an opaque 401 loop later). Lives here, not at venice.ts module
  // scope, so keyless imports (tests, tooling) stay safe.
  assertVeniceKey();
  const runtime = getRuntime();
  let connection: Awaited<ReturnType<typeof runtime.connect>> | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      connection = await runtime.connect();
      break;
    } catch (err) {
      const wait = Math.min(60_000, 5_000 * Math.pow(1.4, attempt));
      console.warn(`⚠ connect failed (attempt ${attempt + 1}): ${(err as Error).message} — retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (!connection) {
    console.error("✗ could not connect after 30 attempts — gateway may be down for an extended period. Exiting; tsx-watch will restart on next file change.");
    process.exit(1);
  }
  myAddress = connection?.address ?? null;
  console.log(`✓ Connected as ${myAddress ?? "agent"}`);
  console.log(`  Mode: ${config.dryRun ? "DRY RUN (advisory only)" : "LIVE"}`);
  console.log(`  Watching: ${EVENTS_FILE}`);

  // Auto-join a mining guild if we're unaffiliated — unlocks the ~15-20% of
  // challenges gated to tier0+ members. Idempotent: skips if already in one.
  myGuildId = await ensureGuildMembership(runtime, { myAddress, dryRun: config.dryRun });

  runtime.events?.subscribe?.("mention", (event: any) => {
    console.log("📣 mention:", event.data);
  });
  runtime.events?.subscribe?.("message.received", (event: any) => {
    console.log("💬 message:", event.data);
  });
  runtime.events?.subscribe?.("bounty.new", (event: any) => {
    if (!runsInLean("bounty")) return; // lean skips bounty drafting (LLM + on-chain apply)
    handleNewBountyEvent(runtime, (event.data ?? event) as Record<string, unknown>);
  });
  runtime.events?.subscribe?.("bounty.application.approved" as any, (event: any) => {
    console.log("🎉 application.approved:", JSON.stringify(event.data ?? event).slice(0, 200));
  });
  runtime.events?.subscribe?.("bounty.application.rejected" as any, (event: any) => {
    console.log("🛑 application.rejected:", JSON.stringify(event.data ?? event).slice(0, 200));
  });

  runtime.proactive?.onOpportunities?.((event: any) => {
    console.log("🎯 opportunity:", event.data);
    const opp = (event.data || event) as OpportunityEvent;
    const t = (opp.actionType || opp.type || "").toLowerCase();
    // Lean skips the verification + bounty grind even when pushed via the
    // proactive channel — these run LLM inference + on-chain writes that the
    // loop-level gating alone would not catch.
    if (t.includes("verification") && runsInLean("verification")) handleVerificationOpportunity(runtime, opp);
    else if (t.includes("bounty") && runsInLean("bounty")) handleBountyOpportunity(runtime, opp);
  });

  runtime.proactive?.onActionRequest?.((req: any) => {
    console.log("🎯 action request:", req);
    const opp = req as OpportunityEvent;
    const t = (opp.actionType || "").toLowerCase();
    if (t.includes("verification") && runsInLean("verification")) handleVerificationOpportunity(runtime, opp);
    else if (t.includes("bounty") && runsInLean("bounty")) handleBountyOpportunity(runtime, opp);
  });

  // Loop registration. LEAN_KEEP loops (net-positive royalty engine + reward
  // claims + cheap read-only housekeeping) run unconditionally; the inference
  // "grind" is wrapped in runsInLean(<track>) — a no-op off-lean (unchanged
  // behavior), skipped under BOT_LEAN=1. See src/lean.ts.
  const banner = leanBanner();
  if (banner) console.log(banner);
  await startRewardLoop(runtime); // claimRewards — collect earnings (kept)
  if (runsInLean("bountyLifecycle")) await startBountyPoller(runtime);
  if (runsInLean("knowledgePublish")) await startKnowledgePublishLoop(runtime);
  if (runsInLean("verification")) await startVerificationLoop(runtime);
  if (runsInLean("mining")) await startMiningLoop(runtime);
  if (runsInLean("crowdJury")) await startCrowdJuryLoop(runtime);
  if (runsInLean("learnings")) await startLearningsLoop(runtime);
  if (runsInLean("predictions")) await startPredictionsLoop(runtime);
  if (runsInLean("social")) await startSocialLoop(runtime);
  if (runsInLean("engagement")) await startEngagementLoop(runtime);
  if (runsInLean("observation")) await startObservationLoop(runtime);
  await startNetworkStatusLoop(runtime, myAddress); // networkStatus — read-only (kept)
  startCitationVelocityLoops(runtime, myAddress); // citationVelocity — passive, 0 LLM (kept)
  if (runsInLean("paperReproduction")) startPaperReproductionLoop(runtime);
  if (runsInLean("socialEngagement")) startSocialEngagementLoops(runtime);
  // MCP-derived tracks (every callback swallows its own errors)
  if (runsInLean("bounty")) await startBountyLoop(runtime);
  if (runsInLean("clarifications")) await startClarificationsLoop(runtime);
  if (runsInLean("swarms")) await startSwarmsLoop(runtime);
  await startWeeklyRewardsLoop(runtime); // weeklyRewards — royalty engine + housekeeping (kept; inner grind gated)
  if (runsInLean("teaching")) await startTeachingLoop(runtime);
  if (runsInLean("attention")) await startAttentionLoop(runtime);
  await startDiagnosticsLoop(runtime); // diagnostics — local health (kept)
  await startEcosystemLoop(runtime); // ecosystem — read-only stats (kept)
  // Fire-and-forget — one-shot, idempotent, must never block boot.
  // DRY_RUN-gated: these are REAL on-chain writes (marketplace listing +
  // project creation), and a first-time user's "dry run" must not sign
  // irreversible transactions. (BOT_ONBOARDING=0 also disables outright.)
  if (config.dryRun) {
    console.log("🧭 onboarding actions skipped (DRY_RUN)");
  } else {
    void runOnboardingActions(runtime, myAddress).catch((e) => console.warn(`onboarding ⚠ ${(e as Error).message.slice(0, 120)}`));
  }
  // Opt-in forge preset load (BOT_FORGE_PRESET). One-shot, idempotent, cost-capped,
  // never blocks boot. Seeds the miner with curated domain knowledge.
  void loadConfiguredPresetAtBoot(runtime).catch((e) => console.warn(`forge ⚠ ${(e as Error).message.slice(0, 120)}`));
  // Optionally auto-spawn a tunnel (cloudflared/ngrok) when BOT_TUNNEL_AUTOSPAWN=1.
  // This sets BOT_WEBHOOK_URL in-process so bootstrapSubscriptions can find it.
  await autoSpawnTunnel(Number(process.env.WEB_PORT ?? 7878)).catch((e) =>
    console.warn(`tunnel ⚠ ${(e as Error).message.slice(0, 120)}`),
  );
  // Bootstrap webhook subscriptions if BOT_WEBHOOK_URL is set (else no-op)
  void bootstrapSubscriptions(runtime).catch((e) => console.warn(`subscriptions ⚠ ${(e as Error).message.slice(0, 120)}`));
  // Specialization-drift tick on startup + every 24h. The function is
  // idempotent — re-runs within 24h short-circuit and return the last snapshot.
  setTimeout(() => safe("specializationDrift", () => runSpecializationDriftTick(runtime).then(() => undefined)), 30 * 60_000);
  setInterval(() => safe("specializationDrift", () => runSpecializationDriftTick(runtime).then(() => undefined)), 24 * 3600_000);

  setInterval(async () => {
    try {
      const pending = await runtime.proactive.getPendingApprovals?.();
      if (pending?.count) console.log(`🎯 pending approvals: ${pending.count}`);
    } catch {}
  }, 120000);

  await followEventsFile();

  const shutdown = async () => {
    console.log("\n→ shutting down");
    if (rewardInterval) clearInterval(rewardInterval);
    if (bountyPollInterval) clearInterval(bountyPollInterval);
    if (knowledgeInterval) clearInterval(knowledgeInterval);
    if (verificationInterval) clearInterval(verificationInterval);
    if (miningInterval) clearInterval(miningInterval);
    if (crowdJuryInterval) clearInterval(crowdJuryInterval);
    if (learningsInterval) clearInterval(learningsInterval);
    if (predictionsInterval) clearInterval(predictionsInterval);
    if (socialInterval) clearInterval(socialInterval);
    if (engagementInterval) clearInterval(engagementInterval);
    if (observationInterval) clearInterval(observationInterval);
    if (bountyInterval) clearInterval(bountyInterval);
    if (clarificationInterval) clearInterval(clarificationInterval);
    if (swarmInterval) clearInterval(swarmInterval);
    if (swarmHeartbeatInterval) clearInterval(swarmHeartbeatInterval);
    if (weeklyRewardsInterval) clearInterval(weeklyRewardsInterval);
    if (teachingInterval) clearInterval(teachingInterval);
    if (attentionInterval) clearInterval(attentionInterval);
    if (diagnosticsInterval) clearInterval(diagnosticsInterval);
    if (ecosystemInterval) clearInterval(ecosystemInterval);
    shutdownTunnel();
    releaseInstanceLock();
    await runtime.disconnect?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("✗ fatal:", err);
  process.exit(1);
});
