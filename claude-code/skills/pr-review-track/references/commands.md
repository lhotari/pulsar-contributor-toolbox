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

It does make one repair to files it finds: a `review.md` for an unmerged PR that
has no `prt:pr-actions` block — because it was drafted before the block existed
— gets one below its verdict, both flags `false`. `refresh`, `status` and
`ask --promote` do the same. See
[action-file.md](action-file.md#prtpr-actions--acting-on-the-pull-request-itself).

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

Above the buckets sits **`reviews in progress`**: every PR whose `review.md`
exists and is neither `submitted` nor `skip` — the reviews that were started and
not finished — with its author, and linked to its draft. The same rows are
reachable from the buckets too, where the status cell is the link. Links are
relative to the board's directory, so they open straight from an editor.

A `hold` draft counts as in progress: it was started, it is parked, it is not
done. An unfinished draft on a closed or merged PR is linked from the
`closed or merged` list as well, since `prt cleanup` is about to archive it.

The board ends with a count of what is in `_archive` — enough to remember that
something was set aside, without listing every PR `cleanup` has ever taken.

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
promoted — including a note typed *inside* a block, which is lifted out; open
`prt:ask` blocks are kept beside what they are about, and answered ones move to
the `## Resolved notes` log at the end of the file for one more generation.
A note whose comment survived at a different id is re-bound **by anchor, not by
id** — inline ids are positional, so next round's `i3` may be a different
finding. A note whose comment is gone is orphaned to `re: gone` with `was:`
recording where it pointed, never dropped. Every promotion, re-bind and orphan
is printed. `--no-carry` drops them (the old file is still in `history/`).

If the old file's notes cannot be parsed safely, `draft` **refuses** rather than
overwriting them — including any `@ai` note still written as one after promotion,
whether the lift declined it or nothing can lift it at all (`prt:log`, a block's
header). Those carry no better than an unreadable file: `carryAsks` moves
`prt:ask` blocks and nothing else, so the words would go to `history/` and out
of the working copy with nothing said. The refusal names every such line. Fix the
note, or `--no-carry`.

**It carries the human's lint acknowledgements forward too**, and only those:
`security-reviewed`, `ask-quote-reviewed` and `tooling-reviewed` are the only
`prt:doc` keys that survive a regeneration, because every other one is a
measurement the submitter re-checks. Each is re-earned against the new draft
rather than inherited — a labelled hatch keeps only the labels this generation
still trips, and a blanket `yes` is dropped the moment any outgoing passage is
one you have not read. Both directions are printed. `--no-carry` drops these as
well. The rules are in [`action-file.md`](action-file.md).

### `ask [<N>…] [--promote] [--tidy] [--json]`

Read the notes in an action file: `●` open and blocking, `○` open but deferred,
`✓` closed, with the derived state and the latest answer — `edited` there means a
note whose question was rewritten after it was answered, which is open — then `!`
for every
`@ai` line that is not a `prt:ask` block yet, with where it sits, the one edit
that fixes it, and its first line. That last group is why the command can be
trusted: a note is listed from the moment it is typed, not from the moment it is
promoted, and the remedy on the row is the note's own — never a `--promote` that
cannot lift this particular one. The listing is read
from the blocks wherever they sit, so a note filed under `## Resolved notes` is
still listed and still marked `✓` — at the end now, because the list is in file
order and filing moved it there. `no notes` prints only when the command had
nothing at all to say — never under a line about a note it just described.

`--promote` turns `@ai` shorthand into canonical `prt:ask` blocks. A note in a
gap is promoted in place; a note typed inside a block is **lifted** — deleted
from the block and re-emitted as a `prt:ask` just after that block's terminator,
with `follows:` set to the pair when it came out of a `prt:ask` or `prt:answer`.
Each promotion prints its id, the target it inferred, and the block it came out
of, and records the question it wrote as `q:`. A note the **lift** declines — one
butted straight up against prose, or one that is the whole of a block that cannot
go empty — is left exactly where it is and says so, by line and reason.

The same run also **accepts a question you rewrote**. A note whose text no longer
matches its `q:` is open already — `prt ask` shows it as `edited` and the submit
refuses it, with or without this flag — and `--promote` is what settles the
bookkeeping: it moves `q:` onto your wording and writes `re-q:` onto the old
answer, pinning that answer to the wording it really answered. The note stays
open, and the run prints a line saying so. Answering it again is what closes it.

A note nothing can lift is the gap in this flag, and it is worth knowing before
you trust its output: inside `prt:log`, inside a block's `<!-- prt:… -->`
header, inside a block whose sentinel or terminator is broken, or inside a block
of an unknown kind, `--promote` cannot lift it. It says so — one
`NOT PROMOTED` line per note, carrying the same remedy the `!` row carries —
rather than printing `no un-promoted @ai notes` over a file that has one, which
is what it used to do while `prt validate` went on refusing that same file over
that same note. The all-clear is now printed only over a file the scanner finds
none in, so `prt ask`, `--promote` and `prt validate` agree.

`--tidy` files the other end of the lifecycle: every note that has a terminal
answer moves, with its answers, as one verbatim slice, into the
`## Resolved notes` log at the end of the file, under one line naming the id,
the derived state, the `did:` verb, the generation, and the first sentence of
the answer's last paragraph. Without it a pair is filed one generation later,
when `prt draft` next regenerates — too late to be the answer to "I have
answered it, now move it". Pairs it cannot move losslessly are left alone and
each says why. Running it twice is a byte-for-byte no-op.

It reconciles in both directions, because the section is bytes while the state
above it is derived on every read. So the same run also **takes a pair back**:
delete an answer and the note reopens, and `--tidy` moves the pair out of the
section to beside its target and drops the line that called it handled; edit an
answer to a different disposition and the line above it is re-derived in place;
and a section left with nothing under it loses its heading, unless what is left
is a paragraph you typed. Each of those prints its id too.

Both are opt-in, because both rewrite a file the human is editing, and both
archive the old file to `history/` first — only when there is something to
write, so a run over every tracked PR does not bury the copies that matter.
`--promote --tidy` is one write and one archive. They refuse on a file the
submitter may be reading (`ready`, `queued`, `partial`).

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

A nudge overwrites whatever draft was there, so it carries that file's notes
across — open ones under `## Notes to the assistant`, resolved ones into
`## Resolved notes`, same split as `draft`. A PR whose `review.md` holds an
`@ai` note that would not survive the rewrite is **skipped** with the reason
printed — same gate as `draft`: a reminder can wait, a retyped note cannot.

### `prt job add|list|next|commit|done|fail|cancel|release`

The background review queue. A job is one PR's worth of model work — `review`,
`re-review` or `revise` — recorded on that PR's `pr.json`, so the queue is
simply "every tracked PR carrying a job" and archiving one takes its job with
it. Ordering is `(priority, queuedAt)`: `--priority now` (what the human just
asked for) runs ahead of `--priority batch` (the default).

```
job add <N>… --kind K [--priority now|batch] [--instructions "…"] [--tier T] [--since <sha>]
job list [--json]                       # the queue and its owner. Read-only.
job next [--max N] [--force]            # own, reap, start up to N, print them with tokens
job commit <N> --token T --from <file>  # the only way a worker writes review.md
job done <N> --token T [--outcome "…"]
job fail <N> --token T --error "…"
job cancel <N>… | --all [--force]
job release [--force]
```

**One session drains a repository at a time**, recorded in `drain.owner` beside
`BOARD.md`:

| Holder | Outcome |
|---|---|
| The same session | Ours; the lease is touched and work continues. |
| Another session whose process is gone | Taken over at once, and its running jobs are reaped. |
| Another session, alive, idle > 30 min | Taken over — a wedged session must not block recovery forever. |
| Another session, alive and working | Refused, naming it. `job release --force` takes it anyway. |

Only *starting* work needs ownership. `job add`, `job list` and every other read
work from any session, so a second session can queue and watch but not run —
which is the accident the rule exists to prevent, and nothing more.

Every mutation happens inside a short `jobs.lock` mutex, so two `job next` calls
in one session cannot select the same job. `job next` reaps in the same breath:
a `running` job owned by another session can only mean that session died, so it
is requeued — unless it had already written its file, in which case it is
*recovered* rather than retried. Re-running that would regenerate a draft for
nothing, or re-apply a revision to bytes it already revised.

`job commit` and `draft --job-token` re-check two things at the moment of
writing: that the token is still the current attempt, and that line 1 is not
protected. Checking either when the job started would be checking it a network
round trip too early. See
[the design](../../../../docs/superpowers/specs/2026-08-28-prt-async-review-jobs-design.md).

## Posting

### `validate [<N>…]`

Parses the action file, plans the actions, and checks every anchor against the
live diff, which it fetches from GitHub. Never contacts GitHub for writes.

**`✗` and exit 1 mean `prt submit` will refuse this file.** Every check here is
one of its refusals, and they are not a second implementation: parse errors come
from the same parser, the four content refusals from the same
`contentRefusals()`, and `on-anchor-fail` is read the way the submitter reads it,
so a `demote`/`drop` comment whose anchor is gone warns rather than fails the
verdict.

**`✓` and exit 0 do not promise the reverse.** They mean nothing in the *bytes*
stops the post. What is left is live state, read at submit time — the PR still
open, the head unmoved, no unsubmitted review of yours, the threads where the
draft left them — plus the two questions about *when* rather than *what*:
`Status:` has to read `ready`, and there has to be something left to post.

The four content refusals, printed as `refuses:` lines:

| refusal | cleared by |
|---|---|
| a security disclosure in outgoing text | `security-reviewed: yes` in `prt:doc` |
| an open note of yours (`●`, including one whose question you rewrote) | answering it, `blocking: no`, or `closed: yes` |
| pipeline mechanics in outgoing text | `tooling-reviewed: <labels>` in `prt:doc` |
| outgoing text quoting a private note back | `ask-quote-reviewed: yes` in `prt:doc` |

Each prints the same sentence the submit-time refusal prints, hatch included, so
clearing one never requires tripping a submit first. See
[action-file.md](action-file.md#the-pipeline-mechanics-lint).

An `edited` note that is `blocking: no` is the one member of that family
`prt submit` does not refuse, so it prints as a `warning:` and leaves the verdict
alone — named, but not counted as something that stops a post.

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

A `prt:pr-actions` block adds two actions on the PR itself, run after everything
that posts text and then set back to `false`: `update-branch` (GitHub's **Update
branch**, sent with `expected_head_sha` so a moved head updates nothing) and
`trigger-ci` (**Approve workflows to run** without approving the PR). Both in
one round update the branch first, then wait up to `workflowApprovalWaitSeconds`
for the new head's runs to appear and approve those. See
[action-file.md](action-file.md#prtpr-actions--acting-on-the-pull-request-itself).

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

### `archive <N>... [--reason "why"]` · `archive [--list]` · `unarchive <N>...`

`cleanup` archives what GitHub has settled; `archive` archives what you have.
Use it for the PR you have decided not to review, or not to review now: the
directory moves to the same `_archive/<owner>/<repo>/pr-<N>/`, with its draft,
notes and cache intact, and `--reason` is recorded in `ARCHIVED.txt` beside it.

Archiving is how you say *not this one*, so `latest` skips archived numbers as
well as tracked ones — an ignored PR is not ranked back onto the board tomorrow.
The board stops listing it and carries a one-line count of what is in the archive.

It refuses exactly what `cleanup` refuses: `ready` (an approval that was never
posted) and `queued`/`partial` (a transaction is open). Set the file to `hold`
first if you really mean to put an armed review away.

`archive` with no numbers — or `--list` — reports what is in the archive, with
each PR's title and the marker line saying when and why it went there.
`unarchive <N>...` (alias `restore`) moves one back into the live tree. It never
overwrites a PR that is being tracked again; remove the live directory first if
the archived copy is the one you want. What comes back is as stale as the day it
left, so `prt refresh <N>` after it.

### `status <N> [<new status>]` · `doctor`

`status` reads line 1, and can set `draft`, `hold` or `skip`. It refuses to set
`ready` — that is your approval signature, so you write it in the file — and it
refuses every status the submitter owns. Setting a status also backfills a
missing `prt:pr-actions` block, as `sync` does. `doctor` prints the resolved
repo, reviewer, editor, GraphQL budget, and how many PRs are tracked per repo.

## Environment

- `PRT_ROOT` overrides the store root (default `~/.claude/pr-review-track`).
- `PRT_DEBUG=1` prints stack traces.
- Auth comes from `gh`; the token needs the `repo` scope to post reviews and
  `read:org` for member lookups.
