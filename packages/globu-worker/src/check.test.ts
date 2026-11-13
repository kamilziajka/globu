import path from "node:path";
import { describe, expect, it } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, initRepo, tempDir, write } from "../../testing/index.js";
import { checkAccess, checksLine, formatCheck } from "./check.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import type { Runner, RunResult } from "./exec.js";
import type { JiraClient } from "./jira.js";
import type { WorkerDeps } from "./worker.js";

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
`;

const INIT = JSON.stringify({ type: "system", subtype: "init", model: "claude-test", skills: ["globu:issue-deliver"] });
const RESULT = JSON.stringify({ type: "result", is_error: false, result: "OK", total_cost_usd: 0.0812 });

type Replies = Partial<Record<"gh" | "git" | "claude", Partial<RunResult>>>;
type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };

function runner(replies: Replies, calls: Call[]): Runner {
  return async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env as NodeJS.ProcessEnv, cwd: options.cwd });
    const fallback = command === "gh" ? "octocat\n" : command === "claude" ? `${INIT}\n${RESULT}\n` : "";
    const reply = replies[command as keyof Replies] ?? {};
    return { code: 0, stdout: fallback, stderr: "", timedOut: false, ...reply };
  };
}

function jira(overrides: Partial<JiraClient> = {}): JiraClient {
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async () => ["MR-1"],
    issue: unused,
    assign: unused,
    transitionTo: unused,
    comment: unused,
    addLabel: unused,
    remoteLink: unused,
    ...overrides
  };
}

type World = { home: string; config: WorkerConfig };

function world(origin = true): World {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  const remote = initRepo(path.join(root, "remotes/backend"), { "README.md": "backend\n" });
  if (origin) register({ locator: `file://${remote}`, cwd: root, dest: path.join(home, "work/backend") });
  else register({ locator: initRepo(path.join(home, "work/backend")), cwd: root, id: "backend" });
  return { home, config: configOf(CONFIG) };
}

function configOf(text: string): WorkerConfig {
  return loadWorkerConfig(write(tempDir(), "worker.yaml", text));
}

function deps(setup: World, options: { replies?: Replies; jira?: JiraClient; token?: string | null } = {}) {
  const calls: Call[] = [];
  const worker: WorkerDeps = {
    config: setup.config,
    secrets: {
      jiraEmail: "bot@acme.example",
      jiraToken: "jira-secret",
      githubToken: options.token === undefined ? "gh-token" : options.token
    },
    home: setup.home,
    claudeConfigDir: "/claude",
    jira: options.jira ?? jira(),
    run: runner(options.replies ?? {}, calls),
    io: captureIo(setup.home),
    now: () => new Date(),
    env: { PATH: process.env.PATH, JIRA_API_TOKEN: "jira-secret", ANTHROPIC_API_KEY: "sk-1" }
  };
  return { worker, calls };
}

const detail = (checks: { name: string; detail: string }[], name: string) =>
  checks.find((check) => check.name === name)?.detail;

describe("checkAccess", () => {
  it("passes when the shards, Jira, GitHub and Claude all answer", async () => {
    const { worker, calls } = deps(world());
    const reported: string[] = [];
    const checks = await checkAccess(worker, (check) => reported.push(check.name));
    expect([...reported].sort()).toEqual(["claude", "github", "jira", "shards"]);
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ["shards", true],
      ["jira", true],
      ["github", true],
      ["claude", true]
    ]);
    expect(detail(checks, "shards")).toBe("backend");
    expect(detail(checks, "jira")).toBe("https://acme.atlassian.net as Bot, the JQL matches issues");
    expect(detail(checks, "github")).toBe("as octocat, 1 deliverable repositories readable");
    expect(detail(checks, "claude")).toBe("claude-test answers in /claude with the issue-deliver skill (0.08 USD)");
    const claude = calls.find((call) => call.command === "claude") as Call;
    expect(claude.args).not.toContain("--model");
    expect(claude.args).not.toContain("--plugin-dir");
    expect(claude.env.ANTHROPIC_API_KEY).toBe("sk-1");
    expect(claude.env.JIRA_API_TOKEN).toBeUndefined();
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe("/claude");
    expect(claude.cwd).toBe(worker.home);
    const remote = calls.find((call) => call.command === "git") as Call;
    expect(remote.args.slice(-3, -1)).toEqual(["ls-remote", "--heads"]);
    expect(formatCheck(checks[0])).toBe("ok    shards: backend");
    expect(checksLine(checks)).toBe("✔ shards backend   ✔ jira Bot   ✔ github octocat   ✔ claude claude-test");
    expect(checksLine([{ name: "configuration", ok: false, detail: "missing" }])).toBe("✖ configuration");
  });

  it("names what fails in each check", async () => {
    const setup = world();
    const failing = deps(
      { ...setup, config: configOf(CONFIG.replace("[backend]", "[ghost]")) },
      {
        jira: jira({
          myself: async () => {
            throw new Error("Jira GET /myself failed: 401");
          }
        }),
        token: null
      }
    );
    const checks = await checkAccess(failing.worker);
    expect(checks.every((check) => !check.ok)).toBe(false);
    expect(detail(checks, "shards")).toContain('shard "ghost" is not registered');
    expect(detail(checks, "jira")).toBe("Jira GET /myself failed: 401");
    expect(detail(checks, "github")).toBe("set GH_TOKEN to push branches and open pull requests");
    expect(formatCheck(checks[1])).toBe("FAIL  jira: Jira GET /myself failed: 401");

    const empty = deps(setup, {
      jira: jira({ search: async () => [] }),
      replies: { gh: { code: 1, stderr: "Bad credentials\n" } }
    });
    const second = await checkAccess(empty.worker);
    expect(detail(second, "jira")).toContain("the JQL matches nothing now");
    expect(detail(second, "github")).toBe("gh api user failed: Bad credentials");

    const unreadable = deps(setup, { replies: { git: { code: 128, stderr: "Repository not found\n" } } });
    expect(detail(await checkAccess(unreadable.worker), "github")).toMatch(
      /^cannot read file:\/\/.* with GH_TOKEN: Repository not found$/
    );
  });

  it("refuses a deliverable shard without a repository URL", async () => {
    const local = deps(world(false));
    expect(detail(await checkAccess(local.worker), "github")).toBe(
      'shard "backend" has no repository URL, the worker cannot push to it'
    );
  });

  it("reports why Claude did not answer or lacks the skill, and passes the model and plugin dir", async () => {
    const setup = world();
    const config = configOf(`${CONFIG}claude:\n  model: claude-x\n  pluginDir: /plugin\n`);
    const cases: [Partial<RunResult>, string][] = [
      [{ code: 1, stdout: "", stderr: "not logged in\n" }, "claude -p failed in /claude: not logged in"],
      [{ code: 1, stdout: "" }, "claude -p failed in /claude: exit code 1"],
      [
        {
          stdout: `${INIT}\n${JSON.stringify({ type: "result", is_error: true, result: "Invalid API key", total_cost_usd: 0 })}\n`
        },
        "claude -p failed in /claude: Invalid API key"
      ],
      [{ stdout: `${INIT}\n` }, "claude -p failed in /claude: exit code 0"],
      [
        { stdout: `${RESULT}\n` },
        "the issue-deliver skill is not loaded, install the globu plugin or set claude.pluginDir"
      ],
      [
        {
          stdout: `${JSON.stringify({ type: "system", subtype: "init", skills: ["other:issue-deliver-x"] })}\n${RESULT}\n`
        },
        "the issue-deliver skill is not loaded, install the globu plugin or set claude.pluginDir"
      ]
    ];
    for (const [reply, expected] of cases) {
      const { worker, calls } = deps({ ...setup, config }, { replies: { claude: reply } });
      expect(detail(await checkAccess(worker), "claude")).toBe(expected);
      const args = (calls.find((call) => call.command === "claude") as Call).args;
      expect(args).toEqual(expect.arrayContaining(["--model", "claude-x", "--plugin-dir", "/plugin"]));
    }
    const plain = JSON.stringify({ type: "system", subtype: "init", model: "m", skills: ["issue-deliver"] });
    const { worker } = deps(setup, { replies: { claude: { stdout: `${plain}\n${RESULT}\n` } } });
    expect(detail(await checkAccess(worker), "claude")).toBe(
      "m answers in /claude with the issue-deliver skill (0.08 USD)"
    );
  });
});
