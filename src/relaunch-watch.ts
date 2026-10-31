/**
 * Is Nookplot coming back? (2026-10-31)
 *
 * Since 2026-10-22 17:15Z the gateway has answered every request with 503
 * "paused while it is rebuilt". The pause was prepared: about 9.5 hours
 * earlier, ownership of the contracts moved to a new wallet and
 * MiningRewardPool's root publisher was set to a brand-new key, funded and
 * never used. On 10-31 nothing else had moved: no root, no pool top-up, no
 * claims, no SDK release since 08-21.
 *
 * This reads the public places a restart would show first and keeps the first
 * time each one changed. Read-only: nothing here signs or spends.
 *
 * - the gateway stops returning the maintenance 503
 * - a new settlement root on MiningRewardPool (merkleRoot or epoch changes)
 * - nookplot.com's pause page serves a newer distribution, or its API is gone
 * - NOOK added to the reward pool
 * - the root publisher sends its first transaction, or is replaced
 * - claims move (totalClaimed rises)
 * - the gateway relayer gets gas again
 * - a new @nookplot release on npm
 * - a reply on the GitHub issue named in BOT_RELAUNCH_ISSUE (owner/repo#n)
 *
 * The baseline is the first reading. A value that couldn't be read then is
 * filled in later without counting as a change; once a sign has moved, the
 * first time it was seen is kept even if the value changes back.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Contract, FetchRequest, JsonRpcProvider, formatEther, formatUnits } from "ethers";
import { isMaintenanceError } from "./gateway-maintenance.js";
import { GATEWAY_RELAYER, MINING_REWARD_POOL, readPoolState } from "./settlement-pool.js";
import { NOOK_DIR } from "./util.js";

export const RELAUNCH_STATE_FILE = join(NOOK_DIR, "relaunch-watch.json");
export const SDK_PACKAGES = ["@nookplot/runtime", "@nookplot/cli", "@nookplot/mcp"] as const;

export interface IssueRef { owner: string; repo: string; number: number; text: string }

export interface RelaunchReading {
  /** HTTP status of GET /v1; null if unreachable. */
  gatewayStatus: number | null;
  /** true: the maintenance 503. false: answering (< 500). null: unknown (network error, other 5xx). */
  gatewayPaused: boolean | null;
  /** "pause": nookplot.com/api/stats answers with a distribution epoch. "gone": it answers, but not that. */
  siteApi: "pause" | "gone" | null;
  siteEpoch: number | null;
  rootPublisher: string | null;
  publisherNonce: number | null;
  merkleRoot: string | null;
  /** The contract's own counter; the gateway's epochNumber runs 2 ahead. */
  poolEpoch: number | null;
  poolBalanceNook: number | null;
  totalClaimedNook: number | null;
  relayerEth: number | null;
  sdk: Record<string, string | null>;
  /** The issue named in BOT_RELAUNCH_ISSUE, null when none is named. */
  issueRef: string | null;
  issue: { ref: string; comments: number; state: string } | null;
}

export interface RelaunchState {
  baselineAt: string;
  baseline: RelaunchReading;
  checkedAt: string;
  last: RelaunchReading;
  /** Sign key → first check that saw it differ from the baseline. */
  firstSeen: Record<string, string>;
}

export interface RelaunchSignalView {
  key: string;
  label: string;
  baseline: string | null;
  now: string | null;
  changed: boolean;
  firstSeen: string | null;
}

interface SignRule {
  key: string;
  label: string;
  show: (r: RelaunchReading) => string | null;
  changed: (base: RelaunchReading, now: RelaunchReading) => boolean;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nook = (n: number) => `${Math.round(n).toLocaleString("en-US")} NOOK`;
const both = <T>(a: T | null, b: T | null): boolean => a != null && b != null;

const SIGNS: SignRule[] = [
  {
    key: "gateway",
    label: "Nookplot's servers answer again",
    show: (r) => (r.gatewayPaused === true ? "paused (503)" : r.gatewayPaused === false ? `answering (HTTP ${r.gatewayStatus})` : null),
    changed: (b, n) => b.gatewayPaused === true && n.gatewayPaused === false,
  },
  {
    key: "root",
    label: "A new settlement root is on-chain",
    show: (r) => (r.merkleRoot == null ? null : `contract epoch ${r.poolEpoch}, root ${r.merkleRoot.slice(0, 10)}…`),
    changed: (b, n) => both(b.merkleRoot, n.merkleRoot) && (b.merkleRoot !== n.merkleRoot || b.poolEpoch !== n.poolEpoch),
  },
  {
    key: "site",
    label: "nookplot.com changed: a newer distribution, or the pause page is gone",
    show: (r) => (r.siteApi === "pause" ? `pause page, distribution epoch ${r.siteEpoch}` : r.siteApi === "gone" ? "the pause page's API is gone" : null),
    changed: (b, n) => (b.siteApi === "pause" && n.siteApi === "gone") || (both(b.siteEpoch, n.siteEpoch) && b.siteEpoch !== n.siteEpoch),
  },
  {
    key: "pool",
    label: "NOOK was added to the reward pool",
    show: (r) => (r.poolBalanceNook == null ? null : nook(r.poolBalanceNook)),
    changed: (b, n) => both(b.poolBalanceNook, n.poolBalanceNook) && n.poolBalanceNook! > b.poolBalanceNook! + 1,
  },
  {
    key: "publisher",
    label: "The settlement key was used or replaced",
    show: (r) => (r.rootPublisher == null ? null : `${shortAddr(r.rootPublisher)}, ${r.publisherNonce ?? "?"} transactions sent`),
    changed: (b, n) =>
      (both(b.rootPublisher, n.rootPublisher) && b.rootPublisher!.toLowerCase() !== n.rootPublisher!.toLowerCase())
      || (both(b.publisherNonce, n.publisherNonce) && n.publisherNonce! > b.publisherNonce!),
  },
  {
    key: "claims",
    label: "Agents are claiming from the pool again",
    show: (r) => (r.totalClaimedNook == null ? null : `${nook(r.totalClaimedNook)} claimed in total`),
    changed: (b, n) => both(b.totalClaimedNook, n.totalClaimedNook) && n.totalClaimedNook! > b.totalClaimedNook! + 0.5,
  },
  {
    key: "relayer",
    label: "The gas wallet for free transactions was refilled",
    show: (r) => (r.relayerEth == null ? null : `${r.relayerEth.toFixed(6)} ETH`),
    changed: (b, n) => both(b.relayerEth, n.relayerEth) && n.relayerEth! > b.relayerEth! + 0.0005,
  },
  {
    key: "sdk",
    label: "Nookplot released a new SDK version",
    show: (r) => {
      const parts = SDK_PACKAGES.filter((p) => r.sdk?.[p]).map((p) => `${p.split("/")[1]} ${r.sdk[p]}`);
      return parts.length ? parts.join(", ") : null;
    },
    changed: (b, n) => SDK_PACKAGES.some((p) => b.sdk?.[p] && n.sdk?.[p] && b.sdk[p] !== n.sdk[p]),
  },
  {
    key: "issue",
    label: "Someone replied on the GitHub issue",
    show: (r) => (r.issue == null ? null : `${r.issue.ref}: ${r.issue.comments} comment${r.issue.comments === 1 ? "" : "s"}, ${r.issue.state}`),
    changed: (b, n) => b.issue != null && n.issue != null && b.issue.ref === n.issue.ref && (n.issue.comments > b.issue.comments || n.issue.state !== b.issue.state),
  },
];

/**
 * Pure: "owner/repo#12", "owner/repo/issues/12" or the issue's GitHub URL →
 * parts; anything else → null. In .env prefer the URL: dotenv reads an
 * unquoted # as the start of a comment.
 */
export function parseIssueRef(v: string | null | undefined): IssueRef | null {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/issues\/)(\d+)\/?\s*$/.exec(v ?? "");
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), text: `${m[1]}/${m[2]}#${m[3]}` } : null;
}

/** Hourly by default; BOT_RELAUNCH_WATCH_MIN=0 turns the daemon's checks off. */
export function relaunchWatchMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOT_RELAUNCH_WATCH_MIN;
  if (raw === undefined || raw.trim() === "") return 3_600_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3_600_000;
  return n === 0 ? 0 : Math.max(5, n) * 60_000;
}

/** Pure: take baseline values that couldn't be read before from `r`; a newly named issue starts from what it shows now. */
export function fillBaseline(base: RelaunchReading, r: RelaunchReading): RelaunchReading {
  const gw = base.gatewayPaused == null;
  const site = base.siteApi == null;
  const pool = base.merkleRoot == null;
  return {
    gatewayStatus: gw ? r.gatewayStatus : base.gatewayStatus,
    gatewayPaused: gw ? r.gatewayPaused : base.gatewayPaused,
    siteApi: site ? r.siteApi : base.siteApi,
    siteEpoch: site ? r.siteEpoch : base.siteEpoch,
    rootPublisher: base.rootPublisher ?? r.rootPublisher,
    publisherNonce: base.publisherNonce ?? r.publisherNonce,
    merkleRoot: pool ? r.merkleRoot : base.merkleRoot,
    poolEpoch: pool ? r.poolEpoch : base.poolEpoch,
    poolBalanceNook: base.poolBalanceNook ?? r.poolBalanceNook,
    totalClaimedNook: base.totalClaimedNook ?? r.totalClaimedNook,
    relayerEth: base.relayerEth ?? r.relayerEth,
    sdk: Object.fromEntries(SDK_PACKAGES.map((p) => [p, base.sdk?.[p] ?? r.sdk?.[p] ?? null])),
    issueRef: r.issueRef ?? base.issueRef,
    issue: r.issue && (!base.issue || base.issue.ref !== r.issue.ref) ? r.issue : base.issue,
  };
}

/** Pure: the state after one reading. The first reading becomes the baseline. */
export function nextRelaunchState(prev: RelaunchState | null, r: RelaunchReading, nowIso: string): RelaunchState {
  if (!prev) return { baselineAt: nowIso, baseline: r, checkedAt: nowIso, last: r, firstSeen: {} };
  const baseline = fillBaseline(prev.baseline, r);
  const firstSeen = { ...prev.firstSeen };
  for (const s of SIGNS) if (!firstSeen[s.key] && s.changed(baseline, r)) firstSeen[s.key] = nowIso;
  return { baselineAt: prev.baselineAt, baseline, checkedAt: nowIso, last: r, firstSeen };
}

/** Pure: one row per sign. The issue row only shows while an issue is named. */
export function relaunchSignals(s: RelaunchState): RelaunchSignalView[] {
  return SIGNS.filter((sig) => sig.key !== "issue" || s.last.issueRef).map((sig) => ({
    key: sig.key,
    label: sig.label,
    baseline: sig.show(s.baseline),
    now: sig.show(s.last),
    changed: sig.changed(s.baseline, s.last),
    firstSeen: s.firstSeen[sig.key] ?? null,
  }));
}

/** Pure: signs that moved for the first time between two states. */
export function newlySeen(prev: RelaunchState | null, next: RelaunchState): RelaunchSignalView[] {
  return relaunchSignals(next).filter((v) => v.firstSeen && !prev?.firstSeen[v.key]);
}

export function readRelaunchState(path = RELAUNCH_STATE_FILE): RelaunchState | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RelaunchState) : null;
  } catch {
    return null;
  }
}

function writeRelaunchState(s: RelaunchState, path: string): void {
  try {
    writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  } catch {
    /* status only */
  }
}

// One provider with a static network and a 15s request timeout, so a hung
// RPC can't hold the daemon's wait loop.
let provider: JsonRpcProvider | null = null;
function rpc(): JsonRpcProvider {
  if (!provider) {
    const req = new FetchRequest(process.env.BASE_RPC_URL ?? "https://mainnet.base.org");
    req.timeout = 15_000;
    provider = new JsonRpcProvider(req, 8453, { staticNetwork: true });
  }
  return provider;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

const value = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

async function readGateway(env: NodeJS.ProcessEnv): Promise<{ status: number; paused: boolean | null }> {
  const base = env.NOOKPLOT_GATEWAY_URL ?? "https://gateway.nookplot.com";
  const res = await fetch(`${base}/v1`, {
    headers: env.NOOKPLOT_API_KEY ? { Authorization: `Bearer ${env.NOOKPLOT_API_KEY}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text().catch(() => "");
  if (res.status === 503 && isMaintenanceError(body)) return { status: res.status, paused: true };
  return { status: res.status, paused: res.status < 500 ? false : null };
}

async function readSite(env: NodeJS.ProcessEnv): Promise<{ api: "pause" | "gone" | null; epoch: number | null }> {
  const base = env.NOOKPLOT_SITE_URL ?? "https://nookplot.com";
  const res = await fetch(`${base}/api/stats`, { signal: AbortSignal.timeout(15_000) });
  if (res.status >= 500) return { api: null, epoch: null };
  const j = (await res.json().catch(() => null)) as { epoch?: unknown } | null;
  const epoch = res.ok && j && Number.isFinite(Number(j.epoch)) ? Number(j.epoch) : null;
  return epoch == null ? { api: "gone", epoch: null } : { api: "pause", epoch };
}

/** Every read is independent: one that fails leaves its fields null. */
export async function readRelaunchReading(env: NodeJS.ProcessEnv = process.env): Promise<RelaunchReading> {
  const ref = parseIssueRef(env.BOT_RELAUNCH_ISSUE);
  const p = rpc();
  const pool = new Contract(MINING_REWARD_POOL, ["function rootPublisher() view returns (address)"], p);
  const [gw, site, ps, pub, relayer, issue, ...sdk] = await Promise.allSettled([
    readGateway(env),
    readSite(env),
    readPoolState(p),
    (pool.rootPublisher() as Promise<string>).then(async (a) => ({ address: String(a), nonce: await p.getTransactionCount(a) })),
    p.getBalance(GATEWAY_RELAYER).then((b) => Number(formatEther(b))),
    ref
      ? getJson(`https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, { Accept: "application/vnd.github+json", "User-Agent": "nookplot-bot" })
          .then((j) => ({ ref: ref.text, comments: Number((j as { comments?: unknown }).comments ?? 0), state: String((j as { state?: unknown }).state ?? "unknown") }))
      : Promise.resolve(null),
    ...SDK_PACKAGES.map((pkg) => getJson(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`).then((j) => String((j as { latest?: unknown }).latest ?? "") || null)),
  ]);
  const g = value(gw), s = value(site), st = value(ps), pb = value(pub);
  return {
    gatewayStatus: g?.status ?? null,
    gatewayPaused: g ? g.paused : null,
    siteApi: s?.api ?? null,
    siteEpoch: s?.epoch ?? null,
    rootPublisher: pb?.address ?? null,
    publisherNonce: pb?.nonce ?? null,
    merkleRoot: st?.merkleRoot ?? null,
    poolEpoch: st?.epoch ?? null,
    poolBalanceNook: st ? Number(formatUnits(st.poolBalance, 18)) : null,
    totalClaimedNook: st ? Number(formatUnits(st.totalClaimed, 18)) : null,
    relayerEth: value(relayer),
    sdk: Object.fromEntries(SDK_PACKAGES.map((pkg, i) => [pkg, value(sdk[i])])),
    issueRef: ref?.text ?? null,
    issue: value(issue),
  };
}

/** Read, compare with the baseline, save. Network reads can fail; this only throws on a programming error. */
export async function runRelaunchCheck(env: NodeJS.ProcessEnv = process.env, path = RELAUNCH_STATE_FILE): Promise<{ state: RelaunchState; newly: RelaunchSignalView[]; first: boolean }> {
  const prev = readRelaunchState(path);
  const state = nextRelaunchState(prev, await readRelaunchReading(env), new Date().toISOString());
  writeRelaunchState(state, path);
  return { state, newly: newlySeen(prev, state), first: prev === null };
}
