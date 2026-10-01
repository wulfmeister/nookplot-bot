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
 * Our epoch_solving payout is CAPPED per settlement epoch at exactly this
 * many NOOK. Found in review 2026-10-01, after the per-challenge EV ranker
 * had been written on the premise that R is exogenous:
 *   - mining-claims.jsonl: epoch_solving = 1,575,000 on 8 of the 13 non-zero
 *     claims since 09-17 (09-17, 19, 21, 22, 26, 28, 29, 30, the last 4
 *     included);
 *   - mining-settlements.jsonl: Σ realizedNook per settlement epoch
 *     (verifiedAt, 02:00Z) is 1,575,000 to within 1e-4 NOOK for 09-04, 09-15,
 *     09-18, 09-20, 09-21, 09-25, 09-27, 09-28 and 09-29. Every uncapped
 *     epoch sits 500k+ below it. Inside a capped epoch the solves are scaled
 *     pro rata to fit: 09-20 paid 11 × 143,182; 09-29 paid 7 × 225,000; 09-28
 *     paid ONE python medium the whole 1,575,000.
 * No epoch before 09-04 reached it, so we can't tell when it started. The
 * mechanism is UNVERIFIED: no SDK or doc text describes a cap.
 * 1,575,000 = 900,000 × 1.75 (our tier-3 multiplier), so a per-agent cap
 * scaled by stake tier would fit, but that is inference. If the gateway
 * changes the number, `capped` stops firing; the per-epoch totals in the
 * log line make that visible.
 */
export const EPOCH_SOLVING_CAP = 1_575_000;
/** |Σ paid − cap| below this counts as capped. Measured distance is <1e-4
 *  NOOK in capped epochs and >500k in uncapped ones. */
const CAP_TOLERANCE_NOOK = 1;

export interface EpochPayoutTotal {
  epoch: string;
  key: number;
  /** Σ realizedNook over our PAID verified rows that settled in this epoch. */
  total: number;
  n: number;
  /** total equals EPOCH_SOLVING_CAP: one more solve here would have added ~0. */
  capped: boolean;
}

/**
 * Pure: our paid solving total per settlement epoch (verifiedAt, 02:00Z
 * boundary), latest row per submission, newest first. It counts every paid
 * row, including rows WITHOUT baseReward, because the cap applies to the
 * whole epoch total.
 */
export function epochPayoutTotals(
  rows: Array<{ submissionId?: string; ts?: string; verifiedAt?: string; status?: string; realizedNook?: number }>,
  nowMs: number,
  windowDays = 14,
  cap = EPOCH_SOLVING_CAP,
): EpochPayoutTotal[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const latest = new Map<string, (typeof rows)[number]>();
  const anonymous: typeof rows = [];
  for (const r of rows) {
    if (r.submissionId) latest.set(r.submissionId, r);
    else anonymous.push(r);
  }
  const byEpoch = new Map<number, { total: number; n: number }>();
  for (const r of [...latest.values(), ...anonymous]) {
    if (r.status !== "verified" || r.realizedNook === undefined || !Number.isFinite(r.realizedNook)) continue;
    const t = Date.parse(r.verifiedAt ?? r.ts ?? "");
    if (!Number.isFinite(t) || t < cutoff || t > nowMs) continue;
    const key = settlementEpochKey(t);
    const b = byEpoch.get(key) ?? { total: 0, n: 0 };
    b.total += r.realizedNook;
    b.n++;
    byEpoch.set(key, b);
  }
  return [...byEpoch.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, b]) => ({
      epoch: settlementEpochLabel(key),
      key,
      total: b.total,
      n: b.n,
      capped: cap > 0 && Math.abs(b.total - cap) < CAP_TOLERANCE_NOOK,
    }));
}

export interface RHatEpoch {
  epoch: string;
  /** Median realized / (comp × baseReward) over rows that carry baseReward. */
  r: number;
  n: number;
  /** The epoch hit EPOCH_SOLVING_CAP. Then `r` = cap / Σ(comp × base × …) of
   *  OUR solves: a LOWER BOUND on the uncapped rate, and it falls when we
   *  solve more. It is not a network rate. */
  capped?: boolean;
  /** Σ paid in the epoch (all our paid rows, with or without baseReward). */
  paidTotal?: number;
}

/**
 * Pro-rata rate R per settlement epoch from PAID rows that carry baseReward
 * (R = realized / (compositeScore × baseReward)). Diagnostics only. Newest
 * first.
 *
 * R is shared by every kind and difficulty in an epoch, and that holds in
 * capped epochs too, because the cap scales everyone pro rata. What fails in
 * a capped epoch is the premise that R is EXOGENOUS (see
 * EPOCH_SOLVING_CAP): there it is the cap divided by our own volume. Such
 * epochs are tagged `capped` so nobody reads them as the network's rate.
 */
export function rHatByEpoch(
  rows: Array<{ submissionId?: string; ts?: string; verifiedAt?: string; status?: string; realizedNook?: number; compositeScore?: number; baseReward?: number }>,
  nowMs: number,
  windowDays = 14,
  cap = EPOCH_SOLVING_CAP,
): RHatEpoch[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const totals = new Map(epochPayoutTotals(rows, nowMs, windowDays, cap).map((t) => [t.key, t]));
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
    .map(([key, rs]) => {
      const tot = totals.get(key);
      return {
        epoch: settlementEpochLabel(key),
        r: median(rs),
        n: rs.length,
        ...(tot ? { capped: tot.capped, paidTotal: tot.total } : {}),
      };
    });
}

export interface KHatEntry {
  kHat: number;
  compHat: number;
  ev: number;
  n: number;
  /** Distinct settlement epochs (independent draws of R), NOT distinct K. */
  batches: number;
  /** Median R = K / baseReward over rows that carry baseReward (diagnostic).
   *  Mixes capped epochs, where R is cap / Σ ours (see EPOCH_SOLVING_CAP). */
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
 * 3.3x a standard hard's in the same epoch). This kind-level EV feeds the
 * legacy ordering, which is still the ACTIVE one by default (see
 * challengeRankerMode). The per-challenge ranker (src/challenge-ev.ts) ranks
 * each challenge by its own baseReward. R cancels there only in uncapped
 * epochs (see EPOCH_SOLVING_CAP). `rHat` (median R over rows that carry
 * baseReward) is reported for diagnostics.
 *
 * CAP CAVEAT (2026-10-01): in an epoch that hit EPOCH_SOLVING_CAP, K is
 * cap-scaled, i.e. K = base × cap / Σ(comp × base) of our own solves that
 * epoch. Both kinds scale by the same factor inside one epoch, so the
 * within-epoch ratio survives. Across epochs, though, a kind we solved a lot
 * of in capped epochs shows a lower K. 09-20 paid 11 python mediums at
 * 143,182 each, while 09-28 paid one at 1,575,000.
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
