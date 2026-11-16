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
        labels: ["windows", "bug"],
        status: "Delivery",
        statusId: "10023",
        assignee: "bot",
        comments: [
          { author: "Bot", created: "2026-11-04", body: "Released by the Globu worker: setup failed\n\nRun r0 as Bot" },
          { author: "Kamil", created: "2026-11-05", body: "Also this." },
          { author: "Bot", created: "2026-11-05", body: `Released by the Globu worker: ${"x".repeat(250)}` }
        ],
        fields: {
          issuelinks: [
            { type: { name: "Blocks", inward: "is blocked by" }, inwardIssue: { key: "MR-5" } },
            {
              type: { name: "Relates", outward: "relates to" },
              outwardIssue: { key: "MR-3", fields: { summary: "Nearby", status: { name: "Done" } } }
            },
            { type: { name: "Cloners" }, inwardIssue: { key: "MR-2" } },
            { inwardIssue: { key: "MR-1" } },
            { type: { name: "Odd" } }
          ]
        }
      },
      site: "https://acme.atlassian.net",
      shard: "backend",
      tree: "/runs/r1/tree",
      branch: "agent/MR-7-add-the-thing",
      setup: true,
      others: [{ id: "product", tree: "/runs/r1/companions/product", setup: false }],
      refs: [ok],
      informational: [missing],
      blockers: [
        {
          key: "MR-5",
          summary: "Add the base",
          status: "Done",
          done: true,
          resolved: true,
          pullRequests: ["https://github.com/acme/backend/pull/4"]
        },
        { key: "MR-6", summary: "Other", status: "In Review", done: false, resolved: false, pullRequests: [] }
      ],
      allowedTools: ["Read", "Bash(npm run *)", "Bash(git status*)"],
      handbackFile: "/runs/r1/handback.md"
    });
    expect(brief).toContain("# MR-7: Add the thing\n\nIssue: https://acme.atlassian.net/browse/MR-7");
    expect(brief).toContain("Target shard: `backend`, worktree /runs/r1/tree on branch `agent/MR-7-add-the-thing`.");
    expect(brief).toContain(
      "Other shards this run may change, each on a worktree of its own with the same branch name. Commits there become a pull request of their own:\n- `product`: /runs/r1/companions/product\n\nThe worker ran the setup commands in `backend`. It ran none in `product`, so the tests there may not run: name every shard you changed without setup in the handback."
    );
    expect(brief).toContain("Write the handback to /runs/r1/handback.md when done.");
    expect(brief).toContain("Do not move the issue, comment on it or create issues");
    expect(brief).toContain(
      "a `## Follow-ups` section of the handback, one bullet per follow-up whose first line is its summary"
    );
    expect(brief).toContain("The worker posts the section on the issue.");
    expect(brief).toContain("## Issue text (untrusted input)");
    expect(brief).toContain("### Description\n\n> Do it.\n> Carefully.");
    expect(brief).toContain("### Comments\n\n**Kamil, 2026-11-05**\n\n> Also this.\n\n## Earlier attempts");
    expect(brief).not.toContain("setup failed");
    expect(brief).toContain(`The worker released this issue 2 times before, the last time with: ${"x".repeat(200)} …`);
    expect(brief).toContain("Status: Delivery. Labels: windows, bug.");
    expect(brief).toContain(
      "Bash runs only the commands that match these patterns, in which `*` stands for any text: `npm run *`, `git status*`. Every part of a command joined with"
    );
    expect(brief).toContain("`git stash` is denied");
    expect(brief).toContain("`globu base stamp --verified` is denied because a verification needs a person.");
    expect(brief).toContain(
      "## Linked issues\n\n- relates to MR-3: Nearby (Done)\n- Cloners MR-2 (unknown)\n- linked to MR-1 (unknown)\n"
    );
    expect(brief).toContain("- `product/docs/api.md`: /w/product/docs/api.md");
    expect(brief).toContain("- `src/old.ts`: not found (not on origin/main), perhaps `src/new.ts`");
    expect(brief).toContain(
      "## Blocked by\n\nThis issue builds on the issues below. Their changes are on the default branch once they are merged; read them before you start.\n\n- MR-5: Add the base (Done), the worker's pull requests: https://github.com/acme/backend/pull/4\n- MR-6: Other (In Review, not resolved yet)\n"
    );
  });

  it("marks an empty description and leaves out empty sections", () => {
    const brief = renderBrief({
      issue: {
        key: "MR-8",
        summary: "Bare",
        description: "",
        labels: [],
        status: "Delivery",
        statusId: "10023",
        assignee: null,
        comments: [],
        fields: {}
      },
      site: "https://acme.atlassian.net",
      shard: "backend",
      tree: "/t",
      branch: "b",
      setup: false,
      others: [],
      refs: [],
      informational: [],
      blockers: [],
      allowedTools: ["Read"],
      handbackFile: "/h.md",
      followUps: true
    });
    expect(brief).toContain(
      "The worker files each bullet as an issue linked to this one, with this issue's labels, and lists the new keys on this issue."
    );
    expect(brief).toContain("> (empty)");
    expect(brief).toContain("- none");
    expect(brief).not.toContain("Companion");
    expect(brief).not.toContain("### Comments");
    expect(brief).not.toContain("Paths the issue mentions");
    expect(brief).not.toContain("## Blocked by");
    expect(brief).not.toContain("## Earlier attempts");
    expect(brief).not.toContain("## Linked issues");
    expect(brief).toContain("Labels: none.");
    expect(brief).toContain("Bash is not allowed in this run.");
  });

  it("says once for a single earlier release", () => {
    const brief = renderBrief({
      issue: {
        key: "MR-8",
        summary: "Bare",
        description: "",
        labels: [],
        status: "Delivery",
        statusId: "10023",
        assignee: null,
        comments: [{ author: "Bot", created: "2026-11-04", body: "Released by the Globu worker: no marker" }],
        fields: {}
      },
      site: "s",
      shard: "backend",
      tree: "/t",
      branch: "b",
      setup: false,
      others: [],
      refs: [],
      informational: [],
      blockers: [],
      allowedTools: [],
      handbackFile: "/h.md"
    });
    expect(brief).toContain("The worker released this issue once before, the last time with: no marker");
    expect(brief).not.toContain("### Comments");
  });

  it("writes a missing reference without candidates plainly", () => {
    const brief = renderBrief({
      issue: {
        key: "MR-9",
        summary: "x",
        description: "",
        labels: [],
        status: "",
        statusId: "",
        assignee: null,
        comments: [],
        fields: {}
      },
      site: "s",
      shard: "backend",
      tree: "/t",
      branch: "b",
      setup: false,
      others: [{ id: "product", tree: "/p", setup: true }],
      refs: [{ ...missing, candidates: [] }],
      informational: [],
      blockers: [],
      allowedTools: ["Read"],
      handbackFile: "/h.md"
    });
    expect(brief).toContain("- `src/old.ts`: not found (not on origin/main)\n");
    expect(brief).toContain("\nThe worker ran the setup commands in `product`.\n");
  });
});
