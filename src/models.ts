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
// High-VOLUME prose tasks stay on grok-4-3 ($1.42/$2.83 — far cheaper on
// output). Verification moved OFF grok-4-3 to grok-4-5 on 2026-07-30 at the
// operator's direction; see the note on those rows below.
const DEFAULTS: Record<Task, string> = {
  bounty_draft: "claude-opus-4-8",
  bounty_work: "claude-opus-4-8",
  bounty_critique: "claude-opus-4-8",
  bounty_revise: "claude-opus-4-8",
  // mining_solve default → claude-opus-5 (operator, 2026-09-02): opus-4-8
  // failed the gateway's traceSummary specificity gate on 12/16 mining
  // attempts since 08-28 (chronic near-misses, 30-34 vs threshold 35);
  // opus-5 failed 2/8 in the same window. Same price ($6/$30), same 1M ctx.
  mining_solve: "claude-opus-5",
  mining_learning: "grok-4-3",
  // Verification moved to grok-4-5 on 2026-07-30 (operator). NOTE: this is
  // NOT a cost saving — grok-4-5 lists $2.27/$6.80 per M vs grok-4-3's
  // $1.42/$2.83, so it roughly doubles verification inference; the operator
  // accepted that explicitly for verification quality. Caveat carried over
  // from 06-11: the scoring prompt was calibrated on grok-4-3, so score
  // distributions may shift — same family keeps the drift small, but watch
  // verification-stats.jsonl for a step change in mean scores.
  // grok-4-5 → grok-4-6 on 2026-08-13 (operator): same price, same 500k ctx,
  // NOT beta, and it restores the xhigh effort tier 4-5 dropped.
  verification_score: "grok-4-6",
  verification_comprehension: "grok-4-6",
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
  //   gemini-3-1-pro-preview — Google's top model on Venice, 1M ctx, $2.50/$15.
  //     4th arm 2026-08-05, replacing kimi-k3 (see below); effort=high.
  //   openai-gpt-56-sol — GPT-5.6 "Sol", 1M ctx, $6.25/$37.50. Back in the
  //     roster 2026-09-02 (operator), replacing gpt-56-luna: Venice's
  //     INFERENCE path started rejecting luna's reasoning_effort=max on
  //     09-01 (3 identical 400s, "does not support 'max' with this model")
  //     even though the catalog still lists max in reasoningEffortOptions —
  //     catalog-verified is NOT live-verified. Sol's 08-13 removal (worst
  //     settled verified-rate, 40% at n≥15) happened at effort=high; the
  //     operator is retrying it at xhigh. Live-probed 09-02: 200 OK, 11k
  //     chars of solve-shaped JSON in 132s at xhigh.
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
  // Roster set 2026-08-05 (operator): kimi-k3 REMOVED — the gateway's modelUsed
  // validator rejected both wire names we were willing to try ("kimi-k3" 3x
  // 07-29/30, "moonshotai/Kimi-K3" 1x 07-30), 0 acceptances ever, $2.24 burned.
  // Note the org/Model hypothesis (see GATEWAY_MODEL_NAME_OVERRIDES in
  // mining.ts) is now DISPROVEN — the validator refused the HF-style form too.
  // gemini-3-1-pro-preview joins as the 4th arm (operator wants SOTA frontier
  // from 4 distinct providers): verified in the LIVE catalog 2026-08-05
  // (GET /v1/models, 108 models — $2.50/$15, 1M ctx, NOT beta), and its wire
  // name is the only candidate with zero rejection risk — 27 historical
  // gateway acceptances on record. Its 07-09 removal ("parse-failed and
  // circuit-broken", below) is discounted: the 5/5 parse-fail record dates
  // from June under the pre-07-28 breaker/accounting bugs (successes never
  // tagged) AND an unsupported reasoning_effort=xhigh (catalog says
  // low|medium|high) that plausibly caused the empty outputs itself.
  // LUNA POSTMORTEM (2026-09-02): the 08-13 BETA WATCH note warned Venice may
  // withdraw a beta model without notice. What actually broke was subtler —
  // the model stayed up but its 'max' effort tier was dropped from the LIVE
  // inference path on 09-01 while the catalog kept listing it. Every luna
  // attempt 400'd from 09-01T23:33 until the 09-02 swap. Lesson kept: probe
  // the exact (model, effort) pair live; the catalog alone proves nothing.
  mining_solve: [
    "grok-4-6",
    "claude-opus-5",
    "openai-gpt-56-sol",
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
  // grok-4-5 accepts ONLY low|medium|high per the live catalog
  // (reasoningEffortOptions) — it was set to "xhigh" from 2026-07-09 until
  // 2026-07-28, an unsupported value Venice appears to have silently ignored.
  "grok-4-5": "high",
  // grok-4-6 DOES list xhigh (catalog 2026-08-13: low|medium|high|xhigh,
  // default high) — operator wants it at xhigh, and this time it's supported.
  "grok-4-6": "xhigh",
  "openai-gpt-55": "high",
  // Sol at "xhigh" per operator (2026-09-02), up from the prophylactic "high"
  // it ran at during its first roster stint (ended 08-13). The old concern —
  // gpt-55 empty-tracing at xhigh — did not reproduce on sol: live probe
  // 09-02 returned 11k chars of solve-shaped JSON in 132s at xhigh.
  "openai-gpt-56-sol": "xhigh",
  // Luna left the roster 2026-09-02: Venice's inference path REJECTS
  // reasoning_effort=max for it since 09-01 (HTTP 400) while the catalog
  // still lists max as supported. Held at "high" (its catalog default) so
  // any residual call site doesn't inherit the dead config.
  "openai-gpt-56-luna": "high",
  // claude-opus-5 at "xhigh" per operator (2026-09-02). HISTORY: this entry
  // was deliberately absent 07-28→09-02 because the catalog then reported
  // supportsReasoningEffort=false — the arm ran at Venice's server-side
  // default (now listed as "medium"). The 09-02 catalog re-probe shows the
  // dial exists (low|medium|high|xhigh|max, default medium), and a live
  // xhigh probe returned 200 with 17k chars in 122s.
  "claude-opus-5": "xhigh",
  // gemini-3-1-pro-preview accepts ONLY low|medium|high per the live catalog
  // (2026-08-05). It ran at an unsupported "xhigh" from 05-24 → 07-09 — the
  // same class of misconfig grok-4-5 had — which plausibly produced its
  // "solver produced no output" errors and the parse-fails that got it benched.
  "gemini-3-1-pro-preview": "high",
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
  failureRates: Record<string, { attempts: number; failures: number; rate: number; idRejected?: number }>,
): { filtered: string[]; sidelined: string[] } {
  const sidelined: string[] = [];
  const filtered = pool.filter((m) => {
    const r = failureRates[m];
    if (!r) return true;
    // A rejection of the model ID itself is deterministic — the gateway will
    // refuse this id on every future submission, so waiting for a rate to
    // accumulate just burns more paid solves (GLM burned 52, kimi-k3 3 before
    // this rule existed). One is enough.
    if ((r.idRejected ?? 0) > 0) {
      sidelined.push(m);
      return false;
    }
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
