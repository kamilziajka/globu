import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { diagnosticsName, writeDiagnostics } from "./diagnostics.js";
import { type Runner, spawnRunner } from "./exec.js";
import { newRun, saveRun } from "./runs.js";

function tools(missing: string[] = []): Runner {
  return async (command, args, options) => {
    if (command === "tar") return spawnRunner(command, args, options);
    if (missing.includes(command)) return { code: 127, stdout: "", stderr: "not found", timedOut: false };
    return { code: 0, stdout: `${command} 9.9.9\nmore\n`, stderr: "", timedOut: false };
  };
}

function unpack(archive: string): string {
  const dir = tempDir();
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  return dir;
}

describe("diagnostics", () => {
  it("names the archive after the time", () => {
    expect(diagnosticsName(new Date("2026-11-13T10:42:07.123Z"))).toBe(
      "globu-worker-diagnostics-20261113T104207Z.tar.gz"
    );
  });

  it("packs logs, run records, worker.yaml and versions, with secrets redacted", async () => {
    const home = tempDir();
    write(home, "logs/worker-2026-11-13.log", '{"msg":"command","args":["uses sk-secret-value"]}\n');
    write(home, "worker.yaml", "jira:\n  site: https://acme.atlassian.net # sk-secret-value\n");
    write(home, "secrets.env", "ANTHROPIC_API_KEY=sk-secret-value\n");
    saveRun(
      path.join(home, "runs/MR-1-x"),
      newRun("MR-1", new Date("2026-11-13T10:00:00Z"), { jira: "Bot", github: null })
    );
    const out = path.join(tempDir(), "out.tar.gz");
    const included = await writeDiagnostics(
      { home, env: {}, run: tools(["claude"]), secrets: ["sk-secret-value"] },
      out
    );
    expect(included).toEqual(["logs/worker-2026-11-13.log", "runs/MR-1-x.json", "worker.yaml", "environment.txt"]);
    const dir = unpack(out);
    expect(fs.readFileSync(path.join(dir, "logs/worker-2026-11-13.log"), "utf8")).toContain("uses [redacted]");
    expect(fs.readFileSync(path.join(dir, "worker.yaml"), "utf8")).toContain("# [redacted]");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "runs/MR-1-x.json"), "utf8")).key).toBe("MR-1");
    expect(fs.existsSync(path.join(dir, "secrets.env"))).toBe(false);
    const environment = fs.readFileSync(path.join(dir, "environment.txt"), "utf8").split("\n");
    expect(environment[0]).toMatch(/^globu-worker \d+\.\d+\.\d+$/);
    expect(environment[1]).toBe(`node ${process.version}`);
    expect(environment[3]).toBe(`home ${home}`);
    expect(environment.slice(4, 7)).toEqual(["claude not available (127)", "git git 9.9.9", "gh gh 9.9.9"]);
  });

  it("packs only the environment of an empty home and reports a failing tar", async () => {
    const home = tempDir();
    const out = path.join(tempDir(), "out.tar.gz");
    expect(await writeDiagnostics({ home, env: {}, run: tools(), secrets: [] }, out)).toEqual(["environment.txt"]);
    const broken: Runner = async (command, args, options) =>
      command === "tar"
        ? { code: 2, stdout: "", stderr: "disk full\n", timedOut: false }
        : tools()(command, args, options);
    await expect(writeDiagnostics({ home, env: {}, run: broken, secrets: [] }, out)).rejects.toThrow(
      "tar failed: disk full"
    );
  });
});
