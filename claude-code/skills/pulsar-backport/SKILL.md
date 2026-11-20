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
- **needs-attention**: a `conflict` (cherry-pick stopped), `needs-fix` (applied, but `check-pick.sh` found slog, markers, unguarded debug, or Gradle files: branch-4.2 and branch-4.0 build with Maven, master with Gradle), or `blocked` pick. Conflicts also record *conflict dependency hints*: in-range master commits missing from the lane that touched the conflicted files.
- **verifying**: a Claude job compiles every touched module and runs the changed tests.
- **testing**: the engine pushes the lane to `<branch>-backports-<session>` on apache/pulsar and opens a PR against the branch (labels `ready-to-test`, `doc-not-needed`; title says do not merge). CI is polled every 5 minutes.
- **ci-failed**: a Claude job investigates (investigate-ci skill). Flaky or pre-existing → `bpt ci rerun` (limited by `maxReruns`, default 3). Caused by a pick → `fixup!` commit for that pick, then `lane phase … verified`, and the engine pushes again (fast-forward, no force).
- **ci-green → ready**: autosquash folds the fixups into their picks and asserts the tree is byte-identical to the tested tree.
- **Finalize** (user click): fast-forward push of the squashed commits to the real branch, then `workflow_dispatch` of Pulsar CI, Flaky, Go and Python function workflows (Pulsar CI has no push trigger). If someone pushed to the branch meanwhile, the batch is rebased and the UI asks before pushing that untested combination.
- **final-ci-failed**: rerun for flakes; a real fix goes on top as a new commit and the user pushes it from the UI ("Push fix").
- **done**: `cherry-picked/<branch>` and `release/<version>` labels on every picked PR, test PR closed with a comment, test branch deleted. When **every** lane is done, autopilot posts the PR comments queued during planning (e.g. "needs a separate backport" on a skipped PR); a failed post is retried on the next post-comments run, a posted one never twice.

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

`job ask` is right when the fix needs a product decision, a dependency the user hasn't approved, or a non-mechanical rewrite. Keep the question short and plain. Add `--propose` with the actions you recommend (recommended first), so the user approves one with a click instead of typing an answer; when none of those fits, put what you would do in `--recommend "<one imperative sentence>"`, which the user accepts with one click (you resume with it as the reply):

```bash
node "$BPT" job ask <job> --question "#27214 calls ManagedLedgerConfig#getFoo, added by #26925" --propose dep:27214:26925,drop:27214
```

Proposals: `dep:<pr>:<dependency>` (backport the dependency first, in master order), `drop:<pr>` (leave the pick out; the lane is rebuilt without it), `rerun`, `reset`. An approved proposal finishes your job; a typed reply resumes your session with it.

### resolve (`conflict` or `needs-fix` pick)
Conflicts and failed post-pick checks go to this Claude job as soon as they happen, with or without autopilot (two attempts, then the pick waits under Decisions needed; session config `autoResolve=false` turns it off).

Follow the **pulsar-cherry-pick** skill's per-commit loop for this one commit: read the source commit, resolve with zdiff3 (take the commit's logic, re-skin to the branch: slf4j, Maven, Java 8 on 4.0 client modules), run `scripts/check-pick.sh <master-sha>` from that skill, compile the module (`./mvnw -q -pl <module> test-compile …`; install shared modules first).

Run the commit's changed tests as that skill's step 6 says. `ctx.pick.tests` has them worked out: the test methods the commit added or modified, as a `-Dtest` value per module (`Class#m1+m2`; a whole class when the change is outside a test method), or, when the commit changes no test, the branch's existing `<Class>Test` of the classes it changes (`fallback: true`). A failure caused by the resolution is fixed and re-run; one that also fails on the branch without the pick is noted and does not block. The verify job builds and tests the whole lane later.

`lane resolved` re-runs check-pick.sh and refuses while it still reports findings, so slog → slf4j, debug guards and Gradle → Maven are done before a pick counts as resolved.

Then `git add` and `git -c core.editor=true cherry-pick --continue` (for `needs-fix`: `git commit --amend --no-edit`), and report what validated it:

```bash
node "$BPT" lane resolved <session> <branch> <pr> --tests "TopicPoliciesTest#testA+testB,PersistentTopicTest" --result "passed"
```
If the conflict shows the pick needs an earlier PR (the conflict hints list candidates, but it may also be a PR merged before the plan's range): leave the cherry-pick as it is and `job ask` with `--propose dep:<pr>:<dep>` and the symbol or file it needs in the question. Do not pull in other PRs on your own; the engine adds the approved dependency in master order.

### verify (all picks applied)
`ctx.modules` lists the touched modules. Build them (`./mvnw -q -T 1C -pl <modules> -am install -DskipTests -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dlicense.skip=true` once, then `test-compile`), and run the added/modified test methods of each pick (`git show <picked> --stat`; `-Dtest='Class#m1+m2'`). Fix problems with `git commit --fixup=<picked sha>` so they squash into the right pick later. Run checkstyle on touched modules (branch-4.2 needs `initialize`: `./mvnw -pl <m> initialize checkstyle:check`). When green: `node "$BPT" lane phase <session> <branch> verified`, then `job done`.

### fix-ci (test PR or the real branch failed)
`ctx.lane.ci.<kind>.failed` lists failed checks with links. Use the **investigate-ci** skill. Decide per failure:
- **Flaky or pre-existing** (fails on the branch without these picks, known flaky, infrastructure): `node "$BPT" ci rerun <session> <branch>`.
- **Caused by a pick**: reproduce locally in the lane worktree, fix, run the affected tests. Test lane: `git commit --fixup=<that pick's sha>` then `node "$BPT" lane phase <session> <branch> verified` (the engine pushes). Final lane: a normal commit on top of HEAD with a `[fix][<component>]` subject; the user pushes it from the UI.
- **A pick is wrong for this branch and cannot be adapted**: `job ask` with `--propose drop:<pr>`; approved, the lane is rebuilt without it and tested again.
- **A pick needs another PR**: `job ask` with `--propose dep:<pr>:<dep>`.
Finish with `job done` summarising each failure and what you did.

### triage
Follow the pulsar-backport-plan skill's *Triage* section for the session.

## Changing course while backporting

Decisions made during planning can turn out wrong, and dependencies show up only when the picks meet the branch. Nothing has to be fixed by hand: the UI's **Decisions needed** panel (and `node "$BPT" decisions <id>`) lists every point where the backport waits for the user, each with the options that carry it on (the recommended one first). Autopilot stops at each one. **Continue with recommended** (`decisions <id> recommended`) takes the recommended option of every decision that needs no typed input or confirmation.

| Situation | Options |
|---|---|
| A pick is blocked on a dependency | backport the dependency first · pick without it · leave the pick out |
| A pick conflicts or fails the post-pick check | resolve with Claude (again, with instructions) · backport a conflict hint first · I resolved it · leave it out |
| A worker asks (`job ask`) | its proposals · reply · cancel the job |
| A PR was decided "backport" after picking finished | re-pick in master order · pick on top, out of order (needs a reason) · leave it out |
| A picked PR is no longer decided "backport" | drop it · keep it |
| Verification failed twice, CI still fails after a fix | try again with instructions · mark verified / re-run |
| A lane is tested and squashed | Finalize |

**Master commit order is the rule.** A pick that belongs before commits already in the lane (a dependency accepted late, a decision changed mid-way) makes the engine *rebuild* the lane from that point: it resets the lane to the commit before the first affected pick and re-applies the later picks from their lane commits, so conflict resolutions and `fixup!` commits are kept. While picking, this happens automatically; after picking finished it is the recommended option of a decision, because verification and test CI start over. Only an explicit "pick on top" with a reason deviates from master order. Make fixups with `git commit --fixup=<sha>` (subject form), which survive a rebuild.

Other controls:
- **Drop** (picks tab, `lane drop`): removes any pick, also one already committed; the lane is rebuilt without it and its fixups, and its decision becomes "skip".
- **Add dependency…** (picks tab, `lane add-dep <id> <branch> <pr> <dep>`): another PR is needed first. A PR merged before the plan's range joins the plan; it is decided "backport" and goes in at its master position.
- A rebuilt lane can no longer fast-forward its pushed test branch, and the engine never force-pushes: the next test push opens round 2 (`<test-branch>-r2`) and closes the superseded test PR. A lane that reuses a rebuilt lane keeps the old commits until it is reset (an event says so).
- **Abort backporting…** (`abort <id>`): cancels the lanes' jobs, resets every lane not yet pushed to its real branch, closes their test PRs and returns the session to planning with its decisions kept. Revisit the plan and click Start backporting again. **Pause** (back to planning) only stops starting new work and keeps the lanes.

## Status and recovery

- `node "$BPT" session show <id>` — lanes, phases, attention messages, test PRs.
- `node "$BPT" lane show <id> <branch>` — every pick with its status and details.
- `node "$BPT" job list --session <id>`, `job log <job>`.
- A lane can be reset (`lane reset`, or the UI) any time before Finalize; it deletes the worktree and local branch and forgets the picks. Its test PR is closed on the next push (or by an abort), which opens a new round.
- Decisions changed while a lane runs: the pick list follows (pending picks drop out or are added in master order; committed picks and picks added after picking finished become Decisions needed).

## References

- [references/design.md](references/design.md) — architecture, database schema, safety model, how to extend.
- pulsar-cherry-pick skill — conflict resolution, slog→slf4j, Gradle→Maven.
- investigate-ci skill — CI failure analysis.
