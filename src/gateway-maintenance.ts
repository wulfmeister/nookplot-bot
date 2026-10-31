/**
 * Riding out a Nookplot maintenance pause (2026-10-31).
 *
 * Since ~2026-10-22 17:00Z every gateway request has returned
 *   503 {"error":"maintenance","message":"Nookplot is paused while it is
 *   rebuilt. On-chain assets are unaffected; see https://nookplot.com"}
 * The connect loop treated that like any outage: 30 attempts (~25 min), then
 * process.exit(1), and launchd started it again — 457 launches in 9 days,
 * each one re-arming the boot wake gate, with nothing done in between.
 *
 * During a maintenance pause the daemon now waits in-process: one check every
 * BOT_MAINTENANCE_POLL_MIN minutes (default 10), a log line per hour, a state
 * file the dashboard reads, and an automatic resume when the gateway answers.
 * On return it logs the gateway version against the last one seen, so the
 * rebuilt API can be checked without holding the bot back.
 *
 * Other connect failures (DNS, network, 5xx without the maintenance body)
 * keep the old 30-attempt limit.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOOK_DIR } from "./util.js";

export const MAINTENANCE_STATE_FILE = join(NOOK_DIR, "gateway-maintenance.json");
export const GATEWAY_MANIFEST_FILE = join(NOOK_DIR, "gateway-manifest.json");

/** Pure: is this error the gateway's maintenance-pause reply? */
export function isMaintenanceError(text: string | null | undefined): boolean {
  if (!text) return false;
  return /paused while it is rebuilt/i.test(text) || /"error"\s*:\s*"maintenance"/i.test(text) || /\b503\b[^]*\bmaintenance\b/i.test(text);
}

export function maintenancePollMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BOT_MAINTENANCE_POLL_MIN);
  return (Number.isFinite(n) && n >= 1 ? n : 10) * 60_000;
}

export interface MaintenanceState {
  state: "maintenance" | "up";
  /** First time the pause was seen (kept across restarts). */
  since: string | null;
  lastCheck: string;
  message?: string;
  backAt?: string;
}

export function readMaintenanceState(path = MAINTENANCE_STATE_FILE): MaintenanceState | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as MaintenanceState;
  } catch {
    return null;
  }
}

/** Pure: the next state after one check. `prev` keeps the pause's start across restarts. */
export function nextMaintenanceState(prev: MaintenanceState | null, inMaintenance: boolean, nowIso: string, message?: string): MaintenanceState {
  if (inMaintenance) {
    const since = prev?.state === "maintenance" && prev.since ? prev.since : nowIso;
    return { state: "maintenance", since, lastCheck: nowIso, message };
  }
  return { state: "up", since: prev?.since ?? null, lastCheck: nowIso, backAt: prev?.state === "maintenance" ? nowIso : prev?.backAt };
}

export function writeMaintenanceState(s: MaintenanceState, path = MAINTENANCE_STATE_FILE): void {
  try {
    writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  } catch {
    /* never let a status file stop the daemon */
  }
}

export interface ManifestSnapshot { version: string | null; savedAt: string; note?: string }

export function readManifestSnapshot(path = GATEWAY_MANIFEST_FILE): ManifestSnapshot | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ManifestSnapshot) : null;
  } catch {
    return null;
  }
}

/** Pure: one log line comparing the gateway version before and after a pause. */
export function describeVersionChange(prev: ManifestSnapshot | null, nextVersion: string | null): string {
  const before = prev?.version ?? "unknown";
  const after = nextVersion ?? "unknown";
  return before === after
    ? `gateway version unchanged (${after})`
    : `gateway version changed: ${before} → ${after} — check the API before trusting every loop`;
}

export function saveManifestSnapshot(version: string | null, nowIso: string, path = GATEWAY_MANIFEST_FILE): void {
  try {
    writeFileSync(path, JSON.stringify({ version, savedAt: nowIso } satisfies ManifestSnapshot, null, 2) + "\n");
  } catch {
    /* status only */
  }
}
