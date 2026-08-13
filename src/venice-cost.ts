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
/**
 * Real Venice list prices, USD per 1M tokens, pulled from the live catalog
 * (`GET /v1/models` → model_spec.pricing) on 2026-07-28.
 *
 * Replaces a single hand-maintained "blended" rate per model, which had gone
 * both STALE and INCOMPLETE: grok-4-3 was listed at 12.0 against a real
 * $1.42/$2.83, and three of the four live mining arms (grok-4-5,
 * openai-gpt-56-sol, and both new ones) had no entry at all, so they silently
 * fell back to the default. Since these numbers feed NOOK-per-dollar per A/B
 * arm — the comparison that decides which model to prune — a wrong rate
 * quietly corrupts the decision.
 *
 * Input vs output is tracked separately because our calls are extremely
 * output-heavy: reasoning tokens bill as output and every call carries a 50k
 * completion budget, so a blended rate mis-prices arms whose in/out spread
 * differs (grok-4-5 is 3.0x out/in; gpt-56-sol is 6.0x).
 */
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  // Current mining A/B arms
  "grok-4-5": { in: 2.27, out: 6.8 },
  "claude-opus-5": { in: 6, out: 30 },
  // Live catalog 2026-08-13; luna also has cache tiers ($0.027 cached-in) the
  // flat table can't express — mining calls are uncached, so immaterial.
  "openai-gpt-56-luna": { in: 0.26666667, out: 1.6 },
  "openai-gpt-56-sol": { in: 6.25, out: 37.5 },
  "kimi-k3": { in: 4.6875, out: 23.4375 },
  // Fallback / other-task models
  "claude-opus-4-8": { in: 6, out: 30 },
  "claude-opus-4-7": { in: 6, out: 30 },
  "claude-fable-5": { in: 12, out: 60 },
  "grok-4-3": { in: 1.42, out: 2.83 },
  "openai-gpt-55": { in: 6.25, out: 37.5 },
  "zai-org-glm-5-2": { in: 1.4, out: 4.4 },
  "gemini-3-1-pro-preview": { in: 2.5, out: 15 },
  "deepseek-v4-pro": { in: 1.65, out: 3.301 },
};
// NOTE: grok-4-3, grok-4-5 and gemini-3-1-pro-preview also have EXTENDED-context
// tiers that roughly double these rates above a 200k-token threshold. The flat
// table cannot express that, so long-context calls on those models are
// under-costed. Immaterial today (mining prompts run ~4-12k tokens); revisit if
// we start feeding whole repos.
/** Unknown model: assume mid-tier rather than free, so cost never reads as 0. */
const DEFAULT_PRICING = { in: 5.0, out: 20.0 };

const DAILY_COST_ALERT = Number(process.env.BOT_VENICE_DAILY_COST_ALERT ?? 50);

export interface CostEntry {
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
  /** For submit-reject rows: the modelUsed string actually sent on the wire.
   *  Recorded so a rejection of an OLD wire name does not condemn a corrected one. */
  wireName?: string;
  callSite?: string;
}

/** Estimate a single call's cost in credits given usage data. */
export function estimateCallCost(model: string, totalTokens: number, completionTokens?: number): number {
  const p = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  // With a known split, price input and output separately (reasoning tokens
  // are billed as output and dominate our spend). Without it, assume the
  // output-heavy shape our calls actually have (~70% completion) rather than
  // an even split, which would understate cost by ~2x.
  const out = completionTokens ?? totalTokens * 0.7;
  const inp = Math.max(0, totalTokens - out);
  return (inp / 1_000_000) * p.in + (out / 1_000_000) * p.out;
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
  // completionTokens ALREADY INCLUDES reasoningTokens — Venice follows the
  // OpenAI convention where reasoning is a subset, verified against 6,108
  // reasoning-bearing rows in this very log (total == prompt + completion in
  // 6108/6108, additive in 0/6108). Adding them would double-count, and only
  // on the arms that report reasoning at all (grok-4-5 and gpt-56-sol always
  // do; claude-opus-* and kimi-k3 never do) — inflating two A/B arms' cost by
  // 18-61% while leaving the others exact, which is precisely the per-arm
  // corruption this pricing work exists to prevent.
  const estCost = estimateCallCost(args.model, totalTokens, completionTokens);
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
/**
 * Rate evidence goes stale after this many days. Rows older than the window
 * predate model/config changes (and, before 2026-07-28, a broken accounting
 * pipeline that never tagged successes) — and without a time bound, a BENCHED
 * model's last-N rows are frozen forever: gemini-3-1-pro-preview sat at "5/5
 * parse-fail" from June and could never re-enter the pool, because a sidelined
 * arm generates no new rows to age the old ones out. Id rejections are exempt
 * (deterministic evidence — see below).
 */
export const PARSE_FAIL_WINDOW_DAYS = Number(process.env.BOT_MODEL_PARSE_FAIL_WINDOW_DAYS ?? 14);

/** Pure aggregation core of {@link parseFailureRateByModel} — testable. */
export function computeParseFailureRates(
  calls: CostEntry[],
  lookback = 10,
  nowMs = Date.now(),
): Record<string, { attempts: number; failures: number; rate: number; idRejected: number; idRejectedWireNames: string[] }> {
  // Most-recent first
  const sorted = [...calls].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const cutoff = nowMs - PARSE_FAIL_WINDOW_DAYS * 86_400_000;
  const byModel: Record<string, CostEntry[]> = {};
  const rejectsByModel: Record<string, CostEntry[]> = {};
  for (const e of sorted) {
    if (!e.model) continue;
    // Rejections of the model ID ITSELF are DETERMINISTIC — the gateway will
    // refuse this id every time, so one occurrence is proof at any age. They
    // are never windowed out; a wire-name CHANGE (not time) is what discounts
    // them, via discountStaleIdRejections.
    if (e.outcome === "submit-reject") (rejectsByModel[e.model] ??= []).push(e);
    if (new Date(e.ts).getTime() < cutoff) continue;
    if (!byModel[e.model]) byModel[e.model] = [];
    if (byModel[e.model].length < lookback) byModel[e.model].push(e);
  }
  const models = new Set([...Object.keys(byModel), ...Object.keys(rejectsByModel)]);
  const result: Record<string, { attempts: number; failures: number; rate: number; idRejected: number; idRejectedWireNames: string[] }> = {};
  for (const model of models) {
    const recent = byModel[model] ?? [];
    // "submit-reject" counts as a failure alongside "parse-fail": a model whose
    // output the GATEWAY refuses is just as worthless as one we can't parse,
    // and costs the same paid solve. Without this the breaker is blind to
    // wire-level rejection — GLM generated cleanly 146/148 times while 100% of
    // its submissions 400'd, so the breaker rated it our healthiest arm for 13
    // days (52 solves, $12.31, zero accepted).
    const failures = recent.filter((e) => e.outcome === "parse-fail" || e.outcome === "submit-reject").length;
    const rejects = rejectsByModel[model] ?? [];
    result[model] = {
      attempts: recent.length,
      failures,
      rate: recent.length > 0 ? failures / recent.length : 0,
      idRejected: rejects.length,
      // Which exact wire strings were refused. A caller that has since CHANGED
      // the wire name for this model can disregard rejections of the old one.
      idRejectedWireNames: [
        ...new Set(rejects.map((e) => e.wireName).filter((w): w is string => Boolean(w))),
      ],
    };
  }
  return result;
}

export function parseFailureRateByModel(lookback = 10): Record<
  string,
  { attempts: number; failures: number; rate: number; idRejected: number; idRejectedWireNames: string[] }
> {
  return computeParseFailureRates(
    readJsonl<CostEntry>(LOG).filter((e) => e.callSite === "mining_solve"),
    lookback,
  );
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
export function recordSubmitRejection(model: string, reason?: string, wireName?: string): void {
  appendJsonl(LOG, {
    ts: new Date().toISOString(),
    model,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estCost: 0,
    outcome: "submit-reject",
    callSite: "mining_solve",
    wireName,
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
