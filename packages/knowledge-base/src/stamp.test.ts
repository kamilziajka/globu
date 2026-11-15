import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseIndex, git, initRepo, read, tempDir, write } from "../../testing/index.js";
import { VERSION } from "./constants.js";
import { generatedActor, humanId, stampDocs, stampedContent, stampTime } from "./stamp.js";

const AT = "2026-11-15T01:02:03Z";

function base(): string {
  const root = tempDir();
  write(root, "wiki/index.md", baseIndex("demo"));
  return root;
}

function isolateGitConfig(): void {
  const empty = write(tempDir(), "gitconfig", "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", empty);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("stampTime and generatedActor", () => {
  it("writes whole seconds in UTC and names this version", () => {
    expect(stampTime(Date.UTC(2026, 10, 15, 1, 2, 3, 456))).toBe(AT);
    expect(stampTime()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(generatedActor()).toBe(`globu/${VERSION}`);
  });
});

describe("humanId", () => {
  it("is git user.name in the base's repo", () => {
    isolateGitConfig();
    const repo = initRepo(path.join(tempDir(), "repo"));
    git(repo, "config", "user.name", "Ada Lovelace");
    expect(humanId(repo)).toBe("Ada Lovelace");
  });

  it("falls back to the login name when user.name is unset", () => {
    isolateGitConfig();
    const repo = initRepo(path.join(tempDir(), "repo"));
    expect(humanId(repo)).toBe(os.userInfo().username);
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no passwd entry");
    });
    expect(() => humanId(repo)).toThrow(`cannot tell who verified: set git user.name in ${repo}`);
  });
});

describe("stampedContent", () => {
  it("sets generated and keeps everything else as it was", () => {
    const root = base();
    const body = "\n# Title\n\n---\n\nA rule above.\n";
    const file = write(
      root,
      "wiki/a.md",
      `---\ntype: "Note"\n# a comment\ndescription: 'kept as written'\ngenerated: { by: "old/1", at: 2020-01-01T00:00:00Z }\n---\n${body}`
    );
    expect(stampedContent(file, "generated", { by: "globu/1.2.0", at: AT })).toBe(
      `---\ntype: "Note"\n# a comment\ndescription: 'kept as written'\ngenerated: { by: "globu/1.2.0", at: ${AT} }\n---\n${body}`
    );
    const bom = write(root, "wiki/bom.md", '﻿---\r\ntype: "Note"\r\n---\r\nBody\r\n');
    expect(stampedContent(bom, "generated", { by: "globu/1.2.0", at: AT })).toBe(
      `﻿---\r\ntype: "Note"\ngenerated: { by: "globu/1.2.0", at: ${AT} }\r\n---\r\nBody\r\n`
    );
  });

  it("appends to verified in each shape it may have", () => {
    const root = base();
    const stamp = { by: "human:Ada Lovelace", at: AT };
    const added = `  - { by: "human:Ada Lovelace", at: ${AT} }`;
    const cases: [string, string][] = [
      ["", `verified:\n${added}`],
      ["verified:\n", `verified:\n${added}`],
      [
        "verified: { by: human:kazet, at: 2026-11-06T09:30:00Z }\n",
        `verified:\n  - { by: human:kazet, at: 2026-11-06T09:30:00Z }\n${added}`
      ],
      [
        "verified:\n  - by: process:ci\n    at: 2026-11-06T09:30:00Z\n",
        `verified:\n  - by: process:ci\n    at: 2026-11-06T09:30:00Z\n${added}`
      ]
    ];
    for (const [before, after] of cases) {
      const file = write(root, "wiki/v.md", `---\ntype: Note\n${before}---\nBody\n`);
      expect(stampedContent(file, "verified", stamp)).toBe(`---\ntype: Note\n${after}\n---\nBody\n`);
    }
  });

  it("refuses files it cannot stamp", () => {
    const root = base();
    const stamp = { by: "globu/1.2.0", at: AT };
    const outside = write(tempDir(), "notes.md", "---\ntype: Note\n---\n");
    const cases: [string, string][] = [
      [path.join(root, "wiki/index.md"), "is not a concept doc of an OKF base"],
      [write(root, "wiki/data.txt", "x"), "is not a concept doc of an OKF base"],
      [write(root, "README.md", "---\ntype: Note\n---\n"), "is not a concept doc of an OKF base"],
      [outside, "is not a concept doc of an OKF base"],
      [write(root, "wiki/bare.md", "No frontmatter.\n"), "has no YAML frontmatter block"],
      [write(root, "wiki/broken.md", "---\nkey: [unclosed\n---\n"), "unparseable YAML frontmatter"],
      [write(root, "wiki/list.md", "---\n- a\n---\n"), "the frontmatter is not a mapping"]
    ];
    for (const [file, message] of cases) expect(() => stampedContent(file, "generated", stamp)).toThrow(message);
    const odd = write(root, "wiki/odd.md", '---\ntype: Note\nverified: "2026-10-09"\n---\n');
    expect(() => stampedContent(odd, "verified", stamp)).toThrow(
      "`verified` is neither a mapping nor a list, fix it before adding a verification"
    );
  });
});

describe("stampDocs", () => {
  it("writes every file, or none when one fails", () => {
    const root = base();
    const a = write(root, "wiki/a.md", "---\ntype: Note\n---\nA\n");
    const b = write(root, "wiki/b.md", "---\ntype: Note\n---\nB\n");
    const bare = write(root, "wiki/bare.md", "bare\n");
    expect(() => stampDocs([a, bare], "generated", () => ({ by: "globu/1.2.0", at: AT }))).toThrow();
    expect(read(a)).toBe("---\ntype: Note\n---\nA\n");

    expect(stampDocs([a, b], "generated", (file) => ({ by: path.basename(file), at: AT }))).toEqual([
      { file: a, field: "generated", by: "a.md", at: AT },
      { file: b, field: "generated", by: "b.md", at: AT }
    ]);
    expect(read(b)).toBe(`---\ntype: Note\ngenerated: { by: "b.md", at: ${AT} }\n---\nB\n`);
    expect(fs.existsSync(bare)).toBe(true);
  });
});
