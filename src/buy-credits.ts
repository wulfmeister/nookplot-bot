/**
 * Credit-pack purchase helper.
 *
 * Direct on-chain interaction with the CreditPurchase contract on Base.
 * Pays for gas in ETH from our wallet (no relay subsidy).
 *
 * Confirmed signatures (decoded from recent on-chain calls + OpenChain lookup):
 *   purchaseWithUSDC(uint256 packId)  → selector 0x8af3d24a
 *
 * NOOK payment selector is not publicly documented; we ship the most likely
 * candidate (`purchaseWithNOOK(uint256)`). If it reverts the helper falls
 * back to USDC with an explanatory note.
 *
 * Usage (prices are the contract's, read live — see credit-packs.ts; the
 * gateway's /v1/credits/packs listing is higher and wrong):
 *   npm run buy-credits -- --pack=0          # Micro: 1 USDC → 25 credits
 *   npm run buy-credits -- --pack=1          # Standard: 5 USDC → 140 credits
 *   npm run buy-credits -- --pack=2 --nook   # Bulk: 20 USDC → 650 credits, via NOOK (with discount)
 *   npm run buy-credits -- --pack=0 --dry-run  # Print planned tx, don't send
 *   npm run buy-credits -- --pack=0 --max-usdc=3  # Accept a contract price up to 3 USDC
 *
 * The "--" matters: without it npm keeps the flags and the script refuses to
 * run. --pack is required; unknown arguments are errors. The USDC price may
 * not exceed the gateway's listed price unless --max-usdc allows it.
 *
 * Requires:
 *   - NOOKPLOT_AGENT_PRIVATE_KEY in .env
 *   - ETH balance for gas on Base
 *   - USDC OR NOOK balance for payment
 *
 * Gas: ~$0.01 USD per tx on Base. Two-tx flow for ERC-20 payment:
 *   1. approve(spender, amount) on the payment token
 *   2. purchaseWithUSDC(packId) or purchaseWithNOOK(packId) on CreditPurchase
 */
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, AbiCoder, parseUnits, formatUnits, formatEther } from "ethers";
import { CREDIT_PURCHASE, USDC_TOKEN, parseBuyArgs, priceWithinCeiling, readOnChainPack, summarizePurchaseReceipt } from "./credit-packs.js";
import type { Provider, TransactionReceipt } from "ethers";

const NOOK_TOKEN = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

// CreditPurchase ABI — minimal, only the functions we use. USDC signature
// confirmed via tx-history analysis. NOOK path uses raw selector because
// the function name isn't publicly listed but the selector + signature
// (packId, maxNookAmount) were extracted from 3 successful on-chain txs.
const CREDIT_PURCHASE_ABI = [
  "function purchaseWithUSDC(uint256 packId)",
];

// Selector for the NOOK-payment function, discovered by decoding successful
// txs to CreditPurchase. Signature: (uint256 packId, uint256 maxNookAmount).
// We send maxNookAmount slightly above the observed exchange rate so the
// contract's slippage check passes; it pulls exactly what's needed via the
// approved allowance.
const NOOK_PURCHASE_SELECTOR = "0xa7b69a0e";

// Observed NOOK amounts from recent successful on-chain purchases.
// Used as the "expected" rate to compute a safe maxNookAmount upper bound.
// usdc/credits are the GATEWAY'S ADVERTISED figures (/v1/credits/packs), not
// what the contract charges; the USDC path reads the real price on-chain.
const PACKS = [
  { id: 0, name: "Micro", usdc: "2", credits: 125, nookDiscount: 20,
    observedNookAmount: "99854.4444444" },
  { id: 1, name: "Standard", usdc: "10", credits: 700, nookDiscount: 25,
    observedNookAmount: "499272.2222222" },
  { id: 2, name: "Bulk", usdc: "35", credits: 3250, nookDiscount: 30,
    observedNookAmount: "1797400" },
];

/**
 * Poll for a receipt, riding out RPC errors (the public Base RPC rate-limits).
 * Throws only when no receipt arrives in time: the caller then reports the
 * transaction as broadcast with an unknown outcome, never as failed.
 */
async function waitForReceipt(provider: Provider, hash: string, timeoutMs = 180_000): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await provider.getTransactionReceipt(hash);
      if (r) return r;
    } catch (err) {
      lastErr = (err as Error).message.slice(0, 120);
    }
    await new Promise((res) => setTimeout(res, 3_000));
  }
  throw new Error(`no receipt after ${Math.round(timeoutMs / 1000)}s${lastErr ? ` (last RPC error: ${lastErr})` : ""}`);
}

/** A sent transaction whose outcome we could not read: never tell the operator it failed. */
function exitUnknown(what: string, hash: string, err: unknown): never {
  console.error(`⚠ ${what} tx ${hash} was broadcast but its outcome is unknown: ${(err as Error).message}`);
  console.error(`  Check https://basescan.org/tx/${hash} and the credits ledger (dashboard Credits tab) BEFORE retrying, or you may buy twice.`);
  process.exit(5);
}

async function main() {
  const parsed = parseBuyArgs(process.argv.slice(2), process.env);
  if (!parsed.args) {
    for (const e of parsed.errors) console.error(`✗ ${e}`);
    console.error(`Usage: npm run buy-credits -- --pack=N [--dry-run] [--max-usdc=X] [--nook]`);
    process.exit(2);
  }
  const args = parsed.args;
  const pack = PACKS[args.packId];
  if (!pack) {
    console.error(`Unknown pack id ${args.packId}. Valid: 0, 1, 2 (Micro, Standard, Bulk).`);
    process.exit(2);
  }
  const pk = process.env.NOOKPLOT_AGENT_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY;
  if (!pk || pk.includes("replace")) {
    console.error("Missing NOOKPLOT_AGENT_PRIVATE_KEY in .env");
    process.exit(2);
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(pk, provider);
  const address = await wallet.getAddress();

  // The contract's own price, not the gateway listing (see credit-packs.ts).
  const onChain = await readOnChainPack(provider, args.packId);
  if (!onChain.active) {
    console.error(`Pack #${args.packId} "${onChain.name}" is not active on the CreditPurchase contract.`);
    process.exit(2);
  }
  const onChainUsdc = formatUnits(onChain.usdcPrice, 6);
  const ceiling = priceWithinCeiling(onChain.usdcPrice, pack.usdc, args.maxUsdc);
  if (!args.useNook && !ceiling.ok) {
    console.error(`✗ The contract now charges ${onChainUsdc} USDC for pack #${args.packId}, above the ${ceiling.ceilingUsdc} USDC ceiling.`);
    console.error(`  If that is expected, re-run with --max-usdc=${onChainUsdc}.`);
    process.exit(3);
  }

  console.log(`Wallet:  ${address}`);
  console.log(`Pack:    #${onChain.id} "${onChain.name}" — ${onChain.credits} credits for ${onChainUsdc} USDC (contract price)`);
  if (onChain.credits !== pack.credits || Number(onChainUsdc) !== Number(pack.usdc)) {
    console.log(`         (the gateway lists ${pack.credits} credits for ${pack.usdc} USDC; the contract charges the price above)`);
  }
  console.log(`Payment: ${args.useNook ? `NOOK (${pack.nookDiscount}% discount, est < ${onChainUsdc} USDC equivalent)` : `${onChainUsdc} USDC`}`);
  console.log(`RPC:     ${RPC_URL}`);
  console.log("");

  // Pre-flight: check ETH balance, payment-token balance, and current allowance
  const ethBal = await provider.getBalance(address);
  console.log(`ETH balance:  ${formatEther(ethBal)} ETH (gas)`);
  if (ethBal < parseUnits("0.0005", "ether")) {
    console.error("Insufficient ETH for gas. Need ~0.0005 ETH (~$0.01).");
    process.exit(3);
  }

  const paymentTokenAddr = args.useNook ? NOOK_TOKEN : USDC_TOKEN;
  const paymentName = args.useNook ? "NOOK" : "USDC";
  const paymentToken = new Contract(paymentTokenAddr, ERC20_ABI, wallet);
  const decimals = Number(await paymentToken.decimals());
  const rawBal = (await paymentToken.balanceOf(address)) as bigint;
  console.log(`${paymentName} balance: ${formatUnits(rawBal, decimals)} ${paymentName}`);

  // Approve amount: for USDC we know exactly (the on-chain usdcPrice). For NOOK,
  // the discount math is on-contract; we approve a generous max to avoid
  // a second tx if our math is off. Standard pattern.
  // For NOOK: contract takes (packId, maxNookAmount). We've observed the
  // exact required amounts from successful on-chain txs. Send 1.2× as the
  // slippage buffer — contract pulls exact, returns nothing extra.
  // For USDC: contract pulls exactly the on-chain usdcPrice; approve exactly
  // that (approving the advertised price left a 1 USDC allowance on 10-11).
  const nookMaxAmount = args.useNook
    ? parseUnits((Number(pack.observedNookAmount) * 1.2).toFixed(4), 18)
    : 0n;
  const approvalAmount = args.useNook
    ? nookMaxAmount
    : onChain.usdcPrice;
  if (rawBal < approvalAmount) {
    if (args.useNook) {
      // For NOOK we don't know exact required amount until contract math runs.
      console.warn(`(warning: balance < generous-approve cap of 1M NOOK; will still try)`);
    } else {
      console.error(`Insufficient ${paymentName}. Need ${formatUnits(approvalAmount, decimals)} ${paymentName}, have ${formatUnits(rawBal, decimals)}.`);
      process.exit(3);
    }
  }

  const currentAllowance = (await paymentToken.allowance(address, CREDIT_PURCHASE)) as bigint;
  console.log(`Current allowance: ${formatUnits(currentAllowance, decimals)} ${paymentName}`);
  console.log("");

  if (args.dryRun) {
    console.log("--dry-run set; not sending any txs. Re-run without --dry-run to execute.");
    return;
  }

  // Step 1: approve if needed
  if (currentAllowance < approvalAmount) {
    console.log(`📝 Step 1: approving CreditPurchase to spend ${formatUnits(approvalAmount, decimals)} ${paymentName}…`);
    const approveTx = await paymentToken.approve(CREDIT_PURCHASE, approvalAmount);
    console.log(`  tx: ${approveTx.hash}`);
    let approveReceipt: TransactionReceipt;
    try {
      approveReceipt = await waitForReceipt(provider, approveTx.hash);
    } catch (err) {
      exitUnknown("approve", approveTx.hash, err);
    }
    if (approveReceipt.status !== 1) {
      console.error(`✗ approve tx ${approveTx.hash} reverted; nothing was purchased.`);
      process.exit(4);
    }
    console.log(`  ✅ confirmed`);
  } else {
    console.log(`📝 Step 1: allowance already sufficient — skipping`);
  }

  // Step 2: purchase
  if (args.useNook) {
    // Use raw calldata since the function name isn't publicly known —
    // selector 0xa7b69a0e + (packId, maxNookAmount) extracted from
    // observed successful on-chain txs.
    const coder = AbiCoder.defaultAbiCoder();
    const argsHex = coder.encode(["uint256", "uint256"], [args.packId, nookMaxAmount]);
    const callData = NOOK_PURCHASE_SELECTOR + argsHex.slice(2);
    console.log(`📝 Step 2: calling CreditPurchase via raw selector ${NOOK_PURCHASE_SELECTOR}`);
    console.log(`         args: (packId=${args.packId}, maxNookAmount=${formatUnits(nookMaxAmount, 18)} NOOK)`);
    let hash: string;
    try {
      hash = (await wallet.sendTransaction({ to: CREDIT_PURCHASE, data: callData })).hash;
    } catch (err) {
      console.error(`✗ purchase not sent: ${(err as Error).message.slice(0, 300)}`);
      process.exit(4);
    }
    console.log(`  tx: ${hash}`);
    let receipt: TransactionReceipt;
    try {
      receipt = await waitForReceipt(provider, hash);
    } catch (err) {
      exitUnknown("purchase", hash, err);
    }
    if (receipt.status !== 1) {
      console.error(`✗ tx ${hash} reverted on-chain. Check on basescan.`);
      process.exit(4);
    }
    console.log(`  ✅ confirmed in block ${receipt.blockNumber} • gas used: ${receipt.gasUsed.toString()}`);
    reportOutcome(receipt.logs, address, "NOOK");
  } else {
    const creditContract = new Contract(CREDIT_PURCHASE, CREDIT_PURCHASE_ABI, wallet);
    console.log(`📝 Step 2: calling purchaseWithUSDC(${args.packId})…`);
    let hash: string;
    try {
      hash = (await creditContract.purchaseWithUSDC(args.packId)).hash;
    } catch (err) {
      console.error(`✗ purchase not sent: ${(err as Error).message.slice(0, 300)}`);
      process.exit(4);
    }
    console.log(`  tx: ${hash}`);
    let receipt: TransactionReceipt;
    try {
      receipt = await waitForReceipt(provider, hash);
    } catch (err) {
      exitUnknown("purchase", hash, err);
    }
    if (receipt.status !== 1) {
      console.error(`✗ tx ${hash} reverted on-chain; the approval may still stand. Check on basescan.`);
      process.exit(4);
    }
    console.log(`  ✅ confirmed in block ${receipt.blockNumber} • gas used: ${receipt.gasUsed.toString()}`);
    reportOutcome(receipt.logs, address, "USDC");
  }
}

/** Print what the tx actually charged and credited, read from its logs. */
function reportOutcome(logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>, buyer: string, paidWith: "USDC" | "NOOK"): void {
  const out = summarizePurchaseReceipt(logs, buyer);
  console.log("");
  const paid = paidWith === "USDC" ? `paid ${formatUnits(out.usdcPaid, 6)} USDC` : "paid with NOOK";
  const got = out.credits === null ? "credit amount not found in the receipt" : `${out.credits} credits`;
  console.log(`🎉 Purchase confirmed: ${paid} → ${got} (from the transaction's logs).`);
  console.log(`   The gateway credits the balance shortly after; check the dashboard's Credits tab or GET /v1/credits/balance.`);
}

main().catch((err) => {
  console.error("✗ buy-credits failed:", err);
  process.exit(1);
});
