import fs from "node:fs";
import path from "node:path";
import { LOG_FILENAME } from "./constants.js";

export const DEFAULT_LOG_BODY = "# Knowledge base update log\n\n";

const DAY_HEADING = /^## (\S+)(?:\s+\(.*\))?$/;

function headingDate(line: string): string | undefined {
  return DAY_HEADING.exec(line.trim())?.[1];
}

export function appendLogEntry(logBody: string, date: string, entries: string[], title?: string): string {
  const bullets = entries.map((entry) => `* ${entry}`).join("\n");
  const lines = logBody.split("\n");
  const existingIdx = lines.findIndex((line) => headingDate(line) === date);

  if (existingIdx !== -1) {
    lines.splice(existingIdx + 1, 0, bullets);
    return lines.join("\n");
  }

  const heading = title ? `## ${date} (${title})` : `## ${date}`;
  const firstSectionIdx = logBody.search(/^## /m);
  if (firstSectionIdx === -1) return `${logBody.trimEnd()}\n\n${heading}\n${bullets}\n`;
  return `${logBody.slice(0, firstSectionIdx)}${heading}\n${bullets}\n\n${logBody.slice(firstSectionIdx)}`;
}

export function appendLog(docsDir: string, date: string, entries: string[], title?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  if (entries.length === 0) throw new Error("at least one log entry is required");
  const logPath = path.join(docsDir, LOG_FILENAME);
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : DEFAULT_LOG_BODY;
  fs.writeFileSync(logPath, appendLogEntry(existing, date, entries, title));
  return logPath;
}
