import "dotenv/config";
import { ethers } from "ethers";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prepareSignRelay, preparePermitStakeRelay } from "@nookplot/mcp/signing";

const NOOK_ADDRESS = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const NOOK_DECIMALS = 18;

const GATEWAY = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
const RPC = process.env.NOOKPLOT_RPC_URL ?? "https://mainnet.base.org";
const API_KEY = required("NOOKPLOT_API_KEY");
const PRIVATE_KEY = required("NOOKPLOT_AGENT_PRIVATE_KEY", "AGENT_PRIVATE_KEY");

const wallet = new ethers.Wallet(PRIVATE_KEY);
const AGENT_ADDR = wallet.address;

function required(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && !v.startsWith("0xreplace") && !v.includes("replace_me")) return v;
  }
  throw new Error(`Missing env: one of ${names.join(", ")} must be set`);
}

function fmtNook(wei: bigint): string {
  const whole = wei / 10n ** BigInt(NOOK_DECIMALS);
  const frac = wei % 10n ** BigInt(NOOK_DECIMALS);
  const fracStr = frac.toString().padStart(NOOK_DECIMALS, "0").slice(0, 4);
  return `${whole.toLocaleString()}.${fracStr}`;
}

async function gatewayGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Gateway GET ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

async function readBalances() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const nook = new ethers.Contract(
    NOOK_ADDRESS,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  );
  const [ethBal, nookBal] = await Promise.all([
    provider.getBalance(AGENT_ADDR),
    nook.balanceOf(AGENT_ADDR) as Promise<bigint>,
  ]);
  return { eth: ethBal, nook: nookBal };
}

async function readStake(): Promise<Record<string, unknown> | null> {
  try {
    return await gatewayGet(`/v1/mining/stake/${AGENT_ADDR}`);
  } catch (err) {
    console.warn(`   ⚠ stake read failed: ${(err as Error).message}`);
    return null;
  }
}

async function readRewards(): Promise<Record<string, unknown> | null> {
  try {
    return await gatewayGet(`/v1/mining/stats/agent/${AGENT_ADDR}`);
  } catch (err) {
    console.warn(`   ⚠ rewards read failed: ${(err as Error).message}`);
    return null;
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = (await rl.question(`${message} (yes/no): `)).trim().toLowerCase();
    return ans === "yes" || ans === "y";
  } finally {
    rl.close();
  }
}

function unwrapRelay(result: unknown): { txHash: string } {
  const r = result as { ok?: boolean; data?: { txHash?: string }; error?: string; status?: number };
  if (r?.ok === false) {
    throw new Error(`gateway relay failed (status=${r.status ?? "?"}): ${r.error ?? "unknown"}`);
  }
  if (r?.data?.txHash) return { txHash: r.data.txHash };
  if ((result as { txHash?: string }).txHash) return { txHash: (result as { txHash: string }).txHash };
  throw new Error(`relay returned unexpected shape: ${JSON.stringify(result).slice(0, 200)}`);
}

async function cmdStatus() {
  console.log(`\nAgent: ${AGENT_ADDR}`);
  console.log(`Gateway: ${GATEWAY}\n`);

  const bals = await readBalances();
  console.log("On-chain wallet (Base):");
  console.log(`  ETH:  ${ethers.formatEther(bals.eth)} (${bals.eth < 100_000_000_000_000n ? "⚠ low — may not cover sweep gas" : "ok"})`);
  console.log(`  NOOK: ${fmtNook(bals.nook)}\n`);

  const stake = await readStake();
  if (stake) {
    console.log("Mining stake:");
    // Gateway field is `stakedNook` (number). NOTE: there is also a `staked`
    // BOOLEAN field — never read that as the amount (it coerces to 1).
    const stakedAmount = (stake as { stakedNook?: number; stakedAmount?: number }).stakedNook
      ?? (stake as { stakedAmount?: number }).stakedAmount
      ?? 0;
    console.log(`  staked:     ${Number(stakedAmount).toLocaleString()} NOOK`);
    const tier = (stake as { tier?: number; currentTier?: number }).tier ?? (stake as { currentTier?: number }).currentTier;
    const mult = (stake as { multiplier?: number; rewardMultiplier?: number }).multiplier
      ?? (stake as { rewardMultiplier?: number }).rewardMultiplier;
    if (tier !== undefined) console.log(`  tier:       ${tier} (${mult ?? "?"}x multiplier)`);
    const nextThresh = (stake as { nextTierThreshold?: number }).nextTierThreshold;
    const nextNeed = (stake as { nookToNextTier?: number }).nookToNextTier;
    if (nextThresh) console.log(`  next tier:  ${Number(nextThresh).toLocaleString()} NOOK (need +${Number(nextNeed ?? 0).toLocaleString()})`);
    const reqAt = (stake as { unstakeRequestedAt?: string | null }).unstakeRequestedAt;
    if (reqAt) {
      const amt = (stake as { unstakeAmount?: number }).unstakeAmount;
      const hrs = (stake as { unstakeHoursRemaining?: number | null }).unstakeHoursRemaining;
      const availAt = (stake as { unstakeAvailableAt?: string }).unstakeAvailableAt;
      console.log(`  ⏳ pending unstake: ${Number(amt ?? 0).toLocaleString()} NOOK`);
      console.log(`      hours remaining: ${hrs ?? "?"}, available at ${availAt ?? "?"}`);
    } else {
      console.log(`  pending unstake: none`);
    }
  } else {
    console.log("Mining stake: (gateway returned no record — likely not yet staked)\n");
  }

  console.log("");
  const rewards = await readRewards();
  if (rewards) {
    const claimable = (rewards as { claimableBalance?: Record<string, number> }).claimableBalance ?? {};
    const pending = (rewards as { pendingRewards?: Record<string, number> }).pendingRewards ?? {};
    console.log("Mining rewards:");
    console.log(`  claimable: ${JSON.stringify(claimable)}`);
    console.log(`  pending:   ${JSON.stringify(pending)}`);
    const lifetime = (rewards as { lifetimeNookEarned?: number }).lifetimeNookEarned;
    if (lifetime !== undefined) console.log(`  lifetime NOOK earned: ${Number(lifetime).toLocaleString()}`);
  }
  console.log("");
}

async function cmdStake(amountStr: string) {
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`bad amount: ${amountStr}`);

  const bals = await readBalances();
  const requiredWei = ethers.parseUnits(String(amount), NOOK_DECIMALS);
  if (bals.nook < requiredWei) {
    throw new Error(`insufficient NOOK: have ${fmtNook(bals.nook)}, need ${amount.toLocaleString()}`);
  }

  console.log(`\nAbout to stake ${amount.toLocaleString()} NOOK from ${AGENT_ADDR}`);
  console.log(`  wallet balance: ${fmtNook(bals.nook)} NOOK`);
  console.log(`  remaining after stake: ${fmtNook(bals.nook - requiredWei)} NOOK`);
  console.log(`  flow: EIP-2612 permit + stake in one signed message (gasless, relayed)\n`);

  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }

  console.log("→ calling preparePermitStakeRelay…");
  const result = await preparePermitStakeRelay(GATEWAY, API_KEY, PRIVATE_KEY, { amount });
  const { txHash } = unwrapRelay(result);
  console.log(`✓ stake submitted: ${txHash}`);
  console.log(`  BaseScan: https://basescan.org/tx/${txHash}`);
}

async function cmdUnstake(amountStr: string) {
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`bad amount: ${amountStr}`);

  console.log(`\nAbout to REQUEST unstake of ${amount.toLocaleString()} NOOK`);
  console.log(`  cooldown: 7 days (irreversible-ish — can be cancelled before complete)`);
  console.log(`  blocked if there are submissions pending verification`);
  console.log(`  after cooldown: run "complete-unstake" to withdraw to wallet\n`);

  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }

  const result = await prepareSignRelay(GATEWAY, API_KEY, PRIVATE_KEY, "/v1/prepare/mining/unstake", {
    amount,
  });
  const { txHash } = unwrapRelay(result);
  console.log(`✓ unstake requested: ${txHash}`);
  console.log(`  BaseScan: https://basescan.org/tx/${txHash}`);
  console.log(`  Run "complete-unstake" after the 7-day cooldown.`);
}

async function cmdCancelUnstake() {
  console.log(`\nAbout to CANCEL pending unstake (returns tokens to active stake).\n`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }
  const result = await prepareSignRelay(GATEWAY, API_KEY, PRIVATE_KEY, "/v1/prepare/mining/unstake/cancel", {});
  const { txHash } = unwrapRelay(result);
  console.log(`✓ unstake cancelled: ${txHash}`);
}

async function cmdCompleteUnstake() {
  console.log(`\nAbout to COMPLETE unstake (withdraw NOOK to wallet).`);
  console.log(`  fails with hours-remaining if 7-day cooldown hasn't passed.\n`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }
  const result = await prepareSignRelay(GATEWAY, API_KEY, PRIVATE_KEY, "/v1/prepare/mining/unstake/complete", {});
  const { txHash } = unwrapRelay(result);
  console.log(`✓ unstake completed: ${txHash}`);
  console.log(`  NOOK returned to ${AGENT_ADDR}.`);
}

async function gatewayPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gateway POST ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

async function cmdClaim(sourceType?: string) {
  // Step 1: read claimable
  const stats = await readRewards();
  const claimable = (stats as { claimableBalance?: Record<string, number> } | null)?.claimableBalance ?? {};
  const sources = sourceType
    ? [sourceType]
    : Object.entries(claimable).filter(([, v]) => v > 0).map(([k]) => k);

  if (sources.length === 0) {
    const pending = (stats as { pendingRewards?: number } | null)?.pendingRewards ?? 0;
    if (pending > 0) {
      console.log(`No claimable balance yet. ${pending.toFixed(2)} NOOK pending — settles at end of current epoch (24h).`);
    } else {
      console.log("No claimable balance and no pending rewards.");
    }
    return;
  }

  const total = sources.reduce((sum, s) => sum + (claimable[s] ?? 0), 0);
  console.log(`\nAbout to CLAIM mining rewards:`);
  for (const s of sources) console.log(`  ${s}: ${(claimable[s] ?? 0).toFixed(2)} NOOK`);
  console.log(`  total: ${total.toFixed(2)} NOOK`);
  console.log(`  flow: mark-claimed (off-chain) → fetch Merkle proof → on-chain claim relayed\n`);

  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }

  // Step 2: mark claimed per source (off-chain ledger move)
  let totalClaimed = 0;
  for (const source of sources) {
    try {
      const result = await gatewayPost<{ claimed?: number }>("/v1/mining/royalties/claim", { sourceType: source });
      if (result.claimed) {
        totalClaimed += result.claimed;
        console.log(`  ✓ ${source}: ${result.claimed.toFixed(2)} NOOK marked claimed`);
      }
    } catch (err) {
      console.warn(`  ⚠ ${source}: ${(err as Error).message}`);
    }
  }
  if (totalClaimed <= 0) {
    console.log("✗ no claimable rewards confirmed by gateway.");
    return;
  }

  // Step 3: fetch Merkle proof
  let proofData: { cumulativeAmount?: number | string; cumulativeAmountRaw?: string; proof?: string[] };
  try {
    proofData = await gatewayGet<typeof proofData>(`/v1/mining/proof/${AGENT_ADDR}`);
  } catch (err) {
    console.log(`\n${totalClaimed.toFixed(2)} NOOK recorded off-chain.`);
    console.log(`On-chain claim pending — Merkle tree publishes hourly. Retry "claim" later.`);
    console.log(`(proof fetch error: ${(err as Error).message})`);
    return;
  }
  const cum = proofData.cumulativeAmount ?? proofData.cumulativeAmountRaw;
  if (!cum || !proofData.proof) {
    console.log(`\n${totalClaimed.toFixed(2)} NOOK recorded. Merkle proof not yet available — publishes hourly. Retry later.`);
    return;
  }

  // Step 4: on-chain claim via relay
  const body: Record<string, unknown> = { proof: proofData.proof };
  if (proofData.cumulativeAmountRaw) body.cumulativeAmountRaw = proofData.cumulativeAmountRaw;
  else body.cumulativeAmount = proofData.cumulativeAmount;

  const result = await prepareSignRelay(GATEWAY, API_KEY, PRIVATE_KEY, "/v1/prepare/mining/claim", body);
  const { txHash } = unwrapRelay(result);
  console.log(`✓ on-chain claim submitted: ${txHash}`);
  console.log(`  ${totalClaimed.toFixed(2)} NOOK arriving in wallet ${AGENT_ADDR}`);
  console.log(`  BaseScan: https://basescan.org/tx/${txHash}`);
}

async function cmdCompound() {
  console.log(`\nAbout to CLAIM + RESTAKE rewards atomically (compound).`);
  console.log(`  fails if you have a pending unstake — cancel it first.\n`);
  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }
  const result = await prepareSignRelay(GATEWAY, API_KEY, PRIVATE_KEY, "/v1/prepare/mining/claim-and-stake", {});
  const { txHash } = unwrapRelay(result);
  console.log(`✓ claim+restake submitted: ${txHash}`);
}

async function cmdSweep(toAddress: string, amountStr?: string) {
  if (!ethers.isAddress(toAddress)) throw new Error(`bad address: ${toAddress}`);

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const nook = new ethers.Contract(
    NOOK_ADDRESS,
    [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
    ],
    signer,
  );

  const bal: bigint = await nook.balanceOf(AGENT_ADDR);
  const sendWei = amountStr ? ethers.parseUnits(amountStr, NOOK_DECIMALS) : bal;
  if (sendWei > bal) throw new Error(`insufficient NOOK: have ${fmtNook(bal)}, asking ${fmtNook(sendWei)}`);
  if (sendWei <= 0n) throw new Error("nothing to sweep");

  const ethBal = await provider.getBalance(AGENT_ADDR);
  if (ethBal < 200_000_000_000_000n) {
    console.warn(`⚠ ETH balance ${ethers.formatEther(ethBal)} is low for gas — transaction may fail.`);
  }

  console.log(`\nAbout to SEND NOOK off this wallet:`);
  console.log(`  from: ${AGENT_ADDR}`);
  console.log(`  to:   ${toAddress}`);
  console.log(`  amt:  ${fmtNook(sendWei)} NOOK`);
  console.log(`  gas:  paid by THIS wallet in ETH (~$0.05 on Base)\n`);

  if (!(await confirm(`Send ${fmtNook(sendWei)} NOOK to ${toAddress}?`))) {
    console.log("aborted.");
    return;
  }

  const tx = await nook.transfer(toAddress, sendWei);
  console.log(`→ tx submitted: ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`✓ confirmed in block ${rcpt?.blockNumber}`);
  console.log(`  BaseScan: https://basescan.org/tx/${tx.hash}`);
}

function usage(): never {
  console.log(`
nookplot-bot stake — manage NOOK stake from this wallet

Usage:
  npm run stake -- status                       Show ETH + NOOK balance, stake tier, rewards
  npm run stake -- stake <amount>               Stake NOOK (gasless permit relay)
  npm run stake -- unstake <amount>             Request unstake (7-day cooldown starts)
  npm run stake -- cancel-unstake               Cancel pending unstake
  npm run stake -- complete-unstake             Withdraw after cooldown
  npm run stake -- claim [sourceType]           Claim earned NOOK to wallet
  npm run stake -- compound                     Claim + restake atomically
  npm run stake -- sweep <toAddress> [amount]   ERC-20 transfer NOOK out (needs ETH for gas)

All write ops prompt for "yes" confirmation before signing.
`);
  process.exit(1);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "status":
      await cmdStatus();
      break;
    case "stake":
      if (!args[0]) usage();
      await cmdStake(args[0]);
      break;
    case "unstake":
      if (!args[0]) usage();
      await cmdUnstake(args[0]);
      break;
    case "cancel-unstake":
      await cmdCancelUnstake();
      break;
    case "complete-unstake":
      await cmdCompleteUnstake();
      break;
    case "claim":
      await cmdClaim(args[0]);
      break;
    case "compound":
      await cmdCompound();
      break;
    case "sweep":
      if (!args[0]) usage();
      await cmdSweep(args[0], args[1]);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message ?? err}`);
  process.exit(1);
});
