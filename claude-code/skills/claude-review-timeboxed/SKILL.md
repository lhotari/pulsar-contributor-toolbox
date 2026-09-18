---
name: claude-review-timeboxed
description: Use when asked for a quick, time-boxed, multi-angle review of a branch, commit range, PR head or design document against the code, including re-reviews after an author or another agent (for example Codex) has responded to earlier feedback, when the review must finish in minutes, use cheaper models where thought is not needed, and be stored in the project's timeboxed-reviews directory.
argument-hint: "[<ref or PR>] [--timebox 10m|15m|30m] [--effort default|high] [--out <path>] [--instructions \"...\"]"
allowed-tools: Bash(git:*), Bash(bash:*), Bash(ls:*), Bash(cat:*), Bash(sed:*), Bash(grep:*), Bash(python3:*), Bash(gh:*), Read, Write, Glob, Grep, Workflow, Agent
---

# Time-boxed multi-angle review

## Overview

Freeze the target, fan out independent lenses on the cheapest model that can do each job, refute every
medium-or-higher finding with the strongest model, re-check the summary claims yourself, and write one
source-cited review file. The whole thing finishes inside the time box because the workflow is sized to it,
not because agents are cut off.

**Violating the letter of the procedure is violating its spirit.** A review that skips freezing or
verification is not "a faster review"; it is a different, weaker artifact.

## When to use

- "Review this branch / PR / implementation with a workflow, quickly" or "check again" after a response.
- A planning or design document must be checked against the code it describes.
- Another agent keeps pushing to the branch while you review.
- Not for posting to GitHub, running builds or tests, or editing code: this skill is read-only and produces a
  file. Use `pr-review` when the terminal-only Fable-and-Codex consensus pipeline is wanted instead.

## Inputs and defaults

| Input | Default | Override |
|---|---|---|
| Target | `HEAD` of the current checkout versus its merge-base with the default branch | a ref, range, PR number (`gh pr view`), or document paths |
| Instructions | none | free text from the user; becomes part of every lens prompt |
| Time box | 10 minutes wall clock for the workflow | `--timebox 15m` or `30m`, or words like "longer" |
| Effort | Sonnet for lookups, Opus for focused review, Fable for concurrency, disputed premises, contrarian and all verification | `--effort high`: Opus lenses become Fable, `effort: 'high'` everywhere, verify cap doubled |
| Output | `<main repo root>/.claude/timeboxed-reviews/<date -I>-<description>-<12-char sha>.md` | `--out <path>` |

The main repo root is the primary checkout even when you run inside a git worktree: the parent of
`git rev-parse --git-common-dir`. Never place the file in a sibling directory or in the worktree.

## Procedure

1. **Freeze and resolve the path.** Run `bash <skill dir>/scripts/freeze-and-path.sh <ref> "<description>"`.
   It creates a detached worktree under `$TMPDIR` and prints `REVISION`, `WORKTREE` and `REVIEW_PATH`.
   Every agent works only in `WORKTREE`. If the review is a follow-up, the previous review file in the same
   directory is the checklist; read its recommended actions and any response document.
2. **Scout inline, two minutes at most.** `git log --oneline <previous>..REVISION`, `git diff --stat`, the
   response's disposition table, the PR body if there is one. Note premises from the previous review that the
   response disputes; they go into the workflow context as open questions, not facts.
3. **Author the workflow** from [`workflow-template.js`](workflow-template.js) and run it with the `Workflow`
   tool (not loose `Agent` calls): one shared context block (revision, worktree, delta, key files with line
   numbers, disputed premises, the user's instructions), a Sonnet checklist lens with the checklist schema,
   focused lenses with the findings schema, then a Fable verify stage over every medium-or-higher non-confirmation
   finding, capped. Tell agents "TIME BOX: about N minutes of work" and "read-only, cite file:line at REVISION".
   Size it with the table below.
4. **Do first-hand checks while it runs.** Re-read the two or three highest-stakes regions yourself and any
   artifact the response cites (negative-control logs, CI snapshots). Watch for state changes: a push, a PR
   body edit or a CI run that lands during the review is a fact the reader needs.
5. **Synthesize yourself.** Parse the result JSON; keep the verifiers' corrected claims, not the originals;
   resolve any lens-versus-verifier disagreement with your own source read and say which side you took and why;
   accept premise corrections that the source supports and say so plainly.
6. **Write the file** from [`review-template.md`](review-template.md) with the Write tool, then tell the user
   the path, the verdict, the open items in priority order, and the worktree cleanup command.

## Sizing

| Time box | Lenses | Verify cap | Agent time box | Extras |
|---|---|---|---|---|
| 10 min (default) | 5 to 7 | 8 | 4 to 5 min | none |
| 15 min | 7 to 9 | 12 | 5 min | second Fable lens (for example concurrency plus contrarian) |
| 30 min or "thorough" | 9 to 12 | 20 | 6 min | completeness critic after verify; loop until a round adds nothing |

Small deltas take fewer lenses, never fewer than a checklist, one strong-model lens on the core change, tests,
docs, and a contrarian. A lens that returns null is reported as missing, not silently dropped.

## Model tiering

| Work | Model, effort |
|---|---|
| Checklist of earlier actions or dispositions, doc and config consistency, planning-document drift | Sonnet, low or medium |
| Focused code or test review with a stated question list | Opus, medium or high |
| Concurrency and interleavings, disputed premises, contrarian hunt, every verifier | Fable, high |

## The review file

Use the template's sections in order: header (revision, worktree, delta, state observed, method with agent
count and duration), verdict, earlier feedback verified as a table, findings by severity with verified and
unverified separated, what holds up, ordered actions, finding index, limits. Every finding carries `file:line`
at the frozen revision. Say what was not run. Name state changes seen during the run.

## Common mistakes

| Mistake | Fix |
|---|---|
| Guessing the output directory or filename | Use the script; the path is derived from the main repo root and the date |
| Agents read the live checkout, or `git show <sha>:path` per file, while someone else pushes | Freeze a detached worktree once; agents only use it |
| Loose `Agent` calls with a `TaskStop` deadline | One `Workflow` with schemas; sizing enforces the time box |
| No adversarial verification, only citation spot-checks | Fable verifiers try to refute each medium-or-higher finding |
| Free-text reports synthesized under time pressure | Structured schemas; synthesis is a parse plus your own re-check |
| Four lenses, no contrarian, no checklist | Minimum set: checklist, core change, tests, docs, contrarian |
| Treating the response document's claims as verified | The checklist lens verifies rows against source, not against the response text |
| Fable for lookups, Sonnet for interleavings | Tier by the kind of work |
| Reporting a verifier's counterclaim without reading the code | Resolve disagreements yourself and record the reasoning |
| Silently accepting or ignoring a premise correction | Verify it from source and state the outcome in the verdict |
| Forgetting that the branch moved | Re-check origin and the PR at the end; report pushes, body edits, CI |

## Red flags

- "I'll read the working tree, it is faster than a worktree."
- "The findings look right, verification would blow the budget."
- "The response says it was fixed."
- "One Fable agent can do all of it."

All of these mean: go back to the procedure.
