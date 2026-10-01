/**
 * Per-challenge expected value — the default mining ranker (2026-10-01).
 *
 * Why this replaced the kind-level ranking: realized payout is
 *
 *     realized = compositeScore × baseReward(challenge) × R(settlement epoch)
 *
 * with R constant across kinds AND difficulties inside one settlement epoch.
 * Measured 2026-10-01 against our settlement ledger and 14 challenge-detail
 * GETs (one per settled challenge): 09-01 standard hard / standard easy /
 * python hard all R=0.2745; 09-18 python medium + hard R=4.375; 09-22
 * standard easy + python medium R=2.4656; 09-27 python medium (K 88,654) and
 * standard expert (K 886,545) — exactly the 10x of their 50k vs 500k base —
 * R=1.7731. The old ranker divided payout by composite only (K = base × R),
 * so it treated DIFFICULTY as if it were KIND: "standard first" picked a
 * standard hard over a python medium worth twice as much, and the tilt
 * buried a standard expert under 23 python mediums.
 *
 * So each challenge ranks by
 *
 *     EV = submitRate(kind) × survival(kind) × compHat(kind) × baseReward(challenge)
 *
 * and R cancels (every candidate in one poll settles under the same future R).
 *   - submitRate: trailing LOCAL accepted / attempts for the kind, with
 *     infrastructure and availability failures excluded (Venice 402/429/5xx,
 *     spend caps, fetch failed, aborts, gateway 5xx, IPFS, epoch cap,
 *     duplicate / guild-claimed). This is the gradual starvation guard: a
 *     kind we keep failing to submit loses rank, while a Venice outage does
 *     not punish whichever kind happened to be attempted.
 *   - survival: verified / (verified + rejected + expired) per kind from the
 *     settlements ledger (latest row per submission).
 *   - compHat: mean composite of verified rows per kind.
 *   - baseReward: the challenge's own field (a STRING on the wire, e.g.
 *     "50000"); fallback by difficulty easy=1, medium=5, hard=15, expert=50 in
 *     units of 10,000 NOOK (the observed easy base), so field-priced and
 *     fallback-priced challenges share one scale.
 * All three rates are Beta-shrunk toward a fixed prior so a kind with no
 * evidence still gets a finite, middling EV and a single row cannot swing it.
 *
 * Plus the acute guard (verifiableStarvationGuard): if the last 4 verifiable
 * attempts in the rolling 24h ALL failed locally for non-infrastructure
 * reasons, every standard outranks every verifiable on the next poll.
 *
 * The comparator is a lexicographic order over scalar keys computed ONCE per
 * challenge (guard demotion, EV, competition bucket, submission count,
 * specialization), so it is a total preorder — transitive by construction.
 * A past mixed-axis version cycled (Array.sort over a cycle is unspecified).
 *
 * Kill switch: BOT_CHALLENGE_EV_RANK=0 restores the legacy kind-EV + verifiable
 * tilt ordering (compareChallengePriority / computeVerifiableTilt in mining.ts).
 */
import { join } from "node:path";
import type { Challenge } from "./mining.js";
import { NOOK_DIR, readJsonlTail } from "./util.js";
import { readSettlements, rHatByEpoch } from "./settlements.js";

export const VERIFIABLE_KINDS = new Set(["python_tests", "javascript_tests", "exact_answer"]);

/** Ranking key: the specific verifiable kind, else "standard". */
export function challengeKindKey(c: Challenge): string {
  return c.verifierKind && VERIFIABLE_KINDS.has(c.verifierKind) ? c.verifierKind : "standard";
}

/** Same mapping for log rows: mining rows say "?" for standard challenges
 *  that arrived without a challengeType, settlement rows may omit the kind. */
export function rowKindKey(verifierKind: string | undefined | null): string {
  return verifierKind && VERIFIABLE_KINDS.has(verifierKind) ? verifierKind : "standard";
}

// ── baseReward ─────────────────────────────────────────────────────────────

/** Relative difficulty multipliers — the observed baseReward ladder on the
 *  2026-10-01 open list is 10k / 50k / 150k / 500k = 1 / 5 / 15 / 50. */
export const DIFFICULTY_MULTIPLIER: Record<string, number> = { easy: 1, medium: 5, hard: 15, expert: 50 };
/** NOOK per multiplier unit (an easy challenge's observed baseReward). */
export const BASE_REWARD_UNIT = 10_000;

export function parseBaseRewardField(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function challengeBaseReward(c: Pick<Challenge, "baseReward" | "difficulty">): {
  value: number;
  source: "field" | "difficulty" | "default";
} {
  const field = parseBaseRewardField(c.baseReward);
  if (field !== null) return { value: field, source: "field" };
  const m = DIFFICULTY_MULTIPLIER[(c.difficulty ?? "").toLowerCase()];
  if (m) return { value: m * BASE_REWARD_UNIT, source: "difficulty" };
  // Unknown difficulty → medium, the same default the legacy weight used.
  return { value: DIFFICULTY_MULTIPLIER.medium * BASE_REWARD_UNIT, source: "default" };
}

// ── attempt classification (submit rate + acute guard) ─────────────────────

/** Failures that say nothing about whether we can solve this KIND: the
 *  inference account, the network, the gateway's own 5xx, IPFS. */
const INFRA_FAILURE =
  /Venice API (?:402|429|5\d\d)|spend limit|Insufficient USD|Diem balance|VENICE_API_KEY missing|Inference processing failed|overloaded|fetch failed|operation was aborted|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|\bstand(?:ing|s)?[- ]?down\b|\bstood down\b|Gateway request failed \(5\d\d\)|<!DOCTYPE html|IPFS upload failed|Failed to pin|unexpected error while recording/i;

/** Gateway refusals about the challenge's AVAILABILITY or our quota, not the
 *  quality of the solution: epoch cap, duplicate, guild locks, full
 *  challenge. Model-id rejections belong to the model breaker, not the kind. */
const AVAILABILITY_FAILURE =
  /Maximum \d+ (?:regular|guild-exclusive)|per 24-hour epoch|Epoch submission cap|Try again next epoch|already submitted|claimed by guild|guild-exclusive challenge|requires tier|maximum of \d+ submissions|doesn.t look like a real model/i;

export type AttemptClass = "accepted" | "failed" | "excluded";

export interface MiningAttemptRow {
  ts?: string;
  verifierKind?: string;
  outcome?: string;
  submissionId?: string;
  notes?: string;
}

export function classifyAttempt(r: MiningAttemptRow): AttemptClass {
  if (r.submissionId) return "accepted";
  if (r.outcome === "skipped") return "excluded";
  if (r.outcome !== "error") return "accepted"; // legacy pass/fail/deferred rows without an id still used a slot
  const notes = r.notes ?? "";
  if (INFRA_FAILURE.test(notes) || AVAILABILITY_FAILURE.test(notes)) return "excluded";
  return "failed"; // specificity 400s, local skips, dry-run hard-fails, no output, …
}

// ── per-kind factors ───────────────────────────────────────────────────────

/** Beta-shrinkage priors: (successes + STRENGTH × PRIOR) / (n + STRENGTH). */
export const SUBMIT_RATE_PRIOR = 0.75;
export const SUBMIT_RATE_STRENGTH = 4;
export const SURVIVAL_PRIOR = 0.6;
export const SURVIVAL_STRENGTH = 4;
export const COMP_PRIOR = 0.6;
export const COMP_STRENGTH = 3;

export interface KindFactors {
  kind: string;
  submitRate: number;
  attempts: number;
  accepted: number;
  survival: number;
  resolved: number;
  verified: number;
  compHat: number;
  compN: number;
}

export type KindFactorTable = Record<string, KindFactors>;

const shrink = (succ: number, n: number, prior: number, strength: number) => (succ + strength * prior) / (n + strength);

export function priorFactors(kind: string): KindFactors {
  return {
    kind,
    submitRate: SUBMIT_RATE_PRIOR,
    attempts: 0,
    accepted: 0,
    survival: SURVIVAL_PRIOR,
    resolved: 0,
    verified: 0,
    compHat: COMP_PRIOR,
    compN: 0,
  };
}

export interface SettlementLikeRow {
  ts?: string;
  submissionId?: string;
  verifierKind?: string;
  status?: string;
  compositeScore?: number;
  verifiedAt?: string;
}

/**
 * Pure: per-kind submitRate / survival / compHat over a trailing window.
 * Settlement rows window on resolution time (verifiedAt, else the reconcile
 * ts — expired rows have no verifiedAt), mining rows on their own ts. Always
 * returns standard + every verifiable kind (prior-only when no evidence).
 */
export function kindFactors(
  settlements: SettlementLikeRow[],
  miningRows: MiningAttemptRow[],
  nowMs: number,
  windowDays = 14,
): KindFactorTable {
  const cutoff = nowMs - windowDays * 86_400_000;
  const acc = new Map<string, { attempts: number; accepted: number; resolved: number; verified: number; compSum: number; compN: number }>();
  const bucket = (kind: string) => {
    let b = acc.get(kind);
    if (!b) {
      b = { attempts: 0, accepted: 0, resolved: 0, verified: 0, compSum: 0, compN: 0 };
      acc.set(kind, b);
    }
    return b;
  };
  for (const r of miningRows) {
    const t = Date.parse(r.ts ?? "");
    if (!Number.isFinite(t) || t < cutoff || t > nowMs) continue;
    const cls = classifyAttempt(r);
    if (cls === "excluded") continue;
    const b = bucket(rowKindKey(r.verifierKind));
    b.attempts++;
    if (cls === "accepted") b.accepted++;
  }
  // Later settlement rows supersede earlier ones per submission.
  const latest = new Map<string, SettlementLikeRow>();
  for (const r of settlements) if (r.submissionId) latest.set(r.submissionId, r);
  for (const r of latest.values()) {
    if (r.status !== "verified" && r.status !== "rejected" && r.status !== "expired") continue;
    const t = Date.parse(r.verifiedAt ?? r.ts ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    const b = bucket(rowKindKey(r.verifierKind));
    b.resolved++;
    if (r.status === "verified") {
      b.verified++;
      const comp = Number(r.compositeScore);
      if (Number.isFinite(comp) && comp > 0) {
        b.compSum += comp;
        b.compN++;
      }
    }
  }
  const out: KindFactorTable = {};
  for (const kind of ["standard", ...VERIFIABLE_KINDS]) out[kind] = priorFactors(kind);
  for (const [kind, b] of acc) {
    out[kind] = {
      kind,
      submitRate: shrink(b.accepted, b.attempts, SUBMIT_RATE_PRIOR, SUBMIT_RATE_STRENGTH),
      attempts: b.attempts,
      accepted: b.accepted,
      survival: shrink(b.verified, b.resolved, SURVIVAL_PRIOR, SURVIVAL_STRENGTH),
      resolved: b.resolved,
      verified: b.verified,
      compHat: (b.compSum + COMP_STRENGTH * COMP_PRIOR) / (b.compN + COMP_STRENGTH),
      compN: b.compN,
    };
  }
  return out;
}

// ── acute starvation guard ─────────────────────────────────────────────────

export const STARVATION_WINDOW_MS = 24 * 3_600_000;

/**
 * Pure: true when the last `n` verifiable attempts inside the rolling 24h
 * (infra/availability failures excluded) ALL failed locally. While true,
 * verifiable must not outrank standard on the next poll — a sort, not a
 * filter, so a verifiable challenge is still taken when no standard is open.
 * n <= 0 disables the guard.
 */
export function verifiableStarvationGuard(
  miningRows: MiningAttemptRow[],
  nowMs: number,
  n = 4,
): { active: boolean; reason: string } {
  if (!(n > 0)) return { active: false, reason: "disabled" };
  const recent = miningRows
    .filter((r) => {
      if (!r.verifierKind || !VERIFIABLE_KINDS.has(r.verifierKind)) return false;
      const t = Date.parse(r.ts ?? "");
      return Number.isFinite(t) && t <= nowMs && nowMs - t <= STARVATION_WINDOW_MS && classifyAttempt(r) !== "excluded";
    })
    .sort((a, b) => Date.parse(a.ts ?? "") - Date.parse(b.ts ?? ""));
  const last = recent.slice(-n);
  if (last.length < n) return { active: false, reason: `${last.length}/${n} verifiable attempts in 24h` };
  const failed = last.filter((r) => classifyAttempt(r) === "failed").length;
  if (failed === n) {
    return { active: true, reason: `last ${n} verifiable attempts all failed locally — standards first this poll` };
  }
  return { active: false, reason: `${failed}/${n} of the last verifiable attempts failed` };
}

// ── scoring + total order ──────────────────────────────────────────────────

const LOW_COMPETITION_MAX = 4;

export interface ScoredChallenge {
  challenge: Challenge;
  kind: string;
  baseReward: number;
  baseRewardSource: "field" | "difficulty" | "default";
  submitRate: number;
  survival: number;
  compHat: number;
  ev: number;
  /** Starvation guard: verifiable demoted below every standard this poll. */
  demoted: boolean;
  /** Sort keys, fixed at scoring time so the comparator is pure. */
  lowCompetition: boolean;
  submissionCount: number;
  specMatch: boolean;
}

export function scoreChallenge(
  c: Challenge,
  table: KindFactorTable,
  opts: { guardActive?: boolean; specMatch?: (c: Challenge) => boolean } = {},
): ScoredChallenge {
  const kind = challengeKindKey(c);
  const f = table[kind] ?? priorFactors(kind);
  const base = challengeBaseReward(c);
  const raw = f.submitRate * f.survival * f.compHat * base.value;
  const subs = Number(c.submissionCount ?? 0);
  const submissionCount = Number.isFinite(subs) ? subs : 0;
  return {
    challenge: c,
    kind,
    baseReward: base.value,
    baseRewardSource: base.source,
    submitRate: f.submitRate,
    survival: f.survival,
    compHat: f.compHat,
    ev: Number.isFinite(raw) && raw > 0 ? raw : 0,
    demoted: Boolean(opts.guardActive) && kind !== "standard",
    lowCompetition: submissionCount <= LOW_COMPETITION_MAX,
    submissionCount,
    specMatch: opts.specMatch ? opts.specMatch(c) : false,
  };
}

/** Lexicographic over scalar keys → a total preorder (transitive). Lower = first. */
export function compareScoredChallenges(a: ScoredChallenge, b: ScoredChallenge): number {
  if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
  if (a.ev !== b.ev) return b.ev - a.ev;
  if (a.lowCompetition !== b.lowCompetition) return a.lowCompetition ? -1 : 1;
  if (a.submissionCount !== b.submissionCount) return a.submissionCount - b.submissionCount;
  if (a.specMatch !== b.specMatch) return a.specMatch ? -1 : 1;
  return 0;
}

export function rankChallengesByEv(
  challenges: Challenge[],
  table: KindFactorTable,
  opts: { guardActive?: boolean; specMatch?: (c: Challenge) => boolean } = {},
): ScoredChallenge[] {
  return challenges.map((c) => scoreChallenge(c, table, opts)).sort(compareScoredChallenges);
}

// ── log lines ──────────────────────────────────────────────────────────────

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toFixed(0));

/** One line: the top N challenges with every EV component. EV is in NOOK per
 *  unit of R (multiply by the settlement epoch's R for realized NOOK). */
export function formatEvTop(ranked: ScoredChallenge[], guard: { active: boolean; reason: string }, topN = 3): string {
  const parts = ranked.slice(0, topN).map((s, i) => {
    const diff = s.challenge.difficulty ?? "?";
    const src = s.baseRewardSource === "field" ? "" : `(${s.baseRewardSource})`;
    return (
      `${i + 1}) ${s.challenge.id.slice(0, 8)} ${s.kind}/${diff} ` +
      `${k(s.baseReward)}${src} × sub ${s.submitRate.toFixed(2)} × surv ${s.survival.toFixed(2)} × comp ${s.compHat.toFixed(2)} = ${k(s.ev)}·R` +
      (s.demoted ? " [demoted]" : "")
    );
  });
  return `   🏁 EV top${Math.min(topN, ranked.length)}: ${parts.join(" | ")} — starvation guard ${guard.active ? "ON" : "off"} (${guard.reason})`;
}

/** One line: per-kind factors with their evidence counts, plus R-hat and the
 *  number of settlement epochs behind it. */
export function formatKindFactors(
  table: KindFactorTable,
  windowDays: number,
  rHat?: Array<{ epoch: string; r: number; n: number }>,
): string {
  const kinds = Object.values(table).filter((f) => f.attempts > 0 || f.resolved > 0);
  const parts = kinds.map(
    (f) =>
      `${f.kind} sub ${f.submitRate.toFixed(2)} (${f.accepted}/${f.attempts}) surv ${f.survival.toFixed(2)} (${f.verified}/${f.resolved}) comp ${f.compHat.toFixed(2)} (n${f.compN})`,
  );
  const r = rHat && rHat.length > 0
    ? `R̂ ${rHat[0].r.toFixed(rHat[0].r < 10 ? 3 : 1)} @${rHat[0].epoch} (n${rHat[0].n}; ${rHat.length} epoch${rHat.length === 1 ? "" : "s"} with baseReward)`
    : "R̂ n/a (no settled rows carry baseReward yet)";
  return `   📐 EV factors (${windowDays}d): ${parts.length > 0 ? parts.join(" | ") : "no evidence — priors only"} | ${r}`;
}

// ── impure shell ───────────────────────────────────────────────────────────

const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");

/** Kill switch: BOT_CHALLENGE_EV_RANK=0 restores the legacy kind-EV +
 *  verifiable-tilt ordering. Anything else (including unset) = per-challenge EV. */
export function challengeRankerMode(env: NodeJS.ProcessEnv = process.env): "ev" | "legacy" {
  return env.BOT_CHALLENGE_EV_RANK === "0" ? "legacy" : "ev";
}

export function evWindowDays(): number {
  const n = Number(process.env.BOT_CHALLENGE_EV_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

export function starvationGuardN(): number {
  const raw = process.env.BOT_VERIFIABLE_STARVATION_N;
  if (raw === undefined || raw === "") return 4;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 4;
}

/** Read local state for one poll. Missing files read as empty (priors). */
export function loadChallengeEvInputs(nowMs: number): {
  table: KindFactorTable;
  guard: { active: boolean; reason: string };
  rHat: Array<{ epoch: string; r: number; n: number }>;
  windowDays: number;
} {
  const windowDays = evWindowDays();
  const miningRows = readJsonlTail<MiningAttemptRow>(MINING_LOG, 4000);
  const settlements = readSettlements();
  return {
    table: kindFactors(settlements, miningRows, nowMs, windowDays),
    guard: verifiableStarvationGuard(miningRows, nowMs, starvationGuardN()),
    rHat: rHatByEpoch(settlements, nowMs, windowDays),
    windowDays,
  };
}
