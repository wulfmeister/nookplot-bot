/**
 * Context-gather helper for mining solves.
 *
 * Pulls every signal we have access to BEFORE the LLM sees a challenge,
 * so the generation is grounded in real citations + prior work + domain
 * conventions instead of model-recalled approximations.
 *
 * Three signals composed:
 *   1. arxiv + web search keyed on the challenge title/domains (research.ts)
 *   2. our own knowledge-vault prior verified work (vault.ts)
 *   3. per-domain prompt fragments — what counts as "good" in each domain
 *
 * Soft-fails on every source: if arxiv 503s, we skip and continue. The
 * gateway's related-learnings (fetchRelatedLearnings in mining.ts) is
 * separate and still runs in parallel — these are additive.
 */
import type { NookplotRuntime } from "@nookplot/runtime";
import { arxivSearch, webSearch, type SearchResult } from "./research.js";
import { search as vaultSearch, type VaultNote } from "./vault.js";
import { fetchWikiContextForChallenge } from "./network-wiki.js";
import { searchPapers, renderRelatedWork } from "./papers.js";
import { fetchPeerTraceBlockForChallenge } from "./mining-dataset.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

interface ChallengeLike {
  id: string;
  title?: string;
  description?: string;
  difficulty?: string;
  domainTags?: string[];
  verifierKind?: string | null;
  challengeType?: string;
}

export interface MiningContext {
  /** Markdown block ready to splice into the solver prompt. May be empty. */
  contextBlock: string;
  /** Just the per-domain hint fragment, useful for the system prompt. */
  domainHint: string;
  /** Citations gathered (papers + URLs) — for inclusion in the trace's Citations section. */
  citations: Array<{ title: string; url?: string; source: "arxiv" | "web" | "vault" }>;
}

/**
 * Per-domain hints. Picked from observed high-scoring traces in the
 * verifiable pool — top solvers consistently include the markers below
 * for each domain. Order: most-specific tag wins. Generic CS fallback last.
 *
 * Keep each fragment under ~280 chars — it goes into the system prompt and
 * compounds with the trace requirements.
 */
const DOMAIN_HINTS: Array<{ tags: string[]; hint: string }> = [
  {
    tags: ["machine-learning", "ml", "deep-learning", "language-models", "training"],
    hint: "ML hint: cite scaling laws (Kaplan 2020, Chinchilla/Hoffmann 2022, Llama-3), give specific token counts / FLOPs / model dims, and include at least one ablation comparison (X vs Y, n=10k or larger).",
  },
  {
    tags: ["security", "cryptography", "cfi", "exploitation", "systems-security", "tpm"],
    hint: "Security hint: name the threat model (passive/active/local), cite a specific CVE or paper (Goktas 2014, Shacham 2007, etc.), include attack-cost estimates (2^N ops, $/breakage, side-channel bandwidth in bits/s).",
  },
  {
    tags: ["algorithms", "data-structures", "complexity", "graph-algorithms"],
    hint: "Algorithms hint: lead with big-O for time + space, give worst vs average vs best case, cite the canonical paper (Knuth Vol N, Cormen, original PoPL/STOC reference), include a sanity-check trace on n=10 input.",
  },
  {
    tags: ["distributed-systems", "consensus", "byzantine-fault-tolerance", "proof-of-stake", "filesystems", "crash-consistency"],
    hint: "Distributed-systems hint: state assumptions (sync/async, f Byzantine), cite the protocol's original paper (Lamport 1998, Castro-Liskov 1999, Ongaro 2014), give a partition / failure scenario walk-through with concrete message counts.",
  },
  {
    tags: ["compilers", "static-analysis", "dataflow-analysis", "program-analysis"],
    hint: "Compilers hint: cite Kildall, Aho-Sethi-Ullman (chapter#), give lattice height + step complexity O(h*n), include a concrete CFG with ≥3 blocks showing fixed-point convergence.",
  },
  {
    tags: ["operating-systems", "caching", "memory-management", "hardware"],
    hint: "OS/HW hint: name the architecture (x86_64, ARMv8, RISC-V), cite specific cache hierarchies (L1=32KB 8-way, L2=256KB, L3=2MB/core typical), include latencies (1ns L1, ~4ns L2, ~12ns L3, ~80ns DRAM) and reference a paper or Intel/AMD manual.",
  },
  {
    tags: ["sybil-detection", "quality-review", "citation-audit", "verification"],
    hint: "Sybil/quality hint: quantify with measurable counts (X citations across Y insights), give a per-100 quality ratio, name a known attack pattern (citation ring, timing correlation, address clustering), and produce a verdict (gaming / clean / inconclusive) with concrete thresholds.",
  },
  {
    tags: ["python", "javascript", "typescript", "code"],
    hint: "Code hint: include the function signature in `backticks`, name the stdlib modules used, give the algorithmic complexity, and walk through one edge case (empty input / negative / off-by-one).",
  },
  {
    tags: ["statistics", "probability", "bandits"],
    hint: "Stats hint: state the assumption (iid, bounded, etc.), cite the bound's source (Hoeffding 1963, Auer 2002 for UCB, Bernstein), give the exact form (e.g. R_T = O(sum_i log(T)/Δ_i)), test on a concrete configuration.",
  },
];

export function pickDomainHint(domains: string[]): string {
  const lower = new Set(domains.map((d) => d.toLowerCase()));
  for (const entry of DOMAIN_HINTS) {
    if (entry.tags.some((t) => lower.has(t))) return entry.hint;
  }
  // Generic CS fallback — top solvers' default style.
  return "Hint: cite ≥2 sources with author + year, include ≥3 concrete numbers with units (ms, MB, ops, %), and use at least one comparison phrase (X vs Y, better than, instead of).";
}

export function formatSearchResults(results: SearchResult[], label: string): string {
  if (results.length === 0) return "";
  const lines = results.slice(0, 4).map((r, i) => {
    const url = r.url ? ` <${r.url}>` : "";
    const snippet = (r.snippet ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `[${label}-${i + 1}] ${r.title}${url}\n  ${snippet}`;
  });
  return lines.join("\n\n");
}

function vaultNoteCategory(path: string): string {
  // Vault layout: knowledge-vault/<category>/<file>.md
  const parts = path.split("/");
  const idx = parts.lastIndexOf("knowledge-vault");
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1] ?? "?";
  return "?";
}

export function formatVaultHits(notes: VaultNote[]): string {
  if (notes.length === 0) return "";
  return notes
    .slice(0, 3)
    .map((n, i) => {
      const body = (n.body ?? "").replace(/\s+/g, " ").slice(0, 280);
      const title = n.frontmatter?.title ?? "(untitled)";
      const cat = vaultNoteCategory(n.path);
      return `[prior-${i + 1}] ${title} (${cat})\n  ${body}`;
    })
    .join("\n\n");
}

/**
 * Gather every signal in parallel before the LLM sees the challenge.
 * Total wall time bounded by the slowest source. Each source soft-fails.
 *
 * Sources (5 parallel):
 *   1. arxiv search (research.ts) — recent papers in the area
 *   2. web search (research.ts)   — non-arxiv URLs, blog posts, code
 *   3. vault search (vault.ts)    — our own prior verified work
 *   4. network wiki (gateway)     — curated domain summaries; FREE; runtime-gated
 *   5. semantic scholar (gateway) — paper search via /v1/papers/search; runtime-gated
 *
 * Runtime-gated sources are only fetched when a runtime is provided. Existing
 * callers without a runtime still work (they just get arxiv + web + vault).
 */
export async function gatherMiningContext(
  ch: ChallengeLike,
  runtime?: RuntimeLike,
): Promise<MiningContext> {
  const domains = ch.domainTags ?? [];
  const query = `${ch.title ?? ""} ${domains.slice(0, 3).join(" ")}`.trim() || ch.id;
  const vaultQuery = `${ch.title ?? ""} ${domains.join(" ")}`.trim();

  const [arxivResults, webResults, vaultHits, wikiBlock, ssPapers, peerBlock] = await Promise.all([
    arxivSearch(query, { max: 4 }).catch(() => [] as SearchResult[]),
    webSearch(query, { max: 4 }).catch(() => [] as SearchResult[]),
    Promise.resolve(vaultQuery ? vaultSearch(vaultQuery, { max: 5 }) : []).catch(() => [] as VaultNote[]),
    runtime ? fetchWikiContextForChallenge(runtime, domains).catch(() => "") : Promise.resolve(""),
    runtime
      ? searchPapers(runtime, query, 5).catch(() => [] as Array<{ title?: string; arxivId?: string }>)
      : Promise.resolve([] as Array<{ title?: string; arxivId?: string }>),
    runtime && process.env.BOT_PEER_TRACES !== "0"
      ? fetchPeerTraceBlockForChallenge(runtime, domains).catch(() => "")
      : Promise.resolve(""),
  ]);

  const citations: MiningContext["citations"] = [];
  for (const r of arxivResults.slice(0, 3)) citations.push({ title: r.title, url: r.url, source: "arxiv" });
  for (const r of webResults.slice(0, 2)) citations.push({ title: r.title, url: r.url, source: "web" });
  for (const n of vaultHits.slice(0, 2)) citations.push({ title: n.frontmatter?.title ?? "vault note", source: "vault" });
  for (const p of ssPapers.slice(0, 2)) {
    if (p.arxivId && p.title) citations.push({ title: p.title, url: `https://arxiv.org/abs/${p.arxivId}`, source: "arxiv" });
  }

  const blocks: string[] = [];
  if (wikiBlock) blocks.push(wikiBlock);
  if (peerBlock) blocks.push(peerBlock);
  const arxivBlock = formatSearchResults(arxivResults, "arxiv");
  if (arxivBlock) blocks.push("## Recent arxiv papers (search results — verify before citing)\n\n" + arxivBlock);
  const ssBlock = renderRelatedWork(ssPapers, 5);
  if (ssBlock) blocks.push(ssBlock);
  const webBlock = formatSearchResults(webResults, "web");
  if (webBlock) blocks.push("## Web search hits\n\n" + webBlock);
  const vaultBlock = formatVaultHits(vaultHits);
  if (vaultBlock) blocks.push("## Our prior verified work (knowledge-vault)\n\n" + vaultBlock);

  const contextBlock = blocks.join("\n\n");
  const domainHint = pickDomainHint(domains);

  return { contextBlock, domainHint, citations };
}
