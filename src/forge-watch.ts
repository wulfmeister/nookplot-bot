/**
 * Probe the gateway for forge/aggregation endpoints that aren't deployed yet.
 *
 * Run: `npm run forge:watch`
 *
 * When any of these flip from 404 → 200, the aggregation-mining track becomes
 * unlocked. At that point we can build out src/aggregation.ts:
 *   - GET /v1/mining/aggregation-challenges  — list open challenges
 *   - GET /v1/mining/aggregation-challenges/:id — fetch detail + input traces
 *   - POST /v1/forge/data/fetch — pay NOOK to pull raw traces by domain
 *   - POST /v1/mining/aggregation-challenges/:id/submit — submit synthesis
 *
 * Tier 3 gives 35% off forge costs; combined with 1.4-1.75x mining rewards,
 * the aggregation track has the best NOOK/hr economics once live.
 */
import "dotenv/config";

const GATEWAY = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
const API_KEY = process.env.NOOKPLOT_API_KEY;

if (!API_KEY) {
  throw new Error("NOOKPLOT_API_KEY missing");
}

const PATHS: Array<{ method: "GET" | "POST"; path: string; sample?: Record<string, unknown> }> = [
  { method: "GET", path: "/v1/mining/aggregation-challenges?status=open&limit=1" },
  { method: "GET", path: "/v1/mining/aggregates?limit=1" },
  { method: "GET", path: "/v1/mining/embedding-challenges?status=open&limit=1" },
  { method: "POST", path: "/v1/forge/data/fetch", sample: { presetId: "ping", maxTraces: 1 } },
];

async function probe(p: typeof PATHS[number]): Promise<{ path: string; method: string; code: number; note: string }> {
  const init: RequestInit = {
    method: p.method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  };
  if (p.method === "POST") init.body = JSON.stringify(p.sample ?? {});
  try {
    const res = await fetch(`${GATEWAY}${p.path}`, init);
    let note = "";
    if (res.status === 404) note = "not deployed";
    else if (res.status === 200) note = "✓ live!";
    else if (res.status === 401 || res.status === 403) note = "auth";
    else if (res.status === 400 || res.status === 422) note = "live (validation rejected our ping)";
    else note = `unexpected ${res.status}`;
    return { path: p.path, method: p.method, code: res.status, note };
  } catch (err) {
    return { path: p.path, method: p.method, code: 0, note: `network: ${(err as Error).message}` };
  }
}

async function main() {
  console.log(`Forge / aggregation endpoint watch — ${new Date().toISOString()}\n`);
  let anyLive = false;
  for (const p of PATHS) {
    const r = await probe(p);
    const status = r.note.includes("live") ? "🟢" : r.code === 404 ? "🔴" : "🟡";
    console.log(`  ${status} ${r.method.padEnd(4)} ${r.path.padEnd(60)} → ${r.code}  ${r.note}`);
    if (r.note.includes("live")) anyLive = true;
  }
  console.log("");
  if (anyLive) {
    console.log("⚡ At least one aggregation/forge endpoint is LIVE.");
    console.log("   Next step: build src/aggregation.ts following the pattern in src/mining.ts.");
    console.log("   See AGENTS.md § 'Future plans (parked)' for the implementation sketch.");
  } else {
    console.log("Nothing new. Re-run periodically — when the gateway ships these,");
    console.log("aggregation mining becomes our best Tier-3 utilization path.");
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
