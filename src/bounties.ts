/**
 * Bounties — Nookplot-native + external bug bounties.
 *
 * Two surfaces, one file:
 *   1. Native: /v1/index/bounties + /v1/bounties/:id/apply
 *      → posters lock NOOK/USDC, applicants submit deliverables, posters approve.
 *   2. External: /v1/integrations/bugbounties (Immunefi/Code4rena/Sherlock aggregator)
 *      → claiming = tracking record on Nookplot; payout happens on external platform.
 *
 * Discovery only by default — we DO NOT auto-apply or auto-claim. We just log
 * the candidates that match our domains/tags so the operator can intervene.
 *
 * Toggle: BOT_BOUNTY_LOOP=0 disables both. Default ON.
 *
 * Logs:
 *   ~/.nookplot/bounty-candidates.jsonl  — what we saw
 *   ~/.nookplot/bounty-applications.jsonl — if we applied (requires explicit opt-in)
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { canAutoWriteNow, recordAutoWrite, effectiveBountyAutoApplyCap } from "./quotas.js";
import { withGenerationSlot } from "./generation-semaphore.js";
import { recordAudit } from "./audit.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const CANDIDATE_LOG = join(NOOK_DIR, "bounty-candidates.jsonl");
const APPLICATION_LOG = join(NOOK_DIR, "bounty-applications.jsonl");

export interface BountyRow {
  id: string;
  title?: string;
  description?: string;
  rewardAmount?: number | string;
  rewardToken?: string;
  tokenAddress?: string;
  status?: string | number;
  tags?: string[];
  domainTags?: string[];
  community?: string;
  creator?: string;
  createdAt?: string;
  deadline?: string;
  /** Older field name from /v1/index/bounties. */
  applicationsCount?: number;
  /** Newer field name returned by /v1/bounties. */
  applicationCount?: number;
  submissionCount?: number;
}

export interface BugBountyRow {
  id: string;
  platform?: string;
  programName?: string;
  title?: string;
  rewardMin?: number;
  rewardMax?: number;
  rewardToken?: string;
  chains?: string[];
  languages?: string[];
  url?: string;
  tags?: string[];
}

interface CandidateLogEntry {
  ts: string;
  source: "native" | "bug-bounty";
  id: string;
  title?: string;
  reward?: string;
  matched_tags?: string[];
}

/**
 * Match a bounty's tags against our specialization tags. Case-insensitive.
 *
 * Partial-match rule: BOTH the bounty tag AND our spec tag must be ≥ 4 chars
 * for a substring hit to count. This prevents false positives like "Go"
 * (a 2-char language label) matching against "algorithms" (positions 2-3).
 */
export function matchTags(bountyTags: string[] | undefined, ourTags: string[]): string[] {
  if (!bountyTags || bountyTags.length === 0 || ourTags.length === 0) return [];
  const lower = new Set(ourTags.map((t) => t.toLowerCase().trim()));
  const matched: string[] = [];
  for (const t of bountyTags) {
    if (typeof t !== "string") continue;
    const l = t.toLowerCase().trim();
    if (lower.has(l)) matched.push(t);
    else if (l.length >= 4) {
      // partial match only when BOTH sides are ≥4 chars — avoids matching
      // 2-3 char language labels (Go, Rust, JS) against arbitrary substrings
      // of our longer spec tags.
      for (const ours of lower) {
        if (ours.length >= 4 && (l.includes(ours) || ours.includes(l))) {
          matched.push(t);
          break;
        }
      }
    }
  }
  return matched;
}

/**
 * Fallback when a bounty doesn't carry explicit tags — derive tag candidates
 * by scanning the title+description for our specialization keywords.
 * Returns the matched-tag list (could be empty).
 */
export function matchTagsByText(
  title: string | undefined,
  description: string | undefined,
  ourTags: string[],
): string[] {
  if (ourTags.length === 0) return [];
  const hay = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (!hay.trim()) return [];
  const matched: string[] = [];
  for (const t of ourTags) {
    const l = t.toLowerCase().trim();
    if (l.length < 4) continue;
    // Match whole-word or hyphen-aware substring
    const re = new RegExp(`\\b${l.replace(/[-]/g, "[- ]?")}\\b`, "i");
    if (re.test(hay)) matched.push(t);
  }
  return matched;
}

/** Combined match: tags first, then text fallback. */
export function matchBounty(b: BountyRow, ourTags: string[]): string[] {
  const tagMatched = matchTags([...(b.tags ?? []), ...(b.domainTags ?? [])], ourTags);
  if (tagMatched.length > 0) return tagMatched;
  return matchTagsByText(b.title, b.description, ourTags);
}

/** Pretty-format a reward amount. Bounties API returns either number or string,
 * and gateway returns raw wei for newer endpoints. Normalize then format.
 */
export function formatReward(amount: number | string | undefined, token: string | undefined): string {
  if (amount === undefined || amount === null) return "—";
  const raw = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(raw)) return String(amount);
  // Auto-detect wei vs whole-token
  const n = raw > 1e15 ? raw / 1e18 : raw;
  const t = token ?? "NOOK";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${t}`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k ${t}`;
  return `${n.toFixed(2)} ${t}`;
}

function ourSpecializationTags(): string[] {
  const csv = process.env.BOT_SPECIALIZE_DOMAINS ?? "";
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Score a native bounty for surfacing. Higher = more worth our attention.
 * Inverse-competition: a low-applicant high-reward bounty ranks above a
 * heavily-contested one. We surface the top-N regardless of tags — frontier
 * models can handle most topics; we just want operator visibility into the
 * best opportunities.
 */
export function scoreBountyForSurface(b: BountyRow): number {
  const reward = normalizeReward(b.rewardAmount);
  const apps = b.applicationCount ?? b.applicationsCount ?? 0;
  // Open status only (already filtered upstream) — bias toward higher reward
  // per competitor. +1 to avoid div-by-zero for zero-applicant bounties.
  return reward / (1 + apps);
}

const SURFACE_TOP_N = Number(process.env.BOT_BOUNTY_SURFACE_TOP_N ?? 10);

/**
 * Browse native bounties + log the top-N most attractive (regardless of tag
 * match). Returns the candidate count newly logged.
 */
export async function browseNativeBounties(runtime: RuntimeLike): Promise<number> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/bounties?status=open&first=50`,
    )) as { bounties?: BountyRow[]; items?: BountyRow[] };
    const bounties = res.bounties ?? res.items ?? [];

    let matchCount = 0;
    const alreadySeen = new Set(
      readJsonl<CandidateLogEntry>(CANDIDATE_LOG)
        .filter((e) => e.source === "native")
        .map((e) => e.id),
    );
    const our = ourSpecializationTags();

    // Sort all open bounties by attractiveness (reward / competition).
    // Surface the top N that we haven't seen before. No tag gate — frontier
    // models can handle most topics, we just want operator visibility.
    const ranked = bounties
      .filter((b) => b.status === 0 || b.status === "open" || b.status === undefined)
      .filter((b) => !alreadySeen.has(b.id))
      .map((b) => ({ b, score: scoreBountyForSurface(b), matched: matchBounty(b, our) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, SURFACE_TOP_N);

    for (const { b, matched } of ranked) {
      matchCount += 1;
      appendJsonl(CANDIDATE_LOG, {
        ts: new Date().toISOString(),
        source: "native" as const,
        id: b.id,
        title: b.title?.slice(0, 120),
        reward: formatReward(b.rewardAmount, b.rewardToken),
        matched_tags: matched, // empty array if no tag overlap — still surfaced
      });
      const tagNote = matched.length > 0 ? ` tags=[${matched.join(",")}]` : "";
      const apps = b.applicationCount ?? b.applicationsCount ?? 0;
      console.log(
        `💰 native bounty: "${(b.title ?? b.id).slice(0, 50)}" ` +
          `reward=${formatReward(b.rewardAmount, b.rewardToken)} apps=${apps}${tagNote}`,
      );
    }
    return matchCount;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404") || msg.includes("not found")) return 0;
    console.warn(`💰 native bounty fetch failed: ${msg}`);
    return 0;
  }
}

/**
 * Browse external bug bounties (Immunefi/Code4rena/Sherlock) + log all.
 *
 * No tag filter: bug bounties have specialty (smart-contract auditing, KYC
 * gates) that doesn't map to our domain tags, and we don't auto-claim them
 * anyway — they're discovery-only for the operator. Wide visibility is the
 * goal. Top-N by reward to keep the log manageable.
 */
export async function browseBugBounties(runtime: RuntimeLike): Promise<number> {
  const our = ourSpecializationTags();
  try {
    const res = (await runtime.connection.request("GET", `/v1/integrations/bugbounties?limit=50`)) as {
      bounties?: BugBountyRow[];
      items?: BugBountyRow[];
    };
    const list = res.bounties ?? res.items ?? [];

    let matchCount = 0;
    const alreadySeen = new Set(
      readJsonl<CandidateLogEntry>(CANDIDATE_LOG)
        .filter((e) => e.source === "bug-bounty")
        .map((e) => e.id),
    );

    // Sort by rewardMax desc, keep top-N. No tag filter.
    const ranked = list
      .filter((b) => !alreadySeen.has(b.id))
      .sort((a, b) => (b.rewardMax ?? 0) - (a.rewardMax ?? 0))
      .slice(0, SURFACE_TOP_N);

    for (const b of ranked) {
      const haystack = [
        ...(b.tags ?? []),
        ...(b.languages ?? []),
        ...(b.chains ?? []),
        b.platform ?? "",
      ];
      const matched = matchTags(haystack, our);
      const reward = b.rewardMin && b.rewardMax
        ? `${b.rewardMin}–${b.rewardMax} ${b.rewardToken ?? "USD"}`
        : `${b.rewardMax ?? b.rewardMin ?? "?"} ${b.rewardToken ?? "USD"}`;
      appendJsonl(CANDIDATE_LOG, {
        ts: new Date().toISOString(),
        source: "bug-bounty" as const,
        id: b.id,
        title: `[${b.platform ?? "external"}] ${(b.programName ?? b.title ?? "").slice(0, 100)}`,
        reward,
        matched_tags: matched, // empty if no overlap — still surfaced
      });
      matchCount += 1;
      const tagNote = matched.length > 0 ? ` tags=[${matched.join(",")}]` : "";
      console.log(
        `🐛 bug bounty: ${b.platform} "${(b.programName ?? b.title ?? "").slice(0, 50)}" ` +
          `reward=${reward}${tagNote} url=${b.url}`,
      );
    }
    return matchCount;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return 0;
    console.warn(`🐛 bug bounty fetch failed: ${msg}`);
    return 0;
  }
}

/**
 * Apply to a native bounty with an application message. Off by default —
 * only call this explicitly from CLI or a deliberate flow. Auto-apply
 * is a footgun (waste of NOOK fees, reputation hit if shallow).
 */
export const BOUNTY_MESSAGE_MAX_CHARS = 1990; // gateway hard limit is 2000; small buffer.

/** Truncate a long application message at a paragraph or sentence boundary near the cap. */
export function truncateApplicationMessage(msg: string, max = BOUNTY_MESSAGE_MAX_CHARS): string {
  if (msg.length <= max) return msg;
  // Prefer to cut at the last double-newline or period within the cap range.
  const head = msg.slice(0, max);
  const para = head.lastIndexOf("\n\n");
  if (para > max - 400) return msg.slice(0, para).trimEnd();
  const sent = head.lastIndexOf(". ");
  if (sent > max - 200) return msg.slice(0, sent + 1).trimEnd();
  return msg.slice(0, max - 1).trimEnd() + "…";
}

export async function applyToBounty(
  runtime: RuntimeLike,
  bountyId: string,
  applicationMessage: string,
): Promise<{ id?: string; status: string }> {
  if (applicationMessage.length < 200) {
    throw new Error("application message must be ≥ 200 chars (gateway quality gate)");
  }
  // Gateway hard-limits messages at 2000 chars. Truncate cleanly rather than
  // bouncing the submit, since the generator can legitimately overshoot.
  const message = truncateApplicationMessage(applicationMessage);
  try {
    const res = (await runtime.connection.request(
      "POST",
      `/v1/bounties/${encodeURIComponent(bountyId)}/apply`,
      { message },
    )) as { id?: string; applicationId?: string; status?: string };
    appendJsonl(APPLICATION_LOG, {
      ts: new Date().toISOString(),
      bountyId,
      applicationId: res.id ?? res.applicationId,
      status: res.status ?? "submitted",
      messageLength: message.length,
      truncated: message.length < applicationMessage.length,
    });
    console.log(`💰 applied to bounty ${bountyId.slice(0, 12)} → ${res.id ?? res.applicationId ?? "?"} (${message.length}c)`);
    return { id: res.id ?? res.applicationId, status: res.status ?? "submitted" };
  } catch (err) {
    appendJsonl(APPLICATION_LOG, {
      ts: new Date().toISOString(),
      bountyId,
      outcome: "error",
      error: (err as Error).message.slice(0, 200),
    });
    throw err;
  }
}

/**
 * Claim an external bug bounty (creates Nookplot tracking record).
 * Vulnerability still gets submitted on the platform (Immunefi etc.).
 */
export async function claimBugBounty(
  runtime: RuntimeLike,
  bugBountyId: string,
  trackingNote: string,
): Promise<unknown> {
  return runtime.connection.request(
    "POST",
    `/v1/integrations/bugbounties/${encodeURIComponent(bugBountyId)}/claim`,
    { note: trackingNote },
  );
}

/** Aggregate over the candidate log for the dashboard. */
export interface BountySummary {
  totalCandidates: number;
  nativeCandidates: number;
  bugBountyCandidates: number;
  last24h: number;
  applicationsSubmitted: number;
}

export function bountySummary(): BountySummary {
  const cands = readJsonl<CandidateLogEntry>(CANDIDATE_LOG);
  const apps = readJsonl<{ outcome?: string }>(APPLICATION_LOG);
  const cutoff = Date.now() - 24 * 3600_000;
  return {
    totalCandidates: cands.length,
    nativeCandidates: cands.filter((c) => c.source === "native").length,
    bugBountyCandidates: cands.filter((c) => c.source === "bug-bounty").length,
    last24h: cands.filter((c) => c.ts && new Date(c.ts).getTime() >= cutoff).length,
    applicationsSubmitted: apps.filter((a) => !a.outcome || a.outcome !== "error").length,
  };
}

const AUTO_APPLY_ACTION_COST = Number(process.env.BOT_BOUNTY_AUTO_APPLY_COST ?? 0.10);
const AUTO_APPLY_MIN_REWARD_NOOK = Number(process.env.BOT_BOUNTY_AUTO_APPLY_MIN_NOOK ?? 100);
// Fresh/low-competition bounties only by default. The live open queue can be
// saturated with 30-50 applicants; pending-but-unapproved apps are a weak
// signal, so avoid piling onto crowded requests unless explicitly configured.
const AUTO_APPLY_MAX_APPS = Number(process.env.BOT_BOUNTY_AUTO_APPLY_MAX_APPS ?? 10);
const AUTO_APPLY_MIN_DESC_CHARS = Number(process.env.BOT_BOUNTY_AUTO_APPLY_MIN_DESC ?? 200);

function countAutoAppliesToday(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return readJsonl<{ ts?: string; outcome?: string; auto?: boolean }>(APPLICATION_LOG).filter(
    (e) => e.auto && e.ts && new Date(e.ts).getTime() >= cutoff && e.outcome !== "error",
  ).length;
}

/**
 * Normalize a reward amount to whole-token units. Gateway returns the raw
 * uint256 string in token-wei (18 decimals), but our previous logging used
 * pre-scaled small numbers. Detect: if the raw value parsed is enormous
 * (> 1e15), divide by 1e18.
 */
export function normalizeReward(raw: number | string | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n > 1e15 ? n / 1e18 : n;
}

/**
 * Score a bounty for auto-apply. Returns a score 0-100. Content-based gates:
 * reward size, competition, description substance. NO topic-tag gate —
 * frontier models can handle most topics, and the LLM's `DECLINE` sentinel
 * is a stronger refusal signal than tag-overlap (which is just a proxy).
 *
 * Tag overlap is still a soft BONUS in the score (helps ranking when
 * multiple candidates pass the gates), but isn't required.
 */
export function scoreBountyForAutoApply(
  b: BountyRow,
  matched: string[],
  ourTags: string[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  // Hard gate 1: reward must clear the floor (in NOOK whole-tokens).
  const reward = normalizeReward(b.rewardAmount);
  if (reward < AUTO_APPLY_MIN_REWARD_NOOK) {
    return { score: 0, reasons: [`reward=${reward.toFixed(0)} < ${AUTO_APPLY_MIN_REWARD_NOOK}`] };
  }
  reasons.push(`reward=${reward.toFixed(0)}`);
  score += Math.min(reward / 100, 30);

  // Hard gate 2: description must be substantive (we use it as the prompt).
  const desc = (b.description ?? "").trim();
  if (desc.length < AUTO_APPLY_MIN_DESC_CHARS) {
    return { score: 0, reasons: [`desc=${desc.length}c < ${AUTO_APPLY_MIN_DESC_CHARS}`] };
  }
  reasons.push(`desc=${desc.length}c`);
  score += 25;

  // Hard gate 3: competition cap (don't apply to ones with many existing apps).
  const appCount = b.applicationCount ?? b.applicationsCount ?? 0;
  if (appCount > AUTO_APPLY_MAX_APPS) {
    return { score: 0, reasons: [`apps=${appCount} > ${AUTO_APPLY_MAX_APPS}`] };
  }
  reasons.push(`apps=${appCount}`);
  // Lower competition = higher score
  score += Math.max(0, 20 - appCount * 2);

  // Soft bonus: tag overlap (helps ranking when multiple candidates pass).
  if (matched.length > 0) {
    score += matched.length * 5;
    reasons.push(`tag-bonus=${matched.length}/${ourTags.length}`);
  }
  return { score, reasons };
}

/**
 * Generate an application message tailored to a bounty. Uses Venice.
 * Returns null on failure (e.g. model decides not to apply).
 */
export async function generateBountyApplicationMessage(b: BountyRow, ourTags: string[]): Promise<string | null> {
  const sys = `You are writing a bounty application on a knowledge network. Be CONCISE and SPECIFIC.

HARD LIMIT: TOTAL OUTPUT MUST BE UNDER 1900 CHARACTERS. The gateway hard-rejects anything ≥ 2000 chars.

REQUIREMENTS:
- 250-400 words (≈ 1500-1900 chars).
- Lead with: what you'll deliver + your approach.
- 2-3 concrete steps you'll take with technical detail.
- Cite 1-2 specific prior works (paper, repo, RFC) that inform your approach.
- No flattery, no restating the bounty back.
- If the bounty is OUTSIDE your real expertise, return exactly the string DECLINE.

Your expertise: ${ourTags.join(", ") || "general CS"}`;
  const userMsg = `Bounty title: ${b.title ?? "(none)"}\nReward: ${formatReward(b.rewardAmount, b.rewardToken)}\nTags: ${(b.tags ?? b.domainTags ?? []).join(", ")}\n\nDescription:\n${b.description}\n\nWrite the application now. Stay under 1900 chars.`;
  try {
    return await withGenerationSlot("bounty", async () => {
      const res = await chat(
        [
          { role: "system", content: sys },
          { role: "user", content: userMsg },
        ],
        // max_tokens 600 ≈ 2400 chars max — gives us headroom; the truncate
        // helper in applyToBounty enforces the hard 2000-char gateway limit.
        { model: pickModel("mining_solve"), timeoutMs: 240_000, max_tokens: 600 },
      );
      const content = (res.content ?? "").trim();
      if (!content || content === "DECLINE" || content.length < 200) return null;
      return content;
    });
  } catch {
    return null;
  }
}

/**
 * Auto-apply pass — runs at most once per BountyTick. Looks at the most-recent
 * candidate log entries, picks the top-scoring one that hasn't been applied
 * to, generates a message, applies.
 *
 * Gated by BOT_BOUNTY_AUTO_APPLY=1 (default OFF).
 */
export async function runBountyAutoApplyTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_BOUNTY_AUTO_APPLY !== "1") return;
  // Reputation-aware daily cap — halved if our last N applications had < 20%
  // approval rate within the last cooldown window.
  const { cap, reason } = effectiveBountyAutoApplyCap();
  if (countAutoAppliesToday() >= cap) {
    return; // silent — already logged when the cooldown initially kicked in
  }
  // Global auto-write cost guardrail
  if (!canAutoWriteNow(AUTO_APPLY_ACTION_COST)) {
    console.log(`💰 auto-apply skipped — daily auto-write cost cap reached`);
    return;
  }
  const ourTags = ourSpecializationTags();
  if (ourTags.length === 0) return;
  // Pull the latest 20 native bounties + score them
  let bounties: BountyRow[];
  try {
    const res = (await runtime.connection.request("GET", `/v1/bounties?status=open&first=50`)) as {
      bounties?: BountyRow[];
      items?: BountyRow[];
    };
    bounties = res.bounties ?? res.items ?? [];
  } catch {
    return;
  }
  // Skip ones we've already applied to. The local logs may miss apps made
  // by the lifecycle-scan path or older runs, so we ALSO query the gateway
  // for authoritative application history.
  const ourPriorIds = new Set<string>();
  for (const e of readJsonl<{ bountyId?: string | number }>(APPLICATION_LOG)) {
    if (e.bountyId != null) ourPriorIds.add(String(e.bountyId));
  }
  for (const e of readJsonl<{ bountyId?: string | number }>(join(NOOK_DIR, "ab-applications.jsonl"))) {
    if (e.bountyId != null) ourPriorIds.add(String(e.bountyId));
  }
  // Gateway-authoritative dedup: pull our own application history.
  // Gateway returns `onchainBountyId` (numeric) on each row — coerce to string
  // to match our local-log entries.
  try {
    const res = (await runtime.connection.request("GET", `/v1/agents/me/bounty-applications`)) as {
      applications?: Array<{
        onchainBountyId?: string | number;
        bountyId?: string | number;
        bounty_id?: string | number;
      }>;
      items?: Array<{
        onchainBountyId?: string | number;
        bountyId?: string | number;
        bounty_id?: string | number;
      }>;
    };
    const apps = res.applications ?? res.items ?? [];
    for (const a of apps) {
      const id = a.onchainBountyId ?? a.bountyId ?? a.bounty_id;
      if (id != null) ourPriorIds.add(String(id));
    }
  } catch {
    // If endpoint unavailable or shape unexpected, fall back to local dedup
    // and tolerate occasional 409s (gateway will reject duplicates anyway).
  }
  const appliedTo = ourPriorIds;
  // Filter: status=0 means open/Created (the only ones we can apply to);
  // status>0 is already-claimed, submitted, or closed.
  const scored = bounties
    .filter((b) => b.status === 0 || b.status === "open" || b.status === undefined)
    .filter((b) => !appliedTo.has(b.id))
    .map((b) => {
      const matched = matchBounty(b, ourTags);
      const score = scoreBountyForAutoApply(b, matched, ourTags);
      return { b, matched, ...score };
    })
    // score=0 means at least one hard gate failed; positive scores all pass.
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return;
  const top = scored[0];
  const message = await generateBountyApplicationMessage(top.b, ourTags);
  if (!message) {
    appendJsonl(APPLICATION_LOG, {
      ts: new Date().toISOString(),
      bountyId: top.b.id,
      auto: true,
      outcome: "skipped" as const,
      notes: "generator declined or returned too-short content",
    });
    return;
  }
  try {
    await applyToBounty(runtime, top.b.id, message);
    appendJsonl(APPLICATION_LOG, {
      ts: new Date().toISOString(),
      bountyId: top.b.id,
      auto: true,
      outcome: "submitted" as const,
      notes: `score=${top.score} tags=[${top.matched.join(",")}] cooldown="${reason}"`,
    });
    recordAutoWrite("bounty", AUTO_APPLY_ACTION_COST, `bountyId=${top.b.id}`);
    recordAudit("bounty_apply", "submitted", `"${(top.b.title ?? top.b.id).slice(0, 60)}"`, {
      bountyId: top.b.id,
      score: top.score,
      cap,
    });
    console.log(`💰 ✓ auto-applied to bounty "${(top.b.title ?? top.b.id).slice(0, 50)}" score=${top.score} (cap=${cap}; ${reason})`);
  } catch (err) {
    const msg = (err as Error).message;
    // 409 = we already applied. Record as a dedup hit (so future passes skip)
    // but don't count it as an error toward the reputation cooldown.
    if (msg.includes("409") || /already applied/i.test(msg)) {
      appendJsonl(APPLICATION_LOG, {
        ts: new Date().toISOString(),
        bountyId: top.b.id,
        auto: true,
        outcome: "skipped" as const,
        notes: "already-applied (gateway dedup)",
      });
      console.log(`💰 dedup skip: already applied to "${(top.b.title ?? top.b.id).slice(0, 50)}"`);
      return;
    }
    // Otherwise it's a real error
    appendJsonl(APPLICATION_LOG, {
      ts: new Date().toISOString(),
      bountyId: top.b.id,
      auto: true,
      outcome: "error" as const,
      notes: (err as Error).message.slice(0, 200),
    });
    recordAudit("bounty_apply", "error", (err as Error).message.slice(0, 120), { bountyId: top.b.id });
  }
}

/** Top-level tick — log candidates from both surfaces. */
export async function runBountyTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_BOUNTY_LOOP === "0") return;
  const [n, b] = await Promise.all([browseNativeBounties(runtime), browseBugBounties(runtime)]);
  if (n + b > 0) console.log(`💰 bounty scan: +${n} native, +${b} bug-bounty matches`);
  // Auto-apply pass (default OFF)
  await runBountyAutoApplyTick(runtime).catch((err) => {
    console.warn(`💰 auto-apply tick error: ${(err as Error).message.slice(0, 150)}`);
  });
}
