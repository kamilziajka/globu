import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { mergedIssues } from "./merged.js";
import {
  endRun,
  followingUp,
  isTerminal,
  latestRuns,
  loadRun,
  loadRuns,
  newRun,
  newRunId,
  pruneRuns,
  type RunRecord,
  removeTree,
  runsDir,
  saveRun,
  spentOn
} from "./runs.js";

const NOW = new Date("2026-11-05T10:20:30.123Z");
const IDENTITY = { jira: "Bot (a1)", github: null };

describe("run records", () => {
  it("ends a run with the time and the wall time since its claim", () => {
    const record = newRun("MR-7", NOW, IDENTITY);
    endRun(record, new Date("2026-11-05T11:01:30.123Z"));
    expect(record).toMatchObject({ endedAt: "2026-11-05T11:01:30.123Z", wallMs: 41 * 60_000 });
  });

  it("names a run after the issue and the time", () => {
    expect(newRunId("MR-7", NOW)).toBe("MR-7-20261105T102030Z");
    expect(newRun("MR-7", NOW, IDENTITY)).toMatchObject({
      id: "MR-7-20261105T102030Z",
      key: "MR-7",
      state: "claimed",
      driver: "worker",
      worktrees: []
    });
    expect(newRun("MR-7", NOW, IDENTITY, "session").driver).toBe("session");
  });

  it("knows which states are final", () => {
    expect(isTerminal("handed-back")).toBe(true);
    expect(isTerminal("released")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });

  it("saves and loads records, skipping directories without one", () => {
    const home = tempDir();
    expect(loadRuns(home)).toEqual([]);
    const first = newRun("MR-7", NOW, IDENTITY);
    const second = { ...newRun("MR-8", new Date("2026-11-04T09:00:00Z"), IDENTITY), costUsd: 2.5 };
    saveRun(path.join(runsDir(home), first.id), first);
    saveRun(path.join(runsDir(home), second.id), second);
    fs.mkdirSync(path.join(runsDir(home), "stray"));
    expect(loadRun(home, first.id).record).toEqual(first);
    expect(() => loadRun(home, "MR-9-x")).toThrow(`no run MR-9-x in ${runsDir(home)}`);
    const loaded = loadRuns(home);
    expect(loaded.map(({ record }) => record.key)).toEqual(["MR-7", "MR-8"]);
    expect(loaded[0].dir).toBe(path.join(runsDir(home), first.id));
  });

  it("sums the cost of the runs started on a day", () => {
    const runs = [
      { dir: "a", record: { ...newRun("MR-7", NOW, IDENTITY), costUsd: 1.5 } },
      { dir: "b", record: { ...newRun("MR-8", NOW, IDENTITY), costUsd: 2 } },
      { dir: "c", record: { ...newRun("MR-9", new Date("2026-11-04T23:59:00Z"), IDENTITY), costUsd: 10 } }
    ];
    expect(spentOn(runs, NOW)).toBe(3.5);
  });

  it("removes links and junctions under a tree without following them", () => {
    const outside = tempDir();
    write(outside, "keep.txt", "keep\n");
    const tree = path.join(tempDir(), "tree");
    write(tree, "packages/a/index.js", "export {};\n");
    fs.mkdirSync(path.join(tree, "node_modules/@acme"), { recursive: true });
    fs.symlinkSync(path.join(tree, "packages/a"), path.join(tree, "node_modules/@acme/a"), "junction");
    fs.symlinkSync(outside, path.join(tree, "node_modules/@acme/outside"), "junction");
    try {
      fs.symlinkSync(path.join(outside, "keep.txt"), path.join(tree, "keep.txt"));
    } catch (err) {
      // A file symlink on Windows needs Developer Mode, which CI has and a developer's machine may not.
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    }
    removeTree(tree);
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    removeTree(tree);
  });

  it("follows up a handed-back run until its pull requests are settled", () => {
    const record = { ...newRun("MR-7", NOW, IDENTITY), state: "handed-back" as const };
    expect(followingUp(record)).toBe(true);
    expect(followingUp({ ...record, followUp: { state: "needs-human", repairs: 2 } })).toBe(true);
    expect(followingUp({ ...record, followUp: { state: "merged", repairs: 0 } })).toBe(false);
    expect(followingUp({ ...record, repairOf: "MR-7-x" })).toBe(false);
    expect(followingUp({ ...record, state: "released" })).toBe(false);
  });

  it("keeps the newest runs, open follow-ups with their repairs, unfinished runs and today's runs, and every merge", () => {
    const home = tempDir();
    const at = (key: string, day: number, patch: Partial<RunRecord> = {}): RunRecord => {
      const record = { ...newRun(key, new Date(Date.UTC(2026, 9, day, 9)), IDENTITY), ...patch };
      saveRun(path.join(runsDir(home), record.id), record);
      write(path.join(runsDir(home), record.id), "claude.jsonl", "{}\n");
      return record;
    };
    const merged = { state: "handed-back" as const, followUp: { state: "merged" as const, repairs: 0 } };
    const old = at("MR-1", 1, merged);
    const open = at("MR-2", 2, { state: "handed-back" });
    const repair = at("MR-2", 3, { state: "released", repairOf: open.id });
    const running = at("MR-3", 4, { state: "running" });
    const released = at("MR-4", 6, { state: "released" });
    const today = at("MR-5", 5, { state: "released", startedAt: NOW.toISOString() });
    const newest = at("MR-6", 7, merged);
    expect(latestRuns(loadRuns(home), 2).map(({ record }) => record.id)).toEqual([today.id, newest.id]);
    expect(pruneRuns(home, 2, NOW).sort()).toEqual([old.id, released.id].sort());
    expect(
      loadRuns(home)
        .map(({ record }) => record.id)
        .sort()
    ).toEqual([open.id, repair.id, running.id, today.id, newest.id].sort());
    expect(fs.existsSync(path.join(runsDir(home), old.id))).toBe(false);
    expect(Object.keys(mergedIssues(home, []))).toEqual(["MR-1", "MR-6"]);
    expect(pruneRuns(home, 2, NOW)).toEqual([]);
  });
});
