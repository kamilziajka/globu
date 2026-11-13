import { gitAuthArgs, resolveAll } from "../../globu-core/src/index.js";
import { scrubbedEnv } from "./config.js";
import { log } from "./logger.js";
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

type InitEvent = { type: string; subtype?: string; skills?: string[]; model?: string };
type ResultEvent = { type: string; is_error: boolean; result: string; total_cost_usd: number };

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
  const skills = init?.skills ?? [];
  if (!skills.some((skill) => skill === claude.skill || skill.endsWith(`:${claude.skill}`))) {
    throw new Error(`the ${claude.skill} skill is not loaded, install the globu plugin or set claude.pluginDir`);
  }
  const cost = end.total_cost_usd.toFixed(2);
  const model = (init as InitEvent).model as string;
  return {
    detail: `${model} answers in ${deps.claudeConfigDir} with the ${claude.skill} skill (${cost} USD)`,
    short: model
  };
}

function shardsProbe(deps: WorkerDeps): Found {
  checkShards(deps.config, deps.home);
  const ids = [...deps.config.shards.deliverable, ...deps.config.shards.companion].join(", ");
  return { detail: ids, short: ids };
}

export const CHECK_NAMES = ["shards", "jira", "github", "claude"];

export async function checkAccess(deps: WorkerDeps, onCheck: (check: Check) => void = () => {}): Promise<Check[]> {
  const probes: Record<string, () => Promise<Found> | Found> = {
    shards: () => shardsProbe(deps),
    jira: () => jiraProbe(deps),
    github: () => githubProbe(deps),
    claude: () => claudeProbe(deps)
  };
  return await Promise.all(
    CHECK_NAMES.map(async (name) => {
      const check = await attempt(name, probes[name]);
      onCheck(check);
      return check;
    })
  );
}
