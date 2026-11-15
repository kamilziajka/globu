import { beforeEach, describe, expect, it } from "vitest";
import { baseIndex, captureIo, native, tempDir, write } from "../../testing/index.js";
import { globuMain } from "./globu.js";

let root: string;

const pkg = native("pkg/docs");

function file(name: string): string {
  return native(`pkg/docs/${name}`);
}

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
  write(
    root,
    "pkg/docs/index.md",
    `${baseIndex("pkg")}\n* [A](./a.md) - heating zones\n* [Pipes](./a|b.md) - pipes\n* [B](./b.md) - Links on.\n* [Old](./old.md) - The old way.\n`
  );
  write(root, "pkg/docs/a.md", concept("The release workflow.", "[gone](./gone.md)\n"));
  write(root, "pkg/docs/b.md", concept("Links on.", "[old](./old.md)\n"));
  write(
    root,
    "pkg/docs/old.md",
    '---\ntype: "Note"\ndescription: "The old way."\nstatus: deprecated\nstale_after: 2020-01-01T00:00:00Z\n---\n'
  );
  write(root, "pkg/docs/lonely.md", concept("Alone."));
});

describe("globu base lint", () => {
  it("prints warnings per base and exits 0", () => {
    expect(run(["base", "lint"])).toEqual({
      code: 0,
      out: [
        "OK    docs",
        `WARN  ${pkg}`,
        `      ${file("a.md")}:6: broken link: ./gone.md does not resolve`,
        `      ${file("b.md")}:6: deprecated link: ./old.md is deprecated`,
        `      ${file("index.md")}:8: index drift: entry for ./a.md does not match its description: ` +
          '"heating zones" against "The release workflow."',
        `      ${file("index.md")}:9: broken link: ./a|b.md does not resolve`,
        `      ${file("lonely.md")}: orphan: no other doc or index links here`,
        `      ${file("old.md")}: stale: past stale_after 2020-01-01T00:00:00Z`,
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
        "6 warnings in 2 bases. Warnings never fail the job.",
        "",
        "| Base | Broken links | Orphans | Index drift | Stale | Deprecated links |",
        "| --- | --: | --: | --: | --: | --: |",
        "| `docs` | 0 | 0 | 0 | 0 | 0 |",
        `| \`${pkg}\` | 2 | 1 | 1 | 1 | 1 |`,
        "",
        `### \`${pkg}\``,
        "",
        "| Where | Check | Finding |",
        "| --- | --- | --- |",
        `| \`${file("a.md")}:6\` | broken link | ./gone.md does not resolve |`,
        `| \`${file("b.md")}:6\` | deprecated link | ./old.md is deprecated |`,
        `| \`${file("index.md")}:8\` | index drift | entry for ./a.md does not match its description: "heating zones" against "The release workflow." |`,
        `| \`${file("index.md")}:9\` | broken link | ./a\\|b.md does not resolve |`,
        `| \`${file("lonely.md")}\` | orphan | no other doc or index links here |`,
        `| \`${file("old.md")}\` | stale | past stale_after 2020-01-01T00:00:00Z |`,
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
      "deprecated-link",
      "index-drift",
      "broken-link",
      "orphan",
      "stale"
    ]);
    expect(report.warnings[1]).toMatchObject({ line: 6, target: "./old.md", message: "./old.md is deprecated" });
    expect(report.warnings[5]).toMatchObject({ line: null, target: null });
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
