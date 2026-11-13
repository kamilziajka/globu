import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { checkLine, checkProgress, clip, SPINNER } from "./tui.js";

describe("tui", () => {
  it("clips text to a width", () => {
    expect(clip("abcdef", 10)).toBe("abcdef");
    expect(clip("abcdef", 4)).toBe("abc…");
  });

  it("draws a spinner, a check mark or a cross per check", () => {
    expect(checkLine("jira", undefined, 11, 80)).toBe(`${SPINNER[1]} jira: checking`);
    expect(plain(checkLine("jira", { name: "jira", ok: true, detail: "as Bot" }, 0, 80))).toBe("✔ jira: as Bot");
    expect(plain(checkLine("jira", { name: "jira", ok: false, detail: "401" }, 0, 80))).toBe("✖ jira: 401");
    expect(plain(checkLine("claude", { name: "claude", ok: true, detail: "x".repeat(40) }, 0, 20))).toBe(
      `✔ claude: ${"x".repeat(9)}…`
    );
  });

  it("redraws the lines in place on every tick and update, and stops the ticks when done", () => {
    const frames: string[] = [];
    let tick: () => void = () => {};
    let stopped = false;
    const progress = checkProgress({ write: (text) => frames.push(text) }, ["jira", "claude"], (next, ms) => {
      expect(ms).toBe(80);
      tick = next;
      return () => {
        stopped = true;
      };
    });
    expect(plain(frames[0])).toBe(`${SPINNER[0]} jira: checking\n${SPINNER[0]} claude: checking\n`);
    tick();
    expect(frames[1].startsWith("\u001b[2A")).toBe(true);
    expect(plain(frames[1])).toContain(`${SPINNER[1]} jira: checking`);
    progress.update({ name: "jira", ok: true, detail: "as Bot" });
    expect(plain(frames[2])).toContain("✔ jira: as Bot");
    progress.done();
    expect(stopped).toBe(true);
    expect(frames).toHaveLength(4);
    const narrow: string[] = [];
    checkProgress({ write: (text) => narrow.push(text), columns: 12 }, ["claude"], () => () => {});
    expect(plain(narrow[0])).toBe(`${SPINNER[0]} claude: c…\n`);
  });
});
