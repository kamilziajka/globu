import { afterEach, describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import type { Runner, RunOptions, RunResult } from "./exec.js";
import { type Logger, setLogger, silentLogger } from "./logger.js";
import { issueUrl, type Notice, notify } from "./notify.js";

type Entry = { level: string; msg: string; fields?: Record<string, unknown> };

function memory(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => entries.push({ level, msg, fields });
  return { logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") }, entries };
}

function config(extra = ""): WorkerConfig {
  return loadWorkerConfig(
    write(
      tempDir(),
      "worker.yaml",
      `
jira:
  site: https://acme.atlassian.net/
  jql: project = MR
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend]
${extra}
`
    )
  );
}

const NOTICE: Notice = {
  event: "handed-back",
  key: "MR-7",
  url: "https://github.com/acme/backend/pull/3",
  message: "MR-7 handed back: https://github.com/acme/backend/pull/3"
};

type Call = { command: string; args: string[]; options: RunOptions };

function runner(result: Partial<RunResult>, calls: Call[]): Runner {
  return async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
}

afterEach(() => setLogger(silentLogger));

describe("issueUrl", () => {
  it("links the issue on the site", () => {
    expect(issueUrl(config(), "MR-7")).toBe("https://acme.atlassian.net/browse/MR-7");
  });
});

describe("notify", () => {
  const env = { PATH: "/usr/bin", GH_TOKEN: "gh", JIRA_API_TOKEN: "jira", CLAUDE_CODE_OAUTH_TOKEN: "oauth", NTFY: "t" };

  it("does nothing without a command", async () => {
    const calls: Call[] = [];
    await notify({ config: config(), env, run: runner({}, calls), home: "/h" }, NOTICE);
    expect(calls).toEqual([]);
  });

  it("runs the command through the setup shell with the event as arguments and variables, secrets stripped", async () => {
    const { logger, entries } = memory();
    setLogger(logger);
    const calls: Call[] = [];
    const notifying = config("notify:\n  command: ./tell.sh\n  timeout: 5s");
    await notify({ config: notifying, env, platform: "linux", run: runner({}, calls), home: "/h" }, NOTICE);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe("sh");
    expect(call.args).toEqual(["-c", "./tell.sh", "globu-worker", "handed-back", "MR-7", NOTICE.url]);
    expect(call.options.cwd).toBe("/h");
    expect(call.options.timeoutMs).toBe(5000);
    expect(call.options.env).toEqual({
      PATH: "/usr/bin",
      NTFY: "t",
      GLOBU_EVENT: "handed-back",
      GLOBU_ISSUE: "MR-7",
      GLOBU_URL: NOTICE.url,
      GLOBU_MESSAGE: NOTICE.message
    });
    expect(entries).toEqual([
      { level: "info", msg: "notified", fields: { event: "handed-back", key: "MR-7", url: NOTICE.url } }
    ]);
  });

  it("logs a failure and never throws", async () => {
    const { logger, entries } = memory();
    setLogger(logger);
    const notifying = config("notify:\n  command: ./tell.sh");
    const deps = (run: Runner, platform: NodeJS.Platform = "darwin") => ({
      config: notifying,
      env: { PATH: tempDir() },
      platform,
      run,
      home: "/h"
    });
    await notify(deps(runner({ timedOut: true, code: null }, [])), NOTICE);
    await notify(deps(runner({ code: 7, stderr: "no route\n" }, [])), NOTICE);
    await notify(deps(runner({ code: null, startError: "ENOENT" }, [])), NOTICE);
    await notify(
      deps(async () => {
        throw new Error("spawn exploded");
      }),
      NOTICE
    );
    await notify(deps(runner({}, []), "win32"), NOTICE);
    await notify({ ...deps(runner({}, [])), platform: undefined }, NOTICE);
    expect(entries.map((entry) => [entry.level, entry.fields?.error])).toEqual([
      ["warn", "timed out"],
      ["warn", "exited with 7: no route"],
      ["warn", "could not start sh: not found on PATH"],
      ["warn", "spawn exploded"],
      ["warn", "could not find sh for the setup commands, install Git for Windows or add its bin directory to PATH"],
      ["info", undefined]
    ]);
  });
});
