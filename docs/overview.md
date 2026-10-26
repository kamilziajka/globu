---
type: "Overview"
title: "Overview"
description: "The problems Globu solves, for whom, and a worked example from an empty repo to a session that finds and updates knowledge across repos."
---

# Overview

Globu is for people who work with Claude Code across several repositories and want Claude to start every session knowing where the relevant knowledge is, and to write what a session learned back to the right place.

## The problems it solves

- **Knowledge that lives next to code is invisible from other repos.** A product repo's decision records, a backend's data model or an infrastructure repo's runbooks are exactly what a session in another repo needs, and Claude Code only sees the repo it started in. Globu keeps a per-user registry of such knowledge sources, called shards, and tells Claude at the start of every session which ones exist, what each holds and when to consult it.
- **A session learns things and forgets them.** A root cause, a decision, an API shape or a gotcha found during a task is gone when the session ends unless someone writes it down. The `update-knowledge` skill summarises the session, routes each item to the base or shard that owns it and writes it in that base's own conventions.
- **Knowledge bases need a shape that both people and agents can edit.** Globu uses [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md): a directory of Markdown files with frontmatter, usually `docs/`, with an `index.md` that carries the authoring guide and a dated log. Any editor works, and `globu base validate` checks the structure. A repo can hold many bases, one per package, and knowledge about a piece of code belongs in the nearest base above it.
- **Not every repo may be edited from everywhere.** Each shard has a mode. A read-only shard is never edited, an `ask` shard makes Claude Code prompt before an edit from a session in another repo, and a writable one is open. A hook enforces this for the file tools and, best effort, for shell commands.

Nothing in a repo has to change for it to be a shard. Globu reads its bases as they are and keeps everything about the user's set of shards in `~/.globu`.

## A worked example

One repo with its own base, and a second repo that uses it.

1. **Give a repo a base.** In the repo, `/globu:setup-knowledge-base` asks whether the base should live in `docs/`, `wiki/`, `knowledge/` or a directory of your own naming, then creates its `index.md` with the authoring guide and its `log.md`, or upgrades a base that is already there. From then on the edit hook validates the base after every change Claude makes to it.

2. **Record what a session learned.** After a task, `/globu:update-knowledge` lists what was decided or discovered, says which doc each item goes to, writes it, adds a log entry and validates. The edits stay in the working tree, so they ship in the same commit as the code.

3. **Register the repo.** `/globu:register-knowledge-base` adopts the repo as a shard and drafts two lines of routing text: what the shard holds and when to consult it. A repo given by URL is cloned read-only under `~/.globu/clones`, or, with a path, as an editable clone. The skill then offers `globu claude sync`, which lets sessions in other repos read the shard without a permission prompt.

4. **Work from another repo.** A session started anywhere begins with the shard index: each shard's location, routing text and entry file. When a task touches a shard's area, Claude reads that shard's `index.md` and follows the links. When the task produces knowledge that belongs to a shard, `update-knowledge` writes it there, within that shard's mode.

5. **Keep it current.** `globu sync` pulls the clones Globu owns and fetches the user's own. `globu doctor` reports clones that are missing or drifted and shards without routing text. Contexts (`globu context set work product team-*` then `globu use work`) select which shards a session sees.

See [architecture](./architecture.md) for how the pieces fit, [knowledge bases](./knowledge-base.md) for the base model and commands, and the [CLI reference](./globu-cli.md) for every command.
