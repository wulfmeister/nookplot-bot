import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = join(__dirname, "..", "knowledge-vault");

export type VaultCategory = "bounties" | "posts" | "agents" | "topics" | "research";

export interface NoteFrontmatter {
  id: string;
  title: string;
  type: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface VaultNote {
  path: string;
  frontmatter: NoteFrontmatter;
  body: string;
  raw: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function formatFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    } else if (typeof v === "string") {
      lines.push(`${k}: ${JSON.stringify(v).slice(1, -1)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function parseFrontmatter(raw: string): { frontmatter: NoteFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: { id: "", title: "", type: "unknown", createdAt: new Date().toISOString() },
      body: raw,
    };
  }
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      try {
        fm[key] = JSON.parse(value);
      } catch {
        fm[key] = value;
      }
    } else if (value === "true" || value === "false") {
      fm[key] = value === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      fm[key] = Number(value);
    } else {
      fm[key] = value;
    }
  }
  return {
    frontmatter: {
      id: String(fm.id ?? ""),
      title: String(fm.title ?? ""),
      type: String(fm.type ?? "unknown"),
      createdAt: String(fm.createdAt ?? new Date().toISOString()),
      ...fm,
    } as NoteFrontmatter,
    body: match[2],
  };
}

export function writeNote(
  category: VaultCategory,
  slug: string,
  frontmatter: Omit<NoteFrontmatter, "createdAt" | "updatedAt"> & Partial<Pick<NoteFrontmatter, "createdAt" | "updatedAt">>,
  body: string,
): string {
  const dir = join(VAULT_ROOT, category);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slugify(slug)}.md`);
  const now = new Date().toISOString();
  const fm = {
    ...frontmatter,
    createdAt: frontmatter.createdAt ?? (existsSync(path) ? readNote(path)?.frontmatter.createdAt ?? now : now),
    updatedAt: now,
  } as NoteFrontmatter;
  const content = formatFrontmatter(fm) + body.trim() + "\n";
  writeFileSync(path, content);
  return path;
}

export function readNote(path: string): VaultNote | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  return { path, frontmatter, body, raw };
}

export function listCategory(category: VaultCategory): VaultNote[] {
  const dir = join(VAULT_ROOT, category);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readNote(join(dir, f)))
    .filter((n): n is VaultNote => n !== null);
}

function walkVault(): VaultNote[] {
  if (!existsSync(VAULT_ROOT)) return [];
  const out: VaultNote[] = [];
  for (const cat of readdirSync(VAULT_ROOT)) {
    const sub = join(VAULT_ROOT, cat);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (!f.endsWith(".md")) continue;
      const n = readNote(join(sub, f));
      if (n) out.push(n);
    }
  }
  return out;
}

export function search(query: string, opts?: { category?: VaultCategory; max?: number }): VaultNote[] {
  const max = opts?.max ?? 10;
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return [];
  const notes = opts?.category ? listCategory(opts.category) : walkVault();
  const scored = notes.map((n) => {
    const haystack = `${n.frontmatter.title} ${(n.frontmatter.tags ?? []).join(" ")} ${n.body}`.toLowerCase();
    const score = tokens.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
    return { n, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.n);
}

export function noteSummary(n: VaultNote, maxBody = 240): string {
  const tags = (n.frontmatter.tags ?? []).join(", ");
  const body = n.body.replace(/\s+/g, " ").slice(0, maxBody);
  return `[[${basename(n.path, ".md")}]] — ${n.frontmatter.title}${tags ? ` (${tags})` : ""}\n  ${body}`;
}

export const VAULT_DIR = VAULT_ROOT;
