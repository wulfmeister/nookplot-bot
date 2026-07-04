import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listCategory } from "./vault.js";
import { NOOK_DIR, BOT_LOG_PATH, readJsonl } from "./util.js";

const AB_LOG = join(NOOK_DIR, "ab-applications.jsonl");
const AB_OUTCOMES = join(NOOK_DIR, "ab-outcomes.jsonl");
const KNOWLEDGE_LOG = join(NOOK_DIR, "knowledge-published.jsonl");
const MINING_LOG = join(NOOK_DIR, "mining-submissions.jsonl");
const CROWD_LOG = join(NOOK_DIR, "crowd-jury.jsonl");
const LEARNINGS_LOG = join(NOOK_DIR, "learnings-posted.jsonl");
const PREDICTIONS_LOG = join(NOOK_DIR, "predictions.jsonl");
const ENGAGEMENT_LOG = join(NOOK_DIR, "engagement.jsonl");
const ENDORSE_LOG = join(NOOK_DIR, "endorsements.jsonl");
const VERIFY_STATS = join(NOOK_DIR, "verification-stats.jsonl");
const BOT_LOG = BOT_LOG_PATH;

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes("--once");
const INTERVAL_MS = parseInt(ARGS.find((a) => a.startsWith("--interval="))?.split("=")[1] ?? "20") * 1000;

const GATEWAY = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
const API_KEY = process.env.NOOKPLOT_API_KEY ?? "";
const MY_ADDR = (process.env.NOOKPLOT_AGENT_ADDRESS ?? "").toLowerCase();

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

async function gw<T>(path: string): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function tailLog(n: number): string[] {
  if (!existsSync(BOT_LOG)) return [];
  const lines = readFileSync(BOT_LOG, "utf8").split("\n").filter((l) => l.trim());
  return lines.slice(-n);
}

function countLogAll(needle: string): number {
  if (!existsSync(BOT_LOG)) return 0;
  const buf = readFileSync(BOT_LOG, "utf8");
  return (buf.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

function countLogToday(needle: string): number {
  if (!existsSync(BOT_LOG)) return 0;
  return countLogAll(needle);
}

interface SnapshotData {
  profile?: { address: string; displayName?: string };
  balance?: { balance: number; lifetimeEarned: number; lifetimeSpent: number; budgetStatus: string };
  bountyCount?: { open: number; mineApplied: number; mineApproved: number; mineRejected: number };
  gatewayError?: string;
}

async function tryGw<T>(path: string): Promise<T | null> {
  try {
    return await gw<T>(path);
  } catch {
    return null;
  }
}

async function snapshot(): Promise<SnapshotData> {
  const [profile, balance, bountyList] = await Promise.all([
    tryGw<{ address: string; displayName?: string }>("/v1/agents/me"),
    tryGw<{ balance: number; lifetimeEarned: number; lifetimeSpent: number; budgetStatus: string }>("/v1/credits/balance"),
    tryGw<{ bounties?: Array<{ id: string; status: number; creator?: string }> }>("/v1/bounties?first=50"),
  ]);
  if (!profile && !balance && !bountyList) {
    return { gatewayError: "gateway unreachable (all endpoints failed)" };
  }
  let bountyCount: SnapshotData["bountyCount"] | undefined;
  if (bountyList) {
    const open = (bountyList.bounties ?? []).filter((b) => b.status === 0);
    let mineApplied = 0;
    let mineApproved = 0;
    let mineRejected = 0;
    for (const b of open.slice(0, 25)) {
      const bid = typeof b.id === "string" ? parseInt(b.id, 10) : b.id;
      if (!bid) continue;
      const apps = await tryGw<{ applications?: Array<{ status: string; applicantAddress?: string }> }>(
        `/v1/bounties/${bid}/applications?first=100`,
      );
      if (!apps) continue;
      const mine = (apps.applications ?? []).find((a) => a.applicantAddress?.toLowerCase() === MY_ADDR);
      if (!mine) continue;
      if (mine.status === "approved") mineApproved += 1;
      else if (mine.status === "rejected") mineRejected += 1;
      else mineApplied += 1;
    }
    bountyCount = { open: open.length, mineApplied, mineApproved, mineRejected };
  }
  return {
    profile: profile ?? undefined,
    balance: balance ?? undefined,
    bountyCount,
  };
}

function render(data: SnapshotData) {
  const lines: string[] = [];
  lines.push(`${C.bold}${C.cyan}┌─ nookplot-bot dashboard ────────────────────────────────────────────┐${C.reset}`);
  lines.push(`  ${C.dim}refreshed${C.reset} ${new Date().toLocaleString()}`);
  if (data.gatewayError) lines.push(`  ${C.red}⚠ ${data.gatewayError} — showing local data only${C.reset}`);
  lines.push("");
  if (data.profile) {
    lines.push(`  ${C.bold}Agent${C.reset}    ${data.profile.displayName ?? "?"} ${C.dim}(${data.profile.address})${C.reset}`);
  } else {
    lines.push(`  ${C.bold}Agent${C.reset}    ${C.dim}(gateway unreachable) ${MY_ADDR}${C.reset}`);
  }
  if (data.balance) {
    const budget = data.balance.budgetStatus === "normal" ? C.green : data.balance.budgetStatus === "low" ? C.yellow : C.red;
    lines.push(
      `  ${C.bold}Credits${C.reset}  ${C.green}${data.balance.balance.toFixed(2)}${C.reset} avail · ${data.balance.lifetimeSpent.toFixed(2)} spent · ${data.balance.lifetimeEarned.toFixed(2)} earned · budget ${budget}${data.balance.budgetStatus}${C.reset}`,
    );
  } else {
    lines.push(`  ${C.bold}Credits${C.reset}  ${C.dim}(gateway unreachable)${C.reset}`);
  }
  lines.push("");

  const apps = readJsonl<{ ts: string; bountyId: number; variant: "long" | "short"; appId?: string; messageLen: number }>(AB_LOG);
  const outcomes = readJsonl<{ appId: string; outcome: "approved" | "rejected" }>(AB_OUTCOMES);
  const outcomeMap = new Map<string, "approved" | "rejected">();
  for (const o of outcomes) outcomeMap.set(o.appId, o.outcome);
  const variants: Record<"long" | "short", { total: number; ok: number; ko: number; pending: number; len: number }> = {
    long: { total: 0, ok: 0, ko: 0, pending: 0, len: 0 },
    short: { total: 0, ok: 0, ko: 0, pending: 0, len: 0 },
  };
  for (const a of apps) {
    if (!variants[a.variant]) continue;
    variants[a.variant].total += 1;
    variants[a.variant].len += a.messageLen;
    const o = a.appId ? outcomeMap.get(a.appId) : undefined;
    if (o === "approved") variants[a.variant].ok += 1;
    else if (o === "rejected") variants[a.variant].ko += 1;
    else variants[a.variant].pending += 1;
  }
  lines.push(`  ${C.bold}A/B applications${C.reset} ${C.dim}(this session)${C.reset}`);
  for (const v of ["long", "short"] as const) {
    const t = variants[v];
    const avg = t.total ? Math.round(t.len / t.total) : 0;
    const resolved = t.ok + t.ko;
    const wr = resolved ? ` ${((t.ok / resolved) * 100).toFixed(0)}%` : "  -";
    lines.push(`    ${v.padEnd(6)} total=${String(t.total).padStart(3)}  ${C.green}✓${t.ok}${C.reset} ${C.red}✗${t.ko}${C.reset} ${C.yellow}⏳${t.pending}${C.reset}  avg ${avg}ch  win-rate${wr}`);
  }
  lines.push("");

  if (data.bountyCount) {
    lines.push(`  ${C.bold}On-network bounty position${C.reset} ${C.dim}(top 25 Open)${C.reset}`);
    lines.push(`    ${C.yellow}⏳ pending${C.reset}    ${data.bountyCount.mineApplied}`);
    lines.push(`    ${C.green}✓ approved${C.reset}   ${data.bountyCount.mineApproved}`);
    lines.push(`    ${C.red}✗ rejected${C.reset}   ${data.bountyCount.mineRejected}`);
    lines.push(`    ${C.dim}${data.bountyCount.open} Open bounties total on network${C.reset}`);
    lines.push("");
  }

  const knowledge = readJsonl<{ ts: string; title: string; cid: string; bodyLen: number; source?: string }>(KNOWLEDGE_LOG);
  const last7 = knowledge.filter((k) => Date.now() - new Date(k.ts).getTime() < 7 * 86400_000);
  // Source breakdown — grounded vs fallback
  const bySource: Record<string, number> = {};
  for (const k of last7) {
    const s = k.source ?? "legacy";
    bySource[s] = (bySource[s] ?? 0) + 1;
  }
  const sourceLine = Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}=${n}`)
    .join("  ");
  lines.push(`  ${C.bold}Knowledge published${C.reset}  ${knowledge.length} total · ${last7.length} in last 7d · ${fmtBytes(knowledge.reduce((s, k) => s + (k.bodyLen ?? 0), 0))}`);
  if (sourceLine) lines.push(`    ${C.dim}sources (7d):${C.reset} ${sourceLine}`);
  for (const k of knowledge.slice(-3).reverse()) {
    const src = k.source ? ` ${C.dim}[${k.source}]${C.reset}` : "";
    lines.push(`    ${C.dim}${fmtAge(k.ts).padStart(7)}${C.reset}  ${k.title.slice(0, 60)}${src}`);
  }
  lines.push("");

  // Mining track — Tier 3's actual payoff path
  const mining = readJsonl<{ ts: string; outcome: string; verifierKind?: string; rewardNook?: number; model?: string }>(MINING_LOG);
  const miningLast24h = mining.filter((m) => Date.now() - new Date(m.ts).getTime() < 86400_000);
  if (mining.length > 0) {
    const c = { pass: 0, fail: 0, deferred: 0, error: 0 } as Record<string, number>;
    let estReward = 0;
    for (const m of mining) c[m.outcome] = (c[m.outcome] ?? 0) + 1;
    for (const m of mining) if (m.outcome === "pass" || m.outcome === "deferred") estReward += m.rewardNook ?? 0;
    lines.push(`  ${C.bold}Mining submissions${C.reset}  ${mining.length} all-time · ${miningLast24h.length} in last 24h`);
    lines.push(`    ${C.green}✅ pass${C.reset} ${c.pass ?? 0}  ${C.yellow}⏳ deferred${C.reset} ${c.deferred ?? 0}  ${C.red}✗ fail${C.reset} ${c.fail ?? 0}  ${C.dim}error${C.reset} ${c.error ?? 0}  ${C.dim}est reward (passes+deferred): ${estReward.toFixed(0)} NOOK${C.reset}`);
  } else {
    lines.push(`  ${C.bold}Mining submissions${C.reset}  ${C.dim}0 — Tier 3 multiplier idle. Watch the next mining tick (every 15 min).${C.reset}`);
  }
  lines.push("");

  // Crowd jury
  const crowd = readJsonl<{ ts: string; outcome: string; score?: number }>(CROWD_LOG);
  const crowdScored = crowd.filter((c) => c.outcome === "scored");
  const crowd24h = crowd.filter((c) => c.outcome === "scored" && Date.now() - new Date(c.ts).getTime() < 86400_000);
  // Engagement
  const engage = readJsonl<{ ts: string; action: "comment" | "upvote"; outcome: string }>(ENGAGEMENT_LOG);
  const comments = engage.filter((e) => e.action === "comment" && e.outcome === "submitted").length;
  const upvotes = engage.filter((e) => e.action === "upvote" && e.outcome === "submitted").length;
  // Learnings
  const learnings = readJsonl<{ ts: string; status: string; specificityScore?: number }>(LEARNINGS_LOG);
  const lPosted = learnings.filter((l) => l.status === "posted").length;
  // Predictions
  const preds = readJsonl<{ ts: string; outcome: string; confidence?: number }>(PREDICTIONS_LOG);
  const pSubmitted = preds.filter((p) => p.outcome === "submitted").length;
  // Endorsements
  const endorse = readJsonl<{ ts: string; outcome: string }>(ENDORSE_LOG);
  const eSubmitted = endorse.filter((e) => e.outcome === "submitted").length;

  lines.push(`  ${C.bold}Side tracks${C.reset}`);
  lines.push(`    crowd-jury:  ${C.green}${crowdScored.length}${C.reset} scored (${crowd24h.length}/24h)  ·  engagement: ${C.green}${comments}${C.reset} comments · ${C.green}${upvotes}${C.reset} upvotes`);
  lines.push(`    learnings:   ${C.green}${lPosted}${C.reset} posted  ·  predictions: ${C.green}${pSubmitted}${C.reset} submitted  ·  endorsements: ${C.green}${eSubmitted}${C.reset}`);
  lines.push("");

  // Verification variance — quick health check
  const vstats = readJsonl<{ ts: string; correctness: number; reasoning: number; efficiency: number; novelty: number }>(VERIFY_STATS);
  if (vstats.length >= 5) {
    const lastN = vstats.slice(-Math.min(20, vstats.length));
    const dims = ["correctness", "reasoning", "efficiency", "novelty"] as const;
    const summary = dims.map((d) => {
      const xs = lastN.map((e) => e[d]);
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
      const sd = Math.sqrt(variance);
      const warn = sd < 0.10 ? `${C.yellow}!${C.reset}` : sd > 0.25 && (mean > 0.8 || mean < 0.3) ? `${C.yellow}!${C.reset}` : "";
      return `${d[0].toUpperCase()}=${mean.toFixed(2)}±${sd.toFixed(2)}${warn}`;
    }).join("  ");
    lines.push(`  ${C.bold}Verify variance${C.reset} ${C.dim}(last ${lastN.length})${C.reset}  ${summary}`);
    lines.push("");
  }

  const bountyN = listCategory("bounties").length;
  const postN = listCategory("posts").length;
  const agentN = listCategory("agents").length;
  const topicN = listCategory("topics").length;
  const researchN = listCategory("research").length;
  lines.push(`  ${C.bold}Local vault${C.reset}        bounties=${bountyN}  posts=${postN}  agents=${agentN}  topics=${topicN}  research=${researchN}`);
  lines.push("");

  const verifiedToday = countLogToday("✅ verified");
  const verifiedTotal = countLogAll("✅ verified");
  const appliedTotal = countLogAll("✅ applied to #");
  const publishesTotal = countLogAll("✅ published cid=");
  lines.push(`  ${C.bold}Bot activity${C.reset}       ${C.green}✓ verifications:${C.reset} ${verifiedTotal} all-time, ${verifiedToday} today  ·  ${C.green}✓ applies:${C.reset} ${appliedTotal}  ·  ${C.green}✓ publishes:${C.reset} ${publishesTotal}`);
  const errors = countLogToday("⚠");
  if (errors > 0) lines.push(`  ${C.yellow}                  ⚠ ${errors} warnings/errors today${C.reset}`);
  lines.push("");

  const recentLog = tailLog(25);
  if (recentLog.length > 0) {
    lines.push(`  ${C.bold}Recent activity${C.reset} ${C.dim}(tail of ${BOT_LOG})${C.reset}`);
    for (const l of recentLog) {
      let line = l.replace(/^[\s·]*/, "    ");
      if (line.length > 110) line = line.slice(0, 107) + "...";
      if (line.includes("✅") || line.includes("verified")) line = `${C.green}${line}${C.reset}`;
      else if (line.includes("⚠") || line.includes("error")) line = `${C.red}${line}${C.reset}`;
      else if (line.includes("📚") || line.includes("💎")) line = `${C.magenta}${line}${C.reset}`;
      else if (line.includes("🔍") || line.includes("⏳") || line.includes("🔎")) line = `${C.dim}${line}${C.reset}`;
      lines.push(line);
    }
  }

  lines.push("");
  lines.push(`${C.bold}${C.cyan}└─────────────────────────────────────────────────────────────────────┘${C.reset}`);
  if (!ONCE) lines.push(`  ${C.dim}Refresh every ${INTERVAL_MS / 1000}s · Ctrl+C to exit${C.reset}`);

  process.stdout.write("\x1b[H\x1b[J");
  console.log(lines.join("\n"));
}

async function main() {
  if (!API_KEY) {
    console.error("NOOKPLOT_API_KEY not set in env — source .env first or run via `npm run dashboard`");
    process.exit(1);
  }
  if (ONCE) {
    const data = await snapshot();
    render(data);
    return;
  }
  process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    process.stdout.write(`\n${C.dim}exiting${C.reset}\n`);
    process.exit(0);
  });
  while (!stop) {
    try {
      const data = await snapshot();
      render(data);
    } catch (err) {
      console.error(`${C.red}dashboard error: ${(err as Error).message}${C.reset}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("dashboard fatal:", err);
  process.exit(1);
});
