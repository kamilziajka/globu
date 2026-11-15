import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const LOCK_PIDS = "GLOBU_LOCK_PIDS";

const LockSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  holder: z.string().optional(),
  since: z.string().optional()
});

export type Lock = z.infer<typeof LockSchema>;
export type Hold = { take(): string | null; busy(): string | null; release(): void };

export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.GLOBU_LOCK_DIR || path.join(os.homedir(), ".globu", "locks"));
}

export function lockFile(dir: string, name: string): string {
  return path.join(dir, `${name}.lock`);
}

export function withLockPid(env: NodeJS.ProcessEnv, pid: number): NodeJS.ProcessEnv {
  const before = env[LOCK_PIDS];
  return { ...env, [LOCK_PIDS]: before ? `${before},${pid}` : String(pid) };
}

function pidsAbove(env: NodeJS.ProcessEnv): string[] {
  return (env[LOCK_PIDS] ?? "").split(",").filter((pid) => pid !== String(process.pid));
}

function heldAbove(lock: Lock | null, above: string[]): boolean {
  return lock !== null && lock.host === os.hostname() && above.includes(String(lock.pid));
}

export function readLock(file: string): Lock | null {
  try {
    const parsed = LockSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isStale(lock: Lock | null): boolean {
  return lock !== null && lock.host === os.hostname() && !running(lock.pid);
}

function heldBy(name: string, file: string, lock: Lock | null): string {
  if (lock === null) return `${name} (${file} is there but holds no readable lock)`;
  const since = lock.since === undefined ? "" : ` since ${lock.since}`;
  return `${name} (held by ${lock.holder ?? "another process"}, pid ${lock.pid} on ${lock.host}${since})`;
}

function create(file: string, content: string): boolean {
  try {
    fs.writeFileSync(file, content, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function acquire(name: string, file: string, content: string): string | null {
  if (create(file, content)) return null;
  const lock = readLock(file);
  if (!isStale(lock)) return heldBy(name, file, lock);
  fs.rmSync(file, { force: true });
  return acquire(name, file, content);
}

export function exclusiveHold(
  names: string[],
  dir: string,
  holder: string,
  now: () => Date,
  env: NodeJS.ProcessEnv
): Hold {
  const above = pidsAbove(env);
  const taken: string[] = [];
  let answer: string | null | undefined;
  const release = () => {
    for (const name of taken.splice(0)) {
      const file = lockFile(dir, name);
      if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
    }
  };
  return {
    take() {
      if (answer !== undefined) return answer;
      answer = null;
      for (const name of names) {
        if (heldAbove(readLock(lockFile(dir, name)), above)) continue;
        fs.mkdirSync(dir, { recursive: true });
        const lock: Lock = { pid: process.pid, host: os.hostname(), holder, since: now().toISOString() };
        const problem = acquire(name, lockFile(dir, name), `${JSON.stringify(lock)}\n`);
        if (problem !== null) {
          release();
          answer = problem;
          break;
        }
        taken.push(name);
      }
      return answer;
    },
    busy() {
      for (const name of names) {
        const file = lockFile(dir, name);
        if (!fs.existsSync(file)) continue;
        const lock = readLock(file);
        if (!heldAbove(lock, above) && !isStale(lock)) return heldBy(name, file, lock);
      }
      return null;
    },
    release
  };
}
