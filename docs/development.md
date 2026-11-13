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

`.nvmrc` pins the Node version used for development and CI. The scripts in `scripts` are TypeScript files run directly by Node, which needs a recent version. The bundled CLI itself targets Node 22, the oldest release line still supported, and the published package declares `node >=22`.

`npm install` also installs the Husky pre-commit hook.

A linked git worktree, such as the ones Claude Code sessions run in under `.claude/worktrees`, needs its own install. Run `npm ci` there before the first build. A build that stops with `Could not resolve "commander"` means the worktree's `node_modules` is missing or incomplete. The shell that commits needs the Node version from `.nvmrc` as well, because the pre-commit hook runs `npm run verify`.

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | lint, typecheck, build, tests with coverage |
| `npm run lint` | Biome check |
| `npm run lint:fix` | Biome with fixes applied |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | bundle the CLI into `packages/globu-cli/dist` and the worker into `packages/globu-worker/dist`, and link the CLI into the plugin |
| `npm run pin` | pack the CLI into `release` and pin the plugin to that tarball |
| `npm run verify:mod` | validate and test the globu-status mod with `claude plugin validate` and `claude plugin test` |
| `npm test` | run the tests once |
| `npm run test:watch` | run the tests in watch mode |
| `npm run test:coverage` | run the tests with the coverage gate |

## Quality gates

All of these run in `npm run verify`, in the pre-commit hook and in CI.

- **Biome** for formatting and lint, with the recommended rule set. Formatting is 2 spaces, double quotes, semicolons, no trailing commas and a 120 column line.
- **TypeScript in strict mode**, with unused locals and parameters as errors. Code is ESM and imports carry explicit `.js` extensions.
- **100% coverage** of statements, branches, functions and lines over `packages`, excluding tests, the test helpers, the thin entry file in `packages/globu-cli/src/bin` and the process-bound `Io` in `packages/globu-cli/src/cli/process-io.ts`.
- **Package version up to date.** The build copies the root version into `packages/globu-cli/package.json` and `packages/globu-worker/package.json` before the tests run, and the hook and CI fail when those files differ from what is committed.

## Comments

Comments are a convention, not a gate. The default is no comments: the code should explain itself and the reasoning lives here in `docs` or in the commit message.

A comment is allowed only when it is critical, meaning a reader would misread or break the code without it and no better name, type or smaller function can carry the point. Such a comment is short and says why, not what. `CLAUDE.md` carries the same rule for Claude Code.

## Writing style

These apply to docs, skills, READMEs and commit messages.

- No em dashes or en dashes. Use a hyphen, a comma, a colon or a full stop.
- No Oxford comma.
- Name a directory without a trailing slash: `wiki`, not `wiki/`, and `packages/globu-cli/dist`, not `packages/globu-cli/dist/`. A path to a file keeps its slashes, such as `wiki/index.md`, and so do relative-path prefixes such as `./` and `../`. Directory trees drawn in code blocks may keep the slash, since it marks what is a directory there.
- Keep the `description` of a doc in `docs` within 160 characters. The site uses it as the page's meta description and as the lede under the title.

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

`mods/globu-status` is a Claude Code mod: a plugin of function hooks, written against the engine's own TypeScript API. It has no build. `claude plugin validate` reads it the way the engine will and `claude plugin test` runs its `tests/*.test.ts` against the engine, so both need the `claude` binary; `npm run verify:mod` runs them, the pre-commit hook runs it after `npm run verify`, and CI installs Claude Code for that step. When a session loads the mod from the working tree, the engine writes `.claude-plugin/types` and a `tsconfig.json` beside it; both are ignored by git, and `tsc -p mods/globu-status` type-checks the mod once they exist. Biome formats and lints the mod like the rest of the repo.

## Continuous integration

`.github/workflows/verify.yml` runs on pull requests and on pushes to `main`: install, `npm run verify`, a check that the committed package versions match the root version, then `npm run verify:mod` with Claude Code installed on the runner.

## Working on the plugin locally

`npm run build` links the CLI package into the plugin as `plugins/globu/node_modules/@kazet/globu`. That directory is ignored by git. With the link in place the hooks and skills of the working tree run the freshly built CLI:

```bash
npm run build
claude --plugin-dir ./plugins/globu --plugin-dir ./mods/globu-status
```

## Releasing

The root `package.json` holds the version. The build copies it into `packages/globu-cli/package.json` and `packages/globu-worker/package.json`, and `globu base setup` stamps it into every base it touches as `knowledge_base_version`. The two packages, `@kazet/globu` and `@kazet/globu-worker`, share that version and are released together.

A release is one command in Claude Code: the project skill `/release <patch|minor|major|x.y.z>` (`.claude/skills/release/SKILL.md`). It does every step below without asking, pushes straight to `main` of this repo and of the site, and stops only for what needs the owner (an `npm publish` or `npm trust` that needs the browser two-factor approval). Every step checks whether it is already done, so running `/release <version>` again after a failure resumes at the first step that is not.

1. **Docs.** The diff since the last tag is compared with `docs` and `README.md`; a changed command, option, config key, skill or hook gets its doc before anything is bumped, because the site's docs are a snapshot of this commit.
2. **Bump.** `npm version <version> --no-git-tag-version && npm run build` changes four files (root `package.json` and `package-lock.json` and both packages' `package.json`), committed as `Release <version>` and pushed to `main`.
3. **The `Release` workflow** (`.github/workflows/release.yml`), started with `gh workflow run release.yml --ref main` and watched to the end. Described below.
4. **The site.** globu.kazet.blog is the `kamilziajka/globu-website` repo (registered with Globu as the shard `globu-website`) and has no dependency on this repo: it carries a `release.json` and a snapshot of `docs` in its `content`, both at its root. `node scripts/release-site.ts <site checkout>` writes both, adds the release entry to the site's `docs/log.md` and reports a doc that is new or gone, which then needs an entry in the site's `src/docs/nav.ts`. The skill runs the site's `npm run verify`, `npm run build:prod` and `npm run verify:prerender` in a worktree of the site, commits, merges the site's moving `main` and pushes to it; Cloudflare Workers Builds deploys `main`, and the release waits until `https://globu.kazet.blog/version.json` reports the version. A site branch that presents a feature ahead of a release leaves `content` and `release.json` to this step.
5. **The record.** An entry in the knowledge base shard that holds Globu's decisions, with the commits, the runs and anything done by hand.

`.claude/hooks/site-drift.mjs`, a Stop hook registered in `.claude/settings.json`, compares `package.json`, the npm versions of both packages, `release.json` on the site's `main` and `https://globu.kazet.blog/version.json` at the end of every session here and reports a release left half done: a bump npm does not serve, a package that lags the other, or a site that lags with or without the version on its `main`.

Every release needs a new version. npm never accepts a version twice, and the workflow refuses to run on a version that is already tagged. `npm view @kazet/globu versions` and `npm view @kazet/globu-worker versions` show what is taken.

### The workflow

It runs `npm run verify`, then:

1. `npm run pin` packs both packages into `release`, writes `release/packages.json` with the name, version, tarball, registry URL and integrity of each, writes `plugins/globu/package.json` and `package-lock.json` with the integrity hash of the CLI tarball and sets `version` in `plugin.json`. The plugin depends on the CLI only; the worker is installed separately with `npm install -g @kazet/globu-worker`.
2. The run stops if `v<version>` is already a tag on `origin`.
3. `npm publish` uploads each tarball as a public package, which `publishConfig.access` in its `package.json` sets. The path needs its leading `./`, because npm reads a bare `release/<file>` as a GitHub `owner/repo` shorthand. It authenticates through npm trusted publishing, so the workflow holds no token. Per package: a version npm already lists is skipped; a publish that npm answers with "cannot publish over the previously published versions" counts as done, because npm lists an accepted version only minutes later; a package that is not on npm at all is skipped with a warning, because its first release is done by hand (below); any other refusal is reported with the exact by-hand command, the other packages still go out, and the run fails before the pin, so a second run after the by-hand publish finishes it.
4. The workflow waits until every published tarball can be downloaded. npm accepts a publish before the files are served, and that can take a few minutes.
5. The pin is committed to `main`, `stable` is moved to that commit and the commit is tagged `v<version>`. The installed plugin updates from `stable` because the `plugin.json` version changed.
6. `gh release create` publishes the GitHub release `Globu <version>` on the tag. Its notes list both packages with links to npm and the commit subjects since the previous tag, without the release and pin commits; releases are pushed to `main` directly, so GitHub's notes generated from pull requests would be empty.

### By hand

A package has to exist on npm before a trusted publisher can be configured for it, so the first release of a package is done by hand from the released commit. `npm whoami` has to print the account first: the token in `~/.npmrc` expires, and an expired one fails every `npm publish` and `npm trust` call with `E401`, so run `npm login` when it does. Then:

```bash
npm run build
npm run pin
npm publish ./release/kazet-globu-worker-<version>.tgz
npm view @kazet/globu-worker@<version> dist.integrity
```

Compare the integrity with `release/packages.json`, then run `git checkout -- plugins` to drop the local pin, which the workflow writes itself, and run the workflow again: it skips what npm lists and finishes the pin, the tag and the GitHub release. Bind a new package to the workflow, which needs npm 11.15 or later, two-factor authentication on the account and the package already on npm:

```bash
npm trust github @kazet/globu-worker --file release.yml --repo kamilziajka/globu --allow-publish
```

`npm trust list @kazet/globu-worker` shows the binding. `@kazet/globu` was bound this way after 0.4.0, `@kazet/globu-worker` after 1.0.0. The same by-hand publish is the way out when trusted publishing refuses a package that is already bound: in 1.1.0 it refused `@kazet/globu-worker` with `E404` although `npm trust list` showed the same binding as the CLI's, which it published. Until that is understood, expect the worker to need it.

Packing is reproducible. If a release fails after publishing, `npm run build && npm run pin` on the released commit writes the same pin again, and a second run of the workflow skips what is already on npm.

To check the pin script without releasing, stage the plugin files, run `npm run pin`, read `git diff -- plugins/globu` and then `git checkout -- plugins/globu` and delete `release`. Only the integrity hash should differ, because the working tree's tarball is not the published one. Stage first: `git checkout` restores the index, and an unstaged hand-written pin is lost.
