import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import os from "node:os";
import spawn from "cross-spawn";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { parseDuration } from "./config.js";
import { notStarted } from "./exec.js";
import { exclusiveHold, type Hold, lockDir, RESOURCE_RE, withLockPid } from "./lock.js";
import { findOnPath } from "./shell.js";

export const HELD_EXIT = 75;
export const NOT_STARTED_EXIT = 127;
export const POLL_MS = 1000;

const HOLDER_CHARS = 60;
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const FORWARDED = new Set<NodeJS.Signals>(["SIGTERM", "SIGHUP"]);

export type HoldDeps = {
  io: Io;
  env: NodeJS.ProcessEnv;
  signals: EventEmitter;
  now: () => Date;
  platform: NodeJS.Platform;
  pollMs: number;
};

export type HoldOptions = { wait?: string };

export function parseResources(text: string): string[] {
  const names = text.split(",");
  for (const name of names) {
    if (!RESOURCE_RE.test(name)) {
      throw new Error(`invalid resource "${name}", a resource name is letters, digits, dots, dashes and underscores`);
    }
  }
  return [...new Set(names)];
}

export function holderOf(argv: string[]): string {
  const line = argv.join(" ").replace(/\s+/g, " ").trim();
  const shown = line.length > HOLDER_CHARS ? `${line.slice(0, HOLDER_CHARS)}...` : line;
  return `globu-worker hold (${shown})`;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + os.constants.signals[signal as NodeJS.Signals];
}

export async function hold(deps: HoldDeps, resources: string, argv: string[], options: HoldOptions): Promise<number> {
  const names = parseResources(resources);
  const waitMs = options.wait === undefined ? null : parseDuration(options.wait);
  const [command, ...args] = argv;
  // On Windows cross-spawn hands an unknown command to cmd.exe, which prints its own "is not recognized" first.
  const bare = !/[\\/]/.test(command);
  if (deps.platform === "win32" && bare && findOnPath(command, deps.env, deps.platform) === null) {
    deps.io.err(`globu-worker: ${notStarted(command, { startError: "ENOENT" })}`);
    return NOT_STARTED_EXIT;
  }
  const dir = lockDir(deps.env);
  const holder = holderOf(argv);
  let stopped: NodeJS.Signals | null = null;
  let wake = () => {};
  let child: ChildProcess | null = null;
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      stopped = signal;
      wake();
      if (child !== null && FORWARDED.has(signal) && deps.platform !== "win32") child.kill(signal);
    };
    deps.signals.on(signal, handler);
    return { signal, handler };
  });
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  let taken: Hold | null = null;
  try {
    const deadline = deps.now().getTime() + (waitMs ?? 0);
    let announced: string | null = null;
    for (;;) {
      const attempt = exclusiveHold(names, dir, holder, deps.now, deps.env);
      const problem = attempt.take();
      if (problem === null) {
        taken = attempt;
        break;
      }
      const left = deadline - deps.now().getTime();
      if (waitMs === null || left <= 0) {
        const within = waitMs === null ? "" : ` within ${options.wait}`;
        deps.io.err(`globu-worker: could not take ${problem}${within}`);
        return HELD_EXIT;
      }
      if (problem !== announced) deps.io.err(`globu-worker: waiting on ${problem}`);
      announced = problem;
      await pause(Math.min(left, deps.pollMs));
      if (stopped !== null) {
        deps.io.err(`globu-worker: stopped by ${stopped} while waiting on ${problem}`);
        return exitCodeOf(null, stopped);
      }
    }
    const env = withLockPid(deps.env, process.pid);
    return await new Promise<number>((resolve) => {
      const started = spawn(command, args, { cwd: deps.io.cwd, env, stdio: "inherit" });
      child = started;
      started.on("error", (error: NodeJS.ErrnoException) => {
        deps.io.err(`globu-worker: ${notStarted(command, { startError: error.code as string })}`);
        resolve(NOT_STARTED_EXIT);
      });
      started.on("close", (code, signal) => resolve(exitCodeOf(code, signal)));
    });
  } finally {
    taken?.release();
    for (const { signal, handler } of handlers) deps.signals.off(signal, handler);
  }
}
