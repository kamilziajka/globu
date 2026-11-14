import fs from "node:fs";
import type { Readable } from "node:stream";
import spawn from "cross-spawn";

export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stdoutFile?: string };
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; startError?: string };
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs);
    (child.stdout as Readable).on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.stdoutFile !== undefined) fs.appendFileSync(options.stdoutFile, chunk);
    });
    (child.stderr as Readable).on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
      if (timer !== null) clearTimeout(timer);
      if (error === undefined) resolve({ code, stdout, stderr, timedOut });
      else resolve({ code, stdout, stderr: `${stderr}${error.message}`, timedOut, startError: error.code as string });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });

export function notStarted(command: string, result: { startError?: string }): string | null {
  if (result.startError === undefined) return null;
  const why = result.startError === "ENOENT" ? "not found on PATH" : result.startError;
  return `could not start ${command}: ${why}`;
}

export async function runOrThrow(run: Runner, command: string, args: string[], options?: RunOptions): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const reason = notStarted(command, result) ?? result.stderr.trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${reason || `exit code ${result.code}`}`);
  }
  return result.stdout.trim();
}
