/**
 * Per-challenge expected value. Mining ranker, SHADOW by default (2026-10-01).
 *
 * Why it exists: realized payout is
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
 * and R cancels (every candidate in one poll settles under the same future
 * R), but ONLY IF THAT EPOCH IS UNCAPPED. Review correction, same day: our
 * epoch_solving total is capped at exactly 1,575,000 NOOK per settlement
 * epoch (evidence and caveats in settlements.ts EPOCH_SOLVING_CAP). The cap
 * bound on 8 of the 13 non-zero claims since 09-17, including the last 4.
 * Two of the four epochs measured above are capped (09-18, 09-27). Inside a
 * capped epoch the cap scales every solve pro rata, which is why R is still
 * shared across kinds there. But R is not exogenous there: R̂ = cap /
 * Σ(comp × base) of OUR solves, and one more solve adds ~0 NOOK while still
 * costing a slot plus inference. Base-proportional EV therefore overstates
 * high-base picks on capped days. How much that changes income relative to
 * the legacy order is unmeasured (legacy is just as blind to the cap).
 *
 * Hence the mode switch (challengeRankerMode): by default the legacy order
 * stays ACTIVE and this ranker runs in SHADOW, logging what it would pick
 * next to what was picked plus the per-epoch cap tally. BOT_CHALLENGE_EV_RANK=1
 * makes it active and is the operator's call to make after weighing the cap.
 * A cap-aware version would project the open epoch's committed
 * Σ comp×base×R from pending rows and, when that is projected capped, rank by
 * P(settle) and inference cost instead of base. It is not built.
 *
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
 * Plus the acute guard (verifiableStarvationGuard). It fires when the last 4
 * verifiable attempts in the rolling 24h ALL failed locally for
 * non-infrastructure reasons, and it is BOUNDED (review fix, 2026-10-01). It
 * holds only while the newest of those failures is under
 * BOT_VERIFIABLE_STARVATION_HOLD_MIN (default 120) minutes old, and it counts
 * only attempts made since this process started. The first version latched:
 * while active it demoted every verifiable below every standard, so no new
 * verifiable attempt could clear it, and it was rebuilt from the log on
 * restart. A routine streak of 4 python failures could then keep verifiables
 * below every open standard for up to ~24h. At the 14-day 61% local submit
 * rate (73/119) such streaks come ~1.7× per 14 days if failures are
 * independent. Now one probe gets through after the hold, and a failed probe
 * re-arms it for another hold. While it holds, the EV ranker demotes
 * verifiables below standards, and the legacy order only cancels
 * preferVerifiable (what item 6 asked for).
 *
 * The comparator is a lexicographic order over scalar keys computed ONCE per
 * challenge (guard demotion, EV, competition bucket, submission count,
 * specialization), so it is a total preorder — transitive by construction.
 * A past mixed-axis version cycled (Array.sort over a cycle is unspecified).
 *
 * Modes (BOT_CHALLENGE_EV_RANK): unset = shadow (legacy active, EV logged),
 * 1 = EV active, 0 = legacy with no EV computation at all. The legacy order
 * is compareChallengePriority / computeVerifiableTilt in mining.ts.
 *
 * Visibility caveat (review, 2026-10-01): this ranker only orders what
 * discovery returns. fetchOpenChallengesPaged stops paging once pollNeed (3)
 * eligible items are visible, and page 1 is newest-first python. A live
 * check on 10-01 found 23 eligible on page 1 (20 python medium, 3 standard
 * hard) and 68 standard expert (500k) one page deeper, never fetched. Over
 * page 1 alone EV's top 5 were all python mediums (17.8k·R each). Over pages
 * 1+2 they were all standard experts (57.8k·R). It is the PAGING DEPTH that
 * hides the experts, not the 'open' status gate. The scope note in
 * formatEvTop ("saw N eligible on P pages, max base X") shows this every poll.
 */
import { join } from "node:path";
import type { Challenge } from "./mining.js";
import { NOOK_DIR, readJsonlTail } from "./util.js";
import { readSettlements, rHatByEpoch, epochPayoutTotals, EPOCH_SOLVING_CAP, type RHatEpoch } from "./settlements.js";

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
  /Venice API (?:402|429|5\d\d)|spend limit|Insufficient USD|Diem balance|VENICE_API_KEY missing|Inference processing failed|overloaded|fetch failed|operation was aborted|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|\bstand(?:ing|s)?[- ]?down\b|\bstood down\b|wake-gate|interrupted by host sleep|Gateway request failed \(5\d\d\)|<!DOCTYPE html|IPFS upload failed|Failed to pin|unexpected error while recording/i;

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
/** How long the guard holds after the NEWEST of the n failures. Two hours is
 *  ~8 polls at the 15-min cadence: enough to cover the next poll even when a
 *  long solve makes the re-entrancy guard skip one, while the old latch could
 *  hold until the OLDEST failure aged out of 24h. */
export const STARVATION_HOLD_MS_DEFAULT = 120 * 60_000;

export interface StarvationGuardState {
  active: boolean;
  reason: string;
}

/**
 * Pure: true when the last `n` verifiable attempts inside the rolling 24h
 * (infra/availability failures excluded) ALL failed locally AND the newest
 * of them is under `holdMs` old. While true, verifiable must not outrank
 * standard. It is a sort, not a filter, so a verifiable challenge is still
 * taken when no standard is open.
 *
 * Bounded so it cannot latch (review fix, 2026-10-01). It clears by itself
 * `holdMs` after the newest failure with no new verifiable attempt. After
 * that, one verifiable probe competes normally: a success clears the
 * condition, a failure re-arms it for another `holdMs`. `sinceMs` (the shell
 * passes process start) ignores attempts made before it, so a restart after
 * a fix starts clean rather than inheriting the log's streak.
 * n <= 0 disables the guard.
 */
export function verifiableStarvationGuard(
  miningRows: MiningAttemptRow[],
  nowMs: number,
  n = 4,
  opts: { holdMs?: number; sinceMs?: number } = {},
): StarvationGuardState {
  if (!(n > 0)) return { active: false, reason: "disabled" };
  const holdMs = opts.holdMs !== undefined && opts.holdMs > 0 ? opts.holdMs : STARVATION_HOLD_MS_DEFAULT;
  const floorMs = Math.max(nowMs - STARVATION_WINDOW_MS, opts.sinceMs ?? -Infinity);
  const recent = miningRows
    .filter((r) => {
      if (!r.verifierKind || !VERIFIABLE_KINDS.has(r.verifierKind)) return false;
      const t = Date.parse(r.ts ?? "");
      return Number.isFinite(t) && t <= nowMs && t >= floorMs && classifyAttempt(r) !== "excluded";
    })
    .sort((a, b) => Date.parse(a.ts ?? "") - Date.parse(b.ts ?? ""));
  const last = recent.slice(-n);
  const scope = opts.sinceMs !== undefined && opts.sinceMs > nowMs - STARVATION_WINDOW_MS ? "since restart" : "in 24h";
  if (last.length < n) return { active: false, reason: `${last.length}/${n} verifiable attempts ${scope}` };
  const failed = last.filter((r) => classifyAttempt(r) === "failed").length;
  if (failed !== n) return { active: false, reason: `${failed}/${n} of the last verifiable attempts failed` };
  const newestMs = Date.parse(last[last.length - 1].ts ?? "");
  const ageMin = Math.round((nowMs - newestMs) / 60_000);
  const holdMin = Math.round(holdMs / 60_000);
  if (nowMs - newestMs > holdMs) {
    return {
      active: false,
      reason: `last ${n} verifiable attempts failed, but the newest is ${ageMin}m old (> ${holdMin}m hold) — verifiables compete again; one more failure re-arms`,
    };
  }
  const until = new Date(newestMs + holdMs).toISOString().slice(11, 16);
  return {
    active: true,
    reason: `last ${n} verifiable attempts all failed locally (newest ${ageMin}m ago) — verifiables yield to standards until ${until}Z`,
  };
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

/** What the ranker could see this poll (paging stops once pollNeed eligible
 *  items are visible, so high-base challenges one page deeper never reach
 *  it; see the visibility caveat in the header). */
export interface EvScope {
  pages: number;
}

/** One line: the top N challenges with every EV component. EV is in NOOK per
 *  unit of R (multiply by the settlement epoch's R for realized NOOK; in a
 *  CAPPED epoch the realized marginal value is ~0 whatever this says). */
export function formatEvTop(
  ranked: ScoredChallenge[],
  guard: StarvationGuardState,
  topN = 3,
  scope?: EvScope,
): string {
  const parts = ranked.slice(0, topN).map((s, i) => {
    const diff = s.challenge.difficulty ?? "?";
    const src = s.baseRewardSource === "field" ? "" : `(${s.baseRewardSource})`;
    return (
      `${i + 1}) ${s.challenge.id.slice(0, 8)} ${s.kind}/${diff} ` +
      `${k(s.baseReward)}${src} × sub ${s.submitRate.toFixed(2)} × surv ${s.survival.toFixed(2)} × comp ${s.compHat.toFixed(2)} = ${k(s.ev)}·R` +
      (s.demoted ? " [demoted]" : "")
    );
  });
  const seen = scope
    ? ` — saw ${ranked.length} eligible on ${scope.pages} page${scope.pages === 1 ? "" : "s"}, max base ${k(ranked.reduce((m, s) => Math.max(m, s.baseReward), 0))}`
    : "";
  return `   🏁 EV top${Math.min(topN, ranked.length)}: ${parts.join(" | ")}${seen} — starvation guard ${guard.active ? "ON" : "off"} (${guard.reason})`;
}

/** Cap tally over the window's paid epochs. */
export interface CapSummary {
  capped: number;
  epochs: number;
  cap: number;
}

export function summarizeCaps(totals: Array<{ capped: boolean }>, cap = EPOCH_SOLVING_CAP): CapSummary {
  return { capped: totals.filter((t) => t.capped).length, epochs: totals.length, cap };
}

const fmtR = (r: number) => r.toFixed(r < 10 ? 3 : 1);

/** One line: per-kind factors with their evidence counts, R-hat for the newest
 *  epoch, and how often the per-epoch solving cap bound. A capped epoch's
 *  R-hat is printed as "≥" and labelled: it is cap / Σ ours, not a network
 *  rate. */
export function formatKindFactors(
  table: KindFactorTable,
  windowDays: number,
  rHat?: RHatEpoch[],
  caps?: CapSummary,
): string {
  const kinds = Object.values(table).filter((f) => f.attempts > 0 || f.resolved > 0);
  const parts = kinds.map(
    (f) =>
      `${f.kind} sub ${f.submitRate.toFixed(2)} (${f.accepted}/${f.attempts}) surv ${f.survival.toFixed(2)} (${f.verified}/${f.resolved}) comp ${f.compHat.toFixed(2)} (n${f.compN})`,
  );
  let r = "R̂ n/a (no settled rows carry baseReward yet)";
  if (rHat && rHat.length > 0) {
    const top = rHat[0];
    const epochs = `${rHat.length} epoch${rHat.length === 1 ? "" : "s"} with baseReward`;
    if (top.capped) {
      r = `R̂ ≥${fmtR(top.r)} @${top.epoch} (n${top.n}; CAPPED: R̂ = cap/Σ ours, not a network rate; ${epochs})`;
      const uncapped = rHat.find((e) => e.capped === false);
      if (uncapped) r += `; newest uncapped R̂ ${fmtR(uncapped.r)} @${uncapped.epoch}`;
    } else {
      r = `R̂ ${fmtR(top.r)} @${top.epoch} (n${top.n}; ${epochs})`;
    }
  }
  const capPart = caps && caps.epochs > 0
    ? ` | solving cap ${k(caps.cap)}/epoch hit ${caps.capped}/${caps.epochs} paid epochs` +
      (caps.capped > 0 ? " (in a capped epoch one more solve adds ~0; EV ∝ base holds only uncapped)" : "")
    : "";
  return `   📐 EV factors (${windowDays}d): ${parts.length > 0 ? parts.join(" | ") : "no evidence — priors only"} | ${r}${capPart}`;
}

/** Shadow mode, one line: what the EV ranker would attempt first next to what
 *  the active legacy order attempts. Compares the first `take` ids. */
export function formatEvShadow(ranked: ScoredChallenge[], active: Challenge[], take: number): string {
  const n = Math.max(1, take);
  const evIds = ranked.slice(0, n).map((s) => s.challenge.id);
  const activeIds = active.slice(0, n).map((c) => c.id);
  const byId = new Map(ranked.map((s) => [s.challenge.id, s]));
  const label = (id: string) => {
    const s = byId.get(id);
    return `${id.slice(0, 8)}(${s ? `${s.kind}/${s.challenge.difficulty ?? "?"}` : "?"})`;
  };
  const same = evIds.length === activeIds.length && evIds.every((id, i) => id === activeIds[i]);
  const overlap = evIds.filter((id) => activeIds.includes(id)).length;
  return (
    `   🕶 EV shadow (inactive; BOT_CHALLENGE_EV_RANK=1 activates): would take ${evIds.map(label).join(" ")}` +
    ` vs active ${activeIds.map(label).join(" ")}` +
    ` — ${same ? "same" : `differs (${overlap}/${n} shared)`}`
  );
}

// ── impure shell ───────────────────────────────────────────────────────────

const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");

/** Process start, approximately (module load). The starvation guard ignores
 *  attempts made before it, so a restart after a fix starts clean. */
const PROCESS_START_MS = Date.now();

export type ChallengeRankerMode = "ev" | "shadow" | "legacy";

/**
 * BOT_CHALLENGE_EV_RANK:
 *   "1"           → ev: per-challenge EV is the ACTIVE order;
 *   "0"           → legacy: kind-EV + verifiable tilt, EV not computed;
 *   unset / other → shadow (DEFAULT): legacy is active, EV is computed and
 *                   logged next to it.
 * The default is shadow, not ev, because the EV premise (R cancels) fails in
 * capped epochs, which is most days since 09-17 (header +
 * settlements.ts EPOCH_SOLVING_CAP). Flipping to ev is the operator's call.
 */
export function challengeRankerMode(env: NodeJS.ProcessEnv = process.env): ChallengeRankerMode {
  const v = env.BOT_CHALLENGE_EV_RANK;
  if (v === "1") return "ev";
  if (v === "0") return "legacy";
  return "shadow";
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

/** BOT_VERIFIABLE_STARVATION_HOLD_MIN: minutes the guard holds after the
 *  newest failure. Default 120; non-positive or garbage → default. */
export function starvationGuardHoldMs(): number {
  const n = Number(process.env.BOT_VERIFIABLE_STARVATION_HOLD_MIN);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : STARVATION_HOLD_MS_DEFAULT;
}

function guardFromRows(miningRows: MiningAttemptRow[], nowMs: number): StarvationGuardState {
  return verifiableStarvationGuard(miningRows, nowMs, starvationGuardN(), {
    holdMs: starvationGuardHoldMs(),
    sinceMs: PROCESS_START_MS,
  });
}

/** The guard alone, for the legacy order (which cancels preferVerifiable
 *  while it is active). Missing log reads as empty → off. */
export function loadStarvationGuard(nowMs: number): StarvationGuardState {
  return guardFromRows(readJsonlTail<MiningAttemptRow>(MINING_LOG, 4000), nowMs);
}

/** Read local state for one poll. Missing files read as empty (priors). */
export function loadChallengeEvInputs(nowMs: number): {
  table: KindFactorTable;
  guard: StarvationGuardState;
  rHat: RHatEpoch[];
  caps: CapSummary;
  windowDays: number;
} {
  const windowDays = evWindowDays();
  const miningRows = readJsonlTail<MiningAttemptRow>(MINING_LOG, 4000);
  const settlements = readSettlements();
  return {
    table: kindFactors(settlements, miningRows, nowMs, windowDays),
    guard: guardFromRows(miningRows, nowMs),
    rHat: rHatByEpoch(settlements, nowMs, windowDays),
    caps: summarizeCaps(epochPayoutTotals(settlements, nowMs, windowDays)),
    windowDays,
  };
}
