/**
 * Bounty review (human-gated apply) — turns the native-bounty surface into a
 * preview → approve → submit flow, mirroring Path A (projects) and Path B (peer
 * review). The daemon DRAFTS at most one application/day for a qualifying open
 * native bounty and queues it; nothing goes on-chain until you approve.
 *
 * Why human-gated (replacing the old BOT_BOUNTY_AUTO_APPLY blind auto-apply): a
 * bounty application is outward-facing under our identity. To avoid being a
 * "slop cannon" you see and approve every application before it's submitted.
 *
 * Note: most network "bounty candidates" are EXTERNAL bug bounties (Immunefi
 * etc.) that aren't NOOK-applyable here. This pipeline only drafts for OPEN
 * NATIVE bounties (/v1/bounties), whose supply is often thin — so some days it
 * will surface nothing, which is correct (no slop).
 *
 * Flow: GET /v1/bounties?status=open → score (reward / competition / substance
 * gates, reused from bounties.ts) → generate a tailored application (the message
 * IS the deliverable pitch) → queue → you `approve`/`pass` →
 * POST /v1/bounties/:id/apply.
 *
 * Guardrails:
 *   - daily cap (BOT_BOUNTY_REVIEW_DAILY_CAP, default 1)
 *   - one application pending at a time
 *   - submit double-gated: BOT_BOUNTY_REVIEW_SUBMIT=1 + interactive y/N
 *   - only bounties passing the hard gates are ever queued
 *
 * CLI:
 *   npm run bounties                  # show the pending application (full)
 *   npm run bounties -- scan          # find + draft one now (no submit)
 *   npm run bounties -- approve <id>  # apply on-chain (after y/N)
 *   npm run bounties -- pass <id>     # skip it
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { NookplotRuntime } from "@nookplot/runtime";
import { getRuntime } from "./runtime.js";
import { NOOK_DIR, readJsonl } from "./util.js";
import {
  type BountyRow,
  matchBounty,
  scoreBountyForAutoApply,
  generateBountyApplicationMessage,
  applyToBounty,
  formatReward,
  normalizeReward,
} from "./bounties.js";

type BrRuntime = Pick<NookplotRuntime, "connection">;
const QUEUE = join(NOOK_DIR, "bounty-review-queue.json");
const APPLICATION_LOG = join(NOOK_DIR, "bounty-applications.jsonl");
const AB_APPLICATION_LOG = join(NOOK_DIR, "ab-applications.jsonl");
const DAILY_CAP = Number(process.env.BOT_BOUNTY_REVIEW_DAILY_CAP ?? 1);

function ourTags(): string[] {
  return (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

interface BountyDraftItem {
  bountyId: string;
  title: string;
  reward: string;
  rewardNook: number;
  appCount: number;
  score: number;
  scoreReasons: string[];
  matchedTags: string[];
  application: string; // the drafted application message (the deliverable pitch)
  description: string; // human-facing assessment
  status: "pending" | "approved" | "passed";
  createdAt: string;
}

function loadQ(): BountyDraftItem[] {
  try {
    return JSON.parse(readFileSync(QUEUE, "utf8"));
  } catch {
    return [];
  }
}
function saveQ(q: BountyDraftItem[]): void {
  writeFileSync(QUEUE, JSON.stringify(q, null, 2));
}
export function pendingBountyReview(): BountyDraftItem | null {
  return loadQ().find((i) => i.status === "pending") ?? null;
}
function approvedToday(): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return loadQ().filter((i) => i.status === "approved" && new Date(i.createdAt) >= start).length;
}

/** Every bounty id we've already applied to or queued (local logs + queue + gateway). */
async function appliedOrQueuedIds(runtime: BrRuntime): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const e of readJsonl<{ bountyId?: string | number }>(APPLICATION_LOG)) if (e.bountyId != null) ids.add(String(e.bountyId));
  for (const e of readJsonl<{ bountyId?: string | number }>(AB_APPLICATION_LOG)) if (e.bountyId != null) ids.add(String(e.bountyId));
  for (const i of loadQ()) ids.add(String(i.bountyId));
  // Gateway-authoritative dedup (local logs can miss apps from other runs).
  try {
    const res = (await runtime.connection.request("GET", "/v1/agents/me/bounty-applications")) as {
      applications?: Array<{ onchainBountyId?: string | number; bountyId?: string | number; bounty_id?: string | number }>;
      items?: Array<{ onchainBountyId?: string | number; bountyId?: string | number; bounty_id?: string | number }>;
    };
    for (const a of res.applications ?? res.items ?? []) {
      const id = a.onchainBountyId ?? a.bountyId ?? a.bounty_id;
      if (id != null) ids.add(String(id));
    }
  } catch {
    /* fall back to local dedup */
  }
  return ids;
}

type ScoredBounty = { b: BountyRow; matched: string[]; score: number; reasons: string[] };

/**
 * Pure ranking core (testable): keep only applyable+un-applied bounties, score
 * them, drop hard-gate failures (score 0), and return the best first. Separated
 * from discoverBounty so the filter/dedup/sort logic can be unit-tested without
 * a live gateway.
 */
export function rankBounties(bounties: BountyRow[], applied: Set<string>, tags: string[]): ScoredBounty[] {
  return bounties
    // status 0 / "open" / undefined are applyable; >0 is claimed/closed.
    .filter((b) => b.status === 0 || b.status === "open" || b.status === undefined)
    .filter((b) => !applied.has(String(b.id)))
    .map((b) => {
      const matched = matchBounty(b, tags);
      const s = scoreBountyForAutoApply(b, matched, tags);
      return { b, matched, score: s.score, reasons: s.reasons };
    })
    // score 0 means a hard gate failed (reward floor / desc length / competition).
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Find the top-scoring open native bounty we can still apply to. */
export async function discoverBounty(runtime: BrRuntime): Promise<ScoredBounty | null> {
  let bounties: BountyRow[];
  try {
    const res = (await runtime.connection.request("GET", "/v1/bounties?status=open&first=50")) as {
      bounties?: BountyRow[];
      items?: BountyRow[];
    };
    bounties = res.bounties ?? res.items ?? [];
  } catch {
    return null;
  }
  const applied = await appliedOrQueuedIds(runtime);
  return rankBounties(bounties, applied, ourTags())[0] ?? null;
}

export async function buildBountyDraft(top: ScoredBounty): Promise<BountyDraftItem | null> {
  const application = await generateBountyApplicationMessage(top.b, ourTags());
  if (!application) return null; // model declined (off-domain) or too thin
  const reward = normalizeReward(top.b.rewardAmount);
  const appCount = top.b.applicationCount ?? top.b.applicationsCount ?? 0;
  const desc = (top.b.description ?? "").trim();
  const description =
    `What this is: an OPEN native bounty "${top.b.title ?? top.b.id}" worth ` +
    `${formatReward(top.b.rewardAmount, top.b.rewardToken)} with ${appCount} existing applicant(s).\n\n` +
    `Why it cleared our gates: ${top.reasons.join("; ")} (score ${Math.round(top.score)}). ` +
    `${top.matched.length ? `Overlaps our expertise tags: ${top.matched.join(", ")}.` : "No direct tag overlap — judged on reward, low competition, and a substantive brief."}\n\n` +
    `Bounty brief (first 600c): ${desc.slice(0, 600)}${desc.length > 600 ? "…" : ""}\n\n` +
    `The application below IS what goes on-chain under our identity. Read it: if it's concrete, credible, and something we can actually deliver, approve; if it overpromises or is off-domain, pass.`;
  return {
    bountyId: String(top.b.id),
    title: String(top.b.title ?? top.b.id),
    reward: formatReward(top.b.rewardAmount, top.b.rewardToken),
    rewardNook: reward,
    appCount,
    score: Math.round(top.score),
    scoreReasons: top.reasons,
    matchedTags: top.matched,
    application,
    description,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

/** Daemon tick: keep ONE application pending at a time, ≤ daily cap. Never submits. */
export async function runBountyReviewTick(runtime: BrRuntime): Promise<void> {
  if (process.env.BOT_BOUNTY_REVIEW_AUTO !== "1") return;
  if (pendingBountyReview()) return;
  if (approvedToday() >= DAILY_CAP) return;
  const top = await discoverBounty(runtime);
  if (!top) return;
  const draft = await buildBountyDraft(top);
  if (!draft) return; // off-domain / thin — try again next tick
  const q = loadQ();
  q.push(draft);
  saveQ(q);
  console.log(
    `\n💰💰 BOUNTY APPLICATION PENDING YOUR APPROVAL: "${draft.title}" (${draft.reward}, ${draft.appCount} applicants, score ${draft.score})\n` +
      `   review it:  npm run bounties\n   then:       npm run bounties -- approve ${draft.bountyId.slice(0, 8)}  |  -- pass ${draft.bountyId.slice(0, 8)}\n`,
  );
}

function findByPrefix(q: BountyDraftItem[], idPrefix: string): BountyDraftItem | undefined {
  return q.find((i) => i.bountyId === idPrefix || i.bountyId.startsWith(idPrefix));
}

/** Apply on-chain (double-gated). */
export async function submitBounty(runtime: BrRuntime, idPrefix: string): Promise<void> {
  const q = loadQ();
  const item = findByPrefix(q, idPrefix);
  if (!item) {
    console.log(`💰 no queued application "${idPrefix}".`);
    return;
  }
  if (process.env.BOT_BOUNTY_REVIEW_SUBMIT !== "1") {
    console.log("💰 BOT_BOUNTY_REVIEW_SUBMIT!=1 — refusing to submit. Set it to enable (your application goes on-chain).");
    return;
  }
  if (approvedToday() >= DAILY_CAP) {
    console.log(`💰 daily cap (${DAILY_CAP}) reached — try tomorrow.`);
    return;
  }
  await applyToBounty(runtime, item.bountyId, item.application);
  item.status = "approved";
  saveQ(q);
  console.log(`💰 ✓ applied to "${item.title}" (${item.bountyId.slice(0, 8)})`);
}

export function passBounty(idPrefix: string): void {
  const q = loadQ();
  const item = findByPrefix(q, idPrefix);
  if (!item) {
    console.log(`💰 no queued application "${idPrefix}".`);
    return;
  }
  item.status = "passed";
  saveQ(q);
  console.log(`💰 passed on application ${item.bountyId.slice(0, 8)}.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function cli(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "scan") {
    const rt = getRuntime();
    if (pendingBountyReview()) {
      console.log("💰 an application is already pending your approval — act on it first.");
      return;
    }
    if (approvedToday() >= DAILY_CAP) {
      console.log(`💰 daily cap (${DAILY_CAP}) reached.`);
      return;
    }
    console.log("💰 scanning open native bounties for a qualifying one…");
    const top = await discoverBounty(rt);
    if (!top) {
      console.log("💰 no qualifying open native bounty right now (native supply is often thin; the daemon keeps checking).");
      return;
    }
    console.log(`💰 drafting application for "${top.b.title ?? top.b.id}"…`);
    const draft = await buildBountyDraft(top);
    if (!draft) {
      console.log("💰 the generator declined (off-domain or too thin) — not queuing.");
      return;
    }
    const q = loadQ();
    q.push(draft);
    saveQ(q);
    console.log("💰 ✓ queued for your approval. Run: npm run bounties");
    return;
  }
  if (cmd === "approve") {
    if (!arg) {
      console.error("usage: npm run bounties -- approve <bountyId>");
      process.exit(1);
    }
    const item = findByPrefix(loadQ(), arg);
    if (!item) {
      console.log("💰 not found.");
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`Apply to "${item.title}" (${item.reward}) on-chain under our identity? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.log("aborted.");
      return;
    }
    await submitBounty(getRuntime(), arg);
    return;
  }
  if (cmd === "pass") {
    if (!arg) {
      console.error("usage: npm run bounties -- pass <bountyId>");
      process.exit(1);
    }
    passBounty(arg);
    return;
  }
  // default: show the pending application in full
  const item = pendingBountyReview();
  if (!item) {
    console.log("💰 nothing pending. Find one with: npm run bounties -- scan  (or enable BOT_BOUNTY_REVIEW_AUTO=1)");
    return;
  }
  console.log(`\n💰 PENDING BOUNTY APPLICATION — your approval needed\n`);
  console.log(`  Bounty  : ${item.title}`);
  console.log(`  Reward  : ${item.reward}   Applicants: ${item.appCount}   Score: ${item.score}`);
  console.log(`  Tags    : ${item.matchedTags.join(", ") || "(none matched — judged on substance)"}`);
  console.log(`\n── WHY (assessment) ──\n${item.description}`);
  console.log(`\n── APPLICATION (goes on-chain under our identity) ──\n${item.application}`);
  console.log(`\nDecide:  npm run bounties -- approve ${item.bountyId.slice(0, 8)}   (apply on-chain)`);
  console.log(`         npm run bounties -- pass ${item.bountyId.slice(0, 8)}      (skip)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
