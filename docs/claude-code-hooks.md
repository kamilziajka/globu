---
type: "Reference"
title: "Claude Code hook contract"
description: "The Claude Code behaviours Globu's hooks and the worker rely on, where each is documented or how it was measured and which are still untested."
---

# Claude Code hook contract

Globu's hooks depend on how Claude Code runs hooks. This page lists what they rely on, so a change in Claude Code can be checked against one place. Everything under "Relied on" was read in the Claude Code docs on 2026-10-05. Nothing here was tested against a live permission prompt. The deny path and `--plugin-dir` were tried in a `claude -p` run on 2026-10-08: the guard refused a write into a `read` shard with exit code 2 and Claude reported the reason.

Sources: the [hooks reference](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions), [permission modes](https://code.claude.com/docs/en/permission-modes), [headless mode](https://code.claude.com/docs/en/headless) and [worktrees](https://code.claude.com/docs/en/worktrees).

## Relied on

| Behaviour | Used by |
|---|---|
| Hook input arrives as JSON on stdin with `cwd` and, for tool events, `tool_input`. `Edit` and `Write` carry `file_path`, `NotebookEdit` carries `notebook_path` and `Bash` carries `command`. | both hooks, parsed in `packages/globu-cli/src/cli/run.ts` |
| `cwd` is the directory Claude is working in. In a worktree session it is the worktree root, and it moves when Claude runs `cd`. | the index and `list` use it to find the session's worktree |
| `CLAUDE_PROJECT_DIR` is exported to the hook process and stays at the directory the session started in, also after `cd` and after entering a worktree. | the guard uses it as the session's home |
| A PreToolUse hook that exits 2 blocks the tool call and Claude reads stderr as the reason. JSON on stdout cannot override it. | the guard, for `read` shards |
| A PreToolUse hook that exits 0 and prints `hookSpecificOutput.permissionDecision: "ask"` makes Claude Code prompt the user. `permissionDecisionReason` is shown in that prompt, labelled `[plugin:globu]`. | the guard, for `ask` shards and possible writes |
| When several hooks disagree, precedence is `deny`, then `defer`, then `ask`, then `allow`. | the guard can only tighten what another hook allows |
| A hook's `ask` also forces the prompt in auto mode. In a `-p` run with nobody to answer, the call is denied and Claude reads the reason. | `ask` shards stay protected in unattended runs |
| `acceptEdits` approves edits inside the working directory and inside `permissions.additionalDirectories` without a prompt. | this is why `ask` exists: after `globu claude sync` a sibling shard would otherwise be edited silently |
| Top-level `decision` and `reason` are deprecated for PreToolUse. | the guard prints `hookSpecificOutput` only |
| A PostToolUse hook that exits 0 and prints `hookSpecificOutput.additionalContext` (with `hookEventName: "PostToolUse"`) has the text added for Claude next to the tool result, as a system reminder. Plain stdout from a PostToolUse hook does not reach Claude. Read on 2026-11-15 and tried in a `claude -p` run the same day: Claude reported the `status` warning after a `Write`. | the edit hook, for warnings about optional OKF fields |
| `--plugin-dir` loads a plugin with its hooks in a `-p` run, and the hooks inherit the environment of the `claude` process. Tested on 2026-10-08. | the bootstrap for unattended runs, which sets `GLOBU_HOME` for the job |
| A Bash rule of `--allowedTools` matches the command by its words, so `Bash(globu base stamp *)` allows `globu base stamp a.md` and not `node <script> globu base stamp a.md` or `globu base validate`, and a `*` inside a rule of `--disallowedTools` matches any text, so `Bash(globu base stamp *--verified*)` refuses `--verified` before or after the files. Under `--permission-mode dontAsk` the disallowed rule wins over the allowed one. A directory first on the `PATH` of the `claude` process stays first in its Bash tool. Tried in a `claude -p` run on 2026-11-15 with Claude Code 2.1.316 on macOS: `type globu` named the worker's launcher, with another `globu` installed through nvm further down the `PATH`. | the worker's allowlist and launcher, which let a run stamp `generated` but not `verified` |

## Not settled

Neither point is answered by the docs, and neither was tested:

- Whether "don't ask again" for the session silences later prompts raised by the hook. If it does, an `ask` shard prompts once per session. If not, it prompts on every edit.
- Whether a hook's `ask` still prompts under `bypassPermissions`.

Test both with a sibling repo in `ask` mode before relying on the mode for a rule that must hold.

## Seen in worker runs

[globu-worker](./worker.md) starts Claude with `-p --output-format stream-json`. These were measured on 2026-11-15 with Claude Code 2.1.316, in the streams of real runs and in short `claude -p` runs made for the purpose. None of it is in the Claude Code docs, so check it again when a run's records stop adding up.

| Behaviour | Used by |
|---|---|
| A run that starts a command with `run_in_background` ends its turn, and `claude -p` stays up and wakes it for each task that finishes. Every stretch of work ends with a `result` line of its own, numbered by `result_index` from 0. | `summarizeStream` reads all of them, see [segments](./worker.md#segments) |
| In a `result` line `num_turns` and `duration_ms` count that stretch only, while `total_cost_usd` and `duration_api_ms` are running totals of the run. | `run.json` sums the first two and keeps the last value of the others |
| `--max-turns` counts each stretch from zero: under `--max-turns 3` a run used 2 turns, was woken and used 3 more before `error_max_turns`. | `claude.maxTurns` is documented as a bound on a segment |
| The `init` event lists the loaded plugins with `name`, `version`, `source` (`globu@globu`) and `path`, and the MCP servers with `name` and `status`. | `check` compares the `globu` plugin's version with the worker's and names what a run loads |
| Under `--permission-mode dontAsk` a call that no rule covers is denied at once with "Permission to use Bash has been denied because Claude Code is running in don't ask mode", and listed in the result's `permission_denials`. | the run goes on, and `run.json` keeps the denied calls |
| An allow rule from a settings source Claude Code trusts applies on top of `--allowedTools`, also under `dontAsk`: with `--allowedTools "Bash(echo *)"` and the rule `Bash(touch:*)` passed through `--settings`, `touch` ran and `mkdir` was denied. The `settings.json` of the config dir is such a source. The same rule in the `.claude/settings.json` of a folder that was never trusted was ignored. | why `claude.configDir: user` gives a run the person's allow rules, and why `check` lists them |
| Read-only Bash commands such as `ls` and `pwd` run under `dontAsk` with no rule at all. | nothing relies on it; a test of the allowlist needs a command that writes |

## Relied on by the worker, untested

[globu-worker](./worker.md) starts Claude with `-p` and leans on these, none of which has been tried against a live run yet:

- `--permission-mode dontAsk` denies, rather than hangs on, a hook's `ask`. A call the allowlist does not cover is denied, see above.
- A tool of `--disallowedTools` wins over an allow rule of the config dir's `settings.json`, as it does over `--allowedTools`.
- `--add-dir <dir>` lets `Write` reach the run directory without a prompt under `dontAsk`.
- `--output-format stream-json` carries a denied tool call as a `tool_result` with `is_error` and the hook's reason in its content, so blocked writes can be read from the stream.
- `CLAUDE_CONFIG_DIR` moves plugin installs and `settings.json` together, so the worker's plugin and the `additionalDirectories` from `globu claude sync` land in the same place.

Test each with a throwaway repository before the first unattended run, then move it to the table above.

## Cost

The guard runs before every `Edit`, `Write`, `NotebookEdit` and `Bash` call. A call takes about 50 ms, most of it Node starting. It returns before any git process runs when no shard is in `read` or `ask` mode.
