/**
 * Central model routing.
 *
 * Each task gets the model best suited for its value/volume tradeoff.
 * Override at runtime by setting MODEL_<TASK> env vars (uppercased).
 *
 * Venice catalog confirmed live (re-probed 2026-07-28, 106 models):
 *   grok-4-3, grok-4-5, grok-4-20, claude-opus-4-8, claude-opus-5,
 *   claude-fable-5, claude-sonnet-5, kimi-k2-5/k2-6/k2-7-code/k3,
 *   openai-gpt-55, openai-gpt-56-sol, gemini-3-1-pro-preview,
 *   deepseek-v4-pro. All four mining arms below probed 200 + non-empty with a
 *   solve-shaped JSON request on 2026-07-28.
 */

import { isLean } from "./lean.js";

export type Task =
  | "bounty_draft"          // bounty application — medium value, low volume
  | "bounty_work"           // approved-bounty deliverables — high value
  | "bounty_critique"       // refiner critique pass
  | "bounty_revise"         // refiner revise pass
  | "mining_solve"          // mining challenge solutions — high value, low volume
  | "mining_learning"       // post-solve learning prose — low value, high specificity
  | "verification_score"    // 4-dim trace scoring — low value, high volume
  | "verification_comprehension" // answer comprehension questions
  | "crowd_jury_score"      // 0-100 static-text grading
  | "knowledge_topic"       // pick a knowledge-graph topic
  | "knowledge_body"        // 1200-word knowledge essay
  | "research_extract"      // distill web search results
  | "action_suggest"        // fast action picker
  | "fit_evaluate";         // bounty fit gate

// 2026-06-15: reverted the high-VALUE default off claude-fable-5 → claude-opus-4-8.
// Venice still lists claude-fable-5 but every inference 500s ("Inference
// processing failed") as of 2026-06-15 — it is functionally gone. claude-opus-4-8
// is live on Venice (probed 200 OK), 1M ctx / 128k completion, $5/$25 per M.
// High-VOLUME tasks (verification, comprehension, prose) stay on grok-4-3
// ($1.42/$2.83 — far cheaper on output). NOTE: verification_score deliberately
// stays on grok-4-3 — the calibration prompt was validated on grok on 06-11 and
// switching the scorer would confound the score-window data.
const DEFAULTS: Record<Task, string> = {
  bounty_draft: "claude-opus-4-8",
  bounty_work: "claude-opus-4-8",
  bounty_critique: "claude-opus-4-8",
  bounty_revise: "claude-opus-4-8",
  mining_solve: "claude-opus-4-8",
  mining_learning: "grok-4-3",
  verification_score: "grok-4-3",
  verification_comprehension: "grok-4-3",
  crowd_jury_score: "grok-4-3",
  knowledge_topic: "grok-4-3",
  knowledge_body: "grok-4-3",
  research_extract: "grok-4-3",
  action_suggest: "grok-4-3",
  fit_evaluate: "grok-4-3",
};

const A_B_POOL: Record<Task, string[] | undefined> = {
  // 4-way A/B cycle: grok-4-3 (cheap baseline), claude-opus-4-8 (strong
  // reasoning), openai-gpt-55 (strong instruction following — uses xhigh
  // thinking, see XHIGH_THINKING_MODELS below).
  // gpt-55-pro is excluded — significantly more expensive per call without
  // a confirmed quality delta worth the cost on bounty drafts.
  bounty_draft: ["grok-4-3", "claude-opus-4-8", "openai-gpt-55"],
  bounty_work: undefined,
  bounty_critique: undefined,
  bounty_revise: undefined,
  // Mining A/B (4-way, operator-directed refresh 2026-07-09): the prior pool
  // had collapsed to 2 live arms — gpt-55, gemini-3-1, and deepseek-v4 all
  // parse-failed and were circuit-broken, leaving only grok-4-3 + opus-4-8. This
  // rotation swaps in four newer models, all re-probed 200 + non-empty:
  //   grok-4-5          — xAI's newer grok; 500k ctx (down from 4-3's 1M), pricier
  //     on output ($2.27/$6.80). reasoning_effort=xhigh.
  //   claude-opus-5     — Claude 5 Opus, 1M ctx, code-optimized. Replaced
  //     claude-fable-5 on 2026-07-28 (operator); effort=high.
  //   kimi-k3           — Moonshot Kimi K3, 1M ctx, code-optimized. Added as the
  //     4th arm 2026-07-28 (operator); effort=high.
  //   openai-gpt-56-sol — GPT-5.6 "Sol", 1M ctx, $6.25/$37.5. effort=high (OpenAI
  //     reasoning models empty-trace at xhigh — see MODEL_EFFORT note).
  // The parse-fail circuit-breaker (filterPoolByParseFailure) sidelines any arm
  // that fails ≥30% over ≥5 attempts, and DEFAULTS.mining_solve (opus-4-8) is the
  // safe fallback if all four get filtered. At 12/day that's ~3 attempts/arm/day;
  // mining-stats recommends pruning at gap ≥20pp once n ≥ 5 per arm.
  // GLM removed 2026-07-28 after 52 attempts / 0 accepted submissions / $12.31
  // burned across 13 days: the gateway's modelUsed validator rejects every
  // dash-mangled form of its id (both "zai-org-glm-5-2" and the stripped
  // "glm-5-2" 400 with "doesn't look like a real model name" AFTER we pay for
  // the solve). The parse-fail circuit breaker could not see it — GLM was
  // 146/148 "ok" at GENERATION time, so the breaker rated it our healthiest
  // arm while 100% of its submissions died at the wire. Do not re-add without
  // a single canary submission using a dotted id ("glm-5.2", fallback
  // "zai-org/GLM-5.2"); both are unverified guesses and each test costs a
  // paid solve.
  // Roster set 2026-07-28 (operator): claude-opus-5 replaces claude-fable-5,
  // kimi-k3 joins as the 4th arm. All four ids verified against the LIVE Venice
  // catalog (GET /v1/models, 106 models) and probed with a solve-shaped request
  // at both high and xhigh — every one returned parseable JSON with a working
  // solution and a summary that clears our specificity gate. None carries an
  // org prefix, which is the shape the gateway's modelUsed validator rejects
  // (see the GLM note above); every plain-id model we have ever submitted has
  // been accepted (grok-4-5 59/59, claude-opus-4-8 39/39, gpt-56-sol 32/32,
  // claude-fable-5 8/8). If a new arm is nonetheless rejected at the wire, the
  // submit-reject breaker now sidelines it automatically.
  // BETA WATCH: kimi-k3 and openai-gpt-56-sol are flagged betaModel=true in the
  // catalog — Venice may withdraw a beta model without the standard deprecation
  // notice. A withdrawn arm 404s at generation, which is NOT matched by
  // isTransientGenerationError, so the attempt is lost rather than rerouted.
  // Re-probe these two first whenever the catalog is re-checked.
  mining_solve: [
    "grok-4-5",
    "claude-opus-5",
    "openai-gpt-56-sol",
    "kimi-k3",
  ],
  mining_learning: undefined,
  verification_score: undefined,
  verification_comprehension: undefined,
  crowd_jury_score: undefined,
  knowledge_topic: undefined,
  knowledge_body: undefined,
  research_extract: undefined,
  action_suggest: undefined,
  fit_evaluate: undefined,
};

/**
 * Per-model reasoning effort.
 * Venice accepts `xhigh` on all three high-thinking models, but in practice
 * openai-gpt-55 at xhigh consumes so much internal-reasoning budget that
 * mining traces come back empty (observed ~50% rate on standard traces with
 * max_tokens=10000). Dropping it one notch to `high` recovers usable output
 * with negligible quality cost.
 */
const MODEL_EFFORT: Record<string, ReasoningEffort> = {
  // claude-opus-4-8 runs at "high" per operator request (2026-06-15) — Opus 4.8's
  // adaptive thinking is always on; reasoning_effort=high controls depth (Venice
  // accepts none|minimal|low|medium|high|xhigh|max). Bump to "xhigh" for deeper.
  "claude-opus-4-8": "high",
  "claude-fable-5": "xhigh",
  "claude-opus-4-7": "xhigh",
  "grok-4-3": "xhigh",
  // grok-4-5 accepts ONLY low|medium|high per the live catalog
  // (reasoningEffortOptions) — it was set to "xhigh" from 2026-07-09 until
  // 2026-07-28, an unsupported value Venice appears to have silently ignored.
  "grok-4-5": "high",
  "openai-gpt-55": "high",
  // OpenAI reasoning models empty-trace at xhigh (observed on gpt-55) — keep
  // gpt-56-sol at high. GLM-5.2 at high pending its own calibration.
  "openai-gpt-56-sol": "high",
  // claude-opus-5 and kimi-k3 are deliberately ABSENT: the live catalog reports
  // supportsReasoningEffort=false / no reasoningEffortOptions for both, so any
  // value here would be an ignored parameter. Both still reason (
  // supportsReasoning=true) — they just don't expose a depth dial. Probing them
  // at high vs xhigh on 2026-07-28 produced different-length output, but since
  // the requests were served identically that was sampling noise, not a
  // calibration signal. effortFor() returning undefined omits the field.
  // Probed live 2026-05-24: both accept xhigh and return non-empty.
  "gemini-3-1-pro-preview": "xhigh",
  "deepseek-v4-pro": "xhigh",
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function effortFor(model: string): ReasoningEffort | undefined {
  return MODEL_EFFORT[model];
}

// Lean mode's cheapest capable model, overridable via BOT_LEAN_MODEL. Read live
// (like isLean) so a value set after this module loads is still honored.
function leanModel(): string {
  return process.env.BOT_LEAN_MODEL || "grok-4-3";
}

export function pickModel(task: Task): string {
  const envKey = `MODEL_${task.toUpperCase()}`;
  const override = process.env[envKey];
  if (override) return override;
  // Lean profit mode (BOT_LEAN=1): force the cheapest model on any residual
  // inference — in lean the only recurring LLM call is the daily challenge
  // draft. An explicit MODEL_<TASK> above still wins.
  if (isLean()) return leanModel();
  return DEFAULTS[task];
}

export interface ModelPick {
  model: string;
  pool: string | "default";
  reasoning_effort?: ReasoningEffort;
}

/**
 * The task's A/B pool (empty when the task has none). Exposed so callers can
 * scope reporting to models actually in rotation — the failure-rate history
 * covers RETIRED models too, and logging those as "sidelined" every tick is
 * noise (they're never picked, so sidelining them is a no-op).
 */
export function abPool(task: Task): readonly string[] {
  return A_B_POOL[task] ?? [];
}

/**
 * Cost-circuit-breaker (#16): if a model's recent mining parse-failure rate
 * exceeds this threshold, exclude it from the A/B pool for the next 24h.
 * This prevents repeated 3-5 cr burns on a model that's reliably producing
 * unparseable output.
 *
 * Pure function — receives the parse-failure rate map from the caller.
 * Returns the filtered pool (or the unfiltered pool if filtering would
 * leave us with zero models, in which case we let the bad model run
 * rather than abandoning mining entirely).
 */
export const PARSE_FAIL_RATE_THRESHOLD = Number(process.env.BOT_MODEL_PARSE_FAIL_THRESHOLD ?? 0.30);
export const PARSE_FAIL_MIN_ATTEMPTS = Number(process.env.BOT_MODEL_PARSE_FAIL_MIN_ATTEMPTS ?? 5);

export function filterPoolByParseFailure(
  pool: string[],
  failureRates: Record<string, { attempts: number; failures: number; rate: number }>,
): { filtered: string[]; sidelined: string[] } {
  const sidelined: string[] = [];
  const filtered = pool.filter((m) => {
    const r = failureRates[m];
    if (!r) return true;
    if (r.attempts < PARSE_FAIL_MIN_ATTEMPTS) return true;
    if (r.rate >= PARSE_FAIL_RATE_THRESHOLD) {
      sidelined.push(m);
      return false;
    }
    return true;
  });
  // Fail-safe: if filtering left zero options, fall back to the unfiltered
  // pool. Better to burn some credits than to halt mining entirely.
  if (filtered.length === 0) return { filtered: pool, sidelined: [] };
  return { filtered, sidelined };
}

/**
 * Pick a different model from the task's A/B pool for transient-error
 * failover (Venice 429/500, fetch failures). Excludes the model that just
 * failed; returns null when the pool has no alternative (caller gives up
 * for this attempt rather than retrying the same overloaded model).
 */
export function pickAlternateModel(task: Task, exclude: string): ModelPick | null {
  const pool = (A_B_POOL[task] ?? []).filter((m) => m !== exclude);
  if (pool.length === 0) return null;
  const model = pool[Math.floor(Math.random() * pool.length)];
  return { model, pool: "ab", reasoning_effort: effortFor(model) };
}

export function pickModelAB(
  task: Task,
  failureRates?: Record<string, { attempts: number; failures: number; rate: number }>,
): ModelPick {
  const pool = A_B_POOL[task];
  if (!pool || pool.length === 0) {
    const model = pickModel(task);
    return { model, pool: "default", reasoning_effort: effortFor(model) };
  }
  if (process.env[`MODEL_${task.toUpperCase()}`]) {
    const model = process.env[`MODEL_${task.toUpperCase()}`]!;
    return { model, pool: "override", reasoning_effort: effortFor(model) };
  }
  // Lean profit mode: force the cheapest model instead of sampling the A/B pool
  // (an explicit MODEL_<TASK> above still wins). Keeps the "any residual
  // inference uses the cheapest model" guarantee on A/B-routed tasks too.
  if (isLean()) {
    const model = leanModel();
    return { model, pool: "lean", reasoning_effort: effortFor(model) };
  }
  // Apply circuit-breaker if caller supplied failure-rate data
  const effectivePool = failureRates
    ? filterPoolByParseFailure(pool, failureRates).filtered
    : pool;
  const model = effectivePool[Math.floor(Math.random() * effectivePool.length)];
  return { model, pool: "ab", reasoning_effort: effortFor(model) };
}
