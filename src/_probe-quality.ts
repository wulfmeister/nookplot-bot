/**
 * Quality comparison: 3 context configs on the same challenge, same model.
 *
 *   A. Venice web_search ON,  no local context     (lean: just the model + Venice's search)
 *   B. Venice web_search OFF, with local context   (mining-context.ts arxiv+web+vault gather)
 *   C. Venice web_search ON,  with local context   (current mining.ts default — both)
 *
 * For each: log length, citation count (Author Year matches), equation count,
 * specificity-score from our gateway-mirror, latency, finish_reason. Print a
 * side-by-side comparison and write the full traces to /tmp/quality-{a,b,c}.md
 * for manual eyeballing.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { gatherMiningContext } from "./mining-context.js";
import { specificityCategories } from "./mining.js";

const VENICE_URL = "https://api.venice.ai/api/v1/chat/completions";
const KEY = process.env.VENICE_API_KEY!;
const MODEL = "claude-opus-4-8"; // pick one for fair comparison
const EFFORT = "xhigh";
const MAX_TOK = 40000;

// Fixed challenge so all 3 configs see the same input
const CHALLENGE = {
  id: "probe-quality-2026-05-24",
  title: "Prove the asymptotic expansion of harmonic numbers",
  difficulty: "hard",
  domainTags: ["number-theory", "analysis"],
  description:
    "Prove that the harmonic numbers H_n = 1 + 1/2 + ... + 1/n satisfy H_n = ln(n) + γ + 1/(2n) + O(1/n²) where γ ≈ 0.5772 is the Euler-Mascheroni constant. Use Euler-Maclaurin or the digamma asymptotic. Verify with n=10.",
};

const SYS_TEMPLATE = (domainHint: string) =>
  `You are an expert problem-solver producing a long-form reasoning trace.${domainHint ? `\n\nDOMAIN FOCUS: ${domainHint}` : ""}

OUTPUT FORMAT — JSON ONLY:
{
  "summary": "150-280 char description",
  "trace": "Long-form markdown — see structure below"
}

Trace markdown MUST use:
## Approach
## Steps (numbered, with work + sanity checks + dead ends)
## Conclusion
## Uncertainty
## Citations [1] Author Year — title

REQUIREMENTS:
- 800-1500 words
- Concrete numbers, not vague claims
- Cite specific papers by author + year
- Show your work`;

interface RunResult {
  config: "A" | "B" | "C";
  label: string;
  latencyMs: number;
  finishReason: string;
  completionTokens: number;
  contentLen: number;
  hasJsonTrace: boolean;
  traceLen: number;
  citationCount: number;     // "Author YEAR" patterns
  equationCount: number;     // $...$, \\[ \\], $$ \n
  backtickRefCount: number;  // `…` identifiers
  specificityCategories: number; // 0-6
  rawContent: string;
}

function countCitations(text: string): number {
  // Matches "Author 1995", "Lai-Robbins 1985", "de Boor 1978", "Author et al. 2020"
  const re = /\b([A-Z][a-zA-Z'-]+(?:-[A-Z][a-zA-Z'-]+)?|de [A-Z][a-zA-Z]+)(?:\s+et\s+al\.?)?\s+(\d{4})\b/g;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

function countEquations(text: string): number {
  // LaTeX inline $..$, block $$..$$, \\[..\\], and obvious equations with =
  const inline = (text.match(/\$[^\$\n]{3,}\$/g) ?? []).length;
  const block = (text.match(/\$\$[\s\S]{3,}?\$\$/g) ?? []).length;
  const bracket = (text.match(/\\\[[\s\S]{3,}?\\\]/g) ?? []).length;
  return inline + block + bracket;
}

function countBackticks(text: string): number {
  return (text.match(/`[^`\n]{2,40}`/g) ?? []).length;
}

async function runConfig(
  config: "A" | "B" | "C",
  withVeniceSearch: boolean,
  withLocalContext: boolean,
): Promise<RunResult> {
  let contextBlock = "";
  let domainHint = "";
  if (withLocalContext) {
    const ctx = await gatherMiningContext(CHALLENGE);
    contextBlock = ctx.contextBlock;
    domainHint = ctx.domainHint;
  }

  const sys = SYS_TEMPLATE(domainHint);
  const userMsg = `# Challenge: ${CHALLENGE.title}

Difficulty: ${CHALLENGE.difficulty}
Domain: ${CHALLENGE.domainTags.join(", ")}

## Full description
${CHALLENGE.description}${contextBlock ? `\n\n${contextBlock}` : ""}

Produce the JSON now.`;

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: userMsg }],
    max_tokens: MAX_TOK,
    temperature: 0.2,
    reasoning_effort: EFFORT,
  };
  if (withVeniceSearch) body.venice_parameters = { enable_web_search: "on" };

  const t0 = Date.now();
  const r = await fetch(VENICE_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1_000_000),
  });
  const latencyMs = Date.now() - t0;
  if (!r.ok) {
    throw new Error(`${config}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { completion_tokens?: number };
  };
  const content = j.choices?.[0]?.message?.content ?? "";
  const finishReason = j.choices?.[0]?.finish_reason ?? "?";
  const completionTokens = j.usage?.completion_tokens ?? 0;

  // Extract trace from JSON
  let traceText = "";
  let hasJsonTrace = false;
  try {
    const match = content.match(/\{[\s\S]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.trace === "string") {
        traceText = parsed.trace;
        hasJsonTrace = true;
      }
    }
  } catch {
    // fallback: count from raw content
    traceText = content;
  }

  const cats = Object.values(specificityCategories(traceText)).filter(Boolean).length;

  return {
    config,
    label:
      `web=${withVeniceSearch ? "ON" : "OFF"} ctx=${withLocalContext ? "ON" : "OFF"}`,
    latencyMs,
    finishReason,
    completionTokens,
    contentLen: content.length,
    hasJsonTrace,
    traceLen: traceText.length,
    citationCount: countCitations(traceText),
    equationCount: countEquations(traceText),
    backtickRefCount: countBackticks(traceText),
    specificityCategories: cats,
    rawContent: content,
  };
}

async function main() {
  console.log(`Quality comparison — model=${MODEL} effort=${EFFORT} maxTok=${MAX_TOK}`);
  console.log(`Challenge: ${CHALLENGE.title}\n`);

  // Run all 3 in parallel — independent calls
  const [a, b, c] = await Promise.all([
    runConfig("A", true, false).catch((e) => { console.error("A failed:", e.message); throw e; }),
    runConfig("B", false, true).catch((e) => { console.error("B failed:", e.message); throw e; }),
    runConfig("C", true, true).catch((e) => { console.error("C failed:", e.message); throw e; }),
  ]);

  const rows = [a, b, c];

  // Comparison table
  console.log("\n" + "=".repeat(90));
  console.log("metric".padEnd(28) + "A (web only)".padStart(18) + "B (local only)".padStart(20) + "C (both)".padStart(20));
  console.log("=".repeat(90));
  const fields: Array<[string, (r: RunResult) => string | number]> = [
    ["latency (s)", (r) => (r.latencyMs / 1000).toFixed(1)],
    ["finish_reason", (r) => r.finishReason],
    ["completion tokens", (r) => r.completionTokens],
    ["content chars", (r) => r.contentLen],
    ["valid JSON trace?", (r) => r.hasJsonTrace ? "✓" : "✗"],
    ["trace chars", (r) => r.traceLen],
    ["citations (Author Year)", (r) => r.citationCount],
    ["equations ($…$, \\[…\\])", (r) => r.equationCount],
    ["`backticked` refs", (r) => r.backtickRefCount],
    ["specificity categories /6", (r) => r.specificityCategories],
  ];
  for (const [name, fn] of fields) {
    console.log(
      name.padEnd(28) +
      String(fn(a)).padStart(18) +
      String(fn(b)).padStart(20) +
      String(fn(c)).padStart(20),
    );
  }

  // Write traces to /tmp for manual inspection
  for (const r of rows) {
    writeFileSync(`/tmp/quality-${r.config.toLowerCase()}.md`, r.rawContent);
  }
  console.log("\nFull traces written to /tmp/quality-{a,b,c}.md for manual diff.\n");

  // Verdict heuristic
  console.log("=== Heuristic verdict ===");
  const scoreOf = (r: RunResult) =>
    r.citationCount * 3 + r.equationCount * 2 + r.backtickRefCount + r.specificityCategories * 2 + (r.hasJsonTrace ? 5 : 0);
  const ranked = [...rows].sort((x, y) => scoreOf(y) - scoreOf(x));
  for (const r of ranked) {
    console.log(`  ${r.config}: score=${scoreOf(r)}  cit=${r.citationCount} eqn=${r.equationCount} bt=${r.backtickRefCount} cat=${r.specificityCategories}`);
  }
  const winner = ranked[0];
  const loser = ranked[ranked.length - 1];
  console.log(`\nWinner: ${winner.config} (${winner.label}). Lowest: ${loser.config}.`);
  console.log(`Verdict: keep current default (C — both ON) if it ranks ≥ #2, otherwise switch to ${winner.config}.`);
}

main().catch((err) => { console.error("✗", err); process.exit(1); });
