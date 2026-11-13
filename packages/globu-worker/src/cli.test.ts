import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, initRepo, tempDir, write } from "../../testing/index.js";
import { workerMain } from "./cli.js";
import { type Runner, spawnRunner } from "./exec.js";
import type { JiraClient, JiraIssue } from "./jira.js";

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

const INIT = JSON.stringify({ type: "system", subtype: "init", model: "m", skills: ["globu:issue-deliver"] });
const RESULT = JSON.stringify({ type: "result", is_error: false, result: "OK", total_cost_usd: 0.08 });

const healthy: Runner = async (command) => ({
  code: 0,
  stdout: command === "gh" ? "octocat\n" : command === "claude" ? `${INIT}\n${RESULT}\n` : "",
  stderr: "",
  timedOut: false
});

function withGithub(): NodeJS.ProcessEnv {
  return { ...env(), GH_TOKEN: "gh-token" };
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

function sessionJira(): JiraClient {
  const stored: JiraIssue = {
    key: "MR-1",
    summary: "Add the thing",
    description: "",
    labels: ["repo:backend"],
    status: "To Do",
    statusId: "1",
    assignee: null,
    comments: [],
    fields: {}
  };
  return {
    ...idleJira(),
    search: async () => ["MR-1"],
    issue: async () => structuredClone(stored),
    assign: async (_key, accountId) => {
      stored.assignee = accountId;
    },
    transitionTo: async (_key, status) => {
      stored.status = status;
    }
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
    const repair = captureIo(root);
    const args = ["once", "--repair", "https://github.com/acme/backend/pull/9"];
    expect(await workerMain(args, repair, env(), { ...quiet(), jira: idleJira() })).toBe(1);
    expect(repair.stderr).toContain("set GH_TOKEN to repair pull requests");
  });

  it("serves a session with poll, claim, finish and release", async () => {
    const root = prepare();
    const jira = sessionJira();
    const poll = captureIo(root);
    expect(await workerMain(["poll"], poll, env(), { ...quiet(), jira })).toBe(0);
    expect(poll.stdout).toBe("MR-1\twould claim and run in backend (0 references resolved)\n");
    const pollJson = captureIo(root);
    expect(await workerMain(["poll", "--json"], pollJson, env(), { ...quiet(), jira })).toBe(0);
    expect(JSON.parse(pollJson.stdout.split("\n").slice(1).join("\n")).plan).toHaveLength(1);
    const at = (second: number) => ({ now: () => new Date(`2026-11-07T10:00:0${second}.000Z`) });
    const claim = captureIo(root);
    expect(await workerMain(["claim", "MR-1", "--json"], claim, env(), { ...quiet(), jira, ...at(1) })).toBe(0);
    const result = JSON.parse(claim.stdout.split("\n").slice(1).join("\n"));
    expect(result.record.state).toBe("prepared");
    expect(result.tree).toBe(path.join(result.dir, "tree"));
    const finish = captureIo(root);
    expect(await workerMain(["finish", result.record.id], finish, env(), { ...quiet(), jira })).toBe(0);
    expect(finish.stdout).toBe("MR-1\treleased: the run made no commits\n");

    const runId = (io: { stdout: string }) =>
      io.stdout.split("\t")[1].replace("prepared ", "").trim().split("/").at(-1) as string;
    const second = captureIo(root);
    expect(await workerMain(["claim", "MR-1"], second, env(), { ...quiet(), jira, ...at(2) })).toBe(0);
    const finishJson = captureIo(root);
    expect(await workerMain(["finish", runId(second), "--json"], finishJson, env(), { ...quiet(), jira })).toBe(0);
    expect(JSON.parse(finishJson.stdout.split("\n").slice(1).join("\n")).state).toBe("released");

    const third = captureIo(root);
    expect(await workerMain(["claim", "MR-1"], third, env(), { ...quiet(), jira, ...at(3) })).toBe(0);
    const release = captureIo(root);
    expect(
      await workerMain(["release", runId(third), "--reason", "x", "--json"], release, env(), { ...quiet(), jira })
    ).toBe(0);
    expect(JSON.parse(release.stdout.split("\n").slice(1).join("\n")).reason).toBe("x");

    const fourth = captureIo(root);
    expect(await workerMain(["claim", "MR-1"], fourth, env(), { ...quiet(), jira, ...at(4) })).toBe(0);
    const plain = captureIo(root);
    expect(await workerMain(["release", runId(fourth), "--reason", "y"], plain, env(), { ...quiet(), jira })).toBe(0);
    expect(plain.stdout).toBe("MR-1\treleased: y\n");
    const twice = captureIo(root);
    expect(await workerMain(["release", runId(fourth), "--reason", "y"], twice, env(), { ...quiet(), jira })).toBe(1);
    expect(twice.stderr).toContain("is already released");
    const done = captureIo(root);
    expect(await workerMain(["finish", runId(fourth), "--json"], done, env(), { ...quiet(), jira })).toBe(1);
    expect(done.stderr).toContain("only a prepared run can be finished");
  });

  it("logs at the level of the flag, the environment or info, and refuses an unknown one", async () => {
    const root = prepare();
    const home = process.env.GLOBU_HOME as string;
    const now = () => new Date("2026-11-13T08:00:00.000Z");
    const file = path.join(home, "logs/worker-2026-11-13.log");
    const read = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
    const quietLevel = { ...env(), GLOBU_LOG_LEVEL: "error" };
    expect(
      await workerMain(["once", "--dry-run"], captureIo(root), quietLevel, { ...quiet(), jira: idleJira(), now })
    ).toBe(0);
    expect(read()).toBe("");
    expect(await workerMain(["once", "--dry-run"], captureIo(root), env(), { ...quiet(), jira: idleJira(), now })).toBe(
      0
    );
    expect(JSON.parse(read().trim())).toMatchObject({ level: "info", msg: "cycle", dryRun: true, eligible: [] });
    const args = ["--log-level", "warn", "once", "--dry-run"];
    expect(await workerMain(args, captureIo(root), env(), { ...quiet(), jira: idleJira(), now })).toBe(0);
    expect(read().trim().split("\n")).toHaveLength(1);
    const bad = captureIo(root);
    expect(await workerMain(["--log-level", "loud", "once"], bad, env(), quiet())).toBe(1);
    expect(bad.stderr).toContain('globu-worker: invalid log level "loud"');
  });

  it("reads secrets.env from the home, lets the environment win and passes only the Claude credential to claude", async () => {
    const root = prepare();
    const home = process.env.GLOBU_HOME as string;
    const file = write(
      home,
      "secrets.env",
      "JIRA_EMAIL=file@acme.example\nJIRA_API_TOKEN=file-token\nANTHROPIC_API_KEY=sk-file-key\n"
    );
    fs.chmodSync(file, 0o640);
    const seen: NodeJS.ProcessEnv[] = [];
    const run: Runner = async (command, _args, options = {}) => {
      if (command === "claude") seen.push(options.env as NodeJS.ProcessEnv);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const given = { GLOBU_HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, JIRA_API_TOKEN: "env-token" };
    const io = captureIo(root);
    const args = ["--log-level", "debug", "once", "--issue", "MR-1"];
    expect(await workerMain(args, io, given, { ...quiet(), jira: sessionJira(), run })).toBe(0);
    expect(io.stderr).toBe(`globu-worker: ${file} is readable by others, run chmod 600 on it\n`);
    expect(seen).toHaveLength(1);
    expect(seen[0].ANTHROPIC_API_KEY).toBe("sk-file-key");
    expect(seen[0].JIRA_API_TOKEN).toBeUndefined();
    expect(seen[0].JIRA_EMAIL).toBeUndefined();
    const logs = fs
      .readdirSync(path.join(home, "logs"))
      .map((name) => fs.readFileSync(path.join(home, "logs", name), "utf8"));
    expect(logs.join("")).toContain("readable by others");
    expect(logs.join("")).not.toContain("sk-file-key");
  });

  it("checks the configuration and every access, and exits 1 when one fails", async () => {
    const missing = captureIo(tempDir());
    expect(await workerMain(["check"], missing, env(), quiet())).toBe(1);
    expect(missing.stdout).toMatch(/^FAIL {2}configuration: no worker configuration at .*worker\.yaml\n$/);

    const root = prepare();
    const ok = captureIo(root);
    expect(await workerMain(["check"], ok, withGithub(), { ...quiet(), jira: idleJira(), run: healthy })).toBe(0);
    expect(ok.stdout.split("\n").map((line) => line.split(":")[0])).toEqual([
      "ok    configuration",
      "ok    shards",
      "ok    jira",
      "ok    github",
      "ok    claude",
      ""
    ]);

    const frames: string[] = [];
    let ticks = 0;
    const terminal = {
      ...quiet(),
      jira: idleJira(),
      run: healthy,
      screen: { write: (text: string) => frames.push(text), columns: 200 },
      every: (tick: () => void) => {
        ticks += 1;
        tick();
        return () => {};
      }
    };
    expect(await workerMain(["check"], captureIo(root), withGithub(), terminal)).toBe(0);
    expect(ticks).toBe(1);
    const shown = plain(frames.join(""));
    expect(shown).toContain("✔ configuration: ");
    expect(shown).toContain("✔ github: as octocat");

    const noGithub = captureIo(root);
    expect(await workerMain(["check"], noGithub, env(), { ...quiet(), jira: idleJira(), run: healthy })).toBe(1);
    expect(noGithub.stdout).toContain("FAIL  github: set GH_TOKEN");
  });

  it("does not start the loop when a check fails", async () => {
    const root = prepare();
    const io = captureIo(root);
    expect(await workerMain(["run"], io, env(), { ...quiet(), jira: idleJira(), run: healthy })).toBe(1);
    expect(io.stdout).toContain("FAIL  github: set GH_TOKEN");
    expect(io.stdout).not.toContain("nothing eligible");
  });

  it("clones missing shards from shards.repos and hands the git token from secrets.env to Globu", async () => {
    const root = prepare();
    const home = process.env.GLOBU_HOME as string;
    const frontend = initRepo(path.join(root, "remotes/frontend"), { "README.md": "frontend\n" });
    const config = CONFIG.replace("[backend]", `[backend, frontend]\n  repos:\n    frontend: file://${frontend}`);
    write(home, "worker.yaml", config);
    write(home, "secrets.env", "GLOBU_GIT_TOKEN=git-file-token\nGLOBU_GIT_USER=oauth2\n");
    fs.chmodSync(path.join(home, "secrets.env"), 0o600);
    try {
      const io = captureIo(root);
      expect(await workerMain(["once", "--dry-run"], io, env(), { ...quiet(), jira: idleJira() })).toBe(0);
      expect(io.stdout.split("\n")[0]).toBe(
        `registered frontend from file://${frontend} in ${path.join(home, "work/frontend")}`
      );
      expect(process.env.GLOBU_GIT_TOKEN).toBe("git-file-token");
      expect(process.env.GLOBU_GIT_USER).toBe("oauth2");
    } finally {
      delete process.env.GLOBU_GIT_TOKEN;
      delete process.env.GLOBU_GIT_USER;
    }
  });

  it("starts in pick mode on a terminal and in auto mode otherwise, after the checks", async () => {
    const bad = captureIo(tempDir());
    expect(await workerMain(["start", "--mode", "fast"], bad, env(), quiet())).toBe(1);
    expect(bad.stderr).toContain('globu-worker: invalid mode "fast", use pick or auto');
    const noTerminal = captureIo(tempDir());
    expect(await workerMain(["start", "--mode", "pick"], noTerminal, env(), quiet())).toBe(1);
    expect(noTerminal.stderr).toContain("pick mode needs a terminal, use --mode auto");

    const root = prepare();
    const failing = captureIo(root);
    expect(await workerMain(["start"], failing, env(), { ...quiet(), jira: idleJira(), run: healthy })).toBe(1);
    expect(failing.stdout).toContain("FAIL  github: set GH_TOKEN");

    const frames: string[] = [];
    const interactive = {
      ...quiet(),
      jira: idleJira(),
      run: healthy,
      screen: { write: (text: string) => frames.push(text) },
      readKey: async () => "quit" as const
    };
    expect(await workerMain([], captureIo(root), withGithub(), interactive)).toBe(0);
    expect(plain(frames.join(""))).toContain("✔ claude: m answers");
    expect(plain(frames.at(-2) as string)).toContain("globu-worker in pick mode");

    const signals = new EventEmitter();
    const auto = captureIo(root);
    const jira = idleJira(() => signals.emit("SIGTERM"));
    expect(await workerMain(["start"], auto, withGithub(), { jira, signals, run: healthy })).toBe(0);
    expect(auto.stdout.trim().split("\n").at(-1)).toBe("stopping after the current cycle");
  });

  it("writes a diagnostics archive to the given path or a timestamped one in the current directory", async () => {
    const home = process.env.GLOBU_HOME as string;
    write(home, "secrets.env", "GH_TOKEN=ghp_from_file\n");
    write(home, "logs/worker-2026-11-13.log", "ghp_from_file\n");
    const run: Runner = async (command, args, options) =>
      command === "tar"
        ? spawnRunner(command, args, options)
        : { code: 0, stdout: "x 1\n", stderr: "", timedOut: false };
    const cwd = tempDir();
    const named = captureIo(cwd);
    const now = () => new Date("2026-11-13T10:42:07.000Z");
    expect(await workerMain(["diagnostics"], named, env(), { ...quiet(), run, now })).toBe(0);
    const archive = path.join(cwd, "globu-worker-diagnostics-20261113T104207Z.tar.gz");
    expect(named.stdout).toBe(`wrote ${archive} with 2 files: logs/worker-2026-11-13.log, environment.txt\n`);
    expect(fs.existsSync(archive)).toBe(true);
    const given = captureIo(cwd);
    expect(await workerMain(["diagnostics", "--out", "d.tgz"], given, env(), { ...quiet(), run })).toBe(0);
    expect(given.stdout).toContain(`wrote ${path.join(cwd, "d.tgz")} with 2 files`);
    const real = captureIo(cwd);
    expect(await workerMain(["diagnostics"], real, env(), quiet())).toBe(0);
    expect(real.stdout).toMatch(/^wrote .*globu-worker-diagnostics-\d{8}T\d{6}Z\.tar\.gz with 2 files/);
  });

  it("loops until a signal arrives, during a cycle or during the pause", async () => {
    const root = prepare();
    const signals = new EventEmitter();
    const during = captureIo(root);
    const jira = idleJira(() => signals.emit("SIGINT"));
    expect(await workerMain(["run"], during, withGithub(), { jira, signals, run: healthy })).toBe(0);
    expect(during.stdout.split("\n").slice(4).join("\n")).toBe("stopping after the current cycle\nnothing eligible\n");

    const later = new EventEmitter();
    const paused = captureIo(root);
    const started = Date.now();
    const pending = workerMain(["run"], paused, withGithub(), { jira: idleJira(), signals: later, run: healthy });
    setTimeout(() => later.emit("SIGTERM"), 50);
    expect(await pending).toBe(0);
    expect(Date.now() - started).toBeLessThan(900);
    expect(paused.stdout.split("\n").slice(4).join("\n")).toBe("nothing eligible\nstopping after the current cycle\n");
  });
});
