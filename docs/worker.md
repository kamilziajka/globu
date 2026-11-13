---
type: "Reference"
title: "globu-worker"
description: "The worker that claims agent-eligible Jira issues and runs Claude Code in the right shard: its homes, worker.yaml and secrets.env, the start, check, once, run and diagnostics commands, logs and a run step by step."
---

# globu-worker

`globu-worker` turns a Jira transition into a pull request. It polls a Jira project for issues a person has marked ready for an agent, claims one, runs Claude Code headless in a worktree of the issue's repository with Globu's index and guard in place, pushes the branch, opens a draft pull request and reports back on the issue. Every merge, production step and product decision stays with people. The worker only refuses issues whose references do not resolve; it never judges whether an issue is simple enough.

It is the third program in this repo, published to npm as `@kazet/globu-worker`, next to the `globu` CLI and the plugin. The registry, the resolver and the hooks know nothing about Jira. The worker knows nothing about implementing issues: that is the `issue-deliver` skill in the plugin, which a person can also run by hand.

## Its own homes

The worker never uses the `~/.globu` and `~/.claude` of the person on the machine. `GLOBU_HOME` defaults to `~/.globu/worker` and `CLAUDE_CONFIG_DIR` to `claude` inside it; either can be set to another directory, and the worker refuses to start when one of them is `~/.globu` or `~/.claude`. Inside `GLOBU_HOME`:

| Path | Holds |
|---|---|
| `manifest.yaml`, `state.yaml`, `clones` | An ordinary Globu home, filled with `globu import`, `register` and `sync` |
| `worker.yaml` | The configuration below |
| `secrets.env` | Optional secrets as `KEY=value` lines, see [secrets](#secrets) |
| `work/<id>` | Editable clones of the shards the worker delivers to, by convention, and where `shards.repos` clones them |
| `logs` | One log file per day, see [logs and diagnostics](#logs-and-diagnostics) |
| `runs/<run-id>` | One directory per run: `run.json`, `brief.md`, `handback.md`, `claude.jsonl` and the pull request bodies. The worktree lives here while the run lasts |

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
  blockedLabel: agent-blocked
  repository:
    labelPrefix: "repo:"
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
```

| Key | Meaning | Default |
|---|---|---|
| `jira.site` | The Jira Cloud site | required |
| `jira.jql` | What is eligible. The worker runs it as written and adds nothing, so the team owns the gate and the order | required |
| `jira.claimedStatus` | The status a claimed issue is moved to, by name or by id: an all-digit value is an id. Transitions are looked up per issue, so a same-named status in another project is never picked | required |
| `jira.releasedStatus` | Where a released issue goes back to, by name or by id | required |
| `jira.doneStatus` | Where an issue goes once all its pull requests are merged, by name or by id. Without it the issue stays in `claimedStatus` and only gets a comment | none |
| `jira.blockedLabel` | Added when the worker gives an issue back, so the JQL above excludes it until a person removes it | `agent-blocked` |
| `jira.repository` | How an issue names its target: `labelPrefix` for a label such as `repo:backend`, or `field: customfield_NNNNN` for a text or option field. The value is a shard id | required |
| `shards.deliverable` | Shards the worker may run in. The repository marker of an issue must name one; anything else is released, so the list is the team's whitelist of repositories the agent delivers to | required |
| `shards.companion` | Shards a run may also write to, each on a worktree of its own with the same branch name, whether or not the issue names them. Commits there become a second pull request. A run never consists of companion changes alone: the deliverable is where it lives and where the per-shard limit counts | none |
| `shards.repos` | Repository URL per shard id. A deliverable or companion shard that is not registered yet is cloned from it into `work/<id>` at start; see [its own homes](#its-own-homes) | none |
| `setup.<shard>` | Commands run with `sh -c`, in order, in each fresh worktree of that shard before Claude starts, such as `npm ci`. They run outside Claude's tool allowlist, with the worker's environment minus the secrets and with `limits.timeout`. One that fails or times out releases the issue with the command and the end of its output | none |
| `poll.every` | The interval of `run`, as `30s`, `5m` or `1h` | `60s` |
| `limits.concurrent`, `limits.perShard` | Runs per cycle and runs per shard per cycle | 1 and 1 |
| `limits.timeout` | The worker kills the run and releases the issue when it lasts longer | `45m` |
| `limits.dayUsd` | When the runs started today have cost this much, the worker keeps polling but claims nothing | 40 |
| `limits.openPullRequests` | With this many of the worker's pull requests open, an automatic cycle claims no new issue; see [following its pull requests](#following-its-pull-requests) | 5 |
| `limits.repairs` | Failed repairs of a pull request before it is handed to a person | 2 |
| `claude.skill` | The skill the run is told to use, the one key under `claude` that is not a flag | `issue-deliver` |
| `claude.model` | Passed as `--model` when set | Claude Code's default |
| `claude.pluginDir` | Passed as `--plugin-dir` when set: the plugin from a checkout of this repo, for a test of an unreleased plugin or a machine without a marketplace | the plugins installed in `CLAUDE_CONFIG_DIR` |
| `claude.maxTurns` | Passed as `--max-turns`. A run that hits it is released | 80 |
| `claude.maxBudgetUsd` | Passed as `--max-budget-usd`. Claude stops at its own estimate, which counts subagents and can overshoot; a run that stopped with commits is still handed back | 5 |
| `claude.allowedTools` | Passed as `--allowedTools`. Everything else is denied, since nobody can answer a prompt | `Read`, `Edit`, `Write`, `Glob`, `Grep`, `npm run`, `npx vitest`, `git status`, `git diff`, `git log`, `git add` and `git commit` through Bash |

Every key under `claude` except `skill` is a `claude -p` flag in camelCase and goes through untouched. `limits` holds what the worker enforces on its own. Claude Code has no settings key for the turn cap or the budget, which is why they are flags here rather than entries in a settings file.
| `git.branchPrefix` | The branch is `<prefix><KEY>-<slug of the summary>` | `agent/` |
| `git.author` | Author and committer of the run's commits. Whether that is a bot or the token holder is the team's attribution call | the clone's git config |
| `github.draft`, `github.labels` | Passed to `gh pr create`: `draft: true` opens draft pull requests instead of ones ready for review. A label must exist in the repository | `false`, none |

## Secrets

Secrets come from the environment or from `secrets.env` in `GLOBU_HOME`, and the environment wins when both name the same variable. The file holds `KEY=value` lines; blank lines, `#` comments, an `export ` prefix and quotes around the value are accepted, a line with an empty value counts as unset, and a line that is not `KEY=value` is reported by its number without its content. The worker warns at start when the file is readable by anyone but its owner (`chmod 600 secrets.env`). `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from the file reach Globu's own clones and fetches too.

The variables: `JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira, `GH_TOKEN` (or `GITHUB_TOKEN`) for the push and `gh`, `GLOBU_GIT_TOKEN` for the clones Globu owns. The Claude process gets none of them: the worker strips `JIRA_EMAIL`, `JIRA_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from its environment and sets `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` to the worker's own. How Claude authenticates is the worker's Claude config dir's business: a login made in that config dir, or `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment or in `secrets.env`. Those two are the only secrets passed on to Claude.

## Commands

| Command | Purpose |
|---|---|
| `start [--mode pick\|auto]` | The way to run the worker by hand: shard bootstrap, `check`, then issues one at a time with a session list. `pick`, the default on a terminal, lists the eligible issues: ↑ and ↓ (or `k` and `j`) move the selection, Enter runs the selected issue, or repairs the selected pull request, and polls again, `r` polls Jira and GitHub again, `q`, Esc or Ctrl+C quits. On a terminal, `globu-worker` without a command runs `start`. Pick mode also polls in the background every `poll.every` and redraws; it never claims or repairs without Enter, but it does move merged issues to `doneStatus`. `auto`, the default without a terminal, is the `run` loop. `limits.concurrent` is held at 1 whatever `worker.yaml` says |
| `check` | Shard bootstrap, then one line per check with `ok` or `FAIL` and exit code 1 on a failure: `worker.yaml` and the secrets load; every deliverable and companion shard has an editable clone; Jira answers for the account and runs the JQL; `gh api user` answers with `GH_TOKEN` and every deliverable repository can be read with it (`git ls-remote`); a one-turn `claude -p` answers in the worker's Claude config dir and lists the configured skill. Jira, GitHub and Claude are checked at the same time; on a terminal each line shows a spinner until its check ends in a green ✔ or a red ✖. The Claude check costs a few cents (about 0.08 USD measured), since a fresh session primes its cache |
| `diagnostics [--out <file>]` | A `.tar.gz` with the log files, every `run.json`, `worker.yaml` and `environment.txt` (worker, Node, OS, `claude`, `git` and `gh` versions), every secret value replaced with `[redacted]`. Never `secrets.env`, a brief, a handback or a Claude stream. Written to `globu-worker-diagnostics-<time>.tar.gz` in the current directory by default |
| `once [--dry-run] [--issue <key>] [--repair <url>] [--json]` | One cycle: poll, claim up to the free slots, run each to the end, exit. `--dry-run` prints what it would claim and why, touching nothing. `--issue` takes that issue instead of polling, also when it is already assigned, which is how a released issue is retried and how the whole path is tested. `--repair` repairs that pull request of the worker now, also when it is past `limits.repairs`. `--json` adds the run records and the plan |
| `run` | Shard bootstrap and `check`, then `once` on the configured interval until `SIGINT` or `SIGTERM`. A failed check stops it before the first cycle. A signal during a cycle lets the cycle finish |
| `poll [--json]` | The dry run of `once`, for a session: what could be claimed now and why, touching nothing |
| `claim <key> [--json]` | Steps 3 to 7 of a run for a session: claim the issue, resolve its references, add the worktrees and write the brief, then stop with the run `prepared` and the worktrees in place. Prints the run directory; `--json` adds the record and the paths of the brief, the tree, the handback and the companions |
| `finish <run-id> [--json]` | Steps 10 and 11 for a prepared run: push the worktrees that have commits, open the pull requests, comment on the issue and remove the worktrees. A run without commits is released with that reason |
| `release <run-id> --reason <text> [--json]` | Give a prepared run's issue back with that reason and remove its worktrees |

Every command takes `--log-level` before its name, as in `globu-worker --log-level debug start`.

`start` shows no Claude output. On a terminal it redraws a table after every change: under the title a gray line keeps the checks in view with what each resolved to (the Jira user, the GitHub login, the Claude model, the shards), then key, summary, state and detail per issue, where the state is `available`, `not ready` (a reference is missing), `skipped`, `preparing`, `running` (with its start time), `pushing`, `handed back` (with the pull requests) or `released` (with the reason), and below it today's spend against `limits.dayUsd` and the keys. In pick mode the selected issue has a green ● and green text, the other available ones a gray ○, and the rest are gray. Without a terminal it prints one line per state change, `<time> <key> <state>: <detail>`, which reads well in a service log. The worker's open pull requests are listed first, as `<KEY> #<number>`, with `conflict`, `checks failing` and `needs human` in red; the first two are pickable while repairs are left. The footer counts the open pull requests against `limits.openPullRequests` and how many need a fix.

`once` prints one line per issue it looked at (`claimed`, `skipped, already assigned`, `skipped, backend has a run already`, `skipped, claimed by someone else`, or in a dry run `would claim and run in backend (2 references resolved)` and `would release: ...`) and one line per run with its final state, its reason when released and its pull requests when handed back. The exit code is 0 whenever the cycle ran; a released issue is not an error of the worker.

## From a session

`once` and `run` start Claude headless. `poll`, `claim`, `finish` and `release` leave the implementing to a Claude Code session, which is the same run with a person in it: the binary does the deterministic steps and the session, or a subagent it starts, does the work of the `issue-deliver` skill in the prepared worktree. The `issue-work` and `issue-watch` skills in the plugin drive these four commands; [plugin skills](./skills.md) describes them.

The four session commands use the session's own Globu home, `~/.globu` unless `GLOBU_HOME` is set, with its own `worker.yaml` and `runs` directory, and never the headless worker's home. The shards they deliver to are the person's registered checkouts, which must be editable and not in `read` mode, and the issue is claimed as the person whose `JIRA_EMAIL` and `JIRA_API_TOKEN` are in the environment. A run made by `claim` has `driver: session` in its record, its footer names the session instead of turns and cost, and it is not reconciled by anything: a run left prepared is given back with `release`.

## A run

1. **Reconcile.** Runs left in a non-final state by a crash or a restart are closed: their worktrees are removed and, when the issue is still assigned to the worker in the claimed status, it is released with a comment saying so.
2. **Poll.** The JQL, oldest first as the team wrote it. Up to `limits.concurrent` issues are taken, skipping an issue already assigned and an issue whose shard already has `limits.perShard` runs this cycle.
3. **Claim.** Assign to the worker's own account, transition to `claimedStatus`, read the issue back. If someone else got there first, drop it without a word.
4. **Find the target.** The repository marker names a shard. Not a deliverable shard: release.
5. **Resolve.** Shard-qualified refs such as `product/docs/decisions/012-pricing.md` and code host links to files in a shard's repo are checked with the same code as `globu resolve`, after a fetch. One missing: release, with the resolver's report and its candidates in the comment, before a token is spent. Bare paths in backticks are resolved too but only reported in the brief, since they may be files the change creates.
6. **Prepare.** A fetch of the target clone and the companions; a repository with no commits on its default branch releases the issue, since there is nothing to branch from and no base for a pull request. Then a worktree of the target clone on a fresh branch from the default branch, one more for each companion shard. The worktrees sit under `runs/<run-id>`, outside every repository; the session view still maps them to their shards through the git common directory, so the guard treats the target as the run's home and every other shard as foreign. Then the `setup` commands of each worktree's shard; a failing one releases the issue.
7. **Brief.** `brief.md` holds the issue as Jira returned it under a heading that says it is untrusted input, the resolved references with their locations on this machine, the worktrees and the handback path.
8. **Run.** From the worktree root: `claude -p "Implement the issue described in <brief> with the issue-deliver skill. Write the handback to <handback>." --permission-mode dontAsk --allowedTools <claude.allowedTools> --disallowedTools "Bash(git push*)" "Bash(gh *)" "Bash(curl *)" "Bash(wget *)" --add-dir <run dir> --max-turns N --max-budget-usd X --output-format stream-json --verbose`, plus `--model` and `--plugin-dir` when configured. The disallowed four keep the run from acting as the courier and are not configurable. The stream goes to `claude.jsonl`. `--add-dir` is what lets the run write the handback outside the repository.
9. **Collect.** Cost, turns and the end state from the stream. Every failed tool call that carries the guard's `shard "<id>"` wording is recorded as a blocked write. Commits on the branch are counted.
10. **Decide.** Timed out, stopped at the turn cap or no commits: release, with the reason. Otherwise push each branch with commits over https with `GH_TOKEN`, open a pull request with `gh pr create`, a draft when `github.draft` is set, whose body is the handback plus the run footer, comment on the issue with the handback and the pull request links, add each pull request as a remote link and leave the issue in `claimedStatus` for the reviewer.
11. **Clean up.** Worktrees are removed, unpushed branches deleted, the run directory kept.

A release moves the issue back to `releasedStatus`, unassigns it, adds `blockedLabel` and comments with the reason. The worker never retries on its own. A person fixes the issue, removes the label and either waits for the next poll or runs `once --issue <key>`.

Every footer, in the pull request body and in the Jira comment, names the run id, the Jira account and GitHub login the worker acted as, turns, cost, wall time and the blocked writes. A run driven from a session names the session instead of the turns, the cost and the blocked writes, which only the headless stream can count. Until Atlassian ships agent identities a run acts as whoever holds the tokens, and the footer records which identity that was.

## Following its pull requests

A handed-back run stays the worker's business until its pull requests are merged or closed. At the start of every automatic cycle, before it looks for new issues, the worker reads each open pull request of its handed-back runs with `gh pr view` and acts on what it finds:

- **Merged**, all of the run's pull requests: the issue moves to `jira.doneStatus` when one is set and gets a comment either way. **Closed** without a merge: a comment, nothing more. Either way the run is settled and no longer followed.
- **Conflicting**, or **failing checks**, with repairs left: a repair run. The worker adds a worktree on the pull request branch, reset to the remote, and merges `origin/<base>` into it. If that merges cleanly and the checks were not failing, it pushes the merge commit with no Claude involved. Otherwise it runs the shard's `setup` commands and `claude -p` with a repair brief, `brief.md` in the repair's run directory, listing the conflicted files, the failing checks with their links and where the original brief and handback are. Claude resolves, runs the tests and commits; the worker checks that nothing is left conflicted and the merge is committed, then pushes. Merge only: the worker never rebases and never force-pushes, so review comments stay attached.
- **Behind** the base branch without a conflict, or still **in review**: nothing. Keeping a branch current is a merge queue's job, or GitHub's update branch.

Each repair is a run of its own, with an id of the form `<KEY>-repair-<attempt>-<time>`, `repairOf` naming the run it repairs, its cost counted against `limits.dayUsd` and its own `repair` and `repaired` or `repair failed` log events. It comments on the pull request and the issue whatever the outcome. Only failed repairs count against `limits.repairs`, since a pull request on a busy base branch may need several good ones. After that many failures the pull request is handed to a person: a comment saying so, the label `needs-human` on the pull request when the repository has it, and no further repair unless `once --repair` asks for one.

Then the cap: with `limits.openPullRequests` or more pull requests open, conflicted and needing a person included, the cycle claims nothing and says `holding new issues`. The cap bounds how many branches can drift apart at once, so the number of conflicts stays small and review shows up as the bottleneck it is. `once --issue` and Enter in pick mode are deliberate and ignore the cap.

Merging stays with people. A merge queue, or GitHub's auto-merge with required checks, is the natural partner: it lands approved pull requests in order and tests each on top of the ones ahead of it, which catches the conflicts that only show when two changes meet.

## What the guard does in a run

Nothing new. The run's working directory is a worktree of the target shard, so writes there are free. Every other shard in the worker's `state.yaml` is a read-only clone, so a certain write is blocked and a possible one raises `ask`, which a run with nobody to answer turns into a denial. Companion shards are in `write` mode in the worker's own state, which is harmless because that state belongs to the worker alone, and their edits land on a branch through the worktree. The limits of reading shell commands in [architecture](./architecture.md#shell-commands-in-the-guard) apply: the guard lowers the odds of an unnoticed write to a sibling repository and the footer reports the ones it caught. It is not a sandbox.

## Logs and diagnostics

The worker writes `logs/worker-YYYY-MM-DD.log` in its home, one JSON object per line with `time`, `level` and `msg`, plus `run` and other fields where they apply. `--log-level` or `GLOBU_LOG_LEVEL` picks `error`, `warn`, `info` (the default) or `debug`. `info` records each cycle, claim, setup command, run start, release and handback; `warn` the day cap and failed checks; `error` a failed cycle or release. `debug` adds every command the worker runs (git, gh, claude, setup) with its arguments, working directory, exit code, duration and the last lines of stderr, every Jira call with its method, path, status and duration, and every check. Before a line is written, each secret value from the environment and `secrets.env` and every git `extraheader` is replaced with `[redacted]`.

To look at a run on another machine, run `globu-worker --log-level debug start` there, reproduce, then `globu-worker diagnostics` and bring the archive back.

## Running it

By hand, `globu-worker start` in a terminal. As a service, `globu-worker start --mode auto` or `globu-worker run`; on a Mac under launchd, with the secrets in the job's environment or in `secrets.env`. In a container, a Cloud Run job or a cron entry runs the bootstrap against an empty `GLOBU_HOME` and then `globu-worker once`; a second invocation while one is running finds the issues already claimed and does nothing. No endpoint is exposed, because the trigger is the poll. Two workers on one Jira project are not supported: the claim is a read-back after assign and transition, which is enough for one.

What the consuming project needs in Jira: a status a person moves an issue into as the act of delegation, an eligibility label, the blocked label in the JQL and a repository marker per issue. The Claude Code behaviours the worker relies on and which were tested are in the [hook contract](./claude-code-hooks.md).
