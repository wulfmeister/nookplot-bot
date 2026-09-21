/**
 * Contract canary — READ-ONLY gateway shape-drift detector.
 *
 * The gateway has drifted its response shapes on us repeatedly (see AGENTS.md
 * "gateway shape-drift sweep" 2026-06-07, "unified skip-cache architecture"
 * 2026-06-08). Every one of those was discovered the hard way: a 400 in the
 * middle of a solve loop, a `guide.starterCode.slice is not a function`, a
 * region-status enum the gateway had quietly renamed. Each cost real epoch
 * slots or verify budget before anyone noticed.
 *
 * This module flips that: every 6h it re-probes a small registry of the
 * READ-ONLY GET endpoints our earning paths depend on, structurally diffs the
 * payload against a declared spec, and logs any drift. No writes are ever
 * issued — it can only ever observe, never mutate.
 *
 * Output line shape (one JSONL line per run):
 *   { ts, endpointId:"*", probed, drift, failed, skipped, confirmed, resolved }
 *
 *   probed    — endpoints successfully read this run
 *   failed    — probes that threw (counted, skipped, never abort the rest)
 *   skipped   — endpoints whose {addr} could not be resolved
 *   drift     — the DEDUPED set of currently-ACTIVE CONFIRMED drifts
 *   confirmed — paths newly promoted to "reported" this run (stability gate)
 *   resolved  — previously-reported drifts that just cleared
 *
 * Stability gating (BOT_CONTRACT_CANARY_STABLE_PROBES, default 2, min 1):
 * a drift must be observed in N CONSECUTIVE runs before it is reported
 * (`confirmed`), and a reported drift that is ABSENT for N consecutive runs is
 * emitted as `resolved`. State persists across restarts in
 * ~/.nookplot/contract-canary-state.json (atomic temp+rename write).
 *
 * Toggle off with BOT_CONTRACT_CANARY=0. Logs to ~/.nookplot/contract-drift.jsonl.
 */
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG_PATH = join(NOOK_DIR, "contract-drift.jsonl");
const STATE_PATH = join(NOOK_DIR, "contract-canary-state.json");
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;
const RECENT_DRIFT_LIMIT = 20;
const DESCRIBE_KEY_LIMIT = 8;
const MAX_LOG_LINE = 120;
const ADDR_PLACEHOLDER = "{addr}";
const MAX_ARRAY_SCAN = 50; // bound the per-array element scan for cost
const DEFAULT_STABLE_PROBES = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldType = "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";

export interface FieldSpec {
  type: FieldType | FieldType[]; // union arrays allowed, e.g. ["string","number"]
  required?: boolean; // default false
  item?: FieldSpec; // for type "array"
  fields?: Record<string, FieldSpec>; // for type "object"
}

export interface EndpointContract {
  id: string; // stable key, e.g. "verifiable-pool"
  method: "GET"; // GET only — the module must never probe writes
  path: string; // may contain the placeholder {addr}
  description: string;
  spec: FieldSpec;
}

export type DriftKind = "type_changed" | "field_removed" | "field_added" | "nullability_changed" | "array_item_shape_changed";

export interface Drift {
  endpointId: string;
  path: string; // dotted path into the payload, e.g. "submissions[].verification_count"
  kind: DriftKind;
  expected: string;
  observed: string;
}

/** A drift under stabilization that has not yet reached N consecutive runs. */
interface PendingDrift {
  endpointId: string;
  path: string;
  group: string; // "presence" for field_removed/nullability_changed, else the kind
  sawNull: boolean; // whether the current streak observed an explicit null
  expected: string;
  observed: string;
  seenRuns: number;
}

/** A drift that has reached the stability threshold and is currently reported. */
interface ActiveDrift {
  endpointId: string;
  path: string;
  kind: DriftKind;
  expected: string;
  observed: string;
  absentRuns: number; // consecutive runs absent; >= N resolves it
  confirmedAt: string;
}

/** Persisted state file (survives process restart). */
export interface CanaryStateFile {
  version: 1;
  lastRunAt: string | null;
  active: Record<string, ActiveDrift>;
  pending: Record<string, PendingDrift>;
  totalConfirmedEver: number;
  resolvedCount: number;
  byKind: Record<string, number>; // ACTIVE confirmed breakdown by kind
  recent: Drift[]; // last N confirmed drifts, newest last
}

/** Result of one engine.processRun(). */
export interface RunOutcome {
  active: Drift[]; // currently-active confirmed drifts (the deduped set)
  confirmed: Drift[]; // newly confirmed this run
  resolved: Drift[]; // newly resolved this run
}

/** Truthful summary surface (no JSONL double-count). */
export interface CanarySummary {
  lastRunAt: string | null;
  activeConfirmed: number;
  totalConfirmedEver: number;
  resolvedCount: number;
  byKind: Record<string, number>;
  recent: Drift[];
}

// ---------------------------------------------------------------------------
// Registry
//
// Declared fields are the ones an earning path actually reads. Anything we
// don't consume is intentionally left undeclared where it would otherwise
// produce constant `field_added` noise — but top-level additions ARE flagged,
// because a new sibling field is often the signal that a payload we depend on
// got restructured. (Nested undeclared keys are NOT flagged, for the same
// anti-noise reason.)
// ---------------------------------------------------------------------------

/**
 * `submissions[].verification_count` comes back as a JSON STRING despite the
 * column being integer in the schema (confirmed 2026-05-24; see the
 * `VerifiableSub` doc comment in src/network-status.ts, where `vcount()` exists
 * solely to coerce it). Declaring the union here is what keeps the canary from
 * flagging a known-benign gateway quirk on every single run. Do NOT "tidy" this
 * back to `number`.
 */
export const CONTRACTS: EndpointContract[] = [
  {
    id: "epoch",
    method: "GET",
    path: "/v1/mining/epoch",
    description: "Current epoch state (number, status, emission-pool split).",
    spec: {
      type: "object",
      fields: {
        epoch: {
          type: "object",
          required: true,
          fields: {
            epochNumber: { type: "number" },
            status: { type: "string" },
            dailyEmission: { type: "number" },
            agentPool: { type: "number" },
            verificationPool: { type: "number" },
            guildPool: { type: "number" },
            posterPool: { type: "number" },
            isEmergencyReserve: { type: "boolean" },
          },
        },
      },
    },
  },
  {
    id: "verifiable-pool",
    method: "GET",
    path: "/v1/mining/submissions/verifiable?limit=20",
    description: "Verifiable submission pool (verify-loop input).",
    spec: {
      type: "object",
      fields: {
        submissions: {
          type: "array",
          required: true,
          item: {
            type: "object",
            fields: {
              id: { type: "string" },
              verification_count: { type: ["number", "string"] }, // gateway quirk — see block comment above
              solver_address: { type: "string" },
              difficulty: { type: "string" },
              verifier_kind: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
  {
    id: "rlm-pending",
    method: "GET",
    path: "/v1/mining/spot-checks/pending?limit=1",
    description: "RLM spot-check queue + our daily verdict budget.",
    spec: {
      type: "object",
      fields: {
        trajectories: { type: "array", required: true },
        dailyCount: { type: "number" },
        dailyCap: { type: "number" },
      },
    },
  },
  {
    id: "credit-packs",
    method: "GET",
    path: "/v1/credits/packs",
    description: "Purchasable credit packs + on-chain contract addresses.",
    spec: {
      type: "object",
      fields: {
        packs: {
          type: "array",
          required: true,
          item: {
            type: "object",
            fields: {
              id: { type: "number" },
              name: { type: "string" },
              usdcPrice: { type: "string" },
              credits: { type: "number" },
            },
          },
        },
        contractAddress: { type: "string" },
        nookTokenAddress: { type: "string" },
      },
    },
  },
  {
    id: "credit-balance",
    method: "GET",
    path: "/v1/credits/balance",
    description: "Our credit balance + lifetime totals + budget status.",
    spec: {
      type: "object",
      fields: {
        balance: { type: "number", required: true },
        lifetimeEarned: { type: "number", required: true },
        lifetimeSpent: { type: "number", required: true },
        budgetStatus: { type: "string", required: true },
      },
    },
  },
  {
    id: "agent-stats",
    method: "GET",
    path: `/v1/mining/stats/agent/${ADDR_PLACEHOLDER}`,
    description: "Our own mining stats (claimable balance map + pending rewards).",
    spec: {
      type: "object",
      fields: {
        claimableBalance: { type: "object" },
        pendingRewards: { type: "number" },
        totalSolves: { type: "number" },
        totalEarned: { type: "number" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function typeOf(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown"; // undefined, function, symbol, bigint
  }
}

function expectedTypes(spec: FieldSpec): FieldType[] {
  return Array.isArray(spec.type) ? spec.type : [spec.type];
}

/** `number` or `number|string` — the declared side of a comparison. */
function typeLabel(spec: FieldSpec): string {
  return expectedTypes(spec).join("|");
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function hasKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Numeric-string tolerance is OFF by default. When the operator enables it
 * (BOT_CONTRACT_CANARY_NUMERIC_TOLERANCE=1), a `number`-declared field that
 * comes back as a purely numeric string ("42", "-3.14", "1e5") is treated as
 * `number` for the type comparison only — it will NOT emit `type_changed`.
 *
 * TRADE-OFF: this deliberately swallows a real drift signal. It is appropriate
 * only when a schema is known to be sloppy about numeric columns (like
 * `verification_count` above, which we instead handle with a declared union).
 * The gateway muting a numeric column into a quoted string is exactly the kind
 * of shape-drift this module exists to catch, so the default stays OFF.
 */
function numericToleranceEnabled(): boolean {
  const v = process.env.BOT_CONTRACT_CANARY_NUMERIC_TOLERANCE;
  return v === "1" || v === "true";
}

const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function isNumericString(s: string): boolean {
  const t = s.trim();
  return t !== "" && NUMERIC_STRING_RE.test(t) && Number.isFinite(Number(t));
}

/** The type a value counts as for the comparison decision (tolerance-aware). */
function comparisonType(value: unknown): FieldType {
  const t = typeOf(value);
  if (t === "string" && numericToleranceEnabled() && isNumericString(value as string)) return "number";
  return t;
}

/**
 * Human-readable description of the OBSERVED value's shape, e.g.
 * `string`, `null`, `array<object(5 keys: id,verification_count,…)>`,
 * `{balance: number, budgetStatus: string}`.
 */
export function describeShape(value: unknown, spec: FieldSpec): string {
  const t = typeOf(value);
  if (t === "array") {
    const arr = value as unknown[];
    if (arr.length === 0) return spec.item ? `array<${typeLabel(spec.item)}>` : "array<unknown>";
    const inner = typeOf(arr[0]);
    if (inner === "object") {
      const keys = Object.keys(arr[0] as Record<string, unknown>);
      const shown = keys.slice(0, DESCRIBE_KEY_LIMIT).join(",");
      const extra = keys.length > DESCRIBE_KEY_LIMIT ? `,+${keys.length - DESCRIBE_KEY_LIMIT}` : "";
      return `array<object(${keys.length} keys: ${shown}${extra})>`;
    }
    return `array<${inner}>`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    const shown = keys.slice(0, DESCRIBE_KEY_LIMIT).map((k) => `${k}: ${typeOf(obj[k])}`);
    const extra = keys.length > DESCRIBE_KEY_LIMIT ? `, +${keys.length - DESCRIBE_KEY_LIMIT} more` : "";
    return `{${shown.join(", ")}${extra}}`;
  }
  return t;
}

/** Order-independent structural signature, used to detect array heterogeneity. */
function shapeSignature(value: unknown, depth: number): string {
  const t = typeOf(value);
  if (t === "array") return "array";
  if (t === "object") {
    if (depth <= 0) return "object";
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${shapeSignature((value as Record<string, unknown>)[k], depth - 1)}`).join(",")}}`;
  }
  return t;
}

function isHeterogeneous(items: unknown[]): boolean {
  if (items.length <= 1) return false;
  const first = shapeSignature(items[0], 3);
  for (let i = 1; i < items.length; i++) {
    if (shapeSignature(items[i], 3) !== first) return true;
  }
  return false;
}

function describeHeterogeneous(items: unknown[], itemSpec: FieldSpec): string {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const el of items) {
    const d = describeShape(el, itemSpec);
    if (!seen.has(d)) {
      seen.add(d);
      distinct.push(d);
    }
    if (distinct.length >= 3) break;
  }
  return `heterogeneous (${distinct.join(" | ")})`;
}

// ---------------------------------------------------------------------------
// diffShape — fully recursive structural diff (pure: no cross-run state)
// ---------------------------------------------------------------------------

/**
 * Recursive structural diff of `observed` against `spec`.
 *
 * - Recurse into objects via `spec.fields`, into arrays via `spec.item`.
 * - Arrays: inspect ALL elements (capped at MAX_ARRAY_SCAN); a heterogeneous
 *   array (differing types OR differing key sets) emits ONE
 *   `array_item_shape_changed` at `<path>[]`, and each object element is then
 *   descended into with that same `[]` prefix so nested drift gets full dotted
 *   paths (`submissions[].verification_count`).
 * - `field_added` fires for the TOP-LEVEL payload only (nested sibling keys are
 *   deliberately left undeclared to avoid constant noise).
 * - The 5 kinds are preserved exactly; no cross-run state is read or written.
 */
export function diffShape(observed: unknown, spec: FieldSpec, endpointId: string, prefix = ""): Drift[] {
  const seen = new Set<string>();
  const out: Drift[] = [];

  const emit = (d: Drift) => {
    // Recursing into every array element can surface the same (path, kind)
    // many times; collapse to one within a run.
    const key = `${d.endpointId}\u0000${d.path}\u0000${d.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  function recurse(value: unknown, s: FieldSpec, pathPrefix: string, isRoot: boolean): void {
    if (value === null) {
      // null at any depth: nullability_changed unless the spec allows null.
      if (!expectedTypes(s).includes("null")) {
        emit({ endpointId, path: pathPrefix || "$", kind: "nullability_changed", expected: typeLabel(s), observed: "null" });
      }
      return;
    }

    const vt = comparisonType(value);
    const allowed = expectedTypes(s);

    if (!allowed.includes(vt)) {
      emit({ endpointId, path: pathPrefix || "$", kind: "type_changed", expected: typeLabel(s), observed: describeShape(value, s) });
      return;
    }

    if (vt === "object" && s.fields) {
      const obj = value as Record<string, unknown>;
      for (const [key, fs] of Object.entries(s.fields)) {
        const p = joinPath(pathPrefix, key);
        if (!hasKey(obj, key)) {
          if (fs.required) emit({ endpointId, path: p, kind: "field_removed", expected: typeLabel(fs), observed: "missing" });
          continue;
        }
        recurse(obj[key], fs, p, false);
      }
      if (isRoot) {
        for (const key of Object.keys(obj)) {
          if (hasKey(s.fields, key)) continue;
          emit({ endpointId, path: joinPath(pathPrefix, key), kind: "field_added", expected: "(undeclared)", observed: describeShape(obj[key], { type: "unknown" }) });
        }
      }
      return;
    }

    if (vt === "array" && s.item) {
      const arr = value as unknown[];
      const elSpec = s.item;
      const elPrefix = `${pathPrefix}[]`;
      const scanned = arr.slice(0, MAX_ARRAY_SCAN);
      if (arr.length > 0 && isHeterogeneous(scanned)) {
        emit({
          endpointId,
          path: elPrefix,
          kind: "array_item_shape_changed",
          expected: `array<${typeLabel(elSpec)}>`,
          observed: describeHeterogeneous(scanned, elSpec),
        });
      }
      for (const el of scanned) recurse(el, elSpec, elPrefix, false);
      return;
    }
    // primitives / arrays without a declared item: nothing further to compare
  }

  recurse(observed, spec, prefix, true);
  return out;
}

// ---------------------------------------------------------------------------
// Stability-gating state (the design-heavy part)
// ---------------------------------------------------------------------------

const DRIFT_KINDS: ReadonlySet<string> = new Set([
  "type_changed",
  "field_removed",
  "field_added",
  "nullability_changed",
  "array_item_shape_changed",
]);

/**
 * `field_removed` (absent + required) and `nullability_changed` (present null)
 * describe the SAME underlying drift ("this field isn't reliably carrying its
 * declared type") across runs. Grouping them under one bucket key is what stops
 * a field that flips absent↔null from oscillating between the two kinds on
 * alternate runs. The reported kind is `nullability_changed` if the streak ever
 * saw an explicit null, otherwise `field_removed`.
 */
function groupKind(kind: DriftKind): string {
  return kind === "field_removed" || kind === "nullability_changed" ? "presence" : kind;
}

function effectiveKind(group: string, sawNull: boolean): DriftKind {
  if (group === "presence") return sawNull ? "nullability_changed" : "field_removed";
  return group as DriftKind;
}

function driftKey(endpointId: string, path: string, kind: DriftKind): string {
  return `${endpointId}\u0000${path}\u0000${groupKind(kind)}`;
}

function sortDrifts(a: Drift, b: Drift): number {
  return a.endpointId === b.endpointId ? (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) : a.endpointId < b.endpointId ? -1 : 1;
}

function emptyState(): CanaryStateFile {
  return { version: 1, lastRunAt: null, active: {}, pending: {}, totalConfirmedEver: 0, resolvedCount: 0, byKind: {}, recent: [] };
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Defensive hydration: a parseable-but-misshapen file degrades to empty, never throws. */
function sanitizeState(raw: unknown): CanaryStateFile {
  const s = emptyState();
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return s;
  if (typeof r.lastRunAt === "string") s.lastRunAt = r.lastRunAt;
  s.totalConfirmedEver = asNum(r.totalConfirmedEver);
  s.resolvedCount = asNum(r.resolvedCount);
  if (r.byKind && typeof r.byKind === "object") {
    for (const [k, v] of Object.entries(r.byKind as Record<string, unknown>)) {
      const n = asNum(v);
      if (n > 0 && DRIFT_KINDS.has(k)) s.byKind[k] = n;
    }
  }
  if (r.active && typeof r.active === "object") {
    for (const [k, v] of Object.entries(r.active as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      if (typeof d.path === "string" && typeof d.kind === "string" && DRIFT_KINDS.has(d.kind)) {
        s.active[k] = {
          endpointId: asStr(d.endpointId),
          path: d.path,
          kind: d.kind as DriftKind,
          expected: asStr(d.expected),
          observed: asStr(d.observed),
          absentRuns: asNum(d.absentRuns),
          confirmedAt: asStr(d.confirmedAt),
        };
      }
    }
  }
  if (r.pending && typeof r.pending === "object") {
    for (const [k, v] of Object.entries(r.pending as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      if (typeof d.path === "string" && typeof d.group === "string") {
        s.pending[k] = {
          endpointId: asStr(d.endpointId),
          path: d.path,
          group: d.group,
          sawNull: Boolean(d.sawNull),
          expected: asStr(d.expected),
          observed: asStr(d.observed),
          seenRuns: Math.max(1, asNum(d.seenRuns)),
        };
      }
    }
  }
  if (Array.isArray(r.recent)) {
    for (const v of r.recent as unknown[]) {
      if (!v || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      if (typeof d.kind === "string" && DRIFT_KINDS.has(d.kind)) {
        s.recent.push({
          endpointId: asStr(d.endpointId),
          path: asStr(d.path),
          kind: d.kind as DriftKind,
          expected: asStr(d.expected),
          observed: asStr(d.observed),
        });
        if (s.recent.length >= RECENT_DRIFT_LIMIT) break;
      }
    }
  }
  return s;
}

function loadStateFile(path: string): CanaryStateFile | null {
  try {
    if (!existsSync(path)) return null;
    return sanitizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null; // corrupt (or unreadable) → treat as empty
  }
}

function saveStateFile(path: string, state: CanaryStateFile): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path); // atomic-ish: a crash mid-write leaves the old file intact
  } catch {
    // persistence is best-effort — never let a state write break the loop
  }
}

/**
 * The stabilization engine. Side-effect-free to construct (no IO until load/save
 * are called); `diffShape` remains entirely separate and pure. Test code can
 * drive a bare engine with an explicit temp path and no filesystem fallout.
 */
export class ContractCanaryEngine {
  readonly path: string | null;
  private state: CanaryStateFile;
  private loaded = false;

  constructor(path: string | null = null) {
    this.path = path;
    this.state = emptyState();
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.path === null) return;
    const s = loadStateFile(this.path);
    if (s) this.state = s;
  }

  save(): void {
    if (this.path === null) return;
    saveStateFile(this.path, this.state);
  }

  /**
   * Fold one run's findings into the state and advance the stability gate.
   * `n` = consecutive runs required to confirm/resolve (>= 1; 1 = immediate).
   */
  processRun(findings: Drift[], ts: string, n: number): RunOutcome {
    const threshold = n >= 1 ? n : DEFAULT_STABLE_PROBES;

    // 1. Collapse this run's findings into a per-key observed map (presence
    //    kinds merge; expected/observed take the latest values).
    const observed = new Map<string, { endpointId: string; path: string; group: string; sawNull: boolean; expected: string; observed: string }>();
    for (const d of findings) {
      const key = driftKey(d.endpointId, d.path, d.kind);
      const prior = observed.get(key);
      if (prior) {
        prior.sawNull = prior.sawNull || d.kind === "nullability_changed";
        prior.expected = d.expected;
        prior.observed = d.observed;
      } else {
        observed.set(key, {
          endpointId: d.endpointId,
          path: d.path,
          group: groupKind(d.kind),
          sawNull: d.kind === "nullability_changed",
          expected: d.expected,
          observed: d.observed,
        });
      }
    }

    const confirmedOut: Drift[] = [];
    const resolvedOut: Drift[] = [];

    const confirm = (key: string, p: PendingDrift) => {
      const kind = effectiveKind(p.group, p.sawNull);
      const drift: Drift = { endpointId: p.endpointId, path: p.path, kind, expected: p.expected, observed: p.observed };
      this.state.active[key] = { endpointId: p.endpointId, path: p.path, kind, expected: p.expected, observed: p.observed, absentRuns: 0, confirmedAt: ts };
      delete this.state.pending[key];
      this.state.totalConfirmedEver += 1;
      this.state.byKind[kind] = (this.state.byKind[kind] ?? 0) + 1;
      this.state.recent = [...this.state.recent, drift].slice(-RECENT_DRIFT_LIMIT);
      confirmedOut.push(drift);
    };

    const activeKeys = new Set(Object.keys(this.state.active));
    const pendingKeys = new Set(Object.keys(this.state.pending));

    for (const [key, obs] of observed) {
      if (key in this.state.active) {
        activeKeys.delete(key); // still present — refresh attributes, reset absence
        const a = this.state.active[key];
        a.expected = obs.expected;
        a.observed = obs.observed;
        a.absentRuns = 0;
      } else if (key in this.state.pending) {
        pendingKeys.delete(key);
        const p = this.state.pending[key];
        p.seenRuns += 1;
        p.expected = obs.expected;
        p.observed = obs.observed;
        p.sawNull = p.sawNull || obs.sawNull;
        if (p.seenRuns >= threshold) confirm(key, p);
      } else {
        const pNext: PendingDrift = { endpointId: obs.endpointId, path: obs.path, group: obs.group, sawNull: obs.sawNull, expected: obs.expected, observed: obs.observed, seenRuns: 1 };
        this.state.pending[key] = pNext;
        if (threshold <= 1) confirm(key, pNext);
      }
    }

    // Active drifts not seen this run → advance absence; RESOLVE at threshold.
    for (const key of activeKeys) {
      const a = this.state.active[key];
      a.absentRuns += 1;
      if (a.absentRuns >= threshold) {
        delete this.state.active[key];
        resolvedOut.push({ endpointId: a.endpointId, path: a.path, kind: a.kind, expected: a.expected, observed: a.observed });
        this.state.resolvedCount += 1;
        this.state.byKind[a.kind] = Math.max(0, (this.state.byKind[a.kind] ?? 0) - 1);
        this.state.recent = this.state.recent.filter((d) => !(d.endpointId === a.endpointId && d.path === a.path && d.kind === a.kind));
      }
    }

    // Pending drifts not seen this run → the consecutive streak broke; drop it.
    for (const key of pendingKeys) delete this.state.pending[key];

    this.state.lastRunAt = ts;

    return {
      active: Object.values(this.state.active).map((a): Drift => ({ endpointId: a.endpointId, path: a.path, kind: a.kind, expected: a.expected, observed: a.observed })).sort(sortDrifts),
      confirmed: confirmedOut.sort(sortDrifts),
      resolved: resolvedOut.sort(sortDrifts),
    };
  }

  summary(): CanarySummary {
    return {
      lastRunAt: this.state.lastRunAt,
      activeConfirmed: Object.keys(this.state.active).length,
      totalConfirmedEver: this.state.totalConfirmedEver,
      resolvedCount: this.state.resolvedCount,
      byKind: { ...this.state.byKind },
      recent: [...this.state.recent],
    };
  }

  /** Raw state accessor for tests (round-trip assertions). */
  getState(): CanaryStateFile {
    return this.state;
  }
}

// Module-level singleton (IO deferred until the first load/save).
const engine = new ContractCanaryEngine(STATE_PATH);

/** Stability threshold: BOT_CONTRACT_CANARY_STABLE_PROBES (default 2, min 1). */
export function stableProbes(): number {
  const raw = Number(process.env.BOT_CONTRACT_CANARY_STABLE_PROBES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_STABLE_PROBES;
}

/**
 * The exact JSONL object written once per run. `drift` is the deduped ACTIVE
 * confirmed set (stable across runs), not the raw per-run findings.
 */
export function buildLogEntry(ts: string, probed: number, failed: number, skipped: number, outcome: RunOutcome): Record<string, unknown> {
  return {
    ts,
    endpointId: "*",
    probed,
    drift: outcome.active,
    failed,
    skipped,
    confirmed: outcome.confirmed,
    resolved: outcome.resolved,
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Our own address, or null. The connection getter can throw before connect(),
 * and the env var is the CLI-written fallback (same precedence as
 * src/runtime.ts).
 */
function ownAddress(runtime: RuntimeLike): string | null {
  try {
    const addr = runtime.connection?.address;
    if (typeof addr === "string" && addr.trim()) return addr.trim();
  } catch {
    /* not connected yet */
  }
  const env = process.env.NOOKPLOT_AGENT_ADDRESS;
  return typeof env === "string" && env.trim() ? env.trim() : null;
}

/**
 * Substitute {addr} when the template needs it. Returns null when the template
 * needs an address we don't have — the caller SKIPS that endpoint rather than
 * probing a literal "{addr}" path.
 */
function resolvePath(template: string, addr: string | null): string | null {
  if (!template.includes(ADDR_PLACEHOLDER)) return template;
  if (!addr) return null;
  return template.replace(ADDR_PLACEHOLDER, encodeURIComponent(addr));
}

/** One-line console summary. Never includes headers, auth, or the API key. */
function formatLine(probed: number, failed: number, skipped: number, drift: Drift[]): string {
  const byKind = new Map<string, number>();
  for (const d of drift) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
  const kindText = [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
  const first = drift[0] ? ` at=${drift[0].endpointId}` : "";
  let line =
    `🔎 contracts ${probed}/${CONTRACTS.length} probed` +
    (skipped > 0 ? ` skip=${skipped}` : "") +
    (failed > 0 ? ` fail=${failed}` : "") +
    ` drift=${drift.length}` +
    (kindText ? ` [${kindText}]` : "") +
    first;
  if (line.length > MAX_LOG_LINE) line = `${line.slice(0, MAX_LOG_LINE - 1)}…`;
  return line;
}

/**
 * Probe every registered contract once and report drift.
 *
 * Read-only by construction: every request is a GET against the registry's
 * declared path. A probe that throws is counted and skipped — it can never
 * abort the remaining endpoints or bubble out of this function.
 */
export async function runContractCanaryTick(runtime: RuntimeLike): Promise<{ probed: number; drift: Drift[] }> {
  if (process.env.BOT_CONTRACT_CANARY === "0") return { probed: 0, drift: [] };
  engine.load();

  const addr = ownAddress(runtime);
  let probed = 0;
  let failed = 0;
  let skipped = 0;
  const findings: Drift[] = [];

  for (const contract of CONTRACTS) {
    const path = resolvePath(contract.path, addr);
    if (path === null) {
      skipped++;
      continue;
    }
    let payload: unknown;
    try {
      payload = await runtime.connection.request("GET", path);
    } catch {
      failed++;
      continue;
    }
    probed++;
    findings.push(...diffShape(payload, contract.spec, contract.id));
  }

  const ts = new Date().toISOString();
  const outcome = engine.processRun(findings, ts, stableProbes());
  engine.save();

  // ONE aggregate line per run; endpointId "*" marks it as whole-registry, and
  // per-endpoint ids live inside drift[].endpointId.
  try {
    appendJsonl(LOG_PATH, buildLogEntry(ts, probed, failed, skipped, outcome));
  } catch (e) {
    console.warn(`🔎 contract canary log failed: ${(e as Error).message.slice(0, 80)}`);
  }

  console.log(formatLine(probed, failed, skipped, outcome.active));
  return { probed, drift: outcome.active };
}

/**
 * Truthful summary from the persisted state (NOT the JSONL — reading the JSONL
 * and summing historical `drift` arrays would double-count the same active
 * drift across every run since it was confirmed).
 */
export function contractCanarySummary(): CanarySummary {
  engine.load();
  return engine.summary();
}

export function startContractCanaryLoop(runtime: RuntimeLike): void {
  if (process.env.BOT_CONTRACT_CANARY === "0") return;
  const configured = Number(process.env.BOT_CONTRACT_CANARY_INTERVAL_MS);
  const every = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;
  // First probe 60s after boot (lets the connection settle), then every `every`.
  setTimeout(() => {
    void runContractCanaryTick(runtime).catch(() => undefined);
  }, FIRST_RUN_DELAY_MS);
  setInterval(() => {
    void runContractCanaryTick(runtime).catch(() => undefined);
  }, every);
}
