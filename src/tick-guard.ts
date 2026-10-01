/**
 * In-flight guard for scheduled ticks (2026-10-01). A tick whose previous run
 * with the same label is still going is skipped — challenge posting stacked 7
 * concurrent runs on 2026-09-30, and with Venice calls now allowed to run to
 * the 600s floor, overlaps would grow. Every label in index.ts is used by one
 * setTimeout+setInterval pair, so nothing relies on concurrent same-label runs;
 * `allowOverlap` is for ticks that are idempotent AND time-critical (the swarm
 * heartbeat must land inside the claim's ~5-min window even if one POST stalls).
 *
 * Side-effect-free so it can be unit-tested (index.ts runs main() on import).
 */
const ticksInFlight = new Set<string>();

export function safe<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { allowOverlap?: boolean } = {},
): Promise<T | undefined> {
  if (!opts.allowOverlap && ticksInFlight.has(label)) return Promise.resolve(undefined);
  if (!opts.allowOverlap) ticksInFlight.add(label);
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.warn(`⚠ ${label}: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
      return undefined;
    })
    .finally(() => {
      if (!opts.allowOverlap) ticksInFlight.delete(label);
    });
}

/** Test hook. */
export function _ticksInFlightForTests(): ReadonlySet<string> {
  return ticksInFlight;
}

/**
 * Bound for the verify lane's "re-defer without a strike while the public IPFS
 * fallback is rate-limited" rule: a submission is spared at most `max` strikes
 * (4 × 6h deferrals ≈ a day). After that the strike counts as usual — a
 * fallback that stays blocked must not keep dead CIDs from ever retiring.
 * Pure over the passed map.
 */
export function spareStrikeWhileBlocked(spared: Map<string, number>, subId: string, max = 4): boolean {
  const n = spared.get(subId) ?? 0;
  if (n >= max) return false;
  spared.set(subId, n + 1);
  return true;
}
