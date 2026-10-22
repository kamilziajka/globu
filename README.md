# Globu

Globu joins your knowledge bases and plugs into Claude Code so Claude can find the right knowledge for a task and write new knowledge back after a session.

This repo ships one Claude Code plugin, **[globu](plugins/globu/README.md)**, with five skills:

- `/globu:setup-knowledge-base` bootstraps or upgrades an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) knowledge base (a `docs/` directory) inside a repo. A repo can hold many.
- `/globu:register-knowledge-base` adds a repo to a per-user registry of knowledge shards, so every session knows which knowledge exists on this machine, when to consult it and where it may write.
- `/globu:update-knowledge` writes what a session learned to the right base or shard.
- `/globu:issue-check` checks that every doc and code reference in a Jira issue resolves to a file a coding agent will be able to open.
- `/globu:issue-fix` runs the same check and corrects the broken references in the issue once you confirm the edit.

Hooks index the registered shards at session start, guard edits to shards that are read-only or ask-first and validate a base right after an edit. Nothing needs a registered shard: inside one repo the bases work on their own.

A second, optional plugin, **[globu-status](mods/globu-status/README.md)**, is a Claude Code mod that shows in every session how much has happened since the knowledge was last updated, with a button that runs the update.

## Install

```sh
claude plugin marketplace add kamilziajka/globu
claude plugin install globu@globu
claude plugin install globu-status@globu
```

The plugin runs its CLI from an npm package that Claude Code installs with it, so `node` (22 or newer) and `npm` must be on the `PATH`.

The CLI also works on its own in a terminal:

```sh
npm install -g globu
globu base --help
```

## Try it locally

```sh
npm install
npm run build
claude --plugin-dir ./plugins/globu --plugin-dir ./mods/globu-status
```

The CLI can also be run directly:

```sh
node packages/globu-cli/dist/globu.mjs help
```

## Development

```sh
nvm use
npm install
npm run verify
```

`npm run verify` runs lint, typecheck, the build and the tests with a 100% coverage gate. The pre-commit hook and CI run the same command. See [docs/development.md](docs/development.md).

`npm run build` bundles the CLI into `packages/globu-cli/dist/` and links it into the plugin. The bundle is not kept in git: the CLI is published to npm as `globu`, and the plugin depends on it at a pinned version. See [docs/development.md](docs/development.md#releasing).

## Licence

[MIT](LICENSE).

## Documentation

Design and reference docs live in [`docs/`](docs/index.md), which is itself an OKF base maintained with these tools.
