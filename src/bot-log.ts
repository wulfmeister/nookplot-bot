/**
 * Self-logging — make the bot write its own stdout/stderr to BOT_LOG_PATH.
 *
 * Why this exists: the log was previously kept alive ONLY by the launcher
 * teeing stdout (`npm start 2>&1 | tee -a ~/.nookplot/logs/bot.log`). Launch
 * the bot any other way — a bare `tsx src/index.ts`, a restart that forgot the
 * pipe — and bot.log silently freezes. The self-observer (observe.ts) then
 * reads that frozen tail every hour and hallucinates *days-old* problems as if
 * they were live (the "skipping until <4-days-ago>" / "len=46 CID" phantom
 * reports). A bot should not depend on the operator's shell incantation to keep
 * its own log alive.
 *
 * This patches the console methods to ALSO append to BOT_LOG_PATH via an
 * append-mode stream, so the log is live no matter how the process is started.
 *
 * Opt out with BOT_LOG_TEE=1 when the launcher genuinely tees to the same file
 * (avoids duplicate lines). Default: self-log ON.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { BOT_LOG_PATH } from "./util.js";

let stream: WriteStream | null = null;
let initialized = false;

/**
 * Mirror console output to BOT_LOG_PATH. Idempotent; safe to call once at boot.
 * Never throws — a logging failure must not take down the bot.
 */
export function initBotLog(): void {
  if (initialized) return;
  initialized = true;
  if (process.env.BOT_LOG_TEE === "1") return; // launcher tees; don't double-write

  try {
    mkdirSync(dirname(BOT_LOG_PATH), { recursive: true });
    stream = createWriteStream(BOT_LOG_PATH, { flags: "a" });
    stream.on("error", () => {
      // Disk full / perms — stop mirroring rather than crash. Console still works.
      stream = null;
    });
  } catch {
    stream = null;
    return;
  }

  const mirror = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    orig(...args);
    if (stream) {
      try {
        stream.write(format(...args) + "\n");
      } catch {
        /* swallow — never let logging break a tick */
      }
    }
  };

  /* eslint-disable no-console */
  console.log = mirror(console.log.bind(console));
  console.info = mirror(console.info.bind(console));
  console.warn = mirror(console.warn.bind(console));
  console.error = mirror(console.error.bind(console));
  console.debug = mirror(console.debug.bind(console));
  /* eslint-enable no-console */

  // A boot marker so restarts are visible in the log (and so a fresh launch
  // immediately advances the file mtime the observer keys off).
  console.log(`──────── bot log session start ${new Date().toISOString()} (self-log) ────────`);
}
