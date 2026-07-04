/**
 * Peer review (Path B, Phase B1) — review OTHER agents' commits to score the
 * `collab` reputation dimension (the last builder dim still at zero). Outward-
 * facing, so it's gated like the projects pipeline: the bot DRAFTS a review with
 * a thorough description, queues ONE for you, and only submits on your approval.
 *
 * Flow: get_frontiers → pick a not-ours, code-bearing, pending_review commit →
 * get_project_commit (the diff) → LLM review → propose {verdict, comment} +
 * a thorough human-facing writeup → queue → you `approve`/`pass` →
 * review_commit({projectId, commitId, verdict, comment}).
 *
 * Guardrails (per operator config):
 *   - both verdicts allowed (approve / request_changes / comment) but the draft
 *     describes its reasoning thoroughly so you can judge before approving
 *   - you approve EVERY review (BOT_PEER_REVIEW_SUBMIT gate + confirm prompt)
 *   - daily cap (BOT_PEER_REVIEW_DAILY_CAP, default 1)
 *   - only high-confidence drafts are queued; never rubber-stamp
 *
 * CLI:
 *   npm run reviews                 # show the pending review draft (full writeup)
 *   npm run reviews -- scan         # find + draft one now (no submit)
 *   npm run reviews -- approve <id> # submit it (your verdict goes on-chain)
 *   npm run reviews -- pass <id>    # skip it
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { NookplotRuntime } from "@nookplot/runtime";
import { getRuntime } from "./runtime.js";
import { chat } from "./venice.js";
import { NOOK_DIR } from "./util.js";

type RvRuntime = Pick<NookplotRuntime, "tools">;
const QUEUE = join(NOOK_DIR, "peer-review-queue.json");
const US = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
const DAILY_CAP = Number(process.env.BOT_PEER_REVIEW_DAILY_CAP ?? 1);
const CODE_RE = /\.(py|js|ts|tsx|jsx|sol|rs|go|java|c|cpp|h|rb)$/i;
const VERDICTS = new Set(["approve", "request_changes", "comment"]);

interface ReviewItem {
  commitId: string;
  projectId: string;
  projectName: string;
  authorName: string;
  message: string;
  verdict: "approve" | "request_changes" | "comment";
  comment: string;
  confidence: string;
  description: string;
  filesReviewed: string[];
  status: "pending" | "approved" | "passed";
  createdAt: string;
}

function loadQ(): ReviewItem[] {
  try {
    return JSON.parse(readFileSync(QUEUE, "utf8"));
  } catch {
    return [];
  }
}
function saveQ(q: ReviewItem[]): void {
  writeFileSync(QUEUE, JSON.stringify(q, null, 2));
}
export function pendingPeerReview(): ReviewItem | null {
  return loadQ().find((i) => i.status === "pending") ?? null;
}
function approvedToday(): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return loadQ().filter((i) => i.status === "approved" && new Date(i.createdAt) >= start).length;
}

async function ex(runtime: RvRuntime, n: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return ((await runtime.tools.executeTool(n, a))?.output ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface Candidate {
  projectId: string;
  projectName: string;
  commitId: string;
  authorName: string;
  message: string;
  diff: string;
  files: string[];
}

/** Find a not-ours, code-bearing, pending_review commit we haven't reviewed. */
async function discoverCandidate(runtime: RvRuntime): Promise<Candidate | null> {
  const fr = await ex(runtime, "get_frontiers", { limit: 30 });
  const frontiers = (fr.frontiers ?? fr.commits ?? []) as Array<Record<string, unknown>>;
  const seen = new Set(loadQ().map((i) => i.commitId));
  for (const f of frontiers) {
    if (String(f.authorAddress ?? "").toLowerCase() === US) continue; // not ours
    if (f.reviewStatus && f.reviewStatus !== "pending_review") continue;
    if (Number(f.linesAdded ?? 0) <= 0) continue;
    const commitId = String(f.commitId ?? f.id ?? "");
    if (!commitId || seen.has(commitId)) continue;
    const det = await ex(runtime, "get_project_commit", { projectId: f.projectId, commitId });
    const changes = (det.changes ?? []) as Array<Record<string, unknown>>;
    const codeFiles = changes.filter((c) => CODE_RE.test(String(c.filePath ?? "")));
    if (codeFiles.length === 0) continue; // only review code commits
    const diff = codeFiles
      .map((c) => `### ${c.filePath} (${c.changeType})\n${String(c.newContent ?? "").slice(0, 4000)}`)
      .join("\n\n")
      .slice(0, 9000);
    return {
      projectId: String(f.projectId),
      projectName: String(f.projectName ?? f.projectId),
      commitId,
      authorName: String(f.authorName ?? "?"),
      message: String(f.message ?? ""),
      diff,
      files: codeFiles.map((c) => String(c.filePath)),
    };
  }
  return null;
}

function parseBlock(text: string, label: string): string {
  const m = text.match(new RegExp(`<<<${label}>>>([\\s\\S]*?)<<<END>>>`));
  return m ? m[1].trim() : "";
}

/** Generate a review draft. Returns null if low-confidence / unparseable. */
async function buildReviewDraft(cand: Candidate): Promise<ReviewItem | null> {
  const sys =
    "You are a careful, fair code reviewer reviewing ANOTHER agent's commit on a shared network. Your review is " +
    "PUBLIC and on-chain under our identity, so be accurate and non-inflammatory. Read the diff and judge it on " +
    "correctness, bugs, security, and clarity. Choose a verdict: 'approve' ONLY if the code is clearly correct and " +
    "sound; 'request_changes' ONLY if you can point to a concrete bug/risk; otherwise 'comment' (neutral, observational). " +
    "Set confidence high/medium/low — be honest; if you can't fully follow the code, use low. " +
    "Output EXACTLY these blocks:\n" +
    "<<<VERDICT>>>approve|request_changes|comment<<<END>>>\n<<<CONFIDENCE>>>high|medium|low<<<END>>>\n" +
    "<<<COMMENT>>>the on-chain review comment (specific, cite the file/line, <=600 chars, professional)<<<END>>>\n" +
    "<<<WRITEUP>>>a thorough plain-English explanation FOR THE OPERATOR: what the project/commit does, what you " +
    "examined, what you found (specifics), and why this verdict — so they can approve or reject your review<<<END>>>";
  const user = `Project: ${cand.projectName}\nCommit message: ${cand.message}\nFiles: ${cand.files.join(", ")}\n\nDIFF:\n${cand.diff}`;
  const { content } = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { temperature: 0.2, timeoutMs: 180_000 },
  );
  let verdict = parseBlock(content, "VERDICT").toLowerCase().replace(/[^a-z_]/g, "");
  const confidence = parseBlock(content, "CONFIDENCE").toLowerCase();
  const comment = parseBlock(content, "COMMENT");
  const writeup = parseBlock(content, "WRITEUP");
  if (!VERDICTS.has(verdict)) verdict = "comment";
  // Gates: must be confident, must have a substantive comment + writeup.
  if (confidence !== "high") return null;
  if (comment.length < 40 || writeup.length < 120) return null;
  return {
    commitId: cand.commitId,
    projectId: cand.projectId,
    projectName: cand.projectName,
    authorName: cand.authorName,
    message: cand.message,
    verdict: verdict as ReviewItem["verdict"],
    comment: comment.slice(0, 600),
    confidence,
    description: writeup,
    filesReviewed: cand.files,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

/** Daemon tick: keep ONE review pending at a time, ≤ daily cap. Never submits. */
export async function runPeerReviewTick(runtime: RvRuntime): Promise<void> {
  if (process.env.BOT_PEER_REVIEW_AUTO !== "1") return;
  if (pendingPeerReview()) return;
  if (approvedToday() >= DAILY_CAP) return;
  const cand = await discoverCandidate(runtime);
  if (!cand) return;
  const draft = await buildReviewDraft(cand);
  if (!draft) return; // low confidence / thin — skip, try again next tick
  const q = loadQ();
  q.push(draft);
  saveQ(q);
  console.log(
    `\n🔎🔎 PEER REVIEW PENDING YOUR APPROVAL: ${draft.verdict.toUpperCase()} on "${draft.projectName}" by ${draft.authorName}\n` +
      `   review it:  npm run reviews\n   then:       npm run reviews -- approve ${draft.commitId.slice(0, 8)}  |  -- pass ${draft.commitId.slice(0, 8)}\n`,
  );
}

function findByPrefix(q: ReviewItem[], idPrefix: string): ReviewItem | undefined {
  return q.find((i) => i.commitId === idPrefix || i.commitId.startsWith(idPrefix));
}

/** Submit a review to the chain (gated). */
export async function submitReview(runtime: RvRuntime, idPrefix: string): Promise<void> {
  const q = loadQ();
  const item = findByPrefix(q, idPrefix);
  if (!item) {
    console.log(`🔎 no queued review "${idPrefix}".`);
    return;
  }
  if (process.env.BOT_PEER_REVIEW_SUBMIT !== "1") {
    console.log("🔎 BOT_PEER_REVIEW_SUBMIT!=1 — refusing to submit. Set it to enable (your verdict goes on-chain).");
    return;
  }
  if (approvedToday() >= DAILY_CAP) {
    console.log(`🔎 daily cap (${DAILY_CAP}) reached — try tomorrow.`);
    return;
  }
  await runtime.tools.executeTool("review_commit", {
    projectId: item.projectId,
    commitId: item.commitId,
    verdict: item.verdict,
    comment: item.comment,
  });
  item.status = "approved";
  saveQ(q);
  console.log(`🔎 ✓ submitted ${item.verdict} review on "${item.projectName}" (${item.commitId.slice(0, 8)})`);
}

export function passReview(idPrefix: string): void {
  const q = loadQ();
  const item = findByPrefix(q, idPrefix);
  if (!item) {
    console.log(`🔎 no queued review "${idPrefix}".`);
    return;
  }
  item.status = "passed";
  saveQ(q);
  console.log(`🔎 passed on review ${item.commitId.slice(0, 8)}.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function cli(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "scan") {
    const rt = getRuntime();
    if (pendingPeerReview()) { console.log("🔎 a review is already pending your approval — act on it first."); return; }
    if (approvedToday() >= DAILY_CAP) { console.log(`🔎 daily cap (${DAILY_CAP}) reached.`); return; }
    console.log("🔎 scanning frontiers for a code commit to review…");
    const cand = await discoverCandidate(rt);
    if (!cand) { console.log("🔎 no suitable candidate found."); return; }
    console.log(`🔎 drafting review of "${cand.projectName}" by ${cand.authorName}…`);
    const draft = await buildReviewDraft(cand);
    if (!draft) { console.log("🔎 draft failed the confidence gate — not queuing (won't submit a low-confidence review)."); return; }
    const q = loadQ(); q.push(draft); saveQ(q);
    console.log("🔎 ✓ queued for your approval. Run: npm run reviews");
    return;
  }
  if (cmd === "approve") {
    if (!arg) { console.error("usage: npm run reviews -- approve <commitId>"); process.exit(1); }
    const item = findByPrefix(loadQ(), arg);
    if (!item) { console.log("🔎 not found."); return; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`Submit your ${item.verdict.toUpperCase()} review on "${item.projectName}" on-chain? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") { console.log("aborted."); return; }
    await submitReview(getRuntime(), arg);
    return;
  }
  if (cmd === "pass") {
    if (!arg) { console.error("usage: npm run reviews -- pass <commitId>"); process.exit(1); }
    passReview(arg);
    return;
  }
  // default: show the pending review in full
  const item = pendingPeerReview();
  if (!item) { console.log("🔎 nothing pending. Find one with: npm run reviews -- scan  (or enable BOT_PEER_REVIEW_AUTO=1)"); return; }
  console.log(`\n🔎 PENDING PEER REVIEW — your approval needed\n`);
  console.log(`  Project : ${item.projectName}`);
  console.log(`  Author  : ${item.authorName}   Commit: ${item.commitId.slice(0, 12)}`);
  console.log(`  Files   : ${item.filesReviewed.join(", ")}`);
  console.log(`  Proposed verdict: ${item.verdict.toUpperCase()}   (confidence ${item.confidence})`);
  console.log(`\n── WHY (thorough writeup) ──\n${item.description}`);
  console.log(`\n── ON-CHAIN COMMENT (what peers will see) ──\n${item.comment}`);
  console.log(`\nDecide:  npm run reviews -- approve ${item.commitId.slice(0, 8)}   (submit your verdict on-chain)`);
  console.log(`         npm run reviews -- pass ${item.commitId.slice(0, 8)}      (skip)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
