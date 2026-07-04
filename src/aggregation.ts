/**
 * Tier-3 aggregation mining (P2.1). Synthesizes multiple verified reasoning
 * traces into a structured KnowledgeAggregateV1 and submits it. Reward split:
 * aggregation miner 50%, source-trace miners 25%, verifiers 15%, treasury 10%.
 * Rate limit: 2 submissions/day. The bot already produces a stream of verified
 * traces, so it is well-placed to aggregate them.
 *
 * Built on the SDK action dispatch (runtime.tools.executeTool) — the bundled
 * handler owns the request/response contract — plus the bot's existing Venice
 * `chat()` for synthesis. Two gates, both automatic/safe:
 *   1. Liveness — list_aggregation_challenges; while the gateway returns
 *      "Endpoint does not exist" this is a logged no-op (the track ships later;
 *      `npm run surfaces` watches for go-live). NO speculative writes.
 *   2. Opt-in — only claims/submits when BOT_AGGREGATION_AUTO=1 (browse-only
 *      otherwise), mirroring the swarm/bounty/teaching auto-* flags.
 *
 * Action contracts (0.5.145 catalog):
 *   list_aggregation_challenges { status?, domain?, limit? }
 *   get_aggregation_challenge   { challengeId }
 *   submit_aggregation          { challengeId, aggregate }   // aggregate: KnowledgeAggregateV1
 *   search_mining_knowledge     { query, domain?, limit? }
 */
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { NOOK_DIR, appendJsonl, readJsonl, extractJsonObj } from "./util.js";
import { join } from "node:path";

type RuntimeLike = Pick<NookplotRuntime, "tools">;

const AGG_LOG = join(NOOK_DIR, "aggregation.jsonl");
const DAILY_CAP = 2; // gateway rate limit: 2 submissions/day

interface AggChallenge {
  id: string;
  domain?: string;
  tags?: string[];
  title?: string;
  inputTraces?: Array<{ id?: string; summary?: string; traceSummary?: string }>;
  outputSpec?: { required?: string[]; optional?: string[] };
  description?: string;
}

/** KnowledgeAggregateV1 — required: synthesis, keyInsights, reasoningPatterns, provenance. */
interface KnowledgeAggregateV1 {
  domain: string;
  tags: string[];
  synthesis: string;
  keyInsights: Array<{ insight: string; confidence?: number; sourceTraceIds?: string[] }>;
  reasoningPatterns: Array<{ pattern: string; description?: string }>;
  provenance: { sourceTraceIds: string[]; method: string; model?: string };
  contradictions?: Array<{ claim: string; counterClaim: string }>;
  knowledgeGaps?: string[];
}

interface AggLogEntry {
  ts: string;
  challengeId: string;
  outcome: "submitted" | "error" | "skipped" | "dormant";
  notes?: string;
}

function isDormant(err: unknown): boolean {
  const m = ((err as Error)?.message ?? String(err));
  return /Endpoint does not exist|Unknown tool|Not found|\b404\b/i.test(m);
}

function submittedToday(): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return readJsonl<AggLogEntry>(AGG_LOG).filter(
    (e) => e.outcome === "submitted" && new Date(e.ts) >= start,
  ).length;
}

function attemptedIds(): Set<string> {
  return new Set(
    readJsonl<AggLogEntry>(AGG_LOG)
      .filter((e) => e.outcome === "submitted" || e.outcome === "skipped")
      .map((e) => e.challengeId),
  );
}

/** Validate the required KnowledgeAggregateV1 sections before spending a daily slot. */
function isWellFormed(a: KnowledgeAggregateV1 | null): a is KnowledgeAggregateV1 {
  return Boolean(
    a &&
      typeof a.synthesis === "string" &&
      a.synthesis.length > 80 &&
      Array.isArray(a.keyInsights) &&
      a.keyInsights.length >= 2 &&
      Array.isArray(a.reasoningPatterns) &&
      a.reasoningPatterns.length >= 1 &&
      a.provenance &&
      Array.isArray(a.provenance.sourceTraceIds),
  );
}

async function synthesize(ch: AggChallenge, model?: string): Promise<KnowledgeAggregateV1 | null> {
  const traces = (ch.inputTraces ?? [])
    .map((t, i) => `[trace ${i + 1}${t.id ? ` id=${t.id}` : ""}] ${t.summary ?? t.traceSummary ?? ""}`)
    .filter((s) => s.length > 12)
    .join("\n\n");
  const sourceIds = (ch.inputTraces ?? []).map((t) => t.id).filter(Boolean) as string[];
  const domain = ch.domain ?? "general";

  const sys =
    "You synthesize multiple reasoning traces into ONE structured KnowledgeAggregateV1. " +
    "Output STRICT JSON only, no prose. Do NOT copy trace text verbatim — synthesize. Schema: " +
    `{"domain":string,"tags":string[],"synthesis":string (information-dense, 150-600 words),` +
    `"keyInsights":[{"insight":string,"confidence":0..1,"sourceTraceIds":string[]}] (>=3, deduped),` +
    `"reasoningPatterns":[{"pattern":string,"description":string}] (>=2),` +
    `"contradictions":[{"claim":string,"counterClaim":string}] (optional),` +
    `"knowledgeGaps":string[] (optional),` +
    `"provenance":{"sourceTraceIds":string[],"method":"llm-synthesis"}}`;
  const user =
    `Domain: ${domain}\nChallenge: ${ch.title ?? ch.description ?? ""}\n` +
    `Required output sections: ${(ch.outputSpec?.required ?? ["synthesis", "keyInsights", "reasoningPatterns", "provenance"]).join(", ")}\n\n` +
    `Source traces to synthesize:\n${traces}`;

  // No web search: submit_aggregation is auto-verified on verbatim-overlap and
  // provenance grounding, so the synthesis must derive ONLY from the provided
  // source traces — external content would risk failing those checks.
  const { content } = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { model, temperature: 0.4, timeoutMs: 180_000 },
  );
  const parsed = extractJsonObj<KnowledgeAggregateV1>(content);
  if (!parsed) return null;
  // Backfill provenance/domain so a slightly-thin model output still validates.
  parsed.domain ??= domain;
  parsed.tags ??= ch.tags ?? [domain];
  parsed.provenance ??= { sourceTraceIds: sourceIds, method: "llm-synthesis" };
  parsed.provenance.sourceTraceIds ??= sourceIds;
  parsed.provenance.method ??= "llm-synthesis";
  parsed.provenance.model = model;
  return parsed;
}

/**
 * Discover and solve aggregation challenges. No-op (logged) while the gateway
 * endpoint is dormant or BOT_AGGREGATION_AUTO!=1. Returns the number submitted.
 */
export async function discoverAndSolveAggregations(runtime: RuntimeLike): Promise<number> {
  let challenges: AggChallenge[];
  try {
    const res = await runtime.tools.executeTool("list_aggregation_challenges", { status: "open", limit: 10 });
    const out = (res?.output ?? {}) as { challenges?: AggChallenge[]; aggregationChallenges?: AggChallenge[] };
    challenges = out.challenges ?? out.aggregationChallenges ?? [];
  } catch (err) {
    if (isDormant(err)) return 0; // not deployed yet — silent no-op
    console.warn(`🧬 aggregation list failed: ${(err as Error).message.slice(0, 120)}`);
    return 0;
  }

  if (challenges.length === 0) return 0;
  console.log(`🧬 ${challenges.length} aggregation challenge(s) open`);
  if (process.env.BOT_AGGREGATION_AUTO !== "1") return 0; // browse-only by default

  const remaining = DAILY_CAP - submittedToday();
  if (remaining <= 0) {
    console.log("🧬 aggregation daily cap (2) reached");
    return 0;
  }
  const seen = attemptedIds();
  const model = process.env.NOOKPLOT_AGENT_API_MODEL;
  let submitted = 0;

  for (const ch of challenges) {
    if (submitted >= remaining) break;
    if (!ch.id || seen.has(ch.id)) continue;
    try {
      const detail = ((await runtime.tools.executeTool("get_aggregation_challenge", { challengeId: ch.id }))
        ?.output ?? {}) as unknown as Partial<AggChallenge> & { challenge?: AggChallenge };
      const full: AggChallenge = detail.challenge ?? { ...ch, ...detail };

      const aggregate = await synthesize(full, model);
      if (!isWellFormed(aggregate)) {
        console.warn(`🧬 ${ch.id.slice(0, 10)} — synthesis malformed, skipping (slot preserved)`);
        appendJsonl(AGG_LOG, { ts: new Date().toISOString(), challengeId: ch.id, outcome: "error", notes: "malformed synthesis" });
        continue;
      }

      await runtime.tools.executeTool("submit_aggregation", { challengeId: ch.id, aggregate });
      submitted += 1;
      console.log(`🧬 ✓ submitted aggregation for ${ch.id.slice(0, 10)} (${aggregate.keyInsights.length} insights)`);
      appendJsonl(AGG_LOG, { ts: new Date().toISOString(), challengeId: ch.id, outcome: "submitted", notes: full.domain });
    } catch (err) {
      console.warn(`🧬 aggregation ${ch.id.slice(0, 10)} failed: ${(err as Error).message.slice(0, 120)}`);
      appendJsonl(AGG_LOG, { ts: new Date().toISOString(), challengeId: ch.id, outcome: "error", notes: (err as Error).message.slice(0, 160) });
    }
  }
  return submitted;
}

export const _internals = { isWellFormed, isDormant, submittedToday };
