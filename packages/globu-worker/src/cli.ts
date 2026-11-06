import type { EventEmitter } from "node:events";
import { Command, CommanderError } from "commander";
import type { Io } from "../../globu-cli/src/cli/index.js";
import { VERSION } from "../../knowledge-base/src/index.js";
import { loadWorkerConfig, ownHomes, readSecrets, workerConfigPath } from "./config.js";
import { spawnRunner } from "./exec.js";
import { jiraClient } from "./jira.js";
import { loop, once, type WorkerDeps } from "./worker.js";

export type Overrides = Partial<Pick<WorkerDeps, "jira" | "run" | "now">> & { signals: EventEmitter };

const DESCRIPTION = "Claim agent-eligible Jira issues and run Claude Code in the right Globu shard.";
const FOOTER = `
GLOBU_HOME defaults to ~/.globu/worker and CLAUDE_CONFIG_DIR to <GLOBU_HOME>/claude; worker.yaml lives in GLOBU_HOME.
Neither may be ~/.globu or ~/.claude, which belong to interactive sessions.
Secrets come from JIRA_EMAIL, JIRA_API_TOKEN and GH_TOKEN. The Claude run never sees them.`;

function buildDeps(io: Io, env: NodeJS.ProcessEnv, overrides: Overrides): WorkerDeps {
  const homes = ownHomes(env);
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
      const deps = buildDeps(io, env, overrides);
      const result = await once(deps, { dryRun: options.dryRun, issue: options.issue });
      if (options.json) io.out(JSON.stringify(result, null, 2));
    });

  program
    .command("run")
    .description("poll and run on the configured interval until SIGINT or SIGTERM")
    .action(async () => {
      const deps = buildDeps(io, env, overrides);
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
