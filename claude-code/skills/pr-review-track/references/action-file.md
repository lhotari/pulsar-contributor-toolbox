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
| `superseded` | Replaced by a newer generation; the old copy lives in `history/`. | generator |

`ready`, `queued`, `partial`, `submitted`, `hold`, `skip` are **protected**: a
generator refuses to overwrite the file. Use `prt draft <N> --to review.next.md`
to produce a proposal alongside it instead.

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
  prefixed before posting.
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

Two opt-in acknowledgements also live here:

- `approve-authorised: yes` — required alongside `event: APPROVE`.
- `security-reviewed: yes` — required if the outgoing text trips the security
  lint (see below).

### `prt:verdict` — the review resolution

```
<!-- prt:verdict
event: COMMENT
-->
```

`APPROVE` · `REQUEST_CHANGES` · `COMMENT` · `NONE`.

`NONE` means "post no review at all" — use it when the file only replies to
threads or resolves them. With `NONE`, the review body and every inline comment
must be `post: false`.

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
- `expect-resolved` / `expect-last-comment` are preconditions: if someone posted
  in the thread after this draft was generated, the submitter blocks so you
  re-read before replying into changed context.
- A block with no body, no `resolve` and no `unresolve` is a no-op.

### `prt:issue-comment` — a plain PR conversation comment

```
<!-- prt:issue-comment
id: c1
-->
Not a review — a normal comment on the PR conversation.
<!-- /prt -->
```

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
   - the security lint (below)

   Any failure ⇒ `Status: blocked`, reasons appended to the activity log,
   **nothing posted**.
3. **Execute** — actions run one at a time, ≥1.2 s apart, each journalled as
   `calling` *before* the request and reconciled after.
4. **Reconcile** — `submitted` if everything landed, `partial` if some did.
   `prt recover <N>` resumes a `partial` or interrupted run; it verifies against
   GitHub by exact body match before retrying, so it never double-posts. An
   action marked `needs-manual-resolution` in `tx.json` is never retried at all —
   the log says what to finish on GitHub.

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
  "ignoreAuthors": ["dependabot[bot]", "github-actions[bot]", "renovate[bot]"],
  "latestLimit": 10,
  "watchIntervalSeconds": 20,
  "quiesceSeconds": 3,
  "securityLint": true,
  "requireExplicitApprove": true,
  "cleanupMode": "archive"
}
```

`requireExplicitApprove` keeps the generator from ever writing `event: APPROVE`
on its own — it downgrades its recommendation to `COMMENT` and tells you what it
would have recommended. Approving stays something you type.
