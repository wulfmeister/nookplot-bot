/**
 * Local-test verifiable submissions through the gateway sandbox before
 * we submit. The gateway exposes POST /v1/exec (the same surface the
 * nookplot_exec_code MCP tool uses). Cost: ~0.51 credits per call,
 * confirmed live 2026-05-24.
 *
 * For python_tests / javascript_tests we run the solution against a
 * stub harness derived from the challenge's submissionGuide; if exit
 * code 0 we have *some* confidence before paying for a real submission.
 * The grader's full test set is hidden, so this is a smoke test, not a
 * proof — but it catches syntax errors, missing imports, obvious bugs.
 *
 * For exact_answer we just sanity-check that the answer string isn't
 * empty/whitespace and (when sampleIO is provided) doesn't contradict
 * any preview pair.
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface SubmissionGuide {
  // Gateway has shipped this as string, { code: string }, { content: string },
  // and { files: { name: string }[] } across different challenge kinds.
  // Use `coerceStarterCode()` before calling string methods on it.
  starterCode?: unknown;
  requirements_txt?: string;
  package_json?: string;
  image?: string;
  entrypoint?: string;
  submissionHint?: string;
  sampleIO?: Array<{ input?: unknown; output?: unknown }>;
}

/**
 * Coerce the gateway's polymorphic starterCode into a plain string for the
 * solver prompt. Returns "" if the shape is foreign — callers proceed
 * without a starter rather than crashing.
 */
export function coerceStarterCode(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  if (typeof o.code === "string") return o.code;
  if (typeof o.content === "string") return o.content;
  if (typeof o.text === "string") return o.text;
  if (typeof o.body === "string") return o.body;
  if (Array.isArray(o.files)) {
    const lines: string[] = [];
    for (const f of o.files) {
      if (f && typeof f === "object") {
        const fc = (f as { content?: unknown; code?: unknown; name?: unknown }).content
          ?? (f as { content?: unknown; code?: unknown; name?: unknown }).code;
        if (typeof fc === "string") lines.push(fc);
      } else if (typeof f === "string") {
        lines.push(f);
      }
    }
    return lines.join("\n");
  }
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string").join("\n");
  }
  return "";
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  creditsCharged?: number;
}

const DEFAULT_PY_IMAGE = "python:3.12-slim";
const DEFAULT_JS_IMAGE = "node:22-slim";

/**
 * Fetch the challenge detail (which includes submissionGuide for
 * verifiable challenges). Soft-fails: returns null if absent or
 * gateway errors — callers proceed without it.
 */
export async function fetchSubmissionGuide(
  runtime: RuntimeLike,
  challengeId: string,
): Promise<SubmissionGuide | null> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/mining/challenges/${encodeURIComponent(challengeId)}`,
    )) as { submissionGuide?: SubmissionGuide };
    return res.submissionGuide ?? null;
  } catch {
    return null;
  }
}

async function execInSandbox(
  runtime: RuntimeLike,
  command: string,
  image: string,
  files: Record<string, string>,
  timeoutSec = 60,
): Promise<ExecResult | null> {
  try {
    const res = (await runtime.connection.request("POST", "/v1/exec", {
      command,
      image,
      files,
      timeout: timeoutSec,
    })) as ExecResult;
    return res;
  } catch (err) {
    console.warn(`   🧪 sandbox exec failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Quick smoke-test for a python_tests submission. Mounts solution.py
 * and runs `python -c "import solution; print('ok')"` to catch syntax
 * and import-time errors. Returns true on exit 0, false on non-zero,
 * null if sandbox unavailable.
 */
export async function smokeTestPython(
  runtime: RuntimeLike,
  solutionPy: string,
  guide: SubmissionGuide | null,
): Promise<{ ok: boolean; details: string } | null> {
  const files: Record<string, string> = { "solution.py": solutionPy };
  // If the grader provides starter code, include it — solution should
  // be a drop-in replacement for the same module shape.
  // Most python_tests graders import `solution` and call exported funcs.
  const image = guide?.image && guide.image.startsWith("python:") ? guide.image : DEFAULT_PY_IMAGE;
  // Try to install requirements if provided + non-empty + small.
  const cmds: string[] = [];
  if (guide?.requirements_txt && guide.requirements_txt.trim().length > 0 && guide.requirements_txt.length < 4000) {
    files["requirements.txt"] = guide.requirements_txt;
    cmds.push("pip install --quiet -r requirements.txt 2>&1 | tail -5 || true");
  }
  cmds.push(`python -c "import solution; print('IMPORT_OK', [n for n in dir(solution) if not n.startswith('_')][:20])"`);
  const command = cmds.join(" && ");
  const res = await execInSandbox(runtime, command, image, files, 90);
  if (!res) return null;
  const ok = res.exitCode === 0 && res.stdout.includes("IMPORT_OK");
  const details = (res.stderr || res.stdout || "").replace(/\s+/g, " ").slice(0, 300);
  return { ok, details };
}

export async function smokeTestJs(
  runtime: RuntimeLike,
  solutionJs: string,
  guide: SubmissionGuide | null,
): Promise<{ ok: boolean; details: string } | null> {
  const files: Record<string, string> = {
    "solution.js": solutionJs,
    "package.json": guide?.package_json ?? '{"type":"module"}',
  };
  const image = guide?.image && guide.image.startsWith("node:") ? guide.image : DEFAULT_JS_IMAGE;
  const command = `node --input-type=module -e "import('./solution.js').then(m => console.log('IMPORT_OK', Object.keys(m).slice(0,20))).catch(e => { console.error(e); process.exit(1); })"`;
  const res = await execInSandbox(runtime, command, image, files, 90);
  if (!res) return null;
  const ok = res.exitCode === 0 && res.stdout.includes("IMPORT_OK");
  const details = (res.stderr || res.stdout || "").replace(/\s+/g, " ").slice(0, 300);
  return { ok, details };
}

/**
 * For exact_answer: check that the answer string isn't empty and that
 * it doesn't trivially mismatch any sampleIO output (when provided).
 * This is a free check (no sandbox call) — sampleIO is in the guide.
 */
export function smokeTestExactAnswer(
  answer: string,
  guide: SubmissionGuide | null,
): { ok: boolean; details: string } {
  const a = (answer ?? "").trim();
  if (!a) return { ok: false, details: "empty answer" };
  if (a.length > 1000) return { ok: false, details: `answer too long (${a.length})` };
  // We can't truly evaluate without the grader, but if sampleIO output
  // is provided AND our answer is identical to ANY sample output, that's
  // a positive smoke signal (means we matched the format at least).
  if (guide?.sampleIO && Array.isArray(guide.sampleIO)) {
    const sampleOuts = guide.sampleIO.map((s) => String(s.output ?? "").trim()).filter(Boolean);
    if (sampleOuts.length > 0 && sampleOuts.includes(a)) {
      return { ok: true, details: "exact match to a sample output (suspicious — could be sampleIO leak)" };
    }
  }
  return { ok: true, details: `length=${a.length}` };
}

/**
 * Verdict from the authoritative pre-submit dry-run (sandbox_test_code):
 *   - pass:      compile-check passed in the challenge's real env → safe to submit
 *   - hard_fail: solution broke at compile/import/collection → it WILL fail
 *                grading, so the caller should skip the submit and keep the slot
 *   - skip:      dry-run unsupported / rate-limited / unavailable → caller falls
 *                back to the legacy smoke and never blocks
 */
export type DryRunVerdict =
  | { status: "pass"; details: string }
  | { status: "hard_fail"; details: string }
  | { status: "skip"; reason: string };

// Rolling 1-hour budget. The gateway caps sandbox_test_code at 20/hr/agent and
// returns 429 DRYRUN_RATE_LIMITED past that; we stop a few short so a 429 never
// costs us a wasted round-trip and we degrade to the legacy smoke instead.
const DRYRUN_HOURLY_CAP = 18;
const dryRunCalls: number[] = [];
function dryRunBudgetLeft(now = Date.now()): boolean {
  const cutoff = now - 3_600_000;
  while (dryRunCalls.length && dryRunCalls[0] < cutoff) dryRunCalls.shift();
  return dryRunCalls.length < DRYRUN_HOURLY_CAP;
}

/**
 * Authoritative pre-submit gate for python_tests via the real grader sandbox
 * (sandbox_test_code MCP action). With no testFiles the gateway compile-checks
 * the solution in the challenge's OWN env (correct image + setup) — catching the
 * #1 python_tests failure, an ImportError/AttributeError at collection, that the
 * generic python:3.12-slim /v1/exec image silently misses.
 *
 * Asymmetric on purpose: a green run only proves the module imports (NOT that
 * it solves the challenge), so we never block on `pass`; but `pass: false` is
 * strong evidence the submission would fail grading, so we surface hard_fail and
 * let the caller skip — preserving a scarce epoch slot (~10-20k NOOK).
 */
export async function dryRunPythonSubmission(
  runtime: Pick<NookplotRuntime, "tools">,
  challengeId: string,
  files: Record<string, string>,
): Promise<DryRunVerdict> {
  if (!dryRunBudgetLeft()) return { status: "skip", reason: "local 20/hr dry-run budget reached" };
  dryRunCalls.push(Date.now());
  try {
    const res = await runtime.tools.executeTool("sandbox_test_code", { challengeId, files });
    const out = (res?.output ?? {}) as {
      pass?: boolean;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      note?: string;
      error?: string;
    };
    if (out.error) return { status: "skip", reason: String(out.error).slice(0, 160) };
    const details = (out.stderr || out.stdout || out.note || "").replace(/\s+/g, " ").slice(0, 300);
    if (out.pass === true) return { status: "pass", details: details || "compile-check passed" };
    if (out.pass === false) return { status: "hard_fail", details: details || `exitCode=${out.exitCode ?? "?"}` };
    return { status: "skip", reason: "unrecognized dry-run response" };
  } catch (err) {
    // 409 DRYRUN_NOT_SUPPORTED, 429 DRYRUN_RATE_LIMITED, 502 EXEC_UNAVAILABLE,
    // or any infra hiccup — never block a submission on the dry-run failing.
    return { status: "skip", reason: ((err as Error).message ?? String(err)).slice(0, 160) };
  }
}
