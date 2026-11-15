import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseIndex, tempDir, write } from "../../testing/index.js";
import { staleDocs, staleRepo } from "./stale.js";

const NOW = Date.UTC(2026, 10, 15);

function doc(fields: string): string {
  return `---\ntype: "Note"\n${fields}---\n\nBody.\n`;
}

describe("staleDocs", () => {
  it("lists docs past stale_after and deprecated docs, nothing else", () => {
    const root = tempDir();
    write(root, "docs/index.md", baseIndex("demo"));
    write(root, "docs/log.md", "# log\n");
    write(root, "docs/a-stale.md", doc("stale_after: 2026-11-01T00:00:00Z\n"));
    write(root, "docs/b-deprecated.md", doc("status: deprecated\n"));
    write(root, "docs/c-both.md", doc("status: deprecated\nstale_after: 2026-01-01T00:00:00+01:00\n"));
    write(root, "docs/d-fresh.md", doc("stale_after: 2999-01-01T00:00:00Z\n"));
    write(root, "docs/e-plain.md", doc(""));
    write(root, "docs/f-broken.md", "---\nkey: [unclosed\n---\n");
    write(root, "docs/g-bare-date.md", doc("stale_after: 2020-01-01\n"));
    const docsDir = path.join(root, "docs");
    expect(staleDocs(docsDir, NOW)).toEqual([
      { file: path.join(docsDir, "a-stale.md"), reasons: ["stale"], staleAfter: "2026-11-01T00:00:00Z" },
      { file: path.join(docsDir, "b-deprecated.md"), reasons: ["deprecated"], staleAfter: null },
      {
        file: path.join(docsDir, "c-both.md"),
        reasons: ["stale", "deprecated"],
        staleAfter: "2026-01-01T00:00:00+01:00"
      }
    ]);
    expect(staleDocs(docsDir)).toHaveLength(3);
  });

  it("finds nothing in a directory that does not exist", () => {
    expect(staleDocs(path.join(tempDir(), "docs"), NOW)).toEqual([]);
  });
});

describe("staleRepo", () => {
  it("reports every base under a directory", () => {
    const root = tempDir();
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/wiki/index.md", baseIndex("pkg"));
    write(root, "pkg/wiki/old.md", doc("status: deprecated\n"));
    const report = staleRepo(root, NOW);
    expect(report.errors).toEqual([]);
    expect(report.results.map((result) => [result.docsDir, result.docs.length])).toEqual([
      [path.join(root, "docs"), 0],
      [path.join(root, "pkg/wiki"), 1]
    ]);
    expect(staleRepo(root).results).toHaveLength(2);
  });

  it("fails when there is no base", () => {
    const root = tempDir();
    expect(staleRepo(root, NOW)).toEqual({ results: [], errors: [{ file: root, message: "no OKF bases found" }] });
  });
});
