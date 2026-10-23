---
name: register-knowledge-base
description: Register a knowledge shard with Globu so Claude can find it in every session. Use when the user wants to add, register or import a repo, folder or knowledge base into Globu, or says "register knowledge base".
---

# Register a shard

A shard is one registered unit of knowledge: a git repo plus what Globu knows about reading it. The CLI is installed with this plugin at `node_modules/@kazet/globu/dist/globu.mjs` in the plugin root (two directories above this file). It never prompts, so you collect the answers and pass flags.

## Workflow

1. **Find out what to register.** Either a local directory (often the current repo, `.`) or a git URL.

2. **Ask the two placement questions, unless the answer is already clear.**
   - Will the user edit this knowledge from this machine?
   - If yes and it is a URL, where should the clone live?

   | Situation | Flags |
   |---|---|
   | Local directory | none (it is adopted in place, editable) |
   | URL, read only | none (cloned under `~/.globu/clones`, kept up to date by `globu sync`) |
   | URL, editable | `--path <dir>` |
   | Local directory the user does not want Claude to edit | `--mode read` |
   | Code repo that sessions in other repos may edit only after asking | `--mode ask` |

3. **Register it.**
   ```bash
   node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs register <path-or-url> [--id <id>] [--mode read|write] [--path <dir>] --json
   ```
   The output includes the detected `format`, the `roots` and their `entry` files.

4. **Draft the routing text.** Read the entry files (and a few more if they are thin). Then write:
   - `description`: one sentence saying what knowledge the shard holds.
   - `useWhen`: one sentence saying which tasks or questions should send Claude there. Be concrete: name the systems, domains or kinds of decision.

   These two lines are all Claude sees at session start, so they decide whether the shard ever gets used. Show them to the user and adjust if they object.

5. **Save the routing text.**
   ```bash
   node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs set <id> --description "<text>" --use-when "<text>"
   ```

6. **Report** the id, format, mode and location. Mention that the shard appears in new sessions, not the current one, and that `globu claude sync` lets Claude read shard folders without permission prompts.

## Notes

- If the command says the repo is already registered, use `globu show <id>` and `globu set` instead.
- A repo without an `origin` remote can be registered but will not sync to other machines. Tell the user.
- Registering from a git worktree records the repo's main checkout. Sessions in any worktree of that repo are still pointed at their own worktree.
- To bring in a whole team's shards at once, run `globu import <manifest-path-or-repo-url>` to see what it would add and then again with `--yes`; `globu sync` clones what it added. The team manifest is a plain Globu manifest, by convention at `.globu/manifest.yaml` in a shared repo.
- Never register a repo the user did not ask for.
