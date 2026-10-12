// Credit packs (2026-10-11): the CreditPurchase contract charges Micro $1 → 25
// credits while /v1/credits/packs lists $2 → 125. buy-credits and the
// dashboard read the contract; these pin the receipt parser and the merge.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";
import { CREDIT_PURCHASE, USDC_TOKEN, mergePackPricing, parseBuyArgs, priceWithinCeiling, summarizePurchaseReceipt, type OnChainPack } from "../credit-packs.js";

const ME = "0x00000000000000000000000000000000000a11ce";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const TREASURY = "0x0000000000000000000000000000000000007ea5";
const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const TRANSFER = id("Transfer(address,address,uint256)");
const APPROVAL = id("Approval(address,address,uint256)");
// Topic 0 of the contract's purchase event as seen on 2026-10-11 (name unknown).
const PURCHASE_EVENT = "0x72a27a4d273e251c561872ada0cf3a7cdbf27026d7facd580d6696872cd5d176";

// Shape of a Micro purchase receipt: USDC Transfer buyer → treasury of
// 1 USDC, then the contract's event with data [credits×100, usdc, 0, ts]. The
// parser ignores word 3 (a timestamp), so the fixture uses a synthetic one.
const microLogs = [
  { address: USDC_TOKEN.toLowerCase(), topics: [TRANSFER, pad(ME), pad(TREASURY)], data: "0x" + word(1_000_000) },
  { address: CREDIT_PURCHASE, topics: [PURCHASE_EVENT, pad(ME), pad("0x0")], data: "0x" + word(2500) + word(1_000_000) + word(0) + word(1_700_000_000) },
];

describe("credit packs: purchase receipt", () => {
  it("reads what a Micro buy charged and credited: 1 USDC → 25 credits", () => {
    const out = summarizePurchaseReceipt(microLogs, ME);
    assert.equal(out.usdcPaid, 1_000_000n);
    assert.equal(out.credits, 25);
  });

  it("buyer address case does not matter", () => {
    assert.equal(summarizePurchaseReceipt(microLogs, ME.toUpperCase().replace("0X", "0x")).credits, 25);
  });

  it("ignores an Approval log, USDC sent TO the buyer, and other tokens", () => {
    const logs = [
      { address: USDC_TOKEN, topics: [APPROVAL, pad(ME), pad(CREDIT_PURCHASE)], data: "0x" + word(2_000_000) },
      { address: USDC_TOKEN, topics: [TRANSFER, pad(OTHER), pad(ME)], data: "0x" + word(5_000_000) },
      { address: "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3", topics: [TRANSFER, pad(ME), pad(TREASURY)], data: "0x" + word(10n ** 18n) },
      ...microLogs,
    ];
    assert.equal(summarizePurchaseReceipt(logs, ME).usdcPaid, 1_000_000n);
  });

  it("another buyer's purchase event is not ours: credits null", () => {
    const logs = [{ ...microLogs[1], topics: [PURCHASE_EVENT, pad(OTHER), pad("0x0")] }];
    const out = summarizePurchaseReceipt(logs, ME);
    assert.equal(out.credits, null);
    assert.equal(out.usdcPaid, 0n);
  });
});

describe("credit packs: dashboard pricing", () => {
  const advertised = [
    { id: 0, name: "Micro", usdcPrice: "2.00", credits: 125, nookDiscount: 20 },
    { id: 1, name: "Standard", usdcPrice: "10.00", credits: 700, nookDiscount: 25 },
    { id: 2, name: "Bulk", usdcPrice: "35.00", credits: 3250, nookDiscount: 30 },
  ];
  const onChain: OnChainPack[] = [
    { id: 0, name: "Micro", usdcPrice: 1_000_000n, credits: 25, active: true },
    { id: 1, name: "Standard", usdcPrice: 5_000_000n, credits: 140, active: true },
    { id: 2, name: "Bulk", usdcPrice: 20_000_000n, credits: 650, active: true },
  ];

  it("the contract's price wins; the listing is kept only as a flagged mismatch", () => {
    const out = mergePackPricing(advertised, onChain);
    assert.deepEqual(out.map((p) => [p.usdcPrice, p.credits, p.source]), [[1, 25, "on-chain"], [5, 140, "on-chain"], [20, 650, "on-chain"]]);
    assert.deepEqual(out[0].advertised, { usdcPrice: 2, credits: 125 });
    assert.equal(out[2].creditsPerDollar, 32.5);
    assert.equal(out[0].nookDiscount, 20);
  });

  it("no mismatch flag when the listing agrees with the contract", () => {
    const agree = [{ id: 0, name: "Micro", usdcPrice: "1.00", credits: 25 }];
    assert.equal(mergePackPricing(agree, onChain.slice(0, 1))[0].advertised, null);
  });

  it("RPC read failed: falls back to the listing, marked as such", () => {
    for (const none of [null, []]) {
      const out = mergePackPricing(advertised, none);
      assert.equal(out.length, 3);
      assert.ok(out.every((p) => p.source === "gateway" && p.advertised === null));
      assert.equal(out[0].usdcPrice, 2);
    }
  });

  it("an inactive pack stays listed, marked inactive", () => {
    const out = mergePackPricing(advertised, [{ ...onChain[0], active: false }]);
    assert.equal(out[0].active, false);
  });
});

describe("credit packs: buy-credits arguments", () => {
  it("--pack is required: no default purchase", () => {
    const r = parseBuyArgs([]);
    assert.equal(r.args, null);
    assert.match(r.errors.join(), /--pack=N is required/);
  });

  it("npm without \"--\" swallows the flags into npm_config_*: refuse, even though argv is empty", () => {
    const r = parseBuyArgs([], { npm_config_pack: "2", npm_config_dry_run: "true" });
    assert.equal(r.args, null);
    assert.match(r.errors[0], /put "--" before them/);
  });

  it("unknown or misspelled arguments are errors, not ignored", () => {
    for (const bad of [["--pack=0", "--dryrun"], ["--pack", "1"], ["--pack=foo"], ["--pack=-1"], ["--pack=0", "--max-usdc=0"]]) {
      assert.equal(parseBuyArgs(bad).args, null, bad.join(" "));
    }
  });

  it("parses a well-formed command", () => {
    assert.deepEqual(parseBuyArgs(["--pack=1", "--dry-run", "--max-usdc=6"]).args, { packId: 1, useNook: false, dryRun: true, maxUsdc: 6 });
    assert.deepEqual(parseBuyArgs(["--pack=0"]).args, { packId: 0, useNook: false, dryRun: false, maxUsdc: null });
  });
});

describe("credit packs: price ceiling", () => {
  it("the listed price is the ceiling by default; the contract's lower price passes", () => {
    assert.deepEqual(priceWithinCeiling(1_000_000n, "2", null), { ok: true, ceilingUsdc: 2 });
  });
  it("a reprice above the listing stops the run unless --max-usdc allows it", () => {
    assert.equal(priceWithinCeiling(10_000_000n, "2", null).ok, false);
    assert.equal(priceWithinCeiling(10_000_000n, "2", 10).ok, true);
    assert.equal(priceWithinCeiling(10_000_001n, "2", 10).ok, false);
  });
});
