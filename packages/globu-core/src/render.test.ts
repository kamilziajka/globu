import path from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktree, initRepo, tempDir } from "../../testing/index.js";
import type { ResolvedShard } from "./registry.js";
import { renderIndex } from "./render.js";

const PRODUCT = path.resolve("/shards/product");
const HANDBOOK = path.resolve("/shards/handbook");

function shard(overrides: Partial<ResolvedShard>): ResolvedShard {
  return {
    id: "product",
    source: { type: "git", repo: null },
    format: "okf",
    roots: [{ path: "docs", name: "product", entry: "docs/index.md" }],
    description: "",
    useWhen: "",
    path: PRODUCT,
    owner: "user",
    mode: "write",
    present: true,
    ...overrides
  };
}

describe("renderIndex", () => {
  it("is empty when there are no shards", () => {
    expect(renderIndex([], null, "/")).toBe("");
  });

  it("lists routing text, entries and format conventions", () => {
    const repo = initRepo(path.join(tempDir(), "product"), { "docs/index.md": "# product\n" });
    const text = renderIndex(
      [
        shard({ path: repo, description: "Product decisions", useWhen: "Pricing questions" }),
        shard({ id: "handbook", format: "generic", mode: "read", path: HANDBOOK, roots: [{ path: "." }] })
      ],
      "work",
      path.join(repo, "docs")
    );
    expect(text).toContain("# Globu knowledge shards (project: work)");
    expect(text).toContain(`- **product** (okf, writable, you are working inside it)\n  - Location: ${repo}\n`);
    expect(text).toContain("  - What: Product decisions\n  - Use when: Pricing questions");
    expect(text).toContain(`  - Entry: product: ${path.join(repo, "docs/index.md")}`);
    expect(text).toContain(`- **handbook** (generic, read-only)\n  - Location: ${HANDBOOK}\n  - Entry: ${HANDBOOK}`);
    expect(text).toContain("- **okf**: Each root is an OKF base.");
    expect(text).toContain("- **generic**: This shard has no declared knowledge format.");
    expect(text).not.toContain("Not available locally");
  });

  it("points at the worktree a session runs in", () => {
    const sandbox = tempDir();
    const repo = initRepo(path.join(sandbox, "product"), { "docs/index.md": "# product\n" });
    const worktree = addWorktree(repo, path.join(sandbox, "elsewhere"), "feature");
    const text = renderIndex([shard({ path: repo, mode: "read" })], null, worktree);
    expect(text).toContain("- **product** (okf, read-only, you are working inside it)");
    expect(text).toContain(
      `  - Location: ${worktree} (this session's worktree. Read and edit it here, not in the main checkout at ${repo})`
    );
    expect(text).toContain(`  - Entry: product: ${path.join(worktree, "docs/index.md")}`);
  });

  it("marks ask shards as writable only from inside", () => {
    const repo = initRepo(path.join(tempDir(), "product"));
    const shards = [shard({ path: repo, mode: "ask" })];

    const outside = renderIndex(shards, null, "/elsewhere");
    expect(outside).toContain("- **product** (okf, ask first)");
    expect(outside).toContain("Only edit shards marked writable. The exception is a shard marked ask first:");

    const inside = renderIndex(shards, null, repo);
    expect(inside).toContain("- **product** (okf, writable, you are working inside it)");
    expect(inside).toContain("Only edit shards marked writable. Never copy knowledge");
  });

  it("truncates long root lists and skips unknown formats", () => {
    const roots = Array.from({ length: 8 }, (_, index) => ({
      path: `pkg${index}/docs`,
      entry: `pkg${index}/docs/index.md`
    }));
    const text = renderIndex([shard({ format: "mystery", roots })], null, "/elsewhere");
    expect(text).toContain("# Globu knowledge shards\n");
    expect(text).toContain(`  - Entries:\n    - ${path.join(PRODUCT, "pkg0/docs/index.md")}`);
    expect(text).toContain("    - 2 more, run `globu show product` to list them");
    expect(text).not.toContain("pkg6");
    expect(text).not.toContain("## Formats");

    const short = renderIndex([shard({ roots: roots.slice(0, 2) })], null, "/elsewhere");
    expect(short).not.toContain("more, run");
  });

  it("counts stale and deprecated docs per shard without listing them", () => {
    const repo = initRepo(path.join(tempDir(), "product"), {
      "docs/index.md": "# product\n",
      "docs/old.md": '---\ntype: "Note"\nstale_after: 2020-01-01T00:00:00Z\n---\n',
      "docs/gone.md": '---\ntype: "Note"\nstatus: deprecated\n---\n',
      "notes/old.md": '---\ntype: "Note"\nstatus: deprecated\n---\n'
    });
    const text = renderIndex(
      [shard({ path: repo }), shard({ id: "notes", format: "generic", path: repo, roots: [{ path: "notes" }] })],
      null,
      "/elsewhere"
    );
    expect(text).toContain(
      `  - Entry: product: ${path.join(repo, "docs/index.md")}\n  - Stale: 2 docs are past stale_after or deprecated, read them with caution. \`globu base stale ${repo}\` lists them\n`
    );
    expect(text.match(/- Stale:/g)).toHaveLength(1);
    expect(text).not.toContain("old.md");
  });

  it("names shards that are not on this machine", () => {
    const text = renderIndex(
      [shard({ id: "a", present: false }), shard({ id: "b", path: null, present: false })],
      null,
      "/"
    );
    expect(text).toContain("Not available locally (run `globu sync`): a, b");
    expect(text).not.toContain("## Formats");
  });
});
