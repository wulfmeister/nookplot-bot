/**
 * Paper-reproduction discovery + research dossier.
 *
 * Paper-reproduction challenges are winner-take-all: solver provides
 * artifactCid (model weights + inference.py + requirements.txt bundle) plus
 * claimedMetricValue. 5 verifiers re-run the artifact in their own Docker
 * sandbox; closes_at picks the winner.
 *
 * Honest scope: this Node bot cannot train ML models. What it CAN do:
 *   1. Discover open paper_reproduction challenges (sourceType filter)
 *   2. Read the linked paper (arXiv ID from challenge bundle)
 *   3. Pull related learnings + walk citations
 *   4. Write a dossier to `knowledge-vault/research/paper-repro-*.md` so a
 *      human can pick it up and run actual training
 *   5. Surface in dashboard + log loudly
 *
 * Toggle off with BOT_PAPER_REPRODUCTION=0.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { writeNote } from "./vault.js";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG_PATH = join(NOOK_DIR, "paper-reproduction.jsonl");
const SEEN_PATH = join(NOOK_DIR, "paper-reproduction-seen.jsonl");

export interface PaperReproChallenge {
  id: string;
  title?: string;
  description?: string;
  difficulty?: string;
  domainTags?: string[];
  sourceType?: string;
  estimatedRewardNook?: number;
  closes_at?: string;
  closesAt?: string;
  bundleIds?: string[];
  resourceIds?: string[];
  baselineScore?: Record<string, unknown> | null;
  status?: string;
}

export interface BundleResource {
  type?: string;
  identifier?: string;
  url?: string;
  arxivId?: string;
  hfDatasetId?: string;
  description?: string;
}

function loadSeen(): Set<string> {
  try {
    const lines = (require("node:fs").readFileSync(SEEN_PATH, "utf8") as string).split("\n");
    const seen = new Set<string>();
    for (const line of lines) {
      const t = line.trim();
      if (t) seen.add(t);
    }
    return seen;
  } catch {
    return new Set();
  }
}

function markSeen(id: string): void {
  try {
    require("node:fs").appendFileSync(SEEN_PATH, id + "\n");
  } catch { /* ignore */ }
}

async function discoverChallenges(runtime: RuntimeLike): Promise<PaperReproChallenge[]> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/challenges?sourceType=paper_reproduction&status=open&limit=20",
    )) as { challenges?: PaperReproChallenge[] };
    return res.challenges ?? [];
  } catch {
    return [];
  }
}

async function fetchChallengeDetail(
  runtime: RuntimeLike,
  challengeId: string,
): Promise<{
  challenge?: PaperReproChallenge;
  bundle?: { resources?: BundleResource[]; description?: string };
  relatedLearnings?: Array<{ summary?: string; content?: string; specificityScore?: number }>;
}> {
  try {
    const detail = (await runtime.connection.request(
      "GET",
      `/v1/mining/challenges/${encodeURIComponent(challengeId)}`,
    )) as PaperReproChallenge & {
      bundle?: { resources?: BundleResource[]; description?: string };
      knowledgeAvailable?: { relatedLearnings?: number };
    };
    let relatedLearnings: Array<{ summary?: string; content?: string; specificityScore?: number }> = [];
    try {
      const rel = (await runtime.connection.request(
        "GET",
        `/v1/mining/challenges/${encodeURIComponent(challengeId)}/related-learnings?limit=10`,
      )) as { learnings?: Array<{ summary?: string; content?: string; specificityScore?: number }> };
      relatedLearnings = rel.learnings ?? [];
    } catch { /* skip */ }
    return { challenge: detail, bundle: detail.bundle, relatedLearnings };
  } catch (err) {
    console.warn(`   ⚠ paper-repro detail fetch failed for ${challengeId.slice(0, 8)}: ${(err as Error).message}`);
    return {};
  }
}

export function extractArxivIds(bundle: { resources?: BundleResource[]; description?: string } | undefined, ch: PaperReproChallenge): string[] {
  const ids = new Set<string>();
  const re = /(?:arxiv\.org\/(?:abs|pdf)\/|arXiv:)?(\d{4}\.\d{4,5})(?:v\d+)?/gi;
  const scan = (s: string | undefined) => {
    if (!s) return;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) ids.add(m[1]);
  };
  scan(ch.description);
  scan(ch.title);
  scan(bundle?.description);
  for (const r of bundle?.resources ?? []) {
    if (r.arxivId) ids.add(r.arxivId);
    scan(r.identifier);
    scan(r.url);
    scan(r.description);
  }
  return [...ids];
}

export function extractHfDatasets(bundle: { resources?: BundleResource[]; description?: string } | undefined): string[] {
  const ds = new Set<string>();
  for (const r of bundle?.resources ?? []) {
    if (r.hfDatasetId) ds.add(r.hfDatasetId);
    if (r.url?.includes("huggingface.co/datasets/")) {
      const m = r.url.match(/huggingface\.co\/datasets\/([\w-]+\/[\w-]+)/);
      if (m) ds.add(m[1]);
    }
  }
  return [...ds];
}

function writeDossier(
  ch: PaperReproChallenge,
  bundle: { resources?: BundleResource[]; description?: string } | undefined,
  arxivIds: string[],
  hfDatasets: string[],
  relatedLearnings: Array<{ summary?: string; content?: string; specificityScore?: number }>,
): void {
  const reward = ch.estimatedRewardNook ?? "?";
  const closes = ch.closes_at ?? ch.closesAt ?? "?";
  const body = `# Paper-reproduction opportunity

**Challenge ID:** ${ch.id}
**Title:** ${ch.title ?? "(no title)"}
**Difficulty:** ${ch.difficulty ?? "?"}
**Domains:** ${(ch.domainTags ?? []).join(", ")}
**Estimated reward:** ${reward} NOOK (winner-take-all)
**Closes at:** ${closes}

## Action required (manual)

This is a paper_reproduction challenge — winner takes the full reward, and
verification requires the solver's Docker sandbox to reproduce the claimed
metric within ε. **Our Node bot cannot train models.** A human (or a
GPU-capable agent) must:

1. Read the paper, walk citations.
2. Find an existing implementation (or write one).
3. Train / fine-tune to hit the claimed metric.
4. Bundle weights + \`inference.py\` + \`requirements.txt\` into a tarball.
5. Pin to IPFS, get the artifactCid.
6. Call \`nookplot_submit_reasoning_trace({challengeId, artifactCid, claimedMetricValue})\`.

## Quick-start research

**arXiv IDs found:** ${arxivIds.length > 0 ? arxivIds.map((id) => `\`${id}\` (https://arxiv.org/abs/${id})`).join(", ") : "(none extracted — read challenge description manually)"}
**HuggingFace datasets:** ${hfDatasets.length > 0 ? hfDatasets.join(", ") : "(none extracted)"}
**Eval target:** \`baselineScore\` = ${JSON.stringify(ch.baselineScore ?? {}, null, 2)}

## Full description

${ch.description ?? "(no description)"}

## Bundle resources

${bundle?.resources?.map((r) => `- type=${r.type ?? "?"} id=${r.identifier ?? "?"} url=${r.url ?? "?"} ${r.description ?? ""}`).join("\n") ?? "(no bundle resources)"}

## Related learnings (top 10 by specificity, from prior solvers)

${
  relatedLearnings.length > 0
    ? relatedLearnings
        .slice(0, 10)
        .map(
          (l, i) =>
            `### Learning ${i + 1} (specificity=${l.specificityScore ?? "?"})\n${(l.summary ?? l.content ?? "").slice(0, 600)}`,
        )
        .join("\n\n")
    : "(no related learnings found yet — you'd be the first solver)"
}
`;
  writeNote(
    "research",
    `paper-repro-${ch.id.slice(0, 12)}`,
    {
      id: `paper-repro-${ch.id}`,
      title: `Paper-repro: ${ch.title ?? ch.id.slice(0, 12)}`,
      type: "paper-reproduction-opportunity",
      tags: ["paper-reproduction", ...(ch.domainTags ?? [])],
      challengeId: ch.id,
      arxivIds,
      hfDatasets,
      estimatedReward: ch.estimatedRewardNook,
      closes_at: closes,
    },
    body,
  );
}

export async function runPaperReproductionTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_PAPER_REPRODUCTION === "0") return;

  const challenges = await discoverChallenges(runtime);
  if (challenges.length === 0) return; // quiet — empty queue is the steady state

  const seen = loadSeen();
  const fresh = challenges.filter((c) => !seen.has(c.id));
  if (fresh.length === 0) {
    console.log(`📄 paper-repro: ${challenges.length} open, all already dossiered`);
    return;
  }

  console.log(`📄 paper-repro: ${fresh.length} NEW opportunity${fresh.length === 1 ? "" : "ies"} (winner-take-all)`);

  for (const ch of fresh) {
    const reward = ch.estimatedRewardNook ?? "?";
    console.log(
      `📄   ${ch.id.slice(0, 8)}  est ${reward} NOOK  ${ch.difficulty ?? "?"}  ${(ch.title ?? "").slice(0, 70)}`,
    );
    const { challenge, bundle, relatedLearnings } = await fetchChallengeDetail(runtime, ch.id);
    if (!challenge) continue;
    const arxivIds = extractArxivIds(bundle, challenge);
    const hfDatasets = extractHfDatasets(bundle);
    writeDossier(challenge, bundle, arxivIds, hfDatasets, relatedLearnings ?? []);
    console.log(
      `📄   → dossier written to knowledge-vault/research/paper-repro-${ch.id.slice(0, 12)}.md` +
        ` — ${arxivIds.length} arXiv ID(s), ${hfDatasets.length} HF dataset(s)`,
    );
    appendJsonl(LOG_PATH, {
      ts: new Date().toISOString(),
      challengeId: ch.id,
      title: ch.title,
      difficulty: ch.difficulty,
      domainTags: ch.domainTags,
      estimatedReward: ch.estimatedRewardNook,
      closes_at: ch.closes_at ?? ch.closesAt,
      arxivIds,
      hfDatasets,
      relatedLearningsCount: (relatedLearnings ?? []).length,
    });
    markSeen(ch.id);
  }
}

export function startPaperReproductionLoop(runtime: RuntimeLike): void {
  if (process.env.BOT_PAPER_REPRODUCTION === "0") return;
  // First poll 2 min after boot, then every 30 min
  setTimeout(() => runPaperReproductionTick(runtime).catch(() => undefined), 2 * 60 * 1000);
  setInterval(() => runPaperReproductionTick(runtime).catch(() => undefined), 30 * 60 * 1000);
}
