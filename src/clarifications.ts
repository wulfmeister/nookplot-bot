/**
 * Clarifications — micro-jobs where agents pay credit for short Q&A.
 *
 * Surfaces a few open clarification requests per tick. By default we LOG only
 * (operator/LLM picks which to answer). With BOT_CLARIFY_AUTO_OFFER=1 we'll
 * auto-offer answers, but only to questions in our specialization domains and
 * only after a quick quality gate on the question itself.
 *
 * Endpoints:
 *   GET  /v1/clarifications?status=open      — browse needs
 *   POST /v1/clarifications/:id/offer        — answer
 *   POST /v1/clarifications/:id/resolve      — close (we use this if our offer is accepted)
 *
 * Toggle: BOT_CLARIFY_LOOP=0 disables. Default ON (browse-only).
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { canAutoWriteNow, recordAutoWrite, effectiveClarifyCap } from "./quotas.js";
import { withGenerationSlot } from "./generation-semaphore.js";
import { recordAudit } from "./audit.js";

const CLARIFY_OFFER_COST = Number(process.env.BOT_CLARIFY_OFFER_COST ?? 0.05);

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "clarifications.jsonl");

const DAILY_OFFER_CAP = 3;
const MIN_QUESTION_CHARS = 60;
const MIN_REWARD_CREDITS = 0.05;

export interface ClarificationRow {
  id: string;
  requester?: string;
  question?: string;
  context?: string;
  domainTags?: string[];
  tags?: string[];
  rewardCredits?: number;
  status?: string;
  createdAt?: string;
  recipients?: string[];
}

interface LogEntry {
  ts: string;
  kind: "candidate" | "offer" | "offer-error" | "resolved";
  id: string;
  question?: string;
  domains?: string[];
  reward?: number;
  notes?: string;
}

function ourSpecializationTags(): string[] {
  return (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function countOffersToday(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return readJsonl<LogEntry>(LOG).filter(
    (e) => e.kind === "offer" && e.ts && new Date(e.ts).getTime() >= cutoff,
  ).length;
}

/** Score a clarification: higher = more worth our attention. */
export function scoreClarification(
  row: ClarificationRow,
  ourTags: string[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const q = (row.question ?? "").trim();
  if (q.length < MIN_QUESTION_CHARS) return { score: 0, reasons: ["question too short"] };
  reasons.push(`q=${q.length}c`);
  score += 5;

  const tags = [...(row.domainTags ?? []), ...(row.tags ?? [])].map((t) => t.toLowerCase());
  const our = new Set(ourTags.map((t) => t.toLowerCase()));
  const matched = tags.filter((t) => our.has(t));
  if (matched.length > 0) {
    score += 20 * matched.length;
    reasons.push(`tags=${matched.join("+")}`);
  }

  const reward = row.rewardCredits ?? 0;
  if (reward >= MIN_REWARD_CREDITS) {
    score += Math.min(reward * 10, 30);
    reasons.push(`reward=${reward.toFixed(3)}cr`);
  }

  // Direct address bonus
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
  if (me && (row.recipients ?? []).some((r) => r.toLowerCase() === me)) {
    score += 50;
    reasons.push("addressed-to-us");
  }

  return { score, reasons };
}

/**
 * Browse open clarifications. Always logs candidates. Auto-offer only if
 * BOT_CLARIFY_AUTO_OFFER=1 AND a generator callback is supplied (LLM in
 * caller; we don't carry one in this module).
 */
export async function runClarificationsTick(
  runtime: RuntimeLike,
  opts: { generateAnswer?: (row: ClarificationRow) => Promise<string | null> } = {},
): Promise<void> {
  if (process.env.BOT_CLARIFY_LOOP === "0") return;

  let rows: ClarificationRow[];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/clarifications?status=open&limit=20`,
    )) as { clarifications?: ClarificationRow[]; items?: ClarificationRow[] };
    rows = res.clarifications ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return;
    console.warn(`❓ clarifications fetch failed: ${msg}`);
    return;
  }

  if (rows.length === 0) return;

  const our = ourSpecializationTags();
  const seen = new Set(readJsonl<LogEntry>(LOG).filter((e) => e.kind === "candidate").map((e) => e.id));

  const scored = rows
    .filter((r) => !seen.has(r.id))
    .map((r) => ({ row: r, ...scoreClarification(r, our) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const s of scored.slice(0, 10)) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "candidate" as const,
      id: s.row.id,
      question: s.row.question?.slice(0, 200),
      domains: s.row.domainTags,
      reward: s.row.rewardCredits,
      notes: s.reasons.join("; "),
    });
    console.log(`❓ clarify match: "${(s.row.question ?? "").slice(0, 60)}" score=${s.score} ${s.reasons.join(",")}`);
  }

  // Auto-offer path (gated)
  if (process.env.BOT_CLARIFY_AUTO_OFFER !== "1" || !opts.generateAnswer) return;
  // Reputation-aware effective cap (halved if recent error rate too high)
  const { cap, reason } = effectiveClarifyCap();
  if (countOffersToday() >= cap) {
    if (countOffersToday() === cap && cap < DAILY_OFFER_CAP) {
      console.log(`❓ clarify daily cap halved (${cap}/${DAILY_OFFER_CAP}) — ${reason}`);
    }
    return;
  }
  if (!canAutoWriteNow(CLARIFY_OFFER_COST)) {
    console.log(`❓ auto-offer skipped — daily auto-write cost cap reached`);
    return;
  }
  const top = scored[0];
  // Threshold lowered from 30 → 10: tag overlap is now a soft bonus, not a
  // gate. The `EMPTY` sentinel from the answer generator is the real refusal
  // signal — frontier models know when they can't answer.
  if (!top || top.score < 10) return;
  let answer: string | null = null;
  try {
    answer = await opts.generateAnswer(top.row);
  } catch (err) {
    console.warn(`❓ clarify answer-gen failed: ${(err as Error).message.slice(0, 120)}`);
    return;
  }
  if (!answer || answer.trim().length < 150) {
    console.log(`❓ clarify: skipping ${top.row.id.slice(0, 12)} — generated answer too short`);
    return;
  }
  try {
    await runtime.connection.request("POST", `/v1/clarifications/${encodeURIComponent(top.row.id)}/offer`, {
      answer,
    });
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "offer" as const,
      id: top.row.id,
      notes: `len=${answer.length}`,
    });
    recordAutoWrite("clarification", CLARIFY_OFFER_COST, `id=${top.row.id}`);
    recordAudit("clarification_offer", "submitted", (top.row.question ?? "").slice(0, 80), {
      id: top.row.id,
      chars: answer.length,
    });
    console.log(`❓ ✓ offered clarification on ${top.row.id.slice(0, 12)} (${answer.length} chars)`);
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "offer-error" as const,
      id: top.row.id,
      notes: (err as Error).message.slice(0, 200),
    });
    console.warn(`❓ offer failed: ${(err as Error).message.slice(0, 150)}`);
  }
}

/**
 * Default Venice-backed answer generator for clarifications. Returns null if
 * the question is outside our domains or the model declines / produces fluff.
 *
 * Designed to be passed as opts.generateAnswer to runClarificationsTick.
 */
export async function generateClarificationAnswer(row: ClarificationRow): Promise<string | null> {
  const q = (row.question ?? "").trim();
  if (q.length < 60) return null;
  const ourTags = ourSpecializationTags();
  const tags = [...(row.domainTags ?? []), ...(row.tags ?? [])];
  const sys = `You are answering a clarification request on a knowledge network. Be DIRECT and SPECIFIC.

REQUIREMENTS:
- 200-600 words.
- Lead with the answer; don't restate the question.
- Cite a specific paper, RFC, or canonical reference if applicable.
- Include at least one concrete number, formula, or code snippet.
- If you don't know, say so and stop — no bluffing. (Returning "" is a valid response.)

Your expertise: ${ourTags.join(", ") || "general CS"}
Question's tags: ${tags.join(", ") || "(none)"}

If the question is FAR outside your expertise, return exactly the string EMPTY.`;
  const userMsg = `Question:\n${q}${row.context ? `\n\nContext:\n${row.context}` : ""}\n\nAnswer now.`;
  try {
    return await withGenerationSlot("clarification", async () => {
      const res = await chat(
        [
          { role: "system", content: sys },
          { role: "user", content: userMsg },
        ],
        { model: pickModel("mining_solve"), timeoutMs: 120_000, max_tokens: 1200 },
      );
      const content = (res.content ?? "").trim();
      if (!content || content === "EMPTY" || content.length < 150) return null;
      return content;
    });
  } catch {
    return null;
  }
}

export interface ClarificationSummary {
  candidatesLast24h: number;
  offersToday: number;
  totalCandidates: number;
}

export function clarificationSummary(): ClarificationSummary {
  const cutoff = Date.now() - 24 * 3600_000;
  const all = readJsonl<LogEntry>(LOG);
  return {
    candidatesLast24h: all.filter(
      (e) => e.kind === "candidate" && e.ts && new Date(e.ts).getTime() >= cutoff,
    ).length,
    offersToday: countOffersToday(),
    totalCandidates: all.filter((e) => e.kind === "candidate").length,
  };
}
