import { type AdfNode, adfToMarkdown } from "./adf.js";

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
export type JiraBlocker = { key: string; summary: string; status: string; done: boolean };
export type JiraLink = { relation: string; key: string; summary: string; status: string };
export type JiraUser = { accountId: string; displayName: string };
export type JiraHit = { key: string; labels: string[] };
export type NewIssue = { project: string; issueType: string; summary: string; description: string };
export type JiraClient = {
  myself(): Promise<JiraUser>;
  search(jql: string, max: number): Promise<JiraHit[]>;
  issue(key: string): Promise<JiraIssue>;
  assign(key: string, accountId: string | null): Promise<void>;
  transitionTo(key: string, status: string): Promise<void>;
  comment(key: string, body: string): Promise<void>;
  addLabel(key: string, label: string): Promise<void>;
  removeLabel(key: string, label: string): Promise<void>;
  setField(key: string, field: string, value: string): Promise<void>;
  remoteLink(key: string, url: string, title: string): Promise<void>;
  createIssue(issue: NewIssue): Promise<string>;
  linkIssues(type: string, inward: string, outward: string): Promise<void>;
};
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type RawIssue = {
  key: string;
  fields: Record<string, unknown> & {
    summary: string;
    description: AdfNode | null;
    labels: string[];
    status: { id: string; name: string };
    assignee: { accountId: string } | null;
    comment?: { comments: { author: { displayName: string }; created: string; body: AdfNode }[] };
  };
};
type Transition = { id: string; to: { id: string; name: string } };
type EditMeta = { fields: Record<string, { schema?: { type?: string } }> };

export function isStatusId(status: string): boolean {
  return /^\d+$/.test(status);
}

export function matchesStatus(candidate: { id: string; name: string }, wanted: string): boolean {
  return isStatusId(wanted) ? candidate.id === wanted : candidate.name.toLowerCase() === wanted.toLowerCase();
}

const ISSUE_FIELDS = "*all";

type RawLinked = {
  key: string;
  fields?: { summary?: string; status?: { name: string; statusCategory?: { key: string } } };
};
type RawLink = {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: RawLinked;
  outwardIssue?: RawLinked;
};

function rawLinks(issue: JiraIssue): RawLink[] {
  return Array.isArray(issue.fields.issuelinks) ? (issue.fields.issuelinks as RawLink[]) : [];
}

export function linksOf(issue: JiraIssue): JiraLink[] {
  return rawLinks(issue).flatMap((link) => {
    const linked = link.inwardIssue ?? link.outwardIssue;
    if (linked === undefined) return [];
    const named = link.inwardIssue === undefined ? link.type?.outward : link.type?.inward;
    return [
      {
        relation: named ?? link.type?.name ?? "linked to",
        key: linked.key,
        summary: linked.fields?.summary ?? "",
        status: linked.fields?.status?.name ?? "unknown"
      }
    ];
  });
}

export function blockersOf(issue: JiraIssue, types: string[]): JiraBlocker[] {
  const wanted = types.map((type) => type.toLowerCase());
  return rawLinks(issue).flatMap((link) => {
    const linked = link.inwardIssue;
    if (linked === undefined || !wanted.includes((link.type?.name ?? "").toLowerCase())) return [];
    const status = linked.fields?.status;
    return [
      {
        key: linked.key,
        summary: linked.fields?.summary ?? "",
        status: status?.name ?? "unknown",
        done: status?.statusCategory?.key === "done"
      }
    ];
  });
}

function toIssue(raw: RawIssue): JiraIssue {
  const { summary, description, labels, status, assignee, comment, ...rest } = raw.fields;
  return {
    key: raw.key,
    summary,
    description: adfToMarkdown(description),
    labels,
    status: status.name,
    statusId: status.id,
    assignee: assignee?.accountId ?? null,
    comments: (comment?.comments ?? []).map((entry) => ({
      author: entry.author.displayName,
      created: entry.created,
      body: adfToMarkdown(entry.body)
    })),
    fields: rest
  };
}

export function jiraClient(site: string, email: string, token: string, fetchFn: Fetch = fetch): JiraClient {
  const base = site.replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  async function request<T>(method: string, route: string, body?: unknown, version = 2): Promise<T> {
    const response = await fetchFn(`${base}/rest/api/${version}${route}`, {
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
      const result = await request<{ issues: { key: string; fields: { labels: string[] } }[] }>("POST", "/search/jql", {
        jql,
        maxResults: max,
        fields: ["summary", "labels"]
      });
      return result.issues.map((issue) => ({ key: issue.key, labels: issue.fields.labels }));
    },
    async issue(key) {
      return toIssue(await request<RawIssue>("GET", `${issuePath(key)}?fields=${ISSUE_FIELDS}`, undefined, 3));
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
    removeLabel: (key, label) => request("PUT", issuePath(key), { update: { labels: [{ remove: label }] } }),
    async setField(key, field, value) {
      const { fields } = await request<EditMeta>("GET", `${issuePath(key)}/editmeta`);
      const meta = fields[field];
      if (meta === undefined) throw new Error(`${field} cannot be edited on ${key}`);
      const content = meta.schema?.type === "option" ? { value } : value;
      await request("PUT", issuePath(key), { fields: { [field]: content } });
    },
    remoteLink: (key, url, title) => request("POST", `${issuePath(key)}/remotelink`, { object: { url, title } }),
    async createIssue({ project, issueType, summary, description }) {
      const issuetype = isStatusId(issueType) ? { id: issueType } : { name: issueType };
      const created = await request<{ key: string }>("POST", "/issue", {
        fields: { project: { key: project }, issuetype, summary, description }
      });
      return created.key;
    },
    linkIssues: (type, inward, outward) =>
      request("POST", "/issueLink", {
        type: { name: type },
        inwardIssue: { key: inward },
        outwardIssue: { key: outward }
      })
  };
}
