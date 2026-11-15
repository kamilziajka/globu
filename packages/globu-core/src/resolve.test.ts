import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addWorktree, commitAll, git, initRepo, tempDir, write } from "../../testing/index.js";
import type { ResolvedShard } from "./registry.js";
import { resolveRefs } from "./resolve.js";

let sandbox: string;
let product: string;

function shard(id: string, shardPath: string | null): ResolvedShard {
  return {
    id,
    source: { type: "git", repo: null },
    format: "okf",
    roots: [{ path: "docs", entry: "docs/index.md" }],
    description: "",
    useWhen: "",
    path: shardPath,
    owner: "user",
    mode: "write",
    present: shardPath !== null && fs.existsSync(shardPath)
  };
}

function resolveIn(
  cwd: string,
  refs: string[],
  shards: ResolvedShard[],
  active = shards,
  context: string | null = null
) {
  return resolveRefs(refs, shards, active, cwd, context);
}

beforeEach(() => {
  sandbox = tempDir();
  const remote = initRepo(path.join(sandbox, "remotes", "product"), { "docs/index.md": "i\n", "docs/a.md": "a\n" });
  git(sandbox, "clone", "-q", remote, "product");
  product = fs.realpathSync.native(path.join(sandbox, "product"));
});

describe("resolveRefs on shards", () => {
  it("resolves files, directories and the shard root on the default branch", () => {
    const report = resolveIn(
      sandbox,
      ["product/docs/a.md", "product/docs/", "product", "product/./docs/../docs/a.md"],
      [shard("product", product)]
    );
    expect(report.ok).toBe(true);
    expect(report.shards).toEqual(["product"]);
    expect(report.refs.map((result) => [result.ok, result.location, result.revision])).toEqual([
      [true, path.join(product, "docs/a.md"), "origin/main"],
      [true, path.join(product, "docs"), "origin/main"],
      [true, product, "origin/main"],
      [true, path.join(product, "docs/a.md"), "origin/main"]
    ]);
    expect(report.refs[0]).toEqual({
      ref: "product/docs/a.md",
      shard: "product",
      ok: true,
      location: path.join(product, "docs/a.md"),
      revision: "origin/main",
      worktrees: [],
      reason: null,
      candidates: []
    });
  });

  it("fails a path that is only in a worktree or not pushed, also from inside that worktree", () => {
    const tree = addWorktree(product, path.join(sandbox, "tree"), "one");
    write(tree, "docs/new.md", "n\n");
    write(product, "docs/local.md", "l\n");
    commitAll(product);
    const shards = [shard("product", product)];

    const report = resolveIn(tree, ["product/docs/new.md", "product/docs/local.md", "product/docs/none.md"], shards);
    expect(report.ok).toBe(false);
    expect(report.refs.map((result) => [result.ok, result.worktrees, result.reason])).toEqual([
      [
        false,
        [tree],
        `not on origin/main of shard "product", it exists only in ${tree}: uncommitted, not pushed or on another branch`
      ],
      [
        false,
        [product],
        `not on origin/main of shard "product", it exists only in ${product}: uncommitted, not pushed or on another branch`
      ],
      [false, [], 'not on origin/main of shard "product"']
    ]);

    commitAll(tree);
    expect(resolveIn(tree, ["product/docs/new.md"], shards).ok).toBe(false);
    expect(resolveIn(tree, ["product/docs/a.md"], shards).refs[0].location).toBe(path.join(tree, "docs/a.md"));
  });

  it("checks HEAD of a repo without a remote", () => {
    const notes = initRepo(path.join(sandbox, "notes"), { "a.md": "a\n" });
    expect(resolveIn(sandbox, ["notes/a.md"], [shard("notes", notes)]).refs[0]).toMatchObject({
      ok: true,
      revision: "HEAD"
    });
  });

  it("explains shards it cannot check", () => {
    const shards = [shard("product", product), shard("gone", null), shard("moved", path.join(sandbox, "moved"))];
    const report = resolveIn(
      sandbox,
      ["product/docs/a.md", "gone/docs/a.md", "moved/a.md"],
      shards,
      shards.slice(1),
      "work"
    );
    expect(report.refs.map((result) => [result.shard, result.reason])).toEqual([
      ["product", 'shard "product" is not in the active project "work"'],
      ["gone", 'shard "gone" has no clone on this machine, run `globu sync`'],
      ["moved", 'shard "moved" has no clone on this machine, run `globu sync`']
    ]);
    expect(report.shards).toEqual([]);

    const leaving = resolveIn(
      sandbox,
      ["product/../remotes/product/docs/a.md", "product//etc"],
      [shard("product", product)]
    );
    expect(leaving.refs.map((result) => result.reason)).toEqual([
      'the path leaves the repo of shard "product"',
      'the path leaves the repo of shard "product"'
    ]);
    expect(leaving.shards).toEqual(["product"]);
  });
});

describe("resolveRefs in the current repo", () => {
  it("resolves paths relative to the current directory", () => {
    const code = initRepo(path.join(sandbox, "code"), { "src/a.ts": "a\n" });
    const report = resolveIn(path.join(code, "src"), ["a.ts", "missing.ts", "../../x"], [shard("product", product)]);
    expect(report.refs.map((result) => [result.ok, result.shard, result.location, result.reason])).toEqual([
      [true, null, path.join(code, "src/a.ts"), null],
      [false, null, null, `not on HEAD of the current repo (${code})`],
      [false, null, null, "the path leaves the current repo"]
    ]);
    expect(report.shards).toEqual([]);

    expect(resolveIn(code, ["src/none.ts", "nope/x.md"], []).refs.map((result) => result.reason)).toEqual([
      `not on HEAD of the current repo (${code})`,
      `not on HEAD of the current repo (${code}), and no shard is registered as "nope"`
    ]);
  });

  it("names the shard the current repo belongs to", () => {
    const report = resolveIn(path.join(product, "docs"), ["a.md", "b.md"], [shard("product", product)]);
    expect(report.refs.map((result) => [result.ok, result.shard, result.reason])).toEqual([
      [true, "product", null],
      [false, "product", 'not on origin/main of shard "product"']
    ]);
    expect(report.shards).toEqual(["product"]);
  });

  it("fails a path outside any repo", () => {
    expect(resolveIn(sandbox, ["docs/a.md"], []).refs[0]).toEqual({
      ref: "docs/a.md",
      shard: null,
      ok: false,
      location: null,
      revision: null,
      worktrees: [],
      reason: 'no shard is registered as "docs" and the current directory is not in a git repo',
      candidates: []
    });
  });
});

describe("resolveRefs candidates", () => {
  function remote(): string {
    return path.join(sandbox, "remotes", "product");
  }

  function move(root: string, from: string, to: string): void {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.renameSync(path.join(root, from), path.join(root, to));
  }

  function publish(change: (root: string) => void): void {
    change(remote());
    commitAll(remote());
    git(product, "fetch", "-q");
  }

  function candidates(cwd: string, refs: string[], shards: ResolvedShard[]) {
    return resolveIn(cwd, refs, shards).refs.map((result) => result.candidates);
  }

  it("follows a file through its renames on the default branch", () => {
    publish((root) => move(root, "docs/a.md", "docs/pricing.md"));
    publish((root) => move(root, "docs/pricing.md", "docs/decisions/012-pricing.md"));
    const report = resolveIn(sandbox, ["product/docs/a.md"], [shard("product", product)]);
    expect(report.refs[0]).toMatchObject({
      ok: false,
      candidates: [{ ref: "product/docs/decisions/012-pricing.md", match: "rename" }]
    });
  });

  it("follows a rename made on a branch that was merged", () => {
    const root = remote();
    git(root, "checkout", "-q", "-b", "feature");
    write(root, "docs/131-users.md", "users decision\n");
    commitAll(root);
    move(root, "docs/131-users.md", "docs/132-users.md");
    commitAll(root);
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    git(product, "fetch", "-q");
    expect(candidates(sandbox, ["product/docs/131-users.md"], [shard("product", product)])).toEqual([
      [{ ref: "product/docs/132-users.md", match: "rename" }]
    ]);
  });

  it("stops at a plain deletion and after five renames", () => {
    publish((root) => {
      fs.rmSync(path.join(root, "docs/a.md"));
      move(root, "docs/index.md", "docs/i0.md");
    });
    for (let hop = 0; hop < 6; hop++) {
      publish((root) => move(root, `docs/i${hop}.md`, `docs/i${hop + 1}.md`));
    }
    expect(
      candidates(
        sandbox,
        ["product/docs/a.md", "product/docs/index.md", "product/docs/i1.md"],
        [shard("product", product)]
      )
    ).toEqual([[], [], [{ ref: "product/docs/i6.md", match: "rename" }]]);
  });

  it("lists files with the same name, closest first and after a rename", () => {
    publish((root) => {
      write(root, "archive/b.md", "old b\n");
      write(root, "docs/guides/b.md", "guide b\n");
      write(root, "docs/readme.md", "r\n");
      move(root, "docs/a.md", "docs/old/a.md");
    });
    expect(
      candidates(
        sandbox,
        ["product/docs/b.md", "product/docs/README.md", "product/docs/a.md", "product/docs/none.md"],
        [shard("product", product)]
      )
    ).toEqual([
      [
        { ref: "product/docs/guides/b.md", match: "name" },
        { ref: "product/archive/b.md", match: "name" }
      ],
      [{ ref: "product/docs/readme.md", match: "name" }],
      [{ ref: "product/docs/old/a.md", match: "rename" }],
      []
    ]);
  });

  it("lists at most ten candidates", () => {
    publish((root) => {
      for (let index = 0; index < 11; index++) write(root, `d${index}/c.md`, `${index}\n`);
    });
    expect(candidates(sandbox, ["product/c.md"], [shard("product", product)])[0]).toHaveLength(10);
  });

  it("finds nothing in a repo without commits", () => {
    const empty = path.join(sandbox, "empty");
    fs.mkdirSync(empty);
    git(empty, "init", "-q");
    expect(resolveIn(sandbox, ["empty/a.md"], [shard("empty", empty)]).refs[0]).toMatchObject({
      ok: false,
      revision: "HEAD",
      candidates: []
    });
  });

  it("writes candidates in the current repo relative to the current directory", () => {
    const code = initRepo(path.join(sandbox, "code"), { "src/render/snapshot.ts": "s\n", "lib/util.ts": "u\n" });
    expect(candidates(path.join(code, "src"), ["snapshot.ts", "../util.ts", "x/src"], [])).toEqual([
      [{ ref: "render/snapshot.ts", match: "name" }],
      [{ ref: "../lib/util.ts", match: "name" }],
      [{ ref: ".", match: "name" }]
    ]);
  });
});
