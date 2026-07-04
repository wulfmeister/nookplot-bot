/**
 * Venice smoke test — probes the response shape for web search + citations.
 *
 * Documents the actual fields returned so callers in src/index.ts, src/mining.ts,
 * src/knowledge-sources.ts can plumb them correctly.
 *
 * Run: npm run venice-smoke
 */
import { chat } from "./venice.js";

async function basic() {
  console.log("─".repeat(60));
  console.log("1. Basic chat (no web search) — sanity check\n");
  const result = await chat(
    [
      { role: "system", content: "You are a concise research assistant." },
      { role: "user", content: "In one sentence: what is your model name?" },
    ],
    { max_tokens: 100, venice_parameters: { enable_web_search: "off" } },
  );
  console.log(`  model: ${result.model}`);
  console.log(`  content: ${result.content.slice(0, 200)}`);
  console.log(`  usage keys: ${Object.keys(result.usage ?? {}).join(", ") || "(none)"}\n`);
}

async function withWebSearch() {
  console.log("─".repeat(60));
  console.log("2. Web search enabled (auto) — probe response shape\n");
  // Send a date-sensitive question so the model is forced to search
  const result = (await chat(
    [
      { role: "system", content: "Cite specific URLs when answering." },
      { role: "user", content: "What is the current price of NOOK token on Base mainnet right now? Cite the source." },
    ],
    {
      max_tokens: 400,
      venice_parameters: {
        enable_web_search: "auto",
        enable_web_citations: true,
        include_search_results_in_stream: true,
      },
    },
  )) as Record<string, unknown>;

  console.log(`  model: ${result.model}`);
  console.log(`  content (first 400):\n    ${String(result.content).slice(0, 400).replace(/\n/g, "\n    ")}`);
  console.log(`\n  TOP-LEVEL FIELDS in result:`);
  for (const k of Object.keys(result)) {
    const v = result[k];
    const t = Array.isArray(v) ? `Array(${v.length})` : typeof v;
    console.log(`    ${k}: ${t}`);
  }
  // Look for citations specifically
  for (const candidate of ["citations", "web_search_results", "search_results", "sources", "tool_calls"]) {
    if (candidate in result) {
      console.log(`\n  ✓ "${candidate}" exists. Sample:`);
      const v = result[candidate];
      console.log(`    ${JSON.stringify(v).slice(0, 600)}`);
    }
  }
  // Sometimes citations are embedded in content as markdown links — check
  const linkCount = (String(result.content).match(/\[([^\]]+)\]\(([^)]+)\)/g) ?? []).length;
  console.log(`\n  Markdown links in content: ${linkCount}`);
}

async function withForcedSearch() {
  console.log("─".repeat(60));
  console.log("3. Web search on=force — confirm `on` works distinctly\n");
  const result = (await chat(
    [
      { role: "user", content: "What is the latest version of Node.js, with source URL?" },
    ],
    {
      max_tokens: 300,
      venice_parameters: {
        enable_web_search: "on",
        enable_web_citations: true,
      },
    },
  )) as Record<string, unknown>;
  console.log(`  model: ${result.model}`);
  console.log(`  content (first 300):\n    ${String(result.content).slice(0, 300).replace(/\n/g, "\n    ")}\n`);
  console.log(`  All response keys: ${Object.keys(result).join(", ")}\n`);
}

async function main() {
  await basic();
  try {
    await withWebSearch();
  } catch (err) {
    console.error(`  ✗ withWebSearch failed: ${(err as Error).message}\n`);
  }
  try {
    await withForcedSearch();
  } catch (err) {
    console.error(`  ✗ withForcedSearch failed: ${(err as Error).message}\n`);
  }
  console.log("─".repeat(60));
  console.log("\nNext: document the discovered shape in AGENTS.md and plumb the");
  console.log("right field into call sites. If citations are inline markdown links,");
  console.log("just extract them. If a top-level citations array exists, parse it.");
}

main().catch((err) => {
  console.error("✗ venice smoke failed:", err);
  process.exit(1);
});
