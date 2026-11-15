import { loadRuns, type StoredRun, spentOn } from "./runs.js";
import { currentUsage, holdReason, overLimit } from "./subscription.js";
import {
  checkShards,
  dryRunAction,
  followUps,
  markerShard,
  type OnceResult,
  OPEN_FOLLOW_UPS,
  once,
  prioritized,
  SEARCH_LIMIT,
  type WorkerDeps,
  waitingOn,
  workerHold
} from "./worker.js";

export type Hold = {
  limit: "dayUsd" | "subscription" | "exclusive" | "openPullRequests" | "concurrent" | "perShard";
  detail: string;
};
export type WhyReport = {
  key: string;
  summary: string;
  matches: boolean;
  blocked: boolean;
  shard: string | null;
  deliverable: boolean;
  assignee: string | null;
  waiting: { key: string; status: string }[];
  holds: Hold[];
  action: string;
  picked: boolean;
};
export type DelegateResult = { key: string; shard: string; matches: boolean };

type Ahead = { key: string; shard: string | null };

export async function matchesJql(deps: WorkerDeps, key: string): Promise<boolean> {
  const filter = deps.config.jira.jql.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
  const jql = filter === "" ? `key = ${key}` : `key = ${key} AND (${filter})`;
  return (await deps.jira.search(jql, 1)).length > 0;
}

async function ahead(deps: WorkerDeps, key: string, slots: number, stored: StoredRun[]): Promise<Ahead[]> {
  const { config, jira } = deps;
  const taken: Ahead[] = [];
  for (const other of prioritized(await jira.search(config.jira.jql, SEARCH_LIMIT), config.jira.priorityLabel)) {
    if (other === key || taken.length >= slots) break;
    const issue = await jira.issue(other);
    if (issue.assignee !== null || waitingOn(deps, issue, stored).length > 0) continue;
    const shard = markerShard(issue, config);
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
  const busy = workerHold(deps, "globu-worker why").busy();
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

function leftBecause(report: WhyReport, waiting: string): string {
  if (!report.matches) return "it does not match jira.jql";
  if (report.assignee !== null) return "it is assigned";
  if (waiting !== "") return `it waits on ${waiting}`;
  return report.holds.length > 0 ? report.holds[0].detail : report.action;
}

function whyLines(report: WhyReport, blockedLabel: string): string[] {
  const { key, shard } = report;
  const marker = shard === null ? "none" : report.deliverable ? shard : `${shard}, not a deliverable shard`;
  const waiting = report.waiting.map((blocker) => `${blocker.key} (${blocker.status})`).join(", ");
  return [
    `${key}\t${report.summary}`,
    `jql\t${report.matches ? "matches jira.jql" : "does not match jira.jql"}`,
    ...(report.blocked
      ? [`blocked\t${blockedLabel} is set, \`globu-worker retry ${key}\` removes it and runs it`]
      : []),
    `marker\t${marker}`,
    `assignee\t${report.assignee ?? "none"}`,
    `blockers\t${waiting === "" ? "none open" : `waiting on ${waiting}`}`,
    `limits\t${report.holds.length === 0 ? "none hold it" : report.holds.map((hold) => hold.detail).join("; ")}`,
    `outcome\t${report.action}`,
    `verdict\t${report.picked ? "the next cycle claims it" : `the next cycle leaves it: ${leftBecause(report, waiting)}`}`
  ];
}

export async function why(deps: WorkerDeps, key: string): Promise<WhyReport> {
  const { config, jira, home } = deps;
  checkShards(config, home);
  const issue = await jira.issue(key);
  const matches = await matchesJql(deps, issue.key);
  const shard = markerShard(issue, config);
  const waiting = waitingOn(deps, issue, loadRuns(home)).map((blocker) => ({
    key: blocker.key,
    status: blocker.status
  }));
  const held = await holds(deps, issue.key, shard, matches && waiting.length === 0);
  const action = dryRunAction(deps, { issue, shardId: shard });
  const report: WhyReport = {
    key: issue.key,
    summary: issue.summary,
    matches,
    blocked: issue.labels.includes(config.jira.blockedLabel),
    shard,
    deliverable: shard !== null && config.shards.deliverable.includes(shard),
    assignee: issue.assignee,
    waiting,
    holds: held,
    action,
    picked:
      matches &&
      issue.assignee === null &&
      waiting.length === 0 &&
      held.length === 0 &&
      action.startsWith("would claim")
  };
  for (const line of whyLines(report, config.jira.blockedLabel)) deps.io.out(line);
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
  shard: string,
  wait: (ms: number) => Promise<void> = pause
): Promise<DelegateResult> {
  const { config, jira, io } = deps;
  if (!config.shards.deliverable.includes(shard)) {
    throw new Error(
      `"${shard}" is not a deliverable shard, the worker delivers to ${config.shards.deliverable.join(", ")}`
    );
  }
  const issue = await jira.issue(key);
  const marker = config.jira.repository;
  if ("labelPrefix" in marker) {
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
  const next = matches
    ? "matches jira.jql"
    : `does not match jira.jql after ${SEARCH_LAG_MS / 1000} s, \`globu-worker why ${issue.key}\` says why`;
  io.out(`${issue.key}\tdelegated to ${shard}, ${next}`);
  return { key: issue.key, shard, matches };
}
