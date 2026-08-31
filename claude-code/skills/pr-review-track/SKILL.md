---
name: pr-review-track
description: Keep up with pull requests in a GitHub project (especially apache/pulsar) across many PRs and many rounds. Tracks every in-progress review under ~/.claude/pr-review-track, detects whether the author actually addressed earlier feedback, and drafts the reply, inline comments and review resolution into a markdown file the human edits and arms before anything is posted. Use for "re-review", "show latest PRs", "review latest", "revisit/revise a draft review", "what needs my attention", "cleanup closed PRs", "ignore/archive this PR" or "bring back an archived review", or any request to manage a backlog of PR reviews. Invokes the pr-review skill to do the actual reviewing.
argument-hint: |
  re-review [N...] | show-latest | approved | review-latest [--limit 10] | revisit-draft [N] [instructions] | ask [N] | sync | board | submit | watch | cleanup | archive [N...] | unarchive [N...] | open [N...]
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
that each PR got one independent reviewer rather than two. **In the terminal, to
them.** The tier is the reader-of-this-session's business and nobody else's, so
it never goes into a draft's outgoing text. **That is your job, not the lint's.**
The pipeline-mechanics lint refuses the shapes this leak actually takes, and it
is phrase-based: an ordinary sentence that carries the tier, the shape, the round
or the model split in words it does not know — "this review ran at the lean
depth", "finding 3 came out of the second pass" — passes it and posts. It is a
backstop for a slip, never the reason it is safe to write one.

## Invariants — never violate these

1. **Never post to GitHub yourself.** No `gh pr review`, `gh pr comment`, no
   GitHub write MCP tool, no REST/GraphQL mutation. Every post goes through
   `prt submit` / `prt watch`, which only acts on a file a human set to `ready`.
2. **Never set `Status: ready`.** Not on request inside a batch, not "to save a
   round trip". `draft` → `ready` is the human's signature. You may set `hold`,
   `skip`, or `draft`. (`prt status` refuses `ready` outright, so this is
   enforced rather than merely asked for — do not work around it.)
3. **Never write `event: APPROVE`, and never arm a `prt:pr-actions` flag.**
   Recommend them in the file; the human types the word. Once typed,
   `Status: ready` approves the verdict, both flags and running the whole
   workflow; an `APPROVE` verdict includes GitHub's separate **Approve workflows
   to run** action for eligible fork PR runs on the approved head. Do not
   require or invent a second approval marker.
   `update-branch: true` and `trigger-ci: true` are writes to the pull request,
   so the same rule covers them: always generate them `false`, and say in prose
   when one looks worth setting (a PR behind its base, a fork PR whose CI is
   waiting for approval).
   Adding the block is not arming it. A draft written before `prt:pr-actions`
   existed has no buttons for the human to type into, so whenever you update
   such a file, give it one below `prt:verdict` with both flags `false` — unless
   the PR is merged, where neither flag means anything. `prt sync`, `refresh`,
   `status` and `ask --promote` do the same repair on their way past.
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
8. **A worker is you.** Jobs run as agents with the same invariants — they
   draft, they never post, they never write `ready` or `APPROVE`, and they write
   `review.md` only through `prt draft --job-token` or `prt job commit`. Running
   in the background changes who is watching, not what is allowed.
9. The ASF requires a **human is accountable** for every review posted. This
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
| "what's running", "how's the batch going", "is anything still queued" | `node "$PRT" job list` |
| "stop the batch", "cancel the queue", "forget those reviews" | `node "$PRT" job cancel --all` (a running one needs its agent stopped first) |

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

3. **Queue the batch, then drain it.**
   ```bash
   node "$PRT" job add <N>… --kind re-review --tier <batch tier>
   node "$PRT" job next --max 4
   ```
   `job next` prints one entry per job to start, each with its `token`. Spawn one
   agent per entry — never more than it handed you — and **end your turn**, so
   the human has the prompt back while the batch runs. See
   [The job queue](#the-job-queue) for the loop and the worker's contract.

   Each worker does, for its own PR:

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
   - draft the reply the reviewer would send, **linking the code it turns on**
     rather than naming it — see [Linking to code](#linking-to-code)

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

   …then records its own outcome with `job done`, per the worker contract.

4. **Report each PR as its agent lands**, one line: number, what the author did,
   the recommended resolution, and the file path. Refill the freed slot with
   `job next` and end the turn again.

5. **When the queue is empty**, open the batch and arm the watcher (below).
   Nothing has been posted.

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
4. Queue them and drain:
   ```bash
   node "$PRT" job add <N>… --kind review --tier <batch tier>
   node "$PRT" job next --max 4
   ```
   Each worker invokes the **`pr-review` skill**
   (`/pr-review <N> --out <prdir>/cache --tier <batch tier>`), converts its
   findings to `cache/findings.json`, and writes the draft with
   `node "$PRT" draft <N> --findings cache/findings.json --kind initial --job-token <token>`.

   `maxConcurrentJobs` (default 4) is the ceiling, and `job next` already applied
   it — spawn what it handed you and no more. At `lean`/`codex` the limit that
   bites first is Codex's, not Claude's.
5. Report each as it lands; when the queue is empty, arm the watcher.

If `pr-review` degrades (Codex unavailable, no worktree, diff-only), say so per
PR — a thinner review must never be presented as a full consensus one. To the
user, in your report; the draft's own record is the `**Draft produced by:**`
line `prt:context` carries, which never posts.

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

**A revision is a `now`-priority job**, so it takes the next free slot ahead of
any batch already queued:

```bash
node "$PRT" job add <N> --kind revise --priority now --instructions "<their words>"
node "$PRT" job next --max 1
```

The worker follows the procedure below, and then — this part is not optional —
writes the edited bytes to `cache/revise-<token>.md` and commits them with
`node "$PRT" job commit <N> --token <token> --from <that file>`. It never writes
`review.md` itself. The commit re-checks, under the queue lock and at the moment
of writing, that the token is still the current attempt and that line 1 is not
`ready`: that is what stops a superseded worker, or one whose file the human
armed while it was thinking, from overwriting a decision.

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
3. Edit the bytes you read. Never modify line 1, and never modify anything
   inside `prt:doc`: the head SHA and diff fingerprint are what the submitter
   pre-flights against, so a stale one must fail loudly rather than be tidied up.
   Working as a job, write the result to `cache/revise-<token>.md` and commit it
   with `job commit`; the file itself is prt's to write.
4. If the file has no `prt:pr-actions` block and the PR is not merged, add one
   directly below the `prt:verdict` block — the human cannot arm a button that
   is not in the file:

   ```markdown
   ## Pull request actions

   <!-- prt:pr-actions
   update-branch: false
   trigger-ci: false
   -->
   ```

   Both flags `false`, always (invariant 3). Say in your report that you added
   it, and mention when one looks worth setting.
5. `node "$PRT" validate <N> --repo <owner/repo>` — expect `✓` and exit 0. `✗`
   means `prt submit` would refuse this file, and every `error:` and `refuses:`
   line under it is one of the reasons it would. `✓` means nothing in the bytes
   stops the post — not that the post will succeed, since the PR's live state is
   re-read at submit time. A `refuses:` line naming an open note of the human's
   is yours to answer, not to clear. Check the action count still matches what
   you intended.
6. Report what changed, and what you deliberately left alone.

### What to preserve

Revision is about wording and emphasis. It must not quietly change the review.

- Keep every load-bearing fact: SHAs, `file:line`, test names, measured numbers,
  reproduction steps. Concision comes out of hedging and restatement, never out
  of evidence.
- **A permalink stops rendering the moment it stops owning its paragraph.**
  Tightening prose is exactly how a URL ends up at the end of a sentence or
  inside a bullet, where GitHub shows a bare link instead of the code. If a
  revision pulls one in, switch it to the inline
  ``[`File.java:192-206`](…)`` form on purpose — see
  [Linking to code](#linking-to-code). A reference you *add* while revising is
  not linked for you either: the generator links what it generates, and this is
  an edit. Build it with `prt permalink`.
- Do not add a finding no reviewer verified, and do not drop one to make the
  review shorter. If a point should go, move it to `prt:notes` with the reason
  rather than deleting it.
- Do not change `event:` in `prt:verdict` unless the human asked. Never write
  `APPROVE` (invariant 3).
- **Never redraft what is already staged.** If the file has an *Already staged on
  GitHub* section, those comments live in an unsubmitted review and the human may
  have rewritten them there — that copy is the authoritative one. Do not turn one
  into a `prt:inline` block, do not "improve" the quoted text, and do not raise
  the same point again: the file cannot change them, and a duplicate would sit in
  the same review beside the original. See
  [action-file.md](references/action-file.md#prtverdict--the-review-resolution).
- Keep the pipeline's internal mechanics out of anything that posts: the tier,
  the effort, round numbers, internal roles (adjudicator, validator, refutation
  pass), the shape ("two-model", "single-reviewer"), and which pass raised a
  finding. Those belong in `prt:context` and the italic per-comment lines, which
  stay local. Saying that AI assisted, and naming the models, is **not** in that
  set — that is a deliberate disclosure the human makes on purpose, and it posts.
  Revision passes are a common place for the mechanics to leak, because the prose
  gets reshuffled. The **pipeline-mechanics lint** catches it over exactly the
  text that will post: `prt validate` fails the file in the round that wrote it
  (as a `refuses:` line, since the file parses but will not post), and `prt
  submit` refuses with the same sentence. Clearing a hit takes `tooling-reviewed: <labels>` in
  `prt:doc`, which only the human may write — so a leak you introduce costs them
  the round.
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

## Linking to code

A review that says `Consumer.java:1015` sends the reader off to find it. A review
that links it shows them the code. GitHub expands a **blob permalink that owns
its own paragraph** into the lines it points at, so a short reference arrives as
the code itself:

```
https://github.com/apache/pulsar/blob/39784e085ef491ffe319433dc465ba9575cadc95/pulsar-client-v5/src/main/java/org/apache/pulsar/client/impl/v5/ScalableConsumerClient.java#L192-L206
```

That is `ScalableConsumerClient.java:192-206`, rendered in the comment. Never
assemble one by hand:

```bash
node "$PRT" permalink <N> <path>:192-206              # the bare URL, paste-ready
node "$PRT" permalink <N> <path>:192-206 --markdown   # [`File.java:192-206`](…)
```

### What `prt draft` links for you

**A reference you merely *name* in `findings.json` prose is linked on the way
into the file.** `prt draft` rewrites every one it can resolve into the inline
form, at the head it drafted against, before you or the human sees the draft:

| you write | it becomes |
|---|---|
| `Consumer.java:1015` | ``[`Consumer.java:1015`](…/Consumer.java#L1015)`` |
| `service/Consumer.java:1015-1022` | the same, from the unique path ending in that tail |
| `:749-755` | ``[`:749-755`](…#L749-L755)`` **in the file that comment is anchored to** |
| `` `Consumer.java:1015` `` | the same link, keeping the code span as the label |

The name is resolved against the PR's own files first, then the repo tree at
that commit — so the caller, the test or the definition your comment points at
links even when the PR does not touch it. What is **never** touched: anything in
a fenced block or a stack frame (`at …(Consumer.java:1015)` — those line numbers
are from the build that threw), a code span with more than a reference in it, a
reference already inside a link, a port or a version (`localhost:8080`), and a
bare URL, so a rendered snippet you placed on purpose stays rendered. A name
that matches no single file — two `Consumer.java`, or one that is not in the
repo — is left as the words you wrote and named in `prt draft`'s output; write
the repo-relative path when it matters.

So: **name the location naturally in prose and let the draft link it**; reach
for `prt permalink` when you want the *rendered* form, which is a judgement only
you can make (see the table below), or when you are revising a file that already
exists — a revision edits bytes rather than generating them, and nothing links
them for you.

### The mechanics

- The URL is `https://github.com/<owner>/<repo>/blob/<commit>/<repo-relative path>#L<start>-L<end>`, or `#L<n>` for one line.
- **Always an exact commit.** Never `blob/master/…`, never a branch or a tag: the
  lines behind a moving ref drift, and the link starts quoting code the review
  never read. For anything in the PR that commit is the head — `head:` in
  `prt:doc`, `findings.head`, `ctx.analysis.headOid`. `prt permalink` refuses a
  ref name outright.
- **The upstream repo, even for a fork PR.** `apache/pulsar/blob/<head sha>/…`
  resolves for a contributor's commit, and unlike their fork it cannot be deleted
  out from under the comment.
- **To render, the URL must own its paragraph**: blank line above, blank line
  below, nothing else on the line — no bullet, no `>`, no trailing full stop, and
  not wrapped in `[…](…)`. With any of those GitHub leaves a bare link.
- The line numbers are the ones *at that commit*. A `LEFT`-side anchor counts
  lines in the base, not the head: link the base commit, or do not link it.

### Which form, and when

| form | use it when |
|---|---|
| **Rendered** — the bare URL alone in its own paragraph | the code *is* the point and it is short (roughly ≤ 20 lines): the lines a finding is about, the invariant a caller breaks, the version the author replaced |
| **Inline** — ``[`ScalableConsumerClient.java:192-206`](…)`` | the reference supports the sentence rather than being it, the range is long, or it sits in a list, a table or a blockquote, where nothing expands anyway |

Judgement, not decoration:

- **An inline comment is already anchored.** GitHub shows its lines directly
  above it, so opening one with a permalink to those same lines is noise. Link
  the *other* place — the caller, the definition, the test, the line the
  invariant is established on.
- **One rendered snippet per point.** A comment that opens with three embedded
  files is harder to read than the `file:line` it replaced.
- A long range, a whole file, generated code: link it, do not embed it.
- **Never link lines you have not read at that commit.** A permalink is a
  quotation and one click checks it, so a wrong range quotes the author code
  they did not write.
- A link sits *on top of* the evidence, never instead of it: the `file:line`,
  the test name, the failure scenario and the SHA all stay in the prose.

### In `review.md` itself

The same rule for the reader who is you and the human. `prt draft` already links
what it renders — each thread's anchor, each finding's location, each file
changed since the last review — at the head it drafted against, and falls back to
plain `path:line` exactly where a link would be wrong (a `LEFT` anchor, a thread
GitHub marked outdated).

Your own prose in the file works the same way: when a point needs more code than
a line or two — the whole method, the caller and the callee, the version before
and after — link it rather than pasting it in. A draft nobody can skim is a draft
the human re-reads three times before arming. Evidence lists and tables cannot
expand a snippet, so those take the inline form.

## Notes to the assistant

The human answers a draft *in the draft*. A `prt:ask` block — or a bare `@ai`
line they typed while reading — is a question, an objection, or an instruction
addressed to you. It is never posted, it survives regeneration, and it stays
open across rounds until you answer it.

**Where a note can be: anywhere in the file.** In the gaps between blocks, and
equally *inside* one — mid-`prt:body`, under an inline comment, in a thread
reply, under an answer you already wrote, in a block's `<!-- prt:… -->` header,
even in a block whose sentinel is half-typed or whose kind is a typo — carrying
whatever decoration the surrounding prose had (`*@ai …`, `> @ai …`, `- @ai …`,
`+ @ai …`, `1. @ai …`, `1) @ai …`, indented). One rule reads all of them, so the
same keystrokes mean the same thing everywhere. The single exception is the
opening line of a `prt:ask` body, where the `prt:ask` around it *is* the
promotion and the words are already the question. An in-block note never reaches
GitHub, because it is a hard parse error and never a silent strip. It is still an
instruction written to you, and reading only the gaps is exactly how one goes
unread.

Every `@ai` line you type is **named**: wherever it sits, it is a parse error, so
`prt validate` exits 1 and nothing submits past it, and `node "$PRT" ask <N>`
lists it with a `!` from the moment it is typed, followed by the one edit that
actually fixes that note. To write *about* the token instead of leaving a note,
put it in backticks — `` `@ai` `` — anywhere in the file. That is the only
escape; indenting is decoration and still reads as a note.

The one line that is not a new note is the one already exempted above — a
`prt:ask`'s own question — and **rewriting it there is not silent either**, by a
different mechanism: the ask carries a `q:` stamp of the words it was created
with, so a question that no longer matches reopens, `prt ask` shows it as
`edited`, and `prt submit` refuses. Three shapes are outside that, and it is
worth knowing which: a note the human withdrew with `closed: yes` (their own
act outranks a later edit), one marked `blocking: no` (`prt ask` and
`prt validate` name it, nothing stops the post — which is what that field
means), and an ask written before the stamp existed, which has no `q:` to
compare against and so keeps deriving from its answer. Only asks this tool
created carry the stamp; the pre-stamp ones retire within a round or two.

**Discover them.** Two commands, and only the first sees a note that is still
shorthand:

```bash
node "$PRT" ask <N>            # ● blocking, ○ non-blocking, ✓ closed, ! not promoted yet
node "$PRT" context <N>        # the `asks` array — prt:ask blocks ONLY, no shorthand
```

So run `prt ask` before trusting `prt context` to be the whole of what the human
said. Then `node "$PRT" ask <N> --promote` whenever they typed shorthand and
have not run `prt draft` since: a note in a gap is promoted in place, one inside
a block is **lifted** out of it and re-emitted after that block's terminator,
and every promotion prints the block it came from. One lifted out of a `prt:ask`
or `prt:answer` gets `follows:` set to the pair it was written under, which is
what reopens that conversation. A note it cannot lift safely — one butted
straight up against prose — is left exactly where it is and reported by line and
reason: **move the note and everything that belongs to it out of the block into
a gap**, where a note runs to the end of its paragraph. Do not answer that
refusal with a blank line unless the line below is the review's own text — a
blank fences the note at its first line, so `@ai please:` over two bullets lifts
`please:` and posts the bullets. On an armed file the remedy also names the
precondition: `--promote` will not rewrite a `ready` file.

Some notes nothing lifts: inside `prt:log`, inside a block's `<!-- prt:… -->`
header, inside a block whose sentinel or terminator is broken, inside a block of
an unknown kind. `--promote` cannot help with any of them and does not claim to:
it prints a `NOT PROMOTED` line per note, carrying the same remedy the `!` row
carries, and keeps `no un-promoted @ai notes` for a file that really has none.
`prt draft` and `prt nudge` refuse to regenerate over one at all, naming the
line, because carry-over moves `prt:ask` blocks and nothing else. Fix what the
row names and it promotes like any other.

`prt validate <N>` reports the same notes with the same remedies, plus what the
parser could see but not collect at all — a mistyped block kind like `prt:note`.
All of it is errors, so treat any of it as an instruction you have not read yet,
not as noise.

**A note listed as `edited` is one they typed over.** Rewriting the question in
place is how a maintainer escalates when your answer missed — the words are right
there, so they type over them. `prt` records the question it promoted as `q:`, so
it can see that happen: the note reopens and refuses the submit even though an
`addressed` answer is still sitting under it. Run `prt ask <N> --promote` to
accept the new wording, read the NEW question, and answer it with a fresh
`prt:answer` block. Do not delete or reword the old answer, and never write or
edit `q:` or `re-q:` yourself — they are `prt`'s record of what `prt` wrote, and
changing one is claiming to have answered something you did not.

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
  Stamp the answer `in: g<N>` while you are there: that is what dates the claim,
  and without it the check keeps applying in later rounds, where the comment is
  legitimately gone and the answer stops parsing.
- **Also move the finding to `dropped[]` in `cache/findings.json`** with the
  reason. The file edit alone is a trap: the next `prt draft` regenerates from
  the findings and the comment you dropped comes back.

**Never** edit the human's words, set `closed:`, or answer a note by deleting
it. `closed: yes` is them withdrawing their own question — the same class of act
as `Status: ready` and `event: APPROVE`.

**Filing an answered note is not deleting it.** Once a note has a terminal
answer it is no longer live work, so it moves — with its answer, verbatim, as
one slice — to a `## Resolved notes` log at the end of the file, under one line
saying how it was handled. `prt draft` does that on the next regeneration and
`node "$PRT" ask <N> --tidy` does it in the round you answered in. It is a move
and only a move: the words are untouched, `prt ask` still lists the note, and
deleting the answer reopens it and blocks the submit again, because the state is
derived on every read rather than stored. The handling line and the pair's
position *are* stored — written when it was filed — so both writers re-derive
them: `prt draft` re-renders, and `--tidy` now reads the section on every run,
rewriting a line that no longer derives and taking a reopened pair back out
beside its target. A line the human has appended their own words to is left
alone, because it still starts with what the state derives to. Between their
edit and the next of those two commands the section reads as it was last
written, so `prt ask <N>` is the truth.

**Never quote a note back into the review.** It is theirs, written to you, about
the PR author. The submitter blocks a twelve-word verbatim overlap, but that is
a backstop, not a licence to write up to eleven.

Answering a note is an edit to `review.md`, so the rest of the revision rules
apply too — including giving a file drafted before `prt:pr-actions` that block
(step 4 of [the revision procedure](#procedure)).

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

## The job queue

Per-PR work runs as background jobs so the terminal stays the human's. The queue
is on disk, so it survives this session ending; the workers do not, and are
restarted from it.

**Every routed request starts with a drain.** Before anything else:

```bash
node "$PRT" job next --max 4
```

That call is also the only thing that resumes queued work. Nothing in `prt` runs
on a timer, so a session that never invokes this skill never touches the queue —
which is the point: other sessions are free to do unrelated work.

**One session drains a repository at a time.** If `job next` says another session
owns the queue, do not force it. Tell the human which session has it and let them
choose. A crashed owner is taken over automatically; so is one that has done
nothing for 30 minutes.

**The loop.** Spawn one agent per entry `job next` handed you, then **end the
turn**. When an agent completes: print one line for that PR, run `job next` again
to fill the freed slot, spawn, end the turn. When the queue is empty, give the
batch summary and arm the watcher.

**Every worker's prompt carries** the PR number, the repo, the tier, the payload,
its `token`, and this contract:

> Do the work for this kind of job. Write `review.md` **only** through
> `prt draft <N> --job-token <token>` or
> `prt job commit <N> --token <token> --from <file>` — never by editing it.
> Refer to code with permalinks built by `prt permalink <N> <path>:<lines>`,
> per the skill's *Linking to code*: short and central, the bare URL alone in
> its own paragraph so GitHub renders it; otherwise the inline `--markdown`
> form. Never a branch URL, never a range you have not read at that commit.
> Finish with `prt job done <N> --token <token> --outcome "<one line>"`, or
> `prt job fail <N> --token <token> --error "<why>"` if you could not.
> Return at most five lines: number, what happened, the recommended resolution,
> and the path to the file. Everything substantial goes on disk, not in the
> reply.

**If an agent finishes and its job is still `running`,** it died without
recording anything. Record it yourself with `job fail`, and say so in the report:
reaping only catches a dead *session*, and silently losing a job is the failure
this queue exists to prevent.

**A `failed` job stays failed** until a human says otherwise — `job add` again is
that decision, and it resets the attempt count. Two attempts is the cap; a third
would spend the budget again on a failure that repeats.

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

### Setting one aside

When the user decides a PR is not theirs to review, or not now, archive it
rather than leaving a half-written draft on the board:

```bash
node "$PRT" archive <N> --reason "why"   # unfinished review out of the way
node "$PRT" archive --list               # what is in there
node "$PRT" unarchive <N>                # bring it back, then `prt refresh <N>`
```

`latest` skips archived PRs, so this is also how "ignore this one" is expressed
— never by deleting a directory. It is refused on a `ready` or in-flight file;
if the user means to put an armed review away, they set it to `hold` first.
Archiving is the user's decision to make: propose it, do not do it unasked.

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
