import fs from "node:fs";
import path from "node:path";
import { gitAuthArgs } from "../../globu-core/src/index.js";
import { attempt, type Check } from "./check.js";
import { scrubbedEnv } from "./config.js";
import { runOrThrow } from "./exec.js";
import { log, tail } from "./logger.js";
import { newRun } from "./runs.js";
import {
  addWorktree,
  authorEnv,
  cleanup,
  fetchShard,
  git,
  openPullRequest,
  type PresentShard,
  registry,
  runSetup,
  type WorkerDeps,
  workerHold
} from "./worker.js";

const BODY =
  "A smoke test of globu-worker: this machine set up a worktree, made a commit, pushed it and opened this pull request. The worker closes it and deletes the branch right away.\n";

export function smokeNames(deps: WorkerDeps): string[] {
  return deps.config.shards.deliverable.map((id) => `smoke ${id}`);
}

function stampOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "z")
    .toLowerCase();
}

async function smokeShard(deps: WorkerDeps, id: string, held: string | null): Promise<string> {
  if (held !== null) throw new Error(`waiting on ${held}`);
  const { config } = deps;
  const token = deps.secrets.githubToken;
  if (token === null) throw new Error("set GH_TOKEN to push branches and open pull requests");
  const shard = registry().all.find((entry) => entry.id === id) as PresentShard;
  if (!fetchShard(shard)) throw new Error(`the repository of shard "${id}" has no commits, nothing to branch from`);
  const stamp = stampOf(deps.now());
  const dir = path.join(deps.home, "smoke", `${id}-${stamp}`);
  const branch = `${config.git.branchPrefix}smoke-${stamp}`;
  const record = newRun(`smoke-${id}`, deps.now(), { jira: "smoke test", github: null });
  const ghEnv = { ...deps.env, GH_TOKEN: token };
  const deleteBranch = ["push", "--quiet", "origin", "--delete", branch];
  const worktree = addWorktree(shard, path.join(dir, "tree"), branch);
  let url: string | null = null;
  let closed = false;
  try {
    log().info("smoke", { shard: id, branch });
    const failedSetup = await runSetup(deps, record, [worktree]);
    if (failedSetup !== null) throw new Error(failedSetup);
    const commit = await deps.run("git", ["commit", "--quiet", "--allow-empty", "-m", "globu-worker smoke test"], {
      cwd: worktree.tree,
      env: {
        ...scrubbedEnv(deps.env),
        ...authorEnv(config),
        GLOBU_HOME: deps.home,
        CLAUDE_CONFIG_DIR: deps.claudeConfigDir
      },
      timeoutMs: config.limits.timeout
    });
    if (commit.code !== 0) {
      throw new Error(`git commit failed:\n${tail(`${commit.stdout.trim()}\n${commit.stderr.trim()}`)}`);
    }
    const author = git(["log", "-1", "--format=%an <%ae>"], worktree.tree);
    const bodyFile = path.join(dir, "pull-request.md");
    fs.writeFileSync(bodyFile, BODY);
    url = await openPullRequest(deps, worktree, `globu-worker smoke test ${stamp}`, bodyFile, token, true);
    await runOrThrow(deps.run, "gh", ["pr", "close", url, "--comment", "Closed by the globu-worker smoke test."], {
      cwd: worktree.tree,
      env: ghEnv
    });
    closed = true;
    await runOrThrow(deps.run, "git", [...gitAuthArgs(shard.source.repo, { token }), ...deleteBranch], {
      cwd: worktree.tree,
      env: deps.env
    });
    worktree.pushed = false;
    const setup = (config.setup[id] ?? []).length;
    return `${setup} setup commands, a commit as ${author}, ${url} opened as a draft, closed and its branch deleted`;
  } finally {
    if (url !== null && !closed) await deps.run("gh", ["pr", "close", url], { cwd: worktree.tree, env: ghEnv });
    if (worktree.pushed) {
      await deps.run("git", [...gitAuthArgs(shard.source.repo, { token }), ...deleteBranch], {
        cwd: worktree.tree,
        env: deps.env
      });
      worktree.pushed = false;
    }
    cleanup([worktree]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function smokeTest(deps: WorkerDeps, onCheck: (check: Check) => void = () => {}): Promise<Check[]> {
  const hold = workerHold(deps, "globu-worker smoke test");
  const held = hold.take();
  const checks: Check[] = [];
  try {
    for (const id of deps.config.shards.deliverable) {
      const check = await attempt(`smoke ${id}`, () => smokeShard(deps, id, held));
      onCheck(check);
      checks.push(check);
    }
  } finally {
    hold.release();
  }
  return checks;
}
