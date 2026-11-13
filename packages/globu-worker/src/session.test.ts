import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { newRun, type RunRecord } from "./runs.js";
import { renderTable, rowLine, sessionList } from "./session.js";

const NOW = new Date("2026-11-13T10:42:00.000Z");

function run(key: string, patch: Partial<RunRecord>): RunRecord {
  return { ...newRun(key, NOW, { jira: "Bot", github: null }), ...patch };
}

describe("sessionList", () => {
  it("turns poll results into rows and reports only what changed", () => {
    const list = sessionList();
    const changed = list.plan([
      {
        key: "MR-1",
        summary: "Add the thing",
        shard: "backend",
        action: "would claim and run in backend (2 references resolved)"
      },
      { key: "MR-2", summary: "Broken refs", shard: "backend", action: "would release: 1 of 2 references missing" },
      { key: "MR-3", summary: "Taken", shard: "backend", action: "skipped, already assigned" },
      { key: "MR-4", summary: "Now", shard: "backend", action: "claimed" }
    ]);
    expect(changed.map((row) => [row.key, row.state, row.detail])).toEqual([
      ["MR-1", "available", "backend (2 references resolved)"],
      ["MR-2", "not ready", "1 of 2 references missing"],
      ["MR-3", "skipped", "already assigned"],
      ["MR-4", "preparing", ""]
    ]);
    expect(list.pickable().map((row) => row.key)).toEqual(["MR-1"]);
    expect(
      list.plan([
        {
          key: "MR-1",
          summary: "Add the thing",
          shard: "backend",
          action: "would claim and run in backend (2 references resolved)"
        }
      ])
    ).toEqual([]);
  });

  it("follows a run through its states and keeps a busy row when the next poll lists it", () => {
    const list = sessionList();
    list.plan([
      {
        key: "MR-1",
        summary: "Add the thing",
        shard: "backend",
        action: "would claim and run in backend (0 references resolved)"
      }
    ]);
    expect(list.run(run("MR-1", { state: "running" }))).toEqual([
      { key: "MR-1", summary: "Add the thing", state: "running", detail: "since 10:42 UTC" }
    ]);
    expect(
      list.plan([{ key: "MR-1", summary: "Add the thing", shard: "backend", action: "skipped, already assigned" }])
    ).toEqual([]);
    expect(list.run(run("MR-1", { state: "running" }))).toEqual([]);
    expect(
      list.run(run("MR-1", { state: "handed-back", pullRequests: ["https://x/1", "https://x/2"] }))[0].detail
    ).toBe("https://x/1 https://x/2");
    expect(list.run(run("MR-9", { state: "released", reason: "no marker\nmore" }))).toEqual([
      { key: "MR-9", summary: "", state: "released", detail: "no marker" }
    ]);
    expect(list.run(run("MR-8", { state: "claimed" }))[0].state).toBe("preparing");
    expect(list.run(run("MR-8", { state: "pushing" }))[0].state).toBe("pushing");
  });
});

describe("pull request rows", () => {
  it("lists pull requests first, makes the repairable ones pickable and reports what changed", () => {
    const list = sessionList();
    list.plan([
      { key: "MR-1", summary: "First", shard: "b", action: "would claim and run in b (0 references resolved)" }
    ]);
    list.run(run("MR-7", { state: "handed-back", pullRequests: ["https://x/7"] }));
    const entries = [
      {
        run: "r7",
        key: "MR-7",
        url: "https://x/7",
        number: 7,
        summary: "Seven",
        state: "conflict" as const,
        repairable: true
      },
      {
        run: "r8",
        key: "MR-8",
        url: "https://x/8",
        number: 8,
        summary: "Eight",
        state: "needs human" as const,
        repairable: false
      }
    ];
    expect(list.followUps(entries).map((row) => row.key)).toEqual(["MR-7 #7", "MR-8 #8"]);
    expect(list.followUps(entries)).toEqual([]);
    expect(list.rows().map((row) => row.key)).toEqual(["MR-7 #7", "MR-8 #8", "MR-1", "MR-7"]);
    expect(list.pickable().map((row) => row.key)).toEqual(["MR-7 #7", "MR-1"]);
    expect(list.pullRequests()[0]).toMatchObject({ state: "conflict", url: "https://x/7", pickable: true });
    const table = plain(renderTable(list, { header: "h", footer: "f", selected: "MR-1" })).split("\n");
    expect(table[2].startsWith("○ MR-7 #7")).toBe(true);
    expect(table[3].startsWith("  MR-8 #8")).toBe(true);
    expect(table[4].startsWith("● MR-1")).toBe(true);
  });
});

describe("renderTable and rowLine", () => {
  it("aligns columns, clips long summaries and marks the selection in pick mode", () => {
    const empty = sessionList();
    expect(plain(renderTable(empty, { header: "head", footer: "foot" }))).toBe(
      "head\n\nNo issues match the JQL right now.\n\nfoot\n"
    );
    const list = sessionList();
    list.plan([
      { key: "MR-10", summary: "x".repeat(60), shard: "b", action: "would claim and run in b (0 references resolved)" },
      { key: "MR-2", summary: "Short", shard: "b", action: "skipped, already assigned" },
      { key: "MR-3", summary: "Third", shard: "b", action: "would claim and run in b (1 references resolved)" }
    ]);
    const auto = plain(renderTable(list, { header: "head", footer: "foot" })).split("\n");
    expect(auto[2]).toBe(`MR-10  ${"x".repeat(47)}…  available  b (0 references resolved)`);
    expect(auto[3]).toBe(`MR-2   Short${" ".repeat(43)}  skipped    already assigned`);
    expect(auto.at(-2)).toBe("foot");
    const pick = plain(renderTable(list, { header: "head", footer: "foot", selected: "MR-3" })).split("\n");
    expect(pick[2]).toBe(`○ MR-10  ${"x".repeat(47)}…  available  b (0 references resolved)`);
    expect(pick[3]).toBe(`  MR-2   Short${" ".repeat(43)}  skipped    already assigned`);
    expect(pick[4]).toBe(`● MR-3   Third${" ".repeat(43)}  available  b (1 references resolved)`);
    const none = plain(renderTable(list, { header: "head", footer: "foot", selected: null })).split("\n");
    expect(none[4].startsWith("○ MR-3")).toBe(true);
  });

  it("prints one line per state change", () => {
    expect(rowLine({ key: "MR-1", summary: "s", state: "released", detail: "why" }, NOW)).toBe(
      "2026-11-13T10:42:00.000Z MR-1 released: why"
    );
    expect(rowLine({ key: "MR-1", summary: "s", state: "preparing", detail: "" }, NOW)).toBe(
      "2026-11-13T10:42:00.000Z MR-1 preparing"
    );
  });
});
