import { spawn } from "node:child_process";
import fs from "node:fs";

export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stdoutFile?: string };
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.stdoutFile !== undefined) fs.appendFileSync(options.stdoutFile, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const finish = (code: number | null, error?: Error) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ code, stdout, stderr: error === undefined ? stderr : `${stderr}${error.message}`, timedOut });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });

export async function runOrThrow(run: Runner, command: string, args: string[], options?: RunOptions): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
  return result.stdout.trim();
}
