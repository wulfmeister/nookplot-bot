/**
 * NOOK → USD spot price (CoinGecko). Shared so the daemon can stamp each claim
 * with the price *at claim time* — freezing that day's USD value instead of
 * letting it drift retroactively with the live price. `NOOK_USD_PRICE` pins a
 * fixed price (overrides the live fetch).
 *
 * This is a one-shot fetch (no caching): the daemon calls it at most a few times
 * a day when recording claims. The dashboard keeps its own cached live-price path
 * for the always-current display number.
 */
export interface NookPriceSpot {
  usd: number;
  source: string;
}

/**
 * Historical NOOK→USD price points over a time range (CoinGecko market_chart),
 * used to backfill claims recorded before we stamped price-at-claim-time. A
 * range ≤ 90 days returns hourly granularity → we can pick the point nearest a
 * claim's actual timestamp. Returns `[[unixMs, usd], ...]` ascending, or null.
 */
export async function fetchNookPriceRange(fromSec: number, toSec: number): Promise<Array<[number, number]> | null> {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/nookplot/market_chart/range?vs_currency=usd&from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (r.ok) {
      const j = (await r.json()) as { prices?: Array<[number, number]> };
      if (Array.isArray(j.prices) && j.prices.length > 0) return j.prices;
    }
  } catch {
    /* network/timeout */
  }
  return null;
}

export async function fetchNookPriceUsd(): Promise<NookPriceSpot | null> {
  const envPrice = Number(process.env.NOOK_USD_PRICE);
  if (Number.isFinite(envPrice) && envPrice > 0) return { usd: envPrice, source: "env:NOOK_USD_PRICE" };
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=nookplot&price_change_percentage=7d",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const arr = (await r.json()) as Array<{ current_price?: number }>;
      const usd = Array.isArray(arr) ? arr[0]?.current_price : undefined;
      if (typeof usd === "number" && usd > 0) return { usd, source: "coingecko" };
    }
  } catch {
    /* network/timeout — caller stores no price and the dashboard falls back to live */
  }
  return null;
}
