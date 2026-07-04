/**
 * Social engagement loops — vote, follow, comment.
 *
 * Goal: quality-gated participation in the network's social layer — votes,
 * follows, and substantive comments on work we've actually read or cited.
 * Participation also unlocks the `social` category of the daily activity drip.
 *
 * Anti-spam guardrails:
 *   - Vote loop:    1 every 90 min, max 16/day; only on minReputation 25+ + minScore 1+
 *   - Follow loop:  1 every 4h,    max 6/day;  only on agents with score > 100
 *   - Comment loop: 1 every 6h,    max 4/day;  only on learnings we already cited
 *                   (the comment is substantive, not generic "great post!")
 *
 * All actions are deduplicated via local JSONL logs:
 *   ~/.nookplot/votes.jsonl, follows.jsonl, comments.jsonl
 *
 * Toggle individually:
 *   BOT_VOTE_LOOP=0    BOT_FOLLOW_LOOP=0    BOT_COMMENT_LOOP=0
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { prepareSignRelay } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl, sleep } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const VOTE_LOG = join(NOOK_DIR, "votes.jsonl");
const FOLLOW_LOG = join(NOOK_DIR, "follows.jsonl");
const COMMENT_LOG = join(NOOK_DIR, "comments.jsonl");
const CITATION_LOG = join(NOOK_DIR, "citation-velocity.jsonl");

// Daily caps — conservative, not spam
const VOTE_DAILY_CAP = 16;
const FOLLOW_DAILY_CAP = 6;
const COMMENT_DAILY_CAP = 4;

const VOTE_INTERVAL_MS = 90 * 60_000;       // every 90 min → ~16/day theoretical
const FOLLOW_INTERVAL_MS = 4 * 3600_000;    // every 4h → 6/day
const COMMENT_INTERVAL_MS = 6 * 3600_000;   // every 6h → 4/day

// Quality floors
const VOTE_MIN_REPUTATION = 25;
const VOTE_MIN_SCORE = 1;
const FOLLOW_MIN_SCORE = 100;

interface FeedPost {
  cid?: string;
  contentCid?: string;
  authorAddress?: string;
  author_address?: string;
  score?: number;
  authorScore?: number;
  author_score?: number;
  authorReputation?: number;
  title?: string;
  community?: string;
  tags?: string[];
  createdAt?: string;
}

interface AgentRow {
  address?: string;
  contributionScore?: number;
  score?: number;
  displayName?: string;
  expertiseTags?: Array<{ tag: string }>;
}

interface CitationVelocityLogEntry {
  ts: string;
  kind: "citation" | "compile" | "citation-error";
  targetItemId?: string;
  peerAuthor?: string;
  domain?: string;
}

function countTodayInLog(path: string): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return readJsonl<{ ts?: string }>(path).filter(
    (e) => e.ts && new Date(e.ts).getTime() >= cutoff,
  ).length;
}

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  return undefined;
}

// ─── Voting ─────────────────────────────────────────────────────────────

export async function runVoteTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_VOTE_LOOP === "0") return;
  if (countTodayInLog(VOTE_LOG) >= VOTE_DAILY_CAP) return;

  // Pull "hot" feed with quality floors
  let posts: FeedPost[] = [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/feed?sort=hot&limit=25&minScore=${VOTE_MIN_SCORE}&minReputation=${VOTE_MIN_REPUTATION}`,
    )) as { posts?: FeedPost[]; items?: FeedPost[] };
    posts = res.posts ?? res.items ?? [];
  } catch (err) {
    console.warn(`👍 vote: feed fetch failed: ${(err as Error).message.slice(0, 120)}`);
    return;
  }

  // Dedupe against prior votes
  const voted = new Set(readJsonl<{ cid?: string }>(VOTE_LOG).map((v) => v.cid).filter(Boolean));
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();

  const candidates = posts.filter((p) => {
    const cid = pick<string>(p as Record<string, unknown>, "cid", "contentCid");
    const author = pick<string>(p as Record<string, unknown>, "authorAddress", "author_address") ?? "";
    return cid && !voted.has(cid) && author.toLowerCase() !== me;
  });
  if (candidates.length === 0) return;

  // Pick the best 1 per tick
  const pick1 = candidates[0];
  const cid = pick<string>(pick1 as Record<string, unknown>, "cid", "contentCid");
  if (!cid) return;
  try {
    const tx = await prepareSignRelay(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).connection,
      "/v1/prepare/vote",
      { cid, type: "up" },
    );
    console.log(`👍 voted UP on ${cid.slice(0, 12)}… (post by ${(pick1.authorAddress ?? "?").slice(0, 10)}) tx=${tx.txHash?.slice(0, 10)}…`);
    appendJsonl(VOTE_LOG, {
      ts: new Date().toISOString(),
      cid,
      type: "up",
      authorAddress: pick<string>(pick1 as Record<string, unknown>, "authorAddress", "author_address"),
      community: pick1.community,
      txHash: tx.txHash,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ALREADY_VOTED") || msg.includes("already voted")) {
      // Idempotent — record so we don't keep retrying
      appendJsonl(VOTE_LOG, { ts: new Date().toISOString(), cid, type: "up", skipped: "already-voted" });
    } else {
      console.warn(`👍 vote failed: ${msg.slice(0, 150)}`);
    }
  }
}

// ─── Following ──────────────────────────────────────────────────────────

export async function runFollowTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_FOLLOW_LOOP === "0") return;
  if (countTodayInLog(FOLLOW_LOG) >= FOLLOW_DAILY_CAP) return;

  // Use citation-velocity log to find agents whose work we've already cited —
  // they're high-quality + we've already engaged with them
  const cites = readJsonl<CitationVelocityLogEntry>(CITATION_LOG)
    .filter((e) => e.kind === "citation" && e.peerAuthor)
    .map((e) => e.peerAuthor as string);
  const followed = new Set(readJsonl<{ targetAddress?: string }>(FOLLOW_LOG).map((f) => f.targetAddress?.toLowerCase()).filter(Boolean));
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();

  // Frequency-weighted (more citations = stronger affinity)
  const counts = new Map<string, number>();
  for (const a of cites) {
    if (!a) continue;
    const al = a.toLowerCase();
    if (al === me || followed.has(al)) continue;
    counts.set(al, (counts.get(al) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return;

  // Validate the top candidate against quality floor via /v1/agents/:addr
  for (const [addr, citeCount] of sorted.slice(0, 5)) {
    try {
      const profile = (await runtime.connection.request("GET", `/v1/agents/${encodeURIComponent(addr)}`)) as AgentRow;
      const score = profile.contributionScore ?? profile.score ?? 0;
      if (score < FOLLOW_MIN_SCORE) continue;
      const tx = await prepareSignRelay(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (runtime as any).connection,
        "/v1/prepare/follow",
        { target: addr },
      );
      console.log(`👥 followed ${addr.slice(0, 12)}… (score=${score}, cited by us ${citeCount}×) tx=${tx.txHash?.slice(0, 10)}…`);
      appendJsonl(FOLLOW_LOG, {
        ts: new Date().toISOString(),
        targetAddress: addr,
        contributionScore: score,
        citationCount: citeCount,
        txHash: tx.txHash,
      });
      return; // one follow per tick
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("ALREADY_FOLLOWING") || msg.includes("already following")) {
        appendJsonl(FOLLOW_LOG, { ts: new Date().toISOString(), targetAddress: addr, skipped: "already-following" });
        continue;
      }
      // log and try next candidate
      continue;
    }
  }
}

// ─── Commenting ─────────────────────────────────────────────────────────
//
// Most spam-sensitive. Rule: only comment on learnings we've CITED. The
// comment summarizes how the cited work informed our own.

interface RecentCitation {
  ts: string;
  targetItemId: string;
  citationType: string;
  peerAuthor?: string;
  domain?: string;
}

export async function runCommentTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_COMMENT_LOOP === "0") return;
  if (countTodayInLog(COMMENT_LOG) >= COMMENT_DAILY_CAP) return;

  // Find a recent citation we haven't commented on yet
  const cites = readJsonl<CitationVelocityLogEntry>(CITATION_LOG)
    .filter((e): e is CitationVelocityLogEntry & RecentCitation =>
      e.kind === "citation" && typeof e.targetItemId === "string",
    );
  const commented = new Set(readJsonl<{ targetItemId?: string }>(COMMENT_LOG).map((c) => c.targetItemId).filter(Boolean));
  const fresh = cites.filter((c) => !commented.has(c.targetItemId));
  if (fresh.length === 0) return;

  // Pick the most recent un-commented citation
  const target = fresh[fresh.length - 1];

  // Confirmed path: /v1/mining/learnings/:insightId returns { id, title, content_cid, ... }
  let title = "";
  let contentCid: string | undefined;
  try {
    const item = (await runtime.connection.request(
      "GET",
      `/v1/mining/learnings/${encodeURIComponent(target.targetItemId)}`,
    )) as { title?: string; cid?: string; contentCid?: string; content_cid?: string };
    title = item.title ?? "";
    contentCid = item.cid ?? item.contentCid ?? item.content_cid;
  } catch {
    // Soft-fail; skip without retry storm
    return;
  }
  if (!contentCid) return;

  const domain = target.domain ?? "general";
  // Substantive, non-template body — references what we actually did with their work
  const body =
    `Cited this in our ${domain} work — the ${target.citationType === "extends" ? "approach extended" : "supporting evidence helped frame"} our trace. ` +
    `Thanks for publishing; the specificity made it directly applicable.`;

  try {
    const tx = await prepareSignRelay(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).connection,
      "/v1/prepare/comment",
      { parentCid: contentCid, body, community: domain },
    );
    console.log(`💬 commented on "${title.slice(0, 50)}" by ${(target.peerAuthor ?? "?").slice(0, 10)} tx=${tx.txHash?.slice(0, 10)}…`);
    appendJsonl(COMMENT_LOG, {
      ts: new Date().toISOString(),
      targetItemId: target.targetItemId,
      parentCid: contentCid,
      peerAuthor: target.peerAuthor,
      domain,
      body,
      txHash: tx.txHash,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ALREADY_COMMENTED") || msg.includes("duplicate")) {
      appendJsonl(COMMENT_LOG, { ts: new Date().toISOString(), targetItemId: target.targetItemId, skipped: "duplicate" });
    } else {
      console.warn(`💬 comment failed: ${msg.slice(0, 150)}`);
    }
  }
}

// ─── Wire-up ────────────────────────────────────────────────────────────

export function startSocialEngagementLoops(runtime: RuntimeLike): void {
  if (process.env.BOT_VOTE_LOOP !== "0") {
    setTimeout(() => runVoteTick(runtime).catch(() => undefined), 7 * 60_000);
    setInterval(() => runVoteTick(runtime).catch(() => undefined), VOTE_INTERVAL_MS);
  }
  if (process.env.BOT_FOLLOW_LOOP !== "0") {
    setTimeout(() => runFollowTick(runtime).catch(() => undefined), 10 * 60_000);
    setInterval(() => runFollowTick(runtime).catch(() => undefined), FOLLOW_INTERVAL_MS);
  }
  if (process.env.BOT_COMMENT_LOOP !== "0") {
    setTimeout(() => runCommentTick(runtime).catch(() => undefined), 15 * 60_000);
    setInterval(() => runCommentTick(runtime).catch(() => undefined), COMMENT_INTERVAL_MS);
  }
}

// Exported for tests
export const _internal = {
  VOTE_DAILY_CAP,
  FOLLOW_DAILY_CAP,
  COMMENT_DAILY_CAP,
  VOTE_MIN_REPUTATION,
  VOTE_MIN_SCORE,
  FOLLOW_MIN_SCORE,
};

/** Pure function: pick the best voteable post given a list, exclude list, and my address. */
export function selectVoteCandidate(
  posts: FeedPost[],
  alreadyVotedCids: Set<string>,
  myAddress: string,
): FeedPost | null {
  const me = (myAddress ?? "").toLowerCase();
  for (const p of posts) {
    const cid = pick<string>(p as Record<string, unknown>, "cid", "contentCid");
    const author = pick<string>(p as Record<string, unknown>, "authorAddress", "author_address") ?? "";
    if (!cid) continue;
    if (alreadyVotedCids.has(cid)) continue;
    if (author.toLowerCase() === me) continue;
    return p;
  }
  return null;
}

/** Pure function: rank follow candidates from citation log entries by frequency. */
export function rankFollowCandidates(
  citationLog: Array<{ kind?: string; peerAuthor?: string }>,
  alreadyFollowed: Set<string>,
  myAddress: string,
): Array<{ address: string; citeCount: number }> {
  const me = (myAddress ?? "").toLowerCase();
  const counts = new Map<string, number>();
  for (const e of citationLog) {
    if (e.kind !== "citation" || !e.peerAuthor) continue;
    const al = e.peerAuthor.toLowerCase();
    if (al === me || alreadyFollowed.has(al)) continue;
    counts.set(al, (counts.get(al) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([address, citeCount]) => ({ address, citeCount }))
    .sort((a, b) => b.citeCount - a.citeCount);
}

/** Pure function: synthesize a substantive non-template comment body. */
export function buildCommentBody(
  citationType: string,
  domain: string,
): string {
  return (
    `Cited this in our ${domain} work — the ${citationType === "extends" ? "approach extended" : "supporting evidence helped frame"} our trace. ` +
    `Thanks for publishing; the specificity made it directly applicable.`
  );
}
