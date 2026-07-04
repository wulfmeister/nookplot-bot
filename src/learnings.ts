import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { writeNote } from "./vault.js";
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
}

async function generateLearning(args: {
  challengeTitle: string;
  challengeDescription: string;
  verifierKind: string;
  reasoning: string;
  outcome: Record<string, unknown>;
  hiddenTests?: unknown;
}): Promise<{ content: string; summary: string } | null> {
  const sys = `You write a post-solve learning for the Nookplot mining network. Be SPECIFIC: concrete numbers, named techniques, edge cases you handled, things that surprised you when the verifier ran. Generic prose scores low — specifics rank higher in challenge_related_learnings.

Length: 400-900 chars of markdown content; 80-200 char summary.
Output JSON only:
{"content": "<markdown body>", "summary": "<one-paragraph specific summary>"}

Good example: "For nth-decagonal-number (n*(4n-3)), the obvious recurrence d(n) = d(n-1) + (8n-7) is 2x slower than the closed form on n>10000. The EvalPlus harness adds large-n edge cases the vanilla MBPP misses; tested up to n=1e7."

Bad example: "I used Python and followed best practices. Edge cases are important."`;

  const userMsg = `Challenge: ${args.challengeTitle}\nVerifier kind: ${args.verifierKind}\n\nDescription:\n${args.challengeDescription.slice(0, 1500)}\n\nMy reasoning at submit time:\n${args.reasoning}\n\nVerifier outcome:\n${JSON.stringify(args.outcome).slice(0, 1500)}${args.hiddenTests ? `\n\nNow-revealed hidden tests:\n${JSON.stringify(args.hiddenTests).slice(0, 1500)}` : ""}`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ], { max_tokens: 700, temperature: 0.4, model: pickModel("mining_learning") });

  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1)) as { content?: string; summary?: string };
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
      if (!learning) {
        console.warn(`   ⚠ ${subId.slice(0, 8)} learning generation failed`);
        appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "error", notes: "gen fail" });
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
      });
    } catch (err) {
      console.warn(`   ⚠ learning ${subId.slice(0, 8)}: ${(err as Error).message}`);
      appendJsonl(LEARNING_LOG, { ts: new Date().toISOString(), submissionId: subId, challengeId: m.challengeId, status: "error", notes: (err as Error).message.slice(0, 200) });
    }
  }
}
