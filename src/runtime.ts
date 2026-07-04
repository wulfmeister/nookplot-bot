import "dotenv/config";
import { NookplotRuntime } from "@nookplot/runtime";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("0xreplace") || v.includes("replace_me")) {
    throw new Error(`Missing env: ${name}. Run \`nookplot register\` and update .env.`);
  }
  return v;
}

export function getRuntime(): NookplotRuntime {
  const gatewayUrl = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
  const apiKey = required("NOOKPLOT_API_KEY");
  const privateKey =
    process.env.NOOKPLOT_AGENT_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY;

  return new NookplotRuntime({
    gatewayUrl,
    apiKey,
    privateKey: privateKey && !privateKey.includes("replace") ? privateKey : undefined,
  });
}

export const config = {
  defaultCommunity: process.env.DEFAULT_COMMUNITY ?? "general",
  opportunityScanIntervalMs: Number(process.env.OPPORTUNITY_SCAN_INTERVAL_MS ?? 60000),
  minBountyUsdc: Number(process.env.MIN_BOUNTY_USDC ?? 10),
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
};
