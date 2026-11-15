import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import {
  endedByWindows,
  MachineProblem,
  machineFailure,
  notStarted,
  type Runner,
  runOrThrow,
  spawnRunner
} from "./exec.js";

describe("spawnRunner", () => {
  it("captures stdout and stderr and mirrors stdout to a file", async () => {
    const file = path.join(tempDir(), "out.log");
    const result = await spawnRunner("node", ["-e", "process.stdout.write('hi'); process.stderr.write('oops')"], {
      stdoutFile: file
    });
    expect(result).toEqual({ code: 0, stdout: "hi", stderr: "oops", timedOut: false });
    expect(fs.readFileSync(file, "utf8")).toBe("hi");
  });

  it("kills a process that outlives its timeout", async () => {
    const result = await spawnRunner("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("reports a command that cannot start", async () => {
    const result = await spawnRunner("globu-no-such-command", []);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("ENOENT");
    expect(result.startError).toBe("ENOENT");
  });
});

describe("notStarted", () => {
  it("says why a command never started and nothing for one that ran", () => {
    expect(notStarted("sh", { startError: "ENOENT" })).toBe("could not start sh: not found on PATH");
    expect(notStarted("sh", { startError: "EACCES" })).toBe("could not start sh: EACCES");
    expect(notStarted("sh", {})).toBeNull();
  });
});

describe("runOrThrow", () => {
  it("returns trimmed stdout or throws with stderr or the exit code", async () => {
    expect(await runOrThrow(spawnRunner, "node", ["-e", "console.log(' ok ')"])).toBe("ok");
    await expect(runOrThrow(spawnRunner, "node", ["-e", "console.error('bad'); process.exit(3)"])).rejects.toThrow(
      "node -e console.error('bad'); process.exit(3) failed: bad"
    );
    await expect(runOrThrow(spawnRunner, "node", ["-e", "process.exit(4)"])).rejects.toThrow("failed: exit code 4");
  });

  it("throws a machine problem for a command that cannot start or that Windows ended", async () => {
    const missing = runOrThrow(spawnRunner, "globu-no-such-command", ["x"]);
    await expect(missing).rejects.toBeInstanceOf(MachineProblem);
    await expect(missing).rejects.toThrow("could not start globu-no-such-command: not found on PATH");
    const ended: Runner = async () => ({ code: 3221225794, stdout: "", stderr: "", timedOut: false });
    const torn = runOrThrow(ended, "gh", ["pr", "comment"]);
    await expect(torn).rejects.toBeInstanceOf(MachineProblem);
    await expect(torn).rejects.toThrow("Windows ended gh with status 0xC0000142");
    const failed = runOrThrow(spawnRunner, "node", ["-e", "process.exit(4)"]);
    await expect(failed).rejects.not.toBeInstanceOf(MachineProblem);
  });
});

describe("machineFailure", () => {
  it("names a command that did not start or ended with a Windows status, and nothing else", () => {
    expect(machineFailure("git", { code: null, startError: "ENOENT" })).toBe("could not start git: not found on PATH");
    expect(machineFailure("git", { code: 3221225794 })).toBe("Windows ended git with status 0xC0000142");
    expect(endedByWindows("claude", 0xc000013a)).toBe("Windows ended claude with status 0xC000013A");
    expect(machineFailure("git", { code: 128 })).toBeNull();
    expect(machineFailure("git", { code: 0 })).toBeNull();
    expect(machineFailure("git", { code: null })).toBeNull();
  });
});
