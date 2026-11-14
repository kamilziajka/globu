import { CLAUDE_SECRET_VARIABLES, scrubbedEnv, type WorkerConfig } from "./config.js";
import { notStarted, type Runner } from "./exec.js";
import { log, tail } from "./logger.js";
import { NO_SHELL, setupShell } from "./shell.js";

export type NotifyEvent = "handed-back" | "released" | "needs-human" | "stopped";
export type Notice = { event: NotifyEvent; key: string; url: string; message: string };
export type NotifyDeps = {
  config: WorkerConfig;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run: Runner;
  home: string;
};

export function issueUrl(config: WorkerConfig, key: string): string {
  return `${config.jira.site.replace(/\/+$/, "")}/browse/${key}`;
}

function notifyEnv(env: NodeJS.ProcessEnv, notice: Notice): NodeJS.ProcessEnv {
  const copy = scrubbedEnv(env);
  for (const name of CLAUDE_SECRET_VARIABLES) delete copy[name];
  return {
    ...copy,
    GLOBU_EVENT: notice.event,
    GLOBU_ISSUE: notice.key,
    GLOBU_URL: notice.url,
    GLOBU_MESSAGE: notice.message
  };
}

async function attempt(deps: NotifyDeps, command: string, notice: Notice): Promise<string | null> {
  const shell = setupShell(deps.env, deps.platform ?? process.platform);
  if (shell === null) return NO_SHELL;
  const result = await deps.run(shell, ["-c", command, "globu-worker", notice.event, notice.key, notice.url], {
    cwd: deps.home,
    env: notifyEnv(deps.env, notice),
    timeoutMs: deps.config.notify.timeout
  });
  if (result.timedOut) return "timed out";
  if (result.code === 0) return null;
  return notStarted(shell, result) ?? `exited with ${result.code}: ${tail(result.stderr.trim())}`;
}

export async function notify(deps: NotifyDeps, notice: Notice): Promise<void> {
  const { command } = deps.config.notify;
  if (command === undefined) return;
  const fields = { event: notice.event, key: notice.key, url: notice.url };
  let problem: string | null;
  try {
    problem = await attempt(deps, command, notice);
  } catch (err) {
    problem = (err as Error).message;
  }
  if (problem === null) log().info("notified", fields);
  else log().warn("notify failed", { ...fields, error: problem });
}
