---
name: setup-knowledge-base
description: Bootstrap or upgrade an OKF knowledge base (a docs/, wiki/ or knowledge/ directory) in a repo or in one module of a repo. Use when the user asks to set up, initialize or upgrade a knowledge base, or to add a base to a package. Idempotent, safe to re-run.
---

# Set up an OKF base

An OKF base is a directory with an `index.md` that carries `okf_version`, a `log.md` and concept docs. The directory is usually called `docs/`, `wiki/` or `knowledge/`, but any name works: a base is recognised by its `index.md`, not by its name. A repo can hold several bases, for example one at the root and one per package. Nothing links them together: they are found by scanning, and knowledge about a piece of code belongs in the nearest base walking up from that code.

## Command

The CLI is installed with this plugin at `node_modules/@kazet/globu/dist/globu.mjs` in the plugin root (two directories above this file).

```bash
node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs base setup [target] [--dir <name>] [--name <name>] [--description "<one sentence>"]
```

- `target` defaults to the current directory. Pass the directory that should contain the base, or the base directory itself.
- `--dir` names the base directory inside `target`, `docs` by default. Without it, an existing base directly under `target` is upgraded whatever it is called.
- `--name` defaults to the name of the directory holding the base.
- `--description` is one sentence saying what this base covers. Other tools use it to decide when to read the base, so always supply one for a new base.

The command creates `index.md` and `log.md` when they are missing. On an existing base it only fills in required frontmatter and refreshes the authoring guide block between its markers. It never touches other content.

## Your job

1. If it is unclear which directory should hold the base (repo root or a specific package), ask the user. Otherwise proceed.
2. Check whether `target` already holds a base (`base list <target>`). If it does, upgrade it in place and skip the next step.
3. For a new base, ask the user what to call the directory with `AskUserQuestion`: `docs` (recommended, the convention most tools expect), `wiki` or `knowledge`, and let them type another name through the Other option. Pass the answer with `--dir`. Skip the question when the user already named the directory.
4. For a new base, draft the description from what the directory contains and pass it with `--description`.
5. Run the command and report what was created, updated or left unchanged.
6. If validation fails, show the errors and fix the files directly.
7. Do not commit unless the user asks.
