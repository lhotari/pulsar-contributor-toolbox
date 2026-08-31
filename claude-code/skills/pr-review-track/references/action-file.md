# The action file (`review.md`)

One file per tracked PR. It is the **only** thing that decides what gets posted to
GitHub, and a human is the only thing that arms it.

Location: `$PRT_ROOT/<owner>/<repo>/pr-<N>/review.md`
(`PRT_ROOT` defaults to `~/.claude/pr-review-track`.)

## The gate

**Line 1 is always `Status: <value>`.** Nothing else in the file changes what the
tooling is allowed to do.

| Status | Meaning | Who sets it |
|---|---|---|
| `draft` | Prepared by the model; the human is editing. Never posted. | generator |
| `ready` | **Human authorisation.** The submitter may capture and post it. | human |
| `queued` | An immutable snapshot was captured. Further edits do not affect this run. | submitter |
| `partial` | Some approved actions posted, some did not — or a pending review is waiting on you. Needs reconciliation. | submitter |
| `submitted` | Every approved action verified on GitHub. | submitter |
| `blocked` | A pre-flight check refused it. **Nothing was posted.** Reason is in the activity log. | submitter |
| `error` | Posting failed before anything was posted. | submitter |
| `hold` | Parked by the human. `sync` / `re-review` will not regenerate over it. | human |
| `skip` | The human decided not to review this PR. `cleanup` may archive it. | human |

`skip` parks a PR in the live tree, where it stays visible in the `parked`
bucket and `cleanup` picks it up once GitHub closes it. To get it off the board
entirely and out of `latest`, `prt archive <N>` moves the whole directory to
`_archive` — reversibly, with `prt unarchive <N>`.

`ready`, `queued`, `partial`, `hold`, `skip` are **protected**: a generator
refuses to overwrite the file. Use `prt draft <N> --to review.next.md` to
produce a proposal alongside it instead.

*Generator* is the operative word. A human asking for the draft to be reworded,
tightened, or extended is not a regeneration: the `revisit-draft` workflow in the
skill edits `draft` and `hold` files in place for exactly that, backing the file
up under `cache/` first. `ready`, `queued` and `partial` stay off-limits even
then — the first because `watch` may capture it mid-edit and post bytes the human
never signed, the other two because a submission is already in flight.

`submitted` is deliberately *not* protected — the approved bytes and the posted
URLs already live in `history/` and `outbox/`, so the next round's draft has
nothing to destroy. Protecting it would make `--force` part of every re-review
round, and `--force` also overrides `ready` and `hold`.

**Only you can write `ready`.** `prt status <N> ready` refuses; open the file and
change line 1. That is not politeness — it is the gate, enforced by the tool
rather than by an agent's good manners. `prt status` also refuses every status
the submitter owns (`queued`, `submitted`, `partial`, `blocked`, `error`).

## Block syntax

Only content inside a sentinel block is ever posted. Everything else — headings,
tables, quoted context, your own scribbles — is for you.

```
<!-- prt:KIND
key: value
key: value
-->
free-form markdown body
<!-- /prt -->
```

Rules:

- A sentinel counts **only at column 0**. To write one literally inside a body,
  indent it by one space.
- The body is taken byte for byte. It may contain `##` headings, `---`, fenced
  code, YAML, or HTML comments of its own. It is never trimmed, reflowed, or
  prefixed before posting. The one exception: a BOM is stripped and CRLF is
  normalised to LF, because a stray `\r` inside a ```suggestion block corrupts
  the code GitHub offers to apply.
- Booleans are strict. `post: ture` is an error, not a silent `false` — a typo
  must stop the run rather than quietly drop a comment you armed.
- `prt:doc`, `prt:verdict` and `prt:pr-actions` are attribute-only: the opening
  sentinel is the whole block, no `<!-- /prt -->`.
- Every block that produces a post needs a unique `id:`.
- A one-line form works when there are no fields: `<!-- prt:context -->`. A
  `prt:body` written that way still parses — its one field, `post:`, defaults to
  `true` — but a generated one spells the field out.

### Block kinds

Three things about a kind matter, and they are not the same three: whether its
body reaches GitHub, whether it has a body at all, and what happens to an `@ai`
note typed inside it.

| kind | reaches GitHub | shape | an `@ai` note typed in its body |
|---|---|---|---|
| `body` `inline` `thread` `issue-comment` | **yes**, byte for byte | body | error — it would post; `prt ask <N> --promote` lifts it out |
| `context` `notes` | never | body | error — collected by nothing; lifted out the same way |
| `log` | never | body | error, but **not** lifted: the submitter owns those bytes, so move it yourself |
| `ask` `answer` | never | body | not scanned — this is where a note is meant to end up |
| `doc` | never | attribute-only | no body to type in |
| `verdict` `pr-actions` | no text of their own; they set the review event and the PR-level actions | attribute-only | no body to type in |

The last column is about **bodies**. Every kind's `<!-- prt:… -->` **header** is
scanned as well, `doc`'s, `verdict`'s and `ask`'s included, because
`parseSentinelFields` keeps `key: value` lines and silently drops the rest — so a
note typed up there would be thrown away by the file itself. It is an error in
every kind and lifted in none: a splice inside a sentinel is how a block loses
its `id:`. Move it below the `-->`.

Everything outside every block is a **gap**: headings, tables, quoted context,
your scribbles. `tokenize` discards gaps, which is what makes "a note never
leaks" structural rather than a promise — and it is where a promoted note lands.

### `prt:doc` — what this draft was generated against

```
<!-- prt:doc
schema: 1
repo: apache/pulsar
pr: 26289
kind: re-review
generation: 3
generated: 2026-08-21T13:57:12Z
reviewer: lhotari
head: e2467d03493d57f271db7cfb7deee7ecd9dc2597
base-ref: master
diff-fingerprint: sha256:e7cb8ae2f30ee930224d155d
reviewed-at: f102ddfabb4f741eba60181d1b91f6ee91cbd5e4
-->
```

These are **preconditions**, re-checked against live GitHub immediately before
posting. If the head moved, the PR was retargeted, or the effective diff changed,
the submitter blocks instead of posting into a document that no longer exists.

Three opt-in acknowledgements also live here. Only a human writes one — the
model is forbidden to touch `prt:doc` at all:

- `security-reviewed: yes` — required if the outgoing text trips the security
  lint (see below).
- `ask-quote-reviewed: yes` — required if outgoing text repeats a private
  `prt:ask` note verbatim (see below).
- `tooling-reviewed: <labels>` — required if it trips the pipeline-mechanics
  lint (see below). Unlike the two above it has to name the hits it excuses; a
  bare `yes` is refused.

**These survive `prt draft` regenerating the file, and nothing else in
`prt:doc` does.** They are the only keys carried over from the previous
generation; every line above them is re-measured, because four of them are the
preconditions the submitter re-checks against live GitHub and a carried one
would be checked against itself. An acknowledgement is re-earned rather than
inherited, so it travels only as far as the text it excused:

- `tooling-reviewed` carries label by label. `tier, consensus` over a draft that
  still trips only `tier` comes back as `tooling-reviewed: tier`. It can shrink
  and it can never grow.
- The two blanket `yes` hatches excuse the whole file, so they carry only when
  their lint still fires *and* every outgoing passage in the new draft is
  byte-for-byte one you already read. Any new or reworded body, inline comment
  or thread reply drops them and you are asked again.

`prt draft` prints every acknowledgement it kept and every one it dropped, with
the reason. `--no-carry` drops them along with the notes, and `prt nudge` carries
none of them — a reminder replaces the outgoing text with generated boilerplate,
so every acknowledgement would have nothing left to excuse anyway.

### `prt:verdict` — the review resolution

```
<!-- prt:verdict
event: COMMENT
-->
```

`APPROVE` · `REQUEST_CHANGES` · `COMMENT` · `REPLY` · `NONE`.

`APPROVE` submits the approving PR review and then approves every workflow run
on the same PR head that GitHub reports as `action_required` (the UI's
**Approve workflows to run** action). If there are no eligible runs, that step
is a successful no-op. Both mutations are journalled under the same transaction;
if workflow approval fails after the review lands, the file becomes `partial`
and `prt recover` safely re-queries and resumes the remaining runs.

`REPLY` **stages**. It writes into a PENDING review — GitHub's *Start a review*,
where every comment is visible to nobody but you — and never submits it. So the
pass publishes nothing: the author sees a staged comment only when a later
verdict submits the review.

What it stages is comments: replies into threads you already own (`prt:thread`)
and new threads from `prt:inline`, line, range or whole-file alike. What it
cannot stage is anything GitHub has no draft state for — resolving a thread, a
`prt:issue-comment`, and the review body, which belongs to the submit that
completes the review. Those wait for a later verdict, with the approved file as
the record; `prt validate` names them rather than letting you find out from the
activity log.

**A staged reply is addressed by the thread's node id**, so `reply-to:` is not
required under `REPLY` — it is the immediate path's argument, the REST id of the
thread's first comment.

Then the review is yours to edit **on GitHub**. That is the point of the mode:
open the pending review, rewrite a comment, delete one, add one, and what is
there is what the round says. From that moment the file no longer holds the
authoritative text, and prt treats it that way:

- `prt draft` reads the pending review and shows its comments under
  **Already staged on GitHub** — a `prt:context` block, never posted, never
  regenerated as `prt:inline`. A drafted copy would be an older version of a
  comment that already exists, and arming it would put it in the review twice.
- The next `event: REPLY` pass adds to the same review. GitHub allows one
  pending review per person per pull request, so there is never a second.
- Any other verdict **submits that review**: its comments as they now stand on
  GitHub, the `prt:body` in this file as the review body, plus any new inline
  comments the file has picked up since. Nothing already staged is re-sent.
- A pending review prt did not stage still blocks a submit, exactly as before.
  Submitting one would publish text nobody here has read.

If you submit or discard the review in GitHub's UI instead, nothing is left
behind: the next command notices it is no longer pending and forgets it.

`NONE` means "post no review at all" — use it when the file only replies to or
resolves threads, or posts ordinary conversation comments. With `NONE`, set
`post: false` on the review body and on every inline comment; anything left over
is a parse error rather than a silent omission. Deleting the summary text works
too, but `post: false` keeps the draft you just read.

**The verdict block is mandatory whenever there is anything to review.** Deleting
it does not mean "no event" — a review POST without an event creates an
*unsubmitted* review that only you can see and that then blocks every later
submit on the PR. The parser refuses, and so does the submitter.

### `prt:pr-actions` — acting on the pull request itself

```
<!-- prt:pr-actions
update-branch: false
trigger-ci: false
-->
```

Two things a maintainer does from the PR page rather than from a review. They
run when you set line 1 to `ready`, after everything that posts text, and each
is set back to `false` once it has actually landed.

| flag | what it does |
|---|---|
| `update-branch` | Merges the base branch into the PR, as GitHub's **Update branch** button does. |
| `trigger-ci` | GitHub's **Approve workflows to run** for the runs waiting on this PR. |

The generator always writes `false`, for the same reason it never writes
`APPROVE`: both are writes to the pull request, so the human types the word.
`Status: ready` then authorises the flags along with everything else in the
file — there is no second marker. A misspelled field name and a value that is
neither yes nor no are both parse errors, because a flag that reads as armed and
does nothing cannot be told apart from one that ran and had nothing to do.

`update-branch` sends the head this file was drafted against as
`expected_head_sha`, so a branch that moved after the draft was written updates
nothing and says so. A branch already level with its base is left alone rather
than merged into itself. A merge conflict comes back as a failed action: the
file becomes `partial`, GitHub's message goes in the log, and the flag stays
`true` so `prt recover` retries what you asked for.

`trigger-ci` is the same action `event: APPROVE` already performs, so the two
together still do it once. It exists for letting CI run *without* approving the
PR — a first-time contributor's fork PR, most often.

**Both flags in one round update the branch first, then approve.** The update
replaces the head whose runs would be approved, so the order is not arbitrary:
approving first would approve exactly the runs the update is about to supersede.
Because GitHub moves the head some seconds after accepting the update, and
creates that head's workflow runs some seconds after that, the submitter waits —
re-reading the head and its runs until they appear or
`workflowApprovalWaitSeconds` (default 60) runs out. Finding none is recorded as
"no runs were waiting for approval", not as a failure: a repository that does
not gate this PR's workflows has nothing to approve. That wait is also the one
place `prt watch` will sit on a single PR for up to a minute.

**A file drafted before this block existed is repaired, not left behind.** The
generator is not the only writer: `prt sync`, `prt refresh`, `prt status` and
`prt ask --promote` each add the missing block on their way past, and so does a
model hand-revising the file. It goes directly below `prt:verdict` — after the
verdict's prose and any notes attached to it, above whatever section comes next.

The repair is skipped in exactly four cases: the block is already there
(wherever the human moved it to); there is no verdict, or no complete one, to
hang it under — a nudge file has none; the PR is merged, where there is no
branch left to update and no CI left to release; or line 1 says `ready`,
`queued` or `partial`, which are bytes the human signed or the submitter is
part-way through. Both flags always arrive `false`: the repair puts the buttons
in the file, it never presses them.

### `prt:body` — the review's summary comment

```
<!-- prt:body
post: true
-->
Markdown posted as the top comment of the review.
<!-- /prt -->
```

| field | values | notes |
|---|---|---|
| `post` | `true` / `false` | defaults to `true`; `false` keeps the summary in this file without posting it |

`post: false` is how you hold a summary back without losing it — under
`event: NONE`, or while the review says everything it needs to say in its inline
comments. The text stays where you can read it and reaches nothing that posts:
not the review payload, not the payload hash, not the security or
pipeline-mechanics lints, which each read only what will actually be sent.
Deleting the text does the same thing and costs you the draft, so it is the
weaker of the two.

The flag is a strict boolean like every other one here — `post: fasle` is a
parse error, not a silent `true`. A `prt:body` with no `post:` field at all
still posts, so a file written before the flag existed behaves exactly as it did.

No summary + no inline comments + `event: COMMENT` is an error — GitHub would
create an empty review. Use `event: NONE` instead. That error names `post:
false` when the summary is only being held back, because "there is no review
body" is not what you are looking at.

### `prt:inline` — a line comment

```
<!-- prt:inline
id: i1
post: true
subject: line
path: pulsar-broker/src/main/java/org/apache/pulsar/broker/service/Consumer.java
line: 1015
side: RIGHT
-->
**[BUG] permits are lost when the consumer is removed**

Concrete failure: …
<!-- /prt -->
```

| field | values | notes |
|---|---|---|
| `post` | `true` / `false` | `false` keeps the text as a note without posting it |
| `subject` | `line` · `range` · `file` | `file` comments on the file as a whole, no line — see the note below |
| `path` | repo-relative | must match the path in **this PR's** diff |
| `line` | integer | the **end** line of a range |
| `start-line` | integer | required for `subject: range` |
| `side` | `RIGHT` / `LEFT` | `RIGHT` = added or context line, `LEFT` = removed line |
| `start-side` | `RIGHT` / `LEFT` | defaults to `side` |
| `on-anchor-fail` | `block` (default) · `demote` · `drop` | what to do if the anchor is gone at submit time |

`prt anchors <N>` lists every commentable `(path, line, side)` for the PR.

**`subject: file` costs three requests instead of one.** GitHub's batch review
payload has no `subject_type` field — sending one 422s with *"Field is not
defined on DraftPullRequestReviewComment"* (verified against the live API on
2026-08-21). So a review containing a file-level comment is posted as: create a
PENDING review with the line comments → add each file thread through GraphQL's
`addPullRequestReviewThread` → submit the pending review with the event.

If that sequence breaks partway, a pending review is left on the PR holding text
you already approved. The tool never retries it — retrying would create a second
one. The action file goes to `partial`, the log names the review's URL, and you
submit or discard it on GitHub yourself. Everything else in the file is left
alone. Reviews with only line comments take the single-request path and cannot
land in this state.

**`on-anchor-fail` defaults to `block` on purpose.** If the anchor moves between
drafting and posting, the tool refuses and tells you the nearest valid line — it
does not silently relocate your comment or fold it into the summary. `demote`
and `drop` exist so you can opt into that behaviour per comment, in advance.

### `prt:thread` — reply to / resolve a thread you already own

```
<!-- prt:thread
id: t1
post: true
thread: PRRT_kwDOA7PXtM6ZzmFh
reply-to: 3796616876
resolve: no
expect-resolved: no
expect-last-comment: 3800997515
-->
Reply markdown.
<!-- /prt -->
```

- `thread` — the GraphQL node id (`PRRT_…`). Never edit it.
- `reply-to` — the REST integer id of the thread's **first** comment. Required
  when there is a reply body; GitHub's reply endpoint takes the top-level
  comment of the thread, not a reply. Not required under `event: REPLY`, which
  stages the reply against `thread:` instead.
- `resolve: yes` resolves the thread after the reply lands. `unresolve: yes` is
  the inverse.
- `expect-resolved` / `expect-last-comment` are preconditions the generator
  fills in from the thread as it stood: if someone posted in it after this draft
  was written, the submitter blocks so you re-read before replying into changed
  context.
- A block with no body, no `resolve` and no `unresolve` is a no-op.

### `prt:issue-comment` — a plain PR conversation comment

```
<!-- prt:issue-comment
id: c1
-->
Not a review — a normal comment on the PR conversation.
<!-- /prt -->
```

This is what `prt nudge` produces: a single reminder naming the points an author
has not answered, rather than a reply in each thread, so it costs them one
notification. It is gated exactly like every other action — drafted, edited by
you, and posted only once line 1 says `ready`.

Re-review drafts also use this block to answer questions the PR author asked in
the ordinary PR conversation. Such replies are posted in every verdict mode
except `REPLY`, which is intentionally limited to file review threads.

### Linking to code from any body

Every body in this file — the four that post and the two that do not — refers to
code, and GitHub renders a **blob permalink that owns its own paragraph** as the
code itself:

```
Both callers already hold the lock, so the second acquire is unreachable:

https://github.com/apache/pulsar/blob/39784e085ef491ffe319433dc465ba9575cadc95/pulsar-broker/src/main/java/org/apache/pulsar/broker/service/Consumer.java#L1015-L1022

which makes the branch below dead rather than merely redundant.
```

- Blank line above, blank line below, nothing else on the line. In a bullet, a
  table, a blockquote, or wrapped in `[…](…)`, it stays a bare link — use
  ``[`Consumer.java:1015`](…)`` there instead.
- The commit is exact, and for anything in the PR it is `head:` from `prt:doc`.
  A `blob/master/…` link renders whatever master says on the day it is read.
- The upstream repo, even when the PR comes from a fork.
- `prt permalink <N> <path>:1015-1022` builds it; `--markdown` gives the inline
  form.

A `prt:inline` body is already anchored at its own lines, so link the *other*
place — the caller, the test, the definition. When and why is in the skill's
[Linking to code](../SKILL.md#linking-to-code).

### `prt:ask` — a note to the assistant. Never posted.

Your questions, objections and instructions, addressed to the model rather than
to the PR author. They live in the file, survive regeneration, and carry a
lifecycle across rounds.

```
<!-- prt:ask
id: a6
re: i3
blocking: yes
closed: no
follows: a2
raised: g4
q: sha256:9f1c0b4e2a7d5c8130ee46b2
-->
this one's wrong — the null check is upstream, drop it
<!-- /prt -->
```

| field | values | who writes it | notes |
|---|---|---|---|
| `id` | `a<n>`, unique for the life of the PR | `prt` | assigned by promotion, from a high-water mark kept in the PR's `state.json` — so a retired id is not reissued once the ask itself has left the file |
| `re` | a block `id` · `verdict` · `body` · `general` · `gone` | you, maintained by `prt` | defaults to `general` |
| `blocking` | `yes` / `no` | you | **defaults to `yes`** — see below |
| `closed` | `yes` / `no` | **you only** | withdraw your own question |
| `follows` | an earlier ask id | you | chains a follow-up when an answer did not satisfy |
| `raised` | `g<N>` | `prt` | the generation you wrote it in |
| `was` | `path:line` | `prt` | only on an orphan (`re: gone`) |
| `q` | `sha256:…` | `prt` | the question as promotion wrote it — see *Rewriting a note reopens it* |

**The shorthand.** Typing four lines while reading a draft is friction you will
not pay at 23:00, so type this instead, anywhere in the file:

```
@ai i3 — drop this, the null check upstream makes it unreachable
@ai verdict — COMMENT is too soft. Two reviewers disagreed on the wrap-around case.
@ai follows a5 — still not convinced; the clamp moved, it did not go away.
```

One rule reads a note wherever it sits — gap, block body, or block header, in a
block whose sentinel you have not finished typing, in a block whose kind is a
typo — so the same keystrokes mean the same thing everywhere. Markdown
decoration in front of the token is ignored, because a stray italic marker left
over from the surrounding prose is how the first note that mattered went unread.
The decoration a note may wear is exactly what markdown calls a leader: the
blockquote `>`, the emphasis `*` and `_`, all four bullet markers `-` `*` `+`,
an ordered marker `1.` or `1)`, leading whitespace, and any combination of them
(`> - *@ai …`). What the line may **not** carry before `@ai` is anything else,
and the token must be whole: `@ai-worker`, `@ai.assistant@…` and `@aider` are
handles, not notes.

**Backticks are the escape, everywhere.** To write *about* the token rather than
leave a note, put it in backticks: `` `@ai` ``. Indenting used to work in a gap
and does not any more — one escape that holds in every part of the file beats
two that disagree about the middle of a `prt:body`.

A note runs to the next blank line — or, if you wrote it as a list item (any of
`-` `*` `+` `1.` `1)`), to the next item at the same level, so `- @ai …` inside
a list takes only its own bullet. A leading `i3` / `verdict` / `body` /
`general` / `follows aN` binds it; otherwise it binds to the **nearest preceding
block**, and the promotion prints what it inferred so the guess is never silent.
A `##` heading **in a gap** between that block and the note stops the search at
`general`, because a note under a new heading is not a reaction to whatever came
before it — most of all under `## Resolved notes` at the foot of the file, where
the nearest preceding block would otherwise be hundreds of lines above. A `##`
heading inside a block's *body* is your markdown, not a section boundary, and
does not move the binding.

**Naming a note chains off it rather than targeting it.** `@ai a1 — still not
convinced` is the same thing as `@ai follows a1 — …`, and the same thing a note
typed inside a1's own `prt:ask` or `prt:answer` becomes: `follows: a1`, with
`re:` inherited from a1 so the follow-up sits beside the comment the
conversation is about. An ask is not a comment, so binding `re: a1` would leave
the next `prt draft` unable to find it and orphan the note to `re: gone`.
`prt draft` promotes automatically; `prt ask <N> --promote` does it on demand.
Ids are handed out in **file order**, whether a note was typed in a gap or lifted
out of a block, so the promotion report lists your notes in the order you wrote
them.

The leading token is only *removed* from your text when a punctuation separator
follows it — `@ai i3 — drop this` stores "drop this", while `@ai i3 drop this`
stores the whole line. That asymmetry is deliberate: `general cleanup of the
summary` and `i1 is fine, it is i2 that is wrong` both open with a token that is
also an ordinary word, and eating it would delete a word you wrote. The target
is still read in both cases; only the tidier body needs the dash.

**An un-promoted `@ai` line is an error, not a warning.** A warning is silent in
practice, and a silently swallowed instruction is the worst thing this format
could do. So it reaches both `prt validate` (exit 1) and the submitter, which
refuses. Promoted, or the submit stops — there is no third path.

That is the invariant, and it holds for **every `@ai` line, in every placement**:
named by an error, and never overwritten without a word. It is pinned by a test
that types one into a gap, a posted body, a block's header, `prt:log`, an
unknown block kind, a `prt:ask` body and a `prt:answer` body, and requires all
seven to produce a parse error, an exit-1 `prt validate` and an `!` row. There is
exactly one line it does not cover, and it is the one the next section is about:
a `prt:ask`'s own question, which is not a new note but an old one being
rewritten — a different mechanism, and not a silent one either. See
*Rewriting a note reopens it*.

`prt ask <N>` lists un-promoted notes beside the promoted ones, so a note is
visible from the moment it is typed rather than from the moment it is promoted;
and `prt draft` and `prt nudge` both refuse to regenerate over a note that would
not survive it, naming the line (pass `--no-carry` to drop it deliberately — the
old file is kept in `history/`).

A note somewhere `--promote` can reach is additionally **promoted**, or
**refused** by line and reason on the same run. The places it cannot reach —
`prt:log`, a block's header, a block whose sentinel or terminator is broken, a
block of an unknown kind — get a third line, `NOT PROMOTED`, carrying the same
remedy `prt ask <N>` prints beside the `!` row. `no un-promoted @ai notes` is
printed only over a file the scanner finds none in, so all three commands now
agree about whether a file is clear.

**`@ai` inside a block is still a hard error**, and the text is *not* stripped at
submit time: the format promises a body is posted byte for byte, so quietly
editing it would decouple the posted bytes from `outbox/<txId>/approved.md`. The
remedy is `prt ask <N> --promote`, which **lifts** the note out on disk — it
deletes the note's line from the block and writes a `prt:ask` just after that
block's `<!-- /prt -->`, bound to the block it was typed in. The old file goes to
`history/` first, and you see the edit in the file before you arm it.

A lift takes exactly **one line**, and only when the line below it is blank, an
HTML comment, another note, the sibling list item that ends it, or the end of the
block. In a gap a note may run to the end of its paragraph, which is free because
nothing in a gap is posted; in a body the next line is usually the next sentence
of your review, and there is no way to tell "the rest of my note" from "the rest
of my summary". So a note butted straight up against the line below it is
reported and left where it is. **Move it, and everything that belongs to it, out
of the block into a gap** — a gap note runs to the end of its paragraph, so the
continuation comes with it whichever reading was true. A blank line after the
note works too, but it lifts the note's *first line only* and the rest stays in
the block and posts, so reach for it only when the line below is the review's own
text; and if the line was never a note, put the token in backticks. A note that
is a block's *entire* body is left alone too
whenever emptying that block would change the file rather than shorten it:
emptying a `prt:body` posts a review with no summary at all, an emptied
`prt:ask` parses as a free stub and takes its `id:` with it, and an emptied
`prt:answer` with a terminal disposition stops parsing. Whether the block should
go is your call.

**A note inside a `prt:ask` or `prt:answer` body is lifted like any other, and
binds with `follows:`.** That is the natural place to object to an answer you
have just read, so the words have to go somewhere: the lift writes a new
`prt:ask` after the pair, `follows:` the ask it was written under, which reopens
the conversation the answer had closed. The one line that is *not* read as a new
note is the opening line of a `prt:ask` body — the `prt:ask` around it is the
promotion, so those words were already collected and handed to the model.

That exemption is about the words the **tool** wrote there, and it is not a blind
spot for words you write over them: typing a new question into that line does not
make a second note, it changes the question — and a question that no longer
matches its `q:` reopens the note. See *Rewriting a note reopens it*.

A **bulleted** note is fenced by the next item at its own level, so `- @ai …`
inside a list is lifted and the list closes up around it. A *deeper* item is not
a fence — it can be a child of the note — and a note that is not itself a list
item is not fenced by one either: `@ai please:` followed by two bullets is a note
whose bullets belong to it, and taking only the first line would truncate your
instruction into the review, so that is reported instead. Both are the case the
paragraph above is about: move the note and its continuation out of the block,
rather than fencing it with a blank line and leaving the rest to post.

Four places are never lifted at all, because a splice there would destroy what
the block is for or delete lines that may belong to a different block:

- `prt:log`, the submitter's own append-only record;
- a block's `<!-- prt:… -->` **header**, where `id:` and `post:` live;
- a block missing its `<!-- /prt -->`, or whose sentinel never reaches its
  `-->` — its body runs on to the next sentinel, so its extent is a guess;
- a block whose kind is not one this tool knows (`prt:scratchpad`, `prt:note`).

These are the ones `--promote` cannot lift, and it says so rather than going
quiet: each prints as `NOT PROMOTED`, with the same remedy `prt ask <N>` gives
beside its `!` row. `prt validate` names them by line, and `prt draft` and
`prt nudge` refuse to regenerate over them. Do what the row says — move the note
below the `-->`, close the sentinel, fix the kind — and it is promoted like any
other.

**What a lift leaves behind is one blank line, exactly where the note was.** So
when your note stood at a place that was already a paragraph boundary — blank
above, blank below, or written straight under a paragraph that a blank already
closed — the body comes back byte-identical. When you typed it into the *middle*
of a paragraph, splitting it, the split stays: `A.` `B.` on consecutive lines,
annotated between them, come back with a blank line between them. Whitespace
only, never your prose, and you see it in the file before you arm it — but if
the paragraph mattered, close it back up yourself.

### `prt:answer` — the model's reply. Never posted.

```
<!-- prt:answer
to: a6
disposition: addressed
did: drop-inline i3
in: g5
-->
Dropped it. You are right that the upstream check makes the branch unreachable.
<!-- /prt -->
```

| field | values | notes |
|---|---|---|
| `to` | an ask `id` in this file | must resolve, else error |
| `disposition` | `addressed` · `declined` · `deferred` | strict; a typo is an error, never a silent value |
| `did` | `drop-inline <id>` · `edit-inline <id>` · `edit-thread <id>` · `edit-body` · `edit-verdict` · `answer-only` · `none` | `drop-inline` is cross-checked against the round `in:` names |
| `in` | `g<N>` | the generation it was answered in |
| `re-q` | `sha256:…` | written by `prt` only when the question moves out from under this answer; absent means "the ask's `q:`" |

An answer carries no `id:` — it is not postable, so it must not claim a slot in
the id namespace.

**One terminal answer per question, not per ask.** A second `addressed` or
`declined` for the same wording is an error. A second one for a question that has
since been *rewritten* is not — that is how a reopened note gets closed again.

**Two guards make the model's claim honest.** A body is mandatory for
`addressed` and `declined`, so it cannot mark its own homework done without
showing the work. And `did: drop-inline i3` is checked against the file: if `i3`
still says `post: true` the file will not parse, in any round; and if `i3` is
absent altogether, the file will not parse **in the round the answer was written
in** — `in: g<N>` is what dates it.

That round bound is the whole of the second guard's scope, and it is deliberate.
A dropped finding leaves `findings.json`, so one generation later "there is no
i3" is not a contradiction, it is what dropping i3 *means* — and reading it as an
error there made an honest answer unparseable, which in turn made `prt draft`
refuse (it will not regenerate over notes it cannot read) and left the file with
no exit but `--no-carry` or a falsified `did:`. So the guard bites where a wrong
claim is still a wrong claim: the model cannot write a paragraph that
contradicts the file it is writing into.

**State is derived, never stored.** A stored `state:` field and an answer body
are two facts that can disagree — "addressed" with nothing to show for it.
Deriving makes that unrepresentable:

```
closed: yes                                     -> withdrawn
a LIVE terminal answer (addressed|declined)     -> that disposition
a LIVE deferred answer                          -> deferred (still open)
answers, but none of them live                  -> edited (still open)
otherwise                                       -> open
```

An answer is **live** when it still answers the question the note carries: its
own `re-q:` if it has one, otherwise the ask's `q:`. Neither present — a note
written before those fields existed — is live, so nothing in the store you
already have changes state.

There is no reopen transition you *write*. Unsatisfied by an answer? Write a new
note with `follows: aN` — the chain stays linear and auditable. (Deleting the
answer block also reopens it, precisely because the state is derived.)

### Rewriting a note reopens it

Typing over the question is the other natural way to escalate — the model got it
wrong, the words are right there — so it means what it looks like:

- `prt` records the question at the moment it promotes it, as `q:`. That is the
  one moment it can honestly say "these are the words I wrote".
- Rewrite the question and the answer under it stops being an answer to it. The
  note goes to **`edited`**, which is open: `prt ask` lists it with `●`, and
  both `prt validate` and `prt submit` refuse it. (`blocking: no` demotes that
  to a `warning:` in `validate` and stops nothing, which is what the field
  means — named, not enforced.)
- `prt ask <N> --promote` then accepts the new wording — it moves `q:` forward
  and writes `re-q:` onto the old answer, pinning it to the wording it really
  answered. The note stays open; the old answer stays on the page.
- Answering it again closes it. The new answer needs no `re-q:` of its own.

Regeneration carries all of that: `q:` and `re-q:` are copied, never recomputed,
so a `prt draft` cannot quietly re-close a note you have just reopened.

**The limit.** A note promoted before `q:` existed has no record of its original
wording, so editing it is undetectable and it stays closed. Nothing spuriously
reopens, which is the direction that matters, but the guarantee only covers notes
`prt` created — from this version on, all of them. It follows the QUESTION only:
editing an *answer* body changes nothing, because an answer is the model's record
of what it did rather than a statement of what you asked. To object to an answer,
type a note under it — that is lifted into a new ask with `follows:`.

**Where a note sits is derived from that state too.** Open and deferred notes
stay beside what they are about — a note on `i7` is unjudgeable away from `i7`'s
text. The other three states are past tense, so the pair moves to
`## Resolved notes` at the end (below). Nothing about the move is
stored either: delete the answer and the note is open again, and the next
`prt draft` puts it straight back beside its target.

### An open note refuses the submit

`Status: ready` means **every question I raised is closed**. An open note with
`blocking: yes` — the default — is a preflight reason: the file goes to
`blocked`, nothing is posted, and the reason names the note.

The escape is one field: `blocking: no` for "just something to remember next
round", or `closed: yes` to withdraw the question.

This lives in `contentRefusals()`, which `preflight` and `prt validate` both
run — so the two commands agree about it — and deliberately **not** in the
parser. As a parse error it would also stop `prt draft`, since `carryAsks`
refuses to regenerate over notes it cannot read: the round in which you are
answering your own note would be the round you could not draft.

### Dropping a comment because of a note

Set `post: false` and add `dropped-by: <ask id>` to the `prt:inline` block, and
move the finding to `dropped[]` in `findings.json` with the reason. The file
change alone is a trap: the next `prt draft` regenerates from `findings.json`
and the comment comes back while its note still reads `addressed`.

### The quote lint

The one leak the parser cannot close is the model folding your private note into
outgoing prose during a revision pass. Twelve consecutive words shared between a
`prt:ask` body and any outgoing text — code spans stripped — blocks the
submission. Clear it with `ask-quote-reviewed: yes` in `prt:doc` if the sentence
genuinely belongs in the review; only you can, since the model may not edit
`prt:doc`.

### `## Resolved notes`

The log of notes that are already handled, at the end of the file. A note with a
terminal state — `addressed`, `declined` or `withdrawn` — is no longer live work,
so it moves here with its answers, as **one verbatim slice of the file**: the
question is your bytes and the answer is the model's, and neither is re-rendered
on the way. Above each pair is one derived line — id, state, `did:` verb,
generation, and the first sentence of the answer's **last** paragraph — because
an answer opens with what was changed and closes with what you still have to
weigh, and the closing half is the half that decides whether the pair is worth
opening. It is *derived* — computed from the ask and its answers, never stored as
a field — but it is derived when the pair is filed and written into the file as
ordinary text, so it is bytes from then on.

`prt draft` places them here on every regeneration; `prt ask <N> --tidy` does it
in the round you answered in. `carryAsks` retires a resolved note one generation
later, so the section is bounded to what you have just handled, and the rest is
in `history/`.

**Deleting an answer reopens its note, and the note blocks the submit again** —
that state is derived on every read, so it is always right. The file's furniture
is bytes and follows one step behind, so both writers reconcile it: `prt draft`
re-renders, and `--tidy` reads the section on every run and

- rewrites a handling line that no longer derives — the answer under it changed,
  so a `declined` you rewrote to `addressed` stops standing as `declined`;
- moves a **reopened** pair back out of the section, beside the block it is
  `re:` bound to, dropping the line that called it handled;
- drops the heading and its framing when nothing is left under them — and never
  when a paragraph of yours is.

**Adding your own words to a handling line is safe.** The line is the natural
place to push back on what the model just reported, so a line that *begins* with
what the state derives to now is read as that line plus your sentence: the
derived half is already correct, and nothing is rewritten. Only a line that no
longer derives at all is replaced — and when the replacement takes bytes the
tool did not write, the run says which bytes rather than only naming the state.

All of it is reported by id, like every other move. Between your edit and the
next of those two commands the section still reads as it was last written, so
`prt ask <N>` remains the thing to believe.

It is **not** inside `prt:log`, even though that is literally the log at the end
of the file, and the reasons are mechanical rather than aesthetic. `tokenize`
has no nesting, so a `prt:ask` inside `prt:log` ends the log block at the ask's
own sentinel and the file stops parsing. `appendLog` splices at the first
`<!-- /prt -->` after the log sentinel, which would then be the note's — so the
next submit would write its timestamped line into the middle of your question.
And `contentHash` cuts the file at that sentinel, so a note moved inside it would
drop out of the hash that records "the human edited this draft".

A pair is left where it is, with a printed reason, whenever the move cannot be
proved lossless: prose of yours sitting between the note and its answer, an
unbalanced `<details>` wrapper, or two blocks claiming one id. And nothing moves
at all in a file with an unterminated block, whose spans run into the block
below.

### Notes and hashes

`payloadHash` excludes notes entirely, so annotating a file does **not**
invalidate a payload that was already approved. `contentHash` includes them,
because writing one *is* a human edit — and `## Resolved notes` sits above the
`prt:log` sentinel, which is where `contentHash` stops looking, so filing a note
stays a visible edit rather than a silent one.

### `prt:context` / `prt:notes` / `prt:log`

Never posted. `context` holds the generated evidence, `notes` holds dropped
findings, `log` is the append-only activity record the submitter writes. Its own
`## Activity log` heading lives *inside* that block — the section above is a
different log, and the footer says which is which.

Nothing here reaches GitHub, so nothing here renders a snippet — but it is the
part of the file a human actually reads, so the generator links what it prints:
each thread's anchor, each finding's location and each file changed since the
last review carry an inline permalink at the head this draft was written
against. Where a link would be wrong the plain `path:line` is kept instead — a
`LEFT`-side anchor counts lines in the base, and GitHub nulls an outdated
thread's `line`, so the number recorded is the original one and means nothing at
the head.

## What happens when you set `Status: ready`

1. **Capture** — the file is read twice, 150ms apart, and the two reads must be
   identical, so a buffer still being written is refused rather than captured.
   (It narrows the window; it does not close it — an editor that pauses longer
   than that between two writes can present the same partial file twice. The
   watcher's `quiesceSeconds` is the other half of the same defence.) The exact
   bytes are copied to
   `outbox/<txId>/approved.md` and journalled in `outbox/<txId>/tx.json`. Status
   becomes `queued`; from here your edits no longer affect this run.
2. **Preflight** — every precondition is re-checked against live GitHub:
   - PR still open; the event is legal (you cannot approve your own PR)
   - head SHA, base ref, and diff fingerprint all unchanged
   - no unsubmitted (PENDING) review of yours sitting on the PR
   - every inline anchor still exists in the diff
   - every thread precondition still holds
   - no open blocking `prt:ask` note is left unanswered
   - the security lint and the pipeline-mechanics lint (both below), and the
     ask-quote lint

   Any failure ⇒ `Status: blocked`, reasons appended to the activity log,
   **nothing posted**.
3. **Execute** — actions run one at a time, ≥1.2 s apart, each journalled as
   `calling` *before* the request and reconciled after.
4. **Reconcile** — `submitted` if everything landed, `partial` if some did.

`prt recover <N>` resumes an interrupted run. Before re-running any action it
asks GitHub whether that action already landed, matching on **body *and* the
thread it was addressed to *and* a timestamp at or after this transaction
started** — a body match alone would mistake an older look-alike comment for
this one. An empty body never matches anything, because GitHub creates an
empty-bodied review object for every standalone reply and one of those would
otherwise look like a body-less review of ours.

A failure is only treated as "definitely did not happen" when GitHub answered
with a 4xx. A timeout, a killed process, or a 5xx leaves the action `unknown`,
which means reconcile-then-decide rather than retry — a wrong retry is a
duplicate comment on somebody's pull request.

An action marked `needs-manual-resolution` is never retried at all; the log says
what to finish on GitHub.

## The security lint

Outgoing text matching `CVE-…`, "vulnerability", "exploit", "RCE", "privilege
escalation", "auth bypass", "security flaw" blocks the submission. Apache
Pulsar's rule is absolute: never disclose a vulnerability — or the security
nature of a change — in a public PR (`SECURITY.md`). If the wording is genuinely
not a disclosure, add `security-reviewed: yes` to the `prt:doc` block. It is
carried into the next generation as long as that generation's outgoing text is
text you have already read (see `prt:doc` above).

Disable with `"securityLint": false` in `config.json` — but consider why first.

## The pipeline-mechanics lint

**Disclosing that AI assisted is legal and stays legal.** "I ran an AI-assisted
review of this PR", "a local review with Claude Code", an `Assisted-by:` trailer,
naming which models ran — all of it posts. apache/pulsar's own `AGENTS.md` asks
contributors to *consider* exactly that attribution, under the ASF Generative
Tooling guidance it links. This lint does not touch any of it.

What it refuses is the pipeline's *internal mechanics* leaking out of
`prt:context` into a body: the **tier**, the **effort**, the **round** numbers,
the internal **roles** (adjudicator, validator, refutation pass), the **shape**
(`two-model`, `single-reviewer`), and **which pass raised a finding**. Those are
terms of art from `pr-review`'s own report format; they mean nothing to a Pulsar
reader and imply a rigour ranking nobody asked for.

Nine phrases, and every one of them is contextual — `tier`, `round 2`,
`validator`, `consensus` and `cross-validate` are all ordinary Pulsar vocabulary
(tiered storage, SASL handshake rounds, `*Validator` types, BookKeeper's
consensus, PIP-478's config axes). A hit needs the word standing next to the
pipeline sense of itself: `` Tier `lean` ``, `the round-3 refute pass`, `effort
xhigh`, `not the two-model consensus pipeline`, `the reviewers split on it`.
The measurements behind each are in the `toolingLint` doc comment.

An earlier version had a second arm that blocked *this* PR's own reviewer names.
It is deleted: over 33,945 real apache/pulsar comments it flagged 77, and 71 of
those 77 were deliberate disclosures written by the maintainer himself.

The scan covers exactly what `planActions` will post and nothing else, so its
scope narrows with `event:` — under `REPLY` only the thread bodies are linted,
because only the thread bodies are sent.

`prt validate` refuses over a hit, in the same round that wrote it, printing the
same sentence `prt submit` refuses with. If a hit is genuinely about the code, or you do mean to
describe the pipeline, add `tooling-reviewed: <the labels it printed>` to the
`prt:doc` block. It has to name them: one acknowledged `tier` must not silence an
unrelated `reviewer-split` somewhere else in the same file. Naming them is also
what lets `prt draft` carry the hatch label by label into the next generation,
keeping only the labels that generation still trips (see `prt:doc` above).

Disable with `"toolingLint": false` in `config.json` — but consider why first.

## Configuration

`$PRT_ROOT/config.json`, overridable per repo in `<owner>/<repo>/repo.json`:

```json
{
  "reviewer": null,
  "editorCmd": "code",
  "editorArgs": ["-r"],
  "priorityAuthors": ["merlimat"],
  "nudgeAfterDays": 2,
  "nudgeCooldownDays": 7,
  "nudgeMaxAgeDays": 90,
  "ignoreAuthors": ["dependabot[bot]", "github-actions[bot]", "renovate[bot]"],
  "latestLimit": 10,
  "watchIntervalSeconds": 20,
  "quiesceSeconds": 3,
  "workflowApprovalWaitSeconds": 60,
  "securityLint": true,
  "toolingLint": true,
  "requireExplicitApprove": true,
  "cleanupMode": "archive"
}
```

`requireExplicitApprove` keeps the generator from ever writing `event: APPROVE`
on its own — it downgrades its recommendation to `COMMENT` and tells you what it
would have recommended. Approving stays something you type; setting the file to
`Status: ready` then authorises the verdict and the workflow together.
