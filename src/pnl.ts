/**
 * Daily P&L: inference spend (venice-costs.jsonl) joined against claimed
 * earnings, per calendar day (UTC). Powers the dashboard's earnings-vs-spend
 * section — the 2026-07-04 cost audit found the bot was netting ~-$5/day
 * without anyone noticing because spend and earnings lived in different logs.
 *
 * Attribution caveat (documented in the UI): earnings credit at the ~02:00Z
 * claim for the PRIOR epoch's work, while spend accrues the day the calls
 * happen — so a single day's net is ~1 day misaligned; the multi-day trend is
 * the honest signal.
 */
import { join } from "node:path";
import { NOOK_DIR, readJsonl } from "./util.js";

const VENICE_COSTS = join(NOOK_DIR, "venice-costs.jsonl");

export interface DaySpend {
  date: string;      // YYYY-MM-DD (UTC)
  spendUsd: number;  // Venice credits ≈ USD (blended catalog rates, biased high)
  calls: number;
}

/**
 * Sum per-call cost records into a per-day series covering the FULL trailing
 * window — days with zero calls appear with spendUsd 0, so joins against an
 * earnings series never drop days. Pure — testable.
 */
export function dailySpendSeries(
  entries: Array<{ ts?: string; estCost?: number }>,
  days: number,
  nowMs: number,
): DaySpend[] {
  const byDate = new Map<string, { spendUsd: number; calls: number }>();
  for (let i = days - 1; i >= 0; i--) {
    byDate.set(new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10), { spendUsd: 0, calls: 0 });
  }
  for (const e of entries) {
    if (!e.ts || typeof e.estCost !== "number" || !Number.isFinite(e.estCost)) continue;
    const d = byDate.get(e.ts.slice(0, 10));
    if (!d) continue; // outside window
    d.spendUsd += e.estCost;
    d.calls += 1;
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, spendUsd: v.spendUsd, calls: v.calls }));
}

export function readDailySpend(days = 30, nowMs = Date.now()): DaySpend[] {
  return dailySpendSeries(readJsonl<{ ts?: string; estCost?: number }>(VENICE_COSTS), days, nowMs);
}
