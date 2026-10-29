import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { baseIndex, initRepo, read, tempDir, write } from "../packages/testing/index.js";

const root = path.join(import.meta.dirname, "..");
const GLOBU = path.join(root, "packages/globu-cli/dist/globu.mjs");
const PLUGIN = "plugins/globu";
const PACKAGE = "packages/globu-cli";

type HooksFile = { hooks: Record<string, { hooks: { command: string }[] }[]> };

function runBundle(bundle: string, args: string[], input: unknown = "") {
  return spawnSync(bundle, args, {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env }
  });
}

function hookCommands(plugin: string): string[] {
  const file = JSON.parse(read(root, plugin, "hooks/hooks.json")) as HooksFile;
  return Object.values(file.hooks).flatMap((matchers) =>
    matchers.flatMap((matcher) => matcher.hooks.map((hook) => hook.command))
  );
}

describe("bundled CLI", () => {
  it("runs as a standalone executable and reads hook input from stdin", () => {
    expect(runBundle(GLOBU, ["--version"]).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);

    const repo = initRepo(path.join(tempDir(), "notes"), { "docs/index.md": baseIndex("notes") });
    expect(runBundle(GLOBU, ["register", repo, "--mode", "read"]).status).toBe(0);
    expect(runBundle(GLOBU, ["hook", "session-start"], { cwd: repo }).stdout).toContain("- **notes** (okf, read-only");

    const blocked = runBundle(GLOBU, ["hook", "guard"], { tool_input: { file_path: path.join(repo, "docs/x.md") } });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("read-only");

    expect(runBundle(GLOBU, ["set", "notes", "--mode", "ask"]).status).toBe(0);
    const asked = runBundle(GLOBU, ["hook", "guard"], { tool_input: { file_path: path.join(repo, "docs/x.md") } });
    expect(asked.status).toBe(0);
    expect(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(runBundle(GLOBU, ["nope"]).status).toBe(1);
  });

  it("bootstraps a fresh home from a team manifest", () => {
    const root = tempDir();
    const product = initRepo(path.join(root, "remotes/product"), { "docs/index.md": baseIndex("product", "Truth") });
    const notes = initRepo(path.join(root, "remotes/notes"), { "README.md": "notes\n" });
    const shards = [
      {
        id: "product",
        source: { type: "git", repo: `file://${product}` },
        format: "okf",
        roots: [{ path: "docs", name: "product", entry: "docs/index.md" }],
        description: "Truth",
        useWhen: "Product questions",
        access: "read"
      },
      {
        id: "notes",
        source: { type: "git", repo: `file://${notes}` },
        format: "generic",
        roots: [{ path: ".", entry: "README.md" }],
        description: "Notes",
        useWhen: "Notes questions"
      }
    ];
    const team = initRepo(path.join(root, "remotes/team"), {
      ".globu/manifest.yaml": YAML.stringify({ shards, contexts: { team: ["product", "notes"] } })
    });
    const home = process.env.GLOBU_HOME as string;

    expect(runBundle(GLOBU, ["import", `file://${team}`, "--context", "team", "--yes"]).status).toBe(0);
    expect(runBundle(GLOBU, ["sync"]).stdout).toMatch(/^cloned\tproduct\ncloned\tnotes\nnext: `globu claude sync`/);
    const index = runBundle(GLOBU, ["index"]).stdout;
    expect(index).toContain("# Globu knowledge shards (context: team)");
    expect(index).toContain(`- **product** (okf, read-only)\n  - Location: ${path.join(home, "clones/product")}`);
    expect(index).toContain("- **notes** (generic, read-only)");

    expect(runBundle(GLOBU, ["claude", "sync"]).status).toBe(0);
    const settings = JSON.parse(read(process.env.CLAUDE_CONFIG_DIR as string, "settings.json"));
    expect(settings.permissions.additionalDirectories).toEqual([
      path.join(home, "clones/product"),
      path.join(home, "clones/notes")
    ]);

    const target = path.join(home, "clones/product/docs/new.md");
    const blocked = runBundle(GLOBU, ["hook", "guard"], { cwd: root, tool_input: { file_path: target } });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('belongs to shard "product", which is read-only');
    const bash = runBundle(GLOBU, ["hook", "guard"], { cwd: root, tool_input: { command: `echo x > ${target}` } });
    expect(bash.status).toBe(2);
  });

  it("manages knowledge bases and validates edits", () => {
    const repo = tempDir();
    expect(runBundle(GLOBU, ["base", "setup", repo, "--name", "demo"]).status).toBe(0);
    const bad = write(repo, "docs/bad.md", "bare\n");
    const hook = runBundle(GLOBU, ["hook", "validate-edit"], { tool_input: { file_path: bad } });
    expect(hook.status).toBe(2);
    expect(hook.stderr).toContain("missing YAML frontmatter block");
  });
});

describe("published package", () => {
  it("carries the root version and ships its bundle", () => {
    const manifest = JSON.parse(read(root, PACKAGE, "package.json"));
    expect(manifest.version).toBe(JSON.parse(read(root, "package.json")).version);
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.license).toBe("MIT");
    expect(read(root, PACKAGE, "LICENSE")).toBe(read(root, "LICENSE"));
    for (const bin of Object.values<string>(manifest.bin)) {
      expect(fs.existsSync(path.join(root, PACKAGE, bin))).toBe(true);
    }
  });
});

describe("plugin hooks", () => {
  it("run the CLI from the installed package", () => {
    const { name, bin } = JSON.parse(read(root, PACKAGE, "package.json"));
    const commands = hookCommands(PLUGIN);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      for (const bundle of Object.values<string>(bin)) {
        expect(command).toContain(`"\${CLAUDE_PLUGIN_ROOT}/node_modules/${name}/${bundle}"`);
      }
      const result = spawnSync(command, {
        shell: true,
        input: "{}",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(root, PLUGIN) }
      });
      expect(result.status).toBe(0);
    }
    const { dependencies } = JSON.parse(read(root, PLUGIN, "package.json"));
    expect(Object.keys(dependencies)).toEqual([name]);
  });
});
