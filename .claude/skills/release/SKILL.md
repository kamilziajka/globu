---
name: release
description: Release a new version of Globu end to end. Use when the user asks to release, publish or ship Globu, or to cut a version, and to resume a release that stopped. Checks that the docs cover the changes, bumps the version, runs and watches the Release workflow, puts the docs snapshot and release.json on the site's main branch, waits until globu.kazet.blog serves the version and records the release in the knowledge base. Takes patch, minor, major or an exact version; running it again with the same version resumes.
---

# Release Globu

One run of this skill takes Globu from a commit on `main` to the packages on npm, the plugins pinned on `stable`, the tag and GitHub release and globu.kazet.blog serving the new version and docs. Work without stopping for confirmation: push to `main` of both repos directly, never open a pull request for the release. Stop only where a step below says the user is needed, and then say exactly what to run.

Every step first checks whether it is already done and skips it if so. That makes `/release <version>` the way to resume after any failure: the same command, the same version, picks up at the first step that is not done.

`docs/development.md` under "Releasing" explains the pieces and the reasons; this skill is the procedure.

## 1. The version

The argument is `patch`, `minor`, `major` or an exact version such as `1.2.0`.

* An exact version: use it.
* `patch`, `minor` or `major`: compute it from the last tag (`git describe --tags --abbrev=0 --match 'v*' origin/main`).
* No argument: read `git log --no-merges --format='%s' <last tag>..origin/main`. New commands, options, skills or behaviour make it `minor`; only fixes and docs make it `patch`. Say which version you chose and why in one line, then go on.

When `package.json` on `origin/main` is already at a version that npm does not serve, a release is in progress: resume it with that version instead of starting another.

## 2. Preflight

In a worktree of this repo on a branch at `origin/main` (`git fetch origin && git merge --ff-only origin/main`):

* `git status --porcelain` is empty and `gh auth status` is fine.
* Decide what is already done, for the resume:
  * `npm view @kazet/globu@<version> version` and `npm view @kazet/globu-worker@<version> version` (published?)
  * `git ls-remote --tags origin v<version>` (pinned, tagged and released by the workflow?)
  * `gh release view v<version>`
  * `gh api repos/kamilziajka/globu-website/contents/release.json --jq .content | base64 -d` (site main updated?)
  * `curl -s https://globu.kazet.blog/version.json` (site deployed?)
  * the globu-knowledge-base `docs/log.md` for a `Globu <version> released` entry (recorded?)
* Every non-private `packages/*/package.json` must exist on npm (`npm view <name> name`). A new package gets its first release by hand in step 5; say so now, because it needs `npm login` with the browser approval.

## 3. The docs cover the changes

Skip when the tag exists. Otherwise compare what changed since the last tag with what the docs say:

* `git diff --stat <last tag>..origin/main -- packages plugins mods` for the code and `git log <last tag>..origin/main -- docs` for the docs.
* A changed command, flag, config key, skill or hook needs its doc (`docs/globu-cli.md`, `docs/worker.md`, `docs/skills.md`, `docs/knowledge-base.md`, `docs/architecture.md`) and, where it is user facing, `README.md`. Read the diffs and the docs; do not trust a commit message.
* Fix what is missing, add the `base log docs <today>` entry, run `npm run verify`, commit (`Docs for <version>`) and push to `main`. The site takes its docs from this commit, so this is the last chance to correct them before the release.

## 4. Bump

Skip when `package.json` on `origin/main` is already at the version.

`npm version <version> --no-git-tag-version && npm run build`, then commit the four changed files (root `package.json` and `package-lock.json`, `packages/globu-cli/package.json`, `packages/globu-worker/package.json`) as `Release <version>` and `git push origin HEAD:main`. The pre-commit hook runs `npm run verify`.

## 5. The Release workflow

Skip when the tag exists and the GitHub release exists.

`gh workflow run release.yml --ref main`, take the run id from `gh run list --workflow release.yml --limit 1 --json databaseId`, and wait with `gh run watch <id> --exit-status` in the background (about six minutes). The run publishes the packages that are not on npm yet, waits until npm serves them, commits the pin, moves `stable`, tags `v<version>` and publishes the GitHub release with the commits since the last tag as notes.

When it fails, read `gh run view <id> --log-failed`:

* `npm refused <name>@<version>` (`E404` or `E403` from trusted publishing, see GLOBU-30 in the knowledge base) or a package that is not on npm at all: the user publishes it by hand. In this worktree, at the `Release <version>` commit, run `npm run build && npm run pin` and give the user the exact command with the absolute path: `npm publish <worktree>/release/<tarball>`. It needs their `npm login` and the browser approval, so it is theirs to run. Then poll `npm view <name>@<version> version` every 30 seconds until it prints the version (npm takes minutes to list an accepted publish; a run started earlier tries to publish again and fails), check `dist.integrity` against `release/packages.json`, run `git checkout -- plugins` to drop the local pin, and run the workflow again. A new package is then bound with `npm trust github <name> --file release.yml --repo kamilziajka/globu --allow-publish`, again by the user.
* A failure in `npm run verify`: the commit on `main` is broken. Fix it on `main`, then run the workflow again; it refuses only a version that is already tagged.
* Anything else: read the log, fix the cause and run the workflow again. Never tag, push `stable` or create the GitHub release by hand.

Afterwards `git fetch origin main --tags && git merge --ff-only origin/main` and confirm both packages on npm, the tag and `gh release view v<version>`.

## 6. The site

Skip when globu.kazet.blog already serves the version.

Find the site checkout with `node packages/globu-cli/dist/globu.mjs list --json`, shard `globu-website`, its `workPath`. Work in a worktree so the user's checkout is untouched:

```bash
git -C <workPath> fetch origin
git -C <workPath> worktree add .claude/worktrees/globu-release-<version> -b globu-release-<version> origin/main
```

Unless the site's main already has the version in `release.json`:

1. From this repo at the tag, run `node scripts/release-site.ts <site worktree>`. It writes `release.json` with today's date, replaces the docs snapshot in `content` with `docs/*.md` (all but `index.md` and `log.md`) and adds the release entry to the site's `docs/log.md`. Exit code 2 means a doc is new or gone: add `fromContent("<slug>")` for a new one to the right group in `src/docs/nav.ts`, or remove a gone one, then run the script again.
2. In the site worktree: `npm install`, `npm run verify`, `npm run build:prod`, `npm run verify:prerender`, and check that `dist/version.json` reports the version.
3. Commit as `Globu <version>: release.json and the docs snapshot`, `git fetch origin && git merge origin/main` (other sessions push to the site; a conflict in the day's section of `docs/log.md` resolves by keeping both sides, the release entry first), re-run the three checks when the merge brought anything, and `git push origin HEAD:main`.

Remove the worktree (`git -C <workPath> worktree remove .claude/worktrees/globu-release-<version>`). Cloudflare Workers Builds deploys `main` on its own: poll `https://globu.kazet.blog/version.json` every 30 seconds for up to ten minutes until it reports the version. If it does not, look at the deploy (`gh api repos/kamilziajka/globu-website/commits/<sha>/check-runs`) and report rather than retry.

A branch that presents a feature on the site ahead of a release leaves `content` and `release.json` alone; this step is the only writer of both.

## 7. The knowledge base

Skip when the globu-knowledge-base `docs/log.md` has the entry.

Find the shard `globu-knowledge-base` with `globu list --json` and work in a worktree of it at `origin/main`. Add a `base log` entry for today: `Globu <version> released on <date>` with the release commit, the pin commit, the tag, the Release run id or ids, the site commit and anything the run needed by hand. Mark backlog items that shipped with a history line, then `base validate`, commit and push to `main`.

## 8. Report

One short report: the version and the packages on npm, the Release run, the tag and the GitHub release, the site commit and that globu.kazet.blog serves the version, the knowledge base entry, and every step that needed the user or a retry. The Stop hook `.claude/hooks/site-drift.mjs` reports a release left half done at the end of later sessions until it is finished.

## Guardrails

* Never `npm publish` a package the workflow publishes, except as step 5 describes for a refused or new package, and only by the user.
* Never create the tag, move `stable` or create the GitHub release by hand: the workflow does it and refuses an already tagged version.
* Never edit the site's `content` by hand: fix `docs` here and run the site step again.
* Never lower the coverage gate or skip a check to get a release out. A release that cannot pass `npm run verify` waits for the fix.
