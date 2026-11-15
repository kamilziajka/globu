import fs from "node:fs";
import path from "node:path";
import { type Lifecycle, lifecycleOf } from "./fields.js";
import { parseFrontmatter } from "./frontmatter.js";
import { findBases } from "./scan.js";
import { listConcepts, type ValidationError } from "./validate.js";

export type StaleDoc = { file: string; reasons: Lifecycle[]; staleAfter: string | null };
export type BaseStale = { docsDir: string; docs: StaleDoc[] };
export type RepoStale = { results: BaseStale[]; errors: ValidationError[] };

function staleDoc(file: string, now: number): StaleDoc | null {
  try {
    const { data } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const reasons = lifecycleOf(data, now);
    if (reasons.length === 0) return null;
    return { file, reasons, staleAfter: reasons.includes("stale") ? String(data.stale_after) : null };
  } catch {
    return null;
  }
}

export function staleDocs(docsDir: string, now: number = Date.now()): StaleDoc[] {
  if (!fs.statSync(docsDir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return listConcepts(docsDir).flatMap((file) => staleDoc(file, now) ?? []);
}

export function staleRepo(rootPath: string, now: number = Date.now()): RepoStale {
  const resolved = path.resolve(rootPath);
  const docsDirs = findBases(resolved).map((base) => base.docsDir);
  if (docsDirs.length === 0) return { results: [], errors: [{ file: resolved, message: "no OKF bases found" }] };
  return { results: docsDirs.map((docsDir) => ({ docsDir, docs: staleDocs(docsDir, now) })), errors: [] };
}
