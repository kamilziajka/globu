---
name: issue-watch
description: Watch a Jira project from this session and deliver the eligible issues as they appear. Polls with globu-worker on the configured interval, claims up to the concurrency cap, runs one subagent per issue with the issue-deliver skill and finishes each into a draft pull request. Use when the user asks to watch, monitor or keep delivering issues from a project in this session, or to start a worker here.
---

# Watch a project from this session

The supervised counterpart of `globu-worker run`. The binary polls, claims, prepares and hands back. This session implements, through one subagent per issue, and the person can stop at any time. Every run is recorded in the session's Globu home under `runs/`.

This is a supervised loop, not a service. It lasts as long as the session and stops when the session stops. The hard caps the headless worker gets from `claude -p`, the turn cap and the budget, do not exist for a subagent, so the person watching is the cost cap. For an unattended loop use `globu-worker run`.

## Set-up

Same binary and secrets as `issue-work` (`../issue-work/SKILL.md`). Read `limits.concurrent` and `poll.every` from `worker.yaml` in the session's Globu home, `~/.globu` unless `GLOBU_HOME` is set. The user may override both when invoking the skill, for example "watch MR, two at a time, every five minutes".

## Loop

1. **Poll.** `globu-worker poll --json`. Every plan entry whose action starts with `would claim` is a candidate, in the order the JQL returned them.
2. **Claim.** For each candidate while fewer than `limits.concurrent` runs are in progress: `globu-worker claim <KEY> --json`. A claim that comes back released is reported and skipped.
3. **Delegate.** For each prepared run start one subagent in the background with the brief path, the tree path, the handback path and the companions, and the instruction to run the `issue-deliver` skill in that tree exactly as the skill says: never push, never call Jira or GitHub, end by writing the handback. Give the subagent no secrets. Keep the run id with the subagent.
4. **Collect.** When a subagent reports back: if the handback exists and the tree has commits, `globu-worker finish <run-id> --json` and report the pull requests. Otherwise `globu-worker release <run-id> --reason "<the subagent's reason>"`.
5. **Report.** One line per run as it completes: key, state and the pull requests or the reason.
6. **Wait.** Sleep `poll.every` and go to step 1, with the session's own loop facility when it has one, such as a scheduled wake-up or `/loop`. Without one, ask the user to say "again" and poll on that.
7. **Stop** when the user says so. Finish or release every run in progress before ending. Never leave a run prepared.

## Notes

- Two watchers on one project, or a watcher next to `globu-worker run` on the same project, are not supported: the claim read-back cannot tell two uses of the same Jira account apart.
- The day cost cap of `worker.yaml` is not enforced here. The person is the cap.
- A subagent that asks a question has nobody to answer it. Brief it to decide and to name the decision under Open points in the handback.
