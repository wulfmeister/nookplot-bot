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

const DEFAULT_FALLBACK_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
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
export async function fetchTraceViaPublicGateways(
  cid: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  for (const base of fallbackGateways()) {
    try {
      const r = await fetch(`${base}${encodeURIComponent(cid)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) continue;
      const text = traceTextFromGatewayBody(await r.text());
      if (text && text.trim().length > 0) return text;
    } catch {
      /* timeout / network error — try the next gateway */
    }
  }
  return null;
}
