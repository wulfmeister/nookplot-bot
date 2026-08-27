/**
 * Verification daily-quota allocator.
 *
 * The gateway caps verifications at 30/24h per agent. Within that budget,
 * the question is: how should we spend slots when verifications differ in
 * leverage?
 *
 * Insight: a verification on a `v2` submission (one that already has 2
 * verifications) pushes it to the 3-quorum threshold — clearing NOOK to the
 * solver, removing the submission from the queue, and contributing 3× the
 * network-unblock value of a `v0` verification. So we want to *hold* slots
 * for v2s as they appear, but not so tightly that we expire unused slots at
 * the UTC reset (selfish + wasteful).
 *
 * Algorithm — slack-based threshold:
 *   slack = (cap - used_today) - hours_left_in_utc_day
 *
 *   slack ≥ 5  → eat anything (vCount ≥ 0); we're behind even on v0s
 *   slack ≥ 0  → skip pure v0s (vCount ≥ 1)
 *   slack ≥ -3 → only near-quorum v2s (vCount ≥ 2)
 *   else       → only v2s (cap remains 2; we can't enforce v3+ alone)
 *
 * Special boundary cases:
 *   - usedToday ≥ cap → Infinity (block all)
 *   - <1h left in UTC day → 0 (free fire, don't waste)
 *
 * Reset boundary: midnight UTC (matches gateway daily epoch). Caller is
 * responsible for resetting their local count at UTC-day rollover.
 */

// NOTE (2026-08-27): the gateway cap is a ROLLING 24h window (settled — see
// quotas.ts and the index.ts rename to verifyRollingCount), while this
// threshold-release schedule still paces against hours-to-UTC-midnight. That
// approximation only mis-paces near the boundary and errs conservative;
// deliberately NOT changed in the naming cleanup (pacing math is behavior,
// not naming — and verify is ~1% of income; see the standing don't-invest
// decision). The constant name keeps "DAILY" to match the schedule it paces.
export const VERIFY_DAILY_CAP_DEFAULT = 30;

export function verifyThreshold(
  usedToday: number,
  nowMs: number,
  cap: number = VERIFY_DAILY_CAP_DEFAULT,
): number {
  const remaining = cap - usedToday;
  if (remaining <= 0) return Number.POSITIVE_INFINITY;
  const d = new Date(nowMs);
  const hourUtc = d.getUTCHours();
  const minuteUtc = d.getUTCMinutes();
  const hoursLeft = Math.max(0, 24 - hourUtc - minuteUtc / 60);
  if (hoursLeft <= 1) return 0; // final hour: clear the slots
  const slack = remaining - hoursLeft;
  if (slack >= 5) return 0;
  if (slack >= 0) return 1;
  if (slack >= -3) return 2;
  return 2; // tightest meaningful threshold (gateway quorum is 3)
}

/** Returns true if the UTC day has rolled over since `lastUtcDay`. */
export function isNewUtcDay(lastUtcDay: number, nowMs: number = Date.now()): boolean {
  return new Date(nowMs).getUTCDate() !== lastUtcDay;
}
