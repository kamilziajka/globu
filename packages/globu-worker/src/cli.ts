import type { EventEmitter } from "node:events";
import path from "node:path";
import { Command, CommanderError } from "commander";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { useGitHubToken } from "../../globu-core/src/index.js";
import { VERSION } from "../../knowledge-base/src/index.js";
import { bootstrapShards } from "./bootstrap.js";
import { attempt, type Check, checkAccess, checkNames, formatCheck } from "./check.js";
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
import { hold, POLL_MS } from "./hold.js";
import { jiraClient } from "./jira.js";
import { LAUNCHER_COMMAND, launcherMain } from "./launcher.js";
import { exclusiveHold, type Hold, withLockPid } from "./lock.js";
import { fileLogger, loggedFetch, loggedRunner, parseLevel, setLogger } from "./logger.js";
import { smokeNames, smokeTest } from "./smoke.js";
import { parseMode, type ReadKey, start } from "./start.js";
import { delegate, retry, why } from "./triage.js";
import { checkLine, checkProgress, type Every, type Screen, widthOf } from "./tui.js";
import { claimIssue, finishRun, loop, nextCycle, once, releaseRun, type WorkerDeps } from "./worker.js";

export type Overrides = Partial<Pick<WorkerDeps, "jira" | "run" | "now" | "platform">> & {
  signals: EventEmitter;
  screen?: Screen;
  readKey?: ReadKey;
  every?: Every;
  wait?: (ms: number) => Promise<void>;
};

const DESCRIPTION = "Claim agent-eligible Jira issues and run Claude Code in the right Globu shard.";
const FOOTER = `
once, run and retry start Claude headless in a home of the worker's own: GLOBU_HOME defaults to ~/.globu/worker and
CLAUDE_CONFIG_DIR to <GLOBU_HOME>/claude, and neither may be ~/.globu or ~/.claude. worker.yaml lives in GLOBU_HOME.
why and delegate read that home too, or the session's with --session.
poll, claim, finish and release serve a Claude Code session that does the implementing itself: they use the
session's own home, ~/.globu unless GLOBU_HOME says otherwise, and its worker.yaml and runs directory.
Secrets come from JIRA_EMAIL, JIRA_API_TOKEN and GH_TOKEN, in the environment or in <GLOBU_HOME>/secrets.env, where
the environment wins. The Claude run never sees them, only ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN when set.
The log is written to <GLOBU_HOME>/logs at the level of --log-level or GLOBU_LOG_LEVEL, info by default.
hold needs no home or worker.yaml: it takes the lock files in GLOBU_LOCK_DIR, ~/.globu/locks by default.`;

type Global = { logLevel?: string };

const GIT_VARIABLES = ["GLOBU_GIT_TOKEN", "GLOBU_GIT_USER"];
const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function buildDeps(io: Io, given: NodeJS.ProcessEnv, overrides: Overrides, homes: Homes, global: Global): WorkerDeps {
  process.env.GLOBU_HOME = homes.home;
  process.env.CLAUDE_CONFIG_DIR = homes.claudeConfigDir;
  const loaded = withSecretsFile(given, homes.home);
  const env: NodeJS.ProcessEnv = withLockPid({ ...loaded.env, ...NON_INTERACTIVE }, process.pid);
  Object.assign(process.env, NON_INTERACTIVE);
  for (const name of GIT_VARIABLES) {
    const value = env[name];
    if (value !== undefined) process.env[name] = value;
  }
  const now = overrides.now ?? (() => new Date());
  const level = parseLevel(global.logLevel ?? env.GLOBU_LOG_LEVEL ?? "info");
  const logger = fileLogger({ dir: path.join(homes.home, "logs"), level, secrets: secretValues(env), now });
  setLogger(logger);
  for (const warning of loaded.warnings) {
    logger.warn(warning);
    io.err(`globu-worker: ${warning}`);
  }
  const config = loadWorkerConfig(workerConfigPath(homes.home));
  const secrets = readSecrets(env);
  useGitHubToken(secrets.githubToken);
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

type Probe = (onCheck: (check: Check) => void) => Promise<Check[]>;

async function report(io: Io, overrides: Overrides, names: string[], probe: Probe): Promise<Check[]> {
  const { screen } = overrides;
  if (screen === undefined) {
    const checks = await probe(() => {});
    for (const check of checks) io.out(formatCheck(check));
    return checks;
  }
  const progress = checkProgress(screen, names, overrides.every ?? still);
  const checks = await probe(progress.update);
  progress.done();
  return checks;
}

async function verify(io: Io, overrides: Overrides, deps: WorkerDeps, first: Check[]): Promise<Check[]> {
  const { screen } = overrides;
  for (const check of first) {
    if (screen === undefined) io.out(formatCheck(check));
    else screen.write(`${checkLine(check.name, check, 0, widthOf(screen))}\n`);
  }
  return [...first, ...(await report(io, overrides, checkNames(deps.config), (onCheck) => checkAccess(deps, onCheck)))];
}

const passed = (checks: Check[]) => checks.every((check) => check.ok);

/** The exit code of run and start --mode auto after they stopped for a problem of the machine (EX_UNAVAILABLE). */
export const MACHINE_EXIT = 69;
const HOME_LOCK = "worker";

/** Takes <home>/worker.lock for a command that cycles, so two processes never cycle on one home. */
function ownHome(deps: WorkerDeps, command: string): Hold {
  const lock = exclusiveHold([HOME_LOCK], deps.home, `globu-worker ${command}`, deps.now, deps.env);
  const held = lock.take();
  if (held !== null) throw new Error(`another globu-worker cycles on ${deps.home}: ${held}`);
  return lock;
}

async function owning<T>(deps: WorkerDeps, command: string, work: () => Promise<T>): Promise<T> {
  const lock = ownHome(deps, command);
  try {
    return await work();
  } finally {
    lock.release();
  }
}

export async function workerMain(
  argv: string[],
  io: Io,
  env: NodeJS.ProcessEnv,
  overrides: Overrides
): Promise<number> {
  if (argv[0] === LAUNCHER_COMMAND) return launcherMain(argv.slice(1), io);
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
  const untilStopped = async (deps: WorkerDeps): Promise<boolean> => {
    let stopped = false;
    let wake: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      io.out("stopping after the current cycle");
      wake?.();
    };
    overrides.signals.once("SIGINT", stop);
    overrides.signals.once("SIGTERM", stop);
    return await loop(deps, {
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
    .option("--smoke", "then set up, commit, push and open and close a draft pull request in each deliverable shard")
    .action(async (options: { smoke?: boolean }) => {
      let deps: WorkerDeps | null = null;
      const loaded = await attempt("configuration", () => {
        deps = ownDeps();
        return workerConfigPath(deps.home);
      });
      if (deps === null) {
        io.out(formatCheck(loaded));
        exitCode = 1;
        return;
      }
      const ready = deps as WorkerDeps;
      if (!passed(await verify(io, overrides, ready, [loaded]))) {
        exitCode = 1;
        if (options.smoke) io.out("smoke test skipped, fix the failing checks first");
        return;
      }
      if (!options.smoke) return;
      const smoke = await report(io, overrides, smokeNames(ready), (onCheck) => smokeTest(ready, onCheck));
      if (!passed(smoke)) exitCode = 1;
    });

  program
    .command("once")
    .description("poll once, claim what fits in the free slots, run each to the end and exit")
    .option("--dry-run", "print what would be claimed and why, touching nothing")
    .option("--issue <key>", "take this issue instead of polling")
    .option("--repair <url>", "repair this pull request of the worker instead of polling")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { dryRun?: boolean; issue?: string; repair?: string; json?: boolean }) => {
      const deps = ownDeps();
      const cycle = () => once(deps, { dryRun: options.dryRun, issue: options.issue, repair: options.repair });
      const result = options.dryRun ? await cycle() : await owning(deps, "once", cycle);
      if (options.dryRun && options.issue === undefined && result.plan.length > 0) {
        io.out(nextCycle(deps.config, result.plan));
      }
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("retry <key>")
    .description("remove the blocked label from an issue and take it as once --issue does")
    .option("--json", "print machine-readable JSON")
    .action(async (key: string, options: { json?: boolean }) => {
      const deps = ownDeps();
      const result = await owning(deps, "retry", () => retry(deps, key));
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  const homesOf = (session?: boolean) => (session ? sessionHomes(env) : ownHomes(env));

  program
    .command("why <key>")
    .description("say why the next cycle would or would not claim an issue, touching nothing")
    .option("--session", "use the session's home instead of the worker's")
    .option("--json", "print machine-readable JSON")
    .action(async (key: string, options: { session?: boolean; json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, homesOf(options.session), global());
      const report = await why(deps, key);
      if (options.json) io.out(JSON.stringify(report, null, 2));
    });

  program
    .command("delegate <key>")
    .description("mark an issue for the worker: add the eligibility label and the repository marker")
    .requiredOption("--repo <shard>", "the deliverable shard the issue lands in")
    .option("--session", "use the session's home instead of the worker's")
    .option("--json", "print machine-readable JSON")
    .action(async (key: string, options: { repo: string; session?: boolean; json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, homesOf(options.session), global());
      const result = await delegate(deps, key, options.repo);
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
      await owning(deps, "run", async () => {
        if (!passed(await verify(io, overrides, deps, []))) {
          exitCode = 1;
          return;
        }
        if (await untilStopped(deps)) exitCode = MACHINE_EXIT;
      });
    });

  program
    .command("hold")
    .description("take the lock files of exclusive resources, run a command and give them back when it ends")
    .argument("<resources>", "resource names separated by commas, such as gpu or gpu,disk")
    .argument("<command...>", "the command and its arguments, after --")
    .option("--wait <duration>", "wait up to this long, such as 30s, 5m or 1h, while another process holds one")
    .action(async (resources: string, command: string[], options: { wait?: string }) => {
      const now = overrides.now ?? (() => new Date());
      const platform = overrides.platform ?? process.platform;
      const deps = { io, env, signals: overrides.signals, now, platform, pollMs: POLL_MS };
      exitCode = await hold(deps, resources, command, options);
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
      await owning(deps, `start --mode ${mode}`, async () => {
        const checks = await verify(io, overrides, deps, []);
        if (!passed(checks)) {
          exitCode = 1;
          return;
        }
        const options = { mode, screen: overrides.screen, readKey: overrides.readKey, checks, wait: overrides.wait };
        if (await start(deps, { ...options, untilStopped })) exitCode = MACHINE_EXIT;
      });
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
