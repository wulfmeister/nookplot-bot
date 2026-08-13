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
 * This module only WARNS (log line the observer picks up). It deliberately
 * does not auto-buy credits — purchases stay manual via `npm run buy-credits`
 * (operator preference).
 */

const BASE = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";

export interface VeniceBalances {
  usd: number;
  diem: number;
  nextEpochBegins: string | null;
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
    `(2026-08-05: ~5.7h outage, ~3 slots lost).${refill} Top up manually: npm run buy-credits`
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
      data?: { balances?: { USD?: number; DIEM?: number }; nextEpochBegins?: string };
    };
    const bal = body.data?.balances;
    if (!bal) return null;
    return {
      usd: Number(bal.USD ?? 0),
      diem: Number(bal.DIEM ?? 0),
      nextEpochBegins: body.data?.nextEpochBegins ?? null,
    };
  } catch {
    return null; // network blip — next tick retries; never throw into the daemon
  }
}

// Warn once per crossing; re-arm when the balance recovers to 2x threshold
// (same pattern as the diversity-saturation warn) so a refill → re-drain
// cycle warns again instead of staying silent forever.
let warnedLowBalance = false;

export async function maybeWarnVeniceBalance(): Promise<void> {
  const b = await fetchVeniceBalances();
  if (!b) return;
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
