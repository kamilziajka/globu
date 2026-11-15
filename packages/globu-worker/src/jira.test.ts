import { describe, expect, it } from "vitest";
import { blockersOf, type Fetch, type JiraIssue, jiraClient } from "./jira.js";

type Call = { method: string; url: string; body: unknown; authorization: string };

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const path = url
      .replace("https://acme.atlassian.net/rest/api/2", "")
      .replace("https://acme.atlassian.net/rest/api/3", "v3:");
    const route = `${init.method} ${path}`;
    calls.push({
      method: init.method as string,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      authorization: (init.headers as Record<string, string>).Authorization
    });
    const match = routes[route];
    if (match === undefined) return new Response("no such route", { status: 404 });
    const text = match.body === undefined ? "" : JSON.stringify(match.body);
    return new Response(text, { status: match.status ?? 200 });
  };
  return { fetchFn, calls };
}

const RAW_ISSUE = {
  key: "MR-7",
  fields: {
    summary: "Add the thing",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Description" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Lands in " },
            { type: "text", text: "backend/src/app.ts", marks: [{ type: "code" }] },
            { type: "text", text: "." }
          ]
        }
      ]
    },
    labels: ["agent-eligible", "repo:backend"],
    status: { id: "10001", name: "Ready for delivery" },
    assignee: null,
    comment: {
      comments: [
        {
          author: { displayName: "Kamil" },
          created: "2026-11-05T10:00:00.000+0000",
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "go" }] }] }
        }
      ]
    },
    customfield_10042: { value: "backend" }
  }
};

describe("jiraClient", () => {
  it("authenticates with a basic header and strips a trailing slash from the site", async () => {
    const { fetchFn, calls } = fakeFetch({ "GET /myself": { body: { accountId: "a1", displayName: "Bot" } } });
    const client = jiraClient("https://acme.atlassian.net/", "bot@acme.example", "secret", fetchFn);
    expect(await client.myself()).toEqual({ accountId: "a1", displayName: "Bot" });
    expect(calls[0].authorization).toBe(`Basic ${Buffer.from("bot@acme.example:secret").toString("base64")}`);
    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/2/myself");
  });

  it("searches and reads issues into the worker's shape", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /search/jql": {
        body: {
          issues: [
            { key: "MR-7", fields: { labels: ["agent-next"] } },
            { key: "MR-8", fields: { labels: [] } }
          ]
        }
      },
      "GET v3:/issue/MR-7?fields=*all": { body: RAW_ISSUE },
      "GET v3:/issue/MR-9?fields=*all": {
        body: {
          key: "MR-9",
          fields: {
            summary: "Bare",
            description: null,
            labels: [],
            status: { id: "1", name: "Open" },
            assignee: { accountId: "a1" }
          }
        }
      }
    });
    const client = jiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    expect(await client.search("project = MR", 50)).toEqual([
      { key: "MR-7", labels: ["agent-next"] },
      { key: "MR-8", labels: [] }
    ]);
    expect(calls[0].body).toEqual({ jql: "project = MR", maxResults: 50, fields: ["summary", "labels"] });
    expect(await client.issue("MR-7")).toEqual({
      key: "MR-7",
      summary: "Add the thing",
      description: "## Description\n\nLands in `backend/src/app.ts`.",
      labels: ["agent-eligible", "repo:backend"],
      status: "Ready for delivery",
      statusId: "10001",
      assignee: null,
      comments: [{ author: "Kamil", created: "2026-11-05T10:00:00.000+0000", body: "go" }],
      fields: { customfield_10042: { value: "backend" } }
    });
    const bare = await client.issue("MR-9");
    expect(calls[1].url).toBe("https://acme.atlassian.net/rest/api/3/issue/MR-7?fields=*all");
    expect(bare.description).toBe("");
    expect(bare.comments).toEqual([]);
    expect(bare.assignee).toBe("a1");
  });

  it("assigns, transitions by target status name or id, comments, labels and links", async () => {
    const { fetchFn, calls } = fakeFetch({
      "PUT /issue/MR-7/assignee": {},
      "GET /issue/MR-7/transitions": {
        body: {
          transitions: [
            { id: "11", to: { id: "10023", name: "Delivery" } },
            { id: "21", to: { id: "10024", name: "Done" } }
          ]
        }
      },
      "POST /issue/MR-7/transitions": {},
      "POST /issue/MR-7/comment": { status: 201, body: { id: "1" } },
      "PUT /issue/MR-7": {},
      "POST /issue/MR-7/remotelink": { status: 201, body: { id: 1 } }
    });
    const client = jiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    await client.assign("MR-7", "a1");
    await client.assign("MR-7", null);
    await client.transitionTo("MR-7", "delivery");
    await client.transitionTo("MR-7", "10024");
    await client.comment("MR-7", "hello");
    await client.addLabel("MR-7", "agent-blocked");
    await client.remoteLink("MR-7", "https://github.com/acme/backend/pull/1", "Pull request for MR-7");
    expect(calls.map((call) => call.body)).toEqual([
      { accountId: "a1" },
      { accountId: null },
      undefined,
      { transition: { id: "11" } },
      undefined,
      { transition: { id: "21" } },
      { body: "hello" },
      { update: { labels: [{ add: "agent-blocked" }] } },
      { object: { url: "https://github.com/acme/backend/pull/1", title: "Pull request for MR-7" } }
    ]);
  });

  it("creates an issue by issue type name or id and links two issues", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /issue": { status: 201, body: { id: "10100", key: "MR-9" } },
      "POST /issueLink": { status: 201 }
    });
    const client = jiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    const named = { project: "MR", issueType: "Task", summary: "Do more", description: "Later." };
    expect(await client.createIssue(named)).toBe("MR-9");
    expect(await client.createIssue({ ...named, issueType: "10002" })).toBe("MR-9");
    await client.linkIssues("Relates", "MR-7", "MR-9");
    expect(calls.map((call) => call.body)).toEqual([
      { fields: { project: { key: "MR" }, issuetype: { name: "Task" }, summary: "Do more", description: "Later." } },
      { fields: { project: { key: "MR" }, issuetype: { id: "10002" }, summary: "Do more", description: "Later." } },
      { type: { name: "Relates" }, inwardIssue: { key: "MR-7" }, outwardIssue: { key: "MR-9" } }
    ]);
  });

  it("removes a label and sets a text or option field after reading its type", async () => {
    const { fetchFn, calls } = fakeFetch({
      "PUT /issue/MR-7": {},
      "GET /issue/MR-7/editmeta": {
        body: {
          fields: {
            customfield_1: { schema: { type: "string" } },
            customfield_2: { schema: { type: "option" } },
            customfield_3: {}
          }
        }
      }
    });
    const client = jiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    await client.removeLabel("MR-7", "agent-blocked");
    await client.setField("MR-7", "customfield_1", "backend");
    await client.setField("MR-7", "customfield_2", "backend");
    await client.setField("MR-7", "customfield_3", "backend");
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
      { update: { labels: [{ remove: "agent-blocked" }] } },
      { fields: { customfield_1: "backend" } },
      { fields: { customfield_2: { value: "backend" } } },
      { fields: { customfield_3: "backend" } }
    ]);
    await expect(client.setField("MR-7", "customfield_9", "backend")).rejects.toThrow(
      "customfield_9 cannot be edited on MR-7"
    );
  });

  it("names the available transitions when none leads to the status", async () => {
    const { fetchFn } = fakeFetch({
      "GET /issue/MR-7/transitions": { body: { transitions: [{ id: "21", to: { id: "10024", name: "Done" } }] } },
      "GET /issue/MR-8/transitions": { body: { transitions: [] } }
    });
    const client = jiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    await expect(client.transitionTo("MR-7", "Delivery")).rejects.toThrow(
      'MR-7 has no transition to "Delivery", available: Done (10024)'
    );
    await expect(client.transitionTo("MR-7", "10023")).rejects.toThrow('MR-7 has no transition to "10023"');
    await expect(client.transitionTo("MR-8", "Delivery")).rejects.toThrow("available: none");
  });

  it("reports a failed request with its status and body", async () => {
    const { fetchFn } = fakeFetch({ "GET /myself": { status: 401, body: { message: "bad token" } } });
    const client = jiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    await expect(client.myself()).rejects.toThrow('Jira GET /myself failed: 401 {"message":"bad token"}');
    await expect(client.search("x", 1)).rejects.toThrow("Jira POST /search/jql failed: 404 no such route");
  });
});

describe("blockersOf", () => {
  const linked = (key: string, status: string, category: string) => ({
    key,
    fields: { summary: `Summary of ${key}`, status: { name: status, statusCategory: { key: category } } }
  });
  const withLinks = (issuelinks: unknown): JiraIssue => ({
    key: "MR-7",
    summary: "",
    description: "",
    labels: [],
    status: "Ready for delivery",
    statusId: "10001",
    assignee: null,
    comments: [],
    fields: { issuelinks }
  });

  it("returns the inward side of links whose type blocks, with the blocker's status", () => {
    const issue = withLinks([
      { type: { name: "Blocks" }, inwardIssue: linked("MR-1", "In Review", "indeterminate") },
      { type: { name: "blocks" }, inwardIssue: linked("MR-2", "Done", "done") },
      { type: { name: "Blocks" }, outwardIssue: linked("MR-9", "To Do", "new") },
      { type: { name: "Relates" }, inwardIssue: linked("MR-3", "To Do", "new") },
      { type: { name: "Dependency" }, inwardIssue: { key: "MR-4" } },
      { inwardIssue: linked("MR-5", "To Do", "new") }
    ]);
    expect(blockersOf(issue, ["Blocks"])).toEqual([
      { key: "MR-1", summary: "Summary of MR-1", status: "In Review", done: false },
      { key: "MR-2", summary: "Summary of MR-2", status: "Done", done: true }
    ]);
    expect(blockersOf(issue, ["Dependency"])).toEqual([{ key: "MR-4", summary: "", status: "unknown", done: false }]);
    expect(blockersOf(issue, [])).toEqual([]);
  });

  it("finds nothing when the issue has no links field", () => {
    expect(blockersOf(withLinks(undefined), ["Blocks"])).toEqual([]);
  });
});
