import fs from "node:fs";
import path from "node:path";

export type RunState = "claimed" | "resolving" | "prepared" | "running" | "pushing" | "handed-back" | "released";
export type RunDriver = "worker" | "session";
export type StoredWorktree = { shard: string; tree: string; branch: string; base: string };
export type FollowUp = { state: "open" | "merged" | "closed" | "needs-human"; repairs: number };
export type RunRecord = {
  id: string;
  key: string;
  driver: RunDriver;
  shard: string | null;
  branch: string | null;
  worktrees: StoredWorktree[];
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  turns: number;
  pullRequests: string[];
  blocked: string[];
  reason: string | null;
  identity: { jira: string; github: string | null };
  repairOf?: string;
  followUp?: FollowUp;
  followUpIssues?: string[];
  environment?: boolean;
  denied?: string[];
  durationMs?: number;
  apiMs?: number;
};
export type StoredRun = { dir: string; record: RunRecord };

const TERMINAL: RunState[] = ["handed-back", "released"];
const RECORD = "run.json";

export function isTerminal(state: RunState): boolean {
  return TERMINAL.includes(state);
}

export function runsDir(home: string): string {
  return path.join(home, "runs");
}

export function newRunId(key: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${key}-${stamp}`;
}

export function newRun(
  key: string,
  now: Date,
  identity: RunRecord["identity"],
  driver: RunDriver = "worker"
): RunRecord {
  return {
    id: newRunId(key, now),
    key,
    driver,
    shard: null,
    branch: null,
    worktrees: [],
    state: "claimed",
    startedAt: now.toISOString(),
    endedAt: null,
    costUsd: 0,
    turns: 0,
    pullRequests: [],
    blocked: [],
    reason: null,
    identity
  };
}

export function saveRun(dir: string, record: RunRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

export function loadRuns(home: string): StoredRun[] {
  const root = runsDir(home);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .sort()
    .flatMap((name) => {
      const dir = path.join(root, name);
      const file = path.join(dir, RECORD);
      return fs.existsSync(file) ? [{ dir, record: JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord }] : [];
    });
}

export function loadRun(home: string, id: string): StoredRun {
  const found = loadRuns(home).find(({ record }) => record.id === id);
  if (found === undefined) throw new Error(`no run ${id} in ${runsDir(home)}`);
  return found;
}

export function spentOn(runs: StoredRun[], day: Date): number {
  const prefix = day.toISOString().slice(0, 10);
  return runs
    .filter(({ record }) => record.startedAt.startsWith(prefix))
    .reduce((total, { record }) => total + record.costUsd, 0);
}

export function followingUp(record: RunRecord): boolean {
  const state = record.followUp?.state ?? "open";
  return (
    record.state === "handed-back" && record.repairOf === undefined && (state === "open" || state === "needs-human")
  );
}

export function latestRuns(runs: StoredRun[], count: number): StoredRun[] {
  return [...runs].sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt)).slice(0, count);
}

export function removeLinks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name);
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) fs.unlinkSync(entry);
    else if (stat.isDirectory()) removeLinks(entry);
  }
}

export function removeTree(dir: string): void {
  removeLinks(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function prunableRuns(runs: StoredRun[], keep: number, now: Date): StoredRun[] {
  const open = new Set(runs.filter(({ record }) => followingUp(record)).map(({ record }) => record.id));
  const today = now.toISOString().slice(0, 10);
  const kept = new Set(latestRuns(runs, keep).map(({ record }) => record.id));
  return runs.filter(
    ({ record }) =>
      !kept.has(record.id) &&
      isTerminal(record.state) &&
      !open.has(record.id) &&
      !open.has(record.repairOf ?? "") &&
      !record.startedAt.startsWith(today)
  );
}

export function pruneRuns(home: string, keep: number, now: Date): string[] {
  const pruned = prunableRuns(loadRuns(home), keep, now);
  for (const { dir } of pruned) removeTree(dir);
  return pruned.map(({ record }) => record.id);
}
