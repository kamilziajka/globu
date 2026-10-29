---
type: "Architecture"
title: "Globu architecture"
description: "The plugin and CLI in this repo, their two halves and how Globu's registry, probe, drivers and Claude Code integration fit together."
---

# Globu architecture

Globu plugs into Claude Code so Claude can find the right knowledge for a task and write new knowledge back after a session. This repo ships one Claude Code plugin, `globu`, and one CLI of the same name, with two halves.

| Half | Scope | Needs the other? |
|---|---|---|
| Knowledge bases (`globu base`, the edit hook) | One repo, any number of OKF bases inside it | No |
| Registry (every other command and hook) | The per-user layer: which knowledge sources exist for me, when to consult them and where writes may go | Yes, through the OKF library |

The dependency runs one way. The registry knows about OKF bases through its `okf` driver. The OKF library in `packages/knowledge-base` knows nothing about the registry, so the single-repo half works with no shard registered.

## Vocabulary

- **Shard**: one registered unit of knowledge. Today a shard is one git repo.
- **Root**: a place inside a shard where knowledge starts, with an entry file. An OKF repo with a base per package is one shard with many roots.
- **Format**: how a shard's knowledge is laid out. Each format has a driver.
- **Context**: a named selection of shards, for example `work` or `personal`.
- **Manifest**: the portable list of shards and contexts.
- **State**: what is true only on this machine.

## Configuration

Everything lives in `~/.globu` (override with `GLOBU_HOME`; when the home directory is not writable the default moves to `globu` under the system temp directory).

`manifest.yaml` is portable. It can be kept in a dotfiles repo and symlinked, and a team can keep one in a shared repo for `globu import` to merge from.

```yaml
version: 1
shards:
  - id: product
    source: { type: git, repo: git@github.com:acme/product.git }
    format: okf
    roots:
      - { path: docs, name: product, entry: docs/index.md }
    description: Product decisions and domain rules
    useWhen: Pricing, roadmap or domain modelling questions
    access: read
contexts:
  work: [product, team-*]
imports:
  - source: git@github.com:acme/product.git
    commit: 4f1c2d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d
```

`imports` records the team manifests merged in with `globu import`, so a later bare `globu import --yes` refreshes them. An entry holds the source, the `file` when it is not the default, the `ref` when the import came from a link to a file on a branch, and the `commit` the team repo was at, so the next refresh can say whether it moved. The merge copies shards and contexts into this file: nothing is resolved at session time, and the team repo is only read when `import` runs.

`state.yaml` is per machine and never shared.

```yaml
version: 1
current: work
shards:
  product: { path: /Users/me/.globu/clones/product, mode: read, owner: globu }
claude:
  directories: []
```

The rule that separates them: anything true on every machine goes in the manifest, anything true only here goes in state.

## Clones

| | Read-only shard | Editable shard |
|---|---|---|
| Owner | `globu` | `user` |
| Location | `~/.globu/clones/<id>` | a path the user chose, or an existing clone adopted in place |
| Clone | shallow | full |
| `globu sync` | fast-forward pull | fetch only, never resets or switches branch |

With `GLOBU_GIT_TOKEN` set, the clone and the pull go over https with the token sent as a header scoped to the repo's host, and an ssh URL is rewritten to https for that git call only. The manifest and the clone's origin keep the URL as written. The fetch of an editable clone uses whatever credentials that clone already has.

A shard's effective mode is the stricter of two settings: the manifest's optional `access: read` cap and the local `mode` in state. The local mode has three values:

| Mode | Meaning |
|---|---|
| `read` | Never edited, not even from a session inside the shard's own repo. |
| `ask` | Edited freely from a session whose home is the shard's repo. From any other session every edit raises a permission prompt. User-owned clones only. |
| `write` | Edited from any session. |

The state path of a shard is always the main checkout of its repo. `register` run from a linked worktree records the main checkout, not the worktree.

## Resolver

The resolver merges manifest and state into resolved shards (`id`, `path`, `mode`, `owner`, `present`, `format`, `roots`, routing text). Every command and hook works from that list. The active context filters it: `GLOBU_CONTEXT` wins, then `current` in state, and with neither set every shard is active.

## Session view

A shard is a repo, not a directory. A session often runs in a linked git worktree of a shard's repo, and that worktree can sit anywhere on disk. The session view (`packages/globu-core/src/session.ts`) adds two fields to each resolved shard for one working directory:

- `here`: the directory is in the main checkout or in any linked worktree of the shard's repo.
- `workPath`: the root of that checkout when `here` is true, otherwise the shard's `path`. This is where the session reads and writes the shard.

Two checkouts belong to the same repo when they share a git common directory. The origin URL is not used: a second clone of the same repo is a different working copy, and a read-only managed clone must not block edits in the user's own clone.

For a main checkout the common directory is its own `.git` directory, so a shard's side of the comparison needs no git process. Only a shard whose `.git` is a file, such as a worktree of a bare repo, costs a `git rev-parse`. The session's side is one `git rev-parse` per directory looked up.

The roots stay the ones pinned from the main checkout. A base added or removed on a worktree's branch does not show in that session's index until the change reaches the main checkout and `globu reprobe` runs.

The index, `list` and both hooks use the session view. `show`, `doctor`, `sync` and `claude sync` work on the registry and always mean the main checkout.

## Probe and drivers

The probe turns a directory into a shard proposal. It asks each driver in order whether it recognises the directory. The first match wins and the result is pinned in the manifest, so the probe runs at registration and not every session. `globu doctor` reports drift and `globu reprobe` refreshes the pinned result, or shows it with `--dry-run`. Both read the working tree of the main checkout, so a stale or differently-branched checkout is probed as it is.

A driver has a fixed interface:

| Member | Purpose |
|---|---|
| `name` | The format name pinned in the manifest |
| `detect(dir)` | Returns the roots and a description when the directory is in this format |
| `conventions` | The reading and writing rules given to Claude in the session index |

Drivers so far, in detection order:

1. `okf`: any tracked `index.md` carrying `okf_version`, whatever its directory is called. Each base is a root.
2. `generic`: matches everything. The entry is the README when there is one.

Source and format are separate axes. The only source type so far is `git`.

The CLI detects structure only. Meaning is drafted by Claude: the `register` skill reads the entry files and proposes `description` and `useWhen`, the two lines that decide whether a shard ever gets consulted.

## Claude Code integration

All of it comes from the `globu` plugin, which should be enabled at user scope.

- **SessionStart hook** runs `globu hook session-start`. It prints the active context's index (id, location, routing text, entry files, format conventions) and Claude Code adds that to the session. Location and entry files come from `workPath`, so a session in a worktree is pointed at that worktree and told to leave the main checkout alone. It prints nothing when no shards are registered. It reads local files and runs `git rev-parse`.
- **PreToolUse guard** runs `globu hook guard` before `Edit`, `Write`, `NotebookEdit` and `Bash`. It finds the shard by the repo the target belongs to, so a file in any worktree maps to its shard. For a `read` shard it blocks the edit with exit code 2. For an `ask` shard it returns the PreToolUse permission decision `ask`, which makes Claude Code prompt the user, unless the session's home is that shard's repo. Home is the repo of `CLAUDE_PROJECT_DIR`, the directory the session started in. The hook's `cwd` is only the fallback because it follows `cd`, and a session must not become exempt by changing into a sibling repo. Shell commands are read as described below.
- **`globu claude sync`** writes the active shards' paths into `permissions.additionalDirectories` in the user's Claude settings so reads need no prompt. It records which entries it added and only ever changes those. It is an explicit command and nothing calls it implicitly. The register skill offers it after a shard is registered and runs it only when the user agrees.
- **PostToolUse edit hook** runs `globu hook validate-edit` after `Edit` and `Write` and validates the base an edited Markdown file belongs to. See [knowledge bases](./knowledge-base.md).
- **Skills**: `setup-knowledge-base`, `register-knowledge-base`, `update-knowledge`, `issue-check` and `issue-fix`.

The repo a session runs in needs nothing. The hooks read `~/.globu` only.

## Resolving references

An issue written for a coding agent points at the docs that govern the work. `globu resolve` (`packages/globu-core/src/resolve.ts`) checks those pointers before the issue is handed over. It maps a ref's first segment to a registered shard, or else treats the ref as a path in the current repo, and asks git whether the path exists on the default branch: `origin/HEAD`, or `HEAD` of the main checkout when there is none.

The check uses the default branch and not the working tree because the agent that delivers the issue checks the repo out fresh, in CI or in a new worktree. A decision record written in one session's worktree and never pushed is on disk here and missing there. When a path fails, the worktrees of the repo are searched so the report can say where the file is stuck. Locations of refs that resolve come from the session view, like the index.

Reading the issue and turning loose mentions such as "decision 12" into refs is meaning, not structure, so it lives in the `issue-check` skill. The CLI knows nothing about Jira.

A failing ref also carries candidates for the file that was meant. A rename comes from git history: the last commit on the default branch that deleted the path, searched with `--full-history` so a rename made on a merged branch is found, and the rename in that commit, followed for up to five hops. Files with the same name come from the tree of the default branch. Choosing between candidates and writing the fix back to Jira is the `issue-fix` skill's job, so the CLI still only reads.

## Unattended runs

A GitHub Actions job, a cloud session or a fresh machine starts with no `~/.globu`, no clones and no plugin. [Unattended runs](./unattended-runs.md) describes the bootstrap that recreates them before Claude starts: `globu import` of a team manifest, `register` of the job's checkout, `sync` with a token from the environment and `claude sync`, with the plugin installed through the action's marketplace inputs or loaded with `--plugin-dir`. After it the hooks behave as they do on a laptop.

## Shell commands in the guard

A shell command cannot be analysed exactly, so the guard reads it as well as a parser without a shell can. `packages/globu-core/src/shell.ts` splits the command into simple commands and their redirects. `command.ts` turns those into targets, each either a certain write or a possible one, and `guard.ts` turns targets into a verdict.

| What the command does | Target | Certainty |
|---|---|---|
| Redirects output to a file (`>`, `>>`, `&>`) | that file | certain |
| `rm`, `rmdir`, `mv`, `touch`, `mkdir`, `tee`, `truncate` | every path argument | certain |
| `cp`, `ln` | the last path argument | certain |
| A command that only reads (`cat`, `ls`, `grep`, `find` without `-delete` or `-exec`, `sed` without `-i` and so on) | none | |
| `git` with a reading subcommand (`status`, `log`, `diff`, `branch --show-current` and so on) | none | |
| Any other `git` subcommand | the directory it runs in, after `-C` | possible |
| Anything else | every path argument and the directory it runs in | possible |

The directory a command runs in follows `cd` and `pushd` within the command. Variables assigned in the same command are expanded, `~` and `$HOME` too, and `bash -c "..."` is read recursively. Heredoc bodies and comments are skipped.

| Shard mode | Certain write | Possible write |
|---|---|---|
| `read` | blocked | prompt, unless the session's home is that repo |
| `ask` | prompt, unless home | prompt, unless home |
| `write` | nothing | nothing |

What it cannot see: paths built from variables set elsewhere, from command substitution or from a pipe into `xargs`, and writes made inside a script the command runs. A possible write therefore prompts instead of blocking, and a miss is possible. The guard lowers the chance of an unnoticed change to another repo. It is not a sandbox.

The Claude Code behaviours all of this depends on are listed in the [hook contract](./claude-code-hooks.md).

## Writing knowledge back

`update-knowledge` names a target for every item, checks the mode and then writes using the target's format. Knowledge about the current repo's code goes to the nearest base walking up from that code, found with `globu base list` and `base owner`, whether or not the repo is a shard. Everything else is matched against the registered shards' routing text. A shard is written under `workPath`, so knowledge written from a worktree lands on that worktree's branch. For `okf` targets the skill follows the authoring guide embedded in the base's `index.md`, logs the change with `globu base log` and validates. Edits are left in the working tree.

Rules that hold everywhere:

- A private shard exists only in its owner's manifest. A shared repo never references it.
- Every write names its target. There is no default shard.
- The CLI never prompts. Skills ask the questions and pass flags.

## Repository layout

```
packages/knowledge-base      OKF library: frontmatter, scan, validate, setup, log
packages/globu-core          manifest, state, resolver, session view, probe, drivers, contexts, Claude settings
packages/globu-cli           the globu program, published to npm as @kazet/globu: the base group, the registry commands, the hooks and the commander runner
packages/testing             test helpers
plugins/globu                the plugin: skills, session, guard and edit hooks, pinned dependency on the CLI
mods/globu-status            the status mod: a plugin of function hooks with its own tests
scripts/                     build and pin
tests/                       checks that run the built bundles and the plugin hooks
```

`packages/knowledge-base` must never import from `packages/globu-core`, and `packages/globu-cli/src/base.ts` imports only the OKF library and the runner.

## Distribution

The CLI is bundled into a single file with no runtime dependencies and published to npm as `@kazet/globu`. Nothing compiled is kept in git.

The plugin is a source-only directory: skills, hooks, `plugin.json` and a `package.json` with a `package-lock.json` that pin the CLI to one exact version. Claude Code copies the plugin into its cache on install and then installs that one dependency, so hooks and skills run the CLI from `node_modules/@kazet/globu/dist` inside the plugin root.

The marketplace is this repo. Its entries point at the plugin and mod directories on the `stable` branch, which only the release moves. `main` can therefore hold skills that are ahead of the published CLI without anyone installing that mix.

The entries name the repo by its full HTTPS URL. Claude Code expands the `owner/repo` shorthand of a `git-subdir` source to an SSH URL without falling back to HTTPS, so on a machine with no GitHub SSH setup the install failed even though adding the marketplace succeeded.

Locally, `npm run build` links the package into the plugin's `node_modules`, so `claude --plugin-dir` runs the working tree.

See [development](./development.md) for tooling and quality gates.
