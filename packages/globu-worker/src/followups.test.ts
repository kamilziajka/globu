import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, git, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig } from "./config.js";
import type { Runner } from "./exec.js";
import type { JiraClient } from "./jira.js";
import { loadRun, loadRuns, newRun, type RunRecord, saveRun } from "./runs.js";
import { start } from "./start.js";
import { type FollowUpRow, followUps, once, type WorkerDeps } from "./worker.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const BRANCH = "agent/MR-7-change-x";

type Claude = "resolve" | "add-only" | "nothing" | "fix" | "timeout";
type Script = { pulls: Record<string, object | null>; claude?: Claude };
type Calls = { gh: string[][]; claude: { cwd: string; env: NodeJS.ProcessEnv; prompt: string }[] };

function runner(script: Script, calls: Calls): Runner {
  return async (command, args, options = {}) => {
    if (command === "sh") {
      const failed = args[1] === "false";
      return { code: failed ? 1 : 0, stdout: "", stderr: failed ? "setup broke\n" : "", timedOut: false };
    }
    if (command === "gh") {
      calls.gh.push(args);
      if (args[1] === "view") {
        const raw = script.pulls[args[2]];
        if (raw === null) return { code: 1, stdout: "", stderr: "not found", timedOut: false };
        return { code: 0, stdout: JSON.stringify(raw), stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    const cwd = options.cwd as string;
    calls.claude.push({ cwd, env: options.env as NodeJS.ProcessEnv, prompt: args[1] });
    const mode = script.claude ?? "nothing";
    if (mode === "resolve" || mode === "add-only") {
      write(cwd, "src/x.ts", "export const x = 3;\n");
      git(cwd, "add", "-A");
      if (mode === "resolve") git(cwd, "commit", "-q", "--no-edit");
    }
    if (mode === "fix") {
      write(cwd, "src/fix.ts", "export {};\n");
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", "fix the checks");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: mode === "timeout" };
  };
}

type FakeJira = JiraClient & { comments: string[]; transitions: string[] };

function jira(): FakeJira {
  const comments: string[] = [];
  const transitions: string[] = [];
  return {
    comments,
    transitions,
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async () => [],
    issue: async (key) => ({
      key,
      summary: "Change x",
      description: "",
      labels: [],
      status: "Delivery",
      statusId: "2",
      assignee: "bot",
      comments: [],
      fields: {}
    }),
    assign: async () => {},
    transitionTo: async (key, status) => {
      transitions.push(`${key} -> ${status}`);
    },
    comment: async (_key, body) => {
      comments.push(body);
    },
    addLabel: async () => {},
    remoteLink: async () => {}
  };
}

function config(extra = "", author = true): string {
  return `
jira:
  site: https://acme.atlassian.net
  jql: project = MR
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend]
${author ? "git:\n  author:\n    name: Agent\n    email: agent@acme.example\n" : ""}${extra}`;
}

function world(
  options: { base?: string; branch?: string; branchFile?: string; extra?: string; author?: boolean } = {}
) {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  const remote = initRepo(path.join(root, "remotes/backend"), { "src/x.ts": "export const x = 1;\n" });
  git(remote, "checkout", "-q", "-b", BRANCH);
  write(remote, options.branchFile ?? "src/x.ts", options.branch ?? "export const x = 2;\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-qm", "MR-7 change x");
  git(remote, "checkout", "-q", "main");
  if (options.base !== undefined) {
    write(remote, "src/x.ts", options.base);
    git(remote, "commit", "-qam", "move the base");
  }
  register({ locator: `file://${remote}`, cwd: root, dest: path.join(home, "work/backend") });
  const url = `file://${remote}/pull/7`;
  const original = newRun("MR-7", new Date("2026-11-13T10:00:00.000Z"), { jira: "Bot", github: "octocat" });
  original.state = "handed-back";
  original.branch = BRANCH;
  original.pullRequests = [url];
  const originalDir = path.join(home, "runs", original.id);
  saveRun(originalDir, original);
  write(originalDir, "brief.md", "# MR-7\n");
  const file = write(root, "worker.yaml", config(options.extra, options.author));
  return { root, home, remote, url, original, configFile: file };
}

function pull(url: string, patch: object = {}): object {
  return {
    url,
    number: 7,
    title: "MR-7: Change x",
    state: "OPEN",
    mergeable: "CONFLICTING",
    headRefName: BRANCH,
    baseRefName: "main",
    statusCheckRollup: [],
    ...patch
  };
}

function deps(setup: ReturnType<typeof world>, script: Script, token: string | null = "gh-token") {
  const calls: Calls = { gh: [], claude: [] };
  const fake = jira();
  const rows: FollowUpRow[][] = [];
  const io = captureIo(setup.root);
  const worker: WorkerDeps = {
    config: loadWorkerConfig(setup.configFile),
    secrets: { jiraEmail: "bot@acme.example", jiraToken: "t", githubToken: token },
    home: setup.home,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR as string,
    jira: fake,
    run: runner(script, calls),
    io,
    now: () => NOW,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, JIRA_API_TOKEN: "t" },
    onFollowUps: (next) => rows.push(next)
  };
  return { worker, calls, jira: fake, rows, io };
}

function original(setup: ReturnType<typeof world>): RunRecord {
  return loadRun(setup.home, setup.original.id).record;
}

describe("following pull requests", () => {
  it("repairs a conflicting pull request with Claude and pushes a merge commit", async () => {
    const setup = world({ base: "export const x = 9;\n", extra: "limits:\n  openPullRequests: 1\n" });
    const {
      worker,
      calls,
      jira: fake,
      rows,
      io
    } = deps(setup, { pulls: { [setup.url]: pull(setup.url) }, claude: "resolve" });
    const { runs } = await once(worker);
    expect(rows[0]).toEqual([
      {
        run: setup.original.id,
        key: "MR-7",
        url: setup.url,
        number: 7,
        summary: "Change x",
        state: "conflict",
        repairable: true
      }
    ]);
    expect(runs).toHaveLength(1);
    const repair = runs[0];
    expect(repair.state).toBe("handed-back");
    expect(repair.repairOf).toBe(setup.original.id);
    expect(repair.branch).toBe(BRANCH);
    expect(git(setup.remote, "rev-list", "--parents", "-n", "1", BRANCH).split(" ")).toHaveLength(3);
    expect(git(setup.remote, "show", `${BRANCH}:src/x.ts`)).toBe("export const x = 3;");
    const brief = fs.readFileSync(path.join(setup.home, "runs", repair.id, "brief.md"), "utf8");
    expect(brief).toContain("## Conflicted files\n\n- src/x.ts");
    expect(brief).toContain("## Failing checks\n\nnone");
    expect(calls.claude[0].prompt).toContain("Repair the pull request described in");
    expect(calls.claude[0].env.JIRA_API_TOKEN).toBeUndefined();
    expect(calls.gh.find((args) => args[1] === "comment")?.[4]).toContain("Repaired by the Globu worker.");
    expect(fake.comments[0]).toContain(`Repaired ${setup.url}.`);
    expect(original(setup).followUp).toBeUndefined();
    expect(io.stdout).toContain("holding new issues: 1 pull requests open, the cap is 1");
  });

  it("merges a branch that is only behind and pushes it without Claude", async () => {
    const setup = world({ base: "export const x = 1;\nexport const y = 1;\n", branchFile: "src/z.ts", branch: "z\n" });
    const { worker, calls } = deps(setup, { pulls: { [setup.url]: pull(setup.url) } });
    const record = (await once(worker, { repair: setup.url })).runs[0];
    expect(record.state).toBe("handed-back");
    expect(calls.claude).toEqual([]);
    expect(git(setup.remote, "show", `${BRANCH}:src/x.ts`)).toContain("export const y = 1;");
  });

  it("runs the setup commands and Claude for failing checks", async () => {
    const setup = world({ author: false, extra: 'setup:\n  backend: ["true"]\n' });
    const failing = {
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ name: "test", conclusion: "FAILURE", detailsUrl: "https://ci/1" }]
    };
    const { worker, calls } = deps(setup, { pulls: { [setup.url]: pull(setup.url, failing) }, claude: "fix" });
    const record = (await once(worker, { repair: setup.url })).runs[0];
    expect(record.state).toBe("handed-back");
    const brief = fs.readFileSync(path.join(setup.home, "runs", record.id, "brief.md"), "utf8");
    expect(brief).toContain("## Conflicted files\n\nnone");
    expect(brief).toContain("- test: https://ci/1");
    expect(calls.claude).toHaveLength(1);
    expect(git(setup.remote, "show", `${BRANCH}:src/fix.ts`)).toBe("export {};");
  });

  it("gives a pull request to a person after the last failed repair and leaves it alone", async () => {
    const setup = world({ base: "export const x = 9;\n", extra: "limits:\n  repairs: 2\n  openPullRequests: 1\n" });
    const { worker, calls, jira: fake, rows } = deps(setup, { pulls: { [setup.url]: pull(setup.url) } });
    const first = (await once(worker)).runs[0];
    expect(first.state).toBe("released");
    expect(first.reason).toBe("conflicts are left unresolved");
    expect(fake.comments[0]).toContain("The worker will try again.");
    expect(original(setup).followUp).toEqual({ repairs: 1, state: "open" });
    expect((await once(worker)).runs[0].reason).toBe("conflicts are left unresolved");
    expect(original(setup).followUp).toEqual({ repairs: 2, state: "needs-human" });
    expect(fake.comments[1]).toContain("It needs a person now.");
    expect(calls.gh.find((args) => args[1] === "edit")).toEqual([
      "pr",
      "edit",
      setup.url,
      "--add-label",
      "needs-human"
    ]);
    expect((await once(worker)).runs).toEqual([]);
    expect(rows.at(-1)?.[0]).toMatchObject({ state: "needs human", repairable: false });
    expect(loadRuns(setup.home).filter(({ record }) => record.repairOf !== undefined)).toHaveLength(2);
  });

  it("names why a repair failed", async () => {
    const setup = world({
      base: "export const x = 9;\n",
      extra: 'limits:\n  repairs: 9\nsetup:\n  backend: ["false"]\n'
    });
    const reasons: string[] = [];
    const attempt = async (script: Script) => {
      const { worker } = deps(setup, script);
      reasons.push((await once(worker, { repair: setup.url })).runs[0].reason as string);
    };
    await attempt({ pulls: { [setup.url]: pull(setup.url) } });
    fs.writeFileSync(setup.configFile, config("limits:\n  repairs: 9\n  timeout: 1m\n"));
    await attempt({ pulls: { [setup.url]: pull(setup.url) }, claude: "add-only" });
    await attempt({ pulls: { [setup.url]: pull(setup.url) }, claude: "timeout" });
    await attempt({ pulls: { [setup.url]: null } });
    expect(reasons[0]).toBe('setup command "false" in backend exited with 1:\nsetup broke');
    expect(reasons[1]).toBe("the merge was not committed");
    expect(reasons[2]).toBe("timed out after 1.0 min");
    expect(reasons[3]).toMatch(/^worker error: gh pr view .* failed: not found$/);
  });

  it("fails a repair that commits nothing", async () => {
    const clean = world({ author: false });
    const failing = { mergeable: "MERGEABLE", statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] };
    const { worker } = deps(clean, { pulls: { [clean.url]: pull(clean.url, failing) } });
    expect((await once(worker, { repair: clean.url })).runs[0].reason).toBe("the repair made no commits");
  });

  it("refuses a repair without a token, for an unknown pull request or an unregistered repository", async () => {
    const setup = world();
    await expect(once(deps(setup, { pulls: {} }, null).worker, { repair: setup.url })).rejects.toThrow(
      "set GH_TOKEN to repair pull requests"
    );
    expect(await followUps(deps(setup, { pulls: {} }, null).worker, true)).toEqual([]);
    await expect(once(deps(setup, { pulls: {} }).worker, { repair: "file:///x/pull/1" })).rejects.toThrow(
      "no open run of the worker has file:///x/pull/1"
    );
    const stranger = "https://github.com/acme/other/pull/3";
    const record = original(setup);
    record.pullRequests.push(stranger);
    saveRun(path.join(setup.home, "runs", record.id), record);
    await expect(once(deps(setup, { pulls: {} }).worker, { repair: stranger })).rejects.toThrow(
      `no registered shard has the repository of ${stranger}`
    );
  });

  it("moves a merged issue to done, notes a closed one and only reads in a dry follow-up", async () => {
    const setup = world({ extra: "" });
    const { worker, jira: fake } = deps(setup, { pulls: { [setup.url]: pull(setup.url, { state: "MERGED" }) } });
    expect((await followUps(worker, false))[0].state).toBe("merged");
    expect(fake.comments).toEqual([]);
    await followUps(worker, true);
    expect(fake.transitions).toEqual([]);
    expect(fake.comments).toEqual([`Merged: ${setup.url}`]);
    expect(original(setup).followUp).toEqual({ repairs: 0, state: "merged" });
    expect(await followUps(worker, true)).toEqual([]);
  });

  it("moves a merged issue to the done status when one is set", async () => {
    const done = world({ extra: "" });
    fs.writeFileSync(
      done.configFile,
      config("").replace(
        "  releasedStatus: Ready for delivery",
        "  releasedStatus: Ready for delivery\n  doneStatus: Done"
      )
    );
    const merged = deps(done, { pulls: { [done.url]: pull(done.url, { state: "MERGED" }) } });
    await followUps(merged.worker, true);
    expect(merged.jira.transitions).toEqual(["MR-7 -> Done"]);

    const closed = deps(done, { pulls: { [done.url]: pull(done.url, { state: "CLOSED" }) } });
    const record = original(done);
    delete record.followUp;
    saveRun(path.join(done.home, "runs", record.id), record);
    await followUps(closed.worker, true);
    expect(closed.jira.comments).toEqual([`Closed without merging: ${done.url}`]);
    expect(closed.jira.transitions).toEqual([]);
  });

  it("closes a repair left behind by a restart without giving the issue back", async () => {
    const setup = world();
    const stale = newRun("MR-7", NOW, { jira: "Bot", github: null });
    stale.repairOf = setup.original.id;
    stale.state = "running";
    saveRun(path.join(setup.home, "runs", stale.id), stale);
    const { worker, jira: fake } = deps(setup, { pulls: { [setup.url]: pull(setup.url, { mergeable: "MERGEABLE" }) } });
    expect((await once(worker)).plan).toEqual([]);
    expect(loadRun(setup.home, stale.id).record).toMatchObject({
      state: "released",
      reason: "the worker restarted during this repair"
    });
    expect(fake.transitions).toEqual([]);
  });

  it("in pick mode refreshes in the background and repairs the selected pull request on Enter", async () => {
    const setup = world({ base: "export const x = 9;\n" });
    const { worker, calls } = deps(setup, { pulls: { [setup.url]: pull(setup.url) }, claude: "resolve" });
    const frames: string[] = [];
    const presses: ("enter" | "quit")[] = ["enter", "quit"];
    let waits = 0;
    await start(worker, {
      mode: "pick",
      screen: { write: (text) => frames.push(text) },
      readKey: () => new Promise((resolve) => setTimeout(() => resolve(presses.shift() ?? "quit"), 20)),
      wait: async () => {
        waits += 1;
        if (waits > 1) await new Promise(() => {});
      },
      untilStopped: async () => {}
    });
    const shown = frames.map(plain).join("");
    expect(shown).toContain("○ MR-7 #7  ");
    expect(shown).toContain("1 of 5 pull requests open, 1 need a fix.");
    expect(shown).toContain("Repairing MR-7 #7...");
    expect(calls.claude).toHaveLength(1);
    expect(git(setup.remote, "show", `${BRANCH}:src/x.ts`)).toBe("export const x = 3;");
  });
});
