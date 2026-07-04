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
 *     insights), not free-floating LLM invention,
 *   - title dedupe vs everything we've posted before.
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
  outcome: "posted" | "error" | "skipped";
  notes?: string;
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

export function postedToday(entries: Array<{ ts: string; outcome: string }>, nowIso: string): number {
  const today = epochDay(nowIso);
  return entries.filter((e) => epochDay(e.ts) === today && e.outcome === "posted").length;
}

export function isDuplicateTitle(title: string, prior: Array<{ title: string }>): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const t = norm(title);
  return prior.some((p) => norm(p.title) === t);
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

async function draftChallenge(domain: string, grounding: string): Promise<ChallengeDraft | null> {
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
        content: `Domain: ${domain}\n\nGrounding material from my own solved challenges and verification insights:\n\n${grounding.slice(0, 4000)}`,
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
  // Rescue posts rotate to the NEXT domain — the current one just proved
  // unattractive to solvers today.
  const domain = rotateDomain(domains, dayOfYear + (rescue ? 1 : 0));

  // Ground in our own work: recent vault notes for this domain.
  const notes = vaultSearch(domain, { max: 4 });
  if (notes.length === 0) {
    console.log(`📮 challenge-post: no vault grounding for ${domain} — skipping today`);
    return;
  }
  const grounding = notes.map((n) => noteSummary(n, 400)).join("\n\n");

  // Up to 3 draft attempts per tick: a single too-generic draft used to skip
  // the whole tick, and with ticks hours apart two such skips left an entire
  // epoch bare (2026-07-04: consecutive "specificity <4" skips 8h apart put
  // the day's 250k royalty at risk). Drafting is cheap; the royalty is not.
  let draft: ChallengeDraft | null = null;
  let lastSkipNote = "";
  for (let attempt = 1; attempt <= 3 && !draft; attempt++) {
    let cand: ChallengeDraft | null = null;
    try {
      cand = await draftChallenge(domain, grounding);
    } catch (err) {
      lastSkipNote = `draft failed: ${(err as Error).message.slice(0, 100)}`;
      console.warn(`📮 challenge-post: ${lastSkipNote} (attempt ${attempt}/3)`);
      continue;
    }
    if (!cand) {
      lastSkipNote = "draft unparseable";
      console.warn(`📮 challenge-post: draft unparseable (attempt ${attempt}/3)`);
      continue;
    }
    if (isDuplicateTitle(cand.title, prior)) {
      lastSkipNote = `duplicate title "${cand.title.slice(0, 50)}"`;
      console.log(`📮 challenge-post: ${lastSkipNote} (attempt ${attempt}/3)`);
      continue;
    }
    const spec = countSpecificity(cand.description);
    if (spec < MIN_SPECIFICITY) {
      lastSkipNote = `specificity ${spec}<${MIN_SPECIFICITY}`;
      console.log(`📮 challenge-post: draft too generic (${spec}/${MIN_SPECIFICITY} categories) (attempt ${attempt}/3)`);
      continue;
    }
    draft = cand;
  }
  if (!draft) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      title: "(no acceptable draft)",
      domain,
      outcome: "skipped" as const,
      notes: `3 attempts: ${lastSkipNote}`,
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
    } satisfies PostedEntry);
  }
}
