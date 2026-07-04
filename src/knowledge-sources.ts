/**
 * Engagement-grounded knowledge sources for the publishing pipeline.
 *
 * Each source returns null when no material is ready, or a {title, body, tags}
 * triple that's anchored in actual network artifacts (trace IDs, learning CIDs,
 * etc.) — real work product with receipts, never a free-floating generic essay.
 *
 * Sources tried in order (high-credibility first):
 *   1. verification synthesis  — "I verified N traces in <domain>, here's what I saw"
 *   2. mining postmortem        — reflection on a verified solve
 *   3. bounty deliverable reflux — repurpose an approved bounty deliverable
 *   4. learning commentary      — substantive reply to a peer learning
 *
 * Returns null all-around if nothing grounded is ready. The caller decides
 * whether to fall back to a generic post (max once per week).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat, VENICE_WEB_SEARCH } from "./venice.js";
import { pickModel } from "./models.js";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const ANCHOR_LOG = join(NOOK_DIR, "knowledge-anchors.jsonl");
const VAULT_DIR = join(process.cwd(), "knowledge-vault");

interface AnchorEntry {
  ts: string;
  source: "verification" | "mining" | "bounty" | "commentary" | "fallback";
  /** A stable key identifying what we anchored on (e.g. domain name, submission ID) */
  key: string;
  title: string;
}

export interface KnowledgePost {
  title: string;
  body: string;
  tags: string[];
  source: AnchorEntry["source"];
  anchorKey: string;
}

export function recordAnchor(entry: Omit<AnchorEntry, "ts">) {
  appendJsonl(ANCHOR_LOG, { ts: new Date().toISOString(), ...entry });
}

function recentAnchors(maxAgeMs: number): AnchorEntry[] {
  const cutoff = Date.now() - maxAgeMs;
  return readJsonl<AnchorEntry>(ANCHOR_LOG).filter((a) => new Date(a.ts).getTime() >= cutoff);
}

function daysAgo(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / (24 * 3600_000);
}

export function lastFallbackDays(): number {
  const fallbacks = readJsonl<AnchorEntry>(ANCHOR_LOG).filter((a) => a.source === "fallback");
  if (fallbacks.length === 0) return Infinity;
  return daysAgo(fallbacks[fallbacks.length - 1].ts);
}

// ─────────────────────────────────────────────────────────────
// SOURCE 1: verification synthesis
// ─────────────────────────────────────────────────────────────

interface VerificationNote {
  submissionId: string;
  challengeId?: string;
  solver?: string;
  domain: string;
  scores: number[];
  insight: string;
  ts: number;
}

function readVerificationNotes(maxAgeMs: number): VerificationNote[] {
  const dir = join(VAULT_DIR, "research");
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - maxAgeMs;
  const files = readdirSync(dir).filter((f) => f.startsWith("verification-") && f.endsWith(".md"));
  const notes: VerificationNote[] = [];
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");
    const subMatch = body.match(/submissionId:\s*([0-9a-fA-F-]+)/);
    const chMatch = body.match(/challengeId:\s*([0-9a-fA-F-]+)/);
    const solverMatch = body.match(/solver:\s*(0x[0-9a-fA-F]{40})/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]*)\]/);
    const scoresMatch = body.match(/scores:\s*\[([^\]]+)\]/);
    if (!subMatch || !scoresMatch) continue;
    const tags = (tagsMatch?.[1] ?? "")
      .split(",")
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
      .filter((t) => t && t !== "verification");
    const domain = tags[0] ?? "general";
    const insightMatch = body.match(/## Insight submitted\s*\n+([\s\S]*?)(?:\n##|\n*$)/);
    const insight = (insightMatch?.[1] ?? "").trim().slice(0, 500);
    const scores = scoresMatch[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    // Use file mtime as proxy for ts
    const stat = (existsSync(join(dir, f)) ? Date.now() : 0); // simplification
    if (stat < cutoff) continue;
    notes.push({
      submissionId: subMatch[1],
      challengeId: chMatch?.[1],
      solver: solverMatch?.[1],
      domain,
      scores,
      insight,
      ts: stat,
    });
  }
  return notes;
}

async function verificationSynthesis(): Promise<KnowledgePost | null> {
  const notes = readVerificationNotes(14 * 24 * 3600_000);
  if (notes.length < 5) return null;
  // Group by domain
  const byDomain = new Map<string, VerificationNote[]>();
  for (const n of notes) {
    if (!byDomain.has(n.domain)) byDomain.set(n.domain, []);
    byDomain.get(n.domain)!.push(n);
  }
  // Find a domain with ≥5 traces we haven't synthesized recently
  const recentKeys = new Set(
    recentAnchors(30 * 24 * 3600_000).filter((a) => a.source === "verification").map((a) => a.key),
  );
  let chosen: { domain: string; notes: VerificationNote[] } | null = null;
  for (const [domain, ns] of byDomain) {
    if (ns.length < 5) continue;
    if (recentKeys.has(domain)) continue;
    if (!chosen || ns.length > chosen.notes.length) chosen = { domain, notes: ns };
  }
  if (!chosen) return null;

  const sample = chosen.notes.slice(0, 10);
  const sys = `You write a "what I observed verifying N traces in <domain>" synthesis post for a knowledge network. The post is grounded in actual verifications — every claim must reference at least one specific submission by ID.

OUTPUT JSON ONLY:
{"title": "5-14 word title naming the domain + the observation", "body": "<markdown body 800-1300 words>"}

REQUIRED structure for body:
## Setup
What I verified, how many, over what period. Be specific.

## What stood out
3-5 numbered observations. EACH must cite at least one submission ID (8-char prefix is enough). Concrete patterns, not vague claims.

## What I'd grade harder next time
1-2 calibration notes — patterns I noticed I might've been over-generous on.

## Citations
Numbered list of every submissionId you referenced.

REQUIREMENTS:
- Cite specific submissionIds (8-char prefix). Never fake a citation.
- Concrete numbers ("4 of 7 traces", "scores ranged 0.35-0.82"), not "many" / "some".
- No fluff. No "in conclusion." No greetings.`;

  const userMsg = `Domain: ${chosen.domain}
Trace count in last 14 days: ${chosen.notes.length}
Sample (first 10):
${sample.map((n, i) => `${i + 1}. submissionId=${n.submissionId.slice(0, 12)} scores=[${n.scores.map((s) => s.toFixed(2)).join("/")}] insight="${n.insight.slice(0, 200)}"`).join("\n")}`;

  const res = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ],
    { max_tokens: 3500, temperature: 0.25, model: pickModel("knowledge_body") },
  );
  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const p = JSON.parse(cleaned.slice(first, last + 1)) as { title?: string; body?: string };
    if (!p.title || !p.body || p.body.length < 600) return null;
    return {
      title: String(p.title).slice(0, 180),
      body: p.body,
      tags: ["agent-generated", "verification-synthesis", chosen.domain],
      source: "verification",
      anchorKey: chosen.domain,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SOURCE 2: mining postmortem
// ─────────────────────────────────────────────────────────────

interface LearningEntry {
  ts: string;
  submissionId: string;
  challengeId: string;
  cid?: string;
  specificityScore?: number;
  status?: string;
}

async function miningPostmortem(): Promise<KnowledgePost | null> {
  const learnings = readJsonl<LearningEntry>(join(NOOK_DIR, "learnings-posted.jsonl")).filter(
    (l) => l.status === "posted",
  );
  if (learnings.length === 0) return null;
  const recent = recentAnchors(60 * 24 * 3600_000)
    .filter((a) => a.source === "mining")
    .map((a) => a.key);
  const used = new Set(recent);
  const candidate = [...learnings].reverse().find((l) => !used.has(l.submissionId));
  if (!candidate) return null;

  // Pull the original mining vault note
  const vaultFile = join(VAULT_DIR, "research", `mining-${candidate.challengeId.slice(0, 12)}.md`);
  if (!existsSync(vaultFile)) return null;
  const vault = readFileSync(vaultFile, "utf8");

  const sys = `You write a public knowledge post that postmortems a mining challenge solve. The audience is other agents who will face similar problems. The post must cite the specific challengeId + the IPFS-pinned trace.

OUTPUT JSON ONLY:
{"title":"5-14 word title naming the specific technique or pitfall", "body":"<markdown 700-1100 words>"}

Body structure:
## What the challenge asked
Brief restatement (3-5 sentences).

## My approach
What I tried. Be specific about choices and tradeoffs.

## What surprised me
The single most concrete thing I learned. Cite numbers or behaviors.

## What I'd do differently
1-2 specific changes for next time.

## Citations
- challengeId: <id>
- traceCid: <cid if known>
- Any papers/learnings I cited`;

  const userMsg = `Challenge ID: ${candidate.challengeId}
Submission ID: ${candidate.submissionId}
Learning CID: ${candidate.cid ?? "(not yet pinned)"}
Specificity score: ${candidate.specificityScore ?? "?"}

## Original vault note
${vault.slice(0, 4000)}`;

  const res = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ],
    { max_tokens: 2800, temperature: 0.25, model: pickModel("knowledge_body") },
  );
  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const p = JSON.parse(cleaned.slice(first, last + 1)) as { title?: string; body?: string };
    if (!p.title || !p.body || p.body.length < 500) return null;
    return {
      title: String(p.title).slice(0, 180),
      body: p.body,
      tags: ["agent-generated", "mining-postmortem"],
      source: "mining",
      anchorKey: candidate.submissionId,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SOURCE 3: bounty deliverable reflux
// ─────────────────────────────────────────────────────────────

async function bountyReflux(): Promise<KnowledgePost | null> {
  const dir = join(VAULT_DIR, "bounties");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith("-work.md"));
  if (files.length === 0) return null;
  const recent = new Set(recentAnchors(60 * 24 * 3600_000).filter((a) => a.source === "bounty").map((a) => a.key));
  const candidate = files.reverse().find((f) => !recent.has(f));
  if (!candidate) return null;

  const body = readFileSync(join(dir, candidate), "utf8");
  // Look for a title in the frontmatter
  const titleMatch = body.match(/title:\s*"?([^\n"]+)/);
  const bountyTitle = titleMatch?.[1]?.trim() ?? "Bounty deliverable";

  const sys = `Convert a bounty deliverable into a public knowledge post that's useful to other agents. The bounty work itself is typically markdown — repackage the most generalizable insights into a knowledge post, with citations to the original bounty.

OUTPUT JSON ONLY:
{"title":"5-14 word title — the generalizable claim, not the bounty title", "body":"<markdown 700-1200 words>"}

The body must:
- Lead with the generalizable insight, not the bounty context
- Quote concrete claims/numbers from the original where useful
- Cite the bounty ID at the bottom
- Strip any client-specific context that's not interesting outside the bounty`;

  const userMsg = `Original bounty deliverable file: ${candidate}\nOriginal title: ${bountyTitle}\n\n## Deliverable content (truncated to 6000 chars)\n${body.slice(0, 6000)}`;

  const res = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ],
    { max_tokens: 3000, temperature: 0.25, model: pickModel("knowledge_body") },
  );
  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const p = JSON.parse(cleaned.slice(first, last + 1)) as { title?: string; body?: string };
    if (!p.title || !p.body || p.body.length < 500) return null;
    return {
      title: String(p.title).slice(0, 180),
      body: p.body,
      tags: ["agent-generated", "bounty-reflux"],
      source: "bounty",
      anchorKey: candidate,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SOURCE 4: learning commentary
// ─────────────────────────────────────────────────────────────

async function learningCommentary(runtime: RuntimeLike): Promise<KnowledgePost | null> {
  let learnings: Array<{
    id?: string;
    submissionId?: string;
    cid?: string;
    summary?: string;
    content?: string;
    specificityScore?: number;
    domains?: string[];
    author?: string;
    authorAddress?: string;
  }> = [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/learnings?limit=20&sort=specificity_desc",
    )) as { learnings?: typeof learnings };
    learnings = res.learnings ?? [];
  } catch {
    return null;
  }
  const recent = new Set(recentAnchors(30 * 24 * 3600_000).filter((a) => a.source === "commentary").map((a) => a.key));
  const candidate = learnings.find(
    (l) => l.cid && !recent.has(l.cid) && (l.specificityScore ?? 0) >= 70 && (l.summary?.length ?? 0) > 80,
  );
  if (!candidate) return null;

  const sys = `Write a short, substantive commentary on another agent's learning post. NOT a summary — a reflection that either:
(a) extends the learning with a specific case where it applies / doesn't apply, or
(b) constructively pushes back with a concrete counter-example.

OUTPUT JSON ONLY:
{"title":"5-12 words framing your angle (not the original learning's title)", "body":"<markdown 400-700 words>"}

Body structure:
## The learning I'm responding to
Brief quote / restatement (2-3 sentences). Cite by CID + author.

## My take
The actual reflection. Specific. Not "great points!"

## Where this applies / breaks
Concrete cases.

## Citations
- Original learning CID: <cid>
- Author address: <addr>
- Any additional sources`;

  const userMsg = `Learning to respond to:
CID: ${candidate.cid}
Author: ${candidate.author ?? candidate.authorAddress ?? "(unknown)"}
Specificity: ${candidate.specificityScore}
Domains: ${(candidate.domains ?? []).join(", ")}

Summary:
${candidate.summary ?? ""}

Full content (truncated):
${(candidate.content ?? "").slice(0, 3000)}`;

  const res = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ],
    { max_tokens: 2000, temperature: 0.3, model: pickModel("knowledge_body") },
  );
  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const p = JSON.parse(cleaned.slice(first, last + 1)) as { title?: string; body?: string };
    if (!p.title || !p.body || p.body.length < 300) return null;
    return {
      title: String(p.title).slice(0, 180),
      body: p.body,
      tags: ["agent-generated", "commentary"],
      source: "commentary",
      anchorKey: candidate.cid ?? candidate.id ?? "?",
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Top-level: try sources in order
// ─────────────────────────────────────────────────────────────

export async function findGroundedPost(runtime: RuntimeLike): Promise<KnowledgePost | null> {
  // Priority order: verification synthesis (highest credibility), mining postmortem
  // (per-solve cadence, very specific), bounty reflux (rare but high value),
  // commentary (cheap, frequent).
  const tries: Array<() => Promise<KnowledgePost | null>> = [
    verificationSynthesis,
    miningPostmortem,
    bountyReflux,
    () => learningCommentary(runtime),
  ];
  for (const t of tries) {
    try {
      const post = await t();
      if (post) return post;
    } catch (err) {
      console.warn(`   ⚠ grounded source error: ${(err as Error).message}`);
    }
  }
  return null;
}
