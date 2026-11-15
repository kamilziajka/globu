import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadManifest, register, saveManifest, updateShard } from "../../globu-core/src/index.js";
import { baseIndex, captureIo, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import type { Runner } from "./exec.js";
import type { JiraClient, JiraIssue } from "./jira.js";
import { newRun, type RunRecord, runsDir, saveRun } from "./runs.js";
import { recordUsage } from "./subscription.js";
import { delegate, matchesJql, retry, why } from "./triage.js";
import type { WorkerDeps } from "./worker.js";

const NOW = new Date("2026-11-14T09:00:00.000Z");

function setup(): { root: string; config: WorkerConfig } {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  for (const id of ["backend", "frontend"]) {
    const remote = initRepo(path.join(root, `remotes/${id}`), { "docs/index.md": baseIndex(id) });
    register({ locator: `file://${remote}`, cwd: root, dest: path.join(home, `work/${id}`) });
  }
  const file = write(
    root,
    "worker.yaml",
    `
jira:
  site: https://acme.atlassian.net
  jql: project = MR AND labels != agent-blocked ORDER BY created ASC
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend, frontend]
limits:
  concurrent: 2
`
  );
  return { root, config: loadWorkerConfig(file) };
}

function setupProjects(): { root: string; config: WorkerConfig } {
  const { root } = setup();
  saveManifest({
    ...loadManifest(),
    projects: {
      mercastra: {
        shards: ["backend", "frontend"],
        jira: "MR",
        worker: {
          statuses: { ready: "Ready for delivery", claimed: "Delivery", released: "To Do" },
          filter: "type != Epic"
        }
      },
      sandbox: { shards: ["frontend"], jira: "SB", worker: { statuses: { claimed: "Doing", released: "Open" } } }
    }
  });
  const file = write(root, "worker.yaml", "version: 2\njira: { site: https://acme.atlassian.net }\n");
  return { root, config: loadWorkerConfig(file) };
}

function issue(key: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `Change ${key}`,
    description: "",
    labels: ["agent-eligible", "repo:backend"],
    status: "Ready for delivery",
    statusId: "10001",
    assignee: null,
    comments: [],
    fields: {},
    ...overrides
  };
}

type FakeJira = JiraClient & { store: Map<string, JiraIssue>; searches: string[]; edits: string[] };

function fakeJira(issues: JiraIssue[]): FakeJira {
  const store = new Map(issues.map((entry) => [entry.key, structuredClone(entry)]));
  const searches: string[] = [];
  const edits: string[] = [];
  const get = (key: string) => store.get(key) as JiraIssue;
  const eligible = (entry: JiraIssue) => !entry.labels.includes("agent-blocked");
  return {
    store,
    searches,
    edits,
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async (jql) => {
      searches.push(jql);
      const named = /^key = (\S+)/.exec(jql)?.[1];
      const all = [...store.values()].filter(eligible).map((entry) => ({ key: entry.key, labels: entry.labels }));
      return named === undefined ? all : all.filter((hit) => hit.key === named);
    },
    issue: async (key) => structuredClone(get(key)),
    assign: async (key, accountId) => {
      get(key).assignee = accountId;
    },
    transitionTo: async (key, status) => {
      get(key).status = status;
    },
    comment: async () => {},
    addLabel: async (key, label) => {
      edits.push(`${key} +${label}`);
      get(key).labels.push(label);
    },
    removeLabel: async (key, label) => {
      edits.push(`${key} -${label}`);
      get(key).labels = get(key).labels.filter((entry) => entry !== label);
    },
    setField: async (key, field, value) => {
      edits.push(`${key} ${field}=${value}`);
      get(key).fields[field] = value;
    },
    remoteLink: async () => {},
    createIssue: async () => "MR-100",
    linkIssues: async () => {},
    issueTypes: async () => [],
    linkTypes: async () => [],
    permissions: async () => ({})
  };
}

function runner(pulls: Record<string, object>): Runner {
  return async (command, args) => {
    if (command === "gh" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify(pulls[args[2]]), stderr: "", timedOut: false };
    }
    return { code: 0, stdout: command === "gh" ? "octocat\n" : "", stderr: "", timedOut: false };
  };
}

function deps(root: string, config: WorkerConfig, jira: JiraClient, pulls: Record<string, object> = {}) {
  const io = captureIo(root);
  const worker: WorkerDeps = {
    config,
    secrets: { jiraEmail: "bot@acme.example", jiraToken: "t", githubToken: "gh-token" },
    home: process.env.GLOBU_HOME as string,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR as string,
    jira,
    run: runner(pulls),
    io,
    now: () => NOW,
    env: { PATH: process.env.PATH }
  };
  return { worker, io };
}

function handedBack(key: string, url: string): void {
  const record: RunRecord = {
    ...newRun(key, NOW, { jira: "x", github: null }),
    state: "handed-back",
    pullRequests: [url],
    followUp: { state: "open", repairs: 0 }
  };
  saveRun(path.join(runsDir(process.env.GLOBU_HOME as string), record.id), record);
}

function pull(url: string, mergeable: string): object {
  return {
    url,
    number: 1,
    title: "MR-0: x",
    state: "OPEN",
    mergeable,
    headRefName: "agent/MR-0",
    baseRefName: "main",
    statusCheckRollup: []
  };
}

const blockedBy = (key: string) => ({
  issuelinks: [
    { type: { name: "Blocks" }, inwardIssue: { key, fields: { summary: "", status: { name: "In Review" } } } }
  ]
});

describe("why", () => {
  it("says the next cycle claims an issue that passes every check", async () => {
    const { root, config } = setup();
    const jira = fakeJira([issue("MR-1")]);
    const { worker, io } = deps(root, config, jira);
    const report = await why(worker, "MR-1");
    expect(report).toEqual({
      key: "MR-1",
      summary: "Change MR-1",
      matches: true,
      reasons: [],
      blocked: false,
      shard: "backend",
      target: "backend",
      deliverable: true,
      assignee: null,
      waiting: [],
      holds: [],
      action: "would claim and run in backend (0 references resolved)",
      picked: true
    });
    expect(io.stdout).toBe(
      [
        "MR-1\tChange MR-1",
        "jql\tmatches jira.jql",
        "marker\tbackend",
        "assignee\tnone",
        "blockers\tnone open",
        "limits\tnone hold it",
        "outcome\twould claim and run in backend (0 references resolved)",
        "verdict\tthe next cycle claims it",
        ""
      ].join("\n")
    );
    expect(jira.searches[0]).toBe("key = MR-1 AND (project = MR AND labels != agent-blocked)");
    expect(jira.edits).toEqual([]);
    config.defaults.exclusive = ["gpu"];
    const lock = path.join(process.env.GLOBU_LOCK_DIR as string, "gpu.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "render-box", holder: "klayboy render" }));
    const held = await why(worker, "MR-1");
    expect(held.holds).toEqual([
      { limit: "exclusive", detail: `waiting on gpu (held by klayboy render, pid ${process.pid} on render-box)` }
    ]);
    expect(held.picked).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("names the blocked label, a missing or foreign marker, an assignee and open blockers", async () => {
    const { root, config } = setup();
    const jira = fakeJira([
      issue("MR-1", { labels: ["agent-blocked", "repo:notes"], assignee: "someone", fields: blockedBy("MR-0") }),
      issue("MR-2", { labels: [] })
    ]);
    const { worker, io } = deps(root, config, jira);
    const blocked = await why(worker, "MR-1");
    expect(blocked).toMatchObject({
      matches: false,
      blocked: true,
      shard: "notes",
      deliverable: false,
      assignee: "someone",
      waiting: [{ key: "MR-0", status: "In Review" }],
      action: 'would release: "notes" is not a deliverable shard, the worker delivers to backend, frontend',
      picked: false
    });
    expect(io.stdout).toContain("jql\tdoes not match jira.jql\n");
    expect(io.stdout).toContain("blocked\tagent-blocked is set, `globu-worker retry MR-1` removes it and runs it\n");
    expect(io.stdout).toContain("marker\tnotes, not a shard a run can land in\n");
    expect(io.stdout).toContain("assignee\tsomeone\n");
    expect(io.stdout).toContain("blockers\twaiting on MR-0 (In Review)\n");
    expect(io.stdout).toContain("verdict\tthe next cycle leaves it: it does not match jira.jql\n");

    const unmarked = await why(worker, "MR-2");
    expect(unmarked).toMatchObject({ matches: true, shard: null, deliverable: false, holds: [], picked: false });
    expect(io.stdout).toContain("marker\tnone\n");
    expect(io.stdout).toContain(
      "verdict\tthe next cycle leaves it: would release: no deliverable repository marker, the worker delivers to backend, frontend\n"
    );
  });

  it("names the day cap, the subscription limit, the open pull request cap and repairs that take the slots", async () => {
    const { root, config } = setup();
    const resetsAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    recordUsage(process.env.GLOBU_HOME as string, [{ window: "five_hour", utilization: 0.81, resetsAt }], NOW);
    const spent = { ...newRun("MR-0", NOW, { jira: "x", github: null }), state: "released" as const, costUsd: 41 };
    saveRun(path.join(runsDir(process.env.GLOBU_HOME as string), spent.id), spent);
    const review = "https://github.com/acme/backend/pull/1";
    const conflict = "https://github.com/acme/backend/pull/2";
    handedBack("MR-8", review);
    handedBack("MR-9", conflict);
    config.limits = { ...config.limits, concurrent: 1, openPullRequests: 2 };
    const jira = fakeJira([issue("MR-1")]);
    const pulls = { [review]: pull(review, "MERGEABLE"), [conflict]: pull(conflict, "CONFLICTING") };
    const { worker } = deps(root, config, jira, pulls);
    const report = await why(worker, "MR-1");
    expect(report.holds).toEqual([
      { limit: "dayUsd", detail: "the day cap of 40 USD is reached, 41.00 spent" },
      {
        limit: "subscription",
        detail: `the subscription's five-hour window is at 81 %, the limit is 70 %, it resets at ${resetsAt.slice(0, 16).replace("T", " ")} UTC`
      },
      { limit: "openPullRequests", detail: "2 pull requests are open, the cap is 2" },
      { limit: "concurrent", detail: "limits.concurrent is 1 and 1 repair comes first" }
    ]);
    expect(report.picked).toBe(false);

    config.limits = { ...config.limits, concurrent: 2 };
    const both = { [review]: pull(review, "CONFLICTING"), [conflict]: pull(conflict, "CONFLICTING") };
    const crowded = await why(deps(root, config, jira, both).worker, "MR-1");
    expect(crowded.holds.at(-1)).toEqual({
      limit: "concurrent",
      detail: "limits.concurrent is 2 and 2 repairs come first"
    });
  });

  it("walks the queue ahead of the issue as a cycle would, for the concurrency and per-shard limits", async () => {
    const { root, config } = setup();
    const frontend = ["agent-eligible", "repo:frontend"];
    const jira = fakeJira([
      issue("MR-1", { assignee: "someone" }),
      issue("MR-2", { fields: blockedBy("MR-0") }),
      issue("MR-3"),
      issue("MR-4"),
      issue("MR-5", { labels: frontend }),
      issue("MR-6", { labels: frontend }),
      issue("MR-7")
    ]);
    const { worker, io } = deps(root, config, jira);
    expect((await why(worker, "MR-1")).holds).toEqual([]);
    expect(io.stdout).toContain("verdict\tthe next cycle leaves it: it is assigned\n");
    expect((await why(worker, "MR-2")).holds).toEqual([]);
    expect(io.stdout).toContain("limits\tnone hold it\n");
    expect(io.stdout).toContain("verdict\tthe next cycle leaves it: it waits on MR-0 (In Review)\n");
    expect((await why(worker, "MR-4")).holds).toEqual([
      { limit: "perShard", detail: "limits.perShard is 1 and MR-3 comes first in backend" }
    ]);
    expect(io.stdout).toContain(
      "verdict\tthe next cycle leaves it: limits.perShard is 1 and MR-3 comes first in backend\n"
    );
    expect((await why(worker, "MR-5")).picked).toBe(true);
    expect((await why(worker, "MR-6")).holds).toEqual([
      { limit: "concurrent", detail: "limits.concurrent is 2 and MR-3, MR-5 come first" }
    ]);
    expect((await why(worker, "MR-7")).holds[0].limit).toBe("concurrent");

    config.jira.priorityLabel = "agent-next";
    (jira.store.get("MR-7") as JiraIssue).labels.push("agent-next");
    expect((await why(worker, "MR-7")).picked).toBe(true);
    expect((await why(worker, "MR-6")).holds).toEqual([
      { limit: "concurrent", detail: "limits.concurrent is 2 and MR-7, MR-5 come first" }
    ]);
  });
});

describe("why and delegate with projects", () => {
  it("says which part of the generated search keeps an issue out", async () => {
    const { root, config } = setupProjects();
    const jira = fakeJira([
      issue("MR-1", { status: "To Do", statusId: "3", labels: ["agent-blocked", "repo:backend"], assignee: "someone" }),
      issue("ZZ-1"),
      issue("SB-1", { labels: ["agent-eligible"], status: "Open" })
    ]);
    const { worker, io } = deps(root, config, jira);
    const out = await why(worker, "MR-1");
    expect(out.reasons).toEqual([
      "the status is To Do, not Ready for delivery",
      "the label agent-eligible is missing",
      "the label agent-blocked is set",
      "it is assigned",
      "the project's filter does not match (type != Epic)"
    ]);
    expect(io.stdout).toContain(
      "jql\tdoes not match the worker's search: the status is To Do, not Ready for delivery, the label agent-eligible is missing, the label agent-blocked is set, it is assigned, the project's filter does not match (type != Epic)\n"
    );
    expect(jira.searches.slice(0, 2)).toEqual([
      'key = MR-1 AND (((project = "MR" AND status = "Ready for delivery" AND (type != Epic)) OR (project = "SB" AND statusCategory != Done)) AND labels = "agent-eligible" AND labels != "agent-blocked" AND assignee is EMPTY)',
      "key = MR-1 AND (type != Epic)"
    ]);

    const single = await why(worker, "SB-1");
    expect(single).toMatchObject({ matches: true, reasons: [], shard: null, target: "frontend", picked: true });
    expect(io.stdout).toContain(
      "SB-1\tChange SB-1\njql\tmatches the worker's search\nmarker\tnone, the run lands in frontend\n"
    );

    const foreign = await why(worker, "ZZ-1");
    expect(foreign).toMatchObject({
      matches: true,
      target: null,
      deliverable: false,
      action: "skipped, ZZ is not a project this worker serves",
      picked: false
    });
    jira.search = async () => [];
    expect((await why(worker, "ZZ-1")).reasons).toEqual(["ZZ is not a project this worker serves"]);
    expect((await why(worker, "SB-1")).reasons).toEqual([]);
  });

  it("checks only the issue's project in a session", async () => {
    const { root, config } = setupProjects();
    const jira = fakeJira([issue("SB-1", { labels: ["agent-eligible"] }), issue("ZZ-1")]);
    const { worker } = deps(root, config, jira);
    worker.session = true;
    updateShard("backend", { mode: "read" });
    expect((await why(worker, "SB-1")).picked).toBe(true);
    expect((await why(worker, "ZZ-1")).action).toBe("skipped, ZZ is not a project this worker serves");
    updateShard("frontend", { mode: "read" });
    await expect(why(worker, "SB-1")).rejects.toThrow('shard "frontend" is read-only on this machine');
    worker.session = false;
    await expect(why(worker, "ZZ-1")).rejects.toThrow('shard "backend" is read-only on this machine');
  });

  it("delegates without a repository when the project has one shard", async () => {
    const { root, config } = setupProjects();
    const jira = fakeJira([issue("SB-1", { labels: [] }), issue("MR-1", { labels: [] }), issue("ZZ-1")]);
    const { worker, io } = deps(root, config, jira);
    expect(await delegate(worker, "SB-1", undefined, async () => {})).toEqual({
      key: "SB-1",
      shard: "frontend",
      matches: true
    });
    expect(jira.edits).toEqual(["SB-1 +agent-eligible"]);
    expect(io.stdout).toBe(
      "SB-1\tneeds no repository marker, its project has one shard\nSB-1\tdelegated to frontend, matches the worker's search\n"
    );
    await expect(delegate(worker, "MR-1", undefined)).rejects.toThrow(
      "no repository marker, and project mercastra has 2 shards a run can land in: backend, frontend, pass --repo <shard>"
    );
    await expect(delegate(worker, "MR-1", "ghost")).rejects.toThrow(
      'the repository marker names "ghost", which is not in project mercastra'
    );
    await expect(delegate(worker, "ZZ-1", "backend")).rejects.toThrow(
      "no project this worker serves has the Jira key ZZ"
    );
  });
});

describe("matchesJql", () => {
  it("drops the ORDER BY of the JQL and handles one that only orders", async () => {
    const { root, config } = setup();
    config.jira.jql = "order by created";
    const jira = fakeJira([issue("MR-1")]);
    const { worker } = deps(root, config, jira);
    expect(await matchesJql(worker, "MR-1")).toBe(true);
    expect(jira.searches).toEqual(["key = MR-1"]);
  });
});

describe("retry", () => {
  it("removes the blocked label and takes the issue as once --issue does", async () => {
    const { root, config } = setup();
    const jira = fakeJira([issue("MR-1", { labels: ["agent-eligible", "repo:backend", "agent-blocked"] })]);
    const { worker, io } = deps(root, config, jira);
    const result = await retry(worker, "MR-1");
    expect(jira.edits[0]).toBe("MR-1 -agent-blocked");
    expect(io.stdout.split("\n")[0]).toBe("MR-1\tremoved agent-blocked");
    expect(result.plan).toEqual([{ key: "MR-1", summary: "Change MR-1", shard: "backend", action: "claimed" }]);
    expect(result.runs[0].reason).toBe("the run made no commits");
  });

  it("says nothing about the label when the issue does not carry it", async () => {
    const { root, config } = setup();
    const jira = fakeJira([issue("MR-1")]);
    const { worker, io } = deps(root, config, jira);
    await retry(worker, "MR-1");
    expect(jira.edits).not.toContain("MR-1 -agent-blocked");
    expect(io.stdout.split("\n")[0]).toBe("MR-1\tclaimed");
  });
});

describe("delegate", () => {
  it("adds the eligibility label and the marker label, replacing another marker", async () => {
    const { root, config } = setup();
    const jira = fakeJira([issue("MR-1", { labels: ["repo:frontend", "ux"] })]);
    const { worker, io } = deps(root, config, jira);
    expect(await delegate(worker, "MR-1", "backend")).toEqual({ key: "MR-1", shard: "backend", matches: true });
    expect(jira.edits).toEqual(["MR-1 -repo:frontend", "MR-1 +repo:backend", "MR-1 +agent-eligible"]);
    expect(jira.store.get("MR-1")?.labels).toEqual(["ux", "repo:backend", "agent-eligible"]);
    expect(io.stdout).toBe("MR-1\tdelegated to backend, matches jira.jql\n");
  });

  it("pauses for real between searches when no wait is given", async () => {
    const { root, config } = setup();
    const jira = fakeJira([issue("MR-1", { labels: [] })]);
    const search = jira.search;
    let calls = 0;
    jira.search = async (jql, max) => (++calls < 2 ? [] : await search(jql, max));
    const { worker } = deps(root, config, jira);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = delegate(worker, "MR-1", "backend");
      await vi.advanceTimersByTimeAsync(5000);
      expect((await pending).matches).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for Jira's search to see new labels", async () => {
    const { root, config } = setup();
    const jira = fakeJira([issue("MR-1", { labels: [] })]);
    const search = jira.search;
    let calls = 0;
    jira.search = async (jql, max) => (++calls < 3 ? [] : await search(jql, max));
    const { worker, io } = deps(root, config, jira);
    expect((await delegate(worker, "MR-1", "backend", async () => {})).matches).toBe(true);
    expect(calls).toBe(3);
    expect(io.stderr).toBe("MR-1: waiting up to 30 s for Jira's search to see the labels\n");
  });

  it("sets a custom field marker, says when the JQL still leaves the issue out and refuses a foreign shard", async () => {
    const { root, config } = setup();
    config.jira.repository = { field: "customfield_10042" };
    config.jira.eligibleLabel = "ai";
    const jira = fakeJira([issue("MR-1", { labels: ["agent-blocked"] })]);
    const { worker, io } = deps(root, config, jira);
    const waited: number[] = [];
    const result = await delegate(worker, "MR-1", "frontend", async (ms) => void waited.push(ms));
    expect(result.matches).toBe(false);
    expect(waited).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
    expect(jira.searches).toHaveLength(7);
    expect(jira.edits).toEqual(["MR-1 customfield_10042=frontend", "MR-1 +ai"]);
    expect(io.stderr).toBe("MR-1: waiting up to 30 s for Jira's search to see the labels\n");
    expect(io.stdout).toBe(
      "MR-1\tdelegated to frontend, does not match jira.jql after 30 s, `globu-worker why MR-1` says why\n"
    );
    await expect(delegate(worker, "MR-1", "notes")).rejects.toThrow(
      '"notes" is not a deliverable shard, the worker delivers to backend, frontend'
    );
  });
});
