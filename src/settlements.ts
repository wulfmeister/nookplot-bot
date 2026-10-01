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
  /** Challenge baseReward (NOOK) copied from our own mining-submissions row —
   *  present from 2026-10-01. realized = compositeScore × baseReward × R with
   *  R constant per settlement epoch, so this is what turns K into R. */
  baseReward?: number;
  difficulty?: string;
}

/** Local mining-row fields the reconciler copies onto a settlement row. */
export interface LocalSubmissionMeta {
  verifierKind?: string;
  model?: string;
  baseReward?: number;
  difficulty?: string;
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
  localKindBySubId: Map<string, LocalSubmissionMeta>,
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
      ...(local?.baseReward !== undefined && Number.isFinite(local.baseReward) && local.baseReward > 0 ? { baseReward: local.baseReward } : {}),
      ...(local?.difficulty ? { difficulty: local.difficulty } : {}),
    });
  }
  return out;
}

/**
 * Settlement-batch key: the mining epoch-day (02:00Z boundary) of the
 * settlement time. Measured 2026-10-01 on our ledger + 14 challenge-detail
 * GETs: R = K / baseReward is identical across kinds AND difficulties inside
 * one epoch (09-01: standard hard, standard easy and python hard all
 * R=0.2745; 09-18: python medium + hard R=4.375; 09-22: standard easy +
 * python medium R=2.4656; 09-27: python medium + standard expert R=1.7731)
 * and stays put across that epoch's settlement passes (09-20, 09-21/22,
 * 09-22/23, 09-29 each paid the same K at two pass times; 09-15 standards
 * verified 02:56..07:11 all one K). The 02:00Z boundary is visible in the
 * data: 08-13T00:xx paid 08-12's K (117,184) while 08-13T02:xx paid a new
 * one (125,856). No counterexample among our own paid rows since 08-08. So
 * one epoch-day is ONE independent observation of R, however many
 * difficulty variants (distinct K) it contains.
 *
 * Scope: OUR rows only. Other solvers on the same challenge settle at a
 * different R (09-27: 0.8526 vs our 1.7731) — consistent with R carrying the
 * solver's stake-tier × guild multiplier (unverified) — which is irrelevant
 * here because this ledger only holds our submissions.
 */
export function settlementEpochKey(ms: number): number {
  return Math.floor((ms - 2 * 3_600_000) / 86_400_000);
}

/** ISO date (YYYY-MM-DD) of the epoch start for a settlementEpochKey. */
export function settlementEpochLabel(key: number): string {
  return new Date(key * 86_400_000 + 2 * 3_600_000).toISOString().slice(0, 10);
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, c) => a - c);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Pro-rata rate R per settlement epoch from PAID rows that carry baseReward
 * (R = realized / (compositeScore × baseReward)). Diagnostics only — R is
 * exogenous and cancels out of the per-challenge ranking. Newest first.
 */
export function rHatByEpoch(
  rows: Array<{ ts?: string; verifiedAt?: string; status?: string; realizedNook?: number; compositeScore?: number; baseReward?: number }>,
  nowMs: number,
  windowDays = 14,
): Array<{ epoch: string; r: number; n: number }> {
  const cutoff = nowMs - windowDays * 86_400_000;
  const byEpoch = new Map<number, number[]>();
  for (const r of rows) {
    if (r.status !== "verified" || r.realizedNook === undefined || !r.compositeScore) continue;
    if (!(r.baseReward && r.baseReward > 0)) continue;
    const t = Date.parse(r.verifiedAt ?? r.ts ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    const key = settlementEpochKey(t);
    const list = byEpoch.get(key) ?? [];
    list.push(r.realizedNook / (r.compositeScore * r.baseReward));
    byEpoch.set(key, list);
  }
  return [...byEpoch.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, rs]) => ({ epoch: settlementEpochLabel(key), r: median(rs), n: rs.length }));
}

export interface KHatEntry {
  kHat: number;
  compHat: number;
  ev: number;
  n: number;
  /** Distinct settlement epochs (independent draws of R), NOT distinct K. */
  batches: number;
  /** Median R = K / baseReward over rows that carry baseReward (diagnostic). */
  rHat?: number;
  rN?: number;
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
 * `batches` counts DISTINCT SETTLEMENT EPOCHS (settlementEpochKey), not
 * distinct K. Corrected 2026-10-01: K = baseReward × R, so one epoch that
 * paid a medium and a hard python solve has two K values but ONE draw of R —
 * counting distinct K let a single epoch pass the 2-batch evidence bar.
 * Evidence gates must use batches, not row count, or a single lucky-epoch
 * batch whipsaws the ranking (R swings ~9x — more than the historical 5-6.5x
 * kind gap).
 *
 * LEGACY CAVEAT: kHat still mixes difficulties (a standard expert's K is
 * 3.3x a standard hard's in the same epoch), so this kind-level EV is only
 * the input for the legacy ordering (BOT_CHALLENGE_EV_RANK=0). The default
 * ranker (src/challenge-ev.ts) ranks each challenge by its own baseReward,
 * where R cancels. `rHat` (median R over rows that carry baseReward) is
 * reported for diagnostics.
 */
export function kHatByKind(
  rows: Array<{ ts?: string; verifiedAt?: string; verifierKind?: string; status?: string; realizedNook?: number; compositeScore?: number; baseReward?: number }>,
  nowMs: number,
  windowDays = 14,
): Record<string, KHatEntry> {
  const cutoff = nowMs - windowDays * 86_400_000;
  const byKind = new Map<string, { ks: number[]; comps: number[]; epochs: Set<number>; rs: number[] }>();
  for (const r of rows) {
    if (r.status !== "verified" || r.realizedNook === undefined || !r.compositeScore) continue;
    const t = Date.parse(r.verifiedAt ?? r.ts ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    const kind = r.verifierKind ?? "standard";
    const b = byKind.get(kind) ?? { ks: [], comps: [], epochs: new Set<number>(), rs: [] };
    const k = r.realizedNook / r.compositeScore;
    b.ks.push(k);
    b.comps.push(r.compositeScore);
    b.epochs.add(settlementEpochKey(t));
    if (r.baseReward && r.baseReward > 0) b.rs.push(k / r.baseReward);
    byKind.set(kind, b);
  }
  const out: Record<string, KHatEntry> = {};
  for (const [kind, b] of byKind) {
    const kHat = median(b.ks);
    const compHat = b.comps.reduce((s, c) => s + c, 0) / b.comps.length;
    out[kind] = {
      kHat,
      compHat,
      ev: kHat * compHat,
      n: b.ks.length,
      batches: b.epochs.size,
      ...(b.rs.length > 0 ? { rHat: median(b.rs), rN: b.rs.length } : {}),
    };
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
  const localKindBySubId = new Map<string, LocalSubmissionMeta>();
  for (const m of readJsonl<{ submissionId?: string } & LocalSubmissionMeta>(MINING_LOG)) {
    if (m.submissionId) {
      localKindBySubId.set(m.submissionId, {
        verifierKind: m.verifierKind,
        model: m.model,
        baseReward: m.baseReward,
        difficulty: m.difficulty,
      });
    }
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
