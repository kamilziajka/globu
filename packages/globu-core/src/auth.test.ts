import { afterEach, describe, expect, it } from "vitest";
import { gitAuthArgs, useGitHubToken } from "./auth.js";

const BASIC = `Authorization: Basic ${Buffer.from("x-access-token:secret").toString("base64")}`;

describe("gitAuthArgs", () => {
  afterEach(() => useGitHubToken(null));

  it("falls back to a GitHub token for github.com only, below GLOBU_GIT_TOKEN and explicit credentials", () => {
    useGitHubToken("gh");
    const github = `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from("x-access-token:gh").toString("base64")}`;
    expect(gitAuthArgs("https://GitHub.com/acme/notes.git")).toEqual([
      "-c",
      github.replace("github.com", "GitHub.com")
    ]);
    expect(gitAuthArgs("git@github.com:acme/notes.git")[1]).toBe(github);
    expect(gitAuthArgs("https://gitlab.com/acme/notes.git")).toEqual([]);
    expect(gitAuthArgs("https://github.com/acme/notes.git", { token: "secret" })[1]).toContain(BASIC);
    process.env.GLOBU_GIT_TOKEN = "secret";
    expect(gitAuthArgs("https://github.com/acme/notes.git")[1]).toContain(BASIC);
  });

  it("does nothing without a token", () => {
    expect(gitAuthArgs("git@github.com:acme/notes.git")).toEqual([]);
  });

  it("adds a basic auth header scoped to the host of an http URL", () => {
    process.env.GLOBU_GIT_TOKEN = "secret";
    expect(gitAuthArgs("https://github.com/acme/notes.git")).toEqual([
      "-c",
      `http.https://github.com/.extraheader=${BASIC}`
    ]);
    expect(gitAuthArgs("http://127.0.0.1:8080/notes.git")).toEqual([
      "-c",
      `http.http://127.0.0.1:8080/.extraheader=${BASIC}`
    ]);
  });

  it("rewrites ssh URLs to https for the same host", () => {
    process.env.GLOBU_GIT_TOKEN = "secret";
    expect(gitAuthArgs("git@github.com:acme/notes.git")).toEqual([
      "-c",
      `http.https://github.com/.extraheader=${BASIC}`,
      "-c",
      "url.https://github.com/.insteadOf=git@github.com:"
    ]);
    expect(gitAuthArgs("ssh://git@gitlab.example.com:2222/team/notes.git")).toEqual([
      "-c",
      `http.https://gitlab.example.com/.extraheader=${BASIC}`,
      "-c",
      "url.https://gitlab.example.com/.insteadOf=ssh://git@gitlab.example.com:2222/"
    ]);
  });

  it("honours the user name override and leaves other sources alone", () => {
    process.env.GLOBU_GIT_TOKEN = "secret";
    process.env.GLOBU_GIT_USER = "oauth2";
    expect(gitAuthArgs("https://gitlab.com/team/notes.git")[1]).toContain(
      Buffer.from("oauth2:secret").toString("base64")
    );
    expect(gitAuthArgs("file:///tmp/notes")).toEqual([]);
    expect(gitAuthArgs("git://example.com/notes.git")).toEqual([]);
    expect(gitAuthArgs(null)).toEqual([]);
  });
});
