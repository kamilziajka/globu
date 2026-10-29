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

6. **Offer `globu claude sync`.** Without it, the first read of the new shard from another repo raises a permission prompt in every session. Tell the user in one line what the command does: it adds the paths of all active shards, not only this one, to `permissions.additionalDirectories` in their Claude settings, and in `acceptEdits` mode files under those paths can then be edited without a prompt, which is what `--mode read` and `--mode ask` are for. Ask once. On a yes, run:
   ```bash
   node <plugin-root>/node_modules/@kazet/globu/dist/globu.mjs claude sync
   ```
   Never run it unasked. Changing the user's Claude settings is never a side effect of registering.

7. **Report** the id, format, mode and location, and whether the paths were added to the Claude settings. Mention that the shard appears in new sessions, not the current one.

## Notes

- If the command says the repo is already registered, use `globu show <id>` and `globu set` instead.
- A repo without an `origin` remote can be registered but will not sync to other machines. Tell the user.
- Registering from a git worktree records the repo's main checkout. Sessions in any worktree of that repo are still pointed at their own worktree.
- To bring in a whole team's shards at once, run `globu import <locator>` to see what it would add: the locator is a manifest path, a repo URL or the browser link to the manifest file on GitHub or GitLab. The preview ends with the exact command that applies it, including `--context <name>` when the team manifest defines one context. Before `globu sync`, attach every repo the user already has cloned with `globu register <path>`, otherwise `sync` makes a second, read-only copy under `~/.globu/clones` and the user keeps editing the other one. Then `globu sync` for the rest and, with the user's agreement, `globu claude sync`. `globu import <locator> --yes --sync` does the import and the clones in one step when nothing is cloned yet.
- Never register a repo the user did not ask for.
