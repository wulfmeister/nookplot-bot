/**
 * Paid egress proxy — POST /v1/actions/http
 *
 * The gateway can act as our reverse-proxy to external URLs at a flat
 * 0.15 credits / call. Useful for:
 *   - Paywalled APIs that block direct fetches (Anthropic news, OpenReview)
 *   - Geo-fenced sources that need a stable IP
 *   - Sources that 429/403 our direct fetches but allow gateway IPs
 *
 * Daily cost guardrail: EGRESS_DAILY_BUDGET (credits). Default 5 cr/day = ~33
 * calls. The bot REFUSES new calls once the budget is exhausted; the
 * remaining budget resets at UTC midnight.
 *
 * Endpoint: POST /v1/actions/http
 *   body: { method, url, headers?, body?, timeoutMs? }
 *   returns: { status, body, headers }
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "egress.jsonl");

const COST_PER_CALL = 0.15;
const DAILY_BUDGET_CREDITS = Number(process.env.EGRESS_DAILY_BUDGET ?? 5);

export interface EgressResponse<T = unknown> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

interface LogEntry {
  ts: string;
  url: string;
  method: string;
  status?: number;
  costCredits: number;
  ok: boolean;
  notes?: string;
}

function dayBucket(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

/** Sum of egress credits spent today (UTC). */
export function spentToday(): number {
  const today = dayBucket(new Date().toISOString());
  return readJsonl<LogEntry>(LOG)
    .filter((e) => e.ts && dayBucket(e.ts) === today)
    .reduce((s, e) => s + (e.costCredits ?? 0), 0);
}

/** Credits remaining under today's budget. Returns 0 if the budget is exhausted. */
export function remainingBudget(): number {
  return Math.max(0, DAILY_BUDGET_CREDITS - spentToday());
}

/**
 * Make an HTTP request through the gateway egress proxy. Throws if today's
 * budget is exhausted (so callers can fall back to direct fetch or skip).
 */
export async function egressRequest<T = unknown>(
  runtime: RuntimeLike,
  opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<EgressResponse<T>> {
  if (remainingBudget() < COST_PER_CALL) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      url: opts.url,
      method: opts.method,
      costCredits: 0,
      ok: false,
      notes: `budget-exhausted (${spentToday()}/${DAILY_BUDGET_CREDITS} cr today)`,
    });
    throw new Error(
      `egress budget exhausted (${spentToday().toFixed(2)}/${DAILY_BUDGET_CREDITS} cr today)`,
    );
  }
  try {
    const res = (await runtime.connection.request("POST", "/v1/actions/http", opts)) as EgressResponse<T>;
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      url: opts.url,
      method: opts.method,
      status: res.status,
      costCredits: COST_PER_CALL,
      ok: true,
    });
    return res;
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      url: opts.url,
      method: opts.method,
      costCredits: 0,
      ok: false,
      notes: (err as Error).message.slice(0, 200),
    });
    throw err;
  }
}

/** Convenience: GET text response via egress, throwing on non-2xx. */
export async function egressFetchText(runtime: RuntimeLike, url: string): Promise<string> {
  const res = await egressRequest<string>(runtime, { method: "GET", url, timeoutMs: 15_000 });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`egress ${url} → HTTP ${res.status}`);
  }
  return typeof res.body === "string" ? res.body : JSON.stringify(res.body);
}

/** Convenience: GET JSON response via egress, throwing on non-2xx. */
export async function egressFetchJson<T = unknown>(runtime: RuntimeLike, url: string): Promise<T> {
  const res = await egressRequest<T>(runtime, { method: "GET", url, timeoutMs: 15_000 });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`egress ${url} → HTTP ${res.status}`);
  }
  return res.body;
}

export interface EgressSummary {
  callsToday: number;
  spentTodayCredits: number;
  budgetCredits: number;
  remainingCredits: number;
  callsAllTime: number;
}

export function egressSummary(): EgressSummary {
  const all = readJsonl<LogEntry>(LOG);
  const today = dayBucket(new Date().toISOString());
  return {
    callsToday: all.filter((e) => e.ts && dayBucket(e.ts) === today && e.ok).length,
    spentTodayCredits: spentToday(),
    budgetCredits: DAILY_BUDGET_CREDITS,
    remainingCredits: remainingBudget(),
    callsAllTime: all.filter((e) => e.ok).length,
  };
}
