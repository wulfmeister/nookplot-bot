/**
 * CIDv0 multihash-header check (2026-10-01, item 7).
 *
 * A CIDv0 is base58btc(0x12 0x20 ‖ 32-byte sha2-256 digest). "Qm" + 44 random
 * base58 chars spans headers 0x121e..0x1222, so ~70% of alphabet-valid fakes
 * decode to a header that cannot exist. isWellFormedCid now rejects those, so
 * the verify path marks them permanent without a gateway or public fetch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isWellFormedCid,
  cidRejectReason,
  cidV0MultihashHeader,
  CIDV0_SHA256_HEADER,
  extractTraceCid,
} from "../trace-payload.js";

// Independent base58btc ENCODER (the module only decodes), so the boundary
// tests below check the decoder against separately written code.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(n: bigint): string {
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}

// Genuine CIDv0s. Third character spans the full N..f range a real CIDv0 can
// start with, including both partial buckets (N and f).
const GENUINE = [
  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", // task vector (well-known go-ipfs docs dir)
  "QmNLiJbCobNi7imGRoFjA2L6r7Kz8nJjiA9snkzNRdBrF3", // pool trace, fetched into verify cache
  "QmP1DUzQY2uXqbA1B8Pg2pmuguNvdHzozjJYGUiU6bfLMt", // pool trace, fetched into verify cache
  "Qmf19VnRWD3eWjnprPWXkMHsJTWHtWQQfC11ANDuvvGuao", // pool trace, fetched into verify cache
  "QmStD1fFJC4NdLYk15p4CyBveYZ2D18VbB5MoqtqMTW4Se", // our published knowledge (2026-05-19)
  "QmT61tBKXBzVizYyMmWGMjqbBCqMvp23ceZAnHtp3n2keY", // our published knowledge (2026-05-19)
  "QmNXBEmFzT11fbEvmyYJAM5GMWLmQPe7zKMtwxxNXSpSh9", // live pool detail, 2026-10-01
  "QmeqqBQYtiC1a5BXexX3TSTssFsPLnwSP6tLZu3yTLyqex", // live pool detail, 2026-10-01
  "Qmb2KBzLzoA9u2BXfRFcRhDgmNXtgx3sGbAfgC5zS4EcTw", // existing backend.test.ts fixture
];

describe("trace-payload CIDv0 multihash header (fabricated Qm CIDs)", () => {
  it("task vectors: the real CID passes, the fabricated 0x121f one fails", () => {
    assert.equal(isWellFormedCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), true);
    assert.equal(isWellFormedCid("Qm9J9WExKy7tuaAM8BPqdQUNb3caoDYtdJ9nSRhYV6sNSP"), false);
  });

  it("every genuine fixture decodes to 0x1220 and passes", () => {
    for (const cid of GENUINE) {
      assert.equal(cid.length, 46, cid);
      assert.equal(cidV0MultihashHeader(cid), CIDV0_SHA256_HEADER, cid);
      assert.equal(isWellFormedCid(cid), true, cid);
    }
  });

  it("cidV0MultihashHeader reads the 2-byte header; null on a non-base58 char", () => {
    assert.equal(CIDV0_SHA256_HEADER, 0x1220n);
    assert.equal(cidV0MultihashHeader("Qm9J9WExKy7tuaAM8BPqdQUNb3caoDYtdJ9nSRhYV6sNSP"), 0x121fn);
    assert.equal(cidV0MultihashHeader("Qm424d0f7ca290ab5bc1110ff7ba7853d704044e760658"), null); // '0'
    assert.equal(cidV0MultihashHeader("QmOabc"), null); // 'O'
  });

  it("accepts the exact 0x1220 boundaries and rejects one step outside each", () => {
    const min = CIDV0_SHA256_HEADER << 256n; // digest = 32 zero bytes
    const max = ((CIDV0_SHA256_HEADER + 1n) << 256n) - 1n; // digest = 32 0xff bytes
    const lo = b58encode(min), hi = b58encode(max);
    const below = b58encode(min - 1n), above = b58encode(max + 1n);
    for (const s of [lo, hi, below, above]) {
      assert.equal(s.length, 46, s);
      assert.ok(s.startsWith("Qm"), s);
    }
    assert.equal(isWellFormedCid(lo), true, lo);
    assert.equal(isWellFormedCid(hi), true, hi);
    assert.equal(isWellFormedCid(below), false, below);
    assert.equal(isWellFormedCid(above), false, above);
    assert.equal(cidV0MultihashHeader(below), 0x121fn);
    assert.equal(cidV0MultihashHeader(above), 0x1221n);
  });

  it("rejects fakes at every impossible header the Qm range covers (0x121e, 0x121f, 0x1221, 0x1222)", () => {
    // "Qm"+44 covers headers 4638.76..4642.13 (in units of 2^256), so the
    // offset into each header's bucket must keep the value inside that span:
    // high in 0x121e, low in 0x1222, mid-bucket for the other two.
    const offsets: Array<[bigint, bigint]> = [
      [0x121en, 15n << 252n], // +0.9375
      [0x121fn, 1n << 255n], // +0.5
      [0x1221n, 1n << 255n], // +0.5
      [0x1222n, 1n << 251n], // +0.03125
    ];
    const fakes = offsets.map(([h, off]): [bigint, string] => [h, b58encode((h << 256n) + off + 0xabcdefn)]);
    for (const [h, s] of fakes) {
      assert.equal(s.length, 46, s);
      assert.ok(s.startsWith("Qm"), s);
      assert.doesNotMatch(s, /^Qm[1-9a-f]{44}$/, `${s} must not be a pure-hex tail`);
      assert.equal(cidV0MultihashHeader(s), h, s);
      assert.equal(isWellFormedCid(s), false, s);
    }
  });

  it("cidRejectReason names the fake multihash prefix and calls it a correct skip", () => {
    const r = cidRejectReason("Qm9J9WExKy7tuaAM8BPqdQUNb3caoDYtdJ9nSRhYV6sNSP");
    assert.match(r, /fake multihash prefix 0x121f/);
    assert.match(r, /0x1220/);
    assert.match(r, /correct skip/);
    assert.doesNotMatch(r, /should NOT have been rejected/);
  });

  it("keeps the earlier, more specific reasons ahead of the header reason", () => {
    // Pure-hex tail decoding to 0x121e: still reported as a hex-digest fake.
    const hexFake = "Qm" + "1a2b3c4d5e6f".repeat(4).slice(0, 44);
    assert.equal(cidV0MultihashHeader(hexFake), 0x121en);
    assert.match(cidRejectReason(hexFake), /pure lowercase hex/i);
    // Truncation and forbidden chars are unchanged.
    assert.match(cidRejectReason("Qme9c319c24c"), /len=12/);
    assert.match(cidRejectReason("Qm424d0f7ca290ab5bc1110ff7ba7853d704044e760658"), /non-base58 char '0'/);
  });

  it("CIDv1 and other multibase CIDs are untouched by the header check", () => {
    assert.equal(isWellFormedCid("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), true);
    assert.equal(isWellFormedCid("k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8"), true);
    // base58btc CIDv1 ('z…'): a 0x1220 header is not required there.
    assert.equal(isWellFormedCid("zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7"), true);
  });

  it("extractTraceCid skips a fabricated traceCid for a real CID in a link, else returns it raw", () => {
    const fake = "Qm9J9WExKy7tuaAM8BPqdQUNb3caoDYtdJ9nSRhYV6sNSP";
    const real = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    assert.equal(extractTraceCid({ traceCid: fake, trace: `ipfs://${real}` }), real);
    // Only the fake present: returned as-is so the caller's malformed branch
    // marks it permanent (no fetch), rather than treating it as CID-less.
    assert.equal(extractTraceCid({ traceCid: fake }), fake);
    assert.equal(extractTraceCid({ traceCid: `ipfs://${fake}` }), `ipfs://${fake}`);
  });
});
