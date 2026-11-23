---
name: pr-review-desk
description: Review desk for GitHub pull requests across repositories, with a local web UI and a SQLite state. Triage (sync, priority score with reasons, categories, committer boost, lanes), a deterministic security scan that red-flags malicious PRs before anything runs, AI review drafts through the pr-review skill on Claude Code workers, and a human check in the UI where comments are edited next to their code, staged as a pending GitHub review (more comments can be added on GitHub) and submitted with the event the human picks. Use when asked to triage or review PRs ("review PR 123", "what should I review", "triage this repo", "re-review my open reviews"), from any clone, or when acting as a desk worker (prompts that start "You are a headless worker for the pr-review-desk skill"). Supersedes pr-review-track.
argument-hint: "[triage] [--repo owner/repo] | <PR number or URL>... [--instructions \"…\"] | ui | status | import-prt | worker"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill, Monitor, Workflow
---

# PR review desk

```bash
PRD=~/.claude/skills/pr-review-desk/scripts/prd.mjs
[ -f "$PRD" ] || PRD=~/workspace-pulsar/pulsar-contributor-toolbox/claude-code/skills/pr-review-desk/scripts/prd.mjs
node "$PRD" doctor
```

| | owns |
|---|---|
| **`prd` engine** (SQLite in `~/.claude/pr-review-desk`) | GitHub reads, triage, lanes, the security scan, findings → draft, anchors and permalinks, staging and submitting (only on a UI click) |
| **Claude Code workers** (headless `claude -p`, or you) | the security gate, review judgement (via the **pr-review** skill), thread assessments, revisions, answers |
| **The human**, in the web UI | what to review, every word that posts, the verdict (Comment / Request changes / Approve), staging, submitting, security overrides |

No API key: workers run on the user's Claude Code login.

## Routing

Repository: `--repo`, a PR URL, or the clone you are in (its upstream when it is a fork; the clone becomes the repo's checkout for reviewer worktrees).

| The user says | Do |
|---|---|
| `/pr-review-desk`, "triage", "what should I review" | `node "$PRD" triage` then `node "$PRD" ui`; report the lanes in two or three lines and give the link |
| a PR number or URL, "review 27123" | `node "$PRD" track <N…> --review [--instructions "…"]`, then `ui`. A PR on security hold is not queued: say so and point at the evidence |
| "re-review", "check my open reviews" | `triage`; the **Changed since your review** lane is the answer (its "Re-review top N" button queues them in priority order). Queue re-reviews only for the PRs the user names, or ask how many of the top of the lane to queue |
| "open the desk", "ui" | `node "$PRD" ui --open` |
| "status" | `node "$PRD" list --lane check` (and `follow-up`, `security`) |
| "import my prt drafts" | `node "$PRD" import-prt` (one-time; pr-review-track's draft/hold files become draft rounds, skip → ignored) |
| "work the queue", "process review jobs" | [Driving from this session](#driving-from-this-session) |

Then stop: the rest happens in the web UI. Report outcomes, not play-by-play.

## Lanes

Backlog → Queued → AI reviewing → **Drafts to check** → **Staged on GitHub** → Waiting for author / Approved → **Changed since your review** → (re-review) → Drafts to check … · plus **Security hold**, Parked (snoozed, parked, ignored, or an ignore rule), Closed/merged. A lane is derived from facts on every change (the human's hold, an active job, the review round, GitHub state), never set by hand.

- **Drafts to check** holds drafts written for the PR's *current* head — first reviews and re-reviews alike (`kind:re-review` / `kind:initial` filter them).
- **Changed since your review** holds PRs you reviewed that moved (new commits, replies waiting on you, threads resolved without a code change, new author comments) and PRs whose draft fell behind the head. The Me column says which; the score orders them (author waiting on you ≫ resolved without change ≫ new commits ≫ out-of-date draft). "Re-review top N" queues re-reviews for the first N rows as filtered and sorted. A re-review carries the still-valid points of an out-of-date draft forward.
- **A stale round cannot be submitted.** When the PR has new commits after the head the draft read, or the author commented, replied in a thread or reviewed after the draft was written, submit is refused (the UI disables it and says why) and the draft has to be revisited: a re-review supersedes it, carries the user's own comments and comments added on GitHub over, and deletes an out-of-date pending review on GitHub. The check is re-run against fresh GitHub data at submit time.
- **CI on approval.** When the verdict is Approve, the submit dialog offers to approve workflow runs GitHub holds for approval (on by default) and to update the PR branch from its base ("Update branch") and approve the runs that starts. The update is on by default when there was no commit and no workflow run in the last 7 days, so CI passes on the latest base before merging. Both are refused while the security gate is flagged or suspicious. The merge commit the update creates does not count as new work, so the PR stays in Approved.

- **Approved but blocked by threads.** GitHub refuses to merge while a conversation is unresolved. Approved PRs with open threads show "N open thread(s) block merge"; "Settle threads" (row, PR page, or "Settle threads top N" in Approved) queues a `threads` job that checks every open thread (anyone's, outdated ones too) against the code and proposes one action each: resolve, reply and resolve, nudge the author (reply, keep open), follow-up issue (create, reply with its number, resolve), or leave it to you. The plan waits on the Threads tab: edit any text, tick what to apply (other reviewers' threads start unticked), "Apply". The Threads tab also has "Follow-up issue and resolve" and "Resolve" on every open thread, without Claude. Applying re-reads the PR: a thread resolved meanwhile is skipped, one with a new comment is refused; replies and issues go through the same lints as reviews.
- **CI waiting for approval.** "Approve CI top N" (any active lane) lists the workflow runs GitHub holds on the current heads of the top N PRs shown, then approves them after you confirm. A head the scan did not read is scanned first; a flagged, suspicious or inconclusive head is never approved.
- **Merge conflicts** (any lane; PR page → Branch). "Resolve conflicts (merge <base>)" queues a `merge` job: the engine fetches the PR's base branch from the upstream remote (master, or branch-4.2 for a PR against it) and starts `git merge` in a worktree of the pinned head (gate must be clear); the worker resolves, commits one merge commit, builds what it can, and `prd job merge-ready` checks it (parents = pinned head + base, clean, no markers) and pins it under `refs/pr-desk/<n>/merge-<job>`. You read the summary and combined diff and click "Push merge to the PR branch": a plain (fast-forward) push as you, refused if the head moved or a fork PR does not allow maintainer edits. "Update branch" is GitHub's merge for a PR without conflicts.

**Priority** is prt's ranking (priority authors, review requested, ASF membership, nobody reviewed it, size, CI, recency, fix titles; for follow-ups: author waiting on me, threads resolved without change, new commits) plus the repo's weights: committers (+150: org MEMBER/OWNER/COLLABORATOR or write permission per the collaborators API), category (`[fix]` up, docs down), labels, paths. Every point has a reason the UI shows.

**Autopilot** (per repo, off by default) applies `auto.review` / `auto.reReview` rules on each sync: score threshold, committers-only, size, drafts, per-day and concurrency limits, once per head for re-reviews, paused when the Claude tier or Codex budget (review-budget.sh) is in the configured state. With `auto.review.maxPerDay: "budget"` there is no daily count: reviews continue while every Claude and Codex usage window is below `auto.budget.maxPercent` (default 85) and, if set, burns no faster than `auto.budget.maxPace`; the reading is refreshed every 10 minutes in this mode. Cancelled automatic reviews never count toward the daily limit. It only queues drafts. Rules live in the UI (Rules & repos) or `prd repo config`.

## Security model

Every PR is untrusted. Before any model reads a PR and before any checkout exists, `prd` scans the diff (`scripts/lib/scan.mjs`): changed execution surfaces (build scripts, wrappers, CI workflows, hooks, package manifests, native builds, Dockerfiles, shell scripts, IDE task configs, binaries) and high-risk shapes in added lines (download piped to a shell, reverse shells, decode-and-execute, credential/key access, miners, CI secret exfiltration and `pull_request_target`, hidden/bidi Unicode, persistence, destructive commands; process execution or downloads inside a build surface). A hit is **flagged**: the PR moves to **Security hold**, the rules never queue it, and nothing from it runs.

Gate states per head: `unscanned` → `scanned` | `flagged`; then the worker's gate (pr-review's critical security gate) records `clear`, `suspicious` or `inconclusive`; the human can override either way in the UI with a note. A new head resets the gate.

Execution is allowed only when the gate is `clear` for the job's pinned head:
- the engine creates the reviewer worktree (`prd job worktree`) and refuses otherwise; a flagged head can be cleared only by the human;
- headless workers start in a scratch directory without a checkout; while the gate is not clear their deny list includes build/test/interpreter commands, `git fetch/checkout/worktree`, besides the GitHub write commands that are always denied (`gh pr review/comment/edit/merge/close`, `gh api` writes and GraphQL, `git push`, `curl`, `sqlite3`);
- this is defence in depth, not a sandbox: a worker is still told to treat the PR as hostile and to stop at the first suspicious sign.

## Driving from this session

Headless workers are the default (the server launches `claude -p` per queued job, `maxClaudeWorkers` at a time). To work jobs here instead, set the repo's `runner` to `interactive` (Rules & repos), then:

```bash
node "$PRD" job claim --wait 1200     # blocks until a job is queued; prints the worker prompt and context
```

Run it in the background, do the job as the *Worker jobs* section says, loop. Never stage or submit — the CLI has no command for it, and the web UI is the human's.

## Worker jobs

Start with `node "$PRD" job show <job>` (JSON: PR facts, pinned `head`, `diffFile`, `findingsOut`, `security` with the scan and `execAllowed`, `checkout`, `plan` with tier and Codex pairs, my last review, threads, new author comments, comments already staged on GitHub, the current draft). End with exactly one of `job done <job> --summary "…"`, `job fail <job> --reason "…"`, `job ask <job> --question "…"`.

1. **Security gate first.** Read the diff file (not a checkout). Apply pr-review's *Critical security gate*, then `node "$PRD" gate <job> clear|suspicious|inconclusive --evidence "<concrete evidence>"`. Not clear → static review of the diff only; never build, test, install, or run anything from the PR. The scan's hits are in `ctx.security.scan`.
2. **Checkout only after a clear gate:** `node "$PRD" job worktree <job>` prints a detached worktree at the pinned head. Use it as the reviewer worktree for pr-review (do not create another one at `/tmp/pr-review-N`); parallel reviewers each get their own worktree from the same pinned SHA. The engine removes it when the job ends. No checkout configured → `coverage: diff-only`.
3. **review** — run the **pr-review** skill with `--tier <plan.tier> --out <job dir>`, Codex first scan at `plan.firstScan`, follow-up validation at `plan.followUp`. Then `node "$PRD" review import <job> --findings <job dir>/findings.json`.
4. **re-review** — assess every thread in `ctx.threads` (`LIKELY_ADDRESSED`, `PARTIALLY_ADDRESSED`, `NOT_ADDRESSED`, `RESPONSE_NEEDED`, `OBSOLETE`, `NEEDS_HUMAN_VERIFICATION`, with checkable evidence; a thread resolved with no code change behind it is a finding) and answer author questions in `ctx.newIssueComments`. Review the delta since `ctx.since` with `pr-review --since` when it is more than the requested edits. Judgement at `plan.followUp` (the re-review ceiling). Write `findings.json` with `threadAssessments` / `issueCommentAssessments` / `findings`, then `review import`.
5. **revise** — apply the user's instructions to the existing draft in place: `node "$PRD" comment set <id> --body-file f`, `comment add <job> --path P --line N [--side LEFT] [--start-line N] --body-file f`, `comment exclude <id>`, `review body <job> --body-file f`. Keep every SHA, file:line, test name and failure scenario. A comment the human edited (`editedBy: human`) is changed only when the instruction names it.
6. **threads** — for each thread in `ctx.openThreads` decide ADDRESSED / OBSOLETE (resolve, or reply-resolve), NOT_ADDRESSED (nag: what to do next), FOLLOW_UP (issue: title, self-contained body, reply with `{issue}`), NEEDS_HUMAN (leave), with checkable evidence. Write `ctx.threadPlanOut` and `node "$PRD" threads import <job> --file <it>`. Nothing posts until the human applies it.
7. **merge** — `node "$PRD" job merge-start <job>` (after a clear gate), resolve the conflicted files keeping both sides' intent, `git add` + `git commit --no-edit`, build/test the touched modules when allowed, `node "$PRD" job merge-ready <job>`, then `job done` with a per-file account. Never push.
8. **ask** — answer in the summary (`job done <job> --summary-file f`); it is shown privately in the UI. Change the draft only when asked.

`findings.json` is the pr-review contract — schema in `../pr-review-track/references/findings-schema.md`. Rules that matter here: `head` is the SHA you read (the job's pinned head); a finding that does not anchor still goes in (it arrives excluded with the reason); name code locations in prose (`Consumer.java:1015`) and the import links them at `head`; `summary` and every `body` reach a public PR.

### What posts, and how it reads

- **Never** describe the pipeline in anything that posts: no tier, effort, rounds, internal roles (adjudicator, validator, refutation pass), shape (two-model, single-reviewer), or which pass raised a finding. Saying that AI assisted, or naming the models, is fine. The desk refuses a stage/submit whose text trips prt's pipeline-mechanics or security-disclosure lint until the human acknowledges it.
- **Never disclose a vulnerability** or the security nature of a change in a public PR.
- First review of a PR: one short, varied sentence thanking the author before any criticism; when recommending approval the body starts with `LGTM.`. Inline comments and replies: short, constructive, evidence first, a concrete next step. No `APPROVE` from a worker — `recommendedEvent: APPROVE` is a recommendation the human acts on.

## Status and recovery

- `node "$PRD" list [--lane L]`, `show <N>`, `job list`, `job log <id>`; the UI's Jobs and Activity pages.
- A job stuck `running` after a server restart is marked failed on the next start; re-queue it from the PR page.
- A pending review discarded or submitted on GitHub is noticed by "Sync from GitHub" (and before every stage/submit).
- State: `~/.claude/pr-review-desk/desk.sqlite` (`PRD_HOME` overrides); diffs, findings and job dirs under `prs/`, logs under `logs/`.

## References

- [references/design.md](references/design.md) — architecture, schema, the stage/submit transaction, extending the rules.
- pr-review skill — the review pipeline and the security gate. pr-review-track — retired workflow; its library (`scripts/lib`) is what `prd` uses for GitHub I/O, anchors, permalinks, ranking and lints.
