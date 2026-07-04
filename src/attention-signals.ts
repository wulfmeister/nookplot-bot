/**
 * Attention signals + geometric matching.
 *
 * Two distinct features bundled into one module:
 *
 *   1. ATTENTION SIGNALS — gateway-side notifications when another agent's
 *      work matches our profile/manifest. Cheaper than polling /discover.
 *      Endpoints:
 *        GET  /v1/agents/me/attention-signals?...
 *        POST /v1/agents/me/attention-signals/ack
 *
 *   2. GEOMETRIC MATCHING — embedding-similarity agent search (vs keyword tags).
 *      Endpoints:
 *        POST /v1/match/geometric
 *
 * Logs all unacked signals to ~/.nookplot/attention-signals.jsonl so dashboard
 * can show them.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "attention-signals.jsonl");

export interface AttentionSignal {
  id: string;
  kind?: string;
  subjectType?: string;
  subjectId?: string;
  subjectTitle?: string;
  matchedTags?: string[];
  fromAddress?: string;
  ts?: string;
  message?: string;
}

interface LogEntry {
  ts: string;
  kind: "signal" | "ack" | "match-geometric" | "error";
  signalId?: string;
  details?: unknown;
  notes?: string;
}

export async function fetchAttentionSignals(runtime: RuntimeLike, limit = 20): Promise<AttentionSignal[]> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/agents/me/attention-signals?limit=${limit}`,
    )) as { signals?: AttentionSignal[]; items?: AttentionSignal[] };
    return res.signals ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    return [];
  }
}

export async function ackAttentionSignals(runtime: RuntimeLike, signalIds: string[]): Promise<void> {
  if (signalIds.length === 0) return;
  try {
    await runtime.connection.request("POST", `/v1/agents/me/attention-signals/ack`, { signalIds });
    for (const id of signalIds) {
      appendJsonl(LOG, { ts: new Date().toISOString(), kind: "ack" as const, signalId: id });
    }
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      notes: `ack ${signalIds.length}: ${(err as Error).message.slice(0, 150)}`,
    });
  }
}

/** Geometric match against an embedding query. Returns ranked agent addresses. */
export async function matchGeometric(
  runtime: RuntimeLike,
  opts: {
    query?: string;
    embedding?: number[];
    matchType?: "intent-to-intent" | "intent-to-agent" | "agent-to-agent";
    limit?: number;
  },
): Promise<Array<{ address: string; score: number; displayName?: string }>> {
  try {
    const res = (await runtime.connection.request("POST", `/v1/match/geometric`, opts)) as {
      matches?: Array<{ address: string; score: number; displayName?: string }>;
      items?: Array<{ address: string; score: number; displayName?: string }>;
    };
    const matches = res.matches ?? res.items ?? [];
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "match-geometric" as const,
      notes: `${matches.length} matches`,
    });
    return matches;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    return [];
  }
}

/**
 * Weekly collaborator-finder tick — use match_geometric with our specialization
 * tags as the query to surface 3-5 agents whose work is embedding-similar to
 * ours. Pure discovery: logs candidates, never DMs or follows automatically.
 *
 * Toggle: BOT_COLLAB_FINDER=0 disables. Default ON.
 */
export async function runCollabFinderTick(runtime: RuntimeLike): Promise<number> {
  if (process.env.BOT_COLLAB_FINDER === "0") return 0;
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  const recent = readJsonl<LogEntry>(LOG).filter(
    (e) => e.kind === "match-geometric" && e.ts && new Date(e.ts).getTime() >= cutoff,
  );
  // Only run once / 7d — match_geometric is heavyweight + results are stable
  if (recent.length > 0) return 0;
  const domains = (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (domains.length === 0) return 0;
  const me = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
  const matches = await matchGeometric(runtime, {
    query: domains.join(" "),
    matchType: "agent-to-agent",
    limit: 10,
  });
  const useful = matches.filter((m) => m.address.toLowerCase() !== me);
  for (const m of useful.slice(0, 5)) {
    console.log(`🤝 collaborator candidate: ${m.displayName ?? m.address.slice(0, 10)} score=${m.score.toFixed(3)}`);
  }
  appendJsonl(LOG, {
    ts: new Date().toISOString(),
    kind: "match-geometric" as const,
    notes: `weekly collab finder: ${useful.length} candidates`,
    details: useful.slice(0, 5),
  });
  return useful.length;
}

export async function runAttentionTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_ATTENTION_LOOP === "0") return;
  const signals = await fetchAttentionSignals(runtime);
  if (signals.length === 0) return;
  // Record webhook-freshness — even though this fetch went through polling,
  // any signal received means the gateway-side queue has been advancing.
  // (Real webhook handler would also call recordWebhookSignal on push.)
  const { recordWebhookSignal } = await import("./subscriptions.js");
  recordWebhookSignal();
  const seen = new Set(
    readJsonl<LogEntry>(LOG).filter((e) => e.kind === "signal").map((e) => e.signalId).filter(Boolean) as string[],
  );
  const fresh = signals.filter((s) => !seen.has(s.id));
  for (const s of fresh) {
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "signal" as const, signalId: s.id, details: s });
    console.log(
      `📡 attention: ${s.kind ?? "?"} on "${(s.subjectTitle ?? s.subjectId ?? "").slice(0, 50)}" ` +
        `(${(s.matchedTags ?? []).join(",")}) from ${s.fromAddress?.slice(0, 10) ?? "?"}`,
    );
  }
  // Auto-ack to keep the queue clean. We've already logged them.
  if (fresh.length > 0) {
    await ackAttentionSignals(runtime, fresh.map((s) => s.id));
  }
}

export interface AttentionSummary {
  signalsLast24h: number;
  totalSignals: number;
  geometricMatchesLast24h: number;
}

export function attentionSummary(): AttentionSummary {
  const cutoff = Date.now() - 24 * 3600_000;
  const all = readJsonl<LogEntry>(LOG);
  return {
    signalsLast24h: all.filter(
      (e) => e.kind === "signal" && e.ts && new Date(e.ts).getTime() >= cutoff,
    ).length,
    totalSignals: all.filter((e) => e.kind === "signal").length,
    geometricMatchesLast24h: all.filter(
      (e) => e.kind === "match-geometric" && e.ts && new Date(e.ts).getTime() >= cutoff,
    ).length,
  };
}
