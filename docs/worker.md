---
type: "Reference"
title: "globu-worker"
description: "The worker that claims agent-eligible Jira issues and runs Claude Code in the right shard: its homes, worker.yaml, once and run, and a run step by step."
---

# globu-worker

`globu-worker` turns a Jira transition into a draft pull request. It polls a Jira project for issues a person has marked ready for an agent, claims one, runs Claude Code headless in a worktree of the issue's repository with Globu's index and guard in place, pushes the branch, opens a draft pull request and reports back on the issue. Every merge, production step and product decision stays with people. The worker only refuses issues whose references do not resolve; it never judges whether an issue is simple enough.

It is the third program in this repo, published to npm as `@kazet/globu-worker`, next to the `globu` CLI and the plugin. The registry, the resolver and the hooks know nothing about Jira. The worker knows nothing about implementing issues: that is the `implement-issue` skill in the plugin, which a person can also run by hand.

## Its own homes

The worker never uses the `~/.globu` and `~/.claude` of the person on the machine. It refuses to start unless `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` name directories of its own. Inside `GLOBU_HOME`:

| Path | Holds |
|---|---|
| `manifest.yaml`, `state.yaml`, `clones` | An ordinary Globu home, filled with `globu import`, `register` and `sync` |
| `worker.yaml` | The configuration below |
| `work/<id>` | Editable clones of the shards the worker delivers to, by convention |
| `runs/<run-id>` | One directory per run: `run.json`, `brief.md`, `handback.md`, `settings.json`, `claude.jsonl` and the pull request bodies. The worktree lives here while the run lasts |

This is the bootstrap from [unattended runs](./unattended-runs.md) with one more step, the editable clones:

```bash
export GLOBU_HOME=~/.globu-worker CLAUDE_CONFIG_DIR=~/.globu-worker/claude
```

```bash
globu import https://github.com/acme/product.git --context team --yes
```

```bash
globu register git@github.com:acme/backend.git --path "$GLOBU_HOME/work/backend"
```

```bash
globu sync
```

```bash
globu claude sync
```

Repeat the `register --path` step for every shard under `deliverable` and `companion` in `worker.yaml`. The other shards are cloned read-only by `sync`. Install the plugin into the worker's Claude config dir with `claude plugin marketplace add` and `claude plugin install`, or point `claude.pluginDir` in `worker.yaml` at the plugin in a checkout of this repo, which the unattended runs guide describes as `--plugin-dir`. `globu-worker once` checks before every cycle that each deliverable shard has an editable clone that is not read-only and each companion is in `write` mode, and refuses to poll otherwise.

Keeping the homes apart costs a second clone of each repository on a laptop. In return the worker's modes are its own policy, the person's checkouts and worktrees are never touched by a run, and a laptop and a container run the same way.

## Configuration

`worker.yaml` in `GLOBU_HOME`:

```yaml
version: 1
jira:
  site: https://acme.atlassian.net
  jql: project = MR AND status = "Ready for delivery" AND labels = agent-eligible AND labels != agent-blocked AND assignee is EMPTY ORDER BY created ASC
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  blockedLabel: agent-blocked
  repository:
    labelPrefix: "repo:"
shards:
  deliverable: [backend, frontend]
  companion: [product]
poll:
  every: 60s
limits:
  concurrent: 2
  perShard: 1
  turns: 80
  timeout: 45m
  runUsd: 5
  dayUsd: 40
claude:
  skill: implement-issue
  model: claude-sonnet-5-5
  allowedTools:
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - Bash(npm run *)
    - Bash(git add *)
    - Bash(git commit *)
git:
  branchPrefix: agent/
  author:
    name: Acme Agent
    email: agent@acme.example
github:
  draft: true
  labels: [agent]
```

| Key | Meaning | Default |
|---|---|---|
| `jira.site` | The Jira Cloud site | required |
| `jira.jql` | What is eligible. The worker runs it as written and adds nothing, so the team owns the gate and the order | required |
| `jira.claimedStatus` | The status a claimed issue is moved to, by name. Transitions are looked up per issue | required |
| `jira.releasedStatus` | Where a released issue goes back to | required |
| `jira.blockedLabel` | Added when the worker gives an issue back, so the JQL above excludes it until a person removes it | `agent-blocked` |
| `jira.repository` | How an issue names its target: `labelPrefix` for a label such as `repo:backend`, or `field: customfield_NNNNN` for a text or option field. The value is a shard id | required |
| `shards.deliverable` | Shards the worker may run in. An issue naming anything else is released | required |
| `shards.companion` | Shards a run may also write to, each on a worktree of its own with the same branch name. Commits there become a second draft pull request | none |
| `poll.every` | The interval of `run`, as `30s`, `5m` or `1h` | `60s` |
| `limits.concurrent`, `limits.perShard` | Runs per cycle and runs per shard per cycle | 1 and 1 |
| `limits.turns`, `limits.timeout`, `limits.runUsd` | Passed to Claude as the turn cap and the budget; the worker kills the run at the timeout | 80, `45m`, 5 |
| `limits.dayUsd` | When the runs started today have cost this much, the worker keeps polling but claims nothing | 40 |
| `claude.skill` | The skill the run is told to use | `implement-issue` |
| `claude.model` | Passed as `--model` when set | Claude Code's default |
| `claude.pluginDir` | Passed as `--plugin-dir` when set: the plugin from a checkout of this repo, for a test of an unreleased plugin or a machine without a marketplace | the plugins installed in `CLAUDE_CONFIG_DIR` |
| `claude.allowedTools` | The permission allowlist of the run. Everything else is denied, since nobody can answer a prompt | `Read`, `Edit`, `Write`, `Glob`, `Grep`, `npm run`, `npx vitest`, `git status`, `git diff`, `git log`, `git add` and `git commit` through Bash |
| `git.branchPrefix` | The branch is `<prefix><KEY>-<slug of the summary>` | `agent/` |
| `git.author` | Author and committer of the run's commits. Whether that is a bot or the token holder is the team's attribution call | the clone's git config |
| `github.draft`, `github.labels` | Passed to `gh pr create`. A label must exist in the repository | `true`, none |

Secrets come from the environment only: `JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira, `GH_TOKEN` (or `GITHUB_TOKEN`) for the push and `gh`, `GLOBU_GIT_TOKEN` for the clones Globu owns. The Claude process gets none of them: the worker strips `JIRA_EMAIL`, `JIRA_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from its environment and sets `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` to the worker's own. How Claude authenticates is the worker's Claude config dir's business: `ANTHROPIC_API_KEY` in the environment or a login made in that config dir.

## Commands

| Command | Purpose |
|---|---|
| `once [--dry-run] [--issue <key>] [--json]` | One cycle: poll, claim up to the free slots, run each to the end, exit. `--dry-run` prints what it would claim and why, touching nothing. `--issue` takes that issue instead of polling, also when it is already assigned, which is how a released issue is retried and how the whole path is tested. `--json` adds the run records and the plan |
| `run` | `once` on the configured interval until `SIGINT` or `SIGTERM`. A signal during a cycle lets the cycle finish |

`once` prints one line per issue it looked at (`claimed`, `skipped, already assigned`, `skipped, backend has a run already`, `skipped, claimed by someone else`, or in a dry run `would claim and run in backend (2 references resolved)` and `would release: ...`) and one line per run with its final state, its reason when released and its pull requests when handed back. The exit code is 0 whenever the cycle ran; a released issue is not an error of the worker.

## A run

1. **Reconcile.** Runs left in a non-final state by a crash or a restart are closed: their worktrees are removed and, when the issue is still assigned to the worker in the claimed status, it is released with a comment saying so.
2. **Poll.** The JQL, oldest first as the team wrote it. Up to `limits.concurrent` issues are taken, skipping an issue already assigned and an issue whose shard already has `limits.perShard` runs this cycle.
3. **Claim.** Assign to the worker's own account, transition to `claimedStatus`, read the issue back. If someone else got there first, drop it without a word.
4. **Find the target.** The repository marker names a shard. Not a deliverable shard: release.
5. **Resolve.** Shard-qualified refs such as `product/docs/decisions/012-pricing.md` and code host links to files in a shard's repo are checked with the same code as `globu resolve`, after a fetch. One missing: release, with the resolver's report and its candidates in the comment, before a token is spent. Bare paths in backticks are resolved too but only reported in the brief, since they may be files the change creates.
6. **Prepare.** A worktree of the target clone on a fresh branch from the default branch, one more for each companion shard. The worktrees sit under `runs/<run-id>`, outside every repository; the session view still maps them to their shards through the git common directory, so the guard treats the target as the run's home and every other shard as foreign.
7. **Brief.** `brief.md` holds the issue as Jira returned it under a heading that says it is untrusted input, the resolved references with their locations on this machine, the worktrees and the handback path. `settings.json` holds the allowlist and denies `git push`, `gh`, `curl` and `wget`.
8. **Run.** From the worktree root: `claude -p "Implement the issue described in <brief> with the implement-issue skill. Write the handback to <handback>." --permission-mode dontAsk --settings <settings> --add-dir <run dir> --max-turns N --max-budget-usd X --output-format stream-json --verbose`. The stream goes to `claude.jsonl`. `--add-dir` is what lets the run write the handback outside the repository.
9. **Collect.** Cost, turns and the end state from the stream. Every failed tool call that carries the guard's `shard "<id>"` wording is recorded as a blocked write. Commits on the branch are counted.
10. **Decide.** Timed out, stopped at the turn cap or no commits: release, with the reason. Otherwise push each branch with commits over https with `GH_TOKEN`, open a draft pull request with `gh pr create` whose body is the handback plus the run footer, comment on the issue with the handback and the pull request links, add each pull request as a remote link and leave the issue in `claimedStatus` for the reviewer.
11. **Clean up.** Worktrees are removed, unpushed branches deleted, the run directory kept.

A release moves the issue back to `releasedStatus`, unassigns it, adds `blockedLabel` and comments with the reason. The worker never retries on its own. A person fixes the issue, removes the label and either waits for the next poll or runs `once --issue <key>`.

Every footer, in the pull request body and in the Jira comment, names the run id, the Jira account and GitHub login the worker acted as, turns, cost, wall time and the blocked writes. Until Atlassian ships agent identities a run acts as whoever holds the tokens, and the footer records which identity that was.

## What the guard does in a run

Nothing new. The run's working directory is a worktree of the target shard, so writes there are free. Every other shard in the worker's `state.yaml` is a read-only clone, so a certain write is blocked and a possible one raises `ask`, which a run with nobody to answer turns into a denial. Companion shards are in `write` mode in the worker's own state, which is harmless because that state belongs to the worker alone, and their edits land on a branch through the worktree. The limits of reading shell commands in [architecture](./architecture.md#shell-commands-in-the-guard) apply: the guard lowers the odds of an unnoticed write to a sibling repository and the footer reports the ones it caught. It is not a sandbox.

## Running it

On a Mac, `globu-worker run` under launchd with the secrets in the job's environment. In a container, a Cloud Run job or a cron entry runs the bootstrap against an empty `GLOBU_HOME` and then `globu-worker once`; a second invocation while one is running finds the issues already claimed and does nothing. No endpoint is exposed, because the trigger is the poll. Two workers on one Jira project are not supported: the claim is a read-back after assign and transition, which is enough for one.

What the consuming project needs in Jira: a status a person moves an issue into as the act of delegation, an eligibility label, the blocked label in the JQL and a repository marker per issue. The Claude Code behaviours the worker relies on and which were tested are in the [hook contract](./claude-code-hooks.md).
