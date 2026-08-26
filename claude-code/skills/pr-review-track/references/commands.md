# `prt` command reference

`prt` is the deterministic engine. It owns GitHub I/O, the on-disk store, the
action-file format, and it is the **only** code that writes to GitHub.

```bash
PRT="$CLAUDE_SKILL_DIR/scripts/prt.mjs"   # or: ~/.claude/skills/pr-review-track/scripts/prt.mjs
node "$PRT" <command> [args] [--repo owner/repo] [--root DIR] [--json]
```

`--repo` defaults to the GitHub repo of the current working directory (the
upstream parent when the checkout is a fork). `--json` makes every command emit
machine-readable output — use it whenever a model consumes the result.

## Discovery

### `approved`

Scans open PRs in the repository and lists those whose configured reviewer has
a current `APPROVED` verdict. It verifies the review history rather than relying
only on GitHub's search qualifier: the reviewer's latest non-comment verdict
must be `APPROVED`, so later standalone thread replies do not hide an approval
and a later changes-requested or dismissed verdict excludes it.

Human-readable output lists each PR number, title, and author, followed by the
full PR URL on its own line so terminals can recognize it as a clickable link
without rendering Markdown. `--json` returns `{ repo, reviewer, rows }` for
automation.

### `latest [--limit 10] [--pool 120] [--include-drafts] [--max-per-author 2]`

Ranks open PRs the reviewer has **not** engaged with — not the author, not
tracked, no review or comment by them. A PR where their review was *requested*
and never given stays in the pool: that is the most relevant thing this command
can surface, not something to filter out as "engaged". Prints the score and the
reasons behind it, so the ordering is auditable.

Beyond `--max-per-author` a contributor's remaining PRs are demoted below
everyone else's first picks rather than dropped — a shortlist where one person
holds six of ten slots is a worse queue.

Ranking inputs, highest first: authors on `priorityAuthors` (`merlimat` by
default) · an explicit review request · ASF `MEMBER` authorship · nobody has
reviewed it yet · first-time contributor · recently updated · small diff · green
CI · `[fix]`/regression titles · PIP proposals. Drafts, bots, very large diffs,
red CI and stale PRs score negative.

### `sync [--limit N]`

Reconciles GitHub with the local store. Finds every open PR in the repo that the
reviewer has reviewed, commented on, or been asked to review (three search
queries, unioned), then fetches all of them — tracked and remote — in batched
GraphQL queries and writes a baseline `pr.json` per PR.

`sync` never drafts. It answers "what is my current position on every PR I have
touched"; `re-review` is what turns that into drafts.

Cost on ~130 PRs: 3 search queries + ~16 batched detail queries. Aliased GraphQL
batching means one request covers many PRs for one rate-limit point.

### `board` · `list [--status draft,ready,…]`

`board` regenerates and prints `BOARD.md`, grouped into attention buckets, most
urgent first:

- `my-queue` — a file of mine is `ready`, `blocked`, `partial` or `error`
- `author-replied-to-me` — someone is waiting on my answer
- `resolved-without-change` — marked done with no code behind it; verify
- `new-commits-to-check` — the head moved since my review
- `ready-to-approve` — every point I raised has a change behind it
- `nudge-due` — unanswered for days, and I have been quiet too
- `waiting-for-author` — my points are still open and untouched
- `ci-blocking` — red CI; the author still has work
- `stale` — nobody has touched it in months
- `parked` — `hold` / `skip`

`list` is the one-line-per-PR form, sorted by the same urgency score.

## Per PR

### `track <N>…` · `refresh [<N>…]`

`track` starts tracking a PR and fetches its baseline. `refresh` re-fetches
tracked PRs (all of them when given no numbers).

### `context <N>`

**The command a model should call before drafting.** Emits JSON with:

- the full analysis (my last review and the SHA it was made at, per-thread state,
  new commits, new comments, CI, labels)
- the incremental diff since my last review, cached to `cache/delta.patch`
- the full diff, cached to `cache/diff.patch`
- per file, every commentable line for `RIGHT` and `LEFT`
- the diff fingerprint and an urgency score with reasons
- `asks[]` — the notes the human left on the existing draft, with their derived
  state. Anything with `open: true` must be answered before the round is handed
  back; it is surfaced here as well as in `prt ask` so a subagent cannot miss it.

### `diff <N> [--since <sha> | --delta]`

The full diff, or the diff since my last review (`--delta` resolves the SHA).

### `anchors <N>`

Every `(path, line, side)` the PR's diff allows a comment on, as compressed
ranges. Use it when a comment fails to anchor.

### `draft <N> [--findings f.json] [--kind initial|re-review] [--to FILE] [--force]`

Writes `review.md` at `Status: draft`. Refuses to overwrite a protected file
unless `--force`; `--to review.next.md` writes a proposal alongside instead.
Anchors are validated at generation time too, so a finding that could never post
arrives as `post: false` with the reason attached rather than wasting your edit.

**It carries the human's notes forward.** `@ai` shorthand in the old file is
promoted; open `prt:ask` blocks are kept, answered ones for one more generation.
A note whose comment survived at a different id is re-bound **by anchor, not by
id** — inline ids are positional, so next round's `i3` may be a different
finding. A note whose comment is gone is orphaned to `re: gone` with `was:`
recording where it pointed, never dropped. Every promotion, re-bind and orphan
is printed. `--no-carry` drops them (the old file is still in `history/`).

If the old file's notes cannot be parsed safely, `draft` **refuses** rather than
overwriting them.

### `ask [<N>…] [--promote] [--json]`

Read the notes in an action file: `●` open and blocking, `○` open but deferred,
`✓` closed, with the derived state and the latest answer.

`--promote` turns `@ai` shorthand into canonical `prt:ask` blocks in place,
printing each id and the target it inferred. It refuses on a file the submitter
may be reading (`ready`, `queued`, `partial`).

There is deliberately **no `--addressed` flag**. Closing a note requires prose
saying what was done, prose is judgement, and judgement is the model's half of
the split — a flag that closed one without a body is exactly what the mandatory
answer body exists to forbid.

### `open [<N>…]`

Opens the action files in the configured editor (`code -r` by default). With no
numbers, opens everything in `draft`, `blocked`, `error`, or `partial`.

### `nudge [<N>…] [--limit 10] [--force]`

Drafts reminders for authors who have not answered points you raised. Produces
an ordinary action file containing a single `prt:issue-comment` block — one
notification for the author rather than one per thread — at `Status: draft`.

Proposed only when a thread of yours has gone unanswered for `nudgeAfterDays`
(2), the head has not moved since your review, you have said nothing on the PR
within `nudgeCooldownDays` (7), and the PR is open, not a draft, and not yours.
The cooldown is derived from GitHub rather than local state, so it holds across
machines and survives a lost tracking directory.

PRs whose oldest unanswered point exceeds `nudgeMaxAgeDays` (90) are listed
separately and not drafted — they need a decision, not a reminder.

## Posting

### `validate [<N>…]`

Parses the action file, plans the actions, and checks every anchor against the
live diff. Never contacts GitHub for writes. Exit code 1 if anything is wrong.

### `submit <N>… | --all-ready [--dry-run]`

Runs the transaction for files whose line 1 says `ready` (also resumes `queued`
and `partial`, and any PR with an open transaction whatever its status — an
interrupted run must be finishable). See `action-file.md` for the protocol.

`--dry-run` runs capture and the full preflight against live GitHub and reports
exactly what would be posted, without writing anything — to GitHub or to the
file. It refuses to resume an open transaction, since resuming posts.

The verdict controls the action set. `REPLY` posts only replies to existing file
review threads and leaves their resolved state and the review verdict untouched;
ordinary PR-conversation replies are deferred. `APPROVE`, `REQUEST_CHANGES`,
and `COMMENT` perform the normal complete pass. `Status: ready` is the single
human authorisation for either workflow. An `APPROVE` verdict also performs
GitHub's **Approve workflows to run** action for every eligible
`action_required` workflow run associated with the PR's approved head SHA.

### `watch [--interval 20] [--quiesce 3] [--once] [--all-repos]`

Polls the tracking tree and submits files as they become `ready`. Polling, not
filesystem events, because editors save through temp-file replacement and a
missed event means a review silently never posts.

A file must be unchanged for `--quiesce` seconds before it is acted on. Each
submission prints one line — those become chat notifications when the watcher
runs under the `Monitor` tool.

### `recover <N>`

Resumes an interrupted transaction. Before re-running an action it asks GitHub
whether that action already landed — matching body, target thread, and a
timestamp at or after the transaction started — so a crash between "posted" and
"recorded" does not double-post. See `action-file.md` for what counts as a
match and why an empty body never does.

## Housekeeping

### `cleanup [--purge] [--dry-run]`

Archives the tracking directory of every closed or merged PR to
`_archive/<owner>/<repo>/pr-<N>/`. `--purge` deletes instead.

Held back and reported rather than archived: a PR whose action file is `queued`
or `partial` (a transaction is open), or `ready` — a `ready` file is an approval
that never got posted, and archiving it would throw that approval away silently.

### `status <N> [<new status>]` · `doctor`

`status` reads line 1, and can set `draft`, `hold` or `skip`. It refuses to set
`ready` — that is your approval signature, so you write it in the file — and it
refuses every status the submitter owns. `doctor` prints the resolved repo, reviewer,
editor, GraphQL budget, and how many PRs are tracked per repo.

## Environment

- `PRT_ROOT` overrides the store root (default `~/.claude/pr-review-track`).
- `PRT_DEBUG=1` prints stack traces.
- Auth comes from `gh`; the token needs the `repo` scope to post reviews and
  `read:org` for member lookups.
