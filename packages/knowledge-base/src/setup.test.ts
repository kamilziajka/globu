import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseIndex, read, tempDir, write } from "../../testing/index.js";
import { VERSION } from "./constants.js";
import { parseFrontmatter } from "./frontmatter.js";
import { AUTHORING_GUIDE_START } from "./guide.js";
import { setupBase } from "./setup.js";

describe("setupBase", () => {
  it("creates a valid base and is idempotent", () => {
    const root = path.join(tempDir(), "demo");
    const first = setupBase(root, { description: "Demo knowledge" });
    const indexPath = path.join(root, "docs", "index.md");
    expect(first.created).toEqual([indexPath, path.join(root, "docs", "log.md")]);
    expect(first.validation.errors).toEqual([]);

    const index = read(indexPath);
    expect(parseFrontmatter(index).data).toEqual({
      okf_version: "0.2",
      name: "demo",
      description: "Demo knowledge",
      knowledge_base_version: VERSION
    });
    expect(index).toContain("# demo knowledge base");
    expect(index).toContain(AUTHORING_GUIDE_START);

    const second = setupBase(root);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toHaveLength(2);
    expect(read(indexPath)).toBe(index);
  });

  it("accepts a docs directory and an explicit name", () => {
    const docsDir = path.join(tempDir(), "docs");
    const summary = setupBase(docsDir, { name: "custom" });
    expect(summary.docsDir).toBe(docsDir);
    expect(parseFrontmatter(read(docsDir, "index.md")).data.name).toBe("custom");
  });

  it("creates the base under the directory name given", () => {
    const root = tempDir();
    expect(setupBase(root, { dir: "wiki" }).docsDir).toBe(path.join(root, "wiki"));
    expect(setupBase(path.join(root, "knowledge"), { dir: "knowledge" }).docsDir).toBe(path.join(root, "knowledge"));
    expect(setupBase(root, { dir: "knowledge" }).created).toEqual([]);
  });

  it("upgrades an existing base whatever its directory is called", () => {
    const root = tempDir();
    write(root, "wiki/index.md", baseIndex("kept"));
    expect(setupBase(root).docsDir).toBe(path.join(root, "wiki"));
    expect(setupBase(path.join(root, "wiki")).docsDir).toBe(path.join(root, "wiki"));
    expect(setupBase(root, { dir: "docs" }).docsDir).toBe(path.join(root, "docs"));
  });

  it("upgrades an existing index without touching its content", () => {
    const root = tempDir();
    write(root, "docs/index.md", "---\nname: kept\nowner: team\n---\n\n# Handwritten\n\n* [Thing](./thing.md)\n");
    write(root, "docs/thing.md", "no frontmatter\n");
    const summary = setupBase(root, { name: "ignored" });

    expect(summary.updated).toEqual([path.join(root, "docs", "index.md")]);
    expect(summary.created).toEqual([path.join(root, "docs", "log.md")]);
    expect(summary.validation.errors).toHaveLength(1);
    const index = read(root, "docs", "index.md");
    expect(parseFrontmatter(index).data).toEqual({
      name: "kept",
      owner: "team",
      okf_version: "0.2",
      knowledge_base_version: VERSION
    });
    expect(index).toContain("* [Thing](./thing.md)");
  });
});
