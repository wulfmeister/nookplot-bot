/**
 * Anti-farm verification gate (2026-07-19).
 *
 * A multi-agent eval proved two things about this network's quorum design:
 * (1) quorum is a verification COUNT — the /verify POST has no reject field,
 * so a 0.3-composite verification advances a spam submission toward payment
 * exactly like a 0.8; and (2) the only true rejection is ABSTENTION — a
 * submission that never reaches quorum expires to permanent zero. Scoring
 * farm output low therefore SUBSIDIZES it (quorum credit + a burned slot
 * from our shared 38/day budget) while abstention polices it.
 *
 * The evidence: 20/20 of our most recent verifications were one Sybil farm
 * (19 wallets across 20 submissions; the generator leaked `wallet=0x…` into
 * two trace bodies) running two fixed-text templates with jitter fields.
 * This module fingerprints those templates, flags the farm's generated
 * challenge titles, and near-dupe-matches new traces against recently seen
 * ones so NEW template families are caught without a fingerprint update.
 */
import { descriptionSimilarity } from "./challenge-posting.js";

interface Fingerprint {
  name: string;
  re: RegExp;
  /** Weak markers appear in legitimate traces too (a real ML run says
   * "seed=42"); they only count when two co-occur. Strong markers are
   * generator artifacts or verbatim template constants — one suffices. */
  weak?: boolean;
}

const TEMPLATE_FINGERPRINTS: Fingerprint[] = [
  // Generator artifacts (observed verbatim in the 07-19 farm sample)
  { name: "wallet-leak", re: /\bwallet=0x[0-9a-fA-F]{4,}/ },
  { name: "salt-jitter", re: /\bsalt=\d{3,6}\b/ },
  { name: "madlib-ref", re: /\[ref\s+[A-Z][a-z]+-[0-9a-f][0-9a-f-]{6,}-\d{3,6}\]/ },
  // Fixed template constants pasted across every domain
  { name: "cv-trials", re: /n\s*=\s*12\s*trials?,?\s*CV\s*<\s*1\s*%/i },
  { name: "commit-rtt", re: /150\s*ms\s+commit.{0,30}?20\s*ms\s+RTT/is },
  { name: "lsm-btree", re: /180K\s*w\/s\s+vs\.?\s+B-?tree\s+60K/i },
  { name: "hnsw-recall", re: /95\s*%(?:\s*recall)?\s*@\s*10\s+(?:in\s+)?1\.2\s*ms/i },
  { name: "posix-memalign", re: /posix_memalign\s+over\s+malloc/i },
  // The signature technique-list combo (two rare terms in one breath)
  { name: "technique-list", re: /Raft pre-vote[\s\S]{0,400}io_uring/i },
  // Weak markers — legitimate alone, farm tells in combination
  { name: "seed-jitter", re: /\bseed=\d{2,4}\b/, weak: true },
  { name: "uid-artifact", re: /\buid=[0-9a-f]{8}\b/, weak: true },
];

/**
 * Which template fingerprint (if any) a trace matches. One strong marker or
 * two weak ones. Returns the marker name(s) for the abstain log, else null.
 */
export function findTemplateFingerprint(text: string): string | null {
  const weak: string[] = [];
  for (const f of TEMPLATE_FINGERPRINTS) {
    if (!f.re.test(text)) continue;
    if (!f.weak) return f.name;
    weak.push(f.name);
  }
  return weak.length >= 2 ? weak.join("+") : null;
}

/**
 * The farm's generated challenge titles: "<FirstName> <domain> expert
 * analysis <hex>" (Brian/Kevin/Donald/… — 11 of 20 sampled). Used to skip
 * SOLVING these too — a verified solve of a farm challenge pays the farm's
 * poster royalty, and our solver otherwise prefers their inflated "expert"
 * difficulty label.
 */
export function isFarmChallengeTitle(title: string): boolean {
  return /^\s*[A-Z][a-z0-9]{2,15}\s+\S.{0,60}?\b(expert|specialist)\s+analysis\s+[0-9a-f]{4,}\s*$/i.test(title.trim());
}

/**
 * Near-dupe check vs recently seen traces (bigram Jaccard — a template with
 * jittered numbers scores ~0.76 because the tokenizer drops numerics). This
 * is the self-updating half of the gate: a NEW template family gets through
 * once, then every sibling matches the cached copy.
 */
export const TRACE_NEAR_DUPE_THRESHOLD = Number(process.env.BOT_VERIFY_TRACE_DUPE_THRESHOLD ?? 0.5);

/**
 * Corpus for the near-dupe check: prior cached snippets EXCLUDING entries
 * recorded for the submission itself. Without self-exclusion, a submission
 * processed twice — overlapping verify polls, a 6h defer→retry, or a daemon
 * restart — matches its OWN cached copy at 100% and a legitimate trace is
 * falsely abstained: 74 confirmed clean→"100% near-dupe" pairs between
 * 07-21 and 08-05 (~5/day) before this fix. Farm siblings have different
 * submission ids, so anti-farm detection is unchanged. Pure — testable.
 */
export function nearDupeCorpus(
  entries: Array<{ id?: string; snippet?: string }>,
  selfId: string,
): string[] {
  return entries
    .filter((e) => e.id !== selfId)
    .map((e) => e.snippet ?? "")
    .filter(Boolean);
}

/**
 * The slice of a trace that the near-dupe check compares.
 *
 * WHY NOT THE FIRST 1500 CHARS (2026-09-20): solvers on this network emit a
 * machine-generated header — `Approach for "<title>" (id=<uuid>,
 * verifier_kind=standard, domain=[...], difficulty=...). Method: decomposed
 * contract, enumerated edge cases, selected deterministic implementation...` —
 * whose wording is identical ACROSS DIFFERENT challenges. Comparing from byte 0
 * lets that boilerplate carry a pair over the 0.5 threshold: two cached pairs
 * measured 0.93 similarity on a 212-char shared prefix and 0.00 similarity once
 * the prefix was skipped. Comparing the body keeps the signal where the copying
 * actually happens.
 *
 * MEASURED EFFECT (same day, live 72-submission pool, per-solver attribution):
 * zero change to the abstain set — 33 of 72 abstain under BOTH bases, and every
 * one of those matches only a SAME-SOLVER peer (the two accounts that post
 * nothing but the template). So this is a correctness guard against
 * cross-challenge false positives, NOT a throughput fix: the current abstains
 * are genuine templated-sibling matches, and relaxing the gate would only
 * credit farm content (quorum is a count with no reject field).
 *
 * Short texts (< DUPE_SHORT_TEXT_CHARS) are returned whole: there is no
 * meaningful header to skip. The cache stores the first 1500 chars, which
 * covers HEADER_SKIP + WINDOW.
 */
// Env-overridable, but validated: a bad value (e.g. BOT_VERIFY_DUPE_WINDOW=abc)
// would make `slice(250, NaN)` return "" and the `!head` guard below would then
// silently DISABLE the anti-farm gate for every long trace — fail-open on the
// one check whose job is to withhold credit from farm copies. Fall back to the
// defaults instead.
function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export const DUPE_HEADER_SKIP = positiveIntEnv("BOT_VERIFY_DUPE_HEADER_SKIP", 250);
export const DUPE_WINDOW_CHARS = positiveIntEnv("BOT_VERIFY_DUPE_WINDOW", 1250);
export const DUPE_SHORT_TEXT_CHARS = 600;

export function dupeWindow(text: string): string {
  if (text.length <= DUPE_SHORT_TEXT_CHARS) return text;
  return text.slice(DUPE_HEADER_SKIP, DUPE_HEADER_SKIP + DUPE_WINDOW_CHARS);
}

export function findNearDuplicateTrace(
  trace: string,
  priorSnippets: string[],
  threshold = TRACE_NEAR_DUPE_THRESHOLD,
): { similarity: number } | null {
  const head = dupeWindow(trace);
  if (!head) return null;
  let best = 0;
  for (const p of priorSnippets) {
    const w = dupeWindow(p);
    if (!w) continue;
    const s = descriptionSimilarity(head, w);
    if (s > best) best = s;
  }
  return best >= threshold ? { similarity: best } : null;
}

/**
 * Off-topic score clamp. The scorer's observed failure mode: correctness
 * correctly drops on a detected topic mismatch, but reasoning/efficiency
 * stay 0.65-0.72 because the junk contains structured tables of (irrelevant)
 * numbers — an admitted "no connection to the challenge" trace scored
 * efficiency 0.72. If correctness says mismatch, the other dimensions can't
 * honestly exceed it by much: tables of numbers about the wrong problem are
 * not reasoning, efficiency, or novelty. Deterministic (no prompt change, so
 * the 06-11 scorer calibration for ON-topic traces is untouched).
 */
export function applyOffTopicClamp<T extends {
  correctnessScore: number;
  reasoningScore: number;
  efficiencyScore: number;
  noveltyScore: number;
}>(scores: T): T {
  if (scores.correctnessScore > 0.3) return scores;
  const cap = Math.min(0.4, scores.correctnessScore + 0.15);
  return {
    ...scores,
    reasoningScore: Math.min(scores.reasoningScore, cap),
    efficiencyScore: Math.min(scores.efficiencyScore, cap),
    noveltyScore: Math.min(scores.noveltyScore, cap),
  };
}
