---
okf_version: "0.2"
name: globu
description: What Globu is for, how it works, the CLI reference and how to develop it
knowledge_base_version: 0.4.0
---

# globu knowledge base

This directory is the public knowledge base for Globu: what it is for, how it works, the CLI reference and how to develop it. It is an OKF bundle and is maintained with the tools built in this repo. Design decisions and the roadmap are kept outside this repo.

<!-- knowledge-base:authoring-guide:start -->
## Before you consider a task done

If you are an agent that just changed code or behavior in this repo, do not stop at the code change. Check whether anything you did is durable enough to belong here (a decision, an API shape, a gotcha, a root cause) and update this base before calling the task finished.

## Which base owns what

A repo can hold more than one base. A base is any directory whose `index.md` carries `okf_version`, usually `docs/`, `wiki/` or `knowledge/`. Knowledge about a piece of code belongs in the nearest base walking up from that code: a package with its own base owns its knowledge and everything else falls to the base at the repo root.

## How to add or update knowledge here

This is a plain [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle: Markdown files with YAML frontmatter, versioned in git. No special tool is required to read or edit it. Any agent or person can create, edit or delete files here directly.

- **Concept docs** are any `.md` file in this directory (or subdirectories) other than `index.md` and `log.md`. Each one must start with frontmatter:
  ```yaml
  ---
  type: "Note"        # required, a freeform label such as "API Endpoint", "Runbook", "Decision" or "Playbook"
  title: "..."         # recommended
  description: "..."   # recommended, one sentence
  ---
  ```
- **Prefer editing an existing doc** over creating a near-duplicate one. Skim this directory first.
- **Link between docs** with normal Markdown links. Bundle-relative paths (e.g. `/topics/foo.md`) are preferred over `../` relatives.
- **Record changes in `log.md`**: add a dated, newest-first bullet describing what changed (see that file for the format).
- **List new docs in `index.md`** under Contents so a reader can find them from the entry point.
<!-- knowledge-base:authoring-guide:end -->

## Contents

* [Overview](./overview.md) - the problems Globu solves and a worked example
* [Architecture](./architecture.md) - the plugin and its two CLIs, the registry, probe, drivers and Claude Code integration
* [Knowledge bases](./knowledge-base.md) - base discovery, ownership rule, the base commands, the edit hook and the skills
* [globu CLI](./globu-cli.md) - command reference
* [globu-status mod](./globu-status.md) - the session indicator for pending knowledge updates
* [Claude Code hook contract](./claude-code-hooks.md) - the hook behaviours the session and guard hooks rely on, and which are untested
* [Unattended runs](./unattended-runs.md) - bootstrapping a CI job or a fresh machine from a team manifest: import, token clones and loading the plugin
* [Development](./development.md) - tooling, quality gates, tests, CI and releasing
* [Update log](./log.md) - chronological history of changes to this base
