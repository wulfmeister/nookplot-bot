/**
 * Network-status checker.
 *
 * Periodic poll of the gateway's epoch + verifier-pool + spot-check state.
 * Logs a one-line health summary to console + JSONL so we can trend
 * verifier supply against our own submission backlog over time.
 *
 * What we measure:
 *   - Epoch state: number, status (open/closed), daily emission pool size
 *   - Verifiable pool depth + verification-count distribution (how starved?)
 *   - RLM spot-check queue depth + our remaining daily budget
 *   - Our own pending-quorum count (how many of OUR submissions are stuck?)
 *
 * Output line shape:
 *   🌐 epoch=66 pool=82/0v/9v1/9v2 rlm=0 mine=11pending(0v=7,1v=4) emission=5.0M
 *
 *   epoch=66        — current epoch number
 *   pool=82/0v/...  — verifiable pool: total / 0 verifications / 1 / 2
 *   rlm=0           — RLM spot-checks pending
 *   mine=11pending  — our submissions still awaiting quorum
 *   emission=5.0M   — daily NOOK emission for the epoch
 *
 * Toggle off with BOT_NETWORK_STATUS=0. Logs to ~/.nookplot/network-status.jsonl.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG_PATH = join(NOOK_DIR, "network-status.jsonl");

interface EpochResp {
  epoch?: {
    epochNumber?: number;
    dailyEmission?: number;
    agentPool?: number;
    verificationPool?: number;
    guildPool?: number;
    posterPool?: number;
    status?: string;
    isEmergencyReserve?: boolean;
    consecutiveReserveDays?: number;
  };
}

interface VerifiableSub {
  id?: string;
  /**
   * Gateway returns this as a STRING, not a number, despite the column being
   * integer in the schema. Always coerce via `vcount(s)` before comparing.
   */
  verification_count?: number | string;
  solver_address?: string;
  difficulty?: string;
  verifier_kind?: string | null;
}

export function vcount(s: VerifiableSub): number {
  const v = s.verification_count;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

interface RlmResp {
  trajectories?: unknown[];
  dailyCount?: number;
  dailyCap?: number;
}

interface AgentStats {
  claimableBalance?: Record<string, number>;
  pendingRewards?: number;
  totalSolves?: number;
  totalEarned?: number;
}

interface MySub {
  id?: string;
  status?: string;
  rewardStatus?: string;
}

export interface NetworkStatusSnapshot {
  ts: string;
  epoch?: number;
  epochStatus?: string;
  dailyEmissionNook?: number;
  verifierPoolNook?: number;
  pool: {
    total: number;
    v0: number;
    v1: number;
    v2: number;
    quorumReady: number; // verification_count >= 3
    byDifficulty: Record<string, number>;
    distinctSolvers: number;
  };
  rlm: {
    pending: number;
    dailyDone: number;
    dailyCap: number;
  };
  mine: {
    pendingSubs: number;
    avgVerifierCount?: number;
    claimableNook: number;
    pendingRewards: number;
    totalSolves: number;
  };
  emergencyReserve: boolean;
}

async function safeGet<T>(runtime: RuntimeLike, path: string): Promise<T | null> {
  try {
    return (await runtime.connection.request("GET", path)) as T;
  } catch {
    return null;
  }
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

export async function pollNetworkStatus(
  runtime: RuntimeLike,
  myAddress: string | null,
): Promise<NetworkStatusSnapshot | null> {
  if (process.env.BOT_NETWORK_STATUS === "0") return null;

  const [epochRes, poolRes, rlmRes] = await Promise.all([
    safeGet<EpochResp>(runtime, "/v1/mining/epoch"),
    safeGet<{ submissions?: VerifiableSub[] }>(runtime, "/v1/mining/submissions/verifiable?limit=200"),
    safeGet<RlmResp>(runtime, "/v1/mining/spot-checks/pending?limit=1"),
  ]);

  // Pool distribution
  const subs = poolRes?.submissions ?? [];
  const v0 = subs.filter((s) => vcount(s) === 0).length;
  const v1 = subs.filter((s) => vcount(s) === 1).length;
  const v2 = subs.filter((s) => vcount(s) === 2).length;
  const quorumReady = subs.filter((s) => vcount(s) >= 3).length;
  const byDifficulty: Record<string, number> = {};
  for (const s of subs) {
    const d = s.difficulty ?? "?";
    byDifficulty[d] = (byDifficulty[d] ?? 0) + 1;
  }
  const solverSet = new Set<string>();
  for (const s of subs) if (s.solver_address) solverSet.add(s.solver_address.toLowerCase());

  // Our pending submissions
  let mineStats = { pendingSubs: 0, claimableNook: 0, pendingRewards: 0, totalSolves: 0, avgVerifierCount: undefined as number | undefined };
  if (myAddress) {
    const [mySubsRes, agentStats] = await Promise.all([
      safeGet<{ submissions?: MySub[] }>(runtime, `/v1/mining/submissions/agent/${encodeURIComponent(myAddress)}?limit=50`),
      safeGet<AgentStats>(runtime, `/v1/mining/stats/agent/${encodeURIComponent(myAddress)}`),
    ]);
    const mySubs = mySubsRes?.submissions ?? [];
    const pending = mySubs.filter((s) => s.status === "submitted");
    mineStats.pendingSubs = pending.length;
    // Sample verifier counts on a few of our pending (gateway one-at-a-time)
    // — skip if too many to avoid slow polls. Limit to 5.
    if (pending.length > 0 && pending.length <= 12) {
      const counts: number[] = [];
      for (const s of pending.slice(0, 5)) {
        if (!s.id) continue;
        const detail = await safeGet<{ verificationStatus?: { verificationCount?: number } }>(
          runtime,
          `/v1/mining/submissions/${encodeURIComponent(s.id)}`,
        );
        const vc = detail?.verificationStatus?.verificationCount;
        if (typeof vc === "number") counts.push(vc);
      }
      if (counts.length > 0) {
        mineStats.avgVerifierCount = counts.reduce((a, b) => a + b, 0) / counts.length;
      }
    }
    const claim = agentStats?.claimableBalance ?? {};
    mineStats.claimableNook = Object.values(claim).reduce((a, b) => a + (b ?? 0), 0);
    mineStats.pendingRewards = agentStats?.pendingRewards ?? 0;
    mineStats.totalSolves = agentStats?.totalSolves ?? 0;
  }

  const snapshot: NetworkStatusSnapshot = {
    ts: new Date().toISOString(),
    epoch: epochRes?.epoch?.epochNumber,
    epochStatus: epochRes?.epoch?.status,
    dailyEmissionNook: epochRes?.epoch?.dailyEmission,
    verifierPoolNook: epochRes?.epoch?.verificationPool,
    pool: {
      total: subs.length,
      v0,
      v1,
      v2,
      quorumReady,
      byDifficulty,
      distinctSolvers: solverSet.size,
    },
    rlm: {
      pending: (rlmRes?.trajectories ?? []).length,
      dailyDone: rlmRes?.dailyCount ?? 0,
      dailyCap: rlmRes?.dailyCap ?? 10,
    },
    mine: mineStats,
    emergencyReserve: Boolean(epochRes?.epoch?.isEmergencyReserve),
  };

  // One-line log to stdout. Density: ≤120 chars.
  const blockedPct = snapshot.pool.total > 0 ? Math.round((snapshot.pool.v0 / snapshot.pool.total) * 100) : 0;
  const avgV = mineStats.avgVerifierCount !== undefined ? ` avgV=${mineStats.avgVerifierCount.toFixed(1)}` : "";
  const reserve = snapshot.emergencyReserve ? " 🚨RESERVE" : "";
  console.log(
    `🌐 epoch=${snapshot.epoch ?? "?"}(${snapshot.epochStatus ?? "?"}) ` +
      `pool=${snapshot.pool.total}(${blockedPct}%v0,${snapshot.pool.v1}v1,${snapshot.pool.v2}v2) ` +
      `rlm=${snapshot.rlm.pending}(${snapshot.rlm.dailyDone}/${snapshot.rlm.dailyCap}) ` +
      `mine=${mineStats.pendingSubs}pending${avgV} ` +
      `claim=${mineStats.claimableNook.toFixed(0)} ` +
      `emit=${fmtNum(snapshot.dailyEmissionNook)}` +
      reserve,
  );

  appendJsonl(LOG_PATH, snapshot);
  return snapshot;
}

export async function startNetworkStatusLoop(
  runtime: RuntimeLike,
  myAddress: string | null,
): Promise<void> {
  if (process.env.BOT_NETWORK_STATUS === "0") return;
  // First snapshot 45s after boot (lets the bot settle), then every 30 min.
  setTimeout(() => pollNetworkStatus(runtime, myAddress).catch(() => undefined), 45_000);
  setInterval(() => pollNetworkStatus(runtime, myAddress).catch(() => undefined), 30 * 60 * 1000);
}
