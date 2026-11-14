import fs from "node:fs";
import path from "node:path";

const WINDOWS_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";
const GIT_DEPTH = 3;

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] as string);
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const windows = platform === "win32";
  const dirs = pathValue(env)
    .split(windows ? ";" : ":")
    .filter((dir) => dir !== "");
  const extensions = windows ? (env.PATHEXT || WINDOWS_EXTENSIONS).toLowerCase().split(";") : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function besideGit(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const git = findOnPath("git", env, platform);
  if (git === null) return null;
  let dir = path.dirname(git);
  for (let level = 0; level < GIT_DEPTH; level++) {
    const candidate = path.join(dir, "bin", "sh.exe");
    if (isFile(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export function setupShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return "sh";
  return findOnPath("sh", env, platform) ?? besideGit(env, platform);
}

export const NO_SHELL =
  "could not find sh for the setup commands, install Git for Windows or add its bin directory to PATH";
