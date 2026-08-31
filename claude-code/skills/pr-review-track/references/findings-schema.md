# `findings.json` — the contract between a review run and a draft

`prt draft <N> --findings findings.json` turns a review's output into an action
file. This is the only interface between the reasoning half of the workflow (a
model reading code) and the mechanical half (the file the human edits).

Write it to `$PRT_ROOT/<owner>/<repo>/pr-<N>/cache/findings.json`.

```json
{
  "schema": 1,
  "repo": "apache/pulsar",
  "pr": 26289,
  "head": "e2467d03493d57f271db7cfb7deee7ecd9dc2597",
  "kind": "re-review",
  "reviewers": ["Claude Fable", "Codex gpt-5.6-sol", "Opus (adjudicated)"],
  "coverage": "full-repo",

  "summary": "Markdown for the review's top comment. May be empty.",
  "recommendedEvent": "REQUEST_CHANGES",
  "recommendedEventWhy": "two of the three points I raised are still open",

  "findings": [
    {
      "id": "i1",
      "severity": "BUG",
      "claim": "permits are lost when the consumer is removed mid-flow",
      "path": "pulsar-broker/src/main/java/org/apache/pulsar/broker/service/Consumer.java",
      "line": 1015,
      "endLine": null,
      "side": "RIGHT",
      "subject": "line",
      "body": "Markdown posted as the inline comment. Evidence + failure scenario.",
      "confidence": "high",
      "agreement": "both reviewers",
      "crossValidation": "confirmed by both",
      "post": true
    }
  ],

  "dropped": [
    { "claim": "…", "reason": "refuted: the null check upstream makes it unreachable" }
  ],

  "threadAssessments": [
    {
      "threadId": "PRRT_kwDOA7PXtM6ZzmFh",
      "assessment": "LIKELY_ADDRESSED",
      "why": "the clamp was removed and a regression test with three queued Flow(MAX_VALUE) updates was added",
      "evidence": [
        "commit e2467d03 removes Math.max at Consumer.java:989",
        "SharedDispatcherPermitAccountingTest adds testWrapAroundIsPreserved",
        "the author replied describing exactly this change"
      ],
      "reply": "Markdown reply to post in the thread, or null.",
      "resolve": false
    }
  ],

  "issueCommentAssessments": [
    {
      "url": "https://github.com/apache/pulsar/pull/26289#issuecomment-123",
      "assessment": "RESPONSE_NEEDED",
      "why": "the PR author asked whether the reviewer still requires the compatibility test",
      "reply": "Yes, please keep that test because …"
    }
  ]
}
```

## Field notes

**`recommendedEvent`** — `APPROVE`, `REQUEST_CHANGES`, `COMMENT`, or `NONE`. With
`requireExplicitApprove` on (the default), a recommendation of `APPROVE` is shown
to the human but the file is written with `event: COMMENT`.

**`findings[].path` / `line` / `side`** must land on a line the PR's diff allows a
comment on. `prt anchors <N>` prints those; `prt context <N>` includes them per
file as `commentableRight` / `commentableLeft`. A finding whose anchor does not
validate is written with `post: false` and an explanation, so the human sees the
finding and can re-aim it rather than losing it.

**`findings[].body`** is posted verbatim. Put the claim in the body as a bold
first line — the generator does that automatically from `severity` + `claim`, so
do not repeat it.

**Refer to code with permalinks, not with names.** `head` is the commit every
link in this file is built against; `prt permalink <N> <path>:<start>-<end>`
builds them. A short, central reference goes in as the **bare URL alone in its
own paragraph** — `\n\nhttps://…#L192-L206\n\n` inside the body string — which is
what makes GitHub render the code in the comment; anything longer, or anything
inside a bullet or a table, takes the inline ``[`File.java:192-206`](…)`` form,
which never expands. Not the lines the comment is already anchored to: GitHub
shows those above it. The rules and the judgement behind them are in the skill's
[Linking to code](../SKILL.md#linking-to-code).

**`summary` and `findings[].body` are the only two fields that reach the pull
request**, and neither may describe how the review was produced: no tier, no
effort, no round numbers, no internal roles (adjudicator, validator, refutation
pass), no shape (`two-model`, `single-reviewer`), no "raised by the second pass".
Those facts have their own fields and their own destination — `reviewers` and
`coverage` render as the `**Draft produced by:**` line inside `prt:context`, and
`confidence`, `agreement` and `crossValidation` render as an italic line above
the inline comment. Neither is ever posted. `tier` is read by nothing the
generator renders; it is here for the human's terminal report and for the record.
Writing the mechanics into `summary` or a `body` instead trips the
pipeline-mechanics lint and costs the human a round — see
[action-file.md](action-file.md#the-pipeline-mechanics-lint). Disclosing that AI
assisted, or naming the models, is not in that set and posts freely.

**`threadAssessments[].assessment`** — describe what the evidence supports, not
what you hope:

| value | use when |
|---|---|
| `LIKELY_ADDRESSED` | the code change plausibly does what I asked |
| `PARTIALLY_ADDRESSED` | some of the point was handled, some was not |
| `NOT_ADDRESSED` | no change, or a change that misses the point |
| `RESPONSE_NEEDED` | the author asked me something |
| `OBSOLETE` | the code the comment was about is gone |
| `NEEDS_HUMAN_VERIFICATION` | I cannot tell from the diff alone |

**`threadAssessments[].evidence`** — concrete and checkable: commit SHAs, file and
line numbers, test names, a paraphrase of what the author said. A thread that
GitHub reports as resolved but has no code change behind it is a finding, not a
closure. These render as a bullet list in `review.md`, where nothing expands, so
a location here takes the inline ``[`Consumer.java:989`](…)`` form — the human
reading the draft can then check the claim in one click instead of opening the
file. `threadAssessments[].reply` posts, so it follows the body rules above.

Only threads with a `reply` or `resolve: true` are written as `post: true`;
everything else lands as `post: false` context so the human can arm it manually.

**`issueCommentAssessments[]`** covers ordinary PR conversation comments from
`analysis.newIssueComments`. Include an entry whenever the PR author asks a
question or otherwise needs a reviewer response. Match the source comment by
its `url`; a non-empty `reply` becomes a gated `prt:issue-comment`. These replies
post with `APPROVE`, `REQUEST_CHANGES`, `COMMENT`, or `NONE`, but are deferred by
the file-thread-only `REPLY` event.
