import fs from "node:fs";
import path from "node:path";

export type RunState = "claimed" | "resolving" | "running" | "pushing" | "handed-back" | "released";
export type RunRecord = {
  id: string;
  key: string;
  shard: string | null;
  branch: string | null;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  turns: number;
  pullRequests: string[];
  blocked: string[];
  reason: string | null;
  identity: { jira: string; github: string | null };
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

export function newRun(key: string, now: Date, identity: RunRecord["identity"]): RunRecord {
  return {
    id: newRunId(key, now),
    key,
    shard: null,
    branch: null,
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

export function spentOn(runs: StoredRun[], day: Date): number {
  const prefix = day.toISOString().slice(0, 10);
  return runs
    .filter(({ record }) => record.startedAt.startsWith(prefix))
    .reduce((total, { record }) => total + record.costUsd, 0);
}
