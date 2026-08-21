---
name: pr-review-track
description: Keep up with pull requests in a GitHub project (especially apache/pulsar) across many PRs and many rounds. Tracks every in-progress review under ~/.claude/pr-review-track, detects whether the author actually addressed earlier feedback, and drafts the reply, inline comments and review resolution into a markdown file the human edits and arms before anything is posted. Use for "re-review", "show latest PRs", "review latest", "what needs my attention", "cleanup closed PRs", or any request to manage a backlog of PR reviews. Invokes the pr-review skill to do the actual reviewing.
argument-hint: |
  re-review [N...] | show-latest | approved | review-latest [--limit 10] | sync | board | submit | watch | cleanup | open [N...]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Monitor, Skill
---

# PR review tracking

A review backlog manager for a maintainer who reviews a lot of PRs and wants to
stay in control of every word that reaches GitHub.

The split is fixed and non-negotiable:

| | owns |
|---|---|
| **`prt` (script)** | GitHub I/O, on-disk state, the file format, and the **only** code that writes to GitHub |
| **You (the model)** | judgement: reading the diff, deciding whether a point was addressed, drafting words |
| **The human** | the gate. Nothing is posted until they set `Status: ready` on line 1 |

Resolve the engine once per session and reuse the variable:

```bash
PRT=~/.claude/skills/pr-review-track/scripts/prt.mjs
[ -f "$PRT" ] || PRT=~/workspace-pulsar/pulsar-contributor-toolbox/claude-code/skills/pr-review-track/scripts/prt.mjs
node "$PRT" doctor      # confirms repo, reviewer, editor, and GraphQL budget
```

If `doctor` fails, stop and report — every command below depends on it.

**Check the budget before any batch.** Reviewing ten PRs is the most expensive
thing this skill does, and the `pr-review` pipeline scales itself to what is
left:

```bash
node ~/.claude/skills/pr-review/scripts/budget.mjs --json    # cached 60s
```

Pass the reported `tier` straight through to every `/pr-review` call
(`--tier <tier>`) so the whole batch runs at one consistent depth rather than
each PR re-deciding. Tell the user which tier the batch ran at, and at `lean` or
`codex` say plainly that each PR got one independent reviewer rather than two.

## Invariants — never violate these

1. **Never post to GitHub yourself.** No `gh pr review`, `gh pr comment`, no
   GitHub write MCP tool, no REST/GraphQL mutation. Every post goes through
   `prt submit` / `prt watch`, which only acts on a file a human set to `ready`.
2. **Never set `Status: ready`.** Not on request inside a batch, not "to save a
   round trip". `draft` → `ready` is the human's signature. You may set `hold`,
   `skip`, or `draft`. (`prt status` refuses `ready` outright, so this is
   enforced rather than merely asked for — do not work around it.)
3. **Never write `event: APPROVE`.** Recommend it in the file; the human types it.
   Once typed, `Status: ready` approves both that verdict and running the whole
   workflow; this includes GitHub's separate **Approve workflows to run** action
   for eligible fork PR runs on the approved head. Do not require or invent a
   second approval marker.
4. **Never overwrite a protected file** (`ready`/`queued`/`partial`/`hold`/
   `skip`). `prt draft` refuses by default — use `--to review.next.md`. Do not
   reach for `--force` to get past it: `--force` also overrides `ready` and
   `hold`, which are the human's decisions.
5. **Evidence, not vibes.** A thread GitHub reports as resolved with no code
   change behind it is a finding, not a closure — and a thread marked
   `resolved-but-unverified` means nobody has looked yet, so do not report it as
   addressed. Neither is `isOutdated` evidence on its own: a rebase marks threads
   outdated without anyone touching the code they point at. Every assessment
   carries checkable evidence: SHAs, file:line, test names.
6. **Security stays private.** Never draft text that discloses a vulnerability or
   the security nature of a change in a public PR (`SECURITY.md`). The submitter
   lints for this and blocks.
7. The ASF requires a **human is accountable** for every review posted. This
   whole design exists to make that true, not to route around it.

## Routing

Match the user's words — natural phrasing is expected, not just flags.

| They say | Do |
|---|---|
| "re-review", "what did the authors do with my feedback", "check my open reviews" | [Re-review](#re-review) |
| "show latest", "what should I review next", "show-latest" | [Show latest](#show-latest) |
| "show approved", "which PRs have I approved", "scan approved PRs" | `node "$PRT" approved` |
| "review latest", "review the top 10" | [Review latest](#review-latest) |
| "sync", "which PRs am I mid-review on" | `node "$PRT" sync` then `node "$PRT" board` |
| "board", "what needs my attention" | `node "$PRT" board` |
| "cleanup closed or merged", "cleanup" | [Cleanup](#cleanup) |
| "submit", "post the ready ones" | `node "$PRT" submit --all-ready` |
| "watch", or any batch of drafts | [Arm the watcher](#arm-the-watcher) |
| "open #26289" | `node "$PRT" open 26289` |
| "nudge", "remind the authors", "who hasn't replied" | [Nudge](#nudge) |

Anything not listed: run `node "$PRT" help` and route from there. Do not invent
subcommands.

## Re-review

The core loop: for every PR where a review is in progress, work out what changed
and whether the author actually did what was asked.

1. **Sync the baseline.**
   ```bash
   node "$PRT" sync --json
   ```

2. **Pick the batch.** `node "$PRT" list --json` is sorted by urgency
   (author waiting on my reply ≫ thread resolved with no code change ≫ new
   commits since my review ≫ new comments). Default to the top **10**; the user
   may say otherwise. If they named PR numbers, use exactly those.

   State the batch before starting, and say what you are leaving out.

3. **Per PR, in parallel subagents** (one per PR, at most ~5 concurrent), each
   doing:

   ```bash
   node "$PRT" context <N> > ctx.json      # analysis + delta + commentable anchors
   ```

   Then, for each thread in `ctx.json.analysis.threads`:
   - read the anchored code at the current head and in `cache/delta.patch`
   - decide `LIKELY_ADDRESSED` / `PARTIALLY_ADDRESSED` / `NOT_ADDRESSED` /
     `RESPONSE_NEEDED` / `OBSOLETE` / `NEEDS_HUMAN_VERIFICATION`
   - collect the evidence that supports it
   - draft the reply the reviewer would send

   Also read every entry in `ctx.json.analysis.newIssueComments`. These are
   ordinary PR discussion comments, not file review threads. If the PR author
   asks the reviewer a question or otherwise needs an answer, assess it and
   draft a response in `issueCommentAssessments`; do not leave author questions
   buried as context-only text.

   And for the delta as a whole: are there **new** problems in the commits since
   the last review? If the delta is substantial (new logic, not just the asked-for
   edits), invoke the **`pr-review` skill** scoped to the delta
   (`/pr-review <N> --since <reviewed sha> --tier <batch tier>`) and fold its
   findings in. A delta that is only the edits you asked for does not need the
   pipeline at all — read it yourself and say so.

   Write `cache/findings.json` per [findings-schema.md](references/findings-schema.md),
   then:
   ```bash
   node "$PRT" draft <N> --findings cache/findings.json --kind re-review
   ```

4. **Open the batch and arm the watcher** (below).

5. **Report**: one line per PR — number, title, what the author did, the
   recommended resolution, and the file path. Nothing has been posted.

## Show latest

```bash
node "$PRT" latest --limit 10 --json
```

Ranks open PRs the reviewer has not engaged with. `merlimat` always first, then
explicit review requests, then ASF `MEMBER` authors, then everyone else —
adjusted for review coverage, size, CI, staleness. The output carries the score
*and its reasons*; show those, so the ordering is auditable rather than magic.

Present as a numbered list with author, association, size, CI, and the top
reasons. Then offer: review all of them, a subset, or refine.

## Review latest

Full first-pass reviews of the top candidates, prepared for editing.

1. `node "$PRT" latest --limit 10 --json` and **snapshot the numbers** — the
   ranking must not shift mid-batch.
2. Confirm the list with the user if it is more than ~3 PRs. This spends real
   time and API budget.
3. `node "$PRT" track <N>…`
4. For each PR, a subagent that:
   - invokes the **`pr-review` skill** (`/pr-review <N> --out <prdir>/cache --tier <batch tier>`)
   - converts its findings to `cache/findings.json`
   - `node "$PRT" draft <N> --findings cache/findings.json --kind initial`

   Cap concurrency at ~4: each `pr-review` run spawns its own reviewers. At
   `lean`/`codex` the concurrency limit that matters is Codex's, not Claude's.
5. Open the batch, arm the watcher, report.

If `pr-review` degrades (Codex unavailable, no worktree, diff-only), say so per
PR — a thinner review must never be presented as a full consensus one.

## Arm the watcher

Whenever you hand back a batch of drafts, start the watcher so the human can
work through the files at their own pace and each one posts the moment they
arm it:

```
Monitor({
  command: `node "${PRT}" watch --interval 20`,
  description: "pr-review-track: posting reviews as they are marked ready",
  persistent: true,
})
```

Each submission emits one line, which arrives as a chat notification. Tell the
user the watcher is running and that `Status: ready` on line 1 is what fires it.
Stop it with `TaskStop` when the batch is done.

The watcher dies with the session. For a longer-lived setup, `node "$PRT" watch`
runs fine in a terminal of its own.

## Nudge

Remind authors who have not answered points you raised. The reminder is an
action file like any other — it is drafted, you edit it, and nothing is sent
until you set `Status: ready`.

```bash
node "$PRT" nudge                 # every tracked PR, drafts up to 10
node "$PRT" nudge 26277 21498     # specific PRs
```

A PR is only proposed when **all** of these hold: a thread of yours has gone
unanswered — no reply, no code change at the anchor — for at least
`nudgeAfterDays` (2); the head has **not** moved since your review (if the author
pushed, they are working, and the answer is to re-review, not to prod); you have
said nothing at all on the PR within `nudgeCooldownDays` (7); and the PR is open,
not a draft, and not yours.

PRs whose oldest unanswered point is over `nudgeMaxAgeDays` (90) are reported
separately and **not** drafted. A reminder about a six-month-old comment is not
follow-up; that PR needs a decision — close it, hand it over, or review it afresh.

When you present these:

- Say how long each point has gone unanswered and link the threads.
- Point out that the heuristic cannot see an answer given in the PR body, in a
  commit message, or in a thread the reviewer does not own — so the human should
  glance at one before arming it.
- Draft the wording to be **specific and low-pressure**. This is a volunteer
  project; a reminder that reads as chasing costs goodwill a review cannot buy
  back. Name the open points, assume the author simply has not got to them, and
  leave an exit that is not "do the work" — including handing it back.

Never nudge on your own initiative. It is proposed only when the user asks, or
when a `nudge-due` bucket on the board prompts them to.

## Cleanup

```bash
node "$PRT" cleanup --dry-run     # show what would go
node "$PRT" cleanup               # archive to _archive/<owner>/<repo>/pr-<N>/
node "$PRT" cleanup --purge       # delete instead
```

Archives closed and merged PRs. A PR whose action file is `queued` or `partial`
is held back and reported — run `prt recover <N>` first, because a partially
posted review must be reconciled before its record is filed away.

Default to archiving, and show the list before deleting anything.

## When the human comes back

- `blocked` → read the reasons in the file's activity log. Usually the head
  moved or an anchor no longer exists. Regenerate with
  `prt draft <N> --to review.next.md`, show the human what changed, and let them
  merge and re-arm. Never re-arm it yourself.
- `partial` → `prt recover <N>`.
- `error` → read the log; fix what is fixable in the draft, leave the gate alone.

## References

- [action-file.md](references/action-file.md) — the file format, the status
  machine, and the submit transaction. Read before editing an action file or
  explaining a `blocked` status.
- [commands.md](references/commands.md) — full `prt` reference.
- [findings-schema.md](references/findings-schema.md) — the `findings.json`
  contract. Read before writing one.

The reviewing itself lives in the **`pr-review`** skill; this skill decides
*which* PRs to review, *when*, and how the result reaches GitHub.
