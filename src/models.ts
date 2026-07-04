/**
 * Central model routing.
 *
 * Each task gets the model best suited for its value/volume tradeoff.
 * Override at runtime by setting MODEL_<TASK> env vars (uppercased).
 *
 * Venice catalog confirmed live (probed 2026-05-22):
 *   grok-4-3, grok-4-20, claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6,
 *   openai-gpt-55, openai-gpt-55-pro, kimi-k2-6, deepseek-v4-pro
 */

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
  // Mining A/B (4-way as of 2026-06-15):
  //   claude-opus-4-8        — Opus arm; replaced claude-fable-5 (Venice 500s,
  //     functionally gone 2026-06-15) and the superseded claude-opus-4-7.
  //     reasoning_effort=high (see MODEL_EFFORT).
  //   openai-gpt-55          — struggling @ 8% (re-eval after spec-gate + xhigh→high)
  //   grok-4-3               — proven on bounty drafts; 1M ctx + xSearch
  //   gemini-3-1-pro-preview — Google flagship, 1M ctx, multimodal + reasoning effort
  //   deepseek-v4-pro        — SIDELINED 2026-06-11: 40% submit rate (2/5,
  //     worst in pool) while gemini/gpt-55 ran 100%. Epoch slots are the
  //     scarce resource (12/day, failures burn slots) — a low-submit-rate
  //     model in rotation is direct NOOK loss. The verifiable-kind override
  //     now also respects the parse-fail circuit-breaker (mining.ts), so it
  //     won't route there while deepseek is failing; re-add here if it recovers.
  // At 13/day cap that's ~3.2 attempts per model per day; mining-stats has
  // power to recommend pruning at gap ≥20pp once total n ≥ 5 per arm.
  mining_solve: [
    "claude-opus-4-8",
    "openai-gpt-55",
    "grok-4-3",
    "gemini-3-1-pro-preview",
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
  "openai-gpt-55": "high",
  // Probed live 2026-05-24: both accept xhigh and return non-empty.
  "gemini-3-1-pro-preview": "xhigh",
  "deepseek-v4-pro": "xhigh",
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function effortFor(model: string): ReasoningEffort | undefined {
  return MODEL_EFFORT[model];
}

export function pickModel(task: Task): string {
  const envKey = `MODEL_${task.toUpperCase()}`;
  return process.env[envKey] ?? DEFAULTS[task];
}

export interface ModelPick {
  model: string;
  pool: string | "default";
  reasoning_effort?: ReasoningEffort;
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
  // Apply circuit-breaker if caller supplied failure-rate data
  const effectivePool = failureRates
    ? filterPoolByParseFailure(pool, failureRates).filtered
    : pool;
  const model = effectivePool[Math.floor(Math.random() * effectivePool.length)];
  return { model, pool: "ab", reasoning_effort: effortFor(model) };
}
