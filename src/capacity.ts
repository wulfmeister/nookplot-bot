/**
 * Daily capacity-utilization tracker.
 *
 * We have two hard daily ceilings that, if left unused, are pure wasted
 * earning potential:
 *   - mining solves: 12 regular / rolling 24h (gateway "Maximum 12 regular")
 *   - verify+crowd:  38 / ROLLING 24h (BOT_VERIFY_SHARED_CAP) — like mining, the
 *     gateway's window is rolling; this trend still buckets by calendar UTC day
 *     (approximate, same as the mining series) purely for a readable day view.
 *
 * The raw data already lives in mining-submissions.jsonl + quotas.jsonl; this
 * module aggregates it into a day-over-day utilization trend so chronic waste
 * (the alternating 12/0 mining bug, the ~25% verify under-use) is visible at a
 * glance instead of needing an ad-hoc query. Used by:
 *   - `npm run capacity` (CLI table, below)
 *   - the dashboard `/api/capacity` panel
 *   - the hourly observer's chronic-under-use flag
 */
import { join } from "node:path";
import { NOOK_DIR, readJsonl } from "./util.js";
import { VERIFY_SHARED_CAP } from "./quotas.js";

// Gateway's REGULAR-submission ceiling is 12 per rolling 24h (see mining.ts
// REGULAR_ROLLING_CAP). We bucket by calendar UTC day for the trend — close
// enough to the 02:00 epoch boundary that the daily pattern is unambiguous.
export const MINING_DAILY_CAP = 12;

export interface DayUtil {
  date: string; // YYYY-MM-DD (UTC)
  miningUsed: number;
  miningCap: number;
  miningPct: number; // can exceed 100 (e.g. a 13th incl. guild-exclusive)
  verifyUsed: number;
  verifyCap: number;
  verifyPct: number;
  /**
   * Traces that cleared the anti-farm abstention gate that day — i.e. how much
   * GENUINE work was actually available to verify. The 38/day cap is not the
   * right denominator: ~94% of the pool is Sybil-farm spam we correctly abstain
   * on, so measuring against the cap reports "under-use" for behaving
   * correctly. Undefined on days predating the trace cache.
   */
  verifyEligible?: number;
}

interface MiningRow { ts?: string; outcome?: string }
interface QuotaRow { ts?: string; kind?: string }

/**
 * Pure aggregation: bucket accepted mining solves (deferred/pass) and
 * verify+crowd actions by UTC calendar day, for the last `days` days ending at
 * `nowMs`. Days with no activity are included as zeros. Testable.
 */
export function aggregateCapacity(
  miningRows: MiningRow[],
  quotaRows: QuotaRow[],
  days: number,
  nowMs: number,
  miningCap: number = MINING_DAILY_CAP,
  verifyCap: number = VERIFY_SHARED_CAP,
): DayUtil[] {
  const mine: Record<string, number> = {};
  const ver: Record<string, number> = {};
  for (const r of miningRows) {
    if (!r.ts) continue;
    if (r.outcome === "deferred" || r.outcome === "pass") {
      const d = r.ts.slice(0, 10);
      mine[d] = (mine[d] ?? 0) + 1;
    }
  }
  for (const r of quotaRows) {
    if (!r.ts) continue;
    if (r.kind === "verify" || r.kind === "crowd-score") {
      const d = r.ts.slice(0, 10);
      ver[d] = (ver[d] ?? 0) + 1;
    }
  }
  const out: DayUtil[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(nowMs - i * 24 * 3600_000).toISOString().slice(0, 10);
    const miningUsed = mine[date] ?? 0;
    const verifyUsed = ver[date] ?? 0;
    out.push({
      date,
      miningUsed,
      miningCap,
      miningPct: Math.round((miningUsed / miningCap) * 100),
      verifyUsed,
      verifyCap,
      verifyPct: Math.round((verifyUsed / verifyCap) * 100),
    });
  }
  return out;
}

/** Read the raw logs and aggregate the last `days` days of utilization. */
export function readCapacity(days = 14, nowMs = Date.now()): DayUtil[] {
  const rows = aggregateCapacity(
    readJsonl<MiningRow>(join(NOOK_DIR, "mining-submissions.jsonl")),
    readJsonl<QuotaRow>(join(NOOK_DIR, "quotas.jsonl")),
    days,
    nowMs,
  );
  // Genuine verify supply per day = traces that cleared the anti-farm gate.
  const eligible = new Map<string, number>();
  for (const r of readJsonl<{ ts?: string; abstained?: boolean }>(join(NOOK_DIR, "verify-trace-cache.jsonl"))) {
    if (!r.ts || r.abstained) continue;
    const d = r.ts.slice(0, 10);
    eligible.set(d, (eligible.get(d) ?? 0) + 1);
  }
  // Only attach where the cache actually covers the day, so older days keep
  // the cap-based denominator rather than silently reading as zero supply.
  const covered = new Set<string>();
  for (const r of readJsonl<{ ts?: string }>(join(NOOK_DIR, "verify-trace-cache.jsonl"))) {
    if (r.ts) covered.add(r.ts.slice(0, 10));
  }
  return rows.map((d) => (covered.has(d.date) ? { ...d, verifyEligible: eligible.get(d.date) ?? 0 } : d));
}

/**
 * Chronic-under-use check over the last `window` complete-ish days (excludes
 * today, which is still filling). Returns a flag string when the trailing
 * average utilization is below the floor, else null. Pure. Used by the observer.
 */
export function capacityUnderuse(
  rows: DayUtil[],
  opts: { window?: number; miningFloor?: number; verifyFloor?: number } = {},
): string | null {
  const window = opts.window ?? 5;
  const miningFloor = opts.miningFloor ?? 0.6;
  const verifyFloor = opts.verifyFloor ?? 0.5;
  // Drop the most recent day (partial) then take the trailing `window`.
  const complete = rows.slice(0, -1);
  const recent = complete.slice(-window);
  if (recent.length < window) return null;
  const avg = (sel: (d: DayUtil) => number) => recent.reduce((s, d) => s + sel(d), 0) / recent.length;
  const mPct = avg((d) => d.miningUsed / d.miningCap);
  // Verify utilization is measured against GENUINE SUPPLY, not the raw cap.
  // Chasing the cap would mean verifying spam — and because quorum is a COUNT
  // with no reject field, every spam verification advances that spam toward
  // payment. This metric previously reported "verify 15% (floor 50%)" while the
  // correct behavior was to abstain on ~94% of the pool: it was coaching the
  // operator to subsidize the farm.
  const denom = (d: DayUtil) => (d.verifyEligible === undefined ? d.verifyCap : Math.min(d.verifyCap, d.verifyEligible));
  const measurable = recent.filter((d) => denom(d) > 0);
  const vPct = measurable.length
    ? measurable.reduce((s, d) => s + d.verifyUsed / denom(d), 0) / measurable.length
    : 1; // nothing genuine was available — that is not under-use
  const flags: string[] = [];
  if (mPct < miningFloor) flags.push(`mining avg ${(mPct * 100).toFixed(0)}% over ${window}d (floor ${(miningFloor * 100).toFixed(0)}%)`);
  if (vPct < verifyFloor) {
    const basis = recent.some((d) => d.verifyEligible !== undefined) ? "of genuine (non-spam) supply" : "of cap";
    flags.push(`verify avg ${(vPct * 100).toFixed(0)}% ${basis} over ${window}d (floor ${(verifyFloor * 100).toFixed(0)}%)`);
  }
  return flags.length ? `capacity under-use: ${flags.join("; ")}` : null;
}

// ── CLI: `npm run capacity [days]` ────────────────────────────────────────
function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "█".repeat(filled) + "·".repeat(10 - filled);
}

function runCli(): void {
  const days = Math.max(1, Number(process.argv[2] ?? 14));
  const rows = readCapacity(days);
  console.log(`Capacity utilization — last ${days} UTC days (mining cap ${MINING_DAILY_CAP}/24h, verify cap ${VERIFY_SHARED_CAP}/24h; both rolling, bucketed by calendar day)\n`);
  console.log("UTC-day      mining               verify");
  let mWaste = 0, vWaste = 0;
  for (const r of rows) {
    mWaste += Math.max(0, r.miningCap - r.miningUsed);
    vWaste += Math.max(0, r.verifyCap - r.verifyUsed);
    console.log(
      `${r.date}  ${String(r.miningUsed).padStart(2)}/${r.miningCap} ${bar(r.miningPct)} ${String(r.miningPct).padStart(3)}%   ` +
      `${String(r.verifyUsed).padStart(2)}/${r.verifyCap} ${bar(r.verifyPct)} ${String(r.verifyPct).padStart(3)}%`,
    );
  }
  const n = rows.length;
  console.log(`\nWasted over ${n} days: mining ${mWaste} solves (~${(mWaste / n).toFixed(1)}/day), verify ${vWaste} slots (~${(vWaste / n).toFixed(1)}/day)`);
  const flag = capacityUnderuse(rows);
  if (flag) console.log(`\n⚠ ${flag}`);
}

if (import.meta.url === `file://${process.argv[1]}`) runCli();
