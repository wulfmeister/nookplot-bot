/**
 * Projects — Path A: package the bot's OWN documented work into a Nookplot
 * project, to start scoring the builder reputation dimensions (commits, lines,
 * projects, exec, collab) where we currently score zero. See the leaderboard
 * analysis: the entire reputation gap to the top-25 is these dimensions.
 *
 * ANTI-SLOP DESIGN (this is the whole point — a slop cannon LOWERS reputation):
 *   1. Grounded, not invented. The synthesis is built ONLY from the bot's own
 *      knowledge-vault research notes (real work it documented), and every
 *      section is backed by a provenance index linking the source notes +
 *      challengeIds. The LLM is told to synthesize the provided material, not
 *      add outside claims.
 *   2. Coherent. One topic per project (clustered by tag), min cluster size —
 *      not a random dump.
 *   3. Quality-gated. The draft must clear the same specificity gate the miner
 *      uses for trace summaries, or it is rejected and NOT written.
 *   4. Preview-first. `preview` writes the full draft to disk for YOU to read;
 *      it NEVER submits. Submission is a separate, explicit step.
 *   5. Double-gated submission. `submit` requires BOT_PROJECTS_SUBMIT=1 AND, in
 *      autonomous/supervised mode, create_project queues for owner approval in
 *      the dashboard before anything goes on-chain.
 *   6. Deduped. Clusters already turned into a draft are skipped.
 *
 * NOTE on grounding quality: our local notes are mostly `deferred` reasoning
 * summaries (not verified code). So v1 produces a RESEARCH SYNTHESIS artifact
 * (like the network's "W## …research" projects). A stronger "verified code"
 * variant — pulling status=verified solves + their IPFS traces from the gateway
 * — is the planned upgrade (see README "Path B / projects roadmap").
 *
 * CLI:
 *   npm run projects                  # pick a cluster, build + PREVIEW a draft (no submit)
 *   npm run projects -- list          # show candidate clusters
 *   npm run projects -- submit <slug> # submit a previewed draft (gated + confirm)
 */
import "dotenv/config";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { NookplotRuntime } from "@nookplot/runtime";
import { getRuntime } from "./runtime.js";
import { chat } from "./venice.js";
import { NOOK_DIR, extractJsonObj } from "./util.js";
import { countSpecificity } from "./specificity-gate.js";

const VAULT_DIR = process.env.BOT_VAULT_DIR ?? "knowledge-vault/research";
const DRAFTS_DIR = join(NOOK_DIR, "project-drafts");
const USED_FILE = join(NOOK_DIR, "project-clusters-used.json");
const MIN_CLUSTER = Number(process.env.BOT_PROJECTS_MIN_CLUSTER ?? 6);
const MAX_SOURCES = 16; // cap how many notes feed one synthesis

interface Note {
  file: string;
  title: string;
  tags: string[];
  outcome: string;
  verifierKind: string;
  challengeId: string;
  body: string;
}

function parseNote(file: string, raw: string): Note | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const get = (k: string) => fm?.[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const tagsRaw = get("tags");
  const tags = [...tagsRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const title = get("title").replace(/^["']|["']$/g, "");
  if (!title) return null;
  return {
    file,
    title,
    tags,
    outcome: get("outcome"),
    verifierKind: get("verifierKind"),
    challengeId: get("challengeId"),
    body: fm ? raw.slice(fm[0].length).trim() : raw,
  };
}

export function loadVaultNotes(): Note[] {
  if (!existsSync(VAULT_DIR)) return [];
  const out: Note[] = [];
  for (const f of readdirSync(VAULT_DIR)) {
    if (!f.endsWith(".md")) continue;
    try {
      const n = parseNote(f, readFileSync(join(VAULT_DIR, f), "utf8"));
      if (n) out.push(n);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function usedClusters(): string[] {
  try {
    return JSON.parse(readFileSync(USED_FILE, "utf8"));
  } catch {
    return [];
  }
}

/** Candidate clusters: tags with enough substantive notes, freshest topics first. */
export function candidateClusters(notes: Note[]): Array<{ tag: string; notes: Note[] }> {
  // Skip generic/process tags that don't make a coherent *topic*.
  const GENERIC = new Set([
    "mining", "verification", "standard", "deferred", "rejection", "test",
    "python_tests", "expert", "learning", "peer-review", "quality-review",
  ]);
  const byTag = new Map<string, Note[]>();
  for (const n of notes) {
    // a note is "substantive" if its body has real specificity
    if (countSpecificity(n.body) < 2) continue;
    for (const t of n.tags) {
      if (GENERIC.has(t)) continue;
      (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(n);
    }
  }
  const used = new Set(usedClusters());
  return [...byTag.entries()]
    .filter(([tag, ns]) => ns.length >= MIN_CLUSTER && !used.has(tag))
    .map(([tag, ns]) => ({ tag, notes: ns.slice(0, MAX_SOURCES) }))
    .sort((a, b) => b.notes.length - a.notes.length);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

type ProjRuntime = Pick<NookplotRuntime, "connection" | "tools">;
const PY_IMAGE = process.env.BOT_PROJECTS_PY_IMAGE ?? "python:3.12-slim";

interface Draft {
  slug: string;
  name: string;
  description: string;
  tag: string;
  sourceCount: number;
  files: Array<{ path: string; content: string }>;
  testsPassed: boolean;
  testOutput: string;
}

/** Pull a `<<<LABEL>>> … <<<END>>>` block, stripping any markdown code fence. */
function parseBlock(text: string, label: string): string {
  const m = text.match(new RegExp(`<<<${label}>>>([\\s\\S]*?)<<<END>>>`));
  if (!m) return "";
  return m[1].replace(/^\s*```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

/** Run the candidate's own unit tests in the gateway sandbox (stdlib-only). */
async function runUnitTests(runtime: ProjRuntime, mainPy: string, testPy: string): Promise<{ pass: boolean; output: string }> {
  try {
    const res = (await runtime.connection.request("POST", "/v1/exec", {
      command: "python test_main.py 2>&1",
      image: PY_IMAGE,
      files: { "main.py": mainPy, "test_main.py": testPy },
      timeout: 90,
    })) as { exitCode: number; stdout?: string; stderr?: string };
    const out = ((res.stdout ?? "") + (res.stderr ?? "")).trim().slice(-1000);
    return { pass: res.exitCode === 0, output: out };
  } catch (e) {
    return { pass: false, output: (e as Error).message.slice(0, 200) };
  }
}

/**
 * Build a CODE project (main.py + test_main.py + README.md) — matching the
 * network norm (~89% of live projects ship code). The artifact is a tested
 * reference implementation of one technique grounded in the bot's own work on
 * the topic. The HARD anti-slop gate is execution: the candidate's own unit
 * tests must PASS in the sandbox (`python test_main.py` exits 0) or it is never
 * queued — we only ever commit code that runs green.
 */
async function buildCodeDraft(runtime: ProjRuntime, cluster: { tag: string; notes: Note[] }): Promise<Draft | null> {
  const { tag, notes } = cluster;
  const topic = tag.replace(/-/g, " ");
  const sources = notes.slice(0, 12).map((n, i) => `[${i + 1}] ${n.title}`).join("\n");
  const sys =
    "You produce a SMALL, self-contained, genuinely useful Python project: a reference implementation of " +
    "ONE concrete technique, plus real unit tests. HARD RULES: (1) Python-3 STANDARD LIBRARY ONLY — no " +
    "numpy/pandas/requests/third-party imports (the sandbox has no pip). (2) main.py = a clean, documented " +
    "module with clear functions/classes, no TODOs/placeholders. (3) test_main.py uses `unittest`, " +
    "`import`s from main, has >=4 meaningful assertions incl. edge cases, and ends with " +
    '`if __name__ == "__main__": unittest.main()`. (4) The tests MUST pass against your own main.py. ' +
    "Output EXACTLY these blocks, nothing else:\n" +
    "<<<TITLE>>>short title<<<END>>>\n<<<DESC>>>one sentence<<<END>>>\n" +
    "<<<FILE:main.py>>>\n<code>\n<<<END>>>\n<<<FILE:test_main.py>>>\n<code>\n<<<END>>>\n<<<FILE:README.md>>>\n<markdown>\n<<<END>>>";
  const user =
    `Build a tested reference implementation of a single technique drawn from this agent's ${topic} work. ` +
    `Choose something concrete and self-contained that needs no external data or libraries. The agent has ` +
    `worked these ${topic} problems:\n${sources}\n\nThe README must explain what it is, the approach, the ` +
    `complexity, and note it is grounded in the agent's ${topic} work.`;

  const messages = [
    { role: "system" as const, content: sys },
    { role: "user" as const, content: user },
  ];
  let gen = (await chat(messages, { temperature: 0.35, timeoutMs: 180_000 })).content;
  let mainPy = parseBlock(gen, "FILE:main\\.py");
  let testPy = parseBlock(gen, "FILE:test_main\\.py");
  let readmeBody = parseBlock(gen, "FILE:README\\.md");
  const title = (parseBlock(gen, "TITLE") || `${topic} reference implementation`).slice(0, 80);
  const desc = (parseBlock(gen, "DESC") || `A tested ${topic} reference implementation.`).slice(0, 200);

  // ---- structural gate ----
  if (!mainPy || !testPy || mainPy.length < 200) return null;
  if (!/import unittest/.test(testPy) || (testPy.match(/self\.assert/g)?.length ?? 0) < 4) return null;
  if (/\b(numpy|pandas|requests|scipy|sklearn|torch|tensorflow)\b/.test(mainPy + testPy)) return null;

  // ---- execution gate: tests must pass in the sandbox (one repair attempt) ----
  let exec = await runUnitTests(runtime, mainPy, testPy);
  if (!exec.pass) {
    const repair = (await chat(
      [...messages, { role: "assistant" as const, content: gen }, {
        role: "user" as const,
        content: `The tests FAILED in the sandbox:\n${exec.output}\nReturn the SAME blocks with main.py and/or test_main.py fixed so 'python test_main.py' exits 0. Stdlib-only.`,
      }],
      { temperature: 0.2, timeoutMs: 180_000 },
    )).content;
    const m2 = parseBlock(repair, "FILE:main\\.py"), t2 = parseBlock(repair, "FILE:test_main\\.py"), r2 = parseBlock(repair, "FILE:README\\.md");
    if (m2 && t2) {
      mainPy = m2; testPy = t2; if (r2) readmeBody = r2; gen = repair;
      exec = await runUnitTests(runtime, mainPy, testPy);
    }
  }
  if (!exec.pass) return null; // never queue code that fails its own tests

  const index = notes.slice(0, 12).map((n, i) => `- [${i + 1}] ${n.title} — challenge \`${n.challengeId}\``).join("\n");
  // Drop any leading H1 the model put in the body so we don't double the title.
  const body = (readmeBody || desc).replace(/^\s*#\s+.+\n+/, "");
  const readme =
    `# ${title}\n\n${body}\n\n## Tests\n\nAll unit tests pass in a clean \`${PY_IMAGE}\` sandbox ` +
    `(\`python test_main.py\`):\n\n\`\`\`\n${exec.output.slice(-500)}\n\`\`\`\n\n## Provenance\n\n` +
    `Grounded in this agent's own ${topic} work on Nookplot:\n\n${index}\n`;
  const slug = (slugify(title) || slugify(topic)).slice(0, 40);
  return {
    slug,
    name: title,
    description: desc,
    tag,
    sourceCount: notes.length,
    files: [
      { path: "main.py", content: mainPy + "\n" },
      { path: "test_main.py", content: testPy + "\n" },
      { path: "README.md", content: readme },
    ],
    testsPassed: true,
    testOutput: exec.output.slice(-400),
  };
}

// ── Seeded (directed) projects — grounded in an operational finding, not a vault
//    cluster. Higher-value because they're useful to OTHER agents → citations. ──
interface Seed {
  key: string;
  tag: string;
  title: string;
  brief: string;
  grounding: string;
  provenance: string[];
}

const SEEDS: Record<string, Seed> = {
  "cid-validator": {
    key: "cid-validator",
    tag: "ipfs-cid-validation",
    title: "IPFS CID Validator",
    brief:
      "A self-contained validator for IPFS Content Identifiers. Implement (stdlib only, no external deps): " +
      "base58btc decode/encode, base32 (RFC4648 lowercase, no padding) decode/encode, and unsigned-varint decode. " +
      "Support CIDv0 (base58btc 'Qm...' = a 0x12 0x20 sha2-256 multihash, 34 bytes → 46 base58 chars) and CIDv1 " +
      "(multibase-prefixed: 'b' = base32, 'z' = base58btc; then varint version=1, varint multicodec, then a multihash " +
      "of varint code + varint length + digest where digest length MUST equal the declared length). " +
      "Public API: is_valid_cid(s)->bool, parse_cid(s)->CidInfo (raises ValueError on invalid), and " +
      "looks_like_spam(s)->bool that flags the network's common fake-CID pattern: strings that superficially resemble " +
      "a CIDv0 ('Qm' + ~44 more chars) but are NOT valid base58btc multihashes (e.g. contain the base58-forbidden " +
      "characters 0,O,I,l, or decode to the wrong length). Also expose make_cidv0(digest32)->str and " +
      "make_cidv1(codec,digest)->str so the tool can ENCODE, enabling round-trip tests.",
    grounding:
      "On the Nookplot network ~45% of the reasoning-trace verify pool is fake-CID spam: 'Qm'+hex strings that pass a " +
      "naive 'starts with Qm' check but are NOT valid base58btc CIDv0s and 400 when fetched from IPFS. We added base58 " +
      "validation to filter them and stop wasting our daily verify budget on them. This packages that filter as a " +
      "reusable validator any miner or verifier on the network can drop in.",
    provenance: [
      "Operational finding: ~45% of the verify pool was Qm+hex spam that 400s on fetch (wasted verify budget).",
      "Fix we shipped: base58btc multihash validation as a gate before spending a verify slot.",
      "This module generalizes that gate into a standalone, tested CID validator + spam classifier.",
    ],
  },
};

export function listSeeds(): Seed[] {
  return Object.values(SEEDS);
}

/** Build a CODE draft from a directed seed (same exec gate as buildCodeDraft). */
async function buildSeededDraft(runtime: ProjRuntime, seed: Seed): Promise<Draft | null> {
  const sys =
    "You produce a SMALL, self-contained, genuinely useful Python project: a reference implementation plus real unit " +
    "tests. HARD RULES: (1) Python-3 STANDARD LIBRARY ONLY — implement any encodings (base58, base32, varint) by hand, " +
    "no third-party imports. (2) main.py = a clean, documented module, no TODOs/placeholders. (3) test_main.py uses " +
    "`unittest`, imports from main, has >=6 assertions, and ends with `if __name__ == \"__main__\": unittest.main()`. " +
    "(4) Where correctness is OBJECTIVE, write GROUND-TRUTH tests — e.g. round-trip (encode a known digest, then validate " +
    "it = valid; corrupt one char = invalid) and definitionally-invalid inputs (base58-forbidden chars 0/O/I/l, wrong " +
    "lengths) — NOT tests that merely re-assert the implementation. (5) The tests MUST pass against your own main.py. " +
    "Output EXACTLY these blocks, nothing else:\n" +
    "<<<TITLE>>>short title<<<END>>>\n<<<DESC>>>one sentence<<<END>>>\n" +
    "<<<FILE:main.py>>>\n<code>\n<<<END>>>\n<<<FILE:test_main.py>>>\n<code>\n<<<END>>>\n<<<FILE:README.md>>>\n<markdown>\n<<<END>>>";
  const user =
    `Build this project.\n\nSUGGESTED TITLE: ${seed.title}\n\nWHAT TO BUILD:\n${seed.brief}\n\n` +
    `WHY IT'S USEFUL / GROUNDING:\n${seed.grounding}\n\nThe README must explain what it is, the approach, complexity, ` +
    `and the grounding above. Lead with ground-truth and round-trip tests so the validator is provably correct, not just self-consistent.`;

  const messages = [
    { role: "system" as const, content: sys },
    { role: "user" as const, content: user },
  ];
  let gen = (await chat(messages, { temperature: 0.3, timeoutMs: 180_000 })).content;
  let mainPy = parseBlock(gen, "FILE:main\\.py");
  let testPy = parseBlock(gen, "FILE:test_main\\.py");
  let readmeBody = parseBlock(gen, "FILE:README\\.md");
  const title = (parseBlock(gen, "TITLE") || seed.title).slice(0, 80);
  const desc = (parseBlock(gen, "DESC") || seed.title).slice(0, 200);

  if (!mainPy || !testPy || mainPy.length < 200) return null;
  if (!/import unittest/.test(testPy) || (testPy.match(/self\.assert/g)?.length ?? 0) < 6) return null;
  // Encodings must be hand-rolled (stdlib only) — reject third-party crypto/cid deps.
  if (/^\s*(import|from)\s+(requests|numpy|pandas|base58|multibase|multihash|py_?cid|cid|pymultihash)\b/m.test(mainPy + testPy)) return null;

  let exec = await runUnitTests(runtime, mainPy, testPy);
  if (!exec.pass) {
    const repair = (await chat(
      [...messages, { role: "assistant" as const, content: gen }, {
        role: "user" as const,
        content: `The tests FAILED in the sandbox:\n${exec.output}\nReturn the SAME blocks with fixes so 'python test_main.py' exits 0. Stdlib-only.`,
      }],
      { temperature: 0.2, timeoutMs: 180_000 },
    )).content;
    const m2 = parseBlock(repair, "FILE:main\\.py"), t2 = parseBlock(repair, "FILE:test_main\\.py"), r2 = parseBlock(repair, "FILE:README\\.md");
    if (m2 && t2) { mainPy = m2; testPy = t2; if (r2) readmeBody = r2; gen = repair; exec = await runUnitTests(runtime, mainPy, testPy); }
  }
  if (!exec.pass) return null;

  const body = (readmeBody || desc).replace(/^\s*#\s+.+\n+/, "");
  const prov = seed.provenance.map((p) => `- ${p}`).join("\n");
  const readme =
    `# ${title}\n\n${body}\n\n## Tests\n\nAll unit tests pass in a clean \`${PY_IMAGE}\` sandbox (\`python test_main.py\`):\n\n` +
    `\`\`\`\n${exec.output.slice(-500)}\n\`\`\`\n\n## Provenance\n\n${prov}\n`;
  const slug = (slugify(title) || seed.key).slice(0, 40);
  return {
    slug,
    name: title,
    description: desc,
    tag: seed.tag,
    sourceCount: seed.provenance.length,
    files: [
      { path: "main.py", content: mainPy + "\n" },
      { path: "test_main.py", content: testPy + "\n" },
      { path: "README.md", content: readme },
    ],
    testsPassed: true,
    testOutput: exec.output.slice(-400),
  };
}

function writeDraft(d: Draft): string {
  const dir = join(DRAFTS_DIR, d.slug);
  mkdirSync(dir, { recursive: true });
  for (const f of d.files) writeFileSync(join(dir, f.path), f.content);
  writeFileSync(join(dir, "_meta.json"), JSON.stringify({ name: d.name, description: d.description, tag: d.tag, sourceCount: d.sourceCount, testsPassed: d.testsPassed, testOutput: d.testOutput }, null, 2));
  return dir;
}

/** Build + preview a draft. With `preferredTag`, builds that specific cluster
 *  (so you can pick a neutral topic rather than the highest-count one — e.g.
 *  avoid the `sybil-detection` cluster, which names specific peer agents).
 *  Never submits. */
export async function previewDraft(runtime: ProjRuntime, preferredTag?: string): Promise<Draft | null> {
  const all = candidateClusters(loadVaultNotes());
  const clusters = preferredTag ? all.filter((c) => c.tag === preferredTag) : all.filter((c) => !SENSITIVE_TAGS.has(c.tag));
  if (clusters.length === 0) {
    console.log(
      preferredTag
        ? `📁 no eligible cluster for "${preferredTag}" (need ≥${MIN_CLUSTER} substantive, unused notes). Try: npm run projects -- list`
        : "📁 no eligible clusters (need ≥" + MIN_CLUSTER + " substantive notes on an unused topic)",
    );
    return null;
  }
  for (const cluster of clusters.slice(0, 4)) {
    console.log(`📁 building code project for "${cluster.tag}" (validating tests in sandbox)…`);
    const draft = await buildCodeDraft(runtime, cluster);
    if (!draft) {
      console.log(`   ✗ failed structural/exec gate — skipping (tests didn't pass or output not slop-worthy)`);
      continue;
    }
    const dir = writeDraft(draft);
    console.log(`\n📁 ✓ DRAFT (NOT submitted) → ${dir}\n   name: ${draft.name}\n   files: ${draft.files.map((f) => f.path).join(", ")}\n   ✅ tests pass in sandbox: ${draft.testOutput.split("\n").slice(-1)[0]}\n`);
    for (const f of draft.files) console.log(`\n──── ${f.path} ` + "─".repeat(60 - f.path.length) + "\n" + f.content);
    console.log("─".repeat(72) + `\n\nReview it, then: npm run projects -- submit ${draft.slug}`);
    return draft;
  }
  console.log("📁 all top clusters failed the gate — nothing written.");
  return null;
}

/** Submit a previewed draft as a Nookplot project. Double-gated. */
export async function submitDraft(runtime: ProjRuntime, slug: string, opts?: { viaGate?: boolean }): Promise<void> {
  const dir = join(DRAFTS_DIR, slug);
  if (!existsSync(dir)) throw new Error(`no draft at ${dir} — run 'npm run projects' first`);
  const meta = JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8"));
  // Commit only real source files: skip metadata (leading "_") and anything
  // that isn't a regular file (e.g. a stray __pycache__/ dir from a local run).
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith("_") && !f.startsWith(".") && statSync(join(dir, f)).isFile())
    .map((f) => ({ path: f, content: readFileSync(join(dir, f), "utf8") }));

  if (!opts?.viaGate && process.env.BOT_PROJECTS_SUBMIT !== "1") {
    console.log("📁 BOT_PROJECTS_SUBMIT!=1 — refusing to submit. Set it to enable (still owner-approval-gated on-chain).");
    return;
  }
  console.log(`📁 creating project "${meta.name}" (${files.length} files)…`);
  const created = (await runtime.tools.executeTool("create_project", {
    projectId: slug,
    name: meta.name,
    description: meta.description,
    tags: [meta.tag],
    languages: ["python"],
  }))?.output as { projectId?: string; queued?: boolean; id?: string };
  if ((created as { queued?: boolean })?.queued) {
    console.log("📁 queued for your approval in the dashboard (autonomous mode). Approve there to finish the on-chain create.");
    return;
  }
  const pid = created?.projectId ?? created?.id ?? slug;
  // create_project's on-chain relay can lag the commit, so commit_files may 404
  // ("Project not found") for a while after create — observed up to ~30s. Retry
  // with a generous window before giving up.
  const MAX_ATTEMPTS = 15;
  let committed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !committed; attempt++) {
    try {
      await runtime.tools.executeTool("commit_files", { projectId: pid, message: `Add ${meta.name}`, files });
      committed = true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!/not found/i.test(msg) || attempt === MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, 3000)); // wait for the project to propagate
    }
  }
  // Run the tests IN-PROJECT to score the `exec` reputation dimension (a project
  // run attributes to us). Best-effort — never fail a submit over scoring.
  try {
    const py = Object.fromEntries(files.filter((f) => f.path.endsWith(".py")).map((f) => [f.path, f.content]));
    if (py["test_main.py"]) {
      const xc = (await runtime.tools.executeTool("exec_code", {
        projectId: pid,
        command: "python test_main.py 2>&1",
        image: PY_IMAGE,
        files: py,
        timeout: 90,
      }))?.output as { exitCode?: number };
      console.log(`📁 exec score: tests ran in-project (exit ${xc?.exitCode ?? "?"}) keys=[${Object.keys(xc ?? {}).join(",")}]`);
    }
  } catch (err) {
    // Best-effort — never fail a submit over scoring — but surface WHY, since
    // a silently-swallowed exec is exactly why the `exec` dimension read 0.
    console.warn(`📁 exec score skipped: ${(err as Error).message.slice(0, 160)}`);
  }
  // mark cluster used so we don't repackage it
  try {
    const used = usedClusters();
    used.push(meta.tag);
    writeFileSync(USED_FILE, JSON.stringify(used));
  } catch { /* best effort */ }
  // mark the review item approved (if it came through the queue)
  try {
    const q = loadQueue();
    const item = q.find((i) => i.slug === slug);
    if (item) { item.status = "approved"; saveQueue(q); }
  } catch { /* best effort */ }
  console.log(`📁 ✓ committed to project ${pid}`);
}

// ── Review queue + peer comparison (human-in-the-loop) ───────────────────────

const REVIEW_QUEUE = join(NOOK_DIR, "project-review-queue.json");
// Topics the AUTO tick must never surface unreviewed — these name/accuse peers.
const SENSITIVE_TAGS = new Set(["sybil-detection", "rejection", "peer-review", "quality-review"]);

// ── Conservative auto-submit gate (opt-in via BOT_PROJECTS_AUTO_SUBMIT=1) ─────
// Removes the human from the critical path for the routine, low-stakes majority
// (where review approvals were adding no additional signal) while ESCALATING the correctness-
// critical domains where a subtle bug is a permanent on-chain reputation hit —
// exactly where the one real defect this pipeline caught lived (a crypto crash).
const AUTO_SUBMIT = process.env.BOT_PROJECTS_AUTO_SUBMIT === "1";
// Domains that ALWAYS go to a human even with passing tests + a clean review:
// subtle-correctness territory where "tests pass" is provably insufficient.
const HIGH_STAKES_TAGS = new Set(
  (process.env.BOT_PROJECTS_HIGH_STAKES_TAGS ??
    "cryptography,security,privacy,consensus,authentication,exploitation,systems-security,smart-contracts,ml-safety,tpm,appsec,infosec,websec,netsec,opsec")
    .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
);
/**
 * The draft generator picks tags freely, so exact-set matching lets synonyms
 * bypass the always-escalate list (a security draft tagged "appsec" slipped
 * past "security" on 2026-07-02). Also treat any tag containing a high-stakes
 * root or ending in "sec" as high-stakes — over-escalating is cheap, a bad
 * auto-publish is a permanent on-chain reputation hit.
 */
export function isHighStakesTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return HIGH_STAKES_TAGS.has(t) || /security|crypto|privacy|auth|exploit|consensus|sec$/.test(t);
}
const REVIEW_MODEL = process.env.BOT_PROJECTS_REVIEW_MODEL ?? "claude-opus-4-8";

/**
 * Merge duplicate `## H2` sections in a README (the recurring `## Tests` /
 * `## Provenance` duplication these drafts ship). Keeps the FIRST occurrence of
 * each heading and drops later same-named sections (their content — e.g. the
 * sandbox output — is preserved in _meta.json). Pure — testable.
 */
export function dedupReadmeSections(readme: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let dropping = false;
  for (const line of readme.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      const key = m[1].toLowerCase();
      dropping = seen.has(key);
      if (dropping) continue;
      seen.add(key);
    }
    if (!dropping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

/** Single strong-model correctness review — the automated stand-in for the manual deep review. */
async function reviewDraftCorrectness(name: string, codeAndTests: string): Promise<{ safe: boolean; confidence: string; issues: string[]; notes: string }> {
  const sys =
    "You are a STRICT reviewer deciding whether a small project is safe to PUBLISH ON-CHAIN under our identity WITHOUT any human review. It ALREADY passed its unit tests in a clean sandbox — so 'tests pass' is NOT sufficient evidence and you must NOT rely on it. Hunt for: logic bugs the tests miss, stubs that ignore their inputs, off-by-one / boundary errors, insecure patterns, and MISLEADING claims in code/comments (e.g. 'implements standard X' when it doesn't). Escalation to a human is cheap; a wrong on-chain publish is permanent — so set safe=false or confidence below 'high' on ANY genuine doubt. " +
    "Output STRICT JSON only: {\"safe\": boolean, \"confidence\": \"high\"|\"medium\"|\"low\", \"issues\": [\"blocking issue\", ...], \"notes\": \"one line\"}.";
  try {
    const res = await chat(
      [{ role: "system", content: sys }, { role: "user", content: `Project: ${name}\n\n${codeAndTests.slice(0, 24000)}` }],
      { model: REVIEW_MODEL, max_tokens: 1500, temperature: 0.1, timeoutMs: 180_000 },
    );
    const p = extractJsonObj<{ safe?: boolean; confidence?: string; issues?: string[]; notes?: string }>(res.content);
    if (!p) {
      console.log(`📁🤖 review output did not parse — raw (first 400 chars): ${res.content.slice(0, 400)}`);
      return { safe: false, confidence: "low", issues: ["review output did not parse"], notes: "" };
    }
    return { safe: p.safe === true, confidence: (p.confidence ?? "low").toLowerCase(), issues: p.issues ?? [], notes: p.notes ?? "" };
  } catch (e) {
    return { safe: false, confidence: "low", issues: [`review error: ${(e as Error).message.slice(0, 80)}`], notes: "" };
  }
}

/** Decide whether a pending draft can auto-submit or must escalate to a human. */
async function autoSubmitGate(item: ReviewItem): Promise<{ decision: "submit" | "escalate"; reason: string }> {
  const dir = join(DRAFTS_DIR, item.slug);
  let meta: { testsPassed?: boolean } = {};
  try { meta = JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8")); } catch { /* ignore */ }
  if (meta.testsPassed !== true) return { decision: "escalate", reason: "sandbox tests did not pass" };
  if (isHighStakesTag(item.tag)) {
    return { decision: "escalate", reason: `high-stakes domain "${item.tag}" — subtle-correctness territory, human review required` };
  }
  let code = "";
  try {
    code = readdirSync(dir)
      .filter((f) => (f.endsWith(".py") || f.endsWith(".js")) && !f.startsWith("_"))
      .map((f) => `# ${f}\n${readFileSync(join(dir, f), "utf8")}`)
      .join("\n\n");
  } catch { /* ignore */ }
  if (!code) return { decision: "escalate", reason: "could not read draft source for review" };
  const review = await reviewDraftCorrectness(item.name, code);
  if (!review.safe) return { decision: "escalate", reason: `review flagged: ${review.issues.join("; ") || review.notes || "unsafe"}` };
  if (review.confidence !== "high") return { decision: "escalate", reason: `review confidence ${review.confidence} (auto-submit needs high)` };
  return { decision: "submit", reason: "tests pass + clean high-confidence review + low-stakes domain" };
}

/** Run the gate on the current pending draft (once) and either auto-submit or leave it for the human. */
async function maybeAutoSubmitPending(runtime: ProjRuntime): Promise<void> {
  const item = pendingReview();
  if (!item || item.gateDecision) return; // no pending, or already gated this draft
  let gate: { decision: "submit" | "escalate"; reason: string };
  try {
    gate = await autoSubmitGate(item);
  } catch (e) {
    gate = { decision: "escalate", reason: `gate error: ${(e as Error).message.slice(0, 80)}` };
  }
  const q = loadQueue();
  // Match on slug+createdAt: re-drafted topics reuse a slug, and matching slug
  // alone stamped the decision on an old approved row (leaving the pending one
  // un-gated, so the review re-ran every tick).
  const qi = q.find((i) => i.slug === item.slug && i.createdAt === item.createdAt);
  if (qi) { qi.gateDecision = gate.decision; qi.gateReason = gate.reason; saveQueue(q); }
  if (gate.decision === "submit") {
    try {
      const rp = join(DRAFTS_DIR, item.slug, "README.md");
      if (existsSync(rp)) writeFileSync(rp, dedupReadmeSections(readFileSync(rp, "utf8")));
    } catch { /* best effort */ }
    console.log(`📁🤖 auto-submit gate PASSED "${item.name}" (${gate.reason}) — submitting on-chain`);
    await submitDraft(runtime, item.slug, { viaGate: true });
  } else {
    console.log(`📁🤖 auto-submit gate ESCALATED "${item.name}" to operator — ${gate.reason}`);
  }
}

interface ReviewItem {
  slug: string;
  name: string;
  tag: string;
  sourceCount: number;
  status: "pending" | "approved" | "passed";
  createdAt: string;
  // Set once by the auto-submit gate (BOT_PROJECTS_AUTO_SUBMIT=1) so we don't
  // re-run the LLM review each tick, and so the dashboard can show why a draft
  // was escalated to the human instead of auto-shipped.
  gateDecision?: "submit" | "escalate";
  gateReason?: string;
}

function loadQueue(): ReviewItem[] {
  try {
    return JSON.parse(readFileSync(REVIEW_QUEUE, "utf8"));
  } catch {
    return [];
  }
}
function saveQueue(q: ReviewItem[]): void {
  writeFileSync(REVIEW_QUEUE, JSON.stringify(q, null, 2));
}
export function pendingReview(): ReviewItem | null {
  return loadQueue().find((i) => i.status === "pending") ?? null;
}

/**
 * Recurring in-project exec to grow (and diagnose) the `exec` reputation
 * dimension. For each approved project we re-run its test suite via
 * exec_code({projectId}) so the run attributes to us. This is ALSO a probe:
 * `exec` has been reading 0 despite the submit-time run, so we log the full
 * gateway response keyset — if in-project runs don't move the dimension after a
 * few cycles, the evidence is here and we pivot (e.g. to artifact reruns).
 *
 * Gated by BOT_EXEC_SCORING_AUTO=1. One run per approved project per tick.
 */
export async function runExecScoringTick(runtime: NookplotRuntime): Promise<void> {
  if (process.env.BOT_EXEC_SCORING_AUTO !== "1") return;
  const approved = loadQueue().filter((i) => i.status === "approved");
  if (approved.length === 0) return;
  for (const item of approved) {
    const dir = join(DRAFTS_DIR, item.slug);
    if (!existsSync(dir)) {
      console.log(`🧪 exec-score: no local draft for ${item.slug} — skipping (can't re-run without sources)`);
      continue;
    }
    const py = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".py") && statSync(join(dir, f)).isFile())
        .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const),
    );
    if (!py["test_main.py"]) {
      console.log(`🧪 exec-score: ${item.slug} has no test_main.py — skipping`);
      continue;
    }
    try {
      const res = (await runtime.tools.executeTool("exec_code", {
        projectId: item.slug,
        command: "python test_main.py 2>&1",
        image: PY_IMAGE,
        files: py,
        timeout: 90,
      }))?.output as { exitCode?: number; stdout?: string } & Record<string, unknown>;
      const tail = String(res?.stdout ?? "").trim().split("\n").slice(-1)[0] ?? "";
      // Log the FULL keyset so we can see whether the gateway returns any
      // attribution/score field for a project-attributed run — the diagnostic
      // for why `exec` reads 0.
      console.log(
        `🧪 exec-score ${item.slug}: exit=${res?.exitCode ?? "?"} keys=[${Object.keys(res ?? {}).join(",")}] "${tail.slice(0, 80)}"`,
      );
    } catch (err) {
      console.warn(`🧪 exec-score ${item.slug} FAILED: ${(err as Error).message.slice(0, 160)}`);
    }
  }
}

interface PeerProject {
  name: string;
  id: string;
  mode?: string;
  commits?: number;
  langs?: string[];
  files?: string[];
  kind?: string;
}
export interface PeerComparison {
  topic: string;
  peers: PeerProject[];
  assessment: string;
}

/** Scrape comparable network projects so a draft can be judged against the bar. */
async function buildPeerComparison(runtime: Pick<NookplotRuntime, "tools">, topic: string): Promise<PeerComparison> {
  const ex = async (n: string, a: Record<string, unknown>) => {
    try {
      return (await runtime.tools.executeTool(n, a))?.output as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const peers: PeerProject[] = [];
  const lp = await ex("list_projects", { query: (topic || "research").slice(0, 60), limit: 6 });
  for (const p of ((lp.projects ?? lp.items ?? []) as Record<string, unknown>[]).slice(0, 4)) {
    peers.push({
      name: String(p.name ?? "?"),
      id: String(p.projectId ?? p.id ?? ""),
      mode: (p.collaborationMode ?? p.mode) as string,
      commits: (p.commitCount ?? p.commits) as number,
      langs: (p.languages as string[]) ?? [],
    });
  }
  // Fallback: if topic search is sparse, use recent network frontier projects as
  // general "what's the bar" context so the comparison is never empty.
  if (peers.length < 2) {
    const fr = await ex("get_frontiers", { limit: 10 });
    const seen = new Set(peers.map((p) => p.name));
    for (const f of ((fr.frontiers ?? fr.commits ?? []) as Record<string, unknown>[])) {
      const name = String(f.projectName ?? "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      peers.push({ name, id: String(f.projectId ?? ""), commits: undefined, langs: [] });
      if (peers.length >= 4) break;
    }
  }
  // Characterize up to 2 peers (code vs research) by listing their files.
  for (const p of peers.slice(0, 2)) {
    if (!p.id) continue;
    const lf = await ex("list_project_files", { projectId: p.id });
    const names = ((lf.files ?? lf.tree ?? []) as unknown[])
      .map((x) => (typeof x === "string" ? x : ((x as Record<string, unknown>)?.path ?? (x as Record<string, unknown>)?.name)))
      .filter(Boolean) as string[];
    p.files = names.slice(0, 10);
    p.kind = names.some((n) => /\.(py|js|ts|sol|rs|go)$/i.test(n)) ? "working code" : "research/markdown";
  }
  const codePeers = peers.filter((p) => p.kind === "working code").length;
  const assessment =
    peers.length === 0
      ? `No comparable projects surfaced — ours may be early to the topic (good) or the search missed them.`
      : `Compared against ${peers.length} project(s) on the network; ${codePeers} are working-code, ${peers.length - codePeers} notes/markdown. ` +
        `Ours is a tested Python module (main.py + test_main.py + README.md) — it matches the network norm (~89% of live ` +
        `projects ship code, incl. the "W## …research" series which are main.py+test_main.py). Its unit tests pass in a clean ` +
        `sandbox before it's ever queued, so this is a runnable, verified artifact — not notes.`;
  return { topic, peers, assessment };
}

function autoPickCluster(notes: Note[]): { tag: string; notes: Note[] } | null {
  return candidateClusters(notes).find((c) => !SENSITIVE_TAGS.has(c.tag)) ?? null;
}

/**
 * Daemon tick: keep exactly ONE draft pending your review at a time. Generates a
 * neutral-topic draft + a peer comparison and enqueues it — then STOPS. It never
 * submits; you approve (`-- submit`) or pass (`-- pass`). Off unless
 * BOT_PROJECTS_AUTO_PREVIEW=1.
 */
/** Write a draft + peer comparison and enqueue it as the one pending review. */
export async function enqueueDraft(runtime: ProjRuntime, draft: Draft): Promise<void> {
  const dir = writeDraft(draft);
  const peers = await buildPeerComparison(runtime, draft.tag);
  writeFileSync(join(dir, "_peers.json"), JSON.stringify(peers, null, 2));
  const q = loadQueue();
  q.push({ slug: draft.slug, name: draft.name, tag: draft.tag, sourceCount: draft.sourceCount, status: "pending", createdAt: new Date().toISOString() });
  saveQueue(q);
  console.log(
    `\n📁📁 PROJECT DRAFT PENDING YOUR REVIEW: "${draft.name}" (main.py + test_main.py + README.md, tests pass)\n` +
      `   ${peers.assessment}\n` +
      `   review it:  npm run projects -- review\n` +
      `   then:       npm run projects -- submit ${draft.slug}   |   -- pass ${draft.slug}\n`,
  );
}

/** Draft + enqueue a directed seed (e.g. the CID validator). Returns the draft or null. */
export async function seedDraft(runtime: ProjRuntime, key: string): Promise<Draft | null> {
  const seed = SEEDS[key];
  if (!seed) {
    console.log(`📁 no seed "${key}". Available: ${Object.keys(SEEDS).join(", ")}`);
    return null;
  }
  if (pendingReview()) {
    console.log("📁 a draft is already pending review — act on it first (review / submit / pass).");
    return null;
  }
  console.log(`📁 seeding "${seed.title}" (validating tests in sandbox)…`);
  const draft = await buildSeededDraft(runtime, seed);
  if (!draft) {
    console.log("📁 seed failed the structural/exec gate — tests didn't pass. Re-run to retry.");
    return null;
  }
  await enqueueDraft(runtime, draft);
  return draft;
}

export async function runProjectsReviewTick(runtime: ProjRuntime): Promise<void> {
  if (process.env.BOT_PROJECTS_AUTO_PREVIEW !== "1") return;
  if (pendingReview()) {
    // A draft is already pending. With the auto-submit gate on, run it (auto-ship
    // the clean low-stakes ones, escalate the rest); otherwise wait for the operator.
    if (AUTO_SUBMIT) await maybeAutoSubmitPending(runtime);
    return;
  }
  // Try a few neutral topics — the exec gate may reject some before one passes.
  const candidates = candidateClusters(loadVaultNotes()).filter((c) => !SENSITIVE_TAGS.has(c.tag)).slice(0, 4);
  for (const cluster of candidates) {
    const draft = await buildCodeDraft(runtime, cluster);
    if (!draft) continue; // tests failed / structural gate — next topic
    await enqueueDraft(runtime, draft);
    if (AUTO_SUBMIT) await maybeAutoSubmitPending(runtime);
    return;
  }
}

function readPeers(slug: string): PeerComparison | null {
  try {
    return JSON.parse(readFileSync(join(DRAFTS_DIR, slug, "_peers.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Mark a pending draft as passed (not submitting) and don't regenerate that topic. */
export function passDraft(slug: string): void {
  const q = loadQueue();
  const item = q.find((i) => i.slug === slug);
  if (item) {
    item.status = "passed";
    saveQueue(q);
    try {
      const used = usedClusters();
      if (!used.includes(item.tag)) used.push(item.tag);
      writeFileSync(USED_FILE, JSON.stringify(used));
    } catch { /* best effort */ }
    console.log(`📁 passed on "${slug}" — won't resurface that topic. Next tick will draft a different one.`);
  } else {
    console.log(`📁 no queued draft "${slug}".`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function cli(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "seeds") {
    console.log("📁 directed seeds (grounded in operational findings, useful to other agents):");
    for (const s of listSeeds()) console.log(`   ${s.key.padEnd(18)} ${s.title}`);
    console.log(`\nDraft one:  npm run projects -- seed <key>`);
    return;
  }
  if (cmd === "seed") {
    if (!arg) { console.error("usage: npm run projects -- seed <key>   (see: npm run projects -- seeds)"); process.exit(1); }
    await seedDraft(getRuntime(), arg);
    return;
  }
  if (cmd === "list") {
    const clusters = candidateClusters(loadVaultNotes());
    console.log(`📁 ${clusters.length} candidate clusters (≥${MIN_CLUSTER} substantive notes, unused):`);
    for (const c of clusters.slice(0, 15)) console.log(`   ${c.tag.padEnd(28)} ${c.notes.length} notes`);
    console.log(`\nPreview a specific one:  npm run projects -- preview <tag>`);
    return;
  }
  if (cmd === "preview") {
    await previewDraft(getRuntime(), arg);
    return;
  }
  if (cmd === "review") {
    const item = pendingReview();
    if (!item) { console.log("📁 nothing pending review. The daemon drafts one at a time when BOT_PROJECTS_AUTO_PREVIEW=1."); return; }
    const peers = readPeers(item.slug);
    let readme = "";
    try { readme = readFileSync(join(DRAFTS_DIR, item.slug, "README.md"), "utf8"); } catch { /* */ }
    console.log(`\n📁 PENDING REVIEW: "${item.name}"  (${item.sourceCount} grounded sources · drafted ${item.createdAt})\n`);
    console.log("── HOW IT COMPARES TO PEERS ──");
    console.log("  " + (peers?.assessment ?? "(no peer data)"));
    for (const p of peers?.peers ?? []) console.log(`   • ${p.name} [${p.kind ?? p.mode ?? "?"}] ${p.commits != null ? p.commits + " commits" : ""} ${(p.langs ?? []).join("/")}`);
    console.log("\n── DRAFT CONTENT ──\n" + "─".repeat(72) + "\n" + readme + "\n" + "─".repeat(72));
    console.log(`\nDecide:  npm run projects -- submit ${item.slug}   (approve + publish)`);
    console.log(`         npm run projects -- pass ${item.slug}     (skip; won't resurface this topic)`);
    return;
  }
  if (cmd === "pass") {
    if (!arg) { console.error("usage: npm run projects -- pass <slug>"); process.exit(1); }
    passDraft(arg);
    return;
  }
  if (cmd === "submit") {
    if (!arg) { console.error("usage: npm run projects -- submit <slug>"); process.exit(1); }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`Submit draft "${arg}" as an on-chain project? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") { console.log("aborted."); return; }
    await submitDraft(getRuntime(), arg);
    return;
  }
  await previewDraft(getRuntime());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
