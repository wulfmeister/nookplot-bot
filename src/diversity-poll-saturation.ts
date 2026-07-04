/**
 * Track the rolling diversity-blocked ratio across verify polls and warn
 * once if solver-side saturation keeps starving our verify income.
 *
 * Distinct from [[skip-caches.maybeWarnDiversitySaturation]], which fires
 * on the *cache size* (the gateway-confirmed 429 path). In practice the
 * dominant skip path is the in-memory [[recentSolverVerifyCount]] >= 3 guard
 * inside index.ts — those skips never touch the cache, so cache-size never
 * crosses the threshold even when 100% of every poll's planned batch is
 * being pre-skipped on diversity grounds.
 *
 * This module measures saturation at the *poll* level: how much of the
 * planned batch was diversity-blocked before any verify attempt was made.
 * Three consecutive polls at >= 80% blocked → warn once. Re-arms when the
 * window has zero high-ratio ticks.
 *
 * Why warn at all (vs auto-widen specialization): the right response is
 * usually "wait, the 14d windows will roll off" rather than "widen domains
 * and dilute the authorship sprint." The warn surfaces the symptom; the
 * user decides whether the trade-off is worth a config change.
 */

const HISTORY_LEN = 5;
const HIGH_RATIO_THRESHOLD = 0.80;
const TICKS_TO_WARN = 3;

let recentBlockedRatios: number[] = [];
let warnedSaturation = false;

export function recordDiversityPollSaturation(ratio: number): void {
  recentBlockedRatios.push(ratio);
  if (recentBlockedRatios.length > HISTORY_LEN) {
    recentBlockedRatios = recentBlockedRatios.slice(-HISTORY_LEN);
  }
}

/** Count of recent polls where ≥ HIGH_RATIO_THRESHOLD were diversity-blocked. */
export function highRatioTickCount(): number {
  return recentBlockedRatios.filter((r) => r >= HIGH_RATIO_THRESHOLD).length;
}

export function maybeWarnDiversityPollSaturation(): void {
  if (highRatioTickCount() >= TICKS_TO_WARN && !warnedSaturation) {
    warnedSaturation = true;
    const recent = recentBlockedRatios.map((r) => `${(r * 100).toFixed(0)}%`).join(", ");
    console.warn(
      `⚠ solver diversity saturating verify polls — last ${recentBlockedRatios.length} ticks blocked: ${recent}. ` +
      `Verify budget will idle while top solvers' 14d windows clear. ` +
      `Either accept the throughput dip or widen BOT_SPECIALIZE_DOMAINS to catch fresher solvers.`,
    );
  } else if (highRatioTickCount() === 0) {
    // Re-arm once no high-ratio ticks remain in the window so a fresh spike re-fires.
    warnedSaturation = false;
  }
}

/** Test-only helper to reset module state between tests. */
export function _resetForTests(): void {
  recentBlockedRatios = [];
  warnedSaturation = false;
}
