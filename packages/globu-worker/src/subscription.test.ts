import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import {
  currentUsage,
  holdReason,
  loadSubscription,
  overLimit,
  recordUsage,
  SUBSCRIPTION_FILE,
  usageLine
} from "./subscription.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const FIVE = { window: "five_hour", utilization: 0.15, resetsAt: "2026-11-14T12:30:00.000Z" };
const SEVEN = { window: "seven_day", utilization: 0.6, resetsAt: "2026-11-16T08:00:00.000Z" };

describe("recordUsage", () => {
  it("keeps the latest figure per window in the worker's home", () => {
    const home = path.join(tempDir(), "home");
    expect(loadSubscription(home)).toBeNull();
    recordUsage(home, [FIVE, SEVEN], NOW);
    const later = new Date("2026-11-14T11:00:00.000Z");
    const fresher = { ...FIVE, utilization: 0.4 };
    recordUsage(home, [fresher], later);
    expect(loadSubscription(home)).toEqual({ seenAt: later.toISOString(), windows: [SEVEN, fresher] });
  });

  it("ignores a file it cannot read as a subscription", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, SUBSCRIPTION_FILE), "{}");
    expect(loadSubscription(home)).toBeNull();
    expect(currentUsage(home, {}, NOW)).toEqual([]);
  });
});

describe("currentUsage", () => {
  it("drops windows that have reset and every figure while the runs bill an API key", () => {
    const home = tempDir();
    recordUsage(home, [FIVE, SEVEN], NOW);
    expect(currentUsage(home, {}, NOW)).toEqual([FIVE, SEVEN]);
    expect(currentUsage(home, {}, new Date("2026-11-14T13:00:00.000Z"))).toEqual([SEVEN]);
    expect(currentUsage(home, { ANTHROPIC_API_KEY: "sk" }, NOW)).toEqual([]);
  });
});

describe("overLimit", () => {
  it("names the window over the limit that resets last", () => {
    expect(overLimit([FIVE, SEVEN], 70)).toBeNull();
    expect(overLimit([FIVE, SEVEN], 60)).toEqual(SEVEN);
    const full = { ...FIVE, utilization: 0.9 };
    expect(overLimit([SEVEN, full], 50)).toEqual(SEVEN);
    expect(overLimit([full, SEVEN], 50)).toEqual(SEVEN);
    expect(overLimit([full, { ...SEVEN, utilization: 0.1 }], 70)).toEqual(full);
  });
});

describe("usageLine and holdReason", () => {
  it("shows every window against the limit, or the one that holds and when it resets", () => {
    expect(usageLine([], 70)).toBe("");
    expect(usageLine([FIVE, SEVEN], 70)).toBe("subscription five-hour 15 %, seven-day 60 % of 70 %");
    expect(usageLine([FIVE, SEVEN], 60)).toBe("subscription seven-day at 60 %, holding until 2026-11-16 08:00 UTC");
    expect(holdReason(SEVEN, 60)).toBe(
      "the subscription's seven-day window is at 60 %, the limit is 60 %, it resets at 2026-11-16 08:00 UTC"
    );
  });
});
