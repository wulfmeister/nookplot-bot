/**
 * Venice cost accounting.
 *
 * Every successful Venice chat() call records its model + token usage +
 * estimated cost to ~/.nookplot/venice-costs.jsonl. Used to:
 *   1. Surface daily spend on the dashboard.
 *   2. Trigger a single warning when daily spend exceeds the alert threshold.
 *   3. Track per-model parse-failure waste (consumed by mining circuit-breaker).
 *
 * Cost basis: Venice prices vary per-model. We use a conservative blended
 * estimate (input + reasoning + output combined) per 1M tokens. Real numbers
 * are computed from the per-model pricing table below, with reasonable
 * defaults for any unrecognized model.
 *
 * ENV:
 *   BOT_VENICE_DAILY_COST_ALERT — credits threshold; default 50.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

const LOG = join(NOOK_DIR, "venice-costs.jsonl");

/**
 * Approximate Venice credits-per-million-tokens by model (blended).
 * Conservative — real costs are usually lower, but biasing high means our
 * alerts fire EARLY rather than after a quiet wallet drain.
 *
 * Numbers track the published Venice catalog prices as of 2026-05; revise
 * if Venice updates pricing.
 */
const COST_PER_M_TOKENS_BLENDED: Record<string, number> = {
  // Venice list 2026-06-11: $12/M in, $60/M out — exactly 2× opus-4-7
  // ($6/$30), so 2× the table's opus blended rate keeps ordering consistent.
  "claude-opus-4-8": 25.0, // $5/$25 per M — same Opus-tier blended rate as 4-7
  "claude-fable-5": 50.0,
  "claude-opus-4-7": 25.0,
  "openai-gpt-55": 18.0,
  "grok-4-3": 12.0,
  "gemini-3-1-pro-preview": 8.0,
  "deepseek-v4-pro": 5.0,
};
const DEFAULT_COST_PER_M = 15.0;

const DAILY_COST_ALERT = Number(process.env.BOT_VENICE_DAILY_COST_ALERT ?? 50);

interface CostEntry {
  ts: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  estCost: number;
  /** When the caller knows whether this call was useful (e.g. a mining solve
   * that failed to parse), they record that here for later forensics. */
  outcome?: "parse-ok" | "parse-fail" | "timeout" | "other-error" | "ok" | "rate-limited" | "submit-reject";
  callSite?: string;
}

/** Estimate a single call's cost in credits given usage data. */
export function estimateCallCost(model: string, totalTokens: number): number {
  const rate = COST_PER_M_TOKENS_BLENDED[model] ?? DEFAULT_COST_PER_M;
  return (totalTokens / 1_000_000) * rate;
}

/** Record a successful Venice call. */
export function recordVeniceCall(args: {
  model: string;
  usage?: Record<string, unknown> | undefined;
  outcome?: CostEntry["outcome"];
  callSite?: string;
}): { estCost: number; totalTokens: number } {
  const u = args.usage ?? {};
  const promptTokens = Number((u as { prompt_tokens?: number }).prompt_tokens ?? 0);
  const completionTokens = Number((u as { completion_tokens?: number }).completion_tokens ?? 0);
  const reasoningTokens = Number(
    (u as { reasoning_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } })
      .reasoning_tokens ??
      (u as { completion_tokens_details?: { reasoning_tokens?: number } }).completion_tokens_details
        ?.reasoning_tokens ??
      0,
  );
  const totalTokens = Number(
    (u as { total_tokens?: number }).total_tokens ?? promptTokens + completionTokens + reasoningTokens,
  );
  const estCost = estimateCallCost(args.model, totalTokens);
  const entry: CostEntry = {
    ts: new Date().toISOString(),
    model: args.model,
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningTokens || undefined,
    totalTokens,
    estCost,
    outcome: args.outcome,
    callSite: args.callSite,
  };
  appendJsonl(LOG, entry);
  return { estCost, totalTokens };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sum of estimated Venice cost today (UTC). */
export function veniceSpentToday(): number {
  const today = todayUtc();
  return readJsonl<CostEntry>(LOG)
    .filter((e) => e.ts && e.ts.slice(0, 10) === today)
    .reduce((s, e) => s + (e.estCost ?? 0), 0);
}

/** Per-model spend today. */
export function veniceSpentTodayByModel(): Record<string, { calls: number; estCost: number; tokens: number }> {
  const today = todayUtc();
  const byModel: Record<string, { calls: number; estCost: number; tokens: number }> = {};
  for (const e of readJsonl<CostEntry>(LOG)) {
    if (!e.ts || e.ts.slice(0, 10) !== today) continue;
    const m = e.model ?? "(unknown)";
    if (!byModel[m]) byModel[m] = { calls: 0, estCost: 0, tokens: 0 };
    byModel[m].calls += 1;
    byModel[m].estCost += e.estCost ?? 0;
    byModel[m].tokens += e.totalTokens ?? 0;
  }
  return byModel;
}

/**
 * Per-model 429 count today — the "are we maxing out inference capacity"
 * signal (2026-06-11, added alongside the claude-fable-5 default switch).
 * A sustained rise here means we've outgrown the provider's rate limits
 * for that model and should spread load or downshift volume tasks.
 */
export function veniceRateLimited429Today(): Record<string, number> {
  const today = todayUtc();
  const byModel: Record<string, number> = {};
  for (const e of readJsonl<CostEntry>(LOG)) {
    if (!e.ts || e.ts.slice(0, 10) !== today) continue;
    if (e.outcome !== "rate-limited") continue;
    const m = e.model ?? "(unknown)";
    byModel[m] = (byModel[m] ?? 0) + 1;
  }
  return byModel;
}

/**
 * Per-model parse-failure tracking. Used by the mining circuit-breaker (#16):
 * if a model's parse-failure RATE within the last `lookback` calls exceeds
 * the threshold, that model is considered "blown" and shouldn't be picked
 * for new mining solves for a cooldown window.
 *
 * Returns: per-model { attempts, failures, rate }.
 */
export function parseFailureRateByModel(lookback = 10): Record<
  string,
  { attempts: number; failures: number; rate: number }
> {
  const allCalls = readJsonl<CostEntry>(LOG).filter((e) => e.callSite === "mining_solve");
  // Most-recent first
  const sorted = [...allCalls].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const byModel: Record<string, CostEntry[]> = {};
  for (const e of sorted) {
    if (!e.model) continue;
    if (!byModel[e.model]) byModel[e.model] = [];
    if (byModel[e.model].length < lookback) byModel[e.model].push(e);
  }
  const result: Record<string, { attempts: number; failures: number; rate: number }> = {};
  for (const [model, recent] of Object.entries(byModel)) {
    // "submit-reject" counts as a failure alongside "parse-fail": a model whose
    // output the GATEWAY refuses is just as worthless as one we can't parse,
    // and costs the same paid solve. Without this the breaker is blind to
    // wire-level rejection — GLM generated cleanly 146/148 times while 100% of
    // its submissions 400'd, so the breaker rated it our healthiest arm for 13
    // days (52 solves, $12.31, zero accepted).
    const failures = recent.filter((e) => e.outcome === "parse-fail" || e.outcome === "submit-reject").length;
    result[model] = {
      attempts: recent.length,
      failures,
      rate: recent.length > 0 ? failures / recent.length : 0,
    };
  }
  return result;
}

/**
 * Re-tag the most recent venice-cost log entry with a specific outcome +
 * callSite. Used by mining.ts to mark a call as parse-fail / parse-ok after
 * the fact (the cost is recorded immediately on the API response, before
 * the parsing pass that determines outcome).
 *
 * Atomic: rewrites the JSONL file with the last matching entry updated.
 * Idempotent — calling twice tags the same entry.
 */
export function tagLatestCallOutcome(
  model: string,
  outcome: CostEntry["outcome"],
  callSite?: string,
): void {
  const all = readJsonl<CostEntry>(LOG);
  // Find most-recent entry for this model
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].model === model) {
      all[i].outcome = outcome;
      if (callSite) all[i].callSite = callSite;
      // Rewrite the file atomically. For our scale (10k lines = ~3MB) this
      // is fine; if it gets much bigger, swap to an append-and-compact model.
      writeFileSync(LOG, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return;
    }
  }
}

/**
 * Record that the GATEWAY refused a submission produced by `model` (a permanent
 * 4xx that no retry fixes — e.g. an unrecognized modelUsed id). Appended as a
 * zero-cost mining_solve entry so `parseFailureRateByModel` — and therefore the
 * cost circuit breaker — sees wire-level rejection, not just parse failures.
 * The paid solve is already spent by the time we learn this, so the only
 * defense is sidelining the arm before it burns the next one.
 */
export function recordSubmitRejection(model: string, reason?: string): void {
  appendJsonl(LOG, {
    ts: new Date().toISOString(),
    model,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estCost: 0,
    outcome: "submit-reject",
    callSite: "mining_solve",
    note: reason?.slice(0, 160),
  } as CostEntry & { note?: string });
}

/** Track whether we've already fired the daily alert. Latched to avoid spam. */
let alertFiredToday: string | null = null;

/**
 * Should we emit a "you're spending a lot today" warning right now?
 * Returns true at most once per UTC day, once spend crosses the threshold.
 */
export function shouldFireDailyAlert(): boolean {
  const today = todayUtc();
  if (alertFiredToday === today) return false;
  if (veniceSpentToday() < DAILY_COST_ALERT) return false;
  alertFiredToday = today;
  return true;
}

export interface VeniceCostSummary {
  spentToday: number;
  alertThreshold: number;
  remainingBudgetBeforeAlert: number;
  byModel: Record<string, { calls: number; estCost: number; tokens: number }>;
  /** Per-model 429 count today — inference-capacity pressure signal. */
  rateLimited429: Record<string, number>;
}

export function veniceCostSummary(): VeniceCostSummary {
  const spent = veniceSpentToday();
  return {
    spentToday: spent,
    alertThreshold: DAILY_COST_ALERT,
    remainingBudgetBeforeAlert: Math.max(0, DAILY_COST_ALERT - spent),
    byModel: veniceSpentTodayByModel(),
    rateLimited429: veniceRateLimited429Today(),
  };
}
