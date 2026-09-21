/**
 * Ground-truth check on the near-dupe gate using the LIVE verifiable pool:
 * for each submission, is its closest peer from the SAME solver (farm sibling)
 * or a DIFFERENT one (shared generator across accounts)? And how much of the
 * pool is the `Approach for "..."` template at all?
 *
 * This decides whether the gate's abstains are correct (farm) or over-firing
 * on boilerplate. Read-only; prints a table.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { descriptionSimilarity } from "./challenge-posting.js";
import { dupeWindow } from "./trace-fingerprint.js";

interface Sub {
  id: string;
  solver_address: string;
  challenge_id: string;
  trace_summary?: string | null;
  verifier_kind?: string;
}

// Pool snapshot to analyse. Default: fetch live from the gateway; pass a path
// as argv[2] to analyse a saved `GET /v1/mining/submissions/verifiable` body.
async function loadSubs(): Promise<Sub[]> {
  const file = process.argv[2];
  if (file) return JSON.parse(readFileSync(file, "utf8")).submissions as Sub[];
  const key = process.env.NOOKPLOT_API_KEY;
  if (!key) throw new Error("NOOKPLOT_API_KEY not set and no pool file given");
  const r = await fetch("https://gateway.nookplot.com/v1/mining/submissions/verifiable?limit=100", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`pool fetch ${r.status}`);
  return ((await r.json()) as { submissions: Sub[] }).submissions;
}
const subs: Sub[] = await loadSubs();

const template = (t: string) => /^\s*Approach for "/.test(t);
const nTemplate = subs.filter((s) => template(s.trace_summary ?? "")).length;
console.log(`pool: ${subs.length} submissions | template-style summaries: ${nTemplate} (${Math.round((nTemplate / subs.length) * 100)}%)`);
const bySolver = new Map<string, number>();
for (const s of subs) bySolver.set(s.solver_address, (bySolver.get(s.solver_address) ?? 0) + 1);
console.log(`distinct solvers: ${bySolver.size}`);

interface Res { id: string; solver: string; best: number; kind: "same-solver" | "other-solver" | "none"; challenge: string }

function analyse(basis: (t: string) => string, label: string) {
  const res: Res[] = [];
  for (const a of subs) {
    const ta = a.trace_summary ?? "";
    if (ta.length < 200) { res.push({ id: a.id, solver: a.solver_address, best: 0, kind: "none", challenge: a.challenge_id }); continue; }
    let best = 0, sameSolver = false, otherSolver = false;
    for (const b of subs) {
      if (b.id === a.id) continue;
      const tb = b.trace_summary ?? "";
      if (tb.length < 200) continue;
      const sim = descriptionSimilarity(basis(ta), basis(tb));
      if (sim >= 0.5) {
        if (b.solver_address === a.solver_address) sameSolver = true;
        else otherSolver = true;
      }
      if (sim > best) best = sim;
    }
    res.push({
      id: a.id, solver: a.solver_address, best,
      kind: sameSolver ? "same-solver" : otherSolver ? "other-solver" : "none",
      challenge: a.challenge_id,
    });
  }
  const flag = res.filter((r) => r.best >= 0.5);
  console.log(`[${label}] abstain=${flag.length}/${subs.length}  same-solver=${flag.filter((r) => r.kind === "same-solver").length}  other-solver=${flag.filter((r) => r.kind === "other-solver").length}  clean=${res.length - flag.length}`);
  return res;
}

analyse((t) => t.slice(0, 1500), "old basis (first 1500)");
const res = analyse(dupeWindow, "new basis (windowed)");

const flag = res.filter((r) => r.best >= 0.5);
console.log(`\nwould abstain at 0.50 (new windowed basis): ${flag.length} of ${subs.length}`);
console.log(`  matched ONLY a same-solver peer : ${flag.filter((r) => r.kind === "same-solver").length}  ← true farm signal`);
console.log(`  matched an OTHER-solver peer    : ${flag.filter((r) => r.kind === "other-solver").length}  ← shared generator / cross-account`);
console.log(`  matched nothing                 : ${res.length - flag.length}  ← verifiable if the trace fetches`);

console.log(`\nper-solver: total / would-abstain / non-template-summaries`);
for (const [s, n] of [...bySolver.entries()].sort((a, b) => b[1] - a[1])) {
  const mine = subs.filter((x) => x.solver_address === s);
  const ab = res.filter((r) => r.solver === s && r.best >= 0.5).length;
  const nt = mine.filter((x) => !template(x.trace_summary ?? "")).length;
  console.log(`  ${s.slice(0, 12)}…  ${String(n).padStart(3)} / ${String(ab).padStart(3)} abstained / ${nt} non-template`);
}

console.log(`\nverifiable candidates per kind (would NOT abstain):`);
const clean = subs.filter((s) => {
  const r = res.find((x) => x.id === s.id);
  return r && r.best < 0.5;
});
for (const s of clean.slice(0, 8)) {
  console.log(`  [${s.verifier_kind}] ${(s.trace_summary ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
}
