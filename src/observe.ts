/**
 * Poor-man's self-improving bot.
 *
 * Once an hour, the bot reads its own logs and asks Claude Opus (xhigh thinking)
 * to identify patterns worth attention. Output is markdown — never auto-applied
 * code. Future agents see OBSERVATIONS.md on boot via the AGENTS.md pre-flight
 * checklist and can act on the proposals.
 *
 * Two outputs:
 *   - observations/YYYY-MM-DD.md  — full daily log, append-only
 *   - OBSERVATIONS.md             — rolling top-10, auto-pruned to 7 days
 *
 * Safe by design:
 *   - Confidence ≥ 0.6 filter to suppress noise
 *   - Reversibility = "easy" filter — high-stakes changes need human review
 *   - Never auto-applies code edits
 *   - Silence is fine: an empty observation is a valid output
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { chat } from "./venice.js";
import { NOOK_DIR, BOT_LOG_PATH, appendJsonl, extractJsonObj, readJsonl } from "./util.js";
import { readCapacity, capacityUnderuse } from "./capacity.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const BOT_LOG = BOT_LOG_PATH;
const REPO_ROOT = process.cwd();
const OBS_DIR = join(REPO_ROOT, "observations");
const ROLLING = join(REPO_ROOT, "OBSERVATIONS.md");
const RUN_LOG = join(NOOK_DIR, "observations-run.jsonl");

const WINDOW_MS = 60 * 60 * 1000; // last hour
const PRUNE_DAYS = 7;
const MAX_ROLLING_ENTRIES = 10;
// If the bot log hasn't been written in this long it is NOT live — the bot was
// likely launched without self-logging/tee, or has wedged. The log-derived
// signals (errors/rate-limits/warnings + the tail fed to the LLM) are then
// STALE and must not be reported as current, or the observer will "discover"
// days-old problems every hour. 2h gives a healthy hourly-ticking bot slack.
const LOG_STALE_MS = 2 * WINDOW_MS;

interface Observation {
  pattern: string;
  hypothesis: string;
  proposedChange: string;
  confidence: number;
  reversibility: "easy" | "moderate" | "hard";
}

interface RollingEntry {
  ts: string;
  pattern: string;
  hypothesis: string;
  proposedChange: string;
  confidence: number;
  reversibility: string;
  resolved?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Stats — pure number crunching, no LLM
// ─────────────────────────────────────────────────────────────

/** Human label for a log-staleness age. Handles the missing-file (Infinity) case. */
function logAgeHuman(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "missing";
  return `~${Math.round(ageMs / 3600_000)}h`;
}

function readRecentLog(): { lines: string[]; errors: number; rateLimits: number; warnings: number; stale: boolean; ageMs: number } {
  if (!existsSync(BOT_LOG)) return { lines: [], errors: 0, rateLimits: 0, warnings: 0, stale: true, ageMs: Infinity };
  // Staleness check FIRST: if the file hasn't been touched within LOG_STALE_MS
  // it is not a live log. We still read the tail (for the operator-facing note)
  // but flag it so the counts/tail are not presented to the LLM as current.
  const ageMs = Date.now() - statSync(BOT_LOG).mtimeMs;
  const stale = ageMs > LOG_STALE_MS;
  const raw = readFileSync(BOT_LOG, "utf8");
  const lines = raw.split("\n");
  // Best-effort: log lines don't all have timestamps; just take the tail.
  // 1 hour of activity typically produces 200-800 lines.
  const tail = lines.slice(-600);
  let errors = 0;
  let rateLimits = 0;
  let warnings = 0;
  for (const l of tail) {
    if (/error/i.test(l)) errors += 1;
    if (l.includes("429") || /Rate limited/.test(l)) rateLimits += 1;
    if (l.includes("⚠")) warnings += 1;
  }
  // A stale tail describes a PAST run — zero the live counters so they aren't
  // reported as this hour's activity. ageMs/stale carry the real signal.
  if (stale) return { lines: tail, errors: 0, rateLimits: 0, warnings: 0, stale, ageMs };
  return { lines: tail, errors, rateLimits, warnings, stale, ageMs };
}

function summarizeJsonl<T>(
  path: string,
  windowMs: number,
  bucketer: (entry: T) => string,
): Record<string, number> {
  const entries = readJsonl<T & { ts?: string }>(path);
  const cutoff = Date.now() - windowMs;
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (!e.ts || new Date(e.ts).getTime() < cutoff) continue;
    const bucket = bucketer(e);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

interface TrackSnapshot {
  mining: { hourly: Record<string, number>; allTime: number };
  crowdJury: { hourly: Record<string, number> };
  learnings: { hourly: Record<string, number> };
  predictions: { hourly: Record<string, number> };
  engagement: { hourly: Record<string, number> };
  endorsements: { hourly: Record<string, number> };
  knowledge: { hourly: Record<string, number>; recentTitles: string[] };
  verification: { hourly: number; meanByDim: Record<string, number>; sdByDim: Record<string, number>; lastN: number };
  bounties: { hourlyApplied: number };
  log: { errors: number; rateLimits: number; warnings: number; lineCount: number; stale: boolean; ageMs: number };
  capacity: { underuse: string | null };
}

function gatherStats(): TrackSnapshot {
  const mining = summarizeJsonl<{ outcome: string }>(join(NOOK_DIR, "mining-submissions.jsonl"), WINDOW_MS, (e) => e.outcome);
  const miningAll = readJsonl(join(NOOK_DIR, "mining-submissions.jsonl")).length;
  const crowdJury = summarizeJsonl<{ outcome: string }>(join(NOOK_DIR, "crowd-jury.jsonl"), WINDOW_MS, (e) => e.outcome);
  const learnings = summarizeJsonl<{ status: string }>(join(NOOK_DIR, "learnings-posted.jsonl"), WINDOW_MS, (e) => e.status);
  const predictions = summarizeJsonl<{ outcome: string }>(join(NOOK_DIR, "predictions.jsonl"), WINDOW_MS, (e) => e.outcome);
  const engagement = summarizeJsonl<{ action: string; outcome: string }>(join(NOOK_DIR, "engagement.jsonl"), WINDOW_MS, (e) => `${e.action}:${e.outcome}`);
  const endorsements = summarizeJsonl<{ outcome: string }>(join(NOOK_DIR, "endorsements.jsonl"), WINDOW_MS, (e) => e.outcome);

  const knowledge = summarizeJsonl<{ source?: string }>(join(NOOK_DIR, "knowledge-published.jsonl"), 24 * 60 * 60 * 1000, (e) => e.source ?? "legacy");
  const knowledgeAll = readJsonl<{ ts?: string; title?: string }>(join(NOOK_DIR, "knowledge-published.jsonl"));
  const recentTitles = knowledgeAll.slice(-5).map((k) => k.title ?? "?");

  // Verification variance — read last 20 entries
  interface VStat { ts?: string; correctness: number; reasoning: number; efficiency: number; novelty: number }
  const vEntries = readJsonl<VStat>(join(NOOK_DIR, "verification-stats.jsonl"));
  const cutoff = Date.now() - WINDOW_MS;
  const vRecent = vEntries.filter((e) => e.ts && new Date(e.ts).getTime() >= cutoff);
  const vLast20 = vEntries.slice(-20);
  const meanByDim: Record<string, number> = {};
  const sdByDim: Record<string, number> = {};
  const dims = ["correctness", "reasoning", "efficiency", "novelty"] as const;
  for (const d of dims) {
    if (vLast20.length === 0) {
      meanByDim[d] = 0;
      sdByDim[d] = 0;
      continue;
    }
    const xs = vLast20.map((e) => e[d]);
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
    meanByDim[d] = Math.round(m * 100) / 100;
    sdByDim[d] = Math.round(Math.sqrt(v) * 100) / 100;
  }

  const log = readRecentLog();

  // Bounty applications in the last hour
  const abLog = readJsonl<{ ts?: string }>(join(NOOK_DIR, "ab-applications.jsonl"));
  const bountyApplied = abLog.filter((e) => e.ts && new Date(e.ts).getTime() >= cutoff).length;

  return {
    mining: { hourly: mining, allTime: miningAll },
    crowdJury: { hourly: crowdJury },
    learnings: { hourly: learnings },
    predictions: { hourly: predictions },
    engagement: { hourly: engagement },
    endorsements: { hourly: endorsements },
    knowledge: { hourly: knowledge, recentTitles },
    verification: { hourly: vRecent.length, meanByDim, sdByDim, lastN: vLast20.length },
    bounties: { hourlyApplied: bountyApplied },
    log: { errors: log.errors, rateLimits: log.rateLimits, warnings: log.warnings, lineCount: log.lines.length, stale: log.stale, ageMs: log.ageMs },
    capacity: { underuse: capacityUnderuse(readCapacity(10)) },
  };
}

// ─────────────────────────────────────────────────────────────
// LLM observation
// ─────────────────────────────────────────────────────────────

async function askForPatterns(stats: TrackSnapshot, recentLogTail: string[]): Promise<Observation[]> {
  const sys = `You are an autonomous bot's periodic self-observer. The bot operates earning tracks on the Nookplot agent network: verifications, bounty applications, knowledge publishing, mining submissions, crowd-jury scoring, post-solve learnings, predictions, endorsements, engagement (comments + upvotes).

Your task: given the last hour of activity stats + log tail, identify up to 3 CONCRETE patterns worth attention. For each, provide:
- pattern: what you observed, with specific numbers
- hypothesis: why this might be happening
- proposedChange: a specific file:section change (e.g. "src/mining.ts loadCaches: drop the 4h error cooldown to 1h"). NOT vague advice.
- confidence: your 0-1 confidence this is worth acting on
- reversibility: "easy" (config knob, single-line tune), "moderate" (refactor a function), "hard" (architectural)

CRITICAL FILTERS:
- If nothing concrete is worth flagging, return {"observations": []} — silence is good output. We'd rather skip a tick than dilute the signal.
- Don't propose changes that require new SDK features or new endpoints — only changes to files in src/.
- Don't propose adding/removing tracks — only tuning what exists.
- Don't repeat patterns from recent observations (you'll see them in the rolling context).
- Specifics > generalities. "Mining error rate 30% over 4 attempts in last hour, all timeout" beats "mining could be better".

OUTPUT: JSON ONLY:
{"observations": [{"pattern": "...", "hypothesis": "...", "proposedChange": "...", "confidence": 0.0, "reversibility": "easy"}]}`;

  // Read rolling for context — avoid duplicate observations
  let recentObs = "";
  if (existsSync(ROLLING)) {
    recentObs = readFileSync(ROLLING, "utf8").slice(0, 4000);
  }

  // When the log is stale the tail describes a PAST run. Feeding it to the LLM
  // makes it "discover" days-old issues every hour (the failure this guard was
  // added for). Suppress the tail and tell the model to rely on JSONL stats.
  const logSection = stats.log.stale
    ? `# Log tail — SUPPRESSED\n⚠ The bot log is STALE (${logAgeHuman(stats.log.ageMs)} old, last written long before this hour). It is NOT live and has been withheld. Do NOT infer any live problem from log contents this tick. Base observations ONLY on the JSONL-derived stats above (mining/verify/knowledge/etc.). The single most useful observation you can make is that the log itself is not being written — flag that if not already noted.`
    : `# Log tail (newest 50 + sample of older 50)\n\`\`\`\n${(
        recentLogTail.slice(-50).join("\n") +
        "\n... (sampled) ...\n" +
        recentLogTail.slice(0, Math.min(50, recentLogTail.length)).join("\n")
      ).slice(0, 8000)}\n\`\`\``;

  const user = `# Current stats (last 1 hour)
\`\`\`json
${JSON.stringify(stats, null, 2)}
\`\`\`

${logSection}

# Recent observations (avoid repeating)
${recentObs.slice(0, 3500)}

Identify up to 3 concrete patterns worth attention. Silence is fine.`;

  try {
    const res = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      {
        model: process.env.MODEL_OBSERVE ?? "claude-opus-4-8",
        max_tokens: 2500,
        temperature: 0.2,
        timeoutMs: 180_000,
      },
    );
    const parsed = extractJsonObj<{ observations?: Observation[] }>(res.content);
    if (!parsed?.observations) return [];
    return parsed.observations.filter(
      (o): o is Observation =>
        typeof o?.pattern === "string" &&
        typeof o?.hypothesis === "string" &&
        typeof o?.proposedChange === "string" &&
        typeof o?.confidence === "number" &&
        (o?.reversibility === "easy" || o?.reversibility === "moderate" || o?.reversibility === "hard"),
    );
  } catch (err) {
    console.warn(`   ⚠ observe LLM error: ${(err as Error).message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Output: append daily, refresh rolling top-10
// ─────────────────────────────────────────────────────────────

function ensureObsDir() {
  if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
}

function todayFile(): string {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10);
  return join(OBS_DIR, `${ymd}.md`);
}

function appendDaily(obs: Observation[], stats: TrackSnapshot) {
  ensureObsDir();
  const file = todayFile();
  const now = new Date().toISOString();
  let block = `\n## ${now}\n\n`;
  const logField = stats.log.stale
    ? `log=STALE(${logAgeHuman(stats.log.ageMs)} — not live)`
    : `errors=${stats.log.errors} · 429s=${stats.log.rateLimits}`;
  block += `**Tick stats**: mining=${JSON.stringify(stats.mining.hourly)} · verify=${stats.verification.hourly} · bounty-apply=${stats.bounties.hourlyApplied} · ${logField}\n\n`;
  if (stats.capacity.underuse) block += `**⚠ ${stats.capacity.underuse}** — run \`npm run capacity\`\n\n`;
  if (obs.length === 0) {
    block += `_No observations worth flagging this hour. Stats above were nominal._\n`;
  } else {
    for (const o of obs) {
      block += `### Pattern (confidence ${o.confidence.toFixed(2)}, ${o.reversibility})\n`;
      block += `**Observed:** ${o.pattern}\n\n`;
      block += `**Why:** ${o.hypothesis}\n\n`;
      block += `**Proposed change:** ${o.proposedChange}\n\n`;
    }
  }
  const existing = existsSync(file) ? readFileSync(file, "utf8") : `# Observations — ${new Date().toISOString().slice(0, 10)}\n`;
  writeFileSync(file, existing + block);
}

function refreshRolling(newObs: Observation[]) {
  // Load all daily files, parse out observations from the last PRUNE_DAYS days,
  // dedupe by proposedChange, keep top MAX_ROLLING_ENTRIES by confidence, sort by recency.
  const existing: RollingEntry[] = [];
  ensureObsDir();
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 3600_000;
  const files = readdirSync(OBS_DIR).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    const fpath = join(OBS_DIR, f);
    const stat = statSync(fpath);
    if (stat.mtimeMs < cutoff) continue;
    const text = readFileSync(fpath, "utf8");
    // Parse "## <iso>" blocks
    const blocks = text.split(/\n## /).slice(1);
    for (const block of blocks) {
      const lines = block.split("\n");
      const ts = lines[0]?.trim();
      if (!ts || new Date(ts).getTime() < cutoff) continue;
      // Multi-pattern blocks: split by "### Pattern"
      const patterns = block.split(/\n### Pattern/).slice(1);
      for (const p of patterns) {
        const confMatch = p.match(/confidence\s+([\d.]+),\s*(\w+)/);
        const observedMatch = p.match(/\*\*Observed:\*\*\s*(.+?)(?:\n|$)/);
        const whyMatch = p.match(/\*\*Why:\*\*\s*(.+?)(?:\n|$)/);
        const propMatch = p.match(/\*\*Proposed change:\*\*\s*(.+?)(?:\n|$)/);
        if (!observedMatch || !propMatch) continue;
        existing.push({
          ts,
          pattern: observedMatch[1].trim(),
          hypothesis: whyMatch?.[1]?.trim() ?? "",
          proposedChange: propMatch[1].trim(),
          confidence: confMatch ? parseFloat(confMatch[1]) : 0.6,
          reversibility: confMatch?.[2] ?? "easy",
        });
      }
    }
  }

  // Also include the just-generated ones
  const now = new Date().toISOString();
  for (const o of newObs) {
    existing.push({
      ts: now,
      pattern: o.pattern,
      hypothesis: o.hypothesis,
      proposedChange: o.proposedChange,
      confidence: o.confidence,
      reversibility: o.reversibility,
    });
  }

  // Dedupe by proposedChange (case-insensitive)
  const seen = new Set<string>();
  const deduped: RollingEntry[] = [];
  for (const e of [...existing].reverse()) {
    const key = e.proposedChange.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  // Sort by confidence then recency, take top N
  deduped.sort((a, b) => b.confidence - a.confidence || new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const top = deduped.slice(0, MAX_ROLLING_ENTRIES);

  // Write OBSERVATIONS.md
  let body = `# OBSERVATIONS.md\n\n`;
  body += `_Self-generated by the hourly observe loop. Open the relevant \`observations/YYYY-MM-DD.md\` for full daily history. Entries auto-pruned after ${PRUNE_DAYS} days. Top ${MAX_ROLLING_ENTRIES} active concerns by confidence:_\n\n`;
  body += `_Last refreshed: ${now}_\n\n`;
  if (top.length === 0) {
    body += `_(no active observations — bot is operating nominally)_\n`;
  } else {
    for (let i = 0; i < top.length; i++) {
      const e = top[i];
      body += `## ${i + 1}. ${e.pattern.slice(0, 140)} _(conf ${e.confidence.toFixed(2)}, ${e.reversibility})_\n\n`;
      body += `**Observed at:** ${e.ts}\n\n`;
      if (e.hypothesis) body += `**Hypothesis:** ${e.hypothesis}\n\n`;
      body += `**Proposed change:** ${e.proposedChange}\n\n`;
      body += `---\n\n`;
    }
  }
  body += `\n## How to use this file\n\n`;
  body += `1. On agent boot, scan the entries above before changing any track.\n`;
  body += `2. If you act on an observation, mark its block here with \`<!-- resolved YYYY-MM-DD -->\` and it will roll off naturally.\n`;
  body += `3. If you disagree, just ignore — entries auto-prune after ${PRUNE_DAYS} days.\n`;
  body += `4. To trigger a fresh observation manually: \`npm run observe\`.\n`;
  writeFileSync(ROLLING, body);
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

export async function runObservationTick(_runtime: RuntimeLike, opts: { dryRun?: boolean } = {}): Promise<void> {
  if (opts.dryRun) {
    console.log("🔭 (DRY_RUN — skipping observation)");
    return;
  }
  const startedAt = new Date().toISOString();
  const stats = gatherStats();
  const recentLog = readRecentLog();
  if (stats.log.stale) {
    console.warn(`🔭 ⚠ bot.log is STALE (${logAgeHuman(stats.log.ageMs)} old) — log-derived signals suppressed this tick. Is the bot self-logging? (see src/bot-log.ts / BOT_LOG_PATH)`);
  }
  if (stats.capacity.underuse) {
    console.warn(`🔭 ⚠ ${stats.capacity.underuse} — wasted earning capacity; see 'npm run capacity'`);
  }
  console.log(`🔭 observe tick — log=${stats.log.lineCount} lines${stats.log.stale ? " (STALE)" : `, ${stats.log.errors} errors, ${stats.log.rateLimits} rate-limits`}`);

  const obs = await askForPatterns(stats, recentLog.lines);
  // Filter: confidence ≥ 0.6 AND reversibility = "easy" (safe to auto-act, or at least to consider)
  const filtered = obs.filter((o) => o.confidence >= 0.6 && o.reversibility === "easy");
  console.log(`🔭 ${obs.length} raw observations · ${filtered.length} pass filter (conf≥0.6 + easy)`);

  appendDaily(filtered, stats);
  refreshRolling(filtered);
  appendJsonl(RUN_LOG, {
    ts: startedAt,
    rawCount: obs.length,
    filteredCount: filtered.length,
    stats: {
      verify: stats.verification.hourly,
      miningHourly: stats.mining.hourly,
      bountyHourly: stats.bounties.hourlyApplied,
      errors: stats.log.errors,
      rateLimits: stats.log.rateLimits,
      logStale: stats.log.stale,
      logAgeMs: stats.log.ageMs,
      capacityUnderuse: stats.capacity.underuse,
    },
  });
}

// Allow running as a one-shot CLI: `npm run observe`
if (process.argv[1]?.endsWith("observe.ts") || process.argv[1]?.endsWith("observe.js")) {
  (async () => {
    // For CLI mode we don't need the runtime — observe is pure local-state analysis.
    const fakeRuntime = { connection: {} as never };
    await runObservationTick(fakeRuntime as RuntimeLike);
    console.log(`✓ Wrote daily log + refreshed OBSERVATIONS.md`);
  })().catch((err) => {
    console.error("observe failed:", err);
    process.exit(1);
  });
}
