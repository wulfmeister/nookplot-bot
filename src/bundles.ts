/**
 * Knowledge-bundle pass — the royalty flywheel (2026-06-11, from
 * operator-playbook research).
 *
 * Top contribution-leaderboard agents all differentiate on bundles: an
 * on-chain knowledge bundle earns micro-royalties every time another agent
 * accesses its content. The gateway does the heavy lifting via
 * GET /v1/mining/bundlable-learnings/:address — it returns our solver
 * learnings + verifier insights as IPFS CIDs (these are ContentIndex-
 * registered via the post-solve/verify publish path, so they qualify)
 * plus a suggested name/description/tags.
 *
 * Cadence: at most one bundle per BOT_BUNDLE_INTERVAL_DAYS (default 7).
 * Threshold: needs ≥ BOT_BUNDLE_MIN_CIDS new CIDs (default 8 — playbook
 * says bundle at 5-10+). CIDs already bundled (tracked in bundles.jsonl)
 * are never re-bundled; the contract enforces authorship validation, and
 * duplicate-content bundles read as farm spam.
 */
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { prepareSignRelay } from "@nookplot/runtime";
import { NOOK_DIR, readJsonl, appendJsonl } from "./util.js";
import { recordAudit } from "./audit.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const BUNDLE_LOG = join(NOOK_DIR, "bundles.jsonl");
const INTERVAL_DAYS = Number(process.env.BOT_BUNDLE_INTERVAL_DAYS ?? 7);
const MIN_CIDS = Number(process.env.BOT_BUNDLE_MIN_CIDS ?? 3);
/**
 * Probed on-chain 2026-06-11: a 3-CID create succeeded; 21-CID and 10-CID
 * creates both reverted ("inner contract reverted").
 * The discriminating 8-CID daily bundle ALSO reverted (2026-06-12..15 logs:
 * repeated "inner contract reverted") — so it's a SIZE CAP, not a per-day
 * cooldown. Per the probe plan, dropped to 3 (the only size that has ever
 * landed). MIN matches so a 3-CID bundle actually fires; with a ~50-CID
 * backlog the adaptive daily throttle drains it ~3/day. Bump both via
 * BOT_BUNDLE_MAX_CIDS / BOT_BUNDLE_MIN_CIDS if the contract cap rises.
 */
const MAX_CIDS_PER_BUNDLE = Number(process.env.BOT_BUNDLE_MAX_CIDS ?? 3);

interface BundleLogEntry {
  ts: string;
  txHash?: string;
  name: string;
  cids: string[];
  domain?: string;
}

interface PublishedKnowledgeEntry {
  ts?: string;
  title?: string;
  cid?: string;
  txHash?: string;
  unsigned?: boolean;
}

/**
 * CIDs eligible for bundling = our knowledge items that went through the
 * SIGNED publish path (`/v1/memory/publish` → relay → ContentIndex).
 *
 * Why not the gateway's `bundlable-learnings` CIDs: the bundle contract
 * validates that each contributor is the REGISTERED AUTHOR of at least one
 * CID — and mining/verification insight CIDs are gateway-pinned, not
 * ContentIndex-registered to us. Production 400 on 2026-06-11:
 * "Contributor 0xa0c2… is not the registered author of any CID in this
 * bundle". Only entries with a txHash (on-chain indexing succeeded) and
 * not marked unsigned qualify. Pure — testable.
 */
export function registeredPublishedCids(entries: PublishedKnowledgeEntry[]): Array<{ cid: string; title: string }> {
  const out: Array<{ cid: string; title: string }> = [];
  for (const e of entries) {
    if (!e.cid || !e.txHash || e.unsigned === true) continue;
    out.push({ cid: e.cid, title: e.title ?? "untitled" });
  }
  return out;
}

/** True when enough days have passed since the last bundle (or none exist). */
export function bundleDue(lastBundleTs: string | undefined, nowMs: number, intervalDays = INTERVAL_DAYS): boolean {
  if (!lastBundleTs) return true;
  const last = Date.parse(lastBundleTs);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= intervalDays * 24 * 3600_000;
}

/**
 * Pick the CIDs for the next bundle: everything the gateway offers minus
 * anything we've already bundled, capped at maxPerBundle. Pure — testable.
 */
export function selectBundleCids(
  offered: string[],
  alreadyBundled: Set<string>,
  maxPerBundle = MAX_CIDS_PER_BUNDLE,
): string[] {
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const cid of offered) {
    if (!cid || alreadyBundled.has(cid) || seen.has(cid)) continue;
    seen.add(cid);
    fresh.push(cid);
    if (fresh.length >= maxPerBundle) break;
  }
  return fresh;
}

function previouslyBundledCids(): Set<string> {
  const out = new Set<string>();
  for (const e of readJsonl<BundleLogEntry>(BUNDLE_LOG)) {
    for (const cid of e.cids ?? []) out.add(cid);
  }
  return out;
}

function lastBundleTs(): string | undefined {
  const entries = readJsonl<BundleLogEntry>(BUNDLE_LOG);
  return entries.length > 0 ? entries[entries.length - 1].ts : undefined;
}

/**
 * Bundle contract tag rules: lowercase alphanumeric + hyphens, max 50 chars.
 * The gateway's own suggestedTags violate this (real example: "cs.AI" →
 * 400 "Invalid tag" on 2026-06-11), so sanitize everything: lowercase,
 * non-[a-z0-9] runs → single hyphen, trim hyphens, drop empties + dupes.
 */
export function sanitizeBundleTags(tags: string[], max = 6): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
    if (t.length > 0 && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : ["mining-knowledge"];
}

/**
 * Run one bundle tick. Internally throttled — safe to call from any daily
 * loop. Toggle with BOT_BUNDLES=0.
 */
export async function runBundleTick(runtime: RuntimeLike, myAddress: string | null): Promise<void> {
  if (process.env.BOT_BUNDLES === "0") return;
  if (!myAddress) return;

  const published = registeredPublishedCids(
    readJsonl<PublishedKnowledgeEntry>(join(NOOK_DIR, "knowledge-published.jsonl")),
  );
  const byCid = new Map(published.map((p) => [p.cid, p.title]));
  const alreadyBundled = previouslyBundledCids();
  const backlog = published.filter((p) => !alreadyBundled.has(p.cid)).length;
  // Adaptive throttle: while a backlog exists (more registered CIDs than fit
  // one bundle), bundle daily; otherwise weekly. Daily also matches the
  // suspected per-day creation cooldown on the bundle contract.
  const interval = backlog > MAX_CIDS_PER_BUNDLE ? 1 : INTERVAL_DAYS;
  if (!bundleDue(lastBundleTs(), Date.now(), interval)) return;

  const cids = selectBundleCids(published.map((p) => p.cid), alreadyBundled);
  if (cids.length < MIN_CIDS) {
    console.log(`📦 bundle tick: only ${cids.length} new registered CIDs (< ${MIN_CIDS}) — waiting for more published knowledge`);
    return;
  }

  const titles = cids.map((c) => byCid.get(c) ?? "untitled");
  const name = `Agent ops knowledge — ${cids.length} published notes`.slice(0, 120);
  const description = (
    `Knowledge bundle of ${cids.length} ContentIndex-published notes from an active mining+verification agent. ` +
    `Topics include: ${titles.slice(0, 5).join("; ")}.`
  ).slice(0, 500);
  const tags = sanitizeBundleTags(["mining-knowledge", "verification", "agent-ops", "distributed-systems"]);

  try {
    const tx = await prepareSignRelay(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).connection,
      "/v1/prepare/bundle",
      { name, description, cids, tags },
    );
    console.log(`📦 ✅ knowledge bundle created: "${name}" (${cids.length} CIDs) tx=${tx.txHash?.slice(0, 10)}…`);
    appendJsonl(BUNDLE_LOG, {
      ts: new Date().toISOString(),
      txHash: tx.txHash,
      name,
      cids,
    } satisfies BundleLogEntry);
    recordAudit("bundle", "submitted", name, { cidCount: cids.length });
  } catch (err) {
    console.warn(`📦 ⚠ bundle create failed: ${(err as Error).message.slice(0, 160)}`);
  }
}
