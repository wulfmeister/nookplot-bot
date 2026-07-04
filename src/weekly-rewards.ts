/**
 * Weekly tier-reward epoch tracking. Distinct from mining Merkle pool —
 * this is a contribution-tier reward distributed weekly to active agents.
 *
 * Endpoints:
 *   GET  /v1/rewards/weekly/current   — epoch info (number, time remaining, pool, tier thresholds)
 *   GET  /v1/rewards/weekly/me        — my history (per-epoch tier + amount + claim status)
 *
 * The claim itself happens through the same MiningRewardPool merkle flow we
 * already use in src/mining.ts (claimMiningOnChain), because the gateway
 * bundles weekly rewards into the same Merkle root. So this file is read-only:
 * it logs unclaimed entries to a JSONL so the dashboard + summary can show
 * what's outstanding.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "weekly-rewards.jsonl");

export interface WeeklyEpochInfo {
  epochNumber?: number;
  startsAt?: string;
  endsAt?: string;
  msRemaining?: number;
  poolSize?: number | string;
  tierThresholds?: Record<string, number>;
  myCurrentTier?: string;
  myCurrentRank?: number;
}

export interface WeeklyRewardRow {
  epochNumber: number;
  tier?: string;
  rank?: number;
  score?: number;
  amount?: number | string;
  amountToken?: string;
  claimed?: boolean;
  claimedAt?: string | null;
  startsAt?: string;
  endsAt?: string;
}

interface LogEntry {
  ts: string;
  kind: "epoch" | "row" | "alert";
  epochNumber?: number;
  details?: unknown;
}

export async function fetchCurrentEpoch(runtime: RuntimeLike): Promise<WeeklyEpochInfo | null> {
  try {
    const res = (await runtime.connection.request("GET", `/v1/rewards/weekly/current`)) as WeeklyEpochInfo;
    return res;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return null;
    console.warn(`🏆 weekly epoch fetch failed: ${msg}`);
    return null;
  }
}

export async function fetchMyHistory(runtime: RuntimeLike, limit = 12): Promise<WeeklyRewardRow[]> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/rewards/weekly/me?limit=${limit}`,
    )) as { rewards?: WeeklyRewardRow[]; items?: WeeklyRewardRow[] };
    return res.rewards ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    console.warn(`🏆 weekly history fetch failed: ${msg}`);
    return [];
  }
}

export async function runWeeklyRewardsTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_WEEKLY_REWARDS_LOOP === "0") return;
  const [epoch, history] = await Promise.all([fetchCurrentEpoch(runtime), fetchMyHistory(runtime, 12)]);
  if (epoch) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "epoch" as const,
      epochNumber: epoch.epochNumber,
      details: epoch,
    });
    if (epoch.msRemaining !== undefined && epoch.msRemaining < 6 * 3600_000) {
      console.log(
        `🏆 weekly epoch #${epoch.epochNumber} ends in ${Math.round(epoch.msRemaining / 3600_000)}h — ` +
          `my tier=${epoch.myCurrentTier ?? "?"} rank=${epoch.myCurrentRank ?? "?"}`,
      );
    }
  }
  // Log any unclaimed historical rewards (one-time per epoch)
  const seen = new Set(
    readJsonl<LogEntry>(LOG).filter((e) => e.kind === "row").map((e) => e.epochNumber),
  );
  let unclaimedNew = 0;
  for (const r of history) {
    if (seen.has(r.epochNumber)) continue;
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "row" as const, epochNumber: r.epochNumber, details: r });
    if (!r.claimed && r.amount && Number(r.amount) > 0) {
      unclaimedNew += 1;
      console.log(
        `🏆 unclaimed weekly: epoch #${r.epochNumber} tier=${r.tier ?? "?"} ` +
          `amount=${r.amount} ${r.amountToken ?? "NOOK"} → run claimMiningOnChain to sweep`,
      );
    }
  }
  if (unclaimedNew > 0) {
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "alert" as const, details: { unclaimedNew } });
  }
}

export interface WeeklyRewardSummary {
  currentEpoch?: number;
  hoursRemaining?: number;
  currentTier?: string;
  currentRank?: number;
  unclaimedCount: number;
  unclaimedAmount: number;
  totalEarned: number;
}

export function weeklyRewardSummary(): WeeklyRewardSummary {
  const all = readJsonl<LogEntry>(LOG);
  const lastEpoch = all
    .filter((e) => e.kind === "epoch")
    .map((e) => e.details as WeeklyEpochInfo)
    .pop();
  const rows = all.filter((e) => e.kind === "row").map((e) => e.details as WeeklyRewardRow);
  let unclaimedCount = 0;
  let unclaimedAmount = 0;
  let totalEarned = 0;
  for (const r of rows) {
    const amt = Number(r.amount ?? 0);
    if (!Number.isFinite(amt)) continue;
    totalEarned += amt;
    if (!r.claimed) {
      unclaimedCount += 1;
      unclaimedAmount += amt;
    }
  }
  return {
    currentEpoch: lastEpoch?.epochNumber,
    hoursRemaining: lastEpoch?.msRemaining ? Math.round(lastEpoch.msRemaining / 3600_000) : undefined,
    currentTier: lastEpoch?.myCurrentTier,
    currentRank: lastEpoch?.myCurrentRank,
    unclaimedCount,
    unclaimedAmount,
    totalEarned,
  };
}
