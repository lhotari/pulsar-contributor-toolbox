---
name: pr-review-track
description: Keep up with pull requests in a GitHub project (especially apache/pulsar) across many PRs and many rounds. Tracks every in-progress review under ~/.claude/pr-review-track, detects whether the author actually addressed earlier feedback, and drafts the reply, inline comments and review resolution into a markdown file the human edits and arms before anything is posted. Use for "re-review", "show latest PRs", "review latest", "revisit/revise a draft review", "what needs my attention", "cleanup closed PRs", or any request to manage a backlog of PR reviews. Invokes the pr-review skill to do the actual reviewing.
argument-hint: |
  re-review [N...] | show-latest | approved | review-latest [--limit 10] | revisit-draft [N] [instructions] | ask [N] | sync | board | submit | watch | cleanup | open [N...]
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

**Decide the tier once per session, then stop asking.** Reviewing ten PRs is the
most expensive thing this skill does, and the `pr-review` pipeline scales itself
to what is left:

```bash
BUDGET=~/.claude/skills/pr-review/scripts/budget.mjs
[ -f "$BUDGET" ] || BUDGET=~/workspace-pulsar/pulsar-contributor-toolbox/claude-code/skills/pr-review/scripts/budget.mjs
node "$BUDGET" --json    # cached 30 min
```

The reading is cached at a resolution of **30 minutes** and reports its own age
(`cached`, `cacheAgeMs`); a stale-by-minutes estimate picks the same tier, so
take it. Run this **once**, at the start of the session's first batch, and reuse
the answer for everything that follows — including later batches within the same
sitting. Do not re-run it per PR, per round, or per `re-review`. Re-measure only
when the session has been running long enough that the cache has expired anyway
*and* a lot has been spent since, or when the user asks.

Pass the tier straight through to every `/pr-review` call (`--tier <tier>`).
That both keeps the batch at one consistent depth and stops each PR re-deriving
the tier — `pr-review` skips the budget script entirely when it is given one.
Tell the user which tier the batch ran at, and at `lean` or `codex` say plainly
that each PR got one independent reviewer rather than two.

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
4. **Never let a generator overwrite a protected file** (`ready`/`queued`/
   `partial`/`hold`/`skip`). `prt draft` refuses by default — use
   `--to review.next.md`. Do not reach for `--force` to get past it: `--force`
   also overrides `ready` and `hold`, which are the human's decisions.
   Hand-revising a `draft` or `hold` file *because the human asked you to* is a
   different act and is allowed — see [Revisit draft](#revisit-draft).
5. **Answer every open note before you hand the file back.** A `prt:ask` block —
   or an `@ai` line — is the human talking to *you*. Answer it with a
   `prt:answer` block carrying a real justification; never edit their words, and
   never mark one addressed without saying what you did. An open blocking note
   refuses the submit, so leaving one unanswered silently costs them a round.
   See [Notes to the assistant](#notes-to-the-assistant).
6. **Evidence, not vibes.** A thread GitHub reports as resolved with no code
   change behind it is a finding, not a closure — and a thread marked
   `resolved-but-unverified` means nobody has looked yet, so do not report it as
   addressed. Neither is `isOutdated` evidence on its own: a rebase marks threads
   outdated without anyone touching the code they point at. Every assessment
   carries checkable evidence: SHAs, file:line, test names.
7. **Security stays private.** Never draft text that discloses a vulnerability or
   the security nature of a change in a public PR (`SECURITY.md`). The submitter
   lints for this and blocks.
8. The ASF requires a **human is accountable** for every review posted. This
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
| "which reviews did I start and not finish", "my unfinished drafts" | `node "$PRT" board` — the `reviews in progress` section links each `review.md` |
| "cleanup closed or merged", "cleanup" | [Cleanup](#cleanup) |
| "submit", "post the ready ones" | `node "$PRT" submit --all-ready` |
| "watch", or any batch of drafts | [Arm the watcher](#arm-the-watcher) |
| `revisit-draft <N> [instructions]`, "revisit the draft", "make the comments more concise", "revise #26424" | [Revisit draft](#revisit-draft) |
| "answer my notes", "I left you comments in the file", "address the asks on #26424" | [Notes to the assistant](#notes-to-the-assistant) |
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
   node "$PRT" context <N> > ctx.json      # analysis + delta + anchors + my open notes
   ```

   **First, read `ctx.json.asks`.** Any entry with `open: true` is the human
   asking you something about the draft you are about to replace — answer it
   before anything else, per [Notes to the assistant](#notes-to-the-assistant).
   A note saying "drop this comment" changes what the round should contain, so
   acting on it first saves re-doing the work.

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

## Revisit draft

```
revisit-draft <N> [instructions]
```

Refine a draft that already exists, **in place**, without regenerating it. Reach
for this when the human says "make the comments more concise", "drop the severity
prefixes", "add the test case", "soften the tone", or just "revisit the draft for
#26424". The instructions are free text — apply them to the existing prose.

If no PR number is given and exactly one draft is open, use that one; otherwise
list the candidates and ask which.

The distinction that matters: `prt draft` *regenerates* the file from
`findings.json` and would discard every judgement call already baked into the
prose — the adjudication, the wording, the human's own edits. Revisiting *edits
the bytes that are there*. Never reach for the generator to satisfy a revision
request.

### What may be revised

| Status | Revise? |
|---|---|
| `draft`, `hold` | Yes — this is the editing state. |
| `blocked`, `error` | Yes — revising is part of the recovery path. |
| `submitted` | Only to prepare a *new* round — prefer a fresh `prt draft` for that. |
| `ready` | **No.** Ask the human to set it back to `hold` first. |
| `queued`, `partial` | **No.** A submission is in flight — `prt recover <N>` first. |
| `skip` | Ask first. The human dropped this PR. |

`ready` is refused for a mechanical reason, not a ceremonial one: the watcher can
pick the file up between your read and your write, and then the human's signature
sits on bytes nobody approved.

### Procedure

1. Read the file and check line 1 before touching anything. Run
   `node "$PRT" ask <N>` — if the human left notes, those *are* the revision
   instructions, and each one needs a `prt:answer`, not just a silent edit.
2. Back it up beside the draft, timestamped:
   `cp review.md "cache/review.$(date +%Y%m%dT%H%M%S).md"`.
   Do **not** write into `history/` — the submitter owns that directory.
3. Edit in place. Never modify line 1, and never modify anything inside
   `prt:doc`: the head SHA and diff fingerprint are what the submitter
   pre-flights against, so a stale one must fail loudly rather than be tidied up.
4. `node "$PRT" validate <N> --repo <owner/repo>` — expect no errors and no
   warnings, and check the action count still matches what you intended.
5. Report what changed, and what you deliberately left alone.

### What to preserve

Revision is about wording and emphasis. It must not quietly change the review.

- Keep every load-bearing fact: SHAs, `file:line`, test names, measured numbers,
  reproduction steps. Concision comes out of hedging and restatement, never out
  of evidence.
- Do not add a finding no reviewer verified, and do not drop one to make the
  review shorter. If a point should go, move it to `prt:notes` with the reason
  rather than deleting it.
- Do not change `event:` in `prt:verdict` unless the human asked. Never write
  `APPROVE` (invariant 3).
- Keep tooling attribution out of anything that posts. Model names belong in
  `prt:context` and the italic per-comment lines, which stay local — not in a
  comment body that lands on a public PR. Revision passes are a common place for
  this to leak, because the prose gets reshuffled.
- **Flag the drift.** The file is now ahead of `cache/findings.json`. Harmless
  while the status is `draft`/`hold`, but a later `prt draft` regenerates from
  the stale findings and silently loses the revision. Say so in your report, and
  update `findings.json` too when the change is substantive enough to be worth
  carrying into the next round.

### Attaching artefacts

Reviews often reference something bulky — a suggested test, a stack trace, a
benchmark table. Put it in a collapsed block so the comment stays skimmable:

```markdown
<details>
<summary><code>SomeSuggestedTest.java</code></summary>

...fenced code here...

</details>
```

Files an earlier round staged under `cache/` (`cache/suggested-test-*.java` and
friends) exist to be inlined this way. Keep ASF licence headers intact on
anything the author is meant to paste into the repo — RAT fails without them.

## Notes to the assistant

The human answers a draft *in the draft*. A `prt:ask` block — or a bare `@ai`
line they typed while reading — is a question, an objection, or an instruction
addressed to you. It is never posted, it survives regeneration, and it stays
open across rounds until you answer it.

**Discover them.** They arrive in two places, so a subagent cannot miss them:

```bash
node "$PRT" ask <N>            # or --json; ● blocking, ○ non-blocking, ✓ closed
node "$PRT" context <N>        # the same notes in the `asks` array
```

Run `node "$PRT" ask <N> --promote` first if the human typed `@ai` shorthand and
has not run `prt draft` since — an un-promoted note is a parse error, so the
file will not submit until it is promoted.

`prt validate <N>` reports notes the parser could see but not collect: an `@ai`
line inside a block, or a mistyped block kind like `prt:note`. Both are errors,
so treat either as an instruction you have not read yet, not as noise.

**Answer them.** Append a sibling block; never open theirs.

```
<!-- prt:answer
to: a6
disposition: addressed
did: drop-inline i3
in: g5
-->
Dropped it. You are right that the upstream null check makes the branch
unreachable — I had only checked the callers in this file.
<!-- /prt -->
```

- `addressed` — you did what was asked. `declined` — you looked and disagree;
  say why, with evidence, and expect a `follows:` note back. `deferred` — real
  work for a later round; the note stays open.
- **A body is mandatory** for `addressed` and `declined`. This is enforced, not
  encouraged: a disposition with nothing to show for it will not parse.
- `did: drop-inline i3` is cross-checked. Set `post: false` and
  `dropped-by: a6` on that inline in the same edit, or the file will not parse.
- **Also move the finding to `dropped[]` in `cache/findings.json`** with the
  reason. The file edit alone is a trap: the next `prt draft` regenerates from
  the findings and the comment you dropped comes back.

**Never** edit the human's words, set `closed:`, or answer a note by deleting
it. `closed: yes` is them withdrawing their own question — the same class of act
as `Status: ready` and `event: APPROVE`.

**Never quote a note back into the review.** It is theirs, written to you, about
the PR author. The submitter blocks a twelve-word verbatim overlap, but that is
a backstop, not a licence to write up to eleven.

When you report back, say what you answered, what you declined and why, and what
is still open.

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

- `blocked` because a note is open → the human armed the file with a question of
  their own still unanswered. Answer it (a `prt:answer` block), then tell them it
  is ready to re-arm. Do not clear the block by setting `blocking: no` or
  `closed: yes` — both are theirs.
- `blocked` otherwise → read the reasons in the file's activity log. Usually the head
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
