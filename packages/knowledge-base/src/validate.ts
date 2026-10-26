import fs from "node:fs";
import path from "node:path";
import { INDEX_FILENAME, RESERVED_FILENAMES } from "./constants.js";
import { type Frontmatter, parseFrontmatter } from "./frontmatter.js";
import { findBases } from "./scan.js";

export type ValidationError = { file: string; message: string };
export type BaseValidation = { docsDir: string; errors: ValidationError[] };
export type RepoValidation = { results: BaseValidation[]; errors: ValidationError[] };

function listMarkdown(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, found);
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

function conceptErrors(data: Frontmatter, hasFrontmatter: boolean): string[] {
  if (!hasFrontmatter) return ["missing YAML frontmatter block"];
  if (typeof data.type !== "string" || data.type.trim() === "") return ["missing or empty required `type` field"];
  return [];
}

function indexErrors(data: Frontmatter): string[] {
  return data.okf_version ? [] : [`${INDEX_FILENAME} is missing \`okf_version\``];
}

function fileErrors(filePath: string): string[] {
  const isIndex = path.basename(filePath) === INDEX_FILENAME;
  try {
    const { data, hasFrontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    return isIndex ? indexErrors(data) : conceptErrors(data, hasFrontmatter);
  } catch (err) {
    return [`unparseable YAML frontmatter: ${(err as Error).message}`];
  }
}

export function validateBase(docsDir: string): BaseValidation {
  const indexPath = path.join(docsDir, INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) {
    return { docsDir, errors: [{ file: indexPath, message: `missing required ${INDEX_FILENAME}` }] };
  }
  const concepts = listMarkdown(docsDir)
    .filter((filePath) => !RESERVED_FILENAMES.has(path.basename(filePath)))
    .sort();
  const errors = [indexPath, ...concepts].flatMap((file) => fileErrors(file).map((message) => ({ file, message })));
  return { docsDir, errors };
}

export function validateRepo(rootPath: string): RepoValidation {
  const resolved = path.resolve(rootPath);
  const docsDirs = findBases(resolved).map((base) => base.docsDir);

  if (docsDirs.length === 0) {
    return { results: [], errors: [{ file: resolved, message: "no OKF bases found" }] };
  }
  const results = docsDirs.map(validateBase);
  return { results, errors: results.flatMap((result) => result.errors) };
}
