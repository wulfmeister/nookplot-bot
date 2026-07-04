/**
 * Centralized rate-limit + cost-guardrail accounting.
 *
 * Three concerns live here, all related to "what are we allowed to do today":
 *
 *   1. Verifier shared cap (verifies + crowd-jury scores share one budget at
 *      the gateway). Single counter — both consumers increment it.
 *   2. Auto-write cost cap — every auto-write surface (bounty apply, swarm
 *      submit, teaching deliver, clarify offer) consults this before acting.
 *      Sums per-action costs into a daily running total; halts when over cap.
 *   3. Reputation-aware cooldown for bounty auto-apply — if our last N
 *      applications have a low approval rate, halve our daily cap for a week.
 *
 * All accounting is in-memory (counters reset on UTC day rollover) +
 * JSONL-backed for visibility. State is reconstructed from JSONL on boot so a
 * restart mid-day doesn't lose count.
 *
 * ENV:
 *   BOT_VERIFY_SHARED_CAP        — default 38 (gateway-imposed 40 with buffer)
 *   BOT_AUTO_WRITE_DAILY_COST_CAP — default 1.0 NOOK (sum of action costs)
 *   BOT_BOUNTY_AUTO_APPLY_DAILY_CAP — default 2
 *   BOT_BOUNTY_APPROVAL_FLOOR    — default 0.20 (20%)
 *   BOT_BOUNTY_LOOKBACK          — default 5 (last N applications)
 *   BOT_BOUNTY_COOLDOWN_DAYS     — default 7
 */
import { join } from "node:path";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

const QUOTA_LOG = join(NOOK_DIR, "quotas.jsonl");
const BOUNTY_APP_LOG = join(NOOK_DIR, "bounty-applications.jsonl");

// ─── 1. Verifier shared cap ──────────────────────────────────────────────

/** Gateway-side cap minus a small safety buffer (gateway is hard 40). */
export const VERIFY_SHARED_CAP = Number(process.env.BOT_VERIFY_SHARED_CAP ?? 38);
// The gateway enforces the verify+crowd budget over a ROLLING 24h window (same
// as the mining regular cap — see mining.ts rollingCapState; a calendar-midnight
// reset is empirically ruled out by a limit-hit 6.9 min past 00:00Z), NOT a clean
// daily reset. Count usage over the trailing 24h so a slot frees exactly when its
// entry ages out, instead of falsely re-opening 38 slots at midnight.
const VERIFY_WINDOW_MS = 24 * 3600_000;

interface VerifyEntry {
  ts: string;
  kind: "verify" | "crowd-score" | "limit-hit";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Count verify+crowd-score actions in the trailing rolling 24h window. */
export function verifySharedCount(): number {
  const cutoff = Date.now() - VERIFY_WINDOW_MS;
  return readJsonl<VerifyEntry>(QUOTA_LOG).filter(
    (e) => e.ts && new Date(e.ts).getTime() > cutoff && (e.kind === "verify" || e.kind === "crowd-score"),
  ).length;
}

// Burst pacing: the 2026-06-29 collapse (39 verifies free-fired in a burst →
// gateway 429 → limit-hit froze verifying for a whole window, ~37 slots ≈
// 5.8k NOOK lost on 06-30) was a rate problem, not a budget problem. Cap the
// trailing-hour rate so consumption spreads across the rolling window:
// 2/h × 24h = 48 ≥ shared cap 38, so pacing never shrinks the daily total —
// it only prevents cap-boundary collisions with the gateway's own counter.
const VERIFY_HOURLY_PACE = Number(process.env.BOT_VERIFY_HOURLY_PACE ?? 2);

/** Pure pacing check: true when the trailing-hour action count is under the rate. Testable. */
export function verifyPaceOk(actionTsMs: number[], nowMs: number, perHour: number = VERIFY_HOURLY_PACE): boolean {
  return actionTsMs.filter((t) => Number.isFinite(t) && t > nowMs - 3600_000).length < perHour;
}

function verifyPaceOkNow(): boolean {
  const ts = readJsonl<VerifyEntry>(QUOTA_LOG)
    .filter((e) => e.ts && (e.kind === "verify" || e.kind === "crowd-score"))
    .map((e) => new Date(e.ts).getTime());
  return verifyPaceOk(ts, Date.now());
}

/** Did the gateway 429 the verify cap within the trailing 24h window? */
export function verifyLimitHitToday(): boolean {
  const cutoff = Date.now() - VERIFY_WINDOW_MS;
  return readJsonl<VerifyEntry>(QUOTA_LOG).some(
    (e) => e.ts && new Date(e.ts).getTime() > cutoff && e.kind === "limit-hit",
  );
}

/** Pre-flight check before any verify or crowd-score action. */
export function canVerifyNow(): boolean {
  if (verifyLimitHitToday()) return false;
  if (!verifyPaceOkNow()) return false;
  return verifySharedCount() < VERIFY_SHARED_CAP;
}

/** Record a successful verify. */
export function recordVerify(): void {
  appendJsonl(QUOTA_LOG, { ts: new Date().toISOString(), kind: "verify" as const });
}

/** Record a successful crowd-jury score. */
export function recordCrowdScore(): void {
  appendJsonl(QUOTA_LOG, { ts: new Date().toISOString(), kind: "crowd-score" as const });
}

/**
 * Call when the gateway returns a 429 for the verify-shared cap. This halts
 * further verify/crowd-score attempts until the limit-hit ages out of the
 * trailing 24h window, sparing us the retry storm.
 */
export function recordVerifyLimitHit(): void {
  appendJsonl(QUOTA_LOG, { ts: new Date().toISOString(), kind: "limit-hit" as const });
}

// ─── 2. Auto-write cost cap ──────────────────────────────────────────────

// Bumped 1.0 → 10.0 (2026-05-26): EV math favors aggressive applying with
// minimal per-action cost; the per-action gates + reputation cooldown are
// stronger feedback signals than a tight global cap.
export const AUTO_WRITE_DAILY_COST_CAP = Number(process.env.BOT_AUTO_WRITE_DAILY_COST_CAP ?? 10.0);

interface AutoWriteEntry {
  ts: string;
  kind: "auto-write";
  surface: "bounty" | "swarm" | "teaching" | "clarification";
  cost: number;
  notes?: string;
}

/** Sum of auto-write action costs today (in NOOK or whatever the cost basis is). */
export function autoWriteCostToday(): number {
  const today = todayUtc();
  return readJsonl<AutoWriteEntry>(QUOTA_LOG)
    .filter((e) => e.ts && e.ts.slice(0, 10) === today && e.kind === "auto-write")
    .reduce((s, e) => s + (e.cost ?? 0), 0);
}

/** Pre-flight: would adding one more auto-write of cost X exceed the cap? */
export function canAutoWriteNow(estimatedCost: number): boolean {
  return autoWriteCostToday() + estimatedCost <= AUTO_WRITE_DAILY_COST_CAP;
}

/** Record an auto-write action with its estimated cost. */
export function recordAutoWrite(surface: AutoWriteEntry["surface"], cost: number, notes?: string): void {
  appendJsonl(QUOTA_LOG, {
    ts: new Date().toISOString(),
    kind: "auto-write" as const,
    surface,
    cost,
    notes,
  });
}

// ─── 3. Reputation-aware bounty cooldown ─────────────────────────────────

// Bumped 2 → 20 (2026-05-26): the cost cap is the real binding constraint
// (10 NOOK/day ≈ 100 applies/day at 0.10 each), and we want to capture as
// many opportunities as the LLM can generate quality applications for.
const BOUNTY_AUTO_APPLY_DAILY_CAP = Number(process.env.BOT_BOUNTY_AUTO_APPLY_DAILY_CAP ?? 20);
const BOUNTY_APPROVAL_FLOOR = Number(process.env.BOT_BOUNTY_APPROVAL_FLOOR ?? 0.20);
const BOUNTY_LOOKBACK = Number(process.env.BOT_BOUNTY_LOOKBACK ?? 5);
const BOUNTY_COOLDOWN_DAYS = Number(process.env.BOT_BOUNTY_COOLDOWN_DAYS ?? 7);

interface BountyApp {
  ts: string;
  bountyId?: string;
  outcome?: "submitted" | "approved" | "rejected" | "error" | "skipped";
  auto?: boolean;
}

/**
 * Look at the last N (by timestamp) bounty applications we made. Compute the
 * approval rate. If below the floor, we're in a cooldown.
 *
 * Returns the effective daily cap (full, halved, or 0).
 */
export function effectiveBountyAutoApplyCap(): { cap: number; reason: string } {
  const apps = readJsonl<BountyApp>(BOUNTY_APP_LOG);
  // Sort newest first
  const sorted = [...apps]
    .filter((a) => a.outcome && a.outcome !== "skipped" && a.outcome !== "error")
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, BOUNTY_LOOKBACK);

  if (sorted.length < BOUNTY_LOOKBACK) {
    // Not enough data — full cap
    return { cap: BOUNTY_AUTO_APPLY_DAILY_CAP, reason: `lookback insufficient (${sorted.length}/${BOUNTY_LOOKBACK})` };
  }

  const approved = sorted.filter((a) => a.outcome === "approved").length;
  const rate = approved / sorted.length;

  if (rate >= BOUNTY_APPROVAL_FLOOR) {
    return { cap: BOUNTY_AUTO_APPLY_DAILY_CAP, reason: `approval=${(rate * 100).toFixed(0)}% ≥ floor` };
  }

  // Cooldown active — but only if the last rejection is recent enough
  const lastRejection = sorted.find((a) => a.outcome === "rejected");
  if (lastRejection?.ts) {
    const daysSince = (Date.now() - new Date(lastRejection.ts).getTime()) / (24 * 3600_000);
    if (daysSince <= BOUNTY_COOLDOWN_DAYS) {
      return {
        cap: Math.max(1, Math.floor(BOUNTY_AUTO_APPLY_DAILY_CAP / 2)),
        reason: `low approval (${(rate * 100).toFixed(0)}%, last reject ${daysSince.toFixed(1)}d ago)`,
      };
    }
  }
  return { cap: BOUNTY_AUTO_APPLY_DAILY_CAP, reason: `cooldown expired (>${BOUNTY_COOLDOWN_DAYS}d)` };
}

// ─── 4. Reputation cooldown for teaching + clarification ────────────────
//
// These tracks don't have an explicit "approved/rejected" signal like
// bounties do. We use a proxy: error rate within the lookback window. If
// > 50% of recent attempts errored (gateway rejections, timeouts, bad
// gen output), we halve the cap until the rate recovers.

const TEACHING_LESSON_LOG = join(NOOK_DIR, "teaching.jsonl");
const CLARIFY_LOG = join(NOOK_DIR, "clarifications.jsonl");

const DAILY_LESSON_CAP = Number(process.env.BOT_TEACHING_DELIVER_DAILY_CAP ?? 2);
const DAILY_OFFER_CAP = Number(process.env.BOT_CLARIFY_OFFER_DAILY_CAP ?? 3);
const ERROR_RATE_FLOOR = Number(process.env.BOT_AUTO_WRITE_ERROR_FLOOR ?? 0.50);
const COOLDOWN_LOOKBACK = Number(process.env.BOT_AUTO_WRITE_LOOKBACK ?? 6);

interface TeachingLogRow {
  ts?: string;
  kind?: string;
  exchangeId?: string;
  notes?: string;
}
interface ClarifyLogRow {
  ts?: string;
  kind?: string;
  id?: string;
  notes?: string;
}

/**
 * Generic helper: given recent log rows tagged by kind, compute the error
 * rate and return a halved cap if too many errors recently.
 */
function effectiveCapWithErrorCooldown(
  rows: Array<{ kind?: string; ts?: string }>,
  okKinds: string[],
  errorKinds: string[],
  fullCap: number,
): { cap: number; reason: string } {
  // Sort newest first, take the most-recent COOLDOWN_LOOKBACK that count
  const considered = [...rows]
    .filter((r) => r.kind && (okKinds.includes(r.kind) || errorKinds.includes(r.kind)))
    .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())
    .slice(0, COOLDOWN_LOOKBACK);
  if (considered.length < COOLDOWN_LOOKBACK) {
    return { cap: fullCap, reason: `lookback insufficient (${considered.length}/${COOLDOWN_LOOKBACK})` };
  }
  const errors = considered.filter((r) => errorKinds.includes(r.kind ?? "")).length;
  const errRate = errors / considered.length;
  if (errRate >= ERROR_RATE_FLOOR) {
    return {
      cap: Math.max(1, Math.floor(fullCap / 2)),
      reason: `error rate ${(errRate * 100).toFixed(0)}% ≥ ${ERROR_RATE_FLOOR * 100}% floor`,
    };
  }
  return { cap: fullCap, reason: `error rate ${(errRate * 100).toFixed(0)}% < floor` };
}

export function effectiveTeachingCap(): { cap: number; reason: string } {
  return effectiveCapWithErrorCooldown(
    readJsonl<TeachingLogRow>(TEACHING_LESSON_LOG),
    ["delivered", "accepted"],
    ["error"],
    DAILY_LESSON_CAP,
  );
}

export function effectiveClarifyCap(): { cap: number; reason: string } {
  return effectiveCapWithErrorCooldown(
    readJsonl<ClarifyLogRow>(CLARIFY_LOG),
    ["offer"],
    ["offer-error"],
    DAILY_OFFER_CAP,
  );
}

// ─── Aggregate summary for dashboard ─────────────────────────────────────

export interface QuotaSummary {
  verify: {
    sharedCount: number;
    sharedCap: number;
    limitHit: boolean;
    remaining: number;
  };
  autoWrite: {
    costToday: number;
    cap: number;
    remaining: number;
  };
  bounty: {
    effectiveCap: number;
    cooldownReason: string;
  };
  teaching: {
    effectiveCap: number;
    cooldownReason: string;
  };
  clarify: {
    effectiveCap: number;
    cooldownReason: string;
  };
}

export function quotaSummary(): QuotaSummary {
  const v = verifySharedCount();
  const c = autoWriteCostToday();
  const bounty = effectiveBountyAutoApplyCap();
  const teaching = effectiveTeachingCap();
  const clarify = effectiveClarifyCap();
  return {
    verify: {
      sharedCount: v,
      sharedCap: VERIFY_SHARED_CAP,
      limitHit: verifyLimitHitToday(),
      remaining: Math.max(0, VERIFY_SHARED_CAP - v),
    },
    autoWrite: {
      costToday: c,
      cap: AUTO_WRITE_DAILY_COST_CAP,
      remaining: Math.max(0, AUTO_WRITE_DAILY_COST_CAP - c),
    },
    bounty: {
      effectiveCap: bounty.cap,
      cooldownReason: bounty.reason,
    },
    teaching: {
      effectiveCap: teaching.cap,
      cooldownReason: teaching.reason,
    },
    clarify: {
      effectiveCap: clarify.cap,
      cooldownReason: clarify.reason,
    },
  };
}

/** Detect "this is a verify-cap 429" from the gateway error string. The real
 *  gateway wording is "Maximum N verification challenge per 24-hour epoch"
 *  (mirrors the mining regular-cap message); the older forms are kept. */
export function isVerifyCapError(msg: string): boolean {
  return /(verifications?.*per 24-hour|verification challenge per 24-hour|Maximum \d+ verification|crowd scores? per 24-hour|shared budget)/i.test(msg);
}
