---
name: pulsar-backport
description: Execute an apache/pulsar backport plan from the bpt session database — cherry-pick the decided PRs onto branch-4.2 in master commit order, catch dependencies that planning missed, push a test branch to apache/pulsar and take its dispatched CI to green (never through a PR), then reuse the tested picks for branch-4.0, and finally fast-forward the real branches when the user clicks Finalize in the local web UI. Use when asked to run/continue/resume backporting, process backport jobs, fix a backport's CI, or act as a bpt worker (prompts that start "You are a headless worker for the pulsar-backport skill"). Planning is the pulsar-backport-plan skill.
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
| **`bpt` engine** | worktrees, cherry-picks in order, dependency gate, check-pick scan, pushes (test branches only, never forced), CI dispatch on the test branch, CI polling, rerun, squash, the final fast-forward, labels |
| **Claude Code workers** (headless `claude -p`, or you) | judgement jobs: resolve a conflict, make a pick compile, verify the lane builds, diagnose CI failures and fix them |
| **The user**, in the web UI | decisions, dependency accept/dismiss, starting backporting, and **Finalize** — the only path that pushes to a real release branch |

No Anthropic API key is involved: workers run on the user's Claude Code login. `bpt serve` launches them with `claude -p --permission-mode auto`, with `git push`, `gh pr create/edit/merge/comment/close`, `gh issue` and `gh label` denied. Set the session's "Claude jobs" selector to **my Claude Code session** to have the interactive session process them instead (see *Driving from this session*).

## Lane state machine

One lane per target branch, in plan order. A lane with `reuse_from` (branch-4.0 ← branch-4.2) starts only after its source lane is tested and squashed, and cherry-picks the source lane's final commits (without adding a second `cherry picked from` trailer).

```
not-started → picking ⇄ needs-attention → picked → verifying → verified → testing ⇄ ci-failed
            → ci-green → (squash) → ready → [user: Finalize] → final-ci ⇄ final-ci-failed → done
```

- **picking**: `pick-all` cherry-picks pending PRs in master order with `-x` in the lane worktree `~/workspace-pulsar/pulsar-cherry-picking/worktrees/<session>/<branch>` (local branch `bpt/<session>/<branch>`). Before each pick it re-runs blame analysis against the lane: an in-range master commit that the PR builds on and that is neither on the branch nor earlier in the batch is a **dependency found while backporting**. If the pick then conflicts — or the dependency came from the evaluator or a person — the pick is **blocked** and the user decides in the UI (Accept adds the dependency to the batch ahead of it; Dismiss proceeds). A clean pick on top of a blame hint only records a warning; the build check catches the rest. A dependency the user **left out in review** (decision "skip" set or accepted by the user) never blocks and is not asked about again: the pick goes in without it (a conflict is resolved without it), with a warning.
- **Build check, every pick**: before the next pick goes in (and before picking counts as finished), each committed pick — clean or resolved — passes the engine's build check in the lane worktree (`lib/build.mjs`): the Maven modules of the files it changed compile with their tests (`-pl <modules> -am`, one reactor, nothing installed into `~/.m2`), the test methods it added or changed pass (`ctx.pick.tests`; a change without tests runs the branch's `<Class>Test` of the changed classes), and checkstyle passes for its changed Java files (`initialize checkstyle:check -Dcheckstyle.includes=…`). A failure makes the pick `needs-fix` with the stage, output and log path in `detail.build`, and it goes to a resolve job; the user can also accept a failure that is not the pick's (`lane accept-build`). `lane build` runs it by hand. Session config: `buildCheck=false` turns it off, `buildCheckTests=false` skips the tests, `buildTimeoutMinutes` (90), `mvn` (default `./mvnw`).
- **A problem can show up later than the pick that caused it**: a pick can pass its own check and still break a module it did not touch or a test a later pick adds. When a check fails, `detail.build.suspects` names the picks that last changed the failing lines (git blame of the compiler errors), and the decision offers dropping such an earlier pick. The resolver chooses where the problem belongs: fix this pick, fix the earlier pick (a fixup of its commit), backport what the earlier pick is missing (`--propose dep:<earlier>:<missing>`), or drop the earlier pick (`--propose drop:<earlier>`).
- **Fixes go into the pick they belong to**: a fix for a problem a pick introduced — found by its own build check, a later pick, verify or CI — is a `git commit --fixup=<that pick's commit>`. The engine squashes it into that commit right away (`lane absorb`: autosquash, same tree), so the pick's commit and every commit after it are rewritten and every pick's sha in the database is updated; an amended pick's build check runs again. A pushed test branch cannot be rewritten (no force-push): it is retired, and the next test push opens a new round with a new PR (the old one is closed). Only after the real branch is pushed is a fix a new commit on top.
- **Intent check**: part of the build check, before Maven. A dependency version the master commit changes in `gradle/libs.versions.toml` must be in effect in the branch's Maven build (the version Maven resolves for those coordinates, property references followed, is the new one or newer) and the distribution LICENSE files must name the new jar (`lib/intent.mjs`). Dropping the Gradle file without making the upgrade in a `pom.xml` fails it.
- **Diff review** (after picking, before verify; again for a pick whose patch changed): Claude review jobs (`review`, a batch of `reviewBatch` picks, default 8) compare each pick with its master commit (`pick diff <id> <branch> <pr>`: both diffs file by file, plan notes, PRs left out in review, conflict hints, build and intent results) and record `ok`, `adapted` (differs where the branch needs it: missing feature or left-out PR, API differences, slog/Gradle/Java-level adaptations) or `concern` (`pick review … --verdict … --summary … --concerns …`). A concern is a decision: fix it in the pick (a resolve job; the fix goes into the pick's commit), accept it, or drop the pick; the squash waits for open concerns. A review belongs to the pick's patch (git patch-id): a rebuilt lane keeps it, a changed pick is reviewed again. The picks tab shows the verdict; **Compare** shows the analysis and both diffs side by side. Session config `diffReview=false` turns it off.
- **Analysis** (recorded by the same review jobs, stored in the `analysis` table so a report never re-analyses): per pick and branch, what the PR fixes, why it matters for the branch (`--reason bug|security|divergence|dependency|test|build|other`; *divergence*: the class on the branch is otherwise identical to master and taking a fix keeps later fixes applying cleanly, never for features) and its compatibility (`--compat none|behavior|breaking --compat-note …`: API, config and defaults, wire protocol, metrics, REST/CLI, dependencies, formats). `pick analysis <id> <branch> <pr> …`. Session config `analysis=false` turns it off.
- **Backport report** (UI tab *Report*, `bpt report <id> <branch> [--out F] [--gist]`): a summary and **Potential breaking changes** (and compatible behavior changes) at the top, then every cherry-pick of a lane in master order with **Fixes**, **Why on this branch** (the analysis and the plan's assessment, branch evidence, decision notes), **Compatibility**, **Adaptation** (diff review verdict and summary, plan adaptation and port notes, conflict resolution and its validation, warnings) and **Validation** (build check, intent check), and the latest CI run (the test branch's dispatched runs, or the release branch after finalize) with every workflow run linked and a summary. The tab renders it; *Download .md*, *Open in VS Code* (written to `$BPT_HOME/reports/`) and *Create secret gist* (`gh gist create`, secret).
- **A lane that reuses another lane's commits follows its decisions** (session config `followSourceDecisions`, default on): a pick blocked on a dependency that the source lane accepted gets it too, one dismissed there is picked without it, and a pick the source lane left out is left out. Without a decision on the source lane, the user decides.
- **needs-attention**: a `conflict` (cherry-pick stopped), `needs-fix` (applied, but `check-pick.sh` found slog, markers, unguarded debug, or Gradle files: branch-4.2 and branch-4.0 build with Maven, master with Gradle), or `blocked` pick. Conflicts also record *conflict dependency hints*: in-range master commits missing from the lane that touched the conflicted files.
- **verifying**: a Claude job compiles every touched module and runs the changed tests.
- **testing**: the engine pushes the lane to `<branch>-backports-<session>` on apache/pulsar and dispatches the CI workflows on that branch (`workflow_dispatch` of Pulsar CI, Flaky, Go and Python functions; session config `testWorkflows`, default `finalWorkflows`). No pull request is opened: a test PR against a release branch could be merged by accident. CI is polled every 5 minutes from the `workflow_dispatch` runs of the lane's commit on the test branch (the same for the release branch after Finalize). The first run seen per workflow is stored in the `ci_runs` table (run id, status, conclusion, attempt) and decides the result from then on: a later run of the same workflow never hides it, a rerun is a new attempt of the same run. A dispatched workflow without a run yet keeps the state pending; a failed `gh` listing (or one missing a tracked run) changes nothing. No run at all after 10 minutes, and none ever seen → dispatched once more; still none 20 minutes later → attention.
- **ci-failed**: a Claude job investigates (investigate-ci skill). Flaky or pre-existing → `bpt ci rerun` (limited by `maxReruns`, default 3). Caused by a pick → `fixup!` commit for that pick, then `lane phase … verified`; the engine squashes the fix into the pick and pushes the rewritten lane as a new test round (new branch and PR, no force-push).
- **ci-green → ready**: autosquash folds any fixups left into their picks (usually none: they were squashed in when made) and asserts the tree is byte-identical to the tested tree.
- **Finalize** (user click): the local release branch is fast-forwarded to the squashed commits (with `git merge --ff-only` in the worktree that has it checked out, if any; that worktree must be clean) and that branch is pushed to apache/pulsar, then `workflow_dispatch` of Pulsar CI, Flaky, Go and Python function workflows (Pulsar CI has no push trigger). If someone pushed to the branch meanwhile, the batch is rebased and the UI asks before pushing that untested combination.
- **final-ci-failed**: rerun for flakes; a real fix goes on top as a new commit and the user pushes it from the UI ("Push fix").
- **done**: `cherry-picked/<branch>` and `release/<version>` labels on every picked PR, test branch deleted. When **every** lane is done, autopilot posts the PR comments queued during planning (e.g. "needs a separate backport" on a skipped PR); a failed post is retried on the next post-comments run, a posted one never twice.
- **finished** (session): once every lane is done, no job is queued or running and every queued PR comment is posted, autopilot marks the session **finished**. A finished session is read-only: the server, the CLI commands that write, the job queue and autopilot refuse every change. The plan, picks, diffs and reports stay readable, and the reports can still be downloaded, opened in VS Code and published as secret gists. A comment whose post failed keeps the session open until it is posted or cleared. The escape hatch is CLI only: `bpt session reopen <id> --reason T` makes it editable again, with autopilot off.

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

Then `git add` and `git -c core.editor=true cherry-pick --continue` (for `needs-fix`: `git commit --fixup=<the pick's commit>`, or the earlier pick's commit when that one caused it; never amend a commit that is not HEAD), and report what validated it. The pick must compile, pass its changed tests and checkstyle for the changed files: the engine's build check runs that next, and a failure comes back as `needs-fix` (`ctx.pick.detail.build` has the stage, output and log):

```bash
node "$BPT" lane resolved <session> <branch> <pr> --tests "TopicPoliciesTest#testA+testB,PersistentTopicTest" --result "passed"
```
If the conflict shows the pick needs an earlier PR (the conflict hints list candidates, but it may also be a PR merged before the plan's range): leave the cherry-pick as it is and `job ask` with `--propose dep:<pr>:<dep>` and the symbol or file it needs in the question. Do not pull in other PRs on your own; the engine adds the approved dependency in master order. PRs in `ctx.pick.excludedInReview` were left out of this branch in review: resolve without them, adapting the change; `job ask` answers a `dep:` proposal for one of them at once ("NOT ASKED") and the job stays yours. Only when the pick cannot work at all without it, propose `drop:<pr>`.

### verify (all picks applied)
`ctx.modules` lists the touched modules. Build them (`./mvnw -q -T 1C -pl <modules> -am install -DskipTests -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dlicense.skip=true` once, then `test-compile`), and run the added/modified test methods of each pick (`git show <picked> --stat`; `-Dtest='Class#m1+m2'`). Fix problems with `git commit --fixup=<picked sha>` of the pick that caused them; the engine squashes them into that pick before the test push. Run checkstyle on touched modules (branch-4.2 needs `initialize`: `./mvnw -pl <m> initialize checkstyle:check`). When green: `node "$BPT" lane phase <session> <branch> verified`, then `job done`.

### fix-ci (the test branch or the real branch failed)
**Reproduce before calling anything flaky.** Build the failing module with the reactor in the lane worktree (`./mvnw -T 1C -pl <module> -am package -Dtest=<Class#method> …`; never `-o` against `~/.m2` jars, which can be stale) and run each failed test at least 5 times; report the counts. A test that fails locally, or failed in both the first run and the in-run retry (surefire *Run 1* / *Run 2*), is not flaky until shown otherwise: find the commit that causes it (revert the suspect pick in a scratch worktree and re-run) and check master for the same failure or for a later fix that is not on the branch. A real failure on a lane that is already pushed is fixed on top: `lane pick-on-top` for a missing master fix, `lane revert` for a pick that needs a fix first (both below).
`ctx.lane.ci.<kind>.failed` lists the failed workflow runs with links (`workflow_dispatch` runs on `ctx.lane.ci.test.branch`, or on the release branch after Finalize). Use the **investigate-ci** skill. Decide per failure:
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
- A rebuilt lane can no longer fast-forward its pushed test branch, and the engine never force-pushes: the next test push starts round 2 (`<test-branch>-r2`) and deletes the superseded test branch. A lane that reuses a rebuilt lane keeps the old commits until it is reset (an event says so).
- **After the batch is pushed** (phases final-ci, final-ci-failed, done) its commits are fixed; changes go on top as ordinary commits, local until the user clicks *Push commits on top to <branch>* (`push-final-fix`: fast-forwards the local release branch, pushes it, dispatches CI again):
  - `lane pick-on-top <id> <branch> <pr> [--reason T]` backports a missing master fix (`cherry-pick -x`; a PR merged before the plan's range joins the plan) and runs its build check. On a conflict the cherry-pick stays in progress: resolve, `git cherry-pick --continue`, run it again. The pick is recorded (`detail.onTop`) and listed in the report as *backported on top*.
  - `lane revert <id> <branch> <pr> --reason T` reverts a pick that needs a fix first with an ordinary `git revert` commit; the pick becomes `reverted` and the report lists it under **Reverted** with the reason. A reverted PR does not get (and loses) the `cherry-picked/<branch>` and release labels.
- **Abort backporting…** (`abort <id>`): cancels the lanes' jobs, resets every lane not yet pushed to its real branch, deletes their test branches and returns the session to planning with its decisions kept. Revisit the plan and click Start backporting again. **Pause** (back to planning) only stops starting new work and keeps the lanes.

## Status and recovery

- `node "$BPT" session show <id>` — lanes, phases, attention messages, test branches and CI.
- `node "$BPT" lane show <id> <branch>` — every pick with its status and details.
- `node "$BPT" job list --session <id>`, `job log <job>`.
- A lane can be reset (`lane reset`, or the UI) any time before Finalize; it deletes the worktree and local branch and forgets the picks. Its test branch is deleted on the next push (or by an abort), which starts a new round.
- Decisions changed while a lane runs: the pick list follows (pending picks drop out or are added in master order; committed picks and picks added after picking finished become Decisions needed).

## References

- [references/design.md](references/design.md) — architecture, database schema, safety model, how to extend.
- pulsar-cherry-pick skill — conflict resolution, slog→slf4j, Gradle→Maven.
- investigate-ci skill — CI failure analysis.
