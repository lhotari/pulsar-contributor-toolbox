# Claude review of TARGET at `REVISION`

Status: source-verified review, no tests run. Written: DATE.
Author: MODEL (Claude Code) for USER. FOLLOW_UP_LINE (for a follow-up: "Follows PREVIOUS_REVIEW_PATH and checks
RESPONSE_PATH"; for a first review: "First review; claims checked against the PR description or design document").

Revision reviewed: `FULL_SHA` (base `BASE_REVISION`), frozen in a detached worktree at WORKTREE. Delta reviewed:
COMMIT_LIST. State observed during the review that the reader must know (pushes, PR body edits, CI runs): STATE_NOTES.
Line numbers are `file:line` at `REVISION`.

Method: profile PROFILE from usage reading USAGE_READING (or "unknown or stale"); one time-boxed workflow of N agents
(M minutes): LENS_LIST with model and effort per lens; K findings re-checked by VERIFIER_MODEL verifiers at
VERIFIER_EFFORT; deadline handling: DEADLINE_NOTES (none needed, cap reduced, or verification skipped, with which
lenses reported truncation). I confirmed the items in the summary myself.

## 1. Verdict

Lead with the outcome in three to six sentences: what holds, what remains, whether anything blocks. Name the single
most consequential open item and where it is discussed.

## 2. Earlier feedback, responses or stated claims, verified

Follow-up review: one row per earlier action and per response row, status addressed / partially / not addressed /
superseded / contradicted, evidence at `REVISION`; rows marked contradicted or not verified were re-checked by a
verifier or by the author and say so. First review: one row per behavioural claim in the PR description or design
document, status matches / stale / unsupported, evidence at `REVISION`.

Include premise corrections the response made to the previous review, accepted or rejected with source evidence.

## 3. Findings

Order by severity. For each: what the code does (cited), why it matters, the smallest fix. Separate "verified"
(a verifier and/or the author re-checked it) from "not verified" (below the cap or low severity). Record
disagreements between lenses and verifiers with the author's resolution and reasoning.

## 4. Refuted or downgraded

Findings a verifier refuted or lowered, one line each with the reason, so the reader does not re-derive them.

## 5. What holds up

Confirmations that a reader might otherwise re-derive: interleavings tried and rejected, invariants checked, tests
judged sound, documents found consistent.

## 6. Recommended actions, in order

Numbered, each one sentence with a pointer to the section that justifies it.

## Appendix A. Finding index

| Lens (model, effort) | Id | Sev | Title | Verifier (model, effort, verdict) |
|---|---|---|---|---|

## Appendix B. Limits

What was not run or not checked, which lenses were missing or truncated, which claims came only from agents, whether
the usage reading was stale, and how to remove the frozen worktree.
