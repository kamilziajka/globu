---
name: release
description: Release a new version of Globu and bring its public site up to date. Use when the user asks to release, publish or ship Globu, or to cut a version. Bumps the version, runs the Release workflow, waits for npm, then writes the released version and a snapshot of docs/ into the site workspace in mercastra-app-frontend and opens that pull request. Takes the version as its argument.
---

# Release Globu

Releases the `@kazet/globu` npm package the way `docs/development.md` describes under "Releasing", then updates the site at globu.mercastra.com, which lives in `mercastra-app-frontend` (`packages/globu-homepage`, `mercastra-product` decision 148). The site has no dependency on this repo: it carries `release.json` and a snapshot of `docs/` that this skill writes. Do the steps in order and stop at the first failure.

## Before anything

1. The argument is the version, for example `0.4.0`. Without one, show `npm view @kazet/globu versions --json` and the current `package.json` version and ask which version to release.
2. Check: on `main`, `git status --porcelain` empty, `git pull --ff-only` done, `gh auth status` fine. Refuse to continue otherwise.
3. Confirm the version is not published yet: it must not appear in `npm view @kazet/globu versions --json`.

## Release

4. Bump: `npm version <version> --no-git-tag-version && npm run build`. Three files change (root `package.json` and `package-lock.json`, `packages/globu-cli/package.json`). Commit them as `Release <version>`.
5. Ask the user whether to push the commit to `main` directly or open a pull request. The Release workflow checks out `main`, so a pull request has to merge before the next step; wait for the user to say it merged.
6. Run the workflow and wait for it: `gh workflow run release.yml --ref main`, then find the run with `gh run list --workflow release.yml --limit 1 --json databaseId` and `gh run watch <id> --exit-status`. About six minutes.
7. `git pull --ff-only` (the workflow adds the pin commit) and confirm `npm view @kazet/globu version` prints the version. If it does not after a minute, stop and report.

## Update the site

8. Find the frontend checkout: `node packages/globu-cli/dist/globu.mjs list --json` (or `globu list --json`), take the shard with id `mercastra-app-frontend` and use its `workPath`. It is an `ask` shard: say what you are about to change there and expect a permission prompt on each write.
9. Make a worktree on a fresh branch so the user's checkout is untouched:
   ```bash
   git -C <workPath> fetch origin
   git -C <workPath> worktree add .claude/worktrees/globu-release-<version> -b globu-release-<version> origin/main
   ```
   Work inside that worktree from here on (`<site>` below is `<worktree>/packages/globu-homepage`).
10. Write `<site>/release.json`:
    ```json
    {
      "version": "<version>",
      "releasedAt": "<today, YYYY-MM-DD>"
    }
    ```
11. Refresh the snapshot: delete every `<site>/content/*.md`, then copy every `docs/*.md` of this repo except `index.md` and `log.md` into `<site>/content/`. Copy verbatim; the site rewrites links and strips the authoring guide at build time. A doc added to `docs/` since the last release is new content: add it to the nav registry in `<site>/src/docs/nav.ts` under the right group (`fromContent("<slug>")`), because an unlisted content file fails `nav.test.ts`.
12. Check the site in the worktree:
    ```bash
    npm install
    npm run test --workspace=packages/globu-homepage
    npm run globu-homepage:build
    npm run verify:prerender --workspace=packages/globu-homepage
    ```
13. Commit as `Globu <version>: release.json and the docs snapshot`, push the branch and open the pull request against `main` with `gh pr create`. The title must contain `Globu <version>`: the drift hook looks for it. In the body name this repo's release commit and the pin commit. Add the log entry to `<site>/docs/log.md` in the same commit.
14. Remove the worktree when the pull request is open: `git -C <workPath> worktree remove .claude/worktrees/globu-release-<version>`.

## Report

15. Say: the published version, the Release run, the site pull request and that globu.mercastra.com shows the new version only after that pull request merges and deploys. `.claude/hooks/site-drift.mjs` reports the gap at the end of later sessions until then.

## Guardrails

- Never publish by hand with `npm publish` here; the workflow does it with trusted publishing. The by-hand path in `docs/development.md` is for a package's first release only.
- Never edit `content/` files in the site by hand to fix wording: fix `docs/` here and re-run the snapshot step.
- If the site build fails on the snapshot (a frontmatter the renderer does not parse, a link form it does not know), fix the renderer in the site or the doc here; do not skip the site step.
