/**
 * One-off (re-runnable, idempotent) backfill of `priceUsdAtClaim` onto historical
 * off-chain claims recorded before we started stamping the NOOK→USD price at
 * claim time. Pulls one CoinGecko market_chart range over the claim span and
 * stamps each claim with the price point NEAREST its actual timestamp.
 *
 * Safety: backs up the file first, re-reads it fresh right before writing (so a
 * claim the daemon appends mid-run isn't lost), and writes atomically (tmp +
 * rename). Claims that already have a price, or that have no nearby price point
 * (>36h), are left untouched.
 *
 *   npm run backfill:prices
 */
import "dotenv/config";
import { readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { NOOK_DIR } from "./util.js";
import { fetchNookPriceRange } from "./nook-price.js";

const FILE = join(NOOK_DIR, "mining-claims.jsonl");
const NEAR_WINDOW_MS = 36 * 3600_000; // don't stamp if the nearest price is >36h off

interface Claim {
  ts: string;
  claimed?: number;
  kind?: string;
  priceUsdAtClaim?: number;
  priceSourceAtClaim?: string;
  [k: string]: unknown;
}

function readClaims(): Claim[] {
  return readFileSync(FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Claim);
}

function isBackfillable(c: Claim): boolean {
  return c.kind !== "on-chain" && typeof c.claimed === "number" && c.priceUsdAtClaim == null;
}

/** Nearest price (usd) to tsMs within NEAR_WINDOW_MS, else null. prices ascending. */
function nearestPrice(prices: Array<[number, number]>, tsMs: number): number | null {
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const [ms, usd] of prices) {
    const diff = Math.abs(ms - tsMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = usd;
    }
  }
  return best != null && bestDiff <= NEAR_WINDOW_MS ? best : null;
}

async function main(): Promise<void> {
  const claims = readClaims();
  const missing = claims.filter(isBackfillable);
  console.log(`mining-claims.jsonl: ${claims.length} entries, ${missing.length} off-chain claims missing a price.`);
  if (missing.length === 0) {
    console.log("nothing to backfill — all off-chain claims already have priceUsdAtClaim.");
    return;
  }

  const tsList = missing.map((c) => new Date(c.ts).getTime()).filter((n) => Number.isFinite(n));
  const fromSec = Math.min(...tsList) / 1000 - 2 * 86400; // pad ±2 days for edge coverage
  const toSec = Math.max(...tsList) / 1000 + 2 * 86400;
  console.log(`fetching CoinGecko range ${new Date(fromSec * 1000).toISOString().slice(0, 10)} → ${new Date(toSec * 1000).toISOString().slice(0, 10)}…`);
  const prices = await fetchNookPriceRange(fromSec, toSec);
  if (!prices) {
    console.error("✗ CoinGecko range fetch failed (rate limit or no history). Re-run in a minute.");
    process.exit(1);
  }
  console.log(`got ${prices.length} price points (${new Date(prices[0][0]).toISOString().slice(0, 10)} … ${new Date(prices[prices.length - 1][0]).toISOString().slice(0, 10)}).`);

  // Back up before touching the file.
  const bak = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(FILE, bak);
  console.log(`backed up → ${bak}`);

  // Re-read fresh so a claim appended during the fetch window isn't clobbered.
  const fresh = readClaims();
  let stamped = 0;
  const noData: string[] = [];
  for (const c of fresh) {
    if (!isBackfillable(c)) continue;
    const usd = nearestPrice(prices, new Date(c.ts).getTime());
    if (usd != null) {
      c.priceUsdAtClaim = usd;
      c.priceSourceAtClaim = "coingecko:history";
      stamped++;
    } else {
      noData.push(c.ts.slice(0, 10));
    }
  }

  // Atomic write.
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, fresh.map((c) => JSON.stringify(c)).join("\n") + "\n");
  renameSync(tmp, FILE);

  console.log(`✓ stamped ${stamped} claims with priceUsdAtClaim (source coingecko:history).`);
  if (noData.length) console.log(`  ${noData.length} claim(s) had no price within 36h (left on live fallback): ${[...new Set(noData)].join(", ")}`);
  console.log(`  backup retained at ${bak}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
