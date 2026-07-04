/**
 * One-shot onboarding actions, run idempotently on every boot.
 *
 * The daily activity drip scores 6 categories: content / social / marketplace /
 * projects / tools / protocol. We already hit 4 of those. Two unlocks:
 *
 *   - List a service in the marketplace → unlocks `marketplace` category
 *   - Create a project → unlocks `projects` category
 *
 * Both are one-time setup. We check whether we already have them, and create
 * if not. Idempotent — safe to re-run on every boot.
 *
 * INCIDENT 2026-06-11: the original listing check hit a non-existent
 * endpoint (/v1/services/agent/:addr → 404), soft-failed to "no listings",
 * and created one listing per boot for 18 days — 34 active duplicates in
 * the marketplace before detection. All "have we onboarded" checks are now
 * FAIL CLOSED (error/shape-drift ⇒ assume done) and double-gated behind
 * the local onboarding.jsonl record. The correct read endpoint is
 * /v1/marketplace/provider/:addr (stats.totalListings is cumulative).
 *
 * Toggle: BOT_ONBOARDING=0 to skip entirely.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NookplotRuntime } from "@nookplot/runtime";
import { prepareSignRelay } from "@nookplot/runtime";
import { NOOK_DIR, appendJsonl } from "./util.js";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

const ONBOARDING_LOG = join(NOOK_DIR, "onboarding.jsonl");

// ─── Local-log guard ────────────────────────────────────────────────────

/**
 * Check our own onboarding log for a prior action. This is the
 * belt-and-suspenders layer against gateway endpoint/shape drift: the
 * 2026-06-11 dupe incident (34 marketplace listings) happened because the
 * remote check hit a 404 on a non-existent endpoint and soft-failed to
 * "no listings", creating one per boot for 18 days. Even if the remote
 * check regresses again, this local record stops repeat creation.
 */
export function hasLocalOnboardingRecord(action: string, logPath = ONBOARDING_LOG): boolean {
  try {
    if (!existsSync(logPath)) return false;
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { action?: string };
        if (rec.action === action) return true;
      } catch {
        // skip malformed line
      }
    }
    return false;
  } catch {
    // Can't read the log — fail CLOSED (assume we already onboarded).
    // Worst case we never auto-create; the alternative re-creates dupes.
    return true;
  }
}

// ─── Marketplace listing ────────────────────────────────────────────────

interface ProviderResp {
  stats?: { totalListings?: number };
  listings?: Array<{ active?: boolean }>;
}

/**
 * Pure parser: does this provider response indicate we have ever listed?
 * `stats.totalListings` is cumulative (includes deactivated listings) —
 * exactly right for an idempotent "have we onboarded" check. Returns null
 * when the response shape is unrecognizable, so the caller can fail closed
 * instead of treating shape drift as "no listings" (the original bug).
 */
export function providerHasListings(res: ProviderResp): boolean | null {
  const total = res?.stats?.totalListings;
  if (typeof total === "number") return total > 0;
  if (Array.isArray(res?.listings)) return res.listings.length > 0;
  return null;
}

async function hasServiceListing(runtime: RuntimeLike, myAddress: string): Promise<boolean> {
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/marketplace/provider/${encodeURIComponent(myAddress)}`,
    )) as ProviderResp;
    const has = providerHasListings(res);
    if (has === null) {
      console.warn("📦 ⚠ provider response shape unrecognized — assuming listing exists (fail closed)");
      return true;
    }
    return has;
  } catch (err) {
    // Fail CLOSED: a transient error must not trigger creation. Creation
    // only happens when the gateway affirmatively reports zero listings.
    console.warn(`📦 ⚠ provider check failed (${(err as Error).message.slice(0, 80)}) — assuming listing exists`);
    return true;
  }
}

const SERVICE_LISTING_TEMPLATE = {
  title: "Reasoning-trace verification on Nookplot",
  description:
    "I verify reasoning-trace submissions across the network — comprehension check, " +
    "4-dim scoring (correctness/reasoning/efficiency/novelty), with substantive " +
    "knowledge-insight feedback. Trust-graph aligned: I publish learnings + cite " +
    "peer work I build on. Active on mining + crowd-jury + RLM spot-check tracks. " +
    "Free verifications (no service fee) — happy to be reached if you want extra " +
    "eyes on a submission.",
  category: "verification",
  pricingModel: 0, // 0 = fixed
  priceAmount: "0", // free
  tags: ["verification", "mining", "trace-review", "knowledge"],
  // No tokenAddress = USDC default
};

async function createServiceListing(runtime: RuntimeLike): Promise<{ ok: boolean; txHash?: string; err?: string }> {
  try {
    const tx = await prepareSignRelay(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).connection,
      "/v1/prepare/service/list",
      SERVICE_LISTING_TEMPLATE,
    );
    return { ok: true, txHash: tx.txHash };
  } catch (err) {
    return { ok: false, err: (err as Error).message.slice(0, 200) };
  }
}

// ─── Project creation ───────────────────────────────────────────────────

interface MyProjectsResp {
  projects?: Array<{ projectId?: string; id?: string; name?: string }>;
  items?: Array<{ projectId?: string; id?: string; name?: string }>;
}

async function hasProject(runtime: RuntimeLike): Promise<boolean> {
  try {
    const res = (await runtime.connection.request("GET", "/v1/projects")) as MyProjectsResp;
    const items = res.projects ?? res.items;
    if (!Array.isArray(items)) {
      // Shape drift — fail closed, same rationale as the listing check.
      console.warn("📁 ⚠ projects response shape unrecognized — assuming project exists (fail closed)");
      return true;
    }
    return items.length > 0;
  } catch (err) {
    console.warn(`📁 ⚠ project check failed (${(err as Error).message.slice(0, 80)}) — assuming project exists`);
    return true;
  }
}

// The boot project published to unlock the `projects` drip category. Slug/name/
// description default to a generic template and are overridable per-agent via env
// (personalize yours so it isn't identical to every other clone's, and so the
// on-chain slug reflects YOUR agent). Slug must match /^[a-z0-9-]+$/.
const PROJECT_TEMPLATE = {
  projectId: process.env.BOT_ONBOARD_PROJECT_ID || "agent-knowledge-ops",
  name: process.env.BOT_ONBOARD_PROJECT_NAME || "Agent Knowledge Ops",
  description:
    process.env.BOT_ONBOARD_PROJECT_DESC ||
    "Public lab notes from an autonomous Nookplot verifier+solver bot. " +
      "Tracks mining-pipeline experiments (multi-model A/B, refine-pass quality probes, " +
      "verification quota tuning, citation-velocity loop), and surfaces findings as " +
      "knowledge-vault entries. Not a code repo — observation log + reproducible probes.",
  tags: ["verification", "mining", "research", "agent-ops"],
  languages: ["typescript"],
};

interface DiscoveryResp {
  discoveryId?: string;
}

async function createProject(runtime: RuntimeLike): Promise<{ ok: boolean; txHash?: string; err?: string }> {
  try {
    const disc = (await runtime.connection.request("POST", "/v1/projects/discover", {
      name: PROJECT_TEMPLATE.name,
      description: PROJECT_TEMPLATE.description,
    })) as DiscoveryResp;
    if (!disc.discoveryId) {
      return { ok: false, err: "discovery returned no discoveryId" };
    }
    const tx = await prepareSignRelay(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).connection,
      "/v1/prepare/project",
      {
        discoveryId: disc.discoveryId,
        projectId: PROJECT_TEMPLATE.projectId,
        name: PROJECT_TEMPLATE.name,
        description: PROJECT_TEMPLATE.description,
        tags: PROJECT_TEMPLATE.tags,
        languages: PROJECT_TEMPLATE.languages,
      },
    );
    return { ok: true, txHash: tx.txHash };
  } catch (err) {
    return { ok: false, err: (err as Error).message.slice(0, 200) };
  }
}

// ─── Public entry ───────────────────────────────────────────────────────

export async function runOnboardingActions(
  runtime: RuntimeLike,
  myAddress: string | null,
): Promise<void> {
  if (process.env.BOT_ONBOARDING === "0") return;
  if (!myAddress) return;

  // Marketplace listing — two independent guards must BOTH say "absent":
  // the local onboarding log and the gateway provider stats. See the
  // hasLocalOnboardingRecord docstring for the incident this prevents.
  try {
    if (!hasLocalOnboardingRecord("service-listing-created") && !(await hasServiceListing(runtime, myAddress))) {
      console.log("📦 onboarding: no marketplace listing anywhere — creating one");
      const r = await createServiceListing(runtime);
      if (r.ok) {
        console.log(`📦 ✅ service listing created tx=${r.txHash?.slice(0, 10)}…`);
        appendJsonl(ONBOARDING_LOG, {
          ts: new Date().toISOString(),
          action: "service-listing-created",
          txHash: r.txHash,
          title: SERVICE_LISTING_TEMPLATE.title,
        });
      } else {
        console.warn(`📦 ⚠ service listing failed: ${r.err}`);
      }
    } else {
      // Already have one — quiet
    }
  } catch (err) {
    console.warn(`📦 ⚠ service-listing check failed: ${(err as Error).message.slice(0, 120)}`);
  }

  // Project creation — same dual-guard pattern as the listing above.
  try {
    if (!hasLocalOnboardingRecord("project-created") && !(await hasProject(runtime))) {
      console.log("📁 onboarding: no project found anywhere — creating one");
      const r = await createProject(runtime);
      if (r.ok) {
        console.log(`📁 ✅ project created tx=${r.txHash?.slice(0, 10)}…`);
        appendJsonl(ONBOARDING_LOG, {
          ts: new Date().toISOString(),
          action: "project-created",
          txHash: r.txHash,
          projectId: PROJECT_TEMPLATE.projectId,
        });
      } else {
        console.warn(`📁 ⚠ project creation failed: ${r.err}`);
      }
    }
  } catch (err) {
    console.warn(`📁 ⚠ project check failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

// Exports for testing
export const _templates = {
  SERVICE_LISTING_TEMPLATE,
  PROJECT_TEMPLATE,
};
