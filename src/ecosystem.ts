/**
 * Partner-protocol ecosystem stats — Botcoin, Hermes, etc.
 *
 * Used to surface partner-protocol leaderboards + my work-receipts on the
 * dashboard. Read-only.
 *
 * Endpoints:
 *   GET /v1/index/agents/:address/work-receipts?protocol=&limit=
 *   GET /v1/index/work-receipts/stats?protocol=
 *   GET /v1/index/work-receipts/leaderboard?protocol=&sort=&limit=
 *   GET /v1/protocols/:protocol/milestones
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface WorkReceipt {
  id: string;
  protocol: string;
  amount?: number;
  ts?: string;
  reason?: string;
}

export interface EcosystemStats {
  protocol: string;
  totalMiners?: number;
  totalSolves?: number;
  totalCreditsDistributed?: number;
  totalReceipts?: number;
  generatedAt?: string;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName?: string;
  totalCredits?: number;
  receiptCount?: number;
}

export interface ProtocolMilestone {
  id: string;
  title: string;
  description?: string;
  status?: "upcoming" | "active" | "completed";
  due?: string;
}

const PROTOCOLS = ["botcoin", "nookplot", "hermes"];
const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 30 * 60_000;

async function memo<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data as T;
  try {
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

export async function fetchEcosystemStats(
  runtime: RuntimeLike,
  protocol: string,
): Promise<EcosystemStats | null> {
  return memo(`stats:${protocol}`, async () => {
    return (await runtime.connection.request(
      "GET",
      `/v1/index/work-receipts/stats?protocol=${encodeURIComponent(protocol)}`,
    )) as EcosystemStats;
  });
}

export async function fetchLeaderboard(
  runtime: RuntimeLike,
  protocol: string,
  limit = 20,
): Promise<LeaderboardEntry[]> {
  const data = await memo(`lb:${protocol}:${limit}`, async () => {
    return (await runtime.connection.request(
      "GET",
      `/v1/index/work-receipts/leaderboard?protocol=${encodeURIComponent(
        protocol,
      )}&sort=credits&limit=${limit}`,
    )) as { entries?: LeaderboardEntry[]; items?: LeaderboardEntry[] };
  });
  return data?.entries ?? data?.items ?? [];
}

export async function fetchMyWorkReceipts(
  runtime: RuntimeLike,
  protocol: string,
): Promise<WorkReceipt[]> {
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
  if (!me) return [];
  const data = await memo(`receipts:${protocol}:${me}`, async () => {
    return (await runtime.connection.request(
      "GET",
      `/v1/index/agents/${encodeURIComponent(me)}/work-receipts?protocol=${encodeURIComponent(
        protocol,
      )}&limit=100`,
    )) as { receipts?: WorkReceipt[]; items?: WorkReceipt[] };
  });
  return data?.receipts ?? data?.items ?? [];
}

export async function fetchMilestones(
  runtime: RuntimeLike,
  protocol: string,
): Promise<ProtocolMilestone[]> {
  const data = await memo(`milestones:${protocol}`, async () => {
    return (await runtime.connection.request(
      "GET",
      `/v1/protocols/${encodeURIComponent(protocol)}/milestones`,
    )) as { milestones?: ProtocolMilestone[]; items?: ProtocolMilestone[] };
  });
  return data?.milestones ?? data?.items ?? [];
}

export interface EcosystemSummary {
  protocols: Array<{
    protocol: string;
    totalMiners?: number;
    totalSolves?: number;
    myReceipts: number;
    myCredits: number;
    myRank?: number;
  }>;
}

export async function gatherEcosystemSummary(runtime: RuntimeLike): Promise<EcosystemSummary> {
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
  const out: EcosystemSummary = { protocols: [] };
  for (const p of PROTOCOLS) {
    const [stats, receipts, lb] = await Promise.all([
      fetchEcosystemStats(runtime, p),
      fetchMyWorkReceipts(runtime, p),
      fetchLeaderboard(runtime, p, 100),
    ]);
    const myCredits = receipts.reduce((s, r) => s + (r.amount ?? 0), 0);
    const myRank = lb.findIndex((e) => e.address.toLowerCase() === me);
    out.protocols.push({
      protocol: p,
      totalMiners: stats?.totalMiners,
      totalSolves: stats?.totalSolves,
      myReceipts: receipts.length,
      myCredits,
      myRank: myRank >= 0 ? myRank + 1 : undefined,
    });
  }
  return out;
}
