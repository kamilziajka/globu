import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseIndex, captureIo, escapeRegExp, native, read, tempDir, write } from "../../testing/index.js";
import { workerMain } from "./cli.js";
import {
  cmdLauncher,
  launcherDir,
  launcherMain,
  shLauncher,
  WORKER_SCRIPT,
  withDirOnPath,
  writeLaunchers
} from "./launcher.js";

const DOC = "---\ntype: Note\ntitle: A\ndescription: a\n---\n\n# A\n";

function base(): string {
  const root = tempDir();
  write(root, "wiki/index.md", baseIndex("demo"));
  write(root, "wiki/a.md", DOC);
  return root;
}

describe("launchers", () => {
  it("run the worker's own script with the globu command and every argument", () => {
    expect(shLauncher("/usr/bin/node", "/opt/it's/globu-worker.mjs", "linux")).toBe(
      `#!/bin/sh\nexec '/usr/bin/node' '/opt/it'\\''s/globu-worker.mjs' globu "$@"\n`
    );
    expect(shLauncher("C:\\node\\node.exe", "C:\\w\\globu-worker.mjs", "win32")).toBe(
      `#!/bin/sh\nexec 'C:/node/node.exe' 'C:/w/globu-worker.mjs' globu "$@"\n`
    );
    expect(cmdLauncher("C:\\node\\node.exe", "C:\\w\\globu-worker.mjs")).toBe(
      `@"C:\\node\\node.exe" "C:\\w\\globu-worker.mjs" globu %*\r\n`
    );
  });

  it("are written to the bin directory of the home and rewritten only when they change", () => {
    const home = tempDir();
    const dir = launcherDir(home);
    expect(dir).toBe(path.join(home, "bin"));
    writeLaunchers(dir, "/usr/bin/node", "/opt/globu-worker.mjs", "linux");
    const sh = path.join(dir, "globu");
    expect(read(sh)).toBe(shLauncher("/usr/bin/node", "/opt/globu-worker.mjs", "linux"));
    expect(read(dir, "globu.cmd")).toBe(cmdLauncher("/usr/bin/node", "/opt/globu-worker.mjs"));
    if (process.platform !== "win32") expect(fs.statSync(sh).mode & 0o111).not.toBe(0);
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(sh, old, old);
    writeLaunchers(dir, "/usr/bin/node", "/opt/globu-worker.mjs", "linux");
    expect(fs.statSync(sh).mtime).toEqual(old);
    writeLaunchers(dir, "/usr/local/bin/node", "/opt/globu-worker.mjs", "linux");
    expect(read(sh)).toContain("'/usr/local/bin/node'");
  });

  it("point at the module they are built into", () => {
    expect(path.basename(WORKER_SCRIPT)).toBe("launcher.ts");
  });

  it("go first on the PATH, under the name the environment already uses", () => {
    expect(withDirOnPath({ PATH: "/usr/bin" }, "/w/bin", "linux")).toEqual({ PATH: "/w/bin:/usr/bin" });
    expect(withDirOnPath({ Path: "C:\\Windows", HOME: "h" }, "C:\\w\\bin", "win32")).toEqual({
      Path: "C:\\w\\bin;C:\\Windows",
      HOME: "h"
    });
    expect(withDirOnPath({}, "/w/bin", "linux")).toEqual({ PATH: "/w/bin" });
  });
});

describe("globu in a worker run", () => {
  it("stamps generated on concept docs", async () => {
    const root = base();
    const io = captureIo(root);
    expect(await workerMain(["globu", "base", "stamp", "wiki/a.md"], io, {}, { signals: new EventEmitter() })).toBe(0);
    expect(io.stdout).toMatch(new RegExp(`^generated\\t${escapeRegExp(native("wiki/a.md"))}\\tglobu/`));
    expect(read(root, "wiki/a.md")).toMatch(/^generated: \{ by: "globu\/[^"]+", at: \S+Z \}$/m);
  });

  it("refuses a verification, other commands, options and a missing file list", () => {
    const root = base();
    const cases: [string[], string][] = [
      [["base", "stamp", "wiki/a.md", "--verified"], "a verification needs a person"],
      [["base", "stamp", "--verified", "wiki/a.md"], "a verification needs a person"],
      [["base", "validate", "wiki"], "a worker run has only `globu base stamp <files...>`"],
      [[], "a worker run has only `globu base stamp <files...>`"],
      [["base", "stamp", "--json", "wiki/a.md"], "unknown option --json, usage: globu base stamp <files...>"],
      [["base", "stamp"], "usage: globu base stamp <files...>"]
    ];
    for (const [args, message] of cases) {
      const io = captureIo(root);
      expect(launcherMain(args, io)).toBe(2);
      expect(io.stderr).toContain(message);
    }
    expect(read(root, "wiki/a.md")).toBe(DOC);
  });

  it("reports a file that is not a concept doc", () => {
    const root = base();
    const io = captureIo(root);
    expect(launcherMain(["base", "stamp", "wiki/index.md"], io)).toBe(1);
    expect(io.stderr).toContain("is not a concept doc of an OKF base");
  });
});
