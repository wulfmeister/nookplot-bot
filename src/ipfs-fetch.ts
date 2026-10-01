/**
 * Public IPFS gateway fallback for trace fetches.
 *
 * Why: the verify loop reads each submission's full reasoning trace from the
 * Nookplot gateway (`GET /v1/ipfs/<cid>`). When that endpoint 502s — which it
 * does in storms — the verify attempt no-ops and we leave daily verify slots
 * unused even though the slack-threshold is already free-firing on v0s. The
 * trace CID is a standard IPFS CID, so a public gateway can serve the exact
 * same content. `rlm-spotcheck.ts` already does gateway→ipfs.io for prompts;
 * this generalizes that for the verify path.
 *
 * Only call this on a TRANSIENT gateway failure (502/timeout/empty). A
 * permanent "Invalid CID format" means the hash is bad and won't resolve on a
 * public gateway either — and we don't want to push our spam-CID load onto
 * ipfs.io.
 */
import { traceTextFromIpfsPayload } from "./trace-payload.js";

// 2026-10-01: Pinata only. ipfs.io and dweb.link recovered 1,000+ traces from
// ~07-28 to ~08-24 ("↩ trace CID recovered via public IPFS gateway"), dropped
// off ~08-27, and have recovered none since ~09-19; both now answer 429 "This
// IPFS gateway is switching to a service worker gateway only" to every request.
// gateway.pinata.cloud served our genuine CIDs and pool CIDs the Nookplot
// gateway 502s (n=5, 4-7s) but serves a Cloudflare challenge (429,
// cf-mitigated) under burst traffic — provisional; judge it from the bot's own
// log. The Nookplot gateway's /v1/ipfs route 502s even for genuine CIDs (since
// ~2026-08-25), so this fallback is the verify lane's main read path.
// Override with BOT_IPFS_FALLBACK_GATEWAYS.
const DEFAULT_FALLBACK_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
];

/** Ordered list of public gateway bases to try. Override via BOT_IPFS_FALLBACK_GATEWAYS (comma-separated). */
export function fallbackGateways(): string[] {
  const env = process.env.BOT_IPFS_FALLBACK_GATEWAYS;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_FALLBACK_GATEWAYS;
}

/**
 * Parse a public-gateway response body into trace text. A public gateway always
 * returns a raw string; if that string is actually a JSON wrapper
 * (`{content|text|body|...}`) — the shape our own gateway sometimes pins — dig
 * into it via {@link traceTextFromIpfsPayload}; otherwise treat the body as the
 * raw markdown trace. Pure — testable.
 */
export function traceTextFromGatewayBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  // An HTML document is a gateway error/interstitial page, never a trace
  // (traces are markdown or a JSON wrapper). This is the ONLY path where an
  // HTTP body can become "trace" text without JSON.parse vetting it — letting
  // an error page through would record it into the near-dupe cache and abstain
  // every subsequent error page against it.
  if (/^<(?:!doctype|html|head|body)\b/i.test(trimmed)) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const dug = traceTextFromIpfsPayload(JSON.parse(trimmed));
      if (dug && dug.trim().length > 0) return dug;
    } catch {
      /* not JSON after all — fall through to raw body */
    }
  }
  return trimmed;
}

/**
 * Fetch a trace from public IPFS gateways, in order, as a fallback for a 502ing
 * Nookplot gateway. Returns the first non-empty trace, or null if all fail.
 * Never throws.
 */
/** A gateway that rate-limits us (429 / Cloudflare challenge) is skipped for
 *  this long — hammering a challenged gateway extends the block, and every
 *  skipped fetch would otherwise cost the caller a full timeout. */
export const PUBLIC_GW_BLOCK_MS = 20 * 60_000;
const blockedUntil = new Map<string, number>();

/** True when every configured public gateway is inside a rate-limit block —
 *  the verify lane then re-defers WITHOUT a fetch strike (a block is ours,
 *  not evidence the CID is dead). */
export function publicGatewaysAllBlocked(nowMs = Date.now()): boolean {
  const gws = fallbackGateways();
  return gws.length > 0 && gws.every((g) => (blockedUntil.get(g) ?? 0) > nowMs);
}

/** Test hook. */
export function _resetGatewayBlocksForTests(): void {
  blockedUntil.clear();
}

export async function fetchTraceViaPublicGateways(
  cid: string,
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  for (const base of fallbackGateways()) {
    if ((blockedUntil.get(base) ?? 0) > Date.now()) continue;
    try {
      const r = await fetchImpl(`${base}${encodeURIComponent(cid)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429 || r.headers?.get?.("cf-mitigated")) {
        blockedUntil.set(base, Date.now() + PUBLIC_GW_BLOCK_MS);
        console.warn(`   ⏸ public IPFS gateway ${new URL(base).host} rate-limited us (HTTP ${r.status}) — skipping it for ${PUBLIC_GW_BLOCK_MS / 60_000} min`);
        continue;
      }
      if (!r.ok) continue;
      const text = traceTextFromGatewayBody(await r.text());
      if (text && text.trim().length > 0) return text;
    } catch {
      /* timeout / network error — try the next gateway */
    }
  }
  return null;
}
