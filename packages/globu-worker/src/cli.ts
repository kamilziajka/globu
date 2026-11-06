import type { EventEmitter } from "node:events";
import { Command, CommanderError } from "commander";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { VERSION } from "../../knowledge-base/src/index.js";
import { type Homes, loadWorkerConfig, ownHomes, readSecrets, sessionHomes, workerConfigPath } from "./config.js";
import { spawnRunner } from "./exec.js";
import { jiraClient } from "./jira.js";
import { claimIssue, finishRun, loop, once, releaseRun, type WorkerDeps } from "./worker.js";

export type Overrides = Partial<Pick<WorkerDeps, "jira" | "run" | "now">> & { signals: EventEmitter };

const DESCRIPTION = "Claim agent-eligible Jira issues and run Claude Code in the right Globu shard.";
const FOOTER = `
once and run start Claude headless in a home of the worker's own: GLOBU_HOME defaults to ~/.globu/worker and
CLAUDE_CONFIG_DIR to <GLOBU_HOME>/claude, and neither may be ~/.globu or ~/.claude. worker.yaml lives in GLOBU_HOME.
poll, claim, finish and release serve a Claude Code session that does the implementing itself: they use the
session's own home, ~/.globu unless GLOBU_HOME says otherwise, and its worker.yaml and runs directory.
Secrets come from JIRA_EMAIL, JIRA_API_TOKEN and GH_TOKEN. The Claude run never sees them.`;

function buildDeps(io: Io, env: NodeJS.ProcessEnv, overrides: Overrides, homes: Homes): WorkerDeps {
  process.env.GLOBU_HOME = homes.home;
  const config = loadWorkerConfig(workerConfigPath(homes.home));
  const secrets = readSecrets(env);
  return {
    config,
    secrets,
    home: homes.home,
    claudeConfigDir: homes.claudeConfigDir,
    jira: overrides.jira ?? jiraClient(config.jira.site, secrets.jiraEmail, secrets.jiraToken),
    run: overrides.run ?? spawnRunner,
    io,
    now: overrides.now ?? (() => new Date()),
    env
  };
}

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
    .addHelpText("after", FOOTER);

  program
    .command("once")
    .description("poll once, claim what fits in the free slots, run each to the end and exit")
    .option("--dry-run", "print what would be claimed and why, touching nothing")
    .option("--issue <key>", "take this issue instead of polling")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { dryRun?: boolean; issue?: string; json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, ownHomes(env));
      const result = await once(deps, { dryRun: options.dryRun, issue: options.issue });
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("poll")
    .description("list what a session could claim now and why, touching nothing")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env));
      const result = await once(deps, { dryRun: true });
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("claim <key>")
    .description("claim an issue for this session: resolve its references, add the worktrees and write the brief")
    .option("--json", "print machine-readable JSON")
    .action(async (key: string, options: { json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env));
      const result = await claimIssue(deps, key);
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("finish <run-id>")
    .description("push a prepared run's commits, open the pull requests and hand back on the issue")
    .option("--json", "print machine-readable JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env));
      const record = await finishRun(deps, id);
      if (options.json) io.out(JSON.stringify(record, null, 2));
    });

  program
    .command("release <run-id>")
    .description("give a prepared run's issue back with a reason and remove its worktrees")
    .requiredOption("--reason <text>", "why the issue goes back")
    .option("--json", "print machine-readable JSON")
    .action(async (id: string, options: { reason: string; json?: boolean }) => {
      const deps = buildDeps(io, env, overrides, sessionHomes(env));
      const record = await releaseRun(deps, id, options.reason);
      if (options.json) io.out(JSON.stringify(record, null, 2));
    });

  program
    .command("run")
    .description("poll and run on the configured interval until SIGINT or SIGTERM")
    .action(async () => {
      const deps = buildDeps(io, env, overrides, ownHomes(env));
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
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    io.err(`globu-worker: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}
