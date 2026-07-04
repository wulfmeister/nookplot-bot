/**
 * Inbox watch (rewritten 2026-06-26).
 *
 * The gateway's flat inbox LIST endpoint (`GET /v1/inbox`) returns 500
 * "Failed to list messages" — a persistent server-side bug that also breaks
 * the `nookplot inbox` CLI. The old version of this tick just re-probed that
 * broken endpoint daily and surfaced nothing, so DMs piled up unseen
 * (23 unread accumulated).
 *
 * The THREADS view (`GET /v1/inbox/threads`) DOES work, returning one entry
 * per conversation with the latest message text. This tick now reads that,
 * surfaces each new/updated thread to the log + inbox-watch.jsonl (one-shot
 * per (thread, last-message) so a new reply re-surfaces), and writes a compact
 * snapshot the dashboard reads. No auto-reply — replies are an operator
 * decision.
 *
 * Toggle off with BOT_INBOX_WATCH=0.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "inbox-watch.jsonl");
const SNAPSHOT = join(NOOK_DIR, "inbox-threads.json");

interface InboxThread {
  id?: string;
  threadId?: string;
  otherAddress?: string;
  otherName?: string;
  direction?: string;
  lastMessage?: string;
  messageType?: string;
  createdAt?: string;
  unreadCount?: number;
}

/** Stable per-surfacing key: a thread re-surfaces when its latest message changes. */
function threadKey(t: InboxThread): string {
  const id = t.id ?? t.threadId ?? t.otherAddress ?? "?";
  const tail = String(t.lastMessage ?? "").slice(0, 60);
  return `${id}|${t.createdAt ?? ""}|${tail}`;
}

export async function runInboxWatchTick(runtime: RuntimeLike): Promise<void> {
  if (process.env.BOT_INBOX_WATCH === "0") return;

  let unread = -1;
  try {
    const u = (await runtime.connection.request("GET", "/v1/inbox/unread")) as { unreadCount?: number };
    unread = u.unreadCount ?? -1;
  } catch {
    // unread endpoint down too — keep going; threads may still work.
  }

  let threads: InboxThread[] = [];
  try {
    const res = (await runtime.connection.request("GET", "/v1/inbox/threads?limit=30")) as {
      threads?: InboxThread[];
      items?: InboxThread[];
    };
    threads = res.threads ?? res.items ?? [];
  } catch (err) {
    const msg = (err as Error).message;
    // The flat list 500s; the threads view normally works. If even this fails,
    // report the count we have and move on (no tight retry on a 5xx endpoint).
    console.warn(`📬 inbox threads fetch failed (${unread >= 0 ? `${unread} unread` : "count unknown"}): ${msg.slice(0, 120)}`);
    return;
  }

  // Snapshot for the dashboard (always overwrite with the current view).
  const snapshot = {
    ts: new Date().toISOString(),
    unread,
    threadCount: threads.length,
    threads: threads
      .slice()
      .sort((a, b) => (b.unreadCount ?? 0) - (a.unreadCount ?? 0))
      .map((t) => ({
        id: t.id ?? t.threadId ?? null,
        from: t.otherName ?? "(unnamed)",
        otherAddress: t.otherAddress ?? null,
        messageType: t.messageType ?? "dm",
        direction: t.direction ?? null,
        unreadCount: t.unreadCount ?? 0,
        createdAt: t.createdAt ?? null,
        preview: String(t.lastMessage ?? "").replace(/\s+/g, " ").slice(0, 400),
      })),
  };
  try {
    writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
  } catch {
    /* best effort — snapshot is for the dashboard only */
  }

  // Surface new/updated threads to the log + jsonl (one-shot per last-message).
  const seen = new Set(readJsonl<{ key?: string }>(LOG).map((e) => e.key));
  let fresh = 0;
  for (const t of threads) {
    const key = threadKey(t);
    if (seen.has(key)) continue;
    fresh++;
    const from = t.otherName ?? t.otherAddress ?? "?";
    const body = String(t.lastMessage ?? "").replace(/\s+/g, " ").slice(0, 220);
    console.log(
      `📬 DM from ${from} (${(t.otherAddress ?? "").slice(0, 12)}, ${t.messageType ?? "dm"}, unread ${t.unreadCount ?? 0}): ${body}`,
    );
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      key,
      threadId: t.id ?? t.threadId,
      from,
      otherAddress: t.otherAddress,
      messageType: t.messageType,
      unreadCount: t.unreadCount,
      preview: body,
    });
  }
  if (fresh > 0) {
    console.log(`📬 inbox: ${fresh} new/updated thread(s) surfaced — ${threads.length} threads, ${unread} unread. Reply via 'nookplot inbox send' (operator decision).`);
  }
}
