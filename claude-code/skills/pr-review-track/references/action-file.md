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
- `prt:doc` and `prt:verdict` are attribute-only: the opening sentinel is the
  whole block, no `<!-- /prt -->`.
- Every block that produces a post needs a unique `id:`.
- A one-line form works when there are no fields: `<!-- prt:body -->`.

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

One opt-in acknowledgement also lives here:

- `security-reviewed: yes` — required if the outgoing text trips the security
  lint (see below).

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

`REPLY` is a deliberately incomplete pass. It posts reply bodies from
`prt:thread` blocks only. It does not create or submit a review, does not post
the review body or new inline findings, does not resolve or unresolve threads,
and does not post `prt:issue-comment` blocks. This lets you send file-thread
replies, edit them in GitHub's UI if needed, and complete the review later with
`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. Before arming that later pass,
disable or remove thread replies already posted so they are not posted twice.

`NONE` means "post no review at all" — use it when the file only replies to or
resolves threads, or posts ordinary conversation comments. With `NONE`, delete the review-body text and set
`post: false` on every inline comment; anything left over is a parse error
rather than a silent omission.

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

### `prt:body` — the review's summary comment

```
<!-- prt:body -->
Markdown posted as the top comment of the review.
<!-- /prt -->
```

Empty body + no inline comments + `event: COMMENT` is an error — GitHub would
create an empty review. Use `event: NONE` instead.

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
  comment of the thread, not a reply.
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
-->
this one's wrong — the null check is upstream, drop it
<!-- /prt -->
```

| field | values | who writes it | notes |
|---|---|---|---|
| `id` | `a<n>`, unique for the life of the PR | `prt` | assigned by promotion; a retired id is never reissued |
| `re` | a block `id` · `verdict` · `body` · `general` · `gone` | you, maintained by `prt` | defaults to `general` |
| `blocking` | `yes` / `no` | you | **defaults to `yes`** — see below |
| `closed` | `yes` / `no` | **you only** | withdraw your own question |
| `follows` | an earlier ask id | you | chains a follow-up when an answer did not satisfy |
| `raised` | `g<N>` | `prt` | the generation you wrote it in |
| `was` | `path:line` | `prt` | only on an orphan (`re: gone`) |

**The shorthand.** Typing four lines while reading a draft is friction you will
not pay at 23:00, so type this instead, at column 0, anywhere *outside* a block:

```
@ai i3 — drop this, the null check upstream makes it unreachable
@ai verdict — COMMENT is too soft. Two reviewers disagreed on the wrap-around case.
@ai follows a5 — still not convinced; the clamp moved, it did not go away.
```

A note runs to the next blank line. A leading `i3` / `verdict` / `body` /
`general` / `follows aN` binds it; otherwise it binds to the **nearest preceding
block**, and the promotion prints what it inferred so the guess is never silent.
`prt draft` promotes automatically; `prt ask <N> --promote` does it on demand.

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

**`@ai` inside a body that posts is a hard error**, and the text is *not*
stripped: the format promises a body is posted byte for byte, so quietly editing
it would decouple the posted bytes from `outbox/<txId>/approved.md`. To write
about `@ai` as prose, indent it one space — the same escape the format already
teaches for sentinels.

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
| `did` | `drop-inline <id>` · `edit-inline <id>` · `edit-thread <id>` · `edit-body` · `edit-verdict` · `answer-only` · `none` | `drop-inline` is cross-checked |
| `in` | `g<N>` | the generation it was answered in |

An answer carries no `id:` — it is not postable, so it must not claim a slot in
the id namespace.

**Two guards make the model's claim honest.** A body is mandatory for
`addressed` and `declined`, so it cannot mark its own homework done without
showing the work. And `did: drop-inline i3` is checked against the file: if `i3`
is absent, or still says `post: true`, the file will not parse. The model can
write a wrong paragraph; it cannot write one that contradicts the file's state.

**State is derived, never stored.** A stored `state:` field and an answer body
are two facts that can disagree — "addressed" with nothing to show for it.
Deriving makes that unrepresentable:

```
closed: yes                        -> withdrawn
a terminal answer (addressed|declined) -> that disposition
a deferred answer                  -> deferred (still open)
otherwise                          -> open
```

There is no reopen transition. Unsatisfied by an answer? Write a new note with
`follows: aN` — the chain stays linear and auditable. (Deleting the answer block
also reopens it, precisely because the state is derived.)

### An open note refuses the submit

`Status: ready` means **every question I raised is closed**. An open note with
`blocking: yes` — the default — is a preflight reason: the file goes to
`blocked`, nothing is posted, and the reason names the note.

The escape is one field: `blocking: no` for "just something to remember next
round", or `closed: yes` to withdraw the question.

This lives in `preflight()`, deliberately not in the parser. An open note is the
*normal* state of a draft being worked on, so as a parse error it would make
every mid-round `prt validate` fail — and the revisit loop depends on that
signal staying clean.

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

### Notes and hashes

`payloadHash` excludes notes entirely, so annotating a file does **not**
invalidate a payload that was already approved. `contentHash` includes them,
because writing one *is* a human edit.

### `prt:context` / `prt:notes` / `prt:log`

Never posted. `context` holds the generated evidence, `notes` holds dropped
findings, `log` is the append-only activity record the submitter writes.

## What happens when you set `Status: ready`

1. **Capture** — the file is read twice and the two reads must be identical, so a
   half-saved editor buffer can never be captured. The exact bytes are copied to
   `outbox/<txId>/approved.md` and journalled in `outbox/<txId>/tx.json`. Status
   becomes `queued`; from here your edits no longer affect this run.
2. **Preflight** — every precondition is re-checked against live GitHub:
   - PR still open; the event is legal (you cannot approve your own PR)
   - head SHA, base ref, and diff fingerprint all unchanged
   - no unsubmitted (PENDING) review of yours sitting on the PR
   - every inline anchor still exists in the diff
   - every thread precondition still holds
   - no open blocking `prt:ask` note is left unanswered
   - the security lint (below), and the ask-quote lint

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
not a disclosure, add `security-reviewed: yes` to the `prt:doc` block.

Disable with `"securityLint": false` in `config.json` — but consider why first.

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
  "requireExplicitApprove": true,
  "cleanupMode": "archive"
}
```

`requireExplicitApprove` keeps the generator from ever writing `event: APPROVE`
on its own — it downgrades its recommendation to `COMMENT` and tells you what it
would have recommended. Approving stays something you type; setting the file to
`Status: ready` then authorises the verdict and the workflow together.
