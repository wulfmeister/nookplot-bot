/**
 * openai-gpt-61-sol roster probe (2026-10-01).
 *
 * The operator asked to "switch all models to chatgpt 6.1-sol on venice, then
 * test the endpoints". The swap shipped while the Venice key was 402-locked
 * (DIEM spend limit, until 2026-10-02T00:00Z), so this script is the test half:
 * run it BEFORE the daemon restart that puts the new roster live.
 *
 * Every inference goes through the bot's own code path: chat() from venice.ts,
 * and for the two mining lanes the production solvers themselves
 * (solvePythonTests / solveStandardTrace from mining.ts, exported for this
 * probe only). Shapes whose builder lives in index.ts (which starts the daemon
 * on import) or is unexported (projects review) are replicated from the
 * production strings; the probe checks those strings are still in the source
 * and flags drift. Nothing here submits, verifies or POSTs to the gateway.
 *
 * Shapes, cheapest / most diagnostic first:
 *   smoke    tiny chat, temperature 0.2, default effort (answers: key unlocked?
 *            temperature accepted? xhigh accepted? model id echoed?)
 *   json     knowledge_topic shape (index.ts generateKnowledgeTopic), temp 0.8
 *   review   projects review retry shape at reasoning_effort "low" (projects.ts)
 *   verify   verification scoring (VERIFY_CALIBRATION_PROMPT + a real trace)
 *   python   solvePythonTests on a real python_tests challenge, web search on
 *   standard solveStandardTrace on a real standard challenge
 *   jev      one /decisions call on jev-latest (unchanged model; endpoint check)
 *
 * Usage (run from the repo root that holds .env — dotenv reads ./.env):
 *   npm run probe:gpt61 -- --dry               plan + estimates; ZERO network calls
 *   npm run probe:gpt61                        every shape, budget $3
 *   npm run probe:gpt61 -- --only smoke,json   a subset, still in plan order
 *   flags: --budget <usd>  --model <id>  --effort <low|medium|high|xhigh|max>
 *          --source vault|gateway  --vault <dir>  --no-jev
 *
 * Writes ONE file: ~/.nookplot/reports/gpt61-probe-<ISO>.json, and only when
 * the pre-flight passed and inference was attempted. The bot's own ledgers are
 * not touched: HOME is pointed at a temp dir before any bot module loads, so
 * chat()'s venice-costs.jsonl rows land there and are copied into the report.
 * (Consequence: the probe's spend is NOT in ~/.nookplot/venice-costs.jsonl.)
 *
 * Stops: the first 402 / 429 / "spend limit" / "Too many failed attempts" /
 * "Insufficient" in any error (exit 1, no further Venice call of any kind); a
 * second non-billing call error (exit 2); the budget (exit 3). Pre-flight abort
 * or a missing key also exits 2.
 *
 * Pre-flight limitation: /api_keys/rate_limits reports ACCOUNT balances, not
 * the per-key DIEM spend limit that produced the 2026-10-01 402s. The smoke
 * call (≈$0.04) is the real canary, which is why it runs first.
 */
import diagnosticsChannel from "node:diagnostics_channel";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Challenge } from "./mining.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in src/__tests__/gpt61-sol.test.ts). This module's
// static imports are node builtins only, so importing it has no side effects.
// ---------------------------------------------------------------------------

export type ShapeId = "smoke" | "json" | "review" | "verify" | "python" | "standard" | "jev";
export const SHAPE_ORDER: readonly ShapeId[] = ["smoke", "json", "review", "verify", "python", "standard", "jev"];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** Billing / lockout signatures that end the run immediately (2026-09-28 lesson). */
export const BILLING_STOP_RE = /\b402\b|\b429\b|spend limit|too many failed attempts|insufficient/i;

/** True when a status or an ERROR text (never a 200's model output) is a billing/lockout stop. */
export function isBillingStop(status: number | undefined, errorText: string | undefined): boolean {
  if (status === 402 || status === 429) return true;
  return typeof errorText === "string" && BILLING_STOP_RE.test(errorText);
}

export interface CallOutcome {
  /** The logical call produced a usable HTTP 200 (parse failures still count as ok). */
  ok: boolean;
  /** Every HTTP status seen for this call, including chat()'s internal retries. */
  statuses: number[];
  /** Thrown error messages and non-2xx response bodies only. */
  errorTexts: string[];
}

/**
 * After every call: a billing/lockout signature anywhere stops the run; the
 * first non-billing error is recorded and tolerated; a second one stops.
 */
export function decideAfterCall(
  priorNonBillingErrors: number,
  o: CallOutcome,
): { action: "continue" | "stop"; billing: boolean; reason?: string; nonBillingErrors: number } {
  const billingStatus = o.statuses.find((s) => s === 402 || s === 429);
  const billingText = o.errorTexts.find((t) => isBillingStop(undefined, t));
  if (billingStatus !== undefined || billingText !== undefined) {
    const why = billingStatus !== undefined ? `HTTP ${billingStatus}` : (billingText ?? "").replace(/\s+/g, " ").slice(0, 160);
    return { action: "stop", billing: true, reason: `billing/lockout: ${why}`, nonBillingErrors: priorNonBillingErrors };
  }
  if (!o.ok) {
    const n = priorNonBillingErrors + 1;
    if (n >= 2) return { action: "stop", billing: false, reason: "second non-billing call error", nonBillingErrors: n };
    return { action: "continue", billing: false, nonBillingErrors: n };
  }
  return { action: "continue", billing: false, nonBillingErrors: priorNonBillingErrors };
}

/** Stop BEFORE a call whose estimate would push the running total past the budget. */
export function wouldExceedBudget(spentUsd: number, nextEstUsd: number, budgetUsd: number): boolean {
  return spentUsd + nextEstUsd > budgetUsd + 1e-9;
}

export interface RateLimitsSnapshot {
  accessPermitted?: unknown;
  usd: number;
  diem: number;
  bundled?: number;
  nextEpochBegins?: string | null;
  apiTier?: string | null;
}

/** Abort unless the key may call inference and DIEM+USD covers the floor. */
export function preflightVerdict(b: RateLimitsSnapshot | null, minUsd: number): { ok: boolean; reason: string } {
  if (!b) return { ok: false, reason: "rate_limits unavailable (network, auth, or shape) — not risking inference blind" };
  if (b.accessPermitted !== true) return { ok: false, reason: `accessPermitted=${JSON.stringify(b.accessPermitted)} (must be true)` };
  const sum = b.diem + b.usd;
  if (!(sum >= minUsd)) return { ok: false, reason: `DIEM+USD = ${sum.toFixed(2)} < ${minUsd.toFixed(2)} required` };
  return { ok: true, reason: `DIEM+USD = ${sum.toFixed(2)} ≥ ${minUsd.toFixed(2)}` };
}

export interface ProbeArgs {
  dry: boolean;
  budget: number;
  model: string;
  effort?: Effort;
  only?: ShapeId[];
  source: "vault" | "gateway";
  vaultDir?: string;
  jev: boolean;
}

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const a: ProbeArgs = { dry: false, budget: 3, model: "openai-gpt-61-sol", source: "vault", jev: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--dry") a.dry = true;
    else if (k === "--no-jev") a.jev = false;
    else if (k === "--budget") {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) throw new Error("--budget must be a positive number of USD");
      a.budget = n;
    } else if (k === "--model") a.model = val();
    else if (k === "--effort") {
      const e = val();
      if (!(EFFORTS as readonly string[]).includes(e)) throw new Error(`--effort must be one of ${EFFORTS.join("|")}`);
      a.effort = e as Effort;
    } else if (k === "--only") {
      const ids = val().split(",").map((s) => s.trim()).filter(Boolean);
      const bad = ids.filter((s) => !(SHAPE_ORDER as readonly string[]).includes(s));
      if (bad.length || ids.length === 0) throw new Error(`--only: unknown shape(s) ${bad.join(",")} — valid: ${SHAPE_ORDER.join(",")}`);
      a.only = ids as ShapeId[];
    } else if (k === "--source") {
      const s = val();
      if (s !== "vault" && s !== "gateway") throw new Error("--source must be vault or gateway");
      a.source = s;
    } else if (k === "--vault") a.vaultDir = val();
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

/** Decode a captured response body per its Content-Encoding (undici taps see the wire bytes). */
export function decodeBody(chunks: readonly Uint8Array[], encoding?: string): string {
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const enc = (encoding ?? "").toLowerCase();
  try {
    if (enc.includes("br")) return brotliDecompressSync(buf).toString("utf8");
    if (enc.includes("gzip")) return gunzipSync(buf).toString("utf8");
    if (enc.includes("deflate")) {
      try {
        return inflateSync(buf).toString("utf8");
      } catch {
        return inflateRawSync(buf).toString("utf8");
      }
    }
  } catch {
    /* fall through: report the raw bytes rather than nothing */
  }
  return buf.toString("utf8");
}

/** Header lookup over undici's raw [name, value, ...] array or a plain object. */
export function headerValue(headers: unknown, name: string): string | undefined {
  const want = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === want) return String(headers[i + 1]);
    }
    return undefined;
  }
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === want) return Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return undefined;
}

/** Venice web-citation markers (`^1^`, `^1,2^`) that would corrupt code or answers. */
export function hasCitationMarkers(s: string | undefined): boolean {
  return !!s && /\^\d+(?:,\d+)*\^/.test(s);
}

function frontmatter(text: string): { fm: Record<string, string>; body: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { fm, body: m[2] };
}

function jsonArray(s: string | undefined): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface MiningNote {
  challengeId: string;
  title: string;
  kind: string;
  tags: string[];
  description: string;
  model?: string;
}

/** Parse a knowledge-vault/research/mining-*.md note (written by mining.ts) back into a challenge. */
export function parseMiningNote(text: string): MiningNote | null {
  const f = frontmatter(text);
  if (!f || f.fm.type !== "mining-submission" || !f.fm.challengeId) return null;
  const tags = jsonArray(f.fm.tags).map(String);
  const kind = f.fm.verifierKind && f.fm.verifierKind !== "null" ? f.fm.verifierKind : tags[1] ?? "standard";
  const d = f.body.match(/## Challenge\n\n([\s\S]*?)\n\n## Our reasoning/);
  const description = d ? d[1].trim() : "";
  if (!description) return null;
  return {
    challengeId: f.fm.challengeId,
    title: (f.fm.title ?? "").replace(/^Mining solve:\s*/, ""),
    kind,
    // tags = ["mining", kind, status, ...domainTags] (mining.ts writeNote)
    tags: tags.slice(3),
    description,
    model: f.fm.model,
  };
}

export interface VerificationNote {
  submissionId: string;
  source: string;
  excerpt: string;
  tags: string[];
  scores: number[];
}

/** Parse a knowledge-vault/research/verification-*.md note (trace excerpt + the scores we gave). */
export function parseVerificationNote(text: string): VerificationNote | null {
  const f = frontmatter(text);
  if (!f || f.fm.type !== "verification") return null;
  const src = f.body.match(/## Trace source\n\n(\S+)/);
  const ex = f.body.match(/## Trace excerpt\n\n([\s\S]*?)\n\n## Scores/);
  if (!ex) return null;
  return {
    submissionId: f.fm.submissionId ?? "",
    source: src ? src[1] : "?",
    excerpt: ex[1],
    tags: jsonArray(f.fm.tags).map(String).filter((t) => t !== "verification" && t !== "quality-review"),
    scores: jsonArray(f.fm.scores).map(Number).filter((n) => Number.isFinite(n)),
  };
}

// ---------------------------------------------------------------------------
// Plan + estimates
// ---------------------------------------------------------------------------

/** chat() floors every completion budget at this (venice.ts MIN_COMPLETION_TOKENS default). */
const COMPLETION_FLOOR = Number(process.env.BOT_MIN_COMPLETION_TOKENS ?? 50_000);
/** Venice docs (pricing): web search $10 / 1k requests — charged when a search actually runs. */
const WEB_SEARCH_USD = 0.01;

interface ShapePlan {
  id: ShapeId;
  what: string;
  model: string;
  effort: Effort | "n/a" | "(model default)";
  temperature?: number;
  /** The caller's hint; chat() sends max(hint, floor). */
  maxTokensHint?: number;
  webSearch: boolean;
  /** Planning estimate in tokens (typical, not worst case). */
  estIn: number;
  estOut: number;
}

function buildPlan(args: ProbeArgs, effortForModel: (m: string) => string | undefined): ShapePlan[] {
  const eff = (args.effort ?? effortForModel(args.model) ?? "(model default)") as ShapePlan["effort"];
  const all: ShapePlan[] = [
    { id: "smoke", what: "tiny chat (key/temperature/effort/model-echo canary)", model: args.model, effort: eff, temperature: 0.2, maxTokensHint: 16, webSearch: false, estIn: 300, estOut: 2_500 },
    { id: "json", what: "knowledge_topic short JSON (index.ts)", model: args.model, effort: eff, temperature: 0.8, maxTokensHint: 200, webSearch: false, estIn: 300, estOut: 3_500 },
    { id: "review", what: "projects review retry @ low (projects.ts)", model: args.model, effort: "low", temperature: 0.1, maxTokensHint: 6_000, webSearch: false, estIn: 4_000, estOut: 3_000 },
    { id: "verify", what: "verification_score (VERIFY_CALIBRATION_PROMPT)", model: args.model, effort: eff, temperature: 0.2, maxTokensHint: 800, webSearch: false, estIn: 2_500, estOut: 7_000 },
    { id: "python", what: "solvePythonTests, web search auto (mining.ts)", model: args.model, effort: eff, temperature: 0.15, maxTokensHint: 6_000, webSearch: true, estIn: 7_000, estOut: 16_000 },
    { id: "standard", what: "solveStandardTrace (mining.ts)", model: args.model, effort: eff, temperature: 0.2, maxTokensHint: 40_000, webSearch: false, estIn: 2_000, estOut: 30_000 },
    { id: "jev", what: "jev-latest /decisions inbox triage (unchanged model)", model: "jev-latest", effort: "n/a", webSearch: false, estIn: 3_000, estOut: 0 },
  ];
  return all.filter((p) => (args.only ? args.only.includes(p.id) : true) && (p.id !== "jev" || args.jev));
}

// ---------------------------------------------------------------------------
// Wire tap: undici publishes every request on node:diagnostics_channel, so the
// probe sees status, raw body, finish_reason and usage even for calls made
// deep inside the production solvers — without changing production code.
// ---------------------------------------------------------------------------

interface WireRec {
  method: string;
  origin: string;
  path: string;
  startMs: number;
  endMs?: number;
  status?: number;
  encoding?: string;
  req: Buffer[];
  res: Buffer[];
  error?: string;
}
const WIRE: WireRec[] = [];
const BY_REQ = new WeakMap<object, WireRec>();
const WANT_PATH = /\/chat\/completions|\/decisions|\/api_keys\/rate_limits|\/v1\/mining\/challenges/;

function installWireTap(): void {
  const rec = (m: unknown): WireRec | undefined => {
    const r = (m as { request?: object })?.request;
    return r ? BY_REQ.get(r) : undefined;
  };
  diagnosticsChannel.subscribe("undici:request:create", (m) => {
    const request = (m as { request?: { origin?: unknown; path?: unknown; method?: unknown } }).request;
    if (!request) return;
    const path = String(request.path ?? "");
    if (!WANT_PATH.test(path)) return;
    const r: WireRec = { method: String(request.method ?? "?"), origin: String(request.origin ?? ""), path, startMs: Date.now(), req: [], res: [] };
    WIRE.push(r);
    BY_REQ.set(request, r);
  });
  diagnosticsChannel.subscribe("undici:request:bodyChunkSent", (m) => {
    const r = rec(m);
    const c = (m as { chunk?: unknown }).chunk;
    if (r && c != null) r.req.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c as Uint8Array));
  });
  diagnosticsChannel.subscribe("undici:request:headers", (m) => {
    const r = rec(m);
    const resp = (m as { response?: { statusCode?: number; headers?: unknown } }).response;
    if (!r || !resp) return;
    r.status = resp.statusCode;
    r.encoding = headerValue(resp.headers, "content-encoding");
  });
  diagnosticsChannel.subscribe("undici:request:bodyChunkReceived", (m) => {
    const r = rec(m);
    const c = (m as { chunk?: unknown }).chunk;
    if (r && c != null) r.res.push(Buffer.from(c as Uint8Array));
  });
  diagnosticsChannel.subscribe("undici:request:trailers", (m) => {
    const r = rec(m);
    if (r) r.endMs = Date.now();
  });
  diagnosticsChannel.subscribe("undici:request:error", (m) => {
    const r = rec(m);
    if (!r) return;
    r.endMs = Date.now();
    r.error = String((m as { error?: { message?: string } }).error?.message ?? "error");
  });
}

interface ChatWire {
  attempts: Array<{ status?: number; latencyMs?: number; error?: string; temperature?: unknown; maxTokens?: unknown; effort?: unknown; webSearch?: boolean }>;
  finishReason?: string;
  content?: string;
  reasoning?: string;
  usage?: Record<string, unknown>;
  responseModel?: string;
  citations?: number;
  refusal?: string;
  errorBodies: string[];
}

function readChatWire(recs: WireRec[]): ChatWire {
  const out: ChatWire = { attempts: [], errorBodies: [] };
  for (const r of recs) {
    let sent: Record<string, unknown> = {};
    try {
      sent = JSON.parse(Buffer.concat(r.req).toString("utf8")) as Record<string, unknown>;
    } catch {
      /* body not captured (non-streamed send) — params unknown */
    }
    const vp = sent.venice_parameters as { enable_web_search?: string } | undefined;
    const body = r.res.length ? decodeBody(r.res, r.encoding) : "";
    const ok = r.status !== undefined && r.status >= 200 && r.status < 300;
    out.attempts.push({
      status: r.status,
      latencyMs: r.endMs !== undefined ? r.endMs - r.startMs : undefined,
      error: r.error ?? (ok ? undefined : body.replace(/\s+/g, " ").slice(0, 300)),
      temperature: sent.temperature,
      maxTokens: sent.max_tokens,
      effort: sent.reasoning_effort,
      webSearch: vp ? vp.enable_web_search !== "off" : false,
    });
    if (!ok) {
      if (body) out.errorBodies.push(body);
      if (r.error) out.errorBodies.push(r.error);
      continue;
    }
    try {
      const d = JSON.parse(body) as {
        model?: string;
        usage?: Record<string, unknown>;
        choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string; refusal?: string } }>;
        venice_parameters?: { web_search_citations?: unknown[] };
      };
      out.finishReason = d.choices?.[0]?.finish_reason;
      out.content = d.choices?.[0]?.message?.content ?? "";
      out.reasoning = d.choices?.[0]?.message?.reasoning_content;
      out.refusal = d.choices?.[0]?.message?.refusal;
      out.usage = d.usage;
      out.responseModel = d.model;
      out.citations = Array.isArray(d.venice_parameters?.web_search_citations) ? d.venice_parameters!.web_search_citations!.length : 0;
    } catch {
      out.content = body; // undecodable — keep the bytes for the report
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inputs (local reads; one optional gateway GET)
// ---------------------------------------------------------------------------

interface Inputs {
  python?: { ch: Challenge; source: string; baseline?: unknown };
  standard?: { ch: Challenge; source: string; baseline?: unknown };
  verifyTrace?: { text: string; tags: string[]; source: string; earlierScores?: number[] };
  projectDraft?: { name: string; code: string; slug: string };
  notes: string[];
}

function newestFiles(dir: string, re: RegExp, limit: number): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => join(dir, x.f));
}

function latestByChallenge(path: string, ids: Set<string>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!existsSync(path) || ids.size === 0) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = String(row.challengeId ?? "");
      if (ids.has(id)) out.set(id, row); // file is append-ordered → last wins
    } catch {
      /* skip */
    }
  }
  return out;
}

function noteToChallenge(n: MiningNote): Challenge {
  return {
    id: n.challengeId,
    title: n.title,
    description: n.description,
    domainTags: n.tags,
    verifierKind: n.kind === "standard" ? null : n.kind,
    challengeType: n.kind === "standard" ? "standard" : undefined,
  };
}

function loadLocalInputs(realHome: string, vaultDir: string): Inputs {
  const nook = join(realHome, ".nookplot");
  const research = join(vaultDir, "research");
  const inputs: Inputs = { notes: [] };

  // Mining challenges from the vault: prefer one with a settled grok-era result,
  // so the probe's output can be compared with what the old roster got paid for.
  const notes = newestFiles(research, /^mining-.*\.md$/, 400)
    .map((p) => ({ p, n: parseMiningNote(readFileSync(p, "utf8")) }))
    .filter((x): x is { p: string; n: MiningNote } => x.n !== null);
  const settled = latestByChallenge(join(nook, "mining-settlements.jsonl"), new Set(notes.map((x) => x.n.challengeId)));
  const pick = (kind: string) => {
    const ofKind = notes.filter((x) => x.n.kind === kind);
    return ofKind.find((x) => settled.has(x.n.challengeId)) ?? ofKind[0];
  };
  for (const [slot, kind] of [["python", "python_tests"], ["standard", "standard"]] as const) {
    const x = pick(kind);
    if (!x) continue;
    const s = settled.get(x.n.challengeId);
    inputs[slot] = {
      ch: noteToChallenge(x.n),
      source: `vault ${x.p.split("/").pop()}`,
      baseline: s ? { model: s.model, status: s.status, compositeScore: s.compositeScore } : { model: x.n.model, status: "unsettled" },
    };
  }

  // A real full trace for the verification shape, with the scores we gave it.
  for (const p of newestFiles(research, /^verification-.*\.md$/, 80)) {
    const v = parseVerificationNote(readFileSync(p, "utf8"));
    if (v && v.source === "ipfs" && v.excerpt.length >= 1500) {
      inputs.verifyTrace = { text: v.excerpt, tags: v.tags, source: `vault ${p.split("/").pop()}`, earlierScores: v.scores };
      break;
    }
  }
  if (!inputs.verifyTrace) {
    const cache = join(nook, "verify-trace-cache.jsonl");
    if (existsSync(cache)) {
      const lines = readFileSync(cache, "utf8").trim().split("\n").reverse();
      for (const l of lines) {
        try {
          const row = JSON.parse(l) as { snippet?: string; id?: string };
          if ((row.snippet ?? "").length >= 800) {
            inputs.verifyTrace = { text: row.snippet!, tags: [], source: `verify-trace-cache ${row.id ?? "?"}` };
            break;
          }
        } catch {
          /* skip */
        }
      }
    }
  }
  if (!inputs.verifyTrace) inputs.notes.push("verify: no cached trace found — shape will be skipped");

  // A real project draft for the review shape (same assembly as projects.ts autoSubmitGate).
  const drafts = join(nook, "project-drafts");
  if (existsSync(drafts)) {
    const dirs = readdirSync(drafts)
      .map((d) => join(drafts, d))
      .filter((d) => statSync(d).isDirectory())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const d of dirs) {
      const files = readdirSync(d).filter((f) => (f.endsWith(".py") || f.endsWith(".js")) && !f.startsWith("_"));
      if (!files.length) continue;
      const code = files.map((f) => `# ${f}\n${readFileSync(join(d, f), "utf8")}`).join("\n\n");
      let name = d.split("/").pop() ?? "draft";
      try {
        name = String((JSON.parse(readFileSync(join(d, "_meta.json"), "utf8")) as { name?: string }).name ?? name);
      } catch {
        /* keep slug */
      }
      inputs.projectDraft = { name, code, slug: d.split("/").pop() ?? "" };
      break;
    }
  }
  if (!inputs.projectDraft) inputs.notes.push("review: no project draft found — shape will be skipped");
  return inputs;
}

async function fetchGatewayChallenges(): Promise<{ python?: Challenge; standard?: Challenge; error?: string }> {
  const gw = process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
  const key = process.env.NOOKPLOT_API_KEY;
  if (!key) return { error: "NOOKPLOT_API_KEY not set" };
  try {
    const r = await fetch(`${gw}/v1/mining/challenges?status=open&limit=100`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { error: `gateway HTTP ${r.status}` };
    const body = (await r.json()) as { challenges?: Challenge[] };
    const cs = body.challenges ?? [];
    const skip = new Set(["rlm_trajectory", "distillation_request", "project_improvement"]);
    return {
      python: cs.find((c) => c.verifierKind === "python_tests" && c.description),
      standard: cs.find((c) => c.challengeType === "standard" && !c.verifierKind && c.description && !skip.has(c.sourceType ?? "")),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Venice account snapshot
// ---------------------------------------------------------------------------

async function getRateLimits(): Promise<{ snap: RateLimitsSnapshot | null; status?: number; error?: string }> {
  const base = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";
  try {
    const r = await fetch(`${base}/api_keys/rate_limits`, {
      headers: { Authorization: `Bearer ${process.env.VENICE_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { snap: null, status: r.status, error: (await r.text()).slice(0, 300) };
    const b = (await r.json()) as {
      data?: { accessPermitted?: unknown; balances?: { USD?: number; DIEM?: number; BUNDLED_CREDITS?: number }; nextEpochBegins?: string; apiTier?: { id?: string } };
    };
    const d = b.data;
    if (!d?.balances) return { snap: null, status: r.status, error: "no data.balances in response" };
    return {
      status: r.status,
      snap: {
        accessPermitted: d.accessPermitted,
        usd: Number(d.balances.USD ?? 0),
        diem: Number(d.balances.DIEM ?? 0),
        bundled: Number(d.balances.BUNDLED_CREDITS ?? 0),
        nextEpochBegins: d.nextEpochBegins ?? null,
        apiTier: d.apiTier?.id ?? null,
      },
    };
  } catch (e) {
    return { snap: null, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Production-string drift checks for the replicated shapes
// ---------------------------------------------------------------------------

const KNOWLEDGE_TOPIC_SYS =
  'Propose one specific, substantive technical topic to write a 1200-1500 word knowledge post about. Output JSON only: {"title":"...","angle":"..."} where title is 5-12 words and angle is one sentence framing the unique perspective (a specific tension, contrarian take, or under-explored aspect).';
const KNOWLEDGE_TOPIC_SEED = "WebSocket reliability patterns for long-lived agent connections";
const PROJECT_REVIEW_SYS =
  "You are a STRICT reviewer deciding whether a small project is safe to PUBLISH ON-CHAIN under our identity WITHOUT any human review. It ALREADY passed its unit tests in a clean sandbox — so 'tests pass' is NOT sufficient evidence and you must NOT rely on it. Hunt for: logic bugs the tests miss, stubs that ignore their inputs, off-by-one / boundary errors, insecure patterns, and MISLEADING claims in code/comments (e.g. 'implements standard X' when it doesn't). Escalation to a human is cheap; a wrong on-chain publish is permanent — so set safe=false or confidence below 'high' on ANY genuine doubt. " +
  "Output STRICT JSON only: {\"safe\": boolean, \"confidence\": \"high\"|\"medium\"|\"low\", \"issues\": [\"blocking issue\", ...], \"notes\": \"one line\"}.";
const JEV_FIXTURE =
  "Hi — I read your consistent-hashing trace and have a small PR to the bounded-load variant. Could you review it this week? No payment involved; happy to credit you in the README.";

function driftChecks(srcDir: string): string[] {
  const out: string[] = [];
  const read = (f: string) => {
    try {
      return readFileSync(join(srcDir, f), "utf8");
    } catch {
      return "";
    }
  };
  const idx = read("index.ts");
  const proj = read("projects.ts");
  const need: Array<[string, string, string]> = [
    ["index.ts", idx, KNOWLEDGE_TOPIC_SYS.slice(0, 120)],
    ["index.ts", idx, "{ max_tokens: 200, temperature: 0.8, model: pickModel(\"knowledge_topic\") }"],
    ["index.ts", idx, "Trace:\\n${trace.slice(0, 12000)}"],
    ["index.ts", idx, "{ max_tokens: 800, temperature: 0.2, model: pickModel(\"verification_score\") }"],
    ["projects.ts", proj, PROJECT_REVIEW_SYS.slice(0, 120)],
    ["projects.ts", proj, 'max_tokens: 6000, temperature: 0.1, timeoutMs: 180_000, reasoning_effort: "low"'],
  ];
  for (const [file, text, needle] of need) {
    if (text && !text.includes(needle)) out.push(`${file}: replicated string no longer found — "${needle.slice(0, 60)}…"`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CallRecord {
  shape: ShapeId;
  model: string;
  effort: string;
  temperatureSent?: unknown;
  maxTokensSent?: unknown;
  webSearch?: boolean;
  httpStatus?: number;
  statuses: number[];
  attempts: ChatWire["attempts"];
  latencyMs: number;
  finishReason?: string;
  contentChars: number;
  reasoningChars: number;
  reasoningTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  responseModel?: string;
  citations?: number;
  estCostUsd: number;
  parseOk: boolean;
  parseReason: string;
  specificity?: Record<string, unknown>;
  contentFilter: boolean;
  temperatureRejected: boolean;
  contentHead: string;
  error?: string;
  extra?: Record<string, unknown>;
  logLines: string[];
}

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main(): Promise<number> {
  let args: ProbeArgs;
  try {
    args = parseProbeArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    return 2;
  }
  const realHome = homedir();
  const reportsDir = join(realHome, ".nookplot", "reports");
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const vaultDir = args.vaultDir ?? resolve(srcDir, "..", "knowledge-vault");
  // Loads ./.env into process.env (no network, no writes).
  await import("dotenv/config");

  const inputs = loadLocalInputs(realHome, vaultDir);
  const needGateway = args.source === "gateway" || !inputs.python || !inputs.standard;
  const drift = driftChecks(srcDir);

  // ---------------- dry: print the plan, touch nothing on the network -------
  if (args.dry) {
    const models = await import("./models.js");
    const cost = await import("./venice-cost.js");
    const plan = buildPlan(args, models.effortFor);
    console.log(`gpt61 probe — DRY RUN (no network calls). model=${args.model} budget=$${args.budget}`);
    console.log(`completion floor ${COMPLETION_FLOOR} tokens (chat() MIN_COMPLETION_TOKENS); worst = that floor fully spent\n`);
    console.log(["shape", "model", "effort", "temp", "max_tok sent", "web", "est in/out", "est $", "worst $", "cum est $", "budget"].join(" | "));
    let cum = 0;
    let stopped = false; // the real run stops at the first over-budget shape — mirror that
    for (const p of plan) {
      const est = cost.estimateCallCost(p.model, p.estIn + p.estOut, p.estOut) + (p.webSearch ? WEB_SEARCH_USD : 0);
      const worst = p.id === "jev" ? est : cost.estimateCallCost(p.model, p.estIn + COMPLETION_FLOOR, COMPLETION_FLOOR) + (p.webSearch ? WEB_SEARCH_USD : 0);
      const over = stopped || wouldExceedBudget(cum, est, args.budget);
      if (over) stopped = true;
      else cum += est;
      const sent = p.maxTokensHint === undefined ? "n/a" : String(Math.max(p.maxTokensHint, COMPLETION_FLOOR));
      console.log([p.id, p.model, p.effort, p.temperature ?? "-", sent, p.webSearch ? "auto" : "-", `${p.estIn}/${p.estOut}`, usd(est), usd(worst), usd(cum), over ? "SKIP(budget)" : "ok"].join(" | "));
    }
    console.log(`\nplanned total ≈ ${usd(cum)} (typical). Each solve may also retry once on a timeout; Venice may bill aborted attempts.`);
    console.log(`\ninputs:`);
    console.log(`  python   ${inputs.python ? `${inputs.python.ch.id.slice(0, 8)} "${(inputs.python.ch.title ?? "").slice(0, 60)}" (${inputs.python.source}) baseline=${JSON.stringify(inputs.python.baseline)}` : "none in vault"}`);
    console.log(`  standard ${inputs.standard ? `${inputs.standard.ch.id.slice(0, 8)} "${(inputs.standard.ch.title ?? "").slice(0, 60)}" (${inputs.standard.source}) baseline=${JSON.stringify(inputs.standard.baseline)}` : "none in vault"}`);
    console.log(`  verify   ${inputs.verifyTrace ? `${inputs.verifyTrace.text.length} chars (${inputs.verifyTrace.source}) our earlier scores=${JSON.stringify(inputs.verifyTrace.earlierScores ?? null)}` : "none"}`);
    console.log(`  review   ${inputs.projectDraft ? `${inputs.projectDraft.slug} (${inputs.projectDraft.code.length} chars)` : "none"}`);
    for (const n of inputs.notes) console.log(`  note: ${n}`);
    if (needGateway) console.log(`  would GET ${process.env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com"}/v1/mining/challenges?status=open&limit=100 (1 request) for the missing challenge(s)`);
    console.log(drift.length ? `\n⚠ prompt drift:\n  ${drift.join("\n  ")}` : `\nreplicated prompts: no drift vs src/index.ts + src/projects.ts`);
    console.log(`\nrun order: GET /api_keys/rate_limits → abort unless accessPermitted && DIEM+USD ≥ $${Math.max(3, args.budget).toFixed(2)} → shapes above, sequential, stop on the first 402/429 → GET /api_keys/rate_limits again (skipped after a billing stop)`);
    console.log(`writes on a real run: ${join(reportsDir, "gpt61-probe-<ISO>.json")} only`);
    return 0;
  }

  // ---------------- real run --------------------------------------------------
  if (!process.env.VENICE_API_KEY) {
    console.error("✗ VENICE_API_KEY not set — run from the repo root that holds .env");
    return 2;
  }
  const startedAt = new Date().toISOString();
  installWireTap();

  // (a) Pre-flight.
  const minUsd = Math.max(3, args.budget);
  const pre = await getRateLimits();
  if (pre.snap) {
    console.log(`💳 before: DIEM ${pre.snap.diem.toFixed(3)}  USD ${pre.snap.usd.toFixed(3)}  bundled ${pre.snap.bundled ?? 0}  accessPermitted=${String(pre.snap.accessPermitted)}  nextEpoch ${pre.snap.nextEpochBegins ?? "?"}`);
  }
  const verdict = preflightVerdict(pre.snap, minUsd);
  if (!verdict.ok) {
    console.error(`✗ pre-flight ABORT: ${verdict.reason}${pre.status ? ` (rate_limits HTTP ${pre.status}${pre.error ? `: ${pre.error.slice(0, 160)}` : ""})` : pre.error ? ` (${pre.error})` : ""}`);
    console.error("  no inference was attempted; no report written.");
    return 2;
  }
  console.log(`✓ pre-flight: ${verdict.reason}`);

  // Optional gateway GET for missing challenges (GET only, one request).
  if (needGateway) {
    const g = await fetchGatewayChallenges();
    if (g.error) inputs.notes.push(`gateway GET failed: ${g.error}`);
    if (g.python && (args.source === "gateway" || !inputs.python)) inputs.python = { ch: g.python, source: "gateway open list" };
    if (g.standard && (args.source === "gateway" || !inputs.standard)) inputs.standard = { ch: g.standard, source: "gateway open list" };
  }

  // Point HOME at a temp dir BEFORE any bot module loads: NOOK_DIR is computed
  // from homedir() at import, so every ledger write lands in the sandbox.
  const sandbox = mkdtempSync(join(tmpdir(), "gpt61-probe-"));
  // appendJsonl does not mkdir — without this every ledger row is silently dropped.
  mkdirSync(join(sandbox, ".nookplot"), { recursive: true });
  process.env.HOME = sandbox;
  const venice = await import("./venice.js");
  const models = await import("./models.js");
  const cost = await import("./venice-cost.js");
  const mining = await import("./mining.js");
  const gate = await import("./specificity-gate.js");
  const util = await import("./util.js");
  const calib = await import("./verify-calibration.js");
  const jev = await import("./jev.js");
  if (!util.NOOK_DIR.startsWith(sandbox)) {
    console.error(`✗ ledger sandbox failed (NOOK_DIR=${util.NOOK_DIR}) — refusing to write into the real ~/.nookplot`);
    return 2;
  }

  const plan = buildPlan(args, models.effortFor);
  const effortArg = (p: ShapePlan): Effort | undefined =>
    p.effort === "n/a" || p.effort === "(model default)" ? undefined : (p.effort as Effort);
  const calls: CallRecord[] = [];
  let spent = 0;
  let nonBillingErrors = 0;
  let stop: { reason: string; atShape: ShapeId; billing: boolean; budget?: boolean } | null = null;

  for (const p of plan) {
    const est = cost.estimateCallCost(p.model, p.estIn + p.estOut, p.estOut) + (p.webSearch ? WEB_SEARCH_USD : 0);
    if (wouldExceedBudget(spent, est, args.budget)) {
      stop = { reason: `budget: spent ${usd(spent)} + est ${usd(est)} > $${args.budget}`, atShape: p.id, billing: false, budget: true };
      console.log(`⛔ ${stop.reason} — not running ${p.id} or anything after it`);
      break;
    }
    // Inputs a shape needs; skip (not an error) when unavailable.
    const missing =
      (p.id === "python" && !inputs.python) ||
      (p.id === "standard" && !inputs.standard) ||
      (p.id === "verify" && !inputs.verifyTrace) ||
      (p.id === "review" && !inputs.projectDraft) ||
      (p.id === "jev" && process.env.BOT_JEV === "0");
    if (missing) {
      console.log(`↷ ${p.id}: skipped (no input / disabled)`);
      continue;
    }

    console.log(`\n▶ ${p.id} — ${p.what} — ${p.model} effort=${p.effort} est ${usd(est)} (started ${new Date().toISOString().slice(11, 19)}Z)`);
    const mark = WIRE.length;
    const logLines: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...a: unknown[]) => {
      logLines.push(a.map(String).join(" "));
      origWarn(...a);
    };
    console.log = (...a: unknown[]) => {
      logLines.push(a.map(String).join(" "));
      origLog(...a);
    };
    const t0 = Date.now();
    let thrown: string | undefined;
    let chatContent: string | undefined;
    let chatUsage: Record<string, unknown> | undefined;
    let chatModel: string | undefined;
    let parseOk = false;
    let parseReason = "";
    let specificity: Record<string, unknown> | undefined;
    const extra: Record<string, unknown> = {};
    let jevTokens: number | undefined;
    const jevStatuses: number[] = [];
    const jevErrors: string[] = [];

    try {
      if (p.id === "smoke") {
        const r = await venice.chat(
          [
            { role: "system", content: "You are a connectivity check. Reply with exactly the single word OK." },
            { role: "user", content: "ping" },
          ],
          { model: p.model, max_tokens: p.maxTokensHint, temperature: p.temperature, reasoning_effort: effortArg(p), timeoutMs: 180_000 },
        );
        chatContent = r.content;
        chatUsage = r.usage;
        chatModel = r.model;
        parseOk = r.content.trim().length > 0;
        parseReason = parseOk ? (/\bOK\b/.test(r.content) ? "replied OK" : "non-empty but not OK") : "EMPTY content";
      } else if (p.id === "json") {
        const r = await venice.chat(
          [
            { role: "system", content: KNOWLEDGE_TOPIC_SYS },
            { role: "user", content: `Category: ${KNOWLEDGE_TOPIC_SEED}\n\nAvoid generic surveys. Pick a specific, opinionated angle.` },
          ],
          { model: p.model, max_tokens: p.maxTokensHint, temperature: p.temperature, reasoning_effort: effortArg(p) },
        );
        chatContent = r.content;
        chatUsage = r.usage;
        chatModel = r.model;
        let strict = false;
        try {
          const o = JSON.parse(r.content.trim()) as { title?: unknown; angle?: unknown };
          strict = !!o.title && !!o.angle;
        } catch {
          strict = false;
        }
        const tol = util.extractJsonObj<{ title?: string; angle?: string }>(r.content);
        parseOk = !!(tol?.title && tol?.angle); // production path: extractJson + JSON.parse
        parseReason = strict ? "strict JSON.parse ok" : parseOk ? "ok via extractJson only (not strict)" : "no {title, angle}";
        extra.topic = tol;
      } else if (p.id === "review") {
        const d = inputs.projectDraft!;
        const r = await venice.chat(
          [
            { role: "system", content: PROJECT_REVIEW_SYS },
            { role: "user", content: `Project: ${d.name}\n\n${d.code.slice(0, 24000)}` },
          ],
          { model: p.model, max_tokens: 6000, temperature: 0.1, timeoutMs: 180_000, reasoning_effort: "low" },
        );
        chatContent = r.content;
        chatUsage = r.usage;
        chatModel = r.model;
        const o = util.extractJsonObj<{ safe?: unknown; confidence?: unknown; issues?: unknown; notes?: unknown }>(r.content);
        parseOk = !!o && typeof o.safe === "boolean" && typeof o.confidence === "string";
        parseReason = parseOk ? `safe=${String(o!.safe)} confidence=${String(o!.confidence)}` : r.content.trim() ? "did not parse to {safe, confidence}" : "EMPTY content";
        extra.draft = d.slug;
        extra.review = o;
      } else if (p.id === "verify") {
        const v = inputs.verifyTrace!;
        const r = await venice.chat(
          [
            { role: "system", content: calib.VERIFY_CALIBRATION_PROMPT },
            { role: "user", content: `Domain tags: ${v.tags.join(", ") || "(none)"}\n\nTrace:\n${v.text.slice(0, 12000)}` },
          ],
          { model: p.model, max_tokens: 800, temperature: 0.2, reasoning_effort: effortArg(p) },
        );
        chatContent = r.content;
        chatUsage = r.usage;
        chatModel = r.model;
        const raw = util.extractJson(r.content);
        let o: Record<string, unknown> | null = null;
        try {
          o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          o = null;
        }
        const dims = ["correctnessScore", "reasoningScore", "efficiencyScore", "noveltyScore"];
        const rats = ["correctnessRationale", "reasoningEvaluation", "efficiencyAssessment", "noveltyAssessment"];
        if (!o) {
          parseOk = false;
          parseReason = r.content.trim() ? "no parseable JSON" : "EMPTY content";
        } else if (o.skip) {
          parseOk = true;
          parseReason = `model chose skip: ${String(o.skip).slice(0, 80)}`;
        } else {
          const scores = dims.map((k) => Number(o![k]));
          const scoresOk = scores.every((x) => Number.isFinite(x) && x >= 0 && x <= 1);
          const ratLens = rats.map((k) => String(o![k] ?? "").length);
          const ratsOk = ratLens.every((n) => n >= 80);
          parseOk = scoresOk;
          parseReason = `${scoresOk ? "4 scores in [0,1]" : `scores out of range/missing ${JSON.stringify(scores)}`}; rationales ${ratsOk ? "all ≥80" : `short ${JSON.stringify(ratLens)} (production pads these)`}`;
          extra.scores = scores;
          extra.rationaleChars = ratLens;
          extra.ourEarlierScoresSameTrace = v.earlierScores;
          extra.justificationChars = String(o.justification ?? "").length;
          extra.insightChars = String(o.knowledgeInsight ?? "").length;
        }
        extra.traceSource = v.source;
      } else if (p.id === "python") {
        const ch = inputs.python!.ch;
        const res = await mining.solvePythonTests(ch, "", p.model, effortArg(p), undefined, null);
        const w = readChatWire(WIRE.slice(mark).filter((r) => /\/chat\/completions/.test(r.path)));
        const rawParsed = w.content ? mining.parseVerifiableSolution(w.content, "solution") : null;
        const strict = w.content ? !!util.extractJsonObj<{ solution?: string }>(w.content)?.solution : false;
        parseOk = !!res;
        parseReason = res ? (strict ? "strict JSON (solution first)" : "solution salvaged from a fenced block") : "parse-fail (solver returned null)";
        const solution = rawParsed?.value ?? "";
        const rawSummary = rawParsed?.summary ?? "";
        const rawReasoning = rawParsed?.reasoning ?? "";
        const cats = (s: string) => Object.entries(gate.specificityCategories(s)).filter(([, v]) => v).map(([k]) => k);
        specificity = {
          reasoning: { chars: rawReasoning.length, categories: cats(rawReasoning), passesGate: gate.passesSpecificityGate(rawReasoning) },
          summaryRaw: { chars: rawSummary.length, categories: cats(rawSummary), passesGate: gate.passesSpecificityGate(rawSummary) },
          summaryShipped: res?.traceSummary
            ? { chars: res.traceSummary.length, categories: cats(res.traceSummary), passesGate: gate.passesSpecificityGate(res.traceSummary) }
            : null,
        };
        extra.challenge = { id: ch.id, title: ch.title, source: inputs.python!.source, baseline: inputs.python!.baseline };
        extra.solutionChars = solution.length;
        extra.citationMarkersInSolution = hasCitationMarkers(solution);
        extra.citationMarkersInSummary = hasCitationMarkers(rawSummary) || hasCitationMarkers(rawReasoning);
        if (solution) {
          // Syntax only: ast.parse never executes the model's code.
          const py = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: solution, encoding: "utf8", timeout: 20_000 });
          extra.pythonSyntaxOk = py.error ? `n/a (${py.error.message})` : py.status === 0;
          if (py.status !== 0 && !py.error) extra.pythonSyntaxError = (py.stderr ?? "").split("\n").filter(Boolean).pop();
        }
      } else if (p.id === "standard") {
        const ch = inputs.standard!.ch;
        const res = await mining.solveStandardTrace(ch, "", p.model, effortArg(p), undefined);
        const w = readChatWire(WIRE.slice(mark).filter((r) => /\/chat\/completions/.test(r.path)));
        const strictObj = w.content ? util.extractJsonObj<{ summary?: string; trace?: string }>(w.content) : null;
        const strict = !!strictObj?.trace;
        parseOk = !!res;
        parseReason = res ? (strict ? "strict JSON {summary, trace}" : "trace recovered by salvageMarkdownTrace") : w.finishReason === "content_filter" ? "content_filter" : "parse-fail (solver returned null)";
        const trace = res?.traceContent ?? "";
        const rawSummary = strictObj?.summary ?? "";
        const cats = (s: string) => Object.entries(gate.specificityCategories(s)).filter(([, v]) => v).map(([k]) => k);
        specificity = {
          summaryRaw: { chars: rawSummary.length, categories: cats(rawSummary), passesGate: gate.passesSpecificityGate(rawSummary) },
          summaryShipped: res?.traceSummary
            ? { chars: res.traceSummary.length, categories: cats(res.traceSummary), passesGate: gate.passesSpecificityGate(res.traceSummary) }
            : null,
          trace: { chars: trace.length, categories: cats(trace) },
        };
        extra.challenge = { id: ch.id, title: ch.title, source: inputs.standard!.source, baseline: inputs.standard!.baseline };
        extra.sections = ["## Approach", "## Steps", "## Conclusion", "## Uncertainty", "## Citations"].filter((h) => trace.includes(h));
        extra.traceChars = trace.length;
      } else if (p.id === "jev") {
        const tap: typeof fetch = async (input, init) => {
          const r = await fetch(input, init);
          jevStatuses.push(r.status);
          if (!r.ok) jevErrors.push(`HTTP ${r.status}: ${(await r.clone().text()).slice(0, 300)}`);
          return r;
        };
        const res = await jev.jevDecide(
          { from: "probe-fixture", messageType: "dm", message: JEV_FIXTURE },
          jev.INBOX_TRIAGE_QUESTIONS,
          { fetchImpl: tap, onCost: (n) => (jevTokens = n), timeoutMs: 20_000, callSite: "probe_gpt61" },
        );
        parseOk = !!res;
        const tri = jev.triageFromAnswers(res?.answers);
        parseReason = res ? `answers ok → ${tri ? `${tri.label} (${tri.category}, ${tri.priority.toFixed(2)}/3)` : "untriageable"}` : "null (disabled, paused, HTTP error, or unparseable)";
        extra.triage = tri;
      }
    } catch (e) {
      thrown = (e as Error).message;
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    const latencyMs = Date.now() - t0;

    // Assemble the record from the wire (authoritative) with chat()'s return as fallback.
    const wireRecs = WIRE.slice(mark).filter((r) => (p.id === "jev" ? /\/decisions/ : /\/chat\/completions/).test(r.path));
    const w = readChatWire(wireRecs);
    const content = w.content ?? chatContent ?? "";
    const usage = w.usage ?? chatUsage ?? {};
    const promptTokens = p.id === "jev" ? jevTokens : Number(usage.prompt_tokens ?? NaN);
    const completionTokens = p.id === "jev" ? 0 : Number(usage.completion_tokens ?? NaN);
    const details = usage.completion_tokens_details as { reasoning_tokens?: number } | undefined;
    const reasoningTokens = Number(usage.reasoning_tokens ?? details?.reasoning_tokens ?? NaN);
    const statuses = (p.id === "jev" && jevStatuses.length ? jevStatuses : w.attempts.map((a) => a.status)).filter((s): s is number => typeof s === "number");
    const respModel = w.responseModel ?? chatModel;
    let callCost = 0;
    if (p.id === "jev") callCost = jevTokens ? cost.estimateCallCost("jev-latest", jevTokens, 0) : 0;
    else if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
      callCost = cost.estimateCallCost(respModel ?? p.model, (promptTokens as number) + completionTokens, completionTokens);
      if (p.webSearch && (w.citations ?? 0) > 0) callCost += WEB_SEARCH_USD; // UNVERIFIED: billed only when a search ran
    }
    spent += callCost;
    const tempRejected =
      w.errorBodies.some((b) => /'temperature'/i.test(b)) || logLines.some((l) => /rejected temperature/.test(l));
    const firstAttempt = w.attempts[0];
    const errorTexts = [...w.errorBodies, ...jevErrors, ...(thrown ? [thrown] : [])];
    const ok = !thrown && (p.id === "jev" ? statuses.length > 0 && statuses.every((s) => s < 400) : statuses.some((s) => s >= 200 && s < 300));

    const rec: CallRecord = {
      shape: p.id,
      model: p.model,
      effort: p.effort,
      temperatureSent: firstAttempt?.temperature ?? p.temperature,
      maxTokensSent: firstAttempt?.maxTokens,
      webSearch: firstAttempt?.webSearch,
      httpStatus: statuses[statuses.length - 1],
      statuses,
      attempts: w.attempts,
      latencyMs,
      finishReason: w.finishReason,
      contentChars: content.length,
      reasoningChars: (w.reasoning ?? "").length,
      reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : undefined,
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
      responseModel: respModel,
      citations: w.citations,
      estCostUsd: callCost,
      parseOk,
      parseReason: thrown ? `error: ${thrown.slice(0, 200)}` : parseReason,
      specificity,
      contentFilter: w.finishReason === "content_filter",
      temperatureRejected: tempRejected,
      contentHead: content.slice(0, 300),
      error: thrown,
      extra: Object.keys(extra).length ? extra : undefined,
      logLines: logLines.slice(0, 40),
    };
    calls.push(rec);
    console.log(
      `◀ ${p.id}: HTTP ${statuses.join("→") || "-"} ${Math.round(latencyMs / 1000)}s finish=${w.finishReason ?? "-"} content=${content.length}ch ` +
        `tok in/out/reason=${rec.promptTokens ?? "?"}/${rec.completionTokens ?? "?"}/${rec.reasoningTokens ?? "?"} ${usd(callCost)} ` +
        `parse=${parseOk ? "✓" : "✗"} (${rec.parseReason})${tempRejected ? " [temperature REJECTED → retried without]" : ""}`,
    );

    const d = decideAfterCall(nonBillingErrors, { ok, statuses, errorTexts });
    nonBillingErrors = d.nonBillingErrors;
    if (d.action === "stop") {
      stop = { reason: d.reason ?? "stop", atShape: p.id, billing: d.billing };
      console.log(`⛔ STOP after ${p.id}: ${stop.reason}`);
      break;
    }
  }

  // (f) Post-flight balance. Skipped after ANY billing/lockout stop: no further
  // request of any kind goes out with the key once it has said 402/429.
  const post = stop?.billing
    ? { snap: null as RateLimitsSnapshot | null, error: "skipped after a billing/lockout stop (no further requests with the key)" }
    : await getRateLimits();
  const before = pre.snap!;
  const after = post.snap;
  const delta = after ? before.diem + before.usd - (after.diem + after.usd) : null;
  const refillCrossed = !!after && after.nextEpochBegins !== before.nextEpochBegins;

  // Copy the sandboxed ledger rows (what chat() recorded) into the report.
  let ledgerRows: unknown[] = [];
  try {
    ledgerRows = util.readJsonl(join(util.NOOK_DIR, "venice-costs.jsonl"));
  } catch {
    /* none */
  }

  const findings = {
    temperatureRejected: calls.some((c) => c.temperatureRejected) ? true : calls.some((c) => c.shape !== "jev" && c.statuses[0] === 200) ? false : null,
    effortsAnswered: [...new Set(calls.filter((c) => c.statuses.includes(200) && c.shape !== "jev").map((c) => c.effort))],
    responseModels: [...new Set(calls.map((c) => c.responseModel).filter(Boolean))],
    responseModelMatchesRequest: (() => {
      const seen = calls.filter((c) => c.shape !== "jev" && c.responseModel);
      return seen.length ? seen.every((c) => c.responseModel === c.model) : null; // ledger + breaker key on this echo
    })(),
    emptyContent: calls.filter((c) => c.shape !== "jev" && c.statuses.includes(200) && c.contentChars === 0).map((c) => c.shape),
    contentFilter: calls.filter((c) => c.contentFilter).map((c) => c.shape),
    finishLength: calls.filter((c) => c.finishReason === "length").map((c) => c.shape),
    parseFailures: calls.filter((c) => !c.parseOk).map((c) => c.shape),
    maxCompletionTokens: Math.max(0, ...calls.map((c) => c.completionTokens ?? 0)),
    promptDrift: drift,
  };
  const report = {
    probe: "gpt61-sol",
    startedAt,
    finishedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    model: args.model,
    budgetUsd: args.budget,
    completionFloor: COMPLETION_FLOOR,
    preflight: { before, verdict: verdict.reason },
    inputs: {
      python: inputs.python ? { id: inputs.python.ch.id, title: inputs.python.ch.title, source: inputs.python.source, baseline: inputs.python.baseline } : null,
      standard: inputs.standard ? { id: inputs.standard.ch.id, title: inputs.standard.ch.title, source: inputs.standard.source, baseline: inputs.standard.baseline } : null,
      verifyTrace: inputs.verifyTrace ? { source: inputs.verifyTrace.source, chars: inputs.verifyTrace.text.length, earlierScores: inputs.verifyTrace.earlierScores } : null,
      projectDraft: inputs.projectDraft ? { slug: inputs.projectDraft.slug, chars: inputs.projectDraft.code.length } : null,
      notes: inputs.notes,
      limitations: [
        "solves ran with no related-learnings, no mining-context gather and no submission guide (production adds them) — prompts are smaller than production",
        "replicated shapes (json/review/verify) are copies of production strings; see findings.promptDrift",
        "probe spend is NOT in ~/.nookplot/venice-costs.jsonl (ledger sandboxed); see ledgerRows",
      ],
    },
    calls,
    stop,
    totals: { estUsd: spent, ledgerUsd: ledgerRows.reduce((s: number, r) => s + Number((r as { estCost?: number }).estCost ?? 0), 0) },
    postflight: {
      after,
      error: post.error,
      balanceDropUsd: delta,
      estimateUsd: spent,
      ratio: delta !== null && spent > 0 ? delta / spent : null,
      refillCrossed,
    },
    findings,
    ledgerRows,
  };

  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `gpt61-probe-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Compact table.
  console.log("\n== gpt61 probe summary ==");
  console.log(["shape", "http", "secs", "finish", "content", "in/out/reason tok", "est $", "parse", "temp-rej", "spec (raw summary | shipped)"].join(" | "));
  for (const c of calls) {
    const sp = c.specificity as { summaryRaw?: { categories?: string[]; passesGate?: boolean }; summaryShipped?: { passesGate?: boolean } | null } | undefined;
    const spec = sp?.summaryRaw ? `${(sp.summaryRaw.categories ?? []).length}/6 ${sp.summaryRaw.passesGate ? "pass" : "FAIL"} | ${sp.summaryShipped ? (sp.summaryShipped.passesGate ? "pass" : "FAIL") : "-"}` : "-";
    console.log(
      [c.shape, c.statuses.join("→") || "-", Math.round(c.latencyMs / 1000), c.finishReason ?? "-", c.contentChars, `${c.promptTokens ?? "?"}/${c.completionTokens ?? "?"}/${c.reasoningTokens ?? "?"}`, usd(c.estCostUsd), c.parseOk ? "✓" : "✗", c.temperatureRejected ? "YES" : "-", spec].join(" | "),
    );
  }
  console.log(`\nfindings: ${JSON.stringify(findings)}`);
  if (after) {
    console.log(
      `💳 after: DIEM ${after.diem.toFixed(3)}  USD ${after.usd.toFixed(3)} — balance drop ${delta!.toFixed(4)} vs summed estimates ${spent.toFixed(4)}` +
        `${spent > 0 ? ` (ratio ${(delta! / spent).toFixed(2)})` : ""}${refillCrossed ? " ⚠ DIEM epoch rolled over mid-run — delta not comparable" : ""}`,
    );
  } else {
    console.log(`💳 after: not read (${post.error ?? "unavailable"})`);
  }
  console.log(`report: ${reportPath}`);
  if (stop?.billing) return 1;
  if (stop && !stop.budget) return 2;
  if (stop?.budget) return 3;
  return 0;
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("✗ probe crashed:", err);
      process.exit(2);
    },
  );
}
