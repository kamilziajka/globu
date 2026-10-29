---
type: "Reference"
title: "globu CLI"
description: "Command reference for the globu CLI: knowledge bases, registering shards, contexts, sync, diagnostics and the hook entry points."
---

# globu CLI

Published to npm as `@kazet/globu` and built to `packages/globu-cli/dist/globu.mjs`. Source: `packages/globu-cli/src/globu.ts` on top of `packages/globu-core`, with the `base` group in `packages/globu-cli/src/base.ts` on top of `packages/knowledge-base` and the commander runner in `packages/globu-cli/src/cli`. Add `--json` to any command. `--help` works on the program and on every command. The CLI never prompts.

Environment:

- `GLOBU_HOME`: config directory, default `~/.globu`. When the home directory is not writable the default is `globu` under the system temp directory.
- `GLOBU_CONTEXT`: overrides the active context for one process.
- `GLOBU_GIT_TOKEN`: makes the clones Globu makes and the pulls of clones it owns go over https with this token. `GLOBU_GIT_USER` sets the user name sent with it, default `x-access-token`. See [unattended runs](./unattended-runs.md).
- `CLAUDE_CONFIG_DIR`: where `claude sync` finds `settings.json`, default `~/.claude`.

## Knowledge bases

The `base` group works on the repo the command runs in and needs no registered shard. See [knowledge bases](./knowledge-base.md) for the commands and the ownership rule.

## Shards

| Command | Purpose |
|---|---|
| `register <path>` | Adopt the git repo containing `path` in place. Editable unless `--mode read` or `--mode ask`. From a linked worktree it records the main checkout. |
| `register <url>` | Shallow clone into `~/.globu/clones/<id>`, read-only. |
| `register <url> --path <dir>` | Full clone at `dir` (or adopt a matching clone already there), editable. |
| `unregister <id> [--purge]` | Remove from manifest and state. `--purge` also deletes a globu-owned clone. User-owned clones are never deleted. Prints a `globu claude sync` reminder when the Claude settings still list the clone. |
| `list [--all]` | Shards in the active context, or all of them. Run inside a worktree of a shard's repo, it adds that worktree as `this session: <dir>`. With `--json` every shard carries `here` and `workPath`. |
| `show <id>` | Everything known about one shard. |
| `set <id> [--description] [--use-when] [--mode] [--access]` | Edit routing text, local mode or the manifest's access cap. |
| `reprobe <id> [--dry-run]` | Detect format and roots again and update the manifest. It prints the old and new format and roots; `--dry-run` prints them without writing. |
| `sync` | Clone shards missing on this machine, pull globu-owned clones, fetch user-owned ones. With `GLOBU_GIT_TOKEN` set the clones and pulls go over https with that token. Reminds about `globu claude sync` when it cloned anything. |

Other `register` flags: `--id`, `--description`, `--use-when`.

Behaviours worth knowing:

- The id defaults to the repo name. Two URL spellings of the same repo (ssh and https) count as the same shard.
- Registering a repo that is already in the manifest attaches a local clone to the existing entry. That is how a manifest synced from another machine gets its paths, and how an imported shard that `sync` cloned read-only is pointed at the clone you already had: the read-only clone under `~/.globu/clones` is deleted in that case, since Globu owns it.
- The repo URL is read from the `origin` remote, or from the only remote when there is no `origin`. A repo with no remote, or with several and none called `origin`, can be registered, but its manifest entry has no URL and other machines cannot sync it.
- `--mode` takes `read`, `ask` or `write`. `ask` lets sessions inside the shard's repo edit it and makes every other session prompt first. `--access` takes `read` or `write`.
- `--mode write` and `--mode ask` are refused for a globu-owned clone. Register the URL again with `--path` to get an editable clone.

## Team manifests

| Command | Purpose |
|---|---|
| `import [locator]` | Merge a team manifest into this machine's manifest. The locator is a manifest file, a directory holding `.globu/manifest.yaml`, a git URL of a repo holding it, or a browser link to the file inside the repo on GitHub or GitLab. Without `--yes` it only prints what would be added, updated and defined, and the full command that applies it. With no locator it refreshes every import recorded earlier. |

Flags: `--file <path>` names the manifest inside the repo or directory, `--context <name>` makes that context active once the import is written, `--yes` writes, `--sync` runs `globu sync` right after a `--yes` import.

A browser link such as `https://gitlab.example.com/group/repo/-/blob/main/.globu/manifest.yaml` (GitLab `/-/blob/` and `/-/raw/`, GitHub `/blob/` and `/raw/`, and `raw.githubusercontent.com`) is split into the repo URL, the ref and the file. The repo is cloned at that ref and the record under `imports` keeps all three, so a refresh reads the same file at the same ref. A ref the clone cannot check out, for example a commit id, is an error that says which repo URL and `--file` to pass instead.

Each import records the commit of the team repo it read, when the source is a git URL or a directory inside a repo. The output shows that commit and the one read last time, so a refresh says whether the team manifest moved. When a team manifest defines exactly one context and it is not the active one, the preview puts `--context <name>` into the suggested command and a written import says how to activate it.

Ids are global: a team shard whose id or repo is already registered under something else is an error and nothing is written. A team shard that matches a local one by id and repo updates its manifest entry and leaves the clone, mode and path alone. The import is one level deep. New shards have no clone until `globu sync` runs, which clones them read-only. A written import that added shards therefore ends with the three steps that follow: `globu register <path>` for each repo already cloned on the machine, so that clone is attached editable and no second copy is made, then `globu sync` for the rest, then `globu claude sync`. The reasoning and a CI example are in [unattended runs](./unattended-runs.md).

## Contexts

| Command | Purpose |
|---|---|
| `context list` | Show contexts and which is active. |
| `context set <name> <id-or-pattern...>` | Define a context. `*` is a wildcard. |
| `context rm <name>` | Delete a context. |
| `use <name>` | Make a context active for new sessions. |
| `use --all` | Clear the active context so every shard is active. |

## Claude Code

| Command | Purpose |
|---|---|
| `index` | Print the text the session hook injects, for the directory it is run in. |
| `claude sync [--remove]` | Add the active shards' paths to `permissions.additionalDirectories`, or remove the ones Globu added. Entries Globu did not add are never touched. The register skill offers to run it after registering. |
| `hook session-start` | SessionStart entry point. Prints the index, or nothing. |
| `hook validate-edit` | PostToolUse entry point for `Edit` and `Write`. Validates the base that owns an edited Markdown file and exits 2 with the errors when it fails. |
| `hook guard` | PreToolUse entry point for `Edit`, `Write`, `NotebookEdit` and `Bash`. Exit code 2 when the target is in a `read` shard. For an `ask` shard changed from a session in another repo it prints a PreToolUse `permissionDecision` of `ask` and exits 0. Targets are matched to shards by git repo, so linked worktrees count wherever they are. For `Bash` it reads `tool_input.command`: certain writes are treated like file edits, possible ones only prompt. See [architecture](./architecture.md) for the rules and their limits. |

## References

| Command | Purpose |
|---|---|
| `resolve <ref...>` | Check that each reference exists on the default branch of its repo, then print the index of the shards the references touched. Exit code 1 when any reference fails. |

A ref is `<shard-id>/<path>` when its first segment is a registered shard id, and otherwise a path relative to the current directory in the repo the command runs in. A shard id alone means the root of that shard's repo. The default branch is `origin/HEAD` as last fetched, or `HEAD` of the main checkout when the repo has no `origin/HEAD`. A file that exists only in the working tree, in a linked worktree, in an unpushed commit or on another branch does not resolve, because a coding agent that checks out the repo will not see it.

Each failure names its reason: the shard is not in the active context, it has no clone on this machine, the path leaves the repo, or the path is not on the default branch. In the last case the worktrees where the path does exist are listed. A path in the current repo that fails while its first segment is not a directory there also says that no shard has that id, which is the usual sign of a shard missing from this machine. A path that is not on the default branch also gets candidates for the file that was meant, each written as a ref that resolves from the same directory. A `renamed` candidate is where git history moved the file on the default branch, followed through up to five renames, including renames made on a branch that was later merged. `similar` candidates are files and directories on the default branch with the same name, ignoring case, with those that share the most path segments with the ref first. There are at most ten, the rename first. The text output prints each as a line after the failure, such as `renamed<TAB><ref><TAB><candidate>`. With `--json` the report has `ok`, `context`, `shards`, `index` and one entry per ref with `ref`, `shard`, `ok`, `location`, `revision`, `worktrees`, `reason` and `candidates`, a list of `{ ref, match }` where `match` is `rename` or `name`. `location` is under the session's worktree when the command runs in one, like the index. Run `globu sync` first when a doc was pushed from elsewhere. The `issue-check` skill extracts refs from a Jira issue and calls this, and `issue-fix` uses the candidates to correct the issue.

## Diagnostics

`doctor` reports, per shard: missing or wrong clone, origin mismatch, a clone that is behind its remote as last fetched, format or roots that changed since registration, a missing entry file and missing routing text. After the shards it checks the paths it added to the Claude settings and reports, under the id `claude-settings`, any that no longer exists or belongs to no registered shard. Exit code 1 when any finding is an error.

An origin mismatch is what a repo transfer or a changed remote leaves behind: `the clone's origin does not match the manifest` names the URL the manifest still holds. No command changes a shard's repo URL, so edit `repo:` under that shard's `source` in `~/.globu/manifest.yaml` to the clone's new origin, exactly as `git remote get-url origin` prints it, and run `doctor` again.

The probe runs on the working tree of the main checkout, not on the default branch, so a format or roots finding says what it found and where: `format is now "generic" (no index.md with an okf_version marker) in the working tree at <path>`. Before trusting it, check that the clone is up to date (the behind warning says so) and on the branch that carries the base, then preview the change with `globu reprobe <id> --dry-run`. Versions before 0.6.0 only recognised a base in a directory called `docs`, so a base at `wiki/index.md` probed as generic until the plugin's pinned CLI was updated.
