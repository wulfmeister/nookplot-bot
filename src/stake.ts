import "dotenv/config";
import { ethers } from "ethers";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prepareSignRelay, preparePermitStakeRelay } from "@nookplot/mcp/signing";
import { isMaintenanceError } from "./gateway-maintenance.js";
import { GATEWAY_RELAYER, MINING_REWARD_POOL, MINING_REWARD_POOL_ABI, planDirectClaim, readPoolState, rootWouldPass } from "./settlement-pool.js";
import { MINING_STAKE, MINING_STAKE_ABI, parseUnstakeAmount, planUnstake, readStakeContract, unstakeAvailableAt, type UnstakePlan } from "./stake-direct.js";
import { exitUnknown, waitForReceipt } from "./tx-wait.js";

const NOOK_ADDRESS = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const NOOK_DECIMALS = 18;

const GATEWAY = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
const SITE = process.env.NOOKPLOT_SITE_URL ?? "https://nookplot.com";
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
    if (isMaintenanceError((err as Error).message)) console.warn("     The gateway is paused; `npm run stake -- stake-onchain` reads the stake from the contract.");
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

type ProofResponse = { hasProof?: boolean; cumulativeAmountRaw?: string; proof?: string[]; merkleRoot?: string; epochNumber?: number; publishedAt?: string };

/** A gateway that is paused, down or unreachable, as opposed to one that answered with an error. */
function gatewayUnavailable(msg: string): boolean {
  return isMaintenanceError(msg) || /failed \(5\d\d\)/.test(msg) || /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|aborted|timeout/i.test(msg);
}

/**
 * This wallet's Merkle proof: the gateway's, or nookplot.com's when the
 * gateway can't answer (2026-10-31). The pause page serves the same proof
 * shape for the root it publishes, and planDirectClaim still refuses a proof
 * whose root isn't the pool's.
 */
async function fetchProof(): Promise<{ proof: ProofResponse; source: string }> {
  try {
    return { proof: await gatewayGet<ProofResponse>(`/v1/mining/proof/${AGENT_ADDR}`), source: "the gateway" };
  } catch (err) {
    const msg = (err as Error).message;
    if (!gatewayUnavailable(msg)) throw err;
    const res = await fetch(`${SITE}/api/proof/${AGENT_ADDR}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the gateway can't answer (${msg.slice(0, 80)}) and ${SITE}'s proof lookup failed (${res.status})`);
    return { proof: (await res.json()) as ProofResponse, source: `${new URL(SITE).host} (the gateway can't answer)` };
  }
}

/**
 * Read-only: where on-chain settlement stands and, if it's stuck, why
 * (2026-10-12). Compares the gateway's proof with the MiningRewardPool.
 */
async function cmdSettlement() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const [pool, fetched, claimed, relayerEth] = await Promise.all([
    readPoolState(provider),
    fetchProof().catch(() => null),
    new ethers.Contract(MINING_REWARD_POOL, MINING_REWARD_POOL_ABI, provider).cumulativeClaimed(AGENT_ADDR) as Promise<bigint>,
    provider.getBalance(GATEWAY_RELAYER),
  ]);
  const proof = fetched?.proof ?? null;
  const ageDays = Math.floor((Date.now() - Date.parse(pool.lastRootPublishedAt)) / 86_400_000);
  console.log(`
MiningRewardPool ${MINING_REWARD_POOL}`);
  console.log(`  newest root    ${pool.merkleRoot.slice(0, 18)}… (contract epoch ${pool.epoch}), published ${pool.lastRootPublishedAt} (${ageDays} days ago)`);
  console.log(`  pool balance   ${fmtNook(pool.poolBalance)} NOOK`);
  console.log(`  owed, unclaimed ${fmtNook(pool.unclaimedObligations)} NOOK`);
  console.log(`  spare          ${fmtNook(pool.headroom)} NOOK  ← the most a new root may add`);
  console.log(`  per-root cap   ${pool.maxEpochPayout > 0n ? fmtNook(pool.maxEpochPayout) + " NOOK" : "none"}`);
  console.log(`  paused ${pool.paused}, claimable ${pool.claimable}`);
  console.log(`
This wallet: ${fmtNook(claimed)} NOOK claimed on-chain`);
  if (proof?.proof && proof.cumulativeAmountRaw) {
    const cum = BigInt(proof.cumulativeAmountRaw);
    console.log(`  proof          ${fmtNook(cum)} NOOK cumulative, gateway epoch ${proof.epochNumber ?? "?"}, root ${String(proof.merkleRoot).slice(0, 18)}…, from ${fetched?.source}`);
    const plan = planDirectClaim({ proofRoot: proof.merkleRoot, proofCumulative: cum, onChainRoot: pool.merkleRoot, alreadyClaimed: claimed, paused: pool.paused, claimable: pool.claimable });
    console.log(plan.action === "claim"
      ? `  → ${fmtNook(plan.delta)} NOOK claimable now: npm run stake -- claim-direct`
      : `  → nothing to claim: ${plan.reason}`);
  } else {
    console.log("  proof          none returned (gateway or nookplot.com)");
  }
  console.log(`
Gateway relayer ${GATEWAY_RELAYER}: ${Number(ethers.formatEther(relayerEth)).toFixed(6)} ETH for gas`);
  const ethBal = await provider.getBalance(AGENT_ADDR);
  console.log(`This wallet: ${Number(ethers.formatEther(ethBal)).toFixed(6)} ETH, enough for claim-direct if the relayer runs dry`);
  const oneDay = 4_850_000n * 10n ** 18n;
  const pass = rootWouldPass(oneDay, pool);
  console.log(`
Could Nookplot publish a root adding one day of credits (~4.85M)? ${pass.ok ? "yes" : `no: ${pass.reasons.join("; ")}`}`);
}

/**
 * Claim straight from this wallet with our own gas (2026-10-12): claim() is
 * permissionless, so this works when the gateway relayer is out of ETH.
 * Refuses unless the proof matches the on-chain root and there is something
 * new to claim; simulates before asking. The proof comes from nookplot.com
 * while the gateway can't answer (2026-10-31).
 */
async function cmdClaimDirect() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const poolC = new ethers.Contract(MINING_REWARD_POOL, MINING_REWARD_POOL_ABI, signer);
  const [pool, fetched, claimed] = await Promise.all([
    readPoolState(provider),
    fetchProof(),
    poolC.cumulativeClaimed(AGENT_ADDR) as Promise<bigint>,
  ]);
  const proof = fetched.proof;
  const cum = proof?.cumulativeAmountRaw ? BigInt(proof.cumulativeAmountRaw) : null;
  const plan = planDirectClaim({ proofRoot: proof?.merkleRoot, proofCumulative: cum, onChainRoot: pool.merkleRoot, alreadyClaimed: claimed, paused: pool.paused, claimable: pool.claimable });
  if (plan.action !== "claim") {
    console.log(`Nothing to claim: ${plan.reason}. (Newest root published ${pool.lastRootPublishedAt}.)`);
    return;
  }
  // Simulate first: a revert here costs nothing.
  await poolC.claim.staticCall(cum, proof.proof);
  const gas = await poolC.claim.estimateGas(cum, proof.proof);
  const fee = await provider.getFeeData();
  const maxCost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  const ethBal = await provider.getBalance(AGENT_ADDR);
  console.log(`
About to claim ${fmtNook(plan.delta)} NOOK directly from ${AGENT_ADDR}`);
  console.log(`  pool ${MINING_REWARD_POOL}, root ${pool.merkleRoot.slice(0, 18)}…, proof from ${fetched.source}`);
  console.log(`  gas ~${gas.toString()}, at most ${ethers.formatEther(maxCost)} ETH (wallet has ${ethers.formatEther(ethBal)})`);
  if (ethBal < maxCost) throw new Error("not enough ETH in the wallet for gas");
  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return;
  }
  let hash: string;
  try {
    hash = (await poolC.claim(cum, proof.proof)).hash;
  } catch (err) {
    console.error(`✗ claim not sent: ${(err as Error).message.slice(0, 300)}`);
    process.exit(4);
  }
  console.log(`  tx: ${hash}`);
  let rcpt: ethers.TransactionReceipt;
  try {
    rcpt = await waitForReceipt(provider, hash);
  } catch (err) {
    exitUnknown("claim", hash, err);
  }
  if (rcpt.status !== 1) {
    console.error(`✗ claim tx ${hash} reverted. Check https://basescan.org/tx/${hash}`);
    process.exit(4);
  }
  console.log(`✓ claimed ${fmtNook(plan.delta)} NOOK in block ${rcpt.blockNumber}`);
  console.log(`  BaseScan: https://basescan.org/tx/${hash}`);
}

const nowSec = () => Math.floor(Date.now() / 1000);
const utc = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * Read-only (2026-10-31): the stake as MiningStake records it, and what each
 * -direct command would do now, simulated as this wallet. Needs no gateway.
 */
async function cmdStakeOnchain() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const [c, ethBal] = await Promise.all([readStakeContract(provider, AGENT_ADDR), provider.getBalance(AGENT_ADDR)]);
  const s = c.stake, now = nowSec();
  console.log(`\nMiningStake ${MINING_STAKE}${c.paused ? "  ⚠ PAUSED by its owner" : ""}`);
  console.log(`  staked      ${fmtNook(s.amount)} NOOK, tier ${c.tier}${s.stakedAt ? `, since ${utc(s.stakedAt)}` : ""}`);
  if (s.unstakeRequestedAt) {
    const ready = unstakeAvailableAt(s);
    console.log(`  unstaking   ${fmtNook(s.unstakeAmount)} NOOK, requested ${utc(s.unstakeRequestedAt)}, withdrawable ${now >= ready ? "now" : `from ${utc(ready)}`}`);
  } else {
    console.log("  unstaking   nothing pending");
  }
  if (s.slashedAt) console.log(`  slashed     ${utc(s.slashedAt)}`);
  console.log(`  cooldown    ${(c.cooldown / 86_400).toFixed(1)} days for a new request`);
  console.log(`  wallet gas  ${Number(ethers.formatEther(ethBal)).toFixed(6)} ETH`);
  // eth_call as this wallet: nothing is signed or sent.
  const sc = new ethers.Contract(MINING_STAKE, MINING_STAKE_ABI, provider);
  const checks: [string, UnstakePlan, () => Promise<unknown>][] = [
    ["unstake-direct all", planUnstake("request", c, now, s.amount), () => sc.requestUnstake.staticCall(s.amount, { from: AGENT_ADDR })],
    ["cancel-unstake-direct", planUnstake("cancel", c, now), () => sc.cancelUnstake.staticCall({ from: AGENT_ADDR })],
    ["complete-unstake-direct", planUnstake("complete", c, now), () => sc.completeUnstake.staticCall({ from: AGENT_ADDR })],
  ];
  console.log("");
  for (const [name, plan, simulate] of checks) {
    if (plan.action === "none") {
      console.log(`  ${name.padEnd(24)} would refuse: ${plan.reason}`);
      continue;
    }
    const verdict = await simulate().then(
      () => "the contract would accept it (simulated, nothing sent)",
      (err) => `the contract would revert: ${(err as Error).message.slice(0, 120)}`,
    );
    console.log(`  ${name.padEnd(24)} ${verdict}`);
  }
  console.log("");
}

/** Simulate, show, ask, send, wait: shared by the three -direct stake commands. */
async function sendStakeTx(label: string, fn: "requestUnstake" | "cancelUnstake" | "completeUnstake", args: unknown[], lines: string[]): Promise<boolean> {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const c = new ethers.Contract(MINING_STAKE, MINING_STAKE_ABI, signer);
  // Simulate first: a revert here costs nothing.
  await c[fn].staticCall(...args);
  const gas: bigint = await c[fn].estimateGas(...args);
  const fee = await provider.getFeeData();
  const maxCost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  const ethBal = await provider.getBalance(AGENT_ADDR);
  console.log("");
  for (const l of lines) console.log(l);
  console.log(`  gas ~${gas.toString()}, at most ${ethers.formatEther(maxCost)} ETH (wallet has ${ethers.formatEther(ethBal)})`);
  if (ethBal < maxCost) throw new Error("not enough ETH in the wallet for gas");
  if (!(await confirm("Proceed?"))) {
    console.log("aborted.");
    return false;
  }
  let hash: string;
  try {
    hash = (await c[fn](...args)).hash;
  } catch (err) {
    console.error(`✗ ${label} not sent: ${(err as Error).message.slice(0, 300)}`);
    process.exit(4);
  }
  console.log(`  tx: ${hash}`);
  let rcpt: ethers.TransactionReceipt;
  try {
    rcpt = await waitForReceipt(provider, hash);
  } catch (err) {
    exitUnknown(label, hash, err);
  }
  if (rcpt.status !== 1) {
    console.error(`✗ ${label} tx ${hash} reverted. Check https://basescan.org/tx/${hash}`);
    process.exit(4);
  }
  console.log(`✓ ${label} confirmed in block ${rcpt.blockNumber}`);
  console.log(`  BaseScan: https://basescan.org/tx/${hash}`);
  return true;
}

/** Request an unstake straight from this wallet, paying its own gas (2026-10-31; stake-direct.ts). */
async function cmdUnstakeDirect(amountArg?: string) {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const c = await readStakeContract(provider, AGENT_ADDR);
  const plan = planUnstake("request", c, nowSec(), parseUnstakeAmount(amountArg, c.stake.amount));
  if (plan.action !== "request") {
    console.log(`Not sending: ${plan.reason}.`);
    return;
  }
  const left = c.stake.amount - plan.amount;
  await sendStakeTx("unstake request", "requestUnstake", [plan.amount], [
    `About to REQUEST an unstake of ${fmtNook(plan.amount)} NOOK, straight from ${AGENT_ADDR} (no gateway needed)`,
    `  staked now ${fmtNook(c.stake.amount)} NOOK, tier ${c.tier}; ${left > 0n ? `${fmtNook(left)} NOOK stays staked` : "nothing stays staked"}`,
    `  withdrawable from ${utc(plan.availableAt)} (${(c.cooldown / 86_400).toFixed(1)}-day cooldown) with complete-unstake-direct`,
    "  until then the NOOK stays locked, the gateway stops reward accrual, and the agent leaves its mining guild",
    "  cancel-unstake-direct undoes the request; the guild seat comes back only if the guild still has room",
  ]);
}

async function cmdCancelUnstakeDirect() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const plan = planUnstake("cancel", await readStakeContract(provider, AGENT_ADDR), nowSec());
  if (plan.action !== "cancel") {
    console.log(`Not sending: ${plan.reason}.`);
    return;
  }
  await sendStakeTx("unstake cancel", "cancelUnstake", [], [
    `About to CANCEL the pending unstake of ${fmtNook(plan.amount)} NOOK, straight from ${AGENT_ADDR}`,
    "  the NOOK goes back to active stake and the gateway resumes reward accrual",
    "  the mining-guild seat comes back only if the guild still has room; otherwise rejoin by hand",
  ]);
}

async function cmdCompleteUnstakeDirect() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const plan = planUnstake("complete", await readStakeContract(provider, AGENT_ADDR), nowSec());
  if (plan.action !== "complete") {
    console.log(`Not sending: ${plan.reason}.`);
    return;
  }
  const sent = await sendStakeTx("unstake completion", "completeUnstake", [], [
    `About to WITHDRAW ${fmtNook(plan.amount)} NOOK from stake to ${AGENT_ADDR}`,
    `  ${plan.remaining > 0n ? `${fmtNook(plan.remaining)} NOOK stays staked` : "nothing stays staked afterwards"}`,
  ]);
  if (sent) console.log(`  wallet now holds ${fmtNook((await readBalances()).nook)} NOOK`);
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
  npm run stake -- claim [sourceType]           Claim earned NOOK to wallet (gasless, via the gateway relayer)
  npm run stake -- claim-direct                 Claim straight from this wallet with our own ETH gas
                                                (uses nookplot.com's proof when the gateway can't answer)
  npm run stake -- settlement                   Read-only: where on-chain settlement stands, and why
  npm run stake -- stake-onchain                Read-only: the stake as the staking contract records it
  npm run stake -- unstake-direct <amount|all>  Request unstake straight from this wallet with its own ETH gas
  npm run stake -- cancel-unstake-direct        Cancel a pending unstake, the same way
  npm run stake -- complete-unstake-direct      Withdraw after the 7-day cooldown, the same way
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
    case "claim-direct":
      await cmdClaimDirect();
      break;
    case "settlement":
      await cmdSettlement();
      break;
    case "stake-onchain":
      await cmdStakeOnchain();
      break;
    case "unstake-direct":
      if (!args[0]) usage();
      await cmdUnstakeDirect(args[0]);
      break;
    case "cancel-unstake-direct":
      await cmdCancelUnstakeDirect();
      break;
    case "complete-unstake-direct":
      await cmdCompleteUnstakeDirect();
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
  const msg = String(err?.message ?? err);
  console.error(`✗ ${msg}`);
  if (isMaintenanceError(msg)) {
    console.error("  Nookplot's gateway is paused. These work without it: settlement, claim-direct, stake-onchain, unstake-direct, cancel-unstake-direct, complete-unstake-direct.");
  }
  process.exit(1);
});
