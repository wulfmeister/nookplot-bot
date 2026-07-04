import { existsSync, statSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve, relative, basename, extname } from "node:path";
import { createHash } from "node:crypto";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: tsx src/knowledge-probe.ts <folder-or-glob>");
  console.error("Examples:");
  console.error("  tsx src/knowledge-probe.ts knowledge");
  console.error("  tsx src/knowledge-probe.ts 'docs/**/*.md'");
  process.exit(1);
}

const cwd = process.cwd();
const target = resolve(cwd, arg);

if (existsSync(target) && statSync(target).isDirectory()) {
  console.log(`→ Scanning ${target} for .md and .txt files...`);
} else {
  console.log(`→ Using glob pattern: ${arg}`);
}

const pattern = existsSync(target) && statSync(target).isDirectory()
  ? `${arg.replace(/\/$/, "")}/**/*.{md,txt}`
  : arg;

const collected: string[] = [];
for await (const entry of glob(pattern, { cwd })) {
  collected.push(resolve(cwd, entry));
}

const safe = collected.filter((f) => {
  try {
    if (!statSync(f).isFile()) return false;
  } catch {
    return false;
  }
  const rel = relative(cwd, f);
  return !rel.startsWith("..") && rel.length > 0;
});

const escaped = collected.length - safe.length;
if (escaped > 0) {
  console.warn(`⚠ ${escaped} file(s) escape the project root and will be skipped by Nookplot's files adapter.`);
  console.warn(`  Move them under ${cwd} to publish them.`);
}

if (safe.length === 0) {
  console.log("✗ No publishable files found.");
  process.exit(1);
}

let totalBytes = 0;
const titleCounts: Record<string, number> = { "first-heading": 0, "frontmatter": 0, "filename": 0 };

for (const path of safe) {
  const content = readFileSync(path, "utf8").trim();
  if (!content) continue;
  totalBytes += Buffer.byteLength(content);

  const headingMatch = content.match(/^#+\s+(.+)$/m);
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const fmTitle = fmMatch?.[1].split("\n").find((l) => l.startsWith("title:"));
  const fileTitle = basename(path, extname(path)).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const title = headingMatch?.[1].trim() ?? fmTitle?.replace(/^title:\s*/, "").replace(/^["']|["']$/g, "").trim() ?? fileTitle;

  if (headingMatch) titleCounts["first-heading"]++;
  else if (fmTitle) titleCounts["frontmatter"]++;
  else titleCounts["filename"]++;

  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  const rel = relative(cwd, path);
  const sizeKb = (Buffer.byteLength(content) / 1024).toFixed(1);
  console.log(`  ${hash}  ${sizeKb.padStart(7)} KB  ${title}  (${rel})`);
}

console.log();
console.log(`Total: ${safe.length} files, ${(totalBytes / 1024).toFixed(1)} KB`);
console.log(`Title sources: first-heading=${titleCounts["first-heading"]}, frontmatter=${titleCounts["frontmatter"]}, filename=${titleCounts["filename"]}`);
const bestStrategy = Object.entries(titleCounts).sort((a, b) => b[1] - a[1])[0][0];
console.log(`Recommended titleFrom: ${bestStrategy}`);
console.log();
console.log("To publish, update nookplot.yaml knowledge.sources:");
console.log(`  sources:`);
console.log(`    - type: files`);
console.log(`      paths: ["${pattern}"]`);
console.log(`      titleFrom: ${bestStrategy}`);
console.log();
console.log("Then run:  nookplot sync --dry-run     # preview");
console.log("Then:      nookplot sync               # publish");
