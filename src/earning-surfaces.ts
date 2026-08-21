/**
 * Earning-surfaces watcher — accurate liveness detection for Nookplot earning
 * tracks that ship in the 0.5.145 action catalog but are NOT yet deployed on the
 * gateway. Supersedes forge-watch.ts, which guessed REST paths (e.g.
 * `/v1/mining/aggregation-challenges`) and so couldn't tell "wrong path" from
 * "not deployed". This probes via the REAL MCP dispatch (runtime.tools.executeTool,
 * which runs the SDK's bundled handler against the correct gateway path), so a
 * 🟢 here means the surface is actually callable and ready to earn from.
 *
 * Verified dormant on 2026-06-20 (gateway → "Endpoint does not exist"):
 *   - P2.1 Tier-3 aggregation mining: list_aggregation_challenges / submit_aggregation
 *           (miner 50% + source 25% + verifiers 15%; poster earns 10% of access fees)
 *   - P2.2 Tier-1 embedding mining:   list_embedding_challenges / submit_embeddings
 *           (also needs a local nomic-embed-text-v1.5 model via Ollama — not installed)
 *   - P2.3 API-marketplace selling:   api_onboard / api_listings / remediation_*
 *           (the buy-side apiMarketplace.searchAvailable stub IS up, but there is
 *            no way to create a listing or earn yet)
 *
 * When a surface flips dormant→live the watcher logs LOUDLY and appends an event
 * so the matching solver can be dropped in immediately. Each solver is small: the
 * SDK already bundles the client handlers, so it's executeTool() + the custom
 * compute (LLM synthesis for aggregation, local embeddings for Tier-1).
 *
 * Wired as a low-frequency daemon tick (these flip only on gateway deploys) and
 * runnable on demand: `npm run surfaces`.
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { getRuntime } from "./runtime.js";
import { NOOK_DIR, appendJsonl } from "./util.js";

const STATE_FILE = join(NOOK_DIR, "earning-surfaces.json");
const EVENTS_FILE = join(NOOK_DIR, "earning-surfaces.jsonl");

interface Surface {
  key: string;
  label: string;
  /** Catalog action used as the liveness probe (a cheap list/read). */
  action: string;
  args: Record<string, unknown>;
  /** Human note on what's needed beyond the gateway endpoint. */
  prereq?: string;
  /** What to build the moment it flips live. */
  onLive: string;
}

const SURFACES: Surface[] = [
  // aggregation_mining and embedding_mining probes RETIRED 2026-08-20: the
  // actions were REMOVED from the SDK in @nookplot/runtime 0.5.156 (verified
  // by tarball diff 0.5.145→0.5.162) — they are dead, not dormant, and the
  // probe could only ever report "dormant" forever. Solver modules kept.
  {
    key: "api_marketplace_sell",
    label: "P2.3 API-marketplace selling + remediation",
    action: "api_listings",
    args: { limit: 1 },
    onLive:
      "solver READY (src/api-marketplace-sell.ts) — set BOT_API_ONBOARD_AUTO=1 + BOT_API_LISTING_{TITLE,DESC,URL} to list a metered API",
  },
];

interface ProbeOutcome {
  live: boolean;
  detail: string;
}

/**
 * Classify a probe result. The gateway distinguishes "not deployed" from "exists
 * but you called it wrong" — only the former means dormant. "Unknown tool" /
 * "Endpoint does not exist" / 404 → dormant; a validation/auth rejection means
 * the endpoint is live (it got far enough to reject our args).
 */
function classifyError(err: unknown): ProbeOutcome {
  const msg = ((err as Error)?.message ?? String(err)).replace(/\s+/g, " ");
  if (/Endpoint does not exist|Unknown tool|Not found|\b404\b/i.test(msg)) {
    return { live: false, detail: "not deployed" };
  }
  if (/Invalid arguments|\b(400|401|403|409|422|429)\b/i.test(msg)) {
    return { live: true, detail: `live (rejected probe: ${msg.slice(0, 70)})` };
  }
  return { live: false, detail: msg.slice(0, 90) };
}

async function probe(runtime: Pick<NookplotRuntime, "tools">, s: Surface): Promise<ProbeOutcome> {
  try {
    const res = await runtime.tools.executeTool(s.action, s.args);
    const out = (res?.output ?? {}) as Record<string, unknown>;
    let count = "";
    for (const [k, v] of Object.entries(out)) {
      if (Array.isArray(v)) {
        count = ` ${k}=${v.length}`;
        break;
      }
    }
    return { live: true, detail: `live${count}` };
  } catch (err) {
    return classifyError(err);
  }
}

function readState(): Record<string, { live: boolean; since: string }> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state: Record<string, { live: boolean; since: string }>): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export interface SurfaceReport {
  key: string;
  label: string;
  live: boolean;
  detail: string;
  flippedLive: boolean;
}

/**
 * Probe every pending earning surface, persist state, and shout when one flips
 * dormant→live. Cheap (a few list calls); these flip only on gateway deploys.
 */
export async function runEarningSurfacesTick(runtime: NookplotRuntime): Promise<SurfaceReport[]> {
  const prev = readState();
  const now = new Date().toISOString();
  const reports: SurfaceReport[] = [];

  for (const s of SURFACES) {
    const outcome = await probe(runtime, s);
    const was = prev[s.key]?.live ?? false;
    const flippedLive = outcome.live && !was;
    reports.push({ key: s.key, label: s.label, live: outcome.live, detail: outcome.detail, flippedLive });

    if (flippedLive) {
      const banner = `🟢🟢 EARNING SURFACE LIVE: ${s.label} — ${outcome.detail}. NEXT: ${s.onLive}` +
        (s.prereq ? ` [prereq: ${s.prereq}]` : "");
      console.log("\n" + banner + "\n");
      appendJsonl(EVENTS_FILE, { ts: now, event: "flipped_live", key: s.key, label: s.label, onLive: s.onLive });
    }
    // Persist only a flip's first-seen timestamp; keep an existing `since`.
    prev[s.key] = { live: outcome.live, since: was === outcome.live && prev[s.key]?.since ? prev[s.key].since : now };
  }

  writeState(prev);
  return reports;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  const runtime = getRuntime();
  console.log(`Earning-surfaces watch (via MCP dispatch) — ${new Date().toISOString()}\n`);
  const reports = await runEarningSurfacesTick(runtime);
  for (const r of reports) {
    const icon = r.live ? "🟢" : "🔴";
    console.log(`  ${icon} ${r.label.padEnd(44)} ${r.detail}`);
  }
  const liveCount = reports.filter((r) => r.live).length;
  console.log(
    `\n${liveCount}/${reports.length} live. Dormant surfaces are blocked gateway-side; ` +
      `this watcher auto-alerts (and logs to ${EVENTS_FILE}) the moment any ships.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
