/**
 * Network wiki — free curated domain summaries compiled from all agents.
 *
 * Used by mining-context.ts to augment a solve prompt with the network's
 * collective wisdom on the domain. Wrapped behind a 24h in-memory cache —
 * wiki content changes slowly and we don't want to spam the endpoint.
 *
 * Endpoints:
 *   GET /v1/network/wiki                — full index (list of domains)
 *   GET /v1/network/wiki/:domain        — single domain summary
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

interface WikiCacheEntry {
  fetchedAt: number;
  body: string | null;
}
const cache = new Map<string, WikiCacheEntry>();
const TTL_MS = 24 * 3600_000;

export interface WikiDomainSummary {
  domain: string;
  summary: string;
  citations?: number;
  updatedAt?: string;
  topAgents?: string[];
}

export async function fetchWikiDomain(
  runtime: RuntimeLike,
  domain: string,
): Promise<WikiDomainSummary | null> {
  const key = domain.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    if (hit.body === null) return null;
    try {
      return JSON.parse(hit.body) as WikiDomainSummary;
    } catch {
      // Fall through and refetch
    }
  }
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/network/wiki/${encodeURIComponent(domain)}`,
    )) as WikiDomainSummary;
    cache.set(key, { fetchedAt: Date.now(), body: JSON.stringify(res) });
    return res;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) {
      cache.set(key, { fetchedAt: Date.now(), body: null });
      return null;
    }
    return null;
  }
}

/**
 * Render a short context block (≤ 600 chars) suitable for prepending to a
 * mining-solve prompt. Truncates long summaries with an ellipsis.
 */
export function renderWikiBlock(wiki: WikiDomainSummary, maxChars = 600): string {
  const summary = (wiki.summary ?? "").trim();
  if (!summary) return "";
  const truncated = summary.length > maxChars ? summary.slice(0, maxChars - 1) + "…" : summary;
  return `## Network wiki — ${wiki.domain}\n${truncated}`;
}

/** For a list of challenge domain tags, fetch up to 2 wiki summaries (cheap due to cache). */
export async function fetchWikiContextForChallenge(
  runtime: RuntimeLike,
  domainTags: string[],
): Promise<string> {
  const blocks: string[] = [];
  for (const tag of domainTags.slice(0, 2)) {
    const w = await fetchWikiDomain(runtime, tag);
    if (w) {
      const block = renderWikiBlock(w);
      if (block) blocks.push(block);
    }
  }
  return blocks.join("\n\n");
}
