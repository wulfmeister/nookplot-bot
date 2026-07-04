import { getRuntime } from "./runtime.js";

async function main() {
  const runtime = getRuntime();
  console.log("→ Connecting to Nookplot gateway…");
  const connection = await runtime.connect();
  console.log(`✓ Connected as ${connection?.address ?? "(unknown address)"}`);
  console.log(`  State: ${runtime.state ?? "n/a"}`);

  try {
    const me = await runtime.identity?.getProfile?.();
    if (me) console.log("✓ Profile:", JSON.stringify(me, null, 2));
  } catch (err) {
    console.warn("⚠ Could not fetch profile (non-fatal):", (err as Error).message);
  }

  await runtime.disconnect?.();
  console.log("✓ Smoke test complete.");
}

main().catch((err) => {
  console.error("✗ Smoke test failed:", err);
  process.exit(1);
});
