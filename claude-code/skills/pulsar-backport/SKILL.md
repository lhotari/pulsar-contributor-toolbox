---
name: pulsar-backport
description: Execute an apache/pulsar backport plan from the bpt session database — cherry-pick the decided PRs onto branch-4.2 in master commit order, catch dependencies that planning missed, open a test PR on apache/pulsar and take CI to green, then reuse the tested picks for branch-4.0, and finally fast-forward the real branches when the user clicks Finalize in the local web UI. Use when asked to run/continue/resume backporting, process backport jobs, fix a backport's CI, or act as a bpt worker (prompts that start "You are a headless worker for the pulsar-backport skill"). Planning is the pulsar-backport-plan skill.
argument-hint: "drive <session-id> | worker | status <session-id> | ui"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill, Monitor
---

# Backport execution (apache/pulsar)

```bash
BPT=~/.claude/skills/pulsar-backport/scripts/bpt.mjs
[ -f "$BPT" ] || BPT=~/workspace-pulsar/pulsar-contributor-toolbox/claude-code/skills/pulsar-backport/scripts/bpt.mjs
node "$BPT" doctor
```

## Who does what

| | owns |
|---|---|
| **`bpt` engine** | worktrees, cherry-picks in order, dependency gate, check-pick scan, pushes (test branches only, never forced), test PR, CI polling, rerun, squash, the final fast-forward, labels |
| **Claude Code workers** (headless `claude -p`, or you) | judgement jobs: resolve a conflict, make a pick compile, verify the lane builds, diagnose CI failures and fix them |
| **The user**, in the web UI | decisions, dependency accept/dismiss, starting backporting, and **Finalize** — the only path that pushes to a real release branch |

No Anthropic API key is involved: workers run on the user's Claude Code login. `bpt serve` launches them with `claude -p --permission-mode auto`, with `git push`, `gh pr create/edit/merge/comment/close`, `gh issue` and `gh label` denied. Set the session's "Claude jobs" selector to **my Claude Code session** to have the interactive session process them instead (see *Driving from this session*).

## Lane state machine

One lane per target branch, in plan order. A lane with `reuse_from` (branch-4.0 ← branch-4.2) starts only after its source lane is tested and squashed, and cherry-picks the source lane's final commits (without adding a second `cherry picked from` trailer).

```
not-started → picking ⇄ needs-attention → picked → verifying → verified → testing ⇄ ci-failed
            → ci-green → (squash) → ready → [user: Finalize] → final-ci ⇄ final-ci-failed → done
```

- **picking**: `pick-all` cherry-picks pending PRs in master order with `-x` in the lane worktree `~/workspace-pulsar/pulsar-cherry-picking/worktrees/<session>/<branch>` (local branch `bpt/<session>/<branch>`). Before each pick it re-runs blame analysis against the lane: an in-range master commit that the PR builds on and that is neither on the branch nor earlier in the batch is a **dependency found while backporting**. If the pick then conflicts — or the dependency came from the evaluator or a person — the pick is **blocked** and the user decides in the UI (Accept adds the dependency to the batch ahead of it; Dismiss proceeds). A clean pick on top of a blame hint only records a warning; the build check catches the rest.
- **needs-attention**: a `conflict` (cherry-pick stopped), `needs-fix` (applied, but `check-pick.sh` found slog/markers/unguarded debug), or `blocked` pick. Conflicts also record *conflict dependency hints*: in-range master commits missing from the lane that touched the conflicted files.
- **verifying**: a Claude job compiles every touched module and runs the changed tests.
- **testing**: the engine pushes the lane to `<branch>-backports-<session>` on apache/pulsar and opens a PR against the branch (labels `ready-to-test`, `doc-not-needed`; title says do not merge). CI is polled every 5 minutes.
- **ci-failed**: a Claude job investigates (investigate-ci skill). Flaky or pre-existing → `bpt ci rerun` (limited by `maxReruns`, default 3). Caused by a pick → `fixup!` commit for that pick, then `lane phase … verified`, and the engine pushes again (fast-forward, no force).
- **ci-green → ready**: autosquash folds the fixups into their picks and asserts the tree is byte-identical to the tested tree.
- **Finalize** (user click): fast-forward push of the squashed commits to the real branch, then `workflow_dispatch` of Pulsar CI, Flaky, Go and Python function workflows (Pulsar CI has no push trigger). If someone pushed to the branch meanwhile, the batch is rebased and the UI asks before pushing that untested combination.
- **final-ci-failed**: rerun for flakes; a real fix goes on top as a new commit and the user pushes it from the UI ("Push fix").
- **done**: `cherry-picked/<branch>` and `release/<version>` labels on every picked PR, test PR closed with a comment, test branch deleted.

## Driving from this session

Start the UI and tell the user the link (keep it running in the background):

```bash
node "$BPT" serve --open
```

Then either let the UI's autopilot run headless workers, or process Claude jobs yourself:

```bash
node "$BPT" session config <id> runner=interactive     # the server stops launching claude -p workers
node "$BPT" job claim --session <id> --wait 1200        # blocks until a job is queued; prints its context
```

Run the claim in the background (or under Monitor) and handle each job exactly as the *Worker jobs* section says; loop until the user stops you. `node "$BPT" advance <id> --force` performs one autopilot step without the server. Report outcomes, not play-by-play.

Rules for the driver: never push or touch labels yourself — use the engine's commands, and only for test branches unless the user clicked Finalize (or explicitly told you to finalize in chat). Never force-push. Never `git stash` in a lane worktree (the stash stack is shared across worktrees).

## Worker jobs

Every job starts with `node "$BPT" job show <job>` — JSON with the job, the lane (worktree, base, head, CI summary), the pick (master sha, conflicts, conflict and blame dependency hints, evaluator assessment, port note, adaptation hint), and all picks of the lane. Work **only** in the lane worktree. End with exactly one of:

```bash
node "$BPT" job done <job> --summary "what you did, one or two sentences"
node "$BPT" job fail <job> --reason "why it cannot be done"
node "$BPT" job ask  <job> --question "the decision only the user can make"
```

`job ask` is right when the fix needs a product decision, a dependency the user hasn't approved, or a non-mechanical rewrite. The user answers in the UI and your session is resumed with the answer.

### resolve (`conflict` or `needs-fix` pick)
Follow the **pulsar-cherry-pick** skill's per-commit loop for this one commit: read the source commit, resolve with zdiff3 (take the commit's logic, re-skin to the branch: slf4j, Maven, Java 8 on 4.0 client modules), run `scripts/check-pick.sh <master-sha>` from that skill, compile the module (`./mvnw -q -pl <module> test-compile …`; install shared modules first), run the commit's changed test methods. Then `git add` and `git -c core.editor=true cherry-pick --continue` (for `needs-fix`: `git commit --amend --no-edit`), and `node "$BPT" lane resolved <session> <branch> <pr>`.
If the conflict shows the pick needs an earlier PR (the conflict hints list candidates): `node "$BPT" dep add <session> <pr> <dep> --branch <branch> --detail "<symbol/file it needs>"`, `git cherry-pick --abort`, and `job ask` with the recommendation. Do not pull in other PRs on your own.

### verify (all picks applied)
`ctx.modules` lists the touched modules. Build them (`./mvnw -q -T 1C -pl <modules> -am install -DskipTests -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dlicense.skip=true` once, then `test-compile`), and run the added/modified test methods of each pick (`git show <picked> --stat`; `-Dtest='Class#m1+m2'`). Fix problems with `git commit --fixup=<picked sha>` so they squash into the right pick later. Run checkstyle on touched modules (branch-4.2 needs `initialize`: `./mvnw -pl <m> initialize checkstyle:check`). When green: `node "$BPT" lane phase <session> <branch> verified`, then `job done`.

### fix-ci (test PR or the real branch failed)
`ctx.lane.ci.<kind>.failed` lists failed checks with links. Use the **investigate-ci** skill. Decide per failure:
- **Flaky or pre-existing** (fails on the branch without these picks, known flaky, infrastructure): `node "$BPT" ci rerun <session> <branch>`.
- **Caused by a pick**: reproduce locally in the lane worktree, fix, run the affected tests. Test lane: `git commit --fixup=<that pick's sha>` then `node "$BPT" lane phase <session> <branch> verified` (the engine pushes). Final lane: a normal commit on top of HEAD with a `[fix][<component>]` subject; the user pushes it from the UI.
- **A pick is wrong for this branch and cannot be adapted**: `job ask` recommending to skip it (the user resets or skips).
Finish with `job done` summarising each failure and what you did.

### triage
Follow the pulsar-backport-plan skill's *Triage* section for the session.

## Status and recovery

- `node "$BPT" session show <id>` — lanes, phases, attention messages, test PRs.
- `node "$BPT" lane show <id> <branch>` — every pick with its status and details.
- `node "$BPT" job list --session <id>`, `job log <job>`.
- A lane can be reset (`lane reset`, or the UI) any time before Finalize; it deletes the worktree and local branch and forgets the picks, the remote test branch stays.
- Decisions changed while a lane runs: the UI syncs the pick list (pending picks drop out or are added; a PR added after later commits were picked is flagged as out of master order).

## References

- [references/design.md](references/design.md) — architecture, database schema, safety model, how to extend.
- pulsar-cherry-pick skill — conflict resolution, slog→slf4j, Gradle→Maven.
- investigate-ci skill — CI failure analysis.
