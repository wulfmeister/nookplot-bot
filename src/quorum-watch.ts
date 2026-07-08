/**
 * Quorum-stall watcher (diagnostic tooling).
 *
 * Mining rewards only settle when your submission reaches the network's
 * verifier quorum. That pipeline can freeze network-wide — submissions pile up
 * at v0/v1 and never reach v2+, so nothing settles and your daily claim
 * collapses even though your own solves are fine (0% reject).
 *
 * The tell is `pool.v2` in ~/.nookplot/network-status.jsonl: it sits at a
 * healthy 10-20 while submissions progress toward quorum, and drops to 0 and
 * STAYS there when the pipeline stalls. This watcher measures how long v2 has
 * been pinned at 0 and flags a stall, so you catch the "delayed → expired"
 * transition instead of discovering it at claim time.
 *
 * Runs locally off the JSONL log (no gateway auth). `npm run quorum:watch`.
 * Env: BOT_QUORUM_STALL_HOURS (default 6) — hours of v2=0 before it's a stall.
 *      BOT_QUORUM_ALERT_EXIT=1 — exit 2 on stall (for cron/alert gating).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { NOOK_DIR, readJsonlTail } from "./util.js";

const HOUR_MS = 3_600_000;

export interface NsEntry {
  ts?: string;
  epoch?: number;
  epochStatus?: string;
  pool?: {
    v2?: number;
    quorumReady?: number;
    distinctSolvers?: number;
    byDifficulty?: Record<string, number>;
    total?: number;
  };
  mine?: { pendingSubs?: number; claimableNook?: number; pendingRewards?: number };
}

export interface QuorumHealth {
  status: "no-data" | "healthy" | "stalled" | "recovering";
  stallHours: number; // measured span of the trailing v2===0 run
  latestV2: number;
  latestQuorumReady: number;
  pendingSubs: number;
  claimableNook: number;
  distinctSolvers: number;
  difficulty: string; // dominant pool difficulty
  v2Recent: number[]; // last few v2 readings, oldest → newest
  lines: string[];
}

/**
 * Pure: given chronological network-status entries, measure the trailing run
 * where pool.v2 === 0 and classify quorum health. Stall duration is measured
 * within the data (latest entry ts − first-entry-of-the-zero-run ts).
 */
export function analyzeQuorumHealth(
  entries: NsEntry[],
  opts: { stallHours?: number } = {},
): QuorumHealth {
  const stallThresh = opts.stallHours ?? 6;
  const rows = entries
    .filter((e) => e.ts && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));

  if (rows.length === 0) {
    return {
      status: "no-data", stallHours: 0, latestV2: 0, latestQuorumReady: 0,
      pendingSubs: 0, claimableNook: 0, distinctSolvers: 0, difficulty: "?",
      v2Recent: [], lines: ["── quorum watch ──", "  ⚠ no network-status data to analyze"],
    };
  }

  const v2 = (e: NsEntry) => e.pool?.v2 ?? 0;
  const latest = rows[rows.length - 1];
  const latestV2 = v2(latest);

  // Trailing run of v2===0 entries (the stall signature).
  let runStartIdx = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (v2(rows[i]) === 0) runStartIdx = i;
    else break;
  }
  const inZeroRun = runStartIdx < rows.length; // latest reading is v2===0
  const stallHours = inZeroRun
    ? (Date.parse(latest.ts!) - Date.parse(rows[runStartIdx].ts!)) / HOUR_MS
    : 0;

  const pendingSubs = latest.mine?.pendingSubs ?? 0;
  const claimableNook = latest.mine?.claimableNook ?? 0;
  const distinctSolvers = latest.pool?.distinctSolvers ?? 0;
  const byDiff = latest.pool?.byDifficulty ?? {};
  const difficulty = Object.entries(byDiff).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  const v2Recent = rows.slice(-8).map(v2);
  // Recovering = latest broke a 0-run that the immediately-prior readings were in.
  const recovering = !inZeroRun && rows.slice(-4, -1).some((e) => v2(e) === 0);

  let status: QuorumHealth["status"];
  if (inZeroRun && stallHours >= stallThresh) status = "stalled";
  else if (recovering) status = "recovering";
  else status = "healthy";

  const lines: string[] = [];
  lines.push(`── quorum watch ${latest.ts} (epoch ${latest.epoch ?? "?"} ${latest.epochStatus ?? ""}) ──`);
  lines.push(`  pool: v2=${latestV2} quorumReady=${latest.pool?.quorumReady ?? 0} solvers=${distinctSolvers} difficulty=${difficulty}(${byDiff[difficulty] ?? 0}%)`);
  lines.push(`  mine: pendingSubs=${pendingSubs} claimableNook=${Math.round(claimableNook)}`);
  lines.push(`  v2 last ${v2Recent.length}: [${v2Recent.join(", ")}]`);
  if (status === "stalled") {
    lines.push(`  🚨 STALL: v2 pinned at 0 for ~${stallHours.toFixed(1)}h (≥${stallThresh}h) — nothing reaching quorum network-wide.`);
    lines.push(`     ${pendingSubs} of your submissions pending, ${Math.round(claimableNook)} claimable. Delayed income; expiry risk rises the longer this holds.`);
  } else if (status === "recovering") {
    lines.push(`  🌤 RECOVERING: v2 back to ${latestV2} after a recent 0-run — quorum resuming; pending subs should start settling.`);
  } else if (latestV2 === 0) {
    lines.push(`  ⏳ v2=0 for ~${stallHours.toFixed(1)}h — under the ${stallThresh}h stall threshold; watching.`);
  } else {
    lines.push(`  ✅ healthy: v2=${latestV2} — submissions are progressing toward quorum.`);
  }
  return {
    status, stallHours: Number(stallHours.toFixed(1)), latestV2,
    latestQuorumReady: latest.pool?.quorumReady ?? 0, pendingSubs, claimableNook,
    distinctSolvers, difficulty, v2Recent, lines,
  };
}

const REPORT = join(NOOK_DIR, "logs", "quorum-watch.log");
const SOURCE = join(NOOK_DIR, "network-status.jsonl");

function run(): void {
  const stallHours = Number(process.env.BOT_QUORUM_STALL_HOURS ?? 6);
  const entries = readJsonlTail<NsEntry>(SOURCE, 400);
  const health = analyzeQuorumHealth(entries, { stallHours });
  const out = health.lines.join("\n");
  console.log(out);
  try {
    mkdirSync(join(NOOK_DIR, "logs"), { recursive: true });
    appendFileSync(REPORT, out + "\n");
  } catch {
    /* report is best-effort */
  }
  if (process.env.BOT_QUORUM_ALERT_EXIT === "1" && health.status === "stalled") process.exit(2);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    run();
  } catch (e) {
    console.error("quorum watch failed:", (e as Error).message);
    process.exit(1);
  }
}
