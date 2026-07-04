/**
 * Search subscriptions + webhook surface (push-instead-of-poll architecture).
 *
 * Two flows:
 *   1. POST /v1/search/subscriptions — server-side saved search; gateway will
 *      fire a webhook (or queue) when matches happen. Requires a webhook URL
 *      that the gateway can reach — we register it via /v1/agents/me/webhooks.
 *
 *   2. POST /v1/agents/me/webhooks — register an inbound webhook source
 *      (GitHub, Slack, generic). Gateway delivers events to our `targetUrl`.
 *
 * Both require a publicly reachable URL. Most local bots don't have one, so
 * we make the registration EXPLICIT (env-gated): set BOT_WEBHOOK_URL to a
 * tunnel address (ngrok, cloudflared, fly.io) and the bot will register on
 * boot. Without it, subscription/webhook flows are no-op.
 *
 * Endpoints:
 *   POST   /v1/search/subscriptions       — create
 *   POST   /v1/agents/me/webhooks         — register webhook source
 *   DELETE /v1/agents/me/webhooks/:source — remove
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl, readJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const LOG = join(NOOK_DIR, "subscriptions.jsonl");

export interface SubscriptionSpec {
  name: string;
  query: string;
  types?: string[];
  filters?: Record<string, unknown>;
}

interface LogEntry {
  ts: string;
  kind: "subscription-created" | "webhook-registered" | "webhook-removed" | "error";
  name?: string;
  source?: string;
  notes?: string;
}

function webhookUrl(): string | null {
  const url = (process.env.BOT_WEBHOOK_URL ?? "").trim();
  if (!url || !/^https?:\/\//.test(url)) return null;
  return url;
}

let tunnelProcess: ChildProcess | null = null;

/**
 * Look for `cloudflared` or `ngrok` in PATH (or common install paths). Returns
 * the binary name to invoke + which CLI flavor it is.
 */
function detectTunnelBinary(): { bin: string; flavor: "cloudflared" | "ngrok" } | null {
  const candidates = [
    { bin: "cloudflared", flavor: "cloudflared" as const, paths: ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"] },
    { bin: "ngrok", flavor: "ngrok" as const, paths: ["/opt/homebrew/bin/ngrok", "/usr/local/bin/ngrok", "/usr/bin/ngrok"] },
  ];
  for (const c of candidates) {
    // Real PATH lookup first (the docstring always promised this); the .deb
    // install from scripts/install-tunnel.sh lands in /usr/bin on Linux.
    try {
      const found = execSync(`command -v ${c.bin}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (found) return { bin: found, flavor: c.flavor };
    } catch { /* not in PATH — try known install paths */ }
    for (const p of c.paths) {
      if (existsSync(p)) return { bin: p, flavor: c.flavor };
    }
  }
  return null;
}

/**
 * Auto-spawn a tunnel + capture its public URL. Returns the URL on success
 * or null if a tunnel can't be set up. Idempotent — if BOT_WEBHOOK_URL is
 * already set we just use it.
 *
 * Why this is opt-in (BOT_TUNNEL_AUTOSPAWN=1): tunnels expose our local port
 * to the public internet, which is a security-sensitive default. The operator
 * must explicitly turn it on.
 */
export async function autoSpawnTunnel(port: number): Promise<string | null> {
  if (process.env.BOT_TUNNEL_AUTOSPAWN !== "1") return null;
  if (webhookUrl()) return webhookUrl();
  const tunnel = detectTunnelBinary();
  if (!tunnel) {
    console.log("📡 tunnel: cloudflared/ngrok not found in PATH — install one to enable webhooks");
    return null;
  }
  return new Promise((resolve) => {
    let resolved = false;
    const args =
      tunnel.flavor === "cloudflared"
        ? ["tunnel", "--url", `http://127.0.0.1:${port}`]
        : ["http", String(port), "--log=stdout"];
    tunnelProcess = spawn(tunnel.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const urlRe =
      tunnel.flavor === "cloudflared" ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i : /https:\/\/[a-z0-9-]+\.ngrok-free\.app/i;
    const onData = (buf: Buffer) => {
      const m = buf.toString().match(urlRe);
      if (m && !resolved) {
        resolved = true;
        const url = m[0];
        process.env.BOT_WEBHOOK_URL = url;
        appendJsonl(LOG, { ts: new Date().toISOString(), kind: "webhook-registered" as const, source: "auto-tunnel", notes: url });
        console.log(`📡 tunnel UP via ${tunnel.flavor}: ${url}`);
        resolve(url);
      }
    };
    tunnelProcess.stdout?.on("data", onData);
    tunnelProcess.stderr?.on("data", onData);
    tunnelProcess.on("exit", (code) => {
      if (!resolved) {
        appendJsonl(LOG, {
          ts: new Date().toISOString(),
          kind: "error" as const,
          notes: `tunnel exited code=${code} before capturing URL`,
        });
        resolve(null);
      }
    });
    // Failsafe timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        appendJsonl(LOG, { ts: new Date().toISOString(), kind: "error" as const, notes: "tunnel spawn 15s timeout" });
        resolve(null);
      }
    }, 15_000);
  });
}

/** Stop the spawned tunnel if we own it. Called from main shutdown handler. */
export function shutdownTunnel(): void {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch {}
    tunnelProcess = null;
  }
}

export async function createSubscription(
  runtime: RuntimeLike,
  spec: SubscriptionSpec,
): Promise<{ id?: string }> {
  const url = webhookUrl();
  if (!url) {
    console.log(`📡 subscription "${spec.name}" skipped — BOT_WEBHOOK_URL not set`);
    return {};
  }
  try {
    const res = (await runtime.connection.request("POST", `/v1/search/subscriptions`, {
      ...spec,
      targetUrl: url,
    })) as { id?: string };
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "subscription-created" as const, name: spec.name, notes: res.id });
    return res;
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      name: spec.name,
      notes: (err as Error).message.slice(0, 200),
    });
    return {};
  }
}

export async function registerWebhook(
  runtime: RuntimeLike,
  source: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  try {
    await runtime.connection.request("POST", `/v1/agents/me/webhooks`, { source, targetUrl: url, config });
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "webhook-registered" as const, source });
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      source,
      notes: (err as Error).message.slice(0, 200),
    });
  }
}

export async function removeWebhook(runtime: RuntimeLike, source: string): Promise<void> {
  try {
    await runtime.connection.request("DELETE", `/v1/agents/me/webhooks/${encodeURIComponent(source)}`);
    appendJsonl(LOG, { ts: new Date().toISOString(), kind: "webhook-removed" as const, source });
  } catch (err) {
    appendJsonl(LOG, {
      ts: new Date().toISOString(),
      kind: "error" as const,
      source,
      notes: (err as Error).message.slice(0, 200),
    });
  }
}

/**
 * One-time registration on boot — only fires if BOT_WEBHOOK_URL is set.
 * Subscribes to a few canned searches that match our domains and verifier
 * kinds. Subsequent boots are idempotent because the gateway dedupes by name.
 */
export async function bootstrapSubscriptions(runtime: RuntimeLike): Promise<void> {
  const url = webhookUrl();
  if (!url) {
    console.log(`📡 subscriptions: BOT_WEBHOOK_URL not set — polling mode (default)`);
    return;
  }
  const domains = (process.env.BOT_SPECIALIZE_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const specs: SubscriptionSpec[] = [
    { name: "open-mining-challenges", query: domains.join(" OR "), types: ["mining_challenge"] },
    { name: "verifiable-submissions", query: "*", types: ["verifiable_submission"] },
    { name: "open-bounties", query: domains.join(" OR "), types: ["bounty"] },
  ];
  for (const s of specs) await createSubscription(runtime, s);
}

// ─── Webhook replay fallback ────────────────────────────────────────────
//
// When BOT_WEBHOOK_URL is set, we expect the gateway to push events to it.
// But: tunnels restart, ports go down, edge load balancers drop. If we go
// long enough without a signal, treat the webhook as silently broken and
// step up our regular polling cadence to catch missed work.
//
// Used by attention-signals + bountyTick loops: when isWebhookStale() is
// true, they should poll more aggressively for missed signals.

const WEBHOOK_STALENESS_MS = Number(process.env.BOT_WEBHOOK_STALENESS_MS ?? 60 * 60_000); // 1h
let lastSignalAt: number | null = null;

/** Record that we just received a webhook-delivered signal. */
export function recordWebhookSignal(): void {
  lastSignalAt = Date.now();
}

/**
 * Returns true if a webhook is configured but no signal has arrived in
 * the staleness window. The orchestrator can react by stepping up its
 * fallback polling cadence.
 */
export function isWebhookStale(): boolean {
  if (!webhookUrl()) return false;
  if (lastSignalAt === null) {
    // No signal yet since boot. Read the log to see when the last
    // subscription-delivery line landed, if any.
    const all = readJsonl<LogEntry>(LOG);
    const recent = [...all].reverse().find((e) => e.kind === "subscription-created" || e.kind === "webhook-registered");
    if (!recent || !recent.ts) return true;
    return Date.now() - new Date(recent.ts).getTime() > WEBHOOK_STALENESS_MS;
  }
  return Date.now() - lastSignalAt > WEBHOOK_STALENESS_MS;
}

export interface SubscriptionSummary {
  active: number;
  webhookConfigured: boolean;
  webhookUrl: string | null;
  webhookStale: boolean;
  lastSignalAt: string | null;
}

export function subscriptionSummary(): SubscriptionSummary {
  const all = readJsonl<LogEntry>(LOG);
  const created = all.filter((e) => e.kind === "subscription-created").length;
  return {
    active: created,
    webhookConfigured: webhookUrl() !== null,
    webhookUrl: webhookUrl(),
    webhookStale: isWebhookStale(),
    lastSignalAt: lastSignalAt ? new Date(lastSignalAt).toISOString() : null,
  };
}
