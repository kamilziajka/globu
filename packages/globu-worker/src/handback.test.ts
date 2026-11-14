import { afterEach, describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { fileFollowUps, followUpSection, parseFollowUps, SUMMARY_LIMIT } from "./handback.js";
import type { JiraClient, NewIssue } from "./jira.js";
import { type Logger, setLogger, silentLogger } from "./logger.js";

afterEach(() => setLogger(silentLogger));

function config(followUps = ""): WorkerConfig {
  return loadWorkerConfig(
    write(
      tempDir(),
      "worker.yaml",
      `
jira:
  site: https://acme.atlassian.net
  jql: project = MR
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
${followUps}
shards:
  deliverable: [backend]
`
    )
  );
}

type Fake = JiraClient & { created: NewIssue[]; linked: string[] };

function jira(options: { failCreate?: string; failLink?: string } = {}): Fake {
  const created: NewIssue[] = [];
  const linked: string[] = [];
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    created,
    linked,
    myself: unused,
    search: unused,
    issue: unused,
    assign: unused,
    transitionTo: unused,
    comment: unused,
    addLabel: unused,
    removeLabel: unused,
    setField: unused,
    remoteLink: unused,
    createIssue: async (issue) => {
      if (issue.summary === options.failCreate) throw new Error("Jira POST /issue failed: 400 issuetype is invalid");
      created.push(issue);
      return `${issue.project}-${100 + created.length}`;
    },
    linkIssues: async (type, inward, outward) => {
      if (outward === options.failLink) throw new Error("Jira POST /issueLink failed: 404 no link type");
      linked.push(`${inward} ${type} ${outward}`);
    }
  };
}

function memory(): { logger: Logger; entries: string[] } {
  const entries: string[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    entries.push(`${level} ${msg} ${JSON.stringify(fields)}`);
  return { logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") }, entries };
}

const HANDBACK = [
  "## Summary",
  "",
  "Done.",
  "",
  "- not a follow-up",
  "",
  "## Follow-ups",
  "",
  "These came up on the way.",
  "",
  "- Add retries to the client",
  "  The client gives up after one failure.",
  "",
  "  - nested detail",
  "  ```sh",
  "  # not a heading",
  "  - not a bullet",
  "  ```",
  "  ### a small heading",
  "* Rename the flag",
  "lazily continued",
  "",
  "A closing remark that belongs to no bullet.",
  "+   Spaced   out   summary   ",
  "- None.",
  "",
  "## Not done",
  "",
  "- not a follow-up either"
].join("\r\n");

describe("parseFollowUps", () => {
  it("reads one follow-up per bullet of the section, the first line as the summary", () => {
    expect(parseFollowUps(HANDBACK)).toEqual([
      {
        summary: "Add retries to the client",
        description:
          "The client gives up after one failure.\n\n- nested detail\n```sh\n# not a heading\n- not a bullet\n```\n### a small heading"
      },
      { summary: "Rename the flag", description: "lazily continued" },
      { summary: "Spaced out summary", description: "" }
    ]);
  });

  it("finds the section by a level two heading only, whatever its spelling", () => {
    expect(parseFollowUps("## Summary\n\nDone.\n")).toEqual([]);
    expect(parseFollowUps("### Follow-ups\n\n- Nope\n")).toEqual([]);
    expect(parseFollowUps("## Followups ##\n- One\n# Top\n- Two\n")).toEqual([{ summary: "One", description: "" }]);
    expect(parseFollowUps("## follow ups\n\nNothing to add.\n")).toEqual([]);
  });

  it("cuts a long summary and keeps the whole line in the description", () => {
    const line = "x".repeat(SUMMARY_LIMIT + 5);
    const [long] = parseFollowUps(`## Follow-ups\n- ${line}\n  more\n`);
    expect(long.summary).toHaveLength(SUMMARY_LIMIT);
    expect(long.summary.endsWith("…")).toBe(true);
    expect(long.description).toBe(`${line}\n\nmore`);
    expect(parseFollowUps(`## Follow-ups\n- ${line}\n`)[0].description).toBe(line);
  });
});

describe("fileFollowUps", () => {
  it("does nothing unless follow-ups are configured", async () => {
    const fake = jira();
    expect(await fileFollowUps(fake, config(), "MR-7", "run-1", HANDBACK)).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  it("creates each follow-up in the issue's project and links it, logging each", async () => {
    const { logger, entries } = memory();
    setLogger(logger);
    const fake = jira();
    const filed = await fileFollowUps(fake, config("  followUps:\n    issueType: Task"), "MR-7", "run-1", HANDBACK);
    expect(filed.map((entry) => entry.key)).toEqual(["MR-101", "MR-102", "MR-103"]);
    expect(fake.created[0]).toEqual({
      project: "MR",
      issueType: "Task",
      summary: "Add retries to the client",
      description: expect.stringMatching(
        /^The client gives up after one failure\.[\s\S]*\n\nFollow-up of MR-7, from the handback of Globu worker run run-1\.$/
      )
    });
    expect(fake.created[2].description).toBe("Follow-up of MR-7, from the handback of Globu worker run run-1.");
    expect(fake.linked).toEqual(["MR-7 Relates MR-101", "MR-7 Relates MR-102", "MR-7 Relates MR-103"]);
    expect(entries[0]).toBe(
      'info follow-up filed {"run":"run-1","key":"MR-7","followUp":"MR-101","summary":"Add retries to the client"}'
    );
  });

  it("reports a follow-up it could not create, link or file and goes on with the rest", async () => {
    const { logger, entries } = memory();
    setLogger(logger);
    const fake = jira({ failCreate: "Rename the flag", failLink: "MR-101" });
    const settings = "  followUps:\n    issueType:\n      MR: Story\n    linkType: Relates to\n    max: 2";
    const filed = await fileFollowUps(fake, config(settings), "MR-7", "run-1", HANDBACK);
    expect(filed).toEqual([
      {
        summary: "Add retries to the client",
        key: "MR-101",
        problem: "not linked: Jira POST /issueLink failed: 404 no link type"
      },
      { summary: "Rename the flag", key: null, problem: "Jira POST /issue failed: 400 issuetype is invalid" },
      { summary: "Spaced out summary", key: null, problem: "over jira.followUps.max of 2" }
    ]);
    expect(fake.created.map((issue) => issue.issueType)).toEqual(["Story"]);
    expect(entries.filter((entry) => entry.startsWith("warn follow-up failed"))).toHaveLength(3);
    const other = await fileFollowUps(fake, config(settings), "SB-2", "run-2", "## Follow-ups\n- One\n");
    expect(other).toEqual([{ summary: "One", key: null, problem: "no jira.followUps.issueType for project SB" }]);
  });
});

describe("followUpSection", () => {
  it("lists the new keys and the problems, and nothing without follow-ups", () => {
    expect(followUpSection([])).toBe("");
    expect(
      followUpSection([
        { summary: "One", key: "MR-9", problem: null },
        { summary: "Two", key: "MR-10", problem: "not linked: no link type" },
        { summary: "Three", key: null, problem: "issuetype is invalid" }
      ])
    ).toBe(
      "Follow-up issues:\n- MR-9: One\n- MR-10: Two (not linked: no link type)\n- not created: Three (issuetype is invalid)\n\n"
    );
  });
});
