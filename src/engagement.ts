/**
 * Engagement loop — substantive comments + selective upvotes on peer learnings.
 *
 * Cheap reputation surface: a short, on-point comment is much more visible
 * than a 1500-word essay and signals that we read + reason about peer work.
 *
 * Endpoints (verified live 2026-05-22):
 *   GET  /v1/mining/learnings/browse?domainTag=&limit=  (search)
 *   GET  /v1/mining/learnings/:id                       (detail)
 *   GET  /v1/mining/learnings/:id/comments              (existing thread)
 *   POST /v1/mining/learnings/:id/comments  body: {body, parentCommentId?}
 *   POST /v1/mining/learnings/:id/upvote    body: {}    (toggle)
 *
 * Rate limits per SDK: 10 comments per learning per hour. We cap globally:
 *   - 2 comments/day (high-quality only)
 *   - 5 upvotes/day (only learnings we'd actually cite)
 *
 * Comments target peer learnings with specificityScore >= 70 and substantive
 * summaries. Generic praise ("great work!") is explicitly filtered out by the
 * prompt — we either extend or push back with a concrete case.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const ENGAGEMENT_LOG = join(NOOK_DIR, "engagement.jsonl");

const COMMENT_DAILY_CAP = 2;
const UPVOTE_DAILY_CAP = 5;

interface LogEntry {
  ts: string;
  action: "comment" | "upvote";
  learningId: string;
  authorAddress?: string;
  specificity?: number;
  body?: string;
  outcome: "submitted" | "skipped" | "error";
  notes?: string;
}

interface LearningRow {
  id?: string;
  cid?: string;
  submissionId?: string;
  summary?: string;
  content?: string;
  specificityScore?: number;
  domains?: string[];
  domainTags?: string[];
  author?: string;
  authorAddress?: string;
  upvoteCount?: number;
}

function loadDayCaches(): { commentedIds: Set<string>; upvotedIds: Set<string>; commentsToday: number; upvotesToday: number } {
  const entries = readJsonl<LogEntry>(ENGAGEMENT_LOG);
  const since = Date.now() - 24 * 3600_000;
  const commentedIds = new Set<string>();
  const upvotedIds = new Set<string>();
  let commentsToday = 0;
  let upvotesToday = 0;
  for (const e of entries) {
    if (e.outcome !== "submitted") continue;
    const recent = new Date(e.ts).getTime() >= since;
    if (e.action === "comment") {
      commentedIds.add(e.learningId);
      if (recent) commentsToday += 1;
    } else if (e.action === "upvote") {
      upvotedIds.add(e.learningId);
      if (recent) upvotesToday += 1;
    }
  }
  return { commentedIds, upvotedIds, commentsToday, upvotesToday };
}

async function browseLearnings(runtime: RuntimeLike): Promise<LearningRow[]> {
  try {
    // Confirmed live path (same one citation-velocity.ts uses successfully).
    // The previous /v1/mining/learnings/browse path was a guess and 404s.
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/network-learnings?limit=25",
    )) as { learnings?: LearningRow[]; items?: LearningRow[] };
    return res.learnings ?? res.items ?? [];
  } catch (err) {
    console.warn(`   ⚠ learnings browse failed: ${(err as Error).message.slice(0, 150)}`);
    return [];
  }
}

async function fetchLearningDetail(runtime: RuntimeLike, id: string): Promise<LearningRow | null> {
  try {
    return (await runtime.connection.request("GET", `/v1/mining/learnings/${encodeURIComponent(id)}`)) as LearningRow;
  } catch {
    return null;
  }
}

async function generateComment(l: LearningRow): Promise<string | null> {
  const sys = `Write a substantive comment on another agent's learning. NOT a summary, NOT generic praise.

Either:
(a) extend with a concrete case where the learning applies / doesn't apply, OR
(b) push back with a specific counter-example / edge case the author may have missed.

Constraints:
- 100-300 chars only. Be tight.
- Reference a specific claim from the learning verbatim or by paraphrase.
- No greetings. No "great post!" No "thanks for sharing!"
- No JSON, no markdown, no quotes around the output — just the raw comment text.`;

  const userMsg = `Specificity score: ${l.specificityScore ?? "?"}
Domains: ${(l.domains ?? l.domainTags ?? []).join(", ")}
Summary: ${l.summary ?? ""}

Full content (truncated):
${(l.content ?? "").slice(0, 2500)}`;

  try {
    const res = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: userMsg },
      ],
      { max_tokens: 250, temperature: 0.35, model: pickModel("knowledge_body") },
    );
    const text = res.content.trim().replace(/^["']|["']$/g, "");
    if (text.length < 80) return null;
    // Reject generic-praise patterns
    if (/^(great|nice|love this|thanks|interesting|good (post|point|work))/i.test(text)) return null;
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

export async function runEngagementLoop(
  runtime: RuntimeLike,
  opts: { dryRun?: boolean; myAddress?: string | null } = {},
): Promise<void> {
  if (opts.dryRun) {
    console.log("🗨 (DRY_RUN — skipping engagement)");
    return;
  }
  const caches = loadDayCaches();
  if (caches.commentsToday >= COMMENT_DAILY_CAP && caches.upvotesToday >= UPVOTE_DAILY_CAP) {
    return;
  }

  const learnings = await browseLearnings(runtime);
  if (learnings.length === 0) return;

  const mine = opts.myAddress?.toLowerCase();
  const candidates = learnings.filter((l) => {
    const id = l.id ?? l.cid ?? l.submissionId;
    if (!id) return false;
    if (mine && l.authorAddress?.toLowerCase() === mine) return false;
    if ((l.specificityScore ?? 0) < 70) return false;
    if ((l.summary?.length ?? 0) < 80) return false;
    return true;
  });

  if (candidates.length === 0) {
    console.log(`🗨 no engagement-worthy learnings in ${learnings.length} surfaced`);
    return;
  }

  // Sort by specificity descending — most concrete learnings first
  candidates.sort((a, b) => (b.specificityScore ?? 0) - (a.specificityScore ?? 0));

  let commentsRemaining = COMMENT_DAILY_CAP - caches.commentsToday;
  let upvotesRemaining = UPVOTE_DAILY_CAP - caches.upvotesToday;

  for (const l of candidates) {
    const id = (l.id ?? l.cid ?? l.submissionId)!;
    if (commentsRemaining <= 0 && upvotesRemaining <= 0) break;

    // Upvote path — only if we'd cite it ourselves (specificity >= 75 + good summary)
    if (upvotesRemaining > 0 && !caches.upvotedIds.has(id) && (l.specificityScore ?? 0) >= 75) {
      try {
        await runtime.connection.request("POST", `/v1/mining/learnings/${encodeURIComponent(id)}/upvote`, {});
        console.log(`   👍 upvoted learning ${id.slice(0, 10)} (specificity ${l.specificityScore})`);
        appendJsonl(ENGAGEMENT_LOG, {
          ts: new Date().toISOString(),
          action: "upvote" as const,
          learningId: id,
          authorAddress: l.authorAddress,
          specificity: l.specificityScore,
          outcome: "submitted" as const,
        });
        upvotesRemaining -= 1;
        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        appendJsonl(ENGAGEMENT_LOG, {
          ts: new Date().toISOString(),
          action: "upvote" as const,
          learningId: id,
          outcome: "error" as const,
          notes: (err as Error).message.slice(0, 200),
        });
      }
    }

    // Comment path — for the top ~3 most-specific that we haven't commented on
    if (commentsRemaining > 0 && !caches.commentedIds.has(id) && (l.specificityScore ?? 0) >= 80) {
      // Fetch detail if content is missing
      let detail = l;
      if (!l.content) {
        const d = await fetchLearningDetail(runtime, id);
        if (d) detail = { ...l, ...d };
      }
      const body = await generateComment(detail);
      if (!body) {
        appendJsonl(ENGAGEMENT_LOG, {
          ts: new Date().toISOString(),
          action: "comment" as const,
          learningId: id,
          outcome: "skipped" as const,
          notes: "comment generator returned generic or empty",
        });
        continue;
      }
      try {
        await runtime.connection.request(
          "POST",
          `/v1/mining/learnings/${encodeURIComponent(id)}/comments`,
          { body },
        );
        console.log(`   💬 commented on ${id.slice(0, 10)} (${body.length}ch)`);
        appendJsonl(ENGAGEMENT_LOG, {
          ts: new Date().toISOString(),
          action: "comment" as const,
          learningId: id,
          authorAddress: l.authorAddress,
          specificity: l.specificityScore,
          body: body.slice(0, 500),
          outcome: "submitted" as const,
        });
        commentsRemaining -= 1;
        await new Promise((r) => setTimeout(r, 8000));
      } catch (err) {
        console.warn(`   ⚠ comment ${id.slice(0, 10)}: ${(err as Error).message}`);
        appendJsonl(ENGAGEMENT_LOG, {
          ts: new Date().toISOString(),
          action: "comment" as const,
          learningId: id,
          outcome: "error" as const,
          notes: (err as Error).message.slice(0, 200),
        });
      }
    }
  }
}
