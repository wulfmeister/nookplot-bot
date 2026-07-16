import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { writeNote, VAULT_DIR } from "./vault.js";
import { descriptionSimilarity, titleBigrams } from "./challenge-posting.js";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");
const LEARNING_LOG = join(NOOK_DIR, "learnings-posted.jsonl");
// Terminal verification outcomes, keyed by submission. The submit-time mining
// log only records whether the trace UPLOADED (pass/deferred) — the eventual
// verified/expired/rejected result was observed in this poll but never written
// back, so mining-stats showed pass-rate "—" and we were blind to the metric
// that actually drives NOOK. This closes that loop; mining-stats joins on it.
const MINING_VERIFIED_LOG = join(NOOK_DIR, "mining-verified.jsonl");

interface MiningEntry {
  ts: string;
  challengeId: string;
  verifierKind: string;
  outcome: "pass" | "fail" | "deferred" | "error" | "skipped";
  submissionId?: string;
  model?: string;
}

/** Persist a terminal verification outcome once per submission (the loop drops
 *  each sub from the candidate set after its terminal branch, so no dupes). */
function recordMiningOutcome(m: MiningEntry, status: "verified" | "expired" | "rejected"): void {
  appendJsonl(MINING_VERIFIED_LOG, {
    ts: new Date().toISOString(),
    submissionId: m.submissionId,
    challengeId: m.challengeId,
    model: m.model,
    verifierKind: m.verifierKind,
    status,
  });
}

interface LearningEntry {
  ts: string;
  submissionId: string;
  challengeId: string;
  cid?: string;
  specificityScore?: number;
  status: "posted" | "skipped" | "error" | "rejection-analyzed" | "expired";
  notes?: string;
  /** Posted summary — the anti-repeat gate compares new drafts against these. */
  summary?: string;
}

// ── Anti-repeat gate (2026-07-15) ─────────────────────────────────────────
// The audit found the same story beats retold across learnings with different
// invented numbers (the same Dinic's-beats-Edmonds-Karp tale twice in 3 days
// at "4.5x" then "9.4x"). Two complementary checks — a skipped learning costs
// nothing, the 9th union-find-path-compression post costs credibility:
//  1. Bigram-Jaccard vs recent texts — catches near-verbatim clones (a
//     numbers-swapped clone scores ~0.76 since the tokenizer drops numerics).
//     Measured on the real 203-note corpus this ALONE is inert against
//     paraphrased retellings (max real pair 0.11), hence:
//  2. Technique-motif cooldown — a distinctive bigram ("union find",
//     "bellman ford") shared with a recent learning's summary blocks the
//     draft, the same family mechanism the challenge poster needed for
//     repeats that live under any Jaccard threshold.

export const LEARNING_DUPE_THRESHOLD = Number(process.env.BOT_LEARNING_DUPE_THRESHOLD ?? 0.4);
export const LEARNING_MOTIF_COOLDOWN_DAYS = Number(process.env.BOT_LEARNING_MOTIF_COOLDOWN_DAYS ?? 14);

/** Bigram-Jaccard the draft against recent learning texts; null = fresh. */
export function findRepetitiveLearning(
  draftText: string,
  priorTexts: string[],
  threshold = LEARNING_DUPE_THRESHOLD,
): { similarity: number; prior: string } | null {
  let best: { similarity: number; prior: string } | null = null;
  for (const p of priorTexts) {
    const s = descriptionSimilarity(draftText, p);
    if (s >= threshold && (!best || s > best.similarity)) best = { similarity: s, prior: p };
  }
  return best;
}

/**
 * Tokens too generic to identify a technique family — a bigram made ONLY of
 * these ("edge case", "hidden test") is not a motif; one distinctive token
 * ("union find", "max flow") makes it one.
 */
const GENERIC_LEARNING_TOKENS = new Set([
  "edge", "case", "hidden", "test", "verifier", "challenge", "solution",
  "problem", "approach", "algorithm", "python", "code", "function", "input",
  "output", "result", "time", "complexity", "performance", "solve",
  "submission", "trace", "solver", "constraint", "large", "small", "faster",
  "slower", "speedup", "handled", "correct", "learning", "insight",
]);

/**
 * Motif cooldown: does the draft summary share a DISTINCTIVE technique bigram
 * with any recent learning summary? Paraphrased retellings keep their anchor
 * bigrams ("dinic algorithm", "path compression") even when every sentence is
 * reworded, which is exactly what Jaccard can't see.
 */
export function findLearningMotifCollision(
  draftSummary: string,
  priorSummaries: string[],
): { bigram: string; prior: string } | null {
  const distinctive = (b: string): boolean => {
    const [x, y] = b.split(" ");
    return !(GENERIC_LEARNING_TOKENS.has(x) && GENERIC_LEARNING_TOKENS.has(y));
  };
  const draftBigrams = new Set([...titleBigrams(draftSummary)].filter(distinctive));
  if (draftBigrams.size === 0) return null;
  for (const p of priorSummaries) {
    for (const b of titleBigrams(p)) {
      if (draftBigrams.has(b)) return { bigram: b, prior: p };
    }
  }
  return null;
}

/**
 * Recent learning texts for the verbatim-clone gate: summaries stored in the
 * log (new entries) backfilled with the ## Summary/## Content sections of the
 * newest vault learning notes — so the gate is armed on day one instead of
 * waiting for post-rewrite entries to accumulate.
 */
export function recentLearningTexts(max = 25): string[] {
  const out: string[] = [];
  for (const e of readJsonl<LearningEntry>(LEARNING_LOG).slice(-max)) {
    if (e.status === "posted" && e.summary) out.push(e.summary);
  }
  try {
    const dir = join(VAULT_DIR, "research");
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("learning-") && f.endsWith(".md"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, max);
    for (const { f } of files) {
      const raw = readFileSync(join(dir, f), "utf8");
      const body = raw.split(/^## Summary$/m)[1];
      if (body) out.push(body.replace(/^## Content$/m, " ").replace(/\s+/g, " ").trim().slice(0, 1200));
    }
  } catch {
    /* vault dir missing — log summaries alone still gate */
  }
  return out.slice(0, max * 2);
}

/**
 * Summaries of learnings posted within the motif-cooldown window (log entries
 * + vault notes by mtime) — the corpus for findLearningMotifCollision.
 */
export function recentLearningSummaries(days = LEARNING_MOTIF_COOLDOWN_DAYS): string[] {
  const cutoff = Date.now() - days * 86_400_000;
  const out: string[] = [];
  for (const e of readJsonl<LearningEntry>(LEARNING_LOG)) {
    if (e.status === "posted" && e.summary && new Date(e.ts).getTime() >= cutoff) out.push(e.summary);
  }
  try {
    const dir = join(VAULT_DIR, "research");
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("learning-") || !f.endsWith(".md")) continue;
      if (statSync(join(dir, f)).mtimeMs < cutoff) continue;
      const raw = readFileSync(join(dir, f), "utf8");
      const m = raw.match(/^## Summary\s*\n+([\s\S]*?)(?:\n## |$)/m);
      if (m) out.push(m[1].replace(/\s+/g, " ").trim().slice(0, 400));
    }
  } catch {
    /* vault dir missing — log summaries alone still gate */
  }
  return out;
}

/**
 * Prompt rewritten 2026-07-15 after a corpus audit of the 203 published
 * learnings: 187 followed one 4-beat template dictated by the old prompt
 * ("surprised you when the verifier ran" became a literal section in 19/19
 * recent posts), the old few-shot example LEAKED verbatim into public posts
 * ("EvalPlus" named on challenges that never involved it), and several posts
 * carried fabricated process claims ("4 iterations on verifier feedback" —
 * this pipeline submits exactly once). The new prompt is grounding-first
 * (every fact must exist in the supplied material), template-free, and may
 * decline ({"skip":true}) when the material is too thin — a skipped learning
 * costs nothing, a fabricated one costs reputation.
 */
async function generateLearning(args: {
  challengeTitle: string;
  challengeDescription: string;
  verifierKind: string;
  reasoning: string;
  outcome: Record<string, unknown>;
  hiddenTests?: unknown;
}): Promise<{ content: string; summary: string } | "skip" | null> {
  const sys = `You are writing a short post-solve note for other agents on a mining network, attached to a verified submission of yours.

HARD GROUNDING RULE: every number, test count, tool name, and behavior you mention MUST appear in the material below (challenge, your submit-time reasoning, verifier outcome, revealed tests). If it is not in the material, it does not exist. Do NOT invent timings, iteration counts, test totals, benchmark results, or process details — this pipeline submits exactly once, so never describe feedback loops, reruns, or "iterations". Do not name harnesses or tools unless the material names them.

NUMBER PROVENANCE: numbers in the challenge DESCRIPTION are requirements/targets the challenge asked for — if you mention one, attribute it that way ("the challenge required X"). Only numbers appearing in the verifier outcome or revealed tests may be stated as results or observed behavior. If the outcome contains no numbers, your note states no result numbers.

CONTENT: extract the ONE most transferable insight from THIS solve — a technique that mattered, a pitfall, an unexpected verifier behavior. Quote the concrete evidence from the material. If the material is too thin to support a concrete, non-generic insight, output {"skip":true} instead of padding.

STYLE: plain engineer-to-engineer prose, 400-900 chars. No headings, no fixed sections, no boilerplate openers (never start with the network's name or "Post-solve learning"). Do not reuse a rigid structure — write the way the insight itself wants to be written.

Output JSON only: {"content":"<markdown>","summary":"<80-200 chars>"} or {"skip":true}`;

  const userMsg = `Challenge: ${args.challengeTitle}\nVerifier kind: ${args.verifierKind}\n\nDescription:\n${args.challengeDescription.slice(0, 1500)}\n\nMy reasoning at submit time:\n${args.reasoning.slice(0, 4000)}\n\nVerifier outcome:\n${JSON.stringify(args.outcome).slice(0, 1500)}${args.hiddenTests ? `\n\nNow-revealed hidden tests:\n${JSON.stringify(args.hiddenTests).slice(0, 1500)}` : ""}`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
    // 0.7 (was 0.4): with the template gone, low temperature was still
    // converging on near-identical phrasing across notes.
  ], { max_tokens: 700, temperature: 0.7, model: pickModel("mining_learning") });

  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1)) as { content?: string; summary?: string; skip?: boolean | string };
    if (parsed.skip === true || parsed.skip === "true") return "skip";
    if (!parsed.content || !parsed.summary) return null;
    return {
      content: parsed.content,
      summary: parsed.summary.slice(0, 240),
    };
  } catch {
    return null;
  }
}

interface RejectionDetail {
  traceSummary?: string;
  modelUsed?: string;
  challenge?: { title?: string; description?: string };
  verificationOutcome?: {
    pass?: boolean;
    score?: number;
    verifier_kind?: string;
    kind_specific?: { fail_reason?: string; tests_total?: number; tests_passed?: number };
    stderr_excerpt?: string;
    stdout_excerpt?: string;
    retry_guidance?: { hint?: string; slots_remaining?: number; max_submissions?: number };
  };
}

/**
 * Distill WHY a submission was rejected into a vault note the solver
 * context-gatherer will surface on similar future challenges. Extraction +
 * one cheap LLM pass; always marks the submission analyzed (even on LLM
 * failure) so it leaves the polling window.
 */
async function analyzeRejection(
  runtime: RuntimeLike,
  subId: string,
  m: MiningEntry,
  rawDetail: unknown,
): Promise<void> {
  const detail = rawDetail as RejectionDetail;
  const vo = detail.verificationOutcome;
  const failReason = vo?.kind_specific?.fail_reason ?? "unknown";
  const tests = vo?.kind_specific?.tests_total !== undefined
    ? `${vo.kind_specific.tests_passed ?? 0}/${vo.kind_specific.tests_total} tests passed`
    : "";
  const slots = vo?.retry_guidance?.slots_remaining;
  console.log(
    `   🔻 ${subId.slice(0, 8)} REJECTED (${vo?.verifier_kind ?? m.verifierKind}): ${failReason}${tests ? ` — ${tests}` : ""}` +
    (slots !== undefined ? ` — gateway says ${slots} resubmission slots remain` : ""),
  );

  let analysis = "";
  try {
    const res = await chat([
      {
        role: "system",
        content:
          "A mining submission of yours was rejected. Write a 300-700 char post-mortem: what concretely failed, " +
          "the most likely root cause, and ONE specific thing to do differently on similar challenges. " +
          "Be concrete (name the failure mode, cite the test counts / stderr) — this note is retrieved as context " +
          "for future solves of similar challenges. Plain text, no JSON.",
      },
      {
        role: "user",
        content:
          `Challenge: ${detail.challenge?.title ?? m.challengeId}\nVerifier kind: ${vo?.verifier_kind ?? m.verifierKind}\n` +
          `Fail reason: ${failReason}\n${tests}\nScore: ${vo?.score ?? "?"}\n` +
          `stderr: ${(vo?.stderr_excerpt ?? "").slice(0, 600)}\nstdout: ${(vo?.stdout_excerpt ?? "").slice(0, 400)}\n` +
          `Our trace summary at submit: ${(detail.traceSummary ?? "").slice(0, 400)}\nModel used: ${detail.modelUsed ?? "?"}`,
      },
    ], { max_tokens: 600, temperature: 0.3, model: pickModel("mining_learning") });
    analysis = res.content.trim().slice(0, 1200);
  } catch (err) {
    analysis = `(analysis generation failed: ${(err as Error).message.slice(0, 100)})`;
  }

  writeNote(
    "research",
    `rejection-${subId.slice(0, 12)}`,
    {
      id: `rejection-${subId}`,
      title: `Rejection post-mortem: ${detail.challenge?.title ?? subId.slice(0, 12)}`,
      type: "rejection-post-mortem",
      tags: ["rejection", vo?.verifier_kind ?? m.verifierKind],
      submissionId: subId,
      challengeId: m.challengeId,
      failReason,
      model: detail.modelUsed,
    },
    `## What failed\n\n${failReason}${tests ? ` (${tests})` : ""}\n\n## Verifier output\n\n\`\`\`\nstderr: ${(vo?.stderr_excerpt ?? "(none)").slice(0, 600)}\nstdout: ${(vo?.stdout_excerpt ?? "(none)").slice(0, 400)}\n\`\`\`\n\n## Post-mortem\n\n${analysis}\n\n## Retry guidance from gateway\n\n${vo?.retry_guidance?.hint ?? "(none)"}\n`,
  );
  appendJsonl(LEARNING_LOG, {
    ts: new Date().toISOString(),
    submissionId: subId,
    challengeId: m.challengeId,
    status: "rejection-analyzed" as const,
    notes: `${failReason}${tests ? ` ${tests}` : ""}`.slice(0, 160),
  });
}

export async function publishPostSolveLearnings(
  runtime: RuntimeLike,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  // Kill-switch (2026-07-15): a corpus audit found 187/203 published learnings
  // on one 4-beat template, the generation prompt's few-shot example leaking
  // verbatim into posts ("EvalPlus" named on unrelated challenges), and
  // fabricated process claims ("4 iterations on verifier feedback" — the
  // pipeline submits once). Paused via BOT_LEARNINGS=0 until the prompt is
  // rewritten and an anti-repeat gate covers this surface.
  if (process.env.BOT_LEARNINGS === "0") return;
  if (opts.dryRun) {
    console.log("🧠 (DRY_RUN — skipping learnings poll)");
    return;
  }

  const mining = readJsonl<MiningEntry>(MINING_LOG);
  const posted = new Set(readJsonl<LearningEntry>(LEARNING_LOG).map((e) => e.submissionId));

  const candidates = mining.filter((m) => m.submissionId && (m.outcome === "pass" || m.outcome === "deferred") && !posted.has(m.submissionId!));
  if (candidates.length === 0) return;

  console.log(`🧠 checking ${candidates.length} mining submissions for verified status`);

  for (const m of candidates.slice(0, 3)) {
    const subId = m.submissionId!;
    try {
      const detail = (await runtime.connection.request(
        "GET",
        `/v1/mining/submissions/${encodeURIComponent(subId)}`,
      )) as {
        status?: string;
        challenge?: { title?: string; description?: string };
        challenge_title?: string;
        challenge_description?: string;
        reasoning?: string;
        verification_outcome?: Record<string, unknown>;
        hiddenTests?: unknown;
      };

      const status = detail.status;
      if (status === "rejected") {
        recordMiningOutcome(m, "rejected");
        // Post-rejection learning — twin of post-solve learning (2026-06-12).
        // Same-cohort peers run ~0 rejections/100 vs our 9; the submission
        // detail carries WHY (deterministic test failures with stderr,
        // fail_reason, and retry_guidance) and we previously never read it.
        // Marks the entry so rejected subs stop clogging this 3-per-tick loop.
        await analyzeRejection(runtime, subId, m, detail);
        continue;
      }
      if (status === "expired") {
        recordMiningOutcome(m, "expired");
        // Never reached quorum — nothing to learn, and previously these
        // re-polled forever, eating the 3-per-tick window (the repeating
        // "⏳ status=expired" log lines). Mark once and move on.
        appendJsonl(LEARNING_LOG, {
          ts: new Date().toISOString(),
          submissionId: subId,
          challengeId: m.challengeId,
          status: "expired" as const,
          notes: "expired before quorum — no learning to post",
        });
        console.log(`   ⌛ ${subId.slice(0, 8)} expired before quorum — marked, will not re-poll`);
        continue;
      }
      if (status !== "verified") {
        console.log(`   ⏳ ${subId.slice(0, 8)} status=${status ?? "unknown"} — wait for quorum`);
        continue;
      }
      recordMiningOutcome(m, "verified");

      const learning = await generateLearning({
        challengeTitle: detail.challenge?.title ?? detail.challenge_title ?? "(unknown)",
        challengeDescription: detail.challenge?.description ?? detail.challenge_description ?? "",
        verifierKind: m.verifierKind,
        reasoning: detail.reasoning ?? "",
        outcome: detail.verification_outcome ?? {},
        hiddenTests: detail.hiddenTests,
      });
      if (learning === "skip") {
        console.log(`   ⤵ ${subId.slice(0, 8)} learning declined — material too thin for a concrete insight`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "skipped", notes: "declined: material too thin" });
        continue;
      }
      if (!learning) {
        console.warn(`   ⚠ ${subId.slice(0, 8)} learning generation failed`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "error", notes: "gen fail" });
        continue;
      }
      // Anti-repeat gates: retelling a recent learning (same story beats, new
      // invented numbers) is the audit's core failure mode on this surface.
      const rep = findRepetitiveLearning(`${learning.summary}\n${learning.content}`, recentLearningTexts());
      if (rep) {
        console.log(`   ⤵ ${subId.slice(0, 8)} learning skipped — ${(rep.similarity * 100).toFixed(0)}% similar to a recent note`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "skipped", notes: `near-dupe of recent learning (${(rep.similarity * 100).toFixed(0)}%)` });
        continue;
      }
      const motif = findLearningMotifCollision(learning.summary, recentLearningSummaries());
      if (motif) {
        console.log(`   ⤵ ${subId.slice(0, 8)} learning skipped — motif cooldown "${motif.bigram}" (retold within ${LEARNING_MOTIF_COOLDOWN_DAYS}d)`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "skipped", notes: `motif cooldown: "${motif.bigram}"` });
        continue;
      }

      // Upload to IPFS via gateway
      const upload = (await runtime.connection.request("POST", "/v1/ipfs/upload", {
        data: { content: learning.content, format: "markdown", uploadedAt: new Date().toISOString() },
        name: `learning-${subId.slice(0, 8)}`,
      })) as { cid?: string };

      if (!upload.cid) {
        console.warn(`   ⚠ ${subId.slice(0, 8)} IPFS upload returned no CID`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "error", notes: "no cid" });
        continue;
      }

      const learnRes = (await runtime.connection.request(
        "POST",
        `/v1/mining/submissions/${encodeURIComponent(subId)}/learning`,
        { learningCid: upload.cid, learningSummary: learning.summary },
      )) as { specificityScore?: number; error?: string };

      if (learnRes.error) {
        console.warn(`   ⚠ ${subId.slice(0, 8)} post error: ${learnRes.error}`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, cid: upload.cid, status: "error", notes: learnRes.error });
        continue;
      }

      const spec = learnRes.specificityScore;
      console.log(`   ✅ posted learning for ${subId.slice(0, 8)} cid=${upload.cid.slice(0, 14)} specificity=${spec ?? "?"}`);

      writeNote(
        "research",
        `learning-${subId.slice(0, 12)}`,
        {
          id: `learning-${subId}`,
          title: `Learning: ${detail.challenge?.title ?? subId.slice(0, 12)}`,
          type: "post-solve-learning",
          tags: ["learning", m.verifierKind],
          submissionId: subId,
          challengeId: m.challengeId,
          cid: upload.cid,
          specificityScore: spec,
        },
        `## Summary\n\n${learning.summary}\n\n## Content\n\n${learning.content}\n`,
      );

      appendJsonl(LEARNING_LOG, {
        ts: new Date().toISOString(),
        submissionId: subId,
        challengeId: m.challengeId,
        cid: upload.cid,
        specificityScore: spec,
        status: "posted" as const,
        summary: learning.summary,
      });
    } catch (err) {
      console.warn(`   ⚠ learning ${subId.slice(0, 8)}: ${(err as Error).message}`);
      appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "error", notes: (err as Error).message.slice(0, 200) });
    }
  }
}
