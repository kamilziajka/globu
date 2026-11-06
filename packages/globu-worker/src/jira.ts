export type JiraComment = { author: string; created: string; body: string };
export type JiraIssue = {
  key: string;
  summary: string;
  description: string;
  labels: string[];
  status: string;
  statusId: string;
  assignee: string | null;
  comments: JiraComment[];
  fields: Record<string, unknown>;
};
export type JiraUser = { accountId: string; displayName: string };
export type JiraClient = {
  myself(): Promise<JiraUser>;
  search(jql: string, max: number): Promise<string[]>;
  issue(key: string): Promise<JiraIssue>;
  assign(key: string, accountId: string | null): Promise<void>;
  transitionTo(key: string, status: string): Promise<void>;
  comment(key: string, body: string): Promise<void>;
  addLabel(key: string, label: string): Promise<void>;
  remoteLink(key: string, url: string, title: string): Promise<void>;
};
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type RawIssue = {
  key: string;
  fields: Record<string, unknown> & {
    summary: string;
    description: string | null;
    labels: string[];
    status: { id: string; name: string };
    assignee: { accountId: string } | null;
    comment?: { comments: { author: { displayName: string }; created: string; body: string }[] };
  };
};
type Transition = { id: string; to: { id: string; name: string } };

export function isStatusId(status: string): boolean {
  return /^\d+$/.test(status);
}

export function matchesStatus(candidate: { id: string; name: string }, wanted: string): boolean {
  return isStatusId(wanted) ? candidate.id === wanted : candidate.name.toLowerCase() === wanted.toLowerCase();
}

const ISSUE_FIELDS = "*all";

function toIssue(raw: RawIssue): JiraIssue {
  const { summary, description, labels, status, assignee, comment, ...rest } = raw.fields;
  return {
    key: raw.key,
    summary,
    description: description ?? "",
    labels,
    status: status.name,
    statusId: status.id,
    assignee: assignee?.accountId ?? null,
    comments: (comment?.comments ?? []).map((entry) => ({
      author: entry.author.displayName,
      created: entry.created,
      body: entry.body
    })),
    fields: rest
  };
}

export function jiraClient(site: string, email: string, token: string, fetchFn: Fetch = fetch): JiraClient {
  const base = site.replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  async function request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetchFn(`${base}/rest/api/2${route}`, {
      method,
      headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Jira ${method} ${route} failed: ${response.status} ${text.trim()}`);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  const issuePath = (key: string) => `/issue/${encodeURIComponent(key)}`;

  return {
    myself: () => request<JiraUser>("GET", "/myself"),
    async search(jql, max) {
      const result = await request<{ issues: { key: string }[] }>("POST", "/search/jql", {
        jql,
        maxResults: max,
        fields: ["summary"]
      });
      return result.issues.map((issue) => issue.key);
    },
    async issue(key) {
      return toIssue(await request<RawIssue>("GET", `${issuePath(key)}?fields=${ISSUE_FIELDS}`));
    },
    assign: (key, accountId) => request("PUT", `${issuePath(key)}/assignee`, { accountId }),
    async transitionTo(key, status) {
      const { transitions } = await request<{ transitions: Transition[] }>("GET", `${issuePath(key)}/transitions`);
      const transition = transitions.find((candidate) => matchesStatus(candidate.to, status));
      if (transition === undefined) {
        const names = transitions.map((candidate) => `${candidate.to.name} (${candidate.to.id})`).join(", ") || "none";
        throw new Error(`${key} has no transition to "${status}", available: ${names}`);
      }
      await request("POST", `${issuePath(key)}/transitions`, { transition: { id: transition.id } });
    },
    comment: (key, body) => request("POST", `${issuePath(key)}/comment`, { body }),
    addLabel: (key, label) => request("PUT", issuePath(key), { update: { labels: [{ add: label }] } }),
    remoteLink: (key, url, title) => request("POST", `${issuePath(key)}/remotelink`, { object: { url, title } })
  };
}
