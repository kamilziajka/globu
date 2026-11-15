import fs from "node:fs";
import path from "node:path";
import { INDEX_FILENAME, LOG_FILENAME, RESERVED_FILENAMES } from "./constants.js";
import { type Frontmatter, parseFrontmatter, textOf } from "./frontmatter.js";
import { findBases, isInside, readBaseIndex } from "./scan.js";
import { type StaleDoc, staleDocOf } from "./stale.js";
import type { ValidationError } from "./validate.js";

export type LintKind = "broken-link" | "orphan" | "index-drift" | "stale" | "deprecated-link";
export type LintWarning = { kind: LintKind; file: string; line: number | null; target: string | null; message: string };
export type BaseLint = { docsDir: string; warnings: LintWarning[] };
export type RepoLint = { results: BaseLint[]; warnings: LintWarning[]; errors: ValidationError[] };

type Link = { line: number; target: string; resolved: string | null };
type Entry = Link & { text: string };
type Doc = { file: string; description: string; lifecycle: StaleDoc | null; links: Link[]; entries: Entry[] };
type Bundle = { docsDir: string; repoRoot: string | null; now: number };

export const INDEX_DRIFT_THRESHOLD = 0.5;

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const CODE_SPAN_RE = /(`+)[^`]*?\1/g;
const INLINE_LINK_RE = /\[[^\]]*\]\(([^)]*)\)/g;
const REFERENCE_RE = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/;
const ENTRY_RE = /^\s*[*+-]\s+\[[^\]]*\]\(([^)]*)\)(.*)$/;
const ENTRY_TEXT_RE = /^\s*(?:[-:\u2013\u2014]\s*(.*))?$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function findRepoRoot(dir: string): string | null {
  let current = dir;
  while (!fs.existsSync(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function listBundle(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(path.join(full, ".git")) && readBaseIndex(full) === null) listBundle(full, found);
    } else if (entry.name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

function bodyStart(lines: string[]): number {
  if (lines[0] !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end === -1 ? 0 : end + 1;
}

function hrefOf(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) return trimmed.slice(1).split(">")[0];
  return trimmed.split(/\s/)[0];
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveTarget(bundle: Bundle, file: string, target: string): string | null {
  if (target.startsWith("//") || SCHEME_RE.test(target)) return null;
  const pathPart = decode(target.replace(/[?#].*$/, ""));
  if (pathPart === "") return null;
  const resolved = pathPart.startsWith("/")
    ? path.resolve(bundle.docsDir, pathPart.slice(1))
    : path.resolve(path.dirname(file), pathPart);
  return bundle.repoRoot === null || isInside(bundle.repoRoot, resolved) ? resolved : null;
}

function readFrontmatter(raw: string): Frontmatter {
  try {
    return parseFrontmatter(raw).data;
  } catch {
    return {};
  }
}

function readDoc(bundle: Bundle, file: string): Doc {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  const links: Link[] = [];
  const entries: Entry[] = [];
  let fence: string | null = null;
  const link = (line: number, target: string): Link => ({
    line,
    target,
    resolved: resolveTarget(bundle, file, target)
  });

  for (let index = bodyStart(lines); index < lines.length; index++) {
    const text = lines[index];
    const marker = FENCE_RE.exec(text)?.[1];
    if (fence !== null) {
      if (marker?.startsWith(fence)) fence = null;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const line = index + 1;
    const reference = REFERENCE_RE.exec(text);
    if (reference !== null && !reference[1].startsWith("^")) links.push(link(line, hrefOf(reference[2])));
    for (const match of text.replace(CODE_SPAN_RE, "").matchAll(INLINE_LINK_RE)) {
      links.push(link(line, hrefOf(match[1])));
    }
    const entry = ENTRY_RE.exec(text);
    const entryText = entry === null ? null : ENTRY_TEXT_RE.exec(entry[2]);
    if (entry !== null && entryText !== null) {
      entries.push({ ...link(line, hrefOf(entry[1])), text: (entryText[1] ?? "").trim() });
    }
  }
  const data = readFrontmatter(raw);
  const lifecycle = RESERVED_FILENAMES.has(path.basename(file)) ? null : staleDocOf(file, data, bundle.now);
  return { file, description: textOf(data.description).trim(), lifecycle, links, entries };
}

function words(text: string): Set<string> {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(found.filter((word) => word.length >= 3).map((word) => word.slice(0, 5)));
}

export function descriptionOverlap(entry: string, description: string): number {
  const entryWords = words(entry);
  if (entryWords.size === 0) return 1;
  const descriptionWords = words(description);
  const shared = [...entryWords].filter((word) => descriptionWords.has(word)).length;
  return shared / entryWords.size;
}

function isLog(doc: Doc): boolean {
  return path.basename(doc.file) === LOG_FILENAME;
}

function brokenLinks(doc: Doc): LintWarning[] {
  return doc.links
    .filter((found) => found.resolved !== null && !fs.existsSync(found.resolved))
    .map((found) => ({
      kind: "broken-link",
      file: doc.file,
      line: found.line,
      target: found.target,
      message: `${found.target} does not resolve`
    }));
}

function isLinked(file: string, linked: Set<string | null>): boolean {
  const dir = path.dirname(file);
  return linked.has(file) || (linked.has(dir) && !fs.existsSync(path.join(dir, INDEX_FILENAME)));
}

function orphans(docs: Doc[]): LintWarning[] {
  const linked = new Set(
    docs
      .filter((doc) => !isLog(doc))
      .flatMap((doc) => doc.links.filter((found) => found.resolved !== doc.file).map((found) => found.resolved))
  );
  return docs
    .filter((doc) => !RESERVED_FILENAMES.has(path.basename(doc.file)) && !isLinked(doc.file, linked))
    .map((doc) => ({
      kind: "orphan",
      file: doc.file,
      line: null,
      target: null,
      message: "no other doc or index links here"
    }));
}

function indexDrift(index: Doc, byFile: Map<string | null, Doc>): LintWarning[] {
  return index.entries.flatMap((entry): LintWarning[] => {
    const description = byFile.get(entry.resolved)?.description;
    if (!description) return [];
    const warning = { kind: "index-drift" as const, file: index.file, line: entry.line, target: entry.target };
    if (entry.text === "") return [{ ...warning, message: `entry for ${entry.target} carries no description` }];
    if (descriptionOverlap(entry.text, description) >= INDEX_DRIFT_THRESHOLD) return [];
    return [
      {
        ...warning,
        message: `entry for ${entry.target} does not match its description: "${entry.text}" against "${description}"`
      }
    ];
  });
}

function isDeprecated(doc: Doc | undefined): boolean {
  return doc?.lifecycle?.reasons.includes("deprecated") === true;
}

function stale(doc: Doc): LintWarning[] {
  const staleAfter = doc.lifecycle?.staleAfter;
  if (!staleAfter) return [];
  return [{ kind: "stale", file: doc.file, line: null, target: null, message: `past stale_after ${staleAfter}` }];
}

function deprecatedLinks(doc: Doc, byFile: Map<string | null, Doc>): LintWarning[] {
  if (RESERVED_FILENAMES.has(path.basename(doc.file)) || isDeprecated(doc)) return [];
  return doc.links
    .filter((found) => found.resolved !== doc.file && isDeprecated(byFile.get(found.resolved)))
    .map((found) => ({
      kind: "deprecated-link",
      file: doc.file,
      line: found.line,
      target: found.target,
      message: `${found.target} is deprecated`
    }));
}

function lineOf(warning: LintWarning): number {
  return warning.line ?? 0;
}

function byPosition(a: LintWarning, b: LintWarning): number {
  return a.file.localeCompare(b.file) || lineOf(a) - lineOf(b);
}

export function lintBase(docsDir: string, now: number = Date.now()): BaseLint {
  const bundle = { docsDir: path.resolve(docsDir), repoRoot: findRepoRoot(path.resolve(docsDir)), now };
  const docs = listBundle(bundle.docsDir)
    .sort()
    .map((file) => readDoc(bundle, file));
  const byFile = new Map<string | null, Doc>(docs.map((doc) => [doc.file, doc]));
  const warnings = [
    ...docs.filter((doc) => !isLog(doc)).flatMap(brokenLinks),
    ...orphans(docs),
    ...docs.filter((doc) => path.basename(doc.file) === INDEX_FILENAME).flatMap((doc) => indexDrift(doc, byFile)),
    ...docs.flatMap(stale),
    ...docs.flatMap((doc) => deprecatedLinks(doc, byFile))
  ].sort(byPosition);
  return { docsDir, warnings };
}

export function lintRepo(rootPath: string, now: number = Date.now()): RepoLint {
  const resolved = path.resolve(rootPath);
  const docsDirs = findBases(resolved).map((base) => base.docsDir);
  if (docsDirs.length === 0) {
    return { results: [], warnings: [], errors: [{ file: resolved, message: "no OKF bases found" }] };
  }
  const results = docsDirs.map((docsDir) => lintBase(docsDir, now));
  return { results, warnings: results.flatMap((result) => result.warnings), errors: [] };
}
