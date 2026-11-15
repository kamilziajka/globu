import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { gitAuthArgs, resolveAll } from "../../globu-core/src/index.js";
import { VERSION } from "../../knowledge-base/src/index.js";
import {
  DEFAULT_PROJECT,
  type FollowUpSettings,
  projectOf,
  type StatusSetting,
  scrubbedEnv,
  settingFor,
  type WorkerConfig
} from "./config.js";
import { notStarted } from "./exec.js";
import { isStatusId, type JiraIssueType } from "./jira.js";
import { log } from "./logger.js";
import { isTerminal, loadRuns } from "./runs.js";
import { NO_SHELL, setupShell } from "./shell.js";
import { checkShards, type WorkerDeps } from "./worker.js";

export type Check = { name: string; ok: boolean; detail: string; short?: string };
type Found = { detail: string; short: string };

const CLAUDE_CHECK_TIMEOUT = 120_000;

export async function attempt(name: string, probe: () => Promise<string | Found> | string | Found): Promise<Check> {
  try {
    const found = await probe();
    const check = typeof found === "string" ? { name, ok: true, detail: found } : { name, ok: true, ...found };
    log().debug("check", check);
    return check;
  } catch (err) {
    const check = { name, ok: false, detail: (err as Error).message };
    log().warn("check", check);
    return check;
  }
}

export function checksLine(checks: Check[]): string {
  return checks.map((check) => `${check.ok ? "✔" : "✖"} ${check.name} ${check.short ?? ""}`.trimEnd()).join("   ");
}

export function formatCheck(check: Check): string {
  return `${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`;
}

async function jiraProbe(deps: WorkerDeps): Promise<Found> {
  const me = await deps.jira.myself();
  const found = await deps.jira.search(deps.config.jira.jql, 1);
  const matches = found.length === 0 ? "matches nothing now" : "matches issues";
  return { detail: `${deps.config.jira.site} as ${me.displayName}, the JQL ${matches}`, short: me.displayName };
}

async function githubProbe(deps: WorkerDeps): Promise<Found> {
  const token = deps.secrets.githubToken;
  if (token === null) throw new Error("set GH_TOKEN to push branches and open pull requests");
  const login = await deps.run("gh", ["api", "user", "--jq", ".login"], { env: { ...deps.env, GH_TOKEN: token } });
  if (login.code !== 0) throw new Error(`gh api user failed: ${login.stderr.trim()}`);
  const targets = resolveAll().shards.filter((shard) => deps.config.shards.deliverable.includes(shard.id));
  for (const shard of targets) {
    const repo = shard.source.repo;
    if (repo === null) throw new Error(`shard "${shard.id}" has no repository URL, the worker cannot push to it`);
    const remote = await deps.run("git", [...gitAuthArgs(repo, { token }), "ls-remote", "--heads", repo], {
      env: deps.env
    });
    if (remote.code !== 0) throw new Error(`cannot read ${repo} with GH_TOKEN: ${remote.stderr.trim()}`);
  }
  const name = login.stdout.trim();
  return { detail: `as ${name}, ${targets.length} deliverable repositories readable`, short: name };
}

type LoadedPlugin = { name: string; version?: string; source?: string };
type InitEvent = {
  type: string;
  subtype?: string;
  skills?: string[];
  model?: string;
  plugins?: LoadedPlugin[];
  mcp_servers?: { name: string }[];
};
type ResultEvent = { type: string; is_error: boolean; result: string; total_cost_usd: number };

const PLUGIN = "globu";

const ClaudeSettings = z.object({
  hooks: z.record(z.string(), z.unknown()).default({}),
  permissions: z.object({ allow: z.array(z.string()).default([]) }).prefault({})
});

function claudeSettings(dir: string): z.infer<typeof ClaudeSettings> {
  try {
    return ClaudeSettings.parse(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")));
  } catch {
    return ClaudeSettings.parse({});
  }
}

function outdatedPlugin(deps: WorkerDeps, plugin: LoadedPlugin): string {
  const { pluginDir } = deps.config.claude;
  const fix =
    pluginDir === undefined
      ? `update it with \`claude plugin marketplace update\` and \`claude plugin update ${plugin.source ?? plugin.name}\`, both with CLAUDE_CONFIG_DIR=${deps.claudeConfigDir}`
      : "point claude.pluginDir at the plugin of the worker's version";
  const where = pluginDir ?? deps.claudeConfigDir;
  return `the ${PLUGIN} plugin in ${where} is ${plugin.version} and the worker is ${VERSION}, ${fix}`;
}

function loadedWith(deps: WorkerDeps, init: InitEvent): string {
  const plugins = (init.plugins ?? []).map((plugin) => [plugin.name, plugin.version].filter(Boolean).join(" "));
  const servers = (init.mcp_servers ?? []).map((server) => server.name);
  const settings = claudeSettings(deps.claudeConfigDir);
  const hooks = Object.keys(settings.hooks);
  const { allow } = settings.permissions;
  const parts = [
    ...(plugins.length > 0 ? [`plugins ${plugins.join(", ")}`] : []),
    ...(servers.length > 0 ? [`MCP servers ${servers.join(", ")}`] : []),
    ...(hooks.length > 0 ? [`settings.json hooks on ${hooks.join(", ")}`] : []),
    ...(allow.length > 0
      ? [`${allow.length} settings.json allow rules on top of claude.allowedTools (${allow.join(", ")})`]
      : [])
  ];
  return parts.length === 0 ? "" : `, a run loads ${parts.join("; ")}`;
}

async function claudeProbe(deps: WorkerDeps): Promise<Found> {
  const { claude } = deps.config;
  const args = [
    "-p",
    "Reply with OK.",
    "--max-turns",
    "1",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(claude.model === undefined ? [] : ["--model", claude.model]),
    ...(claude.pluginDir === undefined ? [] : ["--plugin-dir", claude.pluginDir])
  ];
  const result = await deps.run("claude", args, {
    cwd: deps.home,
    env: { ...scrubbedEnv(deps.env), GLOBU_HOME: deps.home, CLAUDE_CONFIG_DIR: deps.claudeConfigDir },
    timeoutMs: CLAUDE_CHECK_TIMEOUT
  });
  const events = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as InitEvent & ResultEvent);
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const end = events.find((event) => event.type === "result");
  if (result.code !== 0 || end === undefined || end.is_error) {
    const reason = end === undefined ? result.stderr.trim() || `exit code ${result.code}` : end.result;
    throw new Error(`claude -p failed in ${deps.claudeConfigDir}: ${reason}`);
  }
  const skill = (init?.skills ?? []).find((name) => name === claude.skill || name.endsWith(`:${claude.skill}`));
  if (init === undefined || skill === undefined) {
    throw new Error(`the ${claude.skill} skill is not loaded, install the globu plugin or set claude.pluginDir`);
  }
  const plugin = (init.plugins ?? []).find((entry) => skill === `${entry.name}:${claude.skill}`);
  if (plugin?.name === PLUGIN && plugin.version !== undefined && plugin.version !== VERSION) {
    throw new Error(outdatedPlugin(deps, plugin));
  }
  const cost = end.total_cost_usd.toFixed(2);
  const model = init.model as string;
  const chosen = claude.model === undefined ? `${model} (the default, set claude.model to choose)` : model;
  return {
    detail: `${chosen} answers in ${deps.claudeConfigDir} with the ${claude.skill} skill (${cost} USD)${loadedWith(deps, init)}`,
    short: model
  };
}

function leftoverTrees(home: string): string[] {
  const trees = loadRuns(home)
    .filter(({ dir, record }) => isTerminal(record.state) && fs.existsSync(path.join(dir, "tree")))
    .map(({ dir }) => path.join(dir, "tree"));
  if (trees.length === 0) return [];
  const note = `settled runs left their worktree behind, delete ${trees.join(" and ")}`;
  log().warn("leftover trees", { trees });
  return [note];
}

function shardsProbe(deps: WorkerDeps): Found {
  checkShards(deps.config, deps.home);
  const ids = [...deps.config.shards.deliverable, ...deps.config.shards.companion].join(", ");
  return { detail: [ids, ...leftoverTrees(deps.home)].join(", "), short: ids };
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN_NAME_RE = /^[\w.+-]+$/;
const LONG_PATHS = "core.longpaths is off, deep node_modules paths can fail: git config --global core.longpaths true";

function setupPrograms(config: WorkerConfig): string[] {
  const words = Object.values(config.setup)
    .flat()
    .map(
      (command) =>
        command
          .trim()
          .split(/\s+/)
          .find((word) => !ASSIGNMENT_RE.test(word)) ?? ""
    )
    .filter((word) => PLAIN_NAME_RE.test(word));
  return [...new Set(words)];
}

async function longPathsNote(deps: WorkerDeps): Promise<string[]> {
  const result = await deps.run("git", ["config", "--get", "core.longpaths"], { env: deps.env });
  return result.stdout.trim() === "true" ? [] : [LONG_PATHS];
}

async function setupProbe(deps: WorkerDeps): Promise<Found> {
  const platform = deps.platform ?? process.platform;
  const notes = platform === "win32" ? await longPathsNote(deps) : [];
  const programs = setupPrograms(deps.config);
  if (programs.length === 0) return { detail: ["no setup commands", ...notes].join(", "), short: "none" };
  const shell = setupShell(deps.env, platform);
  if (shell === null) throw new Error(NO_SHELL);
  const missing: string[] = [];
  for (const program of programs) {
    const result = await deps.run(shell, ["-c", 'command -v "$1"', "sh", program], {
      cwd: deps.home,
      env: { ...scrubbedEnv(deps.env), GLOBU_HOME: deps.home }
    });
    const start = notStarted(shell, result);
    if (start !== null) throw new Error(start);
    if (result.code !== 0) missing.push(program);
  }
  if (missing.length > 0) throw new Error(`${shell} cannot find ${missing.join(", ")} for the setup commands`);
  return { detail: [`${shell} finds ${programs.join(", ")}`, ...notes].join(", "), short: programs.join(", ") };
}

const FOLLOW_UP_PERMISSIONS: Record<string, string> = { CREATE_ISSUES: "Create issues", LINK_ISSUES: "Link issues" };
const PROJECT_SAMPLE = 50;

async function followUpProjects(deps: WorkerDeps, setting: StatusSetting): Promise<string[]> {
  const named = typeof setting === "string" ? [] : Object.keys(setting).filter((key) => key !== DEFAULT_PROJECT);
  const hits = await deps.jira.search(deps.config.jira.jql, PROJECT_SAMPLE);
  return [...new Set([...named, ...hits.map((hit) => projectOf(hit.key))])].sort();
}

async function followUpProject(deps: WorkerDeps, setting: StatusSetting, project: string): Promise<JiraIssueType> {
  const wanted = settingFor(setting, project);
  if (wanted === undefined)
    throw new Error(`no jira.followUps.issueType for project ${project}, which the JQL matches`);
  const [types, granted] = await Promise.all([
    deps.jira.issueTypes(project),
    deps.jira.permissions(project, Object.keys(FOLLOW_UP_PERMISSIONS))
  ]);
  const type = types.find((candidate) => (isStatusId(wanted) ? candidate.id : candidate.name) === wanted);
  if (type === undefined) {
    const names = types.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ") || "none";
    throw new Error(`${project} has no issue type "${wanted}", available: ${names}`);
  }
  const missing = Object.keys(FOLLOW_UP_PERMISSIONS).filter((key) => !granted[key]);
  if (missing.length > 0) {
    const names = missing.map((key) => FOLLOW_UP_PERMISSIONS[key]).join(" and ");
    const noun = missing.length === 1 ? "permission" : "permissions";
    throw new Error(`the worker's Jira user lacks the ${names} ${noun} in ${project}`);
  }
  return type;
}

async function linkTypeProbe(deps: WorkerDeps, linkType: string): Promise<string> {
  const names = await deps.jira.linkTypes();
  if (!names.includes(linkType)) {
    throw new Error(`Jira has no link type "${linkType}", available: ${names.join(", ") || "none"}`);
  }
  return linkType;
}

async function followUpsProbe(deps: WorkerDeps, settings: FollowUpSettings): Promise<Found> {
  const projects = await followUpProjects(deps, settings.issueType);
  const [link, ...types] = await Promise.allSettled([
    linkTypeProbe(deps, settings.linkType),
    ...projects.map((project) => followUpProject(deps, settings.issueType, project))
  ]);
  const failed = [link, ...types].flatMap((result) =>
    result.status === "rejected" ? [(result.reason as Error).message] : []
  );
  if (failed.length > 0) throw new Error(failed.join("; "));
  const found = (types as PromiseFulfilledResult<JiraIssueType>[]).map((result) => result.value);
  const resolved = found.map((type, index) => `${type.name} (${type.id}) in ${projects[index]}`);
  const parts =
    projects.length === 0
      ? ["issue type and permissions not checked, the JQL matches no issue now and issueType names no project"]
      : [`issue type ${resolved.join(", ")}`, `Create issues and Link issues granted in ${projects.join(", ")}`];
  const names = [...new Set(found.map((type) => type.name))];
  return {
    detail: [...parts, `link type ${settings.linkType}`].join(", "),
    short: [...names, settings.linkType].join(", ")
  };
}

export const CHECK_NAMES = ["shards", "setup", "jira", "follow-ups", "github", "claude"];

export function checkNames(config: WorkerConfig): string[] {
  return config.jira.followUps === undefined ? CHECK_NAMES.filter((name) => name !== "follow-ups") : CHECK_NAMES;
}

export async function checkAccess(deps: WorkerDeps, onCheck: (check: Check) => void = () => {}): Promise<Check[]> {
  const probes: Record<string, () => Promise<Found> | Found> = {
    shards: () => shardsProbe(deps),
    setup: () => setupProbe(deps),
    jira: () => jiraProbe(deps),
    "follow-ups": () => followUpsProbe(deps, deps.config.jira.followUps as FollowUpSettings),
    github: () => githubProbe(deps),
    claude: () => claudeProbe(deps)
  };
  return await Promise.all(
    checkNames(deps.config).map(async (name) => {
      const check = await attempt(name, probes[name]);
      onCheck(check);
      return check;
    })
  );
}
