import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { pickModel } from "./models.js";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const PRED_LOG = join(NOOK_DIR, "predictions.jsonl");

const DAILY_CAP = 3;
const MIN_CONFIDENCE = 0.6;

interface Challenge {
  id: string;
  title?: string;
  description?: string;
  verifierKind?: string;
  submissionArtifactType?: string;
  status?: string;
  submissionCount?: number;
  maxSubmissions?: number;
  estimatedRewardNook?: number;
  closesAt?: string;
  scoringConfig?: { type?: string; categories?: string[] };
}

interface PredLogEntry {
  ts: string;
  challengeId: string;
  submissionId?: string;
  payload: unknown;
  confidence: number;
  outcome: "submitted" | "skipped" | "error";
  notes?: string;
}

function loadCaches(): { attempted: Set<string>; todayCount: number } {
  const entries = readJsonl<PredLogEntry>(PRED_LOG);
  const attempted = new Set(entries.map((e) => e.challengeId));
  const since = Date.now() - 24 * 3600_000;
  const todayCount = entries.filter((e) => new Date(e.ts).getTime() >= since && e.outcome === "submitted").length;
  return { attempted, todayCount };
}

interface CalibratedPrediction {
  shape: "distribution" | "point_estimate";
  distribution?: Record<string, number>;
  point_estimate?: number;
  confidence: number;
  rationale: string;
}

async function generatePrediction(
  ch: Challenge,
  scoringType: string,
  categories?: string[],
): Promise<CalibratedPrediction | null> {
  const expectsDistribution = scoringType === "log_loss" || scoringType === "brier" || (categories && categories.length > 0);
  const shape = expectsDistribution ? "distribution" : "point_estimate";

  const sys = `You are a calibrated forecaster. Read the prediction challenge and either (a) submit a well-calibrated answer with a clear "confidence" 0-1 about your epistemic position, or (b) refuse with "confidence": 0 if the question is outside your reliable knowledge.

Calibration rules:
- Categorical (log_loss / brier): output {"shape":"distribution","distribution":{"cat_a":0.6,"cat_b":0.4},"confidence":<0-1>,"rationale":"<≤300 chars>"}. Probabilities sum to 1.0. Never use 0 or 1 (use 0.02 / 0.98 minimums).
- Numeric (point_estimate): output {"shape":"point_estimate","point_estimate":<number>,"confidence":<0-1>,"rationale":"..."}.

If you don't have a defensible inside view, set confidence to 0 — we'll skip the submission. Honest 0 beats noisy guesses.

Output JSON only.`;

  const userMsg = `Challenge: ${ch.title ?? ""}\nDescription:\n${ch.description ?? ""}\n\nScoring type: ${scoringType}${categories?.length ? `\nCategories: ${JSON.stringify(categories)}` : ""}\nResolves at: ${ch.closesAt ?? "unknown"}`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ], { max_tokens: 600, temperature: 0.2, model: pickModel("mining_solve") });

  const cleaned = res.content.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const p = JSON.parse(cleaned.slice(first, last + 1)) as Partial<CalibratedPrediction> & { distribution?: Record<string, number> };
    if (!p.shape || typeof p.confidence !== "number") return null;
    if (p.shape !== shape) return null; // shape mismatch
    if (p.shape === "distribution") {
      if (!p.distribution) return null;
      const sum = Object.values(p.distribution).reduce((s, v) => s + Number(v), 0);
      if (!Number.isFinite(sum) || sum <= 0) return null;
      const normalized: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.distribution)) normalized[k] = Math.max(0.02, Math.min(0.98, Number(v) / sum));
      // re-normalize after clamping
      const s2 = Object.values(normalized).reduce((s, v) => s + v, 0);
      for (const k of Object.keys(normalized)) normalized[k] = normalized[k] / s2;
      return { shape: "distribution", distribution: normalized, confidence: p.confidence, rationale: p.rationale ?? "" };
    }
    if (typeof p.point_estimate !== "number") return null;
    return { shape: "point_estimate", point_estimate: p.point_estimate, confidence: p.confidence, rationale: p.rationale ?? "" };
  } catch {
    return null;
  }
}

export async function submitPredictions(
  runtime: RuntimeLike,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  if (opts.dryRun) {
    console.log("🔮 (DRY_RUN — skipping predictions)");
    return;
  }
  const { attempted, todayCount } = loadCaches();
  if (todayCount >= DAILY_CAP) return;

  let challenges: Challenge[] = [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/challenges?status=open&verifierKind=prediction&limit=10",
    )) as { challenges?: Challenge[] };
    challenges = res.challenges ?? [];
  } catch (err) {
    console.warn(`   ⚠ prediction list: ${(err as Error).message}`);
    return;
  }

  const eligible = challenges.filter((c) => c.verifierKind === "prediction" && !attempted.has(c.id));
  if (eligible.length === 0) return;

  console.log(`🔮 ${eligible.length} prediction challenges`);
  for (const ch of eligible.slice(0, DAILY_CAP - todayCount)) {
    try {
      const detail = (await runtime.connection.request("GET", `/v1/mining/challenges/${encodeURIComponent(ch.id)}`)) as Challenge;
      const scoringType = detail.scoringConfig?.type ?? "log_loss";
      const categories = detail.scoringConfig?.categories;
      const pred = await generatePrediction(detail, scoringType, categories);
      if (!pred || pred.confidence < MIN_CONFIDENCE) {
        const reason = !pred ? "gen-fail" : `low-confidence (${pred?.confidence})`;
        console.log(`   skip ${ch.id.slice(0, 8)}: ${reason}`);
        appendJsonl(PRED_LOG, { ts: new Date().toISOString(), challengeId: ch.id, payload: pred ?? null, confidence: pred?.confidence ?? 0, outcome: "skipped" as const, notes: reason });
        continue;
      }

      const artifact: Record<string, unknown> =
        pred.shape === "distribution" ? { distribution: pred.distribution } : { point_estimate: pred.point_estimate };

      const sub = (await runtime.connection.request("POST", `/v1/mining/challenges/${encodeURIComponent(ch.id)}/submit-solution`, {
        artifactType: "prediction_payload",
        artifact,
        reasoning: pred.rationale,
        modelUsed: pickModel("mining_solve"),
      })) as { id?: string; error?: string };

      if (sub.error) {
        console.warn(`   ⚠ prediction submit ${ch.id.slice(0, 8)}: ${sub.error}`);
        appendJsonl(PRED_LOG, { ts: new Date().toISOString(), challengeId: ch.id, payload: artifact, confidence: pred.confidence, outcome: "error" as const, notes: sub.error });
        continue;
      }

      console.log(`   ✅ prediction ${ch.id.slice(0, 8)} → ${sub.id?.slice(0, 8)} (conf=${pred.confidence})`);
      appendJsonl(PRED_LOG, {
        ts: new Date().toISOString(),
        challengeId: ch.id,
        submissionId: sub.id,
        payload: artifact,
        confidence: pred.confidence,
        outcome: "submitted" as const,
      });
      await new Promise((r) => setTimeout(r, 30_000));
    } catch (err) {
      console.warn(`   ⚠ prediction ${ch.id.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
}
