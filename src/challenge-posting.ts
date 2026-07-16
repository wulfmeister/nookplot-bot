/**
 * Challenge-posting channel (2026-06-11). 5% of the daily emission
 * (250k NOOK/day network-wide) goes to challenge posters, and per the
 * operator-playbook research poster royalties are trust/tier-weighted —
 * a few QUALITY challenges from an established staked wallet beat volume.
 * Royalties accrue per verified solve of our challenge (sourceType
 * `posting`), and every `access_mining_trace` micro-royalty splits between
 * solver / verifiers / **challenge poster** / treasury — so a challenge
 * that attracts solvers keeps paying.
 *
 * Cadence: 1/day default (gateway cap is 10/day — deliberately way under).
 * Quality gates before POST:
 *   - description must clear our own specificity mirror (≥4 of 6 categories
 *     — the same gate our submissions face),
 *   - grounded in a real vault note (our solved challenges + verification
 *     insights), not free-floating LLM invention — with grounding ROTATION
 *     (notes used in the last 30d are deprioritized) so the deterministic
 *     vault search can't feed the drafter the same 4 notes every cycle,
 *   - semantic anti-repeat gate: token-Jaccard near-dupe check vs every
 *     prior posted title (threshold 0.45), with recent titles fed to the
 *     draft prompt as negative examples and a next-domain fallback so the
 *     gate never costs the day's royalty.
 *
 * Toggle BOT_CHALLENGE_POST=0. Cap via BOT_CHALLENGE_POST_CAP.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { NOOK_DIR, readJsonl, appendJsonl, extractJsonObj } from "./util.js";
import { search as vaultSearch, noteSummary } from "./vault.js";
import { countSpecificity } from "./specificity-gate.js";
import { specializeDomains } from "./mining.js";
import { recordAudit } from "./audit.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "challenges-posted.jsonl");
const DAILY_CAP = Number(process.env.BOT_CHALLENGE_POST_CAP ?? 1);
const MIN_SPECIFICITY = 4;

interface PostedEntry {
  ts: string;
  challengeId?: string;
  title: string;
  domain: string;
  /** "posting" = intent row appended BEFORE the gateway POST; finalized by a
   * later "posted"/"error" row with the same title. A crash between POST and
   * log-append used to hide a live challenge from the cap and the dupe gate
   * forever — an orphaned intent row keeps both conservative. */
  outcome: "posted" | "error" | "skipped" | "posting";
  notes?: string;
  /** Vault note keys that grounded this draft — drives grounding rotation. */
  groundingNotes?: string[];
  /** Posted description — the anti-repeat gate compares draft descriptions
   * against these (titles are cheap to paraphrase; the problem text is what
   * peers actually solve). Absent on pre-gate entries. */
  description?: string;
}

interface ChallengeDraft {
  title: string;
  description: string;
  difficulty: "medium" | "hard" | "expert";
  domainTags: string[];
}

/**
 * Gateway royalty epochs settle at 02:00 UTC, so "today" must be counted in
 * epoch-days, not calendar days: a 00:30Z post belongs to the PRIOR epoch.
 * Calendar-day counting let 00:03Z/00:51Z posts (06-26, 07-03) double-fill one
 * epoch's royalty (capped at 250k) and leave their own epoch to luck.
 */
export function epochDay(iso: string): string {
  return new Date(new Date(iso).getTime() - 2 * 3600_000).toISOString().slice(0, 10);
}

/** Next 02:00Z settlement boundary at/after nowMs. Pure — testable. */
export function nextSettlementMs(nowMs: number): number {
  const d = new Date(nowMs);
  const todaySettle = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 2, 0, 0);
  return nowMs < todaySettle ? todaySettle : todaySettle + 86_400_000;
}

export function postedToday(
  entries: Array<{ ts: string; outcome: string; title?: string }>,
  nowIso: string,
): number {
  const today = epochDay(nowIso);
  const todays = entries.filter((e) => epochDay(e.ts) === today);
  const posted = todays.filter((e) => e.outcome === "posted");
  // Orphaned intent rows count as posts: a "posting" row with no later
  // finalizing row (same title) means we may have a live challenge the log
  // never confirmed (crash mid-POST) — treat it as posted rather than risk
  // double-filling the epoch (the royalty caps at 250k regardless).
  const orphanedIntents = todays.filter(
    (e) =>
      e.outcome === "posting" &&
      !todays.some(
        (f) => f !== e && f.title === e.title && (f.outcome === "posted" || f.outcome === "error") && f.ts >= e.ts,
      ),
  );
  return posted.length + orphanedIntents.length;
}

export function isDuplicateTitle(title: string, prior: Array<{ title: string }>): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const t = norm(title);
  return prior.some((p) => norm(p.title) === t);
}

// ── Anti-repeat gate (2026-07-15) ─────────────────────────────────────────
// Exact-title dedupe proved trivially defeatable: the deterministic domain
// rotation + deterministic vaultSearch grounding re-derived the same problem
// every cycle, and the dedupe only forced cosmetic edits ("1,000-Qubit" →
// "1,200-Qubit"). Measured damage: 18 of the first 40 posted titles were
// near-dupes of another post (12 pairs at token-Jaccard ≥0.45, worst 88%),
// and peers started calling the output templated. The gate below rejects
// drafts SEMANTICALLY similar to anything we've posted.

const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "vs", "versus", "against", "for", "under", "with", "in",
  "on", "of", "to", "and", "at", "by", "into", "from", "over", "via",
]);

/**
 * Ordered content tokens of a title. The tokenizer is LOAD-BEARING (validated
 * against the real 40-title corpus): split on ALL non-alphanumerics (else
 * "Surface-Code"/"Deopt/Respec" hide matches), DROP pure-numeric tokens
 * (numbers are the model's fake-novelty lever — 1,000→1,200 qubits,
 * 0.92→0.85 load were the only "difference" in real dupes), and strip a
 * trailing plural-s (else the real HNSW/LSH dupe pair scores 0.36 and
 * escapes; stemmed it scores 0.46 and is caught).
 */
export function titleTokenList(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !TITLE_STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Content tokens of a title as a set (see titleTokenList for the rules). */
export function titleTokens(title: string): Set<string> {
  return new Set(titleTokenList(title));
}

/** Jaccard similarity of two titles' content-token sets (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export const NEAR_DUPLICATE_THRESHOLD = Number(process.env.BOT_CHALLENGE_DEDUPE_THRESHOLD ?? 0.45);
/** Rolling gate window: a repeat of a 3-month-old title costs nothing; a
 * skipped day costs the 250k royalty. Comparing vs ALL history forever would
 * saturate each domain's small title vocabulary and make skips chronic. */
export const GATE_WINDOW_DAYS = Number(process.env.BOT_CHALLENGE_GATE_WINDOW_DAYS ?? 90);

/**
 * The rows the anti-repeat gate compares against: LIVE posts only (posted, or
 * an in-flight/crashed "posting" intent), inside the rolling window. Skipped
 * drafts were never seen by peers — comparing against them blocks titles no
 * one has read (the original 0.45 calibration was contaminated by exactly
 * this); error rows would block the natural retry after a transient gateway
 * failure.
 */
export function gateCorpus<T extends { ts: string; title: string; outcome: string }>(
  prior: T[],
  nowIso: string,
  windowDays = GATE_WINDOW_DAYS,
): T[] {
  const cutoff = new Date(nowIso).getTime() - windowDays * 86_400_000;
  return prior.filter(
    (p) =>
      (p.outcome === "posted" || p.outcome === "posting") &&
      p.title !== "(no acceptable draft)" &&
      new Date(p.ts).getTime() >= cutoff,
  );
}

/**
 * Semantic near-dupe check vs the gate corpus. Returns the closest prior
 * title so the redraft prompt can name what to avoid. Threshold 0.45
 * validated on the posted-only corpus with the pinned tokenizer: catches
 * every real same-problem pair (worst 0.70) with zero false positives;
 * lowering it starts blocking legitimately-distinct pairs at ~0.35.
 */
export function findNearDuplicate(
  title: string,
  corpus: Array<{ title: string }>,
  threshold = NEAR_DUPLICATE_THRESHOLD,
): { title: string; similarity: number } | null {
  let best: { title: string; similarity: number } | null = null;
  for (const p of corpus) {
    if (!p.title || p.title === "(no acceptable draft)") continue;
    const s = titleSimilarity(title, p.title);
    if (s >= threshold && (!best || s > best.similarity)) best = { title: p.title, similarity: s };
  }
  return best;
}

/** Adjacent content-token bigrams of a title ("surface code", "code distance"). */
export function titleBigrams(title: string): Set<string> {
  const toks = titleTokenList(title);
  const out = new Set<string>();
  for (let i = 0; i + 1 < toks.length; i++) out.add(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

export const MOTIF_COOLDOWN_DAYS = Number(process.env.BOT_CHALLENGE_MOTIF_COOLDOWN_DAYS ?? 14);

/**
 * Domain-scoped motif cooldown. The dominant repetition mode isn't the ≥0.45
 * clones — it's FAMILIES ("Surface-Code Distance vs X", "Deopt Oscillation
 * in Y") whose members score 0.30–0.43 against each other, under the Jaccard
 * gate but plainly repetitive to anyone reading the feed. Banning the title
 * bigrams of same-domain posts from the last N days blocks the family without
 * lowering the global threshold (which would block legitimately-distinct
 * titles). Returns the first colliding bigram, or null.
 */
export function findMotifCollision(
  title: string,
  domain: string,
  corpus: Array<{ ts: string; title: string; domain?: string }>,
  nowIso: string,
  days = MOTIF_COOLDOWN_DAYS,
): { bigram: string; priorTitle: string } | null {
  const cutoff = new Date(nowIso).getTime() - days * 86_400_000;
  const bigrams = titleBigrams(title);
  for (const p of corpus) {
    if (p.domain !== domain || new Date(p.ts).getTime() < cutoff) continue;
    for (const b of titleBigrams(p.title)) {
      if (bigrams.has(b)) return { bigram: b, priorTitle: p.title };
    }
  }
  return null;
}

export const DESCRIPTION_SIMILARITY_THRESHOLD = Number(process.env.BOT_CHALLENGE_DESC_THRESHOLD ?? 0.3);

/**
 * Bigram-Jaccard similarity of two descriptions. Titles are cheap to
 * paraphrase — peers solve DESCRIPTIONS, and the observed failure mode is a
 * renamed title over the same problem text. Bigrams (not unigrams) so shared
 * vocabulary alone doesn't collide; 0.30 threshold since same-recipe
 * descriptions share long runs of phrasing.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const ba = titleBigrams(a);
  const bb = titleBigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const x of ba) if (bb.has(x)) inter++;
  return inter / (ba.size + bb.size - inter);
}

/**
 * Gate relaxation near settlement: the royalty pays for a POSTED challenge —
 * a mildly repetitive post has positive expected value, a skipped day is
 * exactly zero. On the rescue path, or within ~4h of the 02:00Z settlement,
 * the semantic gates stand down to exact-title dedupe + specificity only.
 */
export function isGateRelaxed(nowMs: number, rescue: boolean): boolean {
  return rescue || nextSettlementMs(nowMs) - nowMs <= 4 * 3600_000;
}

/**
 * Ordered domains to try: today's rotation first, then the rest by
 * least-recently-posted (staleness = fresh motif space), always excluding
 * domains already posted this epoch-day — a fallback or rescue that lands in
 * today's own domain near-dupes today's own post (and the naive "+1" fallback
 * collided with both the rescue's "+1" and tomorrow's rotation).
 */
export function fallbackDomainOrder(
  domains: string[],
  prior: Array<{ ts: string; domain?: string; outcome: string }>,
  nowIso: string,
  primary: string,
): string[] {
  const today = epochDay(nowIso);
  const postedToday = new Set(
    prior.filter((p) => (p.outcome === "posted" || p.outcome === "posting") && epochDay(p.ts) === today).map((p) => p.domain),
  );
  const lastPosted = new Map<string, number>();
  for (const p of prior) {
    if (p.outcome !== "posted" || !p.domain) continue;
    const t = new Date(p.ts).getTime();
    if (t > (lastPosted.get(p.domain) ?? 0)) lastPosted.set(p.domain, t);
  }
  const rest = domains
    .filter((d) => d !== primary && !postedToday.has(d))
    .sort((a, b) => (lastPosted.get(a) ?? 0) - (lastPosted.get(b) ?? 0));
  return postedToday.has(primary) ? rest : [primary, ...rest];
}

/**
 * Titles posted in the last `days` epoch-days — fed to the draft prompt as
 * negative examples so the model steers away from recent motifs up front
 * (cheaper than drafting into the gate and bouncing).
 */
export function recentPostedTitles(
  prior: Array<{ ts: string; title: string; outcome: string }>,
  nowIso: string,
  days = 14,
): string[] {
  const cutoff = new Date(nowIso).getTime() - days * 86_400_000;
  return prior
    .filter((p) => p.outcome === "posted" && new Date(p.ts).getTime() >= cutoff)
    .map((p) => p.title);
}

/**
 * Grounding rotation: prefer vault notes NOT used to ground a recent post.
 * vaultSearch is deterministic (keyword-count score, stable sort), so without
 * rotation the same domain query returns the same top-4 notes every cycle —
 * the root cause of the re-derived challenges. Pads with used notes when the
 * unused pool is thin rather than going ungrounded.
 */
export function rotateGrounding<T extends { path: string }>(
  candidates: T[],
  recentlyUsed: ReadonlySet<string>,
  take: number,
): T[] {
  const fresh = candidates.filter((n) => !recentlyUsed.has(noteKey(n.path)));
  const used = candidates.filter((n) => recentlyUsed.has(noteKey(n.path)));
  return [...fresh, ...used].slice(0, take);
}

/** Stable identifier for a vault note in the posted-log (basename, ext off). */
export function noteKey(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

/** Note keys used as grounding within the last `days` epoch-days. */
export function recentGroundingKeys(
  prior: Array<{ ts: string; groundingNotes?: string[] }>,
  nowIso: string,
  days = 30,
): Set<string> {
  const cutoff = new Date(nowIso).getTime() - days * 86_400_000;
  const keys = new Set<string>();
  for (const p of prior) {
    if (new Date(p.ts).getTime() < cutoff) continue;
    for (const k of p.groundingNotes ?? []) keys.add(k);
  }
  return keys;
}

/** Rotate domain by day-of-year so consecutive posts spread across our domains. */
export function rotateDomain(domains: string[], dayOfYear: number): string {
  if (domains.length === 0) return "algorithms";
  return domains[dayOfYear % domains.length];
}

/**
 * The 250k/day "posting" income is a poster ROYALTY: it pays only if ≥1 solve
 * of OUR posted challenge gets VERIFIED before the 02:00Z settlement. A
 * challenge that attracts no solvers earns nothing (epoch 06-22: 0-submission
 * challenge → full 250k missed). If today's challenge still has zero
 * submissions ≤6h before settlement, one extra post in a different domain is
 * the only remaining lever. Max 1 rescue/epoch — with DAILY_CAP=1 that's 2
 * posts, still far under the gateway's 10/day.
 */
async function midEpochRescueNeeded(
  runtime: RuntimeLike,
  prior: PostedEntry[],
  nowIso: string,
  postedCount: number,
): Promise<boolean> {
  if (postedCount >= DAILY_CAP + 1) return false; // one rescue max
  const nowMs = new Date(nowIso).getTime();
  if (nextSettlementMs(nowMs) - nowMs > 6 * 3600_000) return false;
  const today = prior.filter((e) => epochDay(e.ts) === epochDay(nowIso) && e.outcome === "posted");
  const last = today[today.length - 1];
  if (!last?.challengeId) return false;
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/challenges/${encodeURIComponent(last.challengeId)}`,
    )) as { challenge?: { submissionCount?: number }; submissionCount?: number };
    const count = res.challenge?.submissionCount ?? res.submissionCount;
    return count === 0;
  } catch {
    return false; // can't read the count — don't spend a post on a guess
  }
}

async function draftChallenge(domain: string, grounding: string, avoidTitles: string[]): Promise<ChallengeDraft | null> {
  const avoid =
    avoidTitles.length > 0
      ? `\n\nRecently posted challenges — your problem MUST be clearly different from ALL of these (different technique, different trade-off, different scenario; do not just change the numbers):\n${avoidTitles.map((t) => `- ${t}`).join("\n")}`
      : "";
  const res = await chat(
    [
      {
        role: "system",
        content:
          "You author a reasoning challenge for a network of AI agents. Quality bar: concrete, solvable, " +
          "verifiable by reading a reasoning trace. The description MUST include specific numbers with units, " +
          "named techniques (`backtick-quoted`), and an explicit X-vs-Y trade-off to analyze — generic prompts " +
          "are rejected. Do NOT copy the grounding material verbatim; derive a NEW problem inspired by it. " +
          'Output JSON only: {"title":"<=100 chars","description":"400-1200 chars, concrete, specific",' +
          '"difficulty":"medium|hard|expert","domainTags":["tag1","tag2"]}',
      },
      {
        role: "user",
        content: `Domain: ${domain}\n\nGrounding material from my own solved challenges and verification insights:\n\n${grounding.slice(0, 4000)}${avoid}`,
      },
    ],
    // 8000 not 4000: on models where thinking eats the completion budget
    // (observed on openai-gpt-55 at xhigh), 4000 can return empty content.
    { max_tokens: 8000, temperature: 0.7, model: pickModel("mining_solve") },
  );
  const p = extractJsonObj<Partial<ChallengeDraft>>(res.content);
  if (!p || !p.title || !p.description) return null;
  return {
    title: String(p.title).slice(0, 100),
    description: String(p.description).slice(0, 2000),
    difficulty: (["medium", "hard", "expert"].includes(String(p.difficulty)) ? p.difficulty : "hard") as ChallengeDraft["difficulty"],
    domainTags: Array.isArray(p.domainTags) && p.domainTags.length > 0 ? p.domainTags.slice(0, 4).map(String) : [domain],
  };
}

export async function runChallengePostTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_CHALLENGE_POST === "0") return;
  const prior = readJsonl<PostedEntry>(LOG);
  const nowIso = new Date().toISOString();
  const postedCount = postedToday(prior, nowIso);
  let rescue = false;
  if (postedCount >= DAILY_CAP) {
    rescue = await midEpochRescueNeeded(runtime, prior, nowIso, postedCount);
    if (!rescue) return;
    console.log("📮 mid-epoch rescue: today's challenge has 0 submissions with <6h to settlement — posting one more in a different domain");
  }

  const domains = specializeDomains();
  const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86_400_000);
  const usedGrounding = recentGroundingKeys(prior, nowIso);
  const avoidTitles = recentPostedTitles(prior, nowIso);
  const corpus = gateCorpus(prior, nowIso);
  // Near settlement (or on rescue) a mildly repetitive post beats no post —
  // the semantic gates stand down to exact-title dedupe + specificity.
  const relaxed = isGateRelaxed(new Date(nowIso).getTime(), rescue);
  if (relaxed && !rescue) console.log("📮 challenge-post: <4h to settlement — anti-repeat gate relaxed to exact-dupe only");

  // The gate can exhaust a domain's fresh angles (that's the point). Rather
  // than skip the day — the royalty needs a post — fall through to other
  // domains, least-recently-posted first (fresh motif space), never one
  // already posted this epoch-day (a fallback landing in today's own domain
  // would near-dupe today's own post). Bounded at 3 domains/tick; the hourly
  // tick retries.
  const primary = rotateDomain(domains, dayOfYear + (rescue ? 1 : 0));
  const domainOrder = fallbackDomainOrder(domains, prior, nowIso, primary).slice(0, 3);
  let draft: ChallengeDraft | null = null;
  let draftDomain = "";
  let draftGrounding: string[] = [];
  let lastSkipNote = "";
  for (const domain of domainOrder.length > 0 ? domainOrder : [primary]) {
    if (draft) break;
    // Ground in our own work — rotated two ways: notes that grounded a post
    // in the last 30 days go to the back of the line (vaultSearch is
    // deterministic, so un-rotated grounding re-derives the same challenge),
    // and each ATTEMPT gets a different slice of the pool (feeding the same
    // grounding back with "avoid X" only teaches the model to rename the
    // title over the same problem).
    const pool = rotateGrounding(vaultSearch(domain, { max: 12 }), usedGrounding, 12);
    if (pool.length === 0) {
      lastSkipNote = `no vault grounding for ${domain}`;
      console.log(`📮 challenge-post: ${lastSkipNote} — trying next domain`);
      continue;
    }

    // Up to 3 draft attempts per domain: a single too-generic draft used to
    // skip the whole tick, and with ticks hours apart two such skips left an
    // entire epoch bare (2026-07-04: consecutive "specificity <4" skips 8h
    // apart put the day's 250k royalty at risk). Near-dupe rejections feed the
    // colliding title back into the redraft prompt as a negative example.
    const localAvoid = [...avoidTitles];
    for (let attempt = 1; attempt <= 3 && !draft; attempt++) {
      const slice = pool.slice((attempt - 1) * 4, attempt * 4);
      const notes = slice.length > 0 ? slice : pool.slice(0, 4);
      const grounding = notes.map((n) => noteSummary(n, 400)).join("\n\n");
      let cand: ChallengeDraft | null = null;
      try {
        cand = await draftChallenge(domain, grounding, localAvoid);
      } catch (err) {
        lastSkipNote = `draft failed: ${(err as Error).message.slice(0, 100)}`;
        console.warn(`📮 challenge-post: ${lastSkipNote} (attempt ${attempt}/3, ${domain})`);
        continue;
      }
      if (!cand) {
        lastSkipNote = "draft unparseable";
        console.warn(`📮 challenge-post: draft unparseable (attempt ${attempt}/3, ${domain})`);
        continue;
      }
      if (relaxed) {
        if (isDuplicateTitle(cand.title, corpus)) {
          lastSkipNote = `exact duplicate title "${cand.title.slice(0, 50)}"`;
          console.log(`📮 challenge-post: ${lastSkipNote} (attempt ${attempt}/3, ${domain})`);
          continue;
        }
      } else {
        const nearDupe = findNearDuplicate(cand.title, corpus);
        if (nearDupe) {
          lastSkipNote = `near-dupe of "${nearDupe.title.slice(0, 50)}" (${(nearDupe.similarity * 100).toFixed(0)}%)`;
          console.log(`📮 challenge-post: "${cand.title.slice(0, 50)}" is a ${lastSkipNote} (attempt ${attempt}/3, ${domain})`);
          localAvoid.push(cand.title, nearDupe.title);
          continue;
        }
        const motif = findMotifCollision(cand.title, domain, corpus, nowIso);
        if (motif) {
          lastSkipNote = `motif cooldown "${motif.bigram}" (recently posted in ${domain}: "${motif.priorTitle.slice(0, 40)}")`;
          console.log(`📮 challenge-post: ${lastSkipNote} (attempt ${attempt}/3)`);
          localAvoid.push(cand.title, motif.priorTitle);
          continue;
        }
        const descDupe = corpus
          .filter((p) => p.description)
          .map((p) => ({ p, s: descriptionSimilarity(cand!.description, p.description!) }))
          .sort((a, b) => b.s - a.s)[0];
        if (descDupe && descDupe.s >= DESCRIPTION_SIMILARITY_THRESHOLD) {
          lastSkipNote = `description ${(descDupe.s * 100).toFixed(0)}% similar to "${descDupe.p.title.slice(0, 40)}"`;
          console.log(`📮 challenge-post: ${lastSkipNote} (attempt ${attempt}/3, ${domain})`);
          localAvoid.push(cand.title, descDupe.p.title);
          continue;
        }
      }
      const spec = countSpecificity(cand.description);
      if (spec < MIN_SPECIFICITY) {
        lastSkipNote = `specificity ${spec}<${MIN_SPECIFICITY}`;
        console.log(`📮 challenge-post: draft too generic (${spec}/${MIN_SPECIFICITY} categories) (attempt ${attempt}/3, ${domain})`);
        continue;
      }
      draft = cand;
      draftDomain = domain;
      draftGrounding = notes.map((n) => noteKey(n.path));
    }
  }
  if (!draft) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      title: "(no acceptable draft)",
      domain: primary,
      outcome: "skipped" as const,
      notes: `${domainOrder.length || 1} domain(s) × 3 attempts: ${lastSkipNote}`,
    } satisfies PostedEntry);
    return;
  }
  const domain = draftDomain;

  // Intent row BEFORE the POST: a crash between the gateway call and the log
  // append used to hide a live challenge from the cap and the dupe gate. An
  // orphaned "posting" row is finalized by the posted/error row below; if we
  // die in between, postedToday counts it and the gate corpus sees its title.
  appendJsonl(LOG, {
    ts: new Date().toISOString(),
    title: draft.title,
    domain,
    outcome: "posting" as const,
    groundingNotes: draftGrounding,
    description: draft.description,
  } satisfies PostedEntry);
  // Concurrency re-check: another runner (manual CLI + daemon tick) may have
  // posted while we drafted. Their rows are visible now; ours is excluded by
  // title match. Over-cap → abort our intent instead of double-posting.
  const recheck = readJsonl<PostedEntry>(LOG).filter((e) => !(e.outcome === "posting" && e.title === draft!.title));
  if (postedToday(recheck, new Date().toISOString()) >= DAILY_CAP + (rescue ? 1 : 0)) {
    console.warn("📮 ⚠ concurrent post detected during draft — aborting this one");
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      title: draft.title,
      domain,
      outcome: "error" as const,
      notes: "aborted: concurrent post filled today's cap",
    } satisfies PostedEntry);
    return;
  }

  try {
    const res = (await runtime.connection.request("POST", "/v1/mining/challenges", {
      title: draft.title,
      description: draft.description,
      difficulty: draft.difficulty,
      domainTags: draft.domainTags,
      durationHours: 72,
    })) as { challenge?: { id?: string }; id?: string };
    const id = res.challenge?.id ?? res.id;
    console.log(`📮 ✅ challenge posted: "${draft.title.slice(0, 60)}" (${draft.difficulty}, ${domain}) id=${id?.slice(0, 8)}`);
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      challengeId: id,
      title: draft.title,
      domain,
      outcome: "posted" as const,
      groundingNotes: draftGrounding,
      description: draft.description,
    } satisfies PostedEntry);
    recordAudit("challenge_post", "submitted", draft.title.slice(0, 80), { domain, difficulty: draft.difficulty });
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`📮 ⚠ challenge post failed: ${msg.slice(0, 160)}`);
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      title: draft.title,
      domain,
      outcome: "error" as const,
      notes: msg.slice(0, 160),
      groundingNotes: draftGrounding,
    } satisfies PostedEntry);
  }
}
