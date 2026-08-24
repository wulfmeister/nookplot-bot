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
 * Direct-GET opportunity watches (added 2026-08-20 after the RLM/improvement
 * recon): surfaces whose ECONOMICS are right but whose SUPPLY is currently
 * zero — the flip we're watching for is supply appearing, not an endpoint
 * deploying. (a) improvement requests: escrow-funded, genuinely bypass the
 * collapsed pro-rata R; endpoints live, zero sponsors. (b) RLM solve track:
 * NO-GO verdict on the stale May stock (settled payouts read 0 through
 * pro-rata R) — fresh rows or any buyer-escrowed distillation_request row
 * reopen the question and warrant re-recon BEFORE any spend.
 */
interface GetWatch {
  key: string;
  label: string;
  path: string;
  isLive: (body: unknown) => ProbeOutcome;
  onLive: string;
  prereq?: string;
}

/** First array-valued field in a response body, tolerant of key naming. */
function firstRows(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function classifyAnyRows(body: unknown): ProbeOutcome {
  const rows = firstRows(body);
  return rows.length > 0
    ? { live: true, detail: `live rows=${rows.length}` }
    : { live: false, detail: "no rows" };
}

/** Fresh RLM stock: any row created inside the window (the stale May stock is
 *  value-exhausted; only NEW rows change the NO-GO verdict). */
export function classifyFreshRlm(body: unknown, nowMs: number, windowDays = 14): ProbeOutcome {
  const rows = firstRows(body) as Array<{ createdAt?: string; sourceType?: string }>;
  const cutoff = nowMs - windowDays * 86_400_000;
  const fresh = rows.filter((r) => {
    const t = r.createdAt ? Date.parse(r.createdAt) : NaN;
    return Number.isFinite(t) && t > cutoff;
  });
  if (fresh.length > 0) return { live: true, detail: `live fresh=${fresh.length}/${rows.length} (≤${windowDays}d)` };
  return { live: false, detail: `stale stock only (${rows.length} rows)` };
}

/** Marketplace DEMAND (distinct from the listing-count probe): live the
 *  moment ANY listing has a paying agreement — the marketplace's first-ever
 *  real transaction, and the signal the operator wants before we list. */
export function classifyMarketplaceDemand(body: unknown): ProbeOutcome {
  const rows = firstRows(body) as Array<{ active_agreements?: number; listing_id?: string }>;
  const withBuyers = rows.filter((r) => (r.active_agreements ?? 0) > 0);
  if (withBuyers.length > 0) {
    return {
      live: true,
      detail: `live BUYERS EXIST: ${withBuyers.map((r) => `listing ${r.listing_id}=${r.active_agreements}`).join(", ")}`,
    };
  }
  return { live: false, detail: `${rows.length} listing(s), 0 agreements` };
}

const GET_WATCHES: GetWatch[] = [
  {
    key: "marketplace_demand",
    label: "API-marketplace DEMAND (any paying agreement)",
    path: "/v1/api/availability?limit=20",
    isLive: classifyMarketplaceDemand,
    onLive:
      "first real marketplace transaction ever — re-read docs/api-marketplace.md and memory api-marketplace-watch; operator decision 08-24 was list-on-demand-signal (needs public HTTPS tunnel + the undocumented activation step)",
  },
  {
    key: "x402_rail",
    label: "x402 per-call payment rail (preview → live)",
    path: "/v1/api-x402/5644/health",
    isLive: classifyAnyRows, // success body = open access; the real live signal is a 402/405 via classifyError
    onLive:
      "x402 rail shipped (was 404-by-design) — accountless per-call USDC purchases become possible; buyers can finally price via the 402 challenge; re-evaluate listing per docs/api-marketplace.md",
  },
  {
    key: "improvement_requests",
    label: "Project-improvement escrows (bypass pro-rata R)",
    path: "/v1/improvement/requests?status=open&limit=5",
    isLive: classifyAnyRows,
    onLive:
      "check slot status FIRST (first-verified-fill-wins — later fills earn 0) and the inferenceFilter (fail-closed: filtered → route receipted calls through POST /v1/inference/chat with challengeId BEFORE submit); repo_tests dry-run (20/hr) to de-risk",
  },
  {
    key: "rlm_fresh_stock",
    label: "RLM fresh stock (NO-GO 08-20 on stale rows)",
    path: "/v1/mining/rlm-challenges?limit=100",
    isLive: (b) => classifyFreshRlm(b, Date.now()),
    onLive:
      "RLM settled payouts on the May stock read 0 NOOK (pro-rata R, value-exhausted) — fresh rows reopen the EV question; RE-RUN the recon before any spend (session costs are server-side and unguarded)",
  },
  {
    key: "distillation_requests",
    label: "Buyer-escrowed distillation_request rows",
    path: "/v1/mining/challenges?status=open&sourceType=distillation_request&limit=5",
    isLive: classifyAnyRows,
    onLive: "the only buyer-funded RLM variant (escrow, not emission pool) — economics untested because none have ever existed; recon before spend",
  },
];

async function probeGet(runtime: NookplotRuntime, w: GetWatch): Promise<ProbeOutcome> {
  try {
    const body = await (runtime as unknown as { connection: { request: (m: string, p: string) => Promise<unknown> } })
      .connection.request("GET", w.path);
    return w.isLive(body);
  } catch (err) {
    return classifyError(err);
  }
}

/**
 * Classify a probe result. The gateway distinguishes "not deployed" from "exists
 * but you called it wrong" — only the former means dormant. "Unknown tool" /
 * "Endpoint does not exist" / 404 → dormant; a validation/auth rejection means
 * the endpoint is live (it got far enough to reject our args).
 */
export function classifyError(err: unknown): ProbeOutcome {
  const msg = ((err as Error)?.message ?? String(err)).replace(/\s+/g, " ");
  if (/Endpoint does not exist|Unknown tool|Not found|\b404\b/i.test(msg)) {
    return { live: false, detail: "not deployed" };
  }
  // 402 = payment challenge (the x402 rail's LIVE signal), 405 = route exists
  // but wrong method — both mean the endpoint is deployed and answering.
  if (/Invalid arguments|\b(400|401|402|403|405|409|422|429)\b/i.test(msg)) {
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

  const probes: Array<{ s: Surface | GetWatch; run: () => Promise<ProbeOutcome> }> = [
    ...SURFACES.map((s) => ({ s, run: () => probe(runtime, s) })),
    ...GET_WATCHES.map((s) => ({ s, run: () => probeGet(runtime, s) })),
  ];
  for (const { s, run } of probes) {
    const outcome = await run();
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
