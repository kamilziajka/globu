import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { INDEX_FILENAME } from "./constants.js";
import { type Frontmatter, parseFrontmatter, textOf } from "./frontmatter.js";

export type Base = { name: string; description: string; docsDir: string; path: string };

const SKIPPED_DIRS = new Set(["node_modules", ".git", "target", "build", "dist", "out", ".gradle", ".venv"]);

function isRepoRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function gitFiles(rootDir: string): string[] | null {
  try {
    const out = execFileSync("git", ["-C", rootDir, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 512 * 1024 * 1024
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(rootDir: string, dir: string = rootDir, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(dir, entry.name);
      if (!SKIPPED_DIRS.has(entry.name) && !isRepoRoot(child)) walkFiles(rootDir, child, found);
    } else {
      found.push(toPosix(path.relative(rootDir, path.join(dir, entry.name))));
    }
  }
  return found;
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function readBaseIndex(docsDir: string): Frontmatter | null {
  try {
    const { data } = parseFrontmatter(fs.readFileSync(path.join(docsDir, INDEX_FILENAME), "utf8"));
    return data.okf_version ? data : null;
  } catch {
    return null;
  }
}

export function findBases(rootDir: string): Base[] {
  const root = path.resolve(rootDir);
  const files = gitFiles(root) ?? walkFiles(root);

  const bases: Base[] = [];
  for (const file of files) {
    if (path.posix.basename(file) !== INDEX_FILENAME) continue;
    const docsDir = path.dirname(path.join(root, file));
    const data = readBaseIndex(docsDir);
    if (!data) continue;
    bases.push({
      name: textOf(data.name) || path.basename(path.dirname(docsDir)),
      description: textOf(data.description),
      docsDir,
      path: toPosix(path.relative(root, docsDir)) || "."
    });
  }
  return bases.sort((a, b) => a.path.localeCompare(b.path));
}

export function childBase(dir: string): string | null {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const found = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .filter((child) => !isRepoRoot(child) && readBaseIndex(child) !== null)
    .sort();
  return found[0] ?? null;
}

export function ownerBase(filePath: string, stopAt?: string): string | null {
  const start = path.resolve(filePath);
  const limit = stopAt === undefined ? null : path.resolve(stopAt);
  let dir = fs.statSync(start, { throwIfNoEntry: false })?.isDirectory() ? start : path.dirname(start);

  while (true) {
    const base = readBaseIndex(dir) ? dir : childBase(dir);
    if (base !== null) return base;
    const parent = path.dirname(dir);
    if (dir === limit || parent === dir || isRepoRoot(dir)) return null;
    dir = parent;
  }
}
