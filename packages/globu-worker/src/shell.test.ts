import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { findOnPath, setupShell } from "./shell.js";

describe("findOnPath", () => {
  it("looks through PATH with PATHEXT on Windows and plain names elsewhere", () => {
    const root = tempDir();
    const npm = write(root, "npm/npm.cmd", "");
    const tool = write(root, "bin/tool", "");
    fs.mkdirSync(path.join(root, "bin/folder.exe"));
    expect(findOnPath("npm", { Path: `;${root}/bin;${root}/npm`, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(npm);
    expect(findOnPath("npm", { PATH: `${root}/npm` }, "win32")).toBe(npm);
    expect(findOnPath("folder", { PATH: `${root}/bin` }, "win32")).toBeNull();
    expect(findOnPath("tool", { PATH: `${root}/npm:${root}/bin` }, "darwin")).toBe(tool);
    expect(findOnPath("tool", {}, "linux")).toBeNull();
    expect(findOnPath("tool", { PATH: `${"x".repeat(5000)}:${root}/bin` }, "linux")).toBe(tool);
  });
});

describe("setupShell", () => {
  it("uses sh outside Windows", () => {
    expect(setupShell({}, "darwin")).toBe("sh");
  });

  it("finds sh on PATH or next to Git for Windows", () => {
    const root = tempDir();
    const onPath = write(root, "tools/sh.exe", "");
    expect(setupShell({ PATH: `${root}/tools` }, "win32")).toBe(onPath);

    const git = path.join(root, "Git");
    const sh = write(git, "bin/sh.exe", "");
    for (const dir of ["cmd", "bin", "mingw64/bin"]) {
      write(git, `${dir}/git.exe`, "");
      expect(setupShell({ PATH: path.join(git, dir), PATHEXT: ".EXE" }, "win32")).toBe(sh);
    }
  });

  it("gives up without git or without sh beside it", () => {
    const root = tempDir();
    expect(setupShell({ PATH: root }, "win32")).toBeNull();
    write(root, "a/b/c/d/git.exe", "");
    expect(setupShell({ PATH: path.join(root, "a/b/c/d") }, "win32")).toBeNull();
  });
});
