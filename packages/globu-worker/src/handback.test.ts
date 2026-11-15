import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, write } from "../../testing/index.js";
import { type FollowUpSettings, loadWorkerConfig, requireProject, settingsFor } from "./config.js";
import { FILED_FILE, filedFor, saveFiled } from "./filed.js";
import { fileFollowUps, followUpSection, parseFollowUps, parseOutcome, SUMMARY_LIMIT } from "./handback.js";
import type { JiraClient, NewIssue } from "./jira.js";
import { type Logger, setLogger, silentLogger } from "./logger.js";

afterEach(() => setLogger(silentLogger));

function config(followUps = "", key = "MR-7"): FollowUpSettings | undefined {
  const loaded = loadWorkerConfig(
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
  return settingsFor(loaded, requireProject(loaded, key)).followUps;
}

type Fake = JiraClient & { created: NewIssue[]; linked: string[] };

function jira(options: { failCreate?: string; failLink?: string; first?: number } = {}): Fake {
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
      return `${issue.project}-${(options.first ?? 100) + created.length}`;
    },
    linkIssues: async (type, inward, outward) => {
      if (outward === options.failLink) throw new Error("Jira POST /issueLink failed: 404 no link type");
      linked.push(`${inward} ${type} ${outward}`);
    },
    issueTypes: unused,
    linkTypes: unused,
    permissions: unused
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
    expect(await fileFollowUps(fake, config(), tempDir(), "MR-7", "run-1", HANDBACK)).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  it("creates each follow-up in the issue's project and links it, logging each", async () => {
    const { logger, entries } = memory();
    setLogger(logger);
    const fake = jira();
    const filed = await fileFollowUps(
      fake,
      config("  followUps:\n    issueType: Task"),
      tempDir(),
      "MR-7",
      "run-1",
      HANDBACK
    );
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
    const filed = await fileFollowUps(fake, config(settings), tempDir(), "MR-7", "run-1", HANDBACK);
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
    const other = await fileFollowUps(
      fake,
      config(settings, "SB-2"),
      tempDir(),
      "SB-2",
      "run-2",
      "## Follow-ups\n- One\n"
    );
    expect(other).toEqual([]);
  });
});

describe("fileFollowUps on a later attempt", () => {
  const settings = "  followUps:\n    issueType: Task";
  const first = "## Follow-ups\n- Add retries to the client\n- Rename the flag\n- Drop the old flag\n";

  it("records each follow-up as it is created and linked, and reuses it on a later attempt", async () => {
    const { logger, entries } = memory();
    setLogger(logger);
    const home = tempDir();
    const fake = jira({ failLink: "MR-102" });
    await fileFollowUps(fake, config(settings), home, "MR-7", "run-1", first);
    expect(JSON.parse(fs.readFileSync(path.join(home, FILED_FILE), "utf8"))).toEqual({
      "MR-7": [
        { summary: "Add retries to the client", key: "MR-101", linked: true },
        { summary: "Rename the flag", key: "MR-102", linked: false },
        { summary: "Drop the old flag", key: "MR-103", linked: true }
      ]
    });
    const second = "## Follow-ups\n- Rename the flag\n- Add retries to the client\n- Write the docs\n";
    const again = jira({ first: 200 });
    const filed = await fileFollowUps(again, config(settings), home, "MR-7", "run-2", second);
    expect(filed).toEqual([
      { summary: "Rename the flag", key: "MR-102", problem: null },
      { summary: "Add retries to the client", key: "MR-101", problem: null },
      { summary: "Write the docs", key: "MR-201", problem: null },
      { summary: "Drop the old flag", key: "MR-103", problem: "filed by an earlier attempt, not in this handback" }
    ]);
    expect(again.created.map((issue) => issue.summary)).toEqual(["Write the docs"]);
    expect(again.linked).toEqual(["MR-7 Relates MR-102", "MR-7 Relates MR-201"]);
    expect(filedFor(home, "MR-7").map((entry) => [entry.key, entry.linked])).toEqual([
      ["MR-101", true],
      ["MR-102", true],
      ["MR-103", true],
      ["MR-201", true]
    ]);
    expect(entries.filter((entry) => entry.includes("follow-up reused"))).toHaveLength(2);
    expect(entries.at(-1)).toBe(
      'info follow-up kept {"run":"run-2","key":"MR-7","followUp":"MR-103","summary":"Drop the old flag"}'
    );
    expect(filedFor(home, "SB-2")).toEqual([]);
  });

  it("tries again to link an earlier follow-up the new handback leaves out", async () => {
    const home = tempDir();
    saveFiled(home, "MR-7", [{ summary: "Drop the old flag", key: "MR-103", linked: false }]);
    const filed = await fileFollowUps(jira({ failLink: "MR-103" }), config(settings), home, "MR-7", "run-2", "");
    expect(filed).toEqual([
      {
        summary: "Drop the old flag",
        key: "MR-103",
        problem:
          "filed by an earlier attempt, not in this handback, not linked: Jira POST /issueLink failed: 404 no link type"
      }
    ]);
    expect(filedFor(home, "MR-7")[0].linked).toBe(false);
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

describe("parseOutcome", () => {
  it("reads met, partial or not met from the handback's Outcome line, however it is marked up", () => {
    expect(parseOutcome("## Summary\n\nOutcome: met\n\nAll seven labs pass.")).toBe("met");
    expect(parseOutcome("## Summary\n\n**Outcome:** partial. 3 of 7 labs pass.\n")).toBe("partial");
    expect(parseOutcome("## Summary\n\n- Outcome: Partially met\n")).toBe("partial");
    expect(parseOutcome("## Summary\n\n> outcome: NOT MET, the issue is not ready\n")).toBe("not met");
    expect(parseOutcome("## Summary\n\nOutcome: met\n\n## Not done\n\nOutcome: not met\n")).toBe("met");
  });

  it("has no outcome for a handback without the line", () => {
    expect(parseOutcome("## Summary\n\nDone. The outcome: unclear.\n")).toBeNull();
    expect(parseOutcome("## Summary\n\nOutcome: fine\n")).toBeNull();
    expect(parseOutcome("")).toBeNull();
  });
});
