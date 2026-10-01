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
import { jevTriageMessage, compareTriage, labelTriage, TRIAGE_ICON, REPLIED_TRIAGE, type InboxTriage } from "./jev.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "inbox-watch.jsonl");
// Jev triage verdicts, one per thread per latest message (2026-09-29). Ranking
// only — the bot never replies (docs/inbox-strategy.md).
const TRIAGE_LOG = join(NOOK_DIR, "inbox-triage.jsonl");
const TRIAGE_MAX_PER_TICK = 30;
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

  // Jev triage: rank every thread whose CURRENT latest message has no verdict
  // yet (first run backfills the existing threads; afterwards only new or
  // updated ones). Sequential and bounded; a null (Jev paused/disabled) just
  // retries next tick. The message is untrusted text — Jev returns only a
  // bounded score/choice, and nothing here acts on it except sort order.
  const triageByKey = new Map<string, InboxTriage>();
  for (const e of readJsonl<{ key?: string; triage?: InboxTriage }>(TRIAGE_LOG)) {
    // Re-label from the stored raw scores so a rule change re-ranks the backlog.
    if (e.key && e.triage) triageByKey.set(e.key, labelTriage(e.triage.priority, e.triage.category, e.triage.categoryConfidence));
  }
  let triaged = 0;
  for (const t of threads) {
    if (triaged >= TRIAGE_MAX_PER_TICK) break;
    const key = threadKey(t);
    const text = String(t.lastMessage ?? "").trim();
    // Our own outbound message: fixed "replied" state, no Jev call.
    if (t.direction === "sent") continue;
    if (triageByKey.has(key) || !text) continue;
    const triage = await jevTriageMessage({ from: t.otherName ?? t.otherAddress, messageType: t.messageType, text });
    if (!triage) break; // Jev paused/disabled/failing — stop, try next tick
    triageByKey.set(key, triage);
    triaged++;
    appendJsonl(TRIAGE_LOG, { ts: new Date().toISOString(), key, threadId: t.id ?? t.threadId, from: t.otherName ?? t.otherAddress, triage });
  }
  const triageOf = (t: InboxThread) => (t.direction === "sent" ? REPLIED_TRIAGE : triageByKey.get(threadKey(t)) ?? null);

  // Snapshot for the dashboard (always overwrite with the current view).
  const snapshot = {
    ts: new Date().toISOString(),
    unread,
    threadCount: threads.length,
    threads: threads
      .slice()
      .sort((a, b) => compareTriage(triageOf(a), triageOf(b)) || (b.unreadCount ?? 0) - (a.unreadCount ?? 0))
      .map((t) => ({
        triage: triageOf(t),
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
  const labels: Record<string, number> = {};
  const freshThreads = threads.filter((t) => !seen.has(threadKey(t))).sort((a, b) => compareTriage(triageOf(a), triageOf(b)));
  for (const t of freshThreads) {
    const key = threadKey(t);
    fresh++;
    const from = t.otherName ?? t.otherAddress ?? "?";
    const body = String(t.lastMessage ?? "").replace(/\s+/g, " ").slice(0, 220);
    const tri = triageOf(t);
    if (tri) labels[tri.label] = (labels[tri.label] ?? 0) + 1;
    const tag = !tri
      ? ""
      : tri.label === "replied"
        ? `${TRIAGE_ICON.replied} replied, awaiting their reply · `
        : `${TRIAGE_ICON[tri.label]} ${tri.label} (${tri.category}, ${tri.priority.toFixed(1)}/3) `;
    console.log(
      `📬 ${tag}DM from ${from} (${(t.otherAddress ?? "").slice(0, 12)}, ${t.messageType ?? "dm"}, unread ${t.unreadCount ?? 0}): ${body}`,
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
      triage: tri ?? undefined,
    });
  }
  if (fresh > 0 || triaged > 0) {
    const mix = Object.entries(labels).map(([l, n]) => `${n} ${l}`).join(", ");
    console.log(
      `📬 inbox: ${fresh} new/updated thread(s) surfaced${mix ? ` (${mix})` : ""}, ${triaged} triaged by jev — ${threads.length} threads, ${unread} unread. ` +
        `Ranked view: ~/.nookplot/inbox-threads.json. Reply via 'nookplot inbox send' (operator decision).`,
    );
  }
}
