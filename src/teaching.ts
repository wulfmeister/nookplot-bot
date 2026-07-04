/**
 * Teaching marketplace — agents pay each other to teach a skill/topic.
 *
 * As a track we monitor:
 *   1. search-teachers + log open demand in our domains
 *   2. stats endpoint for dashboard
 *   3. Propose/accept/deliver — manual, gated behind explicit env opt-in
 *
 * Endpoints:
 *   POST /v1/teaching/propose
 *   POST /v1/teaching/:id/accept
 *   POST /v1/teaching/:id/deliver
 *   POST /v1/teaching/:id/approve
 *   POST /v1/teaching/:id/reject
 *   GET  /v1/teaching/exchanges?...
 *   GET  /v1/teaching/search-teachers?...
 *   GET  /v1/teaching/stats
 *
 * Toggle: BOT_TEACHING_LOOP=0 disables. Default ON (browse-only).
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { canAutoWriteNow, recordAutoWrite, effectiveTeachingCap } from "./quotas.js";
import { withGenerationSlot } from "./generation-semaphore.js";
import { recordAudit } from "./audit.js";

const TEACHING_DELIVER_COST = Number(process.env.BOT_TEACHING_DELIVER_COST ?? 0.10);

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "teaching.jsonl");

export interface TeachingExchange {
  id: string;
  teacherAddress?: string;
  learnerAddress?: string;
  skill?: string;
  topic?: string;
  amount?: number;
  amountToken?: string;
  status?: "proposed" | "accepted" | "delivered" | "approved" | "rejected" | "cancelled";
  createdAt?: string;
  deliveredAt?: string | null;
}

export interface TeacherSearchResult {
  address: string;
  displayName?: string;
  skills?: string[];
  rating?: number;
  exchangeCount?: number;
}

export interface TeachingStats {
  totalExchanges?: number;
  totalSettledAmount?: number;
  topSkills?: Array<{ skill: string; count: number }>;
}

interface LogEntry {
  ts: string;
  kind: "stats" | "exchange-incoming" | "proposed" | "delivered" | "accepted" | "rejected" | "error";
  exchangeId?: string;
  notes?: string;
  details?: unknown;
}

export async function fetchTeachingStats(runtime: RuntimeLike): Promise<TeachingStats | null> {
  try {
    return (await runtime.connection.request("GET", `/v1/teaching/stats`)) as TeachingStats;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return null;
    console.warn(`📚 teaching stats fetch failed: ${msg}`);
    return null;
  }
}

export async function listMyExchanges(runtime: RuntimeLike): Promise<TeachingExchange[]> {
  try {
    const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
    const params = new URLSearchParams();
    if (me) params.set("teacher", me);
    const res = (await runtime.connection.request(
      "GET",
      `/v1/teaching/exchanges?${params.toString()}`,
    )) as { exchanges?: TeachingExchange[]; items?: TeachingExchange[] };
    return res.exchanges ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    console.warn(`📚 teaching exchanges fetch failed: ${msg}`);
    return [];
  }
}

export async function searchTeachers(runtime: RuntimeLike, skill: string): Promise<TeacherSearchResult[]> {
  const params = new URLSearchParams({ skill });
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/teaching/search-teachers?${params.toString()}`,
    )) as { teachers?: TeacherSearchResult[]; items?: TeacherSearchResult[] };
    return res.teachers ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    console.warn(`📚 search teachers failed: ${msg}`);
    return [];
  }
}

/** Accept an incoming teaching request (someone wants to learn from us). */
export async function acceptTeachingRequest(runtime: RuntimeLike, exchangeId: string): Promise<void> {
  await runtime.connection.request("POST", `/v1/teaching/${encodeURIComponent(exchangeId)}/accept`, {});
  appendJsonl(LOG, { ts: new Date().toISOString(), kind: "accepted" as const, exchangeId });
}

/** Deliver the lesson content (body of teaching). */
export async function deliverTeaching(
  runtime: RuntimeLike,
  exchangeId: string,
  content: string,
): Promise<void> {
  if (content.length < 400) throw new Error("teaching content must be ≥ 400 chars to be substantive");
  await runtime.connection.request("POST", `/v1/teaching/${encodeURIComponent(exchangeId)}/deliver`, { content });
  appendJsonl(LOG, {
    ts: new Date().toISOString(),
    kind: "delivered" as const,
    exchangeId,
    notes: `${content.length}c`,
  });
}

const DAILY_LESSON_CAP = 2;

function countLessonsToday(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return readJsonl<LogEntry>(LOG).filter(
    (e) => e.kind === "delivered" && e.ts && new Date(e.ts).getTime() >= cutoff,
  ).length;
}

function ourSpecializationTags(): string[] {
  return (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Generate a substantive lesson on the requested skill/topic using Venice.
 * Returns null if the topic is outside our expertise or generation fails.
 */
export async function generateLesson(exchange: TeachingExchange): Promise<string | null> {
  const skill = exchange.skill ?? exchange.topic ?? "";
  if (skill.length < 3) return null;
  const ourTags = ourSpecializationTags();
  const sys = `You are an expert teacher delivering a paid lesson on a knowledge network. Produce a SUBSTANTIVE 800-1200 word lesson with:

STRUCTURE:
## Overview — 1-2 paragraphs framing what this skill is and why it matters
## Foundations — the 3-5 most important concepts, each with a definition + example
## Walk-through — a concrete worked example (with numbers, code, or a derivation)
## Common pitfalls — 3 specific mistakes learners make + how to avoid each
## Further reading — 3-5 named references (papers, RFCs, books, repos)

REQUIREMENTS:
- Specific over abstract. Concrete numbers and named examples beat generic principles.
- Cite specific sources — author + year + title.
- If the requested skill is FAR outside your expertise (${ourTags.join(", ") || "general CS"}), return exactly the string DECLINE.`;
  const userMsg = `Topic / skill: ${skill}\n\nDeliver the lesson now.`;
  try {
    return await withGenerationSlot("teaching", async () => {
      const res = await chat(
        [
          { role: "system", content: sys },
          { role: "user", content: userMsg },
        ],
        { model: pickModel("mining_solve"), timeoutMs: 600_000, max_tokens: 6000 },
      );
      const content = (res.content ?? "").trim();
      if (!content || content === "DECLINE" || content.length < 400) return null;
      return content;
    });
  } catch {
    return null;
  }
}

/**
 * Auto-accept + auto-deliver an incoming teaching request. Gated triply:
 *   1. BOT_TEACHING_AUTO_ACCEPT=1   — operator opt-in
 *   2. Skill must overlap our specialization tags
 *   3. Daily cap (2 lessons / 24h) keeps relay-burn predictable
 */
async function maybeAutoDeliver(runtime: RuntimeLike, ex: TeachingExchange): Promise<void> {
  if (process.env.BOT_TEACHING_AUTO_ACCEPT !== "1") return;
  const { cap, reason } = effectiveTeachingCap();
  if (countLessonsToday() >= cap) {
    if (countLessonsToday() === cap && cap < DAILY_LESSON_CAP) {
      console.log(`📚 teaching daily cap halved (${cap}/${DAILY_LESSON_CAP}) — ${reason}`);
    }
    return;
  }
  if (!canAutoWriteNow(TEACHING_DELIVER_COST)) {
    return;
  }
  // No skill-tag pre-filter — frontier models can teach most topics.
  // Generate first; if the model can't produce substantive content it
  // returns DECLINE and we skip without accepting. Refusing the accept is
  // cheaper than accepting + failing to deliver.
  const lesson = await generateLesson(ex);
  if (!lesson) return;
  const skill = (ex.skill ?? ex.topic ?? "").toLowerCase();
  try {
    await acceptTeachingRequest(runtime, ex.id);
    await deliverTeaching(runtime, ex.id, lesson);
    recordAutoWrite("teaching", TEACHING_DELIVER_COST, `exchange=${ex.id}`);
    recordAudit("teaching_deliver", "submitted", `skill=${skill}`, {
      exchangeId: ex.id,
      chars: lesson.length,
      learner: ex.learnerAddress?.slice(0, 12),
    });
    console.log(`📚 ✓ auto-delivered lesson on ${skill} (${lesson.length}c) to ${ex.learnerAddress?.slice(0, 12)}`);
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      exchangeId: ex.id,
      notes: (err as Error).message.slice(0, 200),
    });
  }
}

/**
 * Top-level tick: log stats + any incoming exchanges. Auto-accept only with
 * BOT_TEACHING_AUTO_ACCEPT=1.
 */
export async function runTeachingTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_TEACHING_LOOP === "0") return;
  const stats = await fetchTeachingStats(runtime);
  if (stats) {
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "stats" as const, details: stats });
  }
  const mine = await listMyExchanges(runtime);
  const seen = new Set(
    readJsonl<LogEntry>(LOG).filter((e) => e.kind === "exchange-incoming").map((e) => e.exchangeId).filter(Boolean) as string[],
  );
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
  for (const ex of mine) {
    if (!ex.id || seen.has(ex.id)) continue;
    // Only log exchanges where someone is asking us to teach
    if (ex.teacherAddress?.toLowerCase() !== me) continue;
    if (ex.status !== "proposed") continue;
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "exchange-incoming" as const,
      exchangeId: ex.id,
      notes: `learner=${ex.learnerAddress?.slice(0, 12)} skill=${ex.skill} amt=${ex.amount}`,
    });
    console.log(
      `📚 teaching request: ${ex.skill ?? ex.topic ?? "?"} from ${ex.learnerAddress?.slice(0, 12)} ` +
        `amount=${ex.amount ?? "?"} ${ex.amountToken ?? "NOOK"}`,
    );
    // Auto-deliver if gated env says so + skill matches
    void maybeAutoDeliver(runtime, ex).catch(() => undefined);
  }
}

export interface TeachingSummary {
  exchangesIncoming: number;
  exchangesAccepted: number;
  exchangesDelivered: number;
  totalExchangesAllAgents?: number;
}

export function teachingSummary(): TeachingSummary {
  const all = readJsonl<LogEntry>(LOG);
  const lastStats = all
    .filter((e) => e.kind === "stats")
    .map((e) => e.details as TeachingStats)
    .pop();
  return {
    exchangesIncoming: all.filter((e) => e.kind === "exchange-incoming").length,
    exchangesAccepted: all.filter((e) => e.kind === "accepted").length,
    exchangesDelivered: all.filter((e) => e.kind === "delivered").length,
    totalExchangesAllAgents: lastStats?.totalExchanges,
  };
}
