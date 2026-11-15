import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, git, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig } from "./config.js";
import { type Runner, spawnRunner } from "./exec.js";
import type { JiraClient } from "./jira.js";
import { smokeNames, smokeTest } from "./smoke.js";
import type { WorkerDeps } from "./worker.js";

const NOW = new Date("2026-11-14T10:20:30.000Z");
const BRANCH = "agent/smoke-20261114t102030z";

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
setup:
  backend: [npm ci]
git:
  author:
    name: Acme Agent
    email: agent@acme.example
github:
  labels: [agent]
`;

type Script = { setup?: number; commit?: number; create?: number; close?: number };
type Call = { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };

const untouchable = new Proxy({} as JiraClient, {
  get: (_target, name) => () => {
    throw new Error(`the smoke test called Jira ${String(name)}`);
  }
});

function world(config = CONFIG, files: Record<string, string> = { "README.md": "backend\n" }) {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  const remote = initRepo(path.join(root, "remotes/backend"), files);
  register({ locator: `file://${remote}`, cwd: root, dest: path.join(home, "work/backend") });
  return { root, home, remote, config: loadWorkerConfig(write(root, "worker.yaml", config)) };
}

function runner(script: Script, calls: Call[]): Runner {
  return async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const result = (code = 0, stdout = "") => ({ code, stdout, stderr: code === 0 ? "" : "it broke", timedOut: false });
    if (command === "sh") return result(script.setup);
    if (command === "git" && args[0] === "commit" && script.commit !== undefined) return result(script.commit);
    if (command === "git") return await spawnRunner(command, args, options);
    if (args[1] === "create") return result(script.create, "creating...\nhttps://github.com/acme/backend/pull/9\n");
    return result(script.close);
  };
}

function deps(setup: ReturnType<typeof world>, script: Script = {}, githubToken: string | null = "gh-token") {
  const calls: Call[] = [];
  const worker: WorkerDeps = {
    config: setup.config,
    secrets: { jiraEmail: "bot@acme.example", jiraToken: "jira-secret", githubToken },
    home: setup.home,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR as string,
    jira: untouchable,
    run: runner(script, calls),
    io: captureIo(setup.root),
    now: () => NOW,
    platform: "linux",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, JIRA_API_TOKEN: "jira-secret", GH_TOKEN: "gh-token" }
  };
  return { worker, calls };
}

function remoteBranches(remote: string): string {
  return git(remote, "branch", "--list", "agent/*");
}

function leftovers(setup: ReturnType<typeof world>): void {
  expect(remoteBranches(setup.remote)).toBe("");
  expect(git(path.join(setup.home, "work/backend"), "branch", "--list", "agent/*")).toBe("");
  expect(fs.readdirSync(path.join(setup.home, "smoke"))).toEqual([]);
}

describe("smokeTest", () => {
  it("sets up, commits as the author, pushes, opens and closes a draft pull request and cleans up", async () => {
    const setup = world();
    const { worker, calls } = deps(setup);
    const seen: string[] = [];
    const checks = await smokeTest(worker, (check) => seen.push(check.name));
    expect(smokeNames(worker)).toEqual(["smoke backend"]);
    expect(seen).toEqual(["smoke backend"]);
    expect(checks).toEqual([
      {
        name: "smoke backend",
        ok: true,
        detail:
          "1 setup commands, a commit as Acme Agent <agent@acme.example>, https://github.com/acme/backend/pull/9 opened as a draft, closed and its branch deleted"
      }
    ]);
    const tree = path.join(setup.home, "smoke", "backend-20261114t102030z", "tree");
    const setupCall = calls.find((call) => call.command === "sh") as Call;
    expect(setupCall.cwd).toBe(tree);
    const commit = calls.find((call) => call.args[0] === "commit") as Call;
    expect(commit.env?.JIRA_API_TOKEN).toBeUndefined();
    expect(commit.env?.GIT_AUTHOR_NAME).toBe("Acme Agent");
    const gh = calls.filter((call) => call.command === "gh").map((call) => call.args);
    expect(gh[0]).toEqual(expect.arrayContaining(["create", "--head", BRANCH, "--draft", "--label", "agent"]));
    expect(gh[1].slice(0, 3)).toEqual(["pr", "close", "https://github.com/acme/backend/pull/9"]);
    expect(gh).toHaveLength(2);
    leftovers(setup);
  });

  it("names the step that failed and leaves nothing behind", async () => {
    const setup = world();
    const failedSetup = await smokeTest(deps(setup, { setup: 1 }).worker);
    expect(failedSetup[0].ok).toBe(false);
    expect(failedSetup[0].detail).toContain('setup command "npm ci" in backend exited with 1');
    leftovers(setup);

    const failedCommit = await smokeTest(deps(setup, { commit: 1 }).worker);
    expect(failedCommit[0].detail).toBe("git commit failed:\nit broke");
    leftovers(setup);

    const noPull = deps(setup, { create: 1 });
    const failedCreate = await smokeTest(noPull.worker);
    expect(failedCreate[0].detail).toContain("gh pr create");
    expect(noPull.calls.filter((call) => call.args.includes("--delete"))).toHaveLength(1);
    leftovers(setup);

    const stuck = deps(setup, { close: 1 });
    const failedClose = await smokeTest(stuck.worker);
    expect(failedClose[0].detail).toContain("gh pr close https://github.com/acme/backend/pull/9");
    expect(stuck.calls.filter((call) => call.args[1] === "close")).toHaveLength(2);
    leftovers(setup);
  });

  it("needs a token and a repository with commits", async () => {
    const setup = world();
    expect((await smokeTest(deps(setup, {}, null).worker))[0].detail).toBe(
      "set GH_TOKEN to push branches and open pull requests"
    );
    const root = tempDir();
    const empty = path.join(root, "remotes/empty");
    git(root, "init", "-q", "--bare", empty);
    git(path.join(setup.home, "work/backend"), "remote", "set-url", "origin", `file://${empty}`);
    expect((await smokeTest(deps(setup).worker))[0].detail).toBe(
      'the repository of shard "backend" has no commits, nothing to branch from'
    );
  });

  it("holds the exclusive resources and waits on one another process has", async () => {
    const setup = world(`${CONFIG}limits:\n  exclusive: [gpu]\n`);
    const lock = path.join(process.env.GLOBU_LOCK_DIR as string, "gpu.lock");
    const { worker, calls } = deps(setup);
    const holders: string[] = [];
    worker.run = async (command, args, options) => {
      if (command === "sh") holders.push(JSON.parse(fs.readFileSync(lock, "utf8")).holder);
      return await runner({}, calls)(command, args, options);
    };
    expect((await smokeTest(worker))[0].ok).toBe(true);
    expect(holders).toEqual(["globu-worker smoke test"]);
    expect(fs.existsSync(lock)).toBe(false);

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "render-box", holder: "klayboy render" }));
    const blocked = await smokeTest(deps(setup).worker);
    expect(blocked[0]).toEqual({
      name: "smoke backend",
      ok: false,
      detail: `waiting on gpu (held by klayboy render, pid ${process.pid} on render-box)`
    });
    expect(fs.existsSync(lock)).toBe(true);
  });
});
