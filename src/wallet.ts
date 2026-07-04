/**
 * Wallet balance lookups via direct Base RPC.
 *
 * Used to verify on-chain settlement (e.g. after `claimMiningOnChain`).
 * The gateway does NOT expose a wallet-balance endpoint (`/v1/token/balance`
 * 404s) so we go straight to Base via ethers.
 *
 * Cached for 30s — these reads are stable and we don't want to hammer the
 * RPC on every dashboard refresh.
 */
import { JsonRpcProvider, Contract, formatUnits, formatEther } from "ethers";

const RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const NOOK_ADDRESS = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

interface CachedBalance {
  ts: number;
  data: WalletBalances;
}
let cache: CachedBalance | null = null;
const CACHE_TTL_MS = 30_000;

export interface WalletBalances {
  address: string;
  nook: number;
  nookFormatted: string;
  eth: number;
  ethFormatted: string;
  blockNumber: number;
  rpcUrl: string;
  fetchedAt: string;
}

/** Get NOOK + ETH balances on Base. Cached 30s. */
export async function getWalletBalances(address: string): Promise<WalletBalances | null> {
  if (!address || !address.startsWith("0x")) return null;
  const now = Date.now();
  if (cache && cache.data.address === address.toLowerCase() && now - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }
  try {
    const provider = new JsonRpcProvider(RPC_URL);
    const nook = new Contract(NOOK_ADDRESS, ERC20_ABI, provider);
    const [rawBal, ethBal, block] = await Promise.all([
      nook.balanceOf(address) as Promise<bigint>,
      provider.getBalance(address),
      provider.getBlockNumber(),
    ]);
    // NOOK is ERC-20 with 18 decimals
    const nookHuman = Number(formatUnits(rawBal, 18));
    const ethHuman = Number(formatEther(ethBal));
    const out: WalletBalances = {
      address: address.toLowerCase(),
      nook: nookHuman,
      nookFormatted: `${nookHuman.toLocaleString(undefined, { maximumFractionDigits: 4 })} NOOK`,
      eth: ethHuman,
      ethFormatted: `${ethHuman.toFixed(6)} ETH`,
      blockNumber: block,
      rpcUrl: RPC_URL,
      fetchedAt: new Date().toISOString(),
    };
    cache = { ts: now, data: out };
    return out;
  } catch (err) {
    console.warn(`wallet balance fetch failed: ${(err as Error).message}`);
    return null;
  }
}
