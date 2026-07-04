/**
 * Pure-function helpers for the verify-loop's per-poll budget decisions.
 *
 * Extracted out of src/index.ts so the math is unit-testable; the previous
 * inline coarse ternary (`remaining > cap/2 ? 8 : 5`) had a visible cliff
 * — at remaining=14 you got 5, at remaining=15 you got 8 — that left
 * throughput on the table mid-day.
 */

/**
 * How many verifies to attempt this poll.
 *
 * Amortizes the remaining daily budget across the polls expected before
 * the UTC reset, with a hard floor of `MIN_BATCH` so we never idle a poll
 * when there's work to do, and a hard ceiling of `remaining` (can't burn
 * past the cap).
 *
 * @param remaining how many verifies are left in the daily cap
 * @param pollsRemaining how many poll cycles we expect before UTC reset
 *                       (clamped to 1 to avoid div-by-zero at end-of-day)
 * @param minBatch floor — default 5
 */
export function computeVerifyBatch(
  remaining: number,
  pollsRemaining: number,
  minBatch = 5,
): number {
  if (remaining <= 0) return 0;
  const polls = Math.max(1, Math.floor(pollsRemaining));
  const fair = Math.ceil(remaining / polls);
  // Take the larger of {floor, fair-share}, bounded by what's actually left.
  return Math.min(remaining, Math.max(minBatch, fair));
}

/**
 * How many poll cycles remain before the UTC daily reset, given the poll
 * interval. Floor at 1 so callers don't blow up at end-of-day; that also
 * matches the intent of "burn the rest now" when there's no time to wait.
 */
export function pollsRemainingBeforeUtcReset(
  hoursLeftUtc: number,
  pollIntervalMinutes: number,
): number {
  if (!Number.isFinite(hoursLeftUtc) || hoursLeftUtc <= 0) return 1;
  if (pollIntervalMinutes <= 0) return 1;
  return Math.max(1, Math.floor((hoursLeftUtc * 60) / pollIntervalMinutes));
}
