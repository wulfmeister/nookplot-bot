import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { writeNote } from "./vault.js";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";
import { canVerifyNow, recordCrowdScore, recordVerifyLimitHit, isVerifyCapError } from "./quotas.js";
import { recordAudit } from "./audit.js";
import {
  finalizedSubmissionSkip,
  FINALIZED_TTL_MS,
  isFinalizedError,
} from "./skip-caches.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const CROWD_LOG = join(NOOK_DIR, "crowd-jury.jsonl");

// Default 10 — only bump (via env) if logs show crowd-jury actually saturating
// the daily cap. The bump from 10 → 15 on 06-08 was speculative; pool was
// empty so the cap was never reached. Env knob preserved for the day pool fills.
const DAILY_CAP = Number(process.env.BOT_CROWD_JURY_DAILY_CAP ?? 10);

interface VerifiableSubmission {
  id: string;
  challenge_id?: string;
  verifier_kind?: string;
  artifact_cid?: string;
  trace_summary?: string;
  domain_tags?: string[];
  difficulty?: string;
  solver_address?: string;
}

interface ArtifactPayload {
  artifactType?: string;
  artifact?: { text?: string };
  judgeContext?: {
    task_prompt?: string;
    rubric?: string;
    aggregation?: string;
    min_judges?: number;
    max_artifact_chars?: number;
  };
}

interface CrowdLogEntry {
  ts: string;
  submissionId: string;
  score: number;
  outcome: "scored" | "error" | "skipped";
  notes?: string;
}

function loadSeen(): { seen: Set<string>; todayCount: number } {
  const entries = readJsonl<CrowdLogEntry>(CROWD_LOG);
  const seen = new Set(entries.map((e) => e.submissionId));
  const since = Date.now() - 24 * 3600_000;
  const todayCount = entries.filter((e) => new Date(e.ts).getTime() >= since && e.outcome === "scored").length;
  return { seen, todayCount };
}

async function gradeArtifact(
  text: string,
  taskPrompt: string,
  rubric: string,
): Promise<{ score: number; rationale: string } | null> {
  const sys = `You are a precise judge. Score the candidate text on a 0-100 integer scale against the task prompt and rubric.

Calibration:
- 90-100: exceptional, meets all rubric criteria with concrete specifics
- 70-89:  strong, meets most criteria, minor gaps
- 50-69:  passable, hits the topic but generic
- 30-49:  weak — vague, missing key rubric elements
- 0-29:   off-topic, wrong format, or nonsense

Avoid uniform-high scores; rubber-stamp detection penalizes that. Output JSON only:
{"score": <integer 0-100>, "rationale": "<≤400 chars referencing specific rubric criteria>"}`;

  const userMsg = `Task prompt:\n${taskPrompt}\n\nRubric:\n${rubric}\n\nCandidate text:\n${text}`;
  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ], { max_tokens: 400, temperature: 0.2, model: pickModel("crowd_jury_score") });

  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1)) as { score?: number; rationale?: string };
    const n = Number(parsed.score);
    if (!Number.isFinite(n)) return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(n))),
      rationale: String(parsed.rationale ?? "").slice(0, 400),
    };
  } catch {
    return null;
  }
}

export async function scoreCrowdJurySubmissions(
  runtime: RuntimeLike,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  if (opts.dryRun) {
    console.log("🎭 (DRY_RUN — skipping crowd-jury poll)");
    return;
  }
  const { seen, todayCount } = loadSeen();
  if (todayCount >= DAILY_CAP) {
    console.log(`🎭 crowd-jury daily cap hit (${todayCount}/${DAILY_CAP})`);
    return;
  }

  let candidates: VerifiableSubmission[] = [];
  try {
    // Widened from 20 → 200 (matches main verification poll). Crowd-jury
    // subs are rarer than standard ones, so we need to scan the whole queue
    // to find any. With diversity filter ranking by other criteria,
    // crowd-jury subs may not surface in the top-20.
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/submissions/verifiable?limit=200",
    )) as { submissions?: VerifiableSubmission[] };
    candidates = (res.submissions ?? []).filter(
      (s) => s.verifier_kind === "crowd_jury" && !seen.has(s.id),
    );
    // Sort by closest-to-quorum (5 needed for crowd_jury) for max network leverage.
    candidates.sort((a, b) => {
      const ac = Number((a as unknown as { crowd_score_count?: number | string }).crowd_score_count ?? 0);
      const bc = Number((b as unknown as { crowd_score_count?: number | string }).crowd_score_count ?? 0);
      return bc - ac;
    });
  } catch (err) {
    console.warn(`   ⚠ crowd-jury list fetch failed: ${(err as Error).message}`);
    return;
  }

  if (candidates.length === 0) {
    console.log("🎭 no new crowd-jury submissions");
    return;
  }

  console.log(`🎭 ${candidates.length} crowd-jury candidates`);

  for (const sub of candidates.slice(0, Math.min(3, DAILY_CAP - todayCount))) {
    const idShort = sub.id.slice(0, 8);
    if (finalizedSubmissionSkip.isSkipped(sub.id)) continue;
    // Honor the shared gateway cap (verifies + crowd-jury combined).
    if (!canVerifyNow()) {
      console.log(`🎭 shared verify cap hit — halting crowd-jury for the day`);
      break;
    }
    try {
      // 1. Comprehension challenge
      const cRes = (await runtime.connection.request(
        "POST",
        `/v1/mining/submissions/${sub.id}/comprehension`,
        {},
      )) as { questions?: Array<{ id: string; question: string }> };
      const questions = cRes.questions ?? [];
      if (questions.length > 0) {
        const answers: Record<string, string> = {};
        const trace = (sub.trace_summary ?? "").slice(0, 4000);
        for (const q of questions) {
          answers[q.id] = `Based on the submission, ${trace.slice(0, 180)}`;
        }
        await runtime.connection.request("POST", `/v1/mining/submissions/${sub.id}/comprehension/answers`, { answers });
      }

      // 2. Inspect the artifact (required gate)
      const artifact = (await runtime.connection.request(
        "GET",
        `/v1/mining/submissions/${sub.id}/artifact`,
      )) as ArtifactPayload;
      const text = artifact.artifact?.text ?? "";
      const taskPrompt = artifact.judgeContext?.task_prompt ?? "";
      const rubric = artifact.judgeContext?.rubric ?? "";

      if (!text || !taskPrompt) {
        console.log(`   ⚠ ${idShort} missing text/task — skip`);
        appendJsonl(CROWD_LOG, { ts: new Date().toISOString(), submissionId: sub.id, score: 0, outcome: "skipped", notes: "no text or task_prompt" });
        continue;
      }

      // 3. Grade
      const graded = await gradeArtifact(text, taskPrompt, rubric);
      if (!graded) {
        console.log(`   ⚠ ${idShort} grader failed to parse`);
        appendJsonl(CROWD_LOG, { ts: new Date().toISOString(), submissionId: sub.id, score: 0, outcome: "error", notes: "parse fail" });
        continue;
      }

      // 4. Submit score
      await runtime.connection.request(
        "POST",
        `/v1/mining/submissions/${sub.id}/crowd-score`,
        { score: graded.score, rationale: graded.rationale },
      );
      recordCrowdScore();
      recordAudit("crowd_jury", "submitted", `score=${graded.score}`, {
        submissionId: sub.id,
        score: graded.score,
      });

      console.log(`   ✅ ${idShort} scored ${graded.score}/100`);
      writeNote(
        "research",
        `crowd-jury-${sub.id.slice(0, 12)}`,
        {
          id: `crowd-jury-${sub.id}`,
          title: `Crowd-jury grading of ${sub.id.slice(0, 12)}`,
          type: "crowd-jury-grading",
          tags: ["crowd-jury", ...(sub.domain_tags ?? [])],
          submissionId: sub.id,
          challengeId: sub.challenge_id,
          score: graded.score,
        },
        `## Task\n\n${taskPrompt}\n\n## Rubric\n\n${rubric}\n\n## Artifact text\n\n${text}\n\n## Our score: ${graded.score}/100\n\n${graded.rationale}\n`,
      );
      appendJsonl(CROWD_LOG, {
        ts: new Date().toISOString(),
        submissionId: sub.id,
        score: graded.score,
        outcome: "scored" as const,
      });

      await new Promise((r) => setTimeout(r, 70 * 1000)); // respect 60s cooldown
    } catch (err) {
      const msg = (err as Error).message;
      // Shared-cap 429 — mark the limit hit and halt the rest of the loop.
      if (isVerifyCapError(msg)) {
        recordVerifyLimitHit();
        console.warn(`   ⚠ ${idShort} crowd-jury hit shared verify cap — halting until UTC midnight`);
        break;
      }
      // 410 finalized — same skip cache as the verify path uses, prevents
      // the discover endpoint from re-surfacing a finalized id each tick.
      if (isFinalizedError(msg)) {
        finalizedSubmissionSkip.markFor(sub.id, FINALIZED_TTL_MS);
        console.warn(`   ⚠ ${idShort} crowd-jury already finalized — skip 24h`);
        appendJsonl(CROWD_LOG, { ts: new Date().toISOString(), submissionId: sub.id, score: 0, outcome: "skipped" as const, notes: "finalized" });
        continue;
      }
      console.warn(`   ⚠ ${idShort}: ${msg.slice(0, 200)}`);
      appendJsonl(CROWD_LOG, { ts: new Date().toISOString(), submissionId: sub.id, score: 0, outcome: "error", notes: msg.slice(0, 200) });
    }
  }
}
