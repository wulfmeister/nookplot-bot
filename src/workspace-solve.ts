/**
 * Cognitive-workspace integration for mining solves.
 *
 * The gateway exposes `/v1/workspaces/*` — shared mutable workspaces with
 * cognitive regions (`hypotheses | evidence | decisions | open_questions |
 * constraints | artifacts | evaluators`). Items can be linked across
 * regions, transitioned (`proposed → confirmed`), and workspaces can be
 * forked by other agents.
 *
 * This module records each mining solve as a workspace so:
 *   1. Other agents can fork our solving process (gateway → marketplace)
 *   2. Future solves on similar challenges can read our prior hypotheses
 *   3. Verifiers can audit the reasoning chain explicitly
 *
 * It does NOT replace our existing solve pipeline (`solveStandardTrace`
 * + `refineStandardTrace`). It runs AFTER a successful solve to persist
 * the state.
 *
 * Toggle off with BOT_WORKSPACE_SOLVE=0.
 *
 * Endpoints used:
 *   POST /v1/workspaces                      — create
 *   POST /v1/workspaces/:id/cognitive/:region — add item (region in body)
 *   POST /v1/workspaces/:id/cognitive/links   — cross-region link
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG_PATH = join(NOOK_DIR, "workspace-solves.jsonl");
let warnedWrappedContent = false;

type Region =
  | "hypotheses"
  | "evidence"
  | "decisions"
  | "open_questions"
  | "constraints"
  | "artifacts"
  | "evaluators";

// Gateway introduced per-region status enums (observed 2026-06-03):
// 400 'Invalid status X for region Y. Must be one of: …'. Each region
// has its own vocabulary, so the global "confirmed" default no longer
// passes. Map below picks a safe default per region. If the gateway
// later renames or trims a value, the addItem catch logs the 400 with
// the allowed list so we can update.
export const REGION_DEFAULT_STATUS: Record<Region, string> = {
  constraints: "active",
  evidence: "validated",
  hypotheses: "proposed",
  decisions: "proposed",
  artifacts: "reviewed",
  open_questions: "open",
  evaluators: "active",
};

export function statusForRegion(region: Region, override?: string): string {
  if (override && override.length > 0) return override;
  return REGION_DEFAULT_STATUS[region] ?? "active";
}

interface WorkspaceCreateResp {
  workspaceId?: string;
  id?: string;
}

interface RecordableSolve {
  challengeId: string;
  challengeTitle?: string;
  challengeDescription?: string;
  domainTags?: string[];
  model: string;
  reasoningEffort?: string;
  citations?: Array<{ title?: string; url?: string; source?: string }>;
  domainHint?: string;
  refined: boolean;
  traceContent?: string;
  traceSummary?: string;
  submissionId?: string;
}

export function normalizeWorkspaceContent(content: unknown): Record<string, unknown> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (!warnedWrappedContent) {
    console.warn("   ⚠ workspace content was not an object; wrapping as { text } for gateway compatibility");
    warnedWrappedContent = true;
  }
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { text: (text ?? "").slice(0, 8000) };
}

async function createWorkspace(
  runtime: RuntimeLike,
  ch: { id: string; title?: string },
): Promise<string | null> {
  try {
    const res = (await runtime.connection.request("POST", "/v1/workspaces", {
      name: `Solve: ${(ch.title ?? ch.id.slice(0, 12)).slice(0, 80)}`,
      description: `Mining solve workspace for challenge ${ch.id}. Records hypotheses / evidence / decisions / artifacts from the bot's pipeline so other agents can fork and audit.`,
    })) as WorkspaceCreateResp;
    return res.workspaceId ?? res.id ?? null;
  } catch (err) {
    console.warn(`   ⚠ workspace create failed: ${(err as Error).message.slice(0, 150)}`);
    return null;
  }
}

async function addItem(
  runtime: RuntimeLike,
  workspaceId: string,
  region: Region,
  itemId: string,
  content: unknown,
  opts: { status?: string; confidence?: number } = {},
): Promise<boolean> {
  try {
    await runtime.connection.request(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/cognitive/${region}`,
      {
        itemId,
        content: normalizeWorkspaceContent(content),
        status: statusForRegion(region, opts.status),
        confidence: opts.confidence ?? 0.7,
      },
    );
    return true;
  } catch (err) {
    console.warn(`   ⚠ workspace item add failed (${region}/${itemId}): ${(err as Error).message.slice(0, 120)}`);
    return false;
  }
}

async function linkItems(
  runtime: RuntimeLike,
  workspaceId: string,
  fromRegion: Region,
  fromItemId: string,
  toRegion: Region,
  toItemId: string,
  linkType: "supports" | "contradicts" | "extends" | "derives_from" = "derives_from",
): Promise<void> {
  try {
    await runtime.connection.request(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/cognitive/links`,
      { fromRegion, fromItemId, toRegion, toItemId, linkType, strength: 0.8 },
    );
  } catch { /* link failures are non-fatal */ }
}

/**
 * Record the full state of a successful solve as a cognitive workspace.
 * Returns the workspace id (or null if creation failed / disabled).
 */
export async function recordSolveAsWorkspace(
  runtime: RuntimeLike,
  solve: RecordableSolve,
): Promise<string | null> {
  if (process.env.BOT_WORKSPACE_SOLVE === "0") return null;

  const wsId = await createWorkspace(runtime, {
    id: solve.challengeId,
    title: solve.challengeTitle,
  });
  if (!wsId) return null;

  // Constraints — challenge bounds + our model/effort
  const constraintsContent =
    `Challenge: ${solve.challengeTitle ?? solve.challengeId.slice(0, 12)}\n` +
    `Domains: ${(solve.domainTags ?? []).join(", ") || "general"}\n` +
    `Model: ${solve.model}${solve.reasoningEffort ? `, effort=${solve.reasoningEffort}` : ""}\n` +
    `Pipeline: ${solve.refined ? "refined (critique+revise)" : "single-shot"}\n` +
    `Domain hint applied: ${solve.domainHint ?? "(none)"}`;
  await addItem(runtime, wsId, "constraints", "constraints-1", constraintsContent);

  // Evidence — the citations gathered
  const cits = solve.citations ?? [];
  for (let i = 0; i < Math.min(cits.length, 8); i++) {
    const c = cits[i];
    const content = `[${c.source ?? "unknown"}] ${c.title ?? "(untitled)"}${c.url ? ` <${c.url}>` : ""}`;
    await addItem(runtime, wsId, "evidence", `evidence-${i + 1}`, content, { confidence: 0.8 });
  }

  // Hypothesis — what we tried (we only ran one approach; this is essentially the trace summary)
  if (solve.traceSummary) {
    await addItem(runtime, wsId, "hypotheses", "hypothesis-1", solve.traceSummary, { confidence: 0.7 });
  }

  // Decision — model choice + refinement decision
  const decisionContent =
    `Chosen model: ${solve.model}\n` +
    `Effort: ${solve.reasoningEffort ?? "default"}\n` +
    `Refine pass: ${solve.refined ? "applied" : "skipped"}`;
  await addItem(runtime, wsId, "decisions", "decision-1", decisionContent);
  if (solve.traceSummary) await linkItems(runtime, wsId, "decisions", "decision-1", "hypotheses", "hypothesis-1", "supports");

  // Artifact — the trace itself (truncated for the workspace cap)
  if (solve.traceContent) {
    await addItem(runtime, wsId, "artifacts", "artifact-trace", solve.traceContent, { confidence: 0.8 });
    if (solve.traceSummary) await linkItems(runtime, wsId, "artifacts", "artifact-trace", "hypotheses", "hypothesis-1", "derives_from");
  }

  // Open question — what could be better? Generic placeholder; future solves
  // can use these to plan critique passes.
  await addItem(
    runtime,
    wsId,
    "open_questions",
    "oq-1",
    "Did the trace include enough citation density (≥2 Author Year pairs) and unit-bearing benchmarks for verifier quorum? Re-check after composite score lands.",
    { status: "open", confidence: 0.5 },
  );

  appendJsonl(LOG_PATH, {
    ts: new Date().toISOString(),
    challengeId: solve.challengeId,
    submissionId: solve.submissionId,
    workspaceId: wsId,
    model: solve.model,
    refined: solve.refined,
    citationCount: cits.length,
    traceLen: solve.traceContent?.length ?? 0,
  });

  console.log(`🧩 workspace ${wsId.slice(0, 10)} recorded for solve of ${solve.challengeId.slice(0, 8)} (forkable)`);
  return wsId;
}
