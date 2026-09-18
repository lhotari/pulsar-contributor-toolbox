# Claude review of TARGET at `REVISION`

Status: source-verified review, no tests run. Written: DATE.
Author: MODEL (Claude Code) for USER. Follows PREVIOUS_REVIEW_PATH and checks RESPONSE_PATH.

Revision reviewed: `FULL_SHA`, frozen in a detached worktree at WORKTREE. Delta since the previous review:
COMMIT_LIST. State observed during the review that the reader must know (pushes, PR body edits, CI runs): STATE_NOTES.
Line numbers are `file:line` at `REVISION`.

Method: one time-boxed workflow of N agents (M minutes): LENS_LIST with models. The K medium-or-higher findings were
re-checked by Fable verifiers. I confirmed the items in the summary myself.

## 1. Verdict

Lead with the outcome in three to six sentences: what holds, what remains, whether anything blocks. Name the single
most consequential open item and where it is discussed.

## 2. Previous feedback and responses, verified

| Earlier action or response row | Status | Evidence at `REVISION` |
|---|---|---|
| ... | addressed / partially / not addressed / superseded / contradicted | `file:line`, test name, commit |

Include premise corrections the response made to the previous review, accepted or rejected with source evidence.

## 3. Findings

Order by severity. For each: what the code does (cited), why it matters, the smallest fix. Separate "verified"
(a verifier and/or the author re-checked it) from "not verified". Record disagreements between lenses and verifiers
with the author's resolution and reasoning.

## 4. What holds up

Confirmations that a reader might otherwise re-derive: interleavings tried and rejected, invariants checked, tests
judged sound, documents found consistent.

## 5. Recommended actions, in order

Numbered, each one sentence with a pointer to the section that justifies it.

## Appendix A. Finding index

| Lens (model) | Id | Sev | Title | Verifier |
|---|---|---|---|---|

## Appendix B. Limits

What was not run or not checked, which claims came only from agents, and how to remove the frozen worktree.
