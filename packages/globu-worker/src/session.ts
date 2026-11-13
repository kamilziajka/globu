import type { RunRecord, RunState } from "./runs.js";
import { clip, gray, green, red } from "./tui.js";
import type { FollowUpRow, PlanEntry } from "./worker.js";

export type Row = { key: string; summary: string; state: string; detail: string; url?: string; pickable?: boolean };
export type SessionList = {
  plan(entries: PlanEntry[]): Row[];
  run(record: RunRecord): Row[];
  followUps(entries: FollowUpRow[]): Row[];
  rows(): Row[];
  pickable(): Row[];
  pullRequests(): Row[];
};

const RUN_STATES: Record<RunState, string> = {
  claimed: "preparing",
  resolving: "preparing",
  prepared: "preparing",
  running: "running",
  pushing: "pushing",
  "handed-back": "handed back",
  released: "released"
};
const BUSY = new Set(["preparing", "running", "pushing"]);
const ALARM = new Set(["conflict", "checks failing", "needs human"]);
export const OPEN_PULL_STATES = new Set(["in review", "conflict", "checks failing", "needs human"]);
const SUMMARY_WIDTH = 48;

function planRow(entry: PlanEntry): Omit<Row, "key" | "summary"> {
  const { action } = entry;
  if (action.startsWith("would claim and run in ")) {
    return { state: "available", detail: action.slice("would claim and run in ".length) };
  }
  if (action.startsWith("would release: "))
    return { state: "not ready", detail: action.slice("would release: ".length) };
  if (action === "claimed") return { state: "preparing", detail: "" };
  return { state: "skipped", detail: action.replace(/^skipped, /, "") };
}

function runRow(record: RunRecord): Omit<Row, "key" | "summary"> {
  const state = RUN_STATES[record.state];
  if (record.state === "handed-back") return { state, detail: record.pullRequests.join(" ") };
  if (record.state === "released") return { state, detail: (record.reason as string).split("\n")[0] };
  return { state, detail: `since ${record.startedAt.slice(11, 16)} UTC` };
}

function changed(before: Row | undefined, row: Row): Row[] {
  return before?.state === row.state && before.detail === row.detail ? [] : [row];
}

export function sessionList(): SessionList {
  const rows = new Map<string, Row>();
  let pulls = new Map<string, Row>();
  const set = (row: Row): Row[] => {
    const before = rows.get(row.key);
    rows.set(row.key, row);
    return changed(before, row);
  };
  const all = () => [...pulls.values(), ...rows.values()];
  return {
    plan: (entries) =>
      entries.flatMap((entry) => {
        const current = rows.get(entry.key);
        if (current !== undefined && BUSY.has(current.state)) return [];
        const row = { key: entry.key, summary: entry.summary, ...planRow(entry) };
        return set({ ...row, pickable: row.state === "available" });
      }),
    run: (record) => set({ key: record.key, summary: rows.get(record.key)?.summary ?? "", ...runRow(record) }),
    followUps: (entries) => {
      const before = pulls;
      pulls = new Map(
        entries.map((entry) => {
          const key = `${entry.key} #${entry.number}`;
          const row = {
            key,
            summary: entry.summary,
            state: entry.state,
            detail: entry.url,
            url: entry.url,
            pickable: entry.repairable
          };
          return [key, row];
        })
      );
      return [...pulls.values()].flatMap((row) => changed(before.get(row.key), row));
    },
    rows: all,
    pickable: () => all().filter((row) => row.pickable === true),
    pullRequests: () => [...pulls.values()]
  };
}

export type TableView = { header: string; footer: string; selected?: string | null };

function marker(row: Row, view: TableView): string {
  if (view.selected === undefined) return "";
  if (row.key === view.selected) return `${green("●")} `;
  return row.pickable === true ? `${gray("○")} ` : "  ";
}

function paint(row: Row, view: TableView, text: string): string {
  if (row.key === view.selected) return green(text);
  if (ALARM.has(row.state)) return red(text);
  return row.pickable === true ? text : gray(text);
}

export function renderTable(list: SessionList, view: TableView): string {
  const rows = list.rows();
  const { header, footer } = view;
  if (rows.length === 0) return `${header}\n\nNo issues match the JQL right now.\n\n${footer}\n`;
  const width = (pick: (row: Row) => string) => Math.max(...rows.map((row) => pick(row).length));
  const keyWidth = width((row) => row.key);
  const summaryWidth = width((row) => clip(row.summary, SUMMARY_WIDTH));
  const stateWidth = width((row) => row.state);
  const lines = rows.map((row) => {
    const columns = [
      row.key.padEnd(keyWidth),
      clip(row.summary, SUMMARY_WIDTH).padEnd(summaryWidth),
      row.state.padEnd(stateWidth),
      row.detail
    ];
    const text = columns.join("  ").trimEnd();
    return `${marker(row, view)}${paint(row, view, text)}`;
  });
  return `${header}\n\n${lines.join("\n")}\n\n${footer}\n`;
}

export function rowLine(row: Row, now: Date): string {
  return `${now.toISOString()} ${row.key} ${row.state}${row.detail === "" ? "" : `: ${row.detail}`}`;
}
