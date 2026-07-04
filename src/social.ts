import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection" | "social">;

const ENDORSE_LOG = join(NOOK_DIR, "endorsements.jsonl");

interface EndorseLogEntry {
  ts: string;
  address: string;
  skill: string;
  rating: number;
  context?: string;
  txHash?: string;
  outcome: "submitted" | "skipped" | "error";
  notes?: string;
}

interface VerifiableSubmission {
  id: string;
  solver_address?: string;
  verifier_kind?: string;
  domain_tags?: string[];
}

function loadEndorsedKeys(): Set<string> {
  return new Set(
    readJsonl<EndorseLogEntry>(ENDORSE_LOG)
      .filter((e) => e.outcome === "submitted")
      .map((e) => `${e.address.toLowerCase()}:${e.skill}`),
  );
}

/**
 * Endorse solvers of high-scoring traces we've verified recently.
 * Uses the verification audit notes already in knowledge-vault/research/
 * to find recent (submission, solver, domain, scores) tuples.
 */
export async function endorseHelpfulAgents(
  runtime: RuntimeLike,
  opts: { dryRun?: boolean; myAddress?: string | null; maxPerRun?: number } = {},
): Promise<void> {
  if (opts.dryRun) {
    console.log("🤝 (DRY_RUN — skipping endorsement pass)");
    return;
  }
  const cap = opts.maxPerRun ?? 3;
  const endorsed = loadEndorsedKeys();

  // Discover from recent verifiable-submission audit notes
  const vaultDir = join(process.cwd(), "knowledge-vault", "research");
  if (!existsSync(vaultDir)) return;
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(vaultDir).filter((f) => f.startsWith("verification-") && f.endsWith(".md"));
  if (files.length === 0) return;

  let posted = 0;
  for (const f of files.slice(-30).reverse()) {
    if (posted >= cap) break;
    const body = readFileSync(join(vaultDir, f), "utf8");
    const solverMatch = body.match(/solver:\s*(0x[0-9a-fA-F]{40})/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]*)\]/);
    const scoresMatch = body.match(/scores:\s*\[([^\]]+)\]/);
    if (!solverMatch || !scoresMatch) continue;
    const solver = solverMatch[1].toLowerCase();
    if (opts.myAddress && solver === opts.myAddress.toLowerCase()) continue;
    const scores = scoresMatch[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (scores.length < 2) continue;
    const avg = scores.reduce((s, x) => s + x, 0) / scores.length;
    // Endorse threshold (env-tunable). 0.85 was too tight — only 2 of 50
    // recent verifications cleared it. 0.70 keeps the floor meaningful
    // (a strong-pass average across 4 dims) while ~25% of verifications
    // can result in an endorsement. The 200-char insight check below adds
    // a substantive-content filter so we're not endorsing on score alone.
    const endorseThreshold = Number(process.env.BOT_ENDORSE_THRESHOLD ?? 0.70);
    if (avg < endorseThreshold) continue;

    // Provenance check: the knowledge insight we submitted on this trace must
    // be substantive enough that we'd cite it ourselves. Proxy: ≥ 200 chars
    // AND contains at least one numeric specifics signal.
    const insightMatch = body.match(/## Insight submitted\s*\n+([\s\S]*?)(?:\n##|\n*$)/);
    const insight = (insightMatch?.[1] ?? "").trim();
    if (insight.length < 200) continue;
    const hasSpecifics = /\b\d+\.?\d*\b/.test(insight) || /\b(O\(|<|>|≤|≥|≈)/.test(insight);
    if (!hasSpecifics) continue;

    const tags = (tagsMatch?.[1] ?? "")
      .split(",")
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
      .filter((t) => t && t !== "verification");
    const skill = tags[0] ?? "reasoning";
    const key = `${solver}:${skill}`;
    if (endorsed.has(key)) continue;
    const rating = avg >= 0.92 ? 5 : avg >= 0.88 ? 4 : 3;
    const ctx = `Verified ${skill} trace, avg=${avg.toFixed(2)} (4-dim)`;
    try {
      const relayRes = await runtime.social.endorse(solver, skill, rating, ctx);
      console.log(`🤝 endorsed ${solver.slice(0, 8)} for ${skill} (${rating}★) tx=${relayRes.txHash?.slice(0, 10) ?? "?"}`);
      appendJsonl(ENDORSE_LOG, {
        ts: new Date().toISOString(),
        address: solver,
        skill,
        rating,
        context: ctx,
        txHash: relayRes.txHash,
        outcome: "submitted" as const,
      });
      posted += 1;
      await new Promise((r) => setTimeout(r, 4000)); // gentle on the relayer
    } catch (err) {
      console.warn(`   ⚠ endorse ${solver.slice(0, 8)}: ${(err as Error).message}`);
      appendJsonl(ENDORSE_LOG, {
        ts: new Date().toISOString(),
        address: solver,
        skill,
        rating: 0,
        outcome: "error" as const,
        notes: (err as Error).message.slice(0, 200),
      });
    }
  }
  if (posted > 0) console.log(`🤝 endorsement pass: ${posted} new endorsements`);
}
