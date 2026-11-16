import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "./runs.js";
import { resetTime } from "./subscription.js";

export const AWAY_MS = 5 * 60_000;
export const GAP_MESSAGE = "resumed after a gap";
export const WHY_WINDOW_MS = 24 * 60 * 60_000;

export type Gap = { from: string; to: string };
export type RunGap = { id: string; wallMs: number | null; outsideMs: number | null; gaps: Gap[] };

const LOG_NAME = /^worker-(\d{4}-\d{2}-\d{2})\.log$/;

export function logGaps(text: string): Gap[] {
  return text.split("\n").flatMap((line) => {
    if (!line.includes(GAP_MESSAGE)) return [];
    try {
      const entry = JSON.parse(line) as { msg?: unknown; from?: unknown; to?: unknown };
      if (entry.msg !== GAP_MESSAGE || typeof entry.from !== "string" || typeof entry.to !== "string") return [];
      return [{ from: entry.from, to: entry.to }];
    } catch {
      return [];
    }
  });
}

export function readGaps(logs: string, since: Date): Gap[] {
  if (!fs.existsSync(logs)) return [];
  const day = since.toISOString().slice(0, 10);
  return fs
    .readdirSync(logs)
    .sort()
    .filter((name) => (LOG_NAME.exec(name)?.[1] ?? "") >= day)
    .flatMap((name) => logGaps(fs.readFileSync(path.join(logs, name), "utf8")));
}

export function overlapping(gaps: Gap[], since: Date, until: Date): Gap[] {
  return gaps.filter((gap) => new Date(gap.to) > since && new Date(gap.from) < until);
}

export function span(ms: number): string {
  const total = Math.round(ms / 60_000);
  const hours = Math.floor(total / 60);
  if (hours === 0) return `${total} min`;
  return total % 60 === 0 ? `${hours} h` : `${hours} h ${total % 60} min`;
}

export function gapText(gap: Gap): string {
  const length = new Date(gap.to).getTime() - new Date(gap.from).getTime();
  return `${resetTime(gap.from)} to ${resetTime(gap.to)} (${span(length)})`;
}

export function outsideClaude(record: RunRecord): number | null {
  if (record.wallMs === undefined || record.durationMs === undefined) return null;
  const outside = record.wallMs - record.durationMs;
  return outside > AWAY_MS ? outside : null;
}

export function runGap(record: RunRecord, gaps: Gap[], now: Date): RunGap | null {
  const until = record.endedAt === null ? now : new Date(record.endedAt);
  const within = overlapping(gaps, new Date(record.startedAt), until);
  const outsideMs = outsideClaude(record);
  if (within.length === 0 && outsideMs === null) return null;
  return { id: record.id, wallMs: record.wallMs ?? null, outsideMs, gaps: within };
}

export function runGapText(gap: RunGap): string {
  const took = gap.wallMs === null ? "" : ` took ${span(gap.wallMs)}`;
  const parts = [
    ...(gap.outsideMs === null
      ? []
      : [
          `${span(gap.outsideMs)} of it outside Claude's segments, spent in setup, the push or a pause such as the machine asleep`
        ]),
    ...gap.gaps.map((entry) => `the worker paused ${gapText(entry)}`)
  ];
  return `${gap.id}${took}, ${parts.join(", ")}`;
}
