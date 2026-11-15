import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import { MERGED_FILE, mergedIssues, recordMerged, saveMerged } from "./merged.js";
import { loadRuns, newRun, type RunRecord, runsDir, saveRun } from "./runs.js";

const IDENTITY = { jira: "Bot (a1)", github: null };
const WRITTEN = new Date("2026-11-02T08:00:00.000Z");

function saved(home: string, key: string, patch: Partial<RunRecord>): void {
  const record = { ...newRun(key, new Date("2026-11-01T09:00:00.000Z"), IDENTITY), ...patch };
  const dir = path.join(runsDir(home), record.id);
  saveRun(dir, record);
  fs.utimesSync(path.join(dir, "run.json"), WRITTEN, WRITTEN);
}

describe("the index of merged issues", () => {
  it("counts the merged runs of a home without an index, dated by their run record", () => {
    const home = tempDir();
    const merged = { state: "handed-back" as const, followUp: { state: "merged" as const, repairs: 0 } };
    saved(home, "MR-1", { ...merged, pullRequests: ["https://github.com/acme/backend/pull/1"] });
    saved(home, "MR-2", { ...merged, repairOf: "MR-1-x" });
    saved(home, "MR-3", { state: "handed-back", followUp: { state: "open", repairs: 0 } });
    saved(home, "MR-4", { state: "released", followUp: { state: "merged", repairs: 0 } });
    expect(mergedIssues(home, loadRuns(home))).toEqual({
      "MR-1": { pullRequests: ["https://github.com/acme/backend/pull/1"], mergedAt: WRITTEN.toISOString() }
    });
    expect(fs.existsSync(path.join(home, MERGED_FILE))).toBe(false);
  });

  it("keeps an issue once its runs are gone and joins its pull requests, keeping the first merge", () => {
    const home = path.join(tempDir(), "home");
    recordMerged(home, [], "MR-9", ["https://github.com/acme/backend/pull/9"], new Date("2026-11-03T10:00:00.000Z"));
    recordMerged(home, [], "MR-5", ["https://github.com/acme/backend/pull/5"], new Date("2026-11-04T10:00:00.000Z"));
    recordMerged(home, [], "MR-9", ["https://github.com/acme/backend/pull/10"], new Date("2026-11-05T10:00:00.000Z"));
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(home, MERGED_FILE), "utf8")))).toEqual(["MR-5", "MR-9"]);
    expect(mergedIssues(home, [])["MR-9"]).toEqual({
      pullRequests: ["https://github.com/acme/backend/pull/9", "https://github.com/acme/backend/pull/10"],
      mergedAt: "2026-11-03T10:00:00.000Z"
    });
    saveMerged(home, { "MR-9": { pullRequests: [], mergedAt: "2026-11-06T10:00:00.000Z" } });
    recordMerged(home, [], "MR-9", [], new Date("2026-11-01T10:00:00.000Z"));
    expect(mergedIssues(home, [])["MR-9"].mergedAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("refuses an index it cannot read", () => {
    const home = tempDir();
    const file = path.join(home, MERGED_FILE);
    fs.writeFileSync(file, JSON.stringify({ "MR-1": { pullRequests: "none" } }));
    expect(() => mergedIssues(home, [])).toThrow(
      `${file} is not an index of merged issues:\nMR-1.pullRequests: Invalid input: expected array, received string\nMR-1.mergedAt: Invalid input: expected string, received undefined`
    );
    fs.writeFileSync(file, "[]");
    expect(() => mergedIssues(home, [])).toThrow(/root: /);
  });
});
