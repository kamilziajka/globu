import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { unmet } from "./handback.js";
import type { StoredRun } from "./runs.js";

const MergedIssueSchema = z.object({ pullRequests: z.array(z.string()), mergedAt: z.string() });
const MergedIndexSchema = z.record(z.string(), MergedIssueSchema);

export type MergedIssue = z.infer<typeof MergedIssueSchema>;
export type MergedIndex = Record<string, MergedIssue>;

export const MERGED_FILE = "merged.json";

function fileOf(home: string): string {
  return path.join(home, MERGED_FILE);
}

function add(index: MergedIndex, key: string, pullRequests: string[], mergedAt: string): void {
  const known = index[key];
  if (known === undefined) {
    index[key] = { pullRequests: [...pullRequests], mergedAt };
    return;
  }
  known.pullRequests = [...new Set([...known.pullRequests, ...pullRequests])];
  if (mergedAt < known.mergedAt) known.mergedAt = mergedAt;
}

function loadFile(home: string): MergedIndex {
  const file = fileOf(home);
  if (!fs.existsSync(file)) return {};
  const parsed = MergedIndexSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
    throw new Error(`${file} is not an index of merged issues:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

export function mergedRun({ record }: StoredRun): boolean {
  return (
    record.repairOf === undefined &&
    record.state === "handed-back" &&
    record.followUp?.state === "merged" &&
    !unmet(record.outcome)
  );
}

export function mergedIssues(home: string, runs: StoredRun[]): MergedIndex {
  const index = loadFile(home);
  for (const stored of runs.filter(mergedRun)) {
    const written = fs.statSync(path.join(stored.dir, "run.json")).mtime.toISOString();
    add(index, stored.record.key, stored.record.pullRequests, written);
  }
  return index;
}

export function saveMerged(home: string, index: MergedIndex): void {
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(fileOf(home), `${JSON.stringify(sorted, null, 2)}\n`);
}

export function recordMerged(home: string, runs: StoredRun[], key: string, pullRequests: string[], at: Date): void {
  const index = mergedIssues(home, runs);
  add(index, key, pullRequests, at.toISOString());
  saveMerged(home, index);
}
