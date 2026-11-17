---
name: release
description: Release a new version of Globu end to end. Use when the user asks to release, publish or ship Globu, or to cut a version, and to resume a release that stopped. Checks that the docs cover the changes, bumps the version, runs and watches the Release workflow, then updates the site and records the release as the release runbook of the knowledge base that holds Globu's decisions describes. Takes patch, minor, major or an exact version; running it again with the same version resumes.
---

# Release Globu

One run of this skill takes Globu from a commit on `main` to the packages on npm, the plugins pinned on `stable`, the tag and the GitHub release, the site serving the new version and docs and the release recorded. Work without stopping for confirmation. This repo's `main` takes the release through one pull request, `release/<version>`, that this skill opens, waits for and merges itself; the release runbook says how the site and the record are updated. Stop only where a step below says the user is needed, and then say exactly what to run.

Every step first checks whether it is already done and skips it if so. That makes `/release <version>` the way to resume after any failure: the same command, the same version, picks up at the first step that is not done.

`docs/development.md` under "Releasing" explains the pieces; this skill is the procedure.

Steps 1 to 5 depend only on this repo, GitHub and npm. Step 6 depends on where the site, the release record and the work items live, which this repo does not know: the knowledge base that holds Globu's decisions has a release runbook for it. The session index names that knowledge base; `node packages/globu-cli/dist/globu.mjs list --json` finds its checkout. Read the runbook before step 2, since its checks are part of the preflight.

## 1. The version

The argument is `patch`, `minor`, `major` or an exact version such as `1.2.0`.

* An exact version: use it.
* `patch`, `minor` or `major`: compute it from the last tag (`git describe --tags --abbrev=0 --match 'v*' origin/main`).
* No argument: read `git log --no-merges --format='%s' <last tag>..origin/main`. New commands, options, skills or behaviour make it `minor`; only fixes and docs make it `patch`. Say which version you chose and why in one line, then go on.

When `package.json` on `origin/main` is already at a version that npm does not serve, a release is in progress: resume it with that version instead of starting another. So is an open pull request from a `release/<version>` branch (`gh pr list --head release/<version>`): resume with its version.

## 2. Preflight

In a worktree of this repo on a branch at `origin/main` (`git fetch origin && git merge --ff-only origin/main`):

* `git status --porcelain` is empty and `gh auth status` is fine.
* Decide what is already done, for the resume:
  * `npm view <name>@<version> version` for every non-private `packages/*/package.json` (published?)
  * `git ls-remote --tags origin v<version>` (pinned, tagged and released by the workflow?)
  * `gh release view v<version>`
  * the checks the release runbook lists for step 6 (site updated, deployed and release recorded?)
* Every non-private `packages/*/package.json` must exist on npm (`npm view <name> name`). A new package gets its first release by hand in step 5; say so now, because it needs `npm login` with the browser approval.
* `npm whoami` prints the account. A by-hand publish in step 5 needs it. When it fails, ask the user to run `npm login` now rather than in the middle of a failed run, and go on meanwhile.

## 3. The docs cover the changes

Skip when the tag exists. Otherwise compare what changed since the last tag with what the docs say:

* `git diff --stat <last tag>..origin/main -- packages plugins mods` for the code and `git log <last tag>..origin/main -- docs` for the docs. When `release/<version>` already exists, read the docs on that branch, so a resumed run sees the docs fix it committed before.
* A changed command, flag, config key, skill or hook needs its doc (`docs/globu-cli.md`, `docs/worker.md`, `docs/skills.md`, `docs/knowledge-base.md`, `docs/architecture.md`) and, where it is user facing, `README.md`. Read the diffs and the docs; do not trust a commit message.
* When `mods/globu-status` changed since the last tag and the `version` in its `.claude-plugin/plugin.json` did not, bump that version (patch for fixes, minor for new behaviour) in the same commit. The mod is versioned on its own, an installed copy updates only when the version changes and the site's packages page shows this version.
* Fix what is missing, add the `base log docs <today>` entry, run `npm run verify` and commit (`Docs for <version>`) on the branch `release/<version>`. Step 4 adds the bump to the same branch and merges both. The site takes its docs from that merge, so this is the last chance to correct them before the release.

## 4. Bump

Skip when `package.json` on `origin/main` is already at the version.

Work on the branch `release/<version>`: check it out when it exists locally or on `origin`, which a resumed run finds, and create it from `origin/main` otherwise. Each part below checks whether it is already done:

1. **The bump.** Skip it when `package.json` on the branch is already at the version, since `npm version` refuses a version that does not change. Otherwise `npm version <version> --no-git-tag-version && npm run build`, then commit the four changed files (root `package.json` and `package-lock.json`, `packages/globu-cli/package.json`, `packages/globu-worker/package.json`) as `Release <version>`. The pre-commit hook runs `npm run verify`.
2. **The push.** `git push -u origin release/<version>`, which does nothing when `origin` already has the commits.
3. **The pull request.** Take its number from `gh pr list --head release/<version> --state open --json number`. Only when there is none, `gh pr create --base main --head release/<version> --title "Release <version>" --body "<the docs fixed in step 3, or none>"`.

Wait for its checks with `gh pr checks <number> --watch --fail-fast` in the background. The Review workflow skips `release/` branches, so no Claude comments hold the merge. When a check fails, read `gh run view <id> --log-failed`, fix it on the branch, push and wait again. When they pass, `gh pr merge <number> --squash --delete-branch --subject "Release <version>"`, then `git fetch origin && git checkout --detach origin/main` and confirm that `package.json` there has the version.

## 5. The Release workflow

Skip when the tag exists and the GitHub release exists.

`gh workflow run release.yml --ref main`, take the run id from `gh run list --workflow release.yml --limit 1 --json databaseId`, and wait with `gh run watch <id> --exit-status` in the background (about six minutes). The run publishes the packages that are not on npm yet, waits until npm serves them, commits the pin, moves `stable`, tags `v<version>` and publishes the GitHub release with the commits since the last tag as notes.

When it fails, read `gh run view <id> --log-failed`:

* `npm refused <name>@<version>` (`E404` or `E403` from trusted publishing, see `docs/development.md`, "By hand") or a package that is not on npm at all: the user publishes it by hand. First copy the group `Trusted publishing lines for <name>` from the run's log into the report and the release record, since it holds npm's reason for refusing the OIDC exchange. In this worktree, at the `Release <version>` commit, run `npm run build && npm run pin` and give the user the exact command with the absolute path: `npm publish <worktree>/release/<tarball>`. It needs their `npm login` and the browser approval, so it is theirs to run. Then poll `npm view <name>@<version> version` every 30 seconds until it prints the version (npm takes minutes to list an accepted publish; a run started earlier tries to publish again and fails), check `dist.integrity` against `release/packages.json`, run `git checkout -- plugins` to drop the local pin, and run the workflow again. A new package is then bound with `npm trust github <name> --file release.yml --repo <owner>/<repo> --allow-publish`, where `<owner>/<repo>` is this repo on GitHub (`gh repo view --json nameWithOwner --jq .nameWithOwner`), again by the user.
* A failure in `npm run verify`: the commit on `main` is broken. Fix it in a pull request of its own, merge it once its checks pass, then run the workflow again; it refuses only a version that is already tagged.
* Anything else: read the log, fix the cause and run the workflow again. Never tag, push `stable` or create the GitHub release by hand.

Afterwards `git fetch origin main --tags && git merge --ff-only origin/main` and confirm every package on npm, the tag and `gh release view v<version>`.

## 6. The site and the record

Follow the release runbook of the knowledge base that holds Globu's decisions. It says how to tell whether each part is done, so a resume skips it, and covers:

* **The site.** Where its checkout is, how its docs snapshot and `release.json` are written with `node scripts/release-site.ts <site checkout>` from this repo at the tag, how the site is checked, pushed and deployed and how to wait until the `version.json` of the site named by `homepage` in `packages/globu-cli/package.json` reports the version. Exit code 2 from the script means a doc is new or gone and the site's navigation needs the change it prints. The script also writes `artefacts` into `release.json`, every artefact in `scripts/artefacts.ts` with the version from its own manifest, and refuses to run before the pin, when the plugin is not yet at the release version. A status mod change has no site step of its own: the marketplace serves the mod from `stable`, which only the Release workflow moves, so the mod reaches users with the next Globu release and that release writes its version.
* **The record.** Where the release is recorded, with the release commit, the pin commit, the tag, the Release run id or ids, the site commit and anything the run needed by hand.
* **The work items.** Where they live and how each one that shipped gets a comment with the version, the commit and anything left open, and moves to done when nothing is left open.

When the runbook is not available, stop after step 5 and tell the user that the site and the record are left.

## 7. Report

One short report: the version and the packages on npm, the Release run, the tag and the GitHub release, the site commit and that the site serves the version, the release record, the work items commented on or moved to done and every step that needed the user or a retry. The Stop hook `.claude/hooks/site-drift.mjs` reports a release left half done at the end of later sessions until it is finished.

## Guardrails

* Never `npm publish` a package the workflow publishes, except as step 5 describes for a refused or new package, and only by the user.
* Never create the tag, move `stable` or create the GitHub release by hand: the workflow does it and refuses an already tagged version.
* Never push to this repo's `main` from the skill: the release and every fix reach it through a pull request, and only the Release workflow pushes the pin there.
* Never edit the site's `content` by hand: fix `docs` here and run the site step again.
* Never lower the coverage gate or skip a check to get a release out. A release that cannot pass `npm run verify` waits for the fix.
