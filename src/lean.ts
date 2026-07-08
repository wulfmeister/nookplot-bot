/**
 * Lean profit mode (`BOT_LEAN=1`).
 *
 * Runs ONLY the net-positive loops — the poster-royalty engine, reward
 * collection, and (near-)zero-inference housekeeping/observability — and skips
 * the inference "grind": mining and verification at cap, bounty/project/peer
 * drafting, social, predictions, self-observation, paper reproduction, etc.
 *
 * Why: measured economics show the poster royalty (~250k NOOK/day off a single
 * cheap challenge draft) plus passive citation yield nets positive, while
 * running every track at cap costs far more Venice inference than the extra
 * NOOK it earns. Lean mode is the "leave it running cheaply and it earns"
 * profile.
 *
 * PREREQUISITE: the poster grounds each daily challenge in your accumulated
 * knowledge-vault, so lean earns only once the vault has content. Seed it first
 * — let the agent run normally for a while, or load a `BOT_FORGE_PRESET` — then
 * switch to lean to coast. A brand-new empty agent has nothing to post yet.
 *
 * Default OFF — when unset, `runsInLean()` is always true, so behavior is
 * byte-identical to before this mode existed.
 */

/**
 * Every track key a `runsInLean(...)` guard is called with. Typing the guard to
 * this union makes a call-site typo a COMPILE error instead of a silently
 * mis-gated loop.
 */
export type LeanTrack =
  // kept in lean (net-positive or zero-LLM; called unconditionally in index.ts,
  // listed here so they're valid args and covered by tests)
  | "claimRewards"
  | "weeklyRewards"
  | "networkStatus"
  | "citationVelocity"
  | "diagnostics"
  | "ecosystem"
  // skipped in lean (the inference "grind")
  | "bountyLifecycle"
  | "knowledgePublish"
  | "verification"
  | "mining"
  | "crowdJury"
  | "learnings"
  | "predictions"
  | "social"
  | "engagement"
  | "observation"
  | "paperReproduction"
  | "socialEngagement"
  | "bounty"
  | "clarifications"
  | "swarms"
  | "teaching"
  | "attention"
  | "draftingAndDormant";

/** Whether lean profit mode is active (read live so it's test-friendly). */
export function isLean(): boolean {
  return process.env.BOT_LEAN === "1";
}

/**
 * The tracks that KEEP running under lean mode — the net-positive royalty
 * engine, reward collection, and free read-only housekeeping. The `weeklyRewards`
 * wrapper also bundles inference-y drafting ticks, which are gated OFF separately
 * inside startWeeklyRewardsLoop (the "draftingAndDormant" guard). Anything not
 * in this set is skipped while lean.
 */
export const LEAN_KEEP: ReadonlySet<LeanTrack> = new Set<LeanTrack>([
  "claimRewards",
  "weeklyRewards",
  "networkStatus",
  "citationVelocity",
  "diagnostics",
  "ecosystem",
]);

/**
 * Whether `track` should run given the current mode.
 * Off-lean → always true (byte-identical to pre-lean behavior).
 * On-lean → only the LEAN_KEEP allowlist runs.
 */
export function runsInLean(track: LeanTrack): boolean {
  return !isLean() || LEAN_KEEP.has(track);
}

/** One-line boot banner summarizing lean mode (empty string when it's off). */
export function leanBanner(): string {
  if (!isLean()) return "";
  return (
    "🍃 BOT_LEAN=1 — lean profit mode: only the poster-royalty engine, reward " +
    "claims, and low-cost housekeeping run; the inference grind (mining, " +
    "verification, drafting, social, self-observe) is skipped and any residual " +
    "inference uses the cheapest model. Near-passive earning, minimal Venice spend."
  );
}
