/**
 * Forge presets — load curated, network-vetted knowledge into the agent's
 * memory/KG at 5% of the external rate (staking discounts stack). This is the
 * "cheaper knowledge boot" path: a forged preset seeds the miner with relevant
 * domain traces so it solves better, instead of starting cold every run.
 *
 * Read + estimate are FREE and run live. Loading SPENDS NOOK, so it is:
 *   - opt-in           — only runs when BOT_FORGE_PRESET names a preset
 *   - cost-capped      — BOT_FORGE_MAX_NOOK (default 5000) → PresetConfig.maxCostNook
 *   - idempotent       — the SDK PresetLoader writes .preset-loaded.json and
 *                        coalesces concurrent loads, so a reboot never double-pays
 *
 * CLI:
 *   npm run forge                      # list presets + live cost estimates (free)
 *   npm run forge -- load <slug|id>    # load one (spends NOOK; prompts to confirm)
 *
 * Boot hook (index.ts): loadConfiguredPresetAtBoot(runtime) — no-op unless
 * BOT_FORGE_PRESET is set.
 *
 * Gateway status (2026-06-20): list_forge_presets / estimate_forge_cost /
 * POST /v1/forge/data/fetch are all LIVE.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { PresetLoader, type PresetConfig } from "@nookplot/runtime";
import type { NookplotRuntime } from "@nookplot/runtime";
import { getRuntime } from "./runtime.js";

export interface ForgePreset {
  id: string;
  slug: string;
  name: string;
  description?: string;
  sourceType?: string;
  datasetConfig?: Record<string, unknown>;
  version?: number;
  domain?: string;
  tags?: string[];
}

export interface ForgeEstimate {
  effectiveTotal?: number;
  deploymentFee?: string | number;
  dataCostTotal?: number;
  fetchLimit?: number;
  stakingTier?: number;
  stakingDiscount?: number;
  estimatedUsd?: string;
  warnings?: string[];
  dataCosts?: Array<{ label?: string; itemCount?: number; subtotal?: number }>;
}

type RuntimeLike = Pick<NookplotRuntime, "tools">;

/** List forge presets (free, live). */
export async function listPresets(runtime: RuntimeLike, limit = 50): Promise<ForgePreset[]> {
  const res = await runtime.tools.executeTool("list_forge_presets", { limit });
  const out = (res?.output ?? {}) as { presets?: ForgePreset[] };
  return out.presets ?? [];
}

/** Estimate the NOOK cost of forging a preset (free, live). */
export async function estimateCost(runtime: RuntimeLike, presetId: string): Promise<ForgeEstimate> {
  const res = await runtime.tools.executeTool("estimate_forge_cost", {
    presetId,
    agentAddress: process.env.NOOKPLOT_AGENT_ADDRESS,
  });
  return (res?.output ?? {}) as ForgeEstimate;
}

/**
 * Translate a gateway preset into the PresetConfig PresetLoader wants. A forge
 * data source is `{ type: sourceType, config: datasetConfig }`; the loader
 * forwards that to POST /v1/forge/data/fetch (which requires presetId + sources[]).
 */
function presetToConfig(p: ForgePreset, maxCostNook: number): PresetConfig {
  return {
    id: p.id,
    version: p.version,
    trustLevel: "verified",
    failurePolicy: "continue",
    maxCostNook,
    sources: [
      {
        type: p.sourceType ?? "mining",
        label: p.slug,
        config: p.datasetConfig ?? {},
      },
    ],
  };
}

/**
 * Load a preset's data into memory via the SDK PresetLoader. Spends NOOK (capped
 * at maxCostNook). Idempotent: a no-op if this preset was already loaded.
 */
export async function loadPreset(
  runtime: NookplotRuntime,
  preset: ForgePreset,
  maxCostNook: number,
): Promise<{ totalItems: number; totalCostNook: number; alreadyLoaded: boolean }> {
  const loader = new PresetLoader(runtime, undefined, presetToConfig(preset, maxCostNook));
  if (await loader.isLoaded()) {
    console.log(`🔥 forge: "${preset.slug}" already loaded (manifest) — skipping (no spend).`);
    return { totalItems: 0, totalCostNook: 0, alreadyLoaded: true };
  }
  loader.on("estimating", (e: { message: string }) => console.log(`🔥 estimating: ${e.message}`));
  loader.on("fetching", (e: { source: string; progress: string }) =>
    console.log(`🔥 fetching ${e.source}: ${e.progress}`),
  );
  loader.on("ingesting", (e: { source: string; method: string }) =>
    console.log(`🔥 ingesting ${e.source} via ${e.method}`),
  );
  loader.on("error", (e: { source: string; error: string }) =>
    console.warn(`🔥 forge error (${e.source}): ${e.error}`),
  );
  const result = await loader.load();
  console.log(
    `🔥 forge complete: ${result.totalItems} items (${result.totalBlocked} blocked) for ${result.totalCostNook} NOOK`,
  );
  return { totalItems: result.totalItems, totalCostNook: result.totalCostNook, alreadyLoaded: false };
}

/**
 * Boot hook: forge the preset named by BOT_FORGE_PRESET (slug or id), once,
 * cost-capped by BOT_FORGE_MAX_NOOK. No-op when the env var is unset. Never
 * throws into the boot path — a forge failure must not stop the daemon.
 */
export async function loadConfiguredPresetAtBoot(runtime: NookplotRuntime): Promise<void> {
  const sel = process.env.BOT_FORGE_PRESET?.trim();
  if (!sel) return;
  const cap = Number(process.env.BOT_FORGE_MAX_NOOK ?? 5000);
  try {
    const presets = await listPresets(runtime, 50);
    const p = presets.find((x) => x.slug === sel || x.id === sel);
    if (!p) {
      console.warn(`🔥 forge: BOT_FORGE_PRESET="${sel}" not found among ${presets.length} presets — skipping.`);
      return;
    }
    console.log(`🔥 forge: loading preset "${p.slug}" (cap ${cap} NOOK)…`);
    await loadPreset(runtime, p, cap);
  } catch (err) {
    console.warn(`🔥 forge boot-load failed (non-fatal): ${(err as Error).message}`);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  const runtime = getRuntime();
  const [cmd, target] = process.argv.slice(2);

  if (!cmd || cmd === "list") {
    const presets = await listPresets(runtime, 50);
    console.log(`\n🔥 ${presets.length} forge presets (estimates are free, loading spends NOOK):\n`);
    for (const p of presets) {
      const est = await estimateCost(runtime, p.id).catch(() => null);
      const items = est?.dataCosts?.reduce((n, d) => n + (d.itemCount ?? 0), 0) ?? 0;
      const cost = est?.effectiveTotal ?? "?";
      console.log(
        `  ${p.slug.padEnd(22)} [${(p.domain ?? "?").padEnd(16)}] ` +
          `${items} traces · ${cost} NOOK (${est?.estimatedUsd ?? "?"})  — ${p.name}`,
      );
    }
    console.log(`\nLoad one with:  npm run forge -- load <slug>\n`);
    return;
  }

  if (cmd === "load") {
    if (!target) {
      console.error("usage: npm run forge -- load <slug|id>");
      process.exit(1);
    }
    const presets = await listPresets(runtime, 50);
    const p = presets.find((x) => x.slug === target || x.id === target);
    if (!p) {
      console.error(`preset "${target}" not found.`);
      process.exit(1);
    }
    const cap = Number(process.env.BOT_FORGE_MAX_NOOK ?? 5000);
    const est = await estimateCost(runtime, p.id).catch(() => null);
    console.log(`\n🔥 "${p.slug}" — est ${est?.effectiveTotal ?? "?"} NOOK (${est?.estimatedUsd ?? "?"}), cap ${cap} NOOK`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("Proceed and spend NOOK? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.log("aborted.");
      return;
    }
    await loadPreset(runtime, p, cap);
    return;
  }

  console.error(`unknown command "${cmd}". Use: list | load <slug>`);
  process.exit(1);
}

// Run CLI only when invoked directly (not when imported by index.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
