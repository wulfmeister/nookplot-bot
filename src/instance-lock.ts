/**
 * Single-instance lock for the daemon.
 *
 * Why: tsx re-execs `npm start` into a worker whose argv doesn't contain
 * "tsx", so pattern-based kills routinely leave orphaned workers alive —
 * five daemons accumulated across five "restarts" (2026-07-11→16), doubling
 * Venice spend, racing the 02:00Z challenge post with pre-gate code, and
 * colliding on the gateway's shared verification cooldown. Procedure can't
 * prevent that class of failure; a boot-time lock can.
 *
 * Mechanism: a pidfile at ~/.nookplot/bot.pid holding { pid, startedAt,
 * gitRev, repo }. On boot, read it; if the recorded pid is alive AND still
 * looks like THIS bot (command line mentions src/index.ts, and — when the
 * holder's cwd is knowable — it matches the recorded repo; `src/index.ts` is
 * a generic name other projects also run under tsx), refuse to boot.
 * Otherwise take the lock. Released on shutdown; a crash leaves a stale file
 * that the next boot detects (dead pid) and replaces.
 *
 * BOT_INSTANCE_LOCK=0 skips the lock (escape hatch for unusual setups).
 * The pidfile doubles as the daemon-identity source for /api/health.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { NOOK_DIR } from "./util.js";

export const PIDFILE_PATH = join(NOOK_DIR, "bot.pid");

export interface InstanceInfo {
  pid: number;
  startedAt: string;
  gitRev: string | null;
  repo: string;
}

export interface LockDeps {
  pidfilePath: string;
  /** Is this pid a live process? (EPERM counts as alive.) */
  isAlive: (pid: number) => boolean;
  /** Full command line of the pid, or null if unknowable. */
  commandOf: (pid: number) => string | null;
  /** Working directory of the pid, or null if unknowable. */
  cwdOf: (pid: number) => string | null;
  pid: number;
  repo: string;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultCommandOf(pid: number): string | null {
  try {
    const out = execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 3000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function defaultCwdOf(pid: number): string | null {
  try {
    // lsof -Fn prints "n<path>" lines; the cwd row is the only one requested.
    const out = execSync(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null`, { encoding: "utf8", timeout: 5000 });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function defaults(overrides: Partial<LockDeps> = {}): LockDeps {
  return {
    pidfilePath: PIDFILE_PATH,
    isAlive: defaultIsAlive,
    commandOf: defaultCommandOf,
    cwdOf: defaultCwdOf,
    pid: process.pid,
    repo: process.cwd(),
    ...overrides,
  };
}

/** Short git rev of the running checkout, read without spawning git. */
export function readGitRev(repoRoot: string): string | null {
  try {
    const head = readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 7) || null; // detached HEAD
    const ref = head.slice(5).trim();
    const refPath = join(repoRoot, ".git", ref);
    if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim().slice(0, 7) || null;
    const packed = readFileSync(join(repoRoot, ".git", "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.slice(0, 7);
    }
    return null;
  } catch {
    return null;
  }
}

export function readPidfile(pidfilePath = PIDFILE_PATH): InstanceInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(pidfilePath, "utf8")) as InstanceInfo;
    return Number.isFinite(parsed?.pid) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify the current pidfile holder. Exported for the dashboard: /api/health
 * reports identity from the same logic the lock enforces.
 */
export function holderStatus(deps: Partial<LockDeps> = {}): {
  state: "none" | "stale" | "alive" | "ambiguous";
  info: InstanceInfo | null;
} {
  const d = defaults(deps);
  const info = readPidfile(d.pidfilePath);
  if (!info) return { state: "none", info: null };
  if (info.pid === d.pid) return { state: "none", info }; // our own file (re-check after acquire)
  if (!d.isAlive(info.pid)) return { state: "stale", info };
  const cmd = d.commandOf(info.pid);
  // Pid reused by an unrelated process → the recorded daemon is gone.
  if (cmd !== null && !cmd.includes("src/index.ts")) return { state: "stale", info };
  // `src/index.ts` is generic (other tsx projects match). If we can see the
  // holder's cwd and it is a DIFFERENT repo, the pid was reused by one of
  // those — stale. If cwd matches, or is unknowable, treat as the live bot.
  const cwd = d.cwdOf(info.pid);
  if (cwd !== null && info.repo && cwd !== info.repo) return { state: "stale", info };
  return { state: cmd === null && cwd === null ? "ambiguous" : "alive", info };
}

/**
 * Take the single-instance lock or throw. Call FIRST in main(), before any
 * side effects — a refused boot must not have posted, spent, or subscribed.
 */
export function acquireInstanceLock(deps: Partial<LockDeps> = {}): InstanceInfo | { skipped: true } {
  if (process.env.BOT_INSTANCE_LOCK === "0") return { skipped: true };
  const d = defaults(deps);
  const holder = holderStatus(d);
  if (holder.state === "alive" || holder.state === "ambiguous") {
    const h = holder.info!;
    throw new Error(
      `another daemon instance appears to be running (pid ${h.pid}, started ${h.startedAt}, rev ${h.gitRev ?? "?"})` +
        `${holder.state === "ambiguous" ? " — could not verify its identity, refusing conservatively" : ""}. ` +
        `Inspect with: ps -o pid,command -p ${h.pid}. If it is truly dead, remove ${d.pidfilePath} ` +
        `(or kill it: kill -TERM ${h.pid}), then restart.`,
    );
  }
  const info: InstanceInfo = {
    pid: d.pid,
    startedAt: new Date().toISOString(),
    gitRev: readGitRev(d.repo),
    repo: d.repo,
  };
  // Clear whatever is there (stale holder, corrupt JSON, our own old file) —
  // the holder check above already guaranteed no LIVE instance owns it. The
  // wx write below still catches a genuine simultaneous-boot race.
  try {
    unlinkSync(d.pidfilePath);
  } catch { /* already gone is fine */ }
  try {
    // wx = exclusive create: if two boots race past the holder check, exactly
    // one wins the write; the loser re-reads and refuses.
    writeFileSync(d.pidfilePath, JSON.stringify(info) + "\n", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const winner = readPidfile(d.pidfilePath);
    throw new Error(
      `another daemon instance won the boot race (pid ${winner?.pid ?? "?"}) — exiting.`,
    );
  }
  return info;
}

/** Remove the pidfile IFF it is ours — never delete a legitimate holder's. */
export function releaseInstanceLock(deps: Partial<LockDeps> = {}): void {
  const d = defaults(deps);
  const info = readPidfile(d.pidfilePath);
  if (info?.pid !== d.pid) return;
  try {
    unlinkSync(d.pidfilePath);
  } catch { /* best effort */ }
}
