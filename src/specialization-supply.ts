/**
 * Track the rolling specialization-match ratio across mining polls and
 * warn once if the narrow keeps under-supplying us with eligible work.
 *
 * Reason: when BOT_SPECIALIZE_DOMAINS is set narrow (e.g. just
 * "distributed-systems"), we sort matching challenges first but still
 * accept off-spec work. If matched/eligible is consistently low across
 * multiple polls, the narrow is starving the loop — we should know.
 */

const HISTORY_LEN = 5;
const LOW_RATIO_THRESHOLD = 0.30;
const TICKS_TO_WARN = 3;

let recentMatchRatios: number[] = [];
let warnedUnderSupply = false;

export function recordSpecializationMatch(ratio: number): void {
  recentMatchRatios.push(ratio);
  if (recentMatchRatios.length > HISTORY_LEN) {
    recentMatchRatios = recentMatchRatios.slice(-HISTORY_LEN);
  }
}

/**
 * Returns the count of recent ticks where match-ratio was below the
 * low-supply threshold. Pure function over module state — testable.
 */
export function lowRatioTickCount(): number {
  return recentMatchRatios.filter((r) => r < LOW_RATIO_THRESHOLD).length;
}

export function maybeWarnSpecializationUnderSupply(targets: string[]): void {
  if (lowRatioTickCount() >= TICKS_TO_WARN && !warnedUnderSupply) {
    warnedUnderSupply = true;
    const recent = recentMatchRatios.map((r) => `${(r * 100).toFixed(0)}%`).join(", ");
    console.warn(
      `⚠ specialization [${targets.join(",")}] is under-supplying eligible work — ` +
      `last ${recentMatchRatios.length} ticks: ${recent}. ` +
      `Consider widening BOT_SPECIALIZE_DOMAINS or accepting the slower 50-solve cadence.`,
    );
  } else if (lowRatioTickCount() === 0) {
    // Re-arm once supply recovers (no low ticks in the window) so a
    // future drop produces a fresh warn.
    warnedUnderSupply = false;
  }
}

/** Test-only helper to reset module state between tests. */
export function _resetForTests(): void {
  recentMatchRatios = [];
  warnedUnderSupply = false;
}
