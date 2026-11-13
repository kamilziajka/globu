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
  resolveRefs
} from "../../globu-core/src/index.js";
import { renderBrief } from "./brief.js";
import { type ClaudeSummary, claudeArgs, implementPrompt, summarizeStream } from "./claude.js";
import { type Secrets, scrubbedEnv, type WorkerConfig } from "./config.js";
import { type Runner, runOrThrow } from "./exec.js";
import { type JiraClient, type JiraIssue, type JiraUser, matchesStatus } from "./jira.js";
import { log, tail } from "./logger.js";
import { extractRefs } from "./refs.js";
import { isTerminal, loadRun, loadRuns, newRun, type RunRecord, runsDir, saveRun, spentOn } from "./runs.js";

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
  onRun?: (record: RunRecord) => void;
  onPlan?: (plan: PlanEntry[]) => void;
};
export type OnceOptions = { dryRun?: boolean; issue?: string };
export type PlanEntry = { key: string; summary: string; shard: string | null; action: string };
export type OnceResult = { runs: RunRecord[]; plan: PlanEntry[] };

type PresentShard = ResolvedShard & { path: string };
type Registry = { all: ResolvedShard[]; active: ResolvedShard[]; context: string | null };
type Worktree = { shard: PresentShard; tree: string; branch: string; base: string; pushed: boolean };
type Candidate = { issue: JiraIssue; shardId: string | null };
type Prepared = {
  record: RunRecord;
  dir: string;
  worktrees: Worktree[];
  target: Worktree;
  briefFile: string;
  handbackFile: string;
};
type Outcome = { timedOut: boolean; code: number | null; stderr: string; summary: ClaudeSummary };
export type ClaimResult = {
  record: RunRecord;
  dir: string;
  brief: string | null;
  tree: string | null;
  handback: string | null;
  companions: { id: string; tree: string }[];
};

const SEARCH_LIMIT = 50;
const ORIGIN = "origin/";

function persist(deps: WorkerDeps, dir: string, record: RunRecord): void {
  saveRun(dir, record);
  deps.onRun?.(structuredClone(record));
}

function git(args: string[], cwd: string): string {
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

function registry(): Registry {
  const { shards: active, context } = resolveActive();
  return { all: resolveAll().shards, active, context };
}

function sameStatus(issue: JiraIssue, wanted: string): boolean {
  return matchesStatus({ id: issue.statusId, name: issue.status }, wanted);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
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
  const lines = [
    `Run ${record.id} as ${record.identity.jira}${github}: ${record.turns} turns, ${record.costUsd.toFixed(2)} USD, ${elapsed}. Blocked writes: ${record.blocked.length}.`,
    ...record.blocked.map((text) => `- ${text}`)
  ];
  return lines.join("\n");
}

async function release(deps: WorkerDeps, record: RunRecord, reason: string): Promise<RunRecord> {
  const { jira, config, io } = deps;
  record.state = "released";
  record.reason = reason;
  record.endedAt = deps.now().toISOString();
  log().info("released", { run: record.id, key: record.key, reason });
  try {
    await jira.transitionTo(record.key, config.jira.releasedStatus);
    await jira.assign(record.key, null);
    await jira.addLabel(record.key, config.jira.blockedLabel);
    await jira.comment(record.key, `Released by the Globu worker: ${reason}\n\n${footer(record, deps.now())}`);
  } catch (err) {
    log().error("releasing failed", { run: record.id, key: record.key, error: (err as Error).message });
    io.err(`${record.key}: releasing failed: ${(err as Error).message}`);
  }
  return record;
}

async function claim(deps: WorkerDeps, issue: JiraIssue, me: JiraUser): Promise<boolean> {
  const { jira, config } = deps;
  await jira.assign(issue.key, me.accountId);
  if (!sameStatus(issue, config.jira.claimedStatus)) await jira.transitionTo(issue.key, config.jira.claimedStatus);
  const after = await jira.issue(issue.key);
  return after.assignee === me.accountId && sameStatus(after, config.jira.claimedStatus);
}

function fetchShard(shard: PresentShard): boolean {
  const auth = gitAuthArgs(shard.source.repo);
  git([...auth, "fetch", "--quiet"], shard.path);
  return git([...auth, "ls-remote", "--heads", "origin"], shard.path) !== "";
}

function addWorktree(shard: PresentShard, tree: string, branch: string): Worktree {
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

function cleanup(worktrees: Worktree[]): void {
  for (const worktree of worktrees) {
    try {
      git(["worktree", "remove", "--force", worktree.tree], worktree.shard.path);
    } catch {}
    if (!worktree.pushed) {
      try {
        git(["branch", "-D", worktree.branch], worktree.shard.path);
      } catch {}
    }
  }
}

function authorEnv(config: WorkerConfig): NodeJS.ProcessEnv {
  const { author } = config.git;
  if (author === undefined) return {};
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email
  };
}

async function openPullRequest(
  deps: WorkerDeps,
  worktree: Worktree,
  title: string,
  bodyFile: string,
  token: string
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
    ...(github.draft ? ["--draft"] : []),
    ...github.labels.flatMap((label) => ["--label", label])
  ];
  const output = await runOrThrow(deps.run, "gh", args, { cwd: worktree.tree, env: { ...deps.env, GH_TOKEN: token } });
  return output.split("\n").at(-1) as string;
}

async function runSetup(deps: WorkerDeps, record: RunRecord, worktrees: Worktree[]): Promise<string | null> {
  const { config } = deps;
  for (const worktree of worktrees) {
    for (const command of config.setup[worktree.shard.id] ?? []) {
      log().info("setup", { run: record.id, shard: worktree.shard.id, command });
      const result = await deps.run("sh", ["-c", command], {
        cwd: worktree.tree,
        env: { ...scrubbedEnv(deps.env), ...authorEnv(config), GLOBU_HOME: deps.home },
        timeoutMs: config.limits.timeout
      });
      if (result.code === 0 && !result.timedOut) continue;
      const outcome = result.timedOut ? "timed out" : `exited with ${result.code}`;
      return `setup command "${command}" in ${worktree.shard.id} ${outcome}:\n${tail(`${result.stdout.trim()}\n${result.stderr.trim()}`)}`;
    }
  }
  return null;
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
      handbackFile
    })
  );
  record.state = "prepared";
  persist(deps, dir, record);
  return { record, dir, worktrees, target, briefFile, handbackFile };
}

async function execute(deps: WorkerDeps, prepared: Prepared): Promise<Outcome> {
  const { config } = deps;
  const { record, dir, target, briefFile, handbackFile } = prepared;
  const streamFile = path.join(dir, "claude.jsonl");
  fs.writeFileSync(streamFile, "");
  record.state = "running";
  persist(deps, dir, record);
  log().info("running", { run: record.id, key: record.key, tree: target.tree });
  const result = await deps.run(
    "claude",
    claudeArgs({
      prompt: implementPrompt(config.claude.skill, briefFile, handbackFile),
      runDir: dir,
      maxTurns: config.claude.maxTurns,
      maxBudgetUsd: config.claude.maxBudgetUsd,
      allowedTools: config.claude.allowedTools,
      model: config.claude.model,
      pluginDir: config.claude.pluginDir
    }),
    {
      cwd: target.tree,
      env: {
        ...scrubbedEnv(deps.env),
        ...authorEnv(config),
        GLOBU_HOME: deps.home,
        CLAUDE_CONFIG_DIR: deps.claudeConfigDir
      },
      timeoutMs: config.limits.timeout,
      stdoutFile: streamFile
    }
  );
  const summary = summarizeStream(fs.readFileSync(streamFile, "utf8"));
  record.costUsd = summary.costUsd;
  record.turns = summary.turns;
  record.blocked = summary.blocked;
  return { timedOut: result.timedOut, code: result.code, stderr: result.stderr, summary };
}

async function conclude(deps: WorkerDeps, prepared: Prepared, outcome: Outcome | null): Promise<RunRecord> {
  const { config, jira } = deps;
  const { record, dir, worktrees, target, handbackFile } = prepared;
  const commits = commitsOn(target);
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
  const links = record.pullRequests.map((url) => `- ${url}`).join("\n");
  await jira.comment(issue.key, `${handback}\n\n---\n\nPull requests:\n${links}\n\n${footer(record, deps.now())}`);
  for (const url of record.pullRequests) await jira.remoteLink(issue.key, url, `Pull request for ${issue.key}`);
  record.state = "handed-back";
  record.endedAt = deps.now().toISOString();
  log().info("handed back", { run: record.id, key: record.key, pullRequests: record.pullRequests });
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
    fs.rmSync(path.join(dir, "tree"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, "companions"), { recursive: true, force: true });
    const issue = await jira.issue(record.key);
    if (issue.assignee === me.accountId && sameStatus(issue, config.jira.claimedStatus)) {
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

function dryRunAction(deps: WorkerDeps, candidate: Candidate): string {
  const { config } = deps;
  const { issue, shardId } = candidate;
  if (shardId === null || !config.shards.deliverable.includes(shardId)) return "would release: no deliverable marker";
  const reg = registry();
  const shard = reg.all.find((entry) => entry.id === shardId) as PresentShard;
  const { failing, gating } = resolveIssue(issue, shard, reg);
  if (failing.length > 0) return `would release: ${failing.length} of ${gating.length} references missing`;
  return `would claim and run in ${shardId} (${gating.length} references resolved)`;
}

export async function once(deps: WorkerDeps, options: OnceOptions = {}): Promise<OnceResult> {
  const { config, jira, io, home } = deps;
  checkShards(config, home);
  const me = await jira.myself();
  const identity = { jira: `${me.displayName} (${me.accountId})`, github: null as string | null };
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    await reconcile(deps, me);
    identity.github = await githubLogin(deps);
  }
  const spent = spentOn(loadRuns(home), deps.now());
  if (spent >= config.limits.dayUsd) {
    log().warn("day cap reached", { capUsd: config.limits.dayUsd, spentUsd: spent });
    io.out(`day cap of ${config.limits.dayUsd} USD reached (${spent.toFixed(2)} spent today), claiming nothing`);
    return { runs: [], plan: [] };
  }
  const keys = options.issue === undefined ? await jira.search(config.jira.jql, SEARCH_LIMIT) : [options.issue];
  log().info("cycle", { dryRun, eligible: keys });
  const picked: Candidate[] = [];
  const plan: PlanEntry[] = [];
  for (const key of keys) {
    if (picked.length >= config.limits.concurrent) break;
    const issue = await jira.issue(key);
    const candidate = { issue, shardId: markerShard(issue, config) };
    const entry: PlanEntry = { key, summary: issue.summary, shard: candidate.shardId, action: "" };
    plan.push(entry);
    if (options.issue === undefined && issue.assignee !== null) {
      entry.action = "skipped, already assigned";
    } else if (picked.filter((other) => other.shardId === candidate.shardId).length >= config.limits.perShard) {
      entry.action = `skipped, ${candidate.shardId} has a run already`;
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
  return { runs, plan };
}

export type LoopOptions = { sleep: (ms: number) => Promise<void>; stopped: () => boolean };

export async function loop(deps: WorkerDeps, options: LoopOptions): Promise<void> {
  for (;;) {
    try {
      await once(deps);
    } catch (err) {
      log().error("cycle failed", { error: (err as Error).message });
      deps.io.err(`globu-worker: ${(err as Error).message}`);
    }
    if (options.stopped()) return;
    await options.sleep(deps.config.poll.every);
    if (options.stopped()) return;
  }
}
