import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  loadWorkerConfig,
  ownHomes,
  parseDuration,
  readSecrets,
  scrubbedEnv,
  workerConfigPath
} from "./config.js";

const MINIMAL = `
jira:
  site: https://acme.atlassian.net
  jql: project = MR AND labels = agent-eligible
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend]
`;

describe("parseDuration", () => {
  it("reads seconds, minutes and hours", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("rejects anything else", () => {
    expect(() => parseDuration("soon")).toThrow('invalid duration "soon"');
  });
});

describe("loadWorkerConfig", () => {
  it("fills the defaults", () => {
    const file = write(tempDir(), "worker.yaml", MINIMAL);
    const config = loadWorkerConfig(file);
    expect(config.jira.blockedLabel).toBe("agent-blocked");
    expect(config.shards.companion).toEqual([]);
    expect(config.poll.every).toBe(60_000);
    expect(config.limits).toEqual({ concurrent: 1, perShard: 1, timeout: 2_700_000, dayUsd: 40 });
    expect(config.claude).toEqual({
      skill: "issue-deliver",
      maxTurns: 80,
      maxBudgetUsd: 5,
      allowedTools: DEFAULT_ALLOWED_TOOLS
    });
    expect(config.git).toEqual({ branchPrefix: "agent/" });
    expect(config.github).toEqual({ draft: true, labels: [] });
  });

  it("reads durations, a field marker and the optional sections", () => {
    const file = write(
      tempDir(),
      "worker.yaml",
      `${MINIMAL.replace('labelPrefix: "repo:"', "field: customfield_10042")}
poll:
  every: 5m
limits:
  timeout: 1h
  concurrent: 2
claude:
  model: claude-sonnet-5-5
  pluginDir: /src/globu/plugins/globu
  maxTurns: 20
  maxBudgetUsd: 2.5
git:
  author:
    name: Acme Agent
    email: agent@acme.example
github:
  draft: false
  labels: [agent]
`
    );
    const config = loadWorkerConfig(file);
    expect(config.jira.repository).toEqual({ field: "customfield_10042" });
    expect(config.poll.every).toBe(300_000);
    expect(config.limits.timeout).toBe(3_600_000);
    expect(config.limits.concurrent).toBe(2);
    expect(config.claude.model).toBe("claude-sonnet-5-5");
    expect(config.claude.pluginDir).toBe("/src/globu/plugins/globu");
    expect(config.claude.maxTurns).toBe(20);
    expect(config.claude.maxBudgetUsd).toBe(2.5);
    expect(config.git.author).toEqual({ name: "Acme Agent", email: "agent@acme.example" });
    expect(config.github).toEqual({ draft: false, labels: ["agent"] });
  });

  it("names every problem with its path", () => {
    const file = write(tempDir(), "worker.yaml", "jira:\n  site: nope\n  jql: x\npoll:\n  every: soon\n");
    expect(() => loadWorkerConfig(file)).toThrow(/jira.site: /);
    expect(() => loadWorkerConfig(file)).toThrow(/poll.every: invalid duration "soon"/);
    expect(() => loadWorkerConfig(file)).toThrow(/shards: /);
  });

  it("reports a missing file and an empty one", () => {
    const dir = tempDir();
    expect(() => loadWorkerConfig(workerConfigPath(dir))).toThrow(`no worker configuration at ${dir}/worker.yaml`);
    expect(() => loadWorkerConfig(write(dir, "worker.yaml", ""))).toThrow(/root: /);
  });
});

describe("readSecrets", () => {
  it("requires the Jira pair and takes either GitHub variable", () => {
    expect(() => readSecrets({})).toThrow("set JIRA_EMAIL and JIRA_API_TOKEN in the environment");
    expect(() => readSecrets({ JIRA_EMAIL: "a" })).toThrow("set JIRA_API_TOKEN in the environment");
    expect(readSecrets({ JIRA_EMAIL: "a", JIRA_API_TOKEN: "t" })).toEqual({
      jiraEmail: "a",
      jiraToken: "t",
      githubToken: null
    });
    expect(readSecrets({ JIRA_EMAIL: "a", JIRA_API_TOKEN: "t", GITHUB_TOKEN: "g" }).githubToken).toBe("g");
    expect(readSecrets({ JIRA_EMAIL: "a", JIRA_API_TOKEN: "t", GH_TOKEN: "h", GITHUB_TOKEN: "g" }).githubToken).toBe(
      "h"
    );
  });
});

describe("scrubbedEnv", () => {
  it("drops every secret and keeps the rest", () => {
    const env = scrubbedEnv({ PATH: "/bin", JIRA_API_TOKEN: "t", GH_TOKEN: "g", GLOBU_GIT_TOKEN: "x", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("ownHomes", () => {
  it("refuses the homes of interactive sessions", () => {
    expect(() => ownHomes({ GLOBU_HOME: path.join(os.homedir(), ".globu") })).toThrow(
      `GLOBU_HOME points at ${path.join(os.homedir(), ".globu")}`
    );
    expect(() => ownHomes({ GLOBU_HOME: "/tmp/w", CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude") })).toThrow(
      "CLAUDE_CONFIG_DIR points at"
    );
  });

  it("defaults to a worker directory inside the Globu home and a claude directory inside that", () => {
    expect(ownHomes({})).toEqual({
      home: path.join(os.homedir(), ".globu/worker"),
      claudeConfigDir: path.join(os.homedir(), ".globu/worker/claude")
    });
    expect(ownHomes({ GLOBU_HOME: "/tmp/w" })).toEqual({ home: "/tmp/w", claudeConfigDir: "/tmp/w/claude" });
    expect(ownHomes({ GLOBU_HOME: "/tmp/w", CLAUDE_CONFIG_DIR: "/tmp/c" })).toEqual({
      home: "/tmp/w",
      claudeConfigDir: "/tmp/c"
    });
  });
});
