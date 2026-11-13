import path from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { register } from "../../globu-core/src/index.js";
import { captureIo, initRepo, tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig } from "./config.js";
import type { Runner } from "./exec.js";
import type { JiraClient, JiraIssue } from "./jira.js";
import { type Key, PICK_KEYS, parseMode, type ReadKey, start } from "./start.js";
import { CLEAR, HIDE_CURSOR, SHOW_CURSOR } from "./tui.js";
import { once, type WorkerDeps } from "./worker.js";

const NOW = new Date("2026-11-13T10:42:00.000Z");

function issue(key: string, summary: string): JiraIssue {
  return {
    key,
    summary,
    description: "",
    labels: ["repo:backend"],
    status: "Ready for delivery",
    statusId: "1",
    assignee: null,
    comments: [],
    fields: {}
  };
}

function jira(issues: JiraIssue[], overrides: Partial<JiraClient> = {}): JiraClient {
  const store = new Map(issues.map((entry) => [entry.key, structuredClone(entry)]));
  const get = (key: string) => store.get(key) as JiraIssue;
  return {
    myself: async () => ({ accountId: "bot", displayName: "Bot" }),
    search: async () =>
      [...store.values()]
        .filter((entry) => entry.assignee === null && !entry.labels.includes("agent-blocked"))
        .map((entry) => entry.key),
    issue: async (key) => structuredClone(get(key)),
    assign: async (key, accountId) => {
      get(key).assignee = accountId;
    },
    transitionTo: async (key, status) => {
      get(key).status = status;
    },
    comment: async () => {},
    addLabel: async (key, label) => {
      get(key).labels.push(label);
    },
    remoteLink: async () => {},
    ...overrides
  };
}

const idle: Runner = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

function deps(client: JiraClient): { worker: WorkerDeps; io: ReturnType<typeof captureIo> } {
  const root = tempDir();
  const home = process.env.GLOBU_HOME as string;
  const remote = initRepo(path.join(root, "remotes/backend"), { "README.md": "backend\n" });
  register({ locator: `file://${remote}`, cwd: root, dest: path.join(home, "work/backend") });
  const config = loadWorkerConfig(
    write(
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
  concurrent: 3
  perShard: 3
`
    )
  );
  const io = captureIo(root);
  const worker: WorkerDeps = {
    config,
    secrets: { jiraEmail: "bot@acme.example", jiraToken: "t", githubToken: null },
    home,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR as string,
    jira: client,
    run: idle,
    io,
    now: () => NOW,
    env: { PATH: process.env.PATH }
  };
  return { worker, io };
}

function screen() {
  const frames: string[] = [];
  return { frames, write: (text: string) => frames.push(text) };
}

function keys(...presses: Key[]): { readKey: ReadKey; read: () => number } {
  let count = 0;
  return {
    read: () => count,
    readKey: async () => {
      count += 1;
      return presses.shift() ?? "quit";
    }
  };
}

describe("start", () => {
  it("parses the mode", () => {
    expect(parseMode("pick")).toBe("pick");
    expect(parseMode("auto")).toBe("auto");
    expect(() => parseMode("fast")).toThrow('invalid mode "fast", use pick or auto');
  });

  it("in auto mode without a terminal runs one issue per cycle and prints a line per state change", async () => {
    const { worker, io } = deps(jira([issue("MR-1", "First"), issue("MR-2", "Second")]));
    await start(worker, { mode: "auto", untilStopped: async (inner) => void (await once(inner)) });
    const lines = io.stdout.trim().split("\n");
    expect(lines[0]).toBe("2026-11-13T10:42:00.000Z MR-1 preparing");
    expect(lines.at(-1)).toBe("2026-11-13T10:42:00.000Z MR-1 released: the run made no commits");
    expect(io.stdout).toContain("MR-1 running: since 10:42 UTC");
    expect(io.stdout).not.toContain("MR-2");
    expect(io.stdout).not.toContain("claimed");
  });

  it("in auto mode on a terminal redraws the table with the day's spend", async () => {
    const { worker } = deps(jira([issue("MR-1", "First")]));
    const view = screen();
    const checks = [
      { name: "jira", ok: true, detail: "as Bot", short: "Bot" },
      { name: "claude", ok: true, detail: "answers", short: "claude-test" }
    ];
    await start(worker, {
      mode: "auto",
      screen: { ...view, columns: 30 },
      checks,
      untilStopped: async (inner) => void (await once(inner))
    });
    const last = plain(view.frames.at(-1) as string);
    expect(last.startsWith(plain(CLEAR))).toBe(true);
    expect(last).toContain("globu-worker in auto mode on https://acme.atlassian.net, one issue at a time");
    expect(last).toContain("MR-1  First  released  the run made no commits");
    expect(last).toContain("Spent today 0.00 of 40.00 USD.");
    expect(last).toContain("Ctrl+C stops after the current run");
    expect(last.split("\n")[1]).toBe("✔ jira Bot   ✔ claude claude-…");
  });

  it("in pick mode moves the selection with the arrows, runs the selected issue on Enter and polls again", async () => {
    const { worker } = deps(jira([issue("MR-1", "First"), issue("MR-2", "Second")]));
    const view = screen();
    const input = keys("other", "down", "down", "up", "enter", "refresh", "quit");
    await start(worker, { mode: "pick", screen: view, readKey: input.readKey, untilStopped: async () => {} });
    expect(input.read()).toBe(7);
    expect(view.frames[0]).toBe(HIDE_CURSOR);
    expect(view.frames.at(-1)).toBe(SHOW_CURSOR);
    const frames = view.frames.slice(1, -1).map(plain);
    expect(frames.every((frame) => frame.startsWith(plain(CLEAR)))).toBe(true);
    const selections = frames.map((frame) => /● (MR-\d)/.exec(frame)?.[1] ?? null);
    expect(selections).toContain("MR-2");
    expect(frames.some((frame) => frame.includes("Running MR-2..."))).toBe(true);
    expect(frames[0]).toContain("Polling Jira...");
    const last = frames.at(-1) as string;
    expect(last).toContain("● MR-1  First   available  backend (0 references resolved)");
    expect(last).toContain("  MR-2  Second  released   the run made no commits");
    expect(last).toContain(PICK_KEYS);
    expect(last).toContain("Spent today 0.00 of 40.00 USD.");
  });

  it("ignores the arrows and Enter when nothing is available", async () => {
    const { worker } = deps(jira([]));
    const view = screen();
    const input = keys("enter", "down", "quit");
    await start(worker, { mode: "pick", screen: view, readKey: input.readKey, untilStopped: async () => {} });
    expect(input.read()).toBe(3);
    expect(plain(view.frames.at(-2) as string)).toContain("No issues match the JQL right now.");
  });

  it("shows a failed poll and a failed run as a notice until the next key", async () => {
    let polls = 0;
    const client = jira([issue("MR-1", "First")], {
      search: async () => {
        polls += 1;
        if (polls === 1) throw new Error("Jira is down");
        return ["MR-1"];
      },
      assign: async () => {
        throw new Error("no permission to assign");
      }
    });
    const { worker } = deps(client);
    const view = screen();
    const input = keys("refresh", "enter", "quit");
    await start(worker, { mode: "pick", screen: view, readKey: input.readKey, untilStopped: async () => {} });
    const frames = view.frames.map(plain);
    expect(frames.some((frame) => frame.includes("Polling failed: Jira is down"))).toBe(true);
    expect(frames.at(-2)).toContain("MR-1: no permission to assign");
  });
});
