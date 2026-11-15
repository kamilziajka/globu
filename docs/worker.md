---
type: "Reference"
title: "globu-worker"
description: "The worker that claims agent-eligible Jira issues and runs Claude Code in the right shard: its homes, worker.yaml and secrets.env, the start, check, once, run, retry, why, delegate and diagnostics commands, the smoke test, exclusive resources, their lock files and hold, the subscription limit, notifications, logs and a run step by step."
---

# globu-worker

`globu-worker` turns a Jira transition into a pull request. It polls a Jira project for issues a person has marked ready for an agent, claims one, runs Claude Code headless in a worktree of the issue's repository with Globu's index and guard in place, pushes the branch, opens a draft pull request and reports back on the issue. Every merge, production step and product decision stays with people. The worker only refuses issues whose references do not resolve; it never judges whether an issue is simple enough.

It is the third program in this repo, published to npm as `@kazet/globu-worker`, next to the `globu` CLI and the plugin. The registry, the resolver and the hooks know nothing about Jira. The worker knows nothing about implementing issues: that is the `issue-deliver` skill in the plugin, which a person can also run by hand.

This page follows the `main` branch and can describe what is not released yet. The docs of each released version are on [globu.kazet.blog](https://globu.kazet.blog), and `globu-worker --version` says which one is installed.

## Its own homes

The worker never uses the `~/.globu` and `~/.claude` of the person on the machine. `GLOBU_HOME` defaults to `~/.globu/worker` and `CLAUDE_CONFIG_DIR` to `claude` inside it; either can be set to another directory, and the worker refuses to start when one of them is `~/.globu` or `~/.claude`. Inside `GLOBU_HOME`:

| Path | Holds |
|---|---|
| `manifest.yaml`, `state.yaml`, `clones` | An ordinary Globu home, filled with `globu import`, `register` and `sync` |
| `worker.yaml` | The configuration below |
| `secrets.env` | Optional secrets as `KEY=value` lines, see [secrets](#secrets) |
| `work/<id>` | Editable clones of the shards the worker delivers to, by convention, and where `shards.repos` clones them |
| `subscription.json` | The latest subscription figures from the runs' streams, see [the subscription limit](#the-subscription-limit) |
| `merged.json` | Every issue whose run had its pull requests merged, with those pull requests and the merge time, so a pruned run still resolves the issues it [blocks](#issues-that-wait) |
| `logs` | One log file per day, see [logs and diagnostics](#logs-and-diagnostics) |
| `runs/<run-id>` | One directory per run: `run.json`, `brief.md`, `handback.md`, `claude.jsonl` and the pull request bodies. The worktree lives here while the run lasts. Only the newest `limits.keepRuns` runs and the ones still in use are kept, see [a run](#a-run) |

The shortest setup needs no `globu` commands: list each shard's repository under `shards.repos` in `worker.yaml` and the worker registers the missing ones as editable clones in `work/<id>`, in `write` mode, and writes their directories into its Claude settings, at the start of `once`, `run`, `start` and `check`. A shard that is already registered is left alone.

The longer setup is the bootstrap from [unattended runs](./unattended-runs.md) with one more step, the editable clones, and it is the one to use when the shards come from a team manifest. The `globu` and `claude` commands below default to the interactive homes, so the two variables are exported for them even when the worker itself runs on its defaults:

```bash
export GLOBU_HOME=~/.globu/worker CLAUDE_CONFIG_DIR=~/.globu/worker/claude
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

Keeping the homes apart costs a second clone of each repository on a laptop. In return the worker's modes are its own policy, the person's checkouts and worktrees are never touched by a run, and a laptop and a container run the same way. A home nested inside `~/.globu` is still a separate home: nothing in Globu reads a parent directory.

## Configuration

`worker.yaml` in `GLOBU_HOME`:

```yaml
version: 1
jira:
  site: https://acme.atlassian.net
  jql: project = MR AND status = "Ready for delivery" AND labels = agent-eligible AND labels != agent-blocked AND assignee is EMPTY ORDER BY created ASC
  claimedStatus: Delivery
  releasedStatus: 10001
  doneStatus: Done
  priorityLabel: agent-next
  eligibleLabel: agent-eligible
  blockedLabel: agent-blocked
  blockingLinks: [Blocks]
  repository:
    labelPrefix: "repo:"
  followUps:
    issueType: Task
shards:
  deliverable: [backend, frontend]
  companion: [product]
  repos:
    backend: https://github.com/acme/backend.git
    frontend: https://github.com/acme/frontend.git
    product: https://github.com/acme/product.git
setup:
  backend: [npm ci]
  frontend: [npm ci, npm run build]
poll:
  every: 60s
limits:
  concurrent: 2
  perShard: 1
  timeout: 45m
  dayUsd: 40
  openPullRequests: 5
  repairs: 2
  keepRuns: 100
  subscription: 70
  exclusive: [gpu]
claude:
  skill: issue-deliver
  model: claude-sonnet-5-5
  maxTurns: 80
  maxBudgetUsd: 5
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
  draft: false
  labels: [agent]
notify:
  command: >-
    curl -s -H "Title: $GLOBU_ISSUE $GLOBU_EVENT" -H "Click: $GLOBU_URL"
    -d "$GLOBU_MESSAGE" https://ntfy.sh/acme-agent
  timeout: 30s
```

| Key | Meaning | Default |
|---|---|---|
| `jira.site` | The Jira Cloud site | required |
| `jira.jql` | What is eligible. The worker runs it as written and adds nothing, so the team owns the gate and the order | required |
| `jira.claimedStatus` | The status a claimed issue is moved to, by name or by id: an all-digit value is an id. Names match without regard to case. Transitions are looked up per issue, so a same-named status in another project is never picked. Either one value or a [map by project](#several-projects) | required |
| `jira.releasedStatus` | Where a released issue goes back to, by name or by id, one value or a map by project | required |
| `jira.doneStatus` | Where an issue goes once all its pull requests are merged, by name or by id, one value or a map by project. Without it, or without an entry for the issue's project, the issue stays in `claimedStatus` and only gets a comment | none |
| `jira.priorityLabel` | Issues carrying this label are taken before the rest, in the order the JQL returns them; the rest follow in the same order. See [Pointing the queue](#pointing-the-queue) | none |
| `jira.eligibleLabel` | The label `delegate` adds to mark an issue for the worker. It should be the eligibility label the JQL asks for, since the worker never reads it anywhere else | `agent-eligible` |
| `jira.blockedLabel` | Added when the worker gives an issue back, so the JQL above excludes it until a person removes it | `agent-blocked` |
| `jira.blockingLinks` | Issue link types, by name, that make an issue wait for the issue on their "is blocked by" side, see [Issues that wait](#issues-that-wait). An empty list turns waiting off | `[Blocks]` |
| `jira.followUps.issueType` | Turns on [follow-up issues](#follow-up-issues): the issue type, by name or by id, of the issues the worker files from a handback's `## Follow-ups` section. One value or a [map by project](#several-projects). Without it the section only reaches the issue in the handback comment | none, off |
| `jira.followUps.linkType` | The issue link type, by name, that links each follow-up to the original issue | `Relates` |
| `jira.followUps.max` | The most follow-ups filed from one handback; the bullets past it are listed in the comment as not created | 10 |
| `jira.repository` | How an issue names its target: `labelPrefix` for a label such as `repo:backend`, or `field: customfield_NNNNN` for a text or option field. The value is a shard id | required |
| `shards.deliverable` | Shards the worker may run in. The repository marker of an issue must name one; anything else is released, so the list is the team's whitelist of repositories the agent delivers to | required |
| `shards.companion` | Shards a run may also write to, each on a worktree of its own with the same branch name, whether or not the issue names them. Commits there become a second pull request. A run never consists of companion changes alone: the deliverable is where it lives and where the per-shard limit counts | none |
| `shards.repos` | Repository URL per shard id. A deliverable or companion shard that is not registered yet is cloned from it into `work/<id>` at start; see [its own homes](#its-own-homes) | none |
| `setup.<shard>` | Commands run with `sh -c`, in order, in each fresh worktree of that shard before Claude starts, such as `npm ci`. On Windows `sh` is the one from Git for Windows, found on `PATH` or next to `git`, see [On Windows](#on-windows). They run outside Claude's tool allowlist, with the worker's environment minus the secrets and with `limits.timeout`. One that fails or times out releases the issue with the command and the end of its output; one whose shell cannot start is a [problem of the machine](#a-run) | none |
| `poll.every` | The interval of `run`, as `30s`, `5m` or `1h` | `60s` |
| `limits.concurrent`, `limits.perShard` | Runs per cycle and runs per shard per cycle | 1 and 1 |
| `limits.timeout` | The worker kills the run and releases the issue when it lasts longer | `45m` |
| `limits.dayUsd` | When the runs started today have cost this much, the worker keeps polling but claims nothing | 40 |
| `limits.openPullRequests` | With this many of the worker's pull requests open, an automatic cycle claims no new issue; see [following its pull requests](#following-its-pull-requests) | 5 |
| `limits.repairs` | Failed repairs of a pull request before it is handed to a person | 2 |
| `limits.keepRuns` | How many run directories to keep, newest first by start time. At the start of every cycle the worker deletes the older ones that are settled. A run that is not in a final state, a handed-back run whose pull requests are still followed, its repairs and every run started today are always kept, the last so that the day cap still counts them. Pruning never touches `merged.json`, so a merged run that is pruned still resolves the issues it [blocks](#issues-that-wait) | 100 |
| `limits.subscription` | A percentage: when a window of the Claude subscription is used this much, the worker keeps polling but claims and repairs nothing until that window resets. See [the subscription limit](#the-subscription-limit) | 70 |
| `limits.exclusive` | Machine-wide resources a run needs to itself, by name: letters, digits, dots, dashes and underscores. The worker takes a lock file for each before it claims or repairs and holds them until the cycle's runs end; see [exclusive resources](#exclusive-resources) | none |
| `claude.skill` | The skill the run is told to use, the one key under `claude` that is not a flag | `issue-deliver` |
| `claude.model` | Passed as `--model` when set | Claude Code's default |
| `claude.pluginDir` | Passed as `--plugin-dir` when set: the plugin from a checkout of this repo, for a test of an unreleased plugin or a machine without a marketplace | the plugins installed in `CLAUDE_CONFIG_DIR` |
| `claude.maxTurns` | Passed as `--max-turns`. A run that hits it is released | 80 |
| `claude.maxBudgetUsd` | Passed as `--max-budget-usd`. Claude stops at its own estimate, which counts subagents and can overshoot; a run that stopped with commits is still handed back | 5 |
| `claude.allowedTools` | Passed as `--allowedTools`. Everything else is denied, since nobody can answer a prompt. Claude Code checks every part of a Bash command joined with `;`, `&&`, `\|\|` or `\|` on its own, so one part outside the list denies the whole command; the brief lists the Bash prefixes and asks for one command per call | `Read`, `Edit`, `Write`, `Glob`, `Grep`, and through Bash `npm run`, `npx vitest`, `git status`, `git diff`, `git log`, `git show`, `git add`, `git commit` and the read-only `ls`, `cat`, `head`, `tail` and `wc` |
| `git.branchPrefix` | The branch is `<prefix><KEY>-<slug of the summary>` | `agent/` |
| `git.author` | Author and committer of the run's commits. Whether that is a bot or the token holder is the team's attribution call | the clone's git config |
| `notify.command` | A command run on a hand back, a release, a pull request that needs a person and a stop for a machine problem, see [notifications](#notifications) | none |
| `notify.timeout` | The notification command is killed when it lasts longer | `30s` |
| `github.draft`, `github.labels` | Passed to `gh pr create`: `draft: true` opens draft pull requests instead of ones ready for review. A label must exist in the repository | `false`, none |

Every key under `claude` except `skill` is a `claude -p` flag in camelCase and goes through untouched. `limits` holds what the worker enforces on its own. Claude Code has no settings key for the turn cap or the budget, which is why they are flags here rather than entries in a settings file.

### Several projects

One JQL can span several projects whose workflows name their statuses differently. Each of the three status keys then takes a map keyed by Jira project key, with an optional `default` entry for every project the map does not name:

```yaml
jira:
  jql: project in (KLAYBOY, SANDBOX) AND labels = agent-eligible AND assignee is EMPTY ORDER BY created ASC
  claimedStatus:
    KLAYBOY: In Progress
    SANDBOX: Doing
  releasedStatus:
    default: To Do
  doneStatus:
    KLAYBOY: Done
```

`jira.followUps.issueType` takes the same kind of map, since issue type names differ between projects too.

The project is the part of the issue key before the hyphen. An issue whose project has neither an entry nor a default for `claimedStatus` or `releasedStatus` is not claimed: the cycle stops with an error that names the key and the project, before the issue is assigned.

### Pointing the queue

Auto mode takes issues in the order the JQL returns them, so with `limits.concurrent` at 1 the first eligible issue always wins, the oldest one under `ORDER BY created ASC`. Adding the `priorityLabel` label to an issue in Jira moves it to the front on the next poll, without touching the JQL or `worker.yaml`. Several labelled issues keep their JQL order among themselves. Pick mode lists the issues in the same order.

A label was chosen over a weight per project: it points at the issue a person wants next, it is set from Jira by whoever triages, it works the same within one project and across several, and it costs nothing extra since the search already returns the labels.

## Secrets

Secrets come from the environment or from `secrets.env` in `GLOBU_HOME`, and the environment wins when both name the same variable. The file holds `KEY=value` lines; blank lines, `#` comments, an `export ` prefix and quotes around the value are accepted, a line with an empty value counts as unset, and a line that is not `KEY=value` is reported by its number without its content. The worker warns at start when the file is readable by anyone but its owner (`chmod 600 secrets.env`); on Windows, where the file has no such mode bits, it does not check. `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from the file reach Globu's own clones and fetches too. Without `GLOBU_GIT_TOKEN`, the worker's clones and fetches of `github.com` repositories use `GH_TOKEN`, so one token covers a private GitHub repository. Every git command the worker runs, and every command it starts, has `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, so a missing credential fails at once instead of waiting for a prompt nobody answers.

The variables: `JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira, `GH_TOKEN` (or `GITHUB_TOKEN`) for the push and `gh`, `GLOBU_GIT_TOKEN` for the clones Globu owns. The Claude process gets none of them: the worker strips `JIRA_EMAIL`, `JIRA_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from its environment and sets `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` to the worker's own. How Claude authenticates is the worker's Claude config dir's business: a login made in that config dir, or `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment or in `secrets.env`. Those two are the only secrets passed on to Claude.

## Commands

| Command | Purpose |
|---|---|
| `start [--mode pick\|auto]` | The way to run the worker by hand: shard bootstrap, `check`, then issues one at a time with a session list. `pick`, the default on a terminal, lists the eligible issues: ↑ and ↓ (or `k` and `j`) move the selection, Enter runs the selected issue, or repairs the selected pull request, and polls again, `r` polls Jira and GitHub again, `q`, Esc or Ctrl+C quits. On a terminal, `globu-worker` without a command runs `start`. Pick mode also polls in the background every `poll.every` and redraws; it never claims or repairs without Enter, but it does move merged issues to `doneStatus`. `auto`, the default without a terminal, is the `run` loop. `limits.concurrent` is held at 1 whatever `worker.yaml` says |
| `check [--smoke]` | Shard bootstrap, then one line per check with `ok` or `FAIL` and exit code 1 on a failure: `worker.yaml` and the secrets load; every deliverable and companion shard has an editable clone; the setup shell is found and finds the first program of each `setup` command (`command -v`), with a note on Windows when `core.longpaths` is off; Jira answers for the account and runs the JQL; `gh api user` answers with `GH_TOKEN` and every deliverable repository can be read with it (`git ls-remote`); a one-turn `claude -p` answers in the worker's Claude config dir and lists the configured skill, naming the model and, when `claude.model` is unset, that it is the config dir's default. Jira, GitHub and Claude are checked at the same time; on a terminal each line shows a spinner until its check ends in a green ✔ or a red ✖. The Claude check costs a few cents (about 0.08 USD measured), since a fresh session primes its cache. `--smoke` then runs the [smoke test](#the-smoke-test) when every check passed, one more line per deliverable shard, and says it skipped it otherwise |
| `diagnostics [--out <file>]` | A `.tar.gz` with the log files, the `run.json` of the 20 runs started last, `worker.yaml`, `merged.json` when there is one and `environment.txt` (worker, Node, OS, `claude`, `git` and `gh` versions), every secret value replaced with `[redacted]`. Never `secrets.env`, a brief, a handback or a Claude stream. Written to `globu-worker-diagnostics-<time>.tar.gz` in the current directory by default |
| `once [--dry-run] [--issue <key>] [--repair <url>] [--json]` | One cycle: poll, claim up to the free slots, run each to the end, exit. `--dry-run` prints what it would claim and why, touching nothing. `--issue` takes that issue instead of polling, also when it is already assigned, which is how the whole path is tested. `--repair` repairs that pull request of the worker now, also when it is past `limits.repairs`. `--json` adds the run records and the plan |
| `retry <key> [--json]` | Removes `jira.blockedLabel` from the issue, then does what `once --issue <key>` does. The way to try a released issue again once its problem is fixed |
| `why <key> [--session] [--json]` | Says why the next cycle would or would not claim the issue, touching nothing: whether it matches `jira.jql` (searched as `key = <key> AND (<jql>)` without the `ORDER BY`) and carries `blockedLabel`, its repository marker, its assignee, the blockers it [waits](#issues-that-wait) on, which limit holds it (`limits.dayUsd`, `limits.subscription`, a held [exclusive resource](#exclusive-resources), `limits.openPullRequests`, or `limits.concurrent` and `limits.perShard` with the repairs and the issues ahead of it in the JQL order) and whether its references resolve. `--session` reads the session's home instead of the worker's. `--json` prints the same as one object |
| `delegate <key> --repo <shard> [--session] [--json]` | Marks the issue for the worker without the Jira UI: adds `jira.eligibleLabel` and the repository marker for a deliverable shard, a `labelPrefix` label that replaces any other marker label, or the custom field, set as text or as an option by its type. Then says whether the issue now matches `jira.jql`, since a status in the JQL still takes a transition. `--session` reads the session's `worker.yaml` |
| `run` | Shard bootstrap and `check`, then `once` on the configured interval until `SIGINT` or `SIGTERM`. A failed check stops it before the first cycle. A signal during a cycle lets the cycle finish |
| `poll [--json]` | The dry run of `once`, for a session: what could be claimed now and why, touching nothing |
| `claim <key> [--json]` | Steps 3 to 7 of a run for a session: claim the issue, resolve its references, add the worktrees and write the brief, then stop with the run `prepared` and the worktrees in place. Prints the run directory; `--json` adds the record and the paths of the brief, the tree, the handback and the companions |
| `finish <run-id> [--json]` | Steps 10 and 11 for a prepared run: push the worktrees that have commits, open the pull requests, comment on the issue and remove the worktrees. A run without commits is released with that reason |
| `release <run-id> --reason <text> [--json]` | Give a prepared run's issue back with that reason and remove its worktrees |
| `hold <resource>[,<resource>] [--wait <duration>] -- <command> [args]` | Takes the lock files of those [exclusive resources](#exclusive-resources), runs the command and deletes them when it ends, passing its exit code through. Needs no `worker.yaml` or secrets. See [hold](#hold) |

Every command takes `--log-level` before its name, as in `globu-worker --log-level debug start`.

`start` shows no Claude output. On a terminal it redraws a table after every change: under the title a gray line keeps the checks in view with what each resolved to (the Jira user, the GitHub login, the Claude model, the shards), then key, summary, state and detail per issue, where the state is `available`, `not ready` (a reference is missing), `waiting` (with the blockers it waits on), `skipped`, `preparing`, `running` (with its start time), `pushing`, `handed back` (with the pull requests) or `released` (with the reason), and below it today's spend against `limits.dayUsd`, the subscription's windows against `limits.subscription` when the runs reported them (`subscription five-hour 15 %, seven-day 60 % of 70 %`, or `subscription five-hour at 72 %, holding until 2026-11-14 18:00 UTC` while the limit holds) and the keys. In pick mode the selected issue has a green ● and green text, the other available ones a gray ○, and the rest are gray. Without a terminal it prints one line per state change, `<time> <key> <state>: <detail>`, which reads well in a service log. The worker's open pull requests are listed first, as `<KEY> #<number>`, with `conflict`, `checks failing` and `needs human` in red; the first two are pickable while repairs are left. The footer counts the open pull requests against `limits.openPullRequests` and how many need a fix.

`once` prints one line per issue it looked at (`claimed`, `waiting on MR-5 (In Review)`, `waiting on gpu (held by klayboy render, pid 4242 on desk since 2026-11-14T10:00:00.000Z)`, `skipped, already assigned`, `skipped, backend has a run already`, `skipped, claimed by someone else`, or in a dry run `would claim and run in backend (2 references resolved)` and `would release: ...`) and one line per run with its final state, its reason when released and its pull requests when handed back. The exit code is 0 whenever the cycle ran; a released issue is not an error of the worker.

## The smoke test

`check` proves each piece answers, not that they work together: a machine can pass it and fail its first run a second after the claim, on a setup command, a commit hook, the push or `gh pr create`. `check --smoke` walks that path without an issue, for each deliverable shard in turn:

1. Take the [exclusive resources](#exclusive-resources), as `globu-worker smoke test`. One held by another process fails every shard's line with `waiting on <resource> (...)` and nothing else runs.
2. Fetch the clone and add a worktree under `smoke/<shard>-<time>` in the worker's home, on a throwaway branch `<git.branchPrefix>smoke-<time>` from the default branch.
3. Run the shard's `setup` commands there, as a run does.
4. Make an empty commit, `globu-worker smoke test`, with the environment Claude's commits get: `git.author`, the secrets stripped, the worker's `GLOBU_HOME` and `CLAUDE_CONFIG_DIR`. The repository's commit hooks run as they would in a run.
5. Push the branch with `GH_TOKEN` and open a pull request with `gh pr create`, always as a draft and with `github.labels`, so a missing label fails here.
6. Close the pull request with a comment and delete the remote branch, then remove the worktree, the local branch and the directory.

A failure names the step and the end of its output, and the cleanup still runs: a pull request that was opened is closed and a branch that was pushed is deleted. The smoke test never reads or writes Jira and spends nothing on Claude, but it costs one setup per deliverable shard and leaves a closed draft pull request in each repository's history. Run it once on a new machine, and again after changing `setup`, the hooks or the token.

## Exclusive resources

Some runs cannot share the machine with other work. On a desktop that renders on its GPU, a run's setup or commit hook can start a render while a render job already has the whole GPU. `limits.exclusive: [gpu]` makes the worker take the machine-wide lock `gpu` before it claims or repairs, hold it through setup, Claude and the push until the cycle's runs end, and claim nothing while another process holds it: the issue stays unclaimed with `waiting on gpu (...)` and the next cycle tries again. A dry run, `poll` and pick mode report the same without taking the lock. Polling, follow-ups and the day cap do not need it. `claim`, `finish` and `release` from a session never take it, since no process lives through a session's run to hold it.

The locks live in `~/.globu/locks`, one file per resource named `<resource>.lock`, outside every worker's own home so that every tool on the machine finds the same file. `GLOBU_LOCK_DIR` moves the directory for every tool that honours it. A lock file is one JSON object:

```json
{"pid": 4242, "host": "desk", "holder": "klayboy render", "since": "2026-11-14T10:00:00.000Z"}
```

`pid` and `host` are required: the process that holds the lock and `os.hostname()` of its machine. `holder` and `since` are what the worker prints when it waits. Another tool takes the same lock in three steps:

1. Create the file exclusively, failing when it exists (`O_CREAT | O_EXCL`, Node's `{ flag: "wx" }`, `set -o noclobber` in a POSIX shell), and write the object into it.
2. When the file exists, read it. It is stale when its `host` is this machine and no process `pid` is running; a stale file may be deleted and the create tried again. Anything else is held, including a file that is empty or not valid JSON, which may be a lock being written.
3. Delete the file when done, and only a file that still names your `pid`.

The worker follows the same rules, so a holder that crashed, the worker included, never blocks the next one for longer than it takes to notice the pid is gone.

### hold

`globu-worker hold` takes those steps for a script, so a render job or a commit hook honours `limits.exclusive` without its own lock code:

```bash
globu-worker hold gpu -- npm run render
globu-worker hold gpu,disk --wait 10m -- node scripts/render.mjs --all
```

It takes every named lock, in order, then starts the command with the terminal's input and output, from the current directory and with the same environment. While it runs, a worker cycle on the same machine claims nothing and prints `waiting on gpu (held by globu-worker hold (npm run render), pid 4242 on desk since ...)`. When the command ends the locks are deleted and `hold` exits with the command's exit code, or with 128 plus the signal's number when a signal ended it, as a shell does. Its own messages go to the error output, so the command's output stays as it was.

- **A held lock.** Without `--wait`, `hold` fails at once with exit code 75 and says who holds it: `could not take gpu (held by globu-worker, pid 4242 on desk since ...)`. `--wait 30s`, `5m` or `1h` tries again every second for up to that long, saying `waiting on ...` once per holder, and then fails the same way. Locks taken before the held one are given back while it waits.
- **A command that cannot start** fails with exit code 127, `could not start <command>: not found on PATH`, and the locks are given back.
- **Signals.** `SIGTERM` and `SIGHUP` are passed on to the command and `hold` waits for it to end before it deletes the locks, so the resource stays taken while the command shuts down. `SIGINT` is not passed on, since Ctrl+C in a terminal already reaches the whole foreground process group, the command included; a second copy would make some programs quit without cleaning up. A signal while waiting for a lock stops the wait without running the command. On Windows nothing is passed on: the console sends Ctrl+C to every process attached to it, and Node can only kill a process there, which would end the `cmd.exe` of a `.cmd` shim and leave the program it started running.
- **A crash.** A `hold` that is killed outright leaves its lock files behind, and they go stale by pid and host as above, so the next taker deletes them. The command may outlive it, and is then no longer covered by a lock.
- **Nested holds.** Every command the worker starts, and every command `hold` starts, gets `GLOBU_LOCK_PIDS` with the pids of the processes above it. A lock whose pid is in that list and whose host is this machine counts as already held, so a commit hook wrapped in `hold gpu` runs inside a worker run that holds `gpu`, or inside another `hold gpu`, instead of waiting on its own parent. A worker started inside `hold` applies the same rule to its own `limits.exclusive`, so `globu-worker hold gpu -- globu-worker once` runs its cycle under the lock of the `hold` around it. Such a lock belongs to the process that took it: it is left alone at the end and never deleted by a process below. A process never counts its own pid as one above it, and the commands it starts get the list with its own pid added.
- **Windows.** The command starts through the same cross-spawn helper as the worker's own commands, so `npm` and other `.cmd` shims start as they do in a shell.

## The subscription limit

When Claude authenticates with the owner's own subscription, a login in the worker's Claude config dir or `CLAUDE_CODE_OAUTH_TOKEN`, the runs draw on the same usage windows as the owner's interactive sessions. A night of runs can use up the five-hour window and lock the owner out of their own sessions until it resets, and the seven-day window can go the same way over a week.

The `claude -p` stream then carries `rate_limit_event` lines. The worker reads every window they report, each with its utilization and the time it resets (`unifiedWindows` in the event, or the single window named by `rateLimitType`), keeps the latest figure per window in `subscription.json` in its home and counts a window the event marks `rejected` as full. Before each cycle it compares the windows that have not reset yet with `limits.subscription`: when one is at the limit or past it, the cycle claims and repairs nothing and says `subscription limit reached: the subscription's five-hour window is at 72 %, the limit is 70 %, it resets at 2026-11-14 18:00 UTC, claiming nothing`. Polling goes on, and the first cycle after the reset claims again. Several windows past the limit hold until the last of them resets. `why` names the limit among the holds and the `start` footer shows the figures next to today's spend.

The figure is only as fresh as the last run, since nothing else reports it: the owner's interactive use between runs is not seen until the next run's stream. The default of 70 % leaves that use room. While `ANTHROPIC_API_KEY` is set the runs bill the API, and the worker ignores the figures it kept.

## Notifications

Nothing in Jira or GitHub tells the owner of the machine that a run ended. `notify.command` is run on four events:

| Event | When | `GLOBU_URL` |
|---|---|---|
| `handed-back` | A run opened its pull requests | The first pull request |
| `released` | A run gave its issue back, for any reason but a machine problem | The issue in Jira |
| `needs-human` | The last allowed repair of a pull request failed | The pull request |
| `stopped` | The `run` loop or `start --mode auto` stopped for a [machine problem](#a-run) | The issue whose run found it |

The command runs with the same shell as `setup` (`sh -c`, Git's `sh` on Windows), in the worker's home, and gets the event, the issue key and the URL as `$1`, `$2` and `$3` and as `GLOBU_EVENT`, `GLOBU_ISSUE` and `GLOBU_URL`, with a line for a person in `GLOBU_MESSAGE`, such as `MR-7 handed back: https://github.com/acme/backend/pull/3` or `MR-8 released: the run made no commits`. Its environment is the worker's without the Jira, GitHub and Claude secrets; a token the command needs can go into `secrets.env` under a name of its own, which passes through. A command that fails, cannot start or outlasts `notify.timeout` is logged as `notify failed` with the reason and never stops the worker. Runs driven from a session never notify, since a person is already in them.

[ntfy](https://ntfy.sh) sends a push notification to a phone subscribed to a topic; the `Click` header opens the URL:

```yaml
notify:
  command: >-
    curl -s -H "Title: $GLOBU_ISSUE $GLOBU_EVENT" -H "Click: $GLOBU_URL"
    -d "$GLOBU_MESSAGE" https://ntfy.sh/acme-agent
```

A [Home Assistant webhook](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger) triggers an automation, which can notify a phone, flash a light or log the event. The automation reads the fields as `trigger.json.event`, `trigger.json.issue` and `trigger.json.url`:

```yaml
notify:
  command: >-
    curl -s -X POST -H "Content-Type: application/json"
    -d "{\"event\": \"$1\", \"issue\": \"$2\", \"url\": \"$3\"}"
    http://homeassistant.local:8123/api/webhook/globu-worker
```

A longer command is better kept in a script next to `worker.yaml`, such as `command: ./notify.sh`, since the command runs in the worker's home.

## From a session

`once` and `run` start Claude headless. `poll`, `claim`, `finish` and `release` leave the implementing to a Claude Code session, which is the same run with a person in it: the binary does the deterministic steps and the session, or a subagent it starts, does the work of the `issue-deliver` skill in the prepared worktree. The `issue-work` and `issue-watch` skills in the plugin drive these four commands; [plugin skills](./skills.md) describes them.

The four session commands use the session's own Globu home, `~/.globu` unless `GLOBU_HOME` is set, with its own `worker.yaml` and `runs` directory, and never the headless worker's home. The shards they deliver to are the person's registered checkouts, which must be editable and not in `read` mode, and the issue is claimed as the person whose `JIRA_EMAIL` and `JIRA_API_TOKEN` are in the environment. A run made by `claim` has `driver: session` in its record, its footer names the session instead of turns and cost, and it is not reconciled by anything: a run left prepared is given back with `release`.

## A run

1. **Reconcile.** Runs left in a non-final state by a crash or a restart are closed: their worktrees are removed and, when the issue is still assigned to the worker in the claimed status, it is released with a comment saying so. Then settled runs beyond `limits.keepRuns` are deleted, each `claude.jsonl` with them, once the merges among them are in `merged.json`.
2. **Poll.** The JQL, in the order the team wrote it, with issues that carry `jira.priorityLabel` moved to the front. Up to `limits.concurrent` issues are taken, skipping an issue already assigned, an issue that [waits](#issues-that-wait) on a blocker and an issue whose shard already has `limits.perShard` runs this cycle.
3. **Claim.** Take the [exclusive resources](#exclusive-resources) before the first claim of the cycle; while another process holds one, claim nothing and say `waiting on <resource> (...)`. Then assign to the worker's own account, transition to the `claimedStatus` of the issue's project, read the issue back. If someone else got there first, drop it without a word.
4. **Find the target.** The repository marker names a shard. Not a deliverable shard: release.
5. **Resolve.** Shard-qualified refs such as `product/docs/decisions/012-pricing.md` and code host links to files in a shard's repo are checked with the same code as `globu resolve`, after a fetch. One missing: release, with the resolver's report and its candidates in the comment, before a token is spent. Bare paths in backticks are resolved too but only reported in the brief, since they may be files the change creates.
6. **Prepare.** A fetch of the target clone and the companions; a repository with no commits on its default branch releases the issue, since there is nothing to branch from and no base for a pull request. Then a worktree of the target clone on a fresh branch from the default branch, one more for each companion shard. The worktrees sit under `runs/<run-id>`, outside every repository; the session view still maps them to their shards through the git common directory, so the guard treats the target as the run's home and every other shard as foreign. Then the `setup` commands of each worktree's shard; a failing one releases the issue.
7. **Brief.** `brief.md` holds the issue under a heading that says it is untrusted input. Its description and comments are read from Jira's v3 API as Atlassian Document Format and converted to Markdown (headings, lists, code, links, mentions, emphasis and tables; anything else as its text), so a path written as code in Jira reaches the brief in backticks and step 5 finds it. Then come the resolved references with their locations on this machine, the issue's status and labels, the issues it is blocked by with their status and the worker's pull requests for them, its other linked issues with the relation and their status, the worktrees and the handback path. The worker's own release comments are left out of the comments and summed up as "Earlier attempts", with the count and the last reason. The Bash rules come next: the allowed prefixes, one command per call, and `git stash` denied because the stash is shared with every other worktree of the clone, so a work-in-progress commit is the way to set work aside. It says that the worker owns the tracker and the pull requests: the run must not move the issue, comment on it or create issues, even when the target repository's own instructions ask for that, since it has no tracker access. Work that should become an issue of its own goes into a `## Follow-ups` section of the handback, one bullet per follow-up with its summary on the first line, which reaches the issue with the handback comment and, with `jira.followUps` set, becomes [issues](#follow-up-issues) of their own.
8. **Run.** From the worktree root: `claude -p "Implement the issue described in <brief> with the issue-deliver skill. Write the handback to <handback>." --permission-mode dontAsk --allowedTools <claude.allowedTools> --disallowedTools "Bash(git push*)" "Bash(git stash*)" "Bash(gh *)" "Bash(curl *)" "Bash(wget *)" --add-dir <run dir> --max-turns N --max-budget-usd X --output-format stream-json --verbose`, plus `--model` and `--plugin-dir` when configured. The disallowed five are not configurable: four keep the run from acting as the courier, and `git stash` keeps parallel runs of one clone out of each other's stash. The stream goes to `claude.jsonl`. `--add-dir` is what lets the run write the handback outside the repository.
9. **Collect.** Cost, turns and the end state from the stream. Every failed tool call that carries the guard's `shard "<id>"` wording is recorded as a blocked write. The result's `permission_denials`, the calls `--allowedTools` refused, go to `denied` in `run.json`, and its `duration_ms` and `duration_api_ms` to `durationMs` and `apiMs`, so the time a commit hook or a test run takes shows next to the model's. Commits on the branch are counted.
10. **Decide.** Timed out, stopped at the turn cap or no commits: release, with the reason. Otherwise push each branch with commits over https with `GH_TOKEN`, open a pull request with `gh pr create`, a draft when `github.draft` is set, whose body is the handback plus the run footer, file the handback's [follow-ups](#follow-up-issues) when `jira.followUps` is set, comment on the issue with the handback, the follow-up keys and the pull request links, add each pull request as a remote link and leave the issue in `claimedStatus` for the reviewer.
11. **Clean up.** Symbolic links and junctions in each worktree are deleted first, without following them, since npm workspaces on Windows link `node_modules` into the tree as junctions that `git worktree remove --force` leaves behind. Then the worktree is removed, whatever is left of its directory deleted and unpushed branches deleted; the run directory is kept until `limits.keepRuns` prunes it. Once every run of the cycle has ended, the exclusive locks are deleted. `check` warns about a `runs/<run-id>/tree` left behind by a run in a final state.

A release moves the issue back to `releasedStatus`, unassigns it, adds `blockedLabel` and comments with the reason. The worker never retries on its own. A person fixes the issue and runs `retry <key>`, which removes the label and takes the issue at once, or removes the label by hand and waits for the next poll. `why <key>` says what still keeps an issue out.

A problem of the machine is not the issue's fault: the setup shell is missing, or a setup command or `claude` cannot start at all. Such a release says "could not start `<program>`: not found on PATH" rather than an exit code, does not add `blockedLabel`, says on the issue that the machine needs fixing and sets `environment: true` in `run.json`. The `run` loop and `start --mode auto` then stop, since every next issue would fail the same way, and [notify](#notifications) `stopped`; once the machine is fixed, starting the worker again takes the issue up on the next poll. A failed repair for that reason does not count against `limits.repairs`.

Every footer, in the pull request body and in the Jira comment, names the run id, the Jira account and GitHub login the worker acted as, turns, cost, wall time with the part of it spent in the model API, the blocked writes and the denied tool calls, each listed on a line of its own. A run driven from a session names the session instead of the turns, the cost and the blocked writes, which only the headless stream can count. Until Atlassian ships agent identities a run acts as whoever holds the tokens, and the footer records which identity that was.

## Following its pull requests

A handed-back run stays the worker's business until its pull requests are merged or closed. At the start of every automatic cycle, before it looks for new issues, the worker reads each open pull request of its handed-back runs with `gh pr view` and acts on what it finds:

- **Merged**, all of the run's pull requests: the issue moves to `jira.doneStatus` when one is set and gets a comment either way, and its key goes into `merged.json` with the run's pull requests. The branch of each merged pull request is deleted on the remote with `git push origin --delete` and `GH_TOKEN`, unless the repository already deleted it on merge, then in the shard's clone, and the clone is fetched with `--prune`. Only the run's own branch is deleted: a pull request whose head is another branch keeps it. A deletion that fails, for a token that may not delete branches say, is logged as a warning and changes nothing else. **Closed** without a merge: a comment, nothing more, and the branch stays. Either way the run is settled and no longer followed.
- **Conflicting**, or **failing checks**, with repairs left: a repair run. The worker adds a worktree on the pull request branch, reset to the remote, and merges `origin/<base>` into it. If that merges cleanly and the checks were not failing, it pushes the merge commit with no Claude involved. Otherwise it runs the shard's `setup` commands and `claude -p` with a repair brief, `brief.md` in the repair's run directory, listing the conflicted files, the failing checks with their links and where the original brief and handback are. Claude resolves, runs the tests and commits; the worker checks that nothing is left conflicted and the merge is committed, then pushes. Merge only: the worker never rebases and never force-pushes, so review comments stay attached.
- **Behind** the base branch without a conflict, or still **in review**: nothing. Keeping a branch current is a merge queue's job, or GitHub's update branch.

Each repair is a run of its own, with an id of the form `<KEY>-repair-<attempt>-<time>`, `repairOf` naming the run it repairs, its cost counted against `limits.dayUsd` and its own `repair` and `repaired` or `repair failed` log events. It comments on the pull request and the issue whatever the outcome. Only failed repairs count against `limits.repairs`, since a pull request on a busy base branch may need several good ones. After that many failures the pull request is handed to a person: a comment saying so, the label `needs-human` on the pull request when the repository has it, and no further repair unless `once --repair` asks for one.

Then the cap: with `limits.openPullRequests` or more pull requests open, conflicted and needing a person included, the cycle claims nothing and says `holding new issues`. The cap bounds how many branches can drift apart at once, so the number of conflicts stays small and review shows up as the bottleneck it is. `once --issue` and Enter in pick mode are deliberate and ignore the cap.

Merging stays with people. A merge queue, or GitHub's auto-merge with required checks, is the natural partner: it lands approved pull requests in order and tests each on top of the ones ahead of it, which catches the conflicts that only show when two changes meet.

## Follow-up issues

The brief asks the run to put work that should become an issue of its own into a `## Follow-ups` section of the handback, one bullet per follow-up: the first line of a bullet is the summary and its further lines, indented, the description. Without `jira.followUps` the section reaches the issue only inside the handback comment. With `jira.followUps.issueType` set, the worker files each bullet when it hands back, after the pull requests are open:

- in the original issue's project, the part of its key before the hyphen, with the configured issue type, by name or by id;
- with the bullet's further lines as the description, followed by a line naming the original issue and the run;
- linked to the original with `jira.followUps.linkType`, `Relates` by default, which Jira shows as "relates to". The original is the link's inward issue and the follow-up its outward one.

The handback comment lists the new keys under "Follow-up issues", above the pull request links, and `run.json` keeps them as `followUpIssues`. The pull request body stays the handback as the run wrote it. A run driven from a session through `finish` files its follow-ups the same way.

The section is the level-two heading `Follow-ups` (or `Followups` or `Follow ups`, in any case) up to the next heading of level one or two. A bullet is a line that starts with `-`, `*` or `+`; the lines indented under it, nested lists and code blocks included, are its description, and a blank line followed by text that is not indented ends it. Text outside the bullets is ignored, and a bullet that reads only `None`, `Nothing` or `n/a` files nothing. A summary longer than Jira's 255 characters is cut, and the whole line opens the description.

A follow-up is never marked for the worker: it gets no `jira.eligibleLabel`, no repository marker, no assignee and no transition, so a person decides whether and where it is delivered, with `delegate` for one. Keep the eligibility label in `jira.jql`: a JQL without it could match a follow-up in its project's first status, and the worker would then release it for a missing repository marker.

Filing never fails the run. An issue Jira refuses to create, a link it refuses, a project that an `issueType` map has no entry or default for and the bullets past `jira.followUps.max` are each listed in the comment with the reason, such as `- not created: Rename the flag (Jira POST /issue failed: 400 ...)` or `- MR-12: Rename the flag (not linked: ...)`, and logged as `follow-up failed` at `warn`; each one filed is logged as `follow-up filed` at `info`. The issue is handed back either way. The Jira account needs the Create issues and Link issues permissions in the projects the worker serves. The issues are created through REST API v2, so the description is plain text, like the worker's comments.

## Issues that wait

An issue linked as "is blocked by" another issue, through a link type in `jira.blockingLinks`, waits until every such blocker is resolved. JQL cannot say "no open blocker" without a Jira app, so the worker reads the links of each issue the JQL returns. A blocker is resolved when its status is in Jira's Done category, or when one of the worker's own runs for it has its pull requests merged; the second keeps a chain moving when `jira.doneStatus` is not set. A waiting issue is listed as `waiting on <key> (<status>)` and takes no slot, so the cycle goes on to the next issue. `once --issue` runs it anyway, and in pick mode it is a gray row that cannot be selected.

That makes delivery sequential: with A blocking B and both matching the JQL, a cycle claims A. Once A's pull request is merged the follow-ups above settle it, and the next cycle claims B, built on a default branch that has A, with A and its pull request named in B's brief. How fast the chain moves depends on the merges: with GitHub's auto-merge and required checks it moves without a person.

The merges are kept in `merged.json` in the worker's home, one entry per issue key with the pull requests and the time the worker saw the merge, written when the follow-ups settle a merged run. `limits.keepRuns` never prunes it, so a long chain keeps moving after the run of its first issue is deleted. A home from before the index is seeded from its run records the first time the worker writes the index, dated by when each `run.json` was last written, and until then the run records are read directly; nothing is lost on an upgrade. A merged run that is still in `runs` counts as well, so deleting `merged.json` by hand forgets only the issues whose runs are already pruned. The brief names the pull requests from the index too.

A blocker the worker's Jira account cannot see is left out of the links by Jira and does not hold anything up. A cycle of links holds both issues; each row says what it waits on. Branching B from A's pull request before it merges, stacked pull requests, is not supported.

## What the guard does in a run

Nothing new. The run's working directory is a worktree of the target shard, so writes there are free. Every other shard in the worker's `state.yaml` is a read-only clone, so a certain write is blocked and a possible one raises `ask`, which a run with nobody to answer turns into a denial. Companion shards are in `write` mode in the worker's own state, which is harmless because that state belongs to the worker alone, and their edits land on a branch through the worktree. The limits of reading shell commands in [architecture](./architecture.md#shell-commands-in-the-guard) apply: the guard lowers the odds of an unnoticed write to a sibling repository and the footer reports the ones it caught. It is not a sandbox.

## Logs and diagnostics

The worker writes `logs/worker-YYYY-MM-DD.log` in its home, one JSON object per line with `time`, `level` and `msg`, plus `run` and other fields where they apply. `--log-level` or `GLOBU_LOG_LEVEL` picks `error`, `warn`, `info` (the default) or `debug`. `info` records each cycle, claim, setup command, run start, release and handback; `warn` the day cap and failed checks; `error` a failed cycle or release. `debug` adds every command the worker runs (git, gh, claude, setup) with its arguments, working directory, exit code, duration and the last lines of stderr, every Jira call with its method, path, status and duration, and every check. Before a line is written, each secret value from the environment and `secrets.env` and every git `extraheader` is replaced with `[redacted]`.

To look at a run on another machine, run `globu-worker --log-level debug start` there, reproduce, then `globu-worker diagnostics` and bring the archive back.

## Running it

By hand, `globu-worker start` in a terminal. As a service, `globu-worker start --mode auto` or `globu-worker run`; on a Mac under launchd, with the secrets in the job's environment or in `secrets.env`. In a container, a Cloud Run job or a cron entry runs the bootstrap against an empty `GLOBU_HOME` and then `globu-worker once`; a second invocation while one is running finds the issues already claimed and does nothing. No endpoint is exposed, because the trigger is the poll. Two workers on one Jira project are not supported: the claim is a read-back after assign and transition, which is enough for one.

What the consuming project needs in Jira: a status a person moves an issue into as the act of delegation, an eligibility label, the blocked label in the JQL and a repository marker per issue. `delegate` sets the label and the marker from a terminal. The Claude Code behaviours the worker relies on and which were tested are in the [hook contract](./claude-code-hooks.md).

### On Windows

The worker runs on Windows with Git for Windows, Node and `claude`, installed natively or through npm; commands installed as `.cmd` shims, such as `npm`, `claude` or `gh`, are started through `cmd.exe` with their arguments escaped for it. Things to set up before the first real run:

- **The setup shell.** Git for Windows puts `sh.exe` in its `bin` directory, which is not on `PATH` by default. The worker finds it next to the `git` that is on `PATH` (`<Git>\cmd\git.exe` or `<Git>\bin\git.exe` gives `<Git>\bin\sh.exe`); `check` fails when it cannot.
- **Private repositories.** `GLOBU_GIT_TOKEN` in `secrets.env`, or for `github.com` a `GH_TOKEN` that can read them. Without one, git fails at once instead of waiting on Git Credential Manager's prompt, and `check` names what is missing.
- **Long paths.** Worktrees sit under `runs\<run-id>\tree`, and a `node_modules` below that can pass the 260-character limit. `git config --global core.longpaths true`, and Windows' own long path setting for the tools that run in setup; `check` notes when the git setting is off.
- **`secrets.env`** needs no `chmod`: NTFS has no POSIX mode bits, so the worker does not warn about them.
- **Finding programs.** In PowerShell `where` is `Where-Object`; use `where.exe git` or `Get-Command git` to see which `git`, `sh` or `claude` is on `PATH`.
- **`diagnostics`** runs `tar` in the directory of the archive and names the archive without its drive, since the GNU `tar` that Git for Windows can put on `PATH` reads `C:\...` as a remote host.

The test suite runs on a Windows runner in CI, see [tests on Windows](./development.md#tests-on-windows).
