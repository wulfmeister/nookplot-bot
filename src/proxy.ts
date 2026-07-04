import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.PROXY_PORT ?? 18790);
const VENICE_BASE = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";
const VENICE_KEY = process.env.VENICE_API_KEY;
const DEFAULT_MODEL = process.env.NOOKPLOT_AGENT_API_MODEL ?? "grok-4-3";

// Describe YOUR agent's stake/boost position in BOT_STRATEGY_POSITION — it
// steers the daemon's earning priorities. The default assumes a fresh
// unstaked agent: mining payouts scale with stake tier (Tier 1 = 9M NOOK),
// so until staked, the tracks that pay from day one come first.
const POSITION_NOTE =
  process.env.BOT_STRATEGY_POSITION ??
  "Current position: no NOOK stake yet. Mining accrues reputation but pays little before a Tier 1 stake (9M NOOK) — prioritize verifications, knowledge publishing, and bounties, and treat mining as reputation-building until staked.";

const STRATEGY_PROMPT = [
  "You are nookplot-bot, an autonomous Nookplot agent.",
  POSITION_NOTE,
  "Earning priority:",
  "  1. Mining challenges — solve when the epoch quota is open; prefer domains with authorship progress.",
  "  2. Verifications — prioritize near-quorum reasoning traces and score from the full trace, not summaries.",
  "  3. Publish specific knowledge/learnings that other agents can cite.",
  "  4. Bounty applications — high-fit and low-competition only; avoid crowded generic bounties.",
  "Decision rules:",
  "  - Prefer concrete, defensible answers over speculation.",
  "  - Always cite sources for factual claims.",
  "  - Keep messages concise and useful — no flattery, no filler.",
].join("\n");

function injectStrategy(parsed: Record<string, unknown>): void {
  const msgs = (parsed.messages as Array<{ role: string; content: string }>) ?? [];
  const hasStrategy = msgs.some((m) => m.role === "system" && m.content?.includes("nookplot-bot"));
  if (!hasStrategy) {
    parsed.messages = [{ role: "system", content: STRATEGY_PROMPT }, ...msgs];
  }
}

if (!VENICE_KEY || /replace_me|your[_-]?key/i.test(VENICE_KEY)) {
  console.error("✗ VENICE_API_KEY missing or still a placeholder — get a key at https://venice.ai (Settings → API)");
  process.exit(1);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isPingPayload(body: string): boolean {
  try {
    const obj = JSON.parse(body);
    return obj?.message === "ping" || (!obj?.messages && !obj?.model);
  } catch {
    return true;
  }
}

function reply(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/" || url === "/health")) {
    return reply(res, 200, { status: "ok", upstream: VENICE_BASE, model: DEFAULT_MODEL });
  }

  if (method !== "POST") {
    return reply(res, 405, { error: "method not allowed" });
  }

  const body = await readBody(req);

  if (isPingPayload(body)) {
    console.log(`[proxy] ping`);
    return reply(res, 200, { ok: true, message: "pong", model: DEFAULT_MODEL });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return reply(res, 400, { error: "invalid json" });
  }

  if (!parsed.model || parsed.model === "openclaw") parsed.model = DEFAULT_MODEL;
  injectStrategy(parsed);

  const target = `${VENICE_BASE}/chat/completions`;
  const started = Date.now();
  console.log(`[proxy] → ${target}  model=${parsed.model}  msgs=${(parsed.messages as unknown[])?.length ?? 0}`);

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VENICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed),
    });
    const data = await upstream.text();
    const ms = Date.now() - started;
    console.log(`[proxy] ← ${upstream.status} (${ms}ms)`);
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(data);
  } catch (err) {
    console.error("[proxy] upstream error:", err);
    reply(res, 502, { error: "upstream failure", detail: String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✓ Venice proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  → Forwarding to ${VENICE_BASE}/chat/completions`);
  console.log(`  → Default model: ${DEFAULT_MODEL}`);
});

const shutdown = () => {
  console.log("\n→ proxy shutting down");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
