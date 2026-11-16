import path from "node:path";
import { resolveAll } from "../../globu-core/src/index.js";
import { projectFor, projectOf, requireProject, type ServedProject, settingsFor } from "./config.js";
import { type Gap, gapText, overlapping, type RunGap, readGaps, runGap, runGapText, WHY_WINDOW_MS } from "./gaps.js";
import { type JiraIssue, matchesStatus } from "./jira.js";
import { searchFilter, searchJql, targetOf } from "./projects.js";
import { type DeniedCall, deniedCalls, latestRuns, loadRuns, type StoredRun, spentOn } from "./runs.js";
import { currentUsage, holdReason, overLimit } from "./subscription.js";
import {
  candidateOf,
  checkShards,
  deniedLine,
  dryRunAction,
  followUps,
  markerShard,
  type OnceResult,
  OPEN_FOLLOW_UPS,
  once,
  prioritized,
  projectHolds,
  projectProblem,
  SEARCH_LIMIT,
  type WorkerDeps,
  waitingOn
} from "./worker.js";

export type Hold = {
  limit: "dayUsd" | "subscription" | "exclusive" | "openPullRequests" | "concurrent" | "perShard";
  detail: string;
};
export type WhyReport = {
  key: string;
  summary: string;
  matches: boolean;
  reasons: string[];
  blocked: boolean;
  shard: string | null;
  target: string | null;
  deliverable: boolean;
  assignee: string | null;
  waiting: { key: string; status: string }[];
  holds: Hold[];
  denied: { run: string; calls: DeniedCall[] } | null;
  action: string;
  picked: boolean;
  gaps: Gap[];
  run: RunGap | null;
};
export type DelegateResult = { key: string; shard: string; matches: boolean };

function searchName(deps: WorkerDeps): string {
  return deps.config.jira.jql === undefined ? "the worker's search" : "jira.jql";
}

type Ahead = { key: string; shard: string | null };

export async function matchesJql(deps: WorkerDeps, key: string): Promise<boolean> {
  const filter = searchFilter(deps.config);
  const jql = filter === "" ? `key = ${key}` : `key = ${key} AND (${filter})`;
  return (await deps.jira.search(jql, 1)).length > 0;
}

async function ahead(deps: WorkerDeps, key: string, slots: number, stored: StoredRun[]): Promise<Ahead[]> {
  const { config, jira } = deps;
  const taken: Ahead[] = [];
  for (const other of prioritized(await jira.search(searchJql(config), SEARCH_LIMIT), config.jira.priorityLabel)) {
    if (other === key || taken.length >= slots) break;
    const issue = await jira.issue(other);
    if (issue.assignee !== null || waitingOn(deps, issue, stored).length > 0) continue;
    const { project, shardId: shard } = candidateOf(deps, issue);
    if (project === null) continue;
    if (taken.filter((entry) => entry.shard === shard).length >= config.limits.perShard) continue;
    taken.push({ key: other, shard });
  }
  return taken;
}

function comeFirst(keys: string[], repairs = 0): string {
  const ahead = [...(repairs > 0 ? [`${repairs} ${repairs === 1 ? "repair" : "repairs"}`] : []), ...keys];
  return `${ahead.join(", ")} ${keys.length + repairs === 1 ? "comes" : "come"} first`;
}

async function holds(deps: WorkerDeps, key: string, shard: string | null, queued: boolean): Promise<Hold[]> {
  const { limits } = deps.config;
  const stored = loadRuns(deps.home);
  const found: Hold[] = [];
  const spent = spentOn(stored, deps.now());
  if (spent >= limits.dayUsd) {
    found.push({
      limit: "dayUsd",
      detail: `the day cap of ${limits.dayUsd} USD is reached, ${spent.toFixed(2)} spent`
    });
  }
  const usage = overLimit(currentUsage(deps.home, deps.env, deps.now()), limits.subscription);
  if (usage !== null) found.push({ limit: "subscription", detail: holdReason(usage, limits.subscription) });
  const project = projectFor(deps.config, key);
  const busy = project === null ? null : projectHolds(deps, "globu-worker why").busy(project);
  if (busy !== null) found.push({ limit: "exclusive", detail: `waiting on ${busy}` });
  const rows = await followUps(deps, false);
  const open = rows.filter((row) => OPEN_FOLLOW_UPS.has(row.state)).length;
  if (open >= limits.openPullRequests) {
    found.push({
      limit: "openPullRequests",
      detail: `${open} pull requests are open, the cap is ${limits.openPullRequests}`
    });
  }
  if (!queued) return found;
  const repairs = Math.min(rows.filter((row) => row.repairable).length, limits.concurrent);
  const slots = limits.concurrent - repairs;
  const taken = await ahead(deps, key, slots, stored);
  const same = taken.filter((entry) => entry.shard === shard);
  if (taken.length >= slots) {
    const keys = taken.map((entry) => entry.key);
    found.push({
      limit: "concurrent",
      detail: `limits.concurrent is ${limits.concurrent} and ${comeFirst(keys, repairs)}`
    });
  } else if (shard !== null && same.length >= limits.perShard) {
    found.push({
      limit: "perShard",
      detail: `limits.perShard is ${limits.perShard} and ${comeFirst(same.map((entry) => entry.key))} in ${shard}`
    });
  }
  return found;
}

function leftBecause(report: WhyReport, waiting: string, search: string): string {
  if (!report.matches) return `it does not match ${search}`;
  if (report.assignee !== null) return "it is assigned";
  if (waiting !== "") return `it waits on ${waiting}`;
  return report.holds.length > 0 ? report.holds[0].detail : report.action;
}

async function searchReasons(deps: WorkerDeps, issue: JiraIssue, project: ServedProject | null): Promise<string[]> {
  const { config, jira } = deps;
  if (config.jira.jql !== undefined) return [];
  if (project === null) return [`${projectOf(issue.key)} is not a project this worker serves`];
  const { statuses, filter } = settingsFor(config, project);
  const { eligibleLabel, blockedLabel } = config.jira;
  const ready = statuses.ready;
  const offStatus = ready !== undefined && !matchesStatus({ id: issue.statusId, name: issue.status }, ready);
  const offFilter = filter !== undefined && (await jira.search(`key = ${issue.key} AND (${filter})`, 1)).length === 0;
  return [
    ...(offStatus ? [`the status is ${issue.status}, not ${ready}`] : []),
    ...(issue.labels.includes(eligibleLabel) ? [] : [`the label ${eligibleLabel} is missing`]),
    ...(issue.labels.includes(blockedLabel) ? [`the label ${blockedLabel} is set`] : []),
    ...(issue.assignee === null ? [] : ["it is assigned"]),
    ...(offFilter ? [`the project's filter does not match (${filter})`] : [])
  ];
}

function gapsLine(gaps: Gap[]): string {
  if (gaps.length === 0) return "none in the last 24 hours";
  const paused = gaps.map((gap) => `the worker paused ${gapText(gap)}`).join("; ");
  return `${paused}, the machine was asleep or the worker was suspended`;
}

function pauses(deps: WorkerDeps, key: string, stored: StoredRun[]): { gaps: Gap[]; run: RunGap | null } {
  const now = deps.now();
  const since = new Date(now.getTime() - WHY_WINDOW_MS);
  const latest = latestRuns(
    stored.filter(({ record }) => record.key === key),
    1
  )[0]?.record;
  const earliest = latest === undefined || new Date(latest.startedAt) > since ? since : new Date(latest.startedAt);
  const gaps = readGaps(path.join(deps.home, "logs"), earliest);
  return {
    gaps: overlapping(gaps, since, now),
    run: latest === undefined ? null : runGap(latest, gaps, now)
  };
}

function whyLines(report: WhyReport, blockedLabel: string, search: string): string[] {
  const { key, shard, target } = report;
  const named = shard ?? "none";
  const marker =
    target === null
      ? shard === null
        ? named
        : `${named}, not a shard a run can land in`
      : target === shard
        ? named
        : `${named}, the run lands in ${target}`;
  const reasons = report.reasons.length === 0 ? "" : `: ${report.reasons.join(", ")}`;
  const waiting = report.waiting.map((blocker) => `${blocker.key} (${blocker.status})`).join(", ");
  return [
    `${key}\t${report.summary}`,
    `jql\t${report.matches ? `matches ${search}` : `does not match ${search}${reasons}`}`,
    ...(report.blocked
      ? [`blocked\t${blockedLabel} is set, \`globu-worker retry ${key}\` removes it and runs it`]
      : []),
    `marker\t${marker}`,
    `assignee\t${report.assignee ?? "none"}`,
    `blockers\t${waiting === "" ? "none open" : `waiting on ${waiting}`}`,
    `limits\t${report.holds.length === 0 ? "none hold it" : report.holds.map((hold) => hold.detail).join("; ")}`,
    `gaps\t${gapsLine(report.gaps)}`,
    ...(report.run === null ? [] : [`run\t${runGapText(report.run)}`]),
    ...(report.denied === null
      ? []
      : [
          `denied\t${report.denied.calls.length} in run ${report.denied.run}`,
          ...report.denied.calls.map((call) => `denied\t${deniedLine(call)}`)
        ]),
    `outcome\t${report.action}`,
    `verdict\t${report.picked ? "the next cycle claims it" : `the next cycle leaves it: ${leftBecause(report, waiting, search)}`}`
  ];
}

function lastDenied(stored: StoredRun[], key: string): WhyReport["denied"] {
  const [last] = latestRuns(
    stored.filter(({ record }) => record.key === key),
    1
  );
  const calls = last === undefined ? [] : deniedCalls(last.record);
  return calls.length === 0 ? null : { run: last.record.id, calls };
}

export async function why(deps: WorkerDeps, key: string): Promise<WhyReport> {
  const { config, jira, home } = deps;
  if (!deps.session) checkShards(config, home);
  const issue = await jira.issue(key);
  const matches = await matchesJql(deps, issue.key);
  const candidate = candidateOf(deps, issue);
  const unusable =
    deps.session && candidate.project !== null
      ? projectProblem(candidate.project, resolveAll().shards, home, true)
      : null;
  if (unusable !== null) throw new Error(unusable);
  const shard = markerShard(issue, config);
  const target = candidate.project === null ? null : candidate.shardId;
  const reasons = matches ? [] : await searchReasons(deps, issue, candidate.project);
  const stored = loadRuns(home);
  const waiting = waitingOn(deps, issue, stored).map((blocker) => ({
    key: blocker.key,
    status: blocker.status
  }));
  const held = await holds(deps, issue.key, target, matches && waiting.length === 0);
  const action = dryRunAction(candidate);
  const report: WhyReport = {
    key: issue.key,
    summary: issue.summary,
    matches,
    reasons,
    blocked: issue.labels.includes(config.jira.blockedLabel),
    shard,
    target,
    deliverable: target !== null,
    assignee: issue.assignee,
    waiting,
    holds: held,
    denied: lastDenied(stored, issue.key),
    action,
    picked:
      matches &&
      issue.assignee === null &&
      waiting.length === 0 &&
      held.length === 0 &&
      action.startsWith("would claim"),
    ...pauses(deps, issue.key, stored)
  };
  for (const line of whyLines(report, config.jira.blockedLabel, searchName(deps))) deps.io.out(line);
  return report;
}

export async function retry(deps: WorkerDeps, key: string): Promise<OnceResult> {
  const label = deps.config.jira.blockedLabel;
  if ((await deps.jira.issue(key)).labels.includes(label)) {
    await deps.jira.removeLabel(key, label);
    deps.io.out(`${key}\tremoved ${label}`);
  }
  return await once(deps, { issue: key });
}

/** How long Jira's search may take to see a label change; it lagged about 20 s on 2026-11-15. */
export const SEARCH_LAG_MS = 30_000;
const SEARCH_RETRY_MS = 5_000;

async function matchesSoon(deps: WorkerDeps, key: string, wait: (ms: number) => Promise<void>): Promise<boolean> {
  for (let waited = 0; ; waited += SEARCH_RETRY_MS) {
    if (await matchesJql(deps, key)) return true;
    if (waited >= SEARCH_LAG_MS) return false;
    if (waited === 0)
      deps.io.err(`${key}: waiting up to ${SEARCH_LAG_MS / 1000} s for Jira's search to see the labels`);
    await wait(SEARCH_RETRY_MS);
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function delegate(
  deps: WorkerDeps,
  key: string,
  shard: string | undefined,
  wait: (ms: number) => Promise<void> = pause
): Promise<DelegateResult> {
  const { config, jira, io } = deps;
  const issue = await jira.issue(key);
  const target = targetOf(requireProject(config, issue.key), shard ?? null, resolveAll().shards);
  if (target.shard === null) {
    throw new Error(shard === undefined ? `${target.problem}, pass --repo <shard>` : target.problem);
  }
  const marker = config.jira.repository;
  if (shard === undefined) {
    io.out(`${issue.key}\tneeds no repository marker, its project has one shard`);
  } else if ("labelPrefix" in marker) {
    const wanted = `${marker.labelPrefix}${shard}`;
    for (const label of issue.labels.filter((entry) => entry.startsWith(marker.labelPrefix) && entry !== wanted)) {
      await jira.removeLabel(issue.key, label);
    }
    await jira.addLabel(issue.key, wanted);
  } else {
    await jira.setField(issue.key, marker.field, shard);
  }
  await jira.addLabel(issue.key, config.jira.eligibleLabel);
  const matches = await matchesSoon(deps, issue.key, wait);
  const search = searchName(deps);
  const next = matches
    ? `matches ${search}`
    : `does not match ${search} after ${SEARCH_LAG_MS / 1000} s, \`globu-worker why ${issue.key}\` says why`;
  io.out(`${issue.key}\tdelegated to ${target.shard}, ${next}`);
  return { key: issue.key, shard: target.shard, matches };
}
