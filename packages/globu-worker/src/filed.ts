import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const FiledEntrySchema = z.object({ summary: z.string(), key: z.string(), linked: z.boolean() });
const FiledIndexSchema = z.record(z.string(), z.array(FiledEntrySchema));

export type FiledEntry = z.infer<typeof FiledEntrySchema>;
type FiledIndex = Record<string, FiledEntry[]>;

export const FILED_FILE = "followups.json";

function fileOf(home: string): string {
  return path.join(home, FILED_FILE);
}

function loadFile(home: string): FiledIndex {
  const file = fileOf(home);
  if (!fs.existsSync(file)) return {};
  const parsed = FiledIndexSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
    throw new Error(`${file} is not an index of filed follow-ups:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

export function filedFor(home: string, key: string): FiledEntry[] {
  return loadFile(home)[key] ?? [];
}

export function saveFiled(home: string, key: string, entries: FiledEntry[]): void {
  const index = loadFile(home);
  if (entries.length === 0 && index[key] === undefined) return;
  if (entries.length === 0) delete index[key];
  else index[key] = entries;
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(fileOf(home), `${JSON.stringify(sorted, null, 2)}\n`);
}

export function forgetFiled(home: string, key: string): void {
  saveFiled(home, key, []);
}
