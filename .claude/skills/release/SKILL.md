---
name: release
description: Release a new version of Globu and bring its public site up to date. Use when the user asks to release, publish or ship Globu, or to cut a version. Bumps the version, runs the Release workflow, waits for npm, then writes the released version and a snapshot of docs into the globu-website repo and opens that pull request. Takes the version as its argument.
---

# Release Globu

Releases the `@kazet/globu` and `@kazet/globu-worker` npm packages the way `docs/development.md` describes under "Releasing", then updates the site at globu.kazet.blog, which lives in its own repo `kamilziajka/globu-website` (registered with Globu as the shard `globu-website`). The site has no dependency on this repo: it carries `release.json` and a snapshot of `docs` that this skill writes. Do the steps in order and stop at the first failure.

## Before anything

1. The argument is the version, for example `0.4.0`. Without one, show `npm view @kazet/globu versions --json` and the current `package.json` version and ask which version to release.
2. Check: `git status --porcelain` empty, `HEAD` at the tip of `origin/main` after `git fetch origin main` (on `main` itself, `git pull --ff-only`; in a Claude Code worktree `main` is checked out elsewhere, so stay on the worktree branch and `git merge --ff-only origin/main`), `gh auth status` fine. Refuse to continue otherwise.
3. Confirm the version is not released yet: it must not appear in `npm view @kazet/globu versions --json` or `npm view @kazet/globu-worker versions --json`, and `git ls-remote --tags origin v<version>` must print nothing.
4. Check whether a package is new. For every `packages/*/package.json` that is not `private`, `npm view <name> name` must succeed. A package that is not on npm yet gets its first release by hand in step 9 and the workflow skips it until then, so check `npm whoami` now: an `E401` means the token in `~/.npmrc` expired, and the user has to run `npm login` before step 9. Say so at once rather than at step 9.

## Release

5. Bump: `npm version <version> --no-git-tag-version && npm run build`. Four files change (root `package.json` and `package-lock.json`, `packages/globu-cli/package.json` and `packages/globu-worker/package.json`). Commit them as `Release <version>`.
6. Ask the user whether to push the commit to `main` directly or open a pull request. A direct push from a worktree branch is `git push origin HEAD:main`. The Release workflow checks out `main`, so a pull request has to merge before the next step; wait for the user to say it merged.
7. Run the workflow and wait for it: `gh workflow run release.yml --ref main`, then find the run with `gh run list --workflow release.yml --limit 1 --json databaseId` and `gh run watch <id> --exit-status`. About six minutes. The run publishes every package that is already on npm, skips one that is not with a warning, commits the pin, moves `stable`, tags `v<version>` and publishes the GitHub release `Globu <version>`.
8. `git pull --ff-only` (in a worktree `git fetch origin main && git merge --ff-only origin/main`; the workflow adds the pin commit and the tag) and confirm `npm view @kazet/globu version` and `npm view @kazet/globu-worker version` print the version, and `gh release view v<version>` exists. If a package does not after a minute, stop and report. npm can serve the version while the run is still on its pin step, so wait for the run itself, not only for npm.
9. A package the workflow skipped because it is not on npm yet is published by hand now, from the released commit: `npm run verify && npm run pin`, `npm publish ./release/<tarball>` and `npm view <name>@<version> dist.integrity` against `release/packages.json`. Then bind it to the workflow with `npm trust github <name> --file release.yml --repo kamilziajka/globu --allow-publish` and confirm with `npm trust list <name>`. Both commands need `npm whoami` to work (step 4). If the user is not there to log in, finish the site step and report exactly these commands as what is left.

## Update the site

10. Find the site checkout: `node packages/globu-cli/dist/globu.mjs list --json` (or `globu list --json`), take the shard with id `globu-website` and use its `workPath`. It is a writable shard, so no permission prompt is expected beyond the usual ones for commands.
11. Make a worktree on a fresh branch so the user's checkout is untouched:
   ```bash
   git -C <workPath> fetch origin
   git -C <workPath> worktree add .claude/worktrees/globu-release-<version> -b globu-release-<version> origin/main
   ```
   Work inside that worktree from here on (`<site>` below is the worktree root; `release.json` and `content` sit at the repo root).
12. Write `<site>/release.json`:
    ```json
    {
      "version": "<version>",
      "releasedAt": "<today, YYYY-MM-DD>"
    }
    ```
13. Refresh the snapshot: delete every `<site>/content/*.md`, then copy every `docs/*.md` of this repo except `index.md` and `log.md` into `<site>/content`. Copy verbatim; the site rewrites links and strips the authoring guide at build time. A doc added to `docs` since the last release is new content: add it to the nav registry in `<site>/src/docs/nav.ts` under the right group (`fromContent("<slug>")`), because an unlisted content file fails `nav.test.ts`. A doc removed from `docs` has to leave the registry too, because the build throws on a listed slug without a file.
14. Check the site in the worktree:
    ```bash
    npm install
    npm run verify
    npm run build:prod
    npm run verify:prerender
    ```
    `dist/version.json` must report the version.
15. Add the log entry to `<site>/docs/log.md` (newest first, under a `## <today>` heading: the version, its release date and the commit of this repo the snapshot was taken at). Commit everything as `Globu <version>: release.json and the docs snapshot`. Other sessions commit to the site's `main` while a release runs, so `git fetch origin && git merge origin/main` before pushing; the usual conflict is the day's section of `docs/log.md`, and keeping both sides with the release entry first resolves it. Then push the branch and open the pull request against `main` with `gh pr create`. The title must contain `Globu <version>`: the drift hook looks for it. In the body name this repo's release commit and the pin commit. The `Workers Builds` check on the pull request is red on every branch commit and green once merged (the site's `docs/hosting.md` explains); it is not a reason to hold the merge.
16. Remove the worktree when the pull request is open: `git -C <workPath> worktree remove .claude/worktrees/globu-release-<version>`. If the user asks to merge the pull request, check `gh pr view <n> --json mergeable` first: when `main` moved again, re-add the worktree, merge `origin/main` once more, re-run the checks of step 14 and push before `gh pr merge <n> --merge --delete-branch`. After the merge, wait for the `Workers Builds` check on the merge commit and confirm `https://globu.kazet.blog/version.json` reports the version.

## Report

17. Say: the published packages, the Release run, the tag and GitHub release, the site pull request, any package still waiting for its first publish by hand and that globu.kazet.blog shows the new version only after that pull request merges and deploys. `.claude/hooks/site-drift.mjs` reports the gap at the end of later sessions until then.

## Guardrails

- Never publish by hand with `npm publish` a package the workflow already publishes; it does so with trusted publishing. The by-hand path of step 9 is for a package's first release only.
- Never create the tag or the GitHub release by hand; the workflow does, and refuses to run on a version that is already tagged.
- Never edit `content` files in the site by hand to fix wording: fix `docs` here and re-run the snapshot step.
- If the site build fails on the snapshot (a frontmatter the renderer does not parse, a link form it does not know), fix the renderer in the site or the doc here; do not skip the site step.
