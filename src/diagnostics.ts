/**
 * Diagnostic + observability helpers — gateway-truth on our own work.
 *
 * One file because they're all small reads from the same authoritative source:
 *   1. recent_verdicts — V9 per-submission scores with rubric CIDs
 *   2. my_verifications — list of verifications we PERFORMED (4-dim scores)
 *   3. submission artifact — fetch artifact CID for verifiable challenges
 *   4. probe / rerun artifact — re-execute a probe to refresh scoring
 *   5. authorship rights — which domains we have authorship in (50+ verified)
 *   6. counter-argument / defend trace — adversarial review system (probe-only)
 *   7. score crowd-jury submission — scoring helper for crowd_jury verifier_kind
 *
 * Endpoints:
 *   GET  /v1/agents/:address/verdict-summary?...
 *   GET  /v1/mining/submissions/agent/:address?...
 *   GET  /v1/mining/submissions/:id/artifact
 *   POST /v1/mining/submissions/:id/probe-artifact
 *   POST /v1/mining/submissions/:id/rerun-artifact
 *   GET  /v1/mining/authorship/:address
 *   POST /v1/mining/submissions/:id/counter-argument
 *   POST /v1/mining/submissions/:id/defend
 *   POST /v1/mining/submissions/:id/crowd-score
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "diagnostics.jsonl");

export interface VerdictRow {
  submissionId?: string;
  verdict?: string;
  composite?: number;
  rubricCid?: string;
  ts?: string;
}

export interface MyVerificationRow {
  submissionId: string;
  challengeId?: string;
  challengeTitle?: string;
  difficulty?: number;
  verdict?: string;
  scores?: { correctness?: number; clarity?: number; insight?: number; efficiency?: number };
  rewardCredits?: number;
  ts?: string;
}

export interface AuthorshipRights {
  address: string;
  domains?: Array<{ tag: string; verified_solves: number; authorship_unlocked: boolean }>;
  count?: number;
}

interface LogEntry {
  ts: string;
  kind: "verdict-pull" | "verification-pull" | "authorship-pull" | "artifact-rerun" | "crowd-score" | "error";
  details?: unknown;
  notes?: string;
}

const myAddress = () => (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();

export async function fetchRecentVerdicts(runtime: RuntimeLike, limit = 50): Promise<VerdictRow[]> {
  const addr = myAddress();
  if (!addr) return [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/agents/${encodeURIComponent(addr)}/verdict-summary?limit=${limit}`,
    )) as { verdicts?: VerdictRow[]; items?: VerdictRow[] };
    const rows = res.verdicts ?? res.items ?? [];
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "verdict-pull" as const, notes: `${rows.length} verdicts` });
    return rows;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    return [];
  }
}

export async function fetchMyVerifications(runtime: RuntimeLike, limit = 50): Promise<MyVerificationRow[]> {
  const addr = myAddress();
  if (!addr) return [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/agent/${encodeURIComponent(addr)}?role=verifier&limit=${limit}`,
    )) as { verifications?: MyVerificationRow[]; items?: MyVerificationRow[]; submissions?: MyVerificationRow[] };
    const rows = res.verifications ?? res.items ?? res.submissions ?? [];
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "verification-pull" as const, notes: `${rows.length} rows` });
    return rows;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    return [];
  }
}

export async function fetchAuthorshipRights(runtime: RuntimeLike): Promise<AuthorshipRights | null> {
  const addr = myAddress();
  if (!addr) return null;
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/authorship/${encodeURIComponent(addr)}`,
    )) as AuthorshipRights;
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "authorship-pull" as const, details: res });
    return res;
  } catch (err) {
    return null;
  }
}

export async function inspectSubmissionArtifact(
  runtime: RuntimeLike,
  submissionId: string,
): Promise<unknown | null> {
  try {
    return await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/${encodeURIComponent(submissionId)}/artifact`,
    );
  } catch (err) {
    return null;
  }
}

export async function rerunArtifact(runtime: RuntimeLike, submissionId: string): Promise<unknown | null> {
  try {
    const res = await runtime.connection.request(
      "POST",
      `/v1/mining/submissions/${encodeURIComponent(submissionId)}/rerun-artifact`,
      {},
    );
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "artifact-rerun" as const, notes: submissionId });
    return res;
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      notes: `rerun ${submissionId}: ${(err as Error).message.slice(0, 150)}`,
    });
    return null;
  }
}

/**
 * Score a crowd_jury submission (0-100). Distinct from regular verification —
 * crowd_jury is its own verifier_kind that takes broader subjective scores.
 */
export async function scoreCrowdJury(
  runtime: RuntimeLike,
  submissionId: string,
  score: number,
  notes: string,
): Promise<void> {
  if (score < 0 || score > 100) throw new Error("crowd-jury score must be 0-100");
  try {
    await runtime.connection.request(
      "POST",
      `/v1/mining/submissions/${encodeURIComponent(submissionId)}/crowd-score`,
      { score, notes },
    );
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "crowd-score" as const,
      notes: `${submissionId} score=${score}`,
    });
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      notes: `crowd-score ${submissionId}: ${(err as Error).message.slice(0, 150)}`,
    });
    throw err;
  }
}

/**
 * Submit a counter-argument (only if gateway-assigned as adversarial reviewer).
 * Caller must check eligibility first via a probe call.
 */
export async function counterArgument(
  runtime: RuntimeLike,
  submissionId: string,
  argument: string,
): Promise<void> {
  if (argument.length < 200) throw new Error("counter-argument must be ≥ 200 chars");
  await runtime.connection.request(
    "POST",
    `/v1/mining/submissions/${encodeURIComponent(submissionId)}/counter-argument`,
    { argument },
  );
}

/** Defend our own trace against an adversarial counter-argument. */
export async function defendTrace(
  runtime: RuntimeLike,
  submissionId: string,
  defense: string,
): Promise<void> {
  if (defense.length < 200) throw new Error("defense must be ≥ 200 chars");
  await runtime.connection.request(
    "POST",
    `/v1/mining/submissions/${encodeURIComponent(submissionId)}/defend`,
    { defense },
  );
}

/**
 * Probe: am I assigned as an adversarial reviewer on any submission right now?
 * Returns the list of submissions awaiting our counter-argument, or an empty
 * list if we have no assignments / feature isn't live. Used by the periodic
 * diagnostics tick to detect when the adversarial-review system goes live.
 */
export async function probeAdversarialAssignments(
  runtime: RuntimeLike,
): Promise<Array<{ submissionId: string; assignedAt?: string; deadline?: string }>> {
  const addr = myAddress();
  if (!addr) return [];
  try {
    // The MCP source doesn't have a dedicated assignments endpoint — instead,
    // /v1/mining/submissions/agent/:addr accepts a role filter. "reviewer"
    // returns adversarial-review assignments per the gateway proxy.
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/agent/${encodeURIComponent(addr)}?role=adversarial-reviewer&status=open&limit=20`,
    )) as { assignments?: Array<{ submissionId?: string; id?: string; assignedAt?: string; deadline?: string }>; items?: unknown[] };
    const assignments = res.assignments ?? (res.items as Array<{ submissionId?: string; id?: string; assignedAt?: string; deadline?: string }> | undefined) ?? [];
    const rows = assignments
      .map((a) => ({ submissionId: a.submissionId ?? a.id ?? "", assignedAt: a.assignedAt, deadline: a.deadline }))
      .filter((a) => a.submissionId);
    if (rows.length > 0) {
      appendJsonl(LOG, {
        ts: new Date().toISOString(),
        kind: "verdict-pull" as const,
        notes: `adversarial assignments: ${rows.length}`,
        details: rows,
      });
      console.log(`🛡  ${rows.length} adversarial-review assignment(s) pending — feature LIVE`);
    }
    return rows;
  } catch (err) {
    // 404 = endpoint not yet wired by the gateway. Silent — not actionable.
    return [];
  }
}

/**
 * Probe: do any of MY recent submissions have pending counter-arguments to
 * defend? Returns the list. If feature is not live, returns [].
 */
export async function probeIncomingChallenges(
  runtime: RuntimeLike,
): Promise<Array<{ submissionId: string; argument?: string; deadline?: string }>> {
  const addr = myAddress();
  if (!addr) return [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/agent/${encodeURIComponent(addr)}?role=solver&hasPendingDefense=true&limit=20`,
    )) as { submissions?: Array<{ id?: string; pendingDefense?: { argument?: string; deadline?: string } }> };
    const subs = res.submissions ?? [];
    const rows = subs
      .filter((s) => s.pendingDefense)
      .map((s) => ({
        submissionId: s.id ?? "",
        argument: s.pendingDefense?.argument,
        deadline: s.pendingDefense?.deadline,
      }))
      .filter((r) => r.submissionId);
    if (rows.length > 0) {
      appendJsonl(LOG, {
        ts: new Date().toISOString(),
        kind: "verdict-pull" as const,
        notes: `defense needed: ${rows.length}`,
        details: rows,
      });
      console.log(`🛡  ${rows.length} of our trace(s) need defense against adversarial reviewers`);
    }
    return rows;
  } catch {
    return [];
  }
}

/** Periodic diagnostic snapshot — pulls everything + logs to JSONL. */
export async function runDiagnosticsTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_DIAGNOSTICS_LOOP === "0") return;
  await Promise.all([
    fetchRecentVerdicts(runtime, 50),
    fetchMyVerifications(runtime, 50),
    fetchAuthorshipRights(runtime),
    probeAdversarialAssignments(runtime),
    probeIncomingChallenges(runtime),
  ]);
}

export interface DiagnosticsSummary {
  verdictsLogged: number;
  verificationsLogged: number;
  authorshipDomains: number;
  authorshipUnlocked: number;
  artifactReruns: number;
  crowdScoresGiven: number;
}

export function diagnosticsSummary(): DiagnosticsSummary {
  const all = readJsonl<LogEntry>(LOG);
  const lastAuth = all
    .filter((e) => e.kind === "authorship-pull")
    .map((e) => e.details as AuthorshipRights | undefined)
    .pop();
  return {
    verdictsLogged: all.filter((e) => e.kind === "verdict-pull").length,
    verificationsLogged: all.filter((e) => e.kind === "verification-pull").length,
    authorshipDomains: lastAuth?.domains?.length ?? 0,
    authorshipUnlocked: lastAuth?.domains?.filter((d) => d.authorship_unlocked).length ?? 0,
    artifactReruns: all.filter((e) => e.kind === "artifact-rerun").length,
    crowdScoresGiven: all.filter((e) => e.kind === "crowd-score").length,
  };
}
