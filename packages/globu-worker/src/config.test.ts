import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../../globu-core/src/index.js";
import { tempDir, write } from "../../testing/index.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  defaultClaude,
  loadWorkerConfig,
  ownHomes,
  parseDuration,
  parseSecretsFile,
  projectFor,
  projectOf,
  readSecrets,
  requireProject,
  scrubbedEnv,
  secretValues,
  sessionHomes,
  settingsFor,
  withSecretsFile,
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

function legacy(text: string) {
  return loadWorkerConfig(write(tempDir(), "worker.yaml", text));
}

describe("loadWorkerConfig for a version 1 file", () => {
  it("reads the settings as defaults and the shards as one project, with a warning", () => {
    const file = write(tempDir(), "worker.yaml", MINIMAL);
    const config = loadWorkerConfig(file);
    expect(config).toEqual({
      version: 1,
      jira: {
        site: "https://acme.atlassian.net",
        jql: "project = MR AND labels = agent-eligible",
        eligibleLabel: "agent-eligible",
        blockedLabel: "agent-blocked",
        blockingLinks: ["Blocks"],
        repository: { labelPrefix: "repo:" }
      },
      order: "created ASC",
      projects: [
        {
          name: "default",
          jira: null,
          shards: ["backend"],
          worker: { statuses: { claimed: "Delivery", released: "Ready for delivery" } },
          legacy: { deliverable: ["backend"], companion: [] }
        }
      ],
      defaults: { claude: {} },
      repos: {},
      poll: { every: 60_000 },
      limits: { concurrent: 1, perShard: 1, dayUsd: 40, openPullRequests: 5, keepRuns: 100, subscription: 70 },
      claude: { configDir: "own" },
      notify: { timeout: 30_000 },
      keepAwake: true,
      warnings: [
        `${file} is a version 1 worker.yaml: its settings are read as the defaults of version 2 and its shards as one project for every other Jira project, with deliverable and companion kept as they were; see "Moving a version 1 worker.yaml" in the worker docs`
      ]
    });
    expect(settingsFor(config, config.projects[0])).toEqual({
      statuses: { claimed: "Delivery", released: "Ready for delivery" },
      exclusive: [],
      claude: { skill: "issue-deliver", maxTurns: 80, maxBudgetUsd: 5, allowedTools: DEFAULT_ALLOWED_TOOLS },
      timeout: 2_700_000,
      repairs: 2,
      git: { branchPrefix: "agent/" },
      github: { draft: false, labels: [] },
      setup: {}
    });
    expect(defaultClaude(config).skill).toBe("issue-deliver");
    expect(loadWorkerConfig(write(tempDir(), "worker.yaml", `version: 1\n${MINIMAL}`)).version).toBe(1);
  });

  it("reads durations, a field marker and the optional sections", () => {
    const config = legacy(
      `${MINIMAL.replace('labelPrefix: "repo:"', "field: customfield_10042")}
shards:
  deliverable: [backend]
  companion: [product, backend]
  repos:
    backend: https://github.com/acme/backend.git
setup:
  backend: [npm ci]
poll:
  every: 5m
limits:
  timeout: 1h
  concurrent: 2
  repairs: 0
  exclusive: [gpu]
claude:
  configDir: user
  model: claude-sonnet-5-5
  pluginDir: /src/globu/plugins/globu
  maxTurns: 20
  maxBudgetUsd: 2.5
git:
  author:
    name: Acme Agent
    email: agent@acme.example
github:
  draft: true
  labels: [agent]
`.replace("shards:\n  deliverable: [backend]\n\nshards:", "shards:")
    );
    expect(config.jira.repository).toEqual({ field: "customfield_10042" });
    expect(config.poll.every).toBe(300_000);
    expect(config.limits.concurrent).toBe(2);
    expect(config.claude).toEqual({ configDir: "user" });
    expect(config.repos).toEqual({ backend: "https://github.com/acme/backend.git" });
    expect(config.projects[0]).toMatchObject({
      shards: ["backend", "product"],
      legacy: { deliverable: ["backend"], companion: ["product", "backend"] }
    });
    expect(settingsFor(config, config.projects[0], "backend")).toMatchObject({
      exclusive: ["gpu"],
      timeout: 3_600_000,
      repairs: 0,
      claude: { model: "claude-sonnet-5-5", pluginDir: "/src/globu/plugins/globu", maxTurns: 20, maxBudgetUsd: 2.5 },
      git: { branchPrefix: "agent/", author: { name: "Acme Agent", email: "agent@acme.example" } },
      github: { draft: true, labels: ["agent"] },
      setup: { backend: ["npm ci"] }
    });
    expect(defaultClaude(config).model).toBe("claude-sonnet-5-5");
  });

  it("makes a project per Jira key that the status maps name, and one for the rest when they have a default", () => {
    const config = legacy(
      MINIMAL.replace(
        "  releasedStatus: Ready for delivery",
        "  releasedStatus:\n    KLAYBOY: To Do\n    default: To do\n  doneStatus:\n    SANDBOX: Done\n  priorityLabel: agent-next"
      )
    );
    expect(config.jira.priorityLabel).toBe("agent-next");
    expect(config.projects.map((project) => [project.name, project.jira, project.worker.statuses])).toEqual([
      ["KLAYBOY", "KLAYBOY", { claimed: "Delivery", released: "To Do" }],
      ["SANDBOX", "SANDBOX", { claimed: "Delivery", released: "To do", done: "Done" }],
      ["default", null, { claimed: "Delivery", released: "To do" }]
    ]);
    expect(config.warnings[0]).toContain("one project for KLAYBOY, SANDBOX, every other Jira project,");
    expect(projectOf("KLAYBOY-108")).toBe("KLAYBOY");
    expect(projectFor(config, "KLAYBOY-108")?.name).toBe("KLAYBOY");
    expect(projectFor(config, "MR-1")?.name).toBe("default");

    const named = legacy(MINIMAL.replace("claimedStatus: Delivery", "claimedStatus: { MR: Delivery }"));
    expect(named.projects.map((project) => project.name)).toEqual(["MR"]);
    expect(projectFor(named, "SB-2")).toBeNull();
    expect(requireProject(named, "MR-2").jira).toBe("MR");
    expect(() => requireProject(named, "SB-2")).toThrow("no project this worker serves has the Jira key SB");
    expect(() =>
      legacy(MINIMAL.replace("releasedStatus: Ready for delivery", "releasedStatus: { SB: Open }"))
    ).not.toThrow();
    expect(() =>
      legacy(
        MINIMAL.replace("claimedStatus: Delivery", "claimedStatus: { MR: Delivery }").replace(
          "releasedStatus: Ready for delivery",
          "releasedStatus: { SB: Open }"
        )
      )
    ).toThrow("jira.claimedStatus and jira.releasedStatus name no project they both cover");
  });

  it("reads follow-up issues as opt in, with the issue type per project and the defaults", () => {
    const single = legacy(MINIMAL.replace("jira:\n", "jira:\n  followUps:\n    issueType: Task\n"));
    expect(settingsFor(single, single.projects[0]).followUps).toEqual({
      issueType: "Task",
      linkType: "Relates",
      max: 10
    });
    const mapped = legacy(
      MINIMAL.replace(
        "jira:\n",
        "jira:\n  followUps:\n    issueType:\n      MR: Story\n    linkType: Relates to\n    max: 3\n"
      )
    );
    expect(mapped.defaults.followUps).toEqual({ linkType: "Relates to", max: 3 });
    expect(settingsFor(mapped, requireProject(mapped, "MR-1")).followUps).toEqual({
      issueType: "Story",
      linkType: "Relates to",
      max: 3
    });
    expect(settingsFor(mapped, requireProject(mapped, "SB-1")).followUps).toBeUndefined();
    expect(() => legacy(MINIMAL.replace("jira:\n", "jira:\n  followUps: {}\n"))).toThrow(/jira.followUps.issueType/);
  });

  it("rejects a status map without entries", () => {
    expect(() => legacy(MINIMAL.replace("claimedStatus: Delivery", "claimedStatus: {}"))).toThrow(
      /jira.claimedStatus: name at least one project or a default/
    );
  });

  it("names every invalid field with its path", () => {
    const file = write(tempDir(), "worker.yaml", "jira:\n  site: nope\n  jql: x\npoll:\n  every: soon\n");
    expect(() => loadWorkerConfig(file)).toThrow(/jira.site: /);
    expect(() => loadWorkerConfig(file)).toThrow(/poll.every: invalid duration "soon"/);
    expect(() => legacy(`${MINIMAL}limits:\n  exclusive: [../gpu]\n`)).toThrow(
      /limits.exclusive.0: a resource name is letters/
    );
    expect(() => loadWorkerConfig(file)).toThrow(/shards: /);
    expect(() => legacy(`version: 3\n${MINIMAL}`)).toThrow("version: expected 1 or 2");
  });

  it("explains a missing or empty file", () => {
    const dir = tempDir();
    expect(() => loadWorkerConfig(workerConfigPath(dir))).toThrow(
      `no worker configuration at ${path.join(dir, "worker.yaml")}`
    );
    expect(() => loadWorkerConfig(write(dir, "worker.yaml", ""))).toThrow(/root: /);
  });
});

function shard(id: string, access?: "read") {
  return {
    id,
    source: { type: "git" as const, repo: `https://github.com/acme/${id}.git` },
    format: "generic",
    roots: [{ path: "." }],
    description: "",
    useWhen: "",
    ...(access === undefined ? {} : { access })
  };
}

const STATUSES = { ready: "To Do", claimed: "In Progress", released: "To Do", done: "Done" };

function manifestOf(projects: Record<string, unknown>): () => Manifest {
  return () => ({
    version: 1,
    shards: [shard("klayboy"), shard("klayboy-website"), shard("sandbox"), shard("handbook", "read")],
    contexts: { old: ["sandbox"] },
    imports: [],
    projects: projects as Manifest["projects"]
  });
}

const PROJECTS = {
  klayboy: {
    shards: ["klayboy*"],
    jira: "KLAYBOY",
    worker: {
      statuses: STATUSES,
      exclusive: ["gpu"],
      filter: "type != Epic",
      claude: { maxBudgetUsd: 8 },
      setup: { klayboy: ["npm ci"] },
      shards: { "klayboy-website": { claude: { model: "claude-haiku-5-5" }, timeout: "10m", github: { draft: true } } }
    }
  },
  sandbox: {
    shards: ["sandbox", "handbook"],
    jira: "SB",
    worker: { statuses: { claimed: "Doing", released: "Open" } }
  },
  notes: { shards: ["handbook"] }
};

const V2 = `
version: 2
jira:
  site: https://acme.atlassian.net
order: priority DESC
defaults:
  claude: { model: claude-sonnet-5-5, maxTurns: 40, maxBudgetUsd: 5 }
  git: { branchPrefix: bot/ }
  github: { labels: [agent] }
  followUps: { linkType: Blocks }
limits: { concurrent: 2 }
notify: { command: ./notify.sh "$@" }
`;

function v2(text: string, projects: Record<string, unknown> = PROJECTS) {
  return loadWorkerConfig(write(tempDir(), "worker.yaml", text), manifestOf(projects));
}

describe("loadWorkerConfig for a version 2 file", () => {
  it("keeps the machine's settings and reads the projects from the manifest", () => {
    const config = v2(V2);
    expect(config).toMatchObject({
      version: 2,
      jira: {
        site: "https://acme.atlassian.net",
        eligibleLabel: "agent-eligible",
        blockedLabel: "agent-blocked",
        repository: { labelPrefix: "repo:" }
      },
      order: "priority DESC",
      repos: {},
      limits: { concurrent: 2, perShard: 1, dayUsd: 40 },
      claude: { configDir: "own" },
      keepAwake: true,
      warnings: []
    });
    expect(config.jira.jql).toBeUndefined();
    expect(config.projects.map((project) => [project.name, project.jira, project.shards, project.legacy])).toEqual([
      ["klayboy", "KLAYBOY", ["klayboy", "klayboy-website"], undefined],
      ["sandbox", "SB", ["sandbox", "handbook"], undefined]
    ]);
    expect(v2(`${V2}projects: [sandbox]\n`).projects.map((project) => project.name)).toEqual(["sandbox"]);
    const plain = v2("version: 2\njira: { site: https://acme.atlassian.net }\n");
    expect(plain.order).toBe("created ASC");
    expect(defaultClaude(plain)).toEqual({
      skill: "issue-deliver",
      maxTurns: 80,
      maxBudgetUsd: 5,
      allowedTools: DEFAULT_ALLOWED_TOOLS
    });
  });

  it("resolves a run's settings from the built-in default, the defaults, the project and its shard entry", () => {
    const config = v2(V2);
    const [klayboy, sandbox] = config.projects;
    expect(settingsFor(config, klayboy)).toEqual({
      statuses: STATUSES,
      exclusive: ["gpu"],
      filter: "type != Epic",
      claude: {
        skill: "issue-deliver",
        model: "claude-sonnet-5-5",
        maxTurns: 40,
        maxBudgetUsd: 8,
        allowedTools: DEFAULT_ALLOWED_TOOLS
      },
      timeout: 2_700_000,
      repairs: 2,
      git: { branchPrefix: "bot/" },
      github: { draft: false, labels: ["agent"] },
      setup: { klayboy: ["npm ci"] }
    });
    expect(settingsFor(config, klayboy, "klayboy")).toEqual(settingsFor(config, klayboy));
    expect(settingsFor(config, klayboy, "klayboy-website")).toMatchObject({
      claude: { model: "claude-haiku-5-5", maxTurns: 40, maxBudgetUsd: 8 },
      timeout: 600_000,
      github: { draft: true, labels: ["agent"] }
    });
    expect(settingsFor(config, sandbox)).toMatchObject({
      statuses: { claimed: "Doing", released: "Open" },
      exclusive: [],
      claude: { model: "claude-sonnet-5-5", maxBudgetUsd: 5 },
      setup: {}
    });
    expect(settingsFor(config, sandbox).followUps).toBeUndefined();
    const filing = v2(V2, {
      sandbox: { ...PROJECTS.sandbox, worker: { ...PROJECTS.sandbox.worker, followUps: { issueType: "Task" } } }
    });
    expect(settingsFor(filing, filing.projects[0]).followUps).toEqual({
      issueType: "Task",
      linkType: "Blocks",
      max: 10
    });
    expect(defaultClaude(config)).toMatchObject({ model: "claude-sonnet-5-5", maxTurns: 40, skill: "issue-deliver" });
  });

  it("refuses version 1 keys, unknown projects and projects it cannot serve", () => {
    expect(() => v2(`${V2}shards:\n  deliverable: [klayboy]\n`)).toThrow(/Unrecognized key: "shards"/);
    expect(() => v2(V2.replace("limits: { concurrent: 2 }", "limits: { timeout: 1h }"))).toThrow(
      /limits: Unrecognized key: "timeout"/
    );
    expect(() => v2(`${V2}projects: [ghost]\n`)).toThrow(
      'serves the project "ghost", which manifest.yaml does not define'
    );
    expect(() => v2(`${V2}projects: [notes]\n`)).toThrow('project "notes" in manifest.yaml has no `jira` key');
    expect(() => v2(V2, { notes: PROJECTS.notes })).toThrow(/serves no project: give a project in manifest.yaml/);
    const bare = (): Manifest => ({ version: 1, shards: [], contexts: {}, imports: [] });
    expect(() => loadWorkerConfig(write(tempDir(), "worker.yaml", V2), bare)).toThrow(/serves no project/);
    expect(() => v2(V2, { empty: { shards: ["nothing-*"], jira: "E", worker: { statuses: STATUSES } } })).toThrow(
      'project "empty" in manifest.yaml matches no registered shard'
    );
    expect(() =>
      v2(V2, { ...PROJECTS, twin: { shards: ["sandbox"], jira: "SB", worker: { statuses: STATUSES } } })
    ).toThrow("serves two projects with the Jira key SB");
    expect(() => v2(V2, { typo: { shards: ["sandbox"], jira: "T", worker: { statusses: STATUSES } } })).toThrow(
      /project "typo" in the manifest is not valid for the worker:\nworker: Unrecognized key: "statusses"/
    );
    expect(() => v2(V2, { bare: { shards: ["sandbox"], jira: "B" } })).toThrow(
      /project "bare" has incomplete worker settings:\nstatuses: /
    );
    expect(() =>
      v2(V2, { half: { shards: ["sandbox"], jira: "H", worker: { statuses: { claimed: "Doing" } } } })
    ).toThrow(/project "half" has incomplete worker settings:\nstatuses.released: /);
  });

  it("reads a manifest from the home when none is given", () => {
    const home = process.env.GLOBU_HOME as string;
    write(
      home,
      "manifest.yaml",
      `shards:\n  - id: sandbox\n    source: { type: git, repo: null }\n    format: generic\n    roots: [{ path: . }]\nprojects:\n  sandbox:\n    shards: [sandbox]\n    jira: SB\n    worker:\n      statuses: { claimed: Doing, released: Open }\n`
    );
    const config = loadWorkerConfig(
      write(home, "worker.yaml", "version: 2\njira: { site: https://acme.atlassian.net }\n")
    );
    expect(config.projects).toEqual([
      { name: "sandbox", jira: "SB", shards: ["sandbox"], worker: { statuses: { claimed: "Doing", released: "Open" } } }
    ]);
  });
});

describe("secrets.env", () => {
  it("parses KEY=value lines with comments, export, quotes and CRLF, and names a bad line by number", () => {
    const text =
      "# worker secrets\r\n\nJIRA_EMAIL = bot@acme.example\nexport GH_TOKEN=\"ghp_1\"\nANTHROPIC_API_KEY='sk-2'\nEMPTY=\n";
    expect(parseSecretsFile(text)).toEqual({
      JIRA_EMAIL: "bot@acme.example",
      GH_TOKEN: "ghp_1",
      ANTHROPIC_API_KEY: "sk-2"
    });
    expect(() => parseSecretsFile("A=1\nghp_pasted_token\n")).toThrow("secrets.env line 2 is not KEY=value");
  });

  it("merges the file under the environment and warns about loose permissions", () => {
    const home = tempDir();
    expect(withSecretsFile({ A: "1" }, home)).toEqual({ env: { A: "1" }, file: null, warnings: [] });
    const file = write(home, "secrets.env", "JIRA_API_TOKEN=from-file\nGH_TOKEN=gh-file\n");
    fs.chmodSync(file, 0o600);
    expect(withSecretsFile({ GH_TOKEN: "gh-env" }, home)).toEqual({
      env: { JIRA_API_TOKEN: "from-file", GH_TOKEN: "gh-env" },
      file,
      warnings: []
    });
    fs.chmodSync(file, 0o644);
    expect(withSecretsFile({}, home, "linux").warnings).toEqual([`${file} is readable by others, run chmod 600 on it`]);
    expect(withSecretsFile({}, home, "win32").warnings).toEqual([]);
  });
});

describe("secretValues", () => {
  it("collects the values of every secret variable that is set", () => {
    expect(secretValues({ JIRA_API_TOKEN: "t", GH_TOKEN: "", ANTHROPIC_API_KEY: "k", HOME: "/h" })).toEqual(["t", "k"]);
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

const W = path.resolve("/tmp/w");
const C = path.resolve("/tmp/c");

describe("sessionHomes", () => {
  it("uses the session's own homes, the interactive ones by default, whatever claude.configDir says", () => {
    const defaults = sessionHomes({});
    expect(defaults.home).toBe(path.join(os.homedir(), ".globu"));
    expect(defaults.claudeHome("own")).toBe(path.join(os.homedir(), ".claude"));
    const given = sessionHomes({ GLOBU_HOME: W, CLAUDE_CONFIG_DIR: C });
    expect(given.home).toBe(W);
    expect(given.claudeHome("user")).toBe(C);
  });
});

describe("ownHomes", () => {
  const USER = path.join(os.homedir(), ".claude");

  it("refuses the homes of interactive sessions", () => {
    expect(() => ownHomes({ GLOBU_HOME: path.join(os.homedir(), ".globu") })).toThrow(
      `GLOBU_HOME points at ${path.join(os.homedir(), ".globu")}, which belongs to interactive sessions`
    );
    expect(() => ownHomes({ GLOBU_HOME: W, CLAUDE_CONFIG_DIR: USER }).claudeHome("own")).toThrow(
      `CLAUDE_CONFIG_DIR points at ${USER}, which belongs to interactive sessions, set claude.configDir to user in worker.yaml to run in it on purpose`
    );
  });

  it("defaults to a worker directory inside the Globu home and a claude directory inside that", () => {
    const defaults = ownHomes({});
    expect(defaults.home).toBe(path.join(os.homedir(), ".globu/worker"));
    expect(defaults.claudeHome("own")).toBe(path.join(os.homedir(), ".globu/worker/claude"));
    expect(ownHomes({ GLOBU_HOME: W }).claudeHome("own")).toBe(path.join(W, "claude"));
    expect(ownHomes({ GLOBU_HOME: W, CLAUDE_CONFIG_DIR: C }).claudeHome("own")).toBe(C);
  });

  it("runs Claude in the user's own home when claude.configDir is user, unless CLAUDE_CONFIG_DIR names another", () => {
    expect(ownHomes({ GLOBU_HOME: W }).claudeHome("user")).toBe(USER);
    expect(ownHomes({ GLOBU_HOME: W, CLAUDE_CONFIG_DIR: USER }).claudeHome("user")).toBe(USER);
    expect(ownHomes({ GLOBU_HOME: W, CLAUDE_CONFIG_DIR: C }).claudeHome("user")).toBe(C);
  });
});
