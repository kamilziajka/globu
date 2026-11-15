import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { FILED_FILE, filedFor, forgetFiled, saveFiled } from "./filed.js";

describe("filed follow-ups", () => {
  it("keeps the follow-ups of each issue in the home, sorted by issue, until they are forgotten", () => {
    const home = path.join(tempDir(), "home");
    expect(filedFor(home, "MR-7")).toEqual([]);
    forgetFiled(home, "MR-7");
    expect(fs.existsSync(path.join(home, FILED_FILE))).toBe(false);
    saveFiled(home, "MR-7", [{ summary: "One", key: "MR-9", linked: false }]);
    saveFiled(home, "MR-10", [{ summary: "Two", key: "MR-11", linked: true }]);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(home, FILED_FILE), "utf8")))).toEqual(["MR-10", "MR-7"]);
    expect(filedFor(home, "MR-7")).toEqual([{ summary: "One", key: "MR-9", linked: false }]);
    forgetFiled(home, "MR-7");
    forgetFiled(home, "MR-8");
    expect(filedFor(home, "MR-7")).toEqual([]);
    expect(filedFor(home, "MR-10")).toHaveLength(1);
  });

  it("refuses a file that is not an index of filed follow-ups", () => {
    const home = tempDir();
    const file = write(home, FILED_FILE, JSON.stringify({ "MR-7": [{ summary: "One" }] }));
    expect(() => filedFor(home, "MR-7")).toThrow(`${file} is not an index of filed follow-ups:\nMR-7.0.key:`);
    write(home, FILED_FILE, "[]");
    expect(() => filedFor(home, "MR-7")).toThrow(/root: /);
  });
});
