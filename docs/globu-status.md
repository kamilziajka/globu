---
type: "Component"
title: "globu-status mod"
description: "The Claude Code mod that shows whether a session's knowledge is up to date: what it shows, how it scores, what counts as an update and how to install it."
---

# globu-status mod

A Claude Code mod, installed as a plugin beside `globu`, that shows per session how much work has happened since the knowledge was last updated. It exists for people who run several sessions side by side: a committed change does not say whether `update-knowledge` ran, the mod does. Source: `mods/globu-status`.

## What it shows

A status line under the prompt, labelled `globu-status`:

- `○ nothing to update` in a fresh session.
- `◔ low`, `◑ medium`, `● strong` while something is pending.
- `updating...` while the update skill runs, then `✓ up to date`.

While something is pending, a band above the prompt adds the counts, `◔ Low need to update knowledge (2 edits, 1 turn)`, in green, yellow or red, with three buttons: `Update knowledge` (hotkey k) submits `/globu:update-knowledge`, `Mark up to date` (m) clears the need, and `Hide for a week` (h) hides the band for seven days across sessions. Pressing `Update knowledge` turns the band into `Updating knowledge...` at once, without buttons. The command only runs once the session is idle and expands the skill without a `Skill` tool call, so the mod cannot wait for one. Nothing counts while the update runs, so edits it makes outside a base and the commit that ships it do not raise the need again. When the update's turn ends the knowledge is up to date and the band disappears. An interrupted or failed turn brings the need back. The band also disappears once the knowledge is up to date by any other route.

`/globu-status` prints the state. `/globu-status reset` marks it up to date and `/globu-status show` lifts a hide early.

## How it scores

Each distinct file changed with Edit, Write or NotebookEdit and each shell command that writes a file counts one, as does each completed turn that made such a change. A `git commit` counts five and forces at least medium, but only while something is pending, so a commit that ships the knowledge update does not raise the need again. Paths under tmp, scratchpad, node_modules, dist and .git are ignored. Under 4 is low, under 9 medium, 9 and up strong.

## What counts as an update

- Invoking `globu:update-knowledge`, or the older `knowledge-base:update-knowledge` and `globu:save-knowledge`.
- Editing a Markdown file inside an OKF base, found by walking up to a folder holding both `index.md` and `log.md`.
- Running `globu base log` or `globu base validate`.
- The end of the turn started by `Update knowledge`.
- Pressing `Mark up to date` or typing `/globu-status reset`.

These names are a contract between the mod and the rest of Globu: renaming a skill or a `base` command means changing the mod too.

## Install

```
/plugin install globu-status@globu
```

To pick up a new release later:

```
/plugin update globu-status@globu
```

The state lives in the session, so a resumed session starts from `nothing to update`. Decisions made in conversation alone, with no file change, are not detected.
