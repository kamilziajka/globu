import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DOCS_DIRNAME, INDEX_FILENAME, LOG_FILENAME, OKF_VERSION, VERSION } from "./constants.js";
import { type Frontmatter, parseFrontmatter, stringifyFrontmatter, textOf } from "./frontmatter.js";
import { upsertAuthoringGuide } from "./guide.js";
import { DEFAULT_LOG_BODY } from "./log.js";
import { childBase, readBaseIndex } from "./scan.js";
import { type BaseValidation, validateBase } from "./validate.js";

export type SetupOptions = { name?: string; description?: string; dir?: string };
export type SetupSummary = {
  docsDir: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  validation: BaseValidation;
};

function defaultIndexBody(name: string): string {
  return `# ${name} knowledge base\n\nThis directory is an OKF-formatted knowledge base.\n\n## Contents\n\n* [Update log](./${LOG_FILENAME}) - chronological history of changes to this base\n`;
}

function writeIfChanged(filePath: string, next: string, summary: SetupSummary): void {
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (previous === next) {
    summary.unchanged.push(filePath);
    return;
  }
  fs.writeFileSync(filePath, next);
  (previous === null ? summary.created : summary.updated).push(filePath);
}

function resolveDocsDir(resolved: string, dir: string | undefined): string {
  const dirname = dir ?? DEFAULT_DOCS_DIRNAME;
  if (path.basename(resolved) === dirname || readBaseIndex(resolved)) return resolved;
  const existing = dir === undefined ? childBase(resolved) : null;
  return existing ?? path.join(resolved, dirname);
}

export function setupBase(targetDir: string, { name, description, dir }: SetupOptions = {}): SetupSummary {
  const resolved = path.resolve(targetDir);
  const docsDir = resolveDocsDir(resolved, dir);
  const baseName = name ?? path.basename(path.dirname(docsDir));
  const indexPath = path.join(docsDir, INDEX_FILENAME);
  const logPath = path.join(docsDir, LOG_FILENAME);
  const summary: SetupSummary = {
    docsDir,
    created: [],
    updated: [],
    unchanged: [],
    validation: { docsDir, errors: [] }
  };

  fs.mkdirSync(docsDir, { recursive: true });

  const existing: { data: Frontmatter; body: string } = fs.existsSync(indexPath)
    ? parseFrontmatter(fs.readFileSync(indexPath, "utf8"))
    : { data: {}, body: defaultIndexBody(baseName) };
  const data = {
    ...existing.data,
    okf_version: OKF_VERSION,
    name: textOf(existing.data.name) || baseName,
    ...(description ? { description } : {}),
    knowledge_base_version: VERSION
  };
  writeIfChanged(indexPath, stringifyFrontmatter(data, upsertAuthoringGuide(existing.body)), summary);
  writeIfChanged(logPath, fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : DEFAULT_LOG_BODY, summary);

  summary.validation = validateBase(docsDir);
  return summary;
}
