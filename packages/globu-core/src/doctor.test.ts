import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseIndex, commitAll, git, initRepo, tempDir, write } from "../../testing/index.js";
import { syncClaudeDirectories } from "./claude.js";
import { doctor } from "./doctor.js";
import { clonesDir, statePath } from "./paths.js";
import { register, unregister } from "./registry.js";

function messages(): string[] {
  return doctor().map((finding) => `${finding.level} ${finding.id}: ${finding.message}`);
}

describe("doctor", () => {
  it("finds nothing wrong with a healthy shard", () => {
    const sandbox = tempDir();
    const url = `file://${initRepo(path.join(sandbox, "remote"), { "README.md": "x" })}`;
    register({ locator: url, cwd: sandbox, id: "ok", description: "d", useWhen: "u" });
    const bare = initRepo(path.join(sandbox, "bare"), { "notes.txt": "x" });
    git(bare, "remote", "add", "origin", "https://example.com/acme/bare.git");
    register({ locator: bare, cwd: sandbox, description: "d", useWhen: "u" });
    expect(doctor()).toEqual([]);
  });

  it("warns about missing routing text and a missing remote", () => {
    const repo = initRepo(path.join(tempDir(), "local"), { "README.md": "x" });
    register({ locator: repo, cwd: repo });
    expect(messages()).toEqual([
      "warning local: no repo URL, so this shard cannot be synced to another machine",
      "warning local: no description, Claude cannot tell what this shard holds",
      "warning local: no useWhen, Claude cannot tell when to consult this shard"
    ]);
  });

  it("notices format and root drift and says what the probe found", () => {
    const repo = initRepo(path.join(tempDir(), "svc"), { "README.md": "x" });
    git(repo, "remote", "add", "origin", "https://example.com/acme/svc.git");
    register({ locator: repo, cwd: repo, description: "d", useWhen: "u" });

    write(repo, "wiki/index.md", baseIndex("svc"));
    expect(messages()).toEqual([
      `warning svc: format is now "okf" (bases at wiki) in the working tree at ${repo}, the manifest says "generic", preview with \`globu reprobe svc --dry-run\``
    ]);

    register({ locator: repo, cwd: repo, id: "svc" });
    fs.rmSync(path.join(process.env.GLOBU_HOME as string, "manifest.yaml"));
    register({ locator: repo, cwd: repo, description: "d", useWhen: "u" });
    write(repo, "pkg/docs/index.md", baseIndex("pkg"));
    expect(messages()).toEqual([
      "warning svc: the roots are now pkg/docs, wiki, the manifest says wiki, preview with `globu reprobe svc --dry-run`"
    ]);

    fs.rmSync(path.join(repo, "pkg"), { recursive: true });
    fs.rmSync(path.join(repo, "wiki"), { recursive: true });
    expect(messages()).toEqual([
      `warning svc: format is now "generic" (no index.md with an okf_version marker) in the working tree at ${repo}, the manifest says "okf", preview with \`globu reprobe svc --dry-run\``
    ]);
  });

  it("notices a missing entry file", () => {
    const repo = initRepo(path.join(tempDir(), "svc"), { "README.md": "x" });
    git(repo, "remote", "add", "origin", "https://example.com/acme/svc.git");
    register({ locator: repo, cwd: repo, description: "d", useWhen: "u" });
    fs.rmSync(path.join(repo, "README.md"));
    expect(messages()).toEqual([
      "warning svc: the entry file README.md is missing from the clone, preview with `globu reprobe svc --dry-run`"
    ]);
  });

  it("notices a clone that is behind its remote as last fetched", () => {
    const sandbox = tempDir();
    const managedRemote = initRepo(path.join(sandbox, "remotes/managed"), { "README.md": "x" });
    const userRemote = initRepo(path.join(sandbox, "remotes/mine"), { "README.md": "x" });
    register({ locator: `file://${managedRemote}`, cwd: sandbox, description: "d", useWhen: "u" });
    register({ locator: `file://${userRemote}`, cwd: sandbox, dest: "work/mine", description: "d", useWhen: "u" });
    expect(doctor()).toEqual([]);

    write(managedRemote, "README.md", "y");
    commitAll(managedRemote);
    write(userRemote, "README.md", "y");
    commitAll(userRemote);
    write(userRemote, "README.md", "z");
    commitAll(userRemote);
    expect(doctor()).toEqual([]);

    git(path.join(clonesDir(), "managed"), "fetch", "-q");
    git(path.join(sandbox, "work/mine"), "fetch", "-q");
    expect(messages()).toEqual([
      "warning managed: the clone is 1 commit behind origin/main as last fetched, run `globu sync`",
      "warning mine: the clone is 2 commits behind origin/main as last fetched, pull it"
    ]);
  });

  it("reports clone problems as errors", () => {
    const sandbox = tempDir();
    const repo = initRepo(path.join(sandbox, "svc"), { "README.md": "x" });
    git(repo, "remote", "add", "origin", "https://example.com/acme/svc.git");
    register({ locator: repo, cwd: repo, description: "d", useWhen: "u" });

    git(repo, "remote", "set-url", "origin", "https://example.com/acme/other.git");
    expect(messages()).toEqual([
      "error svc: the clone's origin does not match the manifest (https://example.com/acme/svc.git)"
    ]);

    fs.rmSync(path.join(repo, ".git"), { recursive: true });
    expect(messages()).toEqual([`error svc: ${repo} is not a git repository`]);

    fs.rmSync(repo, { recursive: true });
    expect(messages()).toEqual([`error svc: clone is missing at ${repo}`]);

    fs.rmSync(statePath());
    expect(messages()).toEqual(["error svc: not cloned on this machine, run `globu sync`"]);
  });

  it("reports Claude settings paths that no shard uses any more", () => {
    const sandbox = tempDir();
    const repo = initRepo(path.join(sandbox, "a"), { "README.md": "x" });
    git(repo, "remote", "add", "origin", "https://example.com/acme/a.git");
    register({ locator: repo, cwd: repo, description: "d", useWhen: "u" });
    syncClaudeDirectories(false);
    expect(doctor()).toEqual([]);

    unregister("a", false);
    expect(messages()).toEqual([
      `warning claude-settings: ${repo} belongs to no registered shard, run \`globu claude sync\``
    ]);

    fs.rmSync(repo, { recursive: true });
    expect(messages()).toEqual([`warning claude-settings: ${repo} no longer exists, run \`globu claude sync\``]);
  });
});
