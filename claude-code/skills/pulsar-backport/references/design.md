# bpt design

## Pieces

```
pulsar-backport-plan/SKILL.md      planning: discover, triage with subagents, decisions, report, labels
pulsar-backport/SKILL.md           execution: lanes, worker jobs, driving from Claude Code
pulsar-backport/scripts/bpt.mjs    CLI (both skills, the workers and the server call it)
  lib/db.mjs        SQLite schema (node:sqlite, no dependencies)
  lib/git.mjs       read-only analysis (merge-tree dry runs, blame dependencies) + worktree operations
  lib/gh.mjs        every GitHub call (labels, PR comments, workflow dispatch, run status, reruns)
  lib/plan.mjs      sessions, discover, pre-filter, verdict import, decisions, label plan, report
  lib/lane.mjs      cherry-pick engine, dependency gate, test push, CI, squash, finalize
  lib/jobs.mjs      job queue; launches engine jobs and headless Claude Code workers
  lib/autopilot.mjs lane state machine (next job per lane)
  lib/control.mjs   decisions needed while backporting: every wait point with its options; apply runs one
  lib/server.mjs    127.0.0.1 HTTP API + static UI + 10 s tick (autopilot, CI polls, dispatch)
  web/              vanilla JS UI (no build step)
test/engine.test.mjs  end-to-end test on a throwaway repo with a fake gh: node --test test/engine.test.mjs
```

State: `~/workspace-pulsar/pulsar-cherry-picking/` (override with `BPT_HOME`)
- `database/backports.sqlite` — all sessions
- `sessions/<id>/prbody/`, `sessions/<id>/triage/round-N/` — PR descriptions, triage batches, verdict files
- `worktrees/<id>/<branch>/` — lane worktrees (git worktrees of `~/workspace-pulsar/pulsar`)
- `logs/job-<n>.log` — engine output or Claude `stream-json`

## Why no MCP server and no API key

Claude Code already runs shell commands, so a CLI is the simplest interface for both the interactive session and the headless workers, and it keeps the engine testable on its own. The web UI is a second client of the same database. Judgement work runs as `claude -p` processes on the user's Claude Code subscription; nothing calls the Anthropic API directly, so there is no key to manage and no separate token budget. A worker's Claude session id is stored with the job so the user's answer to a `job ask` resumes the same conversation (`claude -p --resume <id>`).

An MCP server would only add value if the UI had to push events into a running interactive session; `bpt job claim --wait` covers that by blocking until a job is queued.

## Safety model

- The server binds to 127.0.0.1, checks the Host header (DNS rebinding) and requires a random token (stored in the `meta` table) on every API call.
- Workers cannot push or write to GitHub: the engine is the only writer, and the launcher denies `git push`, `gh pr create/edit/merge/comment/close/review`, `gh issue`, `gh label`.
- Pushes are fast-forward only. Test-branch updates check that the remote head is an ancestor; fixes go in as `fixup!` commits and are squashed only locally, with a tree-equality check, so the pushed real-branch tree is exactly the tested tree.
- The real release branch is pushed only by `finalize` and `push-final-fix`, by fast-forwarding the local branch (in the worktree that has it checked out, if any) and pushing that branch; which only the UI buttons (or an explicit CLI call) enqueue. Autopilot stops at `ready`.
- If the branch moved after testing, finalize rebases and asks again before pushing the untested combination.
- Lane worktrees are separate from every other checkout; the planning analysis only fetches and reads the main clone.

## Dependencies

Three sources, one table (`deps`):
- **evaluator**: `dependsOn` from triage.
- **blame** (plan and backport time): for each hunk of a PR, `git blame` of the parent on the modified lines (and the neighbours of pure insertions). Commits in the session's range that are on neither the branch nor earlier in the batch are candidates. At backport time this is re-run against the lane, so a dependency created by a skip decision or a branch-specific gap surfaces before the pick.
- **conflict**: when a pick conflicts, in-range master commits missing from the lane that touched the conflicted files.
- **manual**: added by the user or a worker (`dep add`).

Gate: open or accepted-but-missing dependencies block the pick, except blame hints on a pick that applies cleanly (recorded as warnings). Accept = mark the dependency PR `backport` on that branch and insert it into the pick list (master order); Dismiss = proceed. Dependencies accepted on a source lane are carried to reusing lanes as open questions.

## Rebuilding a lane

`lane.rewind` is the one primitive behind drop, late dependencies and re-picking in master order. It maps the lane's commits to picks (cherry-pick trailer, else the PR number), finds the first commit that must change (a dropped pick, or a pick after the insertion point), resets the worktree to the commit before it, and marks every later pick `pending` with `detail.replay`: its `source_sha` becomes its own lane commit and `detail.extras` the non-pick commits (fixups) that ride with it, so `pickNext` re-applies resolution and fixups as one cherry-pick sequence without adding a trailer. Fixups whose target is dropped go with it. A stopped cherry-pick is aborted and blocked picks are re-checked. `pickNext` calls it on its own when the first pending pick has committed picks after it in master order (unless `detail.outOfOrder`); past picking, `holds()` turns the same situation into a decision and autopilot and finalize wait.

Pushed test branches are never rewritten: a rebuild or reset moves the test branch to `ci.retired` and bumps `ci.round`; the next `pushTest` deletes the retired branches (closing a test PR left by an earlier version) and pushes `<test-branch>-r<round>`. CI never runs in a PR (one could be merged by accident): `pushTest` dispatches the workflows on the test branch and `pollCi` reads that branch's `workflow_dispatch` runs of the commit, so test and release-branch runs of the same commit never mix. The deciding run per workflow is stored in `ci_runs` (keyed by session, lane, kind, sha, workflow) when first seen; polls, reruns and the report use those run ids, and a failed listing is `unknown`, never "no runs".

## Extending

- New job type: add it to `ENGINE` or `CLAUDE` in `jobs.mjs`, a case in `runEngineJob` (bpt.mjs) or a prompt in `workerPrompt`, a transition in `autopilot.advance`, and a button in `web/app.js`.
- New wait point: add an item with options to `control.pending`; the UI panel and `bpt decisions` render it without changes. A new worker proposal type goes in `parseProposals` and `runProposal`.
- Other target branches or repos: `--branches` accepts any list; `BPT_REPO_SLUG` changes the GitHub repo, `--remote` the git remote.
- CI workflows: session config `finalWorkflows` (array of workflow file names) and `testWorkflows` for the test branch (default: `finalWorkflows`).
