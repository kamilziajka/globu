import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import { runOrThrow, spawnRunner } from "./exec.js";

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
});
