/**
 * Central audit trail across ALL auto-write surfaces (and any other action
 * worth noticing). One shared JSONL — `~/.nookplot/events-audit.jsonl`.
 *
 * Existing per-module logs remain as forensic-detail records. This file is
 * for the operator who wants to `tail -f` and see *everything* the bot is
 * actually doing in real time.
 *
 * Lines are deliberately one-per-action and small — easy to grep/sort/jq.
 */
import { join } from "node:path";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

const AUDIT_LOG = join(NOOK_DIR, "events-audit.jsonl");

export type AuditSurface =
  | "mining_solve"
  | "verify"
  | "artifact_rerun"
  | "crowd_jury"
  | "bounty_apply"
  | "swarm_solve"
  | "clarification_offer"
  | "teaching_deliver"
  | "rlm_spotcheck"
  | "endorsement"
  | "vote"
  | "follow"
  | "comment"
  | "knowledge_publish"
  | "post_solve_learning"
  | "tunnel"
  | "subscription"
  | "bundle"
  | "challenge_post"
  | "intent_proposal";

export type AuditOutcome = "submitted" | "rejected" | "skipped" | "error" | "pending";

export interface AuditEvent {
  ts: string;
  surface: AuditSurface;
  outcome: AuditOutcome;
  /** Free-form short string. Recommend ≤ 120 chars. */
  notes?: string;
  /** Optional structured fields (small — don't dump big payloads here). */
  meta?: Record<string, string | number | boolean | undefined>;
}

/**
 * Record an audit event. Never throws — telemetry must never break the
 * caller's flow.
 */
export function recordAudit(
  surface: AuditSurface,
  outcome: AuditOutcome,
  notes?: string,
  meta?: AuditEvent["meta"],
): void {
  try {
    appendJsonl(AUDIT_LOG, {
      ts: new Date().toISOString(),
      surface,
      outcome,
      notes,
      meta,
    } satisfies AuditEvent);
  } catch {
    // ignore — telemetry never breaks the caller
  }
}

/** Recent N audit events, newest-first, for dashboard surfacing. */
export function recentAudit(n = 50): AuditEvent[] {
  const all = readJsonl<AuditEvent>(AUDIT_LOG);
  return all.slice(-n).reverse();
}

export interface AuditSummary {
  totalEvents: number;
  last24h: Record<string, number>;
  outcomes: Record<string, number>;
}

export function auditSummary(): AuditSummary {
  const all = readJsonl<AuditEvent>(AUDIT_LOG);
  const cutoff = Date.now() - 24 * 3600_000;
  const last24h: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  for (const e of all) {
    if (e.ts && new Date(e.ts).getTime() >= cutoff) {
      last24h[e.surface] = (last24h[e.surface] ?? 0) + 1;
    }
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
  }
  return { totalEvents: all.length, last24h, outcomes };
}
