---
name: issue-work
description: Take one Jira issue in this session with the person watching. Claims it with globu-worker, implements it in the prepared worktree with the issue-deliver skill, shows the handback and hands back through a pull request once the user agrees. Use when the user asks to work on, take, pick up or deliver a Jira issue here, in this session, or hands over an issue key to implement now.
---

# Work one issue here

The headless worker (`globu-worker run`) claims issues and runs Claude with nobody present. This skill is the same loop with a person in it. The worker binary does the deterministic parts: claim, resolve the references, add the worktrees, write the brief, and later push, open the pull requests and comment on the issue. This session does the implementing, and the person can answer prompts, read the handback and stop before anything is pushed.

## The binary

`globu-worker` has to be on the PATH (`npm install -g @kazet/globu-worker`), or it runs from a checkout of the Globu repo as `node <checkout>/packages/globu-worker/dist/globu-worker.mjs`. If it is not found, ask the user where it is. Do not install anything unasked.

The session commands use the session's own Globu home, `~/.globu` unless `GLOBU_HOME` is set. They read two files there:

- `manifest.yaml` for the projects. A project the commands serve has a `jira` key and, under `worker`, at least `statuses.claimed` and `statuses.released`. Every project with a `jira` key is served.
- `worker.yaml` for the Jira site, which is all it needs: `version: 2` and `jira: { site: https://<site>.atlassian.net }`. An older `worker.yaml` with `shards.deliverable` still works and prints a warning.

When a command says that the home serves no project or that a project has incomplete worker settings, show the user the message and the two files' shape above. Do not write either file unasked.

They need `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment, and `finish` also needs `GH_TOKEN`. When one is missing the command says which. Ask the user to export it rather than reading it from anywhere else.

## Workflow

1. **Pick.** When the user named an issue key, skip this step. Otherwise run `globu-worker poll --json` once, show the plan lines and let the user pick one. The plan covers every project of the manifest that has a Jira key, so say which project each issue is in when there are several. A line that reads `skipped, shard "<id>" needs an editable clone` means the issue's project has a repository this machine has no checkout of: `globu register <path-or-url>` fixes that, on the user's word. When the user asks why an issue is missing from the plan or will not be picked, `globu-worker why <KEY> --session` says why.
2. **Claim.** `globu-worker claim <KEY> --json`. When `record.state` is `prepared`, note `brief`, `tree`, `handback` and `companions` from the JSON and tell the user that the issue is now assigned to them and in the claimed status. `companions` lists the worktrees of the other shards of the issue's project, which this run may also change. When it is `released`, the output says why: a missing reference, a repository marker that is missing or names a shard outside the issue's project, or a repository without commits. Report that and stop. A project with one shard needs no marker.
3. **Implement.** Run the `issue-deliver` skill (`../issue-deliver/SKILL.md`) on the brief, inside the `tree` directory. Run every command in `tree`. A change in another shard of the project goes to the worktree the brief names for that shard and nowhere else, and becomes a pull request of its own. Setup commands ran only in `tree`. Every rule of that skill holds here, in particular never push and never call Jira or GitHub yourself. The one difference is that a question the skill would have to settle alone can be put to the user.
4. **Show.** When the handback is written, show it to the user together with `git -C <tree> log --oneline <base>..HEAD`, where `base` is in `record.worktrees`, and ask whether to hand back, to keep working or to give the issue back.
5. **Finish.** On a yes, `globu-worker finish <run-id> --json`. It pushes each worktree that has commits, opens the pull requests, comments on the issue with the handback and removes the worktrees. Report the pull request links. A run with no commits is released with that reason.
6. **Give back.** When the user stops, `globu-worker release <run-id> --reason "<why>"`. The issue goes back to the released status with the blocked label, so a person has to remove the label before the worker or a poll picks it up again.

## Notes

- The run id is `record.id` from the claim. The run directory, `<home>/runs/<id>`, keeps the brief, the handback and `run.json` after the finish for the reviewer.
- Never run `globu-worker once`, `globu-worker run` or `globu-worker retry` from a session. Those start a second Claude, headless, in the worker's own home.
- A claim that fails with "claimed by someone else" means a colleague or the headless worker got there first. Do not retry.
- A run left prepared by a session that ended is cleaned up with `globu-worker release <id> --reason "abandoned"` from any session in the same home.
