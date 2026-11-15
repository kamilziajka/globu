import fs from "node:fs";
import path from "node:path";
import { gitAuthArgs, resolveAll } from "../../globu-core/src/index.js";
import { attempt, type Check } from "./check.js";
import { type ServedProject, scrubbedEnv, settingsFor } from "./config.js";
import { runOrThrow } from "./exec.js";
import { log, tail } from "./logger.js";
import { layoutOf } from "./projects.js";
import { newRun } from "./runs.js";
import {
  addWorktree,
  authorEnv,
  cleanup,
  fetchShard,
  git,
  openPullRequest,
  type PresentShard,
  projectHolds,
  registry,
  runSetup,
  type WorkerDeps
} from "./worker.js";

const BODY =
  "A smoke test of globu-worker: this machine set up a worktree, made a commit, pushed it and opened this pull request. The worker closes it and deletes the branch right away.\n";

type SmokeTarget = { project: ServedProject; id: string };

function smokeTargets(deps: WorkerDeps): SmokeTarget[] {
  const { shards } = resolveAll();
  const targets: SmokeTarget[] = [];
  for (const project of deps.config.projects) {
    for (const id of layoutOf(project, shards).targets) {
      if (!targets.some((target) => target.id === id)) targets.push({ project, id });
    }
  }
  return targets;
}

export function smokeNames(deps: WorkerDeps): string[] {
  return smokeTargets(deps).map(({ id }) => `smoke ${id}`);
}

function stampOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "z")
    .toLowerCase();
}

async function smokeShard(deps: WorkerDeps, { project, id }: SmokeTarget, held: string | null): Promise<string> {
  if (held !== null) throw new Error(`waiting on ${held}`);
  const settings = settingsFor(deps.config, project, id);
  const token = deps.secrets.githubToken;
  if (token === null) throw new Error("set GH_TOKEN to push branches and open pull requests");
  const shard = registry().all.find((entry) => entry.id === id) as PresentShard;
  if (!fetchShard(shard)) throw new Error(`the repository of shard "${id}" has no commits, nothing to branch from`);
  const stamp = stampOf(deps.now());
  const dir = path.join(deps.home, "smoke", `${id}-${stamp}`);
  const branch = `${settings.git.branchPrefix}smoke-${stamp}`;
  const record = newRun(`smoke-${id}`, deps.now(), { jira: "smoke test", github: null });
  const ghEnv = { ...deps.env, GH_TOKEN: token };
  const deleteBranch = ["push", "--quiet", "origin", "--delete", branch];
  const worktree = addWorktree(shard, path.join(dir, "tree"), branch);
  let url: string | null = null;
  let closed = false;
  try {
    log().info("smoke", { shard: id, branch });
    const failedSetup = await runSetup(deps, record, [worktree], settings);
    if (failedSetup !== null) throw new Error(failedSetup);
    const commit = await deps.run("git", ["commit", "--quiet", "--allow-empty", "-m", "globu-worker smoke test"], {
      cwd: worktree.tree,
      env: {
        ...scrubbedEnv(deps.env),
        ...authorEnv(settings.git),
        GLOBU_HOME: deps.home,
        CLAUDE_CONFIG_DIR: deps.claudeConfigDir
      },
      timeoutMs: settings.timeout
    });
    if (commit.code !== 0) {
      throw new Error(`git commit failed:\n${tail(`${commit.stdout.trim()}\n${commit.stderr.trim()}`)}`);
    }
    const author = git(["log", "-1", "--format=%an <%ae>"], worktree.tree);
    const bodyFile = path.join(dir, "pull-request.md");
    fs.writeFileSync(bodyFile, BODY);
    url = await openPullRequest(deps, worktree, `globu-worker smoke test ${stamp}`, bodyFile, token, {
      ...settings.github,
      draft: true
    });
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
    const setup = (settings.setup[id] ?? []).length;
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
  const holds = projectHolds(deps, "globu-worker smoke test");
  const checks: Check[] = [];
  try {
    for (const target of smokeTargets(deps)) {
      const held = holds.take(target.project);
      const check = await attempt(`smoke ${target.id}`, () => smokeShard(deps, target, held));
      onCheck(check);
      checks.push(check);
    }
  } finally {
    holds.release();
  }
  return checks;
}
