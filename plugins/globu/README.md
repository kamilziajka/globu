# globu

Claude Code plugin that keeps [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) knowledge bases inside a repo and gives Claude a per-user registry of knowledge shards across repos.

- `/globu:setup-knowledge-base [path]` bootstraps or upgrades a base, in `wiki` by default, or in `docs`, `knowledge` or a directory of your choice.
- `/globu:register-knowledge-base` adds a shard to the registry and drafts its routing text.
- `/globu:update-knowledge` writes what a session learned to the right base or shard.
- `/globu:issue-check` reads a Jira issue and checks with `globu resolve` that each reference exists on its repo's default branch.
- `/globu:issue-fix` runs that check and rewrites the broken references in the issue after the user confirms the edit.
- `/globu:issue-deliver` implements an issue from a brief that names the issue, the worktree and the referenced files, and writes a handback. The `globu-worker` program runs it unattended.
- A session hook tells Claude which shards exist on this machine and when to consult them.
- A guard hook blocks edits to read-only shards and makes Claude Code ask before edits to shards in `ask` mode. It covers the file tools and, best effort, shell commands.
- An edit hook validates a base right after Claude edits a file in it.

See [docs/knowledge-base.md](../../docs/knowledge-base.md), [docs/globu-cli.md](../../docs/globu-cli.md) and [docs/architecture.md](../../docs/architecture.md).
