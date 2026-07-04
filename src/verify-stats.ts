/**
 * Verification variance check.
 *
 * Reads ~/.nookplot/verification-stats.jsonl and computes per-dimension
 * rolling mean + SD. Anti-rubber-stamp detection flags consistently-high
 * scoring; low-variance scoring (consistent at any level) is also a
 * detectable pattern. SD below ~0.10 over a 20-sample window is a warning.
 *
 * Usage: npm run verify:stats
 */
import { join } from "node:path";
import { NOOK_DIR, readJsonl } from "./util.js";

const STATS = join(NOOK_DIR, "verification-stats.jsonl");

interface Entry {
  ts: string;
  submissionId: string;
  correctness: number;
  reasoning: number;
  efficiency: number;
  novelty: number;
  domain?: string;
}

function meanSd(xs: number[]): { mean: number; sd: number } {
  if (xs.length === 0) return { mean: 0, sd: 0 };
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return { mean: m, sd: Math.sqrt(v) };
}

function fmtRow(label: string, n: number, ms: { mean: number; sd: number }, warn: boolean): string {
  const flag = warn ? " ⚠ low variance" : ms.mean >= 0.85 ? " ⚠ high mean — rubber-stamp risk" : ms.mean <= 0.30 ? " ⚠ very low mean — harshness risk" : "";
  return `${label.padEnd(14)} | n=${String(n).padStart(3)} | mean ${ms.mean.toFixed(3)} | sd ${ms.sd.toFixed(3)}${flag}`;
}

function main() {
  const all = readJsonl<Entry>(STATS);
  if (all.length === 0) {
    console.log("No verification stats yet. Run the bot — verifications populate ~/.nookplot/verification-stats.jsonl.");
    return;
  }

  console.log(`\nVerification variance — ${all.length} total entries\n`);

  // All-time
  const dims = ["correctness", "reasoning", "efficiency", "novelty"] as const;
  for (const d of dims) {
    const xs = all.map((e) => e[d]);
    const ms = meanSd(xs);
    console.log(fmtRow(d, xs.length, ms, ms.sd < 0.10 && xs.length >= 20));
  }

  // Last 20 (rolling check)
  if (all.length >= 20) {
    console.log("\nLast 20 verifications:");
    const last = all.slice(-20);
    for (const d of dims) {
      const xs = last.map((e) => e[d]);
      const ms = meanSd(xs);
      console.log(fmtRow(d, xs.length, ms, ms.sd < 0.10));
    }
  } else {
    console.log(`\n(rolling 20-sample window needs ${20 - all.length} more verifications)`);
  }

  // Per-domain breakdown (top 5)
  const byDomain = new Map<string, Entry[]>();
  for (const e of all) {
    const d = e.domain ?? "general";
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(e);
  }
  const top = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  if (top.length > 1) {
    console.log("\nPer-domain (top 5 by count):");
    for (const [domain, entries] of top) {
      const cs = entries.flatMap((e) => [e.correctness, e.reasoning, e.efficiency, e.novelty]);
      const ms = meanSd(cs);
      console.log(`  ${domain.padEnd(20)} n=${entries.length}  combined mean=${ms.mean.toFixed(3)}  sd=${ms.sd.toFixed(3)}`);
    }
  }

  // Honest interpretation
  console.log("\nInterpretation cheat-sheet:");
  console.log("  mean ≈ 0.4-0.7 with sd ≥ 0.15 = healthy honest scoring");
  console.log("  mean ≥ 0.85 sustained          = rubber-stamp risk (high-score everything)");
  console.log("  sd < 0.10 over 20+ samples     = low-variance pattern (also flaggable)");
  console.log("  mean ≤ 0.30 sustained          = harshness — may discourage solvers + hurt our endorsement signal");
}

main();
