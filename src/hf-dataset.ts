/**
 * Hugging Face dataset inspection — validate a public HF dataset is reachable
 * + summarize splits + columns before a `replication` or `prediction` solve.
 *
 * Endpoint: GET /v1/datasets/inspect?dataset=<hf-id>
 *
 * Returns shape:
 *   { splits: { train: {rows, columns}, test: {rows, columns} }, license, ... }
 */
import type { NookplotRuntime } from "@nookplot/runtime";

type RuntimeLike = Pick<NookplotRuntime, "connection">;

export interface HfDatasetInspection {
  datasetId: string;
  splits?: Record<string, { rows?: number; columns?: string[] }>;
  license?: string;
  description?: string;
  downloads?: number;
  reachable?: boolean;
}

const cache = new Map<string, { at: number; data: HfDatasetInspection | null }>();
const TTL_MS = 12 * 3600_000;

export async function inspectHfDataset(
  runtime: RuntimeLike,
  datasetId: string,
): Promise<HfDatasetInspection | null> {
  const hit = cache.get(datasetId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const res = (await runtime.connection.request(
      "GET",
      `/v1/datasets/inspect?dataset=${encodeURIComponent(datasetId)}`,
    )) as HfDatasetInspection;
    cache.set(datasetId, { at: Date.now(), data: res });
    return res;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120);
    if (msg.includes("404")) {
      cache.set(datasetId, { at: Date.now(), data: null });
      return null;
    }
    return null;
  }
}

/** Render a one-line summary of an HF dataset for inline use in a prompt or log. */
export function summarizeHfDataset(d: HfDatasetInspection): string {
  if (!d.reachable) return `${d.datasetId}: unreachable`;
  const splits = Object.keys(d.splits ?? {});
  const totalRows = Object.values(d.splits ?? {}).reduce((s, x) => s + (x.rows ?? 0), 0);
  return `${d.datasetId}: ${splits.join("/")} = ${totalRows} rows; cols: ${
    splits[0] ? d.splits?.[splits[0]]?.columns?.slice(0, 5).join(",") : "?"
  }`;
}

/**
 * Heuristic: extract a Hugging Face dataset ID from challenge text if present.
 * Looks for explicit "hf:org/name" or "huggingface.co/datasets/org/name" or
 * a code fence containing `load_dataset("org/name")`.
 */
export function extractHfDatasetId(text: string): string | null {
  const direct = text.match(/\bhf:([\w-]+\/[\w.-]+)/i);
  if (direct) return direct[1];
  const url = text.match(/huggingface\.co\/datasets\/([\w-]+\/[\w.-]+)/i);
  if (url) return url[1];
  const load = text.match(/load_dataset\(["']([\w-]+\/[\w.-]+)["']/i);
  if (load) return load[1];
  return null;
}
