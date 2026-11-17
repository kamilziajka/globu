---
type: "Guide"
title: "Development"
description: "Tooling, quality gates and conventions for working on this repo: Node version, TypeScript, Biome, tests, coverage, comment policy, landing a change through a pull request, CI and releasing."
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

The hook runs on a commit, not on a rebase. When `main` moved while a branch was in work, as it does with several sessions merging into it, rebase the branch and run `npm run verify` by hand before pushing: the commits were verified against the old `main`, and a change that landed in between can break them without a conflict. A rebased branch that was pushed before needs `git push --force-with-lease`. Merging `origin/main` into the branch needs no force push and gives the same squash merge. A merge that commits on its own runs git's `pre-merge-commit` hook, which this repo does not have, so either run `npm run verify` by hand after it or merge with `git merge --no-commit origin/main` and then `git commit`, which runs `pre-commit`.

## Landing a change

`main` takes changes only through pull requests. A ruleset on the default branch requires a pull request and the `verify` and `verify-windows` checks, and refuses direct pushes, force pushes and deletion. It asks for no approval, since the owner cannot approve their own pull requests, and it does not require resolved review threads. Nobody bypasses it except the Release workflow's deploy key, which pushes the pin (see [The workflow](#the-workflow)). The owner has no bypass either.

A change is one branch and one pull request. Commit on the branch, push it and open the pull request with `gh pr create`. The [Review workflow](#continuous-integration) comments on the pull request within a few minutes, but it is not a required check, so `gh pr merge --auto` would not wait for it. Wait for every check with `gh pr checks <number> --watch`, read Claude's comments and fix what is real in the same pull request, which starts a new review. When the last review leaves nothing to fix, `gh pr merge <number> --squash` merges it, and GitHub deletes the merged branch. A comment does not block the merge.

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
- `tests/bundle.test.ts` runs the built bundle as a real executable. It checks the thing users install: the shebang, the bundled dependencies and reading hook input from stdin. It also runs every command in the plugin's `hooks.json` with `CLAUDE_PLUGIN_ROOT` set, so a hook path that does not match the package name or its `bin` fails the build, and checks that the plugin pins exactly that package. For the worker it starts `globu-worker run` as a process of its own against a local stand-in for Jira and fake `gh` and `claude` programs, and expects it to be alive after two idle cycles: a pause that does not hold Node's event loop ends the process with exit 13 after the first cycle, which a test that calls `workerMain` inside the test process cannot see.
- `vitest.setup.ts` points `GLOBU_HOME` and `CLAUDE_CONFIG_DIR` at a fresh temp directory before every test, so no test can read or write the developer's real configuration. It also removes every `GIT_*` variable from the environment. A git hook in a linked worktree exports `GIT_DIR`, and with it set the `git init` in a test would act on the real repository instead of the temp one. It then sets `GIT_CONFIG_NOSYSTEM=1`, so the machine's system git config stays out of the tests: on Windows that file turns on Git Credential Manager, which probes an HTTP remote with requests of its own, and `core.autocrlf`. `CLAUDE_PROJECT_DIR` is cleared before every test as well, because the guard reads it to find the session's home repo and the tests may themselves run inside a Claude Code session.
- Commander wraps a program or command description past 80 columns, so a test that matches the help text exactly needs a description that fits on one line.
- Git behaviour is tested against real repositories created in temp directories. Remote repos are `file://` URLs. A test that expects a shard to be matched to a directory needs a real repo for both, because matching asks git. A made-up path only works where no match is expected.
- The tests run on Linux, macOS and Windows, see [tests on Windows](#tests-on-windows).

### Tests on Windows

CI runs the suite on `windows-latest` as well, so the code paths that exist only on Windows (Git's `sh`, `.cmd` shims, junctions, `Path` and drive letters) are tested there and not only through an injected `platform`. A test that passes on Linux can still fail there, so keep to these rules:

- Build an expected path with `path.join` or `path.resolve`, never as `${dir}/file`. The code prints native paths, with backslashes on Windows. `native()` from `packages/testing` turns a literal such as `"wiki/log.md"` into the native form, and `escapeRegExp()` puts a path into a `RegExp`.
- A path git prints, such as `--show-toplevel` or `worktree list`, comes with forward slashes on Windows. The code passes it through `path.resolve` before comparing it with a Node path. `tempDir()` resolves the temp directory with `fs.realpathSync.native`, which expands an 8.3 short name such as `RUNNER~1` to the long name git prints.
- A made-up absolute path such as `/work/home` resolves to the current drive on Windows, so a fixture that goes through `path.resolve` in the code is written as `path.resolve("/work/home")` in the test.
- A shell command handed to the guard uses forward slashes (`posix(repo)`), as Git Bash does on Windows; a backslash there is an escape.
- Run a bundle as `node <bundle>` on Windows, which does not read the shebang, and run a hook command with the shell `setupShell` finds, which is Git's `sh` on Windows.
- A test of the worker that scripts the setup shell as `sh` sets `platform: "linux"` in its deps. The Windows lookup has tests of its own with `platform: "win32"`, and one test leaves the platform out, so the host's shell is looked up for real.
- Pass `"junction"` to `fs.symlinkSync` for a directory link. Elsewhere the type is ignored; on Windows the test then removes a real junction.
- `.gitattributes` keeps every text file at LF in a checkout, so Biome passes on a Windows machine whose git has `core.autocrlf true`, the Git for Windows default.
- Windows starts processes several times slower, so the test timeout there is 30 s instead of 5 s (`vitest.config.ts`).

Two tests are skipped on Windows, because what they check does not exist there:

| Test | Why it cannot run on Windows |
|---|---|
| `paths` falls back to the temp directory when the home directory is not writable | it makes the home unwritable with `chmod 500`, and Windows ignores the mode bits of a directory |
| `findOnPath` looks through a colon separated PATH elsewhere | a Windows path holds a drive colon, so it cannot be written into a `:` separated `PATH` |

The coverage gate is enforced on Linux only. The Windows job runs the tests without it, since the branches for the other platform are not reached there, and `vitest.config.ts` sets no thresholds on Windows, so `npm run verify` and the pre-commit hook pass on a Windows machine too. The junction test there skips its file symlink when Windows refuses it, as it does without Developer Mode.

## Design choices that keep the code testable

- The CLI is a commander program built and run by `runCli` in `packages/globu-cli/src/cli`. It takes an `Io` object (output, error output, stdin and working directory) and returns an exit code. Commander runs with `exitOverride` and writes through `Io`, so nothing calls `process.exit` or reads `process.cwd()` directly and every command runs in-process under test.
- A command sets a non-zero exit code through the `exit` callback it is given. A thrown error becomes `<name>: <message>` on the error output and exit code 1. Usage errors are reported by commander, also with exit code 1.
- Manifest, state and hook input are parsed with zod schemas. A hand-edited file fails with one clear message at load time, and the rest of the code works with known shapes and needs no defensive checks.

## The mod

`mods/globu-status` is a Claude Code mod: a plugin of function hooks, written against the engine's own TypeScript API. It has no build. `claude plugin validate` reads it the way the engine will and `claude plugin test` runs its `tests/*.test.ts` against the engine, so both need the `claude` binary; `npm run verify:mod` runs them and the pre-commit hook runs it after `npm run verify`. CI does not run it. When a session loads the mod from the working tree, the engine writes `.claude-plugin/types` and a `tsconfig.json` beside it; both are ignored by git, and `tsc -p mods/globu-status` type-checks the mod once they exist. Biome formats and lints the mod like the rest of the repo.

## Continuous integration

`.github/workflows/verify.yml` runs on pull requests and on pushes to `main`, with two jobs. `verify`, on `ubuntu-latest`, installs, runs `npm run verify` and checks that the committed package versions match the root version. `verify-windows`, on `windows-latest`, turns off `core.autocrlf` before the checkout, so Biome sees the line endings as committed, then installs and runs lint, typecheck, build and `npm test`, the suite without the coverage gate. Both jobs are required to merge into `main` (see [Landing a change](#landing-a-change)). The ruleset names them as checks from GitHub Actions, so a job renamed in the workflow has to be renamed in the ruleset too, or every pull request waits for a check that never comes. `npm run verify:mod` needs the `claude` binary and runs in the pre-commit hook, not in CI.

`.github/workflows/review.yml` has Claude Code review a pull request through `anthropics/claude-code-action@v1`. It runs when a pull request is opened, reopened, marked ready or pushed to. It is skipped when the pull request as a whole changes only `docs/log.md`: GitHub matches `paths-ignore` against the pull request's whole diff with its base, not against the latest push, so a push of only a log entry to a pull request that changes more is reviewed again. A newer push cancels the review still running for the same pull request. It skips drafts, `release/` branches and pull requests from forks, which get no secrets and no OIDC token; it never runs on `pull_request_target`. It holds no Anthropic key. It authenticates through workload identity federation: the action trades the job's GitHub OIDC token for a short-lived Claude API token, under a federation rule in the Claude Console that accepts only the subject of this repository's pull request runs and acts as a service account in one workspace, which the review is billed to. GitHub writes the owner and repository IDs into this repository's subject, `repo:<owner>@<owner id>/<repo>@<repo id>:pull_request`, so a rule that expects `repo:<owner>/<repo>:pull_request` refuses the exchange with `match_subject_prefix`. The Console's authentication log shows the claims of a refused token. A review that ends within a second with no cost is usually such a refusal. The rule, organization, service account and workspace IDs are not secrets and live in the repository variables `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID`. The job asks for `id-token: write` and is skipped while `ANTHROPIC_FEDERATION_RULE_ID` is unset. The review reads `CLAUDE.md`, this page and the docs the change touches, posts each finding as an inline comment and ends with one summary comment. It comments through the job's `GITHUB_TOKEN`, so no GitHub app is installed and the comments come from `github-actions[bot]`. Findings never fail the job, and the job is not a required check. It is capped at 40 turns and 20 minutes. To review again without a new push, rerun the job from the pull request's checks.

## Working on the plugin locally

`npm run build` links the CLI package into the plugin as `plugins/globu/node_modules/@kazet/globu`. That directory is ignored by git. With the link in place the hooks and skills of the working tree run the freshly built CLI:

```bash
npm run build
claude --plugin-dir ./plugins/globu --plugin-dir ./mods/globu-status
```

## Releasing

The root `package.json` holds the version. The build copies it into `packages/globu-cli/package.json` and `packages/globu-worker/package.json`, and `globu base setup` stamps it into every base it touches as `knowledge_base_version`. The two packages, `@kazet/globu` and `@kazet/globu-worker`, share that version and are released together.

Globu ships four artefacts, listed in `scripts/artefacts.ts`: the two npm packages, the plugin `globu@globu` and the status mod `globu-status@globu`. The plugin takes the root version from the pin. The mod is versioned on its own in `mods/globu-status/.claude-plugin/plugin.json` and is bumped by hand when it changes, since an installed copy updates only when that version changes. Both plugins are served from `stable`, which only the Release workflow moves, so a mod change ships with a Globu release and never on its own.

A release is one command in Claude Code: the project skill `/release <patch|minor|major|x.y.z>` (`.claude/skills/release/SKILL.md`). It does every step below without asking and brings the docs fix and the bump to `main` through one pull request that it merges itself. It stops only for what needs the owner (an `npm publish` or `npm trust` that needs the browser two-factor approval). Every step checks whether it is already done, so running `/release <version>` again after a failure resumes at the first step that is not.

1. **Docs.** The diff since the last tag is compared with `docs` and `README.md`; a changed command, option, config key, skill or hook gets its doc before anything is bumped, because the site's docs are a snapshot of this commit. A changed status mod whose version did not move gets a new version in the same commit.
2. **Bump.** `npm version <version> --no-git-tag-version && npm run build` changes four files (root `package.json` and `package-lock.json` and both packages' `package.json`), committed as `Release <version>` on the branch `release/<version>` next to the docs fix. The skill opens the pull request, waits for its checks and squash merges it as `Release <version>`. The Review workflow skips `release/` branches.
3. **The `Release` workflow** (`.github/workflows/release.yml`), started with `gh workflow run release.yml --ref main` and watched to the end. Described below.
4. **The site.** The site, named by `homepage` in `packages/globu-cli/package.json`, lives in a repo of its own and has no dependency on this one: it carries a `release.json` (the version, the date and every artefact's version, [below](#the-sites-releasejson)) and a snapshot of `docs` in its `content`, both at its root, and it serves `version.json`. `node scripts/release-site.ts <site checkout>`, run at the tag, writes both, adds the release entry to the site's `docs/log.md` and reports a doc that is new or gone, which then needs an entry in the site's `src/docs/nav.ts`. A site branch that presents a feature ahead of a release leaves `content` and `release.json` to this step.
5. **The record.** The release is recorded with the commits, the runs and anything done by hand, and each work item that shipped gets a comment and moves to done when nothing is left open.

Steps 4 and 5 depend on where the site, the record and the work items live. The release runbook of the knowledge base that holds Globu's decisions says where, and how each step is checked, built and deployed; the session index names that knowledge base.

`.claude/hooks/site-drift.mjs`, a Stop hook registered in `.claude/settings.json`, compares `package.json`, the npm versions of the non-private packages under `packages` and the `version.json` of the site named by `homepage` at the end of every session here and reports a release left half done: a bump npm does not serve, a package that lags the other or a site that lags npm. It compares `version` only, not the artefacts: one run of `release-site.ts` writes them with `version` in one commit, the site's checks hold its packages page to `release.json` and the mod cannot reach users without a release, so a site whose `version` is current shows current artefacts too.

Every release needs a new version. npm never accepts a version twice, and the workflow refuses to run on a version that is already tagged. `npm view @kazet/globu versions` and `npm view @kazet/globu-worker versions` show what is taken.

### The site's release.json

The site's root `release.json` is written by the release only and looks like this at 1.3.0:

```json
{
  "version": "1.3.0",
  "releasedAt": "2026-11-15",
  "artefacts": [
    { "id": "cli", "name": "@kazet/globu", "kind": "npm", "version": "1.3.0" },
    { "id": "worker", "name": "@kazet/globu-worker", "kind": "npm", "version": "1.3.0" },
    { "id": "plugin", "name": "globu@globu", "kind": "claude-code-plugin", "version": "1.3.0" },
    { "id": "status", "name": "globu-status@globu", "kind": "claude-code-plugin", "version": "0.1.0" }
  ]
}
```

`version` and `releasedAt` are the Globu release. `artefacts` lists every artefact in the order of the site's packages page, each read from its own manifest when the release runs: `package.json` for an npm package, `.claude-plugin/plugin.json` for a plugin, whose `name` gets the marketplace's name after an `@`. `id` is the stable key the site's `src/packages.ts` joins on, `name` is what a person installs and `kind` is `npm` or `claude-code-plugin`. A list rather than an object keyed by id keeps the order and lets each entry stand alone, so a fifth artefact is one more entry in `scripts/artefacts.ts` and a row in the site's `src/packages.ts`; the site's tests fail until both agree. `release-site.ts` refuses to run when an artefact that shares the root version is not at it, which is the case before the pin, so it runs at the tag.

`release-site.ts` writes the whole file from its own fields, so a key the script does not know is dropped at the next release. A change that gives `release.json` a new key therefore merges here first and on the site second: a site that reads the key before the script writes it fails its `npm run verify` on the next release.

The site's `dist/version.json` keeps its three keys, `version`, `releasedAt` and `builtAt`, and does not carry the artefacts: nothing here reads them there, and the packages page is checked against `release.json` by the site's `verify:prerender` instead.

### The workflow

It first checks that the `release` environment holds the deploy key (job `deploy-key`), runs `npm run verify`, then:

1. `npm run pin` packs both packages into `release`, writes `release/packages.json` with the name, version, tarball, registry URL and integrity of each, writes `plugins/globu/package.json` and `package-lock.json` with the integrity hash of the CLI tarball and sets `version` in `plugin.json`. The plugin depends on the CLI only; the worker is installed separately with `npm install -g @kazet/globu-worker`.
2. The run stops if `v<version>` is already a tag on `origin`.
3. `npm publish` uploads each tarball as a public package, which `publishConfig.access` in its `package.json` sets. The path needs its leading `./`, because npm reads a bare `release/<file>` as a GitHub `owner/repo` shorthand. It authenticates through npm trusted publishing, so the workflow holds no token. Per package: a version npm already lists is skipped; a publish that npm answers with "cannot publish over the previously published versions" counts as done, because npm lists an accepted version only minutes later; a package that is not on npm at all is skipped with a warning, because its first release is done by hand (below); any other refusal is reported with the exact by-hand command, the other packages still go out, and the run fails before the pin, so a second run after the by-hand publish finishes it.
4. The workflow waits until every published tarball can be downloaded. npm accepts a publish before the files are served, and that can take a few minutes.
5. The pin is committed to `main`, `stable` is moved to that commit and the commit is tagged `v<version>`. The installed plugin updates from `stable` because the `plugin.json` version changed. This is the job `tag`, which runs after the publishing job `release` in the GitHub environment `release`. The publishing job hands `tag` the pin as a patch, with `release/packages.json`, through the artifact `pin`. Only `tag` can write to the repository, and only `release` holds the OIDC permission for npm, whose trusted publisher is bound without an environment. The checkout of `tag` uses the environment's `RELEASE_DEPLOY_KEY`, so its pushes go through the deploy key, the only actor the ruleset on `main` lets through. A push with the job's `GITHUB_TOKEN` would be refused, which is why the first job, `deploy-key`, also in the environment `release`, stops the run before anything is published when the environment has no `RELEASE_DEPLOY_KEY`.
6. `gh release create` publishes the GitHub release `Globu <version>` on the tag. Its notes list both packages with links to npm and the commit subjects since the previous tag, without the release and pin commits. They come from commit subjects rather than from GitHub's notes generated from pull requests, because many changes on `main` were pushed without one.

### By hand

A package has to exist on npm before a trusted publisher can be configured for it, so the first release of a package is done by hand from the released commit. `npm whoami` has to print the account first; run `npm login` when it does not. Then:

```bash
npm run build
npm run pin
npm publish ./release/<tarball>
npm view <name>@<version> dist.integrity
```

`release/packages.json` names each package's tarball. Compare the integrity with it, then run `git checkout -- plugins` to drop the local pin, which the workflow writes itself, and run the workflow again: it skips what npm lists and finishes the pin, the tag and the GitHub release. Bind a new package to the workflow, which needs npm 11.15 or later, two-factor authentication on the account and the package already on npm. `<owner>/<repo>` is this repo on GitHub:

```bash
npm trust github <name> --file release.yml --repo <owner>/<repo> --allow-publish
```

`npm trust list <name>` shows the binding. The same by-hand publish is the way out when trusted publishing refuses a package that is already bound. `npm view <name>@<version> _npmUser` tells the two apart: it names the npm account after a by-hand publish and `GitHub Actions` after the workflow's.

A package published through trusted publishing prints `Signed provenance statement` in the run's log. Without that line npm did not exchange the job's OIDC token for a publish token, fell back to the placeholder token `actions/setup-node` writes into `.npmrc` and answers `E404`. npm explains a failed exchange only in its verbose log, so the publish step runs `npm publish --loglevel verbose` and prints the `oidc`, `provenance` and `token` lines of a refused package in a group of their own. An exchange refused for a binding that differs from the job (another workflow file, a repository spelled differently, an environment name the job does not set) is fixed on the package's settings page on npmjs.com, which shows fields `npm trust list` does not.

A group that reads `POST 404` on `/-/npm/v1/oidc/token/exchange/package/<name>` with `OIDC token exchange error - package not found` means npm holds no trusted publisher matching the job for that package, whatever `npm trust list` prints. The fix is on the package's settings page on npmjs.com: delete the trusted publisher and create it again with publisher GitHub Actions, organization or user the GitHub owner of this repo (not the npm account), its repository name, workflow filename `release.yml` and `npm publish` allowed (`npm dist-tag` is not needed). Leave the environment name empty, since the release job sets none.

Packing is reproducible. If a release fails after publishing, `npm run build && npm run pin` on the released commit writes the same pin again, and a second run of the workflow skips what is already on npm.

To check the pin script without releasing, stage the plugin files, run `npm run pin`, read `git diff -- plugins/globu` and then `git checkout -- plugins/globu` and delete `release`. Only the integrity hash should differ, because the working tree's tarball is not the published one. Stage first: `git checkout` restores the index, and an unstaged hand-written pin is lost.
