import type { EventEmitter } from "node:events";
import path from "node:path";
import { Command, CommanderError } from "commander";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { VERSION } from "../../knowledge-base/src/index.js";
import { bootstrapShards } from "./bootstrap.js";
import { attempt, CHECK_NAMES, type Check, checkAccess, formatCheck } from "./check.js";
import {
  type Homes,
  loadWorkerConfig,
  ownHomes,
  readSecrets,
  secretValues,
  sessionHomes,
  withSecretsFile,
  workerConfigPath
} from "./config.js";
import { diagnosticsName, writeDiagnostics } from "./diagnostics.js";
import { spawnRunner } from "./exec.js";
import { jiraClient } from "./jira.js";
import { fileLogger, loggedFetch, loggedRunner, parseLevel, setLogger } from "./logger.js";
import { parseMode, type ReadKey, start } from "./start.js";
import { checkLine, checkProgress, type Every, type Screen, widthOf } from "./tui.js";
import { claimIssue, finishRun, loop, once, releaseRun, type WorkerDeps } from "./worker.js";

export type Overrides = Partial<Pick<WorkerDeps, "jira" | "run" | "now">> & {
  signals: EventEmitter;
  screen?: Screen;
  readKey?: ReadKey;
  every?: Every;
};

const DESCRIPTION = "Claim agent-eligible Jira issues and run Claude Code in the right Globu shard.";
const FOOTER = `
once and run start Claude headless in a home of the worker's own: GLOBU_HOME defaults to ~/.globu/worker and
CLAUDE_CONFIG_DIR to <GLOBU_HOME>/claude, and neither may be ~/.globu or ~/.claude. worker.yaml lives in GLOBU_HOME.
poll, claim, finish and release serve a Claude Code session that does the implementing itself: they use the
session's own home, ~/.globu unless GLOBU_HOME says otherwise, and its worker.yaml and runs directory.
Secrets come from JIRA_EMAIL, JIRA_API_TOKEN and GH_TOKEN, in the environment or in <GLOBU_HOME>/secrets.env, where
the environment wins. The Claude run never sees them, only ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN when set.
The log is written to <GLOBU_HOME>/logs at the level of --log-level or GLOBU_LOG_LEVEL, info by default.`;

type Global = { logLevel?: string };

const GIT_VARIABLES = ["GLOBU_GIT_TOKEN", "GLOBU_GIT_USER"];

function buildDeps(io: Io, given: NodeJS.ProcessEnv, overrides: Overrides, homes: Homes, global: Global): WorkerDeps {
  process.env.GLOBU_HOME = homes.home;
  process.env.CLAUDE_CONFIG_DIR = homes.claudeConfigDir;
  const { env, warnings } = withSecretsFile(given, homes.home);
  for (const name of GIT_VARIABLES) {
    const value = env[name];
    if (value !== undefined) process.env[name] = value;
  }
  const now = overrides.now ?? (() => new Date());
  const level = parseLevel(global.logLevel ?? env.GLOBU_LOG_LEVEL ?? "info");
  const logger = fileLogger({ dir: path.join(homes.home, "logs"), level, secrets: secretValues(env), now });
  setLogger(logger);
  for (const warning of warnings) {
    logger.warn(warning);
    io.err(`globu-worker: ${warning}`);
  }
  const config = loadWorkerConfig(workerConfigPath(homes.home));
  const secrets = readSecrets(env);
  return {
    config,
    secrets,
    home: homes.home,
    claudeConfigDir: homes.claudeConfigDir,
    jira:
      overrides.jira ?? jiraClient(config.jira.site, secrets.jiraEmail, secrets.jiraToken, loggedFetch(fetch, logger)),
    run: loggedRunner(overrides.run ?? spawnRunner, logger),
    io,
    now,
    env
  };
}

const still: Every = () => () => {};

async function verify(io: Io, overrides: Overrides, deps: WorkerDeps, first: Check[]): Promise<Check[]> {
  const { screen } = overrides;
  if (screen === undefined) {
    const checks = [...first, ...(await checkAccess(deps))];
    for (const check of checks) io.out(formatCheck(check));
    return checks;
  }
  for (const check of first) screen.write(`${checkLine(check.name, check, 0, widthOf(screen))}\n`);
  const progress = checkProgress(screen, CHECK_NAMES, overrides.every ?? still);
  const checks = await checkAccess(deps, progress.update);
  progress.done();
  return [...first, ...checks];
}

const passed = (checks: Check[]) => checks.every((check) => check.ok);

export async function workerMain(
  argv: string[],
  io: Io,
  env: NodeJS.ProcessEnv,
  overrides: Overrides
): Promise<number> {
  const program = new Command("globu-worker")
    .description(DESCRIPTION)
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, "")),
      writeErr: (text) => io.err(text.replace(/\n$/, ""))
    })
    .option("--log-level <level>", "error, warn, info or debug")
    .addHelpText("after", FOOTER);
  let exitCode = 0;
  const untilStopped = async (deps: WorkerDeps) => {
    let stopped = false;
    let wake: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      io.out("stopping after the current cycle");
      wake?.();
    };
    overrides.signals.once("SIGINT", stop);
    overrides.signals.once("SIGTERM", stop);
    await loop(deps, {
      stopped: () => stopped,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, ms).unref();
        })
    });
  };
  const global = () => program.opts<Global>();
  const ownDeps = (): WorkerDeps => {
    const deps = buildDeps(io, env, overrides, ownHomes(env), global());
    for (const line of bootstrapShards(deps.config, deps.home)) io.out(line);
    return deps;
  };

  program
    .command("check")
    .description("check the configuration, the shards, Jira, GitHub and Claude, exit 1 when one fails")
    .action(async () => {
      let deps: WorkerDeps | null = null;
      const loaded = await attempt("configuration", () => {
        deps = ownDeps();
        return workerConfigPath(deps.home);
      });
      if (deps === null) {
        io.out(formatCheck(loaded));
        exitCode = 1;
      } else if (!passed(await verify(io, overrides, deps, [loaded]))) exitCode = 1;
    });

  program
    .command("once")
    .description("poll once, claim what fits in the free slots, run each to the end and exit")
    .option("--dry-run", "print what would be claimed and why, touching nothing")
    .option("--issue <key>", "take this issue instead of polling")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { dryRun?: boolean; issue?: string; json?: boolean }) => {
      const deps = ownDeps();
      const result = await once(deps, { dryRun: options.dryRun, issue: options.issue });
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("poll")
    .description("list what a session could claim now and why, touching nothing")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env), global());
      const result = await once(deps, { dryRun: true });
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("claim <key>")
    .description("claim an issue for this session: resolve its references, add the worktrees and write the brief")
    .option("--json", "print machine-readable JSON")
    .action(async (key: string, options: { json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env), global());
      const result = await claimIssue(deps, key);
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("finish <run-id>")
    .description("push a prepared run's commits, open the pull requests and hand back on the issue")
    .option("--json", "print machine-readable JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env), global());
      const record = await finishRun(deps, id);
      if (options.json) io.out(JSON.stringify(record, null, 2));
    });

  program
    .command("release <run-id>")
    .description("give a prepared run's issue back with a reason and remove its worktrees")
    .requiredOption("--reason <text>", "why the issue goes back")
    .option("--json", "print machine-readable JSON")
    .action(async (id: string, options: { reason: string; json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env), global());
      const record = await releaseRun(deps, id, options.reason);
      if (options.json) io.out(JSON.stringify(record, null, 2));
    });

  program
    .command("run")
    .description("poll and run on the configured interval until SIGINT or SIGTERM")
    .action(async () => {
      const deps = ownDeps();
      if (!passed(await verify(io, overrides, deps, []))) {
        exitCode = 1;
        return;
      }
      await untilStopped(deps);
    });

  program
    .command("diagnostics")
    .description("pack the logs, run records, worker.yaml and tool versions into a .tar.gz, secrets redacted")
    .option("--out <file>", "where to write the archive, a timestamped file in the current directory by default")
    .action(async (options: { out?: string }) => {
      const homes = ownHomes(env);
      const loaded = withSecretsFile(env, homes.home);
      const now = overrides.now ?? (() => new Date());
      const out = path.resolve(io.cwd, options.out ?? diagnosticsName(now()));
      const run = overrides.run ?? spawnRunner;
      const included = await writeDiagnostics(
        { home: homes.home, env: loaded.env, run, secrets: secretValues(loaded.env) },
        out
      );
      io.out(`wrote ${out} with ${included.length} files: ${included.join(", ")}`);
    });

  program
    .command("start")
    .description("check, then work through issues one at a time with a live list, picked by hand or automatically")
    .option("--mode <mode>", "pick or auto, pick by default on a terminal and auto otherwise")
    .action(async (options: { mode?: string }) => {
      const interactive = overrides.screen !== undefined && overrides.readKey !== undefined;
      const mode = parseMode(options.mode ?? (interactive ? "pick" : "auto"));
      if (mode === "pick" && !interactive) throw new Error("pick mode needs a terminal, use --mode auto");
      const deps = ownDeps();
      const checks = await verify(io, overrides, deps, []);
      if (!passed(checks)) {
        exitCode = 1;
        return;
      }
      await start(deps, { mode, screen: overrides.screen, readKey: overrides.readKey, checks, untilStopped });
    });

  const bare = argv.length === 0 && overrides.screen !== undefined && overrides.readKey !== undefined;
  try {
    await program.parseAsync(bare ? ["start"] : argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    io.err(`globu-worker: ${(err as Error).message}`);
    return 1;
  }
  return exitCode;
}
