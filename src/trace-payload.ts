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
  /** Pool traces are pinned as {"format":"reasoning_v1","reasoning":"…"} —
   *  missed until 2026-10-01, so a primary-gateway 200 parsed to null (deferred
   *  and struck) and public-gateway recoveries handed the verifier raw JSON. */
  reasoning?: unknown;
  content?: unknown;
  body?: unknown;
  text?: unknown;
}

export function traceTextFromIpfsPayload(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as IpfsTracePayload;
  // `reasoning` LAST: purely additive — every pre-existing shape resolves as
  // before, and reasoning_v1 payloads have no other text field.
  for (const v of [p.traceMarkdown, p.markdown, p.content, p.body, p.text, p.reasoning]) {
    if (typeof v === "string" && v.trim().length > 0) return v;
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
 * A CIDv0 must also DECODE to a sha2-256 multihash. CIDv0 is
 * base58btc(0x12 0x20 ‖ 32-byte digest), 34 bytes, so the decoded integer's
 * bits above the 256-bit digest are the 2-byte header and must equal 0x1220.
 * "Qm" + 44 random base58 chars spans headers 0x121e..0x1222, so only ~30% of
 * random alphabet-valid strings decode to a header a real CIDv0 can have. The
 * rest (e.g. the pool's "Qm9J9WExKy7t…" → 0x121f) can never exist on IPFS, yet
 * each one was spending a primary fetch, a 4s retry, the public-gateway
 * fallback and up to three 6h re-defers. In ~/.nookplot/logs/bot.log (to 2026-10-01), 1,979 of the 4,399
 * distinct Qm CIDs whose fetch failed decode to an impossible header (the
 * logged 12-char prefix pins the header exactly). Every genuine CID we hold
 * decodes to 0x1220: all 1,538 recovered via the public fallback, the 5,485
 * pool traces fetched into the verify cache, and our own 427 published CIDs.
 *
 * For CIDv1 / other multibase encodings (base32 "b…", base36 "k…", base58 "z…")
 * we keep the permissive length-keyed guard: alphabets differ, so we let an
 * unusual-but-plausible CID get a network attempt and rely on the gateway 400 +
 * `isPermanentCidError` to catch a genuine bad hash downstream.
 */
const CIDV0_BASE58_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
// A 44-char tail drawn ENTIRELY from lowercase hex (minus 0, which base58
// already forbids) is a hex digest dressed as a CID, not a real hash:
// P(a genuine base58btc hash lands all-hex) = (15/58)^44 ≈ 1e-26. ~30 such
// fakes passed the alphabet check 08-01→05 and burned 2×15s public-gateway
// timeouts each before dying downstream. The header check below also catches
// hex tails starting 1-9 (they decode below 0x1220) but not every one starting
// a-f, so this rule stays; it also gives the more specific reason.
const CIDV0_HEX_TAIL_RE = /^Qm[1-9a-f]{44}$/;

const BASE58BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Multihash header of a CIDv0: code 0x12 (sha2-256), digest length 0x20 (32). */
export const CIDV0_SHA256_HEADER = 0x1220n;

/**
 * The multihash header (the decoded value's bits above the 256-bit digest) of
 * a base58btc string, or null if any character is outside base58btc. For a
 * real CIDv0 this is {@link CIDV0_SHA256_HEADER}. A string that starts with
 * "Qm" has no leading "1" (zero-byte) digits, so a header of exactly 0x1220
 * also means the decoded multihash is exactly 34 bytes. Pure, BigInt-only.
 */
export function cidV0MultihashHeader(cid: string): bigint | null {
  let n = 0n;
  for (const ch of cid) {
    const digit = BASE58BTC_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  return n >> 256n;
}

export function isWellFormedCid(cid: string): boolean {
  // CIDv0 is always "Qm" + 44 base58btc chars (46 total, no 0/O/I/l) that
  // decode to a 0x1220 sha2-256 multihash. Anything claiming the Qm prefix
  // must satisfy all of that: hex-digest and random-base58 fakes don't.
  if (cid.startsWith("Qm")) {
    return CIDV0_BASE58_RE.test(cid)
      && !CIDV0_HEX_TAIL_RE.test(cid)
      && cidV0MultihashHeader(cid) === CIDV0_SHA256_HEADER;
  }
  return cid.length >= 40 && /^[A-Za-z0-9]+$/.test(cid);
}

/**
 * Why a CID failed {@link isWellFormedCid}. The old telemetry only logged
 * `len=N`, so a correctly-rejected hex-digest fake ("Qm…", len=46) was
 * indistinguishable from a genuine false-rejection — which made the observer
 * repeatedly "flag" the spam filter as broken. This names the actual cause:
 * truncation vs. a forbidden character (and which one) vs. a "fake multihash
 * prefix" (base58-valid but not decoding to 0x1220). Pure — testable.
 */
export function cidRejectReason(cid: string): string {
  if (cid.startsWith("Qm")) {
    if (cid.length !== 46) return `Qm-prefix but len=${cid.length} (CIDv0 must be 46) — truncated/placeholder`;
    const bad = cid.slice(2).match(/[^1-9A-HJ-NP-Za-km-z]/);
    if (bad) return `Qm-prefix, len=46 but non-base58 char '${bad[0]}' at idx ${cid.indexOf(bad[0])} — hex-digest fake (correct skip)`;
    if (CIDV0_HEX_TAIL_RE.test(cid))
      return "Qm-prefix, len=46, base58-valid but tail is PURE lowercase hex — hex-digest fake (P(real)≈1e-26, correct skip)";
    const header = cidV0MultihashHeader(cid);
    if (header !== CIDV0_SHA256_HEADER)
      return `Qm-prefix, len=46, base58-valid but fake multihash prefix 0x${header?.toString(16) ?? "?"} (a CIDv0 must decode to 0x1220 = sha2-256, 32-byte digest) — fabricated CID (correct skip)`;
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
/**
 * A 5xx from the gateway's own IPFS endpoint is worth ONE bounded retry before
 * falling back to public gateways: a CID pinned only on the Nookplot node is
 * invisible to ipfs.io/dweb.link, so a single 502 blip burned a fetch strike
 * (3 strikes = permanent retire) on real submissions — 12 strike cases
 * 08-01→05. Excludes permanent CID errors, which no retry can fix.
 */
export function isTransientIpfsGatewayError(msg: string): boolean {
  return !isPermanentCidError(msg) && /\(50[234]\)/.test(msg);
}

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
