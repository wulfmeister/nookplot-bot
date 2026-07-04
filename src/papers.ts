/**
 * Semantic Scholar paper fetches via the Nookplot gateway proxy.
 *
 * Already-in-the-bot:
 *   - mining-context.ts hits arXiv directly for abstracts.
 *
 * What this adds:
 *   - Citation graph traversal (walk_citations: who cites this / what does this cite)
 *   - For-this-paper recommendations
 *   - Snippet search across the corpus
 *
 * Used by mining-context.ts to expand the "related work" section of a context block.
 *
 * Endpoints:
 *   GET /v1/papers/search?q=&limit=               — search
 *   GET /v1/papers/:arxivId                       — full record
 *   GET /v1/papers/:arxivId/citations?direction=  — walk
 *   GET /v1/papers/:arxivId/recommendations       — recommend
 *   GET /v1/papers/:arxivId/sections              — TOC
 *   GET /v1/papers/:arxivId/sections/:section     — section text
 *   GET /v1/papers/snippets?q=                    — snippet search
 *   GET /v1/papers/:arxivId/resources             — code/data links
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface PaperRow {
  arxivId?: string;
  title?: string;
  authors?: string[];
  year?: number;
  citationCount?: number;
  abstract?: string;
}

const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 6 * 3600_000;

async function memoized<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data as T;
  try {
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404") || msg.includes("not found")) return null;
    return null;
  }
}

export async function searchPapers(
  runtime: RuntimeLike,
  query: string,
  limit = 10,
): Promise<PaperRow[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const result = await memoized(`search:${params.toString()}`, async () => {
    return (await runtime.connection.request("GET", `/v1/papers/search?${params.toString()}`)) as {
      papers?: PaperRow[];
      items?: PaperRow[];
    };
  });
  return result?.papers ?? result?.items ?? [];
}

export async function walkCitations(
  runtime: RuntimeLike,
  arxivId: string,
  direction: "in" | "out",
  limit = 10,
): Promise<PaperRow[]> {
  const params = new URLSearchParams({ direction, limit: String(limit) });
  const result = await memoized(`cite:${arxivId}:${direction}:${limit}`, async () => {
    return (await runtime.connection.request(
      "GET",
      `/v1/papers/${encodeURIComponent(arxivId)}/citations?${params.toString()}`,
    )) as { papers?: PaperRow[]; items?: PaperRow[] };
  });
  return result?.papers ?? result?.items ?? [];
}

export async function recommendPapers(
  runtime: RuntimeLike,
  arxivId: string,
  limit = 10,
): Promise<PaperRow[]> {
  const result = await memoized(`rec:${arxivId}:${limit}`, async () => {
    return (await runtime.connection.request(
      "GET",
      `/v1/papers/${encodeURIComponent(arxivId)}/recommendations?limit=${limit}`,
    )) as { papers?: PaperRow[]; items?: PaperRow[] };
  });
  return result?.papers ?? result?.items ?? [];
}

export async function searchSnippets(
  runtime: RuntimeLike,
  query: string,
  limit = 5,
): Promise<Array<{ arxivId: string; snippet: string; section?: string }>> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const result = await memoized(`snip:${params.toString()}`, async () => {
    return (await runtime.connection.request("GET", `/v1/papers/snippets?${params.toString()}`)) as {
      snippets?: Array<{ arxivId: string; snippet: string; section?: string }>;
      items?: Array<{ arxivId: string; snippet: string; section?: string }>;
    };
  });
  return result?.snippets ?? result?.items ?? [];
}

/** Render a compact "related work" block from a list of papers (≤ N entries). */
export function renderRelatedWork(papers: PaperRow[], maxN = 5): string {
  if (papers.length === 0) return "";
  const lines = papers.slice(0, maxN).map((p) => {
    const year = p.year ? ` (${p.year})` : "";
    const cites = p.citationCount ? ` — ${p.citationCount} cites` : "";
    const a = p.authors && p.authors.length > 0 ? p.authors.slice(0, 2).join(", ") + (p.authors.length > 2 ? " et al." : "") : "?";
    return `  - [${p.arxivId}] ${(p.title ?? "Untitled").slice(0, 120)} — ${a}${year}${cites}`;
  });
  return `## Related work\n${lines.join("\n")}`;
}
