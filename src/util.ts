/**
 * Shared utilities — extracted to one place to avoid 10 copies of the same
 * helpers across track files. If you find yourself writing one of these,
 * import it from here instead.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory for all bot-local state. Created lazily by writes. */
export const NOOK_DIR = join(homedir(), ".nookplot");

/**
 * Canonical path to the live bot log. The launcher tees stdout here
 * (`npm start 2>&1 | tee -a ~/.nookplot/logs/bot.log`). Readers (observer,
 * dashboards) MUST use this — an earlier hardcoded "/tmp/nookplot-bot.log"
 * silently went stale (frozen tail) and then empty once macOS purged /tmp,
 * which killed the self-observer ("log=0 lines"). Override via BOT_LOG_PATH.
 */
export const BOT_LOG_PATH = process.env.BOT_LOG_PATH ?? join(NOOK_DIR, "logs", "bot.log");

/** Read a JSONL file. Returns [] if the file is missing. Skips malformed lines silently. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

/**
 * Tail-read the last N lines of a JSONL file without loading the whole thing.
 * Used by hot paths (dashboard snapshot) where we only need recent activity
 * and the file might grow into the hundreds of MB.
 *
 * Uses synchronous fs because we're already in a sync helper context and
 * the chunks we read are small. Returns parsed objects, oldest first.
 */
export function readJsonlTail<T>(path: string, maxLines: number): T[] {
  if (!existsSync(path)) return [];
  if (maxLines <= 0) return [];
  // Heuristic: pull a chunk sized to cover maxLines × avg-line-length.
  // 2KB per line is generous for our JSONL shapes. Re-read more if short.
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    let bytesToRead = Math.min(size, Math.max(2048 * maxLines, 16384));
    let parsed: T[] = [];
    while (bytesToRead <= size) {
      const start = size - bytesToRead;
      const buf = Buffer.alloc(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, start);
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
      // If we read from middle of file, drop the partial first line.
      const usable = start > 0 ? lines.slice(1) : lines;
      const last = usable.slice(-maxLines);
      parsed = [];
      for (const l of last) {
        try {
          parsed.push(JSON.parse(l) as T);
        } catch {
          // skip malformed
        }
      }
      if (parsed.length >= maxLines || bytesToRead >= size) break;
      bytesToRead = Math.min(size, bytesToRead * 2);
    }
    return parsed;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Append one JSON object as a line. Caller is responsible for the file's directory existing. */
export function appendJsonl(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract the first `{...}` JSON object from a string and return its raw text.
 * Tolerates ```json ... ``` fences, leading prose, and trailing text.
 * Returns null if no balanced braces found. Caller parses.
 */
export function extractJson(text: string): string | null {
  const cleaned = text.trim().replace(/```json|```/g, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  return cleaned.slice(first, last + 1);
}

/**
 * Like extractJson, but also parses to T. Returns null on either extract or parse failure.
 * Use this when callers don't care to distinguish "no braces" from "bad JSON".
 */
export function extractJsonObj<T>(text: string): T | null {
  const raw = extractJson(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
