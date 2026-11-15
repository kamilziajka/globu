import fs from "node:fs";
import path from "node:path";
import { INDEX_FILENAME, RESERVED_FILENAMES } from "./constants.js";
import { fieldWarnings } from "./fields.js";
import { type Frontmatter, parseFrontmatter } from "./frontmatter.js";
import { findBases } from "./scan.js";

export type ValidationError = { file: string; message: string };
export type ValidationWarning = ValidationError;
export type BaseValidation = { docsDir: string; errors: ValidationError[]; warnings: ValidationWarning[] };
export type RepoValidation = { results: BaseValidation[]; errors: ValidationError[]; warnings: ValidationWarning[] };
export type FileCheck = { errors: string[]; warnings: string[] };

function listMarkdown(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, found);
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

export function listConcepts(docsDir: string): string[] {
  return listMarkdown(docsDir)
    .filter((filePath) => !RESERVED_FILENAMES.has(path.basename(filePath)))
    .sort();
}

function conceptCheck(data: Frontmatter, body: string, hasFrontmatter: boolean): FileCheck {
  if (!hasFrontmatter) return { errors: ["missing YAML frontmatter block"], warnings: [] };
  const warnings = fieldWarnings(data, body);
  if (typeof data.type !== "string" || data.type.trim() === "") {
    return { errors: ["missing or empty required `type` field"], warnings };
  }
  return { errors: [], warnings };
}

function indexErrors(data: Frontmatter): string[] {
  return data.okf_version ? [] : [`${INDEX_FILENAME} is missing \`okf_version\``];
}

export function checkFile(filePath: string): FileCheck {
  const isIndex = path.basename(filePath) === INDEX_FILENAME;
  try {
    const { data, body, hasFrontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    return isIndex ? { errors: indexErrors(data), warnings: [] } : conceptCheck(data, body, hasFrontmatter);
  } catch (err) {
    return { errors: [`unparseable YAML frontmatter: ${(err as Error).message}`], warnings: [] };
  }
}

export function validateBase(docsDir: string): BaseValidation {
  const indexPath = path.join(docsDir, INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) {
    return { docsDir, errors: [{ file: indexPath, message: `missing required ${INDEX_FILENAME}` }], warnings: [] };
  }
  const checks = [indexPath, ...listConcepts(docsDir)].map((file) => ({ file, ...checkFile(file) }));
  return {
    docsDir,
    errors: checks.flatMap(({ file, errors }) => errors.map((message) => ({ file, message }))),
    warnings: checks.flatMap(({ file, warnings }) => warnings.map((message) => ({ file, message })))
  };
}

export function validateRepo(rootPath: string): RepoValidation {
  const resolved = path.resolve(rootPath);
  const docsDirs = findBases(resolved).map((base) => base.docsDir);

  if (docsDirs.length === 0) {
    return { results: [], errors: [{ file: resolved, message: "no OKF bases found" }], warnings: [] };
  }
  const results = docsDirs.map(validateBase);
  return {
    results,
    errors: results.flatMap((result) => result.errors),
    warnings: results.flatMap((result) => result.warnings)
  };
}
