import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, initRepo, tempDir, write } from "../../testing/index.js";
import { workerMain } from "./cli.js";
import type { JiraClient } from "./jira.js";

const CONFIG = `
jira:
  site: https://acme.atlassian.net
  jql: project = MR
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend]
poll:
  every: 1s
`;

function env(): NodeJS.ProcessEnv {
  return {
    GLOBU_HOME: process.env.GLOBU_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    JIRA_EMAIL: "bot@acme.example",
    JIRA_API_TOKEN: "secret"
  };
}

function prepare(): string {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  const remote = initRepo(path.join(root, "remotes/backend"), { "README.md": "backend\n" });
  register({ locator: `file://${remote}`, cwd: root, dest: path.join(home, "work/backend") });
  write(home, "worker.yaml", CONFIG);
  return root;
}

function quiet() {
  return { signals: new EventEmitter() };
}

function idleJira(onSearch: () => void = () => {}): JiraClient {
  return {
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async () => {
      onSearch();
      return [];
    },
    issue: async (key) => {
      throw new Error(`no ${key}`);
    },
    assign: async () => {},
    transitionTo: async () => {},
    comment: async () => {},
    addLabel: async () => {},
    remoteLink: async () => {}
  };
}

describe("globu-worker", () => {
  it("prints help and the version", async () => {
    const io = captureIo(tempDir());
    expect(await workerMain(["--help"], io, {}, quiet())).toBe(0);
    expect(io.stdout).toContain("once [options]");
    expect(io.stdout).toContain("GLOBU_HOME defaults to ~/.globu/worker");
    const version = captureIo(tempDir());
    expect(await workerMain(["--version"], version, {}, quiet())).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(await workerMain(["nope"], captureIo(tempDir()), {}, quiet())).toBe(1);
  });

  it("refuses the interactive homes and starts without a configuration", async () => {
    const io = captureIo(tempDir());
    expect(await workerMain(["once"], io, { GLOBU_HOME: path.join(os.homedir(), ".globu") }, quiet())).toBe(1);
    expect(io.stderr).toContain("globu-worker: GLOBU_HOME points at");
    const missing = captureIo(tempDir());
    expect(await workerMain(["once"], missing, env(), quiet())).toBe(1);
    expect(missing.stderr).toContain("globu-worker: no worker configuration at");
  });

  it("reads the registry from the default home when GLOBU_HOME is unset", async () => {
    const saved = { HOME: process.env.HOME, GLOBU_HOME: process.env.GLOBU_HOME };
    const fakeHome = tempDir();
    process.env.HOME = fakeHome;
    try {
      const io = captureIo(fakeHome);
      expect(await workerMain(["once"], io, { JIRA_EMAIL: "b", JIRA_API_TOKEN: "s" }, quiet())).toBe(1);
      expect(io.stderr).toContain(`no worker configuration at ${path.join(fakeHome, ".globu/worker/worker.yaml")}`);
      expect(process.env.GLOBU_HOME).toBe(path.join(fakeHome, ".globu/worker"));
    } finally {
      process.env.HOME = saved.HOME;
      process.env.GLOBU_HOME = saved.GLOBU_HOME;
    }
  });

  it("builds its Jira client from the configuration and checks the shards before calling it", async () => {
    const root = prepare();
    write(process.env.GLOBU_HOME as string, "worker.yaml", CONFIG.replace("[backend]", "[ghost]"));
    const io = captureIo(root);
    expect(await workerMain(["once"], io, env(), quiet())).toBe(1);
    expect(io.stderr).toContain('globu-worker: shard "ghost" is not registered');
  });

  it("runs one cycle and prints the result as JSON on request", async () => {
    const root = prepare();
    const io = captureIo(root);
    expect(await workerMain(["once", "--dry-run"], io, env(), { ...quiet(), jira: idleJira() })).toBe(0);
    expect(io.stdout).toBe("nothing eligible\n");
    const json = captureIo(root);
    expect(await workerMain(["once", "--json"], json, env(), { ...quiet(), jira: idleJira() })).toBe(0);
    expect(JSON.parse(json.stdout.split("\n").slice(1).join("\n"))).toEqual({ runs: [], plan: [] });
  });

  it("loops until a signal arrives, during a cycle or during the pause", async () => {
    const root = prepare();
    const signals = new EventEmitter();
    const during = captureIo(root);
    const jira = idleJira(() => signals.emit("SIGINT"));
    expect(await workerMain(["run"], during, env(), { jira, signals })).toBe(0);
    expect(during.stdout).toBe("stopping after the current cycle\nnothing eligible\n");

    const later = new EventEmitter();
    const paused = captureIo(root);
    const started = Date.now();
    const pending = workerMain(["run"], paused, env(), { jira: idleJira(), signals: later });
    setTimeout(() => later.emit("SIGTERM"), 50);
    expect(await pending).toBe(0);
    expect(Date.now() - started).toBeLessThan(900);
    expect(paused.stdout).toBe("nothing eligible\nstopping after the current cycle\n");
  });
});
