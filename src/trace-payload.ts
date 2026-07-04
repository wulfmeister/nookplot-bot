/**
 * Defensive extraction of the trace markdown body from an IPFS payload.
 *
 * History: the gateway used to return a raw markdown string, then started
 * returning an object with the body under `content` / `traceMarkdown` / etc.,
 * then briefly returned `{content: {text: "..."}}` (a nested wrapping that
 * mirrors workspace-content shape). Older code did `payload.content.trim()`
 * and crashed with "trim is not a function" whenever content was non-string.
 *
 * The function below skips any non-string field and recurses one level into
 * nested objects looking for `text/body/content` — so the verifier loop
 * keeps moving even when the gateway evolves the payload shape again.
 */

interface IpfsTracePayload {
  traceMarkdown?: unknown;
  markdown?: unknown;
  content?: unknown;
  body?: unknown;
  text?: unknown;
}

export function traceTextFromIpfsPayload(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as IpfsTracePayload;
  for (const v of [p.traceMarkdown, p.markdown, p.content, p.body, p.text]) {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
      const inner =
        (v as { text?: unknown; body?: unknown; content?: unknown }).text
        ?? (v as { text?: unknown; body?: unknown; content?: unknown }).body
        ?? (v as { text?: unknown; body?: unknown; content?: unknown }).content;
      if (typeof inner === "string" && inner.length > 0) return inner;
    }
  }
  return null;
}

/** What a missing full trace tells us about whether retrying is worth it. */
export type CidStatus = "ok" | "permanent" | "transient" | "none";

/**
 * Whether a trace CID is even worth a gateway round-trip.
 *
 * The failure we guard against is TRUNCATION: the detail endpoint sometimes
 * returns a ~12-char placeholder (e.g. "Qme9c319c24c") instead of a real CID.
 * Those never resolve, so we skip them without a fetch + 6h re-defer (the
 * "CID carousel" that starved the verify budget).
 *
 * For CIDv0 ("Qm…") we enforce the BASE58BTC ALPHABET, not just length. The
 * verifiable pool is heavily polluted with synthetic submissions whose CID is
 * "Qm" + a hex digest (e.g. "Qm424d0f7ca290…"): 46 chars, looks CID-shaped, but
 * the hex `0` is outside base58 so it 400s "Invalid CID format" at the gateway
 * every single time. Those fakes crowd the quorum-sorted verify batch and
 * starve the real submissions (the "0/30 verify budget burned daily" outage).
 * Rejecting them on the base58 alphabet here turns a wasted round-trip + 6h
 * re-defer carousel into an instant permanent skip, freeing batch slots.
 *
 * For CIDv1 / other multibase encodings (base32 "b…", base36 "k…", base58 "z…")
 * we keep the permissive length-keyed guard: alphabets differ, so we let an
 * unusual-but-plausible CID get a network attempt and rely on the gateway 400 +
 * `isPermanentCidError` to catch a genuine bad hash downstream.
 */
const CIDV0_BASE58_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

export function isWellFormedCid(cid: string): boolean {
  // CIDv0 is always "Qm" + 44 base58btc chars (46 total, no 0/O/I/l). Anything
  // claiming the Qm prefix must satisfy that exactly — hex-digest fakes don't.
  if (cid.startsWith("Qm")) return CIDV0_BASE58_RE.test(cid);
  return cid.length >= 40 && /^[A-Za-z0-9]+$/.test(cid);
}

/**
 * Why a CID failed {@link isWellFormedCid}. The old telemetry only logged
 * `len=N`, so a correctly-rejected hex-digest fake ("Qm…", len=46) was
 * indistinguishable from a genuine false-rejection — which made the observer
 * repeatedly "flag" the spam filter as broken. This names the actual cause:
 * truncation vs. a forbidden character (and which one). Pure — testable.
 */
export function cidRejectReason(cid: string): string {
  if (cid.startsWith("Qm")) {
    if (cid.length !== 46) return `Qm-prefix but len=${cid.length} (CIDv0 must be 46) — truncated/placeholder`;
    const bad = cid.slice(2).match(/[^1-9A-HJ-NP-Za-km-z]/);
    if (bad) return `Qm-prefix, len=46 but non-base58 char '${bad[0]}' at idx ${cid.indexOf(bad[0])} — hex-digest fake (correct skip)`;
    return "Qm-prefix, len=46, base58-valid (unexpected — should NOT have been rejected)";
  }
  if (cid.length < 40) return `len=${cid.length} (<40) — truncated/placeholder`;
  return `len=${cid.length} but contains non-alphanumeric chars`;
}

/**
 * Classify a trace-CID fetch error. A gateway 400 "Invalid CID format" means
 * the hash itself is bad — it will never resolve, so don't re-defer it every
 * 6h. Everything else (5xx, timeouts, gateway 502s) is transient IPFS
 * propagation and worth the retry.
 */
export function isPermanentCidError(msg: string): boolean {
  return /invalid cid format/i.test(msg);
}

/** A full CIDv0 (Qm…46) or CIDv1 base32 (bafy/bafk…) embedded anywhere in a
 *  string — used to recover a CID from an ipfs:// URL or /ipfs/<cid> path when
 *  the bare field held a truncated prefix. */
const EMBEDDED_CID_RE = /Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,}/;

// Field names the gateway has used (or might rename to) for the trace CID, and
// nested objects that could wrap it. Kept generous on purpose: a missed alias
// is a fully-deferred verify pool, a spurious one is harmless (it still has to
// pass the CID shape check).
const CID_FIELD_ALIASES = [
  "traceCid", "trace_cid", "traceCID", "traceIpfsCid", "traceIpfsCID",
  "ipfsCid", "ipfs_cid", "cid", "fullTraceCid", "reasoningTraceCid",
];
const CID_NEST_KEYS = ["trace", "ipfs", "fullTrace", "reasoningTrace", "traceRef"];

function collectCidCandidates(detail: unknown): string[] {
  if (!detail || typeof detail !== "object") return [];
  const d = detail as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.push(s);
    }
  };
  for (const k of CID_FIELD_ALIASES) push(d[k]);
  for (const k of CID_NEST_KEYS) {
    const nested = d[k];
    if (typeof nested === "string") push(nested);
    else if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      push(n.cid);
      push(n.ipfsCid);
      push(n.traceCid);
      push(n.hash);
    }
  }
  return out;
}

/**
 * Pull the trace CID out of a submission-detail payload, defensively.
 *
 * Originally the verifier read a single field (`detail.traceCid`). When the
 * gateway renamed/nested that field — or a publisher shipped a truncated prefix
 * with the real hash only inside an `ipfs://<cid>` link — the bare read
 * returned undefined/garbage, so EVERY verifiable submission looked CID-less
 * and was deferred forever (the "0/30 verify budget burned every day" outage).
 *
 * This scans the known aliases plus one level of nesting, and regex-extracts a
 * full CID embedded in a URL/path. Returns the best CID found (preferring a
 * well-formed one); falls back to the first raw candidate so the caller's
 * malformed-CID branch still fires its permanent-skip telemetry. Pure — testable.
 */
export function extractTraceCid(detail: unknown): string | null {
  const candidates = collectCidCandidates(detail);
  for (const c of candidates) {
    if (isWellFormedCid(c)) return c;
    const m = c.match(EMBEDDED_CID_RE);
    if (m && isWellFormedCid(m[0])) return m[0];
  }
  return candidates[0] ?? null;
}

/**
 * Keys on a detail payload that *look* like they should carry a CID. Used for a
 * one-time schema-drift canary: when {@link extractTraceCid} returns null but
 * the payload clearly has CID-ish keys, we log them once so a renamed field is
 * visible without redeploying. Pure — testable.
 */
export function cidBearingKeys(detail: unknown): string[] {
  if (!detail || typeof detail !== "object") return [];
  return Object.keys(detail as Record<string, unknown>).filter((k) =>
    /cid|ipfs|trace|hash|artifact/i.test(k),
  );
}
