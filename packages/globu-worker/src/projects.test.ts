import { describe, expect, it } from "vitest";
import type { Manifest, ResolvedShard } from "../../globu-core/src/index.js";
import { tempDir, write } from "../../testing/index.js";
import { loadWorkerConfig } from "./config.js";
import {
  deliveryShards,
  layoutOf,
  othersOf,
  overrideNotes,
  searchFilter,
  searchJql,
  setupShards,
  targetOf
} from "./projects.js";

function shard(id: string, access?: "read"): ResolvedShard {
  return {
    id,
    source: { type: "git", repo: `https://github.com/acme/${id}.git` },
    format: "generic",
    roots: [{ path: "." }],
    description: "",
    useWhen: "",
    ...(access === undefined ? {} : { access }),
    path: `/work/${id}`,
    owner: "user",
    mode: access ?? "write",
    present: true
  };
}

const SHARDS = [shard("backend"), shard("product"), shard("handbook", "read"), shard("sandbox")];

const PROJECTS = {
  mercastra: {
    shards: ["backend", "product", "handbook"],
    jira: "MR",
    worker: {
      statuses: { ready: "Ready for delivery", claimed: "Delivery", released: "To Do" },
      filter: "component = API AND type != Epic"
    }
  },
  sandbox: {
    shards: ["sandbox"],
    jira: "SB",
    worker: { statuses: { ready: "10001", claimed: "Doing", released: "Open" } }
  },
  quoted: { shards: ["sandbox"], jira: "Q", worker: { statuses: { claimed: 'Say "go"', released: "Open" } } }
};

function load(text: string, projects: Record<string, unknown> = PROJECTS) {
  const manifest = (): Manifest => ({
    version: 1,
    shards: SHARDS.map(({ path: _path, owner: _owner, mode: _mode, present: _present, ...entry }) => entry),
    contexts: {},
    imports: [],
    projects: projects as Manifest["projects"]
  });
  return loadWorkerConfig(write(tempDir(), "worker.yaml", text), manifest);
}

const V2 = "version: 2\njira: { site: https://acme.atlassian.net }\n";
const V1 = `
jira:
  site: https://acme.atlassian.net
  jql: project = MR AND labels != agent-blocked AND assignee is EMPTY ORDER BY created ASC
  claimedStatus: Delivery
  releasedStatus: To Do
  repository: { labelPrefix: "repo:" }
shards:
  deliverable: [backend, sandbox]
  companion: [product]
`;

describe("the layout of a project", () => {
  it("lets a run land in every shard without the read cap and write to the others", () => {
    const [mercastra, sandbox] = load(V2).projects;
    expect(layoutOf(mercastra, SHARDS)).toEqual({
      targets: ["backend", "product"],
      secondary: ["backend", "product"],
      reference: ["handbook"]
    });
    expect(layoutOf(sandbox, SHARDS)).toEqual({ targets: ["sandbox"], secondary: [], reference: [] });
    expect(othersOf(mercastra, "product", SHARDS)).toEqual(["backend"]);
    expect(othersOf(sandbox, "sandbox", SHARDS)).toEqual([]);
    expect(setupShards(mercastra, "product", ["backend"])).toEqual(["product"]);
    expect(deliveryShards(load(V2), SHARDS)).toEqual(["backend", "product", "sandbox"]);
  });

  it("keeps deliverable and companion as they were for a version 1 file", () => {
    const config = load(V1);
    const [legacy] = config.projects;
    expect(layoutOf(legacy, SHARDS)).toEqual({
      targets: ["backend", "sandbox"],
      secondary: ["product"],
      reference: []
    });
    expect(othersOf(legacy, "backend", SHARDS)).toEqual(["product"]);
    expect(setupShards(legacy, "backend", ["product"])).toEqual(["backend", "product"]);
    expect(deliveryShards(config, SHARDS)).toEqual(["backend", "sandbox", "product"]);
  });
});

describe("the target of an issue", () => {
  it("is the marker's shard when the project has it, and the only shard without a marker", () => {
    const [mercastra, sandbox] = load(V2).projects;
    expect(targetOf(mercastra, "product", SHARDS)).toEqual({ shard: "product", problem: null });
    expect(targetOf(sandbox, null, SHARDS)).toEqual({ shard: "sandbox", problem: null });
    expect(targetOf(mercastra, null, SHARDS).problem).toBe(
      "no repository marker, and project mercastra has 2 shards a run can land in: backend, product"
    );
    expect(targetOf(mercastra, "sandbox", SHARDS).problem).toBe(
      'the repository marker names "sandbox", which is not in project mercastra, whose runs land in backend, product'
    );
    expect(targetOf(mercastra, "handbook", SHARDS).problem).toBe(
      'the repository marker names "handbook", which is reference only in project mercastra (access: read), whose runs land in backend, product'
    );
    const capped = SHARDS.map((entry) => ({ ...entry, access: "read" as const }));
    expect(targetOf(sandbox, null, capped).problem).toBe(
      "no repository marker, and project sandbox has 0 shards a run can land in: none"
    );
  });

  it("needs a deliverable marker for a version 1 file", () => {
    const [legacy] = load(V1).projects;
    expect(targetOf(legacy, "sandbox", SHARDS)).toEqual({ shard: "sandbox", problem: null });
    expect(targetOf(legacy, null, SHARDS).problem).toBe(
      "no deliverable repository marker, the worker delivers to backend, sandbox"
    );
    expect(targetOf(legacy, "product", SHARDS).problem).toBe(
      '"product" is not a deliverable shard, the worker delivers to backend, sandbox'
    );
  });
});

describe("the search", () => {
  it("is generated from the projects, their ready status and filter, the labels and the order", () => {
    const config = load(`${V2}order: priority DESC, created ASC\n`);
    const filter =
      '((project = "MR" AND status = "Ready for delivery" AND (component = API AND type != Epic)) OR (project = "SB" AND status = 10001) OR (project = "Q" AND statusCategory != Done)) AND labels = "agent-eligible" AND labels != "agent-blocked" AND assignee is EMPTY';
    expect(searchFilter(config)).toBe(filter);
    expect(searchJql(config)).toBe(`${filter} ORDER BY priority DESC, created ASC`);
    expect(overrideNotes(config)).toEqual([]);
    const labelled = load(
      `version: 2\njira: { site: https://acme.atlassian.net, eligibleLabel: 'for "agents"', blockedLabel: stop }\nprojects: [quoted]\n`
    );
    expect(searchJql(labelled)).toBe(
      '((project = "Q" AND statusCategory != Done)) AND labels = "for \\"agents\\"" AND labels != "stop" AND assignee is EMPTY ORDER BY created ASC'
    );
  });

  it("is jira.jql as written when the file has one, with notes on what it leaves out", () => {
    const config = load(`version: 2\njira: { site: https://acme.atlassian.net, jql: "project = MR order by rank" }\n`);
    expect(searchJql(config)).toBe("project = MR order by rank");
    expect(searchFilter(config)).toBe("project = MR");
    expect(overrideNotes(config)).toEqual([
      "jira.jql does not mention agent-blocked, so a released issue is found again",
      "jira.jql has no `assignee is EMPTY`, so claimed issues are found"
    ]);
    const legacy = load(V1);
    expect(searchJql(legacy)).toContain("ORDER BY created ASC");
    expect(overrideNotes(legacy)).toEqual([]);
  });
});
