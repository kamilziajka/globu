import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseIndex, initRepo, posix, tempDir, write } from "../../testing/index.js";
import { descriptionOverlap, type LintWarning, lintBase, lintRepo } from "./lint.js";

function doc(description: string, body = ""): string {
  const descriptionLine = description ? `description: "${description}"\n` : "";
  return `---\ntype: "Note"\n${descriptionLine}---\n\n# Doc\n${body}`;
}

const NOW = Date.UTC(2026, 10, 15);

function lifecycle(fields: string, body = ""): string {
  return `---\ntype: "Note"\n${fields}---\n\n${body}`;
}

function summary(docsDir: string, warnings: LintWarning[]): string[] {
  return warnings.map((warning) => {
    const where = warning.line === null ? "" : `:${warning.line}`;
    return `${warning.kind} ${posix(path.relative(docsDir, warning.file))}${where} ${warning.message}`;
  });
}

function lint(root: string, dir = "docs"): string[] {
  const docsDir = path.join(root, dir);
  return summary(docsDir, lintBase(docsDir, NOW).warnings);
}

describe("lintBase broken links", () => {
  it("reports relative and bundle-relative links that do not resolve", () => {
    const root = tempDir();
    write(
      root,
      "docs/index.md",
      `${baseIndex("demo")}\n* [A](./a.md)\n* [Topic](/topics/b.md)\n* [Gone](./gone.md)\n* [Gone too](/topics/gone.md)\n`
    );
    write(
      root,
      "docs/a.md",
      doc(
        "",
        [
          "[back](../docs/index.md) [sibling](topics/b.md#part) [query](./a.md?x=1) [self](#top)",
          "[web](https://example.com/x.md) [mail](mailto:a@b.c) [host](//example.com/y.md)",
          '[spaced](<./with space.md>) [titled](./a.md "Title") [encoded](./with%20space.md)',
          "[bad encoding](./%E0%A4%A.md) ![picture](./missing.png)",
          "`[code](./code.md)` and [real](./real.md)",
          "[ref]: ./ref.md",
          "[^note]: A footnote, not a link.",
          ""
        ].join("\n")
      )
    );
    write(root, "docs/with space.md", doc("", "[a](./a.md)\n"));
    write(root, "docs/topics/b.md", doc(""));
    write(root, "docs/notes.txt", "[not markdown](./nowhere.md)\n");
    expect(lint(root)).toEqual([
      "broken-link a.md:9 ./%E0%A4%A.md does not resolve",
      "broken-link a.md:9 ./missing.png does not resolve",
      "broken-link a.md:10 ./real.md does not resolve",
      "broken-link a.md:11 ./ref.md does not resolve",
      "broken-link index.md:10 ./gone.md does not resolve",
      "broken-link index.md:11 /topics/gone.md does not resolve"
    ]);
  });

  it("skips fenced code, frontmatter and the log", () => {
    const root = tempDir();
    write(root, "docs/index.md", `${baseIndex("demo")}\n* [A](./a.md)\n`);
    write(
      root,
      "docs/a.md",
      [
        "---",
        'type: "Note"',
        'note: "[x](./front.md)"',
        "---",
        "~~~",
        "```",
        "[in tilde](./tilde.md)",
        "~~~",
        "```js",
        "[in fence](./fence.md)",
        "```",
        "[after](./after.md)",
        ""
      ].join("\n")
    );
    write(root, "docs/log.md", "# Log\n\n* [removed](./removed.md)\n");
    expect(lint(root)).toEqual(["broken-link a.md:12 ./after.md does not resolve"]);
  });

  it("reads a file whose frontmatter never closes from the top", () => {
    const root = tempDir();
    write(root, "docs/index.md", `${baseIndex("demo")}\n* [A](./a.md)\n`);
    write(root, "docs/a.md", "---\n[open](./open.md)\n");
    expect(lint(root)).toEqual(["broken-link a.md:2 ./open.md does not resolve"]);
  });

  it("checks links that stay inside the repo and skips the ones that leave it", () => {
    const root = tempDir();
    const repo = initRepo(path.join(root, "repo"));
    write(repo, "docs/index.md", `${baseIndex("demo")}\n* [A](./a.md)\n`);
    write(repo, "docs/a.md", doc("", "[code](../src/x.ts) [other repo](../../other/docs/b.md) [here](../README.md)\n"));
    write(repo, "README.md", "# repo\n");
    expect(lint(repo)).toEqual(["broken-link a.md:6 ../src/x.ts does not resolve"]);
  });
});

describe("lintBase orphans", () => {
  it("reports concept docs nothing else links to", () => {
    const root = tempDir();
    write(
      root,
      "docs/index.md",
      `${baseIndex("demo")}\n* [A](./a.md)\n* [Listing](./listing/)\n* [Guides](./guides/)\n`
    );
    write(root, "docs/log.md", "# Log\n\n* [lonely](./lonely.md)\n");
    write(root, "docs/a.md", doc("", "[self](./a.md) [b](/b.md)\n"));
    write(root, "docs/b.md", doc(""));
    write(root, "docs/lonely.md", doc("", "[me](./lonely.md) [gone](./gone.md)\n"));
    write(root, "docs/listing/one.md", doc(""));
    write(root, "docs/guides/index.md", "# Guides\n\n* [Two](./two.md)\n");
    write(root, "docs/guides/two.md", doc(""));
    write(root, "docs/guides/three.md", doc(""));
    expect(lint(root)).toEqual([
      "orphan guides/three.md no other doc or index links here",
      "orphan lonely.md no other doc or index links here",
      "broken-link lonely.md:6 ./gone.md does not resolve"
    ]);
  });

  it("leaves out nested bases and nested repos", () => {
    const root = tempDir();
    write(root, "docs/index.md", baseIndex("demo"));
    write(root, "docs/inner/index.md", baseIndex("inner"));
    write(root, "docs/inner/x.md", doc("", "[gone](./gone.md)\n"));
    write(root, "docs/clone/.git/HEAD", "ref: refs/heads/main\n");
    write(root, "docs/clone/y.md", doc(""));
    expect(lint(root)).toEqual([]);
  });
});

describe("lintBase index drift", () => {
  it("reports entries whose text no longer matches the linked description", () => {
    const root = tempDir();
    write(
      root,
      "docs/index.md",
      `${baseIndex("demo")}\n${[
        "* [Same](./same.md) - How the release workflow publishes both packages",
        "* [Short](./short.md): the release workflow",
        "* [Drifted](./drifted.md) \u2013 heating zones and thermostats",
        "* [Bare](./bare.md)",
        "* [Undescribed](./undescribed.md) - anything at all",
        "* [Grouped](./grouped.md), [Same](./same.md) - several docs in one entry",
        "* [Prose](./prose.md) with words but no separator",
        "* [Folder](./folder/) - a directory",
        "* [Tiny](./tiny.md) - a b c",
        "* [Missing](./missing.md) - gone"
      ].join("\n")}\n`
    );
    write(root, "docs/same.md", doc("How the release workflow publishes both packages."));
    write(root, "docs/short.md", doc("The release workflow, step by step."));
    write(root, "docs/drifted.md", doc("The release workflow, step by step."));
    write(root, "docs/bare.md", doc("Something worth a description."));
    write(root, "docs/undescribed.md", doc(""));
    write(root, "docs/grouped.md", doc("Nothing like the text."));
    write(root, "docs/prose.md", doc("Nothing like the text."));
    write(root, "docs/folder/index.md", "# Folder\n");
    write(root, "docs/tiny.md", doc("Nothing like the text."));
    write(root, "docs/broken-yaml.md", "---\ndescription: [unclosed\n---\n[same](./same.md)\n");
    expect(lint(root)).toEqual([
      "orphan broken-yaml.md no other doc or index links here",
      'index-drift index.md:10 entry for ./drifted.md does not match its description: "heating zones and thermostats" against "The release workflow, step by step."',
      "index-drift index.md:11 entry for ./bare.md carries no description",
      "broken-link index.md:17 ./missing.md does not resolve"
    ]);
  });
});

describe("lintBase lifecycle", () => {
  it("reports stale docs and links from current docs to deprecated ones", () => {
    const root = tempDir();
    write(
      root,
      "docs/index.md",
      `${baseIndex("demo")}\n${[
        "* [A](./a.md)",
        "* [Old](./old.md)",
        "* [Aged](./aged.md)",
        "* [Both](./both.md)",
        "* [Fresh](./fresh.md)",
        "* [Retired](./retired.md)",
        "* [Sub](./sub/index.md)"
      ].join("\n")}\n`
    );
    write(root, "docs/log.md", "# Log\n\n* [old](./old.md)\n");
    write(
      root,
      "docs/a.md",
      lifecycle("status: stable\n", "[old](./old.md) [aged](./aged.md)\n[both](/both.md#part) [sub](./sub/index.md)\n")
    );
    write(root, "docs/old.md", lifecycle("status: deprecated\n", "[self](./old.md) [retired](./retired.md)\n"));
    write(root, "docs/aged.md", lifecycle("stale_after: 2026-11-01T00:00:00Z\n"));
    write(
      root,
      "docs/both.md",
      lifecycle("status: deprecated\nstale_after: 2026-01-01T00:00:00+01:00\n", "[old](./old.md)\n")
    );
    write(
      root,
      "docs/fresh.md",
      lifecycle("stale_after: 2999-01-01T00:00:00Z\n", "[not a date](./bare.md) [old](./old.md)\n")
    );
    write(root, "docs/bare.md", lifecycle("stale_after: 2020-01-01\n", "[fresh](./fresh.md)\n"));
    write(root, "docs/retired.md", lifecycle("status: deprecated\n"));
    write(
      root,
      "docs/sub/index.md",
      "---\nstatus: deprecated\nstale_after: 2020-01-01T00:00:00Z\n---\n# Sub\n\n* [Old](../old.md)\n"
    );
    expect(lint(root)).toEqual([
      "deprecated-link a.md:6 ./old.md is deprecated",
      "deprecated-link a.md:7 /both.md#part is deprecated",
      "stale aged.md past stale_after 2026-11-01T00:00:00Z",
      "stale both.md past stale_after 2026-01-01T00:00:00+01:00",
      "deprecated-link fresh.md:6 ./old.md is deprecated"
    ]);
    expect(lintBase(path.join(root, "docs")).warnings).toHaveLength(5);
  });
});

describe("descriptionOverlap", () => {
  it("measures the share of the entry's words found in the description", () => {
    expect(descriptionOverlap("Describing releases", "It describes a release")).toBe(1);
    expect(descriptionOverlap("release notes", "The release workflow")).toBe(0.5);
    expect(descriptionOverlap("a b", "anything")).toBe(1);
    expect(descriptionOverlap("...", "anything")).toBe(1);
  });
});

describe("lintRepo", () => {
  it("lints every base under a directory", () => {
    const root = tempDir();
    write(root, "docs/index.md", baseIndex("root"));
    write(root, "pkg/docs/index.md", baseIndex("pkg"));
    write(root, "pkg/docs/lonely.md", doc(""));
    write(root, "pkg/docs/old.md", lifecycle("stale_after: 2026-11-01T00:00:00Z\n", "[lonely](./lonely.md)\n"));
    const { results, warnings, errors } = lintRepo(root, NOW);
    expect(results.map((result) => result.warnings.length)).toEqual([0, 2]);
    expect(warnings.map((warning) => warning.kind)).toEqual(["orphan", "stale"]);
    expect(errors).toEqual([]);
    expect(lintRepo(root, Date.UTC(2026, 9, 1)).warnings).toHaveLength(1);
    expect(lintRepo(root).warnings).toHaveLength(2);
  });

  it("fails when there is no base", () => {
    const root = tempDir();
    expect(lintRepo(root)).toEqual({
      results: [],
      warnings: [],
      errors: [{ file: root, message: "no OKF bases found" }]
    });
  });
});
