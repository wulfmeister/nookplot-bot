import { join } from "node:path";
import { createHash } from "node:crypto";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat, VENICE_WEB_SEARCH } from "./venice.js";
import { pickModel, pickModelAB, pickAlternateModel, effortFor, abPool, PARSE_FAIL_RATE_THRESHOLD, PARSE_FAIL_MIN_ATTEMPTS } from "./models.js";
import { isFarmChallengeTitle } from "./trace-fingerprint.js";
import { writeNote } from "./vault.js";
import { NOOK_DIR, readJsonl, readJsonlTail, appendJsonl, extractJsonObj, sleep } from "./util.js";
import { gatherMiningContext, type MiningContext } from "./mining-context.js";
import {
  fetchSubmissionGuide,
  smokeTestPython,
  smokeTestJs,
  smokeTestExactAnswer,
  coerceStarterCode,
  dryRunPythonSubmission,
  type SubmissionGuide,
} from "./mining-sandbox.js";
import { refine } from "./refine.js";
import { recordSolveAsWorkspace } from "./workspace-solve.js";
import { withGenerationSlot } from "./generation-semaphore.js";
import { recordAudit } from "./audit.js";
import {
  alreadySubmittedChallenges,
  guildClaimedUntil,
  specificityRejectedChallenges,
  ALREADY_SUBMITTED_TTL_MS,
  isAlreadySubmittedError,
  isGuildClaimedError,
  isEpochCapError,
  parseGuildClaimedUntilTs,
} from "./skip-caches.js";
import {
  recordSpecializationMatch,
  maybeWarnSpecializationUnderSupply,
} from "./specialization-supply.js";
import {
  isSpecificityError,
  parseMissingCategories,
  enrichSummarySpecificity,
  passesSpecificityGate,
  countSpecificity,
} from "./specificity-gate.js";

type RuntimeLike = Pick<NookplotRuntime, "connection" | "tools">;

const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");

// Gateway epoch cap is 12 regular + 1 guild-exclusive per 24h (per skill.md +
// nookplot_submit_reasoning_trace docs). The cap is the intended per-agent
// throughput, so run at it regardless of stake — but note PAYOUTS scale with
// stake tier (Tier 1 = 9M NOOK); unstaked agents mostly accrue reputation.
const DAILY_CAP = 13;
// The gateway's REGULAR-submission limit is 12 per ROLLING 24h window (the
// "Maximum 12 regular challenge per 24-hour epoch" 429 — it is NOT a clean
// 02:00 reset). DAILY_CAP (13) is the regular+guild total; the rolling regular
// gate below uses 12.
const REGULAR_ROLLING_CAP = 12;
const ROLLING_WINDOW_MS = 24 * 3600_000;
const ERROR_COOLDOWN_MS = 4 * 3600_000;
const VERIFIABLE_KINDS = new Set(["python_tests", "javascript_tests", "exact_answer"]);
// Models kept in the verifiable-CODE solve path. grok-4-3 rejected 44% of our
// python_tests (functional-pass but security-test FAIL — SSRF / insecure
// deserialization) vs claude-opus-4-8 at 8%, so non-code A/B picks (grok-4-3,
// gemini) are routed to a code-strong model for verifiable kinds. Standard
// reasoning challenges keep the full A/B pool. Override via BOT_VERIFIABLE_MODEL.
const VERIFIABLE_CODE_MODELS = new Set(["claude-opus-4-8", "claude-opus-4-7", "openai-gpt-55"]);
const VERIFIABLE_DEFAULT_MODEL = "claude-opus-4-8";
// How many times to re-solve + resubmit a verifiable challenge that failed its
// deterministic tests, feeding the exact failing test back to the solver. The
// gateway grants up to 20 slots/challenge; we use a few. Tune via env.
const VERIFIABLE_FIX_RETRIES = Number(process.env.BOT_VERIFIABLE_FIX_RETRIES ?? 2);

/**
 * Summary rules for VERIFIABLE (code) solves.
 *
 * The gateway scores traceSummary for specificity and 400s below 35/100. The
 * verifiable path has no reasoning trace to enrich from — only snake_case
 * Python/JS source, which contains no camelCase identifiers, no unit-bearing
 * numbers and no comparative phrasing, so the enricher had nothing to extract
 * and 39 submissions in 14 days died at the wire (60% of all python attempts,
 * each one a paid solve). Ask the SOLVER for the scoring tokens instead of
 * trying to synthesize them afterwards. The three bullets mirror the gateway's
 * own "Concrete fix" guidance verbatim.
 */
const SUMMARY_SPECIFICITY_RULE = `
- The "summary" is scored for specificity by an automated grader and REJECTED below threshold. It must contain ALL THREE of:
  • a measurable claim with units or counts — "O(n log n) for n=10000 elements", "2 passes over 64 bytes", "reduces 3 scans to 1"; a bare year or step number does NOT count;
  • a named method in backticks — \`bisect_right\`, \`urlsplit\`, \`Map.get\` — used in a clause that says what it does, not just listed;
  • an explicit comparison — "X instead of Y", "vs", "better than" — e.g. "iterative accumulation instead of recursion (avoids stack depth limits at n>1000)".
  Describe the ALGORITHM and its measurable properties. Do NOT pad with metadata (reward amounts, challenge ids, the function's own name) — the grader scores those zero.`;

// Hidden test harnesses on these challenges frequently include SECURITY assertions
// (a single security failure rejects the whole solve even when the functional
// test passes — our #1 rejection cause). Tell the solver to write SECURE code.
const SECURITY_HARDENING_PY = `
- SECURITY — the hidden tests very often assert this, and one security failure rejects the whole solve even if the functional test passes. Write secure code, not just working code:
  • SSRF: before any outbound request, validate/allowlist the host and BLOCK internal / link-local / metadata targets — localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (especially 169.254.169.254), 0.0.0.0, ::1, and hostnames that resolve to them.
  • Deserialization: NEVER pickle/marshal/dill.loads or yaml.load() untrusted bytes (arbitrary code execution). Use json (or another data-only parser) for untrusted input.
  • Injection / traversal: no eval/exec/os.system/subprocess with untrusted input; normalize + confine file paths (reject '..' escapes); parameterize any SQL.`;
const SECURITY_HARDENING_JS = `
- SECURITY — the hidden tests very often assert this, and one security failure rejects the whole solve even if the functional test passes. Write secure code, not just working code:
  • SSRF: before any fetch/request, validate/allowlist the host and BLOCK internal / link-local / metadata targets — localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (especially 169.254.169.254), 0.0.0.0, ::1, and hostnames resolving to them.
  • Code execution: never eval() / new Function() / vm on untrusted input; do not deserialize untrusted data into executable form.
  • Injection / traversal: normalize + confine file paths (reject '..' escapes); parameterize any SQL/command; validate/escape any interpolated input.`;

/**
 * Error notes whose presence proves a challenge will NEVER succeed for us —
 * skip permanently regardless of cooldown. Match by substring.
 */
const PERMANENT_FAIL_PATTERNS = [
  "guild-exclusive (requires tier",
  "requires a guild",
  "challenge is closed",
  "no longer accepting",
  "already submitted",
];

/**
 * Patterns that mean "retry next mining epoch" — challenge is still valid, we
 * just hit a per-epoch cap. Use the 02:00 UTC boundary instead of a rolling
 * cooldown so a prior cap does not suppress the next epoch.
 *
 * NOTE: the real gateway error wording is `Maximum N regular challenge per
 * 24-hour epoch` (and similarly for guild-exclusive). We match the stable
 * fragments rather than the exact full phrase.
 */
const EPOCH_EXHAUSTED_PATTERNS = [
  "Maximum 1 guild-exclusive",
  "Maximum 12 regular",        // real format: "Maximum 12 regular challenge per 24-hour epoch"
  "Maximum 12 submissions",    // legacy / fallback
  "Maximum 6 submissions",     // older docs floor
  "per 24-hour epoch",
  "Epoch submission cap reached",
  "Try again next epoch",
];

export function isPermanentFailure(notes: string | undefined): boolean {
  if (!notes) return false;
  return PERMANENT_FAIL_PATTERNS.some((p) => notes.includes(p));
}

export function isEpochExhausted(notes: string | undefined): boolean {
  if (!notes) return false;
  return EPOCH_EXHAUSTED_PATTERNS.some((p) => notes.includes(p));
}

/**
 * Nookplot mining epochs currently reset at 02:00 UTC (`/v1/mining/next-epoch-time`).
 * Given a cap-hit timestamp, compute the first reset boundary after it.
 */
export function regularEpochCapResetAt(hitMs: number): number {
  const hit = new Date(hitMs);
  const reset = Date.UTC(hit.getUTCFullYear(), hit.getUTCMonth(), hit.getUTCDate(), 2, 0, 0, 0);
  return hitMs < reset ? reset : reset + 24 * 3600_000;
}

/**
 * Start of the mining epoch-day containing nowMs (the most recent 02:00 UTC
 * boundary at or before nowMs). The daily submission cap counts from here, not
 * a rolling 24h window — so the count resets cleanly when the gateway opens
 * fresh epoch slots at 02:00Z. Pure — testable.
 */
export function epochDayStartMs(nowMs: number): number {
  return regularEpochCapResetAt(nowMs) - 24 * 3600_000;
}

/**
 * Rolling-window cap math. The gateway enforces "Maximum 12 regular challenges
 * per 24-HOUR ROLLING window" — NOT a clean reset at the 02:00 epoch boundary.
 * Empirically a fresh epoch 429s at 02:05 whenever the prior batch was submitted
 * after 02:00 (which it always is — we can't submit before the reset). Modelling
 * it as a 02:00 reset made us attempt at 02:05, eat a 429, then suppress the
 * WHOLE epoch — forfeiting every other day's solves (observed: alternating 12/0
 * for 8+ days). Modelling the real rolling window lets us WAIT until the oldest
 * in-window submission ages out (~24h after it landed) and then mine, sustaining
 * ~12/day.
 *
 * Pure — given the accepted-submission timestamps it returns how many are in the
 * trailing window and, if at the cap, when the next slot frees. Testable.
 */
export function rollingCapState(
  acceptedTsMs: number[],
  nowMs: number,
  cap: number = REGULAR_ROLLING_CAP,
  windowMs: number = ROLLING_WINDOW_MS,
): { used: number; capped: boolean; freeAtMs: number | null } {
  const inWindow = acceptedTsMs
    .filter((t) => Number.isFinite(t) && t > nowMs - windowMs)
    .sort((a, b) => a - b);
  const used = inWindow.length;
  if (used < cap) return { used, capped: false, freeAtMs: null };
  // The cap frees when the in-window count drops below `cap`: the
  // (used - cap)-th oldest must age out (for used === cap that's the oldest).
  return { used, capped: true, freeAtMs: inWindow[used - cap] + windowMs };
}

/** Accepted regular submissions (anything that wasn't a skip/error) → rolling cap state. */
function rollingCapInfo(nowMs: number): { used: number; capped: boolean; freeAtMs: number | null } {
  const ts = readJsonl<MiningLogEntry>(MINING_LOG)
    .filter((e) => e.outcome !== "skipped" && e.outcome !== "error")
    .map((e) => new Date(e.ts).getTime());
  return rollingCapState(ts, nowMs);
}

/**
 * Pacing gate: spread regular submissions across the rolling window instead of
 * bursting to the cap. Bursting recreates yesterday's cluster forever — each
 * slot frees exactly 24h after it landed, so a clustered day parks its freed
 * slots in the overnight quiet period (2026-07-04 audit: trailing-24h count at
 * cap only 42% of hours; 10-18h gaps between accepted submissions).
 *
 * Policy: with at least half the window free we're in catch-up (no pacing —
 * recover from outages at full speed); otherwise require ~0.9 × windowMs/cap
 * (~108 min at 12/24h) since the last accepted submission, so steady state
 * converges to a uniform spread. Pure — testable.
 */
export function pacingGate(
  acceptedTsMs: number[],
  nowMs: number,
  cap: number = REGULAR_ROLLING_CAP,
  windowMs: number = ROLLING_WINDOW_MS,
): { waitUntilMs: number | null } {
  const inWindow = acceptedTsMs.filter((t) => Number.isFinite(t) && t > nowMs - windowMs);
  const used = inWindow.length;
  if (used < cap / 2 || used >= cap) return { waitUntilMs: null }; // catch-up / cap gate's job
  const next = Math.max(...inWindow) + (windowMs / cap) * 0.9;
  return { waitUntilMs: next > nowMs ? next : null };
}

function pacingInfo(nowMs: number): { waitUntilMs: number | null } {
  if (process.env.BOT_MINING_PACING === "0") return { waitUntilMs: null };
  const ts = readJsonl<MiningLogEntry>(MINING_LOG)
    .filter((e) => e.outcome !== "skipped" && e.outcome !== "error")
    .map((e) => new Date(e.ts).getTime());
  return pacingGate(ts, nowMs);
}

/**
 * Is the regular-submission cap currently full? Uses the rolling-24h window of
 * our own accepted submissions (matches how the gateway counts), so we
 * proactively WAIT when full and resume the moment a slot ages out — instead of
 * attempting, eating a 429, and over-suppressing the rest of the epoch.
 *
 * (`_runtime` kept for call-site compatibility; the rolling model needs no
 * gateway round-trip — our own submission log is the ground truth.)
 */
async function regularEpochCapActive(
  _runtime: RuntimeLike,
): Promise<{ active: boolean; resetAt?: string; source: "rolling" | "none" }> {
  const info = rollingCapInfo(Date.now());
  if (info.capped && info.freeAtMs) {
    return { active: true, resetAt: new Date(info.freeAtMs).toISOString(), source: "rolling" };
  }
  return { active: false, source: "none" };
}

export interface Challenge {
  id: string;
  title?: string;
  description?: string;
  difficulty?: string;
  domainTags?: string[];
  verifierKind?: string | null;
  submissionArtifactType?: string | null;
  language?: string | null;
  submissionCount?: number;
  maxSubmissions?: number;
  baselineScore?: Record<string, unknown> | null;
  estimatedRewardNook?: number;
  status?: string;
  posterAddress?: string | null;
  sourceType?: string;
  challengeType?: string;
}

interface MiningLogEntry {
  ts: string;
  challengeId: string;
  verifierKind: string;
  outcome: "pass" | "fail" | "deferred" | "error" | "skipped";
  rewardNook?: number;
  submissionId?: string;
  model?: string;
  notes?: string;
}

/**
 * Cache state. `attempted` = challenges we should skip permanently
 * (pass / fail / deferred / skipped). Challenges that errored recently
 * within ERROR_COOLDOWN_MS are kept OUT of `attempted` so we retry them.
 * `todayCount` counts only non-error outcomes — transient gateway errors
 * shouldn't burn a daily mining slot.
 */
function loadCaches(inGuild: boolean): { attempted: Set<string>; todayCount: number } {
  const entries = readJsonl<MiningLogEntry>(MINING_LOG);
  const attempted = new Set<string>();
  const now = Date.now();
  for (const e of entries) {
    if (e.outcome === "error") {
      if (isPermanentFailure(e.notes)) {
        // Guild-exclusive errors logged before we joined a guild are no
        // longer permanent for us — retry them now that we have access.
        const isGuildError = e.notes?.includes("guild-exclusive") || e.notes?.includes("requires tier");
        if (isGuildError && inGuild) continue;
        attempted.add(e.challengeId);
        continue;
      }
      if (isEpochExhausted(e.notes)) {
        // Don't retry the same challenge until the mining epoch resets.
        const hitMs = new Date(e.ts).getTime();
        if (Number.isFinite(hitMs) && now < regularEpochCapResetAt(hitMs)) attempted.add(e.challengeId);
      } else {
        // Original semantic: retry transient failures within 4h, give up after.
        const age = now - new Date(e.ts).getTime();
        if (age > ERROR_COOLDOWN_MS) attempted.add(e.challengeId);
      }
    } else {
      attempted.add(e.challengeId);
    }
  }
  // Count accepted submissions over the trailing ROLLING 24h window — this is
  // how the gateway actually enforces the cap ("Maximum 12 regular per 24-hour
  // epoch" is rolling, not a 02:00 reset). A prior batch submitted at ~03:00
  // keeps the window full until ~03:00 the next day. The earlier 02:00-reset
  // count read "0 used" at 02:05, so we'd attempt, eat a 429, and forfeit the
  // whole epoch (alternating 12/0). The rolling count instead waits and resumes
  // as each slot ages out — see rollingCapState / regularEpochCapActive.
  const since = now - ROLLING_WINDOW_MS;
  const todayCount = entries.filter(
    (e) => new Date(e.ts).getTime() >= since && e.outcome !== "skipped" && e.outcome !== "error",
  ).length;
  return { attempted, todayCount };
}

interface SolveResult {
  artifact?: Record<string, unknown>;
  artifactType?: string;
  reasoning: string;
  /** For standard reasoning trace flow: long-form markdown that gets IPFS-pinned */
  traceContent?: string;
  /** For standard reasoning trace flow: 100+ char summary of the trace */
  traceSummary?: string;
}

/**
 * Pull the longest fenced code block from a model response. Salvages the
 * solution when a model (gemini/gpt-55 observed) emits prose/markdown instead
 * of the requested JSON, or wraps the code in a ``` fence inside the JSON.
 * Pure — testable.
 */
export function extractFencedCode(content: string): string | null {
  const fences = [...content.matchAll(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g)];
  let best = "";
  for (const f of fences) {
    const code = f[1] ?? "";
    if (code.length > best.length) best = code;
  }
  best = best.trim();
  return best.length > 0 ? best : null;
}

/**
 * Robustly extract the required field from a verifiable-solve response. Tries
 * strict JSON first (the requested shape); if the field is missing — because
 * the model emitted prose/markdown, or the JSON truncated before the field —
 * falls back to a fenced code block for code solutions. This lets non-deepseek
 * pool models (grok/gpt-55/gemini) produce usable python_tests/js_tests
 * submissions instead of "missing solution" parse-fails. Pure — testable.
 */
export function parseVerifiableSolution(
  content: string,
  field: "solution" | "answer",
): { value: string; reasoning?: string; summary?: string } | null {
  const obj = extractJsonObj<{ reasoning?: string; summary?: string; solution?: string; answer?: string }>(content);
  const v = obj?.[field];
  if (typeof v === "string" && v.trim().length > 0) {
    return { value: v, reasoning: obj?.reasoning, summary: obj?.summary };
  }
  // Code fields only: salvage a fenced block from prose/markdown output.
  if (field === "solution") {
    const fenced = extractFencedCode(content);
    if (fenced) return { value: fenced, reasoning: obj?.reasoning, summary: obj?.summary };
  }
  return null;
}

async function solvePythonTests(
  ch: Challenge,
  learnings: string,
  model: string,
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  context?: MiningContext,
  guide?: SubmissionGuide | null,
  fixHint?: string,
): Promise<SolveResult | null> {
  const domainHint = context?.domainHint ? `\n\n${context.domainHint}` : "";
  const starterStr = coerceStarterCode(guide?.starterCode);
  const starterHint = starterStr
    ? `\n\nStarter scaffold from the grader (extend, don't replace shape):\n\`\`\`python\n${starterStr.slice(0, 1500)}\n\`\`\``
    : "";
  const sampleHint = guide?.sampleIO && Array.isArray(guide.sampleIO) && guide.sampleIO.length > 0
    ? `\n\nGrader sample I/O (for shape only):\n${guide.sampleIO.slice(0, 3).map((s, i) => `  [${i + 1}] in=${JSON.stringify(s.input)} → out=${JSON.stringify(s.output)}`).join("\n")}`
    : "";
  const sys = `You are an expert Python engineer. Solve the challenge by producing a single solution.py file. The solution will be tested against a hidden test harness.${domainHint}

Constraints:
- Output JSON ONLY, no prose, no code fences outside the JSON value.
- Schema (emit "solution" FIRST): {"solution":"complete Python source code as a single string","reasoning":"50-200 char explanation","summary":"100+ char description of approach + key steps"}
${SUMMARY_SPECIFICITY_RULE}
- Your solution.py must export the function(s) named in the challenge description.
- Handle edge cases (empty inputs, negatives, zero, large numbers, off-by-one boundaries).
- Use stdlib only; no third-party imports unless requirements.txt explicitly lists them.
- No print() statements. No __main__ block. Just the requested functions.${SECURITY_HARDENING_PY}${starterHint}${sampleHint}`;

  const learningsBlock = learnings ? `\n\nRelated learnings from prior solves (study before writing):\n${learnings}\n` : "";
  const contextBlock = context?.contextBlock ? `\n\n${context.contextBlock}\n` : "";
  const fixBlock = fixHint
    ? `\n\n⚠ YOUR PREVIOUS SUBMISSION FAILED the grader's hidden tests. Return a corrected COMPLETE solution.py that fixes EXACTLY this (keep everything that passed):\n${fixHint}\n`
    : "";
  const userMsg = `Challenge: ${ch.title ?? "(no title)"}\nDifficulty: ${ch.difficulty ?? "?"}\nDomain: ${(ch.domainTags ?? []).join(", ")}\n\nFull description:\n${ch.description ?? ""}${learningsBlock}${contextBlock}${fixBlock}\n\nProduce JSON now.`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ], { max_tokens: 6000, temperature: 0.15, model, venice_parameters: VENICE_WEB_SEARCH, reasoning_effort, timeoutMs: 180_000 });

  const parsed = parseVerifiableSolution(res.content, "solution");
  if (!parsed) {
    logParseFail("python_tests", model, res.content, "solution");
    return null;
  }
  const reasoning = parsed.reasoning ?? `Python solution for ${ch.title ?? ch.id.slice(0, 8)}.`;
  return {
    artifact: { files: { "solution.py": parsed.value } },
    artifactType: "code",
    reasoning,
    traceSummary: padTraceSummary(parsed.summary ?? reasoning, ch, parsed.value),
  };
}

async function solveJsTests(
  ch: Challenge,
  learnings: string,
  model: string,
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  context?: MiningContext,
  guide?: SubmissionGuide | null,
  fixHint?: string,
): Promise<SolveResult | null> {
  const domainHint = context?.domainHint ? `\n\n${context.domainHint}` : "";
  const starterStr = coerceStarterCode(guide?.starterCode);
  const starterHint = starterStr
    ? `\n\nStarter scaffold from grader (extend, don't replace shape):\n\`\`\`js\n${starterStr.slice(0, 1500)}\n\`\`\``
    : "";
  const sys = `You are an expert JavaScript engineer. Solve the challenge by producing a single solution.js file (ESM).${domainHint}

Constraints:
- Output JSON ONLY (emit "solution" FIRST): {"solution":"complete JS source as a string","reasoning":"50-200 chars","summary":"100+ chars approach + edges handled"}
${SUMMARY_SPECIFICITY_RULE}
- Use ESM exports (export function foo() {}). The runner uses "type": "module".
- No top-level await. No console.log. No imports of node:fs etc unless explicitly required.
- Handle edge cases.${SECURITY_HARDENING_JS}${starterHint}`;

  const learningsBlock = learnings ? `\n\nRelated learnings:\n${learnings}\n` : "";
  const contextBlock = context?.contextBlock ? `\n\n${context.contextBlock}\n` : "";
  const fixBlock = fixHint
    ? `\n\n⚠ YOUR PREVIOUS SUBMISSION FAILED the grader's hidden tests. Return a corrected COMPLETE solution.js that fixes EXACTLY this (keep everything that passed):\n${fixHint}\n`
    : "";
  const userMsg = `Challenge: ${ch.title ?? "(no title)"}\nDifficulty: ${ch.difficulty ?? "?"}\n\nDescription:\n${ch.description ?? ""}${learningsBlock}${contextBlock}${fixBlock}`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ], { max_tokens: 6000, temperature: 0.15, model, venice_parameters: VENICE_WEB_SEARCH, reasoning_effort, timeoutMs: 180_000 });

  const parsed = parseVerifiableSolution(res.content, "solution");
  if (!parsed) {
    logParseFail("javascript_tests", model, res.content, "solution");
    return null;
  }
  const reasoning = parsed.reasoning ?? `JS solution for ${ch.title ?? ch.id.slice(0, 8)}.`;
  return {
    artifact: { files: { "solution.js": parsed.value } },
    artifactType: "code",
    reasoning,
    traceSummary: padTraceSummary(parsed.summary ?? reasoning, ch, parsed.value),
  };
}

async function solveExactAnswer(
  ch: Challenge,
  learnings: string,
  model: string,
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  context?: MiningContext,
  guide?: SubmissionGuide | null,
): Promise<SolveResult | null> {
  const domainHint = context?.domainHint ? `\n\n${context.domainHint}` : "";
  const formatHint = guide?.submissionHint ? `\n\nGrader format hint: ${guide.submissionHint}` : "";
  const sys = `You will produce the exact answer to a verifiable question. The grader compares your answer string verbatim (trimmed) to the expected answer.${domainHint}

Constraints:
- Output JSON ONLY (emit "answer" FIRST): {"answer":"the answer string ONLY — no units, no extra words, no quotes","reasoning":"50-200 chars","summary":"100+ chars: how you derived it + checks"}
- If the challenge expects a LaTeX-formatted math answer (MATH dataset), preserve LaTeX exactly (e.g. "\\\\frac{1}{2}", not "0.5").
- If numeric: no units, no commas, no thousands separators unless the problem requires them.
- If string: trim and case-sensitive — match the expected form.${formatHint}`;

  const learningsBlock = learnings ? `\n\nRelated learnings:\n${learnings}\n` : "";
  const contextBlock = context?.contextBlock ? `\n\n${context.contextBlock}\n` : "";
  const userMsg = `Challenge: ${ch.title ?? "(no title)"}\nDifficulty: ${ch.difficulty ?? "?"}\n\nDescription:\n${ch.description ?? ""}${learningsBlock}${contextBlock}`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ], { max_tokens: 2000, temperature: 0.1, model, venice_parameters: VENICE_WEB_SEARCH, reasoning_effort, timeoutMs: 120_000 });

  const parsed = parseVerifiableSolution(res.content, "answer");
  if (!parsed) {
    logParseFail("exact_answer", model, res.content, "answer");
    return null;
  }
  const reasoning = parsed.reasoning ?? `Exact answer for ${ch.title ?? ch.id.slice(0, 8)}.`;
  return {
    artifact: { text: String(parsed.value).trim() },
    artifactType: "static_text",
    reasoning,
    traceSummary: padTraceSummary(parsed.summary ?? reasoning, ch, parsed.value),
  };
}

/**
 * Standard reasoning trace flow — for `challengeType: "standard"` challenges
 * (no verifierKind). Produces long-form markdown that gets IPFS-pinned.
 * The 3 verifiers grade across correctness/reasoning/efficiency/novelty.
 *
 * Trace MUST be structured (## Approach, ## Steps, ## Conclusion, ## Citations)
 * — unstructured blobs score lower per the SDK guidance.
 */
async function solveStandardTrace(
  ch: Challenge,
  learnings: string,
  model: string,
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  context?: MiningContext,
): Promise<SolveResult | null> {
  const domainHint = context?.domainHint ? `\n\nDOMAIN FOCUS: ${context.domainHint}` : "";
  const sys = `You are an expert problem-solver producing a long-form reasoning trace for a Nookplot mining challenge. The trace will be graded by 3 verifiers across correctness, reasoning quality, efficiency, and novelty.${domainHint}

OUTPUT FORMAT — JSON ONLY:
{
  "summary": "150-280 char concise description of approach + the key result",
  "trace": "Long-form markdown — see structure below"
}

The trace markdown MUST use this exact section structure:

## Approach
A brief framing — what mathematical/scientific/engineering frame you're using and why.

## Steps
Numbered steps (### Step 1, ### Step 2, ...). Each step shows:
- What you're computing or proving
- The work (equations, derivations, code snippets, citations)
- The intermediate result + a sanity check
- Any dead-ends you considered and why you rejected them

## Conclusion
The final answer or key claim, with units / precision.

## Uncertainty
Specific things you're less sure about, ranked by importance.

## Citations
Numbered citations to papers, learnings, or sources used. Format:
[1] Author Year — title or claim, with link or arxiv ID if available.

CONTENT REQUIREMENTS:
- 800-1500 words of substance, not fluff.
- Concrete numbers, not vague claims.
- Cite specific papers/learnings (even from training data) by author + year.
- Show your work — verifiers can re-derive your steps.
- When you don't know, say "uncertain because ..." — calibration scores higher than confident bluffing.`;

  const learningsBlock = learnings
    ? `\n\nRelated learnings from prior solvers — study these before writing your trace:\n${learnings}\n`
    : "";
  const contextBlock = context?.contextBlock ? `\n\n${context.contextBlock}\n` : "";

  const userMsg = `# Challenge: ${ch.title ?? "(no title)"}

Difficulty: ${ch.difficulty ?? "?"}
Domain: ${(ch.domainTags ?? []).join(", ")}
Source type: ${ch.sourceType ?? "?"}

## Full description
${ch.description ?? ""}${learningsBlock}${contextBlock}

Produce the JSON now.`;

  const res = await chat([
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  // 40000 tokens: plenty of headroom. 1000s timeout so xhigh on slow models
  // never gets AbortSignal'd.
  //
  // venice_parameters NOT set — quality-comparison probe showed our own
  // mining-context.ts (arxiv + web + vault gather) produces dramatically
  // better traces than Venice's web_search add-on (13 vs 7 citations, 12 vs
  // 0 LaTeX equations on a controlled test). Plus saves 0.75 credits/call.
  ], { max_tokens: 40000, temperature: 0.2, model, reasoning_effort, timeoutMs: 1_000_000 });

  const parsed = extractJsonObj<{ summary?: string; trace?: string }>(res.content);
  let trace = parsed?.trace ? String(parsed.trace).trim() : "";
  let summary = parsed?.summary;
  if (!trace) {
    // Salvage: gemini-3-1-pro-preview / openai-gpt-55 frequently emit the trace
    // as raw markdown (no JSON wrapper) or as JSON whose multi-KB trace string
    // fails strict parse on unescaped newlines/quotes. Rather than burning the
    // whole inference as a parse-fail (these ran 100% parse-fail in the logs),
    // recover the long-form body directly. Pure helper → unit-tested.
    const salvaged = salvageMarkdownTrace(res.content);
    if (salvaged) {
      trace = salvaged;
      console.log(`   🩹 salvaged ${model} standard trace from non-JSON output (${trace.length} chars)`);
    }
  }
  if (!trace) {
    logParseFail("standard", model, res.content, "trace");
    return null;
  }
  if (trace.length < 600) {
    logParseFail("standard", model, res.content, `trace too short (${trace.length} chars)`);
    return null;
  }
  return {
    reasoning: `Standard reasoning trace for ${ch.title ?? ch.id.slice(0, 12)}.`,
    traceContent: trace,
    traceSummary: padTraceSummary(summary ?? trace.slice(0, 240), ch, trace),
  };
}

/**
 * Recover a long-form markdown trace from a model response that failed the
 * strict `{"summary","trace"}` JSON parse. Three cases, in priority order:
 *   (A) a "trace":"…" field whose value broke JSON.parse on unescaped control
 *       chars — pull the value out and unescape the common sequences;
 *   (B) the whole response wrapped in a single ``` fence — unwrap it;
 *   (C) raw markdown with no JSON wrapper at all — use as-is.
 * Returns null unless the result is ≥600 chars AND reads like a trace (has a
 * markdown heading or several paragraphs), so we never submit short prose
 * garbage. Pure — testable.
 */
export function salvageMarkdownTrace(content: string): string | null {
  let s = content.trim();
  if (!s) return null;
  // (A) Broken-JSON "trace" field: grab everything from the trace value to the
  // last quote and unescape. Most common failure for multi-KB markdown values.
  const tj = s.match(/"trace"\s*:\s*"([\s\S]*?)"\s*[},]?\s*$/);
  if (tj) {
    const inner = tj[1]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
    if (looksLikeTrace(inner)) return inner;
  }
  // (B) Single fenced block spanning the whole response.
  const whole = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)```\s*$/);
  if (whole) s = whole[1].trim();
  // (C) Raw markdown (reject anything still wrapped in a JSON object).
  if (!s.startsWith("{") && looksLikeTrace(s)) return s;
  return null;
}

function looksLikeTrace(s: string): boolean {
  if (s.length < 600) return false;
  const hasHeading = /(^|\n)#{1,6}\s+\S/.test(s);
  const multiParagraph = s.split(/\n\s*\n/).length >= 3;
  return hasHeading || multiParagraph;
}

/**
 * Ensure traceSummary is ≥100 chars. Gateway rejects below that threshold.
 */
/**
 * One-line log when the LLM's response can't be parsed into the shape we
 * expected. Without this we have zero visibility into "solver produced no
 * trace" failures — we burn an inference call and learn nothing.
 */
function logParseFail(kind: string, model: string, content: string, missing: string): void {
  const head = content.replace(/\s+/g, " ").trim().slice(0, 240);
  console.warn(`   ⚠ ${kind} parse-fail (${model}, missing "${missing}"): ${head}${content.length > 240 ? "…" : ""}`);
  // Telemetry: tag the latest-recorded Venice cost entry as a parse-fail so
  // the circuit-breaker (#16) can sideline this model. Fire-and-forget.
  void import("./venice-cost.js").then((m) => m.tagLatestCallOutcome(model, "parse-fail", "mining_solve")).catch(() => undefined);
}

// Moved to specificity-gate.ts (pure, no deps) to avoid an import cycle —
// re-exported here for existing importers (_probe-quality, tests).
export { specificityCategories } from "./specificity-gate.js";
export { countSpecificity };

/**
 * Build a one-line specificity tail by extracting concrete tokens from the
 * source trace. Only invoked as a *fallback* when the LLM's natural summary
 * is too generic (countSpecificity < BOOST_TRIGGER_THRESHOLD). The good
 * summaries ship clean — see padTraceSummary.
 *
 * Design rule: every fragment must be EXTRACTED from the source content.
 * No filler phrases like "use the chosen approach" — those read like bot
 * template-spam to verifiers and dropped our quorum-pickup rate.
 */
export function buildSpecificityTail(traceOrDesc: string, ch: Challenge): string {
  const fragments: string[] = [];

  // Require a unit on numbers — "measured 1" is meaningless, "12ms" or "32KB" is signal.
  const numMatch = traceOrDesc.match(/\b\d+(?:[.,]\d+)?(%|x|×|ms|s\b|ns|μs|MB|GB|KB|tokens?|chars?|bits?|bytes?|iter|epochs?|steps?)\b/);
  if (numMatch) fragments.push(`measured ${numMatch[0]}`);

  const codeMatch = traceOrDesc.match(/`([^`]{2,40})`/);
  if (codeMatch) {
    fragments.push(`uses \`${codeMatch[1]}\``);
  } else {
    const camelMatch = traceOrDesc.match(/\b([a-z]+[A-Z][A-Za-z]{2,})\b/);
    if (camelMatch) fragments.push(`uses \`${camelMatch[1]}\``);
  }

  // Comparison phrase — extract from source. NO filler fallback.
  const vsMatch = traceOrDesc.match(/\b([A-Za-z][\w-]+)\s+(?:vs\.?|versus)\s+([A-Za-z][\w-]+)/i);
  if (vsMatch) fragments.push(`${vsMatch[1]} vs ${vsMatch[2]}`);

  // If we found nothing extractable, return empty — caller decides whether
  // to ship the summary as-is and let the gateway 400 (rare path).
  if (fragments.length === 0) return "";

  const domain = (ch.domainTags ?? []).join("/") || "general";
  return ` Specifics: ${fragments.join("; ")}. (${domain})`;
}

const BOOST_TRIGGER_THRESHOLD = 2; // boost only when fewer than 2 categories present
                                    // = genuinely sparse summary. Was 3 = padded most things.

/**
 * Ensure summary is ≥100 chars AND tries to clear the gateway specificity
 * gate (≥35/100, ≈3 categories). If the LLM summary is rich, ship it
 * as-is — no template padding. Only pad when genuinely sparse, and even
 * then only with extracted tokens (no filler phrases).
 *
 * Why this is conditional: padding every summary added the same boilerplate
 * tail to every trace ("use the chosen approach", etc) which read like
 * template-spam to verifiers and likely contributed to low quorum-pickup
 * rate (no real citations placed → no follows → no comments).
 */
export function padTraceSummary(s: string, ch: Challenge, context?: string): string {
  let summary = s.trim();
  if (summary.length < 100) {
    const tail = ` Domain: ${(ch.domainTags ?? []).join(", ") || "general"}. Difficulty: ${ch.difficulty ?? "?"}. Approach derived from challenge spec + related learnings, with concrete examples and citations in the trace body.`;
    summary = (summary + tail).slice(0, 500);
  }
  // Conditional specificity boost — only kicks in for genuinely sparse
  // summaries. Most LLM-generated summaries already pass 3+ categories.
  if (countSpecificity(summary) < BOOST_TRIGGER_THRESHOLD) {
    const source = context && context.length > summary.length ? context : ch.description ?? "";
    const tail = buildSpecificityTail(source, ch);
    if (tail) summary = (summary + tail).slice(0, 500);
  }
  return summary.slice(0, 500);
}

async function fetchRelatedLearnings(runtime: RuntimeLike, challengeId: string): Promise<string> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      // 10 is the sweet spot — the KG often has 200-500 related learnings per
      // challenge but top-10 covers most of the useful pattern diversity, and
      // we're sending these into Claude's 1M context so prompt size isn't the
      // bottleneck. Sort is gateway-side by specificity descending.
      `/v1/mining/challenges/${encodeURIComponent(challengeId)}/related-learnings?limit=10`,
    )) as { learnings?: Array<{ summary?: string; content?: string; specificityScore?: number }> };
    const items = (res.learnings ?? []).slice(0, 5);
    if (items.length === 0) return "";
    return items
      .map(
        (l, i) =>
          `[learning ${i + 1}, specificity=${l.specificityScore ?? "?"}] ${l.summary ?? (l.content ?? "").slice(0, 220)}`,
      )
      .join("\n\n");
  } catch {
    return "";
  }
}

async function trySolve(
  ch: Challenge,
  learnings: string,
  model: string,
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  context?: MiningContext,
  guide?: SubmissionGuide | null,
  fixHint?: string,
): Promise<SolveResult | null> {
  // Mining is our highest-priority generation track. The semaphore ensures
  // we never run more than BOT_MAX_CONCURRENT_GENERATIONS (default 3) at
  // once, but mining will preempt lower-priority queued generations.
  return withGenerationSlot("mining", async () => {
    if (ch.verifierKind === "python_tests") return await solvePythonTests(ch, learnings, model, reasoning_effort, context, guide, fixHint);
    if (ch.verifierKind === "javascript_tests") return await solveJsTests(ch, learnings, model, reasoning_effort, context, guide, fixHint);
    if (ch.verifierKind === "exact_answer") return await solveExactAnswer(ch, learnings, model, reasoning_effort, context, guide);
    if (!ch.verifierKind && (ch.challengeType === "standard" || ch.challengeType === undefined)) {
      return await solveStandardTrace(ch, learnings, model, reasoning_effort, context);
    }
    return null;
  });
}

/**
 * Verifiable challenges (python_tests / javascript_tests / exact_answer) default
 * to the A/B picker (the proven mining pool), same as standard traces.
 *
 * History: these used to force `deepseek-v4-pro` ("optimizedForCode"). The data
 * disproved that — deepseek was the WORST submitter (19–24% submit-rate, ~100%
 * parse-fail for stretches, ~20 wasted epoch slots/day), so a parse-fail breaker
 * had to keep yanking it back to the A/B pick anyway. Defaulting to A/B removes
 * the periodic re-test waste. The override is now strictly opt-IN: set
 * BOT_VERIFIABLE_MODEL=<model> to force a specific code model (still subject to
 * the parse-fail breaker below).
 */
/**
 * Gateway-facing model name for the submission payload. The gateway's
 * modelUsed validator 400s on Venice's org-prefixed catalog ids — observed
 * 2026-07-17→19: every zai-org-glm-5-2 submission rejected with `modelUsed
 * "zai-org-glm-5-2" doesn't look like a real model name` AFTER paying for the
 * solve (15 burned solves in 3 days). Strip the vendor prefix for the wire;
 * local logs keep the full Venice id for A/B attribution.
 */
export function gatewayModelName(model: string): string {
  return model.replace(/^zai-org-/, "").replace(/^e2ee-/, "");
}

/**
 * Does this submit error blame the MODEL ID itself (as opposed to the trace
 * content, the epoch cap, or a duplicate)? Only these justify sidelining the
 * arm — the gateway is saying it will never accept anything this model
 * produces, so every further pick burns a paid solve for nothing.
 */
export function isModelRejection(error: string): boolean {
  return /modelUsed|doesn't look like a real model name|unknown model/i.test(error);
}

/**
 * Last-resort summary rewrite for a verifiable solve whose summary can't clear
 * the specificity gate by extraction alone. One cheap call, given the code and
 * the exact categories the gateway scores — cheaper than the paid solve it
 * saves. Returns null on any failure; the caller then skips the submit rather
 * than sending something we predict will 400.
 */
export async function regenerateVerifiableSummary(
  current: string,
  code: string | undefined,
  ch: Challenge,
  model: string,
): Promise<string | null> {
  try {
    const res = await chat(
      [
        {
          role: "system",
          content:
            `Rewrite a solution summary so it passes an automated specificity grader. Output the rewritten summary as PLAIN TEXT only — no JSON, no quotes around the whole thing, no preamble.\n${SUMMARY_SPECIFICITY_RULE}\n- 2-4 sentences, 150-500 characters. Describe only what the code actually does; invent no measurements.`,
        },
        {
          role: "user",
          content:
            `Challenge: ${ch.title ?? "(untitled)"}\n\nCurrent summary (too vague):\n${current}\n\n` +
            (code ? `Solution code:\n\`\`\`\n${code.slice(0, 4000)}\n\`\`\`\n\n` : "") +
            `Rewrite it now.`,
        },
      ],
      { model, max_tokens: 4000, temperature: 0.3, timeoutMs: 90_000 },
    );
    const out = (res.content ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    return out.length >= 100 ? out : null;
  } catch (err) {
    console.warn(`   ⚠ summary regeneration failed: ${(err as Error).message.slice(0, 120)}`);
    return null;
  }
}

export function maybeOverrideModelForVerifiable(
  ch: Challenge,
  abPick: { model: string; reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" },
  failureRates?: Record<string, { attempts: number; failures: number; rate: number }>,
): { model: string; reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } {
  if (process.env.BOT_VERIFIABLE_MODEL_OVERRIDE === "0") return abPick;
  if (!ch.verifierKind || !VERIFIABLE_KINDS.has(ch.verifierKind)) return abPick;
  // A model sat at high parse-fail burns scarce epoch slots — never force it.
  const sidelined = (m: string): boolean => {
    const r = failureRates?.[m];
    return !!(r && r.attempts >= PARSE_FAIL_MIN_ATTEMPTS && r.rate >= PARSE_FAIL_RATE_THRESHOLD);
  };
  // Explicit env override wins (unless parse-fail-sidelined).
  const override = process.env.BOT_VERIFIABLE_MODEL;
  if (override && !sidelined(override)) {
    return { model: override, reasoning_effort: effortFor(override) };
  }
  // A/B pick is already code-strong → keep it (preserves opus-vs-gpt55 A/B).
  if (VERIFIABLE_CODE_MODELS.has(abPick.model)) return abPick;
  // Otherwise (grok-4-3 / gemini / anything unproven for code) → route to a
  // code-strong model, unless that model is itself parse-fail-sidelined.
  if (sidelined(VERIFIABLE_DEFAULT_MODEL)) return abPick;
  console.log(`   🎯 verifiable ${ch.verifierKind}: routing ${abPick.model} → ${VERIFIABLE_DEFAULT_MODEL} (code-strong; ${abPick.model} weak on code security tests)`);
  return { model: VERIFIABLE_DEFAULT_MODEL, reasoning_effort: effortFor(VERIFIABLE_DEFAULT_MODEL) };
}

/**
 * Turn a failed verifiable submission's `kind_specific` into a concrete fix-hint
 * for the solver — the exact failing assertion is in stdout_excerpt, which is
 * what lets a re-solve target the real problem (usually a security test). Pure.
 */
export function verifiableFailHint(ks: Record<string, unknown> | undefined | null): string | null {
  if (!ks || typeof ks !== "object") return null;
  const reason = typeof ks.fail_reason === "string" ? ks.fail_reason : "";
  const stdout = typeof ks.stdout_excerpt === "string" ? ks.stdout_excerpt : "";
  const stderr = typeof ks.stderr_excerpt === "string" ? ks.stderr_excerpt : "";
  const detail = (stdout || stderr).replace(/\s+$/g, "").slice(0, 1800);
  const parts = [reason ? `Failing: ${reason}` : "", detail ? `Test output:\n${detail}` : ""].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/**
 * Critique-revise pass on a standard reasoning trace. Uses the same chat
 * primitive as the solver — wraps a draft in a critique lens then revises
 * once. Roughly doubles inference cost on standard challenges but observed
 * top solvers' density patterns suggest this is what they do. Toggle with
 * BOT_MINING_REFINE=0.
 */
async function refineStandardTrace(
  ch: Challenge,
  draft: SolveResult,
  model: string,
): Promise<SolveResult> {
  if (process.env.BOT_MINING_REFINE === "0") return draft;
  if (!draft.traceContent) return draft;
  try {
    const context = `# Nookplot mining challenge
Title: ${ch.title ?? "(no title)"}
Difficulty: ${ch.difficulty ?? "?"}
Domain: ${(ch.domainTags ?? []).join(", ")}

The trace below was produced by a strong model. Verifiers grade across
correctness, reasoning, efficiency, and novelty. A 3-verifier quorum is
needed for a NOOK payout. Top-scoring traces include 2+ citations with
year+author (e.g. "Auer 2002", "de Boor 1978"), explicit equations, and
benchmarks with units (ms / MB / ops / %).

Description:
${(ch.description ?? "").slice(0, 1500)}`;
    const refined = await refine(context, draft.traceContent, {
      critiqueMaxTokens: 800,
      reviseMaxTokens: 6000,
      lensHint:
        "Audit citation density (does every claim have a year+author? add 2+ if missing), benchmarks (any unit-bearing numbers? add 3+ if missing), and explicit equations (any inline math? add 1+ if missing). Preserve structure (## Approach, ## Steps, ## Conclusion, ## Uncertainty, ## Citations).",
      model,
    });
    if (refined.revised && refined.revised.length >= 600) {
      return {
        ...draft,
        traceContent: refined.revised,
        reasoning: `${draft.reasoning} (refined via critique+revise)`,
        traceSummary: padTraceSummary(draft.traceSummary ?? "", ch, refined.revised),
      };
    }
  } catch (err) {
    console.warn(`   ⚠ refine pass failed: ${(err as Error).message} — using draft`);
  }
  return draft;
}

/**
 * Smoke-test a verifiable solution in the gateway sandbox (POST /v1/exec)
 * before submitting. Catches syntax/import errors. Costs ~0.5 credits per
 * test. Returns null when smoke testing doesn't apply (standard traces,
 * unknown kinds).
 */
async function runSandboxSmokeTest(
  runtime: RuntimeLike,
  ch: Challenge,
  solved: SolveResult,
  guide: SubmissionGuide | null,
): Promise<{ ok: boolean; details: string } | null> {
  if (ch.verifierKind === "python_tests") {
    const sol = (solved.artifact?.files as Record<string, string> | undefined)?.["solution.py"];
    if (!sol) return null;
    return await smokeTestPython(runtime, sol, guide);
  }
  if (ch.verifierKind === "javascript_tests") {
    const sol = (solved.artifact?.files as Record<string, string> | undefined)?.["solution.js"];
    if (!sol) return null;
    return await smokeTestJs(runtime, sol, guide);
  }
  if (ch.verifierKind === "exact_answer") {
    const text = (solved.artifact?.text as string | undefined) ?? "";
    return smokeTestExactAnswer(text, guide);
  }
  return null;
}

/**
 * Specialization gate.
 *
 * Authorship rights unlock at 50+ verified solves in ONE domain (→ perpetual
 * 10% royalties on every solve of challenges we author). If BOT_SPECIALIZE_DOMAINS
 * is set, we only attempt challenges whose domainTags intersect that list —
 * race-to-50-solves in a chosen domain rather than spread thin across CS.
 *
 * Example: `BOT_SPECIALIZE_DOMAINS=distributed-systems,algorithms`
 *
 * Unset = current behavior (broad CS, no filter).
 *
 * `BOT_SPECIALIZE_MATCH_MODE=any` (default) — match if ANY tag overlaps
 * `BOT_SPECIALIZE_MATCH_MODE=all` — match only if ALL tags overlap (strict)
 */
/**
 * Competition-aware challenge ordering (2026-06-11, from operator-playbook
 * research). Solve rewards are share-of-pool per challenge: the first mover
 * on a low-competition challenge takes the largest share, while piling onto
 * a 10-submission challenge splits the pool ten ways. Playbook guidance:
 * target 0-4 existing submissions, prefer expert difficulty (500K base
 * pools), external posters.
 *
 * Priority order (lower compare result = a first):
 *   0. Value tier — standard reasoning traces before verifiable (python_tests/
 *      js/exact). Standard est ~38–332 NOOK at ~87% submit-rate; verifiable est
 *      ~10 NOOK at ~23%. Epoch slots are the binding constraint (13/day, shared
 *      across kinds), so each verifiable slot displaces a standard one worth
 *      ~14–38× more in expected value. SOFT preference (this is a sort, not a
 *      filter — verifiable is still attempted when no standard is open, so a
 *      slot never idles).
 *   1. Competition bucket — ≤4 submissions beats >4.
 *   2. Within bucket: fewer submissions first (0 is ideal).
 *   3. Difficulty weight — expert > hard > medium > easy.
 *   4. Estimated reward, descending.
 *   5. Specialization match as the final tiebreak (soft preference only —
 *      throughput beats domain purity while authorship yield stays low).
 */
const DIFFICULTY_WEIGHT: Record<string, number> = { expert: 3, hard: 2, medium: 1, easy: 0 };
const LOW_COMPETITION_MAX = 4;

/** Slot-value tier: 0 = standard reasoning trace (high reward × high submit),
 *  1 = verifiable code/answer challenge (low reward × low submit). See the
 *  priority-order note above. */
export function challengeValueTier(c: Challenge): number {
  return c.verifierKind && VERIFIABLE_KINDS.has(c.verifierKind) ? 1 : 0;
}

/**
 * Verifiable-kind tilt — CORRECTED 2026-07-28.
 *
 * The original trigger (ship 07-23) fired whenever the trailing standard-kind
 * EXPIRY SHARE exceeded 20%, on the theory that converting forfeited slots
 * into sandbox-graded (quorum-immune) ones is free money. That was wrong: it
 * ranked kinds by survival rate while ignoring how much each kind PAYS.
 * Per-submission attribution from the gateway (2026-07-28, last 100 subs):
 *
 *   standard    54,308 NOOK per paid solve × 55% survival = 27,516 / slot
 *   verifiable  10,181 NOOK per paid solve × 88% survival =  8,960 / slot
 *
 * Standard wins 3.1x DESPITE losing 45% of its slots to expiry. Break-even
 * needs standard survival to fall to ~16% (i.e. ~84% expiry) — four times
 * worse than anything yet observed. The 20% trigger therefore fired
 * constantly and steered slots from 27.5k-per-slot work into 9k-per-slot
 * work, compounded by verifiable's 38% submit rate (the gateway specificity
 * gate rejects most of them).
 *
 * The trigger is now the comparison that actually decides it: tilt only when
 * standard's expected value per slot drops BELOW verifiable's, using the
 * measured reward multiple (BOT_STANDARD_REWARD_MULTIPLE, re-measurable with
 * `npm run mining:stats`). Same soft mechanism as before — it is a sort, not
 * a filter, so a slot never idles.
 *
 * The standalone quorum-stall trigger was also dropped: a stall depresses
 * standard survival, which this EV test already sees through the expiry
 * share, and even the worst measured stall week still resolved 43% of
 * standards — far above the ~16% break-even.
 */
export interface TiltInputs {
  ratio: number; // target verifiable share of the rolling day's slots; 0 disables
  /** How many times more a PAID standard solve pays than a paid verifiable one. */
  standardRewardMultiple: number;
  minResolved: number; // minimum resolved standards before survival is trusted
  standardResolved: number; // verified+expired standard rows in the window
  standardExpiredShare: number;
  /** Verifiable survival (verified / resolved). Defaults to 1 — they grade in a sandbox. */
  verifiableSurvival: number;
  todaySubmitted: number; // slots consumed in the rolling 24h (rows with submissionId)
  todayVerifiable: number; // of those, verifiable kinds
}

export interface TiltState {
  active: boolean;
  preferVerifiable: boolean;
  reason: string;
}

export function computeVerifiableTilt(i: TiltInputs): TiltState {
  if (!(i.ratio > 0)) {
    return { active: false, preferVerifiable: false, reason: "tilt disabled (BOT_VERIFIABLE_TILT=0)" };
  }
  // Not enough resolved standards to trust the survival estimate → keep the
  // healthy-network default (standard first). Never tilt on noise.
  if (i.standardResolved < i.minResolved) {
    return {
      active: false,
      preferVerifiable: false,
      reason: `only ${i.standardResolved} resolved standards (<${i.minResolved}) — too few to judge; standard first`,
    };
  }
  // EV per slot, in units of "one paid verifiable solve".
  const standardEv = (1 - i.standardExpiredShare) * i.standardRewardMultiple;
  const verifiableEv = i.verifiableSurvival;
  const ev = `standard EV ${standardEv.toFixed(2)} (${((1 - i.standardExpiredShare) * 100).toFixed(0)}% survival × ${i.standardRewardMultiple.toFixed(1)}x reward) vs verifiable ${verifiableEv.toFixed(2)}`;
  if (standardEv >= verifiableEv) {
    return { active: false, preferVerifiable: false, reason: `${ev} → standard first` };
  }
  const todayShare = i.todaySubmitted > 0 ? i.todayVerifiable / i.todaySubmitted : 0;
  const preferVerifiable = todayShare < i.ratio;
  return {
    active: true,
    preferVerifiable,
    reason: `${ev} → verifiable is worth more per slot; rolling-day verifiable ${i.todayVerifiable}/${i.todaySubmitted} vs ${(i.ratio * 100).toFixed(0)}% target → ${preferVerifiable ? "verifiable first" : "target met — standard first"}`,
  };
}

const MINING_VERIFIED_LOG = join(NOOK_DIR, "mining-verified.jsonl");

/** Gather tilt inputs from local JSONL state (impure shell around computeVerifiableTilt). */
export function loadTiltInputs(nowMs: number): TiltInputs {
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const ratio = Math.min(1, Math.max(0, num(process.env.BOT_VERIFIABLE_TILT, 0.6)));
  // Measured 2026-07-28 from gateway per-submission attribution: a paid
  // standard solve returned 54,308 NOOK vs 10,181 for a paid verifiable one.
  // Re-measure with `npm run mining:stats` and update if the network reprices.
  const standardRewardMultiple = num(process.env.BOT_STANDARD_REWARD_MULTIPLE, 5.3);
  const windowMs = num(process.env.BOT_VERIFIABLE_TILT_WINDOW_DAYS, 10) * 86_400_000;
  let standardResolved = 0;
  let standardExpired = 0;
  let verifiableResolved = 0;
  let verifiableVerified = 0;
  for (const r of readJsonlTail<{ ts?: string; verifierKind?: string; status?: string }>(MINING_VERIFIED_LOG, 600)) {
    if (!r.ts || nowMs - Date.parse(r.ts) > windowMs) continue;
    const verifiable = r.verifierKind ? VERIFIABLE_KINDS.has(r.verifierKind) : false;
    if (r.verifierKind === "standard") {
      if (r.status === "verified") standardResolved++;
      else if (r.status === "expired") { standardResolved++; standardExpired++; }
    } else if (verifiable) {
      if (r.status === "verified") { verifiableResolved++; verifiableVerified++; }
      else if (r.status === "expired" || r.status === "rejected") verifiableResolved++;
    }
  }
  let todaySubmitted = 0;
  let todayVerifiable = 0;
  for (const r of readJsonlTail<{ ts?: string; verifierKind?: string; submissionId?: string }>(MINING_LOG, 300)) {
    if (!r.submissionId) continue; // only rows that consumed a cap slot
    if (!r.ts || nowMs - Date.parse(r.ts) > ROLLING_WINDOW_MS) continue;
    todaySubmitted++;
    if (r.verifierKind && VERIFIABLE_KINDS.has(r.verifierKind)) todayVerifiable++;
  }
  return {
    ratio,
    standardRewardMultiple,
    minResolved: 10,
    standardResolved,
    standardExpiredShare: standardResolved ? standardExpired / standardResolved : 0,
    // Sandbox-graded kinds essentially always resolve; fall back to 1.0 until
    // we have enough resolved rows to say otherwise.
    verifiableSurvival: verifiableResolved >= 5 ? verifiableVerified / verifiableResolved : 1,
    todaySubmitted,
    todayVerifiable,
  };
}

export function compareChallengePriority(
  a: Challenge,
  b: Challenge,
  targets: string[],
  opts: { preferVerifiable?: boolean } = {},
): number {
  // Value tier first: never spend an epoch slot on a ~10-NOOK verifiable
  // challenge while a higher-EV standard reasoning challenge is open —
  // unless the verifiable tilt says the quorum pipeline can't pay standards.
  const tierA = challengeValueTier(a);
  const tierB = challengeValueTier(b);
  if (tierA !== tierB) return opts.preferVerifiable ? tierB - tierA : tierA - tierB;
  const subsA = a.submissionCount ?? 0;
  const subsB = b.submissionCount ?? 0;
  const lowA = subsA <= LOW_COMPETITION_MAX ? 0 : 1;
  const lowB = subsB <= LOW_COMPETITION_MAX ? 0 : 1;
  if (lowA !== lowB) return lowA - lowB;
  if (subsA !== subsB) return subsA - subsB;
  const diffA = DIFFICULTY_WEIGHT[(a.difficulty ?? "").toLowerCase()] ?? 1;
  const diffB = DIFFICULTY_WEIGHT[(b.difficulty ?? "").toLowerCase()] ?? 1;
  if (diffA !== diffB) return diffB - diffA;
  const rewA = a.estimatedRewardNook ?? 0;
  const rewB = b.estimatedRewardNook ?? 0;
  if (rewA !== rewB) return rewB - rewA;
  if (targets.length > 0) {
    const mA = passesSpecializationFilter(a) ? 1 : 0;
    const mB = passesSpecializationFilter(b) ? 1 : 0;
    if (mA !== mB) return mB - mA;
  }
  return 0;
}

/**
 * Transient generation-layer failures worth a one-shot model failover.
 * Distinct from gateway 4xx (permanent for this attempt) and parse failures
 * (model-quality signal handled by the circuit breaker).
 */
export function isTransientGenerationError(msg: string): boolean {
  return /Venice API (?:429|500|502|503)|overloaded|fetch failed|Inference processing failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

/**
 * Guild-claim a challenge: free 2h exclusive solve window for guild members,
 * and per operator playbooks claims do NOT consume epoch-cap slots. Best
 * effort — "already claimed" / unsupported-type errors just fall through to
 * a normal solve attempt.
 */
async function claimChallengeForGuild(runtime: RuntimeLike, challengeId: string, guildId: number): Promise<void> {
  try {
    await runtime.connection.request(
      "POST",
      `/v1/mining/challenges/${encodeURIComponent(challengeId)}/claim`,
      { guildId },
    );
    console.log(`   🛡 guild-claimed ${challengeId.slice(0, 8)} (2h exclusive window)`);
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`   🛡 guild claim skipped: ${msg.slice(0, 100)}`);
  }
}

export function specializeDomains(): string[] {
  const env = process.env.BOT_SPECIALIZE_DOMAINS;
  if (!env) return [];
  return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function passesSpecializationFilter(ch: Challenge): boolean {
  const targets = specializeDomains();
  if (targets.length === 0) return true; // no specialization set
  const challengeTags = (ch.domainTags ?? []).map((t) => t.toLowerCase());
  if (challengeTags.length === 0) return false; // can't classify, can't include
  const mode = process.env.BOT_SPECIALIZE_MATCH_MODE === "all" ? "all" : "any";
  if (mode === "all") return targets.every((t) => challengeTags.includes(t));
  return targets.some((t) => challengeTags.includes(t));
}

function challengeFitsBudget(ch: Challenge): boolean {
  if (ch.status && ch.status !== "open") return false;
  if (ch.submissionCount !== undefined && ch.maxSubmissions !== undefined && ch.submissionCount >= ch.maxSubmissions) return false;
  // Sybil-farm challenges ("<Name> <domain> expert analysis <hex>", inflated
  // to expert difficulty to bait the 500K base reward): a verified solve of
  // one pays the FARM's poster royalty. Skip unless explicitly re-enabled.
  if (process.env.BOT_SKIP_FARM_CHALLENGES !== "0" && isFarmChallengeTitle(ch.title ?? "")) return false;
  // Specialization is soft (preference via sort) unless BOT_SPECIALIZE_STRICT=1.
  // Soft is the default — we never idle when there's work.
  if (process.env.BOT_SPECIALIZE_STRICT === "1" && !passesSpecializationFilter(ch)) return false;
  const verifiable = ch.verifierKind && VERIFIABLE_KINDS.has(ch.verifierKind);
  const standard = !ch.verifierKind && (ch.challengeType === "standard" || ch.challengeType === undefined);
  return Boolean(verifiable || standard);
}

async function ipfsUpload(runtime: RuntimeLike, content: string, name: string): Promise<string | null> {
  try {
    const res = (await runtime.connection.request(
      "POST",
      "/v1/ipfs/upload",
      { data: { content, format: "markdown", uploadedAt: new Date().toISOString() }, name },
    )) as { cid?: string };
    return res.cid ?? null;
  } catch (err) {
    console.warn(`   ⚠ IPFS upload failed: ${(err as Error).message}`);
    return null;
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// NOTE: postSolveLearning (submit-time learning POST) was removed 2026-06-15.
// It always 400'd ("Submission must be verified before posting learnings") and
// the quorum-aware learnings.ts::publishPostSolveLearnings posts the learning
// once a submission flips to "verified". composePostSolveLearning is retained
// below (separately unit-tested) for reuse.

/**
 * Compose a high-specificity learning from a reasoning trace.
 * Picks the top-N specificity-dense sentences (numbers, code refs, comparisons).
 */
export function composePostSolveLearning(reasoning: string, traceSummary: string | undefined): string {
  const sentences = reasoning
    .replace(/\n{2,}/g, "\n")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 400);
  if (sentences.length === 0) return traceSummary ?? "";
  const scored = sentences.map((s) => ({ s, score: countSpecificity(s) }));
  const top = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .filter((x) => x.score > 0);
  let body = top.map((x) => x.s).join(" ");
  if (body.length < 200 && traceSummary) {
    body = (traceSummary + " " + body).trim();
  }
  // Cap at 1500 to stay tight
  return body.slice(0, 1500);
}

export async function discoverAndSolveMiningChallenges(
  runtime: RuntimeLike,
  opts: { dryRun?: boolean; myAddress?: string | null; guildId?: number | null } = {},
): Promise<void> {
  if (opts.dryRun) {
    console.log("⛏ (DRY_RUN — skipping mining poll)");
    return;
  }
  const { attempted, todayCount } = loadCaches(Boolean(opts.guildId));
  if (todayCount >= DAILY_CAP) {
    console.log(`⛏ mining daily cap hit (${todayCount}/${DAILY_CAP}) — skipping`);
    return;
  }
  // Additional short-circuit: if we hit an epoch-exhausted error during the
  // current live gateway epoch, the cap is per-agent not per-challenge.
  const preflightCap = await regularEpochCapActive(runtime);
  if (preflightCap.active) {
    console.log(`⛏ epoch cap active — skipping until ${preflightCap.resetAt ?? "next epoch"} (${preflightCap.source})`);
    return;
  }
  const pace = pacingInfo(Date.now());
  if (pace.waitUntilMs) {
    console.log(`⛏ pacing — spreading rolling-cap slots; next submission ~${new Date(pace.waitUntilMs).toISOString()}`);
    return;
  }

  let challenges: Challenge[] = [];
  try {
    // limit=100 (observed gateway max), NOT 25: the list is newest-first and
    // templated python challenges arrive in batches that bury standard
    // challenges below a 25-item cutoff — which silently flipped our cap mix to 68% python at
    // ~8k NOOK/slot while standard (~41-52k/slot, 5-6.5x) sat unseen at #26+.
    // The tier sort below prefers standard strictly; it just needs to SEE them.
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/challenges?status=open&limit=100",
    )) as { challenges?: Challenge[] };
    challenges = res.challenges ?? [];
  } catch (err) {
    console.warn(`   ⚠ mining list fetch failed: ${(err as Error).message}`);
    return;
  }

  const eligible = challenges.filter((c) => {
    if (!challengeFitsBudget(c)) return false;
    if (attempted.has(c.id)) return false;
    if (opts.myAddress && c.posterAddress?.toLowerCase() === opts.myAddress.toLowerCase()) return false;
    return true;
  });

  if (eligible.length === 0) {
    console.log(`⛏ no eligible new mining challenges this poll (${challenges.length} total open)`);
    return;
  }

  const targets = specializeDomains();
  let tilt: TiltState = { active: false, preferVerifiable: false, reason: "" };
  try {
    tilt = computeVerifiableTilt(loadTiltInputs(Date.now()));
  } catch (err) {
    // Tilt is best-effort — on any state-read failure fall back to the
    // healthy-network ordering rather than blocking the poll.
    console.warn(`   ⚠ tilt state unavailable (${(err as Error).message}) — using default ordering`);
  }
  eligible.sort((a, b) => compareChallengePriority(a, b, targets, tilt));
  if (tilt.active) console.log(`   ⚖ verifiable tilt: ${tilt.reason}`);

  const matched = targets.length > 0 ? eligible.filter((c) => passesSpecializationFilter(c)).length : 0;
  console.log(
    `⛏ found ${eligible.length} eligible challenges (${challenges.length} total open)` +
      (targets.length > 0 ? ` — ${matched} match specialization [${targets.join(",")}]` : ""),
  );
  // Specialization under-supply warn: if narrowed-specialization keeps
  // returning low match-rate across several consecutive ticks, the narrow
  // is starving us of work that wider tags would catch. One-shot warn so
  // we notice; re-arms if the rate recovers.
  if (targets.length > 0 && eligible.length > 0) {
    const ratio = matched / eligible.length;
    recordSpecializationMatch(ratio);
    maybeWarnSpecializationUnderSupply(targets);
  }
  const budget = DAILY_CAP - todayCount;
  // Up to 3 per 15-min poll in catch-up (window over half free — recover from
  // outages fast), but 1 per poll in the paced regime so a single tick can't
  // recreate the burst-cluster pattern the pacing gate exists to dissolve.
  const paced = process.env.BOT_MINING_PACING !== "0" &&
    rollingCapInfo(Date.now()).used >= REGULAR_ROLLING_CAP / 2;
  const todo = eligible.slice(0, Math.min(paced ? 1 : 3, budget));

  for (const ch of todo) {
    const idShort = ch.id.slice(0, 8);
    // Skip-cache pre-flight: any challenge we know is gated (already-submitted
    // by us, or claimed by another guild) gets dropped here, BEFORE we burn
    // Venice spend or the SDK 4-retry ladder. The gateway re-surfaces these
    // in discover until quorum / window expiry, so without this we'd hit them
    // every poll.
    if (alreadySubmittedChallenges.isSkipped(ch.id)) {
      console.log(`⛏ ${idShort} — skip (already submitted this epoch)`);
      continue;
    }
    if (guildClaimedUntil.isSkipped(ch.id)) {
      console.log(`⛏ ${idShort} — skip (claimed by another guild)`);
      continue;
    }
    if (specificityRejectedChallenges.isSkipped(ch.id)) {
      console.log(`⛏ ${idShort} — skip (specificity-rejected twice; 24h cooldown)`);
      continue;
    }
    // Per-iteration epoch-cap pre-flight: if we hit the gateway's "Maximum
    // 12 regular challenges per 24h" error on a PREVIOUS iteration of this
    // same loop, every subsequent submit will also 429 → save Venice spend
    // by short-circuiting BEFORE the context-gather + solver call.
    const loopCap = await regularEpochCapActive(runtime);
    if (loopCap.active) {
      console.log(`⛏ epoch cap hit during this poll — skipping remaining ${todo.length - todo.indexOf(ch)} attempt(s)`);
      break;
    }
    const reward = ch.estimatedRewardNook ?? "?";
    const kind = ch.verifierKind ?? (ch.challengeType === "standard" ? "standard" : "?");
    console.log(`⛏ attempt ${idShort} (${kind}, est ${reward} NOOK): ${(ch.title ?? "").slice(0, 80)}`);

    // Cost circuit-breaker: pass recent per-model parse-failure rates to
    // pickModelAB. Models with >= BOT_MODEL_PARSE_FAIL_THRESHOLD failure rate
    // in their last N calls are sidelined from rotation for the day.
    const { parseFailureRateByModel } = await import("./venice-cost.js");
    const failureRates = parseFailureRateByModel(10);
    const abRaw = pickModelAB("mining_solve", failureRates);
    // Only report models actually in rotation: the failure-rate history keeps
    // stats for retired pool members forever (their last N calls never change
    // once they stop being called), and logging those every tick reads as a
    // live problem when it's just history.
    const activePool = abPool("mining_solve");
    const sidelined = Object.entries(failureRates)
      .filter(([m, r]) => activePool.includes(m) && r.attempts >= 5 && r.rate >= 0.30)
      .map(([m, r]) => `${m}=${(r.rate * 100).toFixed(0)}%`);
    if (sidelined.length > 0) {
      console.log(`   ⚠ models sidelined for parse-fail: ${sidelined.join(", ")}`);
    }
    // Verifiable challenges → route to code-optimized model unless overridden,
    // skipping the override when that model is parse-fail-sidelined.
    const ab = maybeOverrideModelForVerifiable(ch, abRaw, failureRates);
    let modelUsed = ab.model;
    let effortUsed = ab.reasoning_effort;
    if (ab.model !== abRaw.model) {
      console.log(`   🎯 verifiable kind ${ch.verifierKind} → ${ab.model} (A/B pick ${abRaw.model} overridden)`);
    }
    // Guild claim (free, 2h exclusive window, does NOT consume an epoch
    // slot per operator playbooks). Lock the challenge for our guild before
    // burning solve time so a competitor can't land it mid-generation.
    // Best-effort: any failure falls through to a normal solve attempt.
    if (opts.guildId && process.env.BOT_GUILD_CLAIM !== "0") {
      await claimChallengeForGuild(runtime, ch.id, opts.guildId);
    }
    try {
      // Parallel gather: gateway-side related learnings + arxiv/web/vault context + submission guide.
      const [learnings, context, guide] = await Promise.all([
        fetchRelatedLearnings(runtime, ch.id),
        gatherMiningContext(ch, runtime),
        ch.verifierKind && VERIFIABLE_KINDS.has(ch.verifierKind)
          ? fetchSubmissionGuide(runtime, ch.id)
          : Promise.resolve(null),
      ]);
      if (learnings) console.log(`   📚 ${learnings.split("\n\n").length} gateway learnings`);
      if (context.citations.length > 0) {
        const arxiv = context.citations.filter((c) => c.source === "arxiv").length;
        const web = context.citations.filter((c) => c.source === "web").length;
        const vault = context.citations.filter((c) => c.source === "vault").length;
        console.log(`   🔎 context: arxiv=${arxiv}, web=${web}, vault=${vault}`);
      }
      if (guide) console.log(`   📦 submissionGuide: image=${guide.image ?? "?"}, starter=${Boolean(guide.starterCode)}`);

      const startMs = Date.now();
      // Transient generation errors (Venice 429/500, fetch failures) fail
      // over ONCE to a different pool model instead of forfeiting the
      // attempt — 3 of 6 recent attempt-errors were transient.
      let solved: Awaited<ReturnType<typeof trySolve>>;
      try {
        solved = await trySolve(ch, learnings, modelUsed, effortUsed, context, guide);
      } catch (genErr) {
        const gmsg = (genErr as Error).message;
        const alt = isTransientGenerationError(gmsg) ? pickAlternateModel("mining_solve", modelUsed) : null;
        if (!alt) throw genErr;
        console.warn(`   ↻ ${modelUsed} transient error (${gmsg.slice(0, 60)}) — failing over to ${alt.model}`);
        modelUsed = alt.model;
        effortUsed = alt.reasoning_effort;
        solved = await trySolve(ch, learnings, modelUsed, effortUsed, context, guide);
      }
      if (effortUsed) console.log(`   🧠 reasoning_effort=${effortUsed} for ${modelUsed}`);

      // Standard traces get a critique-revise pass (BOT_MINING_REFINE=0 to skip).
      if (solved && solved.traceContent) {
        solved = await refineStandardTrace(ch, solved, modelUsed);
        console.log(`   ✍ refined trace len=${solved.traceContent?.length ?? 0}`);
      }

      // Pre-submit gate for verifiable kinds (BOT_MINING_SANDBOX=0 to skip).
      // For python_tests we use the REAL grader sandbox (sandbox_test_code): a
      // hard compile/import failure means grading WILL fail, so we skip the
      // submit and preserve the scarce epoch slot. We log it as a retryable
      // `error` (NOT `skipped`) so the challenge isn't permanently blacklisted —
      // a later attempt with a different model may produce a clean solution.
      // Other kinds / unsupported / rate-limited cases fall back to the legacy
      // /v1/exec smoke, which annotates but never blocks.
      if (solved && process.env.BOT_MINING_SANDBOX !== "0") {
        const pySol =
          ch.verifierKind === "python_tests"
            ? (solved.artifact?.files as Record<string, string> | undefined)?.["solution.py"]
            : undefined;
        const gate = pySol
          ? await dryRunPythonSubmission(runtime, ch.id, { "solution.py": pySol })
          : ({ status: "skip", reason: "no authoritative dry-run for this kind" } as const);

        if (gate.status === "hard_fail") {
          console.warn(`   🧪 dry-run HARD FAIL — skipping submit to save epoch slot: ${gate.details}`);
          appendJsonl(MINING_LOG, {
            ts: new Date().toISOString(),
            challengeId: ch.id,
            verifierKind: kind,
            outcome: "error" as const,
            notes: `dryrun hard-fail (retryable): ${gate.details}`.slice(0, 200),
            model: modelUsed,
          });
          continue;
        }
        if (gate.status === "pass") {
          console.log(`   🧪 dry-run PASS (real grader env): ${gate.details}`);
        } else {
          // Unsupported / rate-limited / unavailable → legacy smoke (annotate only).
          const smoke = await runSandboxSmokeTest(runtime, ch, solved, guide);
          if (smoke && !smoke.ok) {
            console.warn(`   🧪 smoke FAIL (fallback) — submitting anyway with annotation: ${smoke.details}`);
            solved.reasoning = `${solved.reasoning} [self-smoke failed: ${smoke.details.slice(0, 100)}]`;
          } else if (smoke?.ok) {
            console.log(`   🧪 smoke PASS (fallback): ${smoke.details}`);
          }
        }
      }

      const wallMs = Date.now() - startMs;
      if (!solved) {
        console.warn(`   ⚠ solver produced no artifact/trace`);
        appendJsonl(MINING_LOG, {
          ts: new Date().toISOString(),
          challengeId: ch.id,
          verifierKind: kind,
          outcome: "error" as const,
          notes: "solver produced no output",
          model: modelUsed,
        });
        continue;
      }

      // Specificity pre-gate: a 400-rejected submission still burns one of
      // the 12 daily epoch slots (~10-20k NOOK each at emission-pool rates),
      // so never send a summary that fails the local mirror. Enrich from the
      // trace body / reasoning — always richer than the LLM's summary.
      const s = solved;
      // For verifiable (code) solves there is no traceContent — the richest
      // source of specificity fragments (identifiers, numbers, .ext refs) is the
      // solution code itself, so feed it to the enricher too. No-op for standard
      // traces (empty artifact).
      const codeFiles = (s.artifact?.files ?? {}) as Record<string, unknown>;
      const codeText = Object.values(codeFiles).filter((v): v is string => typeof v === "string").join("\n") || undefined;
      if (s.traceSummary && !passesSpecificityGate(s.traceSummary)) {
        const before = countSpecificity(s.traceSummary);
        s.traceSummary = enrichSummarySpecificity(s.traceSummary, [s.traceContent, codeText, s.reasoning, ch.description]);
        console.log(`   🔬 summary enriched pre-submit (${before}→${countSpecificity(s.traceSummary)} specificity categories)`);
      }
      // Enrichment is extractive — on the verifiable path there is often
      // nothing in the source material to extract (snake_case code has no
      // camelCase names, no unit-bearing numbers, no comparisons), so it can
      // return a summary that still fails. Submitting anyway is how 39 paid
      // solves died at the gateway. Regenerate instead: one cheap targeted
      // call, told exactly which categories are missing.
      if (s.traceSummary && !s.traceContent && !passesSpecificityGate(s.traceSummary)) {
        const rewritten = await regenerateVerifiableSummary(s.traceSummary, codeText, ch, modelUsed);
        if (rewritten && passesSpecificityGate(rewritten)) {
          console.log(`   ✍ summary regenerated to clear the specificity gate`);
          s.traceSummary = rewritten;
        } else {
          console.warn(`   ⛔ summary still below the specificity gate after regeneration — skipping submit to save the solve`);
          appendJsonl(MINING_LOG, {
            ts: new Date().toISOString(),
            challengeId: ch.id,
            verifierKind: kind,
            outcome: "error" as const,
            notes: "specificity gate: summary unfixable locally (submit skipped)",
            model: modelUsed,
          });
          specificityRejectedChallenges.markFor(ch.id, ALREADY_SUBMITTED_TTL_MS);
          continue;
        }
      }

      let sub: {
        id?: string;
        verification_outcome?: { pass?: boolean; score?: number; kind_specific?: Record<string, unknown> };
        error?: string;
      };

      let cid: string | null = null;
      let traceHash: string | undefined;
      if (s.traceContent) {
        // Standard reasoning trace path: IPFS-pin trace → POST /submit
        cid = await ipfsUpload(runtime, s.traceContent, `trace-${ch.id.slice(0, 8)}`);
        if (!cid) {
          appendJsonl(MINING_LOG, {
            ts: new Date().toISOString(),
            challengeId: ch.id,
            verifierKind: kind,
            outcome: "error" as const,
            notes: "IPFS upload failed",
            model: modelUsed,
          });
          continue;
        }
        traceHash = sha256Hex(s.traceContent);
      }

      let submitSummary = s.traceSummary;
      const gatewayModel = gatewayModelName(modelUsed);
      const doSubmit = async (): Promise<typeof sub> => {
        if (s.traceContent) {
          return (await runtime.connection.request(
            "POST",
            `/v1/mining/challenges/${encodeURIComponent(ch.id)}/submit`,
            {
              traceCid: cid,
              traceHash,
              traceSummary: submitSummary,
              modelUsed: gatewayModel,
              selfReportedWallMs: wallMs,
              ...(opts.guildId ? { guildId: opts.guildId } : {}),
            },
          )) as typeof sub;
        }
        // Verifiable path: POST /submit-solution with artifact + reasoning
        return (await runtime.connection.request(
          "POST",
          `/v1/mining/challenges/${encodeURIComponent(ch.id)}/submit-solution`,
          {
            artifactType: s.artifactType,
            artifact: s.artifact,
            reasoning: s.reasoning,
            traceSummary: submitSummary,
            modelUsed: gatewayModel,
            selfReportedWallMs: wallMs,
            ...(opts.guildId ? { guildId: opts.guildId } : {}),
          },
        )) as typeof sub;
      };

      try {
        sub = await doSubmit();
      } catch (subErr) {
        const smsg = (subErr as Error).message;
        if (!isSpecificityError(smsg)) throw subErr;
        // The gateway enumerates exactly which categories scored zero —
        // enrich those from the trace and retry ONCE. (Operator playbooks
        // warn that some 400s shadow-mask rate limits — never loop.)
        const missing = parseMissingCategories(smsg);
        const beforeRetry = submitSummary ?? "";
        submitSummary = enrichSummarySpecificity(
          beforeRetry,
          [s.traceContent, codeText, s.reasoning, ch.description],
          missing.length > 0 ? missing : undefined,
        );
        if (submitSummary === beforeRetry) {
          // Nothing extractable for the missing categories — a retry would
          // fail identically and burn another slot. Cool down 24h.
          specificityRejectedChallenges.markFor(ch.id, ALREADY_SUBMITTED_TTL_MS);
          console.warn(`   🔬 specificity 400 and nothing extractable to enrich — cooling ${idShort} for 24h`);
          throw subErr;
        }
        console.warn(`   🔬 specificity 400 (missing: ${missing.join(",") || "?"}) — retrying with enriched summary`);
        try {
          sub = await doSubmit();
        } catch (subErr2) {
          if (isSpecificityError((subErr2 as Error).message)) {
            specificityRejectedChallenges.markFor(ch.id, ALREADY_SUBMITTED_TTL_MS);
            console.warn(`   🔬 enriched retry also failed specificity — cooling ${idShort} for 24h`);
          }
          throw subErr2;
        }
      }
      s.traceSummary = submitSummary;

      if (sub.error) {
        console.warn(`   ✗ submit error: ${sub.error}`);
        // Model-attributable rejection (the gateway refused the modelUsed id
        // itself) → feed the circuit breaker so this arm gets sidelined before
        // it burns another paid solve. Other 400s (specificity, cap, dupes)
        // are challenge-attributable, not model-attributable, so they must NOT
        // sideline a healthy model.
        if (isModelRejection(sub.error)) {
          void import("./venice-cost.js")
            .then((m) => m.recordSubmitRejection(modelUsed, sub.error))
            .catch(() => undefined); // telemetry must never break the loop
        }
        appendJsonl(MINING_LOG, {
          ts: new Date().toISOString(),
          challengeId: ch.id,
          verifierKind: kind,
          outcome: "error" as const,
          notes: sub.error,
          model: modelUsed,
        });
        continue;
      }

      // Fix-retry: a verifiable challenge that FAILED its deterministic tests
      // gets re-solved with the exact failing test fed back, then resubmitted
      // (gateway grants up to 20 submissions/challenge). Recovers our #1
      // rejection cause — code that passes the functional test but fails a
      // SECURITY test. Bounded by VERIFIABLE_FIX_RETRIES (env BOT_VERIFIABLE_FIX_RETRIES,
      // set 0 to disable). NOTE: a resubmit may consume an epoch slot at the
      // gateway; if so, retries trade a fresh-challenge slot for a fix.
      if (!s.traceContent && (kind === "python_tests" || kind === "javascript_tests")) {
        let fixAttempt = 0;
        while (
          sub.verification_outcome &&
          sub.verification_outcome.pass === false &&
          fixAttempt < VERIFIABLE_FIX_RETRIES
        ) {
          const hint = verifiableFailHint(sub.verification_outcome.kind_specific);
          if (!hint) break;
          fixAttempt++;
          console.log(`   🔁 fix-retry ${fixAttempt}/${VERIFIABLE_FIX_RETRIES} ${idShort} — deterministic test failed, re-solving with the failing test`);
          const reSolved = await trySolve(ch, learnings, modelUsed, effortUsed, context, guide, hint);
          if (!reSolved || !reSolved.artifact) { console.log(`   🔁 re-solve produced no usable artifact — stopping`); break; }
          s.artifact = reSolved.artifact;
          s.artifactType = reSolved.artifactType;
          s.reasoning = reSolved.reasoning;
          s.traceSummary = reSolved.traceSummary;
          submitSummary = reSolved.traceSummary;
          try {
            sub = await doSubmit();
          } catch (retryErr) {
            console.warn(`   🔁 fix-retry submit failed: ${(retryErr as Error).message.slice(0, 120)}`);
            break;
          }
          if (sub.error) { console.warn(`   🔁 fix-retry submit error: ${sub.error}`); break; }
          if (sub.verification_outcome?.pass === true) {
            console.log(`   🔁 ✅ fix-retry ${fixAttempt} PASSED ${idShort}`);
            break;
          }
        }
        s.traceSummary = submitSummary;
      }

      const outcome = sub.verification_outcome;
      const pass = outcome?.pass === true;
      const status: MiningLogEntry["outcome"] = solved.traceContent
        ? "deferred" // standard traces await 3-verifier quorum
        : pass
          ? "pass"
          : outcome
            ? "fail"
            : "deferred";

      console.log(`   ${status === "pass" ? "✅" : status === "fail" ? "✗" : "⏳"} submission ${sub.id?.slice(0, 8)} — ${status}`);

      writeNote(
        "research",
        `mining-${ch.id.slice(0, 12)}`,
        {
          id: `mining-${ch.id}`,
          title: `Mining solve: ${ch.title ?? ch.id.slice(0, 12)}`,
          type: "mining-submission",
          tags: ["mining", kind, status, ...(ch.domainTags ?? [])],
          challengeId: ch.id,
          submissionId: sub.id,
          verifierKind: ch.verifierKind ?? null,
          outcome: status,
          rewardEstimate: ch.estimatedRewardNook,
          model: modelUsed,
        },
        `## Challenge\n\n${ch.description ?? ""}\n\n## Our reasoning\n\n${solved.reasoning}\n\n${solved.traceContent ? `## Trace content (pinned to IPFS)\n\n${solved.traceContent.slice(0, 2000)}...\n\n` : ""}## Outcome\n\n\`\`\`json\n${JSON.stringify(outcome ?? {}, null, 2).slice(0, 1200)}\n\`\`\`\n`,
      );

      appendJsonl(MINING_LOG, {
        ts: new Date().toISOString(),
        challengeId: ch.id,
        verifierKind: kind,
        outcome: status,
        rewardNook: ch.estimatedRewardNook,
        submissionId: sub.id,
        model: modelUsed,
        notes: solved.traceContent
          ? "standard trace; awaiting 3-verifier quorum"
          : pass
            ? "deterministic-pass; awaiting reasoning/efficiency/novelty quorum"
            : undefined,
      });
      recordAudit("mining_solve", status === "pass" ? "submitted" : status === "fail" ? "rejected" : status === "deferred" ? "pending" : "error", `${kind} ${(ch.title ?? "").slice(0, 50)}`, {
        challengeId: ch.id,
        submissionId: sub.id,
        model: modelUsed,
        reward: ch.estimatedRewardNook,
      });

      // Record this solve as a forkable cognitive workspace (toggle off with BOT_WORKSPACE_SOLVE=0).
      // Fire-and-forget — workspace creation must never block / fail the solve.
      void recordSolveAsWorkspace(runtime, {
        challengeId: ch.id,
        challengeTitle: ch.title,
        challengeDescription: ch.description,
        domainTags: ch.domainTags,
        model: modelUsed,
        reasoningEffort: effortUsed,
        citations: context.citations,
        domainHint: context.domainHint,
        refined: Boolean(solved.traceContent && solved.reasoning.includes("(refined via critique+revise)")),
        traceContent: solved.traceContent,
        traceSummary: solved.traceSummary,
        submissionId: sub.id,
      }).catch(() => undefined);

      // NOTE: the post-solve learning is NOT posted here. The gateway rejects
      // it at submit time with 400 "Submission must be verified before posting
      // learnings (status: 'submitted')" — a guaranteed-waste call per solve
      // (12/12 failed on 2026-06-12). The quorum-aware path in
      // learnings.ts::publishPostSolveLearnings polls submission status and
      // posts the learning once it flips to "verified". See that function.

      await sleep(30_000);
    } catch (err) {
      const msg = (err as Error).message;
      // Classify permanent failures and mark the appropriate skip cache so the
      // next poll filters this challenge out before any SDK round-trip.
      if (isAlreadySubmittedError(msg)) {
        alreadySubmittedChallenges.markFor(ch.id, ALREADY_SUBMITTED_TTL_MS);
        console.warn(`   ⚠ ${idShort} — gateway says already submitted; skip for 24h`);
      } else if (isGuildClaimedError(msg)) {
        const untilTs = parseGuildClaimedUntilTs(msg);
        if (untilTs) {
          guildClaimedUntil.markUntil(ch.id, untilTs);
          const hrs = Math.max(0, (untilTs - Date.now()) / 3600_000);
          console.warn(`   ⚠ ${idShort} — claimed by guild; skip for ${hrs.toFixed(1)}h`);
        } else {
          // No parseable timestamp in body — fall back to 4h cooldown
          guildClaimedUntil.markFor(ch.id, ERROR_COOLDOWN_MS);
          console.warn(`   ⚠ ${idShort} — claimed by guild (no ts); skip for ${ERROR_COOLDOWN_MS / 3600_000}h`);
        }
      } else if (isEpochCapError(msg)) {
        // Epoch cap is already handled via regularEpochCapActive() at the top
        // of the next iteration; just log and don't waste a retry.
        console.warn(`   ⚠ ${idShort} — epoch cap; will skip rest of poll`);
      } else {
        console.warn(`   ⚠ mining attempt error for ${idShort}: ${msg}`);
      }
      appendJsonl(MINING_LOG, {
        ts: new Date().toISOString(),
        challengeId: ch.id,
        verifierKind: kind,
        outcome: "error" as const,
        notes: msg.slice(0, 200),
        model: modelUsed,
      });
    }
  }
}
