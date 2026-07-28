/**
 * HTML dashboard server.
 *
 * `npm run web` → starts on http://localhost:7878 (or $WEB_PORT). Serves:
 *   GET /              → public/dashboard.html
 *   GET /api/snapshot  → live merged state (gateway live + JSONL aggregated)
 *   GET /api/history   → ?metric={mining|verification|network|claims} timeseries
 *   GET /api/blockers  → ranked list of current blockers (us + network)
 *
 * All endpoints return JSON. No auth — runs locally only. Bind only to
 * loopback unless WEB_BIND_HOST is set (don't expose to LAN).
 *
 * The server pulls from:
 *   - ~/.nookplot/{mining-submissions,verification-stats,network-status,
 *     mining-claims,rlm-spotchecks,ab-applications,knowledge-published,
 *     endorsements,learnings-posted}.jsonl
 *   - Gateway live: /v1/agents/me, /v1/credits/balance, /v1/mining/stake/:addr,
 *     /v1/mining/stats/agent/:addr, /v1/mining/submissions/agent/:addr,
 *     /v1/mining/submissions/verifiable?limit=200, /v1/mining/epoch
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NOOK_DIR, BOT_LOG_PATH, readJsonl, readJsonlTail } from "./util.js";
import { getWalletBalances } from "./wallet.js";
import { bountySummary } from "./bounties.js";
import { clarificationSummary } from "./clarifications.js";
import { swarmSummary } from "./swarms.js";
import { weeklyRewardSummary } from "./weekly-rewards.js";
import { teachingSummary } from "./teaching.js";
import { attentionSummary } from "./attention-signals.js";
import { diagnosticsSummary } from "./diagnostics.js";
import { subscriptionSummary } from "./subscriptions.js";
import { egressSummary } from "./egress.js";
import { quotaSummary } from "./quotas.js";
import { semaphoreSnapshot } from "./generation-semaphore.js";
import { veniceCostSummary } from "./venice-cost.js";
import { driftSummary } from "./specialization-drift.js";
import { auditSummary, recentAudit } from "./audit.js";
import { getRuntime } from "./runtime.js";
import { isLean, runsInLean } from "./lean.js";
import { readCapacity, capacityUnderuse, MINING_DAILY_CAP } from "./capacity.js";
import { readDailySpend } from "./pnl.js";
import { holderStatus } from "./instance-lock.js";
import { gatewayReachability } from "./network-status.js";

const PORT = Number(process.env.WEB_PORT ?? 7878);
const BIND = process.env.WEB_BIND_HOST ?? "127.0.0.1";
const GATEWAY = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
const API_KEY = process.env.NOOKPLOT_API_KEY ?? "";
const MY_ADDR = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
const PUBLIC_DIR = resolve(process.cwd(), "public");
// Optional bearer-token auth. Set WEB_AUTH_TOKEN to require it on /api/*.
// Static files (HTML/CSS/JS) are always public so the dashboard can load,
// but the JSON endpoints are gated when this is set.
const WEB_AUTH_TOKEN = (process.env.WEB_AUTH_TOKEN ?? "").trim();

const HEADERS: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };

async function gwGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${GATEWAY}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// Gateway returns verification_count as a string — coerce.
function num(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ── Snapshot ─────────────────────────────────────────────────────────────

interface MiningEntry {
  ts: string;
  challengeId: string;
  verifierKind?: string;
  outcome: "pass" | "fail" | "deferred" | "error" | "skipped";
  rewardNook?: number;
  submissionId?: string;
  model?: string;
  notes?: string;
}

interface NetworkStatusEntry {
  ts: string;
  epoch?: number;
  epochStatus?: string;
  dailyEmissionNook?: number;
  verifierPoolNook?: number;
  pool: { total: number; v0: number; v1: number; v2: number; quorumReady: number; byDifficulty: Record<string, number>; distinctSolvers: number };
  rlm: { pending: number; dailyDone: number; dailyCap: number };
  mine: { pendingSubs: number; avgVerifierCount?: number; claimableNook: number; pendingRewards: number; totalSolves: number };
  emergencyReserve: boolean;
}

interface ClaimEntry {
  ts: string;
  claimed?: number;
  sources?: Array<{ source: string; amount: number }>;
  kind?: "on-chain" | "off-chain";
  onChainCumulative?: number;
  epochNumber?: number;
  txHash?: string;
  /** NOOK→USD price captured AT claim time (frozen). Absent on pre-2026-06-25 claims. */
  priceUsdAtClaim?: number;
  priceSourceAtClaim?: string;
}

// ── NOOK → USD price ──────────────────────────────────────────────────────
// No on-chain/gateway price feed exists, so we read the live market price from
// CoinGecko (NOOK trades on Uniswap V4 / MEXC). Set NOOK_USD_PRICE to pin a
// fixed price (overrides the live fetch). Cached 5 min; falls back to the last
// good value, then 0 (dashboard renders "price unavailable" rather than lying).
interface NookPrice { usd: number; change7d: number | null; source: string }
let priceCache: { val: NookPrice; at: number } | null = null;
const PRICE_TTL_MS = 5 * 60_000;
// Negative-cache window: after a failed fetch, don't re-hit CoinGecko (10s
// timeout each) on every snapshot call — back off for this long so a CoinGecko
// outage doesn't make the dashboard sluggish. Shorter than the success TTL so
// the price recovers quickly once the API is back.
const PRICE_FAIL_TTL_MS = 60_000;
async function getNookPriceUsd(): Promise<NookPrice> {
  const envPrice = Number(process.env.NOOK_USD_PRICE);
  if (Number.isFinite(envPrice) && envPrice > 0) return { usd: envPrice, change7d: null, source: "env:NOOK_USD_PRICE" };
  if (priceCache) {
    const age = Date.now() - priceCache.at;
    // A failed fetch (no price, or a stale-good fallback) retries on the short
    // window; a fresh success holds for the full TTL.
    const failed = priceCache.val.source === "unavailable" || priceCache.val.source.endsWith(":stale");
    const ttl = failed ? PRICE_FAIL_TTL_MS : PRICE_TTL_MS;
    if (age < ttl) return priceCache.val;
  }
  try {
    // coins/markets (not simple/price) — it's the endpoint that exposes the 7d
    // change via price_change_percentage_7d_in_currency.
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=nookplot&price_change_percentage=7d",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const arr = (await r.json()) as Array<{ current_price?: number; price_change_percentage_7d_in_currency?: number }>;
      const row = Array.isArray(arr) ? arr[0] : undefined;
      const usd = row?.current_price;
      if (typeof usd === "number" && usd > 0) {
        const val: NookPrice = { usd, change7d: row?.price_change_percentage_7d_in_currency ?? null, source: "coingecko" };
        priceCache = { val, at: Date.now() };
        return val;
      }
    }
  } catch { /* fall through */ }
  // Prefer the last GOOD price (stale but real) over zero; only report
  // "unavailable" if we never got one. Either way, stamp the cache so failures
  // are rate-limited by PRICE_FAIL_TTL_MS instead of retried every call.
  const fallback: NookPrice = priceCache && priceCache.val.source !== "unavailable"
    ? { ...priceCache.val, source: priceCache.val.source.replace(/:stale$/, "") + ":stale" }
    : { usd: 0, change7d: null, source: "unavailable" };
  priceCache = { val: fallback, at: Date.now() };
  return fallback;
}

/**
 * Per-day NOOK earned, derived from the off-chain claim events (each carries
 * that epoch's claimed total + source breakdown; on-chain events only hold the
 * cumulative, so we key off off-chain). Returns oldest→newest.
 */
function dailyEarningsNook(
  claims: ClaimEntry[],
): Array<{ date: string; nook: number; sources: Record<string, number>; priceUsdAtClaim?: number }> {
  return claims
    .filter((c) => c.kind !== "on-chain" && typeof c.claimed === "number")
    .map((c) => {
      const sources: Record<string, number> = {};
      for (const s of c.sources ?? []) sources[s.source] = (sources[s.source] ?? 0) + s.amount;
      // Carry the price frozen at claim time; the USD calc prefers it over live.
      return { date: c.ts.slice(0, 10), nook: c.claimed as number, sources, priceUsdAtClaim: c.priceUsdAtClaim };
    });
}

interface VerifyStatsEntry {
  ts: string;
  submissionId: string;
  solver?: string | null;
  correctness: number;
  reasoning: number;
  efficiency: number;
  novelty: number;
  domain?: string;
}

async function buildSnapshot() {
  const wallet = MY_ADDR ? await getWalletBalances(MY_ADDR) : null;
  const [profile, stake, agentStats, mySubsRes, poolRes, epochRes, rlmRes, creditsRes, proofRes, contribRes, authorshipRes] = await Promise.all([
    gwGet<{ address: string; displayName?: string }>("/v1/agents/me"),
    gwGet<{ stakedNook: number; tier: string; multiplier: number; totalSolves: number; totalVerifications: number; totalEarnedNook: number }>(
      `/v1/mining/stake/${MY_ADDR}`,
    ),
    gwGet<{ claimableBalance?: Record<string, number>; pendingRewards?: number; totalEarned?: number }>(
      `/v1/mining/stats/agent/${MY_ADDR}`,
    ),
    gwGet<{ submissions?: Array<{ id: string; status?: string; modelUsed?: string; submittedAt?: string; solverGuildId?: number | null }> }>(
      `/v1/mining/submissions/agent/${MY_ADDR}?limit=50`,
    ),
    gwGet<{
      submissions?: Array<{ id: string; verification_count?: number | string; solver_address?: string; difficulty?: string }>;
    }>("/v1/mining/submissions/verifiable?limit=200"),
    gwGet<{ epoch?: { epochNumber?: number; status?: string; dailyEmission?: number; verificationPool?: number; isEmergencyReserve?: boolean } }>(
      "/v1/mining/epoch",
    ),
    gwGet<{ trajectories?: unknown[]; dailyCount?: number; dailyCap?: number }>(
      "/v1/mining/spot-checks/pending?limit=1",
    ),
    gwGet<{ balance: number; lifetimeEarned: number; lifetimeSpent: number; budgetStatus: string }>(
      "/v1/credits/balance",
    ),
    gwGet<{ hasProof?: boolean; cumulativeAmount?: number | string; proof?: string[]; epochNumber?: number; merkleRoot?: string; publishedAt?: string }>(
      `/v1/mining/proof/${MY_ADDR}`,
    ),
    gwGet<{
      score?: number;
      velocityMultiplier?: number;
      breakdown?: Record<string, number>;
      expertiseTags?: Array<{ tag: string; confidence: number; evidenceCount: number; verificationLevel: string; source: string; category: string }>;
      computedAt?: string;
    }>(`/v1/contributions/${MY_ADDR}`),
    gwGet<{
      rights?: Array<{
        domain_tag?: string;
        domain?: string;
        solves_in_domain?: number;
        verifiedSolves?: number;
        authorship_unlocked?: boolean;
        challenges_authored?: number;
        total_author_royalties?: string;
      }>;
      count?: number;
    }>(`/v1/mining/authorship/${MY_ADDR}`),
  ]);

  // Hot-path: only the recent slice is needed for snapshot computations.
  // Switching to tail-read keeps dashboard latency flat as the JSONLs grow.
  // `/api/history` keeps full-read because it explicitly exposes history.
  const mining = readJsonlTail<MiningEntry>(join(NOOK_DIR, "mining-submissions.jsonl"), 2000);
  const claims = readJsonlTail<ClaimEntry>(join(NOOK_DIR, "mining-claims.jsonl"), 500);
  const verifyStats = readJsonlTail<VerifyStatsEntry>(join(NOOK_DIR, "verification-stats.jsonl"), 500);
  const networkHistory = readJsonlTail<NetworkStatusEntry>(join(NOOK_DIR, "network-status.jsonl"), 200);

  const now = Date.now();
  const cutoff24h = now - 24 * 3600_000;
  const cutoff7d = now - 7 * 24 * 3600_000;
  const recent24h = mining.filter((e) => new Date(e.ts).getTime() >= cutoff24h);
  const recentVerify24h = verifyStats.filter((e) => e.ts && new Date(e.ts).getTime() >= cutoff24h);

  // Per-model aggregation (last 24h)
  const byModel = new Map<string, { attempts: number; pass: number; deferred: number; error: number; rewardSum: number }>();
  for (const e of recent24h) {
    const m = e.model ?? "(unrecorded)";
    let entry = byModel.get(m);
    if (!entry) { entry = { attempts: 0, pass: 0, deferred: 0, error: 0, rewardSum: 0 }; byModel.set(m, entry); }
    entry.attempts++;
    if (e.outcome === "pass") { entry.pass++; entry.rewardSum += e.rewardNook ?? 0; }
    else if (e.outcome === "deferred") { entry.deferred++; entry.rewardSum += e.rewardNook ?? 0; }
    else if (e.outcome === "error") entry.error++;
  }

  // Verifier-count distribution on our pending submissions — sample first 10
  const mySubs = mySubsRes?.submissions ?? [];
  const myPending = mySubs.filter((s) => s.status === "submitted");
  const mySubVerifierCounts: Array<{ id: string; vCount: number; submittedAt?: string }> = [];
  for (const s of myPending.slice(0, 10)) {
    const detail = await gwGet<{ verificationStatus?: { verificationCount?: number; verificationQuorum?: number } }>(
      `/v1/mining/submissions/${encodeURIComponent(s.id)}`,
    );
    mySubVerifierCounts.push({
      id: s.id,
      vCount: num(detail?.verificationStatus?.verificationCount),
      submittedAt: s.submittedAt,
    });
  }
  const avgVCount = mySubVerifierCounts.length > 0
    ? mySubVerifierCounts.reduce((a, b) => a + b.vCount, 0) / mySubVerifierCounts.length
    : 0;

  // Pool distribution (from live pool query)
  const poolSubs = poolRes?.submissions ?? [];
  const poolDist = { v0: 0, v1: 0, v2: 0, vHigh: 0, total: poolSubs.length };
  for (const s of poolSubs) {
    const v = num(s.verification_count);
    if (v === 0) poolDist.v0++;
    else if (v === 1) poolDist.v1++;
    else if (v === 2) poolDist.v2++;
    else poolDist.vHigh++;
  }
  const distinctSolvers = new Set(poolSubs.map((s) => s.solver_address ?? "").filter(Boolean)).size;

  // Peer benchmarking: solvers in pool, their per-solver activity
  const peerActivity = new Map<string, { subs: number; nearQuorum: number }>();
  for (const s of poolSubs) {
    const a = (s.solver_address ?? "").toLowerCase();
    if (!a) continue;
    let p = peerActivity.get(a);
    if (!p) { p = { subs: 0, nearQuorum: 0 }; peerActivity.set(a, p); }
    p.subs++;
    if (num(s.verification_count) >= 2) p.nearQuorum++;
  }
  const sortedPeers = [...peerActivity.entries()]
    .map(([a, p]) => ({ address: a, subs: p.subs, nearQuorum: p.nearQuorum }))
    .sort((x, y) => y.subs - x.subs);

  // Our percentile within peers
  const ourSubsInPool = peerActivity.get(MY_ADDR);
  const myRank = MY_ADDR && peerActivity.has(MY_ADDR)
    ? sortedPeers.findIndex((p) => p.address === MY_ADDR) + 1
    : null;

  // Expected vs actual NOOK
  // Naive expected: 12 solves/day × avg reward × multiplier × guild
  // Use actual deferred-reward-estimate as the proxy
  const expected24h = recent24h
    .filter((e) => e.outcome === "deferred" || e.outcome === "pass")
    .reduce((s, e) => s + (e.rewardNook ?? 0), 0);
  const actualEarned = stake?.totalEarnedNook ?? 0;
  const claimedTotal = claims.reduce((s, c) => s + (c.claimed ?? 0), 0);
  const offChainClaimable = Object.values(agentStats?.claimableBalance ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  // Verification variance (last 20)
  const last20Verifies = verifyStats.slice(-20);
  const dimMeans: Record<string, { mean: number; sd: number }> = {};
  for (const dim of ["correctness", "reasoning", "efficiency", "novelty"] as const) {
    const xs = last20Verifies.map((e) => e[dim]);
    if (xs.length === 0) { dimMeans[dim] = { mean: 0, sd: 0 }; continue; }
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    dimMeans[dim] = { mean: m, sd: Math.sqrt(v) };
  }

  const latestNetwork = networkHistory[networkHistory.length - 1];

  // Compute on-chain unclaimed = Merkle cumulative - what we've already
  // claimed on-chain (per our local log).
  const onChainClaims = claims.filter((c) => (c as ClaimEntry & { kind?: string }).kind === "on-chain");
  const lastOnChainCumulative = onChainClaims.reduce(
    (m, c) => Math.max(m, (c as ClaimEntry & { onChainCumulative?: number }).onChainCumulative ?? 0),
    0,
  );
  const proofCumulative = typeof proofRes?.cumulativeAmount === "string"
    ? Number(proofRes.cumulativeAmount)
    : (proofRes?.cumulativeAmount ?? 0);
  const onChainUnclaimed = Math.max(0, proofCumulative - lastOnChainCumulative);

  // === USD view: live NOOK price × per-day earnings ===
  const price = await getNookPriceUsd();
  const daily = dailyEarningsNook(claims);
  const last7 = daily.slice(-7);
  const dailyNookAvg7d = last7.length ? last7.reduce((s, d) => s + d.nook, 0) / last7.length : 0;
  const lastDayNook = daily.length ? daily[daily.length - 1].nook : 0;
  const usd = {
    nookPriceUsd: price.usd,
    priceChange7d: price.change7d,
    priceSource: price.source,
    dailyNookAvg7d,
    dailyUsdAvg7d: dailyNookAvg7d * price.usd,
    lastDayNook,
    lastDayUsd: lastDayNook * price.usd,
    cumulativeClaimedNook: proofCumulative,
    cumulativeClaimedUsd: proofCumulative * price.usd,
    offChainClaimableUsd: offChainClaimable * price.usd,
  };

  const blockers = computeBlockers({
    poolDist,
    avgVCount,
    myPending: myPending.length,
    networkHistory,
    claimable: agentStats?.claimableBalance ?? {},
    emergencyReserve: Boolean(epochRes?.epoch?.isEmergencyReserve),
    rlmExhausted: (rlmRes?.dailyCount ?? 0) >= (rlmRes?.dailyCap ?? 10),
  });

  return {
    generatedAt: new Date().toISOString(),
    agent: {
      address: profile?.address,
      name: profile?.displayName,
      runtimeKind: "direct-runtime (custom backend, not Hermes)",
    },
    // === Multi-currency picture (the part the TUI dashboard was missing) ===
    money: {
      credits: creditsRes
        ? {
            balance: creditsRes.balance,
            lifetimeEarned: creditsRes.lifetimeEarned,
            lifetimeSpent: creditsRes.lifetimeSpent,
            budgetStatus: creditsRes.budgetStatus,
            label: "Gateway service-fee credits — pays for /v1/exec, relays, etc. Not NOOK.",
          }
        : null,
      nookStaked: stake?.stakedNook ?? 0,
      // total earned NOOK ever (across solver + verifier + royalty)
      nookTotalEarned: stake?.totalEarnedNook ?? agentStats?.totalEarned ?? 0,
      // sum of all 'epoch_*' balances on the gateway ledger that haven't
      // been settled into a Merkle proof yet
      nookOffChainClaimable: offChainClaimable,
      nookOffChainPending: agentStats?.pendingRewards ?? 0,
      // Merkle proof state
      onChainProof: proofRes?.hasProof
        ? {
            cumulativeAmount: proofCumulative,
            epochNumber: proofRes.epochNumber,
            publishedAt: proofRes.publishedAt,
            alreadyClaimed: lastOnChainCumulative,
            unclaimedThisEpoch: onChainUnclaimed,
          }
        : null,
      // Actual wallet balances via direct Base RPC — the source of truth.
      wallet: wallet,
      // USD view — live NOOK price × earnings. See getNookPriceUsd().
      usd,
    },
    // Bot-mode flags (which optional surfaces are on/off + specialization).
    // Lean-skippable surfaces are AND-ed with runsInLean(track) so the panel
    // reflects what the daemon ACTUALLY registered under BOT_LEAN=1, not just
    // the env flag.
    botMode: {
      lean: isLean(),
      specializeDomains: (process.env.BOT_SPECIALIZE_DOMAINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      specializeMatchMode: process.env.BOT_SPECIALIZE_MATCH_MODE === "all" ? "all" : "any",
      specializeStrict: process.env.BOT_SPECIALIZE_STRICT === "1",
      bountyFitThreshold: Number(process.env.BOT_BOUNTY_FIT_THRESHOLD ?? 0.75),
      bountyApply: process.env.BOT_BOUNTY_APPLY !== "0" && runsInLean("bounty"),
      paperReproduction: process.env.BOT_PAPER_REPRODUCTION !== "0" && runsInLean("paperReproduction"),
      workspaceSolve: process.env.BOT_WORKSPACE_SOLVE !== "0",
      citationVelocity: process.env.BOT_CITATION_VELOCITY !== "0" && runsInLean("citationVelocity"),
      rlmSpotcheck: process.env.BOT_RLM_SPOTCHECK !== "0",
      autoJoinGuild: process.env.BOT_AUTO_JOIN_GUILD !== "0",
      onChainClaim: process.env.BOT_AUTO_ONCHAIN_CLAIM !== "0",
      voteLoop: process.env.BOT_VOTE_LOOP !== "0" && runsInLean("socialEngagement"),
      followLoop: process.env.BOT_FOLLOW_LOOP !== "0" && runsInLean("socialEngagement"),
      commentLoop: process.env.BOT_COMMENT_LOOP !== "0" && runsInLean("socialEngagement"),
      onboarding: process.env.BOT_ONBOARDING !== "0",
      verifyThresholdOverride: process.env.BOT_VERIFY_THRESHOLD,
    },
    winning: computeWinningStatus({
      stakeTier: stake?.tier,
      stakeMultiplier: stake?.multiplier ?? 0,
      credits: creditsRes?.balance ?? 0,
      attempts24h: recent24h.length,
      submitted24h: recent24h.filter((e) => e.outcome === "pass" || e.outcome === "deferred").length,
      errors24h: recent24h.filter((e) => e.outcome === "error").length,
      expectedRevenue24h: expected24h,
      lifetimeEarned: actualEarned,
      claimable: offChainClaimable,
      pendingRewards: agentStats?.pendingRewards ?? 0,
      verifications24h: recentVerify24h.length,
      pendingSubs: myPending.length,
      avgVerifierCount: avgVCount,
      networkV0Pct: poolDist.total > 0 ? poolDist.v0 / poolDist.total : 0,
      nearQuorumPool: poolDist.v2,
      blockers,
    }),
    paperReproOpportunities: readJsonlSafe<{
      ts: string;
      challengeId: string;
      title?: string;
      difficulty?: string;
      estimatedReward?: number;
      arxivIds?: string[];
    }>(join(NOOK_DIR, "paper-reproduction.jsonl")).slice(-10).reverse(),
    reputation: contribRes
      ? {
          score: contribRes.score ?? 0,
          velocityMultiplier: contribRes.velocityMultiplier ?? 1,
          breakdown: contribRes.breakdown ?? {},
          expertiseTags: (contribRes.expertiseTags ?? [])
            .filter((t) => t.verificationLevel === "activity_verified")
            .sort((a, b) => (b.evidenceCount ?? 0) - (a.evidenceCount ?? 0)),
          computedAt: contribRes.computedAt,
        }
      : null,
    authorship: authorshipRes
      ? {
          // Total domains the network is tracking for us.
          trackedDomains: authorshipRes.count ?? (authorshipRes.rights?.length ?? 0),
          // The ACTUALLY unlocked ones — these are where we have authorship rights.
          unlocked: (authorshipRes.rights ?? []).filter((r) => r.authorship_unlocked === true).map((r) => ({
            domain: r.domain_tag ?? r.domain ?? "",
            solvesInDomain: r.solves_in_domain ?? r.verifiedSolves ?? 0,
            challengesAuthored: r.challenges_authored ?? 0,
            totalRoyalties: r.total_author_royalties ?? "0",
          })),
          // Top-5 closest to authorship — for the progress display
          nearestUnlock: (authorshipRes.rights ?? [])
            .filter((r) => r.authorship_unlocked !== true)
            .map((r) => ({
              domain: r.domain_tag ?? r.domain ?? "",
              solvesInDomain: r.solves_in_domain ?? r.verifiedSolves ?? 0,
            }))
            .sort((a, b) => b.solvesInDomain - a.solvesInDomain)
            .slice(0, 8),
        }
      : null,
    stake: stake
      ? {
          stakedNook: stake.stakedNook,
          tier: stake.tier,
          multiplier: stake.multiplier,
          totalSolves: stake.totalSolves,
          totalVerifications: stake.totalVerifications,
          totalEarnedNook: stake.totalEarnedNook,
        }
      : null,
    claimable: agentStats?.claimableBalance ?? {},
    pendingRewards: agentStats?.pendingRewards ?? 0,
    network: {
      epoch: epochRes?.epoch?.epochNumber,
      epochStatus: epochRes?.epoch?.status,
      dailyEmission: epochRes?.epoch?.dailyEmission ?? 0,
      verificationPool: epochRes?.epoch?.verificationPool ?? 0,
      emergencyReserve: Boolean(epochRes?.epoch?.isEmergencyReserve),
      pool: poolDist,
      distinctSolvers,
      blockedPct: poolDist.total > 0 ? poolDist.v0 / poolDist.total : 0,
      latestSnapshot: latestNetwork,
    },
    rlm: {
      pending: (rlmRes?.trajectories ?? []).length,
      dailyDone: rlmRes?.dailyCount ?? 0,
      dailyCap: rlmRes?.dailyCap ?? 10,
    },
    mine: {
      pendingCount: myPending.length,
      sample: mySubVerifierCounts,
      avgVerifierCount: avgVCount,
      poolPresence: ourSubsInPool ?? { subs: 0, nearQuorum: 0 },
      rankBySubs: myRank,
      totalPeers: sortedPeers.length,
    },
    peers: {
      total: sortedPeers.length,
      top5: sortedPeers.slice(0, 5),
    },
    mining: {
      attempts24h: recent24h.length,
      attempts7d: mining.filter((e) => new Date(e.ts).getTime() >= cutoff7d).length,
      attemptsAllTime: mining.length,
      byModel: [...byModel.entries()].map(([model, t]) => ({
        model,
        attempts: t.attempts,
        pass: t.pass,
        deferred: t.deferred,
        error: t.error,
        submitRate: t.attempts > 0 ? (t.pass + t.deferred) / t.attempts : 0,
        rewardSum: t.rewardSum,
      })),
      expectedRevenue24h: expected24h,
    },
    claims: {
      lifetime: claimedTotal,
      // Surface a deep recent history (the table is scrollable client-side).
      events: claims.slice(-120).reverse(),
    },
    verification: {
      total: verifyStats.length,
      last20Dims: dimMeans,
    },
    blockers,
    // MCP-derived tracks: scraped from the official MCP catalog, implemented
    // as raw-API modules in our codebase. See AGENTS.md for full doc.
    mcpTracks: {
      bounties: bountySummary(),
      clarifications: clarificationSummary(),
      swarms: swarmSummary(),
      weeklyRewards: weeklyRewardSummary(),
      teaching: teachingSummary(),
      attention: attentionSummary(),
      diagnostics: diagnosticsSummary(),
      subscriptions: subscriptionSummary(),
      egress: egressSummary(),
    },
    quotas: quotaSummary(),
    generationSemaphore: semaphoreSnapshot(),
    veniceCost: veniceCostSummary(),
    specializationDrift: driftSummary(),
    audit: auditSummary(),
  };
}

function computeBlockers(args: {
  poolDist: { total: number; v0: number; v1: number; v2: number; vHigh: number };
  avgVCount: number;
  myPending: number;
  networkHistory: NetworkStatusEntry[];
  claimable: Record<string, number>;
  emergencyReserve: boolean;
  rlmExhausted: boolean;
}) {
  const blockers: Array<{ severity: "high" | "med" | "low"; scope: "network" | "us"; message: string; action?: string }> = [];
  const p = args.poolDist;
  const blockedPct = p.total > 0 ? p.v0 / p.total : 0;

  // FIRST, before any data-dependent rule: is the gateway even reachable?
  // Every other rule here needs POSITIVE data to fire (e.g. the v0 guard
  // divides by p.total), so a TOTAL outage produced an empty blocker list and
  // a green "No blockers detected 🟢" — which is exactly what the dashboard
  // showed through all 53 hours of the 2026-07-25 blackout while we earned
  // nothing. A reachable gateway always returns an epoch, so a run of samples
  // without one is unambiguous.
  const gw = gatewayReachability(args.networkHistory);
  if (!gw.reachable && gw.consecutiveNoEpoch >= 2) {
    blockers.push({
      severity: "high",
      scope: "us",
      message:
        `Gateway unreachable: ${gw.consecutiveNoEpoch} consecutive polls (~${gw.hours.toFixed(1)}h, since ` +
        `${gw.since ?? "?"}) returned no epoch — the daemon is up but earning nothing`,
      action: "Check host connectivity first (this is usually the local network, not the gateway); the watchdog exits after 3 polls so a supervisor can restart into a fresh connection",
    });
  }

  if (args.emergencyReserve) {
    blockers.push({
      severity: "high",
      scope: "network",
      message: "Daily emission funded from 2.5M NOOK emergency reserve — pool was empty",
      action: "Watch consecutiveReserveDays; if it rises, network is structurally short on protocol-fee inflows",
    });
  }
  if (blockedPct >= 0.7) {
    blockers.push({
      severity: "high",
      scope: "network",
      message: `${Math.round(blockedPct * 100)}% of verifiable pool at v0 (network-wide verifier starvation)`,
      action: "Near-quorum priority sort is on; verifier supply is network-wide/exogenous — no local action (a sibling identity can't verify our own solves under the diversity cap, so it wouldn't unstick payouts).",
    });
  } else if (blockedPct >= 0.4) {
    blockers.push({
      severity: "med",
      scope: "network",
      message: `${Math.round(blockedPct * 100)}% of pool at v0 — verifier supply lagging`,
    });
  }
  if (args.myPending > 0 && args.avgVCount < 1.5 && args.myPending >= 5) {
    blockers.push({
      severity: "med",
      scope: "us",
      message: `${args.myPending} pending submissions averaging ${args.avgVCount.toFixed(1)} verifications each`,
      action: "Wait — limited by network verifier supply",
    });
  }
  // RLM exhausted
  if (args.rlmExhausted) {
    blockers.push({
      severity: "low",
      scope: "us",
      message: "RLM spot-check daily cap (10/24h) reached",
      action: "Resets on next epoch",
    });
  }
  // Claimable balance not zero — but our auto-claim runs every 30min so this would
  // only flag a missed cycle. Worth surfacing if > some threshold.
  const totalClaimable = Object.values(args.claimable).reduce((a, b) => a + (b ?? 0), 0);
  if (totalClaimable >= 100) {
    blockers.push({
      severity: "med",
      scope: "us",
      message: `${totalClaimable.toFixed(0)} NOOK claimable off-chain`,
      action: "Bot auto-claims every 30 min; if persistent, check claim error logs",
    });
  }
  // Network trend — has v0% been climbing over last 24h?
  if (args.networkHistory.length >= 3) {
    const recent = args.networkHistory.slice(-3);
    const trend = recent.map((h) => (h.pool.total > 0 ? h.pool.v0 / h.pool.total : 0));
    if (trend[0] < 0.5 && trend[trend.length - 1] >= 0.7) {
      blockers.push({
        severity: "med",
        scope: "network",
        message: `Network v0% rising fast: ${(trend[0] * 100).toFixed(0)}% → ${(trend[trend.length - 1] * 100).toFixed(0)}% across last 3 snapshots`,
      });
    }
  }
  return blockers;
}

function computeWinningStatus(args: {
  stakeTier?: string;
  stakeMultiplier: number;
  credits: number;
  attempts24h: number;
  submitted24h: number;
  errors24h: number;
  expectedRevenue24h: number;
  lifetimeEarned: number;
  claimable: number;
  pendingRewards: number;
  verifications24h: number;
  pendingSubs: number;
  avgVerifierCount: number;
  networkV0Pct: number;
  nearQuorumPool: number;
  blockers: Array<{ severity: "high" | "med" | "low"; scope: "network" | "us"; message: string; action?: string }>;
}) {
  const errorRate = args.attempts24h > 0 ? args.errors24h / args.attempts24h : 0;
  const submitRate = args.attempts24h > 0 ? args.submitted24h / args.attempts24h : 0;
  const points =
    (args.stakeTier === "tier3" ? 20 : args.stakeMultiplier >= 1.2 ? 10 : 0) +
    (args.credits > 100 ? 10 : args.credits > 0 ? 5 : -10) +
    (args.lifetimeEarned > 0 ? 10 : 0) +
    (args.submitted24h > 0 ? 20 : -10) +
    (args.verifications24h > 0 ? 15 : -5) +
    (submitRate >= 0.6 ? 10 : errorRate >= 0.5 ? -15 : 0) +
    (args.claimable + args.pendingRewards > 0 ? 10 : 0) +
    (args.networkV0Pct >= 0.7 ? -10 : 5);

  const reasons: string[] = [];
  const nextActions: string[] = [];
  if (args.stakeTier === "tier3") reasons.push(`Tier 3 stake active (${args.stakeMultiplier}x individual multiplier).`);
  else nextActions.push("Confirm stake tier before relying on mining revenue.");
  if (args.submitted24h > 0) reasons.push(`${args.submitted24h}/${args.attempts24h} mining attempts landed in 24h.`);
  else nextActions.push("Get mining submitting again this epoch; idle solver slots are the largest missed upside.");
  if (args.verifications24h > 0) reasons.push(`${args.verifications24h} verifications logged in 24h.`);
  else nextActions.push("Spend verification budget on near-quorum v2 submissions first.");
  if (args.pendingSubs > 0) reasons.push(`${args.pendingSubs} solver submissions pending, avg ${args.avgVerifierCount.toFixed(1)}/3 verifiers.`);
  if (args.networkV0Pct >= 0.7) nextActions.push("Treat slow payouts as network verifier starvation, not necessarily solve quality.");
  if (args.nearQuorumPool > 0) nextActions.push(`Prioritize ${args.nearQuorumPool} v2 pool submissions to unlock verifier rewards faster.`);
  if (errorRate >= 0.5) nextActions.push(`Cut 24h mining error rate (${Math.round(errorRate * 100)}%) before pruning models.`);
  if (args.claimable + args.pendingRewards > 0) reasons.push(`${Math.round(args.claimable + args.pendingRewards)} NOOK claimable/pending.`);

  const highUsBlocker = args.blockers.some((b) => b.scope === "us" && b.severity === "high");
  const status = points >= 55 && !highUsBlocker
    ? "winning"
    : points >= 25
      ? "mixed"
      : "blocked";
  const headline = status === "winning"
    ? "Winning, with payout timing mostly gated by verifier supply."
    : status === "mixed"
      ? "Mixed: good positioning, but conversion is not proven yet."
      : "Not winning yet: activity is blocked or not converting.";

  return {
    status,
    score: Math.max(0, Math.min(100, points)),
    headline,
    reasons: reasons.slice(0, 5),
    nextActions: nextActions.slice(0, 5),
    metrics: {
      submitRate,
      errorRate,
      attempts24h: args.attempts24h,
      submitted24h: args.submitted24h,
      verifications24h: args.verifications24h,
      expectedRevenue24h: args.expectedRevenue24h,
      networkV0Pct: args.networkV0Pct,
    },
  };
}

function readJsonlSafe<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readJsonl<T>(path);
}

async function buildHistory(metric: string) {
  if (metric === "mining") {
    const entries = readJsonlSafe<MiningEntry>(join(NOOK_DIR, "mining-submissions.jsonl"));
    return entries.map((e) => ({
      ts: e.ts,
      outcome: e.outcome,
      model: e.model ?? "(unrecorded)",
      reward: e.rewardNook ?? 0,
      challengeId: e.challengeId,
    }));
  }
  if (metric === "verification") {
    const entries = readJsonlSafe<VerifyStatsEntry>(join(NOOK_DIR, "verification-stats.jsonl"));
    return entries.map((e) => ({
      ts: e.ts,
      submissionId: e.submissionId,
      correctness: e.correctness,
      reasoning: e.reasoning,
      efficiency: e.efficiency,
      novelty: e.novelty,
      domain: e.domain,
    }));
  }
  if (metric === "network") {
    return readJsonlSafe<NetworkStatusEntry>(join(NOOK_DIR, "network-status.jsonl"));
  }
  if (metric === "claims") {
    return readJsonlSafe<ClaimEntry>(join(NOOK_DIR, "mining-claims.jsonl"));
  }
  if (metric === "daily-earnings") {
    // Per-day NOOK earned → USD/day series. USD uses the price FROZEN at claim
    // time (priceUsdAtClaim) so historical days don't drift with the live price;
    // claims recorded before that field existed fall back to the live price.
    // Each row also carries that day's inference spend + net (P&L card) —
    // additive fields, older consumers of `series` are unaffected.
    const claims = readJsonlSafe<ClaimEntry>(join(NOOK_DIR, "mining-claims.jsonl"));
    const price = await getNookPriceUsd();
    const spendByDate = new Map(readDailySpend(60).map((s) => [s.date, s]));
    const series = dailyEarningsNook(claims).map((d) => {
      const p = d.priceUsdAtClaim ?? price.usd;
      const sp = spendByDate.get(d.date);
      const usd = d.nook * p;
      const spendUsd = sp?.spendUsd ?? 0;
      spendByDate.delete(d.date);
      return { date: d.date, nook: d.nook, usd, priceUsd: p, priceFrozen: d.priceUsdAtClaim != null, sources: d.sources, spendUsd, netUsd: usd - spendUsd, calls: sp?.calls ?? 0 };
    });
    // Days with spend but no claim (e.g. today before the 02:00Z claim) still
    // belong in the P&L — emit them as zero-earning rows, keep order by date.
    for (const [date, sp] of spendByDate) {
      if (sp.spendUsd > 0) series.push({ date, nook: 0, usd: 0, priceUsd: price.usd, priceFrozen: false, sources: {}, spendUsd: sp.spendUsd, netUsd: -sp.spendUsd, calls: sp.calls });
    }
    series.sort((a, b) => a.date.localeCompare(b.date));
    return {
      priceUsd: price.usd,
      priceChange7d: price.change7d,
      priceSource: price.source,
      series,
    };
  }
  return [];
}

// ── Log tail (parity with TUI dashboard) ────────────────────────────────

function tailBotLog(n: number): { lines: string[]; path: string } {
  // The daemon logs to stdout, redirected wherever the launcher points — so the
  // live feed may be in bot.log OR daemon-live.log depending on how it was
  // started. Read whichever was written most recently.
  const candidates = [BOT_LOG_PATH, join(NOOK_DIR, "logs", "daemon-live.log")];
  let path = BOT_LOG_PATH;
  let newest = -1;
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const m = statSync(p).mtimeMs;
        if (m > newest) {
          newest = m;
          path = p;
        }
      }
    } catch {
      /* skip */
    }
  }
  if (newest < 0) return { lines: [], path: BOT_LOG_PATH };
  try {
    const all = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    return { lines: all.slice(-n), path };
  } catch {
    return { lines: [], path };
  }
}

// ── Side-track counters (parity with TUI dashboard) ─────────────────────

async function buildSidetracks() {
  const counts = {
    endorsements: readJsonlSafe<unknown>(join(NOOK_DIR, "endorsements.jsonl")).length,
    knowledgePublished: readJsonlSafe<unknown>(join(NOOK_DIR, "knowledge-published.jsonl")).length,
    learningsPosted: readJsonlSafe<unknown>(join(NOOK_DIR, "learnings-posted.jsonl")).length,
    predictions: readJsonlSafe<unknown>(join(NOOK_DIR, "predictions.jsonl")).length,
    crowdJury: readJsonlSafe<unknown>(join(NOOK_DIR, "crowd-jury.jsonl")).length,
    engagement: readJsonlSafe<unknown>(join(NOOK_DIR, "engagement.jsonl")).length,
    rlmSpotchecks: readJsonlSafe<unknown>(join(NOOK_DIR, "rlm-spotchecks.jsonl")).length,
    abApplications: readJsonlSafe<unknown>(join(NOOK_DIR, "ab-applications.jsonl")).length,
    networkStatusSnapshots: readJsonlSafe<unknown>(join(NOOK_DIR, "network-status.jsonl")).length,
    miningClaims: readJsonlSafe<unknown>(join(NOOK_DIR, "mining-claims.jsonl")).length,
    paperReproOpportunities: readJsonlSafe<unknown>(join(NOOK_DIR, "paper-reproduction.jsonl")).length,
    citationVelocity: readJsonlSafe<unknown>(join(NOOK_DIR, "citation-velocity.jsonl")).length,
    workspaceSolves: readJsonlSafe<unknown>(join(NOOK_DIR, "workspace-solves.jsonl")).length,
    votes: readJsonlSafe<unknown>(join(NOOK_DIR, "votes.jsonl")).length,
    follows: readJsonlSafe<unknown>(join(NOOK_DIR, "follows.jsonl")).length,
    comments: readJsonlSafe<unknown>(join(NOOK_DIR, "comments.jsonl")).length,
    onboarding: readJsonlSafe<unknown>(join(NOOK_DIR, "onboarding.jsonl")).length,
  };
  const now = Date.now();
  const cutoff24h = now - 24 * 3600_000;
  const today: Record<string, number> = {};
  for (const [name, file] of [
    ["endorsements", "endorsements.jsonl"],
    ["knowledgePublished", "knowledge-published.jsonl"],
    ["learningsPosted", "learnings-posted.jsonl"],
    ["predictions", "predictions.jsonl"],
    ["crowdJury", "crowd-jury.jsonl"],
    ["engagement", "engagement.jsonl"],
    ["rlmSpotchecks", "rlm-spotchecks.jsonl"],
    ["miningClaims", "mining-claims.jsonl"],
    ["paperReproOpportunities", "paper-reproduction.jsonl"],
    ["citationVelocity", "citation-velocity.jsonl"],
    ["workspaceSolves", "workspace-solves.jsonl"],
    ["votes", "votes.jsonl"],
    ["follows", "follows.jsonl"],
    ["comments", "comments.jsonl"],
    ["onboarding", "onboarding.jsonl"],
  ] as const) {
    const entries = readJsonlSafe<{ ts?: string }>(join(NOOK_DIR, file));
    today[name] = entries.filter((e) => e.ts && new Date(e.ts).getTime() >= cutoff24h).length;
  }
  return { total: counts, last24h: today };
}

// ── Credits acquisition info ────────────────────────────────────────────

async function buildCredits() {
  const [balance, packs, txs, usage] = await Promise.all([
    gwGet<{ balance: number; lifetimeEarned: number; lifetimeSpent: number; budgetStatus: string }>("/v1/credits/balance"),
    gwGet<{ packs?: Array<{ id: number; name: string; usdcPrice: string; credits: number; nookDiscount: number }>; contractAddress?: string; nookTokenAddress?: string }>("/v1/credits/packs"),
    gwGet<{ transactions?: Array<{ id: string; amountCredits: number; balanceAfter: number; type: string; referenceId?: string; createdAt: string }> }>("/v1/credits/transactions?limit=20"),
    gwGet<{ days: number; totalRequests: number; totalCostCredits: number; byProvider?: Record<string, unknown> }>("/v1/credits/usage?days=7"),
  ]);
  return {
    balance,
    packs: packs?.packs ?? [],
    creditPurchaseContract: packs?.contractAddress,
    nookTokenAddress: packs?.nookTokenAddress,
    transactions: txs?.transactions ?? [],
    usage: usage,
    waysToGetMore: [
      { method: "Daily activity drip", detail: "Tier 2 = max 45 cr/day. Cross-category diversity required: content, social, marketplace, projects, tools, protocol. Diminishing returns per-category — we already hit content/social/protocol; gaining marketplace + projects would unlock more.", effort: "low" },
      { method: "Passive engagement", detail: "0.10/upvote, 0.15/comment, 0.50/citation on YOUR content. Citation-velocity loop already publishes 8 learnings/day and cites peers; reciprocal citations from peers are the main path here. Mostly automatic — accelerated by more reach (followers).", effort: "low" },
    ],
  };
}

// ── HTTP server ──────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function serveStatic(res: ServerResponse, path: string): boolean {
  const ext = (path.match(/\.[^.]+$/) ?? [".html"])[0];
  try {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    if (!st.isFile()) return false;
    const buf = readFileSync(path);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

function json(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

/**
 * Liveness of the autonomous daemon (`src/index.ts`) — distinct from THIS web
 * process. Primary signal: a live process whose command line includes
 * `src/index.ts` (covers `npm start` and `npm run dev`). Secondary: freshness of
 * the daemon's log (it writes constantly), used as a fallback if `pgrep` is
 * unavailable. Cached 4s so rapid polling can't spawn pgrep in a tight loop.
 */
interface DaemonStatus {
  running: boolean;
  lastActivityAgoSec: number | null;
  /** Identity from the instance-lock pidfile — null when no live holder. */
  identity: { pid: number; startedAt: string; gitRev: string | null } | null;
}
let daemonCache: (DaemonStatus & { at: number }) | null = null;
function daemonStatus(): DaemonStatus {
  const now = Date.now();
  if (daemonCache && now - daemonCache.at < 4000) {
    const { at: _at, ...rest } = daemonCache;
    return rest;
  }
  // Primary signal: the instance-lock pidfile — exact pid, no pattern match.
  // (pgrep -f "src/index.ts" also matches UNRELATED tsx projects, which made
  // the old check read "running" when only some other daemon was up.)
  let running = false;
  let identity: DaemonStatus["identity"] = null;
  let holderState: "none" | "stale" | "alive" | "ambiguous" = "none";
  try {
    const holder = holderStatus();
    holderState = holder.state;
    if (holder.state === "alive" || holder.state === "ambiguous") {
      running = true;
      identity = { pid: holder.info!.pid, startedAt: holder.info!.startedAt, gitRev: holder.info!.gitRev };
    }
  } catch {
    /* fall through to the legacy signals */
  }
  // pgrep fallback ONLY when there is no pidfile at all (pre-lock daemon
  // build). A stale pidfile is a definitive "dead" — pgrep would just
  // false-positive on unrelated tsx projects running a src/index.ts.
  if (!running && holderState === "none") {
    try {
      const r = spawnSync("pgrep", ["-f", "src/index.ts"], { encoding: "utf8", timeout: 2000 });
      running = r.status === 0 && r.stdout.trim().length > 0;
    } catch {
      running = false;
    }
  }
  // Freshness from the newest artifact the daemon actually touches. The bot logs
  // to stdout (redirected wherever the launcher points), so bot.log alone is
  // unreliable — instead take the newest mtime across the per-loop *.jsonl files
  // it appends to, plus the known log paths.
  let newestMs = 0;
  try {
    for (const f of readdirSync(NOOK_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        newestMs = Math.max(newestMs, statSync(join(NOOK_DIR, f)).mtimeMs);
      } catch {
        /* skip unreadable */
      }
    }
    for (const p of [BOT_LOG_PATH, join(NOOK_DIR, "logs", "daemon-live.log")]) {
      try {
        if (existsSync(p)) newestMs = Math.max(newestMs, statSync(p).mtimeMs);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  const lastActivityAgoSec = newestMs > 0 ? Math.max(0, Math.round((now - newestMs) / 1000)) : null;
  // Fallback: if neither pidfile nor pgrep could confirm but the log is very
  // fresh, treat as up. A STALE pidfile skips this — the daemon is known-dead
  // even if its files were touched seconds before the crash.
  if (!running && holderState === "none" && lastActivityAgoSec !== null && lastActivityAgoSec < 180) running = true;
  daemonCache = { running, lastActivityAgoSec, identity, at: now };
  return { running, lastActivityAgoSec, identity };
}

/**
 * Solve funnel — does our solved work actually get paid? Buckets our recent
 * submissions into paid / pending / rejected / expired. `expired` = the window
 * closed before quorum (forfeited, unpaid) — the signal that decides whether to
 * tilt the mining mix toward sandbox-graded verifiable kinds. While `expiredRate`
 * stays low, standard's higher EV wins despite the quorum lag; if it climbs,
 * standard work is being thrown away and a tilt becomes +EV.
 */
interface SolveFunnel {
  windowSize: number;
  buckets: { paid: number; pending: number; rejected: number; expired: number };
  resolved: number;
  paidRate: number | null;
  expiredRate: number | null;
  rejectedRate: number | null;
  paidNookSum: number;
  pending: { count: number; oldestAgeH: number | null; medianAgeH: number | null };
  generatedAt: string;
}

async function buildSolveFunnel(): Promise<SolveFunnel> {
  const r = await gwGet<{ submissions?: Array<Record<string, unknown>> }>(
    `/v1/mining/submissions/agent/${MY_ADDR}?limit=200`,
  );
  const subs = r?.submissions ?? [];
  const b = { paid: 0, pending: 0, rejected: 0, expired: 0 };
  let paidNookSum = 0;
  const pendingAgesH: number[] = [];
  const now = Date.now();
  for (const s of subs) {
    const status = String(s.status ?? "");
    if (status === "verified") {
      b.paid++;
      paidNookSum += num(s.rewardNook);
    } else if (status === "submitted") {
      b.pending++;
      const t = s.submittedAt ? new Date(String(s.submittedAt)).getTime() : NaN;
      if (Number.isFinite(t)) pendingAgesH.push((now - t) / 3600_000);
    } else if (status === "rejected") {
      b.rejected++;
    } else if (status === "expired") {
      b.expired++;
    }
  }
  const resolved = b.paid + b.rejected + b.expired;
  const rate = (x: number) => (resolved > 0 ? x / resolved : null);
  pendingAgesH.sort((a, c) => a - c);
  const median = pendingAgesH.length ? pendingAgesH[Math.floor((pendingAgesH.length - 1) / 2)] : null;
  return {
    windowSize: subs.length,
    buckets: b,
    resolved,
    paidRate: rate(b.paid),
    expiredRate: rate(b.expired),
    rejectedRate: rate(b.rejected),
    paidNookSum: Math.round(paidNookSum),
    pending: {
      count: b.pending,
      oldestAgeH: pendingAgesH.length ? Math.round(pendingAgesH[pendingAgesH.length - 1]) : null,
      medianAgeH: median != null ? Math.round(median) : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Most recent 02:00 UTC boundary at or before `now` — the mining epoch-day
 *  start (the daily cap counts from here, matching mining.ts epochDayStartMs). */
function epochStartMs(now: number): number {
  const d = new Date(now);
  const today2 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 2, 0, 0, 0);
  return now >= today2 ? today2 : today2 - 24 * 3600_000;
}

function bucketSolves(subs: Array<Record<string, unknown>>, lo: number, hi: number) {
  const b = { submitted: 0, paid: 0, pending: 0, rejected: 0, expired: 0, paidNook: 0 };
  for (const s of subs) {
    const t = s.submittedAt ? new Date(String(s.submittedAt)).getTime() : NaN;
    if (!Number.isFinite(t) || t < lo || t >= hi) continue;
    b.submitted++;
    const st = String(s.status ?? "");
    if (st === "verified") {
      b.paid++;
      b.paidNook += num(s.rewardNook);
    } else if (st === "submitted") b.pending++;
    else if (st === "rejected") b.rejected++;
    else if (st === "expired") b.expired++;
  }
  b.paidNook = Math.round(b.paidNook);
  return b;
}

/**
 * Current- and previous-epoch progress — the "today" view. Epochs reset at
 * 02:00 UTC; the gateway's submission cap counts from that boundary. Surfaces
 * how far through the epoch we are, solves/verifications used vs cap, the pace
 * we're on, the epoch's prize pools, and a recap of how the last epoch closed.
 */
async function buildEpochProgress() {
  const [epochRes, nextRes, subsRes] = await Promise.all([
    gwGet<{ epoch?: Record<string, unknown> }>("/v1/mining/epoch"),
    gwGet<{ timeUntilEpochSeconds?: number; timeUntilEpochHuman?: string; nextEpochTime?: string; currentEpoch?: number }>(
      "/v1/mining/next-epoch-time",
    ),
    gwGet<{ submissions?: Array<Record<string, unknown>> }>(`/v1/mining/submissions/agent/${MY_ADDR}?limit=200`),
  ]);
  const now = Date.now();
  const curStart = epochStartMs(now);
  const lastStart = curStart - 24 * 3600_000;
  const subs = subsRes?.submissions ?? [];

  const vstats = readJsonl<VerifyStatsEntry>(join(NOOK_DIR, "verification-stats.jsonl"));
  const vCount = (lo: number, hi: number) =>
    vstats.filter((e) => {
      const t = e.ts ? new Date(e.ts).getTime() : NaN;
      return Number.isFinite(t) && t >= lo && t < hi;
    }).length;

  const ep = epochRes?.epoch ?? {};
  const secondsRemaining =
    nextRes?.timeUntilEpochSeconds ?? Math.max(0, Math.round((curStart + 24 * 3600_000 - now) / 1000));
  const elapsedFrac = Math.min(1, Math.max(0, 1 - secondsRemaining / 86400));
  const SOLVE_CAP = Number(process.env.BOT_MINING_DAILY_CAP ?? 12);
  const VERIFY_CAP = 30;

  return {
    epoch: {
      number: ep.epochNumber ?? nextRes?.currentEpoch ?? null,
      status: ep.status ?? null,
      secondsRemaining,
      humanRemaining: nextRes?.timeUntilEpochHuman ?? null,
      nextEpochTime: nextRes?.nextEpochTime ?? null,
      elapsedFrac,
    },
    pools: {
      dailyEmission: ep.dailyEmission ?? null,
      agent: ep.agentPool ?? null,
      verification: ep.verificationPool ?? null,
      guild: ep.guildPool ?? null,
      poster: ep.posterPool ?? null,
    },
    caps: { solve: SOLVE_CAP, verify: VERIFY_CAP },
    current: { solves: bucketSolves(subs, curStart, now + 1), verifications: vCount(curStart, now + 1) },
    last: { solves: bucketSolves(subs, lastStart, curStart), verifications: vCount(lastStart, curStart) },
    generatedAt: new Date().toISOString(),
  };
}

/** Live status of the projects we've published (builder-reputation surface). */
let _rt: ReturnType<typeof getRuntime> | null = null;
let myProjectsCache: { data: unknown; at: number } | null = null;
async function buildMyProjects(): Promise<{ projects: unknown[] }> {
  const now = Date.now();
  if (myProjectsCache && now - myProjectsCache.at < 60_000) return myProjectsCache.data as { projects: unknown[] };
  let approved: Array<{ slug: string; name: string }> = [];
  try {
    approved = (JSON.parse(readFileSync(join(NOOK_DIR, "project-review-queue.json"), "utf8")) as Array<{ slug: string; name: string; status: string }>)
      .filter((i) => i.status === "approved");
  } catch { /* none yet */ }
  const rt = (_rt ??= getRuntime());
  const projects: unknown[] = [];
  for (const item of approved) {
    try {
      const lc = (await rt.tools.executeTool("list_project_commits", { projectId: item.slug }))?.output as { commits?: Array<Record<string, unknown>> };
      const commits = (lc.commits ?? []) as Array<Record<string, unknown>>;
      const head = commits[0] ?? {};
      const lf = (await rt.tools.executeTool("list_project_files", { projectId: item.slug }))?.output as { files?: Array<{ path?: string }> };
      projects.push({
        slug: item.slug,
        name: item.name,
        commits: commits.length,
        reviewStatus: head.reviewStatus ?? "?",
        approvals: head.approvals ?? 0,
        rejections: head.rejections ?? 0,
        linesAdded: commits.reduce((s, c) => s + (Number(c.linesAdded) || 0), 0),
        files: (lf.files ?? []).map((f) => f.path).filter(Boolean),
      });
    } catch { /* skip a project that won't load */ }
  }
  const data = { projects };
  myProjectsCache = { data, at: now };
  return data;
}

/**
 * Inbox snapshot for the dashboard. The flat /v1/inbox endpoint 500s, so the
 * inbox-watch tick reads the working /v1/inbox/threads view and writes
 * ~/.nookplot/inbox-threads.json; we serve that (file read — no gateway
 * dependency in the dashboard process). `ageMinutes` flags how stale it is.
 */
function buildInbox(): {
  unread: number;
  threadCount: number;
  updatedAt: string | null;
  ageMinutes: number | null;
  threads: unknown[];
} {
  try {
    const snap = JSON.parse(readFileSync(join(NOOK_DIR, "inbox-threads.json"), "utf8")) as {
      ts?: string;
      unread?: number;
      threadCount?: number;
      threads?: unknown[];
    };
    const ageMinutes = snap.ts ? Math.round((Date.now() - new Date(snap.ts).getTime()) / 60_000) : null;
    return {
      unread: snap.unread ?? -1,
      threadCount: snap.threadCount ?? snap.threads?.length ?? 0,
      updatedAt: snap.ts ?? null,
      ageMinutes,
      threads: snap.threads ?? [],
    };
  } catch {
    return { unread: -1, threadCount: 0, updatedAt: null, ageMinutes: null, threads: [] };
  }
}

/**
 * Daily capacity-utilization trend (mining solves /12, verify+crowd /38) so
 * chronic waste is visible day-over-day. Derived from the existing logs via
 * src/capacity.ts — no new persistence.
 */
function buildCapacity(): {
  miningCap: number;
  verifyCap: number;
  days: ReturnType<typeof readCapacity>;
  underuse: string | null;
  wasted: { miningPerDay: number; verifyPerDay: number };
} {
  const days = readCapacity(14);
  const n = Math.max(1, days.length);
  const miningWaste = days.reduce((s, d) => s + Math.max(0, d.miningCap - d.miningUsed), 0);
  const verifyWaste = days.reduce((s, d) => s + Math.max(0, d.verifyCap - d.verifyUsed), 0);
  return {
    miningCap: MINING_DAILY_CAP,
    verifyCap: days[0]?.verifyCap ?? 38,
    days,
    underuse: capacityUnderuse(days),
    wasted: {
      miningPerDay: Math.round((miningWaste / n) * 10) / 10,
      verifyPerDay: Math.round((verifyWaste / n) * 10) / 10,
    },
  };
}

/** The project draft (if any) awaiting the operator's approve/pass decision. */
function buildProjectReview(): { pending: null | { name: string; slug: string; tag: string; sourceCount: number; createdAt: string; assessment: string; excerpt: string } } {
  try {
    const queue: Array<{ slug: string; name: string; tag: string; sourceCount: number; status: string; createdAt: string }> =
      JSON.parse(readFileSync(join(NOOK_DIR, "project-review-queue.json"), "utf8"));
    const item = queue.find((i) => i.status === "pending");
    if (!item) return { pending: null };
    const dir = join(NOOK_DIR, "project-drafts", item.slug);
    let assessment = "";
    try {
      assessment = (JSON.parse(readFileSync(join(dir, "_peers.json"), "utf8")) as { assessment?: string }).assessment ?? "";
    } catch { /* none */ }
    let excerpt = "";
    try {
      excerpt = readFileSync(join(dir, "README.md"), "utf8").split("\n").slice(0, 12).join("\n");
    } catch { /* none */ }
    return { pending: { name: item.name, slug: item.slug, tag: item.tag, sourceCount: item.sourceCount, createdAt: item.createdAt, assessment, excerpt } };
  } catch {
    return { pending: null };
  }
}

/**
 * Experiment scorecard — the exec (artifact-rerun) and collab (peer-review)
 * reputation probes, aggregated from dimension-watch.jsonl + events-audit.jsonl
 * so we can read out "are the experiments moving the needle" without grepping.
 */
function buildExperiments(): {
  generatedAt: string;
  dims: null | { exec: number; collab: number; commits: number; projects: number; lines: number; score: number; velocity: number };
  trend: null | { snapshots: number; firstTs: string; lastTs: string; execDelta: number; collabDelta: number; scoreDelta: number };
  exec: {
    reruns: number; matchTrue: number; matchFalse: number; matchUnknown: number; abstains: number; landed: number; verdict: string;
    recent: Array<{ ts: string; submissionId: string; match: unknown; original: unknown; rerun: unknown }>;
  };
  collab: {
    lastReviewOnChainTs: string | null;
    reviewsGiven: Array<{ project: string; author: string; verdict: string; ts: string }>;
    note: string;
  };
} {
  const dims = readJsonlSafe<{ ts: string; exec: number; collab: number; commits: number; projects: number; lines: number; score: number; velocity: number }>(
    join(NOOK_DIR, "dimension-watch.jsonl"),
  );
  const last = dims.length ? dims[dims.length - 1] : null;
  const first = dims.length ? dims[0] : null;
  const trend = first && last
    ? {
        snapshots: dims.length,
        firstTs: first.ts,
        lastTs: last.ts,
        execDelta: (last.exec ?? 0) - (first.exec ?? 0),
        collabDelta: (last.collab ?? 0) - (first.collab ?? 0),
        scoreDelta: (last.score ?? 0) - (first.score ?? 0),
      }
    : null;

  const audit = readJsonlSafe<{ ts: string; surface: string; outcome: string; notes?: string; meta?: Record<string, unknown> }>(
    join(NOOK_DIR, "events-audit.jsonl"),
  );
  const reruns = audit.filter((e) => e.surface === "artifact_rerun");
  // `match` lives in meta on newer events and in the notes string on older ones
  // ("kind=… match=false") — read both so the count is correct across the log.
  const matchOf = (e: { notes?: string; meta?: Record<string, unknown> }): boolean | null => {
    if (typeof e.meta?.match === "boolean") return e.meta.match;
    if (/match=true/i.test(e.notes ?? "")) return true;
    if (/match=false/i.test(e.notes ?? "")) return false;
    return null;
  };
  const matchTrue = reruns.filter((e) => matchOf(e) === true).length;
  const matchFalse = reruns.filter((e) => matchOf(e) === false).length;
  const matchUnknown = reruns.length - matchTrue - matchFalse;
  const verifyEv = audit.filter((e) => e.surface === "verify");
  const abstains = verifyEv.filter((e) => e.outcome === "skipped" && /reproduce|abstain/i.test(e.notes ?? "")).length;
  const landed = verifyEv.filter((e) => e.outcome === "submitted" && /artifact/i.test(e.notes ?? "")).length;
  const recent = reruns.slice(-8).reverse().map((e) => ({
    ts: e.ts,
    submissionId: String(e.meta?.submissionId ?? "?"),
    match: matchOf(e),
    original: e.meta?.original ?? null,
    rerun: e.meta?.rerun ?? null,
  }));
  const verdict =
    reruns.length === 0 ? "no reruns yet — waiting for code submissions"
    : matchTrue > 0 && (last?.exec ?? 0) > 0 ? "exec moving — the rerun lever works"
    : matchTrue > 0 ? "match=true seen but exec still 0 — recompute lag, or exec ≠ reruns"
    : `0/${reruns.length} reruns reproduced — exec blocked (systematic non-reproduction)`;

  let reviewsGiven: Array<{ project: string; author: string; verdict: string; ts: string }> = [];
  try {
    const rq = JSON.parse(readFileSync(join(NOOK_DIR, "peer-review-queue.json"), "utf8")) as Array<{
      status: string; createdAt: string; projectName?: string; authorName?: string; verdict?: string;
    }>;
    reviewsGiven = rq
      .filter((i) => i.status === "approved")
      .map((i) => ({ project: i.projectName ?? "?", author: i.authorName ?? "?", verdict: i.verdict ?? "?", ts: i.createdAt }));
  } catch { /* none */ }
  const lastReviewOnChainTs = reviewsGiven.length ? reviewsGiven[reviewsGiven.length - 1].ts : null;
  const collabNote =
    (last?.collab ?? 0) > 0 ? "collab > 0 — a review/contribution scored"
    : lastReviewOnChainTs ? "review(s) on-chain but collab still 0 — comment verdicts may not score; MRs likely the lever"
    : "no substantive review on-chain yet";

  return {
    generatedAt: new Date().toISOString(),
    dims: last
      ? { exec: last.exec, collab: last.collab, commits: last.commits, projects: last.projects, lines: last.lines, score: last.score, velocity: last.velocity }
      : null,
    trend,
    exec: { reruns: reruns.length, matchTrue, matchFalse, matchUnknown, abstains, landed, verdict, recent },
    collab: { lastReviewOnChainTs, reviewsGiven, note: collabNote },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  if (req.method !== "GET") return json(res, 405, { error: "method-not-allowed" });

  // Optional bearer-token auth for /api/* when WEB_AUTH_TOKEN is set.
  // /api/health stays open so external monitors can ping without a token.
  if (WEB_AUTH_TOKEN && path.startsWith("/api/") && path !== "/api/health") {
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : url.searchParams.get("token") ?? "";
    if (presented !== WEB_AUTH_TOKEN) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="nookplot-bot"');
      return json(res, 401, { error: "unauthorized" });
    }
  }

  if (path === "/api/snapshot") {
    try { return json(res, 200, await buildSnapshot()); }
    catch (err) { return json(res, 500, { error: (err as Error).message }); }
  }
  if (path === "/api/history") {
    const metric = url.searchParams.get("metric") ?? "mining";
    try { return json(res, 200, await buildHistory(metric)); }
    catch (err) { return json(res, 500, { error: (err as Error).message }); }
  }
  if (path === "/api/blockers") {
    try {
      const snap = await buildSnapshot();
      return json(res, 200, { blockers: snap.blockers, generatedAt: snap.generatedAt });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  if (path === "/api/health") {
    // `daemon.running` is process liveness ONLY — it was true for all 53h of
    // the 2026-07-25 blackout. `gateway` is the half that says whether the
    // daemon can actually earn; the header badge must require both.
    const gateway = gatewayReachability(
      readJsonlTail<NetworkStatusEntry>(join(NOOK_DIR, "network-status.jsonl"), 12),
    );
    return json(res, 200, { ok: true, ts: new Date().toISOString(), daemon: daemonStatus(), gateway });
  }
  if (path === "/api/solve-funnel") {
    try {
      return json(res, 200, await buildSolveFunnel());
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  if (path === "/api/epoch-progress") {
    try {
      return json(res, 200, await buildEpochProgress());
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  if (path === "/api/project-review") {
    return json(res, 200, buildProjectReview());
  }
  if (path === "/api/inbox") {
    return json(res, 200, buildInbox());
  }
  if (path === "/api/capacity") {
    return json(res, 200, buildCapacity());
  }
  if (path === "/api/experiments") {
    return json(res, 200, buildExperiments());
  }
  if (path === "/api/my-projects") {
    try {
      return json(res, 200, await buildMyProjects());
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  if (path === "/api/log") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
    return json(res, 200, tailBotLog(limit));
  }
  if (path === "/api/sidetracks") {
    return json(res, 200, await buildSidetracks());
  }
  if (path === "/api/credits") {
    return json(res, 200, await buildCredits());
  }
  if (path === "/api/mcp-tracks") {
    return json(res, 200, {
      bounties: bountySummary(),
      clarifications: clarificationSummary(),
      swarms: swarmSummary(),
      weeklyRewards: weeklyRewardSummary(),
      teaching: teachingSummary(),
      attention: attentionSummary(),
      diagnostics: diagnosticsSummary(),
      subscriptions: subscriptionSummary(),
      egress: egressSummary(),
      generatedAt: new Date().toISOString(),
    });
  }
  if (path === "/api/verdicts") {
    return json(res, 200, {
      verdicts: readJsonl<{ ts?: string; kind?: string; details?: unknown }>(join(NOOK_DIR, "diagnostics.jsonl"))
        .filter((e) => e.kind === "verdict-pull")
        .slice(-200),
    });
  }
  if (path === "/api/audit") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
    return json(res, 200, { events: recentAudit(limit), summary: auditSummary() });
  }
  // Static files. If WEB_AUTH_TOKEN is set, inject it into the dashboard HTML
  // so the front-end's `fetch("/api/...")` calls include the token. This is
  // safe because the token-protected page is only served to whoever can
  // already read the file (i.e. the operator visiting the URL).
  if (path === "/" || path === "/dashboard.html") {
    const htmlPath = join(PUBLIC_DIR, "dashboard.html");
    if (existsSync(htmlPath)) {
      let html = readFileSync(htmlPath, "utf8");
      if (WEB_AUTH_TOKEN) {
        const inject = `<script>window.__AUTH_TOKEN__ = ${JSON.stringify(WEB_AUTH_TOKEN)};</script>`;
        html = html.replace(/<head>/i, "<head>\n" + inject);
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(html);
      return;
    }
  }
  const fpath = path === "/" ? join(PUBLIC_DIR, "dashboard.html") : join(PUBLIC_DIR, path.replace(/^\//, ""));
  if (!fpath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
  if (serveStatic(res, fpath)) return;
  return json(res, 404, { error: "not-found", path });
}

createServer(handle).listen(PORT, BIND, () => {
  console.log(`🌐 nookplot-bot web dashboard → http://${BIND}:${PORT}`);
  console.log(`   serving public/ from ${PUBLIC_DIR}`);
  console.log(`   stop with Ctrl+C`);
});
