import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { baseIndex, captureIo, read, tempDir, write } from "../../testing/index.js";
import { globuMain } from "./globu.js";

let root: string;

function run(argv: string[], input: unknown = "", cwd = root) {
  const io = captureIo(cwd, input);
  return { code: globuMain(argv, io), out: io.stdout, err: io.stderr };
}

beforeEach(() => {
  root = tempDir();
});

describe("globu base help", () => {
  it("describes the commands", () => {
    const help = run(["help", "base"]);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(
      /^Usage: globu base \[options\] \[command\]\n\nOKF knowledge bases inside the current repo/
    );
    expect(help.out).toContain("log [options] <docsDir> <date> <entries...>");
    expect(run(["base"])).toMatchObject({ code: 1, err: expect.stringMatching(/^Usage: globu base /) });
  });
});

describe("globu base setup", () => {
  it("creates a base in the current directory", () => {
    const result = run(["base", "setup", "--name", "demo", "--description", "Demo"]);
    expect(result).toEqual({
      code: 0,
      out: "base: docs\n  created   docs/index.md\n  created   docs/log.md\n",
      err: ""
    });
    expect(run(["base", "setup"]).out).toBe("base: docs\n  unchanged docs/index.md\n  unchanged docs/log.md\n");
  });

  it("creates the base in the directory named by --dir", () => {
    expect(run(["base", "setup", "--dir", "wiki", "--name", "demo"]).out).toBe(
      "base: wiki\n  created   wiki/index.md\n  created   wiki/log.md\n"
    );
    expect(run(["base", "setup"]).out).toBe("base: wiki\n  unchanged wiki/index.md\n  unchanged wiki/log.md\n");
  });

  it("reports validation errors and exits 1", () => {
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/docs/bad.md", "bare\n");
    const result = run(["base", "setup", "pkg"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("  updated   pkg/docs/index.md\n");
    expect(result.out).toContain("  invalid   pkg/docs/bad.md: missing YAML frontmatter block\n");
    expect(JSON.parse(run(["base", "setup", "pkg", "--json"]).out).validation.errors).toHaveLength(1);
  });
});

describe("globu base validate", () => {
  it("prints one line per base", () => {
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    expect(run(["base", "validate"])).toEqual({ code: 0, out: "OK    docs\nOK    pkg/docs\n", err: "" });

    write(root, "pkg/docs/bad.md", "bare\n");
    const failed = run(["base", "validate", "."]);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("OK    docs\nFAIL  pkg/docs\n      pkg/docs/bad.md: missing YAML frontmatter block\n");
    expect(JSON.parse(run(["base", "validate", "--json"]).out).errors).toHaveLength(1);
  });

  it("fails when there is nothing to validate", () => {
    expect(run(["base", "validate"])).toEqual({ code: 1, out: ".: no OKF bases found\n", err: "" });
  });
});

describe("globu base list and owner", () => {
  it("lists bases and resolves ownership", () => {
    expect(run(["base", "list"]).out).toBe("no OKF bases found\n");
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/src/a.ts", "");

    expect(run(["base", "list"]).out).toBe("root\tdocs\npkg\tpkg/docs\n");
    expect(JSON.parse(run(["base", "list", "pkg", "--json"]).out)).toHaveLength(1);
    expect(run(["base", "owner", "pkg/src/a.ts"])).toEqual({ code: 0, out: "pkg/docs\n", err: "" });
    expect(JSON.parse(run(["base", "owner", "pkg/src/a.ts", "--json"]).out).docsDir).toBe(path.join(root, "pkg/docs"));
  });

  it("exits 1 when no base owns the file", () => {
    expect(run(["base", "owner", "a.ts"])).toEqual({ code: 1, out: "no owning base\n", err: "" });
    expect(run(["base", "owner"])).toEqual({ code: 1, out: "", err: "error: missing required argument 'file'\n" });
  });
});

describe("globu base log", () => {
  it("appends entries", () => {
    run(["base", "setup"]);
    expect(run(["base", "log", "docs", "2026-01-01", "one", "two"]).out).toBe("updated docs/log.md\n");
    expect(read(root, "docs/log.md")).toContain("## 2026-01-01\n* one\n* two\n");
    expect(JSON.parse(run(["base", "log", "docs", "2026-01-02", "three", "--json"]).out).logPath).toBe(
      path.join(root, "docs/log.md")
    );
  });

  it("opens a titled section with --title and joins it on the next call", () => {
    run(["base", "setup"]);
    expect(run(["base", "log", "docs", "2026-10-26", "one", "--title", "what changed"]).out).toBe(
      "updated docs/log.md\n"
    );
    expect(run(["base", "log", "docs", "2026-10-26", "two", "--title", "ignored"]).out).toBe("updated docs/log.md\n");
    expect(read(root, "docs/log.md")).toBe(
      "# Knowledge base update log\n\n## 2026-10-26 (what changed)\n* two\n* one\n"
    );
  });

  it("rejects incomplete arguments and unknown flags", () => {
    expect(run(["base", "log", "docs"]).err).toBe("error: missing required argument 'date'\n");
    expect(run(["base", "log", "docs", "2026-01-01"]).err).toBe("error: missing required argument 'entries'\n");
    expect(run(["base", "log", "docs", "yesterday", "one"]).err).toBe(
      'globu: date must be YYYY-MM-DD, got "yesterday"\n'
    );
    expect(run(["base", "log", "--nope"]).code).toBe(1);
  });
});

describe("globu hook validate-edit", () => {
  function edit(filePath: string) {
    return run(["hook", "validate-edit"], { tool_input: { file_path: filePath } });
  }

  it("fails with exit code 2 when the edited base is invalid", () => {
    run(["base", "setup"]);
    const bad = write(root, "docs/bad.md", "bare\n");
    const result = edit(bad);
    expect(result.code).toBe(2);
    expect(result.err).toBe(
      `globu: ${path.join(root, "docs")} failed validation after this edit:\n  ${bad}: missing YAML frontmatter block\n`
    );
  });

  it("stays quiet for valid bases and for files outside a base", () => {
    run(["base", "setup"]);
    write(root, "docs/good.md", '---\ntype: "Note"\n---\n');
    expect(edit("docs/good.md").code).toBe(0);
    expect(edit(write(root, "README.md", "bare\n")).code).toBe(0);
    expect(edit(path.join(tempDir(), "notes.md")).code).toBe(0);
    expect(edit(write(root, "docs/data.json", "{}")).code).toBe(0);
    expect(run(["hook", "validate-edit"], "").code).toBe(0);
  });
});
