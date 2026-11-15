import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { register, updateShard } from "../../globu-core/src/index.js";
import { baseIndex, captureIo, git, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import type { Runner } from "./exec.js";
import { filedFor } from "./filed.js";
import type { JiraClient, JiraIssue, NewIssue } from "./jira.js";
import { type Logger, setLogger, silentLogger } from "./logger.js";
import { loadRuns, newRun, type RunRecord, runsDir, saveRun } from "./runs.js";
import { setupShell } from "./shell.js";
import { loadSubscription, recordUsage } from "./subscription.js";
import {
  addWorktree,
  checkShards,
  claimIssue,
  cleanup,
  finishRun,
  loop,
  markerShard,
  nextCycle,
  once,
  type PresentShard,
  registry,
  releaseRun,
  type WorkerDeps
} from "./worker.js";

const NOW = new Date("2026-11-05T10:20:30.000Z");

type World = {
  root: string;
  home: string;
  remotes: Record<string, string>;
  clones: Record<string, string>;
  config: WorkerConfig;
};

function setup(overrides: Partial<WorkerConfig["shards"]> = {}): World {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  const remotes = {
    backend: initRepo(path.join(root, "remotes/backend"), {
      "docs/index.md": baseIndex("backend"),
      "src/x.ts": "export const x = 1;\n"
    }),
    product: initRepo(path.join(root, "remotes/product"), {
      "docs/index.md": baseIndex("product"),
      "docs/decisions/012-pricing.md": "---\ntype: Decision\n---\n# Pricing\n"
    }),
    notes: initRepo(path.join(root, "remotes/notes"), { "README.md": "notes\n" })
  };
  const clones = {
    backend: path.join(home, "work/backend"),
    product: path.join(home, "work/product"),
    notes: path.join(home, "clones/notes")
  };
  register({ locator: `file://${remotes.backend}`, cwd: root, dest: clones.backend });
  register({ locator: `file://${remotes.product}`, cwd: root, dest: clones.product });
  register({ locator: `file://${remotes.notes}`, cwd: root });
  const file = write(
    root,
    "worker.yaml",
    `
jira:
  site: https://acme.atlassian.net
  jql: project = MR
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend]
limits:
  concurrent: 2
  timeout: 1s
git:
  author:
    name: Acme Agent
    email: agent@acme.example
github:
  draft: true
  labels: [agent]
`
  );
  const config = loadWorkerConfig(file);
  config.shards = { ...config.shards, ...overrides };
  return { root, home, remotes, clones, config };
}

const STATUS_IDS: Record<string, string> = { "Ready for delivery": "10001", Delivery: "10023" };

function issue(key: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: "Add the thing",
    description: "Lands in `backend`, see product/docs/decisions/012-pricing.md and `src/x.ts`.",
    labels: ["agent-eligible", "repo:backend"],
    status: "Ready for delivery",
    statusId: STATUS_IDS["Ready for delivery"],
    assignee: null,
    comments: [],
    fields: {},
    ...overrides
  };
}

type FakeJira = JiraClient & {
  store: Map<string, JiraIssue>;
  comments: Record<string, string[]>;
  links: Record<string, string[]>;
  transitions: string[];
  created: NewIssue[];
  issueLinks: string[];
};

type FakeOptions = { stolen?: string[]; failTransition?: boolean; failCreate?: string; failHandback?: boolean };

function fakeJira(issues: JiraIssue[], options: FakeOptions = {}): FakeJira {
  const store = new Map(issues.map((entry) => [entry.key, structuredClone(entry)]));
  const comments: Record<string, string[]> = {};
  const links: Record<string, string[]> = {};
  const transitions: string[] = [];
  const created: NewIssue[] = [];
  const issueLinks: string[] = [];
  const get = (key: string) => {
    const found = store.get(key);
    if (found === undefined) throw new Error(`no issue ${key}`);
    return found;
  };
  return {
    store,
    comments,
    links,
    transitions,
    created,
    issueLinks,
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async () => [...store.values()].map((entry) => ({ key: entry.key, labels: entry.labels })),
    issue: async (key) => structuredClone(get(key)),
    assign: async (key, accountId) => {
      get(key).assignee = options.stolen?.includes(key) ? "someone" : accountId;
    },
    transitionTo: async (key, status) => {
      if (options.failTransition && status === "Ready for delivery") throw new Error("no transition");
      transitions.push(`${key} -> ${status}`);
      const name = Object.keys(STATUS_IDS).find((candidate) => STATUS_IDS[candidate] === status) ?? status;
      get(key).status = name;
      get(key).statusId = STATUS_IDS[name] ?? "";
    },
    comment: async (key, body) => {
      if (options.failHandback && body.includes("Pull requests:")) {
        throw new Error(`Jira POST /issue/${key}/comment failed: 500`);
      }
      comments[key] = [...(comments[key] ?? []), body];
    },
    addLabel: async (key, label) => {
      get(key).labels.push(label);
    },
    removeLabel: async () => {},
    setField: async () => {},
    remoteLink: async (key, url) => {
      links[key] = [...(links[key] ?? []), url];
    },
    createIssue: async (fields) => {
      if (fields.summary === options.failCreate) throw new Error("Jira POST /issue failed: 400 issuetype is invalid");
      created.push(fields);
      const key = `${fields.project}-${100 + created.length}`;
      store.set(key, { ...issue(key, { summary: fields.summary, description: fields.description }), labels: [] });
      return key;
    },
    linkIssues: async (type, inward, outward) => {
      issueLinks.push(`${inward} ${type} ${outward}`);
    },
    issueTypes: async () => [],
    linkTypes: async () => [],
    permissions: async () => ({})
  };
}

type Script = {
  commit?: boolean;
  companionCommit?: boolean;
  handback?: boolean | string;
  stream?: string;
  code?: number;
  stderr?: string;
  timedOut?: boolean;
  ghFails?: boolean;
  ghLoginFails?: boolean;
  startError?: string;
  setup?: { code?: number | null; timedOut?: boolean; stdout?: string; stderr?: string; startError?: string };
};
type Calls = {
  gh: string[][];
  claude: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
  setup?: { command: string; cwd: string; env: NodeJS.ProcessEnv; shell: string }[];
};

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  total_cost_usd: 1.5,
  num_turns: 9,
  result: "done"
});
const BLOCKED = JSON.stringify({
  type: "user",
  message: {
    content: [{ type: "tool_result", is_error: true, content: 'belongs to shard "notes", which is read-only' }]
  }
});

function commitIn(dir: string, file: string): void {
  write(dir, file, "export {};\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "MR-7 change");
}

function fakeRunner(script: Script, calls: Calls): Runner {
  return async (command, args, options = {}) => {
    if (/^sh(\.exe)?$/.test(path.basename(command))) {
      calls.setup?.push({
        command: args[1],
        cwd: options.cwd as string,
        env: options.env as NodeJS.ProcessEnv,
        shell: command
      });
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...script.setup };
    }
    if (command === "gh") {
      calls.gh.push(args);
      if (args[0] === "api") {
        return { code: script.ghLoginFails ? 1 : 0, stdout: "octocat\n", stderr: "", timedOut: false };
      }
      if (script.ghFails) return { code: 1, stdout: "", stderr: "label not found", timedOut: false };
      return {
        code: 0,
        stdout: `creating...\nhttps://github.com/acme/pr/${calls.gh.length}\n`,
        stderr: "",
        timedOut: false
      };
    }
    const cwd = options.cwd as string;
    calls.claude.push({ args, cwd, env: options.env as NodeJS.ProcessEnv });
    const runDir = args[args.indexOf("--add-dir") + 1];
    if (script.commit) commitIn(cwd, "src/new.ts");
    if (script.companionCommit) commitIn(path.join(runDir, "companions/product"), "docs/new.md");
    if (script.handback) {
      const text = typeof script.handback === "string" ? script.handback : "## Summary\n\nDone.\n";
      fs.writeFileSync(path.join(runDir, "handback.md"), text);
    }
    fs.appendFileSync(options.stdoutFile as string, `${script.stream ?? `${BLOCKED}\n${RESULT}`}\n`);
    const started = script.startError === undefined ? {} : { startError: script.startError };
    return {
      code: script.code ?? 0,
      stdout: "",
      stderr: script.stderr ?? "",
      timedOut: script.timedOut ?? false,
      ...started
    };
  };
}

function deps(world: World, jira: JiraClient, run: Runner, githubToken: string | null = "gh-token") {
  const io = captureIo(world.root);
  const worker: WorkerDeps = {
    config: world.config,
    secrets: { jiraEmail: "bot@acme.example", jiraToken: "jira-secret", githubToken },
    home: world.home,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR as string,
    jira,
    run,
    io,
    now: () => NOW,
    platform: "linux",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, JIRA_API_TOKEN: "jira-secret", GH_TOKEN: "gh-token" }
  };
  return { worker, io };
}

async function runWith(
  world: World,
  issues: JiraIssue[],
  script: Script,
  options: { githubToken?: string | null; jira?: Partial<Parameters<typeof fakeJira>[1]>; issue?: string } = {}
) {
  const jira = fakeJira(issues, options.jira);
  const calls: Calls = { gh: [], claude: [] };
  const { worker, io } = deps(world, jira, fakeRunner(script, calls), options.githubToken);
  const result = await once(worker, { issue: options.issue });
  return { jira, calls, io, result, record: result.runs[0] as RunRecord | undefined };
}

function expectReleased(jira: FakeJira, record: RunRecord, reason: string): void {
  expect(record.state).toBe("released");
  expect(record.reason).toContain(reason);
  const stored = jira.store.get(record.key) as JiraIssue;
  expect(stored.status).toBe("Ready for delivery");
  expect(stored.assignee).toBeNull();
  expect(stored.labels).toContain("agent-blocked");
  expect(jira.comments[record.key]?.at(-1)).toContain(`Released by the Globu worker: ${reason}`);
}

describe("checkShards", () => {
  it("demands registered, editable, writable shards", () => {
    const world = setup();
    expect(() =>
      checkShards({ ...world.config, shards: { deliverable: ["ghost"], companion: [], repos: {} } }, world.home)
    ).toThrow(`shard "ghost" is not registered in ${world.home}`);
    expect(() =>
      checkShards({ ...world.config, shards: { deliverable: ["notes"], companion: [], repos: {} } }, world.home)
    ).toThrow('shard "notes" needs an editable clone');
    fs.rmSync(world.clones.product, { recursive: true });
    expect(() =>
      checkShards({ ...world.config, shards: { deliverable: ["product"], companion: [], repos: {} } }, world.home)
    ).toThrow('shard "product" needs an editable clone');
    updateShard("backend", { mode: "read" });
    expect(() => checkShards(world.config, world.home)).toThrow('shard "backend" is read-only on this machine');
    updateShard("backend", { mode: "ask" });
    expect(() =>
      checkShards(
        { ...world.config, shards: { deliverable: ["backend"], companion: ["backend"], repos: {} } },
        world.home
      )
    ).toThrow('companion shard "backend" must be in write mode');
    updateShard("backend", { mode: "write" });
    expect(() => checkShards(world.config, world.home)).not.toThrow();
  });
});

describe("markerShard", () => {
  it("reads a label prefix or a custom field, as text or as an option", () => {
    const label = setup().config;
    const field: WorkerConfig = { ...label, jira: { ...label.jira, repository: { field: "customfield_1" } } };
    expect(markerShard(issue("MR-1"), label)).toBe("backend");
    expect(markerShard(issue("MR-1", { labels: [] }), label)).toBeNull();
    expect(markerShard(issue("MR-1", { fields: { customfield_1: "product" } }), field)).toBe("product");
    expect(markerShard(issue("MR-1", { fields: { customfield_1: { value: "product" } } }), field)).toBe("product");
    expect(markerShard(issue("MR-1", { fields: { customfield_1: { id: 3 } } }), field)).toBeNull();
    expect(markerShard(issue("MR-1", { fields: { customfield_1: null } }), field)).toBeNull();
    expect(markerShard(issue("MR-1"), field)).toBeNull();
  });
});

describe("nextCycle", () => {
  it("takes the would-be claims in plan order within the concurrent and per-shard limits", () => {
    const { config } = setup();
    const entry = (key: string, shard: string, action: string) => ({ key, summary: "", shard, action });
    const plan = [
      entry("MR-1", "backend", "skipped, already assigned"),
      entry("MR-2", "backend", "would claim and run in backend (0 references resolved)"),
      entry("MR-3", "backend", "would claim and run in backend (0 references resolved)"),
      entry("MR-4", "frontend", "would release: no deliverable marker"),
      entry("MR-5", "frontend", "would claim and run in frontend (0 references resolved)")
    ];
    const limits = (concurrent: number) => ({ ...config, limits: { ...config.limits, concurrent, perShard: 1 } });
    expect(nextCycle(limits(1), plan)).toBe("next cycle takes MR-2 (limits.concurrent 1, limits.perShard 1)");
    expect(nextCycle(limits(3), plan)).toBe("next cycle takes MR-2, MR-4 (limits.concurrent 3, limits.perShard 1)");
    expect(nextCycle(limits(1), plan.slice(0, 1))).toBe(
      "next cycle takes nothing (limits.concurrent 1, limits.perShard 1)"
    );
  });
});

describe("once", () => {
  it("in a dry run says what it would do and touches nothing", async () => {
    const world = setup();
    const jira = fakeJira([
      issue("MR-1"),
      issue("MR-2", { labels: [] }),
      issue("MR-3", { description: "see product/docs/missing.md" }),
      issue("MR-4", { assignee: "someone" })
    ]);
    const calls: Calls = { gh: [], claude: [] };
    const { worker, io } = deps(world, jira, fakeRunner({}, calls));
    const { plan, runs } = await once(worker, { dryRun: true });
    expect(runs).toEqual([]);
    expect(plan.map((entry) => entry.action)).toEqual([
      "would claim and run in backend (1 references resolved)",
      "would release: no deliverable marker",
      "would release: 1 of 1 references missing",
      "skipped, already assigned"
    ]);
    expect(io.stdout).toContain("MR-1\twould claim and run in backend (1 references resolved)");
    expect(jira.transitions).toEqual([]);
    expect(calls.claude).toEqual([]);
    expect(loadRuns(world.home)).toEqual([]);
  });

  it("says when nothing is eligible and stops at the day cap", async () => {
    const world = setup();
    const empty = deps(world, fakeJira([]), fakeRunner({}, { gh: [], claude: [] }));
    await once(empty.worker);
    expect(empty.io.stdout).toContain("nothing eligible");

    const spent = { ...newRun("MR-0", NOW, { jira: "x", github: null }), state: "released" as const, costUsd: 41 };
    saveRun(path.join(runsDir(world.home), spent.id), spent);
    const capped = deps(world, fakeJira([issue("MR-1")]), fakeRunner({}, { gh: [], claude: [] }));
    const result = await once(capped.worker);
    expect(result).toEqual({ runs: [], plan: [] });
    expect(capped.io.stdout).toContain("day cap of 40 USD reached (41.00 spent today), claiming nothing");
  });

  const notices = (calls: Calls) =>
    (calls.setup ?? [])
      .filter((call) => call.command === "notify-me")
      .map((call) => [call.env.GLOBU_EVENT, call.env.GLOBU_ISSUE, call.env.GLOBU_URL, call.env.GLOBU_MESSAGE]);
  const usage = (utilization: number) =>
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization, resetsAt: Date.parse("2026-11-05T12:00:00Z") / 1000 } }
      }
    });
  const notifying = async (world: World, issues: JiraIssue[], script: Script, env: NodeJS.ProcessEnv = {}) => {
    world.config.notify.command = "notify-me";
    const calls: Calls = { gh: [], claude: [], setup: [] };
    const { worker, io } = deps(world, fakeJira(issues), fakeRunner(script, calls), script.commit ? "gh-token" : null);
    worker.env = { ...worker.env, ...env };
    const result = await once(worker);
    return { calls, io, result };
  };

  it("notifies on a hand back, keeps the subscription figure and claims nothing past its limit", async () => {
    const world = setup();
    const handed = await notifying(world, [issue("MR-7")], {
      commit: true,
      handback: true,
      stream: `${usage(0.75)}\n${RESULT}`
    });
    expect(handed.result.runs[0].state).toBe("handed-back");
    expect(notices(handed.calls)).toEqual([
      ["handed-back", "MR-7", "https://github.com/acme/pr/2", "MR-7 handed back: https://github.com/acme/pr/2"]
    ]);
    expect(loadSubscription(world.home)?.windows).toEqual([
      { window: "five_hour", utilization: 0.75, resetsAt: "2026-11-05T12:00:00.000Z" }
    ]);

    const held = await notifying(world, [issue("MR-8")], {});
    expect(held.result).toEqual({ runs: [], plan: [] });
    expect(held.io.stdout).toContain(
      "subscription limit reached: the subscription's five-hour window is at 75 %, the limit is 70 %, it resets at 2026-11-05 12:00 UTC, claiming nothing"
    );
  });

  it("notifies on a release and ignores the subscription figure while the runs bill an API key", async () => {
    const world = setup();
    recordUsage(world.home, [{ window: "five_hour", utilization: 0.9, resetsAt: "2026-11-05T12:00:00.000Z" }], NOW);
    const released = await notifying(
      world,
      [issue("MR-8")],
      { stream: `${usage(0.2)}\n${RESULT}` },
      {
        ANTHROPIC_API_KEY: "sk"
      }
    );
    expect(released.result.runs[0].state).toBe("released");
    expect(notices(released.calls)).toEqual([
      ["released", "MR-8", "https://acme.atlassian.net/browse/MR-8", "MR-8 released: the run made no commits"]
    ]);
    expect(loadSubscription(world.home)?.windows[0].utilization).toBe(0.2);
  });

  it("claims, runs, pushes, opens draft pull requests and hands back", async () => {
    const world = setup({ companion: ["product"] });
    const comments = [{ author: "Kamil", created: "2026-11-05", body: "Also read `docs/index.md`." }];
    const { jira, calls, io, record } = await runWith(world, [issue("MR-7", { comments })], {
      commit: true,
      companionCommit: true,
      handback: true
    });
    expect(record).toMatchObject({
      key: "MR-7",
      shard: "backend",
      branch: "agent/MR-7-add-the-thing",
      state: "handed-back",
      costUsd: 1.5,
      turns: 9,
      blocked: ['belongs to shard "notes", which is read-only'],
      pullRequests: ["https://github.com/acme/pr/2", "https://github.com/acme/pr/3"],
      identity: { jira: "Bot (bot)", github: "octocat" }
    });
    expect(jira.transitions).toEqual(["MR-7 -> Delivery"]);
    expect(jira.store.get("MR-7")).toMatchObject({ status: "Delivery", assignee: "bot" });
    expect(jira.links["MR-7"]).toEqual(["https://github.com/acme/pr/2", "https://github.com/acme/pr/3"]);
    const comment = jira.comments["MR-7"][0];
    expect(comment).toContain("## Summary\n\nDone.");
    expect(comment).toContain("Pull requests:\n- https://github.com/acme/pr/2\n- https://github.com/acme/pr/3");
    expect(comment).toContain(
      "Run MR-7-20261105T102030Z as Bot (bot), GitHub octocat: 9 turns, 1.50 USD, 0.0 min. Blocked writes: 1."
    );
    expect(comment).toContain('- belongs to shard "notes", which is read-only');

    expect(calls.gh[0]).toEqual(["api", "user", "--jq", ".login"]);
    expect(calls.gh[1]).toEqual([
      "pr",
      "create",
      "--head",
      "agent/MR-7-add-the-thing",
      "--base",
      "main",
      "--title",
      "MR-7: Add the thing",
      "--body-file",
      expect.stringContaining("pull-request-backend.md"),
      "--draft",
      "--label",
      "agent"
    ]);
    expect(calls.gh[2].join(" ")).toContain("pull-request-product.md");
    for (const remote of [world.remotes.backend, world.remotes.product]) {
      expect(git(remote, "rev-parse", "--verify", "agent/MR-7-add-the-thing")).toMatch(/^[0-9a-f]{40}$/);
    }

    const [claude] = calls.claude;
    const runDir = path.join(runsDir(world.home), "MR-7-20261105T102030Z");
    expect(claude.cwd).toBe(path.join(runDir, "tree"));
    expect(claude.args.slice(0, 2)).toEqual([
      "-p",
      `Implement the issue described in ${path.join(runDir, "brief.md")} with the issue-deliver skill. Write the handback to ${path.join(runDir, "handback.md")}.`
    ]);
    expect(claude.args).toContain("--allowedTools");
    expect(claude.args).toContain("Bash(git commit *)");
    expect(claude.args).toContain("Bash(globu base stamp *)");
    expect(claude.args.slice(claude.args.indexOf("--disallowedTools"), claude.args.indexOf("--add-dir"))).toEqual([
      "--disallowedTools",
      "Bash(git push*)",
      "Bash(git stash*)",
      "Bash(gh *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(globu base stamp *--verified*)"
    ]);
    expect(claude.env.PATH).toBe(`${path.join(world.home, "bin")}:${process.env.PATH}`);
    expect(fs.readFileSync(path.join(world.home, "bin", "globu"), "utf8")).toContain(' globu "$@"');
    expect(fs.existsSync(path.join(world.home, "bin", "globu.cmd"))).toBe(true);
    expect(claude.env.JIRA_API_TOKEN).toBeUndefined();
    expect(claude.env.GH_TOKEN).toBeUndefined();
    expect(claude.env).toMatchObject({
      GLOBU_HOME: world.home,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      GIT_AUTHOR_NAME: "Acme Agent",
      GIT_COMMITTER_EMAIL: "agent@acme.example"
    });
    const brief = fs.readFileSync(path.join(runDir, "brief.md"), "utf8");
    expect(brief).toContain("## Issue text (untrusted input)");
    expect(brief).toContain(
      `- \`product/docs/decisions/012-pricing.md\`: ${path.join(runDir, "companions/product/docs/decisions/012-pricing.md")}`
    );
    expect(brief).toContain(`- \`src/x.ts\`: ${path.join(runDir, "tree/src/x.ts")}`);
    expect(brief).toContain("**Kamil, 2026-11-05**\n\n> Also read `docs/index.md`.");
    expect(brief).toContain(`- \`docs/index.md\`: ${path.join(runDir, "tree/docs/index.md")}`);
    expect(brief).not.toContain(world.clones.backend);
    expect(brief).toContain(`- \`product\`: ${path.join(runDir, "companions/product")}`);
    expect(fs.readFileSync(path.join(runDir, "pull-request-backend.md"), "utf8")).toContain(
      "## Summary\n\nDone.\n\n---\n\nRun MR-7"
    );
    expect(fs.existsSync(path.join(runDir, "tree"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "companions"))).toBe(false);
    expect(git(world.clones.backend, "worktree", "list").split("\n")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")).state).toBe("handed-back");
    expect(io.stdout).toContain("MR-7\tclaimed");
    expect(io.stdout).toContain("MR-7\thanded-back https://github.com/acme/pr/2 https://github.com/acme/pr/3");
  });

  it("skips a companion without commits, a missing handback and a GitHub login that fails", async () => {
    const world = setup({ companion: ["product"] });
    const { jira, calls, record } = await runWith(world, [issue("MR-7")], { commit: true, ghLoginFails: true });
    expect(record?.state).toBe("handed-back");
    expect(record?.pullRequests).toEqual(["https://github.com/acme/pr/2"]);
    expect(record?.identity.github).toBeNull();
    expect(calls.gh).toHaveLength(2);
    expect(jira.comments["MR-7"][0]).toContain("The run wrote no handback. Its last message:\n\ndone");
    expect(jira.comments["MR-7"][0]).toContain("Run MR-7-20261105T102030Z as Bot (bot): 9 turns");
    expect(() => git(world.remotes.product, "rev-parse", "--verify", "agent/MR-7-add-the-thing")).toThrow();
    expect(() => git(world.clones.product, "rev-parse", "--verify", "agent/MR-7-add-the-thing")).toThrow();
  });

  it("runs the setup commands of each shard in its fresh worktree before Claude", async () => {
    const world = setup({ companion: ["product"] });
    world.config.setup = { backend: ["npm ci", "npm run build"] };
    const jira = fakeJira([issue("MR-7")]);
    const calls: Calls = { gh: [], claude: [], setup: [] };
    const { worker } = deps(world, jira, fakeRunner({ commit: true }, calls));
    const { runs } = await once(worker);
    expect(runs[0].state).toBe("handed-back");
    expect(calls.setup?.map((call) => [call.command, path.basename(call.cwd)])).toEqual([
      ["npm ci", "tree"],
      ["npm run build", "tree"]
    ]);
    expect(calls.setup?.[0].env.JIRA_API_TOKEN).toBeUndefined();
    expect(calls.setup?.[0].env.GIT_AUTHOR_NAME).toBe("Acme Agent");
    expect(calls.setup?.[0].env.GLOBU_HOME).toBe(world.home);
  });

  it("releases the issue when a setup command fails or times out, before Claude runs", async () => {
    const world = setup();
    world.config.setup = { backend: ["npm ci"] };
    const failed = await runWith(world, [issue("MR-1")], {
      setup: { code: 1, stdout: "added 0 packages\n", stderr: "npm ERR! missing lockfile\n" }
    });
    expectReleased(failed.jira, failed.record as RunRecord, 'setup command "npm ci" in backend exited with 1:');
    expect(failed.record?.reason).toContain("added 0 packages\nnpm ERR! missing lockfile");
    expect(failed.calls.claude).toEqual([]);
    const slow = await runWith(world, [issue("MR-2")], { setup: { timedOut: true, code: null as unknown as number } });
    expectReleased(slow.jira, slow.record as RunRecord, 'setup command "npm ci" in backend timed out:');
  });

  it("finds Git's sh for the setup commands on Windows", async () => {
    const world = setup();
    world.config.setup = { backend: ["npm ci"] };
    const git = path.join(world.root, "Git");
    write(git, "cmd/git.exe", "");
    const sh = write(git, "bin/sh.exe", "");
    const calls: Calls = { gh: [], claude: [], setup: [] };
    const { worker } = deps(world, fakeJira([issue("MR-7")]), fakeRunner({ commit: true }, calls));
    worker.platform = "win32";
    worker.env = { ...worker.env, PATH: path.join(git, "cmd"), PATHEXT: ".EXE" };
    const run = (await once(worker)).runs[0];
    expect([run.state, run.reason]).toEqual(["handed-back", null]);
    expect(calls.setup?.map((call) => [call.shell, call.command])).toEqual([[sh, "npm ci"]]);
  });

  it("looks the setup shell up for the host platform when none is given", async () => {
    const world = setup();
    world.config.setup = { backend: ["npm ci"] };
    const calls: Calls = { gh: [], claude: [], setup: [] };
    const { worker } = deps(world, fakeJira([issue("MR-7")]), fakeRunner({ commit: true }, calls));
    delete worker.platform;
    expect((await once(worker)).runs[0].state).toBe("handed-back");
    expect(calls.setup?.map((call) => call.shell)).toEqual([setupShell(worker.env, process.platform)]);
  });

  it("releases without the blocked label when the machine cannot start the setup or Claude, and the loop stops", async () => {
    const world = setup();
    world.config.setup = { backend: ["npm ci"] };
    const machine = (jira: FakeJira, record: RunRecord, reason: string) => {
      expect(record.state).toBe("released");
      expect(record.environment).toBe(true);
      expect(record.reason).toBe(reason);
      expect((jira.store.get(record.key) as JiraIssue).labels).not.toContain("agent-blocked");
      expect(jira.comments[record.key]?.at(-1)).toContain(
        `Released by the Globu worker: ${reason}\n\nThis is a problem with the worker's machine, not with the issue, so it is not labelled agent-blocked`
      );
    };
    const unstarted = await runWith(world, [issue("MR-1")], { setup: { code: null, startError: "ENOENT" } });
    machine(
      unstarted.jira,
      unstarted.record as RunRecord,
      'setup command "npm ci" in backend: could not start sh: not found on PATH'
    );
    expect(unstarted.calls.claude).toEqual([]);

    const jira = fakeJira([issue("MR-2")]);
    const { worker, io } = deps(world, jira, fakeRunner({}, { gh: [], claude: [] }));
    worker.platform = "win32";
    worker.env = { ...worker.env, PATH: tempDir() };
    const slept: number[] = [];
    worker.config = { ...worker.config, notify: { ...worker.config.notify, command: "notify-me" } };
    expect(await loop(worker, { sleep: async (ms) => void slept.push(ms), stopped: () => false })).toBe(true);
    expect(slept).toEqual([]);
    const shellless = loadRuns(world.home).find(({ record }) => record.key === "MR-2")?.record as RunRecord;
    machine(
      jira,
      shellless,
      "could not find sh for the setup commands, install Git for Windows or add its bin directory to PATH"
    );
    expect(io.stderr).toContain("globu-worker: stopping, the machine needs fixing first: could not find sh");
    expect(io.stderr).toContain("globu-worker: could not send the stopped notification: could not find sh");

    world.config.setup = {};
    const claudeless = await runWith(world, [issue("MR-3")], { code: null as unknown as number, startError: "ENOENT" });
    machine(claudeless.jira, claudeless.record as RunRecord, "could not start claude: not found on PATH");

    world.config.notify.command = "notify-me";
    const calls: Calls = { gh: [], claude: [], setup: [] };
    const stopping = deps(world, fakeJira([issue("MR-4")]), fakeRunner({ code: 1, startError: "ENOENT" }, calls));
    await loop(stopping.worker, { sleep: async () => {}, stopped: () => false });
    expect(calls.setup?.map((call) => [call.env.GLOBU_EVENT, call.env.GLOBU_URL, call.env.GLOBU_MESSAGE])).toEqual([
      [
        "stopped",
        "https://acme.atlassian.net/browse/MR-4",
        "globu-worker stopped, the machine needs fixing first: could not start claude: not found on PATH"
      ]
    ]);
  });

  it("records denied tool calls and the time in the model API in run.json and the footer", async () => {
    const world = setup();
    const stream = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 1.25,
      num_turns: 59,
      result: "done",
      duration_ms: 798_000,
      duration_api_ms: 228_000,
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "git stash push -u" } },
        { tool_name: "Bash", tool_input: { command: "cat <<'EOF' > a.ts\nexport {};\nEOF" } },
        { tool_name: "Bash", tool_input: { command: `node -e "${"x".repeat(200)}"` } }
      ]
    });
    const { jira, record } = await runWith(world, [issue("MR-7")], { commit: true, handback: true, stream });
    expect(record).toMatchObject({ durationMs: 798_000, apiMs: 228_000, segments: 1, wallMs: 0 });
    expect(record?.denied).toHaveLength(3);
    const comment = jira.comments["MR-7"][0];
    expect(comment).toContain(", 3.8 min of it in the model API. Blocked writes: 0. Denied tool calls: 3.");
    expect(comment).toContain("- denied Bash: git stash push -u\n");
    expect(comment).toContain("- denied Bash: cat <<'EOF' > a.ts …\n");
    expect(comment).toContain(`- denied Bash: node -e "${"x".repeat(145)} …`);
  });

  it("counts every segment of a run that was woken for its background tasks", async () => {
    const world = setup();
    const segment = (turns: number, ms: number, apiMs: number, cost: number) =>
      JSON.stringify({
        type: "result",
        subtype: "success",
        num_turns: turns,
        duration_ms: ms,
        duration_api_ms: apiMs,
        total_cost_usd: cost,
        result: "done"
      });
    const stream = [
      segment(62, 357_000, 105_000, 1.41),
      segment(15, 40_000, 140_000, 1.79),
      segment(17, 287_000, 210_000, 2.25)
    ];
    const { jira, record } = await runWith(world, [issue("MR-7")], {
      commit: true,
      handback: true,
      stream: stream.join("\n")
    });
    expect(record).toMatchObject({ turns: 94, durationMs: 684_000, apiMs: 210_000, costUsd: 2.25, segments: 3 });
    expect(jira.comments["MR-7"][0]).toContain(
      ": 94 turns in 3 segments, 2.25 USD, 0.0 min, 3.5 min of it in the model API."
    );
  });

  it("opens a plain pull request without labels or a commit author and notes a run without a last message", async () => {
    const world = setup();
    world.config.git = { branchPrefix: "agent/" };
    world.config.github = { draft: false, labels: [] };
    const { jira, calls, record } = await runWith(world, [issue("MR-7")], {
      commit: true,
      stream: JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.2, num_turns: 3 })
    });
    expect(record?.state).toBe("handed-back");
    expect(calls.gh[1]).not.toContain("--draft");
    expect(calls.gh[1]).not.toContain("--label");
    expect(calls.claude[0].env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(jira.comments["MR-7"][0]).toContain("The run wrote no handback. Its last message:\n\n(none)");
  });

  it("waits on unresolved blockers, counts a merged worker pull request as resolved and names blockers in the brief", async () => {
    const world = setup();
    const link = (key: string, status: string, category: string) => ({
      type: { name: "Blocks" },
      inwardIssue: {
        key,
        fields: { summary: `Base ${key}`, status: { name: status, statusCategory: { key: category } } }
      }
    });
    const handedBack = (key: string, state: "open" | "merged") => {
      const record: RunRecord = {
        ...newRun(key, NOW, { jira: "x", github: null }),
        state: "handed-back",
        pullRequests: [`https://github.com/acme/backend/pull/${key.slice(3)}`],
        followUp: { state, repairs: 0 }
      };
      saveRun(path.join(runsDir(world.home), record.id), record);
    };
    handedBack("MR-3", "open");
    handedBack("MR-4", "merged");
    const issues = [
      issue("MR-7", {
        fields: { issuelinks: [link("MR-5", "In Review", "indeterminate"), link("MR-6", "Done", "done")] }
      }),
      issue("MR-8", { fields: { issuelinks: [link("MR-6", "Done", "done")] } }),
      issue("MR-9", { fields: { issuelinks: [link("MR-4", "In Review", "indeterminate")] } }),
      issue("MR-10", { fields: { issuelinks: [link("MR-3", "In Review", "indeterminate")] } })
    ];
    const calls: Calls = { gh: [], claude: [] };
    const { worker } = deps(world, fakeJira(issues), fakeRunner({}, calls));
    const { plan } = await once(worker, { dryRun: true });
    expect(plan.map((entry) => `${entry.key} ${entry.action}`)).toEqual([
      "MR-7 waiting on MR-5 (In Review)",
      "MR-8 would claim and run in backend (1 references resolved)",
      "MR-9 would claim and run in backend (1 references resolved)",
      "MR-10 waiting on MR-3 (In Review)"
    ]);
    const named = await once(worker, { dryRun: true, issue: "MR-7" });
    expect(named.plan[0].action).toBe("would claim and run in backend (1 references resolved)");

    const { record } = await runWith(world, [issues[2]], {}, { githubToken: null });
    const brief = fs.readFileSync(path.join(runsDir(world.home), (record as RunRecord).id, "brief.md"), "utf8");
    expect(brief).toContain(
      "- MR-4: Base MR-4 (In Review), the worker's pull requests: https://github.com/acme/backend/pull/4\n"
    );
  });

  it("delivers a chain of three without jira.doneStatus after the first run is pruned", async () => {
    const world = setup();
    world.config.limits.keepRuns = 1;
    const link = (key: string) => ({
      type: { name: "Blocks" },
      inwardIssue: {
        key,
        fields: { summary: `Base ${key}`, status: { name: "Delivery", statusCategory: { key: "indeterminate" } } }
      }
    });
    const jira = fakeJira([
      issue("MR-1"),
      issue("MR-2", { fields: { issuelinks: [link("MR-1")] } }),
      issue("MR-3", { fields: { issuelinks: [link("MR-1"), link("MR-2")] } })
    ]);
    const calls: Calls = { gh: [], claude: [] };
    const merged = new Map<string, string>();
    const base = fakeRunner({ commit: true, handback: true }, calls);
    const run: Runner = async (command, args, options) => {
      if (command !== "gh" || args[1] !== "view") return await base(command, args, options);
      const url = args[2];
      const pull = {
        url,
        number: Number(url.split("/").at(-1)),
        title: "MR: Add the thing",
        state: merged.has(url) ? "MERGED" : "OPEN",
        mergeable: "MERGEABLE",
        headRefName: merged.get(url) ?? "other",
        baseRefName: "main",
        statusCheckRollup: []
      };
      return { code: 0, stdout: JSON.stringify(pull), stderr: "", timedOut: false };
    };
    const { worker } = deps(world, jira, run);
    const day = async (date: string) => {
      worker.now = () => new Date(`${date}T10:00:00.000Z`);
      return await once(worker);
    };
    const mergeAll = (records: RunRecord[]) => {
      for (const record of records) for (const url of record.pullRequests) merged.set(url, record.branch as string);
    };

    const first = await day("2026-11-05");
    expect(first.runs.map((record) => `${record.key} ${record.state}`)).toEqual(["MR-1 handed-back"]);
    expect(first.plan.map((entry) => `${entry.key} ${entry.action}`)).toEqual([
      "MR-1 claimed",
      "MR-2 waiting on MR-1 (Delivery)",
      "MR-3 waiting on MR-1 (Delivery), MR-2 (Delivery)"
    ]);
    mergeAll(first.runs);
    const second = await day("2026-11-06");
    expect(second.runs.map((record) => `${record.key} ${record.state}`)).toEqual(["MR-2 handed-back"]);
    expect(second.plan.at(-1)?.action).toBe("waiting on MR-2 (Delivery)");
    mergeAll(second.runs);
    const third = await day("2026-11-07");
    expect(loadRuns(world.home).some(({ record }) => record.key === "MR-1")).toBe(false);
    expect(third.runs.map((record) => `${record.key} ${record.state}`)).toEqual(["MR-3 handed-back"]);
    expect(jira.transitions).not.toContain("MR-1 -> Done");
    const brief = fs.readFileSync(path.join(runsDir(world.home), third.runs[0].id, "brief.md"), "utf8");
    expect(brief).toContain(
      `- MR-1: Base MR-1 (Delivery), the worker's pull requests: ${first.runs[0].pullRequests[0]}\n`
    );
  });

  it("holds the per-shard limit and the concurrency limit", async () => {
    const world = setup();
    const { result, jira } = await runWith(world, [issue("MR-7"), issue("MR-8"), issue("MR-9")], {});
    expect(result.plan.map((entry) => `${entry.key} ${entry.action}`)).toEqual([
      "MR-7 claimed",
      "MR-8 skipped, backend has a run already",
      "MR-9 skipped, backend has a run already"
    ]);
    expect(result.runs).toHaveLength(1);
    expectReleased(jira, result.runs[0], "the run made no commits");
    expect(jira.store.get("MR-8")?.assignee).toBeNull();

    world.config.limits = { ...world.config.limits, concurrent: 1 };
    const second = await runWith(world, [issue("MR-7"), issue("MR-8")], {});
    expect(second.result.plan).toHaveLength(1);
  });

  it("releases an issue without a deliverable marker or with a reference that is not on the default branch", async () => {
    const world = setup();
    const unmarked = await runWith(world, [issue("MR-7", { labels: ["repo:notes"] })], {});
    expectReleased(
      unmarked.jira,
      unmarked.record as RunRecord,
      "no deliverable repository marker, the worker delivers to backend"
    );
    expect(unmarked.calls.claude).toEqual([]);

    const broken = await runWith(
      world,
      [issue("MR-8", { description: "see product/docs/missing.md and product/docs/012-pricing.md" })],
      {}
    );
    expectReleased(broken.jira, broken.record as RunRecord, "references that are not on the default branch:");
    expect(broken.record?.reason).toContain('- product/docs/missing.md: not on origin/main of shard "product"\n');
    expect(broken.record?.reason).toContain(
      '- product/docs/012-pricing.md: not on origin/main of shard "product" (perhaps product/docs/decisions/012-pricing.md)'
    );
    expect(broken.io.stdout).toContain("MR-8\treleased: references that are not on the default branch:");
  });

  it("holds the exclusive resources for the whole run and waits while another process has one", async () => {
    const world = setup();
    world.config.limits.exclusive = ["gpu"];
    const lock = path.join(process.env.GLOBU_LOCK_DIR as string, "gpu.lock");
    const seen: unknown[] = [];
    const calls: Calls = { gh: [], claude: [], setup: [] };
    const run = fakeRunner({ commit: true }, calls);
    const watching: Runner = async (command, args, options) => {
      if (command === "sh" || command === "claude") seen.push(JSON.parse(fs.readFileSync(lock, "utf8")).holder);
      return await run(command, args, options);
    };
    world.config.setup = { backend: ["npm ci"] };
    const jira = fakeJira([issue("MR-7")]);
    const { worker } = deps(world, jira, watching);
    expect((await once(worker)).runs[0].state).toBe("handed-back");
    expect(seen).toEqual(["globu-worker", "globu-worker"]);
    expect(fs.existsSync(lock)).toBe(false);

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "render-box", holder: "klayboy render" }));
    const held = `waiting on gpu (held by klayboy render, pid ${process.pid} on render-box)`;
    const busy = deps(world, fakeJira([issue("MR-8")]), fakeRunner({}, calls));
    expect((await once(busy.worker, { dryRun: true })).plan[0].action).toBe(held);
    const blocked = fakeJira([issue("MR-8")]);
    const cycle = deps(world, blocked, fakeRunner({}, calls), null);
    const result = await once(cycle.worker);
    expect(result.runs).toEqual([]);
    expect(result.plan[0].action).toBe(held);
    expect(cycle.io.stdout).toContain(`MR-8\t${held}`);
    expect(blocked.transitions).toEqual([]);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("runs inside a hold of a process above it without waiting on that process or deleting its lock", async () => {
    const world = setup();
    world.config.limits.exclusive = ["gpu"];
    const dir = process.env.GLOBU_LOCK_DIR as string;
    fs.mkdirSync(dir, { recursive: true });
    const above = { pid: process.ppid, host: os.hostname(), holder: "globu-worker hold (npm run render)" };
    const lock = path.join(dir, "gpu.lock");
    fs.writeFileSync(lock, JSON.stringify(above));
    const calls: Calls = { gh: [], claude: [] };
    const jira = fakeJira([issue("MR-7")]);
    const { worker } = deps(world, jira, fakeRunner({ commit: true }, calls));
    worker.env = { ...worker.env, GLOBU_LOCK_PIDS: `${process.ppid},${process.pid}` };
    expect((await once(worker, { dryRun: true })).plan[0].action).toMatch(/^would claim and run in backend/);
    expect((await once(worker)).runs[0].state).toBe("handed-back");
    expect(calls.claude[0].env.GLOBU_LOCK_PIDS).toBe(`${process.ppid},${process.pid}`);
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual(above);
  });

  it("files the two follow-ups of a handback as linked issues and lists their keys on the issue", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, followUps: { issueType: "Task", linkType: "Relates", max: 10 } };
    const handback = [
      "## Summary",
      "",
      "Done.",
      "",
      "## Follow-ups",
      "",
      "- Add retries to the client",
      "  It gives up after one failure.",
      "- Rename the flag",
      ""
    ].join("\n");
    const { jira, calls, record } = await runWith(world, [issue("MR-7")], { commit: true, handback });
    expect(record).toMatchObject({ state: "handed-back", followUpIssues: ["MR-101", "MR-102"] });
    expect(jira.created.map((entry) => `${entry.project} ${entry.issueType} ${entry.summary}`)).toEqual([
      "MR Task Add retries to the client",
      "MR Task Rename the flag"
    ]);
    expect(jira.issueLinks).toEqual(["MR-7 Relates MR-101", "MR-7 Relates MR-102"]);
    expect(jira.store.get("MR-101")?.labels).toEqual([]);
    const comment = jira.comments["MR-7"][0];
    expect(comment).toContain(
      "---\n\nFollow-up issues:\n- MR-101: Add retries to the client\n- MR-102: Rename the flag\n\nPull requests:\n"
    );
    expect(calls.claude).toHaveLength(1);
    const brief = fs.readFileSync(path.join(world.home, "runs", record?.id as string, "brief.md"), "utf8");
    expect(brief).toContain("The worker files each bullet as an issue linked to this one");
  });

  it("hands back when a follow-up cannot be created and says so in the comment", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, followUps: { issueType: "Task", linkType: "Relates", max: 10 } };
    const handback = "## Summary\n\nDone.\n\n## Follow-ups\n\n- Rename the flag\n";
    const { jira, record } = await runWith(
      world,
      [issue("MR-7")],
      { commit: true, handback },
      { jira: { failCreate: "Rename the flag" } }
    );
    expect(record?.state).toBe("handed-back");
    expect(record?.followUpIssues).toBeUndefined();
    expect(jira.comments["MR-7"][0]).toContain(
      "Follow-up issues:\n- not created: Rename the flag (Jira POST /issue failed: 400 issuetype is invalid)"
    );
  });

  it("does not file the follow-ups again when the comment failed and a later run hands back", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, followUps: { issueType: "Task", linkType: "Relates", max: 10 } };
    const handback = "## Summary\n\nDone.\n\n## Follow-ups\n\n- Add retries to the client\n- Rename the flag\n";
    const failed = await runWith(world, [issue("MR-7")], { commit: true, handback }, { jira: { failHandback: true } });
    expect(failed.record?.state).toBe("released");
    expect(failed.record?.reason).toContain("Jira POST /issue/MR-7/comment failed: 500");
    expect(failed.record?.followUpIssues).toEqual(["MR-101", "MR-102"]);
    expect(filedFor(world.home, "MR-7").map((entry) => entry.key)).toEqual(["MR-101", "MR-102"]);

    const retry = await runWith(world, [issue("MR-7", { summary: "Change x again" })], { commit: true, handback });
    expect(retry.record).toMatchObject({ state: "handed-back", followUpIssues: ["MR-101", "MR-102"] });
    expect(retry.jira.created).toEqual([]);
    expect(retry.jira.issueLinks).toEqual([]);
    expect(retry.jira.comments["MR-7"][0]).toContain(
      "Follow-up issues:\n- MR-101: Add retries to the client\n- MR-102: Rename the flag\n\nPull requests:\n"
    );
    expect(filedFor(world.home, "MR-7")).toEqual([]);
  });

  it("leaves the follow-ups in the comment only when they are not configured", async () => {
    const world = setup();
    const handback = "## Summary\n\nDone.\n\n## Follow-ups\n\n- Rename the flag\n";
    const { jira, record } = await runWith(world, [issue("MR-7")], { commit: true, handback });
    expect(record?.followUpIssues).toBeUndefined();
    expect(jira.created).toEqual([]);
    expect(jira.comments["MR-7"][0]).toContain("## Follow-ups\n\n- Rename the flag\n\n---\n\nPull requests:");
  });

  it("claims by status id when the configuration gives one", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, claimedStatus: "10023" };
    const { jira, record } = await runWith(world, [issue("MR-7")], { commit: true, handback: true });
    expect(record?.state).toBe("handed-back");
    expect(jira.transitions).toEqual(["MR-7 -> 10023"]);
    expect(jira.store.get("MR-7")).toMatchObject({ status: "Delivery", statusId: "10023", assignee: "bot" });
  });

  it("picks the status of the issue's project and falls back to the default entry", async () => {
    const world = setup();
    world.config.jira = {
      ...world.config.jira,
      claimedStatus: { SB: "10023", default: "Doing" },
      releasedStatus: { SB: "Ready for delivery", MR: "Ready for delivery" }
    };
    const { jira, record } = await runWith(world, [issue("SB-2")], { commit: true, handback: true });
    expect(record?.state).toBe("handed-back");
    expect(jira.transitions).toEqual(["SB-2 -> 10023"]);

    const fallback = await runWith(world, [issue("MR-7")], { handback: true }, { githubToken: null });
    expect(fallback.jira.transitions[0]).toBe("MR-7 -> Doing");
  });

  it("refuses to claim an issue whose project has no claimed or released status", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, claimedStatus: { SB: "Delivery" } };
    const unclaimed = fakeJira([issue("MR-7")]);
    await expect(once(deps(world, unclaimed, fakeRunner({}, { gh: [], claude: [] })).worker)).rejects.toThrow(
      "jira.claimedStatus names no status for MR and has no default"
    );
    world.config.jira = { ...world.config.jira, claimedStatus: "Delivery", releasedStatus: { SB: "Open" } };
    const unreleasable = fakeJira([issue("MR-7")]);
    await expect(once(deps(world, unreleasable, fakeRunner({}, { gh: [], claude: [] })).worker)).rejects.toThrow(
      "jira.releasedStatus names no status for MR and has no default"
    );
    expect(unreleasable.store.get("MR-7")?.assignee).toBeNull();
  });

  it("takes issues with the priority label first and keeps the JQL order otherwise", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, priorityLabel: "agent-next" };
    const issues = [issue("MR-7"), issue("MR-8"), issue("MR-9", { labels: ["repo:backend", "agent-next"] })];
    const { result } = await runWith(world, issues, { commit: true, handback: true });
    expect(result.plan.map((entry) => `${entry.key} ${entry.action}`)).toEqual([
      "MR-9 claimed",
      "MR-7 skipped, backend has a run already",
      "MR-8 skipped, backend has a run already"
    ]);
  });

  it("releases an issue whose repository has no commits yet", async () => {
    const world = setup();
    const empty = path.join(world.root, "remotes/sandbox");
    fs.mkdirSync(empty, { recursive: true });
    git(empty, "init", "-q", "--bare", "-b", "main");
    register({ locator: `file://${empty}`, cwd: world.root, dest: path.join(world.home, "work/sandbox") });
    world.config.shards = { deliverable: ["backend", "sandbox"], companion: [], repos: {} };
    const { jira, record } = await runWith(world, [issue("MR-9", { labels: ["repo:sandbox"] })], { commit: true });
    expectReleased(
      jira,
      record as RunRecord,
      'the repository of shard "sandbox" has no commits, push a first commit to its default branch'
    );
  });

  it("releases on a timeout, the turn cap, a failed run and an empty run", async () => {
    const world = setup();
    const timedOut = await runWith(world, [issue("MR-1")], { commit: true, timedOut: true });
    expectReleased(timedOut.jira, timedOut.record as RunRecord, "timed out after 0.0 min");
    expect(() => git(world.clones.backend, "rev-parse", "--verify", "agent/MR-1-add-the-thing")).toThrow();

    const capped = await runWith(world, [issue("MR-2")], {
      commit: true,
      stream: JSON.stringify({ type: "result", subtype: "error_max_turns", num_turns: 80 })
    });
    expectReleased(capped.jira, capped.record as RunRecord, "stopped at the turn cap of 80");
    expect(capped.record?.turns).toBe(80);

    const crashed = await runWith(world, [issue("MR-3")], { code: 1, stderr: "boom\n" });
    expectReleased(crashed.jira, crashed.record as RunRecord, "the run made no commits, claude exited with 1: boom");
    expect(crashed.jira.comments["MR-3"].at(-1)).not.toContain("The run's handback");

    const question = "## Summary\n\nhello.js does not exist yet: create it here or wait for MR-1?\n";
    const empty = await runWith(world, [issue("MR-4")], { handback: question });
    expectReleased(empty.jira, empty.record as RunRecord, "the run made no commits");
    expect(empty.jira.comments["MR-4"].at(-1)).toContain(
      "the run made no commits\n\nThe run's handback:\n\n## Summary\n\nhello.js does not exist yet: create it here or wait for MR-1?\n\n---\n\nRun MR-4-"
    );
    const blank = await runWith(world, [issue("MR-5")], { handback: "  \n" });
    expect(blank.jira.comments["MR-5"].at(-1)).not.toContain("The run's handback");
  });

  it("turns a worker error into a release and keeps a pushed branch", async () => {
    const world = setup();
    const noToken = await runWith(world, [issue("MR-1")], { commit: true }, { githubToken: null });
    expectReleased(
      noToken.jira,
      noToken.record as RunRecord,
      "worker error: set GH_TOKEN to push branches and open pull requests"
    );

    const ghFails = await runWith(world, [issue("MR-2")], { commit: true, ghFails: true });
    expectReleased(ghFails.jira, ghFails.record as RunRecord, "worker error: gh pr create");
    expect(ghFails.record?.reason).toContain("failed: label not found");
    expect(git(world.remotes.backend, "rev-parse", "--verify", "agent/MR-2-add-the-thing")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(world.clones.backend, "rev-parse", "--verify", "agent/MR-2-add-the-thing")).toMatch(/^[0-9a-f]{40}$/);

    git(world.clones.backend, "config", "remote.origin.followRemoteHEAD", "never");
    git(world.clones.backend, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const noHead = await runWith(world, [issue("MR-3")], { commit: true });
    expectReleased(noHead.jira, noHead.record as RunRecord, `worker error: ${world.clones.backend} has no origin/HEAD`);
  });

  it("logs every git command it runs, with the exit code and stderr of one that fails", async () => {
    const world = setup();
    const entries: { msg: string; fields?: Record<string, unknown> }[] = [];
    const record = (msg: string, fields?: Record<string, unknown>) => entries.push({ msg, fields });
    const logger: Logger = { error: record, warn: record, info: record, debug: record };
    setLogger(logger);
    try {
      fs.rmSync(world.remotes.backend, { recursive: true, force: true });
      const run = await runWith(world, [issue("MR-1")], { commit: true });
      expect(run.record?.reason).toContain("worker error: Command failed: git fetch --quiet");
      const failed = entries.find((entry) => entry.msg === "command" && entry.fields?.code !== 0);
      expect(failed?.fields).toMatchObject({ command: "git", args: ["fetch", "--quiet"], cwd: world.clones.backend });
      expect(failed?.fields?.stderr).toContain("does not appear to be a git repository");
      expect(entries.map((entry) => entry.msg)).toEqual(expect.arrayContaining(["cycle", "claimed", "released"]));
    } finally {
      setLogger(silentLogger);
    }
  });

  it("reports when the release itself fails", async () => {
    const world = setup();
    const { io, record } = await runWith(
      world,
      [issue("MR-1", { labels: [] })],
      {},
      { jira: { failTransition: true } }
    );
    expect(record?.state).toBe("released");
    expect(io.stderr).toContain("MR-1: releasing failed: no transition");
  });

  it("notes a lost claim and takes a named issue that is already claimed", async () => {
    const world = setup();
    const stolen = await runWith(world, [issue("MR-1")], {}, { jira: { stolen: ["MR-1"] } });
    expect(stolen.result.plan[0].action).toBe("skipped, claimed by someone else");
    expect(stolen.result.runs).toEqual([]);

    const named = await runWith(
      world,
      [issue("MR-2", { status: "Delivery", assignee: "bot" }), issue("MR-3")],
      {},
      { issue: "MR-2" }
    );
    expect(named.result.plan.map((entry) => entry.key)).toEqual(["MR-2"]);
    expect(named.jira.transitions).toEqual(["MR-2 -> Ready for delivery"]);
  });

  it("reconciles runs left behind by a restart", async () => {
    const world = setup({ companion: ["product"] });
    const runs = runsDir(world.home);
    const claimed = {
      ...newRun("MR-5", new Date("2026-11-05T09:00:00.000Z"), { jira: "x", github: null }),
      state: "running" as const,
      shard: "backend"
    };
    const dropped = { ...newRun("MR-6", NOW, { jira: "x", github: null }), state: "claimed" as const };
    const done = { ...newRun("MR-4", NOW, { jira: "x", github: null }), state: "handed-back" as const };
    for (const record of [claimed, dropped, done]) saveRun(path.join(runs, record.id), record);
    const tree = path.join(runs, claimed.id, "tree");
    git(world.clones.backend, "worktree", "add", "-q", tree, "-b", "agent/MR-5-left");
    const outside = tempDir();
    write(outside, "keep.txt", "keep\n");
    fs.symlinkSync(outside, path.join(tree, "outside"), "junction");
    fs.mkdirSync(path.join(runs, claimed.id, "companions/product"), { recursive: true });

    const { jira, io } = await runWith(
      world,
      [
        issue("MR-5", { status: "Delivery", assignee: "bot" }),
        issue("MR-6", { status: "Delivery", assignee: "someone" }),
        issue("MR-4", { assignee: "someone" })
      ],
      {}
    );
    expect(jira.store.get("MR-5")).toMatchObject({ status: "Ready for delivery", assignee: null });
    expect(jira.comments["MR-5"][0]).toContain(
      "Released by the Globu worker: the worker restarted while this issue was claimed"
    );
    expect(jira.comments["MR-5"][1]).toContain("Released by the Globu worker: the run made no commits");
    expect(jira.comments["MR-6"]).toBeUndefined();
    const reloaded = Object.fromEntries(loadRuns(world.home).map(({ record }) => [record.key, record]));
    expect(reloaded["MR-5"].state).toBe("released");
    expect(loadRuns(world.home).filter(({ record }) => record.key === "MR-5")).toHaveLength(2);
    expect(reloaded["MR-6"]).toMatchObject({
      state: "released",
      reason: "the worker restarted and the issue was no longer claimed"
    });
    expect(reloaded["MR-4"].state).toBe("handed-back");
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(git(world.clones.backend, "worktree", "list").split("\n")).toHaveLength(1);
    expect(io.stdout).toContain("MR-6\tskipped, already assigned");
  });

  it("prunes settled runs beyond limits.keepRuns at the start of a cycle", async () => {
    const world = setup();
    world.config.limits.keepRuns = 1;
    const identity = { jira: "x", github: null };
    const recent = { ...newRun("MR-1", new Date("2026-11-01T09:00:00.000Z"), identity), state: "released" as const };
    const settled = {
      ...newRun("MR-2", new Date("2026-10-01T09:00:00.000Z"), identity),
      state: "handed-back" as const,
      followUp: { state: "closed" as const, repairs: 0 }
    };
    for (const record of [recent, settled]) saveRun(path.join(runsDir(world.home), record.id), record);
    write(path.join(runsDir(world.home), settled.id), "tree/node_modules/x/index.js", "export {};\n");
    await runWith(world, [], {});
    expect(loadRuns(world.home).map(({ record }) => record.id)).toEqual([recent.id]);
    expect(fs.existsSync(path.join(runsDir(world.home), settled.id))).toBe(false);
  });
});

describe("cleanup", () => {
  it("removes the junctions in a worktree without following them, then the worktree and a tree git does not know", () => {
    const world = setup();
    const shard = registry().all.find((entry) => entry.id === "backend") as PresentShard;
    const outside = tempDir();
    write(outside, "keep.txt", "keep\n");
    const tree = path.join(runsDir(world.home), "MR-9-x/tree");
    const worktree = addWorktree(shard, tree, "agent/MR-9-x");
    write(tree, "packages/a/index.js", "export {};\n");
    fs.mkdirSync(path.join(tree, "node_modules/@acme"), { recursive: true });
    fs.symlinkSync(path.join(tree, "packages/a"), path.join(tree, "node_modules/@acme/a"), "junction");
    fs.symlinkSync(outside, path.join(tree, "node_modules/@acme/outside"), "junction");
    const stray = path.join(runsDir(world.home), "MR-9-y/tree");
    write(stray, "left.txt", "left\n");
    cleanup([worktree, { ...worktree, tree: stray, pushed: true }]);
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(git(world.clones.backend, "worktree", "list").split("\n")).toHaveLength(1);
    expect(() => git(world.clones.backend, "rev-parse", "--verify", "agent/MR-9-x")).toThrow();
  });
});

describe("loop", () => {
  it("reports a failing cycle, sleeps and stops when told", async () => {
    const world = setup();
    world.config.shards = { deliverable: ["ghost"], companion: [], repos: {} };
    const { worker, io } = deps(world, fakeJira([]), fakeRunner({}, { gh: [], claude: [] }));
    const slept: number[] = [];
    let stopped = false;
    await loop(worker, {
      sleep: async (ms) => {
        slept.push(ms);
        stopped = true;
      },
      stopped: () => stopped
    });
    expect(io.stderr).toContain('globu-worker: shard "ghost" is not registered');
    expect(slept).toEqual([60_000]);

    let cycles = 0;
    world.config.shards = { deliverable: ["backend"], companion: [], repos: {} };
    await loop(worker, {
      sleep: async () => {
        cycles += 1;
      },
      stopped: () => {
        cycles += 1;
        return cycles >= 6;
      }
    });
    expect(cycles).toBe(6);
  });
});

describe("session commands", () => {
  function session(world: World, issues: JiraIssue[], script: Script = {}, jiraOptions = {}) {
    const jira = fakeJira(issues, jiraOptions);
    const calls: Calls = { gh: [], claude: [] };
    const { worker, io } = deps(world, jira, fakeRunner(script, calls));
    return { worker, io, jira, calls };
  }

  it("claims an issue for a session, keeps the worktrees and finishes it into pull requests", async () => {
    const world = setup({ companion: ["product"] });
    const { worker, io, jira, calls } = session(world, [issue("MR-7")]);
    const claimed = await claimIssue(worker, "MR-7");
    const dir = path.join(runsDir(world.home), "MR-7-20261105T102030Z");
    expect(claimed).toEqual({
      record: expect.objectContaining({ state: "prepared", driver: "session", shard: "backend" }),
      dir,
      brief: path.join(dir, "brief.md"),
      tree: path.join(dir, "tree"),
      handback: path.join(dir, "handback.md"),
      companions: [{ id: "product", tree: path.join(dir, "companions/product") }]
    });
    expect(claimed.record.worktrees).toEqual([
      { shard: "backend", tree: path.join(dir, "tree"), branch: "agent/MR-7-add-the-thing", base: "origin/main" },
      {
        shard: "product",
        tree: path.join(dir, "companions/product"),
        branch: "agent/MR-7-add-the-thing",
        base: "origin/main"
      }
    ]);
    expect(fs.existsSync(path.join(dir, "brief.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "tree/src/x.ts"))).toBe(true);
    expect(io.stdout).toBe(`MR-7\tprepared ${dir}\n`);
    expect(jira.store.get("MR-7")).toMatchObject({ status: "Delivery", assignee: "bot" });
    expect(calls.claude).toEqual([]);

    commitIn(path.join(dir, "tree"), "src/new.ts");
    commitIn(path.join(dir, "companions/product"), "docs/new.md");
    fs.writeFileSync(path.join(dir, "handback.md"), "## Summary\n\nDone by hand.\n");
    const finished = await finishRun(worker, claimed.record.id);
    expect(finished).toMatchObject({
      state: "handed-back",
      driver: "session",
      pullRequests: ["https://github.com/acme/pr/2", "https://github.com/acme/pr/3"]
    });
    const comment = jira.comments["MR-7"][0];
    expect(comment).toContain("## Summary\n\nDone by hand.");
    expect(comment).toMatch(
      /Run MR-7-20261105T102030Z as Bot \(bot\), GitHub octocat from a Claude Code session, 0\.0 min\.$/
    );
    expect(comment).not.toContain("turns");
    expect(git(world.remotes.product, "rev-parse", "--verify", "agent/MR-7-add-the-thing")).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(dir, "tree"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "companions"))).toBe(false);
    expect(git(world.clones.backend, "worktree", "list").split("\n")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).state).toBe("handed-back");
    expect(io.stdout).toContain("MR-7\thanded-back https://github.com/acme/pr/2 https://github.com/acme/pr/3");
    await expect(finishRun(worker, claimed.record.id)).rejects.toThrow(
      "run MR-7-20261105T102030Z is handed-back, only a prepared run can be finished"
    );
    await expect(releaseRun(worker, claimed.record.id, "x")).rejects.toThrow("is already handed-back");
  });

  it("releases at claim time when the issue cannot be prepared and reports a lost race", async () => {
    const world = setup();
    const noMarker = session(world, [issue("MR-1", { labels: [] })]);
    const claimed = await claimIssue(noMarker.worker, "MR-1");
    expect(claimed).toMatchObject({ brief: null, tree: null, handback: null, companions: [] });
    expectReleased(noMarker.jira, claimed.record, "no deliverable repository marker");
    expect(noMarker.io.stdout).toContain("MR-1\treleased: no deliverable repository marker");

    const stolen = session(world, [issue("MR-2")], {}, { stolen: ["MR-2"] });
    await expect(claimIssue(stolen.worker, "MR-2")).rejects.toThrow("MR-2 is claimed by someone else");

    git(world.clones.backend, "config", "remote.origin.followRemoteHEAD", "never");
    git(world.clones.backend, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const broken = session(world, [issue("MR-3")]);
    const failed = await claimIssue(broken.worker, "MR-3");
    expectReleased(broken.jira, failed.record, `worker error: ${world.clones.backend} has no origin/HEAD`);
    expect(fs.existsSync(path.join(failed.dir, "tree"))).toBe(false);
  });

  it("releases a prepared run that made no commits, failed to push or was given back", async () => {
    const world = setup();
    const empty = session(world, [issue("MR-4")]);
    const prepared = await claimIssue(empty.worker, "MR-4");
    const finished = await finishRun(empty.worker, prepared.record.id);
    expectReleased(empty.jira, finished, "the run made no commits");
    expect(finished.reason).toBe("the run made no commits");

    const ghFails = session(world, [issue("MR-5")], { ghFails: true });
    const second = await claimIssue(ghFails.worker, "MR-5");
    commitIn(second.tree as string, "src/new.ts");
    const pushed = await finishRun(ghFails.worker, second.record.id);
    expectReleased(ghFails.jira, pushed, "worker error: gh pr create");
    expect(fs.existsSync(path.join(second.dir, "tree"))).toBe(false);

    const noHandback = session(world, [issue("MR-6")]);
    const third = await claimIssue(noHandback.worker, "MR-6");
    commitIn(third.tree as string, "src/new.ts");
    const handed = await finishRun(noHandback.worker, third.record.id);
    expect(handed.state).toBe("handed-back");
    expect(noHandback.jira.comments["MR-6"][0]).toContain("The run wrote no handback. Its last message:\n\n(none)");

    const givenBack = session(world, [issue("MR-8")]);
    const fourth = await claimIssue(givenBack.worker, "MR-8");
    const released = await releaseRun(givenBack.worker, fourth.record.id, "the person moved on");
    expectReleased(givenBack.jira, released, "the person moved on");
    expect(fs.existsSync(path.join(fourth.dir, "tree"))).toBe(false);
    expect(git(world.clones.backend, "worktree", "list").split("\n")).toHaveLength(1);
    expect(givenBack.io.stdout).toContain("MR-8\treleased: the person moved on");
  });
});
