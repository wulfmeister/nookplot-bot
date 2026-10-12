/**
 * The on-chain side of settlement: Nookplot's MiningRewardPool on Base.
 *
 * Why (2026-10-12): no Merkle root since 2026-09-02, and the gateway gives no
 * reason. The pool's verified source (Sourcify, implementation
 * 0x324ce78a9ccedae0d2f76c111775e403d17006fd, solc 0.8.24) answers it:
 * publishRoot reverts with InsolventRoot when the obligations it would leave
 * unclaimed exceed the pool's NOOK balance, and with ExceedsMaxEpochPayout
 * when one root adds more than maxEpochPayout (50M). After the 09-02 root the
 * pool had 4,849,967 NOOK to spare, under one day of new credits, and nothing
 * has been added since. Only Nookplot can fix that (top up the pool; raise
 * the cap or publish catch-up roots of at most 50M an hour apart).
 *
 * What WE can do: claim directly from our wallet with our own gas once a root
 * covers us. claim() is permissionless (the leaf is keyed to msg.sender), so it
 * doesn't need the gateway's relayer, which was down to ~4 days of ETH on
 * 10-12.
 */
import { Contract, type Provider } from "ethers";

export const MINING_REWARD_POOL = "0x3632428a9878d2b58f58f9ef7c57cb0ee5760a01";
/** The EOA that sends the gateway's "gasless" relayed transactions. */
export const GATEWAY_RELAYER = "0x9f1045d983a6ac1faea82fe9314b47de73515d1a";

export const MINING_REWARD_POOL_ABI = [
  "function merkleRoot() view returns (bytes32)",
  "function epoch() view returns (uint256)",
  "function lastRootPublishedAt() view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function totalCommitted() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function unclaimedObligations() view returns (uint256)",
  "function maxEpochPayout() view returns (uint256)",
  "function paused() view returns (bool)",
  "function claimable() view returns (bool)",
  "function cumulativeClaimed(address) view returns (uint256)",
  "function claim(uint256 cumulativeAmount, bytes32[] proof)",
];

export interface PoolState {
  merkleRoot: string;
  /** The contract's own counter; the gateway's epochNumber runs 2 ahead. */
  epoch: number;
  lastRootPublishedAt: string;
  /** NOOK base units (18 decimals). */
  poolBalance: bigint;
  totalCommitted: bigint;
  totalClaimed: bigint;
  unclaimedObligations: bigint;
  /** poolBalance − unclaimedObligations: the most a new root may add. */
  headroom: bigint;
  /** 0 means no cap. */
  maxEpochPayout: bigint;
  paused: boolean;
  claimable: boolean;
}

export async function readPoolState(provider: Provider): Promise<PoolState> {
  const pool = new Contract(MINING_REWARD_POOL, MINING_REWARD_POOL_ABI, provider);
  const [merkleRoot, epoch, last, poolBalance, totalCommitted, totalClaimed, unclaimed, maxEpochPayout, paused, claimable] =
    await Promise.all([
      pool.merkleRoot(), pool.epoch(), pool.lastRootPublishedAt(), pool.poolBalance(), pool.totalCommitted(),
      pool.totalClaimed(), pool.unclaimedObligations(), pool.maxEpochPayout(), pool.paused(), pool.claimable(),
    ]);
  const bal = BigInt(poolBalance), unc = BigInt(unclaimed);
  return {
    merkleRoot: String(merkleRoot),
    epoch: Number(epoch),
    lastRootPublishedAt: new Date(Number(last) * 1000).toISOString(),
    poolBalance: bal,
    totalCommitted: BigInt(totalCommitted),
    totalClaimed: BigInt(totalClaimed),
    unclaimedObligations: unc,
    headroom: bal > unc ? bal - unc : 0n,
    maxEpochPayout: BigInt(maxEpochPayout),
    paused: Boolean(paused),
    claimable: Boolean(claimable),
  };
}

/**
 * Pure: could Nookplot publish a root that adds `newCommitments` right now?
 * Mirrors publishRoot's checks, apart from the cooldown and the caller check.
 */
export function rootWouldPass(newCommitments: bigint, s: Pick<PoolState, "headroom" | "maxEpochPayout" | "paused">): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (s.paused) reasons.push("the pool is paused");
  if (s.maxEpochPayout > 0n && newCommitments > s.maxEpochPayout) reasons.push("over the per-root cap (ExceedsMaxEpochPayout)");
  if (newCommitments > s.headroom) reasons.push("more than the pool's spare NOOK (InsolventRoot)");
  return { ok: reasons.length === 0, reasons };
}

export type DirectClaimPlan =
  | { action: "claim"; delta: bigint }
  | { action: "none"; reason: string };

/**
 * Pure: should `npm run stake -- claim-direct` send a transaction?
 * proofRoot / proofCumulative come from GET /v1/mining/proof; the rest is read
 * from the pool.
 */
export function planDirectClaim(p: {
  proofRoot: string | null | undefined;
  proofCumulative: bigint | null;
  onChainRoot: string;
  alreadyClaimed: bigint;
  paused: boolean;
  claimable: boolean;
}): DirectClaimPlan {
  if (p.paused) return { action: "none", reason: "the pool is paused" };
  if (!p.claimable) return { action: "none", reason: "claiming is switched off on the pool" };
  if (!p.proofRoot || p.proofCumulative === null) return { action: "none", reason: "the gateway has no Merkle proof for this wallet" };
  if (p.proofRoot.toLowerCase() !== p.onChainRoot.toLowerCase()) {
    return { action: "none", reason: `the gateway's proof is for root ${p.proofRoot.slice(0, 10)}…, but the pool holds ${p.onChainRoot.slice(0, 10)}…; wait for the gateway to catch up` };
  }
  if (p.proofCumulative <= p.alreadyClaimed) {
    return { action: "none", reason: "everything this root owes the wallet is already claimed; a new root is needed" };
  }
  return { action: "claim", delta: p.proofCumulative - p.alreadyClaimed };
}
