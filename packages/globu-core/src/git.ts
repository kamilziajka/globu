import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitAuthArgs } from "./auth.js";

export type Checkout = { root: string; commonDir: string };

const WORKTREE_PREFIX = "worktree ";

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${(err as Error).message.trim()}`);
  }
}

export function isRepo(dir: string): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"], dir) === "true";
  } catch {
    return false;
  }
}

export function checkoutOf(dir: string): Checkout | null {
  try {
    const [root, commonDir] = git(
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      dir
    ).split("\n");
    return { root, commonDir: fs.realpathSync(commonDir) };
  } catch {
    return null;
  }
}

export function mainCheckout(dir: string): string {
  const [main, kind] = git(["worktree", "list", "--porcelain"], dir).split("\n");
  if (kind === "bare") return git(["rev-parse", "--show-toplevel"], dir);
  return fs.realpathSync(main.slice(WORKTREE_PREFIX.length));
}

export function worktreeRoots(dir: string): string[] {
  return git(["worktree", "list", "--porcelain"], dir)
    .split("\n")
    .filter((line) => line.startsWith(WORKTREE_PREFIX))
    .map((line) => line.slice(WORKTREE_PREFIX.length));
}

export function defaultRevision(dir: string): string {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
  } catch {
    return "HEAD";
  }
}

export function hasPath(dir: string, revision: string, relPath: string): boolean {
  try {
    git(["cat-file", "-e", `${revision}:${relPath}`], dir);
    return true;
  } catch {
    return false;
  }
}

const MAX_RENAMES = 5;

function renameOf(dir: string, revision: string, relPath: string): string | null {
  const deletion = git(["log", revision, "--full-history", "--diff-filter=D", "--format=%H", "-1", "--", relPath], dir);
  if (deletion === "") return null;
  const fields = git(
    ["diff-tree", "-r", "-M", "-z", "--name-status", "--diff-filter=R", "--no-commit-id", deletion],
    dir
  ).split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 1] === relPath) return fields[index + 2];
  }
  return null;
}

export function renamedTo(dir: string, revision: string, relPath: string): string | null {
  try {
    let current = relPath;
    for (let hop = 0; hop < MAX_RENAMES; hop++) {
      const next = renameOf(dir, revision, current);
      if (next === null) return null;
      if (hasPath(dir, revision, next)) return next;
      current = next;
    }
    return null;
  } catch {
    return null;
  }
}

export function pathsNamed(dir: string, revision: string, name: string): string[] {
  const wanted = name.toLowerCase();
  try {
    return git(["ls-tree", "-r", "-t", "-z", "--name-only", revision], dir)
      .split("\0")
      .filter((entry) => path.posix.basename(entry).toLowerCase() === wanted);
  } catch {
    return [];
  }
}

export function remoteUrl(dir: string): string | null {
  try {
    return git(["remote", "get-url", "origin"], dir);
  } catch {
    const remotes = git(["remote"], dir).split("\n").filter(Boolean);
    return remotes.length === 1 ? git(["remote", "get-url", remotes[0]], dir) : null;
  }
}

export function headCommit(dir: string): string | null {
  try {
    return git(["rev-parse", "HEAD"], dir);
  } catch {
    return null;
  }
}

export function commitsBehind(dir: string): number {
  const revision = defaultRevision(dir);
  return revision === "HEAD" ? 0 : Number(git(["rev-list", "--count", `HEAD..${revision}`], dir));
}

export function clone(repoUrl: string, destDir: string, shallow: boolean, ref?: string): void {
  const depth = shallow ? ["--depth", "1"] : [];
  const branch = ref === undefined ? [] : ["--branch", ref];
  git([...gitAuthArgs(repoUrl), "clone", ...depth, ...branch, repoUrl, destDir]);
}

export function pull(dir: string, repoUrl: string | null): void {
  git([...gitAuthArgs(repoUrl), "pull", "--ff-only"], dir);
}

export function fetch(dir: string): void {
  git(["fetch", "--quiet"], dir);
}
