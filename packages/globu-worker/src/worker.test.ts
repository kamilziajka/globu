import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { register, updateShard } from "../../globu-core/src/index.js";
import { baseIndex, captureIo, git, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import type { Runner } from "./exec.js";
import type { JiraClient, JiraIssue } from "./jira.js";
import { loadRuns, newRun, type RunRecord, runsDir, saveRun } from "./runs.js";
import { checkShards, claimIssue, finishRun, loop, markerShard, once, releaseRun, type WorkerDeps } from "./worker.js";

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
};

function fakeJira(issues: JiraIssue[], options: { stolen?: string[]; failTransition?: boolean } = {}): FakeJira {
  const store = new Map(issues.map((entry) => [entry.key, structuredClone(entry)]));
  const comments: Record<string, string[]> = {};
  const links: Record<string, string[]> = {};
  const transitions: string[] = [];
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
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async () => [...store.keys()],
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
      comments[key] = [...(comments[key] ?? []), body];
    },
    addLabel: async (key, label) => {
      get(key).labels.push(label);
    },
    remoteLink: async (key, url) => {
      links[key] = [...(links[key] ?? []), url];
    }
  };
}

type Script = {
  commit?: boolean;
  companionCommit?: boolean;
  handback?: boolean;
  stream?: string;
  code?: number;
  stderr?: string;
  timedOut?: boolean;
  ghFails?: boolean;
  ghLoginFails?: boolean;
};
type Calls = { gh: string[][]; claude: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] };

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
    if (script.handback) fs.writeFileSync(path.join(runDir, "handback.md"), "## Summary\n\nDone.\n");
    fs.appendFileSync(options.stdoutFile as string, `${script.stream ?? `${BLOCKED}\n${RESULT}`}\n`);
    return { code: script.code ?? 0, stdout: "", stderr: script.stderr ?? "", timedOut: script.timedOut ?? false };
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
      checkShards({ ...world.config, shards: { deliverable: ["ghost"], companion: [] } }, world.home)
    ).toThrow(`shard "ghost" is not registered in ${world.home}`);
    expect(() =>
      checkShards({ ...world.config, shards: { deliverable: ["notes"], companion: [] } }, world.home)
    ).toThrow('shard "notes" needs an editable clone');
    fs.rmSync(world.clones.product, { recursive: true });
    expect(() =>
      checkShards({ ...world.config, shards: { deliverable: ["product"], companion: [] } }, world.home)
    ).toThrow('shard "product" needs an editable clone');
    updateShard("backend", { mode: "read" });
    expect(() => checkShards(world.config, world.home)).toThrow('shard "backend" is read-only on this machine');
    updateShard("backend", { mode: "ask" });
    expect(() =>
      checkShards({ ...world.config, shards: { deliverable: ["backend"], companion: ["backend"] } }, world.home)
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
      `Implement the issue described in ${runDir}/brief.md with the issue-deliver skill. Write the handback to ${runDir}/handback.md.`
    ]);
    expect(claude.args).toContain("--allowedTools");
    expect(claude.args).toContain("Bash(git commit *)");
    expect(claude.args.slice(claude.args.indexOf("--disallowedTools"), claude.args.indexOf("--add-dir"))).toEqual([
      "--disallowedTools",
      "Bash(git push*)",
      "Bash(gh *)",
      "Bash(curl *)",
      "Bash(wget *)"
    ]);
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
      `- \`product/docs/decisions/012-pricing.md\`: ${world.clones.product}/docs/decisions/012-pricing.md`
    );
    expect(brief).toContain(`- \`src/x.ts\`: ${world.clones.backend}/src/x.ts`);
    expect(brief).toContain("**Kamil, 2026-11-05**\n\n> Also read `docs/index.md`.");
    expect(brief).toContain(`- \`docs/index.md\`: ${world.clones.backend}/docs/index.md`);
    expect(brief).toContain(`- \`product\`: ${runDir}/companions/product`);
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

  it("claims by status id when the configuration gives one", async () => {
    const world = setup();
    world.config.jira = { ...world.config.jira, claimedStatus: "10023" };
    const { jira, record } = await runWith(world, [issue("MR-7")], { commit: true, handback: true });
    expect(record?.state).toBe("handed-back");
    expect(jira.transitions).toEqual(["MR-7 -> 10023"]);
    expect(jira.store.get("MR-7")).toMatchObject({ status: "Delivery", statusId: "10023", assignee: "bot" });
  });

  it("releases an issue whose repository has no commits yet", async () => {
    const world = setup();
    const empty = path.join(world.root, "remotes/sandbox");
    fs.mkdirSync(empty, { recursive: true });
    git(empty, "init", "-q", "--bare", "-b", "main");
    register({ locator: `file://${empty}`, cwd: world.root, dest: path.join(world.home, "work/sandbox") });
    world.config.shards = { deliverable: ["backend", "sandbox"], companion: [] };
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
    expect(git(world.clones.backend, "worktree", "list").split("\n")).toHaveLength(1);
    expect(io.stdout).toContain("MR-6\tskipped, already assigned");
  });
});

describe("loop", () => {
  it("reports a failing cycle, sleeps and stops when told", async () => {
    const world = setup();
    world.config.shards = { deliverable: ["ghost"], companion: [] };
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
    world.config.shards = { deliverable: ["backend"], companion: [] };
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
