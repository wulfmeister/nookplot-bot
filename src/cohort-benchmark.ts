/**
 * Weekly cohort benchmark (2026-06-12). Observability ONLY — changes no
 * bot behavior.
 *
 * Why: the network's emission pool is shared, so our absolute NOOK/day can
 * move for reasons that have nothing to do with us. The honest performance
 * question is always RELATIVE: are we keeping pace with agents of our own
 * age? The 2026-06-11 analysis found our same-cohort peers (all created
 * 05-14→05-19, like us) ran 71-74 submissions/7d vs our 59 — a ~20%
 * throughput gap that lifetime totals obscured. This tick turns that
 * one-off analysis into a standing weekly metric via
 * GET /v1/mining/submissions/agent/:addr (public per-agent histories).
 *
 * Cohort defaults to the five peers from that analysis; override with
 * BOT_COHORT_ADDRS (comma-separated). If a peer goes inactive it just
 * shows 0 — interpret in the weekly line, don't auto-replace (silent
 * cohort churn would make trends meaningless).
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";
import { bundleDue } from "./bundles.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "cohort-benchmark.jsonl");
const INTERVAL_DAYS = Number(process.env.BOT_COHORT_INTERVAL_DAYS ?? 7);
const WINDOW_DAYS = 7;

// Our own address comes from the env (same var the dashboard uses) — it was
// previously hardcoded to the original operator's wallet, which made every
// cloner benchmark someone else's stats as their own.
const US = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();
// No default cohort — set BOT_COHORT_ADDRS to a comma-separated list of peer
// addresses in YOUR age band / domain mix (the tick no-ops when empty).
const DEFAULT_COHORT: string[] = [];

export function cohortAddresses(): string[] {
  const env = process.env.BOT_COHORT_ADDRS;
  if (!env) return DEFAULT_COHORT;
  return env.split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

/** Count timestamps within the trailing window. Pure — testable. */
export function countWithinDays(timestampsMs: number[], nowMs: number, days: number): number {
  const cutoff = nowMs - days * 86_400_000;
  return timestampsMs.filter((t) => Number.isFinite(t) && t >= cutoff && t <= nowMs).length;
}

interface SubRow {
  submittedAt?: string;
  submitted_at?: string;
  createdAt?: string;
  status?: string;
}

async function fetchAgentWeek(runtime: RuntimeLike, addr: string, nowMs: number): Promise<{ last7d: number; rejected7d: number } | null> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/submissions/agent/${encodeURIComponent(addr)}?limit=100`,
    )) as { submissions?: SubRow[] };
    const subs = res.submissions ?? [];
    const ts = subs.map((s) => Date.parse(s.submittedAt ?? s.submitted_at ?? s.createdAt ?? ""));
    const recent = subs.filter((s, i) => Number.isFinite(ts[i]) && nowMs - ts[i] < WINDOW_DAYS * 86_400_000);
    return {
      last7d: countWithinDays(ts, nowMs, WINDOW_DAYS),
      rejected7d: recent.filter((s) => s.status === "rejected").length,
    };
  } catch {
    return null;
  }
}

export async function runCohortBenchmarkTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_COHORT_BENCHMARK === "0") return;
  const entries = readJsonl<{ ts: string }>(LOG);
  const lastTs = entries.length > 0 ? entries[entries.length - 1].ts : undefined;
  if (!bundleDue(lastTs, Date.now(), INTERVAL_DAYS)) return;

  if (!US) {
    console.log("📊 cohort benchmark: NOOKPLOT_AGENT_ADDRESS not set — skipping");
    return;
  }
  const now = Date.now();
  const ours = await fetchAgentWeek(runtime, US, now);
  if (!ours) {
    console.warn("📊 cohort benchmark: failed to fetch our own submissions — skipping this week");
    return;
  }
  const peers: Record<string, { last7d: number; rejected7d: number } | null> = {};
  for (const addr of cohortAddresses()) {
    peers[addr] = await fetchAgentWeek(runtime, addr, now);
  }
  const peerCounts = Object.values(peers).filter(Boolean).map((p) => p!.last7d);
  const peerMedian = peerCounts.length
    ? peerCounts.sort((a, b) => a - b)[Math.floor(peerCounts.length / 2)]
    : 0;
  const pct = peerMedian > 0 ? Math.round((ours.last7d / peerMedian) * 100) : 0;
  console.log(
    `📊 cohort benchmark: us ${ours.last7d} subs/7d (${ours.rejected7d} rejected) vs peer median ${peerMedian} — ${pct}% of cohort pace ` +
    `[${Object.entries(peers).map(([a, p]) => `${a.slice(0, 6)}=${p ? p.last7d : "?"}`).join(" ")}]`,
  );
  appendJsonl(LOG, {
    ts: new Date().toISOString(),
    us: ours,
    peers,
    peerMedian,
    pctOfCohortPace: pct,
  });
}
