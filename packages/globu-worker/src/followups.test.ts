import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, git, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig } from "./config.js";
import type { Runner } from "./exec.js";
import type { JiraClient } from "./jira.js";
import { setLogger, silentLogger } from "./logger.js";
import { mergedIssues } from "./merged.js";
import { loadRun, loadRuns, newRun, type RunRecord, saveRun } from "./runs.js";
import { start } from "./start.js";
import { recordUsage } from "./subscription.js";
import { type FollowUpRow, followUps, loop, once, type WorkerDeps } from "./worker.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const BRANCH = "agent/MR-7-change-x";

type Claude = "resolve" | "add-only" | "nothing" | "fix" | "timeout" | "missing";
type Script = {
  pulls: Record<string, object | null>;
  claude?: Claude;
  viewEnded?: boolean;
  commentEnded?: boolean;
  during?: () => Promise<void>;
};
type Calls = {
  gh: string[][];
  claude: { cwd: string; env: NodeJS.ProcessEnv; prompt: string }[];
  notices: string[][];
};

function runner(script: Script, calls: Calls): Runner {
  return async (command, args, options = {}) => {
    if (command === "sh") {
      if (args[1] === "notify-me") calls.notices.push(args.slice(3));
      const failed = args[1] === "false";
      return { code: failed ? 1 : 0, stdout: "", stderr: failed ? "setup broke\n" : "", timedOut: false };
    }
    if (command === "gh") {
      calls.gh.push(args);
      if (args[1] === "view") {
        if (script.viewEnded) return { code: 3221225794, stdout: "", stderr: "", timedOut: false };
        const raw = script.pulls[args[2]];
        if (raw === null) return { code: 1, stdout: "", stderr: "not found", timedOut: false };
        return { code: 0, stdout: JSON.stringify(raw), stderr: "", timedOut: false };
      }
      if (script.commentEnded && args[1] === "comment") {
        return { code: 3221225794, stdout: "", stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    const cwd = options.cwd as string;
    calls.claude.push({ cwd, env: options.env as NodeJS.ProcessEnv, prompt: args[1] });
    const mode = script.claude ?? "nothing";
    await script.during?.();
    if (mode === "missing") return { code: null, stdout: "", stderr: "", timedOut: false, startError: "ENOENT" };
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
    removeLabel: async () => {},
    setField: async () => {},
    remoteLink: async () => {},
    createIssue: async () => "MR-100",
    linkIssues: async () => {},
    issueTypes: async () => [],
    linkTypes: async () => [],
    permissions: async () => ({})
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
  const calls: Calls = { gh: [], claude: [], notices: [] };
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
    platform: "linux",
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
    expect(brief).toContain(
      "Bash runs only the commands that match these patterns, in which `*` stands for any text: `npm run *`, `npx vitest *`"
    );
    expect(brief).toContain(
      "so run one command per call and read or change files with Read, Edit, Write, Grep and Glob"
    );
    expect(brief).toContain("`git stash` is denied");
    expect(calls.claude[0].prompt).toContain("Repair the pull request described in");
    expect(calls.claude[0].env.JIRA_API_TOKEN).toBeUndefined();
    expect(calls.gh.find((args) => args[1] === "comment")?.[4]).toContain("Repaired by the Globu worker.");
    expect(fake.comments[0]).toContain(`Repaired ${setup.url}.`);
    expect(original(setup).followUp).toBeUndefined();
    expect(io.stdout).toContain("holding new issues: 1 pull requests open, the cap is 1");
  });

  it("leaves repairs alone while another process holds an exclusive resource", async () => {
    const setup = world({ base: "export const x = 9;\n", extra: "limits:\n  exclusive: [gpu]\n" });
    const dir = process.env.GLOBU_LOCK_DIR as string;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gpu.lock"), JSON.stringify({ pid: process.pid, host: "render-box" }));
    const held = `gpu (held by another process, pid ${process.pid} on render-box)`;
    const cycle = deps(setup, { pulls: { [setup.url]: pull(setup.url) }, claude: "resolve" });
    expect((await once(cycle.worker)).runs).toEqual([]);
    expect(cycle.io.stdout).toContain(`repairs waiting on ${held}`);
    const asked = deps(setup, { pulls: { [setup.url]: pull(setup.url) }, claude: "resolve" });
    expect(await once(asked.worker, { repair: setup.url })).toEqual({ runs: [], plan: [] });
    expect(asked.io.stdout).toContain(`repair waiting on ${held}`);
    expect([...cycle.calls.claude, ...asked.calls.claude]).toEqual([]);
    expect(original(setup).followUp).toBeUndefined();
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
    const setup = world({
      base: "export const x = 9;\n",
      extra: "limits:\n  repairs: 2\n  openPullRequests: 1\nnotify:\n  command: notify-me\n"
    });
    const { worker, calls, jira: fake, rows } = deps(setup, { pulls: { [setup.url]: pull(setup.url) } });
    const first = (await once(worker)).runs[0];
    expect(first.state).toBe("released");
    expect(first.reason).toBe("conflicts are left unresolved");
    expect(fake.comments[0]).toContain("The worker will try again.");
    expect(original(setup).followUp).toEqual({ repairs: 1, state: "open" });
    expect((await once(worker)).runs[0].reason).toBe("conflicts are left unresolved");
    expect(original(setup).followUp).toEqual({ repairs: 2, state: "needs-human" });
    expect(fake.comments[1]).toContain("It needs a person now.");
    expect(calls.notices).toEqual([["needs-human", "MR-7", setup.url]]);
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
    await attempt({ pulls: { [setup.url]: pull(setup.url) }, claude: "missing" });
    expect(reasons[0]).toBe('setup command "false" in backend exited with 1:\nsetup broke');
    expect(reasons[1]).toBe("the merge was not committed");
    expect(reasons[2]).toBe("timed out after 1.0 min");
    expect(reasons[3]).toMatch(/^worker error: gh pr view .* failed: not found$/);
    expect(reasons[4]).toBe("could not start claude: not found on PATH");
    expect(original(setup).followUp).toEqual({ repairs: 4, state: "open" });
  });

  it("does not count a repair whose child Windows ended, and records it as a problem of the machine", async () => {
    const setup = world({ base: "export const x = 9;\n", extra: "limits:\n  repairs: 2\n" });
    const { worker, jira } = deps(setup, { pulls: { [setup.url]: pull(setup.url) }, viewEnded: true });
    const record = (await once(worker, { repair: setup.url })).runs[0];
    expect(record).toMatchObject({
      state: "released",
      environment: true,
      reason: "Windows ended gh with status 0xC0000142"
    });
    expect(original(setup).followUp).toEqual({ repairs: 0, state: "open" });
    expect(jira.comments.at(-1)).toContain(
      "could not repair this pull request: Windows ended gh with status 0xC0000142. The worker will try again."
    );
  });

  it("keeps a failed repair's reason and its comments when they cannot be posted, and posts them on a later cycle", async () => {
    const setup = world({ base: "export const x = 9;\n", extra: "limits:\n  repairs: 2\n" });
    const pulls = { [setup.url]: pull(setup.url) };
    const first = deps(setup, { pulls, claude: "add-only", commentEnded: true });
    first.jira.comment = async () => {
      throw new Error("Jira is down");
    };
    const record = (await once(first.worker, { repair: setup.url })).runs[0];
    expect(record).toMatchObject({ state: "released", reason: "the merge was not committed" });
    const stored = () => loadRun(setup.home, record.id).record;
    expect(stored().unposted).toEqual([
      { on: "pull", target: setup.url, body: expect.stringContaining("could not repair this pull request") },
      { on: "issue", target: "MR-7", body: expect.stringContaining("the merge was not committed") }
    ]);
    expect(first.io.stderr).toContain(
      `globu-worker: could not comment on ${setup.url}, the next cycle tries again: Windows ended gh with status 0xC0000142`
    );
    expect(first.io.stderr).toContain(
      "globu-worker: could not comment on MR-7, the next cycle tries again: Jira is down"
    );
    expect(original(setup).followUp).toEqual({ repairs: 1, state: "open" });

    const tokenless = deps(setup, { pulls: {} }, null);
    await once(tokenless.worker);
    expect(stored().unposted).toHaveLength(2);

    const second = deps(setup, { pulls: { [setup.url]: pull(setup.url, { mergeable: "MERGEABLE" }) } });
    await once(second.worker);
    expect(stored().unposted).toBeUndefined();
    expect(stored().reason).toBe("the merge was not committed");
    expect(second.calls.gh).toContainEqual([
      "pr",
      "comment",
      setup.url,
      "--body",
      expect.stringContaining("could not repair")
    ]);
    expect(second.jira.comments).toEqual([expect.stringContaining("could not repair this pull request")]);
  });

  it("prints a repair as repaired or repair failed, and says which issue waits for the slot it took", async () => {
    const setup = world({ base: "export const x = 9;\n", extra: "limits:\n  repairs: 5\n" });
    const pulls = { [setup.url]: pull(setup.url) };
    const failing = deps(setup, { pulls, claude: "add-only" });
    failing.jira.search = async () => [
      { key: "MR-9", labels: [] },
      { key: "MR-10", labels: [] }
    ];
    await once(failing.worker);
    expect(failing.io.stdout.trim().split("\n")).toEqual([
      `MR-7\trepair failed: the merge was not committed ${setup.url}`,
      "MR-9\twaiting on a slot, taken by the repair of #7"
    ]);

    const idle = deps(setup, { pulls, claude: "resolve" });
    await once(idle.worker);
    expect(idle.io.stdout.trim().split("\n")).toEqual([`MR-7\trepaired ${setup.url}`, "nothing eligible"]);

    const byHand = deps(setup, { pulls: { [setup.url]: pull(setup.url, { mergeable: "MERGEABLE" }) } });
    await once(byHand.worker, { repair: setup.url });
    expect(byHand.io.stdout).toContain("MR-7\trepair failed: the repair made no commits");
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
    const clone = path.join(setup.home, "work/backend");
    git(clone, "fetch", "-q");
    git(clone, "branch", "-q", BRANCH, `origin/${BRANCH}`);
    const { worker, jira: fake } = deps(setup, { pulls: { [setup.url]: pull(setup.url, { state: "MERGED" }) } });
    expect((await followUps(worker, false))[0].state).toBe("merged");
    expect(fake.comments).toEqual([]);
    expect(git(setup.remote, "branch", "--list", BRANCH)).not.toBe("");
    await followUps(worker, true);
    expect(fake.transitions).toEqual([]);
    expect(fake.comments).toEqual([`Merged: ${setup.url}`]);
    expect(original(setup).followUp).toEqual({ repairs: 0, state: "merged" });
    expect(mergedIssues(setup.home, [])).toEqual({
      "MR-7": { pullRequests: [setup.url], mergedAt: NOW.toISOString() }
    });
    expect(git(setup.remote, "branch", "--list", BRANCH)).toBe("");
    expect(git(clone, "branch", "--all", "--list", `*${BRANCH}`)).toBe("");
    expect(await followUps(worker, true)).toEqual([]);
  });

  it("deletes only the branch it created and logs a branch it cannot delete", async () => {
    const setup = world();
    git(setup.remote, "branch", "human/topic");
    const theirs = `file://${setup.remote}/pull/8`;
    const stranger = "https://github.com/acme/other/pull/3";
    const record = original(setup);
    record.pullRequests.push(theirs, stranger);
    saveRun(path.join(setup.home, "runs", record.id), record);
    const events: { msg: string; fields: Record<string, unknown> }[] = [];
    const capture = (msg: string, fields: Record<string, unknown> = {}) => events.push({ msg, fields });
    setLogger({ ...silentLogger, info: capture, warn: capture });
    const merged = { state: "MERGED" };
    const { worker } = deps(setup, {
      pulls: {
        [setup.url]: pull(setup.url, merged),
        [theirs]: pull(theirs, { ...merged, headRefName: "human/topic" }),
        [stranger]: pull(stranger, merged)
      }
    });
    try {
      await followUps(worker, true);
    } finally {
      setLogger(silentLogger);
    }
    expect(git(setup.remote, "branch", "--list", BRANCH)).toBe("");
    expect(git(setup.remote, "branch", "--list", "human/topic")).toContain("human/topic");
    expect(events.filter((event) => event.msg.includes("branch"))).toEqual([
      { msg: "branch deleted", fields: { run: record.id, branch: BRANCH, pullRequest: setup.url } },
      {
        msg: "deleting the branch failed",
        fields: {
          run: record.id,
          branch: BRANCH,
          pullRequest: stranger,
          error: `no registered shard has the repository of ${stranger}`
        }
      }
    ]);
  });

  it("moves a merged issue to the done status when one is set", async () => {
    const done = world({ extra: "" });
    fs.writeFileSync(
      done.configFile,
      config("").replace(
        "  releasedStatus: Ready for delivery",
        "  releasedStatus: Ready for delivery\n  doneStatus:\n    MR: Done\n    default: Closed"
      )
    );
    git(done.remote, "branch", "-D", BRANCH);
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

  it("leaves the pull requests and stale runs of a project it no longer serves to people", async () => {
    const setup = world();
    const stale = newRun("MR-7", NOW, { jira: "Bot", github: null });
    stale.state = "running";
    saveRun(path.join(setup.home, "runs", stale.id), stale);
    const open = deps(setup, { pulls: { [setup.url]: pull(setup.url) } });
    open.worker.config.projects[0].jira = "SB";
    expect((await once(open.worker)).runs).toEqual([]);
    expect(open.rows[0]).toMatchObject([{ state: "conflict", repairable: false }]);
    expect(loadRun(setup.home, stale.id).record).toMatchObject({
      state: "released",
      reason: "the worker restarted and the issue was no longer claimed"
    });
    expect(open.jira.transitions).toEqual([]);

    const merged = deps(setup, { pulls: { [setup.url]: pull(setup.url, { state: "MERGED" }) } });
    merged.worker.config.projects[0].jira = "SB";
    await followUps(merged.worker, true);
    expect(merged.jira.transitions).toEqual([]);
    expect(merged.jira.comments).toEqual([`Merged: ${setup.url}`]);
  });

  it("settles a pull request that is merged while another issue runs, on the poll interval", async () => {
    const setup = world();
    const open = pull(setup.url, { mergeable: "MERGEABLE" });
    const script: Script = { pulls: { [setup.url]: open } };
    const { worker, jira: fake } = deps(setup, script);
    worker.config.poll.every = 10;
    const next = { assignee: null as string | null, status: "Ready for delivery" };
    const others = fake.issue;
    fake.search = async () => [{ key: "MR-9", labels: ["repo:backend"] }];
    fake.issue = async (key) =>
      key === "MR-9" ? { ...(await others(key)), labels: ["repo:backend"], ...next } : await others(key);
    fake.assign = async (_key, accountId) => {
      next.assignee = accountId;
    };
    fake.transitionTo = async (_key, status) => {
      next.status = status;
    };
    const warnings: string[] = [];
    setLogger({ ...silentLogger, warn: (message) => warnings.push(message) });
    let seenDuringTheRun = false;
    script.during = async () => {
      script.pulls[setup.url] = null;
      await vi.waitFor(() => expect(warnings).toContain("settling failed"));
      script.pulls[setup.url] = pull(setup.url, { state: "MERGED" });
      await vi.waitFor(() => expect(fake.comments).toContain(`Merged: ${setup.url}`));
      seenDuringTheRun = true;
    };
    try {
      const result = await once(worker);
      expect(result.runs.map((record) => [record.key, record.reason])).toEqual([["MR-9", "the run made no commits"]]);
    } finally {
      setLogger(silentLogger);
    }
    expect(seenDuringTheRun).toBe(true);
    expect(original(setup).followUp).toEqual({ repairs: 0, state: "merged" });
  });

  it("settles a merge while a limit holds, and says the hold when it starts and when it ends", async () => {
    const setup = world();
    const merged = pull(setup.url, { state: "MERGED" });
    const { worker, jira: fake, io } = deps(setup, { pulls: { [setup.url]: merged } });
    recordUsage(setup.home, [{ window: "five_hour", utilization: 0.82, resetsAt: "2026-11-13T12:02:00.000Z" }], NOW);
    const held =
      "subscription limit reached: the subscription's five-hour window is at 82 %, the limit is 70 %, it resets at 2026-11-13 12:02 UTC, claiming nothing\n";

    for (const options of [{ dryRun: true }, { issue: "MR-9" }, { repair: setup.url }]) await once(worker, options);
    expect(io.stdout).toBe(held.repeat(3));
    expect(fake.comments).toEqual([]);

    io.stdout = "";
    let pauses = 0;
    await loop(worker, {
      sleep: async () => {
        pauses += 1;
        if (pauses === 2) worker.now = () => new Date("2026-11-13T12:02:01.000Z");
      },
      stopped: () => pauses >= 3
    });
    expect(io.stdout).toBe(`${held}the subscription limit no longer holds, claiming again\nnothing eligible\n`);
    expect(fake.comments).toEqual([`Merged: ${setup.url}`]);
    expect(original(setup).followUp).toEqual({ repairs: 0, state: "merged" });
  });

  it("closes a repair left behind by a restart without giving the issue back", async () => {
    const setup = world();
    const stale = newRun("MR-7", NOW, { jira: "Bot", github: null });
    stale.repairOf = setup.original.id;
    stale.state = "running";
    saveRun(path.join(setup.home, "runs", stale.id), stale);
    const failed = { ...stale, id: `${stale.id}-2`, reason: "git worktree add failed" };
    saveRun(path.join(setup.home, "runs", failed.id), failed);
    const { worker, jira: fake } = deps(setup, { pulls: { [setup.url]: pull(setup.url, { mergeable: "MERGEABLE" }) } });
    expect((await once(worker)).plan).toEqual([]);
    expect(loadRun(setup.home, stale.id).record).toMatchObject({
      state: "released",
      reason: "the worker restarted during this repair"
    });
    expect(loadRun(setup.home, failed.id).record).toMatchObject({
      state: "released",
      reason: "git worktree add failed (then the worker restarted during this repair)"
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
      untilStopped: async () => false
    });
    const shown = frames.map(plain).join("");
    expect(shown).toContain("○ MR-7 #7  ");
    expect(shown).toContain("1 of 5 pull requests open, 1 need a fix.");
    expect(shown).toContain("Repairing MR-7 #7...");
    expect(calls.claude).toHaveLength(1);
    expect(git(setup.remote, "show", `${BRANCH}:src/x.ts`)).toBe("export const x = 3;");
  });
});
