---
type: "Component"
title: "Knowledge bases"
description: "How OKF knowledge bases inside one repo work: base discovery, ownership rule, the knowledge-base CLI, the edit hook and the skills that use them."
---

# Knowledge bases

The single-repo half of Globu: keeping [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) knowledge bases inside one repo. Source: `packages/knowledge-base` (the library), the `base` command group in `packages/globu-cli/src/base.ts` and, in the `globu` plugin, the edit hook and the `setup-knowledge-base` and `update-knowledge` skills. None of it needs a registered shard, and the library never imports from `packages/globu-core`.

## Model

- A **base** is any directory whose `index.md` carries `okf_version`. It also has a `log.md` and concept docs, each with a `type` in its frontmatter. The directory is usually `docs/`, `wiki/` or `knowledge/`, the three choices the setup skill offers, but the name plays no part in recognising it: only the marker in `index.md` does.
- A repo can hold **many bases**, for example one at the root and one per package in a large Java project.
- Bases are **found by scanning**. Nothing stores a list of them. The scan uses git's file list (tracked files plus untracked files that are not ignored), so build output such as `target/` is skipped. Outside git it walks the directory and skips common build and dependency folders. Either way a nested repo or linked worktree, such as `.claude/worktrees/<name>`, is never searched: git lists it as one entry and the walk skips any directory with its own `.git`.
- **Ownership is by nearest ancestor.** Knowledge about a piece of code belongs in the closest base walking up from that code. At each step up, the directory itself counts if it is a base, otherwise the first base directly under it in name order. Everything else falls to the base at the repo root. The walk stops at the root of the repo or worktree that holds the file, so a file in a worktree is never owned by a base of the main checkout around it.
- The library and the `base` commands never look outside the current repo. Knowledge that spans repos is the registry's job.

Every base carries its own authoring guide inside `index.md`, between `knowledge-base:authoring-guide` markers, named after the library. An agent or person without the plugin can read it and edit the base correctly. When an `index.md` has no markers yet, `setup` inserts the guide after the title and its intro. The intro is the whole first paragraph, and only when that paragraph is prose: a heading, a list, a table or a comment straight after the title is left below the guide. One case is not handled: an intro on the very last line of a file with no final newline is not seen as an intro, and the guide goes above it.

## Commands

The `base` group of the [globu CLI](./globu-cli.md). Add `--json` to any command. `--help` works on the group and on every command.

| Command | Purpose |
|---|---|
| `base setup [path] [--dir] [--name] [--description]` | Create a base or upgrade one in place. Idempotent. `--dir` names the base directory inside `path`, `docs` by default. Without it an existing base directly under `path` is upgraded whatever it is called. |
| `base validate [path]` | Structural check of one base or of every base under a directory. Exit code 1 on errors. |
| `base list [path]` | List every base under a directory. |
| `base owner <file>` | Print the base that owns a file. |
| `base log <docsDir> <YYYY-MM-DD> <entry...>` | Add entries to a base's `log.md`, newest first. It appends to a heading that is exactly `## <date>` or opens one at the top; a base whose log titles its day sections (`## 2026-10-26 (what changed)`) gets a second, bare section for the same day and has to fold it in by hand or edit `log.md` directly. |
| `hook validate-edit` | Hook entry point. |

`setup` only ever changes two things in an existing `index.md`: required frontmatter keys (`okf_version`, `name`, `knowledge_base_version`) and the authoring guide block.

## Hook

The `globu` plugin runs `globu hook validate-edit` as a `PostToolUse` hook on `Edit` and `Write`. When the edited file is a Markdown file inside a base, the base is validated straight away. Errors are returned to Claude with exit code 2 so it can correct them in the same session.

## Skills

Both live in the `globu` plugin.

- `setup-knowledge-base`: runs `base setup` and, for a new base, asks whether the directory should be `docs`, `wiki`, `knowledge` or a custom name, then drafts a description.
- `update-knowledge`: summarizes the session, routes each item to its owning base or to a registered shard, writes the edits, logs them and validates. With no shard registered it works on the current repo's bases alone. It also takes an explicit list of base directories. Edits stay in the working tree. See [architecture](./architecture.md#writing-knowledge-back) for the routing rules.
