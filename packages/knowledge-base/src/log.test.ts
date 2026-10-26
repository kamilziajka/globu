import path from "node:path";
import { describe, expect, it } from "vitest";
import { read, tempDir, write } from "../../testing/index.js";
import { appendLog, appendLogEntry, DEFAULT_LOG_BODY } from "./log.js";

describe("appendLogEntry", () => {
  it("keeps sections newest first and groups entries by date", () => {
    let body = appendLogEntry(DEFAULT_LOG_BODY, "2026-01-01", ["first"]);
    expect(body).toBe("# Knowledge base update log\n\n## 2026-01-01\n* first\n");
    body = appendLogEntry(body, "2026-01-02", ["second", "third"]);
    body = appendLogEntry(body, "2026-01-02", ["fourth"]);
    expect(body).toBe(
      "# Knowledge base update log\n\n## 2026-01-02\n* fourth\n* second\n* third\n\n## 2026-01-01\n* first\n"
    );
  });

  it("joins a same-day section whose heading carries a title", () => {
    const body = "# Log\n\n## 2026-10-26 (articles published, deploy state)\n* old\n\n## 2026-10-25\n* older\n";
    expect(appendLogEntry(body, "2026-10-26", ["new"])).toBe(
      "# Log\n\n## 2026-10-26 (articles published, deploy state)\n* new\n* old\n\n## 2026-10-25\n* older\n"
    );
  });

  it("appends to the first of several same-day sections", () => {
    const body = "# Log\n\n## 2026-10-26 (morning)\n* a\n\n## 2026-10-26\n* b\n";
    expect(appendLogEntry(body, "2026-10-26", ["c"])).toBe(
      "# Log\n\n## 2026-10-26 (morning)\n* c\n* a\n\n## 2026-10-26\n* b\n"
    );
  });

  it("does not treat a heading that merely starts with the date as the same day", () => {
    const body = "# Log\n\n## 2026-10-26-notes\n* a\n\n## 2026-10-2\n* b\n\n## 2026-10-26 extra\n* c\n";
    expect(appendLogEntry(body, "2026-10-26", ["d"])).toBe(
      "# Log\n\n## 2026-10-26\n* d\n\n## 2026-10-26-notes\n* a\n\n## 2026-10-2\n* b\n\n## 2026-10-26 extra\n* c\n"
    );
  });

  it("opens a titled section with a title and ignores the title when the day exists", () => {
    let body = appendLogEntry(DEFAULT_LOG_BODY, "2026-10-26", ["a"], "what changed");
    expect(body).toBe("# Knowledge base update log\n\n## 2026-10-26 (what changed)\n* a\n");
    body = appendLogEntry(body, "2026-10-26", ["b"], "another title");
    expect(body).toBe("# Knowledge base update log\n\n## 2026-10-26 (what changed)\n* b\n* a\n");
  });
});

describe("appendLog", () => {
  it("creates the log when it is missing and appends when it exists", () => {
    const docsDir = tempDir();
    const logPath = appendLog(docsDir, "2026-01-01", ["one"]);
    expect(logPath).toBe(path.join(docsDir, "log.md"));
    appendLog(docsDir, "2026-01-01", ["two"]);
    expect(read(logPath)).toBe("# Knowledge base update log\n\n## 2026-01-01\n* two\n* one\n");
    appendLog(docsDir, "2026-01-02", ["three"], "titled");
    expect(read(logPath)).toContain("## 2026-01-02 (titled)\n* three\n\n## 2026-01-01\n");
  });

  it("rejects a malformed date and an empty entry list", () => {
    const docsDir = tempDir();
    write(docsDir, "log.md", DEFAULT_LOG_BODY);
    expect(() => appendLog(docsDir, "01-01-2026", ["x"])).toThrow(/YYYY-MM-DD/);
    expect(() => appendLog(docsDir, "2026-01-01", [])).toThrow(/at least one/);
  });
});
