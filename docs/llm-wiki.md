---
type: "Explainer"
title: "Globu and the LLM wiki"
description: "How Globu relates to the LLM wiki pattern Andrej Karpathy described: what maps onto what, what Globu adds across repos and where the gist still goes further."
---

# Globu and the LLM wiki

Andrej Karpathy's [LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) is a short description of a way of working with a language model: instead of searching raw documents every time you ask a question, the model builds a wiki between you and the sources and keeps it current. Globu is that pattern across all your repos, in an open format.

The gist describes three layers and three operations. The layers are the raw sources, which are never edited, the wiki the model owns and a schema file such as `CLAUDE.md` that says how the wiki is organised. The operations are ingest, which folds a new source into the wiki, query, which answers from the wiki after reading its index first, and lint, which looks for contradictions, orphan pages and stale claims.

## What maps onto what

| In the gist | In Globu |
|---|---|
| The wiki | An OKF base: a directory such as `wiki` with an `index.md`, a `log.md` and Markdown pages with frontmatter. See [knowledge bases](./knowledge-base.md). |
| The schema in `CLAUDE.md` | The authoring guide inside `index.md`. It travels with the base, so any agent that opens the directory finds it. |
| Ingest | The `update-knowledge` skill. It writes what a session learned into the base that owns it. |
| Query, reading the index first | The shard index at the start of every session, then each shard's entry file. |
| Lint | `globu base validate`, which checks structure, and the edit hook that runs it after every change. |
| `index.md` and `log.md` | The same two files, as OKF reserved files. |

## What Globu adds

The gist describes one wiki. Globu is built for the case where the knowledge lives in many repos and a session in any of them needs it.

- **Many wikis.** A repo can hold one base, or one per package. Knowledge about a piece of code belongs in the nearest base above it, so a session never has to guess where to write.
- **A registry across repos.** Each base you care about is registered as a shard. Every session starts with the list: where each shard is, what it holds and when to read it.
- **Access modes.** A shard is read-only, asks before an edit from another repo or is open. A hook enforces the mode, so the rule holds whether or not anyone remembers it.
- **A team manifest.** One file in a shared repo lists the team's shards. A new laptop or a CI job imports it and clones what is missing. See [unattended runs](./unattended-runs.md).

## Where the gist goes further

Two parts of the gist have no counterpart in Globu yet.

- **Content lint.** `globu base validate` checks that the files have the right shape. It does not look for contradictions between pages, orphan pages or claims that have gone stale. A knowledge lint is on the roadmap.
- **Ingesting outside sources.** `update-knowledge` writes what a session learned. There is no skill yet that takes an article, a paper or a transcript and folds it into a base. That is on the roadmap too.

## If you already keep an LLM wiki

An existing wiki becomes a Globu base without moving anything. In the repo that holds it, run the setup skill and name the directory. It adds the `okf_version` marker and the authoring guide to `index.md`, creates `log.md` if there is none and leaves every page as it is. Pages without a `type` in their frontmatter show up in the first `globu base validate` run; add one to each. Then register the repo so sessions elsewhere can find it.

```text
/globu:setup-knowledge-base
/globu:register-knowledge-base
```
