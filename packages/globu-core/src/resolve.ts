import fs from "node:fs";
import path from "node:path";
import { checkoutOf, defaultRevision, hasPath, mainCheckout, pathsNamed, renamedTo, worktreeRoots } from "./git.js";
import type { ResolvedShard } from "./registry.js";
import { locate, type SessionShard, shardFinder } from "./session.js";

export type Candidate = { ref: string; match: "rename" | "name" };
export type RefResult = {
  ref: string;
  shard: string | null;
  ok: boolean;
  location: string | null;
  revision: string | null;
  worktrees: string[];
  reason: string | null;
  candidates: Candidate[];
};
export type ResolveReport = { ok: boolean; refs: RefResult[]; shards: string[] };

type Target = {
  shard: string | null;
  label: string;
  repo: string;
  root: string;
  relPath: string;
  toRef: (relPath: string) => string;
};

const PARENT = /^\.\.(\/|$)/;
const MAX_CANDIDATES = 10;

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

function withinRepo(relPath: string): string | null {
  const normal = path.posix.normalize(relPath);
  if (path.posix.isAbsolute(normal) || PARENT.test(normal)) return null;
  return normal.replace(/\/+$/, "").replace(/^\.$/, "");
}

function failure(ref: string, shard: string | null, reason: string): RefResult {
  return { ref, shard, ok: false, location: null, revision: null, worktrees: [], reason, candidates: [] };
}

function candidatesFor(target: Target, revision: string): Candidate[] {
  const renamed = renamedTo(target.repo, revision, target.relPath);
  const segments = new Set(target.relPath.split("/"));
  const shared = (relPath: string) => relPath.split("/").filter((segment) => segments.has(segment)).length;
  const named = pathsNamed(target.repo, revision, path.posix.basename(target.relPath))
    .filter((relPath) => relPath !== renamed)
    .sort((a, b) => shared(b) - shared(a));
  return [
    ...(renamed === null ? [] : [{ ref: target.toRef(renamed), match: "rename" as const }]),
    ...named.map((relPath) => ({ ref: target.toRef(relPath), match: "name" as const }))
  ].slice(0, MAX_CANDIDATES);
}

function check(ref: string, target: Target): RefResult {
  const revision = defaultRevision(target.repo);
  const result = { ref, shard: target.shard, revision, worktrees: [] as string[], candidates: [] as Candidate[] };
  if (hasPath(target.repo, revision, target.relPath)) {
    return { ...result, ok: true, location: path.join(target.root, target.relPath), reason: null };
  }
  const candidates = candidatesFor(target, revision);
  const worktrees = worktreeRoots(target.repo).filter((dir) => fs.existsSync(path.join(dir, target.relPath)));
  const where =
    worktrees.length === 0
      ? ""
      : `, it exists only in ${worktrees.join(", ")}: uncommitted, not pushed or on another branch`;
  return {
    ...result,
    ok: false,
    location: null,
    worktrees,
    reason: `not on ${revision} of ${target.label}${where}`,
    candidates
  };
}

export function resolveRefs(
  refs: string[],
  all: ResolvedShard[],
  active: ResolvedShard[],
  cwd: string,
  context: string | null
): ResolveReport {
  const located = locate(active, cwd);
  const findShard = shardFinder(located);
  const session = checkoutOf(cwd);
  const touched = new Set<string>();

  function shardRef(ref: string, id: string, rest: string): RefResult {
    const shard = located.find((candidate) => candidate.id === id);
    if (shard === undefined) {
      const project = context === null ? "this session's project" : `the active project "${context}"`;
      return failure(ref, id, `shard "${id}" is not in ${project}`);
    }
    if (!shard.present) return failure(ref, id, `shard "${id}" has no clone on this machine, run \`globu sync\``);
    touched.add(id);
    const relPath = withinRepo(rest);
    if (relPath === null) return failure(ref, id, `the path leaves the repo of shard "${id}"`);
    const { path: repo, workPath: root } = shard as SessionShard & { path: string; workPath: string };
    return check(ref, { shard: id, label: `shard "${id}"`, repo, root, relPath, toRef: (found) => `${id}/${found}` });
  }

  function localRef(ref: string, head: string): RefResult {
    if (session === null) {
      return failure(ref, null, `no shard is registered as "${head}" and the current directory is not in a git repo`);
    }
    const relPath = withinRepo(toPosix(path.relative(session.root, path.resolve(cwd, ref))));
    if (relPath === null) return failure(ref, null, "the path leaves the current repo");
    const shard = findShard(session.root);
    if (shard !== undefined) touched.add(shard.id);
    const label = shard === undefined ? `the current repo (${session.root})` : `shard "${shard.id}"`;
    const result = check(ref, {
      shard: shard?.id ?? null,
      label,
      repo: mainCheckout(session.root),
      root: session.root,
      relPath,
      toRef: (found) => toPosix(path.relative(cwd, path.join(session.root, found))) || "."
    });
    if (!result.ok && ref.includes("/") && !fs.existsSync(path.resolve(cwd, head))) {
      result.reason = `${result.reason}, and no shard is registered as "${head}"`;
    }
    return result;
  }

  const results = refs.map((ref) => {
    const head = ref.split("/")[0];
    return all.some((shard) => shard.id === head)
      ? shardRef(ref, head, ref.slice(head.length + 1))
      : localRef(ref, head);
  });
  return { ok: results.every((result) => result.ok), refs: results, shards: [...touched] };
}
