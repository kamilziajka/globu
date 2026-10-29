import { describe, expect, it } from "vitest";
import { looksLikeRepoUrl, normalizeRepoUrl, repoBasename, sameRepo, splitFileLink } from "./giturl.js";

describe("normalizeRepoUrl", () => {
  it("treats ssh, scp and https forms as the same repo", () => {
    const expected = "github.com/acme/notes";
    expect(normalizeRepoUrl("git@github.com:Acme/notes.git")).toBe(expected);
    expect(normalizeRepoUrl(" https://github.com/acme/notes ")).toBe(expected);
    expect(normalizeRepoUrl("ssh://git@github.com:22/acme/notes.git/")).toBe(expected);
  });

  it("keeps file URLs case sensitive", () => {
    expect(normalizeRepoUrl("file:///tmp/Repos/Notes.git")).toBe("file:/tmp/Repos/Notes");
  });

  it("falls back to the trimmed value", () => {
    expect(normalizeRepoUrl("Weird")).toBe("weird");
  });
});

describe("helpers", () => {
  it("looksLikeRepoUrl recognises URLs and scp syntax", () => {
    expect(looksLikeRepoUrl("https://github.com/acme/notes")).toBe(true);
    expect(looksLikeRepoUrl("file:///tmp/x")).toBe(true);
    expect(looksLikeRepoUrl("git@github.com:acme/notes.git")).toBe(true);
    expect(looksLikeRepoUrl("./notes")).toBe(false);
    expect(looksLikeRepoUrl("/abs/path")).toBe(false);
  });

  it("sameRepo is false when either side is unknown", () => {
    expect(sameRepo("git@github.com:acme/notes.git", "https://github.com/acme/notes")).toBe(true);
    expect(sameRepo(null, "https://github.com/acme/notes")).toBe(false);
    expect(sameRepo("https://github.com/acme/notes", null)).toBe(false);
  });

  it("repoBasename takes the last path segment", () => {
    expect(repoBasename("git@github.com:acme/notes.git")).toBe("notes");
    expect(repoBasename("https://github.com/acme/handbook/")).toBe("handbook");
    expect(repoBasename("/Users/me/projects/local")).toBe("local");
  });
});

describe("splitFileLink", () => {
  it("splits GitLab and GitHub file links into repo, ref and file", () => {
    expect(splitFileLink("https://gitlab.example.com/group/sub/repo/-/blob/main/.globu/manifest.yaml")).toEqual({
      repo: "https://gitlab.example.com/group/sub/repo",
      ref: "main",
      file: ".globu/manifest.yaml"
    });
    expect(splitFileLink("https://gitlab.com/acme/repo/-/raw/v1.2/team.yaml?ref_type=tags")).toEqual({
      repo: "https://gitlab.com/acme/repo",
      ref: "v1.2",
      file: "team.yaml"
    });
    expect(splitFileLink("https://github.com/acme/repo/blob/main/.globu/manifest.yaml#L1")).toEqual({
      repo: "https://github.com/acme/repo",
      ref: "main",
      file: ".globu/manifest.yaml"
    });
    expect(splitFileLink("https://raw.githubusercontent.com/acme/repo/main/.globu/manifest.yaml")).toEqual({
      repo: "https://github.com/acme/repo",
      ref: "main",
      file: ".globu/manifest.yaml"
    });
  });

  it("leaves repo URLs and paths alone", () => {
    expect(splitFileLink("https://github.com/acme/repo.git")).toBeNull();
    expect(splitFileLink("git@github.com:acme/repo.git")).toBeNull();
    expect(splitFileLink("./team/.globu/manifest.yaml")).toBeNull();
  });
});
