import "dotenv/config";
import { effortFor } from "./models.js";
import { recordVeniceCall, shouldFireDailyAlert, veniceSpentToday } from "./venice-cost.js";

export interface VeniceParameters {
  include_venice_system_prompt?: boolean;
  enable_web_search?: "auto" | "on" | "off";
  enable_web_citations?: boolean;
  include_search_results_in_stream?: boolean;
  character_slug?: string;
  strip_thinking_response?: boolean;
  disable_thinking?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  venice_parameters?: VeniceParameters;
  /**
   * Venice reasoning effort. Per Venice docs: "none" | "minimal" | "low" |
   * "medium" | "high" | "xhigh" | "max". For openai-gpt-55, supported set is
   * none / low / medium / high / xhigh. Unsupported values return upstream 400.
   * Default: omitted (model picks its own default).
   */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Abort after this many ms. Default 60_000. Long reasoning traces with
   *  xhigh thinking can easily exceed 60s — mining solves typically need 180s. */
  timeoutMs?: number;
}

const BASE = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";
const KEY = process.env.VENICE_API_KEY;
const DEFAULT_MODEL = process.env.NOOKPLOT_AGENT_API_MODEL ?? "grok-4-3";

/**
 * Convenience: Venice web-search-enabled parameters.
 * Use for tasks where current external info improves quality
 * (bounty drafts, mining solves, knowledge essays). DO NOT use for
 * verification/comprehension/jury — those grade self-contained content
 * and external info is noise.
 */
export const VENICE_WEB_SEARCH = {
  enable_web_search: "auto" as const,
  enable_web_citations: true,
};

/**
 * Fail-fast guard for long-running entrypoints (daemon calls this at boot).
 * Deliberately NOT a module-scope throw: importing this module must stay safe
 * for keyless contexts — `npm test` on a bare clone and CI run 351/351 with
 * no Venice key, and a module-load throw broke exactly that on 2026-07-04.
 * Catches the .env.example placeholder too — otherwise boot "succeeds" and
 * every later Venice call fails as an opaque 401 retry loop.
 */
export function assertVeniceKey(): void {
  if (!KEY || /replace_me|your[_-]?key/i.test(KEY)) {
    throw new Error("VENICE_API_KEY missing or still a placeholder — get a key at https://venice.ai (Settings → API) and set it in .env");
  }
}

/**
 * Completion-budget floor applied to EVERY chat() call. All models in the
 * roster run with reasoning enabled, and reasoning tokens are billed against
 * max_tokens — a "small" budget sized for the visible output can be consumed
 * entirely by thinking, returning EMPTY content (observed: the project
 * reviewer at 1500 tokens produced 0 chars deterministically and burned all
 * its gate retries; challenge drafting at 4000 had the same failure on
 * gpt-55). Callers' max_tokens now act as a floor-clamped hint: instructions
 * control output LENGTH, this controls the hard stop. Operator accepted the
 * cost tail (a runaway 50k-token opus output ≈ $1.50) over silent empties.
 */
const MIN_COMPLETION_TOKENS = Number(process.env.BOT_MIN_COMPLETION_TOKENS ?? 50_000);

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}) {
  assertVeniceKey();
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  const model = opts.model ?? DEFAULT_MODEL;
  // Floored, but retryable downward: some providers 400 when max_tokens
  // exceeds the model's completion limit — on that specific error we halve
  // and retry rather than failing the call.
  let effectiveMaxTokens = Math.max(opts.max_tokens ?? MIN_COMPLETION_TOKENS, MIN_COMPLETION_TOKENS);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            messages,
            temperature: opts.temperature,
            max_tokens: effectiveMaxTokens,
            venice_parameters: opts.venice_parameters,
            // Auto-apply xhigh thinking when the chosen model supports it
            // (claude-opus-4-7, grok-4-3, openai-gpt-55). Explicit opts wins.
            reasoning_effort: opts.reasoning_effort ?? effortFor(model),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`Venice API ${res.status}: ${await res.text()}`);
        const data = (await res.json()) as {
          choices: Array<{
            message: {
              content: string;
              reasoning_content?: string;
            };
          }>;
          usage?: Record<string, unknown>;
          model?: string;
          venice_parameters?: {
            web_search_citations?: Array<{
              content?: string;
              url?: string;
              title?: string;
            }>;
            [k: string]: unknown;
          };
        };
        // Record cost telemetry. callSite is supplied later (callers add via
        // recordVeniceCallSite); we log immediately with a generic outcome.
        const callModel = data.model ?? model;
        try {
          recordVeniceCall({ model: callModel, usage: data.usage, outcome: "ok" });
        } catch { /* never let telemetry break a Venice call */ }
        if (shouldFireDailyAlert()) {
          console.warn(
            `⚠ Venice daily cost alert: ~${veniceSpentToday().toFixed(2)} credits spent today — investigate per-model breakdown via /api/snapshot venice field`,
          );
        }
        return {
          content: data.choices[0]?.message?.content ?? "",
          reasoning: data.choices[0]?.message?.reasoning_content,
          citations: data.venice_parameters?.web_search_citations ?? [],
          usage: data.usage,
          model: data.model,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastErr = err as Error;
      // Capacity telemetry: a 429 means we hit the provider's rate limit for
      // this model. Recorded per-model so the dashboard can show whether
      // we're starting to max out inference capacity (veniceRateLimited429Today).
      if (lastErr.message.includes("Venice API 429")) {
        try {
          recordVeniceCall({ model, outcome: "rate-limited" });
        } catch { /* telemetry must never break the call */ }
      }
      // A 400 rejecting our (floored) max_tokens means this model's completion
      // limit is below the floor — halve and retry instead of failing.
      const tokenLimit400 =
        lastErr.message.includes("Venice API 400") &&
        /max_?(output_)?tokens|maximum.{0,30}tokens/i.test(lastErr.message);
      if (tokenLimit400 && effectiveMaxTokens > 8000) {
        effectiveMaxTokens = Math.max(8000, Math.floor(effectiveMaxTokens / 2));
        console.warn(`   ↩ ${model} rejected max_tokens — retrying at ${effectiveMaxTokens}`);
        continue;
      }
      // An abort = OUR OWN timeout fired. Re-running the SAME model at the
      // same timeout usually re-times-out — 3 internal attempts stack to
      // 3×timeoutMs before the caller's cross-model failover (which is the
      // productive path) ever fires. One same-model retry max for aborts.
      const isAbort = lastErr.message.includes("aborted");
      const transient =
        lastErr.message.includes("timeout") ||
        lastErr.message.includes("ECONNRESET") ||
        lastErr.message.includes("ENOTFOUND") ||
        isAbort ||
        lastErr.message.includes("UND_ERR_CONNECT_TIMEOUT") ||
        lastErr.message.includes("Venice API 502") ||
        lastErr.message.includes("Venice API 503") ||
        lastErr.message.includes("Venice API 504");
      if (!transient || attempt === maxAttempts - 1 || (isAbort && attempt >= 1)) throw lastErr;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("chat failed");
}
