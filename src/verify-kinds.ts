/**
 * Verify-pool kind eligibility (pure, testable). Extracted from index.ts so the
 * gate that decides WHICH submission kinds we verify can be unit-tested without
 * booting the daemon.
 */

/**
 * Code-executing verifiable kinds whose artifact can be independently re-run via
 * `rerun_submission_artifact` (the `exec` / artifactReruns lever). Other
 * verifiable kinds (crowd_jury / prediction / exact_answer) have nothing to
 * rerun, so they're never eligible for the artifact verify path.
 */
export const RERUNNABLE_KINDS = new Set(["python_tests", "javascript_tests", "replication"]);

export function isRerunnableKind(kind: string | null | undefined): boolean {
  return !!kind && RERUNNABLE_KINDS.has(kind);
}

/**
 * Is this submission eligible for our verify pool? Standard reasoning traces
 * always are. Rerun-able artifact kinds are eligible only when the experiment
 * flag (BOT_VERIFY_ARTIFACTS) is on. Everything else is excluded.
 */
export function isVerifyEligible(kind: string | null | undefined, verifyArtifacts: boolean): boolean {
  return !kind || kind === "standard" || (verifyArtifacts && isRerunnableKind(kind));
}

/** Shape returned by rerun_submission_artifact (the fields we act on). */
export interface RerunResult {
  success?: boolean;
  outcomesMatch?: boolean;
  originalOutcome?: unknown;
  rerunOutcome?: unknown;
}

export type RerunDecision =
  | { action: "verify"; correctness: number; note: string }
  | { action: "abstain"; note: string };

/**
 * Decide a deterministic verifiable submission's correctness from the INDEPENDENT
 * rerun rather than a blind 1.0. Deterministic kinds only enter the verify pool
 * after passing the gateway verifier at submit time, so the baseline is 1.0 —
 * but:
 *  - rerun reproduced the outcome (outcomesMatch === true) → confirm 1.0.
 *  - rerun did NOT reproduce (outcomesMatch === false) → ABSTAIN. We can't tell a
 *    bad submission from solver nondeterminism / an env diff, and vouching either
 *    way risks a wrong on-chain verdict — so we don't vote.
 *  - no usable rerun signal (no result, success === false, or non-boolean
 *    outcomesMatch — e.g. the rerun was rate-limited/errored) → fall back to the
 *    submit-time gate: verify at 1.0 but don't claim independent confirmation.
 */
export function decideFromRerun(rr: RerunResult | null | undefined): RerunDecision {
  if (!rr || rr.success === false || typeof rr.outcomesMatch !== "boolean") {
    return {
      action: "verify",
      correctness: 1.0,
      note: "deterministic verifier passed at submit; independent rerun inconclusive — correctness from the submit-time gate",
    };
  }
  if (rr.outcomesMatch) {
    return {
      action: "verify",
      correctness: 1.0,
      note: "independently re-ran; outcome matched the original — correctness confirmed",
    };
  }
  return {
    action: "abstain",
    note: "independent rerun did NOT reproduce the original outcome — abstaining to avoid a wrong verdict",
  };
}
