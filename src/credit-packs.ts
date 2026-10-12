/**
 * Credit-pack pricing as the CreditPurchase contract actually charges it.
 *
 * Why (2026-10-11): `/v1/credits/packs` advertises Micro $2 → 125 credits,
 * Standard $10 → 700, Bulk $35 → 3,250. The contract's own `packs(id)` says
 * Micro $1 → 25, Standard $5 → 140, Bulk $20 → 650, and that is what a
 * purchase charges and credits: two Micro buys, months apart, each moved
 * 1 USDC and credited 25.00.
 * buy-credits.ts printed the advertised figures ("Purchased 125 credits",
 * "Payment: 2 USDC") and approved 2 USDC for a 1 USDC charge; the dashboard
 * showed the advertised prices too. Both now read the contract.
 *
 * Contract layout (decoded live 2026-10-11, no verified source):
 *   packs(uint256)  → (string name, uint256 usdcPrice [6dp], uint256 creditAmount [×100], bool active)
 *   getPackCount()  → uint256 (3)
 * Purchase event: topics [sig, buyer, packId], data word 0 = credits ×100,
 * word 1 = USDC paid [6dp]. Event name unknown, so the receipt parser keys
 * on the emitting address and the indexed buyer, not the signature.
 */
import { Contract, type Provider } from "ethers";

export const CREDIT_PURCHASE = "0x1A8C121e5C79623986f85F74C66d9cAd086B2358";
export const USDC_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base mainnet

const CREDIT_PURCHASE_READ_ABI = [
  "function packs(uint256) view returns (string name, uint256 usdcPrice, uint256 creditAmount, bool active)",
  "function getPackCount() view returns (uint256)",
];

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface OnChainPack {
  id: number;
  name: string;
  /** USDC base units (6 decimals). */
  usdcPrice: bigint;
  credits: number;
  active: boolean;
}

export async function readOnChainPack(provider: Provider, id: number): Promise<OnChainPack> {
  const c = new Contract(CREDIT_PURCHASE, CREDIT_PURCHASE_READ_ABI, provider);
  const r = await c.packs(id);
  return {
    id,
    name: String(r.name),
    usdcPrice: BigInt(r.usdcPrice),
    credits: Number(r.creditAmount) / 100,
    active: Boolean(r.active),
  };
}

export async function readOnChainPacks(provider: Provider): Promise<OnChainPack[]> {
  const c = new Contract(CREDIT_PURCHASE, CREDIT_PURCHASE_READ_ABI, provider);
  const n = Number(await c.getPackCount());
  return Promise.all(Array.from({ length: n }, (_, i) => readOnChainPack(provider, i)));
}

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface PurchaseOutcome {
  /** Sum of USDC transferred out of the buyer in this tx (6dp base units). */
  usdcPaid: bigint;
  /** Credits from the CreditPurchase event; null if no event from the buyer was found. */
  credits: number | null;
}

const lc = (s: string) => s.toLowerCase();
const topicAddr = (t: string | undefined) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

/** Pure: what a purchase tx actually charged and credited, read from its logs. */
export function summarizePurchaseReceipt(logs: readonly ReceiptLog[], buyer: string): PurchaseOutcome {
  const me = lc(buyer);
  let usdcPaid = 0n;
  let credits: number | null = null;
  for (const l of logs) {
    const addr = lc(l.address);
    if (addr === lc(USDC_TOKEN) && l.topics[0] === ERC20_TRANSFER_TOPIC && topicAddr(l.topics[1]) === me) {
      usdcPaid += BigInt(l.data);
    } else if (addr === lc(CREDIT_PURCHASE) && topicAddr(l.topics[1]) === me && l.data.length >= 2 + 64) {
      credits = Number(BigInt("0x" + l.data.slice(2, 66))) / 100;
    }
  }
  return { usdcPaid, credits };
}

export interface AdvertisedPack {
  id: number;
  name: string;
  usdcPrice: string;
  credits: number;
  nookDiscount?: number;
}

export interface DisplayPack {
  id: number;
  name: string;
  /** Dollars, as the contract charges. */
  usdcPrice: number;
  credits: number;
  active: boolean;
  creditsPerDollar: number;
  /** Where the price came from: the contract, or the gateway listing when the RPC read failed. */
  source: "on-chain" | "gateway";
  /** Gateway listing, when it disagrees with the contract. */
  advertised: { usdcPrice: number; credits: number } | null;
  nookDiscount?: number;
}

/**
 * Pure: the dashboard's pack list. The contract is the truth; the gateway
 * listing is kept only to flag a mismatch, and is the fallback when the RPC
 * read failed (marked source "gateway" so the page can say so).
 */
export function mergePackPricing(advertised: readonly AdvertisedPack[], onChain: readonly OnChainPack[] | null): DisplayPack[] {
  if (!onChain || onChain.length === 0) {
    return advertised.map((p) => {
      const usd = Number(p.usdcPrice);
      return {
        id: p.id, name: p.name, usdcPrice: usd, credits: p.credits, active: true,
        creditsPerDollar: usd > 0 ? p.credits / usd : 0,
        source: "gateway", advertised: null, nookDiscount: p.nookDiscount,
      };
    });
  }
  return onChain.map((p) => {
    const usd = Number(p.usdcPrice) / 1e6;
    const ad = advertised.find((a) => a.id === p.id);
    const adUsd = ad ? Number(ad.usdcPrice) : NaN;
    const mismatch = !!ad && (Math.abs(adUsd - usd) > 1e-9 || ad.credits !== p.credits);
    return {
      id: p.id, name: p.name, usdcPrice: usd, credits: p.credits, active: p.active,
      creditsPerDollar: usd > 0 ? p.credits / usd : 0,
      source: "on-chain",
      advertised: mismatch && ad ? { usdcPrice: adUsd, credits: ad.credits } : null,
      nookDiscount: ad?.nookDiscount,
    };
  });
}

export interface BuyArgs {
  packId: number;
  useNook: boolean;
  dryRun: boolean;
  /** Most USDC the operator agreed to pay; null = the listed price is the ceiling. */
  maxUsdc: number | null;
}

/**
 * Pure: parse `npm run buy-credits -- …` arguments, refusing anything doubtful
 * (2026-10-11 review). Without the `--`, npm keeps the flags for itself
 * (npm_config_pack, npm_config_dry_run) and the script saw an empty argv, so
 * the old defaults (pack 0, live) made a REAL Micro purchase for what the
 * operator typed as a dry run. Now: --pack is required, unknown arguments are
 * errors, and npm-swallowed flags stop the run.
 */
export function parseBuyArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): { args: BuyArgs | null; errors: string[] } {
  const errors: string[] = [];
  const swallowed = ["npm_config_pack", "npm_config_dry_run", "npm_config_nook", "npm_config_max_usdc"].filter((k) => env[k] !== undefined && env[k] !== "");
  if (swallowed.length) {
    errors.push(`npm kept these flags for itself (${swallowed.join(", ")}): put "--" before them, e.g. npm run buy-credits -- --pack=0 --dry-run`);
  }
  let packId: number | null = null;
  let useNook = false, dryRun = false;
  let maxUsdc: number | null = null;
  for (const a of argv) {
    if (a.startsWith("--pack=")) {
      const raw = a.slice("--pack=".length);
      const n = Number(raw);
      if (raw === "" || !Number.isInteger(n) || n < 0) errors.push(`--pack must be a pack number (0, 1, 2), got "${raw}"`);
      else packId = n;
    } else if (a === "--nook") useNook = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--max-usdc=")) {
      const raw = a.slice("--max-usdc=".length);
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || n <= 0) errors.push(`--max-usdc must be a positive number, got "${raw}"`);
      else maxUsdc = n;
    } else errors.push(`unknown argument "${a}"`);
  }
  if (packId === null && !errors.some((e) => e.startsWith("--pack"))) errors.push("--pack=N is required (0 Micro, 1 Standard, 2 Bulk)");
  return errors.length ? { args: null, errors } : { args: { packId: packId!, useNook, dryRun, maxUsdc }, errors };
}

/**
 * Pure: may we pay `priceUsdc` (6dp units)? The ceiling is --max-usdc when
 * given, else the gateway's listed price. Before 10-11 the script approved the
 * listed price, which incidentally capped the spend; approving the contract's
 * price removed that cap, so it is kept explicitly here.
 */
export function priceWithinCeiling(priceUsdc: bigint, listedUsdc: string, maxUsdc: number | null): { ok: boolean; ceilingUsdc: number } {
  const ceilingUsdc = maxUsdc ?? Number(listedUsdc);
  return { ok: Number(priceUsdc) / 1e6 <= ceilingUsdc + 1e-9, ceilingUsdc };
}
