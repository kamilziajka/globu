import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clone, headCommit } from "./git.js";
import { looksLikeRepoUrl, sameRepo, splitFileLink } from "./giturl.js";
import {
  loadManifest,
  type Manifest,
  type ManifestImport,
  readManifestFile,
  type Shard,
  saveManifest
} from "./manifest.js";
import { manifestPath } from "./paths.js";
import { loadState, saveState } from "./state.js";

export const DEFAULT_IMPORT_FILE = ".globu/manifest.yaml";

export type ImportOptions = { locator?: string; file?: string; context?: string; apply: boolean; cwd: string };
export type ImportPlan = {
  source: string;
  file: string | null;
  ref: string | null;
  commit: string | null;
  previousCommit: string | null;
  added: string[];
  updated: string[];
  contexts: string[];
};
export type ImportResult = {
  applied: boolean;
  manifestPath: string;
  context: string | null;
  suggestedContext: string | null;
  plans: ImportPlan[];
};

type TeamManifest = { manifest: Manifest; commit: string | null };

function fetchTeamManifest(entry: ManifestImport): TeamManifest {
  const file = entry.file ?? DEFAULT_IMPORT_FILE;
  if (!looksLikeRepoUrl(entry.source)) {
    const target = fs.statSync(entry.source, { throwIfNoEntry: false })?.isDirectory()
      ? path.join(entry.source, file)
      : entry.source;
    if (!fs.existsSync(target)) throw new Error(`no manifest at ${target}`);
    return { manifest: readManifestFile(target), commit: headCommit(path.dirname(target)) };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "globu-import-"));
  try {
    try {
      clone(entry.source, tmp, true, entry.ref);
    } catch (err) {
      if (entry.ref === undefined) throw err;
      throw new Error(
        `could not clone ${entry.source} at "${entry.ref}": ${(err as Error).message}. Pass the repo URL with --file ${file} to read its default branch instead`
      );
    }
    const target = path.join(tmp, file);
    if (!fs.existsSync(target)) throw new Error(`no manifest at ${file} in ${entry.source}`);
    return { manifest: readManifestFile(target), commit: headCommit(tmp) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function shardKey(shard: Shard): string {
  return JSON.stringify([
    shard.source.repo,
    shard.format,
    shard.roots,
    shard.description,
    shard.useWhen,
    shard.access ?? null
  ]);
}

function merge(manifest: Manifest, team: TeamManifest, entry: ManifestImport, previous: ManifestImport | undefined) {
  const plan: ImportPlan = {
    source: entry.source,
    file: entry.file ?? null,
    ref: entry.ref ?? null,
    commit: team.commit,
    previousCommit: previous?.commit ?? null,
    added: [],
    updated: [],
    contexts: []
  };
  for (const shard of team.manifest.shards) {
    if (shard.source.repo === null) {
      throw new Error(`shard "${shard.id}" in ${entry.source} has no repo URL, so it cannot be imported`);
    }
    const known = manifest.shards.find((candidate) => candidate.id === shard.id);
    if (known === undefined) {
      const byRepo = manifest.shards.find((candidate) => sameRepo(candidate.source.repo, shard.source.repo));
      if (byRepo) throw new Error(`${shard.source.repo} is already registered as "${byRepo.id}", unregister it first`);
      manifest.shards.push({ ...shard });
      plan.added.push(shard.id);
    } else if (!sameRepo(known.source.repo, shard.source.repo)) {
      throw new Error(`id "${shard.id}" is taken by ${known.source.repo ?? "a local repo"}, unregister it first`);
    } else if (shardKey(known) !== shardKey(shard)) {
      Object.assign(known, shard);
      if (shard.access === undefined) delete known.access;
      plan.updated.push(shard.id);
    }
  }
  for (const [name, patterns] of Object.entries(team.manifest.contexts)) {
    manifest.contexts[name] = patterns;
    plan.contexts.push(name);
  }
  return plan;
}

function recordImport(manifest: Manifest, entry: ManifestImport, commit: string | null): void {
  const record = commit === null ? entry : { ...entry, commit };
  const index = manifest.imports.findIndex((known) => known.source === entry.source);
  if (index === -1) manifest.imports.push(record);
  else manifest.imports[index] = record;
}

function entryFor(locator: string, file: string | undefined, cwd: string): ManifestImport {
  const link = splitFileLink(locator);
  if (link !== null) {
    if (file !== undefined) throw new Error("--file cannot be combined with a link to a file inside a repo");
    return { source: link.repo, file: link.file, ref: link.ref };
  }
  const source = looksLikeRepoUrl(locator) ? locator : path.resolve(cwd, locator);
  return file === undefined ? { source } : { source, file };
}

export function importManifests(options: ImportOptions): ImportResult {
  const manifest = loadManifest();
  const state = loadState();
  let entries: ManifestImport[];
  if (options.locator === undefined) {
    if (options.file !== undefined) throw new Error("--file needs a path or a repo URL to read it from");
    if (manifest.imports.length === 0) throw new Error("nothing to import: give a path or a repo URL");
    entries = manifest.imports.map(({ commit: _commit, ...entry }) => entry);
  } else {
    entries = [entryFor(options.locator, options.file, options.cwd)];
  }

  const previous = manifest.imports.map((entry) => ({ ...entry }));
  const plans = entries.map((entry) => {
    const team = fetchTeamManifest(entry);
    const plan = merge(
      manifest,
      team,
      entry,
      previous.find((known) => known.source === entry.source)
    );
    recordImport(manifest, entry, team.commit);
    return plan;
  });
  const context = options.context ?? null;
  if (context !== null && !Object.hasOwn(manifest.contexts, context)) {
    throw new Error(`unknown context "${context}" (known: ${Object.keys(manifest.contexts).join(", ") || "none"})`);
  }
  const defined = [...new Set(plans.flatMap((plan) => plan.contexts))];
  const suggestedContext = context === null && defined.length === 1 && state.current !== defined[0] ? defined[0] : null;

  if (options.apply) {
    saveManifest(manifest);
    if (context !== null) {
      state.current = context;
      saveState(state);
    }
  }
  return { applied: options.apply, manifestPath: manifestPath(), context, suggestedContext, plans };
}
