---
type: "Reference"
title: "Claude Code hook contract"
description: "The Claude Code hook behaviours Globu's session and guard hooks rely on, where each is documented and which ones are still untested."
---

# Claude Code hook contract

Globu's two hooks depend on how Claude Code runs hooks. This page lists what they rely on, so a change in Claude Code can be checked against one place. Everything under "Relied on" was read in the Claude Code docs on 2026-10-05. Nothing here was tested against a live permission prompt. The deny path and `--plugin-dir` were tried in a `claude -p` run on 2026-10-08: the guard refused a write into a `read` shard with exit code 2 and Claude reported the reason.

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
| `--plugin-dir` loads a plugin with its hooks in a `-p` run, and the hooks inherit the environment of the `claude` process. Tested on 2026-10-08. | the bootstrap for unattended runs, which sets `GLOBU_HOME` for the job |

## Not settled

Neither point is answered by the docs, and neither was tested:

- Whether "don't ask again" for the session silences later prompts raised by the hook. If it does, an `ask` shard prompts once per session. If not, it prompts on every edit.
- Whether a hook's `ask` still prompts under `bypassPermissions`.

Test both with a sibling repo in `ask` mode before relying on the mode for a rule that must hold.

## Relied on by the worker, untested

[globu-worker](./worker.md) starts Claude with `-p` and leans on these, none of which has been tried against a live run yet:

- `--permission-mode dontAsk` denies, rather than hangs on, a tool call the allowlist does not cover and a hook's `ask`.
- `--settings <file>` with `permissions.allow` and `permissions.deny` is honoured next to the config dir's own settings, and `deny` wins over `allow`.
- `--add-dir <dir>` lets `Write` reach the run directory without a prompt under `dontAsk`.
- `--output-format stream-json` carries a denied tool call as a `tool_result` with `is_error` and the hook's reason in its content, so blocked writes can be read from the stream.
- `CLAUDE_CONFIG_DIR` moves plugin installs and `settings.json` together, so the worker's plugin and the `additionalDirectories` from `globu claude sync` land in the same place.

Test each with a throwaway repository before the first unattended run, then move it to the table above.

## Cost

The guard runs before every `Edit`, `Write`, `NotebookEdit` and `Bash` call. A call takes about 50 ms, most of it Node starting. It returns before any git process runs when no shard is in `read` or `ask` mode.
