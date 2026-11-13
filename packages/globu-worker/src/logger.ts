import fs from "node:fs";
import path from "node:path";
import type { Runner } from "./exec.js";
import type { Fetch } from "./jira.js";

export const LEVELS = ["error", "warn", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];
export type Fields = Record<string, unknown>;
export type Logger = Record<Level, (msg: string, fields?: Fields) => void>;
export type LoggerOptions = { dir: string; level: Level; secrets: string[]; now: () => Date };

const REDACTED = "[redacted]";
const MIN_SECRET = 4;
const TAIL_LINES = 5;

export function parseLevel(value: string): Level {
  if ((LEVELS as readonly string[]).includes(value)) return value as Level;
  throw new Error(`invalid log level "${value}", use ${LEVELS.join(", ")}`);
}

export function redact(text: string, secrets: string[]): string {
  let result = text.replace(/(extraheader=)[^"]*/g, `$1${REDACTED}`);
  for (const secret of secrets.filter((value) => value.length >= MIN_SECRET)) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      result = result.split(form).join(REDACTED);
    }
  }
  return result;
}

export function tail(text: string): string {
  return text.trim().split("\n").slice(-TAIL_LINES).join("\n");
}

export function logFile(dir: string, day: Date): string {
  return path.join(dir, `worker-${day.toISOString().slice(0, 10)}.log`);
}

export function fileLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS.indexOf(options.level);
  const writer =
    (level: Level) =>
    (msg: string, fields: Fields = {}) => {
      if (LEVELS.indexOf(level) > threshold) return;
      const now = options.now();
      const line = redact(JSON.stringify({ time: now.toISOString(), level, msg, ...fields }), options.secrets);
      fs.mkdirSync(options.dir, { recursive: true });
      fs.appendFileSync(logFile(options.dir, now), `${line}\n`);
    };
  return { error: writer("error"), warn: writer("warn"), info: writer("info"), debug: writer("debug") };
}

const ignore = () => {};
export const silentLogger: Logger = { error: ignore, warn: ignore, info: ignore, debug: ignore };

let current: Logger = silentLogger;

export function setLogger(logger: Logger): void {
  current = logger;
}

export function log(): Logger {
  return current;
}

export function loggedRunner(run: Runner, logger: Logger): Runner {
  return async (command, args, options = {}) => {
    const started = Date.now();
    const result = await run(command, args, options);
    logger.debug("command", {
      command,
      args,
      cwd: options.cwd,
      code: result.code,
      timedOut: result.timedOut,
      ms: Date.now() - started,
      stderr: tail(result.stderr)
    });
    return result;
  };
}

export function loggedFetch(fetchFn: Fetch, logger: Logger): Fetch {
  return async (url, init) => {
    const started = Date.now();
    const route = new URL(url);
    const fields = { method: init.method, path: `${route.pathname}${route.search}` };
    try {
      const response = await fetchFn(url, init);
      logger.debug("jira", { ...fields, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      logger.debug("jira", { ...fields, error: (err as Error).message, ms: Date.now() - started });
      throw err;
    }
  };
}
