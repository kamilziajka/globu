---
type: "Guide"
title: "Development"
description: "Tooling, quality gates and conventions for working on this repo: Node version, TypeScript, Biome, tests, coverage, comment policy, CI and releasing."
---

# Development

## Setup

```bash
nvm use
npm install
npm run verify
```

`.nvmrc` pins the Node version used for development and CI. The scripts in `scripts/` are TypeScript files run directly by Node, which needs a recent version. The bundled CLI itself targets Node 22, the oldest release line still supported, and the published package declares `node >=22`.

`npm install` also installs the Husky pre-commit hook.

A linked git worktree, such as the ones Claude Code sessions run in under `.claude/worktrees/`, needs its own install. Run `npm ci` there before the first build. A build that stops with `Could not resolve "commander"` means the worktree's `node_modules` is missing or incomplete. The shell that commits needs the Node version from `.nvmrc` as well, because the pre-commit hook runs `npm run verify`.

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | lint, typecheck, build, tests with coverage |
| `npm run lint` | Biome check |
| `npm run lint:fix` | Biome with fixes applied |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | bundle the CLI into `packages/globu-cli/dist` and link it into the plugin |
| `npm run pin` | pack the CLI into `release/` and pin the plugin to that tarball |
| `npm run verify:mod` | validate and test the globu-status mod with `claude plugin validate` and `claude plugin test` |
| `npm test` | run the tests once |
| `npm run test:watch` | run the tests in watch mode |
| `npm run test:coverage` | run the tests with the coverage gate |

## Quality gates

All of these run in `npm run verify`, in the pre-commit hook and in CI.

- **Biome** for formatting and lint, with the recommended rule set. Formatting is 2 spaces, double quotes, semicolons, no trailing commas and a 120 column line.
- **TypeScript in strict mode**, with unused locals and parameters as errors. Code is ESM and imports carry explicit `.js` extensions.
- **100% coverage** of statements, branches, functions and lines over `packages/`, excluding tests, the test helpers, the thin entry file in `packages/globu-cli/src/bin` and the process-bound `Io` in `packages/globu-cli/src/cli/process-io.ts`.
- **Package version up to date.** The build copies the root version into `packages/globu-cli/package.json` before the tests run, and the hook and CI fail when that file differs from what is committed.

## Comments

Comments are a convention, not a gate. The default is no comments: the code should explain itself and the reasoning lives here in `docs/` or in the commit message.

A comment is allowed only when it is critical, meaning a reader would misread or break the code without it and no better name, type or smaller function can carry the point. Such a comment is short and says why, not what. `CLAUDE.md` carries the same rule for Claude Code.

## Tests

- Vitest. Unit tests sit next to the code as `*.test.ts`.
- `packages/testing` holds the helpers: temp directories, throwaway git repos, linked worktrees (also of a bare repo) and a captured `Io`.
- `tests/bundle.test.ts` runs the built bundle as a real executable. It checks the thing users install: the shebang, the bundled dependencies and reading hook input from stdin. It also runs every command in the plugin's `hooks.json` with `CLAUDE_PLUGIN_ROOT` set, so a hook path that does not match the package name or its `bin` fails the build, and checks that the plugin pins exactly that package.
- `vitest.setup.ts` points `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` at a fresh temp directory before every test, so no test can read or write the developer's real configuration. It also removes every `GIT_*` variable from the environment. A git hook in a linked worktree exports `GIT_DIR`, and with it set the `git init` in a test would act on the real repository instead of the temp one. `CLAUDE_PROJECT_DIR` is cleared before every test as well, because the guard reads it to find the session's home repo and the tests may themselves run inside a Claude Code session.
- Commander wraps a program or command description past 80 columns, so a test that matches the help text exactly needs a description that fits on one line.
- Git behaviour is tested against real repositories created in temp directories. Remote repos are `file://` URLs. A test that expects a shard to be matched to a directory needs a real repo for both, because matching asks git. A made-up path only works where no match is expected.

## Design choices that keep the code testable

- The CLI is a commander program built and run by `runCli` in `packages/globu-cli/src/cli`. It takes an `Io` object (output, error output, stdin and working directory) and returns an exit code. Commander runs with `exitOverride` and writes through `Io`, so nothing calls `process.exit` or reads `process.cwd()` directly and every command runs in-process under test.
- A command sets a non-zero exit code through the `exit` callback it is given. A thrown error becomes `<name>: <message>` on the error output and exit code 1. Usage errors are reported by commander, also with exit code 1.
- Manifest, state and hook input are parsed with zod schemas. A hand-edited file fails with one clear message at load time, and the rest of the code works with known shapes and needs no defensive checks.

## The mod

`mods/globu-status` is a Claude Code mod: a plugin of function hooks, written against the engine's own TypeScript API. It has no build. `claude plugin validate` reads it the way the engine will and `claude plugin test` runs its `tests/*.test.ts` against the engine, so both need the `claude` binary; `npm run verify:mod` runs them, the pre-commit hook runs it after `npm run verify`, and CI installs Claude Code for that step. When a session loads the mod from the working tree, the engine writes `.claude-plugin/types/` and a `tsconfig.json` beside it; both are ignored by git, and `tsc -p mods/globu-status` type-checks the mod once they exist. Biome formats and lints the mod like the rest of the repo.

## Continuous integration

`.github/workflows/verify.yml` runs on pull requests and on pushes to `main`: install, `npm run verify`, a check that the committed package version matches the root version, then `npm run verify:mod` with Claude Code installed on the runner.

## Working on the plugin locally

`npm run build` links the CLI package into the plugin as `plugins/globu/node_modules/@kazet/globu`. That directory is ignored by git. With the link in place the hooks and skills of the working tree run the freshly built CLI:

```bash
npm run build
claude --plugin-dir ./plugins/globu --plugin-dir ./mods/globu-status
```

## Releasing

The root `package.json` holds the version. The build copies it into `packages/globu-cli/package.json`, and `globu base setup` stamps it into every base it touches as `knowledge_base_version`.

A release publishes the CLI, pins the plugin to it and then updates the public site. In Claude Code the project skill `/release <version>` (`.claude/skills/release/SKILL.md`) does all of it; the steps are:

1. Bump the version with `npm version <version> --no-git-tag-version`, run `npm run build` and merge that to `main`. The command also updates the root `package-lock.json`, and the build updates the CLI's `package.json`, so the bump commit touches three files.
2. Run the `Release` workflow (`.github/workflows/release.yml`) from the Actions tab, or with `gh workflow run release.yml --ref main` and then `gh run watch <run-id> --exit-status`. A run takes about six minutes, most of it waiting for the tarball.
3. Pull `main` afterwards. The workflow adds the pin commit, so a local `main` is one commit behind.
4. Update the site. globu.mercastra.com is `packages/globu-homepage` in `mercastra-app-frontend` and has no dependency on this repo: it shows the version in its `release.json` and renders the docs from a snapshot of `docs/` in its `content/`. The release skill writes both and opens that pull request; by hand, copy `docs/*.md` except `index.md` and `log.md` into `content/`, set `release.json` and open the pull request with `Globu <version>` in its title. The site shows the new version once that merges and deploys. `.claude/hooks/site-drift.mjs`, a Stop hook registered in `.claude/settings.json`, compares `package.json`, the npm version and the site's `version.json` at the end of every session here and reports an unreleased bump or a site that lags without an open pull request (`mercastra-product` decision 148).

Every release needs a new version. npm never accepts a version twice, so a run on an already published version fails at the publish step. `npm view @kazet/globu versions` shows what is taken.

The workflow runs `npm run verify`, then:

1. `npm run pin` packs the CLI into `release/`, writes `plugins/globu/package.json` and `package-lock.json` with the integrity hash of that tarball and sets `version` in `plugin.json`.
2. `npm publish` uploads exactly that tarball as a public package, which `publishConfig.access` in its `package.json` sets. The path needs its leading `./`, because npm reads a bare `release/<file>` as a GitHub `owner/repo` shorthand. It authenticates through npm trusted publishing, so the workflow holds no token.
3. The workflow waits until the tarball can be downloaded. npm accepts a publish before the files are served, and that can take a few minutes.
4. The pin is committed to `main` and `stable` is moved to that commit. The installed plugin updates from `stable` because the `plugin.json` version changed.

A package has to exist on npm before a trusted publisher can be configured for it, so the first release of a package is done by hand with the same steps:

```bash
npm run verify
npm run pin
npm publish ./release/kazet-globu-<version>.tgz
git add plugins
git commit -m "Pin plugins to <version>"
git push origin HEAD:main HEAD:stable
```

Packing is reproducible. If a release fails after publishing, `npm run build && npm run pin` on the released commit writes the same pin again.

To check the pin script without releasing, stage the plugin files, run `npm run pin`, read `git diff -- plugins/globu` and then `git checkout -- plugins/globu` and delete `release/`. Only the integrity hash should differ, because the working tree's tarball is not the published one. Stage first: `git checkout` restores the index, and an unstaged hand-written pin is lost.
