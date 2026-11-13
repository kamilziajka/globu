import { type Check, checksLine } from "./check.js";
import { loadRuns, spentOn } from "./runs.js";
import { type Row, renderTable, rowLine, sessionList } from "./session.js";
import { CLEAR, clip, gray, HIDE_CURSOR, type Screen, SHOW_CURSOR, widthOf } from "./tui.js";
import { once, type WorkerDeps } from "./worker.js";

export type Key = "up" | "down" | "enter" | "refresh" | "quit" | "other";
export type ReadKey = () => Promise<Key>;
export type Mode = "pick" | "auto";
export type StartOptions = {
  mode: Mode;
  screen?: Screen;
  readKey?: ReadKey;
  checks?: Check[];
  untilStopped: (deps: WorkerDeps) => Promise<void>;
};

export const PICK_KEYS = "↑↓ select   ⏎ run   r refresh   q quit";
export const AUTO_KEYS = "Ctrl+C stops after the current run";

export function parseMode(value: string): Mode {
  if (value === "pick" || value === "auto") return value;
  throw new Error(`invalid mode "${value}", use pick or auto`);
}

export async function start(deps: WorkerDeps, options: StartOptions): Promise<void> {
  const list = sessionList();
  const { screen, mode } = options;
  let notice = "";
  let status = "";
  let selected: string | null = null;
  const title = `globu-worker in ${mode} mode on ${deps.config.jira.site}, one issue at a time`;
  const checks = options.checks ?? [];
  const access = (width: number) => (checks.length === 0 ? "" : `\n${gray(clip(checksLine(checks), width))}`);
  const show = (changed: Row[]) => {
    const now = deps.now();
    if (screen === undefined) {
      for (const row of changed) deps.io.out(rowLine(row, now));
      return;
    }
    const spent = spentOn(loadRuns(deps.home), now).toFixed(2);
    const extra = [status, notice].filter((text) => text !== "").map((text) => ` ${text}`);
    const spend = `Spent today ${spent} of ${deps.config.limits.dayUsd.toFixed(2)} USD.${extra.join("")}`;
    const footer = `${spend}\n${gray(mode === "pick" ? PICK_KEYS : AUTO_KEYS)}`;
    const header = `${title}${access(widthOf(screen))}`;
    const view = mode === "pick" ? { header, footer, selected } : { header, footer };
    screen.write(`${CLEAR}${renderTable(list, view)}`);
  };
  const worker: WorkerDeps = {
    ...deps,
    config: { ...deps.config, limits: { ...deps.config.limits, concurrent: 1 } },
    io: { ...deps.io, out: () => {} },
    onPlan: (plan) => show(list.plan(plan)),
    onRun: (record) => show(list.run(record))
  };
  if (mode === "auto") return await options.untilStopped(worker);

  const readKey = options.readKey as ReadKey;
  const pickScreen = screen as Screen;
  const attempt = async (work: () => Promise<unknown>, label: string) => {
    try {
      await work();
    } catch (err) {
      notice = `${label}: ${(err as Error).message}`;
    }
  };
  pickScreen.write(HIDE_CURSOR);
  try {
    for (;;) {
      status = "Polling Jira...";
      show([]);
      await attempt(() => once(worker, { dryRun: true }), "Polling failed");
      status = "";
      for (;;) {
        const keys = list.available().map((row) => row.key);
        const at = Math.max(keys.indexOf(selected as string), 0);
        selected = keys.length === 0 ? null : keys[at];
        show([]);
        const key = await readKey();
        notice = "";
        if (key === "quit") return;
        if (key === "refresh") break;
        if (key === "enter" && selected !== null) {
          const chosen = selected;
          status = `Running ${chosen}...`;
          show([]);
          await attempt(() => once(worker, { issue: chosen }), chosen);
          break;
        }
        if (keys.length === 0) continue;
        const step = key === "up" ? -1 : key === "down" ? 1 : 0;
        selected = keys[(at + step + keys.length) % keys.length];
      }
    }
  } finally {
    pickScreen.write(SHOW_CURSOR);
  }
}
