/**
 * One-shot mining-guild auto-join on bot startup.
 *
 * Why: ~15-20% of mining challenges are guild-exclusive (tier0+ required).
 * Without a guild we permanently skip them — even though joining is free
 * and reversible. This module checks status on boot and joins the best-fit
 * guild if we're unaffiliated.
 *
 * Endpoints (REST shapes confirmed from @nookplot/mcp dist):
 *   GET  /v1/mining/my-guild/:address    — current membership
 *   GET  /v1/mining/guilds/joinable      — guilds with open slots
 *   POST /v1/mining/guild/:id/join       — body { declaredDomains: [...] }
 *
 * Skip the whole flow with BOT_AUTO_JOIN_GUILD=0.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const GUILD_LOG = join(NOOK_DIR, "guild-events.jsonl");

interface GuildStatus {
  guildId?: number;
  guildName?: string;
  tier?: number | { tier?: number; boost?: number | string };
  // The live my-guild endpoint sends tier as a string here, e.g. "tier3".
  miningTier?: string;
  boost?: number | string;
  guildBoost?: number | string;
  declaredDomains?: string[];
  memberCount?: number;
  inGuild?: boolean;
  message?: string;
}

interface JoinableGuild {
  id?: number;
  guildId?: number;
  name?: string;
  tier?: number | { tier?: number; boost?: number | string };
  boost?: number | string;
  guildBoost?: number | string;
  declaredDomains?: string[];
  domains?: string[];
  memberCount?: number;
  member_count?: number;
  patronCount?: number;
  reputationScore?: number;
  recentSolveCount?: number;
}

function defaultDomains(): string[] {
  const env = process.env.BOT_MINING_DOMAINS;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  // Derived from the bot's actual submission history (knowledge-vault/research/mining-*).
  // Broad CS coverage — guilds with overlapping declared domains are preferred.
  return [
    "machine-learning",
    "security",
    "algorithms",
    "systems",
    "distributed-systems",
    "cryptography",
  ];
}

export function tierBoost(g: JoinableGuild | GuildStatus): number {
  const t = g.tier;
  if (typeof t === "object" && t !== null) {
    const b = (t as { boost?: number | string }).boost;
    if (typeof b === "number") return b;
    if (typeof b === "string") return parseFloat(b) || 1.0;
  }
  const direct = (g as JoinableGuild).boost ?? (g as JoinableGuild).guildBoost;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string") return parseFloat(direct) || 1.0;
  return 1.0;
}

export function tierNum(g: JoinableGuild | GuildStatus): number {
  const t = g.tier;
  if (typeof t === "number") return t;
  if (typeof t === "object" && t !== null) {
    const n = (t as { tier?: number }).tier;
    if (typeof n === "number") return n;
  }
  // my-guild sends miningTier: "tier3" — reading only `tier` logged tier=0
  // for a maxed Tier-3 guild and sent us chasing phantom boost headroom.
  const mt = (g as GuildStatus).miningTier;
  if (typeof mt === "string") {
    const m = mt.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

export function members(g: JoinableGuild): number {
  return g.memberCount ?? g.member_count ?? g.patronCount ?? 0;
}

export function domainOverlap(guild: string[], mine: string[]): number {
  const ms = new Set(mine.map((d) => d.toLowerCase()));
  let n = 0;
  for (const d of guild) if (ms.has(d.toLowerCase())) n += 1;
  return n;
}

interface ScoredGuild {
  g: JoinableGuild;
  score: number;
  overlap: number;
  boost: number;
}

/**
 * Rank candidates. Hard constraint: open slots (members < 6).
 * Soft ranking:
 *   1. Higher boost first (more NOOK per solve)
 *   2. Higher domain overlap with our declared domains
 *   3. More members (more shared claims = more guild-exclusive access)
 *
 * We prefer boost over overlap because tier-1+ guilds give a 1.35-1.9x
 * multiplier on EVERY solve, not just guild-exclusive ones — that compounds
 * faster than getting slightly better challenge match.
 */
export function rank(guilds: JoinableGuild[], myDomains: string[]): ScoredGuild[] {
  return guilds
    .filter((g) => members(g) < 6)
    .map((g) => {
      const gDomains = g.declaredDomains ?? g.domains ?? [];
      const overlap = domainOverlap(gDomains, myDomains);
      const boost = tierBoost(g);
      // Composite: boost weighted at 10x because it's the dominant economic
      // factor. Overlap adds 1 per match. Member count is a tiebreaker only.
      const score = boost * 10 + overlap + members(g) * 0.05;
      return { g, score, overlap, boost };
    })
    .sort((a, b) => b.score - a.score);
}

export function guildId(g: JoinableGuild): number | null {
  return g.id ?? g.guildId ?? null;
}

function logEvent(event: string, data: Record<string, unknown>): void {
  appendJsonl(GUILD_LOG, { ts: new Date().toISOString(), event, ...data });
}

export async function ensureGuildMembership(
  runtime: RuntimeLike,
  opts: { myAddress: string | null; dryRun?: boolean } = { myAddress: null },
): Promise<number | null> {
  if (process.env.BOT_AUTO_JOIN_GUILD === "0") {
    console.log("🛡  auto-join-guild disabled (BOT_AUTO_JOIN_GUILD=0)");
    return null;
  }
  if (opts.dryRun) {
    console.log("🛡  (DRY_RUN — skipping guild auto-join)");
    return null;
  }
  if (!opts.myAddress) {
    console.log("🛡  no address yet — skipping guild auto-join");
    return null;
  }

  // 1. Check current status. If already in a guild, log + return.
  let status: GuildStatus | null = null;
  try {
    status = (await runtime.connection.request(
      "GET",
      `/v1/mining/my-guild/${encodeURIComponent(opts.myAddress)}`,
    )) as GuildStatus;
  } catch (err) {
    console.warn(`🛡  my-guild status fetch failed: ${(err as Error).message} — skipping auto-join`);
    return null;
  }

  if (status && (status.guildId || status.inGuild)) {
    const boost = tierBoost(status);
    console.log(
      `🛡  already in guild "${status.guildName ?? status.guildId}" (tier=${tierNum(status)}, boost=${boost}x) — auto-join skipped`,
    );
    logEvent("already-member", {
      guildId: status.guildId,
      guildName: status.guildName,
      tier: tierNum(status),
      boost,
    });
    return status.guildId ?? null;
  }

  // 2. Fetch joinable guilds.
  let joinable: JoinableGuild[] = [];
  try {
    const res = (await runtime.connection.request(
      "GET",
      "/v1/mining/guilds/joinable?limit=20",
    )) as { guilds?: JoinableGuild[] } | JoinableGuild[];
    joinable = Array.isArray(res) ? res : res?.guilds ?? [];
  } catch (err) {
    console.warn(`🛡  joinable-guilds fetch failed: ${(err as Error).message}`);
    logEvent("discover-failed", { error: (err as Error).message });
    return null;
  }

  if (joinable.length === 0) {
    console.log("🛡  no joinable guilds available right now");
    logEvent("no-candidates", {});
    return null;
  }

  const myDomains = defaultDomains();
  const ranked = rank(joinable, myDomains);
  if (ranked.length === 0) {
    console.log(`🛡  all ${joinable.length} guilds are full (no open slots)`);
    logEvent("all-full", { discovered: joinable.length });
    return null;
  }

  const best = ranked[0];
  const gid = guildId(best.g);
  if (gid === null) {
    console.warn(`🛡  best-fit guild has no id — skipping (${JSON.stringify(best.g).slice(0, 120)})`);
    return null;
  }

  console.log(
    `🛡  joining guild #${gid} "${best.g.name ?? "?"}" — boost=${best.boost}x, domain-overlap=${best.overlap}/${myDomains.length}, members=${members(best.g)}/6`,
  );

  // 3. Join.
  try {
    const joinRes = await runtime.connection.request(
      "POST",
      `/v1/mining/guild/${encodeURIComponent(String(gid))}/join`,
      { declaredDomains: myDomains },
    );
    console.log(`🛡  ✅ joined guild #${gid}`);
    logEvent("joined", {
      guildId: gid,
      guildName: best.g.name,
      boost: best.boost,
      overlap: best.overlap,
      declaredDomains: myDomains,
      response: joinRes,
    });
    return gid;
  } catch (err) {
    console.warn(`🛡  ✗ join failed for guild #${gid}: ${(err as Error).message}`);
    logEvent("join-failed", { guildId: gid, error: (err as Error).message });
    return null;
  }
}
