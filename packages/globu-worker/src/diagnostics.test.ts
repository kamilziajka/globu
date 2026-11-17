import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { DIAGNOSTIC_RUNS, diagnosticsName, writeDiagnostics } from "./diagnostics.js";
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
  // From the archive's directory: the GNU tar of Git for Windows reads a drive letter in -f as a remote host.
  execFileSync("tar", ["-xzf", path.basename(archive), "-C", dir], { cwd: path.dirname(archive) });
  return dir;
}

describe("diagnostics", () => {
  it("names the archive after the time", () => {
    expect(diagnosticsName(new Date("2026-11-13T10:42:07.123Z"))).toBe(
      "globu-worker-diagnostics-20261113T104207Z.tar.gz"
    );
  });

  it("packs logs, run records, worker.yaml, merged.json, subscription.json, followups.json and versions, with secrets redacted", async () => {
    const home = tempDir();
    write(home, "logs/worker-2026-11-13.log", '{"msg":"command","args":["uses sk-secret-value"]}\n');
    write(home, "worker.yaml", "jira:\n  site: https://acme.atlassian.net # sk-secret-value\n");
    write(
      home,
      "merged.json",
      `${JSON.stringify({ "MR-0": { pullRequests: ["https://github.com/acme/app/pull/7"], mergedAt: "sk-secret-value" } })}\n`
    );
    write(home, "subscription.json", '{"fiveHour":{"utilization":15,"note":"sk-secret-value"}}\n');
    write(home, "followups.json", '{"MR-1":[{"summary":"Tidy up","key":"MR-9","linked":true}]}\n');
    write(home, "secrets.env", "ANTHROPIC_API_KEY=sk-secret-value\n");
    saveRun(
      path.join(home, "runs/MR-1-x"),
      newRun("MR-1", new Date("2026-11-13T10:00:00Z"), { jira: "Bot", github: null })
    );
    const out = path.join(tempDir(), "out.tar.gz");
    const { included, gaps } = await writeDiagnostics(
      { home, env: {}, run: tools(["claude"]), secrets: ["sk-secret-value"] },
      out
    );
    expect(gaps).toEqual([]);
    expect(included).toEqual([
      "logs/worker-2026-11-13.log",
      "runs/MR-1-x.json",
      "worker.yaml",
      "merged.json",
      "subscription.json",
      "followups.json",
      "environment.txt",
      "summary.txt"
    ]);
    const dir = unpack(out);
    expect(fs.readFileSync(path.join(dir, "logs/worker-2026-11-13.log"), "utf8")).toContain("uses [redacted]");
    expect(fs.readFileSync(path.join(dir, "worker.yaml"), "utf8")).toContain("# [redacted]");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "runs/MR-1-x.json"), "utf8")).key).toBe("MR-1");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "merged.json"), "utf8"))).toEqual({
      "MR-0": { pullRequests: ["https://github.com/acme/app/pull/7"], mergedAt: "[redacted]" }
    });
    expect(fs.readFileSync(path.join(dir, "subscription.json"), "utf8")).toContain('"note":"[redacted]"');
    expect(fs.readFileSync(path.join(dir, "followups.json"), "utf8")).toContain('"key":"MR-9"');
    expect(fs.existsSync(path.join(dir, "secrets.env"))).toBe(false);
    const environment = fs.readFileSync(path.join(dir, "environment.txt"), "utf8").split("\n");
    expect(environment[0]).toMatch(/^globu-worker \d+\.\d+\.\d+$/);
    expect(environment[1]).toBe(`node ${process.version}`);
    expect(environment[3]).toBe(`home ${home}`);
    expect(environment.slice(4, 7)).toEqual(["claude not available (127)", "git git 9.9.9", "gh gh 9.9.9"]);
    expect(fs.readFileSync(path.join(dir, "summary.txt"), "utf8")).toBe("gaps\tnone in the logs\n");
  });

  it("lists the gaps the logs it packs record in summary.txt", async () => {
    const home = tempDir();
    const gap = (from: string, to: string) =>
      JSON.stringify({ time: to, level: "warn", msg: "resumed after a gap", from, to });
    write(home, "logs/worker-2026-11-15.log", `${gap("2026-11-15T09:00:00.000Z", "2026-11-15T09:40:00.000Z")}\n`);
    write(home, "logs/worker-2026-11-16.log", `${gap("2026-11-15T23:14:00.000Z", "2026-11-16T05:52:00.000Z")}\n`);
    const out = path.join(tempDir(), "out.tar.gz");
    const { gaps } = await writeDiagnostics({ home, env: {}, run: tools(), secrets: [] }, out);
    expect(gaps).toEqual([
      { from: "2026-11-15T09:00:00.000Z", to: "2026-11-15T09:40:00.000Z" },
      { from: "2026-11-15T23:14:00.000Z", to: "2026-11-16T05:52:00.000Z" }
    ]);
    expect(fs.readFileSync(path.join(unpack(out), "summary.txt"), "utf8")).toBe(
      [
        "gap\tthe worker paused 2026-11-15 09:00 UTC to 2026-11-15 09:40 UTC (40 min), the machine was asleep or the worker was suspended",
        "gap\tthe worker paused 2026-11-15 23:14 UTC to 2026-11-16 05:52 UTC (6 h 38 min), the machine was asleep or the worker was suspended",
        ""
      ].join("\n")
    );
  });

  it("packs only the environment of an empty home and reports a failing tar", async () => {
    const home = tempDir();
    const out = path.join(tempDir(), "out.tar.gz");
    expect((await writeDiagnostics({ home, env: {}, run: tools(), secrets: [] }, out)).included).toEqual([
      "environment.txt",
      "summary.txt"
    ]);
    const broken: Runner = async (command, args, options) =>
      command === "tar"
        ? { code: 2, stdout: "", stderr: "disk full\n", timedOut: false }
        : tools()(command, args, options);
    await expect(writeDiagnostics({ home, env: {}, run: broken, secrets: [] }, out)).rejects.toThrow(
      "tar failed: disk full"
    );
  });

  it("packs a merged.json that does not parse as it is", async () => {
    const home = tempDir();
    write(home, "merged.json", "{ not json\n");
    const out = path.join(tempDir(), "out.tar.gz");
    expect((await writeDiagnostics({ home, env: {}, run: tools(), secrets: [] }, out)).included).toEqual([
      "merged.json",
      "environment.txt",
      "summary.txt"
    ]);
    expect(fs.readFileSync(path.join(unpack(out), "merged.json"), "utf8")).toBe("{ not json\n");
  });

  it("packs only the latest runs", async () => {
    const home = tempDir();
    const ids = Array.from({ length: DIAGNOSTIC_RUNS + 2 }, (_, index) => {
      const record = newRun(`MR-${index}`, new Date(Date.UTC(2026, 10, 1 + index)), { jira: "Bot", github: null });
      saveRun(path.join(home, "runs", record.id), record);
      return record.id;
    });
    const out = path.join(tempDir(), "out.tar.gz");
    const { included } = await writeDiagnostics({ home, env: {}, run: tools(), secrets: [] }, out);
    const runs = included.filter((name) => name.startsWith("runs/"));
    expect(runs).toEqual(ids.slice(2).map((id) => `runs/${id}.json`));
  });
});
