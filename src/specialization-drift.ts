/**
 * Specialization-drift detector.
 *
 * Network domains evolve — new tags spawn, others merge or get renamed.
 * If our BOT_SPECIALIZE_DOMAINS env stays static while the network drifts,
 * we silently miss matches.
 *
 * This module diffs our local tags against the network's domain index and
 * surfaces drift on the dashboard. It does NOT auto-update the env —
 * specialization is operator-controlled — but it makes the drift visible
 * so the operator can act.
 *
 * Cadence: once per 24h (covered by index.ts), but the work is cached for
 * the lifetime of the process — re-reading the wiki index is cheap because
 * it's part of network-wiki.ts.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "specialization-drift.jsonl");

interface DriftSnapshot {
  ts: string;
  ourTags: string[];
  networkDomains: string[];
  unmatchedTags: string[];   // ours but not in network
  candidateAdds: string[];   // network has but we don't (top 10 by activity)
  candidateRenames: Array<{ ours: string; possible: string[] }>;
}

export interface NetworkWikiIndex {
  domains?: Array<{ domain: string; citationCount?: number; updatedAt?: string }>;
  items?: Array<{ domain: string; citationCount?: number; updatedAt?: string }>;
  /** Older shape: flat list of strings */
  list?: string[];
}

function ourSpecializationTags(): string[] {
  return (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Heuristic: candidate rename is a network domain that shares ≥ 60% of
 * trigrams with one of our specialization tags. Catches renames like
 * "distributed-systems" → "distributed_systems" or "cs.distributed".
 */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function findRenames(ourTags: string[], networkDomains: string[]): Array<{ ours: string; possible: string[] }> {
  const out: Array<{ ours: string; possible: string[] }> = [];
  const networkSet = new Set(networkDomains.map((d) => d.toLowerCase()));
  for (const t of ourTags) {
    if (networkSet.has(t.toLowerCase())) continue; // exact match — no drift
    const ours = trigrams(t);
    const possible: Array<{ d: string; j: number }> = [];
    for (const d of networkDomains) {
      const j = jaccard(ours, trigrams(d));
      if (j >= 0.6) possible.push({ d, j });
    }
    if (possible.length > 0) {
      out.push({
        ours: t,
        possible: possible
          .sort((a, b) => b.j - a.j)
          .slice(0, 3)
          .map((p) => p.d),
      });
    }
  }
  return out;
}

/** Fetch the network wiki index. Tolerant of multiple response shapes. */
async function fetchNetworkDomainIndex(runtime: RuntimeLike): Promise<Array<{ domain: string; citationCount?: number }>> {
  try {
    const res = (await runtime.connection.request("GET", `/v1/network/wiki`)) as NetworkWikiIndex;
    const items = res.domains ?? res.items;
    if (items && Array.isArray(items)) return items;
    if (res.list && Array.isArray(res.list)) return res.list.map((d) => ({ domain: d }));
    return [];
  } catch {
    return [];
  }
}

/**
 * Run the drift check + write a snapshot. Returns the snapshot for direct
 * use by the dashboard. Idempotent — once-per-day timestamp gate to avoid
 * spamming the log.
 */
export async function runSpecializationDriftTick(runtime: RuntimeLike): Promise<DriftSnapshot | null> {
  const lastRun = readJsonl<DriftSnapshot>(LOG).slice(-1)[0];
  if (lastRun && Date.now() - new Date(lastRun.ts).getTime() < 24 * 3600_000) {
    return lastRun;
  }
  const ourTags = ourSpecializationTags();
  if (ourTags.length === 0) return null;
  const networkItems = await fetchNetworkDomainIndex(runtime);
  if (networkItems.length === 0) return null;
  const networkDomains = networkItems.map((x) => x.domain);
  const networkSet = new Set(networkDomains.map((d) => d.toLowerCase()));
  const unmatchedTags = ourTags.filter((t) => !networkSet.has(t.toLowerCase()));
  // Top 10 candidate adds: high-citation network domains we don't currently track
  const ourLower = new Set(ourTags.map((t) => t.toLowerCase()));
  const candidateAdds = [...networkItems]
    .filter((d) => !ourLower.has(d.domain.toLowerCase()))
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
    .slice(0, 10)
    .map((d) => d.domain);
  const candidateRenames = findRenames(ourTags, networkDomains);
  const snap: DriftSnapshot = {
    ts: new Date().toISOString(),
    ourTags,
    networkDomains,
    unmatchedTags,
    candidateAdds,
    candidateRenames,
  };
  appendJsonl(LOG, snap);
  if (unmatchedTags.length > 0) {
    console.log(`🧭 specialization drift: ${unmatchedTags.length} of our tags not in network catalog (${unmatchedTags.join(", ")})`);
  }
  if (candidateRenames.length > 0) {
    for (const r of candidateRenames) {
      console.log(`🧭 possible rename: "${r.ours}" → ${r.possible.map((p) => `"${p}"`).join(" or ")}`);
    }
  }
  return snap;
}

export interface DriftSummary {
  lastChecked: string | null;
  unmatchedCount: number;
  candidateRenameCount: number;
  topCandidateAdds: string[];
}

export function driftSummary(): DriftSummary {
  const last = readJsonl<DriftSnapshot>(LOG).slice(-1)[0];
  if (!last) return { lastChecked: null, unmatchedCount: 0, candidateRenameCount: 0, topCandidateAdds: [] };
  return {
    lastChecked: last.ts,
    unmatchedCount: last.unmatchedTags.length,
    candidateRenameCount: last.candidateRenames.length,
    topCandidateAdds: last.candidateAdds.slice(0, 5),
  };
}
