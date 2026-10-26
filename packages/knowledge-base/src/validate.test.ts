import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseIndex, tempDir, write } from "../../testing/index.js";
import { validateBase, validateRepo } from "./validate.js";

function basenames(errors: { file: string; message: string }[]): string[] {
  return errors.map((err) => `${path.basename(err.file)}: ${err.message}`);
}

describe("validateBase", () => {
  it("passes a base whose concept docs all have a type", () => {
    const root = tempDir();
    write(root, "docs/index.md", baseIndex("demo"));
    write(root, "docs/log.md", "# log\n");
    write(root, "docs/topics/good.md", '---\ntype: "Note"\n---\n\nFine.\n');
    write(root, "docs/diagram.png", "not markdown");
    expect(validateBase(path.join(root, "docs")).errors).toEqual([]);
  });

  it("reports every structural problem", () => {
    const root = tempDir();
    write(root, "docs/index.md", "# no frontmatter\n");
    write(root, "docs/a-bare.md", "No frontmatter here.\n");
    write(root, "docs/b-empty-type.md", '---\ntype: " "\n---\n');
    write(root, "docs/c-no-type.md", "---\ntitle: x\n---\n");
    write(root, "docs/d-broken.md", "---\nkey: [unclosed\n---\n");
    const errors = basenames(validateBase(path.join(root, "docs")).errors);
    expect(errors[0]).toBe("index.md: index.md is missing `okf_version`");
    expect(errors[1]).toBe("a-bare.md: missing YAML frontmatter block");
    expect(errors[2]).toBe("b-empty-type.md: missing or empty required `type` field");
    expect(errors[3]).toBe("c-no-type.md: missing or empty required `type` field");
    expect(errors[4]).toMatch(/^d-broken.md: unparseable YAML frontmatter: /);
    expect(errors).toHaveLength(5);
  });

  it("reports a missing index", () => {
    const docsDir = path.join(tempDir(), "docs");
    expect(basenames(validateBase(docsDir).errors)).toEqual(["index.md: missing required index.md"]);
  });
});

describe("validateRepo", () => {
  it("validates every base under a directory", () => {
    const root = tempDir();
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/docs/bad.md", "bare\n");
    const { results, errors } = validateRepo(root);
    expect(results.map((result) => result.errors.length)).toEqual([0, 1]);
    expect(errors).toHaveLength(1);
  });

  it("validates a base directory passed directly", () => {
    const root = tempDir();
    write(root, "wiki/index.md", baseIndex("root"));
    expect(validateRepo(path.join(root, "wiki")).errors).toEqual([]);
  });

  it("fails when there is no base", () => {
    const root = tempDir();
    expect(validateRepo(root)).toEqual({ results: [], errors: [{ file: root, message: "no OKF bases found" }] });
  });
});
