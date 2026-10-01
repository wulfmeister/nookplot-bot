/**
 * Venice credit-balance watch.
 *
 * Why: on 2026-08-05 the Venice account ran dry mid-epoch (DIEM allowance
 * exhausted, USD already negative) and every inference call 402'd for ~5.7h —
 * ~3 mining slots (~90-100k NOOK) lost, 24 attempts burned, and nothing
 * surfaced it until a log dig three days later. Venice exposes balances on
 * GET /api_keys/rate_limits: `balances: { USD, DIEM }` plus
 * `nextEpochBegins` (the daily DIEM refill boundary), so the outage is
 * predictable ~an hour out.
 *
 * This module WARNS (log line the observer picks up) and feeds readings to
 * the Venice stand-down (below). It deliberately does not auto-buy credits —
 * purchases stay manual via `npm run buy-credits` (operator preference).
 *
 * BLIND SPOT (2026-10-01): these are ACCOUNT balances. A spend limit set on the
 * API KEY ("API key DIEM spend limit exceeded") 402s every call while the
 * account still holds DIEM, and nothing here can see it. The process-wide
 * stand-down (venice-breaker.ts) reacts to that 402 instead. This watch hands
 * it `nextEpochBegins` so the pause ends at the real refill time, and every
 * reading so a top-up (or `accessPermitted` flipping back to true) lifts the
 * pause within one tick instead of at the refill.
 */

import { join } from "node:path";
import { NOOK_DIR, appendJsonl } from "./util.js";
import { noteVeniceBalanceReading, noteVeniceNextEpoch } from "./venice-breaker.js";

const BASE = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";

/**
 * Every 30-min reading, persisted (2026-10-01). Until now a reading was only
 * logged when it crossed the low threshold, so there was no balance series to
 * check the cost ledger against: neither whether the estimates match real
 * drain, nor whether Venice bills a generation the client abandoned (compare
 * the drop across a window holding a "timeout" row in venice-costs.jsonl with
 * that window's ledger sum). ~48 short rows a day.
 */
export const BALANCE_LOG = join(NOOK_DIR, "venice-balance.jsonl");

export interface VeniceBalances {
  usd: number;
  diem: number;
  nextEpochBegins: string | null;
  /**
   * rate_limits' `accessPermitted` (null when absent). Read false on 2026-09-28
   * while the key 402'd at $0. Whether it tracks a per-key spend limit is
   * UNVERIFIED; it is logged to BALANCE_LOG so that can be checked from data.
   */
  accessPermitted?: boolean | null;
}

/** Spendable balance: DIEM plus any positive USD (negative USD is debt Venice
 *  already collected against — it can't fund calls). */
export function spendableBalance(b: VeniceBalances): number {
  return b.diem + Math.max(0, b.usd);
}

export const BALANCE_WARN_THRESHOLD = Number(process.env.BOT_VENICE_BALANCE_WARN_AT ?? 10);

/**
 * Warning text when the account is close to 402-ing, else null. Threshold 10
 * (~1.5 days of the ~$5-7/day burn) by default; the message carries the DIEM
 * refill time because that's the answer to "how long until this self-heals".
 * Pure — testable.
 */
export function assessVeniceBalance(
  b: VeniceBalances,
  threshold = BALANCE_WARN_THRESHOLD,
): string | null {
  const spendable = spendableBalance(b);
  if (spendable >= threshold) return null;
  const refill = b.nextEpochBegins ? ` DIEM refills at ${b.nextEpochBegins}.` : "";
  return (
    `Venice balance low: ${spendable.toFixed(2)} spendable (DIEM ${b.diem.toFixed(2)}, ` +
    `USD ${b.usd.toFixed(2)}) < ${threshold} — inference will 402 when it hits zero ` +
    `(2026-08-05: ~5.7h outage, ~3 slots lost).${refill} Top up manually: npm run buy-credits. ` +
    `This reads account balances only: it cannot see a per-API-key DIEM/USD spend limit, which 402s every call ` +
    `even while the account has balance (2026-10-01).`
  );
}

export async function fetchVeniceBalances(): Promise<VeniceBalances | null> {
  const key = process.env.VENICE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`${BASE}/api_keys/rate_limits`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      data?: { balances?: { USD?: number; DIEM?: number }; nextEpochBegins?: string; accessPermitted?: unknown };
      accessPermitted?: unknown;
    };
    const bal = body.data?.balances;
    if (!bal) return null;
    const ap = body.data?.accessPermitted ?? body.accessPermitted;
    return {
      usd: Number(bal.USD ?? 0),
      diem: Number(bal.DIEM ?? 0),
      nextEpochBegins: body.data?.nextEpochBegins ?? null,
      accessPermitted: typeof ap === "boolean" ? ap : null,
    };
  } catch {
    return null; // network blip — next tick retries; never throw into the daemon
  }
}

// Warn once per crossing; re-arm when the balance recovers to 2x threshold
// (same pattern as the diversity-saturation warn) so a refill → re-drain
// cycle warns again instead of staying silent forever.
let warnedLowBalance = false;

/**
 * Hand one reading to the Venice stand-down: the refill time, then the balance
 * itself, which can lift a pause early (venice-breaker.ts). Returns true when
 * it lifted. No disk or network.
 */
export function feedVeniceBreaker(
  b: VeniceBalances,
  fetchedAtMs: number,
  nowMs = Date.now(),
  log?: (line: string) => void,
): boolean {
  noteVeniceNextEpoch(b.nextEpochBegins);
  return noteVeniceBalanceReading(
    { spendable: spendableBalance(b), accessPermitted: b.accessPermitted ?? null, fetchedAtMs },
    nowMs,
    log,
  );
}

export async function maybeWarnVeniceBalance(): Promise<void> {
  // Taken before the request: a reading only counts as post-refusal if it
  // was SENT after the refusal.
  const fetchedAtMs = Date.now();
  const b = await fetchVeniceBalances();
  if (!b) return;
  try {
    feedVeniceBreaker(b, fetchedAtMs);
  } catch { /* the breaker must never break the tick */ }
  try {
    appendJsonl(BALANCE_LOG, {
      ts: new Date().toISOString(),
      usd: b.usd,
      diem: b.diem,
      nextEpochBegins: b.nextEpochBegins,
      accessPermitted: b.accessPermitted ?? null,
    });
  } catch { /* telemetry must never break the tick */ }
  const warning = assessVeniceBalance(b);
  if (warning) {
    if (!warnedLowBalance) {
      warnedLowBalance = true;
      console.warn(`💸 ${warning}`);
    }
  } else if (spendableBalance(b) >= BALANCE_WARN_THRESHOLD * 2) {
    warnedLowBalance = false;
  }
}
