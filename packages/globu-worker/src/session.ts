import type { RunRecord, RunState } from "./runs.js";
import { clip, gray, green } from "./tui.js";
import type { PlanEntry } from "./worker.js";

export type Row = { key: string; summary: string; state: string; detail: string };
export type SessionList = {
  plan(entries: PlanEntry[]): Row[];
  run(record: RunRecord): Row[];
  rows(): Row[];
  available(): Row[];
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

export function sessionList(): SessionList {
  const rows = new Map<string, Row>();
  const set = (row: Row): Row[] => {
    const before = rows.get(row.key);
    rows.set(row.key, row);
    return before?.state === row.state && before.detail === row.detail ? [] : [row];
  };
  return {
    plan: (entries) =>
      entries.flatMap((entry) => {
        const current = rows.get(entry.key);
        if (current !== undefined && BUSY.has(current.state)) return [];
        return set({ key: entry.key, summary: entry.summary, ...planRow(entry) });
      }),
    run: (record) => set({ key: record.key, summary: rows.get(record.key)?.summary ?? "", ...runRow(record) }),
    rows: () => [...rows.values()],
    available: () => [...rows.values()].filter((row) => row.state === "available")
  };
}

export type TableView = { header: string; footer: string; selected?: string | null };

function marker(row: Row, view: TableView): string {
  if (view.selected === undefined) return "";
  if (row.key === view.selected) return `${green("●")} `;
  return row.state === "available" ? `${gray("○")} ` : "  ";
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
    const painted = row.key === view.selected ? green(text) : row.state === "available" ? text : gray(text);
    return `${marker(row, view)}${painted}`;
  });
  return `${header}\n\n${lines.join("\n")}\n\n${footer}\n`;
}

export function rowLine(row: Row, now: Date): string {
  return `${now.toISOString()} ${row.key} ${row.state}${row.detail === "" ? "" : `: ${row.detail}`}`;
}
