import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { generatedActor, stampDocs, stampTime } from "../../knowledge-base/src/index.js";

export const LAUNCHER_COMMAND = "globu";
export const WORKER_SCRIPT = fileURLToPath(import.meta.url);

const USAGE = "usage: globu base stamp <files...>";
const ONLY_STAMP = `a worker run has only \`globu base stamp <files...>\` from Globu, ${USAGE}`;
const NO_VERIFIED = "`globu base stamp --verified` is not available in a worker run: a verification needs a person";

export function launcherDir(home: string): string {
  return path.join(home, "bin");
}

function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function shLauncher(node: string, script: string, platform: NodeJS.Platform): string {
  const forShell = (file: string) => (platform === "win32" ? file.replaceAll("\\", "/") : file);
  return `#!/bin/sh\nexec ${shQuote(forShell(node))} ${shQuote(forShell(script))} ${LAUNCHER_COMMAND} "$@"\n`;
}

export function cmdLauncher(node: string, script: string): string {
  return `@"${node}" "${script}" ${LAUNCHER_COMMAND} %*\r\n`;
}

function writeIfChanged(file: string, content: string): void {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== content) fs.writeFileSync(file, content, { mode: 0o755 });
}

export function writeLaunchers(dir: string, node: string, script: string, platform: NodeJS.Platform): void {
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(dir, LAUNCHER_COMMAND), shLauncher(node, script, platform));
  writeIfChanged(path.join(dir, `${LAUNCHER_COMMAND}.cmd`), cmdLauncher(node, script));
}

export function withDirOnPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key];
  const delimiter = platform === "win32" ? ";" : ":";
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
}

export function launcherMain(args: string[], io: Io): number {
  if (args[0] !== "base" || args[1] !== "stamp") {
    io.err(ONLY_STAMP);
    return 2;
  }
  const rest = args.slice(2);
  if (rest.includes("--verified")) {
    io.err(NO_VERIFIED);
    return 2;
  }
  const option = rest.find((arg) => arg.startsWith("-"));
  if (option !== undefined || rest.length === 0) {
    io.err(option === undefined ? USAGE : `unknown option ${option}, ${USAGE}`);
    return 2;
  }
  const at = stampTime();
  try {
    const stamped = stampDocs(
      rest.map((file) => path.resolve(io.cwd, file)),
      "generated",
      () => ({ by: generatedActor(), at })
    );
    io.out(
      stamped
        .map((result) => `${result.field}\t${path.relative(io.cwd, result.file)}\t${result.by}\t${result.at}`)
        .join("\n")
    );
    return 0;
  } catch (err) {
    io.err(`globu: ${(err as Error).message}`);
    return 1;
  }
}
