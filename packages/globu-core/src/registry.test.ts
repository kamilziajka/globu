import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  bareWorktree,
  baseIndex,
  commitAll,
  git,
  initRepo,
  read,
  tempDir,
  write
} from "../../testing/index.js";
import { syncClaudeDirectories } from "./claude.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { clonesDir, manifestPath, statePath } from "./paths.js";
import {
  register,
  removeContext,
  reprobe,
  resolveActive,
  resolveAll,
  setContext,
  sync,
  unregister,
  updateShard,
  useContext
} from "./registry.js";
import { loadState, saveState } from "./state.js";

let sandbox: string;

function localRepo(name: string, files: Record<string, string> = { "README.md": `${name}\n` }): string {
  return initRepo(path.join(sandbox, "work", name), files);
}

function remoteRepo(name: string, files: Record<string, string> = { "README.md": `${name}\n` }): string {
  return `file://${initRepo(path.join(sandbox, "remotes", name), files)}`;
}

function ids(): string[] {
  return resolveActive().shards.map((shard) => shard.id);
}

beforeEach(() => {
  sandbox = tempDir();
});

describe("register a local directory", () => {
  it("adopts the repo in place as an editable shard", () => {
    const repo = localRepo("product", {
      "docs/index.md": baseIndex("product", "Product decisions"),
      "packages/api/docs/index.md": baseIndex("api", "API notes")
    });
    const result = register({ locator: "packages", cwd: repo, useWhen: "Product questions" });

    expect(result).toMatchObject({ action: "registered", portable: false });
    expect(result.shard).toEqual({
      id: "product",
      source: { type: "git", repo: null },
      format: "okf",
      roots: [
        { path: "docs", name: "product", entry: "docs/index.md" },
        { path: "packages/api/docs", name: "api", entry: "packages/api/docs/index.md" }
      ],
      description: "Product decisions",
      useWhen: "Product questions",
      path: repo,
      owner: "user",
      mode: "write",
      present: true
    });
    expect(read(manifestPath())).not.toContain(repo);
    expect(read(statePath())).toContain(repo);
  });

  it("uses the origin remote for identity and honours id, mode and description", () => {
    const repo = localRepo("checkout");
    git(repo, "remote", "add", "origin", "git@github.com:acme/handbook.git");
    const result = register({ locator: repo, cwd: sandbox, id: "hb", mode: "read", description: "Handbook" });

    expect(result.portable).toBe(true);
    expect(result.shard).toMatchObject({
      id: "hb",
      source: { repo: "git@github.com:acme/handbook.git" },
      format: "generic",
      roots: [{ path: ".", entry: "README.md" }],
      description: "Handbook",
      mode: "read"
    });
    expect(register({ locator: repo, cwd: sandbox }).shard.id).toBe("hb");
  });

  it("falls back to the only remote when there is no origin", () => {
    const mirror = localRepo("mirror");
    git(mirror, "remote", "add", "gitlab", "git@gitlab.example.com:acme/mirror.git");
    expect(register({ locator: mirror, cwd: sandbox }).shard.source.repo).toBe(
      "git@gitlab.example.com:acme/mirror.git"
    );

    const two = localRepo("two");
    git(two, "remote", "add", "a", "git@example.com:a/two.git");
    git(two, "remote", "add", "b", "git@example.com:b/two.git");
    expect(register({ locator: two, cwd: sandbox }).shard.source.repo).toBeNull();
  });

  it("derives the id from the remote and handles a repo that is itself a docs base", () => {
    const repo = localRepo("docs", { "index.md": baseIndex("handbook") });
    git(repo, "remote", "add", "origin", "https://github.com/acme/handbook.git");
    const { shard } = register({ locator: repo, cwd: sandbox });
    expect(shard.id).toBe("handbook");
    expect(shard.roots).toEqual([{ path: ".", name: "handbook", entry: "index.md" }]);
  });

  it("re-registering a repo attaches to the existing entry", () => {
    const repo = localRepo("notes");
    register({ locator: repo, cwd: sandbox, description: "first" });
    const again = register({ locator: repo, cwd: sandbox, mode: "read", description: "ignored" });
    expect(again.action).toBe("attached");
    expect(again.shard).toMatchObject({ mode: "read", description: "first" });
    expect(loadManifest().shards).toHaveLength(1);
  });

  it("records the main checkout when run from a worktree", () => {
    const repo = localRepo("product");
    const nested = addWorktree(repo, path.join(repo, ".claude/worktrees/one"), "one");
    const outside = addWorktree(repo, path.join(sandbox, "elsewhere"), "two");

    expect(register({ locator: ".", cwd: nested }).shard.path).toBe(repo);
    expect(register({ locator: outside, cwd: sandbox })).toMatchObject({ action: "attached", shard: { path: repo } });
  });

  it("records the worktree itself when the repo has no main checkout", () => {
    const worktree = bareWorktree(localRepo("source"), path.join(sandbox, "bare.git"), path.join(sandbox, "work/tree"));
    expect(register({ locator: worktree, cwd: sandbox, id: "tree" }).shard.path).toBe(worktree);
  });

  it("rejects bad input", () => {
    const repo = localRepo("notes");
    const plain = path.join(sandbox, "plain");
    fs.mkdirSync(plain);
    register({ locator: repo, cwd: sandbox });

    expect(() => register({ locator: "missing", cwd: sandbox })).toThrow(/neither a directory nor a repo URL/);
    expect(() => register({ locator: plain, cwd: sandbox })).toThrow(/not inside a git repository/);
    expect(() => register({ locator: repo, cwd: sandbox, id: "bad id" })).toThrow(/invalid shard id/);
    expect(() => register({ locator: repo, cwd: sandbox, id: "other" })).toThrow(/already registered as "notes"/);
    expect(() => register({ locator: localRepo("x"), cwd: sandbox, id: "notes" })).toThrow(/different shard/);
    expect(() => register({ locator: localRepo("_odd"), cwd: sandbox })).toThrow(/invalid shard id "_odd"/);
  });
});

describe("register a URL", () => {
  it("makes a read-only globu-owned shallow clone", () => {
    const url = remoteRepo("handbook");
    const { shard, portable } = register({ locator: url, cwd: sandbox });

    expect(portable).toBe(true);
    expect(shard).toMatchObject({
      id: "handbook",
      source: { repo: url },
      mode: "read",
      owner: "globu",
      path: path.join(clonesDir(), "handbook")
    });
    expect(read(clonesDir(), "handbook", "README.md")).toBe("handbook\n");
    expect(() => register({ locator: url, cwd: sandbox })).toThrow(/already registered as "handbook"/);
    expect(() => register({ locator: url, cwd: sandbox, id: "other" })).toThrow(/already registered as "handbook"/);
  });

  it("needs --path for an editable shard and clones there", () => {
    const url = remoteRepo("notes");
    expect(() => register({ locator: url, cwd: sandbox, mode: "write" })).toThrow(/--path/);
    expect(() => register({ locator: url, cwd: sandbox, mode: "ask" })).toThrow(/--path/);
    expect(() => register({ locator: `file://${sandbox}/remotes/..`, cwd: sandbox })).toThrow(/invalid shard id/);

    const { shard } = register({ locator: url, cwd: sandbox, dest: "work/notes" });
    expect(shard).toMatchObject({ path: path.join(sandbox, "work/notes"), owner: "user", mode: "write" });
    expect(fs.existsSync(path.join(sandbox, "work/notes/.git"))).toBe(true);
  });

  it("attaches an editable clone to a shard that was read-only", () => {
    const url = remoteRepo("notes");
    register({ locator: url, cwd: sandbox });
    const dest = path.join(sandbox, "work", "notes");
    fs.mkdirSync(dest, { recursive: true });

    const attached = register({ locator: url, cwd: sandbox, dest, mode: "read" });
    expect(attached).toMatchObject({
      action: "attached",
      replaced: path.join(clonesDir(), "notes"),
      shard: { path: dest, owner: "user", mode: "read" }
    });
    expect(fs.existsSync(path.join(clonesDir(), "notes"))).toBe(false);
    expect(register({ locator: url, cwd: sandbox, dest })).toMatchObject({ replaced: null, shard: { mode: "write" } });
    expect(loadManifest().shards).toHaveLength(1);
  });

  it("leaves a replaced clone alone when it is already gone or not under the clones directory", () => {
    const url = remoteRepo("notes");
    const managed = register({ locator: url, cwd: sandbox }).shard.path as string;
    fs.rmSync(managed, { recursive: true });
    expect(register({ locator: url, cwd: sandbox, dest: "work/notes" }).replaced).toBeNull();

    const other = remoteRepo("other");
    register({ locator: other, cwd: sandbox });
    const elsewhere = localRepo("elsewhere");
    const state = loadState();
    state.shards.other.path = elsewhere;
    saveState(state);
    expect(register({ locator: other, cwd: sandbox, dest: "work/other" }).replaced).toBeNull();
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it("refuses a destination that holds something else", () => {
    const url = remoteRepo("notes");
    const plain = path.join(sandbox, "plain");
    write(plain, "file.txt", "x");
    expect(() => register({ locator: url, cwd: sandbox, dest: plain })).toThrow(/not a clone of/);
    expect(() => register({ locator: url, cwd: sandbox, dest: localRepo("other") })).toThrow(/not a clone of/);
  });
});

describe("unregister", () => {
  it("never deletes a user clone", () => {
    const repo = localRepo("mine");
    register({ locator: repo, cwd: sandbox });
    expect(unregister("mine", true)).toEqual({ id: "mine", path: repo, clone: "kept", claudeListed: false });
    expect(fs.existsSync(repo)).toBe(true);
    expect(() => unregister("mine", false)).toThrow(/no shard registered/);
  });

  it("purges a managed clone only on request", () => {
    const url = remoteRepo("theirs");
    const clonePath = register({ locator: url, cwd: sandbox }).shard.path as string;
    expect(unregister("theirs", false).clone).toBe("kept");
    expect(register({ locator: url, cwd: sandbox }).action).toBe("registered");
    expect(unregister("theirs", true).clone).toBe("removed");
    expect(fs.existsSync(clonePath)).toBe(false);
    expect(resolveAll().shards).toEqual([]);
  });

  it("does not purge a clone outside the managed directory", () => {
    const repo = localRepo("mine");
    register({ locator: repo, cwd: sandbox });
    const state = loadState();
    state.shards.mine.owner = "globu";
    saveState(state);
    expect(unregister("mine", true).clone).toBe("kept");
  });

  it("says when the Claude settings still list the clone", () => {
    const repo = localRepo("listed");
    register({ locator: repo, cwd: sandbox });
    syncClaudeDirectories(false);
    expect(unregister("listed", false)).toMatchObject({ clone: "kept", claudeListed: true });
  });

  it("reports nothing to remove for a shard without a local clone", () => {
    const repo = localRepo("gone");
    register({ locator: repo, cwd: sandbox });
    fs.rmSync(repo, { recursive: true });
    expect(unregister("gone", true)).toEqual({ id: "gone", path: repo, clone: "none", claudeListed: false });

    register({ locator: remoteRepo("remote-only"), cwd: sandbox });
    fs.rmSync(statePath());
    expect(unregister("remote-only", true)).toEqual({
      id: "remote-only",
      path: null,
      clone: "none",
      claudeListed: false
    });
  });
});

describe("updateShard", () => {
  it("edits routing text and the access cap", () => {
    register({ locator: localRepo("team"), cwd: sandbox });
    expect(updateShard("team", { description: "Team notes", useWhen: "Team questions" })).toMatchObject({
      description: "Team notes",
      useWhen: "Team questions",
      mode: "write"
    });
    expect(updateShard("team", { access: "read" }).mode).toBe("read");
    expect(loadManifest().shards[0].access).toBe("read");
    expect(updateShard("team", { access: "write" }).mode).toBe("write");
    expect(loadManifest().shards[0].access).toBeUndefined();
  });

  it("changes the local mode for user clones only", () => {
    register({ locator: localRepo("team"), cwd: sandbox });
    expect(updateShard("team", { mode: "read" }).mode).toBe("read");
    expect(updateShard("team", { mode: "write" }).mode).toBe("write");

    register({ locator: remoteRepo("managed"), cwd: sandbox });
    expect(updateShard("managed", { mode: "read" }).mode).toBe("read");
    expect(() => updateShard("managed", { mode: "write" })).toThrow(/globu-managed/);
    expect(() => updateShard("managed", { mode: "ask" })).toThrow(/globu-managed/);
    fs.rmSync(statePath());
    expect(() => updateShard("managed", { mode: "read" })).toThrow(/no local clone yet/);
    expect(() => updateShard("nope", {})).toThrow(/no shard registered/);
  });
});

describe("sync", () => {
  it("clones shards known only to the manifest and pulls managed clones", () => {
    const url = remoteRepo("guide", { "README.md": "v1\n" });
    register({ locator: url, cwd: sandbox });
    const clonePath = path.join(clonesDir(), "guide");

    fs.rmSync(statePath());
    expect(sync()).toEqual([{ id: "guide", action: "cloned" }]);
    fs.rmSync(statePath());
    fs.rmSync(clonePath, { recursive: true });
    expect(sync()).toEqual([{ id: "guide", action: "cloned" }]);
    expect(loadState().shards.guide).toEqual({ path: clonePath, mode: "read", owner: "globu" });

    const remoteDir = url.slice("file://".length);
    write(remoteDir, "README.md", "v2\n");
    commitAll(remoteDir);
    expect(sync()).toEqual([{ id: "guide", action: "pulled" }]);
    expect(read(clonePath, "README.md")).toBe("v2\n");

    fs.rmSync(clonePath, { recursive: true });
    expect(sync()).toEqual([{ id: "guide", action: "cloned" }]);
  });

  it("only fetches user clones", () => {
    const url = remoteRepo("notes");
    const local = localRepo("local-only");
    register({ locator: url, cwd: sandbox, dest: "work/notes" });
    register({ locator: local, cwd: sandbox });
    expect(sync()).toEqual([
      { id: "notes", action: "fetched" },
      { id: "local-only", action: "fetched" }
    ]);
  });

  it("reports problems per shard without stopping", () => {
    const local = localRepo("local-only");
    const url = remoteRepo("broken");
    register({ locator: local, cwd: sandbox });
    register({ locator: url, cwd: sandbox });
    register({ locator: remoteRepo("fine"), cwd: sandbox });

    fs.rmSync(local, { recursive: true });
    fs.rmSync(url.slice("file://".length), { recursive: true });
    const report = sync();
    expect(report.map((entry) => entry.action)).toEqual(["error", "error", "pulled"]);
    expect(report[0].error).toMatch(/clone is missing/);
    expect(report[1].error).toMatch(/git pull --ff-only failed/);

    fs.rmSync(statePath());
    expect(sync()[0]).toEqual({
      id: "local-only",
      action: "error",
      error: "no repo URL in the manifest, register it from a local clone"
    });
  });
});

describe("reprobe", () => {
  it("picks up a format change", () => {
    const repo = localRepo("svc");
    register({ locator: repo, cwd: sandbox });
    expect(reprobe("svc").changed).toBe(false);

    write(repo, "docs/index.md", baseIndex("svc"));
    const preview = reprobe("svc", false);
    expect(preview).toMatchObject({
      changed: true,
      applied: false,
      shard: { format: "generic" },
      probed: { format: "okf", roots: [{ path: "docs", name: "svc", entry: "docs/index.md" }] }
    });
    expect(loadManifest().shards[0].format).toBe("generic");
    const result = reprobe("svc");
    expect(result).toMatchObject({ changed: true, applied: true, shard: { format: "okf" } });
    expect(loadManifest().shards[0].roots).toEqual([{ path: "docs", name: "svc", entry: "docs/index.md" }]);

    write(repo, "pkg/docs/index.md", baseIndex("pkg"));
    expect(reprobe("svc").changed).toBe(true);
  });

  it("needs a local clone", () => {
    const repo = localRepo("svc");
    register({ locator: repo, cwd: sandbox });
    fs.rmSync(repo, { recursive: true });
    expect(() => reprobe("svc")).toThrow(/no local clone/);
    fs.rmSync(statePath());
    expect(() => reprobe("svc")).toThrow(/no local clone/);
  });
});

describe("contexts", () => {
  beforeEach(() => {
    for (const name of ["team-api", "team-web", "private"]) register({ locator: localRepo(name), cwd: sandbox });
  });

  it("select shards by id or pattern", () => {
    expect(ids()).toEqual(["team-api", "team-web", "private"]);
    setContext("work", ["team-*"]);
    setContext("personal", ["private"]);

    expect(useContext("work")).toBe("work");
    expect(resolveActive().context).toBe("work");
    expect(ids()).toEqual(["team-api", "team-web"]);

    process.env.GLOBU_CONTEXT = "personal";
    expect(ids()).toEqual(["private"]);
    delete process.env.GLOBU_CONTEXT;

    expect(useContext(null)).toBeNull();
    expect(ids()).toHaveLength(3);
  });

  it("removing the active context clears it", () => {
    setContext("work", ["team-*"]);
    setContext("other", ["private"]);
    useContext("work");
    expect(removeContext("other")).toEqual({ work: ["team-*"] });
    expect(loadState().current).toBe("work");
    expect(removeContext("work")).toEqual({});
    expect(loadState().current).toBeNull();
  });

  it("rejects unknown and malformed contexts", () => {
    expect(() => useContext("nope")).toThrow(/unknown context "nope" \(known: none\)/);
    setContext("work", ["team-*"]);
    expect(() => useContext("nope")).toThrow(/known: work/);
    expect(() => removeContext("nope")).toThrow(/unknown context/);
    expect(() => setContext("bad name", ["x"])).toThrow(/invalid context name/);
    expect(() => setContext("empty", [])).toThrow(/at least one/);

    process.env.GLOBU_CONTEXT = "ghost";
    expect(() => resolveActive()).toThrow(/unknown context: ghost/);
  });
});

describe("resolveAll", () => {
  it("marks shards with no state as read-only and absent", () => {
    saveManifest({
      version: 1,
      shards: [
        {
          id: "a",
          source: { type: "git", repo: "https://example.com/a.git" },
          format: "generic",
          roots: [{ path: "." }],
          description: "",
          useWhen: ""
        }
      ],
      contexts: {},
      imports: []
    });
    expect(resolveAll().shards[0]).toMatchObject({ path: null, owner: null, mode: "read", present: false });
  });
});
