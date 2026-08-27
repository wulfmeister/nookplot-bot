/**
 * Settlement backfill — batch reconciliation of gateway payout truth into
 * local state.
 *
 * Why this exists (2026-08-27): mining-verified.jsonl's ONLY writer was the
 * learnings loop, which polls 3 candidates per tick oldest-first — so three
 * non-terminal head rows (younger than the 7-day age-out) starve everything
 * behind them, and the ledger missed every quorum flip after 08-24T14:50.
 * Both 08-18 floor-released submissions were PAID ~55.8k on 08-21 while
 * local state still said "deferred". One batch GET
 * (/v1/mining/submissions/agent?limit=100 — caps at 100, ignores offset)
 * reconciles the whole recent window per tick.
 *
 * This ledger (~/.nookplot/mining-settlements.jsonl) is also the input for
 * K-hat: per-solve attribution (2026-08-27, 100-row join) proved
 * realized = compositeScore × K with K batch-constant per settlement epoch —
 * the discover-time estimatedRewardNook carries ZERO per-challenge
 * information. Ranking therefore needs trailing realized/comp per kind from
 * OUR OWN paid rows, which is exactly what this file accumulates.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

const SETTLEMENTS_LOG = join(NOOK_DIR, "mining-settlements.jsonl");
const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");

export interface GatewaySubmissionRow {
  id?: string;
  challengeId?: string;
  status?: string;
  rewardStatus?: string;
  rewardNook?: string | number;
  compositeScore?: string | number;
  modelUsed?: string;
  submittedAt?: string;
  verifiedAt?: string;
}

export interface SettlementRow {
  ts: string;
  submissionId: string;
  challengeId?: string;
  verifierKind?: string;
  model?: string;
  /** Gateway terminal status at reconciliation: verified | expired | rejected. */
  status: string;
  /** Realized payout — ONLY set when rewardStatus === "paid" (pre-paid
   *  rewardNook is a ~1/1400 placeholder; see pro-rata-payout-rate-R). */
  realizedNook?: number;
  compositeScore?: number;
  submittedAt?: string;
  verifiedAt?: string;
}

const TERMINAL = new Set(["verified", "expired", "rejected"]);

/**
 * Pure reconciliation: which gateway rows need a settlement row appended.
 * A submission earns a row when (a) its gateway status is terminal, and
 * (b) we haven't recorded that submissionId at that status+paidness yet —
 * so a "verified but unpaid" row is later superseded by a "verified+paid"
 * row carrying realizedNook, and readers keep the LAST row per submission.
 */
export function reconcileSettlements(
  gwRows: GatewaySubmissionRow[],
  localKindBySubId: Map<string, { verifierKind?: string; model?: string }>,
  existing: Array<{ submissionId?: string; status?: string; realizedNook?: number }>,
  nowIso: string,
): SettlementRow[] {
  const seen = new Map<string, { status: string; paid: boolean }>();
  for (const e of existing) {
    if (e.submissionId && e.status) seen.set(e.submissionId, { status: e.status, paid: e.realizedNook !== undefined });
  }
  const out: SettlementRow[] = [];
  for (const r of gwRows) {
    if (!r.id || !r.status || !TERMINAL.has(r.status)) continue;
    const paid = r.rewardStatus === "paid";
    const prev = seen.get(r.id);
    if (prev && prev.status === r.status && prev.paid === paid) continue;
    if (prev && prev.paid && !paid) continue; // never regress a paid row
    const local = localKindBySubId.get(r.id);
    const realized = paid ? Number(r.rewardNook) : NaN;
    const comp = Number(r.compositeScore);
    out.push({
      ts: nowIso,
      submissionId: r.id,
      challengeId: r.challengeId,
      verifierKind: local?.verifierKind,
      model: local?.model ?? r.modelUsed,
      status: r.status,
      ...(paid && Number.isFinite(realized) ? { realizedNook: realized } : {}),
      ...(Number.isFinite(comp) ? { compositeScore: comp } : {}),
      submittedAt: r.submittedAt,
      verifiedAt: r.verifiedAt,
    });
  }
  return out;
}

/**
 * Trailing K-hat per verifier kind from PAID settlement rows:
 * kHat = median(realizedNook / compositeScore), compHat = mean(comp).
 * kindEv = compHat × kHat is the expected realized NOOK of one solve of that
 * kind. R is exogenous and swings ~9x within a month, so the WINDOW matters
 * more than precision — default 14d, and the ratio between kinds is more
 * trustworthy than either absolute.
 *
 * Windows on verifiedAt (when the payout's R was set), NOT the reconcile
 * timestamp — the first backfill stamps up to 100 old rows "now", and ts-
 * windowing would blend cross-regime K (measured 2.4x skew on live data)
 * for up to windowDays after any catch-up.
 *
 * `batches` counts DISTINCT K values: K is batch-constant per settlement
 * epoch, so three rows can be ONE independent observation. Evidence gates
 * must use batches, not row count, or a single lucky-epoch batch whipsaws
 * the ranking (R swings ~9x — more than the historical 5-6.5x kind gap).
 */
export function kHatByKind(
  rows: Array<{ ts?: string; verifiedAt?: string; verifierKind?: string; status?: string; realizedNook?: number; compositeScore?: number }>,
  nowMs: number,
  windowDays = 14,
): Record<string, { kHat: number; compHat: number; ev: number; n: number; batches: number }> {
  const cutoff = nowMs - windowDays * 86_400_000;
  const byKind = new Map<string, { ks: number[]; comps: number[]; kSet: Set<number> }>();
  for (const r of rows) {
    if (r.status !== "verified" || r.realizedNook === undefined || !r.compositeScore) continue;
    const t = Date.parse(r.verifiedAt ?? r.ts ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    const kind = r.verifierKind ?? "standard";
    const b = byKind.get(kind) ?? { ks: [], comps: [], kSet: new Set<number>() };
    const k = r.realizedNook / r.compositeScore;
    b.ks.push(k);
    b.comps.push(r.compositeScore);
    b.kSet.add(Math.round(k));
    byKind.set(kind, b);
  }
  const out: Record<string, { kHat: number; compHat: number; ev: number; n: number; batches: number }> = {};
  for (const [kind, b] of byKind) {
    const sorted = [...b.ks].sort((a, c) => a - c);
    const kHat = sorted[Math.floor(sorted.length / 2)];
    const compHat = b.comps.reduce((s, c) => s + c, 0) / b.comps.length;
    out[kind] = { kHat, compHat, ev: kHat * compHat, n: b.ks.length, batches: b.kSet.size };
  }
  return out;
}

/** Latest settlement row per submissionId (later rows supersede). */
export function latestSettlements(rows: SettlementRow[]): Map<string, SettlementRow> {
  const m = new Map<string, SettlementRow>();
  for (const r of rows) if (r.submissionId) m.set(r.submissionId, r);
  return m;
}

export function readSettlements(): SettlementRow[] {
  return readJsonl<SettlementRow>(SETTLEMENTS_LOG);
}

type RuntimeLike = Pick<NookplotRuntime, "connection">;

/**
 * The tick: one batch GET, append what's new, and mirror terminal statuses
 * into mining-verified.jsonl (idempotently, via the learnings module's
 * dedupe) so the tilt counters and dashboards see a complete ledger again.
 */
export async function runSettlementsTick(runtime: RuntimeLike, myAddress: string | null): Promise<{ appended: number }> {
  // The batch endpoint is /v1/mining/submissions/agent/:addr — WITH the
  // address. The addressless form routes as /submissions/:id ("agent") and
  // 400s (caught in review before this ever shipped).
  if (!myAddress) return { appended: 0 };
  let gwRows: GatewaySubmissionRow[] = [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/agent/${myAddress}?limit=100`,
    )) as { submissions?: GatewaySubmissionRow[] };
    gwRows = res.submissions ?? [];
  } catch (err) {
    console.warn(`   ⚠ settlements fetch failed: ${(err as Error).message.slice(0, 120)}`);
    return { appended: 0 };
  }
  const localKindBySubId = new Map<string, { verifierKind?: string; model?: string }>();
  for (const m of readJsonl<{ submissionId?: string; verifierKind?: string; model?: string }>(MINING_LOG)) {
    if (m.submissionId) localKindBySubId.set(m.submissionId, { verifierKind: m.verifierKind, model: m.model });
  }
  const fresh = reconcileSettlements(gwRows, localKindBySubId, readSettlements(), new Date().toISOString());
  const { recordMiningOutcomeOnce } = await import("./learnings.js");
  for (const row of fresh) {
    appendJsonl(SETTLEMENTS_LOG, row);
    if (row.status === "verified" || row.status === "expired" || row.status === "rejected") {
      recordMiningOutcomeOnce({
        submissionId: row.submissionId,
        challengeId: row.challengeId ?? "",
        model: row.model,
        verifierKind: row.verifierKind ?? "standard",
      }, row.status as "verified" | "expired" | "rejected", row.verifiedAt);
    }
  }
  if (fresh.length > 0) {
    const paid = fresh.filter((r) => r.realizedNook !== undefined);
    console.log(
      `💰 settlements: ${fresh.length} reconciled` +
        (paid.length ? ` (${paid.length} paid, ${Math.round(paid.reduce((s, r) => s + (r.realizedNook ?? 0), 0)).toLocaleString()} NOOK)` : ""),
    );
  }
  return { appended: fresh.length };
}
