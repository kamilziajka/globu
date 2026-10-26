import path from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktree, baseIndex, initRepo, tempDir, write } from "../../testing/index.js";
import { childBase, findBases, isInside, ownerBase, readBaseIndex } from "./scan.js";

describe("findBases", () => {
  it("needs the OKF marker and respects .gitignore", () => {
    const root = initRepo(tempDir(), {
      ".gitignore": "target/\n",
      "docs/index.md": baseIndex("root"),
      "packages/api/docs/index.md": baseIndex("api", "API package"),
      "packages/cli/wiki/index.md": baseIndex("cli"),
      "packages/web/docs/index.md": "# plain docs folder, not a base\n",
      "packages/web/index.md": "# a page, not a base\n",
      "packages/broken/docs/index.md": "---\nkey: [unclosed\n---\n",
      "target/classes/docs/index.md": baseIndex("copied-by-build")
    });
    write(root, "packages/new/docs/index.md", baseIndex("untracked"));

    expect(findBases(root)).toEqual([
      { name: "root", description: "", docsDir: path.join(root, "docs"), path: "docs" },
      {
        name: "api",
        description: "API package",
        docsDir: path.join(root, "packages/api/docs"),
        path: "packages/api/docs"
      },
      { name: "cli", description: "", docsDir: path.join(root, "packages/cli/wiki"), path: "packages/cli/wiki" },
      { name: "untracked", description: "", docsDir: path.join(root, "packages/new/docs"), path: "packages/new/docs" }
    ]);
  });

  it("walks the directory outside git and skips dependency folders", () => {
    const root = tempDir();
    write(root, "docs/index.md", '---\nokf_version: "0.2"\n---\n');
    write(root, "node_modules/dep/docs/index.md", baseIndex("dep"));
    write(root, ".claude/worktrees/one/.git", "gitdir: elsewhere\n");
    write(root, ".claude/worktrees/one/docs/index.md", baseIndex("worktree"));
    expect(findBases(root).map((base) => [base.name, base.path])).toEqual([[path.basename(root), "docs"]]);
  });

  it("does not look inside a nested worktree", () => {
    const repo = initRepo(tempDir(), { "docs/index.md": baseIndex("root") });
    addWorktree(repo, path.join(repo, ".claude/worktrees/one"), "one");
    expect(findBases(repo).map((base) => base.path)).toEqual(["docs"]);
  });

  it("accepts a base directory as the root, whatever its name", () => {
    const root = tempDir();
    write(root, "knowledge/index.md", baseIndex("root"));
    write(root, "knowledge/guides/docs/index.md", baseIndex("nested"));
    expect(findBases(path.join(root, "knowledge")).map((base) => base.path)).toEqual([".", "guides/docs"]);
  });
});

describe("childBase", () => {
  it("returns the first base directly under a directory, skipping nested repos", () => {
    const root = tempDir();
    write(root, "wiki/index.md", baseIndex("wiki"));
    write(root, "docs/index.md", "# not a base\n");
    write(root, "vendor/.git", "gitdir: elsewhere\n");
    write(root, "vendor/index.md", baseIndex("vendored"));
    expect(childBase(root)).toBe(path.join(root, "wiki"));
    write(root, "knowledge/index.md", baseIndex("knowledge"));
    expect(childBase(root)).toBe(path.join(root, "knowledge"));
    expect(childBase(path.join(root, "docs"))).toBeNull();
    expect(childBase(path.join(root, "missing"))).toBeNull();
  });
});

describe("readBaseIndex", () => {
  it("returns null for a missing index", () => {
    expect(readBaseIndex(tempDir())).toBeNull();
  });
});

describe("ownerBase", () => {
  const root = tempDir();
  write(root, "wiki/index.md", baseIndex("root"));
  write(root, "packages/api/docs/index.md", baseIndex("api"));
  const apiFile = write(root, "packages/api/src/main/Handler.java", "");
  const webFile = write(root, "packages/web/src/app.js", "");
  const docFile = write(root, "packages/api/docs/topics/auth.md", "");

  it("picks the nearest base walking up, whatever the directory is called", () => {
    expect(ownerBase(apiFile)).toBe(path.join(root, "packages/api/docs"));
    expect(ownerBase(webFile)).toBe(path.join(root, "wiki"));
    expect(ownerBase(docFile)).toBe(path.join(root, "packages/api/docs"));
  });

  it("accepts directories and files that do not exist yet", () => {
    expect(ownerBase(path.join(root, "packages/api"))).toBe(path.join(root, "packages/api/docs"));
    expect(ownerBase(path.join(root, "packages/api/src/New.java"))).toBe(path.join(root, "packages/api/docs"));
    expect(ownerBase(path.join(root, "packages/api/src/new/deep/New.java"))).toBe(path.join(root, "packages/api/docs"));
  });

  it("stops at the root of the repo or worktree that holds the file", () => {
    const nested = path.join(root, ".claude/worktrees/one");
    write(nested, ".git", "gitdir: elsewhere\n");
    expect(ownerBase(write(nested, "src/app.js", ""))).toBeNull();
    write(nested, "docs/index.md", baseIndex("worktree"));
    expect(ownerBase(path.join(nested, "src/app.js"))).toBe(path.join(nested, "docs"));
  });

  it("stops at the given directory or at the filesystem root", () => {
    expect(ownerBase(webFile, path.join(root, "packages/web"))).toBeNull();
    expect(ownerBase(path.join(tempDir(), "file.txt"))).toBeNull();
  });
});

describe("isInside", () => {
  it("is true for the directory itself and anything below it", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d.md")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});
