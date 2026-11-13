import { describe, expect, it } from "vitest";
import { followUpState, type PullRequest, parsePullRequest, repoOf } from "./pulls.js";

const RAW = {
  url: "https://github.com/acme/backend/pull/7",
  number: 7,
  title: "MR-7: Change x",
  state: "OPEN" as const,
  mergeable: "MERGEABLE",
  headRefName: "agent/MR-7-x",
  baseRefName: "main",
  statusCheckRollup: null
};

describe("parsePullRequest", () => {
  it("reads the branches and sums up the checks", () => {
    expect(parsePullRequest(RAW)).toEqual({
      url: RAW.url,
      number: 7,
      title: "MR-7: Change x",
      state: "OPEN",
      mergeable: "MERGEABLE",
      head: "agent/MR-7-x",
      base: "main",
      checks: "none",
      failing: []
    });
    const passing = [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { context: "ci/legacy", state: "SUCCESS" }
    ];
    expect(parsePullRequest({ ...RAW, statusCheckRollup: passing }).checks).toBe("passing");
    const running = [{ name: "test", status: "IN_PROGRESS", conclusion: null }];
    expect(parsePullRequest({ ...RAW, statusCheckRollup: running }).checks).toBe("pending");
    expect(parsePullRequest({ ...RAW, statusCheckRollup: [{ context: "ci", state: "PENDING" }] }).checks).toBe(
      "pending"
    );
    expect(parsePullRequest({ ...RAW, statusCheckRollup: [{}] }).checks).toBe("pending");
    const failing = parsePullRequest({
      ...RAW,
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1" },
        { context: "lint", state: "ERROR", targetUrl: "https://ci/2" },
        { name: "build", status: "COMPLETED", conclusion: "TIMED_OUT" }
      ]
    });
    expect(failing.checks).toBe("failing");
    expect(failing.failing).toEqual(["test: https://ci/1", "lint: https://ci/2", "build: no link"]);
  });
});

describe("followUpState", () => {
  it("puts merged and closed first, then a person's flag, then conflicts and checks", () => {
    const pull: PullRequest = parsePullRequest(RAW);
    expect(followUpState({ ...pull, state: "MERGED" }, true)).toBe("merged");
    expect(followUpState({ ...pull, state: "CLOSED" }, true)).toBe("closed");
    expect(followUpState({ ...pull, mergeable: "CONFLICTING" }, true)).toBe("needs human");
    expect(followUpState({ ...pull, mergeable: "CONFLICTING", checks: "failing" }, false)).toBe("conflict");
    expect(followUpState({ ...pull, checks: "failing" }, false)).toBe("checks failing");
    expect(followUpState(pull, false)).toBe("in review");
  });

  it("finds the repository of a pull request link", () => {
    expect(repoOf("https://github.com/acme/backend/pull/7")).toBe("https://github.com/acme/backend");
    expect(repoOf("https://github.com/acme/backend/pull/7/files")).toBe("https://github.com/acme/backend");
  });
});
