import { type Check, checksLine } from "./check.js";
import { loadRuns, spentOn } from "./runs.js";
import { OPEN_PULL_STATES, type Row, renderTable, rowLine, sessionList } from "./session.js";
import { CLEAR, clip, gray, HIDE_CURSOR, type Screen, SHOW_CURSOR, widthOf } from "./tui.js";
import { followUps, once, type WorkerDeps } from "./worker.js";

export type Key = "up" | "down" | "enter" | "refresh" | "quit" | "other";
export type ReadKey = () => Promise<Key>;
export type Mode = "pick" | "auto";
export type StartOptions = {
  mode: Mode;
  screen?: Screen;
  readKey?: ReadKey;
  checks?: Check[];
  wait?: (ms: number) => Promise<void>;
  untilStopped: (deps: WorkerDeps) => Promise<void>;
};

export const PICK_KEYS = "↑↓ select   ⏎ run or repair   r refresh   q quit";
const never = () => new Promise<void>(() => {});
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
    const pulls = list.pullRequests();
    const open = pulls.filter((row) => OPEN_PULL_STATES.has(row.state)).length;
    const fix = pulls.filter((row) => row.pickable === true).length;
    const counts = `${open} of ${deps.config.limits.openPullRequests} pull requests open${fix === 0 ? "" : `, ${fix} need a fix`}`;
    const spend = `Spent today ${spent} of ${deps.config.limits.dayUsd.toFixed(2)} USD, ${counts}.${extra.join("")}`;
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
    onRun: (record) => show(list.run(record)),
    onFollowUps: (rows) => show(list.followUps(rows))
  };
  if (mode === "auto") return await options.untilStopped(worker);

  const readKey = options.readKey as ReadKey;
  const wait = options.wait ?? never;
  const pickScreen = screen as Screen;
  let pending: Promise<Key> | null = null;
  let tick: Promise<"tick"> | null = null;
  const nextEvent = async (): Promise<Key | "tick"> => {
    pending ??= readKey();
    tick ??= wait(deps.config.poll.every).then(() => "tick" as const);
    const event = await Promise.race([pending, tick]);
    if (event === "tick") tick = null;
    else pending = null;
    return event;
  };
  const refresh = async () => {
    await once(worker, { dryRun: true });
    await followUps(worker, true);
  };
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
      status = "Polling Jira and GitHub...";
      show([]);
      await attempt(refresh, "Polling failed");
      status = "";
      for (;;) {
        const rows = list.pickable();
        const keys = rows.map((row) => row.key);
        const at = Math.max(keys.indexOf(selected as string), 0);
        selected = keys.length === 0 ? null : keys[at];
        show([]);
        const key = await nextEvent();
        if (key === "tick") {
          await attempt(refresh, "Polling failed");
          continue;
        }
        notice = "";
        if (key === "quit") return;
        if (key === "refresh") break;
        if (key === "enter" && selected !== null) {
          const chosen = rows[at];
          const url = chosen.url;
          status = url === undefined ? `Running ${chosen.key}...` : `Repairing ${chosen.key}...`;
          show([]);
          const options = url === undefined ? { issue: chosen.key } : { repair: url };
          await attempt(() => once(worker, options), chosen.key);
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
