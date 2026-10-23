---
type: "Guide"
title: "Unattended runs"
description: "How a Claude Code run that did not start on a configured laptop, such as a GitHub Actions job, gets Globu's index, guard and write-back: a team manifest, import, a token for clones and a way to load the plugin."
---

# Unattended runs

Everything Globu does rests on three things being present on the machine: `~/.globu` with the manifest, the shard clones and the `globu` plugin. A GitHub Actions job, a Claude Code cloud session or a poller on a fresh machine has none of them, so the session hook prints nothing and Claude works without the team's knowledge. This page describes the bootstrap that recreates all three before Claude starts. After it, the hooks behave as they do on a laptop: the index is injected, `read` shards are protected and `update-knowledge` writes to the right place.

## The team manifest

A team manifest is an ordinary Globu manifest (see [architecture](./architecture.md#configuration)) kept in a repo every member and every job can reach, by convention at `.globu/manifest.yaml`. It lists the team's shards with their repo URLs, routing text and access caps, and the contexts that select them:

```yaml
version: 1
shards:
  - id: product
    source: { type: git, repo: git@github.com:acme/product.git }
    format: okf
    roots:
      - { path: docs, name: product, entry: docs/index.md }
    description: Product decisions and domain rules
    useWhen: Pricing, roadmap or domain modelling questions
    access: read
  - id: backend
    source: { type: git, repo: git@github.com:acme/backend.git }
    format: okf
    roots:
      - { path: docs, name: backend, entry: docs/index.md }
    description: The API, its data model and its tests
    useWhen: Changing or calling a backend endpoint
contexts:
  team: [product, backend]
```

Every shard needs a repo URL. The manifest holds no paths, modes or tokens: those are per machine and come from `state.yaml` and the environment.

The easiest way to write one is to register the shards on a laptop and copy the `shards` and `contexts` sections of `~/.globu/manifest.yaml` into the team repo.

## Import

`globu import <locator>` merges a team manifest into the local one. The locator is a path to a manifest file, a directory holding `.globu/manifest.yaml` or a git URL of a repo holding it. A URL is cloned shallowly into a temporary directory that is removed after the file is read. `--file <path>` names another file inside the repo or directory.

Without `--yes` the command only prints what it would add, update and define. With `--yes` it writes the manifest and records the locator under `imports`, so a bare `globu import --yes` later refreshes every recorded import. `--context <name>` makes one of the merged contexts active in the same step.

The rules of the merge:

- Ids are global. A team shard whose id is already registered for a different repo is an error, as is a team repo already registered under another id. Nothing is written in that case.
- A team shard that matches a local shard by id and repo is updated from the team manifest: format, roots, routing text and access cap. The local clone, mode and path are untouched.
- Team contexts replace local contexts of the same name.
- The import is one level deep. An `imports` list inside the team manifest is ignored.

Imported shards have no clone until `globu sync` runs, which clones them read-only under `~/.globu/clones`. A checkout that already exists, such as the job's own repository, is attached with `globu register <path>` before `sync`, and is then editable and fetched rather than cloned again.

## Clones with a token

A job has no ssh key and cannot answer a credential prompt. With `GLOBU_GIT_TOKEN` set, every clone Globu makes and every pull of a clone it owns goes over https with that token:

- The token is sent as an `Authorization` header scoped to the host of the repo, through git's `http.<host>.extraheader`, so it never lands in a remote URL or in a config file.
- An ssh URL such as `git@github.com:acme/product.git` is rewritten to `https://github.com/acme/product.git` for that git call only, through `url.<https>.insteadOf`. The manifest keeps the ssh URL and the clone keeps it as its origin.
- The user name in the header is `x-access-token`, which GitHub accepts for personal access tokens and app tokens. `GLOBU_GIT_USER` overrides it, for example `oauth2` for GitLab.

Clones the user owns are fetched with whatever credentials their own git setup holds. The token is not applied to them.

## Where the config lives

`GLOBU_HOME` names the config directory. Set it explicitly in a job, so every process of the job, the hooks included, reads the same manifest. Without it Globu uses `~/.globu`, and when the home directory is not writable it falls back to `globu` under the system temp directory.

## Loading the plugin in a non-interactive run

Claude Code loads plugins from its settings, so a fresh machine needs the plugin installed before the run. The Claude Code GitHub Action does this through two inputs: `plugin_marketplaces` takes the git URL of the marketplace, which for Globu is this repo, and `plugins` takes the plugin to install from it. The action runs `claude plugin marketplace add` and `claude plugin install` with those values before it starts Claude. The marketplace entry points at the `stable` branch, so the installed plugin is the released one.

For a private marketplace the action has no credential input. Claude Code clones a marketplace with the machine's git credentials, and a token in the environment counts only through a credential helper. On a GitHub runner, `gh auth setup-git` with `GH_TOKEN` set installs one before the action runs.

The fallback that needs no marketplace is `--plugin-dir`: check out this repo, run `npm ci && npm run build` with the Node version in `.nvmrc` and pass `--plugin-dir <checkout>/plugins/globu` to Claude, through `claude_args` in the action or directly to `claude -p`. The build links the CLI into the plugin, so the hooks run the working tree.

## A GitHub Actions job

The job below implements whatever the prompt says, with the team's knowledge in place. `GLOBU_READ_TOKEN` is a token that can read the team manifest repo and the shard repos.

```yaml
name: Implement with Claude

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What Claude should do
        required: true

permissions:
  contents: write
  pull-requests: write
  id-token: write

env:
  GLOBU_HOME: ${{ runner.temp }}/globu
  GLOBU_GIT_TOKEN: ${{ secrets.GLOBU_READ_TOKEN }}

jobs:
  implement:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v5
        with:
          node-version: 22

      - name: Bootstrap Globu
        run: |
          npm install -g @kazet/globu
          globu import https://github.com/acme/product.git --context team --yes
          globu register "$GITHUB_WORKSPACE"
          globu sync
          globu claude sync

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          plugin_marketplaces: https://github.com/kamilziajka/globu.git
          plugins: globu@globu
          prompt: ${{ inputs.prompt }}
```

What each line of the bootstrap does:

1. `import` fetches `.globu/manifest.yaml` from the product repo with the token, merges it and activates the `team` context.
2. `register "$GITHUB_WORKSPACE"` attaches the job's checkout to the shard the team manifest lists for this repo, so the session index says Claude is working inside it and writes to it are free. A repo the team manifest does not list is registered as a local shard, which is harmless.
3. `sync` clones the other shards read-only under `$GLOBU_HOME/clones` and fetches the checkout with the credentials `actions/checkout` left in it.
4. `claude sync` adds the clone paths to `permissions.additionalDirectories` in the runner's `~/.claude/settings.json`, so Claude reads them without a permission prompt. The action keeps that file and merges its own `settings` input over it, so do not pass `permissions` in that input or the entry is replaced.

`GLOBU_HOME` is set at job level so the hooks that Claude Code starts see it too. The same four commands work before `claude -p` on any machine.
