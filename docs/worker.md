---
type: "Reference"
title: "globu-worker"
description: "The worker that claims agent-eligible Jira issues and runs Claude Code in the right shard: projects, worker.yaml, its commands, limits, locks, follow-ups and a run"
---

# globu-worker

`globu-worker` turns a Jira transition into a pull request. It polls a Jira project for issues a person has marked ready for an agent, claims one, runs Claude Code headless in a worktree of the issue's repository with Globu's index and guard in place, pushes the branch, opens a draft pull request and reports back on the issue. Every merge, production step and product decision stays with people. The worker only refuses issues whose references do not resolve; it never judges whether an issue is simple enough.

It is the third program in this repo, published to npm as `@kazet/globu-worker`, next to the `globu` CLI and the plugin. The registry, the resolver and the hooks know nothing about Jira. The worker knows nothing about implementing issues: that is the `issue-deliver` skill in the plugin, which a person can also run by hand.

This page follows the `main` branch and can describe what is not released yet. The docs of each released version are on [globu.kazet.blog](https://globu.kazet.blog), and `globu-worker --version` says which one is installed.

## Its own homes

By default the worker never uses the `~/.globu` and `~/.claude` of the person on the machine. `GLOBU_HOME` defaults to `~/.globu/worker` and `CLAUDE_CONFIG_DIR` to `claude` inside it; either can be set to another directory, and the worker refuses to start when one of them is `~/.globu` or `~/.claude`. The one exception is opted into: `claude.configDir: user` runs Claude in the person's own `~/.claude`, see [the user's Claude home](#the-users-claude-home). Inside `GLOBU_HOME`:

| Path | Holds |
|---|---|
| `manifest.yaml`, `state.yaml`, `clones` | An ordinary Globu home, filled with `globu import`, `register` and `sync` |
| `worker.yaml` | The configuration below |
| `secrets.env` | Optional secrets as `KEY=value` lines, see [secrets](#secrets) |
| `work/<id>` | Editable clones of the shards the worker delivers to, by convention, and where the worker clones a project's shard that has none |
| `worker.lock` | Held by the command that cycles on this home, see [one process per home](#one-process-per-home) |
| `subscription.json` | The latest subscription figures from the runs' streams, see [the subscription limit](#the-subscription-limit) |
| `merged.json` | Every issue whose run had its pull requests merged, with those pull requests and the merge time, so a pruned run still resolves the issues it [blocks](#issues-that-wait) |
| `bin` | `globu` and `globu.cmd`, the launchers each Claude run finds first on its `PATH`, see [a run](#a-run) |
| `followups.json` | The [follow-up issues](#follow-up-issues) filed for an issue whose handback comment has not been posted yet, so a later attempt reuses them instead of filing them again |
| `logs` | One log file per day, see [logs and diagnostics](#logs-and-diagnostics) |
| `runs/<run-id>` | One directory per run: `run.json`, `brief.md`, `handback.md`, `claude.jsonl` and the pull request bodies. The worktree lives here while the run lasts. Only the newest `limits.keepRuns` runs and the ones still in use are kept, see [a run](#a-run) |

The shortest setup is a manifest with the projects and their shards, imported from a team manifest or copied from another machine. At the start of `once`, `run`, `start` and `check` the worker clones every shard of a served project that has no clone yet from the manifest's `source.repo` into `work/<id>`, as an editable clone in `write` mode, and writes their directories into its Claude settings. A shard that already has a clone is left alone, and a shard with `access: read` is not cloned by the worker: `globu sync` clones it read-only.

The longer setup is the bootstrap from [unattended runs](./unattended-runs.md) with one more step, the editable clones, and it is the one to use when the shards come from a team manifest. The `globu` and `claude` commands below default to the interactive homes, so the two variables are exported for them even when the worker itself runs on its defaults:

```bash
export GLOBU_HOME=~/.globu/worker CLAUDE_CONFIG_DIR=~/.globu/worker/claude
```

```bash
globu import https://github.com/acme/product.git --project team --yes
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

Repeat the `register --path` step for every shard of a served project that the worker should not clone itself. The other shards are cloned read-only by `sync`. Install the plugin into the worker's Claude config dir with `claude plugin marketplace add` and `claude plugin install`, or point `claude.pluginDir` in `worker.yaml` at the plugin in a checkout of this repo, which the unattended runs guide describes as `--plugin-dir`. `globu-worker once` checks before every cycle that each shard of a served project without the read cap has an editable clone that is not read-only, in `write` mode when its project has more than one such shard, and refuses to poll otherwise.

Keeping the homes apart costs a second clone of each repository on a laptop. In return the worker's modes are its own policy, the person's checkouts and worktrees are never touched by a run, and a laptop and a container run the same way. A home nested inside `~/.globu` is still a separate home: nothing in Globu reads a parent directory.

### The user's Claude home

A Claude home of the worker's own has a price on a machine that a person also works on: it needs its own login, its own install of the plugin, which stays behind when the worker is upgraded, and it does not have the person's global `CLAUDE.md`, so a run misses the rules every other session there follows. `claude.configDir` in `worker.yaml` chooses:

| Value | Claude runs in | What that means |
|---|---|---|
| `own`, the default | `<GLOBU_HOME>/claude`, or `CLAUDE_CONFIG_DIR` when set, never `~/.claude` | Nothing of the person's setup reaches a run. The plugin, the login and any `CLAUDE.md` are installed there by hand and kept up to date by hand. Right for a server, a container and CI |
| `user` | `~/.claude`, or `CLAUDE_CONFIG_DIR` when set | A run has the person's login, plugins, global `CLAUDE.md`, hooks and MCP servers. Right for a worker on the desk of the person whose issues it delivers |

`GLOBU_HOME` stays the worker's own under both, with its registry, clones and runs.

With `user`, a run is not held to `claude.allowedTools` alone. Claude Code adds the allow rules of the home's `settings.json` to the `--allowedTools` it is given, also under `--permission-mode dontAsk`, so a rule such as `Bash(npm *)` that the person granted their own sessions is granted to a run as well. The worker's deny list (`git push`, `git stash`, `gh`, `curl`, `wget`) still wins over them, and the guard still keeps writes inside the target shard. `check` names every such rule, so read its `claude` line before the first run and remove what a run should not have.

The worker writes into that home too: the directories of its shards go into `permissions.additionalDirectories` of `settings.json`, next to the person's own, as `globu claude sync` does.

## Configuration

The configuration is in two files, by the rule that separates the manifest from the state: what is true on every machine is in `manifest.yaml`, what is true only here is in `worker.yaml`.

### Projects, in the manifest

A project in `manifest.yaml` groups shards. For the worker it also carries a Jira project key and a `worker` block. The registry, the resolver and the hooks read only `shards`; `jira` and `worker` are parsed by the worker alone, so the sessions on a laptop, the worker on a desktop and a sandbox home can share one definition.

```yaml
projects:
  mercastra:
    shards: [mercastra-*]
    jira: MR
    worker:
      statuses: { ready: Ready for delivery, claimed: Delivery, released: To Do, done: Done }
      filter: component = API AND type != Epic
      followUps: { issueType: Task }
      setup:
        mercastra-app-backend: [npm ci]
      shards:
        mercastra-product: { github: { labels: [docs] } }
  klayboy:
    shards: [klayboy, klayboy-website]
    jira: KLAYBOY
    worker:
      statuses: { ready: To Do, claimed: In Progress, released: To Do, done: Done }
      exclusive: [gpu]
      claude: { maxBudgetUsd: 8 }
      setup:
        klayboy: [npm ci]
always: [handbook]
```

| Key | Meaning | Default |
|---|---|---|
| `shards` | Shard ids and patterns, `*` is a wildcard. They are the repositories a run of this project may land in and write to, see [targets and other shards](#targets-and-other-shards) | required |
| `jira` | The Jira project key. The part of an issue key before the hyphen picks the project, and with it every setting below | required for a project the worker serves |
| `worker.statuses.ready` | The status an eligible issue is in, by name or by id: an all-digit value is an id. It goes into the [search](#the-search). Without it the project's clause is `statusCategory != Done` | none |
| `worker.statuses.claimed` | The status a claimed issue is moved to, by name or by id. Names match without regard to case. Transitions are looked up per issue | required |
| `worker.statuses.released` | Where a released issue goes back to | required |
| `worker.statuses.done` | Where an issue goes once all its pull requests are merged. Without it the issue stays in `claimed` and only gets a comment | none |
| `worker.filter` | JQL that is ANDed into this project's clause of the search, such as `component = API AND type != Epic` | none |
| `worker.followUps.issueType` | Turns on [follow-up issues](#follow-up-issues): the issue type, by name or by id, of the issues the worker files from a handback's `## Follow-ups` section | none, off |
| `worker.followUps.linkType`, `max` | The issue link type that links each follow-up to the original issue, and the most follow-ups filed from one handback | `Relates`, 10 |
| `worker.exclusive` | Machine-wide resources a run of this project needs to itself, by name: letters, digits, dots, dashes and underscores. See [exclusive resources](#exclusive-resources) | none |
| `worker.setup.<shard>` | Commands run with `sh -c`, in order, in the fresh worktree of the run's target before Claude starts, such as `npm ci`. See [setup](#setup) | none |
| `worker.timeout` | The worker kills the run and releases the issue when it lasts longer, as `30s`, `45m` or `1h` | `45m` |
| `worker.repairs` | Failed repairs of a pull request before it is handed to a person | 2 |
| `worker.claude.skill` | The skill the run is told to use, the one key under `claude` that is not a flag | `issue-deliver` |
| `worker.claude.model` | Passed as `--model` when set | Claude Code's default |
| `worker.claude.pluginDir` | Passed as `--plugin-dir` when set: the plugin from a checkout of this repo, for a test of an unreleased plugin or a machine without a marketplace | the plugins installed in `CLAUDE_CONFIG_DIR` |
| `worker.claude.maxTurns` | Passed as `--max-turns`. A run that ends on it is released. Claude Code counts it per segment, see [segments](#segments), so `timeout` and `claude.maxBudgetUsd` are what bound a whole run | 80 |
| `worker.claude.maxBudgetUsd` | Passed as `--max-budget-usd`. Claude stops at its own estimate, which counts subagents and can overshoot; a run that stopped with commits is still handed back | 5 |
| `worker.claude.allowedTools` | Passed as `--allowedTools`. Everything else is denied, since nobody can answer a prompt. Claude Code checks every part of a Bash command joined with `;`, `&&`, `\|\|` or `\|` on its own, so one part outside the list denies the whole command; the brief lists the Bash patterns and asks for one command per call. `Bash(globu base stamp *)` lets the `issue-deliver` skill stamp `generated` on the knowledge it writes, through the `globu` launcher the worker puts on the run's `PATH`; a list of your own that leaves it out gets the unstamped docs named in the handback instead | `Read`, `Edit`, `Write`, `Glob`, `Grep`, and through Bash `npm run`, `npx vitest`, `git status`, `git diff`, `git log`, `git show`, `git add`, `git commit`, `globu base stamp` and the read-only `ls`, `cat`, `head`, `tail` and `wc` |
| `worker.git.branchPrefix` | The branch is `<prefix><KEY>-<slug of the summary>` | `agent/` |
| `worker.git.author` | Author and committer of the run's commits, as `{ name, email }`. Whether that is a bot or the token holder is the team's attribution call | the clone's git config |
| `worker.github.draft`, `worker.github.labels` | Passed to `gh pr create`: `draft: true` opens draft pull requests instead of ones ready for review. A label must exist in the repository | `false`, none |
| `worker.shards.<shard>` | Overrides for runs and pull requests in that one shard: `claude`, `timeout`, `git` and `github`, with the keys above | none |

A key the worker does not know inside `worker` is an error that names it, so a typo does not pass as a default.

### The machine, in worker.yaml

`worker.yaml` in `GLOBU_HOME` keeps what is true only on this machine:

```yaml
version: 2
jira:
  site: https://acme.atlassian.net
  priorityLabel: agent-next
projects: [klayboy, mercastra]
order: created ASC
defaults:
  claude: { model: claude-sonnet-5-5, maxTurns: 80, maxBudgetUsd: 5 }
  git:
    branchPrefix: agent/
    author: { name: Acme Agent, email: agent@acme.example }
  github: { draft: false, labels: [agent] }
poll:
  every: 60s
limits:
  concurrent: 2
  perShard: 1
  dayUsd: 40
  openPullRequests: 5
  keepRuns: 100
  subscription: 70
claude:
  configDir: own
notify:
  command: ./notify.sh "$@"
  timeout: 30s
keepAwake: true
```

| Key | Meaning | Default |
|---|---|---|
| `version` | `2`. A file without it, or with `1`, is read as [version 1](#moving-a-version-1-workeryaml) with a warning. Any other value is an error | required |
| `jira.site` | The Jira Cloud site | required |
| `projects` | The names of the manifest's projects this worker serves | every project in the manifest that has a `jira` key |
| `order` | The `ORDER BY` of the generated [search](#the-search) | `created ASC` |
| `jira.jql` | A search of your own, run as written in place of the generated one, see [the search](#the-search) | none |
| `jira.priorityLabel` | Issues carrying this label are taken before the rest, in the order the search returns them; the rest follow in the same order. See [Pointing the queue](#pointing-the-queue) | none |
| `jira.eligibleLabel` | The label that marks an issue for the worker. The generated search asks for it and `delegate` adds it | `agent-eligible` |
| `jira.blockedLabel` | Added when the worker gives an issue back. The generated search excludes it until a person removes it | `agent-blocked` |
| `jira.blockingLinks` | Issue link types, by name, that make an issue wait for the issue on their "is blocked by" side, see [Issues that wait](#issues-that-wait). An empty list turns waiting off | `[Blocks]` |
| `jira.repository` | How an issue names its target: `labelPrefix` for a label such as `repo:backend`, or `field: customfield_NNNNN` for a text or option field. The value is a shard id | `labelPrefix: "repo:"` |
| `defaults` | The settings of every project that does not set them itself: any key of a project's `worker` block except `filter` and `shards` | none |
| `poll.every` | The interval of `run`, as `30s`, `5m` or `1h` | `60s` |
| `limits.concurrent`, `limits.perShard` | Runs per cycle and runs per shard per cycle | 1 and 1 |
| `limits.dayUsd` | When the runs started today have cost this much, the worker keeps polling and settling merged pull requests but claims and repairs nothing. It is checked before a cycle starts work, so a run in progress is never cut short and the day can end above it | 40 |
| `limits.openPullRequests` | With this many of the worker's pull requests open, an automatic cycle claims no new issue; see [following its pull requests](#following-its-pull-requests) | 5 |
| `limits.keepRuns` | How many run directories to keep, newest first by start time. At the start of every cycle the worker deletes the older ones that are settled. A run that is not in a final state, a handed-back run whose pull requests are still followed, its repairs and every run started today are always kept, the last so that the day cap still counts them. Pruning never touches `merged.json` or `followups.json`, so a merged run that is pruned still resolves the issues it [blocks](#issues-that-wait) | 100 |
| `limits.subscription` | A percentage: when a window of the Claude subscription is used this much, the worker keeps polling and settling merged pull requests but claims and repairs nothing until that window resets. It is the point where the worker stops starting work, not a ceiling on the window. See [the subscription limit](#the-subscription-limit) | 70 |
| `claude.configDir` | `own` or `user`: whether Claude runs in a home of the worker's own or in the person's `~/.claude`, see [the user's Claude home](#the-users-claude-home) | `own` |
| `notify.command` | A command run on a hand back, a release, a pull request that needs a person and a stop for a machine problem, see [notifications](#notifications) | none |
| `notify.timeout` | The notification command is killed when it lasts longer | `30s` |
| `keepAwake` | While a command that cycles is running, the worker asks Windows or macOS not to put the machine to sleep on its idle timer, see [keeping the machine awake](#keeping-the-machine-awake). `false` leaves the machine's power settings alone | `true` |

A key that is not in this table is an error, so a version 1 key left in a version 2 file is named instead of ignored.

### How a run's settings are resolved

One function gives a run its settings, from four layers where a later one wins:

1. the built-in default in the tables above,
2. `defaults` in `worker.yaml`,
3. the `worker` block of the issue's project,
4. that block's `shards.<shard>` entry for the shard the run, the repair or the pull request is in.

`statuses`, `followUps`, `claude`, `git`, `github` and `setup` are merged key by key, so a project that sets `claude: { maxBudgetUsd: 8 }` keeps the model of `defaults`. A list, such as `allowedTools`, `exclusive` or `github.labels`, replaces the one below it. `followUps` is on only where an `issueType` resolves, so `defaults: { followUps: { linkType: Blocks } }` alone files nothing.

Every key under `claude` except `skill` is a `claude -p` flag in camelCase and goes through untouched. Claude Code has no settings key for the turn cap or the budget, which is why they are flags here rather than entries in a settings file. Budget and open pull request caps stay per machine: `limits` holds what the worker enforces on its own.

`check` uses the `claude` settings of `defaults` for its one-turn probe, so a model or plugin directory that only one project sets is first seen in that project's run.

### The search

The worker generates the search from the projects it serves and the labels it knows:

```
((project = "MR" AND status = "Ready for delivery" AND (component = API AND type != Epic))
  OR (project = "KLAYBOY" AND status = "To Do"))
AND labels = "agent-eligible" AND labels != "agent-blocked"
AND assignee is EMPTY
ORDER BY created ASC
```

Each project contributes one clause: its key, its `statuses.ready` or `statusCategory != Done` without one, and its `filter`. Adding a project to the manifest and to `projects` makes its issues eligible with no JQL written. The generated search is always bounded, which Jira's search endpoint requires.

`jira.jql` replaces all of it and is run as written. The team then owns the gate and the order: `check` notes when the text does not mention `jira.blockedLabel` or has no `assignee is EMPTY`, and fails with Jira's 400 when the query is unbounded. An issue such a search returns from a project the worker does not serve is skipped with `skipped, <KEY> is not a project this worker serves`: it is not claimed and it is not an error of the cycle.

### Targets and other shards

- **Target.** The issue's repository marker names a shard, which must be one of its project's shards. A project with one shard a run can land in needs no marker, and `delegate` then needs no `--repo`. An issue whose marker is missing in a project with several shards, or names a shard outside the project, is released with a comment that says which shards the project has.
- **Other shards of the project.** Each gets a worktree on the same branch name and may be written to. Commits there become additional pull requests. An issue may therefore target a docs repository as well as a code repository.
- **`access: read`.** A shard with the manifest's read cap gets no worktree and stays reference only, also when a project lists it. It is the one switch that keeps a repository out of a run's reach.
- **Outside the project.** Every other registered shard stays a read-only clone and the [guard](#what-the-guard-does-in-a-run) blocks writes to it. A shard that is in no served project cannot be a target.

A shard can be in two projects. A run then takes the settings of the project its issue's Jira key names.

### Setup

Setup commands are explicit, under `worker.setup.<shard>` of the project. The worker runs them with `sh -c` before Claude starts, outside Claude's tool allowlist, with the worker's environment minus the secrets and with the run's `timeout`. On Windows `sh` is the one from Git for Windows, found on `PATH` or next to `git`, see [On Windows](#on-windows). One that fails or times out releases the issue with the command and the end of its output; one whose shell cannot start is a [problem of the machine](#a-run).

They run only in the target's worktree. The other worktrees of a run get no setup, the brief says which worktrees had it, and the `issue-deliver` skill names in the handback every shard it changed without one, since the run could not run that shard's tests. A repair runs the setup of the shard its pull request is in, whichever shard the original run targeted, because the repair's job is to make that shard's checks pass.

### Moving a version 1 worker.yaml

A `worker.yaml` without `version: 2` still starts the worker. It is read as follows, and the worker says so in a warning at every start:

- Its global settings (`claude`, `git`, `github`, `setup`, `limits.timeout`, `limits.repairs`, `limits.exclusive`) become the `defaults`.
- Its status keys become projects: one per Jira project key that a `claimedStatus`, `releasedStatus`, `doneStatus` or `followUps.issueType` map names and that has both a claimed and a released status, and one more for every other Jira project when those two have a single value or a `default` entry.
- `shards.deliverable` and `shards.companion` keep their meaning inside those projects: an issue must name a deliverable shard, each run gets a worktree of every companion, setup runs in all of them and `shards.repos` still clones what is not registered.
- `jira.jql` stays the search.

Two things differ from before. An issue of a Jira project that no status key covers is skipped, where a version 1 worker stopped the cycle with an error. A project with no `followUps.issueType` entry files nothing, where it listed each bullet as not created.

To move the file:

1. In `manifest.yaml` of the worker's home, write a project per Jira project: its `shards` (the former deliverable and companion shards), `jira: <KEY>` and under `worker` the `statuses` (`claimedStatus` becomes `claimed`, `releasedStatus` becomes `released`, `doneStatus` becomes `done`), the `setup` entries of its shards and, where they differed, `followUps`, `exclusive`, `timeout` and `repairs`. Add `statuses.ready` with the status your JQL asked for.
2. In `worker.yaml`, set `version: 2`, move `claude` (except `configDir`), `git` and `github` under `defaults`, and delete `shards`, `setup`, the three status keys, `jira.followUps`, `limits.timeout`, `limits.repairs` and `limits.exclusive`. Delete `jira.jql` to use the generated search, or keep it as the override.
3. Give a shard that must stay reference only `access: read` with `globu set <id> --access read`: under version 2 every other shard of a project gets a worktree and may be written to.
4. Run `globu-worker check`, then `globu-worker once --dry-run` and compare the plan with what the old file produced.

### Pointing the queue

Auto mode takes issues in the order the search returns them, so with `limits.concurrent` at 1 the first eligible issue always wins, the oldest one under `created ASC`. Adding the `priorityLabel` label to an issue in Jira moves it to the front on the next poll, without touching the search or `worker.yaml`. Several labelled issues keep their order among themselves. Pick mode lists the issues in the same order.

A label was chosen over a weight per project: it points at the issue a person wants next, it is set from Jira by whoever triages, it works the same within one project and across several, and it costs nothing extra since the search already returns the labels.

## Secrets

Secrets come from the environment or from `secrets.env` in `GLOBU_HOME`, and the environment wins when both name the same variable. The file holds `KEY=value` lines; blank lines, `#` comments, an `export ` prefix and quotes around the value are accepted, a line with an empty value counts as unset, and a line that is not `KEY=value` is reported by its number without its content. The worker warns at start when the file is readable by anyone but its owner (`chmod 600 secrets.env`); on Windows, where the file has no such mode bits, it does not check. `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from the file reach Globu's own clones and fetches too. Without `GLOBU_GIT_TOKEN`, the worker's clones and fetches of `github.com` repositories use `GH_TOKEN`, so one token covers a private GitHub repository. Every git command the worker runs, and every command it starts, has `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, so a missing credential fails at once instead of waiting for a prompt nobody answers.

The variables: `JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira, `GH_TOKEN` (or `GITHUB_TOKEN`) for the push and `gh`, `GLOBU_GIT_TOKEN` for the clones Globu owns. The Claude process gets none of them: the worker strips `JIRA_EMAIL`, `JIRA_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GLOBU_GIT_TOKEN` and `GLOBU_GIT_USER` from its environment and sets `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` to the worker's own. How Claude authenticates is the worker's Claude config dir's business: a login made in that config dir, or `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment or in `secrets.env`. Those two are the only secrets passed on to Claude.

## Commands

| Command | Purpose |
|---|---|
| `start [--mode pick\|auto]` | The way to run the worker by hand: shard bootstrap, `check`, then issues one at a time with a session list. `pick`, the default on a terminal, lists the eligible issues: ↑ and ↓ (or `k` and `j`) move the selection, Enter runs the selected issue, or repairs the selected pull request, and polls again, `r` polls Jira and GitHub again, `q`, Esc or Ctrl+C quits. On a terminal, `globu-worker` without a command runs `start`. Pick mode also polls in the background every `poll.every` and redraws; it never claims or repairs without Enter, but it does move merged issues to `statuses.done`. `auto`, the default without a terminal, is the `run` loop. `limits.concurrent` is held at 1 whatever `worker.yaml` says |
| `check [--smoke]` | Shard bootstrap, then one line per check with `ok` or `FAIL` and exit code 1 on a failure: `worker.yaml`, the projects it serves and the secrets load; every shard of a served project without the read cap has an editable clone; the setup shell is found and finds the first program of each `setup` command (`command -v`), with a note on Windows when `core.longpaths` is off; Jira answers for the account and runs the [search](#the-search), with a note when a `jira.jql` of your own leaves out the blocked label or `assignee is EMPTY`; `gh api user` answers with `GH_TOKEN` and the repository of every such shard can be read with it (`git ls-remote`); a one-turn `claude -p` answers in the worker's Claude config dir and lists the configured skill, naming the model and, when `defaults.claude.model` is unset, that it is the config dir's default. That check fails when the `globu` plugin it loaded is not the worker's version, and says which commands update it: `npm install -g` upgrades the worker and leaves the plugin of its Claude home where it was. Its line also names what a run loads from that home: the plugins with their versions, the MCP servers, the hook events and the allow rules of its `settings.json`. When a served project has `followUps`, one more line checks [follow-up issues](#follow-up-issues): the link types exist, and in each such project the issue type exists, by name or by all-digit id, and the worker's account holds the Create issues and Link issues permissions (Jira's `mypermissions`); it names the issue type and id it resolved in each project. Jira, the follow-ups, GitHub and Claude are checked at the same time; on a terminal each line shows a spinner until its check ends in a green ✔ or a red ✖. The Claude check costs a few cents (about 0.08 USD measured), since a fresh session primes its cache. `--smoke` then runs the [smoke test](#the-smoke-test) when every check passed, one more line per shard a run can land in, and says it skipped it otherwise |
| `diagnostics [--out <file>]` | A `.tar.gz` with the log files, the `run.json` of the 20 runs started last, `worker.yaml`, `merged.json`, `subscription.json` and `followups.json`, each when it exists, and `environment.txt` (worker, Node, OS, `claude`, `git` and `gh` versions), every secret value replaced with `[redacted]`. Never `secrets.env`, a brief, a handback or a Claude stream. Written to `globu-worker-diagnostics-<time>.tar.gz` in the current directory by default |
| `once [--dry-run] [--issue <key>] [--repair <url>] [--json]` | One cycle: poll, claim up to the free slots, run each to the end, exit. `--dry-run` prints what it would claim and why, touching nothing. `--issue` takes that issue instead of polling, also when it is already assigned, which is how the whole path is tested. `--repair` repairs that pull request of the worker now, also when it is past `repairs`. `--json` adds the run records and the plan |
| `retry <key> [--json]` | Removes `jira.blockedLabel` from the issue when it carries it, then does what `once --issue <key>` does. The way to try a released issue again once its problem is fixed |
| `why <key> [--session] [--json]` | Says why the next cycle would or would not claim the issue, touching nothing: whether it matches the [search](#the-search) (searched as `key = <key> AND (<search>)` without the `ORDER BY`) and, for the generated search, which part keeps it out: the status, a label, the assignee or the project's `filter`. Then whether it carries `blockedLabel`, its repository marker and the shard the run would land in, its assignee, the blockers it [waits](#issues-that-wait) on, which limit holds it (`limits.dayUsd`, `limits.subscription`, a held [exclusive resource](#exclusive-resources) of its project, `limits.openPullRequests`, or `limits.concurrent` and `limits.perShard` with the repairs and the issues ahead of it in the search's order, left out for an issue that waits on a blocker, since its place in the queue is not what holds it) and whether its references resolve. The last line is the verdict, and when the next cycle leaves the issue it names the first reason: `the next cycle leaves it: it waits on MR-5 (In Review)`. `--session` reads the session's home instead of the worker's. `--json` prints the same as one object |
| `delegate <key> [--repo <shard>] [--session] [--json]` | Marks the issue for the worker without the Jira UI: adds `jira.eligibleLabel` and the repository marker for a shard of the issue's project, a `labelPrefix` label that replaces any other marker label, or the custom field, set as text or as an option by its type. `--repo` can be left out when the project has one shard a run can land in, and no marker is set then. Then says whether the issue now matches the search, since a status in it still takes a transition. Jira's search can take about 20 s to see a label change, so it searches again every 5 s for up to 30 s before it says the issue does not match. `--session` reads the session's home |
| `run` | Shard bootstrap and `check`, then `once` on the configured interval until `SIGINT` or `SIGTERM`. A failed check stops it before the first cycle. A signal during a cycle lets the cycle finish |
| `poll [--json]` | The dry run of `once`, for a session: what could be claimed now and why, touching nothing |
| `claim <key> [--json]` | Steps 3 to 7 of a run for a session: claim the issue, resolve its references, add the worktrees and write the brief, then stop with the run `prepared` and the worktrees in place. Prints the run directory; `--json` adds the record and the paths of the brief, the tree, the handback and the companions |
| `finish <run-id> [--json]` | Steps 10 and 11 for a prepared run: push the worktrees that have commits, open the pull requests, comment on the issue and remove the worktrees. A run without commits is released with that reason |
| `release <run-id> --reason <text> [--json]` | Give a prepared run's issue back with that reason and remove its worktrees |
| `hold <resource>[,<resource>] [--wait <duration>] -- <command> [args]` | Takes the lock files of those [exclusive resources](#exclusive-resources), runs the command and deletes them when it ends, passing its exit code through. Needs no `worker.yaml` or secrets. See [hold](#hold) |

Every command takes `--log-level` before its name, as in `globu-worker --log-level debug start`.

`start` shows no Claude output. On a terminal it redraws a table after every change: under the title a gray line keeps the checks in view with what each resolved to (the Jira user, the GitHub login, the Claude model, the shards), then key, summary, state and detail per issue, where the state is `available`, `not ready` (a reference is missing), `waiting` (with the blockers it waits on), `skipped`, `preparing`, `running` (with its start time), `pushing`, `handed back` (with the pull requests) or `released` (with the reason), and below it today's spend against `limits.dayUsd`, the subscription's windows against `limits.subscription` when the runs reported them (`subscription five-hour 15 %, seven-day 60 % of 70 %`, or `subscription five-hour at 72 %, holding until 2026-11-14 18:00 UTC` while the limit holds) and the keys. In pick mode the selected issue has a green ● and green text, the other available ones a gray ○, and the rest are gray. Without a terminal it has no table and prints what `run` prints, see [the service log](#the-service-log). The worker's open pull requests are listed first, as `<KEY> #<number>`, with `conflict`, `checks failing` and `needs human` in red; the first two are pickable while repairs are left. The footer counts the open pull requests against `limits.openPullRequests` and how many need a fix.

`once` prints one line per issue it looked at (`claimed`, `waiting on MR-5 (In Review)`, `waiting on gpu (held by klayboy render, pid 4242 on desk since 2026-11-14T10:00:00.000Z)`, `skipped, already assigned`, `skipped, backend has a run already`, `skipped, claimed by someone else`, `skipped, ZZ is not a project this worker serves`, or in a dry run `would claim and run in backend (2 references resolved)` and `would release: ...`) and one line per run with its final state, its reason when released and its pull requests when handed back. A repair reads `repaired` or `repair failed` with its reason in place of `handed-back` and `released`, so the two kinds of run can be told apart. When repairs took every slot of the cycle, the issues that would have been next read `waiting on a slot, taken by the repair of #7` and are claimed by the next cycle; `nothing eligible` is printed only when the JQL found nothing. A dry run gives a verdict for every issue, the same one pick mode shows, so several can read `would claim`; its last line says which issues an automatic cycle would take within `limits.concurrent` and `limits.perShard`, as in `next cycle takes MR-7 (limits.concurrent 1, limits.perShard 1)`. An issue that reads `would release` counts too, because a cycle claims it before it finds the missing marker or references and releases it, and it holds a slot of that cycle. The exit code is 0 whenever the cycle ran; a released issue is not an error of the worker.

### The service log

`run` and `start --mode auto` without a terminal print the same lines, each cycle's `once` output with the time in front, so a service log reads alike whichever of the two wrote it and can be searched by key or by state:

```
2026-11-15T20:22:36.412Z KLAYBOY-125	claimed
2026-11-15T20:30:12.087Z KLAYBOY-125	handed-back https://github.com/acme/klayboy/pull/5
2026-11-15T20:31:12.455Z nothing eligible
2026-11-15T20:32:05.120Z stopping after the current cycle
```

The time is UTC in ISO 8601, then a space, then the line: a key, a tab and what happened to it, or a message of the worker. Lines for the error output, such as a stop for a machine problem, carry the time as well. When a pause between two cycles lasted more than five minutes longer than `poll.every`, the next line says so: `resumed after a gap: nothing ran from 2026-11-15 23:14 UTC to 2026-11-16 05:52 UTC, the machine was asleep or the worker was suspended`. `once` prints the same lines without the time, since a single cycle is one moment and whatever runs it can add its own.

## The smoke test

`check` proves each piece answers, not that they work together: a machine can pass it and fail its first run a second after the claim, on a setup command, a commit hook, the push or `gh pr create`. `check --smoke` walks that path without an issue, for each shard a run can land in, in turn, with the settings of its project and its shard entry. A shard in two projects is tested once, as the first of them:

1. Take the project's [exclusive resources](#exclusive-resources), as `globu-worker smoke test`. One held by another process fails the line of each of that project's shards with `waiting on <resource> (...)`.
2. Fetch the clone and add a worktree under `smoke/<shard>-<time>` in the worker's home, on a throwaway branch `<git.branchPrefix>smoke-<time>` from the default branch.
3. Run the shard's `setup` commands there, as a run does.
4. Make an empty commit, `globu-worker smoke test`, with the environment Claude's commits get: `git.author`, the secrets stripped, the worker's `GLOBU_HOME` and `CLAUDE_CONFIG_DIR`. The repository's commit hooks run as they would in a run.
5. Push the branch with `GH_TOKEN` and open a pull request with `gh pr create`, always as a draft and with `github.labels`, so a missing label fails here.
6. Close the pull request with a comment and delete the remote branch, then remove the worktree, the local branch and the directory.

A failure names the step and the end of its output, and the cleanup still runs: a pull request that was opened is closed and a branch that was pushed is deleted. The smoke test never reads or writes Jira and spends nothing on Claude, but it costs one setup per shard and leaves a closed draft pull request in each repository's history. Run it once on a new machine, and again after changing `setup`, the hooks or the token.

## Exclusive resources

Some runs cannot share the machine with other work. On a desktop that renders on its GPU, a run's setup or commit hook can start a render while a render job already has the whole GPU. `exclusive: [gpu]` in a project's `worker` block makes the worker take the machine-wide lock `gpu` before it claims or repairs an issue of that project, hold it through setup, Claude and the push until the cycle's runs end, and claim nothing of that project while another process holds it: the issue stays unclaimed with `waiting on gpu (...)` and the next cycle tries again. An issue of a project without the resource is claimed in the same cycle, so with `exclusive: [gpu]` on klayboy alone a sandbox issue does not wait on a render. `exclusive` under `defaults` applies to every project that does not set its own. A dry run, `poll` and pick mode report the same without taking the lock. Polling, follow-ups and the day cap do not need it. `claim`, `finish` and `release` from a session never take it, since no process lives through a session's run to hold it.

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

`globu-worker hold` takes those steps for a script, so a render job or a commit hook honours `exclusive` without its own lock code:

```bash
globu-worker hold gpu -- npm run render
globu-worker hold gpu,disk --wait 10m -- node scripts/render.mjs --all
```

It takes every named lock, in order, then starts the command with the terminal's input and output, from the current directory and with the same environment. While it runs, a worker cycle on the same machine claims nothing and prints `waiting on gpu (held by globu-worker hold (npm run render), pid 4242 on desk since ...)`. When the command ends the locks are deleted and `hold` exits with the command's exit code, or with 128 plus the signal's number when a signal ended it, as a shell does. Its own messages go to the error output, so the command's output stays as it was.

- **A held lock.** Without `--wait`, `hold` fails at once with exit code 75 and says who holds it: `could not take gpu (held by globu-worker, pid 4242 on desk since ...)`. `--wait 30s`, `5m` or `1h` tries again every second for up to that long, saying `waiting on ...` once per holder, and then fails the same way. Locks taken before the held one are given back while it waits.
- **A command that cannot start** fails with exit code 127, `could not start <command>: not found on PATH`, and the locks are given back. On Windows a command named without a path is looked up on `PATH` first and fails before any lock is taken, since `cmd.exe` would otherwise print its own "is not recognized" before that line.
- **Signals.** `SIGTERM` and `SIGHUP` are passed on to the command and `hold` waits for it to end before it deletes the locks, so the resource stays taken while the command shuts down. `SIGINT` is not passed on, since Ctrl+C in a terminal already reaches the whole foreground process group, the command included; a second copy would make some programs quit without cleaning up. A signal while waiting for a lock stops the wait without running the command. On Windows nothing is passed on: the console sends Ctrl+C to every process attached to it, and Node can only kill a process there, which would end the `cmd.exe` of a `.cmd` shim and leave the program it started running.
- **A crash.** A `hold` that is killed outright leaves its lock files behind, and they go stale by pid and host as above, so the next taker deletes them. The command may outlive it, and is then no longer covered by a lock.
- **Nested holds.** Every command the worker starts, and every command `hold` starts, gets `GLOBU_LOCK_PIDS` with the pids of the processes above it. A lock whose pid is in that list and whose host is this machine counts as already held, so a commit hook wrapped in `hold gpu` runs inside a worker run that holds `gpu`, or inside another `hold gpu`, instead of waiting on its own parent. A worker started inside `hold` applies the same rule to its own `exclusive` resources, so `globu-worker hold gpu -- globu-worker once` runs its cycle under the lock of the `hold` around it. Such a lock belongs to the process that took it: it is left alone at the end and never deleted by a process below. A process never counts its own pid as one above it, and the commands it starts get the list with its own pid added.
- **Windows.** The command starts through the same cross-spawn helper as the worker's own commands, so `npm` and other `.cmd` shims start as they do in a shell.

## The subscription limit

When Claude authenticates with the owner's own subscription, a login in the worker's Claude config dir or `CLAUDE_CODE_OAUTH_TOKEN`, the runs draw on the same usage windows as the owner's interactive sessions. A night of runs can use up the five-hour window and lock the owner out of their own sessions until it resets, and the seven-day window can go the same way over a week.

The `claude -p` stream then carries `rate_limit_event` lines. The worker reads every window they report, each with its utilization and the time it resets (`unifiedWindows` in the event, or the single window named by `rateLimitType`), keeps the latest figure per window in `subscription.json` in its home and counts a window the event marks `rejected` as full. Before each cycle it compares the windows that have not reset yet with `limits.subscription`: when one is at the limit or past it, the cycle claims and repairs nothing and says `subscription limit reached: the subscription's five-hour window is at 72 %, the limit is 70 %, it resets at 2026-11-14 18:00 UTC, claiming nothing`. Polling goes on, and the first cycle after the reset claims again. Several windows past the limit hold until the last of them resets. `why` names the limit among the holds and the `start` footer shows the figures next to today's spend.

While the limit holds, and while the day cap does, each cycle still reads the worker's pull requests and settles the ones that were merged or closed, since that needs no Claude: a merged issue moves to done and the issues it blocked are free when the hold ends. `run` and a headless `start` say the hold once, when it starts, in the service log and as one `warn` line in the worker's log, and say `the subscription limit no longer holds, claiming again` (or `the day cap`) on the first cycle after it. A hold whose figures change, for example when another window takes over, is said again. `once` is one cycle, so every `once` during a hold prints the line.

**The limit is a point to stop at, not a ceiling.** It is compared before a cycle starts work and never during a run, so a run that starts below the limit runs to its end and can take the window well past it: on the test desktop one run of 74 minutes took the five-hour window from under 70 % to 82 %. With `limits.concurrent` above 1 several runs start from the same figure. Set the limit with the length of a run in mind, lower when the owner's own sessions need the room.

**The window is shared and the worker sees only its own runs.** The five-hour and seven-day windows count the owner's interactive sessions together with the worker's runs. A busy day of the owner's own can therefore hold the worker, and the worker's runs take from what the owner has left.

The figure the worker compares is only as fresh as its last run, since nothing else reports it: the owner's interactive use between runs is not seen until the next run's stream, so the worker can start a run in a window that the owner has filled since, and it holds on the figure of its last run until that window's reset time even when nothing was used after it. The default of 70 % leaves the owner's use room. While `ANTHROPIC_API_KEY` is set the runs bill the API, and the worker ignores the figures it kept.

## Notifications

Nothing in Jira or GitHub tells the owner of the machine that a run ended. `notify.command` is run on four events:

| Event | When | `GLOBU_URL` |
|---|---|---|
| `handed-back` | A run opened its pull requests | The first pull request |
| `released` | A run gave its issue back, for any reason but a machine problem | The issue in Jira |
| `needs-human` | The last allowed repair of a pull request failed | The pull request |
| `stopped` | The `run` loop or `start --mode auto` stopped for a [machine problem](#a-run) | The issue whose run found it |

The command runs with the same shell as `setup` (`sh -c`, Git's `sh` on Windows), in the worker's home, and gets the event, the issue key and the URL as `$1`, `$2` and `$3` and as `GLOBU_EVENT`, `GLOBU_ISSUE` and `GLOBU_URL`, with a line for a person in `GLOBU_MESSAGE`, such as `MR-7 handed back, met: https://github.com/acme/backend/pull/3`, with the handback's [outcome](#the-outcome) when it has one, or `MR-8 released: the run made no commits`. Its environment is the worker's without the Jira, GitHub and Claude secrets; a token the command needs can go into `secrets.env` under a name of its own, which passes through. A command that fails, cannot start or outlasts `notify.timeout` is logged as `notify failed` with the reason and never stops the worker. When the machine problem that stops the worker is the shell itself, the `stopped` notification cannot run either: the worker then prints `could not send the stopped notification: ...` to its error output next to the stop, and the log has both. Runs driven from a session never notify, since a person is already in them.

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

A longer command is better kept in a script next to `worker.yaml`, such as `command: ./notify.sh "$@"`, since the command runs in the worker's home. The `"$@"` passes the three arguments on to the script: they belong to the command line, and a script started without it gets none, though it still reads the `GLOBU_` variables.

## From a session

`once` and `run` start Claude headless. `poll`, `claim`, `finish` and `release` leave the implementing to a Claude Code session, which is the same run with a person in it: the binary does the deterministic steps and the session, or a subagent it starts, does the work of the `issue-deliver` skill in the prepared worktree. The `issue-work` and `issue-watch` skills in the plugin drive these four commands; [plugin skills](./skills.md) describes them.

The four session commands use the session's own Globu home, `~/.globu` unless `GLOBU_HOME` is set, with its own `runs` directory, and never the headless worker's home. They read the projects from that home's `manifest.yaml`, the same definitions the worker reads, so the person's home needs no `worker.yaml` beyond the Jira site:

```yaml
version: 2
jira: { site: https://acme.atlassian.net }
```

Without `projects` in that file every project of the manifest with a `jira` key is served, and `limits.concurrent` and `poll.every` keep their defaults for `issue-watch`. A version 1 `worker.yaml` in the person's home still works, with the warning.

The shards they deliver to are the person's registered checkouts. A person's home often has projects whose repositories are not all cloned on that machine, so the session commands check only the project of the issue at hand: its shards must be editable and not in `read` mode, and `ask` is enough, since a person answers the prompt. `poll` lists an issue of a project that fails this as `skipped, shard "<id>" needs an editable clone ...` instead of refusing to poll, and `claim` refuses that issue before it touches Jira. `why --session` and `delegate --session` read the same home. The issue is claimed as the person whose `JIRA_EMAIL` and `JIRA_API_TOKEN` are in the environment. A run made by `claim` has `driver: session` in its record, its footer names the session instead of turns and cost, and it is not reconciled by anything: a run left prepared is given back with `release`.

## A run

1. **Reconcile.** Runs left in a non-final state by a crash or a restart are closed: their worktrees are removed and, when the issue is still assigned to the worker in the claimed status, it is released with a comment saying so. A run that already had a reason keeps it, with the restart added in brackets. Comments an earlier repair could not post are posted now. Then settled runs beyond `limits.keepRuns` are deleted, each `claude.jsonl` with them, once the merges among them are in `merged.json`.
2. **Poll.** The [search](#the-search), in its order, with issues that carry `jira.priorityLabel` moved to the front. Up to `limits.concurrent` issues are taken, skipping an issue of a project the worker does not serve, an issue already assigned, an issue that [waits](#issues-that-wait) on a blocker and an issue whose shard already has `limits.perShard` runs this cycle.
3. **Claim.** Take the [exclusive resources](#exclusive-resources) of the issue's project before its first claim of the cycle; while another process holds one, leave the issue and say `waiting on <resource> (...)`. Then assign to the worker's own account, transition to the `statuses.claimed` of the issue's project, read the issue back. If someone else got there first, drop it without a word.
4. **Find the target.** The repository marker names a shard of the issue's project, or the project has one shard a run can land in. Anything else: release, see [targets and other shards](#targets-and-other-shards).
5. **Resolve.** Shard-qualified refs such as `product/docs/decisions/012-pricing.md` and code host links to files in a shard's repo are checked with the same code as `globu resolve`, after a fetch. One missing: release, with the resolver's report and its candidates in the comment, before a token is spent. Bare paths in backticks are resolved too but only reported in the brief, since they may be files the change creates.
6. **Prepare.** A fetch of the target clone and of the project's other shards; a repository with no commits on its default branch releases the issue, since there is nothing to branch from and no base for a pull request. Then a worktree of the target clone on a fresh branch from the default branch at `runs/<run-id>/tree`, and one more for each other shard of the project without the read cap at `runs/<run-id>/companions/<shard>`. The worktrees sit outside every repository; the session view still maps them to their shards through the git common directory, so the guard treats the target as the run's home and every other shard as foreign. Then the [setup](#setup) commands of the target; a failing one releases the issue.
7. **Brief.** `brief.md` holds the issue under a heading that says it is untrusted input. Its description and comments are read from Jira's v3 API as Atlassian Document Format and converted to Markdown (headings, lists, code, links, mentions, emphasis and tables; anything else as its text), so a path written as code in Jira reaches the brief in backticks and step 5 finds it. Then come the resolved references with their locations on this machine: a file of the target shard or of another shard the run has a worktree of is given inside that worktree, so a run that follows the path reads its own branch and edits there and not in the clone every run of the shard shares, while a file of any other shard is given in that shard's checkout, for reading. After them come the issue's status and labels, the issues it is blocked by with their status and the worker's pull requests for them, its other linked issues with the relation and their status, the worktrees, which of them had setup and the handback path. The worker's own release comments are left out of the comments and summed up as "Earlier attempts", with the count and the last reason. The Bash rules come next: the allowed patterns and one command per call. They say that `git stash` is denied because the stash is shared with every other worktree of the clone, so a work-in-progress commit is the way to set work aside, and that `globu base stamp --verified` is denied because a verification needs a person. It says that the worker owns the tracker and the pull requests: the run must not move the issue, comment on it or create issues, even when the target repository's own instructions ask for that, since it has no tracker access. Work that should become an issue of its own goes into a `## Follow-ups` section of the handback, one bullet per follow-up with its summary on the first line, which reaches the issue with the handback comment and, with `followUps` on for the project, becomes [issues](#follow-up-issues) of their own.
8. **Run.** From the worktree root: `claude -p "Implement the issue described in <brief> with the issue-deliver skill. Write the handback to <handback>." --permission-mode dontAsk --allowedTools <claude.allowedTools> --disallowedTools "Bash(git push*)" "Bash(git stash*)" "Bash(gh *)" "Bash(curl *)" "Bash(wget *)" "Bash(globu base stamp *--verified*)" --add-dir <run dir> --max-turns N --max-budget-usd X --output-format stream-json --verbose`, plus `--model` and `--plugin-dir` when configured. The disallowed six are not configurable: four keep the run from acting as the courier, `git stash` keeps parallel runs of one clone out of each other's stash and `base stamp --verified` keeps a run with nobody present from recording a person's verification. The skill stamps `generated` with `globu base stamp` on each concept doc it created or changed in substance, in the target and in the other worktrees, before it commits, so the knowledge a run writes reaches review marked as written by an agent. The `globu` it runs is the worker's own: before every run and repair the worker writes `bin/globu`, a `sh` script, and `bin/globu.cmd` into its home, each running `node <the worker's bundle> globu <arguments>`, and puts `bin` first on the run's `PATH`, so it wins over a `globu` installed on the machine. Git Bash, which Claude Code's Bash tool uses on Windows, runs the `sh` script; `cmd` and PowerShell run the `.cmd`. The command accepts only `globu base stamp <files...>`, refuses `--verified` and any other option and stamps with the worker's version, so the stamp needs no plugin path and no second package. `bin` sits outside the worktrees and the run directory, which `--add-dir` opens to the run's edits, and the launchers are rewritten only when the path of Node or of the bundle changed. The stream goes to `claude.jsonl`. `--add-dir` is what lets the run write the handback outside the repository.
9. **Collect.** Cost, turns and the end state from the stream. Every failed tool call that carries the guard's `shard "<id>"` wording is recorded as a blocked write. The result's `permission_denials`, the calls `--allowedTools` refused, go to `denied` in `run.json`, and its `duration_ms` and `duration_api_ms` to `durationMs` and `apiMs`, so the time a commit hook or a test run takes shows next to the model's. A run with several [segments](#segments) is summed. Commits on the branch are counted.
10. **Decide.** Timed out, stopped at the turn cap or no commits: release, with the reason. Otherwise push each branch with commits over https with `GH_TOKEN`, open a pull request with `gh pr create`, a draft when `github.draft` is set, whose body is the handback plus the run footer, file the handback's [follow-ups](#follow-up-issues) when the project has `followUps`, comment on the issue with the handback, the follow-up keys and the pull request links, add each pull request as a remote link and leave the issue in `statuses.claimed` for the reviewer. A pull request in another shard of the project takes the `github` settings of that shard's entry.
11. **Clean up.** Symbolic links and junctions in each worktree are deleted first, without following them, since npm workspaces on Windows link `node_modules` into the tree as junctions that `git worktree remove --force` leaves behind. Then the worktree is removed, whatever is left of its directory deleted and unpushed branches deleted; the run directory is kept until `limits.keepRuns` prunes it. Once every run of the cycle has ended, the exclusive locks are deleted. `check` warns about a `runs/<run-id>/tree` left behind by a run in a final state.

A release moves the issue back to `statuses.released`, unassigns it, adds `blockedLabel` and comments with the reason. When Claude ran and wrote a handback but the run ends without a pull request (no commits, the turn cap or the timeout), the comment carries that handback below the reason, so a question the run asked reaches whoever triages the issue. The worker never retries on its own. A person fixes the issue and runs `retry <key>`, which removes the label and takes the issue at once, or removes the label by hand and waits for the next poll. `why <key>` says what still keeps an issue out.

A problem of the machine is not the issue's fault. There are two kinds. A program cannot start at all: the setup shell is missing, or a setup command, `claude`, `git` or `gh` is not found. Or Windows ended a program the worker started: it exits with an NTSTATUS error, a code from `0xC0000000` up, such as `0xC0000142` when the console it ran in was taken away or `0xC0000005` when it crashed. No program returns such a code as its own result. Such a release says "could not start `<program>`: not found on PATH" or "Windows ended `<program>` with status 0xC0000142" rather than a plain exit code, does not add `blockedLabel`, says on the issue that the machine needs fixing and sets `environment: true` in `run.json`. The `run` loop and `start --mode auto` then stop with exit code 69 (`EX_UNAVAILABLE`), since every next issue would fail the same way, and [notify](#notifications) `stopped`; once the machine is fixed, starting the worker again takes the issue up on the next poll. A failed repair for that reason does not count against `repairs`.

Every footer, in the pull request body and in the Jira comment, names the run id, the Jira account and GitHub login the worker acted as, turns, with the number of segments when there is more than one, cost, wall time with the part of it spent in the model API, the blocked writes and the denied tool calls, each listed on a line of its own. A run driven from a session names the session instead of the turns, the cost and the blocked writes, which only the headless stream can count. Until Atlassian ships agent identities a run acts as whoever holds the tokens, and the footer records which identity that was.

### The outcome

The `issue-deliver` skill starts the handback's Summary with a line `Outcome: met`, `Outcome: partial` or `Outcome: not met`: whether the change meets what the issue asks for, in the run's own judgment. A run that got 3 of 7 labs to pass and said so is `partial`. The worker reads the first such line, whatever Markdown is around it, and shows the word wherever it reports a hand back, so a reviewer sees which pull request to open first:

| Where | How it reads |
|---|---|
| `once`, `run` and `start --mode auto` | `KLAYBOY-125	handed-back (partial) https://github.com/acme/klayboy/pull/5` |
| The session list of `start` | `handed back  partial https://github.com/acme/klayboy/pull/5` |
| `GLOBU_MESSAGE` of a `handed-back` notification | `KLAYBOY-125 handed back, partial: https://github.com/acme/klayboy/pull/5` |
| `run.json` and the worker's log | `outcome` |

The pull request body and the Jira comment carry it as the first line of the handback. A handback without the line, from an older plugin or written by hand, has no outcome and reads as before. The word is the run's claim, not a check of the worker's: the reviewer still decides.

### Segments

A run that starts a command with `run_in_background` ends its turn and waits. `claude -p` stays up, wakes the run for each task that finishes and writes one `result` line to `claude.jsonl` per stretch of work, a segment. A run that checked a GPU build one task at a time wrote 11 of them.

The worker reads all of them:

| `run.json` | What it holds |
|---|---|
| `turns` | The sum of `num_turns` over the segments |
| `durationMs` | The sum of `duration_ms`, the time Claude Code was working. The waits between segments are not in it |
| `apiMs` | The last `duration_api_ms`, which Claude Code reports as a running total |
| `costUsd` | The last `total_cost_usd`, a running total as well |
| `segments` | How many `result` lines the run wrote |
| `wallMs` | From the claim to the hand back or the release, written when the run ends. A repair counts from its own start |
| `denied` | Every denied call once, whether Claude Code repeats the earlier ones in a later segment or not |

The end state, and with it a release for the turn cap, comes from the last segment.

`--max-turns` counts per segment: a run under `--max-turns 3` that used 2 turns before its background task finished got 3 more after it. So `claude.maxTurns` stops one stretch of work that does not end, not a run that keeps being woken. What bounds the whole run is `timeout`, which kills it, and `claude.maxBudgetUsd`, which Claude Code checks against the running total.

## Following its pull requests

A handed-back run stays the worker's business until its pull requests are merged or closed. At the start of every automatic cycle, before it looks for new issues, the worker reads each open pull request of its handed-back runs with `gh pr view` and acts on what it finds:

- **Merged**, all of the run's pull requests: the issue moves to `statuses.done` when its project sets one and gets a comment either way, and its key goes into `merged.json` with the run's pull requests. The branch of each merged pull request is deleted on the remote with `git push origin --delete` and `GH_TOKEN`, unless the repository already deleted it on merge, then in the shard's clone, and the clone is fetched with `--prune`. Only the run's own branch is deleted: a pull request whose head is another branch keeps it. A deletion that fails, for a token that may not delete branches say, is logged as a warning and changes nothing else. **Closed** without a merge: a comment, nothing more, and the branch stays. Either way the run is settled and no longer followed.
- **Conflicting**, or **failing checks**, with repairs left: a repair run. The worker adds a worktree on the pull request branch, reset to the remote, and merges `origin/<base>` into it. If that merges cleanly and the checks were not failing, it pushes the merge commit with no Claude involved. Otherwise it runs the `setup` commands of the pull request's shard and `claude -p` with a repair brief, `brief.md` in the repair's run directory, listing the conflicted files, the failing checks with their links and where the original brief and handback are. Claude resolves, runs the tests and commits; the worker checks that nothing is left conflicted and the merge is committed, then pushes. Merge only: the worker never rebases and never force-pushes, so review comments stay attached.
- **Behind** the base branch without a conflict, or still **in review**: nothing. Keeping a branch current is a merge queue's job, or GitHub's update branch.

Each repair is a run of its own, with an id of the form `<KEY>-repair-<attempt>-<time>`, `repairOf` naming the run it repairs, its cost counted against `limits.dayUsd` and its own `repair` and `repaired` or `repair failed` log events. It comments on the pull request and the issue whatever the outcome. The repair's `run.json` is written with its state and reason before either comment is sent, and a comment that cannot be posted, because `gh` or Jira fails at that moment, does not undo the repair: it is kept in `run.json` under `unposted`, reported on the error output and in the log as `comment not posted`, and posted at the start of the next cycle that is not a dry run. Only failed repairs count against `repairs`, since a pull request on a busy base branch may need several good ones. After that many failures the pull request is handed to a person: a comment saying so, the label `needs-human` on the pull request when the repository has it, and no further repair unless `once --repair` asks for one. The pull requests of a project the worker no longer serves are still read and settled, but never repaired.

Then the cap: with `limits.openPullRequests` or more pull requests open, conflicted and needing a person included, the cycle claims nothing and says `holding new issues`. The cap bounds how many branches can drift apart at once, so the number of conflicts stays small and review shows up as the bottleneck it is. `once --issue` and Enter in pick mode are deliberate and ignore the cap.

A cycle runs its claimed issues to the end, which can take an hour. While they run, the worker reads the pull requests again every `poll.every` and settles the ones that were merged or closed in the meantime: the issue moves to `doneStatus`, the branch is deleted and the merge is recorded, so an issue that was blocked by it is free for the next cycle. Repairs are not started from there; they wait for the next cycle, like new issues. A read that fails is logged as `settling failed` and tried again at the next interval.

Merging stays with people. A merge queue, or GitHub's auto-merge with required checks, is the natural partner: it lands approved pull requests in order and tests each on top of the ones ahead of it, which catches the conflicts that only show when two changes meet.

## Follow-up issues

The brief asks the run to put work that should become an issue of its own into a `## Follow-ups` section of the handback, one bullet per follow-up: the first line of a bullet is the summary and its further lines, indented, the description. Without `followUps` in the issue's project the section reaches the issue only inside the handback comment. With `followUps.issueType` set, in the project's `worker` block or in `defaults`, the worker files each bullet when it hands back, after the pull requests are open:

- in the original issue's project, the part of its key before the hyphen, with the configured issue type, by name or by id;
- with the bullet's further lines as the description, followed by a line naming the original issue and the run;
- with the labels of the original issue, so a follow-up keeps the kind and the area its project sorts issues by, but without the worker's own: `jira.eligibleLabel`, `jira.blockedLabel`, `jira.priorityLabel` and a repository marker label;
- linked to the original with `followUps.linkType`, `Relates` by default, which Jira shows as "relates to". The original is the link's inward issue and the follow-up its outward one.

The handback comment lists the new keys under "Follow-up issues", above the pull request links, and `run.json` keeps them as `followUpIssues`. The pull request body stays the handback as the run wrote it. A run driven from a session through `finish` files its follow-ups the same way.

The section is the level-two heading `Follow-ups` (or `Followups` or `Follow ups`, in any case) up to the next heading of level one or two. A bullet is a line that starts with `-`, `*` or `+`; the lines indented under it, nested lists and code blocks included, are its description, and a blank line followed by text that is not indented ends it. Text outside the bullets is ignored, and a bullet that reads only `None`, `Nothing` or `n/a` files nothing. A summary longer than Jira's 255 characters is cut, and the whole line opens the description.

The brief also asks the run to write each follow-up in the format the repository asks for its issues, when its instructions or docs define one, such as sections for the kind of work, the area and what done means. The worker does not check the format.

A follow-up is never marked for the worker: it gets no `jira.eligibleLabel`, no repository marker, no assignee and no transition, so a person decides whether and where it is delivered, with `delegate` for one. The generated search asks for the eligibility label, so it never finds a follow-up. Keep the label in a `jira.jql` of your own: a search without it could match a follow-up in its project's first status, and the worker would then release it for a missing repository marker.

Filing never fails the run. An issue Jira refuses to create, a link it refuses and the bullets past `followUps.max` are each listed in the comment with the reason, such as `- not created: Rename the flag (Jira POST /issue failed: 400 ...)` or `- MR-12: Rename the flag (not linked: ...)`, and logged as `follow-up failed` at `warn`; each one filed is logged as `follow-up filed` at `info`. The issue is handed back either way. The Jira account needs the Create issues and Link issues permissions in the projects that file follow-ups, which `check` tests along with the issue type and the link type. The issues are created through REST API v2, so the description is plain text, like the worker's comments.

In every description and comment the worker posts, an issue key of the issue's own project that stands as a word of its own is written as a link with the key as its text, `[MR-7|https://acme.atlassian.net/browse/MR-7]`. Jira turns a bare key into a smart-link card, which shows the issue's title and status in Jira but comes out empty in plain-text readers of the issue, so "Follow-up of MR-7" read as "Follow-up of ," there. A key inside backticks, a Markdown link, a branch name or a run id is left as it is.

Filing happens once per issue, even when the hand back fails after it. Each follow-up goes into `followups.json` in the worker's home, under the original issue's key, as soon as Jira creates it, and is marked linked as soon as the link is made. Only when the handback comment is posted does the worker drop the issue's entry. A comment that fails, or a crash, releases the run and leaves the entry, so a later run of the same issue that hands back reuses every recorded follow-up whose summary matches a bullet of its own handback, links the ones whose link failed and creates only the rest; reused ones are logged as `follow-up reused`. A recorded follow-up that the new handback no longer has is not lost either: it is listed in the comment as `- MR-12: Rename the flag (filed by an earlier attempt, not in this handback)` and logged as `follow-up kept`. The entry lives in the home rather than in `run.json` because `limits.keepRuns` may prune the failed run before the issue is tried again, the same reason `merged.json` lives there. A session's `finish` uses the home of that session, so it does not see what the worker's home recorded.

## Issues that wait

An issue linked as "is blocked by" another issue, through a link type in `jira.blockingLinks`, waits until every such blocker is resolved. JQL cannot say "no open blocker" without a Jira app, so the worker reads the links of each issue the search returns. A blocker is resolved when its status is in Jira's Done category, or when one of the worker's own runs for it has its pull requests merged; the second keeps a chain moving when `statuses.done` is not set. A waiting issue is listed as `waiting on <key> (<status>)` and takes no slot, so the cycle goes on to the next issue. `once --issue` runs it anyway, and in pick mode it is a gray row that cannot be selected.

That makes delivery sequential: with A blocking B and both matching the search, a cycle claims A. Once A's pull request is merged the follow-ups above settle it, and the next cycle claims B, built on a default branch that has A, with A and its pull request named in B's brief. How fast the chain moves depends on the merges: with GitHub's auto-merge and required checks it moves without a person.

The merges are kept in `merged.json` in the worker's home, one entry per issue key with the pull requests and the time the worker saw the merge, written when the follow-ups settle a merged run. `limits.keepRuns` never prunes it, so a long chain keeps moving after the run of its first issue is deleted. A home from before the index is seeded from its run records the first time the worker writes the index, dated by when each `run.json` was last written, and until then the run records are read directly; nothing is lost on an upgrade. A merged run that is still in `runs` counts as well, so deleting `merged.json` by hand forgets only the issues whose runs are already pruned. The brief names the pull requests from the index too.

A blocker the worker's Jira account cannot see is left out of the links by Jira and does not hold anything up. A cycle of links holds both issues; each row says what it waits on. Branching B from A's pull request before it merges, stacked pull requests, is not supported.

## What the guard does in a run

Nothing new. The run's working directory is a worktree of the target shard, so writes there are free. A shard outside the run's project, and a shard with `access: read` inside it, is a read-only clone in the worker's `state.yaml`, so a certain write is blocked and a possible one raises `ask`, which a run with nobody to answer turns into a denial. The other shards of the project are in `write` mode in the worker's own state, which is harmless because that state belongs to the worker alone, and their edits land on a branch through the worktree. The run's session index lists the shards of its project and the manifest's `always` shards, as in any session started in the target's repository. The limits of reading shell commands in [architecture](./architecture.md#shell-commands-in-the-guard) apply: the guard lowers the odds of an unnoticed write to a sibling repository and the footer reports the ones it caught. It is not a sandbox.

## Logs and diagnostics

The worker writes `logs/worker-YYYY-MM-DD.log` in its home, one JSON object per line with `time`, `level` and `msg`, plus `run` and other fields where they apply. `--log-level` or `GLOBU_LOG_LEVEL` picks `error`, `warn`, `info` (the default) or `debug`. `info` records each cycle, claim, setup command, run start, release and handback; `warn` the start of a hold on the day cap or the subscription limit and failed checks; `error` a failed cycle or release. `debug` adds every command the worker runs (git, gh, claude, setup) with its arguments, working directory, exit code, duration and the last lines of stderr, every Jira call with its method, path, status and duration, and every check. Before a line is written, each secret value from the environment and `secrets.env` and every git `extraheader` is replaced with `[redacted]`.

To look at a run on another machine, run `globu-worker --log-level debug start` there, reproduce, then `globu-worker diagnostics` and bring the archive back.

## Running it

By hand, `globu-worker start` in a terminal. As a service, `globu-worker start --mode auto` or `globu-worker run`; on a Mac under launchd, with the secrets in the job's environment or in `secrets.env`, and on Windows [as a scheduled task](#as-a-scheduled-task-on-windows). In a container, a Cloud Run job or a cron entry runs the bootstrap against an empty `GLOBU_HOME` and then `globu-worker once`; a second invocation while one is running on the same home exits 1, see below. No endpoint is exposed, because the trigger is the poll. Two workers on one Jira project are not supported: the claim is a read-back after assign and transition, which is enough for one.

A service manager can tell a stop for a machine problem by its exit code, 69, and should not restart into it: under systemd `Restart=on-failure` with `RestartPreventExitStatus=69`. Under launchd a `KeepAlive` dictionary with `SuccessfulExit` set to false restarts on any non-zero exit, 69 included, so a job that should stay down runs the worker from a script that exits 0 on 69.

### One process per home

The commands that cycle, `once` (not `--dry-run`), `retry`, `run` and `start` in either mode, take `worker.lock` in the home for as long as they run, pick mode for its whole session, since its background refresh settles merged pull requests. A second such command on the same home exits 1 with `another globu-worker cycles on <home>: worker (held by globu-worker start --mode pick, pid ... on ... since ...)`. Read-only commands, `why`, `poll`, `diagnostics` and a dry run, never take it. The lock follows the rules of the [exclusive resources](#exclusive-resources): one that a crashed process left behind goes stale by its pid. Without it, a pick mode left open beside a `once` settled the same merge twice on 2026-11-15 and a process kept deciding with the `worker.yaml` it had read the day before.

What the consuming project needs in Jira: a status a person moves an issue into as the act of delegation, an eligibility label and, in a project with more than one shard, a repository marker per issue. `delegate` sets the label and the marker from a terminal. The Claude Code behaviours the worker relies on and which were tested are in the [hook contract](./claude-code-hooks.md).

### Keeping the machine awake

A worker that polls once a minute is not activity to the operating system, so an unattended desk machine goes to sleep under it on its idle timer: on the test desktop Windows slept during a subscription hold, and the worker neither repaired nor settled anything until a person woke the machine hours later.

While `once` (not `--dry-run`), `retry`, `run` or `start` is running, during runs and between them, the worker therefore holds a request that the system stays awake. It starts one small helper process and ends it when the command ends:

| System | Helper | What it holds |
|---|---|---|
| Windows | `powershell.exe` calling `SetThreadExecutionState` with `ES_CONTINUOUS` and `ES_SYSTEM_REQUIRED`, then waiting for the worker's process | The system stays awake; the display may still turn off |
| macOS | `caffeinate -i -w <the worker's pid>` | No idle sleep; the display may still sleep |
| Linux and others | None | A server does not sleep on an idle timer; a desk machine needs its own power setting |

The helper watches the worker's process and ends with it, so a worker that is killed leaves no request behind. To see the request: `powercfg /requests` in an elevated prompt on Windows, `pmset -g assertions` on macOS. When the helper cannot start or ends on its own, the worker says `globu-worker: cannot keep the machine awake, <why>` on the error output, logs a `warn` and carries on.

The request only covers the idle timer. A person choosing Sleep, a closed laptop lid, hibernation on a low battery and a sleep that a policy forces still stop the worker, and on battery Windows can ignore the request under Modern Standby. The worker cannot report while the machine is asleep. What it does is name the gap afterwards: the first cycle after a pause that lasted more than five minutes longer than `poll.every` prints `resumed after a gap: nothing ran from <time> to <time>, the machine was asleep or the worker was suspended` and logs it as a `warn` with both times, so the [diagnostics](#logs-and-diagnostics) archive shows it. A sleep in the middle of a run is not named: the run goes on after the resume, and its `timeout` counts the time asleep.

`keepAwake: false` in `worker.yaml` turns the request off, for a machine whose power plan already keeps it awake or one that should be allowed to sleep. The Windows equivalent by hand is `powercfg /change standby-timeout-ac 0`.

### On Windows

The worker runs on Windows with Git for Windows, Node and `claude`, installed natively or through npm; commands installed as `.cmd` shims, such as `npm`, `claude` or `gh`, are started through `cmd.exe` with their arguments escaped for it. Things to set up before the first real run:

- **The setup shell.** Git for Windows puts `sh.exe` in its `bin` directory, which is not on `PATH` by default. The worker finds it next to the `git` that is on `PATH` (`<Git>\cmd\git.exe` or `<Git>\bin\git.exe` gives `<Git>\bin\sh.exe`); `check` fails when it cannot.
- **Private repositories.** `GLOBU_GIT_TOKEN` in `secrets.env`, or for `github.com` a `GH_TOKEN` that can read them. Without one, git fails at once instead of waiting on Git Credential Manager's prompt, and `check` names what is missing.
- **Long paths.** Worktrees sit under `runs\<run-id>\tree`, and a `node_modules` below that can pass the 260-character limit. `git config --global core.longpaths true`, and Windows' own long path setting for the tools that run in setup; `check` notes when the git setting is off.
- **`secrets.env`** needs no `chmod`: NTFS has no POSIX mode bits, so the worker does not warn about them.
- **Finding programs.** In PowerShell `where` is `Where-Object`; use `where.exe git` or `Get-Command git` to see which `git`, `sh` or `claude` is on `PATH`.
- **`diagnostics`** runs `tar` in the directory of the archive and names the archive without its drive, since the GNU `tar` that Git for Windows can put on `PATH` reads `C:\...` as a remote host.

The test suite runs on a Windows runner in CI, see [tests on Windows](./development.md#tests-on-windows).

### As a scheduled task on Windows

Windows has no systemd or launchd. Task Scheduler keeps `globu-worker run` going in the session of the person who is logged on, which is where a run finds the GPU, the `PATH` of that person and their Claude login. A task set to run "whether the user is logged on or not" starts in a session without a desktop and without the GPU.

The task starts a small script, because Task Scheduler cannot redirect output. `run-worker.cmd` in the worker's home:

```bat
@echo off
cd /d "%USERPROFILE%\.globu\worker"
call globu-worker run >> logs\service.out 2>&1
exit /b %ERRORLEVEL%
```

Register it from PowerShell:

```powershell
$worker = "$env:USERPROFILE\.globu\worker"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless cmd /c `"$worker\run-worker.cmd`"" -WorkingDirectory $worker
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "globu-worker" -Action $action -Principal $principal -Settings $settings
```

```powershell
Start-ScheduledTask -TaskName "globu-worker"
```

What each part is for:

| Setting | Why |
|---|---|
| `-LogonType Interactive` | The task runs in the console session of the logged-on user, with the GPU and that user's environment |
| `-ExecutionTimeLimit ([TimeSpan]::Zero)` | No time limit. The default stops a task after three days |
| `-MultipleInstances IgnoreNew` | A second start while the worker runs does nothing. A second worker would be refused by `worker.lock` anyway |
| `conhost.exe --headless` | Gives the worker a console without a window on the desktop. Git, `gh` and `claude` are console programs and need one |
| `>> logs\service.out 2>&1` | Appends what `run` prints, each line with its time, see [the service log](#the-service-log) |
| Sleep | Nothing to set: the worker [keeps the machine awake](#keeping-the-machine-awake) while it runs. `-AllowStartIfOnBatteries` and `-DontStopIfGoingOnBatteries` only matter on a laptop |
| No restart on failure | Leave `-RestartCount` and `-RestartInterval` unset. Task Scheduler cannot tell exit code 69, a stop for a machine problem, from any other failure, and a restart into that problem repeats it. After such a stop the task's last result is 69 (`0x45`); fix the machine and start the task again |

Add `-Trigger (New-ScheduledTaskTrigger -AtLogOn)` to `Register-ScheduledTask` to start the worker with the session.

**Stopping.** Stop the worker, not the task. `Stop-ScheduledTask` ends `conhost.exe` only: the `cmd.exe` below it and the worker keep running without a console, and every program they start from then on fails with exit code `0xC0000142`. End the worker and what it started, and the task ends by itself:

```powershell
taskkill /T /F /PID (Get-Content "$env:USERPROFILE\.globu\worker\worker.lock" | ConvertFrom-Json).pid
```

Windows has no `SIGTERM` to send, so this is a hard stop. Between runs it costs nothing. During a run it ends Claude as well: at its next start the worker finds the unfinished run, removes its worktree and gives the issue back with "the worker restarted while this issue was claimed", and the lock file left behind is stale by its pid and is taken over.

Do not replace `run` with a loop of `globu-worker once` in the script. A loop whose console is taken away keeps spinning with every `once` failing at once, where a single `run` is one process to stop.
