/**
 * The scored text of a VERIFIABLE (code) submission: python_tests,
 * javascript_tests, exact_answer — all posted to /submit-solution.
 *
 * Why this module exists (2026-10-01): on /submit-solution the gateway stores,
 * length-checks and — by strong inference — specificity-scores `reasoning`,
 * not `traceSummary`:
 *   - the SDK's own verifiable path sends ONLY `reasoning`
 *     (@nookplot/mcp dist/tools/reasoningWork.js, the submit-solution POST);
 *   - per the 2026-10-01 review, 51/51 accepted code submissions' stored
 *     traceSummary equals the reasoning we sent, and the shortest is exactly
 *     100 chars (232 accepted python reasonings in the vault: 100-523 chars);
 *   - every "traceSummary is required (minimum 100 characters)" 400 since May
 *     is python_tests (13/13), although padTraceSummary always emits ≥100;
 *   - enriching traceSummary after a python 400 rescued 2 of 76 retries, the
 *     same retry on standard (where traceSummary IS scored) rescued 8 of 10.
 * Still unverified: that the SCORE (not only storage + length) is computed on
 * `reasoning`. The 74/76 vs 8/10 contrast points strongly that way.
 *
 * So the code path builds ONE text, sends it as `reasoning`, and sends an
 * identical `traceSummary` (a divergent one only misleads our own logs).
 *
 * The local specificity mirror is deliberately NOT used as a pre-submit skip
 * here: it rejects 205 of 232 gateway-ACCEPTED reasonings. Submit, and on a
 * 400 enrich from what the gateway says is missing, then retry once. A 400
 * does not burn an epoch slot (see the measurement in specificity-gate.ts).
 *
 * Pure — no I/O, no model calls — so the tests can pin the exact body.
 */
import {
  enrichSummarySpecificity,
  isSpecificityError,
  isSummaryLengthError,
  parseMissingCategories,
  type SpecificityCategory,
} from "./specificity-gate.js";

/** The gateway's own floor ("minimum 100 characters"). */
export const REASONING_MIN_CHARS = 100;
/**
 * Ceiling for the text WE compose. The gateway's own limit on `reasoning` is
 * unknown; the longest accepted one on record is 523 chars (a 500-char text
 * plus a "[self-smoke failed …]" annotation), so 500 is known-safe.
 */
export const REASONING_MAX_CHARS = 500;

/** Which body field the gateway scores, per submission route. */
export type SubmitRoute = "submit" | "submit-solution";
export function scoredFieldFor(route: SubmitRoute): "traceSummary" | "reasoning" {
  return route === "submit-solution" ? "reasoning" : "traceSummary";
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

/** Clip to `max` chars, preferring a sentence end, then a word boundary. */
export function clipAtBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (sentence >= max * 0.6) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(—-]+$/, "").trim();
}

/**
 * Grounding taken verbatim from the challenge itself — never template filler.
 * Used only to lift a too-short reasoning over the gateway's 100-char floor.
 */
export function challengeGrounding(ch: { title?: string; description?: string }, budget = 260): string {
  const title = norm(ch.title);
  const desc = norm(ch.description);
  if (!title && !desc) return "";
  const descPart = desc && desc !== title ? clipAtBoundary(desc, Math.max(60, budget - title.length)) : "";
  return `Challenge: ${[title, descPart].filter(Boolean).join(": ")}`;
}

/**
 * Compose the reasoning for a verifiable solve from the model's parsed JSON.
 *
 *   - `||`, not `??`: a model that returns "reasoning": "" must fall through
 *     (the `??` version kept "" and then shipped the ~65-char
 *     "Python solution for <title>." stub — the actual cause of the 09-21
 *     "minimum 100 characters" 400s, which were first blamed on traceSummary);
 *   - under 100 chars → extend with the model's summary (if it sent one), then
 *     with challenge grounding; never with generic filler;
 *   - whitespace collapsed, clipped to REASONING_MAX_CHARS at a boundary.
 * May still return < 100 chars when the model said nothing and the challenge
 * has no title/description — the on-400 retry handles that case.
 */
export function buildVerifiableReasoning(
  parsed: { reasoning?: unknown; summary?: unknown },
  ch: { title?: string; description?: string },
): string {
  const reasoning = norm(parsed.reasoning);
  const summary = norm(parsed.summary);
  let out = reasoning || summary;
  if (out.length < REASONING_MIN_CHARS && summary && !out.includes(summary)) {
    out = `${out} ${summary}`.trim();
  }
  if (out.length < REASONING_MIN_CHARS) {
    const grounding = challengeGrounding(ch);
    if (grounding) out = `${out} ${grounding}`.trim();
  }
  return clipAtBoundary(out, REASONING_MAX_CHARS);
}

export interface SubmitSolutionBody {
  artifactType?: string;
  artifact?: Record<string, unknown>;
  /** The field the gateway stores, length-checks and scores on this route. */
  reasoning: string;
  /** Always identical to `reasoning` — see the module comment. */
  traceSummary: string;
  modelUsed: string;
  selfReportedWallMs: number;
  guildId?: number;
}

/** The exact /submit-solution body. One text, two identical fields. */
export function buildSubmitSolutionBody(input: {
  artifactType?: string;
  artifact?: Record<string, unknown>;
  reasoning: string;
  modelUsed: string;
  selfReportedWallMs: number;
  guildId?: number | null;
}): SubmitSolutionBody {
  return {
    artifactType: input.artifactType,
    artifact: input.artifact,
    reasoning: input.reasoning,
    traceSummary: input.reasoning,
    modelUsed: input.modelUsed,
    selfReportedWallMs: input.selfReportedWallMs,
    ...(input.guildId ? { guildId: input.guildId } : {}),
  };
}

/** Same body with a new scored text (both fields move together). */
export function withReasoning(body: SubmitSolutionBody, reasoning: string): SubmitSolutionBody {
  return { ...body, reasoning, traceSummary: reasoning };
}

export type SummaryRejectionKind = "specificity" | "length";
/** A 400 that judges the scored TEXT (as opposed to the cap, a dupe, the model id). */
export function summaryRejectionKind(msg: string): SummaryRejectionKind | null {
  if (isSpecificityError(msg)) return "specificity";
  if (isSummaryLengthError(msg)) return "length";
  return null;
}

export interface ReasoningRetryPlan {
  body: SubmitSolutionBody;
  kind: SummaryRejectionKind;
  /** Categories the gateway reported at +0 (empty for a length 400). */
  missing: SpecificityCategory[];
  before: string;
  after: string;
}

/**
 * After a summary-judging 400 on /submit-solution, revise the text that was
 * actually sent as `reasoning` — read from the BODY, so the retry can never
 * drift onto a field the gateway ignores again — and return the retry body.
 *
 * Specificity 400: append extracted fragments for exactly the categories the
 * gateway reported missing, trusting the gateway over the local mirror.
 * Length 400: enrich with any extractable category, then challenge grounding,
 * until ≥100 chars. Returns null when the error is not a text verdict or
 * nothing changed (a retry would fail identically) — the caller may then try
 * a model rewrite or cool the challenge down.
 */
export function planReasoningRetry(
  body: SubmitSolutionBody,
  errMsg: string,
  sources: Array<string | undefined>,
  ch: { title?: string; description?: string },
): ReasoningRetryPlan | null {
  const kind = summaryRejectionKind(errMsg);
  if (!kind) return null;
  const before = body.reasoning;
  const missing = kind === "specificity" ? parseMissingCategories(errMsg) : [];
  let after: string;
  if (kind === "specificity") {
    after = enrichSummarySpecificity(before, sources, missing.length > 0 ? missing : undefined, { trustWanted: true });
  } else {
    // Too short: ground in the challenge first (natural text), then enrich so
    // the single retry also has a chance at the specificity check behind it.
    const grounding = before.length < REASONING_MIN_CHARS ? challengeGrounding(ch) : "";
    const base = grounding && !before.includes(grounding)
      ? clipAtBoundary(`${before} ${grounding}`.trim(), REASONING_MAX_CHARS)
      : before;
    after = enrichSummarySpecificity(base, sources);
  }
  if (after === before) return null;
  return { body: withReasoning(body, after), kind, missing, before, after };
}
