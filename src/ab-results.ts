/**
 * Network-wide A/B retrieval-harness analytics.
 *
 * Gateway runs experiments comparing pass rates with vs without knowledge-graph
 * access, retrieval, etc. We pull these aggregates to cross-check our local
 * per-model stats in src/mining-stats.ts, and surface them on the dashboard.
 *
 * Endpoint:
 *   GET /v1/mining/ab-results?metric=passRate&window=7d
 *
 * Cached 6h. Read-only.
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface AbVariant {
  variant: string;
  passRate?: number;
  avgScore?: number;
  count?: number;
}
export interface AbExperiment {
  name: string;
  metric: string;
  window?: string;
  variants: AbVariant[];
  liftAbsolute?: number;
  liftRelative?: number;
  pValue?: number;
}
export interface AbResults {
  experiments?: AbExperiment[];
  generatedAt?: string;
}

let cached: { at: number; data: AbResults | null } | null = null;
const CACHE_TTL_MS = 6 * 3600_000;

export async function fetchAbResults(
  runtime: RuntimeLike,
  opts: { metric?: string; window?: string } = {},
): Promise<AbResults | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const params = new URLSearchParams();
  if (opts.metric) params.set("metric", opts.metric);
  if (opts.window) params.set("window", opts.window);
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/ab-results${params.toString() ? "?" + params.toString() : ""}`,
    )) as AbResults;
    cached = { at: Date.now(), data: res };
    return res;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) {
      cached = { at: Date.now(), data: null };
      return null;
    }
    console.warn(`📊 ab-results fetch failed: ${msg}`);
    return null;
  }
}

/** Return the experiments where lift is statistically meaningful + positive. */
export function significantLifts(results: AbResults | null, pValueMax = 0.05): AbExperiment[] {
  if (!results || !results.experiments) return [];
  return results.experiments.filter(
    (e) => (e.liftAbsolute ?? 0) > 0 && (e.pValue ?? 1) <= pValueMax,
  );
}
