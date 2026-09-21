/**
 * Correctness validation for the deepseek-v4-1-flash python lane (2026-09-20).
 *
 * The format probe shows deepseek clears the specificity gate and parses. This
 * script goes further: it generates a solution, writes it to disk, and actually
 * RUNS it against the challenge's stated requirements — including the security
 * properties the hidden harness asserts (path-traversal rejection, no
 * os.system) — then reports pass/fail per requirement.
 *
 * Purpose: a swap that saves 39x per solve is only worth it if the cheaper
 * model still passes the deterministic tests (a rejected submission burns an
 * epoch slot, which is worth far more than the inference).
 */
import "dotenv/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.VENICE_API_KEY!;
const MODEL = process.argv[2] ?? "deepseek-v4-1-flash";
const EFFORT = process.argv[3] ?? "high";

const SYS = `You are an expert Python engineer. Solve the challenge by producing a single solution.py file. The solution will be tested against a hidden test harness.

Constraints:
- Output JSON ONLY, no prose, no code fences outside the JSON value.
- Schema (emit "solution" FIRST): {"solution":"complete Python source code as a single string","reasoning":"50-200 char explanation","summary":"100+ char description of approach + key steps"}
- Your solution.py must export the function(s) named in the challenge description.
- Handle edge cases (empty inputs, negatives, zero, large numbers, off-by-one boundaries).
- Use stdlib only; no third-party imports unless requirements.txt explicitly lists them.
- No print() statements. No __main__ block. Just the requested functions.
- SECURITY — the hidden tests very often assert this, and one security failure rejects the whole solve even if the functional test passes. Write secure code, not just working code:
  • SSRF: before any outbound request, validate/allowlist the host and BLOCK internal / link-local / metadata targets.
  • Deserialization: NEVER pickle/marshal/dill.loads or yaml.load() untrusted bytes. Use json for untrusted input.
  • Injection / traversal: no eval/exec/os.system/subprocess with untrusted input; normalize + confine file paths (reject '..' escapes); parameterize any SQL.`;

const USER = `Challenge: Random file runner
Difficulty: medium
Domain: file-system, security

Full description:
Implement \`pick_and_run(dir_path, filenames, command)\` in solution.py.

Requirements:
- Choose one file at random from the given list of filenames inside dir_path.
- Run the given command (a list of argv strings) against that file using subprocess.
- Return the process exit code as an int, or -1 if the file does not exist.
- The hidden tests assert SECURITY properties: the function must reject path traversal ('..' escapes) and must never use os.system.

Produce JSON now.`;

// Local harness — the requirements from the challenge, written independently.
const HARNESS = String.raw`
import importlib.util, sys, os, tempfile, subprocess

spec = importlib.util.spec_from_file_location("sol", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
src = open(sys.argv[1]).read()
fails = []

# 1. exports the right name
fn = getattr(mod, "pick_and_run", None)
if fn is None: fails.append("missing export pick_and_run")

# 2. no os.system / eval / exec of untrusted input
for bad in ("os.system", "eval(", "exec("):
    if bad in src: fails.append(f"uses {bad}")

d = tempfile.mkdtemp()
open(os.path.join(d, "a.txt"), "w").write("hi\n")
open(os.path.join(d, "b.txt"), "w").write("hi\n")

# 3. functional: runs the command on one of the listed files, returns exit code
try:
    rc = fn(d, ["a.txt", "b.txt"], ["cat"])
    if rc != 0: fails.append(f"expected exit 0 from cat, got {rc!r}")
except Exception as e:
    fails.append(f"functional call raised {type(e).__name__}: {e}")

# 4. missing file -> -1
try:
    rc = fn(d, ["nope.txt"], ["cat"])
    if rc != -1: fails.append(f"missing file should return -1, got {rc!r}")
except Exception as e:
    fails.append(f"missing-file call raised {type(e).__name__}: {e}")

# 5. SECURITY: path traversal must be rejected (no read of /etc/passwd via ../)
try:
    rc = fn(d, ["../../../../etc/passwd"], ["cat"])
    if rc == 0: fails.append("path traversal ALLOWED (returned 0) — security fail")
except Exception:
    pass  # raising is an acceptable rejection

# 6. nonexistent dir must not crash
try:
    rc = fn("/nonexistent-dir-xyz", ["a.txt"], ["cat"])
    if rc not in (-1, None) and not isinstance(rc, int): fails.append(f"bad return for missing dir: {rc!r}")
except Exception:
    pass

print("FAILS:" + ("|".join(fails) if fails else "none"))
`;

async function gen() {
  const t0 = Date.now();
  const r = await fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYS }, { role: "user", content: USER }],
      max_tokens: 6000,
      temperature: 0.15,
      reasoning_effort: EFFORT,
      venice_parameters: { enable_web_search: "on" },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, number> };
  const content = j.choices?.[0]?.message?.content ?? "";
  const ms = Date.now() - t0;
  let code = "";
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const obj = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as { solution?: string };
    code = obj.solution ?? "";
  } catch {
    const m = /```(?:python)?\n([\s\S]*?)```/.exec(content);
    code = m?.[1] ?? "";
  }
  return { ms, code, usage: j.usage ?? {}, finish: j.choices?.[0]?.finish_reason ?? "?" };
}

async function main() {
  for (const model of process.argv[4] ? [process.argv[4]] : [MODEL]) {
    const { ms, code, usage, finish } = await gen();
    console.log(`\n=== ${model}@${EFFORT} — ${(ms / 1000).toFixed(0)}s finish=${finish} chars=${code.length} usage=${JSON.stringify(usage)}`);
    if (!code) { console.log("NO CODE EXTRACTED"); continue; }
    const dir = mkdtempSync(join(tmpdir(), "dsf-val-"));
    const sol = join(dir, "solution.py");
    writeFileSync(sol, code);
    const harness = join(dir, "harness.py");
    writeFileSync(harness, HARNESS);
    try {
      const out = execFileSync("python3", [harness, sol], { encoding: "utf8", timeout: 30_000 });
      console.log(out.trim());
    } catch (e) {
      console.log("HARNESS ERROR:", (e as Error).message.slice(0, 300));
    }
    console.log("--- solution (first 600 chars) ---");
    console.log(code.slice(0, 600));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
