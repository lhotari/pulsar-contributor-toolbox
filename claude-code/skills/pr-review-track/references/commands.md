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

### `latest [--limit 10] [--pool 120] [--include-drafts]`

Ranks open PRs the reviewer has **not** engaged with (not the author, not
tracked, no review or comment by them). Prints the score and the reasons behind
it, so the ordering is auditable.

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

`board` regenerates and prints `BOARD.md`, grouped into attention buckets:

- `action-needed-from-me` — the author replied, a thread was resolved with no
  code change behind it, new commits since my review, or a file needs submitting
- `waiting-for-author` — my points are still open and untouched
- `ready-to-approve` — every thread I opened has a code change behind it
- `ci-blocking` — red CI; the author still has work
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

### `open [<N>…]`

Opens the action files in the configured editor (`code -r` by default). With no
numbers, opens everything in `draft`, `blocked`, `error`, or `partial`.

## Posting

### `validate [<N>…]`

Parses the action file, plans the actions, and checks every anchor against the
live diff. Never contacts GitHub for writes. Exit code 1 if anything is wrong.

### `submit <N>… | --all-ready`

Runs the transaction for files whose line 1 says `ready` (also resumes `queued`
and `partial`). See `action-file.md` for the protocol.

### `watch [--interval 20] [--quiesce 3] [--once] [--all-repos]`

Polls the tracking tree and submits files as they become `ready`. Polling, not
filesystem events, because editors save through temp-file replacement and a
missed event means a review silently never posts.

A file must be unchanged for `--quiesce` seconds before it is acted on. Each
submission prints one line — those become chat notifications when the watcher
runs under the `Monitor` tool.

### `recover <N>`

Resumes an interrupted transaction. Verifies against GitHub by exact body match
before retrying, so a crash between "posted" and "recorded" cannot double-post.

## Housekeeping

### `cleanup [--purge] [--dry-run]`

Archives the tracking directory of every closed or merged PR to
`_archive/<owner>/<repo>/pr-<N>/`. `--purge` deletes instead. A PR whose action
file is `queued` or `partial` is kept back and reported — reconcile it first.

### `status <N> [<new status>]` · `doctor`

`status` reads or sets line 1. `doctor` prints the resolved repo, reviewer,
editor, GraphQL budget, and how many PRs are tracked per repo.

## Environment

- `PRT_ROOT` overrides the store root (default `~/.claude/pr-review-track`).
- `PRT_DEBUG=1` prints stack traces.
- Auth comes from `gh`; the token needs the `repo` scope to post reviews and
  `read:org` for member lookups.
