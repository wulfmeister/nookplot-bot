/**
 * DeepSeek-V4.1-Flash swap probe (2026-09-20).
 *
 * Question: can we replace claude-opus-5 ($6/$30 per M) as the mining workhorse
 * with deepseek-v4-1-flash ($0.375/$1.50 — 16x/20x cheaper) or another arm?
 *
 * Mirrors the TWO real call shapes from mining.ts:
 *   A. solveStandardTrace — max_tokens 40000, temp 0.2, NO venice web search
 *   B. solvePythonTests   — max_tokens 6000,  temp 0.15, web search ON
 *
 * Scores every output with the REAL local specificity mirror (the same code the
 * pre-submit gate and the on-400 enrichment use), so a model that would 400 at
 * the gateway shows up here.
 *
 * Cost estimates use live catalog rates (probed 2026-09-20).
 */
import "dotenv/config";
import {
  countSpecificity,
  passesSpecificityGate,
  enrichSummarySpecificity,
} from "./specificity-gate.js";

const VENICE_URL = "https://api.venice.ai/api/v1/chat/completions";
const KEY = process.env.VENICE_API_KEY!;

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 6, out: 30 },
  "deepseek-v4-1-flash": { in: 0.375, out: 1.5 },
  "deepseek-v4-flash": { in: 0.138, out: 0.275 },
  "gemini-3-8-flash": { in: 0.9375, out: 4.6875 },
  "grok-4-6": { in: 2.27, out: 6.8 },
};

interface Arm { model: string; effort: string }

const ARMS: Arm[] = [
  { model: "claude-opus-5", effort: "xhigh" },        // incumbent
  { model: "deepseek-v4-1-flash", effort: "high" },   // candidate @ default effort
  { model: "deepseek-v4-1-flash", effort: "max" },    // candidate @ top effort
  { model: "gemini-3-8-flash", effort: "high" },      // current cheap pool arm
  { model: "deepseek-v4-flash", effort: "high" },     // stretch: 100x cheaper
];

// --- Case A: standard trace (shape copied from solveStandardTrace) ---
const STANDARD_SYS = `You are an expert problem-solver producing a long-form reasoning trace for a Nookplot mining challenge. The trace will be graded by 3 verifiers across correctness, reasoning quality, efficiency, and novelty.

OUTPUT FORMAT — JSON ONLY:
{
  "summary": "150-280 char concise description of approach + the key result",
  "trace": "Long-form markdown — see structure below"
}

The trace markdown MUST use this exact section structure:

## Approach
A brief framing — what mathematical/scientific/engineering frame you're using and why.

## Steps
Numbered steps (### Step 1, ### Step 2, ...). Each step shows:
- What you're computing or proving
- The work (equations, derivations, code snippets, citations)
- The intermediate result + a sanity check
- Any dead-ends you considered and why you rejected them

## Conclusion
The final answer or key claim, with units / precision.

## Uncertainty
Specific things you're less sure about, ranked by importance.

## Citations
Numbered citations to papers, learnings, or sources used. Format:
[1] Author Year — title or claim, with link or arxiv ID if available.

CONTENT REQUIREMENTS:
- 800-1500 words of substance, not fluff.
- Concrete numbers, not vague claims.
- Cite specific papers/learnings (even from training data) by author + year.
- Show your work — verifiers can re-derive your steps.
- When you don't know, say "uncertain because ..." — calibration scores higher than confident bluffing.`;

const STANDARD_USER = `# Challenge: Prove that the harmonic numbers H_n = 1 + 1/2 + ... + 1/n satisfy H_n = ln(n) + γ + 1/(2n) + O(1/n²) where γ ≈ 0.5772 is the Euler-Mascheroni constant.

Difficulty: hard
Domain: number-theory, analysis
Source type: agent-authored

## Full description
Provide a rigorous derivation using either:
(a) Euler-Maclaurin summation formula, OR
(b) The integral definition of γ + asymptotic expansion of the digamma function.

State the leading-order error term explicitly. Verify with n=10 (compute H_10 exactly vs the asymptotic estimate).

Produce the JSON now.`;

// --- Case B: python_tests (shape copied from solvePythonTests) ---
const PY_SYS = `You are an expert Python engineer. Solve the challenge by producing a single solution.py file. The solution will be tested against a hidden test harness.

Constraints:
- Output JSON ONLY, no prose, no code fences outside the JSON value.
- Schema (emit "solution" FIRST): {"solution":"complete Python source code as a single string","reasoning":"50-200 char explanation","summary":"100+ char description of approach + key steps"}
- The "summary" is scored for specificity by an automated grader and REJECTED below threshold. It must contain ALL THREE of:
  • a measurable claim with units or counts — "O(n log n) for n=10000 elements", "2 passes over 64 bytes"; a bare year or step number does NOT count;
  • a named method in backticks — \`bisect_right\`, \`urlsplit\`, \`Map.get\` — used in a clause that says what it does, not just listed;
  • an explicit comparison — "X instead of Y", "vs", "better than".
  Describe the ALGORITHM and its measurable properties. Do NOT pad with metadata.
- Your solution.py must export the function(s) named in the challenge description.
- Handle edge cases (empty inputs, negatives, zero, large numbers, off-by-one boundaries).
- Use stdlib only; no third-party imports unless requirements.txt explicitly lists them.
- No print() statements. No __main__ block. Just the requested functions.
- SECURITY — the hidden tests very often assert this, and one security failure rejects the whole solve even if the functional test passes. Write secure code, not just working code:
  • SSRF: before any outbound request, validate/allowlist the host and BLOCK internal / link-local / metadata targets.
  • Deserialization: NEVER pickle/marshal/dill.loads or yaml.load() untrusted bytes (arbitrary code execution). Use json for untrusted input.
  • Injection / traversal: no eval/exec/os.system/subprocess with untrusted input; normalize + confine file paths (reject '..' escapes); parameterize any SQL.`;

const PY_USER = `Challenge: Random file runner
Difficulty: medium
Domain: file-system, security

Full description:
Implement \`pick_and_run(dir_path, filenames, command)\` in solution.py.

Requirements:
- Choose one file at random from the given list of filenames inside dir_path.
- Run the given command (a list of argv strings) against that file using subprocess.
- Return the process exit code as an int, or -1 if the file does not exist.
- The hidden tests assert SECURITY properties: the function must reject path traversal ('..' escapes) and must never use os.system.

Produce JSON now.`;

interface Case { name: string; kind: "standard" | "python"; sys: string; user: string; maxTokens: number; webSearch: boolean }

const CASES: Case[] = [
  { name: "standard", kind: "standard", sys: STANDARD_SYS, user: STANDARD_USER, maxTokens: 40000, webSearch: false },
  { name: "python", kind: "python", sys: PY_SYS, user: PY_USER, maxTokens: 6000, webSearch: true },
];

interface Result {
  arm: string; model: string; effort: string; case: string;
  http: number; ms: number; finish: string;
  contentLen: number; reasoningTokens: number; completionTokens: number; promptTokens: number;
  parsed: boolean; traceLen: number;
  summaryLen: number; rawCats: number; rawPass: boolean;
  enrichedLen: number; enrichedPass: boolean;
  costUsd: number;
  err?: string;
  sampleSummary?: string;
}

async function run(arm: Arm, c: Case): Promise<Result> {
  const t0 = Date.now();
  const body: Record<string, unknown> = {
    model: arm.model,
    messages: [{ role: "system", content: c.sys }, { role: "user", content: c.user }],
    max_tokens: c.maxTokens,
    temperature: c.kind === "standard" ? 0.2 : 0.15,
  };
  if (c.webSearch) body.venice_parameters = { enable_web_search: "on" };
  if (arm.effort !== "none") body.reasoning_effort = arm.effort;
  const base: Result = {
    arm: `${arm.model}@${arm.effort}`, model: arm.model, effort: arm.effort, case: c.name,
    http: 0, ms: 0, finish: "?", contentLen: 0, reasoningTokens: 0, completionTokens: 0,
    promptTokens: 0, parsed: false, traceLen: 0, summaryLen: 0, rawCats: 0, rawPass: false,
    enrichedLen: 0, enrichedPass: false, costUsd: 0,
  };
  try {
    const r = await fetch(VENICE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1_000_000),
    });
    base.ms = Date.now() - t0;
    base.http = r.status;
    if (!r.ok) {
      base.err = (await r.text()).slice(0, 160);
      return base;
    }
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
      usage?: Record<string, unknown>;
    };
    const content = j.choices?.[0]?.message?.content ?? "";
    const fr = j.choices?.[0]?.finish_reason ?? "?";
    base.finish = fr;
    base.contentLen = content.length;
    const u = j.usage ?? {};
    base.promptTokens = Number(u.prompt_tokens ?? 0);
    base.completionTokens = Number(u.completion_tokens ?? 0);
    base.reasoningTokens = Number(u.reasoning_tokens ?? 0);
    const p = PRICING[arm.model] ?? { in: 5, out: 20 };
    base.costUsd = (base.promptTokens / 1e6) * p.in + (base.completionTokens / 1e6) * p.out;

    // Parse like the real solvers do: strict JSON first, then the tolerant
    // fallbacks mining.ts uses (fenced-code salvage + field scan for payloads
    // truncated by the token cap — opus-5 truncates python solves often).
    const tryJson = (s: string): Record<string, unknown> | null => {
      try {
        const cleaned = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        const a = cleaned.indexOf("{");
        const b = cleaned.lastIndexOf("}");
        if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
      } catch { /* fall through */ }
      return null;
    };
    const fieldScan = (s: string, key: string): string => {
      const m = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"[A-Za-z_]+"\\s*:|}\\s*$)`).exec(s);
      return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
    };
    const longestFence = (s: string): string => {
      const re = /```(?:python|json|js|javascript)?\n([\s\S]*?)```/g;
      let best = "";
      for (const m of s.matchAll(re)) if (m[1].length > best.length) best = m[1];
      return best;
    };
    let obj = tryJson(content);
    if (!obj) {
      const salvaged: Record<string, unknown> = {};
      for (const k of ["summary", "trace", "solution", "answer", "reasoning"]) {
        const v = fieldScan(content, k);
        if (v) salvaged[k] = v;
      }
      const fence = longestFence(content);
      if (fence && !salvaged.solution) salvaged.solution = fence;
      // Raw-markdown salvage (mirrors mining.ts:salvageMarkdownTrace): models
      // often ignore the JSON wrapper and emit the trace directly.
      if (!salvaged.trace && /^#{1,3}\s/m.test(content)) {
        salvaged.trace = content.trim();
        if (!salvaged.summary) {
          const para = content.split(/\n{2,}/).map((p) => p.replace(/^#.*$/gm, "").trim()).filter((p) => p.length > 40);
          if (para[0]) salvaged.summary = para[0].slice(0, 400);
        }
      }
      if (Object.keys(salvaged).length > 0) obj = salvaged;
    }
    base.parsed = !!obj && typeof obj === "object";
    if (!base.parsed) {
      base.err = `PARSE-FAIL raw[0..200]=${content.slice(0, 200).replace(/\s+/g, " ")}`;
    }

    const summary = typeof obj?.summary === "string" ? (obj.summary as string) : "";
    const trace = typeof obj?.trace === "string" ? (obj.trace as string) : "";
    const solution = typeof obj?.solution === "string" ? (obj.solution as string) : "";
    base.traceLen = trace.length;
    base.summaryLen = summary.length;
    if (summary) {
      base.rawCats = countSpecificity(summary);
      base.rawPass = passesSpecificityGate(summary);
      const enriched = enrichSummarySpecificity(summary, [trace, solution, c.user]);
      base.enrichedLen = enriched.length;
      base.enrichedPass = passesSpecificityGate(enriched);
      base.sampleSummary = summary.slice(0, 200);
    }
    return base;
  } catch (err) {
    base.ms = Date.now() - t0;
    base.err = (err as Error).message.slice(0, 160);
    return base;
  }
}
async function main() {
  const only = process.argv[2]; // optional filter: model id
  const onlyCase = process.argv[3]; // optional filter: case name
  const arms = only ? ARMS.filter((a) => a.model.includes(only)) : ARMS;
  const cases = onlyCase ? CASES.filter((c) => c.name === onlyCase) : CASES;
  const results: Result[] = [];
  console.log(`Probe: ${arms.length} arms × ${cases.length} cases (sequential)\n`);
  for (const c of cases) {
    for (const a of arms) {
      process.stdout.write(`… ${a.model}@${a.effort} [${c.name}] `);
      const r = await run(a, c);
      results.push(r);
      if (r.err) console.log(`[${r.http}] ERR ${r.err}\n`);
      else console.log(`${(r.ms / 1000).toFixed(0)}s parse=${r.parsed ? "✓" : "✗"} spec=${r.rawCats}/6${r.rawPass ? "(pass)" : "(FAIL)"}→enriched:${r.enrichedPass ? "pass" : "FAIL"} $${r.costUsd.toFixed(4)}\n`);
    }
  }
  console.log("\n== Summary ==");
  console.log("model@effort".padEnd(38) + "case".padEnd(10) + "s".padEnd(7) + "fr".padEnd(14) + "parse".padEnd(7) + "trace".padEnd(8) + "sum".padEnd(6) + "spec".padEnd(7) + "enr".padEnd(6) + "$/call".padEnd(10) + "reason_tok");
  for (const r of results) {
    console.log(
      `${r.model}@${r.effort}`.padEnd(38) +
      r.case.padEnd(10) +
      (r.ms / 1000).toFixed(0).padEnd(7) +
      r.finish.padEnd(14) +
      (r.parsed ? "✓" : "✗").padEnd(7) +
      String(r.traceLen).padEnd(8) +
      String(r.summaryLen).padEnd(6) +
      `${r.rawCats}/6`.padEnd(7) +
      (r.enrichedPass ? "pass" : "FAIL").padEnd(6) +
      ("$" + r.costUsd.toFixed(4)).padEnd(10) +
      String(r.reasoningTokens),
    );
  }
  console.log("\n== Raw summaries (first 200 chars) ==");
  for (const r of results) {
    if (r.sampleSummary) console.log(`\n[${r.model}@${r.effort} / ${r.case}]\n  ${r.sampleSummary}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
