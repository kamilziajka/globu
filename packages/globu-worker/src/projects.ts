import type { ResolvedShard } from "../../globu-core/src/index.js";
import { type ServedProject, settingsFor, type WorkerConfig } from "./config.js";
import { isStatusId } from "./jira.js";

export type Layout = { targets: string[]; secondary: string[]; reference: string[] };
export type Target = { shard: string; problem: null } | { shard: null; problem: string };

export function layoutOf(project: ServedProject, shards: ResolvedShard[]): Layout {
  if (project.legacy !== undefined) {
    return { targets: project.legacy.deliverable, secondary: project.legacy.companion, reference: [] };
  }
  const capped = (id: string) => shards.find((shard) => shard.id === id)?.access === "read";
  const writable = project.shards.filter((id) => !capped(id));
  return {
    targets: writable,
    secondary: writable.length > 1 ? writable : [],
    reference: project.shards.filter(capped)
  };
}

export function deliveryShards(config: WorkerConfig, shards: ResolvedShard[]): string[] {
  const ids = config.projects.flatMap((project) => {
    const { targets, secondary } = layoutOf(project, shards);
    return [...targets, ...secondary];
  });
  return [...new Set(ids)];
}

export function othersOf(project: ServedProject, target: string, shards: ResolvedShard[]): string[] {
  return layoutOf(project, shards).secondary.filter((id) => project.legacy !== undefined || id !== target);
}

export function setupShards(project: ServedProject, target: string, others: string[]): string[] {
  return project.legacy === undefined ? [target] : [target, ...others];
}

export function targetOf(project: ServedProject, marker: string | null, shards: ResolvedShard[]): Target {
  const { targets, reference } = layoutOf(project, shards);
  const list = targets.join(", ") || "none";
  if (project.legacy !== undefined) {
    if (marker === null) {
      return { shard: null, problem: `no deliverable repository marker, the worker delivers to ${list}` };
    }
    if (targets.includes(marker)) return { shard: marker, problem: null };
    return { shard: null, problem: `"${marker}" is not a deliverable shard, the worker delivers to ${list}` };
  }
  if (marker === null) {
    if (targets.length === 1) return { shard: targets[0], problem: null };
    return {
      shard: null,
      problem: `no repository marker, and project ${project.name} has ${targets.length} shards a run can land in: ${list}`
    };
  }
  if (targets.includes(marker)) return { shard: marker, problem: null };
  const why = reference.includes(marker)
    ? `is reference only in project ${project.name} (access: read)`
    : `is not in project ${project.name}`;
  return { shard: null, problem: `the repository marker names "${marker}", which ${why}, whose runs land in ${list}` };
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function projectClause(config: WorkerConfig, project: ServedProject): string {
  const { statuses, filter } = settingsFor(config, project);
  const status =
    statuses.ready === undefined
      ? "statusCategory != Done"
      : `status = ${isStatusId(statuses.ready) ? statuses.ready : quoted(statuses.ready)}`;
  const extra = filter === undefined ? "" : ` AND (${filter})`;
  return `(project = ${quoted(project.jira as string)} AND ${status}${extra})`;
}

function withoutOrder(jql: string): string {
  return jql.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
}

export function searchFilter(config: WorkerConfig): string {
  const { jql, eligibleLabel, blockedLabel } = config.jira;
  if (jql !== undefined) return withoutOrder(jql);
  const projects = config.projects.map((project) => projectClause(config, project)).join(" OR ");
  return `(${projects}) AND labels = ${quoted(eligibleLabel)} AND labels != ${quoted(blockedLabel)} AND assignee is EMPTY`;
}

export function searchJql(config: WorkerConfig): string {
  return config.jira.jql ?? `${searchFilter(config)} ORDER BY ${config.order}`;
}

export function overrideNotes(config: WorkerConfig): string[] {
  const { jql, blockedLabel } = config.jira;
  if (jql === undefined) return [];
  return [
    ...(jql.includes(blockedLabel)
      ? []
      : [`jira.jql does not mention ${blockedLabel}, so a released issue is found again`]),
    ...(/assignee\s+is\s+empty/i.test(jql) ? [] : ["jira.jql has no `assignee is EMPTY`, so claimed issues are found"])
  ];
}
