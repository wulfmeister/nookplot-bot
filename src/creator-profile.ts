import type { getRuntime } from "./runtime.js";

interface BountyListItem {
  id: string | number;
  status?: number;
  title?: string;
  description?: string;
  creator?: string;
  applicationCount?: number;
  submissionCount?: number;
  rewardAmount?: string;
  community?: string;
}

interface ApplicationItem {
  id: string;
  status: string;
  applicantName?: string;
  applicantAddress?: string;
  message?: string;
}

export interface CreatorStyleProfile {
  creator: string;
  pastBountyCount: number;
  approvedApplicationSamples: Array<{ bountyId: number; message: string; applicantName?: string }>;
  approvedMessageLenAvg: number;
  approvedMessageLenMedian: number;
  community: string | undefined;
  styleHint: string;
}

const profileCache = new Map<string, { profile: CreatorStyleProfile; ts: number }>();
const CACHE_MS = 30 * 60 * 1000;

export async function getCreatorStyleProfile(
  runtime: ReturnType<typeof getRuntime>,
  creator: string,
): Promise<CreatorStyleProfile | null> {
  if (!creator) return null;
  const key = creator.toLowerCase();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.profile;
  try {
    const listRes = (await runtime.connection.request(
      "GET",
      `/v1/bounties?first=100`,
    )) as { bounties?: BountyListItem[] };
    const allBounties = listRes.bounties ?? [];
    const theirs = allBounties.filter((b) => (b.creator ?? "").toLowerCase() === key);
    const samples: CreatorStyleProfile["approvedApplicationSamples"] = [];
    let lastCommunity: string | undefined;
    for (const b of theirs.slice(0, 15)) {
      lastCommunity = b.community ?? lastCommunity;
      const bid = typeof b.id === "string" ? parseInt(b.id, 10) : (b.id as number);
      if (!bid) continue;
      try {
        const apps = (await runtime.connection.request(
          "GET",
          `/v1/bounties/${bid}/applications?first=100`,
        )) as { applications?: ApplicationItem[] };
        const approved = (apps.applications ?? []).filter((a) => a.status === "approved");
        for (const a of approved) {
          if (a.message) samples.push({ bountyId: bid, message: a.message, applicantName: a.applicantName });
        }
      } catch {}
      if (samples.length >= 8) break;
    }
    const lens = samples.map((s) => s.message.length).sort((a, b) => a - b);
    const lenAvg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
    const lenMed = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    const styleHint = describeStyle(samples, lenAvg, lenMed);
    const profile: CreatorStyleProfile = {
      creator: key,
      pastBountyCount: theirs.length,
      approvedApplicationSamples: samples,
      approvedMessageLenAvg: lenAvg,
      approvedMessageLenMedian: lenMed,
      community: lastCommunity,
      styleHint,
    };
    profileCache.set(key, { profile, ts: Date.now() });
    return profile;
  } catch {
    return null;
  }
}

function describeStyle(
  samples: CreatorStyleProfile["approvedApplicationSamples"],
  avg: number,
  med: number,
): string {
  if (samples.length === 0) return "no prior approvals — generic substantive style is safe";
  const parts: string[] = [];
  if (med < 120) parts.push(`This creator approves very brief applications (median ${med} chars). Be terse and concrete.`);
  else if (med < 300) parts.push(`This creator approves medium-length applications (median ${med} chars).`);
  else parts.push(`This creator approves long, detailed applications (median ${med} chars). Be thorough.`);
  const winners = samples.slice(0, 3).map((s, i) => `\n  [winner ${i + 1}, ${s.message.length}ch] ${s.message.slice(0, 220)}`).join("");
  parts.push(`Approved-winner examples:${winners}`);
  return parts.join(" ");
}
