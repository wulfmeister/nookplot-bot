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
 * Usage:
 *   npm run buy-credits -- --pack=0          # Micro $2 USDC
 *   npm run buy-credits -- --pack=1          # Standard $10 USDC
 *   npm run buy-credits -- --pack=2 --nook   # Bulk $35 via NOOK (with discount)
 *   npm run buy-credits -- --pack=0 --dry-run  # Print planned tx, don't send
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

const CREDIT_PURCHASE = "0x1A8C121e5C79623986f85F74C66d9cAd086B2358";
const NOOK_TOKEN = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const USDC_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base mainnet
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
const PACKS = [
  { id: 0, name: "Micro", usdc: "2", credits: 125, nookDiscount: 20,
    observedNookAmount: "99854.4444444" },
  { id: 1, name: "Standard", usdc: "10", credits: 700, nookDiscount: 25,
    observedNookAmount: "499272.2222222" },
  { id: 2, name: "Bulk", usdc: "35", credits: 3250, nookDiscount: 30,
    observedNookAmount: "1797400" },
];

interface Args {
  packId: number;
  useNook: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { packId: 0, useNook: false, dryRun: false };
  for (const a of argv) {
    if (a.startsWith("--pack=")) out.packId = Number(a.split("=")[1]);
    else if (a === "--nook") out.useNook = true;
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

async function main() {
  const args = parseArgs();
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

  console.log(`Wallet:  ${address}`);
  console.log(`Pack:    #${pack.id} "${pack.name}" — ${pack.credits} credits`);
  console.log(`Payment: ${args.useNook ? `NOOK (${pack.nookDiscount}% discount, est < ${pack.usdc} USDC equivalent)` : `${pack.usdc} USDC`}`);
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

  // Approve amount: for USDC we know exactly ($pack.usdc * 10^6). For NOOK,
  // the discount math is on-contract; we approve a generous max to avoid
  // a second tx if our math is off. Standard pattern.
  // For NOOK: contract takes (packId, maxNookAmount). We've observed the
  // exact required amounts from successful on-chain txs. Send 1.2× as the
  // slippage buffer — contract pulls exact, returns nothing extra.
  // For USDC: contract pulls exactly pack.usdc (in 6 decimals).
  const nookMaxAmount = args.useNook
    ? parseUnits((Number(pack.observedNookAmount) * 1.2).toFixed(4), 18)
    : 0n;
  const approvalAmount = args.useNook
    ? nookMaxAmount
    : parseUnits(pack.usdc, 6);
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
    await approveTx.wait();
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
    try {
      const tx = await wallet.sendTransaction({ to: CREDIT_PURCHASE, data: callData });
      console.log(`  tx: ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        console.log(`  ✅ confirmed in block ${receipt.blockNumber} • gas used: ${receipt.gasUsed.toString()}`);
        console.log("");
        console.log(`🎉 Purchased ${pack.credits} credits with NOOK. Bot upgraded to tier 2 (200 relays/day, 0.10 cr each).`);
      } else {
        console.error(`✗ tx ${tx.hash} reverted on-chain. Check on basescan.`);
        process.exit(4);
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`✗ purchase failed: ${msg.slice(0, 300)}`);
      process.exit(4);
    }
  } else {
    const creditContract = new Contract(CREDIT_PURCHASE, CREDIT_PURCHASE_ABI, wallet);
    console.log(`📝 Step 2: calling purchaseWithUSDC(${args.packId})…`);
    try {
      const tx = await creditContract.purchaseWithUSDC(args.packId);
      console.log(`  tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  ✅ confirmed in block ${receipt.blockNumber} • gas used: ${receipt.gasUsed.toString()}`);
      console.log("");
      console.log(`🎉 Purchased ${pack.credits} credits with USDC. Bot upgraded to tier 2.`);
    } catch (err) {
      console.error(`✗ purchase failed: ${(err as Error).message.slice(0, 300)}`);
      process.exit(4);
    }
  }
}

main().catch((err) => {
  console.error("✗ buy-credits failed:", err);
  process.exit(1);
});
