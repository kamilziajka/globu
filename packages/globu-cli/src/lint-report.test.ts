import { beforeEach, describe, expect, it } from "vitest";
import { baseIndex, captureIo, tempDir, write } from "../../testing/index.js";
import { globuMain } from "./globu.js";

let root: string;

function run(argv: string[]) {
  const io = captureIo(root);
  return { code: globuMain(argv, io), out: io.stdout, err: io.stderr };
}

function concept(description: string, body = ""): string {
  return `---\ntype: "Note"\ndescription: "${description}"\n---\n\n${body}`;
}

beforeEach(() => {
  root = tempDir();
  write(root, "docs/index.md", baseIndex("root"));
  write(root, "pkg/docs/index.md", `${baseIndex("pkg")}\n* [A](./a.md) - heating zones\n* [Pipes](./a|b.md) - pipes\n`);
  write(root, "pkg/docs/a.md", concept("The release workflow.", "[gone](./gone.md)\n"));
  write(root, "pkg/docs/lonely.md", concept("Alone."));
});

describe("globu base lint", () => {
  it("prints warnings per base and exits 0", () => {
    expect(run(["base", "lint"])).toEqual({
      code: 0,
      out: [
        "OK    docs",
        "WARN  pkg/docs",
        "      pkg/docs/a.md:6: broken link: ./gone.md does not resolve",
        "      pkg/docs/index.md:8: index drift: entry for ./a.md does not match its description: " +
          '"heating zones" against "The release workflow."',
        "      pkg/docs/index.md:9: broken link: ./a|b.md does not resolve",
        "      pkg/docs/lonely.md: orphan: no other doc or index links here",
        ""
      ].join("\n"),
      err: ""
    });
  });

  it("prints a Markdown job summary with --format markdown", () => {
    const { code, out } = run(["base", "lint", "--format", "markdown"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "## Knowledge lint",
        "",
        "4 warnings in 2 bases. Warnings never fail the job.",
        "",
        "| Base | Broken links | Orphans | Index drift |",
        "| --- | --: | --: | --: |",
        "| `docs` | 0 | 0 | 0 |",
        "| `pkg/docs` | 2 | 1 | 1 |",
        "",
        "### `pkg/docs`",
        "",
        "| Where | Check | Finding |",
        "| --- | --- | --- |",
        "| `pkg/docs/a.md:6` | broken link | ./gone.md does not resolve |",
        '| `pkg/docs/index.md:8` | index drift | entry for ./a.md does not match its description: "heating zones" against "The release workflow." |',
        "| `pkg/docs/index.md:9` | broken link | ./a\\|b.md does not resolve |",
        "| `pkg/docs/lonely.md` | orphan | no other doc or index links here |",
        ""
      ].join("\n")
    );
    expect(run(["base", "lint", "docs", "--format", "markdown"]).out).toContain(
      "0 warnings in 1 base. Warnings never fail the job."
    );
  });

  it("prints JSON with --json", () => {
    const report = JSON.parse(run(["base", "lint", "pkg", "--json"]).out);
    expect(report.warnings.map((warning: { kind: string }) => warning.kind)).toEqual([
      "broken-link",
      "index-drift",
      "broken-link",
      "orphan"
    ]);
    expect(report.errors).toEqual([]);
  });

  it("exits 1 when there is no base and rejects an unknown format", () => {
    root = tempDir();
    expect(run(["base", "lint"])).toEqual({ code: 1, out: ".: no OKF bases found\n", err: "" });
    expect(run(["base", "lint", "--format", "markdown"])).toEqual({
      code: 1,
      out: "## Knowledge lint\n\n`.`: no OKF bases found\n",
      err: ""
    });
    expect(run(["base", "lint", "--format", "html"]).err).toMatch(/^error: option '--format <format>' argument 'html'/);
  });
});
