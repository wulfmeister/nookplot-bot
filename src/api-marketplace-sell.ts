/**
 * API-marketplace selling + remediation (P2.3). Lets the bot EARN USDC by
 * listing a metered API other agents pay to call (the gateway meters + proxies
 * each call; the upstream creds stay encrypted), and by reporting/taking over
 * down project-linked listings (the remediation ladder).
 *
 * The bot already serves a public surface (dashboard-web on WEB_PORT, optionally
 * exposed via the auto-spawned tunnel) — that's the proxyUrl an onboarded listing
 * points at.
 *
 * Gates, all automatic/safe:
 *   1. Liveness — api_listings probe; while the gateway returns "Unknown tool"
 *      (the marketplace MCP actions aren't deployed yet) this is a logged no-op.
 *      `npm run surfaces` watches for go-live.
 *   2. Opt-in + config — onboarding is an on-chain spend, so it only runs when
 *      BOT_API_ONBOARD_AUTO=1 AND the listing fields below are set. Idempotent:
 *      the minted listingId is cached and never re-onboarded.
 *
 * Required env to onboard:
 *   BOT_API_LISTING_TITLE, BOT_API_LISTING_DESC, BOT_API_LISTING_URL (public https proxyUrl)
 * Optional: BOT_API_SUBCATEGORY (default "data"), BOT_API_PRICING_MODEL (default
 *   "per-request"), BOT_API_PRICE (default "0.001"), BOT_API_HEALTHCHECK_PATH.
 *
 * Action contracts (0.5.145 catalog):
 *   api_listings          { listingId?, limit? }
 *   api_onboard           { title, description, apiSubCategory, proxyUrl, pricingModel, priceAmount, ... }
 *   api_endpoint          { action: "register"|"unregister"|"heartbeat", listingId, proxyUrl?, ... }
 *   report_endpoint_status{ listingId, reason, details? }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "tools">;

const LISTING_STATE = join(NOOK_DIR, "api-listing.json");
const SELL_LOG = join(NOOK_DIR, "api-marketplace.jsonl");
const HEARTBEAT_MS = 60_000; // api_endpoint heartbeat wants ~1/min

let heartbeatTimer: NodeJS.Timeout | null = null;

function isDormant(err: unknown): boolean {
  const m = (err as Error)?.message ?? String(err);
  return /Endpoint does not exist|Unknown tool|Not found|\b404\b/i.test(m);
}

function readListing(): { listingId?: number } {
  if (!existsSync(LISTING_STATE)) return {};
  try {
    return JSON.parse(readFileSync(LISTING_STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeListing(v: { listingId: number }): void {
  mkdirSync(dirname(LISTING_STATE), { recursive: true });
  writeFileSync(LISTING_STATE, JSON.stringify(v, null, 2));
}

interface ListingConfig {
  title: string;
  description: string;
  apiSubCategory: string;
  proxyUrl: string;
  pricingModel: string;
  priceAmount: string;
  healthCheckPath?: string;
}

function listingConfigFromEnv(): ListingConfig | null {
  const title = process.env.BOT_API_LISTING_TITLE;
  const description = process.env.BOT_API_LISTING_DESC;
  const proxyUrl = process.env.BOT_API_LISTING_URL;
  if (!title || !description || !proxyUrl) return null;
  return {
    title,
    description,
    proxyUrl,
    apiSubCategory: process.env.BOT_API_SUBCATEGORY ?? "data",
    pricingModel: process.env.BOT_API_PRICING_MODEL ?? "per-request",
    // priceAmount is a decimal string in the listing's quote token (USDC unless
    // BOT_API_ACCEPTED_TOKENS says otherwise) — i.e. "0.001" = $0.001/request.
    // The default is a conservative placeholder; set BOT_API_PRICE deliberately
    // before enabling onboarding so you don't list at an unintended price.
    priceAmount: process.env.BOT_API_PRICE ?? "0.001",
    healthCheckPath: process.env.BOT_API_HEALTHCHECK_PATH,
  };
}

function startHeartbeat(runtime: RuntimeLike, listingId: number): void {
  if (heartbeatTimer) return;
  const ping = async () => {
    try {
      await runtime.tools.executeTool("api_endpoint", { action: "heartbeat", listingId });
    } catch (err) {
      console.warn(`🛰 api heartbeat failed: ${(err as Error).message.slice(0, 100)}`);
    }
  };
  void ping();
  heartbeatTimer = setInterval(() => void ping(), HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

/** Onboard the configured listing once, register its proxy endpoint, and begin heartbeating. */
async function onboardOnce(runtime: RuntimeLike, cfg: ListingConfig): Promise<void> {
  const onboardRes = await runtime.tools.executeTool("api_onboard", {
    title: cfg.title,
    description: cfg.description,
    apiSubCategory: cfg.apiSubCategory,
    proxyUrl: cfg.proxyUrl,
    pricingModel: cfg.pricingModel,
    priceAmount: cfg.priceAmount,
  });
  const out = (onboardRes?.output ?? {}) as { listingId?: number; id?: number };
  const listingId = out.listingId ?? out.id;
  if (typeof listingId !== "number") {
    throw new Error(`onboard returned no listingId: ${JSON.stringify(out).slice(0, 120)}`);
  }
  writeListing({ listingId });
  appendJsonl(SELL_LOG, { ts: new Date().toISOString(), event: "onboarded", listingId, proxyUrl: cfg.proxyUrl });
  console.log(`🛰 ✓ onboarded API listing #${listingId} → ${cfg.proxyUrl}`);

  // Register the proxy config (no upstream creds shared by default).
  await runtime.tools
    .executeTool("api_endpoint", {
      action: "register",
      listingId,
      proxyUrl: cfg.proxyUrl,
      ...(cfg.healthCheckPath ? { healthCheckPath: cfg.healthCheckPath } : {}),
    })
    .catch((e) => console.warn(`🛰 endpoint register warn: ${(e as Error).message.slice(0, 100)}`));

  startHeartbeat(runtime, listingId);
}

/**
 * Marketplace tick. No-op (logged) while the marketplace MCP actions are dormant
 * or onboarding isn't enabled/configured. When live + an existing listing is
 * cached, just keeps the heartbeat running.
 */
export async function runApiMarketplaceTick(runtime: RuntimeLike): Promise<void> {
  // Liveness probe via a harmless read.
  try {
    await runtime.tools.executeTool("api_listings", { limit: 1 });
  } catch (err) {
    if (isDormant(err)) return; // marketplace actions not deployed yet
    console.warn(`🛰 api_listings probe failed: ${(err as Error).message.slice(0, 100)}`);
    return;
  }

  const existing = readListing();
  if (typeof existing.listingId === "number") {
    startHeartbeat(runtime, existing.listingId); // resume heartbeat after a restart
    return;
  }

  if (process.env.BOT_API_ONBOARD_AUTO !== "1") return;
  const cfg = listingConfigFromEnv();
  if (!cfg) {
    console.log("🛰 api onboarding enabled but BOT_API_LISTING_{TITLE,DESC,URL} not set — skipping");
    return;
  }
  try {
    await onboardOnce(runtime, cfg);
  } catch (err) {
    console.warn(`🛰 api onboard failed: ${(err as Error).message.slice(0, 140)}`);
    appendJsonl(SELL_LOG, { ts: new Date().toISOString(), event: "onboard_error", notes: (err as Error).message.slice(0, 160) });
  }
}

/** Report a project-linked listing you depend on as unhealthy (remediation ladder entry). */
export async function reportEndpointDown(runtime: RuntimeLike, listingId: number, reason: string, details?: string): Promise<void> {
  await runtime.tools.executeTool("report_endpoint_status", { listingId, reason, ...(details ? { details } : {}) });
  appendJsonl(SELL_LOG, { ts: new Date().toISOString(), event: "reported_down", listingId, reason });
}
