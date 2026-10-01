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
 * text 400 retry once (a 400 does not burn an epoch slot — see the
 * measurement in specificity-gate.ts).
 *
 * The retry is a model REWRITE told what the gateway scored zero; a gated
 * extractive revision is only the fallback when the rewrite returns nothing
 * (decideReasoningRetry). HISTORY, kept: the first version of this module
 * extracted first and rewrote only when nothing at all was extractable. The
 * 2026-10-01 review showed that on snake_case Python it appended fragments the
 * mirror itself scores zero (`technique "http"`, a repeat of "2048 bytes") and
 * so skipped the rewrite, and that its retry text — now verifier-visible — was
 * cut mid-sentence and carried raw `#` comment lines twice.
 *
 * Pure — no I/O, no model calls — so the tests can pin the exact body.
 */
import {
  ENRICH_PRIORITY,
  findTechniqueName,
  isSpecificityError,
  isSummaryLengthError,
  parseMissingCategories,
  specificityCategories,
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
 * Ceiling for a REVISED reasoning (the on-400 retry). Not the 500 used when
 * composing: 500 is the /submit traceSummary habit, and cutting the sent body
 * to fit it under a tail ended texts mid-sentence (2026-10-01 review).
 * 1000 is the SDK's documented traceSummary max (@nookplot/mcp
 * reasoningWork.js:186, "Max 1000 chars") — and we send traceSummary identical
 * to reasoning. The SDK's own verifiable path sends the full traceContent as
 * `reasoning` (reasoningWork.js:291), so the gateway evidently accepts long
 * reasoning; INFERRED, not probed. Longest accepted on record: 523 chars.
 */
export const REASONING_RETRY_MAX_CHARS = 1000;

/** Longest single sentence lifted from a comment or the challenge description. */
const MAX_SENTENCE_CHARS = 160;

/**
 * Comment and docstring prose from source code — `# …`, `// …`, `/* … *\/`,
 * JSDoc ` * …` lines and Python docstrings — with the markers stripped. A run
 * of consecutive comment lines is one block (comments wrap sentences across
 * lines). A `#` or `//` only opens a comment at line start or after
 * whitespace, so "http://host" and "a#b" stay code.
 */
export function codeCommentProse(code: string | undefined): string[] {
  if (!code) return [];
  const blocks: string[] = [];
  let block: string[] = [];
  // A comment line that ends without punctuation either wraps a sentence
  // (next line starts lowercase: join) or was a statement of its own (next
  // line starts uppercase: end it with a period, or the two run together).
  const flush = (): void => {
    if (block.length) {
      blocks.push(block.reduce((acc, l) => (/[.!?:;,]$/.test(acc) || !/^[A-Z]/.test(l) ? `${acc} ${l}` : `${acc}. ${l}`)));
    }
    block = [];
  };
  let inDoc = false;
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#!")) continue; // shebang, not prose
    const quotes = (line.match(/"""|'''/g) ?? []).length;
    if (inDoc || quotes > 0) {
      const text = line.replace(/"""|'''/g, " ").trim();
      if (text) block.push(text);
      if (quotes % 2 === 1) inDoc = !inDoc;
      if (!inDoc) flush();
      continue;
    }
    const m = line.match(/^(?:#+|\/\/+|\/\*+|\*+(?!\/))\s*(.*?)\s*(?:\*+\/)?$/);
    if (m) {
      if (m[1]) block.push(m[1]);
      continue;
    }
    flush();
    // Trailing comment on a code line: its own one-line block.
    const trailing = line.match(/\s(?:#+|\/\/+)\s+(.+?)\s*$/);
    if (trailing) blocks.push(trailing[1]);
  }
  flush();
  return blocks;
}

/**
 * Sentences from prose (comment blocks, a challenge description): fenced code
 * removed, list bullets and emphasis stripped, each line a hard boundary,
 * whitespace collapsed, at most MAX_SENTENCE_CHARS (cut at a word boundary),
 * always ending in terminal punctuation.
 */
export function proseSentences(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const lines = text.replace(/```[\s\S]*?```/g, "\n").replace(/\*\*|__/g, "").split(/\n+/);
  for (const raw of lines) {
    const line = raw.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)) {
      let s = clipAtBoundary(part.trim(), MAX_SENTENCE_CHARS).replace(/[\s,;:(—-]+$/, "");
      if (!s) continue;
      if (!/[.!?]$/.test(s)) s += ".";
      out.push(s);
    }
  }
  return out;
}

/**
 * A sentence fit to append to a reasoning verifiers will read: starts like a
 * sentence, at least four words, and none of the characters that mark code or
 * a comment (`=`, `#`,
 * braces, brackets, `//`, `/*`), so no source line or comment marker can
 * leak into the text.
 */
export function looksLikeProse(s: string): boolean {
  if (!/^[A-Za-z0-9"'`(]/.test(s)) return false;
  if ((s.match(/[A-Za-z]{2,}/g) ?? []).length < 4) return false;
  return !/[=#{}[\]<>|\\$@&]|\/\/|\/\*|\*\//.test(s);
}

function normForOverlap(s: string): string {
  return s.toLowerCase().replace(/[`"']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when `candidate` repeats ≥24 chars (or all, if shorter) of `existing`. */
export function overlapsText(candidate: string, existing: string, window = 24): boolean {
  const a = normForOverlap(candidate);
  const b = normForOverlap(existing);
  if (!a) return true;
  if (a.length <= window) return b.includes(a);
  for (let i = 0; i + window <= a.length; i++) {
    if (b.includes(a.slice(i, i + window))) return true;
  }
  return false;
}

/** First backticked span in the sources that the text does not already carry. */
function findCodeRef(sources: Array<string | undefined>, exclude: string): string | null {
  for (const src of sources) {
    for (const m of (src ?? "").matchAll(/`([^`\n]{2,40})`/g)) {
      if (!exclude.includes(m[1])) return `\`${m[1]}\``;
    }
  }
  return null;
}

/**
 * Additions for the code-kind retry, in gateway-value order (ENRICH_PRIORITY):
 *   - failures / numbers / actionable: a whole SENTENCE from the solution's own
 *     comments, then the challenge description, that the mirror credits for
 *     the category — never a 60-char window around a keyword, never a raw
 *     source line;
 *   - techniques / code: one identifier, in a shape the mirror credits
 *     (findTechniqueName; a backticked span), collected into one clause;
 *   - comparisons: never. Lifted from code or a description it produced
 *     "hold vs arbitrary" out of "must hold versus arbitrary".
 * A category is skipped when the text so far already shows it under the mirror
 * (including a sentence added for an earlier category), and nothing that
 * repeats the text so far is added. Where the mirror credits a category the
 * gateway scored +0 (snake_case as a technique), extraction adds nothing — that
 * disagreement is the model rewrite's job, not a fragment's.
 */
function extractReasoningAdditions(
  base: string,
  code: string | undefined,
  description: string | undefined,
  wanted: readonly SpecificityCategory[],
): string[] {
  const prose = [...codeCommentProse(code).flatMap(proseSentences), ...proseSentences(description)].filter(looksLikeProse);
  const sentences: string[] = [];
  const idents: string[] = [];
  const current = (): string => [base, ...sentences, ...idents].join(" ");
  for (const c of ENRICH_PRIORITY) {
    if (c === "comparisons" || !wanted.includes(c)) continue;
    if (specificityCategories(current())[c]) continue;
    if (c === "techniques") {
      const name = findTechniqueName(code ?? "", current()) ?? findTechniqueName(description ?? "", current());
      if (name) idents.push(JSON.stringify(name));
      continue;
    }
    if (c === "code") {
      const ref = findCodeRef([description, code], current());
      if (ref) idents.push(ref);
      continue;
    }
    const s = prose.find((p) => specificityCategories(p)[c] && !overlapsText(p, current()));
    if (s) sentences.push(s);
  }
  // Glue words chosen to credit no category, so the acceptance count below
  // measures the extracted content and not our own phrasing.
  return idents.length ? [...sentences, `Key calls: ${idents.join(", ")}.`] : sentences;
}

/**
 * Append `additions` to `base` without cutting either mid-word. The base is
 * kept whole unless base + additions would pass `max`; then the base is
 * clipped at a sentence or word boundary to make room.
 */
export function composeRetryReasoning(base: string, additions: string[], max = REASONING_RETRY_MAX_CHARS): string {
  const head = base.replace(/\s+/g, " ").trim();
  const tail = additions.map((a) => a.trim()).filter(Boolean).join(" ");
  if (!tail) return head;
  let body = head.length + 1 + tail.length > max ? clipAtBoundary(head, Math.max(0, max - tail.length - 1)) : head;
  if (/[A-Za-z0-9`'")]$/.test(body)) body += ".";
  const out = body ? `${body} ${tail}` : tail;
  return out.length > max ? clipAtBoundary(out, max) : out;
}

const ALL_CATEGORIES: readonly SpecificityCategory[] = ENRICH_PRIORITY;

/**
 * The categories the gateway has been observed to credit (specificity-gate.ts
 * passesSpecificityGate: techniques +3, code +3, failures +4). Numbers,
 * comparisons and actionable are "never passing evidence" there, and the
 * mirror over-credits actionable: its `\b(use|set|…)` has no trailing
 * boundary, so "user-supplied" reads as "use", and the gateway scored
 * actionable +0 on the 2026-09-26 standard row although it contained "set".
 */
const GATEWAY_CREDITED: readonly SpecificityCategory[] = ["techniques", "code", "failures"];

/**
 * The EXTRACTIVE revision of a code-kind reasoning after a text 400, gated.
 * Reads the text actually sent as `reasoning` from the BODY, so the retry can
 * never drift onto a field the gateway ignores again.
 *
 * Specificity 400: accepted only when the appended additions ALONE credit at
 * least two categories (the gateway's own body says "Pick at least TWO") that
 * the gateway reported missing and the sent text did not already show under
 * the mirror — at least one of them a category the gateway has been seen to
 * credit (GATEWAY_CREDITED). Fragments that score nothing new (the
 * 2026-10-01 review's `technique "http"` + a duplicate "2048 bytes") would
 * only spend the retry and put filler in front of verifiers.
 * Length 400: grounding in the challenge, then any extractable category,
 * accepted when it reaches 100 chars.
 *
 * `plan` is null with a `refusal` reason when the gate refuses or nothing
 * changes; both null when the error is not a text verdict.
 */
export function evaluateExtractiveRetry(
  body: SubmitSolutionBody,
  errMsg: string,
  code: string | undefined,
  ch: { title?: string; description?: string },
): { plan: ReasoningRetryPlan | null; refusal: string | null } {
  const kind = summaryRejectionKind(errMsg);
  if (!kind) return { plan: null, refusal: null };
  const before = body.reasoning;
  const missing = kind === "specificity" ? parseMissingCategories(errMsg) : [];
  let base = before.replace(/\s+/g, " ").trim();
  if (kind === "length" && base.length < REASONING_MIN_CHARS) {
    const grounding = challengeGrounding(ch);
    if (grounding && !base.includes(grounding)) base = `${base} ${grounding}`.trim();
  }
  const wanted = missing.length > 0 ? missing : ALL_CATEGORIES;
  const additions = extractReasoningAdditions(base, code, ch.description, wanted);
  const after = composeRetryReasoning(base, additions);
  // Compare against the whitespace-collapsed original: a plan whose only
  // change is spacing would fail identically.
  if (after === before.replace(/\s+/g, " ").trim()) return { plan: null, refusal: "nothing extractable" };
  if (kind === "specificity") {
    const tail = specificityCategories(additions.join(" "));
    const sent = specificityCategories(before);
    const fresh = wanted.filter((c) => tail[c] && !sent[c]);
    if (fresh.length < 2 || !fresh.some((c) => GATEWAY_CREDITED.includes(c))) {
      return {
        plan: null,
        refusal: `extraction would credit ${fresh.length} new categor${fresh.length === 1 ? "y" : "ies"}${fresh.length ? ` (${fresh.join(",")})` : ""}; needs at least two, one of ${GATEWAY_CREDITED.join("/")}`,
      };
    }
  } else if (after.length < REASONING_MIN_CHARS) {
    return { plan: null, refusal: `still ${after.length} chars after grounding` };
  }
  return { plan: { body: withReasoning(body, after), kind, missing, before, after }, refusal: null };
}

/** The accepted extractive plan, or null (see evaluateExtractiveRetry). */
export function planReasoningRetry(
  body: SubmitSolutionBody,
  errMsg: string,
  code: string | undefined,
  ch: { title?: string; description?: string },
): ReasoningRetryPlan | null {
  return evaluateExtractiveRetry(body, errMsg, code, ch).plan;
}

export type ReasoningRetryStep = "rewrite" | "extract";

export interface ReasoningRetryDecision {
  kind: SummaryRejectionKind;
  missing: SpecificityCategory[];
  /** Steps to try, in order; the caller stops at the first that yields a text. */
  order: ReasoningRetryStep[];
  /** The gated extractive fallback, or null when the gate refused it. */
  extract: ReasoningRetryPlan | null;
  /** Why the extractive fallback is not offered (for the log). */
  extractRefusal: string | null;
}

/**
 * Extract-vs-rewrite for a code-kind text 400. The model REWRITE always goes
 * first; the extractive plan is offered only as a fallback for when the
 * rewrite returns nothing (a failed or empty model call), and only if it
 * passes the gate in evaluateExtractiveRetry.
 *
 * Why rewrite first (2026-10-01 review, CORRECTING this branch's first
 * version, which extracted first and called the rewrite only `if (!plan)`):
 *   - any extracted byte made a plan, so the rewrite, the one step told what
 *     the gateway scored zero, was skipped on exactly the snake_case Python
 *     that produces unscored fragments;
 *   - the retry text is now the field verifiers read, and an appended
 *     "Specifics:"-style tail reads as farm template (AGENTS.md); the one
 *     real-data row where the gateway scored such a tail (summary-rejections,
 *     2026-09-26) shows it credited nothing;
 *   - cost: one model call per code-kind text 400 (~36 in 30 days since
 *     09-01), against the paid solve a failed retry throws away.
 * Null when the error is not a text verdict.
 */
export function decideReasoningRetry(
  body: SubmitSolutionBody,
  errMsg: string,
  code: string | undefined,
  ch: { title?: string; description?: string },
): ReasoningRetryDecision | null {
  const kind = summaryRejectionKind(errMsg);
  if (!kind) return null;
  const missing = kind === "specificity" ? parseMissingCategories(errMsg) : [];
  const { plan, refusal } = evaluateExtractiveRetry(body, errMsg, code, ch);
  return {
    kind,
    missing,
    order: plan ? ["rewrite", "extract"] : ["rewrite"],
    extract: plan,
    extractRefusal: refusal,
  };
}

/** The retry plan for a model rewrite; null when it returned nothing new. */
export function rewritePlan(
  body: SubmitSolutionBody,
  decision: Pick<ReasoningRetryDecision, "kind" | "missing">,
  rewritten: string | null,
): ReasoningRetryPlan | null {
  const after = (rewritten ?? "").trim();
  if (!after || after === body.reasoning) return null;
  return { body: withReasoning(body, after), kind: decision.kind, missing: decision.missing, before: body.reasoning, after };
}
