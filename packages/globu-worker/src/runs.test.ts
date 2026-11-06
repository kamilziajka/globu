import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import { isTerminal, loadRun, loadRuns, newRun, newRunId, runsDir, saveRun, spentOn } from "./runs.js";

const NOW = new Date("2026-11-05T10:20:30.123Z");
const IDENTITY = { jira: "Bot (a1)", github: null };

describe("run records", () => {
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
});
