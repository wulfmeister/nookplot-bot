/**
 * `npm run relaunch-watch`: check now for signs that Nookplot is coming back
 * (relaunch-watch.ts) and print them. The daemon runs the same check every
 * hour while it waits out a pause; this runs it by hand. Read-only.
 */
import "dotenv/config";
import { relaunchSignals, runRelaunchCheck } from "./relaunch-watch.js";

const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

async function main() {
  const { state, newly, first } = await runRelaunchCheck();
  console.log(`\nIs Nookplot coming back?  first check ${when(state.baselineAt)}, this check ${when(state.checkedAt)}\n`);
  for (const s of relaunchSignals(state)) {
    const moved = s.firstSeen ? `   MOVED, first seen ${when(s.firstSeen)}` : "";
    console.log(`  ${s.firstSeen ? "✓" : "·"}  ${s.label}${moved}`);
    const then = s.baseline ?? "couldn't read";
    const now = s.now ?? "couldn't read";
    console.log(`       ${then === now ? now : `${then}  →  ${now}`}`);
  }
  if (first) console.log("\nThis was the first check, so it is the baseline: later checks compare against it.");
  else if (newly.length) console.log(`\nNew since the last check: ${newly.map((s) => s.label).join("; ")}.`);
  const moved = relaunchSignals(state).filter((s) => s.firstSeen).length;
  console.log(moved ? `\n${moved} sign${moved === 1 ? " has" : "s have"} moved.` : "\nNothing has moved yet.");
  console.log("While Nookplot is paused the bot runs this check every hour (BOT_RELAUNCH_WATCH_MIN).\n");
}

main().catch((err) => {
  console.error("✗ relaunch-watch failed:", err);
  process.exit(1);
});
