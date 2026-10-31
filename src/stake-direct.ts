/**
 * Unstaking without the gateway (2026-10-31).
 *
 * `npm run stake -- unstake` asks the gateway to prepare a relayed
 * transaction. While Nookplot is paused (503 since 2026-10-22) that can't
 * work, and the relayer is out of gas anyway. MiningStake needs neither: its
 * unstake functions act on the caller (ERC2771 _msgSender() is the caller
 * itself on a direct call), so this wallet can call them and pay its own gas.
 *
 * Checked on 2026-10-31 against the verified source of the deployed
 * implementation (0x01a78b1b596017122E0cab2da35c16645c71688B, Sourcify exact
 * match; proxy 0x1Fcf45C74C7609Ccf647B678b2116e2CccD9C317):
 *
 * - requestUnstake(amount) starts the cooldown (7 days, fixed at request
 *   time). The tokens stay locked meanwhile, the agent leaves its mining guild,
 *   and the gateway stops reward accrual. Reverts ZeroAmount / NotStaked /
 *   UnstakeAlreadyRequested / InsufficientStake.
 * - cancelUnstake() returns to active stake. The guild seat comes back only if
 *   the guild still has room.
 * - completeUnstake() sends the NOOK to the wallet once the cooldown is over.
 *   Reverts NoUnstakeRequested / CooldownNotElapsed.
 *
 * All three are whenNotPaused, and the owner can also waive a cooldown, slash
 * a stake, or upgrade the contract. The operator runs these by hand.
 */
import { Contract, parseUnits, type Provider } from "ethers";

export const MINING_STAKE = "0x1Fcf45C74C7609Ccf647B678b2116e2CccD9C317";

export const MINING_STAKE_ABI = [
  "function getStakeInfo(address) view returns (tuple(uint256 amount, uint256 stakedAt, uint256 unstakeRequestedAt, uint256 unstakeAmount, uint256 unstakeCooldownSnapshot, uint256 slashedAt))",
  "function getTier(address) view returns (uint8)",
  "function getMultiplier(address) view returns (uint256)",
  "function unstakeCooldown() view returns (uint256)",
  "function paused() view returns (bool)",
  "function requestUnstake(uint256 amount)",
  "function cancelUnstake()",
  "function completeUnstake()",
];

export interface OnChainStake {
  /** NOOK base units (18 decimals). */
  amount: bigint;
  /** Unix seconds; 0 = never staked. */
  stakedAt: number;
  /** Unix seconds; 0 = no request open. */
  unstakeRequestedAt: number;
  unstakeAmount: bigint;
  /** Cooldown in seconds, fixed when the request was made. */
  cooldownSnapshot: number;
  slashedAt: number;
}

export interface StakeContractState {
  stake: OnChainStake;
  tier: number;
  /** Basis points: 100 = 1x, 175 = 1.75x; 0 below the lowest tier. */
  multiplierBps: number;
  /** Cooldown a new request would get, in seconds. */
  cooldown: number;
  paused: boolean;
}

export async function readStakeContract(provider: Provider, address: string): Promise<StakeContractState> {
  const c = new Contract(MINING_STAKE, MINING_STAKE_ABI, provider);
  const [info, tier, mult, cooldown, paused] = await Promise.all([c.getStakeInfo(address), c.getTier(address), c.getMultiplier(address), c.unstakeCooldown(), c.paused()]);
  return {
    stake: {
      amount: BigInt(info.amount),
      stakedAt: Number(info.stakedAt),
      unstakeRequestedAt: Number(info.unstakeRequestedAt),
      unstakeAmount: BigInt(info.unstakeAmount),
      cooldownSnapshot: Number(info.unstakeCooldownSnapshot),
      slashedAt: Number(info.slashedAt),
    },
    tier: Number(tier),
    multiplierBps: Number(mult),
    cooldown: Number(cooldown),
    paused: Boolean(paused),
  };
}

/** Pure: "all", or a NOOK amount with up to 18 decimals, → base units. Throws on anything else. */
export function parseUnstakeAmount(arg: string | undefined, staked: bigint): bigint {
  const a = (arg ?? "").trim().toLowerCase().replace(/_/g, "");
  if (a === "all") return staked;
  if (!/^\d+(\.\d{1,18})?$/.test(a)) throw new Error(`amount must be a number of NOOK or "all", got "${arg ?? ""}"`);
  const v = parseUnits(a, 18);
  if (v <= 0n) throw new Error("amount must be more than 0");
  return v;
}

/** When a pending request's cooldown ends (unix seconds). */
export function unstakeAvailableAt(s: OnChainStake): number {
  return s.unstakeRequestedAt + s.cooldownSnapshot;
}

const at = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const span = (sec: number) => (sec >= 86_400 ? `${(sec / 86_400).toFixed(1)} days` : `${Math.ceil(sec / 3600)} hours`);

export type UnstakePlan =
  | { action: "request"; amount: bigint; availableAt: number }
  | { action: "cancel"; amount: bigint }
  | { action: "complete"; amount: bigint; remaining: bigint }
  | { action: "none"; reason: string };

/**
 * Pure: the contract's own checks, so a refusal comes with a plain reason
 * before anything is simulated or signed. The send still simulates first,
 * which catches anything this misses (e.g. a clock a few seconds off).
 */
export function planUnstake(kind: "request", c: StakeContractState, nowSec: number, amount?: bigint): Extract<UnstakePlan, { action: "request" | "none" }>;
export function planUnstake(kind: "cancel", c: StakeContractState, nowSec: number): Extract<UnstakePlan, { action: "cancel" | "none" }>;
export function planUnstake(kind: "complete", c: StakeContractState, nowSec: number): Extract<UnstakePlan, { action: "complete" | "none" }>;
export function planUnstake(kind: "request" | "cancel" | "complete", c: StakeContractState, nowSec: number, amount?: bigint): UnstakePlan {
  const s = c.stake;
  if (c.paused) return { action: "none", reason: "the staking contract is paused by its owner" };
  const pending = s.unstakeRequestedAt !== 0;
  if (kind === "request") {
    if (s.amount === 0n) return { action: "none", reason: "nothing is staked" };
    if (pending) return { action: "none", reason: `an unstake is already pending (withdrawable from ${at(unstakeAvailableAt(s))}); complete or cancel it first` };
    if (amount === undefined || amount <= 0n) return { action: "none", reason: "the amount must be more than 0" };
    if (amount > s.amount) return { action: "none", reason: "that is more than is staked" };
    return { action: "request", amount, availableAt: nowSec + c.cooldown };
  }
  if (!pending) return { action: "none", reason: "no unstake is pending" };
  if (kind === "cancel") return { action: "cancel", amount: s.unstakeAmount };
  const ready = unstakeAvailableAt(s);
  if (nowSec < ready) return { action: "none", reason: `the cooldown ends ${at(ready)}, ${span(ready - nowSec)} from now` };
  return { action: "complete", amount: s.unstakeAmount, remaining: s.amount - s.unstakeAmount };
}
