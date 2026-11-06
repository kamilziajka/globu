import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

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
  "Bash(git add *)",
  "Bash(git commit *)"
];

export const DENIED_TOOLS = ["Bash(git push*)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)"];

const RepositorySchema = z.union([
  z.object({ labelPrefix: z.string().min(1) }),
  z.object({ field: z.string().min(1) })
]);

const WorkerConfigSchema = z.object({
  version: z.number().default(1),
  jira: z.object({
    site: z.url(),
    jql: z.string().min(1),
    claimedStatus: z.string().min(1),
    releasedStatus: z.string().min(1),
    blockedLabel: z.string().min(1).default("agent-blocked"),
    repository: RepositorySchema
  }),
  shards: z.object({
    deliverable: z.array(z.string().min(1)).min(1),
    companion: z.array(z.string().min(1)).default([])
  }),
  poll: z.object({ every: Duration.default(60_000) }).prefault({}),
  limits: z
    .object({
      concurrent: z.number().int().min(1).default(1),
      perShard: z.number().int().min(1).default(1),
      timeout: Duration.default(45 * 60_000),
      dayUsd: z.number().positive().default(40)
    })
    .prefault({}),
  claude: z
    .object({
      skill: z.string().min(1).default("issue-deliver"),
      model: z.string().min(1).optional(),
      pluginDir: z.string().min(1).optional(),
      maxTurns: z.number().int().min(1).default(80),
      maxBudgetUsd: z.number().positive().default(5),
      allowedTools: z.array(z.string().min(1)).default(DEFAULT_ALLOWED_TOOLS)
    })
    .prefault({}),
  git: z
    .object({
      branchPrefix: z.string().default("agent/"),
      author: z.object({ name: z.string().min(1), email: z.string().min(1) }).optional()
    })
    .prefault({}),
  github: z.object({ draft: z.boolean().default(true), labels: z.array(z.string().min(1)).default([]) }).prefault({})
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function workerConfigPath(home: string): string {
  return path.join(home, "worker.yaml");
}

export function loadWorkerConfig(file: string): WorkerConfig {
  if (!fs.existsSync(file)) throw new Error(`no worker configuration at ${file}`);
  const parsed = WorkerConfigSchema.safeParse(YAML.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
    throw new Error(`${file} is not a valid worker configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
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

export type Homes = { home: string; claudeConfigDir: string };

function ownHome(name: string, value: string, shared: string): string {
  const resolved = path.resolve(value);
  if (resolved === shared) throw new Error(`${name} points at ${shared}, which belongs to interactive sessions`);
  return resolved;
}

export function ownHomes(env: NodeJS.ProcessEnv): Homes {
  const globu = path.join(os.homedir(), ".globu");
  const home = ownHome("GLOBU_HOME", env.GLOBU_HOME || path.join(globu, "worker"), globu);
  const claude = path.join(os.homedir(), ".claude");
  const claudeConfigDir = ownHome("CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR || path.join(home, "claude"), claude);
  return { home, claudeConfigDir };
}
