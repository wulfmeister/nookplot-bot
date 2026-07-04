import { join } from "node:path";
import { NOOK_DIR, readJsonl } from "./util.js";

const AB_LOG = join(NOOK_DIR, "ab-applications.jsonl");
const AB_OUTCOMES = join(NOOK_DIR, "ab-outcomes.jsonl");

interface AppRecord {
  ts: string;
  bountyId: number;
  variant: "long" | "short";
  model?: string;
  modelPool?: string;
  appId?: string;
  messageLen: number;
}

interface OutcomeRecord {
  ts: string;
  bountyId: number;
  appId: string;
  outcome: "approved" | "rejected";
}

interface Tally {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  lenSum: number;
}

function emptyTally(): Tally {
  return { total: 0, approved: 0, rejected: 0, pending: 0, lenSum: 0 };
}

function addTally(t: Tally, app: AppRecord, outcome?: "approved" | "rejected") {
  t.total += 1;
  t.lenSum += app.messageLen;
  if (outcome === "approved") t.approved += 1;
  else if (outcome === "rejected") t.rejected += 1;
  else t.pending += 1;
}

function fmtRow(label: string, t: Tally): string {
  const avgLen = t.total ? Math.round(t.lenSum / t.total) : 0;
  const resolved = t.approved + t.rejected;
  const wr = resolved ? `${((t.approved / resolved) * 100).toFixed(1)}%` : "—";
  return `${label.padEnd(28)} | ${String(t.total).padStart(5)} | ${String(t.approved).padStart(8)} | ${String(t.rejected).padStart(8)} | ${String(t.pending).padStart(7)} | ${wr.padStart(8)} | ${String(avgLen).padStart(9)}`;
}

function main() {
  const apps = readJsonl<AppRecord>(AB_LOG);
  const outcomes = readJsonl<OutcomeRecord>(AB_OUTCOMES);
  const outcomeById = new Map<string, OutcomeRecord["outcome"]>();
  for (const o of outcomes) if (o.appId) outcomeById.set(o.appId, o.outcome);

  const byVariant = new Map<string, Tally>();
  const byModel = new Map<string, Tally>();
  const byVariantModel = new Map<string, Tally>();

  for (const a of apps) {
    const outcome = a.appId ? outcomeById.get(a.appId) : undefined;
    const v = a.variant;
    const m = a.model ?? "(unrecorded — pre-instrumentation)";
    const vm = `${v} / ${m}`;
    if (!byVariant.has(v)) byVariant.set(v, emptyTally());
    addTally(byVariant.get(v)!, a, outcome);
    if (!byModel.has(m)) byModel.set(m, emptyTally());
    addTally(byModel.get(m)!, a, outcome);
    if (!byVariantModel.has(vm)) byVariantModel.set(vm, emptyTally());
    addTally(byVariantModel.get(vm)!, a, outcome);
  }

  const header = "Bucket                       | Total | Approved | Rejected | Pending | Win-rate | Avg chars";
  const sep = "-".repeat(header.length);

  console.log("A/B test — bounty application performance\n");

  console.log("== By length variant ==");
  console.log(header);
  console.log(sep);
  for (const [v, t] of [...byVariant.entries()].sort()) console.log(fmtRow(v, t));

  console.log("\n== By model ==");
  console.log(header);
  console.log(sep);
  for (const [m, t] of [...byModel.entries()].sort((a, b) => b[1].total - a[1].total))
    console.log(fmtRow(m, t));

  console.log("\n== By variant + model ==");
  console.log(header);
  console.log(sep);
  for (const [vm, t] of [...byVariantModel.entries()].sort())
    console.log(fmtRow(vm, t));

  const total = apps.length;
  const resolved = apps.filter((a) => a.appId && outcomeById.has(a.appId)).length;
  console.log(`\nTotals: ${total} applications, ${resolved} resolved, ${total - resolved} still pending.`);
  if (resolved < 10) {
    console.log("(insufficient data for confidence — keep collecting)");
  }
}

main();
