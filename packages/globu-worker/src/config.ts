import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadManifest, type Manifest, matchesAny } from "../../globu-core/src/index.js";
import { isMapping } from "../../knowledge-base/src/index.js";
import { RESOURCE_RE } from "./lock.js";

const DURATION_RE = /^(\d+)(s|m|h)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text: string): number {
  const match = DURATION_RE.exec(text);
  if (match === null) throw new Error(`invalid duration "${text}", use a number followed by s, m or h`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

const Duration = z.string().transform((value, ctx) => {
  try {
    return parseDuration(value);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
    return z.NEVER;
  }
});

export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(npm run *)",
  "Bash(npx vitest *)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(ls*)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(globu base stamp *)"
];

export const DENIED_TOOLS = [
  "Bash(git push*)",
  "Bash(git stash*)",
  "Bash(gh *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(globu base stamp *--verified*)"
];

const RepositorySchema = z.union([
  z.strictObject({ labelPrefix: z.string().min(1) }),
  z.strictObject({ field: z.string().min(1) })
]);

export const DEFAULT_PROJECT = "default";
const DEFAULT_ORDER = "created ASC";
const MOVING = 'see "Moving a version 1 worker.yaml" in the worker docs';

const Text = z.string().min(1);
const Resource = Text.regex(RESOURCE_RE, "a resource name is letters, digits, dots, dashes and underscores");
const Author = z.strictObject({ name: Text, email: Text });

const ClaudePart = z.strictObject({
  skill: Text.optional(),
  model: Text.optional(),
  pluginDir: Text.optional(),
  maxTurns: z.number().int().min(1).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  allowedTools: z.array(Text).optional()
});
const GitPart = z.strictObject({ branchPrefix: z.string().optional(), author: Author.optional() });
const GithubPart = z.strictObject({ draft: z.boolean().optional(), labels: z.array(Text).optional() });
const ShardPart = {
  claude: ClaudePart.optional(),
  timeout: Duration.optional(),
  git: GitPart.optional(),
  github: GithubPart.optional()
};
const SettingsPart = {
  ...ShardPart,
  statuses: z
    .strictObject({
      ready: Text.optional(),
      claimed: Text.optional(),
      released: Text.optional(),
      done: Text.optional()
    })
    .optional(),
  followUps: z
    .strictObject({ issueType: Text.optional(), linkType: Text.optional(), max: z.number().int().min(1).optional() })
    .optional(),
  exclusive: z.array(Resource).optional(),
  repairs: z.number().int().min(0).optional(),
  setup: z.record(z.string(), z.array(Text)).optional()
};
const DefaultsSchema = z.strictObject(SettingsPart);
const ProjectWorkerSchema = z.strictObject({
  ...SettingsPart,
  filter: Text.optional(),
  shards: z.record(z.string(), z.strictObject(ShardPart)).optional()
});
const ManifestProjectSchema = z.object({
  shards: z.array(z.string()),
  jira: Text.optional(),
  worker: ProjectWorkerSchema.prefault({})
});

const SettingsSchema = z.object({
  statuses: z.object({ ready: Text.optional(), claimed: Text, released: Text, done: Text.optional() }),
  followUps: z.object({ issueType: Text, linkType: Text.default("Relates"), max: z.number().default(10) }).optional(),
  exclusive: z.array(z.string()).default([]),
  claude: z
    .object({
      skill: Text.default("issue-deliver"),
      model: Text.optional(),
      pluginDir: Text.optional(),
      maxTurns: z.number().default(80),
      maxBudgetUsd: z.number().default(5),
      allowedTools: z.array(z.string()).default(DEFAULT_ALLOWED_TOOLS)
    })
    .prefault({}),
  timeout: z.number().default(45 * 60_000),
  repairs: z.number().default(2),
  git: z.object({ branchPrefix: z.string().default("agent/"), author: Author.optional() }).prefault({}),
  github: z.object({ draft: z.boolean().default(false), labels: z.array(z.string()).default([]) }).prefault({}),
  setup: z.record(z.string(), z.array(z.string())).default({}),
  filter: Text.optional()
});

export type Settings = z.infer<typeof SettingsSchema>;
export type FollowUpSettings = NonNullable<Settings["followUps"]>;
type Defaults = z.infer<typeof DefaultsSchema>;
type ProjectWorker = z.infer<typeof ProjectWorkerSchema>;

export type ServedProject = {
  name: string;
  jira: string | null;
  shards: string[];
  worker: ProjectWorker;
  legacy?: { deliverable: string[]; companion: string[] };
};

const JiraPart = {
  site: z.url(),
  priorityLabel: Text.optional(),
  eligibleLabel: Text.default("agent-eligible"),
  blockedLabel: Text.default("agent-blocked"),
  blockingLinks: z.array(Text).default(["Blocks"])
};
const PollSchema = z.strictObject({ every: Duration.default(60_000) }).prefault({});
const NotifySchema = z.strictObject({ command: Text.optional(), timeout: Duration.default(30_000) }).prefault({});
const ConfigDir = z.enum(["own", "user"]).default("own");
const MachineLimits = {
  concurrent: z.number().int().min(1).default(1),
  perShard: z.number().int().min(1).default(1),
  dayUsd: z.number().positive().default(40),
  openPullRequests: z.number().int().min(1).default(5),
  keepRuns: z.number().int().min(1).default(100),
  subscription: z.number().min(1).max(100).default(70)
};

const WorkerFileSchema = z.strictObject({
  version: z.literal(2),
  jira: z.strictObject({
    ...JiraPart,
    jql: Text.optional(),
    repository: RepositorySchema.default({ labelPrefix: "repo:" })
  }),
  projects: z.array(Text).min(1).optional(),
  order: Text.default(DEFAULT_ORDER),
  defaults: DefaultsSchema.prefault({}),
  poll: PollSchema,
  limits: z.strictObject(MachineLimits).prefault({}),
  claude: z.strictObject({ configDir: ConfigDir }).prefault({}),
  notify: NotifySchema,
  keepAwake: z.boolean().default(true)
});

const StatusSetting = z.union([
  Text,
  z.record(Text, Text).refine((map) => Object.keys(map).length > 0, "name at least one project or a default")
]);
type StatusSetting = z.infer<typeof StatusSetting>;

const LegacyFileSchema = z.object({
  jira: z.object({
    ...JiraPart,
    jql: Text,
    claimedStatus: StatusSetting,
    releasedStatus: StatusSetting,
    doneStatus: StatusSetting.optional(),
    repository: RepositorySchema,
    followUps: z
      .object({ issueType: StatusSetting, linkType: Text.optional(), max: z.number().int().min(1).optional() })
      .optional()
  }),
  shards: z.object({
    deliverable: z.array(Text).min(1),
    companion: z.array(Text).default([]),
    repos: z.record(z.string(), Text).default({})
  }),
  setup: z.record(z.string(), z.array(Text)).optional(),
  poll: PollSchema,
  limits: z
    .object({
      ...MachineLimits,
      timeout: Duration.optional(),
      repairs: z.number().int().min(0).optional(),
      exclusive: z.array(Resource).optional()
    })
    .prefault({}),
  claude: ClaudePart.extend({ configDir: ConfigDir }).prefault({}),
  git: GitPart.optional(),
  github: GithubPart.optional(),
  notify: NotifySchema,
  keepAwake: z.boolean().default(true)
});
type LegacyFile = z.infer<typeof LegacyFileSchema>;

export type WorkerConfig = {
  version: 1 | 2;
  jira: z.infer<typeof WorkerFileSchema>["jira"];
  order: string;
  projects: ServedProject[];
  defaults: Defaults;
  repos: Record<string, string>;
  poll: { every: number };
  limits: z.infer<typeof WorkerFileSchema>["limits"];
  claude: { configDir: "own" | "user" };
  notify: z.infer<typeof NotifySchema>;
  keepAwake: boolean;
  warnings: string[];
};

export function projectOf(key: string): string {
  return key.split("-")[0];
}

export function projectFor(config: WorkerConfig, key: string): ServedProject | null {
  const jira = projectOf(key);
  return (
    config.projects.find((project) => project.jira === jira) ??
    config.projects.find((project) => project.jira === null) ??
    null
  );
}

export function requireProject(config: WorkerConfig, key: string): ServedProject {
  const project = projectFor(config, key);
  if (project === null) throw new Error(`no project this worker serves has the Jira key ${projectOf(key)}`);
  return project;
}

function layered(base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    const current = merged[key];
    merged[key] = isMapping(value) && isMapping(current) ? { ...current, ...value } : value;
  }
  return merged;
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("\n");
}

export function settingsFor(config: WorkerConfig, project: ServedProject, shard?: string): Settings {
  const { shards, ...block } = project.worker;
  const merged = [block, shard === undefined ? undefined : shards?.[shard]].reduce(layered, { ...config.defaults });
  if (isMapping(merged.followUps) && merged.followUps.issueType === undefined) delete merged.followUps;
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`project "${project.name}" has incomplete worker settings:\n${issuesOf(parsed.error)}`);
  }
  return parsed.data;
}

export function defaultClaude(config: WorkerConfig): Settings["claude"] {
  return SettingsSchema.shape.claude.parse(config.defaults.claude ?? {});
}

export function workerConfigPath(home: string): string {
  return path.join(home, "worker.yaml");
}

function settingFor(setting: StatusSetting | undefined, project: string): string | undefined {
  if (setting === undefined || typeof setting === "string") return setting;
  return setting[project] ?? setting[DEFAULT_PROJECT];
}

function present<T extends Record<string, unknown>>(values: T): T {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as T;
}

function legacyConfig(file: LegacyFile, source: string): WorkerConfig {
  const { jira, shards, limits, claude } = file;
  const { claimedStatus, releasedStatus, doneStatus, followUps, ...site } = jira;
  const { timeout, repairs, exclusive, ...machine } = limits;
  const { configDir, ...flags } = claude;
  const maps = [claimedStatus, releasedStatus, doneStatus, followUps?.issueType];
  const named = maps.flatMap((setting) => (typeof setting === "object" ? Object.keys(setting) : []));
  const keys = [...new Set(named)].filter((key) => key !== DEFAULT_PROJECT);
  const ids = [...new Set([...shards.deliverable, ...shards.companion])];
  const legacy = { deliverable: shards.deliverable, companion: shards.companion };
  const projects = [...keys, DEFAULT_PROJECT].flatMap((name): ServedProject[] => {
    const claimed = settingFor(claimedStatus, name);
    const released = settingFor(releasedStatus, name);
    if (claimed === undefined || released === undefined) return [];
    const statuses = present({ claimed, released, done: settingFor(doneStatus, name) });
    const issueType = settingFor(followUps?.issueType, name);
    const worker = issueType === undefined ? { statuses } : { statuses, followUps: { issueType } };
    return [{ name, jira: name === DEFAULT_PROJECT ? null : name, shards: ids, worker, legacy }];
  });
  if (projects.length === 0) {
    throw new Error(`${source}: jira.claimedStatus and jira.releasedStatus name no project they both cover`);
  }
  const names = projects.map((project) => (project.jira === null ? "every other Jira project" : project.name));
  return {
    version: 1,
    jira: site,
    order: DEFAULT_ORDER,
    projects,
    defaults: present({
      claude: flags,
      timeout,
      repairs,
      exclusive,
      git: file.git,
      github: file.github,
      setup: file.setup,
      followUps: followUps === undefined ? undefined : present({ linkType: followUps.linkType, max: followUps.max })
    }),
    repos: shards.repos,
    poll: file.poll,
    limits: machine,
    claude: { configDir },
    notify: file.notify,
    keepAwake: file.keepAwake,
    warnings: [
      `${source} is a version 1 worker.yaml: its settings are read as the defaults of version 2 and its shards as one project for ${names.join(", ")}, with deliverable and companion kept as they were; ${MOVING}`
    ]
  };
}

function servedProjects(file: z.infer<typeof WorkerFileSchema>, manifest: Manifest, source: string): ServedProject[] {
  const known = manifest.projects ?? {};
  const parsed = (name: string) => {
    const result = ManifestProjectSchema.safeParse(known[name]);
    if (!result.success) {
      throw new Error(`project "${name}" in the manifest is not valid for the worker:\n${issuesOf(result.error)}`);
    }
    return result.data;
  };
  const names = file.projects ?? Object.keys(known).filter((name) => parsed(name).jira !== undefined);
  if (names.length === 0) {
    throw new Error(`${source} serves no project: give a project in manifest.yaml a \`jira\` key`);
  }
  const ids = manifest.shards.map((shard) => shard.id);
  const projects = names.map((name): ServedProject => {
    if (!Object.hasOwn(known, name)) {
      throw new Error(`${source} serves the project "${name}", which manifest.yaml does not define`);
    }
    const { jira, shards, worker } = parsed(name);
    if (jira === undefined) throw new Error(`project "${name}" in manifest.yaml has no \`jira\` key`);
    const matched = ids.filter((id) => matchesAny(shards, id));
    if (matched.length === 0) throw new Error(`project "${name}" in manifest.yaml matches no registered shard`);
    return { name, jira, shards: matched, worker };
  });
  const keys = projects.map((project) => project.jira);
  const twice = keys.find((key, index) => keys.indexOf(key) !== index);
  if (twice !== undefined) throw new Error(`${source} serves two projects with the Jira key ${twice}`);
  return projects;
}

export function loadWorkerConfig(file: string, manifest: () => Manifest = loadManifest): WorkerConfig {
  if (!fs.existsSync(file)) throw new Error(`no worker configuration at ${file}`);
  const raw: unknown = YAML.parse(fs.readFileSync(file, "utf8"));
  const version = isMapping(raw) ? (raw.version ?? 1) : 1;
  if (version !== 1 && version !== 2) {
    throw new Error(`${file} is not a valid worker configuration:\nversion: expected 1 or 2`);
  }
  const parsed = version === 2 ? WorkerFileSchema.safeParse(raw) : LegacyFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not a valid worker configuration:\n${issuesOf(parsed.error)}`);
  const config =
    version === 2
      ? fromFile(parsed.data as z.infer<typeof WorkerFileSchema>, manifest(), file)
      : legacyConfig(parsed.data as LegacyFile, file);
  for (const project of config.projects) {
    settingsFor(config, project);
    for (const shard of Object.keys(project.worker.shards ?? {})) settingsFor(config, project, shard);
  }
  return config;
}

function fromFile(file: z.infer<typeof WorkerFileSchema>, manifest: Manifest, source: string): WorkerConfig {
  const { version, projects: _projects, ...rest } = file;
  return { ...rest, version, projects: servedProjects(file, manifest, source), repos: {}, warnings: [] };
}

export type Secrets = { jiraEmail: string; jiraToken: string; githubToken: string | null };

export const SECRET_VARIABLES = [
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GLOBU_GIT_TOKEN",
  "GLOBU_GIT_USER"
];

export const SECRETS_FILE = "secrets.env";

export function parseSecretsFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) throw new Error(`${SECRETS_FILE} line ${index + 1} is not KEY=value`);
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "") values[match[1]] = value;
  }
  return values;
}

export type LoadedSecrets = { env: NodeJS.ProcessEnv; file: string | null; warnings: string[] };

export function withSecretsFile(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform
): LoadedSecrets {
  const file = path.join(home, SECRETS_FILE);
  if (!fs.existsSync(file)) return { env, file: null, warnings: [] };
  const values = parseSecretsFile(fs.readFileSync(file, "utf8"));
  const open = platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0;
  const warnings = open ? [`${file} is readable by others, run chmod 600 on it`] : [];
  return { env: { ...values, ...env }, file, warnings };
}

export const CLAUDE_SECRET_VARIABLES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [...SECRET_VARIABLES, ...CLAUDE_SECRET_VARIABLES].flatMap((name) => {
    const value = env[name];
    return value ? [value] : [];
  });
}

export function readSecrets(env: NodeJS.ProcessEnv): Secrets {
  const missing = ["JIRA_EMAIL", "JIRA_API_TOKEN"].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`set ${missing.join(" and ")} in the environment`);
  return {
    jiraEmail: env.JIRA_EMAIL as string,
    jiraToken: env.JIRA_API_TOKEN as string,
    githubToken: env.GH_TOKEN || env.GITHUB_TOKEN || null
  };
}

export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of SECRET_VARIABLES) delete copy[name];
  return copy;
}

export type ClaudeHome = "own" | "user";
export type Homes = { home: string; session: boolean; claudeHome: (setting: ClaudeHome) => string };

function ownHome(name: string, value: string, shared: string, hint = ""): string {
  const resolved = path.resolve(value);
  if (resolved === shared) {
    throw new Error(`${name} points at ${shared}, which belongs to interactive sessions${hint}`);
  }
  return resolved;
}

export function sessionHomes(env: NodeJS.ProcessEnv): Homes {
  const claudeConfigDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  return {
    home: path.resolve(env.GLOBU_HOME || path.join(os.homedir(), ".globu")),
    session: true,
    claudeHome: () => claudeConfigDir
  };
}

const USER_HINT = ", set claude.configDir to user in worker.yaml to run in it on purpose";

export function ownHomes(env: NodeJS.ProcessEnv): Homes {
  const globu = path.join(os.homedir(), ".globu");
  const home = ownHome("GLOBU_HOME", env.GLOBU_HOME || path.join(globu, "worker"), globu);
  const user = path.join(os.homedir(), ".claude");
  const given = env.CLAUDE_CONFIG_DIR;
  return {
    home,
    session: false,
    claudeHome: (setting) =>
      setting === "user"
        ? path.resolve(given || user)
        : ownHome("CLAUDE_CONFIG_DIR", given || path.join(home, "claude"), user, USER_HINT)
  };
}
