import "dotenv/config";
import { Agent, fetch as undiciFetch } from "undici";
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
// Fallback for chat() calls that pass no model (projects.ts, peer-review.ts).
// NOTE: .env's NOOKPLOT_AGENT_API_MODEL wins — it was claude-opus-4-8 until
// 2026-09-29, which silently routed those call sites to opus-4-8.
const DEFAULT_MODEL = process.env.NOOKPLOT_AGENT_API_MODEL ?? "openai-gpt-61-sol";

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

/**
 * Timeout FLOOR for every chat() call (2026-10-01). grok-4-7 at xhigh — the
 * whole roster since 2026-09-29 — took 149-249s on the bare probe shapes and
 * more than 300s on production python prompts: two consecutive 300s aborts on
 * one attempt (10 min, then failure — a one-model pool has no failover).
 * Call-site timeouts (90-300s) were sized for faster models and aborted
 * silently. Same design as MIN_COMPLETION_TOKENS: a caller's timeoutMs is a
 * hint, this is the floor. The effort dial is NOT lowered — that stays the
 * operator's calibration (see the temperature note below). Override with
 * BOT_MIN_CALL_TIMEOUT_MS. Worst case per hung call: 2 × floor (one
 * same-model abort retry).
 */
const MIN_CALL_TIMEOUT_MS = (() => {
  const n = Number(process.env.BOT_MIN_CALL_TIMEOUT_MS ?? 600_000);
  // undici rejects a non-integer timeout with UND_ERR_INVALID_ARG on EVERY
  // call — a fractional or garbage env value must not silently stop inference.
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 600_000;
})();

/**
 * Transport for Venice calls ONLY (2026-10-01). Node's built-in fetch (undici
 * 7.16) applies its own 300s headersTimeout/bodyTimeout, which fired before
 * any AbortController above 300s — so the 600s floor never took effect and
 * about half of grok-4-7 mining generations died at ~303s with a bare "fetch
 * failed" (cause UND_ERR_HEADERS_TIMEOUT; reproduced locally against a 600s
 * controller). This agent lifts the transport limits above the longest
 * per-call timeout (the 1,000s standard solve), so OUR AbortController decides.
 * Scoped to Venice on purpose: a global dispatcher would also remove the only
 * timeout on the Nookplot SDK's requests, which set no AbortSignal of their own.
 */
const VENICE_TRANSPORT_TIMEOUT_MS = Math.max(1_800_000, MIN_CALL_TIMEOUT_MS * 2);
const VENICE_DISPATCHER = new Agent({
  headersTimeout: VENICE_TRANSPORT_TIMEOUT_MS,
  bodyTimeout: VENICE_TRANSPORT_TIMEOUT_MS,
});

/** Pure: undici transport-timeout causes behave like our own abort (one retry max). */
export function isTransportTimeoutCause(code: unknown): boolean {
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}

/** Socket-level losses: fast ones (a stale pooled socket, DNS) deserve the
 *  normal retries; one that lands LATE in a long generation is the same
 *  situation as a timeout and gets the one-retry cap (3 × a 10-min call is
 *  ~30 min of a mining slot, and Venice may bill each attempt). */
const SOCKET_LOSS_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET"]);
export const LATE_SOCKET_LOSS_MS = 30_000;

/**
 * Pure: wrap a chat() failure with its transport cause code and decide its
 * retry class. `isAbort` errors get at most one same-model retry; other
 * `transient` errors get the normal 3 attempts; everything else throws.
 */
export function classifyChatError(err: unknown, elapsedMs: number): { error: Error; causeCode?: string; isAbort: boolean; transient: boolean } {
  let error = err instanceof Error ? err : new Error(String(err));
  const raw = (err as { cause?: { code?: unknown } })?.cause?.code;
  const causeCode = typeof raw === "string" ? raw : undefined;
  if (causeCode && !error.message.includes(causeCode)) {
    // Surface the transport cause — a bare "fetch failed" hid the 300s
    // headers timeout for two days (2026-09-29 → 10-01).
    error = new Error(`${error.message} (${causeCode})`, { cause: err });
  }
  const m = error.message;
  const lateSocketLoss = !!causeCode && SOCKET_LOSS_CODES.has(causeCode) && elapsedMs > LATE_SOCKET_LOSS_MS;
  const isAbort = m.includes("aborted") || isTransportTimeoutCause(causeCode) || lateSocketLoss;
  const transient =
    isAbort ||
    m.includes("timeout") ||
    m.includes("ECONNRESET") ||
    m.includes("ENOTFOUND") ||
    m.includes("UND_ERR_CONNECT_TIMEOUT") ||
    m.includes("UND_ERR_SOCKET") ||
    m.includes("Venice API 502") ||
    m.includes("Venice API 503") ||
    m.includes("Venice API 504");
  return { error, causeCode, isAbort, transient };
}

/** Pure: the timeout a chat() call actually gets. */
export function effectiveTimeoutMs(requested?: number, floor = MIN_CALL_TIMEOUT_MS): number {
  return Math.max(requested ?? 180_000, floor);
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}) {
  assertVeniceKey();
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  const model = opts.model ?? DEFAULT_MODEL;
  // Floored, but retryable downward: some providers 400 when max_tokens
  // exceeds the model's completion limit — on that specific error we halve
  // and retry rather than failing the call.
  let effectiveMaxTokens = Math.max(opts.max_tokens ?? MIN_COMPLETION_TOKENS, MIN_COMPLETION_TOKENS);
  // Retryable downward like max_tokens: some models (gpt-56-terra, 09-03)
  // reject ANY explicit temperature — on that specific 400 we drop the field
  // (server default) and retry rather than failing the call.
  let effectiveTemperature = opts.temperature;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptStart = Date.now();
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), effectiveTimeoutMs(opts.timeoutMs));
      try {
        const res = await undiciFetch(`${BASE}/chat/completions`, {
          dispatcher: VENICE_DISPATCHER,
          method: "POST",
          headers: {
            Authorization: `Bearer ${KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            messages,
            temperature: effectiveTemperature,
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
      const cls = classifyChatError(err, Date.now() - attemptStart);
      lastErr = cls.error;
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
      // "Unsupported value: 'temperature' does not support X with this model"
      // (terra, all 4 first-hour attempts 2026-09-03). Deterministic per
      // model — drop the field and retry with the server default. Effort
      // rejections are deliberately NOT auto-downgraded: effort is an
      // operator calibration choice, and silently nerfing it would hide a
      // roster misconfiguration (the luna-max lesson) — those stay loud.
      const temp400 =
        lastErr.message.includes("Venice API 400") &&
        /unsupported value.{0,20}'temperature'/i.test(lastErr.message);
      if (temp400 && effectiveTemperature !== undefined) {
        effectiveTemperature = undefined;
        console.warn(`   ↩ ${model} rejected temperature=${opts.temperature} — retrying with server default`);
        continue;
      }
      // An abort = OUR OWN timeout fired. Re-running the SAME model at the
      // same timeout usually re-times-out — 3 internal attempts stack to
      // 3×timeoutMs before the caller's cross-model failover (which is the
      // productive path) ever fires. One same-model retry max for aborts.
      const { isAbort, transient } = cls;
      if (!transient || attempt === maxAttempts - 1 || (isAbort && attempt >= 1)) throw lastErr;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("chat failed");
}
