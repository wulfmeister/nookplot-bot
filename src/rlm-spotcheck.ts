/**
 * RLM spot-check verifier track.
 *
 * Parallel to standard verification (`pollVerifiableSubmissions` in
 * index.ts). For each RLM trajectory awaiting a spot-check:
 *   1. Pull the prompt CID from IPFS
 *   2. Call the *disclosed* model with that prompt via Venice
 *   3. POST the raw replay text — the gateway re-embeds + computes cosine
 *      against the cached original-output embedding (3-of-5 quorum)
 *
 * Cap: 10 verdicts per 24h per wallet (separate from the 30/day standard
 * verifier cap). Outlier verdicts earn 0 NOOK but no slashing.
 *
 * Endpoints:
 *   GET  /v1/mining/spot-checks/pending?limit=N&has_byok=true
 *   POST /v1/mining/submissions/:id/spot-check
 *        body: { sub_call_id, replay_response_text }
 *
 * Toggle off with BOT_RLM_SPOTCHECK=0.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { NOOK_DIR, appendJsonl, sleep } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG_PATH = join(NOOK_DIR, "rlm-spotchecks.jsonl");
const DAILY_CAP = 10; // Gateway-enforced. Local mirror for log scheduling.

interface PendingTrajectory {
  submissionId?: string;
  submission_id?: string;
  trajectoryId?: string;
  subCallId?: string;
  sub_call_id?: string;
  promptCid?: string;
  prompt_cid?: string;
  claimedModel?: string;
  claimed_model?: string;
  solverAddress?: string;
  solver_address?: string;
  difficulty?: string;
  domainTags?: string[];
  domain_tags?: string[];
}

interface PendingResp {
  trajectories?: PendingTrajectory[];
  dailyCount?: number;
  dailyCap?: number;
  exhausted?: boolean;
}

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

/**
 * Fetch the prompt text from IPFS. Try the gateway's content-by-cid helper
 * first, fall back to ipfs.io public gateway. Returns null on all-fail.
 */
async function fetchPromptFromCid(runtime: RuntimeLike, cid: string): Promise<string | null> {
  // Path A: gateway helper if available
  try {
    const res = (await runtime.connection.request("GET", `/v1/content/${encodeURIComponent(cid)}`)) as {
      content?: string;
      text?: string;
      data?: { content?: string; prompt?: string };
    };
    const text = res.content ?? res.text ?? res.data?.content ?? res.data?.prompt;
    if (typeof text === "string" && text.length > 0) return text;
  } catch { /* fall through */ }
  // Path B: public IPFS gateway
  try {
    const r = await fetch(`https://ipfs.io/ipfs/${encodeURIComponent(cid)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const text = await r.text();
      if (text && text.length > 0) return text;
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Map the claimed model name to a Venice id we can call. The trajectory's
 * `claimedModel` is whatever the solver self-reported — we attempt a direct
 * passthrough first, and fall back to our default reasoning model if Venice
 * rejects the id.
 */
export function normalizeModel(claimedModel: string | undefined): string {
  // Our own default/fallback is claude-opus-4-8 (2026-06-17). The 4-7 entries
  // stay so we faithfully reproduce a trace a solver claims to have run on 4-7
  // (still valid on Venice) — that's fidelity to their claim, not our choice.
  if (!claimedModel) return "claude-opus-4-8";
  // Light normalization for common display variants
  const m = claimedModel.trim().toLowerCase().replace(/\s+/g, "-");
  // Direct passthroughs for ids we know Venice accepts
  const known = new Set([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "openai-gpt-55",
    "openai-gpt-55-pro",
    "grok-4-3",
    "grok-4-20",
    "gemini-3-1-pro-preview",
    "gemini-3-5-flash",
    "deepseek-v4-pro",
    "kimi-k2-6",
  ]);
  if (known.has(m)) return m;
  // Common alias rewrites
  if (m.startsWith("grok-4.3") || m === "grok-4.3") return "grok-4-3";
  if (m.startsWith("claude-opus-4.8")) return "claude-opus-4-8";
  if (m.startsWith("claude-opus-4.7")) return "claude-opus-4-7";
  if (m.startsWith("gpt-5") || m.startsWith("openai-gpt5")) return "openai-gpt-55";
  return "claude-opus-4-8"; // safe fallback
}

async function callDisclosedModel(prompt: string, model: string): Promise<string | null> {
  try {
    const res = await chat(
      // We're replicating a sub-call; the prompt is opaque to us.
      // Use a neutral system to avoid biasing the embedding comparison.
      [
        { role: "system", content: "You are a careful assistant. Respond to the user's message directly." },
        { role: "user", content: prompt.slice(0, 30_000) },
      ],
      { max_tokens: 4000, temperature: 0.2, model, timeoutMs: 180_000 },
    );
    const text = (res.content ?? "").trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.warn(`   ⚠ rlm replay model call failed (${model}): ${(err as Error).message}`);
    return null;
  }
}

export async function runRlmSpotCheckLoop(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_RLM_SPOTCHECK === "0") return;
  let pending: PendingResp;
  try {
    pending = (await runtime.connection.request(
      "GET",
      "/v1/mining/spot-checks/pending?limit=20",
    )) as PendingResp;
  } catch (err) {
    console.warn(`   ⚠ rlm spot-check list failed: ${(err as Error).message}`);
    return;
  }
  const trajectories = pending.trajectories ?? [];
  const dailyCount = pending.dailyCount ?? 0;
  const cap = pending.dailyCap ?? DAILY_CAP;
  if (pending.exhausted || dailyCount >= cap) {
    return; // Quiet — daily exhausted is the steady-state.
  }
  if (trajectories.length === 0) return; // Quiet — empty queue is common.

  console.log(`🛰  rlm spot-checks: ${trajectories.length} pending (${dailyCount}/${cap} done today)`);

  // Don't burn the whole daily cap in one tick — pace ourselves.
  const budget = Math.min(trajectories.length, Math.max(0, cap - dailyCount), 3);
  for (let i = 0; i < budget; i++) {
    const t = trajectories[i] as unknown as Record<string, unknown>;
    const subId = pick<string>(t, "submissionId", "submission_id");
    const subCallId = pick<string>(t, "subCallId", "sub_call_id");
    const promptCid = pick<string>(t, "promptCid", "prompt_cid");
    const claimedModel = pick<string>(t, "claimedModel", "claimed_model");
    if (!subId || !subCallId || !promptCid) {
      console.warn(`   ⚠ rlm trajectory missing required fields — skipping`);
      continue;
    }

    const prompt = await fetchPromptFromCid(runtime, promptCid);
    if (!prompt) {
      console.warn(`   ⚠ rlm prompt fetch failed for cid ${promptCid.slice(0, 12)} — skipping`);
      continue;
    }

    const model = normalizeModel(claimedModel);
    console.log(`   🛰  replaying ${String(subId).slice(0, 8)}/${String(subCallId).slice(0, 8)} on ${model} (prompt ${prompt.length}ch)`);

    const replayText = await callDisclosedModel(prompt, model);
    if (!replayText) {
      appendJsonl(LOG_PATH, {
        ts: new Date().toISOString(),
        submissionId: subId,
        subCallId,
        model,
        outcome: "skip-no-replay",
      });
      continue;
    }

    try {
      const verdictRes = (await runtime.connection.request(
        "POST",
        `/v1/mining/submissions/${encodeURIComponent(subId)}/spot-check`,
        { sub_call_id: subCallId, replay_response_text: replayText },
      )) as { ok?: boolean; cosine?: number; consensus_aligned?: boolean; quorumReached?: boolean };
      console.log(
        `   🛰  ✅ verdict submitted ${String(subId).slice(0, 8)}` +
          (verdictRes.cosine !== undefined ? ` cosine=${verdictRes.cosine?.toFixed?.(3)}` : "") +
          (verdictRes.quorumReached ? " (quorum reached!)" : ""),
      );
      appendJsonl(LOG_PATH, {
        ts: new Date().toISOString(),
        submissionId: subId,
        subCallId,
        model,
        outcome: "verdict-submitted",
        cosine: verdictRes.cosine,
        consensus_aligned: verdictRes.consensus_aligned,
        quorumReached: verdictRes.quorumReached,
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`   ⚠ rlm verdict failed for ${String(subId).slice(0, 8)}: ${msg.slice(0, 200)}`);
      appendJsonl(LOG_PATH, {
        ts: new Date().toISOString(),
        submissionId: subId,
        subCallId,
        model,
        outcome: "verdict-error",
        notes: msg.slice(0, 200),
      });
    }
    await sleep(45_000); // pace to honor the gateway's anti-rubber-stamp expectations
  }
}
