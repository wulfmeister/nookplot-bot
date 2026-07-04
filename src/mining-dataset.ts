/**
 * Browse the collective mining dataset — verified traces from all agents.
 *
 * Used to:
 *   1. Show the dashboard a sample of high-scoring peer traces (learning)
 *   2. Augment context for a specific challenge (find similar prior solves)
 *
 * Endpoints:
 *   GET /v1/mining/dataset?...           — browse (metadata mode by default)
 *   GET /v1/mining/dataset/:submissionId — single trace detail (text content)
 *
 * In-memory 1h cache to avoid repeating the same browse.
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface DatasetRow {
  submissionId: string;
  challengeId?: string;
  challengeTitle?: string;
  domainTags?: string[];
  difficulty?: number;
  verifierCount?: number;
  averageScore?: number;
  solver?: string;
  solverDisplayName?: string;
  createdAt?: string;
}

const browseCache = new Map<string, { at: number; rows: DatasetRow[] }>();
const CACHE_TTL_MS = 3600_000;

export async function browseDataset(
  runtime: RuntimeLike,
  opts: {
    domain?: string;
    minScore?: number;
    minVerifiers?: number;
    limit?: number;
  } = {},
): Promise<DatasetRow[]> {
  const params = new URLSearchParams();
  if (opts.domain) params.set("domain", opts.domain);
  if (opts.minScore !== undefined) params.set("minScore", String(opts.minScore));
  if (opts.minVerifiers !== undefined) params.set("minVerifiers", String(opts.minVerifiers));
  params.set("limit", String(opts.limit ?? 20));
  const key = params.toString();
  const hit = browseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/dataset?${key}`,
    )) as { rows?: DatasetRow[]; items?: DatasetRow[]; submissions?: DatasetRow[] };
    const rows = res.rows ?? res.items ?? res.submissions ?? [];
    browseCache.set(key, { at: Date.now(), rows });
    return rows;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return [];
    console.warn(`📚 dataset browse failed: ${msg}`);
    return [];
  }
}

export async function getDatasetEntry(
  runtime: RuntimeLike,
  submissionId: string,
): Promise<unknown | null> {
  try {
    return await runtime.connection.request(
      "GET",
      `/v1/mining/dataset/${encodeURIComponent(submissionId)}`,
    );
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) return null;
    return null;
  }
}

/** Pick the top N traces in a given domain (by avgScore) for context augmentation. */
export async function topPeerTracesForDomain(
  runtime: RuntimeLike,
  domain: string,
  n = 3,
): Promise<DatasetRow[]> {
  const rows = await browseDataset(runtime, { domain, minVerifiers: 3, minScore: 0.7, limit: 20 });
  return [...rows]
    .sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0))
    .slice(0, n);
}

/**
 * Render a compact peer-trace block for a prompt's context section. Each peer
 * trace is summarized as "challenge → solver score". Total ≤ ~maxChars to
 * avoid prompt bloat.
 */
export function renderPeerTraceBlock(rows: DatasetRow[], maxChars = 600): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const title = (r.challengeTitle ?? r.challengeId ?? "").slice(0, 70);
    const score = (r.averageScore ?? 0).toFixed(2);
    const v = r.verifierCount ?? 0;
    return `  - "${title}" — score ${score} (${v}v)`;
  });
  let block = `## Top peer solves in this domain\n${lines.join("\n")}`;
  if (block.length > maxChars) {
    block = block.slice(0, maxChars - 1) + "…";
  }
  return block;
}

/** Convenience: fetch + render peer-trace block for a challenge's first domain tag. */
export async function fetchPeerTraceBlockForChallenge(
  runtime: RuntimeLike,
  domainTags: string[],
): Promise<string> {
  if (domainTags.length === 0) return "";
  const rows = await topPeerTracesForDomain(runtime, domainTags[0], 3);
  return renderPeerTraceBlock(rows);
}
