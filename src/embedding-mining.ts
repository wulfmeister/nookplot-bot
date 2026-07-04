/**
 * Tier-1 embedding mining (P2.2). Generates 768-dim vector embeddings for a
 * challenge's text batch using a LOCAL model (nomic-embed-text-v1.5 via Ollama,
 * 274 MB, CPU-viable) and submits them. 3-miner consensus, accepted when cosine
 * similarity > 0.95. Near-zero marginal cost — no LLM/inference spend, just local
 * CPU — so it's cheap incremental NOOK.
 *
 * Three gates, all automatic/safe:
 *   1. Liveness — list_embedding_challenges; dormant ("Endpoint does not exist")
 *      → logged no-op. (`npm run surfaces` watches for go-live.)
 *   2. Local model — Ollama must be reachable with the embed model pulled
 *      (`ollama pull nomic-embed-text`); absent → no-op with a one-line hint.
 *   3. Opt-in — only submits when BOT_EMBEDDING_AUTO=1.
 *
 * Action contracts (0.5.145 catalog):
 *   list_embedding_challenges { status?, limit? }
 *   submit_embeddings         { challengeId, vectors }   // vectors: number[768][]
 */
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";
import { join } from "node:path";

type RuntimeLike = Pick<NookplotRuntime, "tools">;

const EMB_LOG = join(NOOK_DIR, "embedding-mining.jsonl");
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const EMBED_MODEL = process.env.NOOK_EMBED_MODEL ?? "nomic-embed-text";
const DIM = 768;
// nomic-embed-text-v1.5 is trained with task-instruction prefixes; the same text
// embedded with vs. without a prefix yields different vectors. Consensus
// (cosine>0.95 vs other miners) therefore depends on EVERY miner using the SAME
// convention. "search_document: " is nomic's documented default for indexing
// passages, so it's the safest starting point — but this MUST be confirmed
// against the challenge spec / reference vectors the moment the endpoint ships
// (the earning-surfaces watcher alerts on go-live). Override via NOOK_EMBED_PREFIX
// (set to an empty string to disable prefixing).
const EMBED_PREFIX = process.env.NOOK_EMBED_PREFIX ?? "search_document: ";

interface EmbChallenge {
  id: string;
  texts?: string[];
  batch?: string[];
  items?: Array<string | { text?: string }>;
}

interface EmbLogEntry {
  ts: string;
  challengeId: string;
  outcome: "submitted" | "error" | "skipped" | "dormant";
  notes?: string;
}

function isDormant(err: unknown): boolean {
  const m = (err as Error)?.message ?? String(err);
  return /Endpoint does not exist|Unknown tool|Not found|\b404\b/i.test(m);
}

function extractTexts(ch: EmbChallenge): string[] {
  if (Array.isArray(ch.texts)) return ch.texts;
  if (Array.isArray(ch.batch)) return ch.batch;
  if (Array.isArray(ch.items)) {
    return ch.items.map((i) => (typeof i === "string" ? i : (i?.text ?? ""))).filter(Boolean);
  }
  return [];
}

/** Is an Ollama server with the embed model reachable? */
export async function ollamaReady(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map((m) => m.name ?? "");
    return names.some((n) => n.startsWith(EMBED_MODEL));
  } catch {
    return false;
  }
}

/** Embed a batch of texts to 768-dim vectors via local Ollama. Applies the
 *  configured nomic task prefix (see EMBED_PREFIX) to each text first. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const prepped = texts.map((t) => `${EMBED_PREFIX}${t}`);
  // Prefer the newer batch endpoint; fall back to per-text /api/embeddings.
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: prepped }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings) && data.embeddings.length === prepped.length) return data.embeddings;
    }
  } catch {
    /* fall through */
  }
  const out: number[][] = [];
  for (const text of prepped) {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as { embedding?: number[] };
    out.push(data.embedding ?? []);
  }
  return out;
}

/** Stable FNV-1a hash over ALL dimensions (rounded), so dup-detection can't
 *  false-positive on two distinct vectors that merely share a prefix. */
function vecKey(v: number[]): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    const x = Math.round(v[i] * 1e6) | 0;
    for (let b = 0; b < 4; b++) {
      h ^= (x >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${(h >>> 0).toString(16)}:${v.length}`;
}

/** Validate vectors against the gateway's strict rules before submitting. */
export function validateVectors(vectors: number[][], expectedCount: number): { ok: boolean; reason?: string } {
  if (vectors.length !== expectedCount) return { ok: false, reason: `count ${vectors.length}!=${expectedCount}` };
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v) || v.length !== DIM) return { ok: false, reason: `vec ${i} dim ${v?.length}!=${DIM}` };
    for (const x of v) {
      if (typeof x !== "number" || Number.isNaN(x) || !Number.isFinite(x)) return { ok: false, reason: `vec ${i} has NaN/Inf` };
    }
  }
  // No duplicate vectors (gateway rejects dupes). Hash over all dims, not a
  // prefix, so distinct vectors sharing leading values aren't falsely flagged.
  const seen = new Set<string>();
  for (let i = 0; i < vectors.length; i++) {
    const key = vecKey(vectors[i]);
    if (seen.has(key)) return { ok: false, reason: `duplicate vector at ${i}` };
    seen.add(key);
  }
  return { ok: true };
}

function attemptedIds(): Set<string> {
  return new Set(
    readJsonl<EmbLogEntry>(EMB_LOG)
      .filter((e) => e.outcome === "submitted")
      .map((e) => e.challengeId),
  );
}

/**
 * Discover and solve embedding challenges. No-op (logged) while the gateway
 * endpoint is dormant, Ollama is unavailable, or BOT_EMBEDDING_AUTO!=1.
 */
export async function discoverAndSolveEmbeddings(runtime: RuntimeLike): Promise<number> {
  let challenges: EmbChallenge[];
  try {
    const res = await runtime.tools.executeTool("list_embedding_challenges", { status: "open", limit: 10 });
    const out = (res?.output ?? {}) as { challenges?: EmbChallenge[]; embeddingChallenges?: EmbChallenge[] };
    challenges = out.challenges ?? out.embeddingChallenges ?? [];
  } catch (err) {
    if (isDormant(err)) return 0;
    console.warn(`🔢 embedding list failed: ${(err as Error).message.slice(0, 120)}`);
    return 0;
  }

  if (challenges.length === 0) return 0;
  console.log(`🔢 ${challenges.length} embedding challenge(s) open`);
  if (process.env.BOT_EMBEDDING_AUTO !== "1") return 0;

  if (!(await ollamaReady())) {
    console.log(`🔢 embedding mining idle: Ollama+${EMBED_MODEL} not reachable at ${OLLAMA_HOST} (run: ollama pull ${EMBED_MODEL})`);
    return 0;
  }

  const seen = attemptedIds();
  let submitted = 0;
  for (const ch of challenges) {
    if (!ch.id || seen.has(ch.id)) continue;
    const texts = extractTexts(ch);
    if (texts.length === 0) continue;
    try {
      const vectors = await embedBatch(texts);
      const v = validateVectors(vectors, texts.length);
      if (!v.ok) {
        console.warn(`🔢 ${ch.id.slice(0, 10)} invalid vectors (${v.reason}) — skipping`);
        appendJsonl(EMB_LOG, { ts: new Date().toISOString(), challengeId: ch.id, outcome: "error", notes: v.reason });
        continue;
      }
      await runtime.tools.executeTool("submit_embeddings", { challengeId: ch.id, vectors });
      submitted += 1;
      console.log(`🔢 ✓ submitted ${vectors.length} embeddings for ${ch.id.slice(0, 10)}`);
      appendJsonl(EMB_LOG, { ts: new Date().toISOString(), challengeId: ch.id, outcome: "submitted", notes: `${vectors.length} vecs` });
    } catch (err) {
      console.warn(`🔢 embedding ${ch.id.slice(0, 10)} failed: ${(err as Error).message.slice(0, 120)}`);
      appendJsonl(EMB_LOG, { ts: new Date().toISOString(), challengeId: ch.id, outcome: "error", notes: (err as Error).message.slice(0, 160) });
    }
  }
  return submitted;
}
