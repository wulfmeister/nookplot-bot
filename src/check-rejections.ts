/**
 * Rejection-rate re-check (diagnostic tooling). Fetches your recent gateway
 * submissions, measures the rejection rate + per-model breakdown before/after a
 * deploy boundary, and compares to a baseline. Useful after changing your solve
 * routing or prompts to confirm the rejection rate actually dropped.
 *
 * Set BOT_FIX_DEPLOY to the ISO timestamp of the change you're evaluating
 * (submissions after it count as "post-fix"); BASELINE below is the pre-change
 * rate you're comparing against — edit both for your own experiment.
 *
 * Runs locally (needs gateway auth via .env). `npm run rejection:check`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getRuntime } from "./runtime.js";
import { NOOK_DIR } from "./util.js";

// Deploy boundary to evaluate — set BOT_FIX_DEPLOY (no default; the check is a
// no-op comparison until you point it at a change you made).
const FIX_DEPLOY_MS = Date.parse(process.env.BOT_FIX_DEPLOY ?? new Date().toISOString());
// Pre-change baseline to compare against (edit for your own experiment).
const BASELINE = { rejectRate: 0.106, grokRejectRate: 0.44, opusRejectRate: 0.08 };
const REPORT = join(NOOK_DIR, "logs", "rejection-check.log");

interface Sub {
  status?: string;
  submittedAt?: string;
  modelUsed?: string;
  traceFormat?: string;
  verificationOutcome?: { verifier_kind?: string } | null;
}

/** Pure: post-fix status distribution, reject rate, and per-model reject rate on code (tests) kinds. */
export function analyzeRejections(subs: Sub[], sinceMs: number) {
  const post = subs.filter((s) => s.submittedAt && Date.parse(s.submittedAt) >= sinceMs);
  const dist: Record<string, number> = {};
  for (const s of post) dist[String(s.status)] = (dist[String(s.status)] ?? 0) + 1;
  const resolved = (dist.verified ?? 0) + (dist.rejected ?? 0) + (dist.expired ?? 0);
  const rejectRate = resolved ? (dist.rejected ?? 0) / resolved : 0;

  // Model breakdown on code (python_tests / javascript_tests) submissions.
  const isCode = (s: Sub) =>
    String(s.verificationOutcome?.verifier_kind ?? "").endsWith("_tests") || s.traceFormat === "reasoning_v1";
  const byModel: Record<string, { n: number; rejected: number }> = {};
  for (const s of post.filter(isCode)) {
    const m = s.modelUsed ?? "?";
    byModel[m] = byModel[m] ?? { n: 0, rejected: 0 };
    byModel[m].n++;
    if (String(s.status) === "rejected") byModel[m].rejected++;
  }
  return { postCount: post.length, dist, resolved, rejectRate, byModel, grokCodeUsed: byModel["grok-4-3"]?.n ?? 0 };
}

function verdict(a: ReturnType<typeof analyzeRejections>): string[] {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`── rejection re-check ${new Date().toISOString()} ──`);
  if (a.resolved < 8) {
    lines.push(`  ⚠ only ${a.resolved} resolved post-fix submissions — too few to judge yet (need ~2-3 epochs). Re-run later.`);
    return lines;
  }
  lines.push(`  post-fix resolved: ${a.resolved} | dist: ${JSON.stringify(a.dist)}`);
  lines.push(`  reject rate: ${pct(a.rejectRate)}  (baseline ${pct(BASELINE.rejectRate)})  → ${a.rejectRate < BASELINE.rejectRate ? "IMPROVED ✅" : "not improved ✗"}`);
  for (const [m, x] of Object.entries(a.byModel)) {
    lines.push(`    ${m}: n=${x.n} rejected=${x.rejected} (${pct(x.n ? x.rejected / x.n : 0)})`);
  }
  lines.push(`  grok-4-3 on code solves: ${a.grokCodeUsed}  → ${a.grokCodeUsed === 0 ? "routing works ✅ (grok off code)" : "⚠ still being used on code"}`);
  const good = a.rejectRate < BASELINE.rejectRate && a.grokCodeUsed === 0;
  lines.push(`  VERDICT: ${good ? "✅ fixes working — rejections down and grok off the code path" : "⚠ mixed — inspect the model breakdown above"}`);
  return lines;
}

async function run(): Promise<void> {
  const rt = getRuntime() as unknown as { connect: () => Promise<void>; connection: { address: string; request: (m: string, p: string) => Promise<unknown> } };
  await rt.connect();
  const addr = rt.connection.address;
  const res = (await rt.connection.request("GET", `/v1/mining/submissions/agent/${addr}?limit=300`)) as { submissions?: Sub[] };
  const subs = res.submissions ?? [];
  const lines = verdict(analyzeRejections(subs, FIX_DEPLOY_MS));
  const out = lines.join("\n");
  console.log(out);
  try {
    mkdirSync(join(NOOK_DIR, "logs"), { recursive: true });
    appendFileSync(REPORT, out + "\n");
  } catch {
    /* report is best-effort */
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("rejection check failed:", (e as Error).message);
    process.exit(1);
  });
}
