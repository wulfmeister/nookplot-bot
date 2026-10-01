/**
 * Jev — Venice's "System One" decision model (`jev-latest`, model type
 * "decision", beta). It does not write text: it answers bounded questions
 * about a `state` with calibrated numbers — `noul` (P(yes)), `choice` (one of
 * N with probabilities + confidence) or `score` (a weighted position on an
 * ordered rubric). ~0.4s and ~2-3k input tokens per call at $0.042/M input,
 * $0 output: about a hundredth of a cent per question.
 * Docs: https://docs.venice.ai/guides/features/decisions  (POST /decisions)
 *
 * WHAT IT IS ALLOWED TO DECIDE (measured, 2026-09-29): on 72 of our settled
 * standard traces Jev's quality score did NOT separate paid from rejected
 * (AUC 0.49; Spearman vs the best verifier's score −0.14; Aug-only 0.69,
 * Sep 0.39 — the Sybil scoring farm makes September's labels mostly noise).
 * So Jev is used where a wrong answer is cheap:
 *   1. ranking inbox threads for the operator (inbox-watch.ts) — sorting,
 *      never replying (docs/inbox-strategy.md: no auto-replies);
 *   2. a SHADOW checker on every mining submission — the verdict is recorded
 *      (jev-checks.jsonl) and scored against settlements by
 *      `npm run mining-stats`, but never gates or alters a submission until
 *      it earns that on our own data.
 *
 * Safety: never throws. A 402/429, or 3 consecutive failures, pauses ALL Jev
 * calls for 30 min — on 2026-09-28 a test loop that retried through a spend
 * limit tripped Venice's ">50 failed attempts" lockout on the key the whole
 * bot depends on. BOT_JEV=0 disables every call site.
 */
import { NOOK_DIR } from "./util.js";
import { join } from "node:path";
import { recordVeniceCall } from "./venice-cost.js";

const BASE = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";
export const JEV_MODEL = "jev-latest";
export const JEV_PAUSE_MS = 30 * 60_000;
export const JEV_CHECKS_LOG = join(NOOK_DIR, "jev-checks.jsonl");

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevAnswer {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

let pausedUntil = 0;
let consecutiveFailures = 0;

/** Test hook: clear the breaker state. */
export function _resetJevForTests(): void {
  pausedUntil = 0;
  consecutiveFailures = 0;
}

export function jevPausedUntil(): number {
  return pausedUntil;
}

/** Pure: pull the `answers` map out of a /decisions body; null if malformed. */
export function parseJevAnswers(body: unknown): Record<string, JevAnswer> | null {
  if (!body || typeof body !== "object") return null;
  const answers = (body as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const out: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    out[id] = {
      type: String(a.type ?? ""),
      noul: num(a.noul),
      choice: typeof a.choice === "string" ? a.choice : undefined,
      score: num(a.score),
      probabilities: a.probabilities && typeof a.probabilities === "object" ? (a.probabilities as Record<string, number>) : undefined,
      confidence: num(a.confidence),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface JevOptions {
  timeoutMs?: number;
  callSite?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Cost sink; defaults to the shared venice-costs.jsonl ledger. */
  onCost?: (inputTokens: number) => void;
  nowMs?: number;
}

/**
 * One /decisions call. Returns null (never throws) when disabled, paused,
 * or on any failure.
 */
export async function jevDecide(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: JevOptions = {},
): Promise<{ answers: Record<string, JevAnswer>; inputTokens: number } | null> {
  if (process.env.BOT_JEV === "0") return null;
  const now = opts.nowMs ?? Date.now();
  if (now < pausedUntil) return null;
  const key = process.env.VENICE_API_KEY;
  if (!key) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const pause = (why: string) => {
    pausedUntil = now + JEV_PAUSE_MS;
    consecutiveFailures = 0;
    console.warn(`   ⚖️ jev paused 30 min (${why}) — never retry through a spend limit or lockout`);
  };
  try {
    const r = await doFetch(`${BASE}/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (r.status === 402 || r.status === 429) {
      pause(`HTTP ${r.status}`);
      return null;
    }
    if (!r.ok) {
      if (++consecutiveFailures >= 3) pause(`${consecutiveFailures} consecutive failures, last HTTP ${r.status}`);
      return null;
    }
    const body = (await r.json()) as { usage?: { input_tokens?: number } };
    const answers = parseJevAnswers(body);
    if (!answers) {
      if (++consecutiveFailures >= 3) pause("3 consecutive unparseable responses");
      return null;
    }
    consecutiveFailures = 0;
    const inputTokens = Number(body.usage?.input_tokens ?? 0);
    const sink =
      opts.onCost ??
      ((n: number) =>
        recordVeniceCall({
          model: JEV_MODEL,
          usage: { prompt_tokens: n, completion_tokens: 0, total_tokens: n },
          outcome: "ok",
          callSite: opts.callSite,
        }));
    try {
      sink(inputTokens);
    } catch {
      /* telemetry must never break a caller */
    }
    return { answers, inputTokens };
  } catch {
    if (++consecutiveFailures >= 3) pause("3 consecutive network failures");
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Inbox triage — rank threads so the operator reads the right ones first.
// ---------------------------------------------------------------------------

export const INBOX_TRIAGE_QUESTIONS: Record<string, JevQuestion> = {
  priority: {
    type: "score",
    instructions:
      "`message` is the latest direct message another agent sent to our autonomous research/mining agent. How much does it deserve the human operator's attention?",
    criteria: [
      "Ignore: spam, promotion, or automated/templated bot chatter",
      "Low: friendly or generic, with no question or request for us",
      "Worth reading: substantive feedback, a technical point, or a question about our work",
      "Operator should act: a direct request, a collaboration or payment proposal, a correction of our published work, or something time-sensitive",
    ],
  },
  category: {
    type: "choice",
    instructions: "What is `message` mainly?",
    criteria: {
      question: "Asks us something about our work or our agent",
      collaboration: "Proposes working together, a joint project, or an exchange",
      feedback: "Feedback, critique, or a correction of our published work",
      bot_chatter: "Automated, templated, or reciprocal-citation chatter from another bot",
      promotion: "Advertising, token shilling, or unsolicited promotion",
      risky: "Asks for keys, credentials, funds, payments, or to follow an unknown link",
      other: null,
    },
  },
};

export interface InboxTriage {
  priority: number; // 0..3 weighted
  category: string;
  categoryConfidence: number;
  label: "risky" | "act" | "read" | "low" | "ignore";
}

/** Pure: collapse Jev's answers into one sortable verdict. */
export function triageFromAnswers(a: Record<string, JevAnswer> | null | undefined): InboxTriage | null {
  const p = a?.priority?.score;
  if (p === undefined) return null;
  return labelTriage(p, a?.category?.choice ?? "other", a?.category?.confidence ?? 0);
}

/**
 * Pure: the label rule, applied to raw scores. Stored verdicts are re-labelled
 * through this on every read, so a rule change re-ranks the backlog too.
 */
export function labelTriage(p: number, category: string, categoryConfidence: number): InboxTriage {
  // A message asking for keys/funds/links is flagged whatever its priority —
  // the operator must see it, and must know not to act on it blindly.
  // Promotion and bot chatter are capped at "low" whatever the score: on the
  // first live backfill (2026-10-01, 25 threads) Jev scored NOTHING below
  // 1.5, so a confident category is the better signal for the noise floor.
  const noise = (category === "promotion" || category === "bot_chatter") && categoryConfidence >= 0.5;
  const label: InboxTriage["label"] =
    category === "risky" && categoryConfidence >= 0.5
      ? "risky"
      : noise
        ? (p >= 0.75 ? "low" : "ignore")
        : p >= 2.25
        ? "act"
        : p >= 1.5
          ? "read"
          : p >= 0.75
            ? "low"
            : "ignore";
  return { priority: p, category, categoryConfidence, label };
}

const LABEL_RANK: Record<InboxTriage["label"], number> = { risky: 4, act: 3, read: 2, low: 1, ignore: 0 };

/** Pure: sort key — label first (risky/act on top), then raw priority. */
export function compareTriage(a?: InboxTriage | null, b?: InboxTriage | null): number {
  const ra = a ? LABEL_RANK[a.label] : -1;
  const rb = b ? LABEL_RANK[b.label] : -1;
  if (ra !== rb) return rb - ra;
  return (b?.priority ?? -1) - (a?.priority ?? -1);
}

export const TRIAGE_ICON: Record<InboxTriage["label"], string> = {
  risky: "⚠️",
  act: "🔴",
  read: "🟡",
  low: "⚪",
  ignore: "🗑",
};

export async function jevTriageMessage(msg: { from?: string; messageType?: string; text: string }): Promise<InboxTriage | null> {
  const res = await jevDecide(
    { from: msg.from ?? "unknown", messageType: msg.messageType ?? "dm", message: msg.text.slice(0, 8000) },
    INBOX_TRIAGE_QUESTIONS,
    { callSite: "inbox_triage" },
  );
  return triageFromAnswers(res?.answers);
}

// ---------------------------------------------------------------------------
// 2. Shadow checker on mining submissions — recorded, never acted on (yet).
// ---------------------------------------------------------------------------

export const ESSAY_CHECK_QUESTIONS: Record<string, JevQuestion> = {
  quality: {
    type: "score",
    instructions:
      "`trace` is a reasoning trace submitted to solve `challenge`. Score it the way a strict, honest expert verifier would, judging correctness, reasoning quality, efficiency and novelty together.",
    criteria: [
      "Wrong, off-topic, or generic filler that does not engage the challenge",
      "Partially correct but thin: few concrete numbers, weak or missing derivations",
      "Solid and specific: correct approach, concrete quantities, sound reasoning",
      "Excellent: correct, rigorous, quantitative, well-cited, clearly expert work",
    ],
  },
  passes: {
    type: "noul",
    instructions: "Would a strict, honest expert verifier score `trace` at least 0.8 out of 1.0 as a solution to `challenge`?",
  },
};

export const CODE_CHECK_QUESTIONS: Record<string, JevQuestion> = {
  quality: {
    type: "score",
    instructions:
      "`solution` is Python/JS source submitted for `challenge`, which is graded by a hidden test suite that often includes security tests. Judge it.",
    criteria: [
      "Does not implement what the challenge asks, or is obviously broken",
      "Implements it but misses edge cases or has a security hole (path traversal, shell injection, unsafe deserialization, SSRF)",
      "Correct for normal inputs and meets the stated security requirements",
      "Correct, defensive, and handles edge cases and every stated security requirement",
    ],
  },
  passes: {
    type: "noul",
    instructions: "Would `solution` pass a hidden test suite checking both correctness and the security requirements stated in `challenge`?",
  },
};

export interface JevCheck {
  score: number;
  pPass: number;
  confidence?: number;
}

/** Pure: collapse checker answers. */
export function checkFromAnswers(a: Record<string, JevAnswer> | null | undefined): JevCheck | null {
  const score = a?.quality?.score;
  const pPass = a?.passes?.noul;
  if (score === undefined || pPass === undefined) return null;
  return { score, pPass, confidence: a?.quality?.confidence };
}

export async function jevCheckSolution(args: {
  challenge: { title?: string; description?: string; difficulty?: string };
  trace?: string;
  code?: string;
}): Promise<JevCheck | null> {
  const challenge = {
    title: args.challenge.title ?? "",
    description: String(args.challenge.description ?? "").slice(0, 6000),
    difficulty: args.challenge.difficulty ?? "",
  };
  const isCode = !args.trace && !!args.code;
  const state = isCode
    ? { challenge, solution: String(args.code).slice(0, 40_000) }
    : { challenge, trace: String(args.trace ?? "").slice(0, 60_000) };
  const res = await jevDecide(state, isCode ? CODE_CHECK_QUESTIONS : ESSAY_CHECK_QUESTIONS, {
    callSite: isCode ? "jev_check_code" : "jev_check_essay",
  });
  return checkFromAnswers(res?.answers);
}

/** Pure: ROC AUC of scores for positives vs negatives (0.5 = coin flip). */
export function aucOf(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/**
 * Pure: score recorded shadow checks against settled outcomes, per kind.
 * `checks` rows carry submissionId/kind/score/pPass; `settlements` rows carry
 * submissionId/status (latest wins).
 */
export function jevCheckReport(
  checks: Array<{ submissionId?: string; kind?: string; score?: number; pPass?: number }>,
  settlements: Array<{ submissionId?: string; status?: string }>,
): Record<string, { paid: number; rejected: number; aucScore: number; aucPass: number }> {
  const status = new Map<string, string>();
  for (const s of settlements) if (s.submissionId && s.status) status.set(s.submissionId, s.status);
  const by = new Map<string, { pos: number[]; neg: number[]; posP: number[]; negP: number[] }>();
  for (const c of checks) {
    if (!c.submissionId || c.score === undefined || c.pPass === undefined) continue;
    const st = status.get(c.submissionId);
    if (st !== "verified" && st !== "rejected") continue;
    const k = c.kind ?? "?";
    const b = by.get(k) ?? { pos: [], neg: [], posP: [], negP: [] };
    if (st === "verified") { b.pos.push(c.score); b.posP.push(c.pPass); } else { b.neg.push(c.score); b.negP.push(c.pPass); }
    by.set(k, b);
  }
  const out: Record<string, { paid: number; rejected: number; aucScore: number; aucPass: number }> = {};
  for (const [k, b] of by) out[k] = { paid: b.pos.length, rejected: b.neg.length, aucScore: aucOf(b.pos, b.neg), aucPass: aucOf(b.posP, b.negP) };
  return out;
}
