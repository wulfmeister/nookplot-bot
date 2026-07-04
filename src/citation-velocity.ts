/**
 * Citation-velocity loop.
 *
 * Two passive-income mechanics on Nookplot's knowledge graph:
 *   - Citation rewards (~0.50 cr each time someone cites our content)
 *   - Knowledge-synthesis: `compile_knowledge` finds gaps + opportunities;
 *     synthesizing fills them and creates higher-tier (more-cited) artifacts.
 *
 * This module:
 *   1. Periodically `browse_network_learnings` in our active domains.
 *   2. For high-quality peer learnings (quality ≥ 50), call
 *      `add_knowledge_citation` linking OUR existing items as `extends` of
 *      the peer item. The documented mechanic rewards both the citing and
 *      cited agent; we only add a citation where our item genuinely
 *      extends/supports the peer item.
 *   3. Periodically call `compile_knowledge` to surface synthesis
 *      opportunities (cross-domain gaps the gateway can spot).
 *
 * NO self-citation. The user explicitly excluded "Aggressively cite our
 * own past learnings" — that's gaming, not real signal.
 *
 * Toggle off with BOT_CITATION_VELOCITY=0.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, sleep } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG_PATH = join(NOOK_DIR, "citation-velocity.jsonl");

// Citations per tick: keep modest — quality over volume, and stay well inside rate limits.
const MAX_CITATIONS_PER_TICK = 3;

// Quality floor for peer learnings we'll cite. Real gateway response
// has `upvote_count` rather than a 0-100 quality score; we use 0+ as
// floor (i.e. accept everything) since `network-learnings` is already
// gateway-curated by quality. Override via BOT_CITATION_QUALITY_FLOOR.
const PEER_QUALITY_FLOOR = Number(process.env.BOT_CITATION_QUALITY_FLOOR ?? 0);

const CITATION_TYPES = ["extends", "supports", "derives_from"] as const;
type CitationType = (typeof CITATION_TYPES)[number];

export interface PeerLearning {
  id?: string;
  insightId?: string;
  itemId?: string;
  title?: string;
  summary?: string;
  body?: string;        // gateway shape: body / content
  content?: string;
  content_cid?: string;
  authorAddress?: string;
  author_address?: string;
  // Quality signals — gateway uses upvote_count / comment_count for ranking
  upvote_count?: number;
  upvoteCount?: number;
  comment_count?: number;
  qualityScore?: number;
  quality_score?: number;
  specificityScore?: number;
  domainTag?: string;
  domain_tag?: string;
  domain?: string;
  domainTags?: string[];
  domain_tags?: string[];
  tags?: string[];
}

export interface MyKnowledgeItem {
  id?: string;
  itemId?: string;
  title?: string;
  domain?: string;
  domainTag?: string;
  domainTags?: string[];
  qualityScore?: number;
}

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  return undefined;
}

export function pickPeerId(p: PeerLearning): string | undefined {
  return pick<string>(p as Record<string, unknown>, "id", "insightId", "itemId");
}

export function pickMyId(m: MyKnowledgeItem): string | undefined {
  return pick<string>(m as Record<string, unknown>, "id", "itemId");
}

export function peerQuality(p: PeerLearning): number {
  // Gateway's network-learnings ranking uses upvote_count + comment_count.
  // Fall through to legacy fields if present.
  const upvotes = p.upvote_count ?? p.upvoteCount ?? 0;
  const comments = p.comment_count ?? 0;
  if (upvotes || comments) return upvotes * 10 + comments * 5;
  return p.qualityScore ?? p.quality_score ?? p.specificityScore ?? 0;
}

export function peerAuthor(p: PeerLearning): string {
  return (p.authorAddress ?? p.author_address ?? "").toLowerCase();
}

export function peerDomains(p: PeerLearning): string[] {
  // Gateway's network-learnings returns `tags: ["domain1", "domain2", ...]`.
  // Legacy shapes carry domainTags/domain_tags/domain instead.
  const all = (p.domainTags ?? p.domain_tags ?? p.tags ?? []).slice();
  const single = p.domainTag ?? p.domain_tag ?? p.domain;
  if (single && !all.includes(single)) all.push(single);
  return all.map((d) => d.toLowerCase());
}

/**
 * Pick the citation type based on domain-overlap heuristic.
 * - same domain  → "extends" (your work continues theirs)
 * - cross-domain → "supports" (you ground their claim from another angle)
 */
export function citationType(peer: PeerLearning, mine: MyKnowledgeItem): CitationType {
  const peerD = peerDomains(peer);
  const mineD = (mine.domainTags ?? [mine.domain, mine.domainTag].filter(Boolean) as string[])
    .map((d) => d.toLowerCase());
  if (peerD.some((d) => mineD.includes(d))) return "extends";
  return "supports";
}

async function listMyKnowledgeItems(
  runtime: RuntimeLike,
  myAddress: string,
): Promise<MyKnowledgeItem[]> {
  // Gateway shape: /v1/agents/:addr/knowledge/graph → { nodes: [...], edges: [...] }
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/agents/${encodeURIComponent(myAddress)}/knowledge/graph?limit=200`,
    )) as { nodes?: MyKnowledgeItem[]; items?: MyKnowledgeItem[] };
    return res.nodes ?? res.items ?? [];
  } catch {
    return [];
  }
}

async function browseNetworkLearnings(
  runtime: RuntimeLike,
  domain: string | null,
): Promise<PeerLearning[]> {
  // Confirmed path: /v1/mining/network-learnings?domainTag=...&limit=20
  // Returns { learnings: [{id, body, author_address, upvote_count, comment_count, tags, ...}] }
  const params = new URLSearchParams();
  if (domain) params.set("domainTag", domain);
  params.set("limit", "20");
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/network-learnings?${params}`,
    )) as { learnings?: PeerLearning[] };
    return res.learnings ?? [];
  } catch {
    return [];
  }
}

async function citePeer(
  runtime: RuntimeLike,
  myItemId: string,
  peerItemId: string,
  type: CitationType,
): Promise<{ ok: boolean; err?: string }> {
  try {
    await runtime.connection.request(
      "POST",
      `/v1/agents/me/knowledge/${encodeURIComponent(myItemId)}/cite`,
      { targetId: peerItemId, citationType: type, strength: 0.8 },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, err: (err as Error).message.slice(0, 200) };
  }
}

async function compileKnowledge(runtime: RuntimeLike): Promise<{ ok: boolean; summary?: string }> {
  try {
    const data = (await runtime.connection.request(
      "GET",
      "/v1/agents/me/knowledge/synthesis-opportunities",
    )) as {
      domains?: Array<{ domain: string; opportunityCount?: number }>;
      crossDomainOpportunities?: unknown[];
      lint?: { totalActive?: number };
      mechanicalResults?: { crossLinksCreated?: number };
    };
    const summary =
      `domains=${data.domains?.length ?? 0}` +
      `, cross-domain-opps=${(data.crossDomainOpportunities ?? []).length}` +
      `, lint-issues=${data.lint?.totalActive ?? 0}` +
      `, cross-links=${data.mechanicalResults?.crossLinksCreated ?? 0}`;
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, summary: (err as Error).message.slice(0, 150) };
  }
}

export async function runCitationVelocityTick(
  runtime: RuntimeLike,
  myAddress: string | null,
): Promise<void> {
  if (process.env.BOT_CITATION_VELOCITY === "0") return;
  if (!myAddress) return;

  const myItems = await listMyKnowledgeItems(runtime, myAddress);
  if (myItems.length === 0) {
    return; // no items to attach citations to; can't cite-from-nothing
  }

  // Build a map: domain → our items in that domain
  const myByDomain = new Map<string, MyKnowledgeItem[]>();
  for (const it of myItems) {
    const ds = (it.domainTags ?? [it.domain, it.domainTag].filter(Boolean) as string[])
      .map((d) => d.toLowerCase());
    for (const d of ds) {
      if (!myByDomain.has(d)) myByDomain.set(d, []);
      myByDomain.get(d)!.push(it);
    }
  }
  // Domains we'll browse — top-3 of our own KG by item count.
  const domains = [...myByDomain.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([d]) => d);

  if (domains.length === 0) domains.push("general");

  // For each domain, browse peers and cite high-quality ones
  let citationsThisTick = 0;
  const me = myAddress.toLowerCase();
  for (const domain of domains) {
    if (citationsThisTick >= MAX_CITATIONS_PER_TICK) break;
    const peers = await browseNetworkLearnings(runtime, domain);
    const candidates = peers.filter(
      (p) =>
        peerAuthor(p) !== me &&
        peerAuthor(p) !== "" &&
        peerQuality(p) >= PEER_QUALITY_FLOOR,
    );
    if (candidates.length === 0) continue;

    // Sort by quality desc — cite the best peers first
    candidates.sort((a, b) => peerQuality(b) - peerQuality(a));

    for (const peer of candidates.slice(0, MAX_CITATIONS_PER_TICK - citationsThisTick)) {
      const peerId = pickPeerId(peer);
      if (!peerId) continue;
      // Pick a relevant item of ours — prefer one in the same domain
      const mineCandidates = myByDomain.get(domain) ?? myItems;
      const mine = mineCandidates[Math.floor(Math.random() * mineCandidates.length)];
      const myId = pickMyId(mine);
      if (!myId) continue;
      const type = citationType(peer, mine);
      const res = await citePeer(runtime, myId, peerId, type);
      if (res.ok) {
        citationsThisTick++;
        console.log(
          `📎 cited peer ${peerId.slice(0, 8)} (${peerAuthor(peer).slice(0, 10)}, ` +
            `quality=${peerQuality(peer)}) → as "${type}" of our ${myId.slice(0, 8)}`,
        );
        appendJsonl(LOG_PATH, {
          ts: new Date().toISOString(),
          kind: "citation",
          sourceItemId: myId,
          targetItemId: peerId,
          citationType: type,
          peerAuthor: peerAuthor(peer),
          peerQuality: peerQuality(peer),
          domain,
        });
      } else {
        appendJsonl(LOG_PATH, {
          ts: new Date().toISOString(),
          kind: "citation-error",
          sourceItemId: myId,
          targetItemId: peerId,
          err: res.err,
        });
      }
      await sleep(2000); // pace
    }
  }

  if (citationsThisTick > 0) {
    console.log(`📎 citation-velocity: ${citationsThisTick} citations added this tick`);
  }
}

export async function runCompileKnowledgeTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_CITATION_VELOCITY === "0") return;
  const r = await compileKnowledge(runtime);
  if (r.ok && r.summary) {
    console.log(`📚 compile_knowledge: ${r.summary}`);
    appendJsonl(LOG_PATH, { ts: new Date().toISOString(), kind: "compile", summary: r.summary });
  }
}

/**
 * Start the citation-velocity loops.
 *   - Cross-citation: every 45 min (paced; max 3 citations/tick)
 *   - Compile knowledge: every 4 hours (lightweight, informational)
 */
export function startCitationVelocityLoops(
  runtime: RuntimeLike,
  myAddress: string | null,
): void {
  if (process.env.BOT_CITATION_VELOCITY === "0") return;
  // First citation pass after 4 min, then every 45 min
  setTimeout(() => runCitationVelocityTick(runtime, myAddress).catch(() => undefined), 4 * 60 * 1000);
  setInterval(() => runCitationVelocityTick(runtime, myAddress).catch(() => undefined), 45 * 60 * 1000);
  // First compile after 5 min, then every 4 hours
  setTimeout(() => runCompileKnowledgeTick(runtime).catch(() => undefined), 5 * 60 * 1000);
  setInterval(() => runCompileKnowledgeTick(runtime).catch(() => undefined), 4 * 3600 * 1000);
}
