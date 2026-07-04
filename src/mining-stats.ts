/**
 * Mining performance by model.
 *
 * Reads ~/.nookplot/mining-submissions.jsonl and shows per-model pass rate,
 * defer rate, error rate, est NOOK at stake. Complements ab-stats (which
 * only covers bounty applications).
 *
 * Usage:
 *   npm run mining-stats              # all-time
 *   npm run mining-stats -- --24h     # last 24h only
 *   npm run mining-stats -- --7d      # last 7 days
 */
import { join } from "node:path";
import { NOOK_DIR, readJsonl } from "./util.js";

const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");
const MINING_VERIFIED_LOG = join(NOOK_DIR, "mining-verified.jsonl");

interface VerifiedEntry {
  ts: string;
  submissionId?: string;
  challengeId?: string;
  model?: string;
  verifierKind?: string;
  status: "verified" | "expired" | "rejected";
}

interface Entry {
  ts: string;
  challengeId: string;
  verifierKind?: string;
  outcome: "pass" | "fail" | "deferred" | "error" | "skipped";
  rewardNook?: number;
  model?: string;
  notes?: string;
}

interface Tally {
  total: number;
  pass: number;
  fail: number;
  deferred: number;
  error: number;
  noOutput: number;        // subset of error
  specReject: number;      // subset of error — specificity gate
  permanent: number;       // subset of error — guild/closed
  transient: number;       // 5xx + aborted
  rewardSum: number;       // pass + deferred reward total
}

function emptyTally(): Tally {
  return {
    total: 0, pass: 0, fail: 0, deferred: 0, error: 0,
    noOutput: 0, specReject: 0, permanent: 0, transient: 0,
    rewardSum: 0,
  };
}

function add(t: Tally, e: Entry) {
  t.total += 1;
  if (e.outcome === "pass") { t.pass += 1; t.rewardSum += e.rewardNook ?? 0; }
  else if (e.outcome === "fail") t.fail += 1;
  else if (e.outcome === "deferred") { t.deferred += 1; t.rewardSum += e.rewardNook ?? 0; }
  else if (e.outcome === "error") {
    t.error += 1;
    const n = e.notes ?? "";
    if (/no output|produced no/.test(n)) t.noOutput += 1;
    else if (/specificity/.test(n)) t.specReject += 1;
    else if (/guild|tier|closed|already submitted/.test(n)) t.permanent += 1;
    else if (/500|aborted|timeout/.test(n)) t.transient += 1;
  }
}

function pct(num: number, den: number): string {
  if (den === 0) return "  -  ";
  return `${((num / den) * 100).toFixed(0).padStart(3)}%`;
}

function fmtRow(label: string, t: Tally): string {
  const resolved = t.pass + t.fail; // error/deferred excluded from win-rate denominator
  const passRate = resolved > 0 ? `${((t.pass / resolved) * 100).toFixed(0)}%` : "—";
  const successAttempts = t.pass + t.deferred;
  const successRate = t.total > 0 ? `${((successAttempts / t.total) * 100).toFixed(0)}%` : "—";
  return [
    label.padEnd(22),
    `n=${String(t.total).padStart(3)}`,
    `✅${String(t.pass).padStart(2)}`,
    `⏳${String(t.deferred).padStart(2)}`,
    `✗${String(t.fail).padStart(2)}`,
    `err${String(t.error).padStart(2)}`,
    `submit-rate ${successRate.padStart(4)}`,
    `pass-rate ${passRate.padStart(4)}`,
    `est ${String(t.rewardSum).padStart(5)} NOOK`,
  ].join("  ");
}

function fmtErrorBreakdown(label: string, t: Tally): string {
  if (t.error === 0) return `${label.padEnd(22)} (no errors)`;
  const parts = [
    t.noOutput > 0 ? `no-output ${t.noOutput}` : "",
    t.specReject > 0 ? `spec-reject ${t.specReject}` : "",
    t.permanent > 0 ? `permanent ${t.permanent}` : "",
    t.transient > 0 ? `transient ${t.transient}` : "",
  ].filter(Boolean);
  const other = t.error - t.noOutput - t.specReject - t.permanent - t.transient;
  if (other > 0) parts.push(`other ${other}`);
  return `${label.padEnd(22)} ${parts.join(", ")}`;
}

function main() {
  const args = process.argv.slice(2);
  const all = readJsonl<Entry>(MINING_LOG);

  let cutoff = 0;
  let windowLabel = "all-time";
  if (args.includes("--24h")) { cutoff = Date.now() - 24 * 3600_000; windowLabel = "last 24h"; }
  else if (args.includes("--7d")) { cutoff = Date.now() - 7 * 24 * 3600_000; windowLabel = "last 7d"; }

  const entries = all.filter((e) => new Date(e.ts).getTime() >= cutoff);

  if (entries.length === 0) {
    console.log(`No mining submissions in window (${windowLabel}).`);
    return;
  }

  const byModel = new Map<string, Tally>();
  const byKind = new Map<string, Tally>();
  for (const e of entries) {
    const m = e.model ?? "(unrecorded — pre-instrumentation)";
    const k = e.verifierKind ?? "?";
    if (!byModel.has(m)) byModel.set(m, emptyTally());
    add(byModel.get(m)!, e);
    if (!byKind.has(k)) byKind.set(k, emptyTally());
    add(byKind.get(k)!, e);
  }

  console.log(`\nMining performance — ${windowLabel} (${entries.length} attempts)\n`);

  console.log("== By model ==");
  for (const [m, t] of [...byModel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(fmtRow(m, t));
  }

  console.log("\n== Error breakdown by model ==");
  for (const [m, t] of [...byModel.entries()].sort((a, b) => b[1].error - a[1].error)) {
    console.log(fmtErrorBreakdown(m, t));
  }

  console.log("\n== By verifier kind ==");
  for (const [k, t] of [...byKind.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(fmtRow(k, t));
  }

  // Verified-rate — the metric that actually drives NOOK. Joins the terminal
  // outcomes recorded by learnings.ts::publishPostSolveLearnings. A submission
  // pays out only at 3-verifier quorum; "expired" = never reached quorum = zero.
  const verified = readJsonl<VerifiedEntry>(MINING_VERIFIED_LOG).filter((e) => new Date(e.ts).getTime() >= cutoff);
  console.log("\n== Verified-rate (terminal outcomes) ==");
  if (verified.length === 0) {
    console.log("  No terminal outcomes recorded yet (accrues going forward; needs subs to reach verified/expired/rejected).");
  } else {
    const tally = (key: (e: VerifiedEntry) => string) => {
      const map = new Map<string, { verified: number; expired: number; rejected: number }>();
      for (const e of verified) {
        const k = key(e) || "?";
        if (!map.has(k)) map.set(k, { verified: 0, expired: 0, rejected: 0 });
        map.get(k)![e.status] += 1;
      }
      return map;
    };
    const render = (label: string, map: Map<string, { verified: number; expired: number; rejected: number }>) => {
      for (const [k, c] of [...map.entries()].sort((a, b) => (b[1].verified + b[1].expired + b[1].rejected) - (a[1].verified + a[1].expired + a[1].rejected))) {
        const n = c.verified + c.expired + c.rejected;
        console.log(
          `${(label + k).padEnd(28)} n=${String(n).padStart(3)}  ✓verified ${String(c.verified).padStart(3)}  ⌛expired ${String(c.expired).padStart(3)}  ✗rejected ${String(c.rejected).padStart(3)}  verified-rate ${pct(c.verified, n)}`,
        );
      }
    };
    render("", tally((e) => e.model ?? "(unrecorded)"));
    console.log("  --");
    render("", tally((e) => e.verifierKind ?? "?"));
  }

  // Recommendation
  console.log("\n== Pick ==");
  const ranked = [...byModel.entries()]
    .filter(([, t]) => t.total >= 5)
    .map(([m, t]) => {
      const score = (t.pass + t.deferred) / t.total; // submit-rate
      return { m, t, score };
    })
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    console.log("Not enough samples per model (need ≥5 each) for a recommendation.");
  } else {
    const best = ranked[0];
    console.log(`Best submit-rate: ${best.m} (${pct(best.t.pass + best.t.deferred, best.t.total)} on n=${best.t.total})`);
    if (ranked.length >= 2) {
      const worst = ranked[ranked.length - 1];
      const gap = (best.score - worst.score) * 100;
      console.log(`Worst: ${worst.m} (${pct(worst.t.pass + worst.t.deferred, worst.t.total)} on n=${worst.t.total}, gap ${gap.toFixed(0)}pp)`);
      if (gap >= 20 && best.t.total + worst.t.total >= 15) {
        console.log(`→ Consider removing ${worst.m} from mining_solve A/B pool in src/models.ts.`);
      }
    }
  }
}

main();
