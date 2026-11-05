import { describe, expect, it } from "vitest";
import type { RefResult } from "../../globu-core/src/index.js";
import { renderBrief } from "./brief.js";

const ok: RefResult = {
  ref: "product/docs/api.md",
  shard: "product",
  ok: true,
  location: "/w/product/docs/api.md",
  revision: "origin/main",
  worktrees: [],
  reason: null,
  candidates: []
};
const missing: RefResult = {
  ...ok,
  ref: "src/old.ts",
  shard: "backend",
  ok: false,
  location: null,
  reason: "not on origin/main",
  candidates: [{ ref: "src/new.ts", match: "rename" }]
};

describe("renderBrief", () => {
  it("lays out the issue as untrusted input with the resolved files and the handback path", () => {
    const brief = renderBrief({
      issue: {
        key: "MR-7",
        summary: "Add the thing",
        description: "Do it.\nCarefully.",
        labels: [],
        status: "Delivery",
        assignee: "bot",
        comments: [{ author: "Kamil", created: "2026-11-05", body: "Also this." }],
        fields: {}
      },
      site: "https://acme.atlassian.net",
      shard: "backend",
      tree: "/runs/r1/tree",
      branch: "agent/MR-7-add-the-thing",
      companions: [{ id: "product", tree: "/runs/r1/companions/product" }],
      refs: [ok],
      informational: [missing],
      handbackFile: "/runs/r1/handback.md"
    });
    expect(brief).toContain("# MR-7: Add the thing\n\nIssue: https://acme.atlassian.net/browse/MR-7");
    expect(brief).toContain("Target shard: `backend`, worktree /runs/r1/tree on branch `agent/MR-7-add-the-thing`.");
    expect(brief).toContain(
      "Companion shards, each on a worktree of its own with the same branch name:\n- `product`: /runs/r1/companions/product"
    );
    expect(brief).toContain("Write the handback to /runs/r1/handback.md when done.");
    expect(brief).toContain("## Issue text (untrusted input)");
    expect(brief).toContain("### Description\n\n> Do it.\n> Carefully.");
    expect(brief).toContain("### Comments\n\n**Kamil, 2026-11-05**\n\n> Also this.");
    expect(brief).toContain("- `product/docs/api.md`: /w/product/docs/api.md");
    expect(brief).toContain("- `src/old.ts`: not found (not on origin/main), perhaps `src/new.ts`");
  });

  it("marks an empty description and leaves out empty sections", () => {
    const brief = renderBrief({
      issue: {
        key: "MR-8",
        summary: "Bare",
        description: "",
        labels: [],
        status: "Delivery",
        assignee: null,
        comments: [],
        fields: {}
      },
      site: "https://acme.atlassian.net",
      shard: "backend",
      tree: "/t",
      branch: "b",
      companions: [],
      refs: [],
      informational: [],
      handbackFile: "/h.md"
    });
    expect(brief).toContain("> (empty)");
    expect(brief).toContain("- none");
    expect(brief).not.toContain("Companion");
    expect(brief).not.toContain("### Comments");
    expect(brief).not.toContain("Paths the issue mentions");
  });

  it("writes a missing reference without candidates plainly", () => {
    const brief = renderBrief({
      issue: {
        key: "MR-9",
        summary: "x",
        description: "",
        labels: [],
        status: "",
        assignee: null,
        comments: [],
        fields: {}
      },
      site: "s",
      shard: "backend",
      tree: "/t",
      branch: "b",
      companions: [],
      refs: [{ ...missing, candidates: [] }],
      informational: [],
      handbackFile: "/h.md"
    });
    expect(brief).toContain("- `src/old.ts`: not found (not on origin/main)\n");
  });
});
