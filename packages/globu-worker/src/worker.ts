import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { defaultRevision } from "../../globu-core/src/git.js";
import {
  gitAuthArgs,
  type RefResult,
  type ResolvedShard,
  resolveActive,
  resolveAll,
  resolveRefs,
  sameRepo
} from "../../globu-core/src/index.js";
import { type Blocker, renderBrief } from "./brief.js";
import { type ClaudeSummary, claudeArgs, implementPrompt, repairPrompt, summarizeStream } from "./claude.js";
import { projectOf, type Secrets, scrubbedEnv, statusFor, type WorkerConfig } from "./config.js";
import { notStarted, type Runner, runOrThrow } from "./exec.js";
import { fileFollowUps, followUpSection } from "./handback.js";
import { blockersOf, type JiraClient, type JiraHit, type JiraIssue, type JiraUser, matchesStatus } from "./jira.js";
import { launcherDir, WORKER_SCRIPT, withDirOnPath, writeLaunchers } from "./launcher.js";
import { exclusiveHold, type Hold, lockDir } from "./lock.js";
import { log, tail } from "./logger.js";
import { mergedIssues, recordMerged } from "./merged.js";
import { issueUrl, type NotifyEvent, notify } from "./notify.js";
import { type FollowUpState, followUpState, type PullRequest, readPullRequest, repoOf } from "./pulls.js";
import { extractRefs } from "./refs.js";
import {
  followingUp,
  isTerminal,
  loadRun,
  loadRuns,
  newRun,
  newRunId,
  pruneRuns,
  type RunRecord,
  removeLinks,
  removeTree,
  runsDir,
  type StoredRun,
  saveRun,
  spentOn
} from "./runs.js";
import { NO_SHELL, setupShell } from "./shell.js";
import { currentUsage, holdReason, overLimit, recordUsage } from "./subscription.js";

export type WorkerDeps = {
  config: WorkerConfig;
  secrets: Secrets;
  home: string;
  claudeConfigDir: string;
  jira: JiraClient;
  run: Runner;
  io: Io;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  onRun?: (record: RunRecord) => void;
  onPlan?: (plan: PlanEntry[]) => void;
  onFollowUps?: (rows: FollowUpRow[]) => void;
};
export type OnceOptions = { dryRun?: boolean; issue?: string; repair?: string };
export type FollowUpRow = {
  run: string;
  key: string;
  url: string;
  number: number;
  summary: string;
  state: FollowUpState;
  repairable: boolean;
};
export type PlanEntry = { key: string; summary: string; shard: string | null; action: string };
export type OnceResult = { runs: RunRecord[]; plan: PlanEntry[] };

export type PresentShard = ResolvedShard & { path: string };
type Registry = { all: ResolvedShard[]; active: ResolvedShard[]; context: string | null };
export type Worktree = { shard: PresentShard; tree: string; branch: string; base: string; pushed: boolean };
export type Candidate = { issue: JiraIssue; shardId: string | null };
type Prepared = {
  record: RunRecord;
  dir: string;
  worktrees: Worktree[];
  target: Worktree;
  briefFile: string;
  handbackFile: string;
};
type Outcome = { timedOut: boolean; code: number | null; stderr: string; startError?: string; summary: ClaudeSummary };
export type ClaimResult = {
  record: RunRecord;
  dir: string;
  brief: string | null;
  tree: string | null;
  handback: string | null;
  companions: { id: string; tree: string }[];
};

export const SEARCH_LIMIT = 50;
export const OPEN_FOLLOW_UPS = new Set<FollowUpState>(["in review", "conflict", "checks failing", "needs human"]);
const ORIGIN = "origin/";

function persist(deps: WorkerDeps, dir: string, record: RunRecord): void {
  saveRun(dir, record);
  deps.onRun?.(structuredClone(record));
}

export function git(args: string[], cwd: string): string {
  const started = Date.now();
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    log().debug("command", { command: "git", args, cwd, code: 0, ms: Date.now() - started });
    return stdout;
  } catch (err) {
    const failure = err as { status: number | null; stderr: string };
    log().debug("command", {
      command: "git",
      args,
      cwd,
      code: failure.status,
      ms: Date.now() - started,
      stderr: tail(`${failure.stderr}`)
    });
    throw err;
  }
}

export function registry(): Registry {
  const { shards: active, context } = resolveActive();
  return { all: resolveAll().shards, active, context };
}

function sameStatus(issue: JiraIssue, wanted: string): boolean {
  return matchesStatus({ id: issue.statusId, name: issue.status }, wanted);
}

function statusOf(config: WorkerConfig, name: "claimedStatus" | "releasedStatus", key: string): string {
  const status = statusFor(config.jira[name], key);
  if (status === undefined) throw new Error(`jira.${name} names no status for ${projectOf(key)} and has no default`);
  return status;
}

export function prioritized(hits: JiraHit[], label: string | undefined): string[] {
  const first = hits.filter((hit) => label !== undefined && hit.labels.includes(label));
  return [...first, ...hits.filter((hit) => !first.includes(hit))].map((hit) => hit.key);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const LINE_LIMIT = 160;

function oneLine(text: string): string {
  const first = text.split("\n")[0];
  return first.length < text.length || first.length > LINE_LIMIT ? `${first.slice(0, LINE_LIMIT)} …` : first;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

function refLine(result: RefResult): string {
  const candidates = result.candidates.map((candidate) => candidate.ref).join(", ");
  return `- ${result.ref}: ${result.reason}${candidates === "" ? "" : ` (perhaps ${candidates})`}`;
}

export function checkShards(config: WorkerConfig, home: string): void {
  const { shards } = resolveAll();
  const wanted = [...config.shards.deliverable, ...config.shards.companion];
  for (const id of wanted) {
    const shard = shards.find((candidate) => candidate.id === id);
    if (shard === undefined) throw new Error(`shard "${id}" is not registered in ${home}`);
    if (!shard.present || shard.owner !== "user") {
      throw new Error(`shard "${id}" needs an editable clone, run \`globu register <url> --path <dir>\` in ${home}`);
    }
    if (shard.mode === "read")
      throw new Error(`shard "${id}" is read-only on this machine, the worker cannot write to it`);
    if (config.shards.companion.includes(id) && shard.mode !== "write") {
      throw new Error(`companion shard "${id}" must be in write mode, run \`globu set ${id} --mode write\``);
    }
  }
}

export function markerShard(issue: JiraIssue, config: WorkerConfig): string | null {
  const marker = config.jira.repository;
  if ("labelPrefix" in marker) {
    const label = issue.labels.find((candidate) => candidate.startsWith(marker.labelPrefix));
    return label === undefined ? null : label.slice(marker.labelPrefix.length);
  }
  const value = issue.fields[marker.field];
  if (typeof value === "string") return value;
  const option = (value as { value?: unknown } | null)?.value;
  return typeof option === "string" ? option : null;
}

function issueText(issue: JiraIssue): string {
  return [issue.summary, issue.description, ...issue.comments.map((comment) => comment.body)].join("\n");
}

function resolveIssue(issue: JiraIssue, shard: PresentShard, reg: Registry) {
  const extracted = extractRefs(
    issueText(issue),
    reg.all.map((candidate) => ({ id: candidate.id, repo: candidate.source.repo }))
  );
  const report = resolveRefs(
    [...extracted.gating, ...extracted.informational],
    reg.all,
    reg.active,
    shard.path,
    reg.context
  );
  const gating = report.refs.filter((result) => extracted.gating.includes(result.ref));
  const informational = report.refs.filter((result) => !extracted.gating.includes(result.ref));
  return { gating, informational, failing: gating.filter((result) => !result.ok) };
}

function footer(record: RunRecord, now: Date): string {
  const github = record.identity.github === null ? "" : `, GitHub ${record.identity.github}`;
  const elapsed = minutes(now.getTime() - new Date(record.startedAt).getTime());
  if (record.driver === "session") {
    return `Run ${record.id} as ${record.identity.jira}${github} from a Claude Code session, ${elapsed}.`;
  }
  const denied = record.denied ?? [];
  const api = record.apiMs ? `, ${minutes(record.apiMs)} of it in the model API` : "";
  const lines = [
    `Run ${record.id} as ${record.identity.jira}${github}: ${record.turns} turns, ${record.costUsd.toFixed(2)} USD, ${elapsed}${api}. Blocked writes: ${record.blocked.length}. Denied tool calls: ${denied.length}.`,
    ...record.blocked.map((text) => `- ${text}`),
    ...denied.map((text) => `- denied ${oneLine(text)}`)
  ];
  return lines.join("\n");
}

async function tell(deps: WorkerDeps, record: RunRecord, event: NotifyEvent, url: string, message: string) {
  if (record.driver === "worker") await notify(deps, { event, key: record.key, url, message });
}

async function release(deps: WorkerDeps, record: RunRecord, reason: string): Promise<RunRecord> {
  const { jira, config, io } = deps;
  record.state = "released";
  record.reason = reason;
  record.endedAt = deps.now().toISOString();
  log().info("released", { run: record.id, key: record.key, reason, environment: record.environment === true });
  const machine = record.environment
    ? `\n\nThis is a problem with the worker's machine, not with the issue, so it is not labelled ${config.jira.blockedLabel} and the worker stops until the machine is fixed.`
    : "";
  try {
    await jira.transitionTo(record.key, statusOf(config, "releasedStatus", record.key));
    await jira.assign(record.key, null);
    if (!record.environment) await jira.addLabel(record.key, config.jira.blockedLabel);
    await jira.comment(
      record.key,
      `Released by the Globu worker: ${reason}${machine}\n\n${footer(record, deps.now())}`
    );
  } catch (err) {
    log().error("releasing failed", { run: record.id, key: record.key, error: (err as Error).message });
    io.err(`${record.key}: releasing failed: ${(err as Error).message}`);
  }
  if (!record.environment) {
    await tell(deps, record, "released", issueUrl(config, record.key), `${record.key} released: ${oneLine(reason)}`);
  }
  return record;
}

async function claim(deps: WorkerDeps, issue: JiraIssue, me: JiraUser): Promise<boolean> {
  const { jira, config } = deps;
  const claimed = statusOf(config, "claimedStatus", issue.key);
  statusOf(config, "releasedStatus", issue.key);
  await jira.assign(issue.key, me.accountId);
  if (!sameStatus(issue, claimed)) await jira.transitionTo(issue.key, claimed);
  const after = await jira.issue(issue.key);
  return after.assignee === me.accountId && sameStatus(after, claimed);
}

export function fetchShard(shard: PresentShard): boolean {
  const auth = gitAuthArgs(shard.source.repo);
  git([...auth, "fetch", "--quiet"], shard.path);
  return git([...auth, "ls-remote", "--heads", "origin"], shard.path) !== "";
}

export function addWorktree(shard: PresentShard, tree: string, branch: string): Worktree {
  const base = defaultRevision(shard.path);
  if (!base.startsWith(ORIGIN)) throw new Error(`${shard.path} has no origin/HEAD, clone it again`);
  git(["worktree", "add", "--quiet", tree, "-b", branch, base], shard.path);
  return { shard, tree, branch, base, pushed: false };
}

function storedWorktrees(worktrees: Worktree[]): RunRecord["worktrees"] {
  return worktrees.map(({ shard, tree, branch, base }) => ({ shard: shard.id, tree, branch, base }));
}

function restoreWorktrees(record: RunRecord): Worktree[] {
  const reg = registry();
  return record.worktrees.map((stored) => ({
    ...stored,
    shard: reg.all.find((entry) => entry.id === stored.shard) as PresentShard,
    pushed: false
  }));
}

function commitsOn(worktree: Worktree): number {
  return Number(git(["rev-list", "--count", `${worktree.base}..HEAD`], worktree.tree));
}

function attemptGit(args: string[], cwd: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

export function cleanup(worktrees: Worktree[]): void {
  for (const worktree of worktrees) {
    removeLinks(worktree.tree);
    const removed = attemptGit(["worktree", "remove", "--force", worktree.tree], worktree.shard.path);
    fs.rmSync(worktree.tree, { recursive: true, force: true });
    if (!removed) attemptGit(["worktree", "prune"], worktree.shard.path);
    if (!worktree.pushed) attemptGit(["branch", "-D", worktree.branch], worktree.shard.path);
  }
}

export function authorEnv(config: WorkerConfig): NodeJS.ProcessEnv {
  const { author } = config.git;
  if (author === undefined) return {};
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email
  };
}

export async function openPullRequest(
  deps: WorkerDeps,
  worktree: Worktree,
  title: string,
  bodyFile: string,
  token: string,
  draft = deps.config.github.draft
): Promise<string> {
  const { github } = deps.config;
  git(
    [...gitAuthArgs(worktree.shard.source.repo, { token }), "push", "--quiet", "-u", "origin", worktree.branch],
    worktree.tree
  );
  worktree.pushed = true;
  const args = [
    "pr",
    "create",
    "--head",
    worktree.branch,
    "--base",
    worktree.base.slice(ORIGIN.length),
    "--title",
    title,
    "--body-file",
    bodyFile,
    ...(draft ? ["--draft"] : []),
    ...github.labels.flatMap((label) => ["--label", label])
  ];
  const output = await runOrThrow(deps.run, "gh", args, { cwd: worktree.tree, env: { ...deps.env, GH_TOKEN: token } });
  return output.split("\n").at(-1) as string;
}

function environmentProblem(record: RunRecord, reason: string): string {
  record.environment = true;
  return reason;
}

export async function runSetup(deps: WorkerDeps, record: RunRecord, worktrees: Worktree[]): Promise<string | null> {
  const { config } = deps;
  const steps = worktrees.flatMap((worktree) =>
    (config.setup[worktree.shard.id] ?? []).map((command) => ({ worktree, command }))
  );
  if (steps.length === 0) return null;
  const shell = setupShell(deps.env, deps.platform ?? process.platform);
  if (shell === null) return environmentProblem(record, NO_SHELL);
  for (const { worktree, command } of steps) {
    log().info("setup", { run: record.id, shard: worktree.shard.id, command });
    const result = await deps.run(shell, ["-c", command], {
      cwd: worktree.tree,
      env: { ...scrubbedEnv(deps.env), ...authorEnv(config), GLOBU_HOME: deps.home },
      timeoutMs: config.limits.timeout
    });
    if (result.code === 0 && !result.timedOut) continue;
    const start = notStarted(shell, result);
    if (start !== null)
      return environmentProblem(record, `setup command "${command}" in ${worktree.shard.id}: ${start}`);
    const outcome = result.timedOut ? "timed out" : `exited with ${result.code}`;
    return `setup command "${command}" in ${worktree.shard.id} ${outcome}:\n${tail(`${result.stdout.trim()}\n${result.stderr.trim()}`)}`;
  }
  return null;
}

function blockers(deps: WorkerDeps, issue: JiraIssue, stored: StoredRun[]): Blocker[] {
  const found = blockersOf(issue, deps.config.jira.blockingLinks);
  if (found.length === 0) return [];
  const merged = mergedIssues(deps.home, stored);
  return found.map((blocker) => {
    const own = stored
      .map(({ record }) => record)
      .filter(
        (record) => record.key === blocker.key && record.repairOf === undefined && record.state === "handed-back"
      );
    const known = merged[blocker.key];
    const pullRequests = [
      ...new Set([...own.flatMap((record) => record.pullRequests), ...(known?.pullRequests ?? [])])
    ];
    return { ...blocker, pullRequests, resolved: blocker.done || known !== undefined };
  });
}

export function waitingOn(deps: WorkerDeps, issue: JiraIssue, stored: StoredRun[]): Blocker[] {
  return blockers(deps, issue, stored).filter((blocker) => !blocker.resolved);
}

async function prepare(
  deps: WorkerDeps,
  candidate: Candidate,
  record: RunRecord,
  dir: string,
  worktrees: Worktree[]
): Promise<Prepared | null> {
  const { config } = deps;
  const { issue, shardId } = candidate;
  persist(deps, dir, record);
  if (shardId === null || !config.shards.deliverable.includes(shardId)) {
    const accepted = config.shards.deliverable.join(", ");
    await release(deps, record, `no deliverable repository marker, the worker delivers to ${accepted}`);
    return null;
  }
  record.shard = shardId;
  record.state = "resolving";
  persist(deps, dir, record);
  const reg = registry();
  const shard = reg.all.find((entry) => entry.id === shardId) as PresentShard;
  const resolved = resolveIssue(issue, shard, reg);
  if (resolved.failing.length > 0) {
    const lines = resolved.failing.map(refLine).join("\n");
    await release(deps, record, `references that are not on the default branch:\n${lines}`);
    return null;
  }

  const companionShards = config.shards.companion.map((id) => reg.all.find((entry) => entry.id === id) as PresentShard);
  for (const entry of [shard, ...companionShards]) {
    if (!fetchShard(entry)) {
      await release(
        deps,
        record,
        `the repository of shard "${entry.id}" has no commits, push a first commit to its default branch`
      );
      return null;
    }
  }

  const branch = `${config.git.branchPrefix}${issue.key}-${slug(issue.summary)}`;
  record.branch = branch;
  const target = addWorktree(shard, path.join(dir, "tree"), branch);
  worktrees.push(target);
  const companions = companionShards.map((companion) => {
    const id = companion.id;
    const worktree = addWorktree(companion, path.join(dir, "companions", id), branch);
    worktrees.push(worktree);
    return { id, tree: worktree.tree };
  });
  record.worktrees = storedWorktrees(worktrees);
  persist(deps, dir, record);
  const failedSetup = await runSetup(deps, record, worktrees);
  if (failedSetup !== null) {
    await release(deps, record, failedSetup);
    return null;
  }

  const briefFile = path.join(dir, "brief.md");
  const handbackFile = path.join(dir, "handback.md");
  fs.writeFileSync(
    briefFile,
    renderBrief({
      issue,
      site: config.jira.site,
      shard: shardId,
      tree: target.tree,
      branch,
      companions,
      refs: resolved.gating,
      informational: resolved.informational,
      blockers: blockers(deps, issue, loadRuns(deps.home)),
      allowedTools: config.claude.allowedTools,
      handbackFile,
      followUps: config.jira.followUps !== undefined
    })
  );
  record.state = "prepared";
  persist(deps, dir, record);
  return { record, dir, worktrees, target, briefFile, handbackFile };
}

async function execute(deps: WorkerDeps, prepared: Prepared): Promise<Outcome> {
  const { record, dir, target, briefFile, handbackFile } = prepared;
  const prompt = implementPrompt(deps.config.claude.skill, briefFile, handbackFile);
  return await runClaude(deps, record, dir, target.tree, prompt);
}

async function runClaude(
  deps: WorkerDeps,
  record: RunRecord,
  dir: string,
  cwd: string,
  prompt: string
): Promise<Outcome> {
  const { config } = deps;
  const streamFile = path.join(dir, "claude.jsonl");
  fs.writeFileSync(streamFile, "");
  record.state = "running";
  persist(deps, dir, record);
  log().info("running", { run: record.id, key: record.key, tree: cwd });
  const platform = deps.platform ?? process.platform;
  const bin = launcherDir(deps.home);
  writeLaunchers(bin, process.execPath, WORKER_SCRIPT, platform);
  const env = {
    ...scrubbedEnv(deps.env),
    ...authorEnv(config),
    GLOBU_HOME: deps.home,
    CLAUDE_CONFIG_DIR: deps.claudeConfigDir
  };
  const result = await deps.run(
    "claude",
    claudeArgs({
      prompt,
      runDir: dir,
      maxTurns: config.claude.maxTurns,
      maxBudgetUsd: config.claude.maxBudgetUsd,
      allowedTools: config.claude.allowedTools,
      model: config.claude.model,
      pluginDir: config.claude.pluginDir
    }),
    {
      cwd,
      env: withDirOnPath(env, bin, platform),
      timeoutMs: config.limits.timeout,
      stdoutFile: streamFile
    }
  );
  const summary = summarizeStream(fs.readFileSync(streamFile, "utf8"));
  record.costUsd = summary.costUsd;
  record.turns = summary.turns;
  record.blocked = summary.blocked;
  record.denied = summary.denied;
  record.durationMs = summary.durationMs;
  record.apiMs = summary.apiMs;
  if (summary.usage.length > 0) recordUsage(deps.home, summary.usage, deps.now());
  return {
    timedOut: result.timedOut,
    code: result.code,
    stderr: result.stderr,
    startError: result.startError,
    summary
  };
}

async function conclude(deps: WorkerDeps, prepared: Prepared, outcome: Outcome | null): Promise<RunRecord> {
  const { config, jira } = deps;
  const { record, dir, worktrees, target, handbackFile } = prepared;
  const commits = commitsOn(target);
  const unstarted = outcome === null ? null : notStarted("claude", outcome);
  if (unstarted !== null) return await release(deps, record, environmentProblem(record, unstarted));
  if (outcome?.timedOut) return await release(deps, record, `timed out after ${minutes(config.limits.timeout)}`);
  if (outcome?.summary.subtype === "error_max_turns") {
    return await release(deps, record, `stopped at the turn cap of ${config.claude.maxTurns}`);
  }
  if (commits === 0) {
    const failed = outcome !== null && outcome.code !== 0;
    const detail = failed ? `, claude exited with ${outcome.code}: ${outcome.stderr.trim()}` : "";
    return await release(deps, record, `the run made no commits${detail}`);
  }

  record.state = "pushing";
  persist(deps, dir, record);
  const token = deps.secrets.githubToken;
  if (token === null) throw new Error("set GH_TOKEN to push branches and open pull requests");
  const handback = fs.existsSync(handbackFile)
    ? fs.readFileSync(handbackFile, "utf8").trim()
    : `The run wrote no handback. Its last message:\n\n${outcome?.summary.result ?? "(none)"}`;
  const issue = await jira.issue(record.key);
  const title = `${issue.key}: ${issue.summary}`;
  for (const worktree of worktrees) {
    if (commitsOn(worktree) === 0) continue;
    const bodyFile = path.join(dir, `pull-request-${worktree.shard.id}.md`);
    fs.writeFileSync(bodyFile, `${handback}\n\n---\n\n${footer(record, deps.now())}\n`);
    record.pullRequests.push(await openPullRequest(deps, worktree, title, bodyFile, token));
  }
  const filed = await fileFollowUps(jira, config, issue.key, record.id, handback);
  const keys = filed.flatMap((entry) => (entry.key === null ? [] : [entry.key]));
  if (keys.length > 0) record.followUpIssues = keys;
  const links = record.pullRequests.map((url) => `- ${url}`).join("\n");
  const section = followUpSection(filed);
  await jira.comment(
    issue.key,
    `${handback}\n\n---\n\n${section}Pull requests:\n${links}\n\n${footer(record, deps.now())}`
  );
  for (const url of record.pullRequests) await jira.remoteLink(issue.key, url, `Pull request for ${issue.key}`);
  record.state = "handed-back";
  record.endedAt = deps.now().toISOString();
  log().info("handed back", { run: record.id, key: record.key, pullRequests: record.pullRequests });
  const message = `${record.key} handed back: ${record.pullRequests.join(" ")}`;
  await tell(deps, record, "handed-back", record.pullRequests[0], message);
  return record;
}

function discard(dir: string, worktrees: Worktree[]): void {
  cleanup(worktrees);
  fs.rmSync(path.join(dir, "companions"), { recursive: true, force: true });
}

async function runOne(deps: WorkerDeps, candidate: Candidate, record: RunRecord, dir: string): Promise<RunRecord> {
  const worktrees: Worktree[] = [];
  try {
    const prepared = await prepare(deps, candidate, record, dir, worktrees);
    if (prepared === null) return record;
    const outcome = await execute(deps, prepared);
    return await conclude(deps, prepared, outcome);
  } catch (err) {
    return await release(deps, record, `worker error: ${(err as Error).message}`);
  } finally {
    discard(dir, worktrees);
    persist(deps, dir, record);
  }
}

function describe(record: RunRecord): string {
  const reason = record.reason === null ? "" : `: ${record.reason.split("\n")[0]}`;
  return `${record.key}\t${record.state}${reason}${record.pullRequests.map((url) => ` ${url}`).join("")}`;
}

export async function claimIssue(deps: WorkerDeps, key: string): Promise<ClaimResult> {
  const { config, jira, io, home } = deps;
  checkShards(config, home);
  const me = await jira.myself();
  const identity = { jira: `${me.displayName} (${me.accountId})`, github: await githubLogin(deps) };
  const issue = await jira.issue(key);
  if (!(await claim(deps, issue, me))) throw new Error(`${key} is claimed by someone else`);
  const record = newRun(key, deps.now(), identity, "session");
  const dir = path.join(runsDir(home), record.id);
  const worktrees: Worktree[] = [];
  let prepared: Prepared | null = null;
  try {
    prepared = await prepare(deps, { issue, shardId: markerShard(issue, config) }, record, dir, worktrees);
  } catch (err) {
    await release(deps, record, `worker error: ${(err as Error).message}`);
  } finally {
    if (prepared === null) discard(dir, worktrees);
    persist(deps, dir, record);
  }
  io.out(prepared === null ? describe(record) : `${key}\tprepared ${dir}`);
  const companions = prepared === null ? [] : prepared.worktrees.slice(1);
  return {
    record,
    dir,
    brief: prepared === null ? null : prepared.briefFile,
    tree: prepared === null ? null : prepared.target.tree,
    handback: prepared === null ? null : prepared.handbackFile,
    companions: companions.map((worktree) => ({ id: worktree.shard.id, tree: worktree.tree }))
  };
}

function preparedRun(deps: WorkerDeps, id: string): Prepared {
  const { dir, record } = loadRun(deps.home, id);
  if (record.state !== "prepared") throw new Error(`run ${id} is ${record.state}, only a prepared run can be finished`);
  const worktrees = restoreWorktrees(record);
  return {
    record,
    dir,
    worktrees,
    target: worktrees[0],
    briefFile: path.join(dir, "brief.md"),
    handbackFile: path.join(dir, "handback.md")
  };
}

export async function finishRun(deps: WorkerDeps, id: string): Promise<RunRecord> {
  const prepared = preparedRun(deps, id);
  const { record, dir, worktrees } = prepared;
  try {
    await conclude(deps, prepared, null);
  } catch (err) {
    await release(deps, record, `worker error: ${(err as Error).message}`);
  } finally {
    discard(dir, worktrees);
    persist(deps, dir, record);
  }
  deps.io.out(describe(record));
  return record;
}

export async function releaseRun(deps: WorkerDeps, id: string, reason: string): Promise<RunRecord> {
  const { dir, record } = loadRun(deps.home, id);
  if (isTerminal(record.state)) throw new Error(`run ${id} is already ${record.state}`);
  const worktrees = restoreWorktrees(record);
  await release(deps, record, reason);
  discard(dir, worktrees);
  persist(deps, dir, record);
  deps.io.out(describe(record));
  return record;
}

async function reconcile(deps: WorkerDeps, me: JiraUser): Promise<void> {
  const { config, jira } = deps;
  const stale = loadRuns(deps.home).filter(({ record }) => !isTerminal(record.state));
  if (stale.length === 0) return;
  for (const { dir, record } of stale) {
    removeTree(path.join(dir, "tree"));
    removeTree(path.join(dir, "companions"));
    const issue = await jira.issue(record.key);
    if (record.repairOf !== undefined) {
      record.state = "released";
      record.reason = "the worker restarted during this repair";
      record.endedAt = deps.now().toISOString();
    } else if (issue.assignee === me.accountId && sameStatus(issue, statusOf(config, "claimedStatus", record.key))) {
      await release(deps, record, "the worker restarted while this issue was claimed");
    } else {
      record.state = "released";
      record.reason = "the worker restarted and the issue was no longer claimed";
      record.endedAt = deps.now().toISOString();
    }
    persist(deps, dir, record);
  }
  const { shards } = resolveAll();
  for (const id of [...config.shards.deliverable, ...config.shards.companion]) {
    const shard = shards.find((candidate) => candidate.id === id) as PresentShard;
    git(["worktree", "prune"], shard.path);
  }
}

async function githubLogin(deps: WorkerDeps): Promise<string | null> {
  const token = deps.secrets.githubToken;
  if (token === null) return null;
  const result = await deps.run("gh", ["api", "user", "--jq", ".login"], { env: { ...deps.env, GH_TOKEN: token } });
  return result.code === 0 ? result.stdout.trim() : null;
}

function openRuns(home: string): StoredRun[] {
  return loadRuns(home).filter(({ record }) => followingUp(record));
}

function deleteBranch(record: RunRecord, pull: PullRequest, token: string): void {
  if (pull.state !== "MERGED" || pull.head !== record.branch) return;
  const branch = pull.head;
  try {
    const shard = registry().all.find((entry) => sameRepo(entry.source.repo, repoOf(pull.url))) as
      | PresentShard
      | undefined;
    if (shard === undefined) throw new Error(`no registered shard has the repository of ${pull.url}`);
    const auth = gitAuthArgs(shard.source.repo, { token });
    git([...auth, "fetch", "--quiet", "--prune"], shard.path);
    if (git(["branch", "--remotes", "--list", `origin/${branch}`], shard.path) !== "") {
      git([...auth, "push", "--quiet", "origin", "--delete", branch], shard.path);
    }
    if (git(["branch", "--list", branch], shard.path) !== "") git(["branch", "-D", branch], shard.path);
    log().info("branch deleted", { run: record.id, branch, pullRequest: pull.url });
  } catch (err) {
    log().warn("deleting the branch failed", {
      run: record.id,
      branch,
      pullRequest: pull.url,
      error: tail((err as Error).message)
    });
  }
}

async function settle(deps: WorkerDeps, stored: StoredRun, pulls: PullRequest[], token: string): Promise<void> {
  const { record, dir } = stored;
  const merged = pulls.some((pull) => pull.state === "MERGED");
  const urls = pulls.map((pull) => pull.url).join(" ");
  record.followUp = { repairs: record.followUp?.repairs ?? 0, state: merged ? "merged" : "closed" };
  const done = statusFor(deps.config.jira.doneStatus, record.key);
  if (merged && done !== undefined) await deps.jira.transitionTo(record.key, done);
  await deps.jira.comment(record.key, merged ? `Merged: ${urls}` : `Closed without merging: ${urls}`);
  log().info(merged ? "merged" : "closed", { run: record.id, key: record.key, pullRequests: record.pullRequests });
  for (const pull of pulls) deleteBranch(record, pull, token);
  if (merged) recordMerged(deps.home, loadRuns(deps.home), record.key, record.pullRequests, deps.now());
  persist(deps, dir, record);
}

export async function followUps(deps: WorkerDeps, apply: boolean): Promise<FollowUpRow[]> {
  const token = deps.secrets.githubToken;
  if (token === null) return [];
  const rows: FollowUpRow[] = [];
  for (const stored of openRuns(deps.home)) {
    const { record } = stored;
    const repairs = record.followUp?.repairs ?? 0;
    const needsHuman = record.followUp?.state === "needs-human";
    const pulls: PullRequest[] = [];
    for (const url of record.pullRequests) pulls.push(await readPullRequest(deps, url, token));
    for (const pull of pulls) {
      const state = followUpState(pull, needsHuman);
      const repairable = (state === "conflict" || state === "checks failing") && repairs < deps.config.limits.repairs;
      const summary = pull.title.replace(`${record.key}: `, "");
      rows.push({ run: record.id, key: record.key, url: pull.url, number: pull.number, summary, state, repairable });
    }
    if (apply && pulls.every((pull) => pull.state !== "OPEN")) await settle(deps, stored, pulls, token);
  }
  deps.onFollowUps?.(structuredClone(rows));
  return rows;
}

function authorArgs(config: WorkerConfig): string[] {
  const { author } = config.git;
  return author === undefined ? [] : ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
}

function conflictedFiles(tree: string): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"], tree)
    .split("\n")
    .filter((line) => line !== "");
}

function repairBrief(pull: PullRequest, original: string, conflicted: string[], handbackFile: string): string {
  const files = conflicted.length === 0 ? "none" : conflicted.map((file) => `- ${file}`).join("\n");
  const checks = pull.failing.length === 0 ? "none" : pull.failing.map((line) => `- ${line}`).join("\n");
  return [
    `# Repair ${pull.url}`,
    "",
    `The branch \`${pull.head}\` is checked out here with \`origin/${pull.base}\` merged into it, the merge left uncommitted when it conflicted.`,
    "Keep what the pull request set out to do and fit it to what changed on the base branch. Do not rebase, do not push.",
    "",
    "## Conflicted files",
    "",
    files,
    "",
    "## Failing checks",
    "",
    checks,
    "",
    "## The original run",
    "",
    `The brief and the handback of the run that opened this pull request are in \`${original}\` (\`brief.md\`, \`handback.md\`).`,
    "",
    `Write what you did to \`${handbackFile}\`.`,
    ""
  ].join("\n");
}

async function attemptRepair(
  deps: WorkerDeps,
  record: RunRecord,
  dir: string,
  shard: PresentShard,
  pull: PullRequest,
  original: string,
  worktrees: Worktree[],
  token: string
): Promise<string | null> {
  fetchShard(shard);
  const tree = path.join(dir, "tree");
  git(["worktree", "add", "--quiet", "-B", pull.head, tree, `${ORIGIN}${pull.head}`], shard.path);
  worktrees.push({ shard, tree, branch: pull.head, base: `${ORIGIN}${pull.head}`, pushed: true });
  record.worktrees = storedWorktrees(worktrees);
  persist(deps, dir, record);
  try {
    git([...authorArgs(deps.config), "merge", "--no-edit", `${ORIGIN}${pull.base}`], tree);
  } catch {}
  const conflicted = conflictedFiles(tree);
  if (conflicted.length > 0 || pull.checks === "failing") {
    const failedSetup = await runSetup(deps, record, worktrees);
    if (failedSetup !== null) return failedSetup;
    const briefFile = path.join(dir, "brief.md");
    const handbackFile = path.join(dir, "handback.md");
    fs.writeFileSync(briefFile, repairBrief(pull, original, conflicted, handbackFile));
    const outcome = await runClaude(deps, record, dir, tree, repairPrompt(briefFile, handbackFile));
    const unstarted = notStarted("claude", outcome);
    if (unstarted !== null) return environmentProblem(record, unstarted);
    if (outcome.timedOut) return `timed out after ${minutes(deps.config.limits.timeout)}`;
    if (conflictedFiles(tree).length > 0) return "conflicts are left unresolved";
    if (fs.existsSync(git(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"], tree))) {
      return "the merge was not committed";
    }
  }
  if (commitsOn(worktrees[0]) === 0) return "the repair made no commits";
  record.state = "pushing";
  persist(deps, dir, record);
  git([...gitAuthArgs(shard.source.repo, { token }), "push", "--quiet", "origin", pull.head], tree);
  return null;
}

async function noteRepair(deps: WorkerDeps, url: string, token: string, body: string, label?: string): Promise<void> {
  const env = { ...deps.env, GH_TOKEN: token };
  await runOrThrow(deps.run, "gh", ["pr", "comment", url, "--body", body], { env });
  if (label !== undefined) await deps.run("gh", ["pr", "edit", url, "--add-label", label], { env });
}

export async function repairPullRequest(
  deps: WorkerDeps,
  url: string,
  identity: RunRecord["identity"]
): Promise<RunRecord> {
  const token = deps.secrets.githubToken;
  if (token === null) throw new Error("set GH_TOKEN to repair pull requests");
  const original = openRuns(deps.home).find(({ record }) => record.pullRequests.includes(url));
  if (original === undefined) throw new Error(`no open run of the worker has ${url}`);
  const shard = registry().all.find((entry) => sameRepo(entry.source.repo, repoOf(url))) as PresentShard | undefined;
  if (shard === undefined) throw new Error(`no registered shard has the repository of ${url}`);
  const failures = original.record.followUp?.repairs ?? 0;
  const attempt = loadRuns(deps.home).filter((stored) => stored.record.repairOf === original.record.id).length + 1;
  const record = newRun(original.record.key, deps.now(), identity);
  record.id = newRunId(`${original.record.key}-repair-${attempt}`, deps.now());
  record.repairOf = original.record.id;
  record.shard = shard.id;
  record.pullRequests = [url];
  const dir = path.join(runsDir(deps.home), record.id);
  persist(deps, dir, record);
  log().info("repair", { run: record.id, key: record.key, pullRequest: url, attempt });
  const worktrees: Worktree[] = [];
  let problem: string | null;
  try {
    const pull = await readPullRequest(deps, url, token);
    record.branch = pull.head;
    problem = await attemptRepair(deps, record, dir, shard, pull, original.dir, worktrees, token);
  } catch (err) {
    problem = `worker error: ${(err as Error).message}`;
  } finally {
    discard(dir, worktrees);
  }
  record.endedAt = deps.now().toISOString();
  const run = footer(record, deps.now());
  if (problem === null) {
    record.state = "handed-back";
    log().info("repaired", { run: record.id, key: record.key, pullRequest: url });
    await noteRepair(deps, url, token, `Repaired by the Globu worker.\n\n${run}`);
    await deps.jira.comment(record.key, `Repaired ${url}.\n\n${run}`);
  } else {
    record.state = "released";
    record.reason = problem;
    const repairs = record.environment ? failures : failures + 1;
    const exhausted = repairs >= deps.config.limits.repairs;
    log().warn("repair failed", { run: record.id, key: record.key, pullRequest: url, reason: problem, exhausted });
    const next = exhausted ? "It needs a person now." : "The worker will try again.";
    const body = `The Globu worker could not repair this pull request: ${problem}. ${next}\n\n${run}`;
    original.record.followUp = { repairs, state: exhausted ? "needs-human" : "open" };
    persist(deps, original.dir, original.record);
    await noteRepair(deps, url, token, body, exhausted ? "needs-human" : undefined);
    await deps.jira.comment(record.key, body);
    if (exhausted) await tell(deps, record, "needs-human", url, `${record.key} needs a person: ${url}`);
  }
  persist(deps, dir, record);
  return record;
}

export function dryRunAction(deps: WorkerDeps, candidate: Candidate): string {
  const { config } = deps;
  const { issue, shardId } = candidate;
  if (shardId === null || !config.shards.deliverable.includes(shardId)) return "would release: no deliverable marker";
  const reg = registry();
  const shard = reg.all.find((entry) => entry.id === shardId) as PresentShard;
  const { failing, gating } = resolveIssue(issue, shard, reg);
  if (failing.length > 0) return `would release: ${failing.length} of ${gating.length} references missing`;
  return `would claim and run in ${shardId} (${gating.length} references resolved)`;
}

export function workerHold(deps: WorkerDeps, holder: string): Hold {
  return exclusiveHold(deps.config.limits.exclusive, lockDir(), holder, deps.now);
}

export async function once(deps: WorkerDeps, options: OnceOptions = {}): Promise<OnceResult> {
  const hold = workerHold(deps, "globu-worker");
  try {
    return await cycle(deps, options, hold);
  } finally {
    hold.release();
  }
}

async function cycle(deps: WorkerDeps, options: OnceOptions, hold: Hold): Promise<OnceResult> {
  const { config, jira, io, home } = deps;
  checkShards(config, home);
  const me = await jira.myself();
  const identity = { jira: `${me.displayName} (${me.accountId})`, github: null as string | null };
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    await reconcile(deps, me);
    const pruned = pruneRuns(home, config.limits.keepRuns, deps.now());
    if (pruned.length > 0) log().info("pruned", { runs: pruned, keep: config.limits.keepRuns });
    identity.github = await githubLogin(deps);
  }
  const spent = spentOn(loadRuns(home), deps.now());
  if (spent >= config.limits.dayUsd) {
    log().warn("day cap reached", { capUsd: config.limits.dayUsd, spentUsd: spent });
    io.out(`day cap of ${config.limits.dayUsd} USD reached (${spent.toFixed(2)} spent today), claiming nothing`);
    return { runs: [], plan: [] };
  }
  const limit = config.limits.subscription;
  const usage = overLimit(currentUsage(home, deps.env, deps.now()), limit);
  if (usage !== null) {
    log().warn("subscription limit reached", { ...usage, limit });
    io.out(`subscription limit reached: ${holdReason(usage, limit)}, claiming nothing`);
    return { runs: [], plan: [] };
  }
  if (options.repair !== undefined) {
    const held = hold.take();
    if (held !== null) {
      io.out(`repair waiting on ${held}`);
      return { runs: [], plan: [] };
    }
    const record = await repairPullRequest(deps, options.repair, identity);
    io.out(describe(record));
    return { runs: [record], plan: [] };
  }
  const repaired: RunRecord[] = [];
  if (!dryRun && options.issue === undefined) {
    const rows = await followUps(deps, true);
    for (const row of rows.filter((entry) => entry.repairable).slice(0, config.limits.concurrent)) {
      const held = hold.take();
      if (held !== null) {
        io.out(`repairs waiting on ${held}`);
        break;
      }
      const record = await repairPullRequest(deps, row.url, identity);
      io.out(describe(record));
      repaired.push(record);
    }
    const open = rows.filter((row) => OPEN_FOLLOW_UPS.has(row.state)).length;
    if (open >= config.limits.openPullRequests) {
      log().info("holding", { open, cap: config.limits.openPullRequests });
      io.out(`holding new issues: ${open} pull requests open, the cap is ${config.limits.openPullRequests}`);
      return { runs: repaired, plan: [] };
    }
  }
  const slots = config.limits.concurrent - repaired.length;
  const keys =
    options.issue === undefined
      ? prioritized(await jira.search(config.jira.jql, SEARCH_LIMIT), config.jira.priorityLabel)
      : [options.issue];
  log().info("cycle", { dryRun, eligible: keys });
  const picked: Candidate[] = [];
  const plan: PlanEntry[] = [];
  const stored = loadRuns(home);
  for (const key of keys) {
    if (picked.length >= slots) break;
    const issue = await jira.issue(key);
    const candidate = { issue, shardId: markerShard(issue, config) };
    const entry: PlanEntry = { key, summary: issue.summary, shard: candidate.shardId, action: "" };
    plan.push(entry);
    const waiting = waitingOn(deps, issue, stored);
    if (options.issue === undefined && issue.assignee !== null) {
      entry.action = "skipped, already assigned";
    } else if (options.issue === undefined && waiting.length > 0) {
      entry.action = `waiting on ${waiting.map((blocker) => `${blocker.key} (${blocker.status})`).join(", ")}`;
      log().info("waiting", { key, on: waiting.map((blocker) => blocker.key) });
    } else if (picked.filter((other) => other.shardId === candidate.shardId).length >= config.limits.perShard) {
      entry.action = `skipped, ${candidate.shardId} has a run already`;
    } else {
      const held = dryRun ? hold.busy() : hold.take();
      if (held !== null) {
        entry.action = `waiting on ${held}`;
        log().info("waiting", { key, on: held });
      } else if (dryRun) {
        entry.action = dryRunAction(deps, candidate);
      } else if (await claim(deps, issue, me)) {
        entry.action = "claimed";
        log().info("claimed", { key });
        picked.push(candidate);
      } else {
        entry.action = "skipped, claimed by someone else";
      }
    }
  }
  deps.onPlan?.(structuredClone(plan));
  if (plan.length === 0) io.out("nothing eligible");
  for (const entry of plan) io.out(`${entry.key}\t${entry.action}`);
  const runs = await Promise.all(
    picked.map((candidate) => {
      const record = newRun(candidate.issue.key, deps.now(), identity);
      return runOne(deps, candidate, record, path.join(runsDir(home), record.id));
    })
  );
  for (const record of runs) io.out(describe(record));
  return { runs: [...repaired, ...runs], plan };
}

export type LoopOptions = { sleep: (ms: number) => Promise<void>; stopped: () => boolean };

export async function loop(deps: WorkerDeps, options: LoopOptions): Promise<void> {
  for (;;) {
    try {
      const broken = (await once(deps)).runs.find((record) => record.environment);
      if (broken !== undefined) {
        log().error("stopping", { run: broken.id, reason: broken.reason });
        deps.io.err(`globu-worker: stopping, the machine needs fixing first: ${broken.reason}`);
        const message = `globu-worker stopped, the machine needs fixing first: ${oneLine(broken.reason as string)}`;
        await notify(deps, { event: "stopped", key: broken.key, url: issueUrl(deps.config, broken.key), message });
        return;
      }
    } catch (err) {
      log().error("cycle failed", { error: (err as Error).message });
      deps.io.err(`globu-worker: ${(err as Error).message}`);
    }
    if (options.stopped()) return;
    await options.sleep(deps.config.poll.every);
    if (options.stopped()) return;
  }
}
