import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../../testing/index.js";
import { awakeCommand, holdAwake, keepAwake } from "./awake.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("keeping the machine awake", () => {
  it("uses caffeinate on macOS, SetThreadExecutionState through PowerShell on Windows and nothing elsewhere", () => {
    expect(awakeCommand("darwin", 42)).toEqual({ command: "caffeinate", args: ["-i", "-w", "42"] });
    expect(awakeCommand("linux", 42)).toBeNull();
    const windows = awakeCommand("win32", 42);
    expect(windows?.command).toBe("powershell.exe");
    expect(windows?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(windows?.args[3] as string, "base64").toString("utf16le");
    expect(script).toContain("SetThreadExecutionState([uint32]2147483649)");
    expect(script.split("\n").at(-1)).toBe("Wait-Process -Id 42");
  });

  it("holds a helper until it is released and does nothing without one", async () => {
    const problems: string[] = [];
    holdAwake(null, (problem) => problems.push(problem))();
    const pidFile = path.join(tempDir(), "awake.pid");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const release = holdAwake({ command: process.execPath, args: ["-e", script] }, (problem) => problems.push(problem));
    await vi.waitFor(() => expect(fs.readFileSync(pidFile, "utf8")).toMatch(/^\d+$/), 10_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    release();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), 10_000);
    expect(problems).toEqual([]);
  });

  it("reports a helper that cannot start or ends on its own", async () => {
    const problems: string[] = [];
    holdAwake({ command: "globu-no-such-helper", args: [] }, (problem) => problems.push(problem));
    holdAwake({ command: process.execPath, args: ["-e", "process.exit(3)"] }, (problem) => problems.push(problem));
    const killed = holdAwake(
      { command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"] },
      (problem) => problems.push(problem)
    );
    await vi.waitFor(() => expect(problems).toHaveLength(3), 10_000);
    killed();
    expect(problems).toHaveLength(3);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^globu-no-such-helper could not start: .*ENOENT/),
        expect.stringMatching(/ ended with (a signal|exit code 1)$/),
        `${process.execPath} ended with exit code 3`
      ])
    );
  });

  it("starts the helper of the platform for this process", () => {
    const problems: string[] = [];
    keepAwake("linux", (problem) => problems.push(problem))();
    expect(problems).toEqual([]);
  });
});
