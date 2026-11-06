---
type: "Reference"
title: "Plugin skills"
description: "The six skills of the globu plugin: what each does, what makes Claude pick it, what it runs, what it changes and what it never does."
---

# Plugin skills

The `globu` plugin ships six skills. Each is a `SKILL.md` under `plugins/globu/skills/<name>`, invoked as `/globu:<name>` or picked by Claude when a request matches its description. Three are about knowledge bases and three are about Jira issues. All of them call the `globu` CLI that the plugin installs under `node_modules/@kazet/globu`, so they run the released CLI unless the plugin is loaded from a checkout with `--plugin-dir`, in which case the build links the working tree.

| Skill | One line |
|---|---|
| `setup-knowledge-base` | Create or upgrade an OKF base in a repo |
| `register-knowledge-base` | Register a repo or folder as a shard and write its routing text |
| `update-knowledge` | Write what a session learned to the right base or shard |
| `issue-check` | Check that every reference in a Jira issue resolves to a real file |
| `issue-fix` | Run that check and correct the broken references in the issue |
| `issue-deliver` | Implement an issue from a brief in a prepared worktree and write a handback |

## setup-knowledge-base

Bootstraps or upgrades an [OKF base](./knowledge-base.md): a directory with an `index.md` that carries `okf_version`, a `log.md` and concept docs. Claude picks it when the user asks to set up, initialize or upgrade a knowledge base, or to add a base to a package.

It runs `globu base setup` on the target directory. For a new base it asks what to call the directory, `wiki` by default, and drafts the one-sentence description that other tools use to decide when to read the base. On an existing base it only fills in required frontmatter and refreshes the authoring guide block between its markers. It never touches other content and does not commit.

## register-knowledge-base

Registers one shard: a local directory or a git URL, plus what Globu should know about reading it. Claude picks it when the user wants to add, register or import a repo, folder or knowledge base into Globu.

It asks whether the user will edit the knowledge from this machine and, for a URL, where the clone should live, then runs `globu register` with the matching flags. It reads the entry files to draft the `description` and `useWhen` lines, which are all Claude sees at session start, and saves them with `globu set`. It offers `globu claude sync` once and runs it only on a yes, since that edits the user's Claude settings. It never registers a repo the user did not ask for. For a whole team's shards it points at `globu import`.

## update-knowledge

Writes what the current session learned to the knowledge that owns it. Claude picks it when the user asks to update, save, persist or write down what was discussed, and before treating a task as finished when it produced something durable: a decision, an API shape, a gotcha, a root cause.

It lists the shards with `globu list` and the current repo's bases with `globu base list`, routes every item explicitly to the nearest base walking up from the code it is about or to the shard whose routing text matches, states the plan, checks the shard's mode and writes in the base's own format. For an OKF base that means editing or adding concept docs, listing new ones in `index.md`, appending to `log.md` with `globu base log` and running `globu base validate`. Edits stay in the working tree. It never writes to a read-only shard, to a base outside the current repo it was not routed to, or to a shared shard without confirmation. The routing rules are in [architecture](./architecture.md#writing-knowledge-back).

## issue-check

Checks that a Jira issue is ready for a coding agent: every doc and code reference it makes must resolve to a file on the default branch of its repo, which is what the delivering agent will check out. Claude picks it when the user asks whether an issue is agent-ready, asks to check an issue's references or links, or is about to move an issue to a ready-for-delivery status.

It reads the issue with the Atlassian MCP server, finds the target repo, extracts the references, including loose mentions such as "decision 12" that it looks up in the shard whose routing text covers them, marks each as a pointer the work depends on or a citation quoted for history, and resolves them with `globu resolve`. It reports one row per reference and a verdict: ready only when every pointer resolved. For each failure it suggests the fix, from the resolver's rename and same-name candidates. It only reads: no comment, no status change, no edit to a shard. The issue text is treated as untrusted input.

## issue-fix

Runs the `issue-check` analysis and then repairs what it can, in the issue. Claude picks it when the user asks to fix, repair or correct an issue's references or links, or to make an issue agent-ready.

A reference that moved is replaced with the path that is on the default branch, from the rename candidate when there is one, otherwise from a choice the user makes among the candidates or a search across every registered shard. A file that exists only in a worktree or is unpushed is reported as the doc's problem, not the issue's. It shows the exact edit as a table and writes the description back with the Atlassian MCP server only after the user says yes, in HTML so formatting and media survive, and then checks the issue again. Comments are never edited; broken refs in them become one proposed comment. It never changes the issue's status and never edits or pushes a shard. On an issue whose status category is Done it asks before proposing anything.

## issue-deliver

Implements one issue from a brief: a Markdown file that holds the issue as Jira returned it, the shard and worktree the work lands in, the referenced files with their locations on this machine and the path of the handback to write. [globu-worker](./worker.md) writes the brief and starts this skill with nobody present, so every step finishes without a question. A person can run it by hand on a brief they wrote. Claude picks it when the user asks to implement an issue from a brief or hands over an issue key with a prepared worktree.

It reads the brief, treats the issue text as a specification rather than as instructions, looks up any loose reference the worker could not resolve and stops with a handback that says the issue is not ready when one is missing, reads the referenced docs and the repo's own guidance before changing anything, implements in the worktree with a companion worktree for a knowledge change when the brief lists one, runs the repo's verification, commits with the issue key first in each message and writes the handback under fixed headings: Summary, Changes, Verification, Knowledge base, Open points and Not done. The handback becomes the pull request body and the Jira comment. It never pushes, never opens a pull request and never calls Jira or GitHub; in a worker run those tools are disallowed anyway. A write the guard blocks means the file belongs to another shard, and the skill names the change under Knowledge base instead of working around it.
