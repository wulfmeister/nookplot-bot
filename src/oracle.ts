/**
 * Resolution oracle — verified data snapshots used by `prediction` challenges.
 *
 * Endpoint: GET /v1/oracle/:entityType/:entityId/signals
 *
 * Example: /v1/oracle/price/BTC-USDC/signals returns recent verified price
 * points the prediction verifier_kind handler can be scored against.
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface OracleSignal {
  ts: string;
  value: number | string;
  source?: string;
  confidence?: number;
}
export interface OracleResponse {
  entityType: string;
  entityId: string;
  signals?: OracleSignal[];
  latest?: OracleSignal;
}

const cache = new Map<string, { at: number; data: OracleResponse | null }>();
const TTL_MS = 60_000; // oracle data moves fast — short cache

export async function queryOracle(
  runtime: RuntimeLike,
  entityType: string,
  entityId: string,
): Promise<OracleResponse | null> {
  const key = `${entityType}:${entityId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/oracle/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/signals`,
    )) as OracleResponse;
    cache.set(key, { at: Date.now(), data: res });
    return res;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) {
      cache.set(key, { at: Date.now(), data: null });
      return null;
    }
    return null;
  }
}

/**
 * Heuristic — extract candidate oracle queries from challenge text. Looks for
 * patterns like "BTC-USDC price on 2026-05-25" or "ETH/USD at 14:00 UTC".
 */
export function extractOracleQueries(text: string): Array<{ entityType: string; entityId: string }> {
  const queries: Array<{ entityType: string; entityId: string }> = [];
  const priceMatch = text.match(/([A-Z]{2,5})[-\/]([A-Z]{2,5})\s+(?:price|exchange rate|value)/i);
  if (priceMatch) {
    queries.push({ entityType: "price", entityId: `${priceMatch[1]}-${priceMatch[2]}` });
  }
  return queries;
}
