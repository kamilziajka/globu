import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import {
  GAP_MESSAGE,
  gapText,
  logGaps,
  outsideClaude,
  overlapping,
  readGaps,
  runGap,
  runGapText,
  span
} from "./gaps.js";
import { fileLogger } from "./logger.js";
import { newRun, type RunRecord } from "./runs.js";

const NIGHT = { from: "2026-11-15T23:14:00.000Z", to: "2026-11-16T05:52:00.000Z" };

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...newRun("MR-1", new Date("2026-11-15T22:00:00.000Z"), { jira: "Bot", github: null }), ...overrides };
}

describe("gaps", () => {
  it("reads the gaps the worker logged, from the day the window starts", () => {
    const home = tempDir();
    const logs = path.join(home, "logs");
    expect(readGaps(logs, new Date("2026-11-15T00:00:00.000Z"))).toEqual([]);
    let now = new Date(NIGHT.to);
    const logger = fileLogger({ dir: logs, level: "warn", secrets: [], now: () => now });
    logger.warn(GAP_MESSAGE, NIGHT);
    now = new Date("2026-11-14T08:00:00.000Z");
    logger.warn(GAP_MESSAGE, { from: "2026-11-14T07:00:00.000Z", to: "2026-11-14T08:00:00.000Z" });
    write(home, "logs/notes.txt", JSON.stringify({ msg: GAP_MESSAGE, ...NIGHT }));
    expect(readGaps(logs, new Date("2026-11-15T12:00:00.000Z"))).toEqual([NIGHT]);
    expect(readGaps(logs, new Date("2026-11-14T12:00:00.000Z"))).toHaveLength(2);
  });

  it("skips lines that are not a gap event", () => {
    const lines = [
      JSON.stringify({ msg: "command", stderr: GAP_MESSAGE }),
      `{"msg":"${GAP_MESSAGE}","from":"2026-11-15T23`,
      JSON.stringify({ msg: GAP_MESSAGE, from: 1, to: 2 }),
      JSON.stringify({ msg: GAP_MESSAGE, from: NIGHT.from }),
      JSON.stringify({ msg: "cycle" }),
      JSON.stringify({ level: "warn", msg: GAP_MESSAGE, ...NIGHT })
    ];
    expect(logGaps(lines.join("\n"))).toEqual([NIGHT]);
  });

  it("keeps the gaps that overlap a window", () => {
    const at = (iso: string) => new Date(iso);
    expect(overlapping([NIGHT], at("2026-11-16T05:00:00.000Z"), at("2026-11-16T09:00:00.000Z"))).toEqual([NIGHT]);
    expect(overlapping([NIGHT], at("2026-11-15T20:00:00.000Z"), at("2026-11-15T23:30:00.000Z"))).toEqual([NIGHT]);
    expect(overlapping([NIGHT], at("2026-11-16T05:52:00.000Z"), at("2026-11-16T09:00:00.000Z"))).toEqual([]);
    expect(overlapping([NIGHT], at("2026-11-15T20:00:00.000Z"), at("2026-11-15T23:14:00.000Z"))).toEqual([]);
  });

  it("names a length in minutes and hours", () => {
    expect(span(40 * 60_000)).toBe("40 min");
    expect(span(3 * 60 * 60_000)).toBe("3 h");
    expect(span(398 * 60_000)).toBe("6 h 38 min");
    expect(gapText(NIGHT)).toBe("2026-11-15 23:14 UTC to 2026-11-16 05:52 UTC (6 h 38 min)");
  });

  it("counts the wall time of a run that Claude's segments do not account for", () => {
    expect(outsideClaude(run())).toBeNull();
    expect(outsideClaude(run({ wallMs: 60 * 60_000 }))).toBeNull();
    expect(outsideClaude(run({ wallMs: 30 * 60_000, durationMs: 27 * 60_000 }))).toBeNull();
    expect(outsideClaude(run({ wallMs: 8 * 60 * 60_000, durationMs: 60 * 60_000 }))).toBe(7 * 60 * 60_000);
  });

  it("names a run that a gap or time outside Claude's segments stretched", () => {
    const now = new Date("2026-11-16T09:00:00.000Z");
    const ended = { endedAt: "2026-11-16T06:30:00.000Z", wallMs: 8.5 * 60 * 60_000, durationMs: 60 * 60_000 };
    expect(runGap(run({ endedAt: "2026-11-15T22:30:00.000Z", wallMs: 30 * 60_000 }), [NIGHT], now)).toBeNull();
    const both = runGap(run(ended), [NIGHT], now);
    expect(both).toEqual({
      id: "MR-1-20261115T220000Z",
      wallMs: 8.5 * 60 * 60_000,
      outsideMs: 7.5 * 60 * 60_000,
      gaps: [NIGHT]
    });
    expect(runGapText(both as NonNullable<typeof both>)).toBe(
      "MR-1-20261115T220000Z took 8 h 30 min, 7 h 30 min of it outside Claude's segments, spent in setup, the push or a pause such as the machine asleep, the worker paused 2026-11-15 23:14 UTC to 2026-11-16 05:52 UTC (6 h 38 min)"
    );
    const open = runGap(run(), [NIGHT], now);
    expect(open).toEqual({ id: "MR-1-20261115T220000Z", wallMs: null, outsideMs: null, gaps: [NIGHT] });
    expect(runGapText(open as NonNullable<typeof open>)).toBe(
      "MR-1-20261115T220000Z, the worker paused 2026-11-15 23:14 UTC to 2026-11-16 05:52 UTC (6 h 38 min)"
    );
  });
});
