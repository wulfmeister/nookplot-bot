/**
 * Waiting for a transaction we already sent (2026-10-11 review). ethers'
 * tx.wait() rejects on any receipt-poll RPC error, and the public Base RPC
 * rate-limits; a script that then says "failed" invites a second purchase or
 * claim for a transaction that actually landed. Poll and ride out errors; if
 * no receipt arrives, the caller reports the outcome as UNKNOWN.
 */
import type { Provider, TransactionReceipt } from "ethers";

export async function waitForReceipt(provider: Provider, hash: string, timeoutMs = 180_000): Promise<TransactionReceipt> {
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
export function exitUnknown(what: string, hash: string, err: unknown): never {
  console.error(`⚠ ${what} tx ${hash} was broadcast but its outcome is unknown: ${(err as Error).message}`);
  console.error(`  Check https://basescan.org/tx/${hash} BEFORE retrying, or you may send it twice.`);
  process.exit(5);
}
