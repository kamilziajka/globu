import fs from "node:fs";
import path from "node:path";
import { isInside } from "../../knowledge-base/src/index.js";
import { activeContextName, selectShards } from "./context.js";
import { clone, fetch, isRepo, mainCheckout, pull, remoteUrl } from "./git.js";
import { looksLikeRepoUrl, repoBasename, sameRepo } from "./giturl.js";
import { loadManifest, type Manifest, type Shard, saveManifest } from "./manifest.js";
import { clonesDir } from "./paths.js";
import { type Probe, probeDir } from "./probe.js";
import { type Access, type LocalShard, loadState, type Mode, type Owner, type State, saveState } from "./state.js";

export type ResolvedShard = Shard & { path: string | null; owner: Owner | null; mode: Mode; present: boolean };
export type Registry = { manifest: Manifest; state: State; shards: ResolvedShard[] };
export type ActiveRegistry = Registry & { context: string | null };

export type RegisterOptions = {
  locator: string;
  cwd: string;
  id?: string;
  mode?: Mode;
  dest?: string;
  description?: string;
  useWhen?: string;
};
export type RegisterResult = {
  action: "registered" | "attached";
  shard: ResolvedShard;
  portable: boolean;
  replaced: string | null;
};
export type UnregisterResult = {
  id: string;
  path: string | null;
  clone: "none" | "kept" | "removed";
  claudeListed: boolean;
};
export type ReprobeResult = {
  changed: boolean;
  applied: boolean;
  shard: ResolvedShard;
  previous: Pick<Shard, "format" | "roots">;
  probed: Probe;
};
export type ShardUpdate = { description?: string; useWhen?: string; mode?: Mode; access?: Access };
export type SyncEntry = { id: string; action: "cloned" | "pulled" | "fetched" | "error"; error?: string };

type Placement = LocalShard & { repo: string | null };

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function assertId(id: string): void {
  if (!NAME_RE.test(id)) throw new Error(`invalid shard id "${id}", pass --id with letters, digits, dots or dashes`);
}

function cloneDirFor(id: string): string {
  return path.join(clonesDir(), id);
}

function ensureManagedClone(repo: string, target: string): boolean {
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  clone(repo, target, true);
  return true;
}

function findShard(manifest: Manifest, id: string): Shard {
  const shard = manifest.shards.find((candidate) => candidate.id === id);
  if (!shard) throw new Error(`no shard registered with id "${id}"`);
  return shard;
}

function resolveShard(shard: Shard, state: State): ResolvedShard {
  const local = Object.hasOwn(state.shards, shard.id) ? state.shards[shard.id] : null;
  return {
    ...shard,
    path: local?.path ?? null,
    owner: local?.owner ?? null,
    mode: shard.access === "read" ? "read" : (local?.mode ?? "read"),
    present: local !== null && fs.existsSync(local.path)
  };
}

function placeLocal(locator: string, cwd: string, mode: Mode | undefined): Placement {
  const target = path.resolve(cwd, locator);
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`"${locator}" is neither a directory nor a repo URL`);
  }
  if (!isRepo(target)) {
    throw new Error(`${target} is not inside a git repository (git repos are the only source type so far)`);
  }
  const localPath = mainCheckout(target);
  return { repo: remoteUrl(localPath), path: localPath, owner: "user", mode: mode ?? "write" };
}

function placeRemote(repo: string, id: string, options: RegisterOptions): Placement {
  if (options.dest === undefined) {
    if (options.mode !== undefined && options.mode !== "read") {
      throw new Error("an editable shard needs --path <dir> so its clone lives where you choose");
    }
    const target = cloneDirFor(id);
    ensureManagedClone(repo, target);
    return { repo, path: target, owner: "globu", mode: "read" };
  }
  const target = path.resolve(options.cwd, options.dest);
  const occupied = fs.existsSync(target) && fs.readdirSync(target).length > 0;
  if (!occupied) {
    clone(repo, target, false);
  } else if (!isRepo(target) || !sameRepo(remoteUrl(target), repo)) {
    throw new Error(`${target} already exists and is not a clone of ${repo}`);
  }
  return { repo, path: mainCheckout(target), owner: "user", mode: options.mode ?? "write" };
}

function assertSameId(known: Shard | undefined, id: string | undefined): void {
  if (known && id !== undefined && id !== known.id) throw new Error(`this repo is already registered as "${known.id}"`);
}

export function register(options: RegisterOptions): RegisterResult {
  const { locator, id } = options;
  if (id !== undefined) assertId(id);
  const manifest = loadManifest();
  const state = loadState();

  let placement: Placement;
  let known: Shard | undefined;
  if (looksLikeRepoUrl(locator)) {
    known = manifest.shards.find((shard) => sameRepo(shard.source.repo, locator));
    assertSameId(known, id);
    if (known && options.dest === undefined && Object.hasOwn(state.shards, known.id)) {
      throw new Error(`${locator} is already registered as "${known.id}"`);
    }
    const remoteId = known?.id ?? id ?? repoBasename(locator);
    assertId(remoteId);
    placement = placeRemote(locator, remoteId, options);
  } else {
    placement = placeLocal(locator, options.cwd, options.mode);
    known = manifest.shards.find(
      (shard) => sameRepo(shard.source.repo, placement.repo) || resolveShard(shard, state).path === placement.path
    );
    assertSameId(known, id);
  }

  const shardId = known?.id ?? id ?? repoBasename(placement.repo ?? placement.path);
  assertId(shardId);
  if (!known && manifest.shards.some((shard) => shard.id === shardId)) {
    throw new Error(`a different shard is already registered with id "${shardId}", pass --id`);
  }

  let shard = known;
  if (!shard) {
    const probed = probeDir(placement.path);
    shard = {
      id: shardId,
      source: { type: "git", repo: placement.repo },
      format: probed.format,
      roots: probed.roots,
      description: options.description ?? probed.description,
      useWhen: options.useWhen ?? ""
    };
    manifest.shards.push(shard);
  }

  const replaced = replacedManagedClone(state, shardId, placement.path);
  state.shards[shardId] = { path: placement.path, mode: placement.mode, owner: placement.owner };
  saveManifest(manifest);
  saveState(state);
  return {
    action: known ? "attached" : "registered",
    shard: resolveShard(shard, state),
    portable: placement.repo !== null,
    replaced
  };
}

function isManagedClone(local: LocalShard): boolean {
  return local.owner === "globu" && isInside(clonesDir(), local.path);
}

function replacedManagedClone(state: State, id: string, newPath: string): string | null {
  const current = Object.hasOwn(state.shards, id) ? state.shards[id] : null;
  if (current === null || current.path === newPath || !isManagedClone(current) || !fs.existsSync(current.path)) {
    return null;
  }
  fs.rmSync(current.path, { recursive: true, force: true });
  return current.path;
}

export function unregister(id: string, purge: boolean): UnregisterResult {
  const manifest = loadManifest();
  const state = loadState();
  const resolved = resolveShard(findShard(manifest, id), state);
  const local = Object.hasOwn(state.shards, id) ? state.shards[id] : null;
  const claudeListed = resolved.path !== null && state.claude.directories.includes(resolved.path);

  manifest.shards = manifest.shards.filter((shard) => shard.id !== id);
  delete state.shards[id];
  saveManifest(manifest);
  saveState(state);

  const result = { id, path: resolved.path, claudeListed };
  if (local === null || !resolved.present) return { ...result, clone: "none" };
  if (!isManagedClone(local) || !purge) return { ...result, clone: "kept" };
  fs.rmSync(local.path, { recursive: true, force: true });
  return { ...result, clone: "removed" };
}

export function updateShard(id: string, update: ShardUpdate): ResolvedShard {
  const manifest = loadManifest();
  const state = loadState();
  const shard = findShard(manifest, id);

  if (update.description !== undefined) shard.description = update.description;
  if (update.useWhen !== undefined) shard.useWhen = update.useWhen;
  if (update.access === "read") shard.access = "read";
  if (update.access === "write") delete shard.access;
  if (update.mode !== undefined) {
    if (!Object.hasOwn(state.shards, id)) {
      throw new Error(`shard "${id}" has no local clone yet, run \`globu sync\` first`);
    }
    if (update.mode !== "read" && state.shards[id].owner === "globu") {
      throw new Error(
        `shard "${id}" lives in a globu-managed clone. Register its URL again with --path <dir> to edit it`
      );
    }
    state.shards[id].mode = update.mode;
  }
  saveManifest(manifest);
  saveState(state);
  return resolveShard(shard, state);
}

export function resolveAll(): Registry {
  const manifest = loadManifest();
  const state = loadState();
  return { manifest, state, shards: manifest.shards.map((shard) => resolveShard(shard, state)) };
}

export function resolveActive(): ActiveRegistry {
  const all = resolveAll();
  const context = activeContextName(all.state);
  return { ...all, context, shards: selectShards(all.shards, all.manifest, context) };
}

function syncShard(shard: ResolvedShard, state: State): SyncEntry["action"] {
  const { repo } = shard.source;
  if (shard.path === null) {
    if (repo === null) throw new Error("no repo URL in the manifest, register it from a local clone");
    const target = cloneDirFor(shard.id);
    ensureManagedClone(repo, target);
    state.shards[shard.id] = { path: target, mode: "read", owner: "globu" };
    return "cloned";
  }
  if (shard.owner === "globu") {
    if (ensureManagedClone(repo as string, shard.path)) return "cloned";
    pull(shard.path, repo);
    return "pulled";
  }
  if (!shard.present) throw new Error(`clone is missing at ${shard.path}, register it again with --path`);
  if (remoteUrl(shard.path) !== null) fetch(shard.path);
  return "fetched";
}

export function sync(): SyncEntry[] {
  const { state, shards } = resolveAll();
  const report = shards.map((shard): SyncEntry => {
    try {
      return { id: shard.id, action: syncShard(shard, state) };
    } catch (err) {
      return { id: shard.id, action: "error", error: (err as Error).message };
    }
  });
  saveState(state);
  return report;
}

export function reprobe(id: string, apply = true): ReprobeResult {
  const manifest = loadManifest();
  const state = loadState();
  const shard = findShard(manifest, id);
  const resolved = resolveShard(shard, state);
  if (resolved.path === null || !resolved.present) {
    throw new Error(`shard "${id}" has no local clone, run \`globu sync\` first`);
  }
  const probed = probeDir(resolved.path);
  const previous = { format: shard.format, roots: shard.roots };
  const changed = probed.format !== previous.format || JSON.stringify(probed.roots) !== JSON.stringify(previous.roots);
  if (apply) {
    shard.format = probed.format;
    shard.roots = probed.roots;
    saveManifest(manifest);
  }
  return { changed, applied: apply, shard: resolveShard(shard, state), previous, probed };
}

export function useContext(name: string | null): string | null {
  const manifest = loadManifest();
  const state = loadState();
  if (name !== null && !Object.hasOwn(manifest.contexts, name)) {
    throw new Error(`unknown context "${name}" (known: ${Object.keys(manifest.contexts).join(", ") || "none"})`);
  }
  state.current = name;
  saveState(state);
  return name;
}

export function setContext(name: string, patterns: string[]): Manifest["contexts"] {
  if (!NAME_RE.test(name)) throw new Error(`invalid context name "${name}"`);
  if (patterns.length === 0) throw new Error("a context needs at least one shard id or pattern");
  const manifest = loadManifest();
  manifest.contexts[name] = patterns;
  saveManifest(manifest);
  return manifest.contexts;
}

export function removeContext(name: string): Manifest["contexts"] {
  const manifest = loadManifest();
  const state = loadState();
  if (!Object.hasOwn(manifest.contexts, name)) throw new Error(`unknown context "${name}"`);
  delete manifest.contexts[name];
  saveManifest(manifest);
  if (state.current === name) {
    state.current = null;
    saveState(state);
  }
  return manifest.contexts;
}
