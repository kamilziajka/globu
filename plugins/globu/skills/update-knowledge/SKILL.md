---
name: update-knowledge
description: Update the knowledge bases with what the current session learned. Use when the user asks to update, save, persist or write down what was just discussed, or before treating a task as finished if it produced something durable (a decision, an API shape, a gotcha, a root cause). Routes each item to the right Globu shard when shards are registered, and to the current repo's bases otherwise. Also accepts an explicit list of base directories to update.
---

# Update knowledge

Decides where each piece of knowledge belongs, checks that it may be written there and then writes it using that base's own conventions. The CLI is installed with this plugin at `node_modules/@kazet/globu/dist/globu.mjs` in the plugin root (two directories above this file): `list` names the registered shards and the `base` commands find, log and validate OKF bases.

## Workflow

1. **Summarize the session.** List what was learned or decided: facts, decisions, API shapes, gotchas, root causes, repeatable procedures. If nothing is durable, say so and stop.

2. **List the candidate targets.**
   - If you were given explicit base directories (arguments to this skill), use exactly those and skip to step 5.
   - List the shards:
     ```bash
     node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs list --json
     ```
     Each shard has `id`, `path`, `workPath`, `here`, `mode`, `format`, `roots`, `description` and `useWhen`. Run the command from the session's working directory: `here` is true for the shard whose repo you are working in, and `workPath` is where to read and write it. In a git worktree `workPath` is the worktree, not the main checkout in `path`.
   - List the bases of the current repo:
     ```bash
     node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs base list --json
     ```
     They are the targets for knowledge about this repo's code whether or not the repo is a shard. If there are no shards and no bases, tell the user and offer the `setup-knowledge-base` skill.

3. **Choose a target for every item, explicitly.** There is no default target.
   - Knowledge about a piece of code belongs in the nearest base walking up from that code. To check a specific file:
     ```bash
     node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs base owner <path-to-code-file>
     ```
     Cross-cutting knowledge with no single owner goes to the base at the repo root.
   - Match every other item against each shard's `description` and `useWhen`.
   - Personal or confidential material goes only to a shard the user owns privately. Never move it into a shared shard.
   - If an item fits no target, or fits more than one, ask the user. Do not guess.

4. **State the plan before writing**: each item and the base or shard it will go to. If any target is a shared shard, or the user has not seen this routing before, wait for confirmation.

5. **Check access** by shard `mode`. A base of the current repo that is not part of a shard is always writable.
   - `write`: edit.
   - `ask`: edit freely when `here` is true. Otherwise the shard belongs to another repo: get the user's explicit agreement in this session before the first edit, and expect a permission prompt on every edit.
   - `read`: do not edit. Tell the user what you would have written and stop there for that item.

6. **Write, per target, using its format.**
   - `okf`: read the base's `index.md` first, it carries the authoring guide, and skim the existing concept docs. Prefer editing an existing doc over creating a near-duplicate. New concept docs need frontmatter with a non-empty `type`, plus `title` and `description`; use `type: "Playbook"` for a repeatable procedure. Add new docs to the Contents list in `index.md`. Then record the change in the log and validate:
     ```bash
     node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs base log <docsDir> <YYYY-MM-DD> "<entry>" ["<entry>" ...]
     node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs base validate <docsDir>
     ```
     Fix any errors before finishing. Build `<docsDir>` from the shard's `workPath` joined with the root's `path`, never from `path`: from a worktree that would send the edits to the main checkout.
   - `generic`: follow the conventions the existing files already use. Keep the change small and say what you changed.

7. **Report** what was written where, and what was skipped and why.

## Guardrails

- Leave edits in the working tree. Do not commit, branch or push unless the user asks. In a code repo the knowledge change normally ships in the same commit as the code change.
- Name the target for every write. Never write to a base or shard just because you happened to be reading it.
- Do not force an update onto a base the session has nothing to say about.
- Never write to a base outside the current repo unless it belongs to a shard you routed to, or its directory was passed to you explicitly.
- Do not add links from a shared shard to a private one.
