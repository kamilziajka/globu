import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../../knowledge-base/src/index.js";
import { baseIndex, captureIo, git, initRepo, native, read, tempDir, write } from "../../testing/index.js";
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
      out: native("base: wiki\n  created   wiki/index.md\n  created   wiki/log.md\n"),
      err: ""
    });
    expect(run(["base", "setup"]).out).toBe(native("base: wiki\n  unchanged wiki/index.md\n  unchanged wiki/log.md\n"));
  });

  it("creates the base in the directory named by --dir", () => {
    expect(run(["base", "setup", "--dir", "docs", "--name", "demo"]).out).toBe(
      native("base: docs\n  created   docs/index.md\n  created   docs/log.md\n")
    );
    expect(run(["base", "setup"]).out).toBe(native("base: docs\n  unchanged docs/index.md\n  unchanged docs/log.md\n"));
  });

  it("reports validation errors and exits 1", () => {
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/docs/bad.md", "bare\n");
    const result = run(["base", "setup", "pkg"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(native("  updated   pkg/docs/index.md\n"));
    expect(result.out).toContain(native("  invalid   pkg/docs/bad.md: missing YAML frontmatter block\n"));
    expect(JSON.parse(run(["base", "setup", "pkg", "--json"]).out).validation.errors).toHaveLength(1);
  });

  it("reports warnings and exits 0", () => {
    write(root, "wiki/index.md", baseIndex("demo"));
    write(root, "wiki/old.md", '---\ntype: "Note"\nstatus: final\n---\n');
    expect(run(["base", "setup"])).toMatchObject({
      code: 0,
      out: expect.stringContaining(
        native('  warning   wiki/old.md: `status` should be draft, stable or deprecated, got "final"\n')
      )
    });
  });
});

describe("globu base validate", () => {
  it("prints one line per base", () => {
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    expect(run(["base", "validate"])).toEqual({ code: 0, out: native("OK    docs\nOK    pkg/docs\n"), err: "" });

    write(root, "pkg/docs/bad.md", "bare\n");
    const failed = run(["base", "validate", "."]);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe(
      native("OK    docs\nFAIL  pkg/docs\n      pkg/docs/bad.md: missing YAML frontmatter block\n")
    );
    expect(JSON.parse(run(["base", "validate", "--json"]).out).errors).toHaveLength(1);
  });

  it("fails when there is nothing to validate", () => {
    expect(run(["base", "validate"])).toEqual({ code: 1, out: ".: no OKF bases found\n", err: "" });
  });

  it("prints warnings under the base and still exits 0", () => {
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "docs/plain.md", '---\ntype: "Note"\n---\n');
    write(root, "docs/old.md", '---\ntype: "Note"\nstale_after: "2027-04-01"\n---\n');
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/docs/bad.md", '---\ngenerated: { by: "globu/1.2.0" }\nstatus: open\n---\n');
    expect(run(["base", "validate", "docs"])).toEqual({
      code: 0,
      out: native(
        'WARN  docs\n      docs/old.md: warning: `stale_after` should be an ISO 8601 datetime with an offset, such as 2026-11-05T08:00:00Z, got "2027-04-01"\n'
      ),
      err: ""
    });
    const both = run(["base", "validate"]);
    expect(both.code).toBe(1);
    expect(both.out).toContain(
      native(
        "FAIL  pkg/docs\n      pkg/docs/bad.md: missing or empty required `type` field\n      pkg/docs/bad.md: warning: `status` should be"
      )
    );
    expect(JSON.parse(run(["base", "validate", "--json"]).out).warnings).toHaveLength(2);
  });
});

describe("globu base stale", () => {
  it("lists stale and deprecated docs in every base", () => {
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "docs/fresh.md", '---\ntype: "Note"\nstale_after: 2999-01-01T00:00:00Z\n---\n');
    expect(run(["base", "stale"])).toEqual({ code: 0, out: "no stale or deprecated docs\n", err: "" });

    write(root, "docs/old.md", '---\ntype: "Note"\nstale_after: 2020-01-01T00:00:00Z\n---\n');
    write(root, "pkg/wiki/index.md", baseIndex("pkg"));
    write(root, "pkg/wiki/gone.md", '---\ntype: "Note"\nstatus: deprecated\nstale_after: 2021-01-01T00:00:00Z\n---\n');
    expect(run(["base", "stale"])).toEqual({
      code: 0,
      out: native(
        "docs/old.md\tstale since 2020-01-01T00:00:00Z\npkg/wiki/gone.md\tstale since 2021-01-01T00:00:00Z, deprecated\n"
      ),
      err: ""
    });
    expect(JSON.parse(run(["base", "stale", "pkg", "--json"]).out).results[0].docs).toEqual([
      {
        file: path.join(root, "pkg/wiki/gone.md"),
        reasons: ["stale", "deprecated"],
        staleAfter: "2021-01-01T00:00:00Z"
      }
    ]);
  });

  it("fails when there is no base", () => {
    expect(run(["base", "stale"])).toEqual({ code: 1, out: ".: no OKF bases found\n", err: "" });
  });
});

describe("globu base stamp", () => {
  it("stamps generated with this version and the current time", () => {
    write(root, "wiki/index.md", baseIndex("demo"));
    write(root, "wiki/a.md", '---\ntype: "Note"\n---\n\nBody.\n');
    const result = run(["base", "stamp", "wiki/a.md"]);
    expect(result.code).toBe(0);
    const [field, file, by, at] = result.out.trim().split("\t");
    expect([field, file, by]).toEqual(["generated", native("wiki/a.md"), `globu/${VERSION}`]);
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(read(root, "wiki/a.md")).toBe(
      `---\ntype: "Note"\ngenerated: { by: "globu/${VERSION}", at: ${at} }\n---\n\nBody.\n`
    );
    expect(run(["base", "validate"]).out).toBe("OK    wiki\n");
  });

  it("appends a verification by git user.name", () => {
    initRepo(root);
    git(root, "config", "user.name", "Ada Lovelace");
    write(root, "wiki/index.md", baseIndex("demo"));
    write(root, "wiki/a.md", '---\ntype: "Note"\n---\n');
    const [stamped] = JSON.parse(run(["base", "stamp", "--verified", "wiki/a.md", "--json"]).out);
    expect(stamped).toMatchObject({ file: path.join(root, "wiki/a.md"), field: "verified", by: "human:Ada Lovelace" });
    expect(read(root, "wiki/a.md")).toBe(
      `---\ntype: "Note"\nverified:\n  - { by: "human:Ada Lovelace", at: ${stamped.at} }\n---\n`
    );
  });

  it("refuses a file outside a base and writes nothing", () => {
    write(root, "wiki/index.md", baseIndex("demo"));
    write(root, "wiki/a.md", '---\ntype: "Note"\n---\n');
    write(root, "README.md", "# readme\n");
    expect(run(["base", "stamp", "wiki/a.md", "README.md"])).toEqual({
      code: 1,
      out: "",
      err: `globu: ${path.join(root, "README.md")} is not a concept doc of an OKF base\n`
    });
    expect(read(root, "wiki/a.md")).toBe('---\ntype: "Note"\n---\n');
  });
});

describe("globu base list and owner", () => {
  it("lists bases and resolves ownership", () => {
    expect(run(["base", "list"]).out).toBe("no OKF bases found\n");
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/src/a.ts", "");

    expect(run(["base", "list"]).out).toBe(native("root\tdocs\npkg\tpkg/docs\n"));
    expect(JSON.parse(run(["base", "list", "pkg", "--json"]).out)).toHaveLength(1);
    expect(run(["base", "owner", "pkg/src/a.ts"])).toEqual({ code: 0, out: native("pkg/docs\n"), err: "" });
    expect(JSON.parse(run(["base", "owner", "pkg/src/a.ts", "--json"]).out).docsDir).toBe(path.join(root, "pkg/docs"));
  });

  it("exits 1 when no base owns the file", () => {
    initRepo(root);
    expect(run(["base", "owner", "a.ts"])).toEqual({ code: 1, out: "no owning base\n", err: "" });
    expect(run(["base", "owner"])).toEqual({ code: 1, out: "", err: "error: missing required argument 'file'\n" });
  });
});

describe("globu base log", () => {
  it("appends entries", () => {
    run(["base", "setup"]);
    expect(run(["base", "log", "wiki", "2026-01-01", "one", "two"]).out).toBe(native("updated wiki/log.md\n"));
    expect(read(root, "wiki/log.md")).toContain("## 2026-01-01\n* one\n* two\n");
    expect(JSON.parse(run(["base", "log", "wiki", "2026-01-02", "three", "--json"]).out).logPath).toBe(
      path.join(root, "wiki/log.md")
    );
  });

  it("opens a titled section with --title and joins it on the next call", () => {
    run(["base", "setup"]);
    expect(run(["base", "log", "wiki", "2026-10-26", "one", "--title", "what changed"]).out).toBe(
      native("updated wiki/log.md\n")
    );
    expect(run(["base", "log", "wiki", "2026-10-26", "two", "--title", "ignored"]).out).toBe(
      native("updated wiki/log.md\n")
    );
    expect(read(root, "wiki/log.md")).toBe(
      "# Knowledge base update log\n\n## 2026-10-26 (what changed)\n* two\n* one\n"
    );
  });

  it("rejects incomplete arguments and unknown flags", () => {
    expect(run(["base", "log", "wiki"]).err).toBe("error: missing required argument 'date'\n");
    expect(run(["base", "log", "wiki", "2026-01-01"]).err).toBe("error: missing required argument 'entries'\n");
    expect(run(["base", "log", "wiki", "yesterday", "one"]).err).toBe(
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
    const bad = write(root, "wiki/bad.md", "bare\n");
    const result = edit(bad);
    expect(result.code).toBe(2);
    expect(result.err).toBe(
      `globu: ${path.join(root, "wiki")} failed validation after this edit:\n  ${bad}: missing YAML frontmatter block\n`
    );
  });

  it("passes warnings for the edited doc to Claude without blocking", () => {
    run(["base", "setup"]);
    write(root, "wiki/other.md", '---\ntype: "Note"\nstatus: open\n---\n');
    const doc = write(root, "wiki/doc.md", '---\ntype: "Note"\nverified: "2026-10-09"\nstatus: final\n---\n');
    const result = edit(doc);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `globu: the OKF fields of ${doc} have problems. They are warnings and do not block the edit:\n  \`verified\` should be a mapping or a list of \`{ by, at }\`, got "2026-10-09"\n  \`status\` should be draft, stable or deprecated, got "final"`
      }
    });
    expect(edit(write(root, "wiki/good.md", '---\ntype: "Note"\n---\n')).out).toBe("");
  });

  it("stays quiet for valid bases and for files outside a base", () => {
    run(["base", "setup"]);
    write(root, "wiki/good.md", '---\ntype: "Note"\n---\n');
    expect(edit("wiki/good.md").code).toBe(0);
    expect(edit(write(root, "README.md", "bare\n")).code).toBe(0);
    expect(edit(path.join(initRepo(tempDir()), "notes.md")).code).toBe(0);
    expect(edit(write(root, "wiki/data.json", "{}")).code).toBe(0);
    expect(run(["hook", "validate-edit"], "").code).toBe(0);
  });
});
