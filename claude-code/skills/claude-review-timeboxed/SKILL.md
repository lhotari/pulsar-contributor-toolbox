---
name: claude-review-timeboxed
description: Use when asked for a time-boxed, multi-angle review of a branch, commit range, PR head or design document against the code, whether a ten-minute pass or a thorough high-effort review, including re-reviews after an author or another agent (for example Codex) has responded to earlier feedback, when the review must fit a stated time budget and the remaining Claude allowance and be stored in the project's timeboxed-reviews directory. Covers Apache Pulsar related repositories in Java, Go, C++, Python or docs.
argument-hint: "[<ref> | <base>..<head> | PR] [--timebox 10m|15m|30m] [--effort default|high|cheap] [--out <path>] [--instructions \"...\"]"
allowed-tools: Bash(git:*), Bash(bash:*), Bash(date:*), Bash(ls:*), Bash(cat:*), Bash(sed:*), Bash(grep:*), Bash(python3:*), Bash(gh:*), Read, Write, Glob, Grep, Workflow, Agent
---

# Time-boxed multi-angle review

## Overview

Freeze the target, fan out independent lenses with models chosen from the request, the time box and the
remaining allowance, refute the medium-or-higher findings with the strongest model the profile allows (high
severity first), re-check the summary claims yourself, and write one source-cited review file. The box is met by
sizing and by wall-clock deadlines the agents can see, and the review says what the clock cut.

**Violating the letter of the procedure is violating its spirit.** A review that skips freezing, the usage
check or verification is not "a faster review"; it is a different, weaker artifact.

## When to use

- Any review with a time budget, not only quick ones: a ten-minute pass on a small delta, a fifteen-minute
  re-review after a response, or a thirty-minute or longer thorough review at high effort. The time box sets the
  size of the workflow; it does not lower the standard of evidence.
- "Review this branch / PR / implementation with a workflow" or "check again" after a response.
- A first review of a PR (claims in its description are checked against the code) or a follow-up (the previous
  review's actions and the response's dispositions are the checklist).
- A planning or design document must be checked against the code it describes.
- Another agent keeps pushing to the branch while you review.
- Any Apache Pulsar related repository: the broker and Java client, the Go, C++, Python and Node clients,
  BookKeeper, the site. The procedure does not depend on the language; the lens prompts take the repository's
  source and test patterns and its own style and test rules (from its CLAUDE.md, CONTRIBUTING or coding guide).
- Not for posting to GitHub, running builds or tests, or editing code: this skill is read-only and produces a
  file. Use `pr-review` when the terminal-only Fable-and-Codex consensus pipeline is wanted instead.

## Inputs and defaults

| Input | Default | Override |
|---|---|---|
| Target | `HEAD` of the current checkout, base = merge-base with the default branch | a ref, `<base>..<head>`, a PR number (`gh pr view`), or document paths |
| Instructions | none | free text from the user; goes into every lens prompt as USER_INSTRUCTIONS |
| Time box | 10 minutes wall clock for the workflow | `--timebox 15m` or `30m`, or words like "longer", "thorough" |
| Profile | from the usage reading (below) | `--effort high` or "thorough" forces high; `--effort cheap`, "cheap" or "save allowance" forces tight |
| Output | `<main repo root>/.claude/timeboxed-reviews/<date -I>-<description>-<12-char sha>.md` | `--out <path>` |

The main repo root is the primary checkout even when you run inside a git worktree: the parent of
`git rev-parse --git-common-dir`. Never place the file in a sibling directory or in the worktree. The word
"quick" selects this skill; it does not select the tight profile.

## Model policy

Run the usage script during scouting, with the network allowed and stderr captured:

```
bash <skill dir>/scripts/claude-usage.sh 2>&1     # allowed_domains: ["api.anthropic.com"]
```

It reads the local Claude OAuth token and calls an undocumented usage endpoint at api.anthropic.com only; this is
the same script `pr-review-track` uses. It prints the session (5 h) and weekly percentages. The reading is the
higher of the two. If the output contains "showing cached data", "token expired", "n/a" or an error, the reading
is unknown: use the normal profile and write "usage unknown or stale" in the Method line instead of a number.
If the reading is 95% or more, do not launch the workflow; report the reading and ask.

An explicit request wins over the reading; say in the Method line when the two disagree.

| Profile | When | Very trivial: lookups, doc and config consistency, checklists | Tasks: focused code or test review with a stated question list | Brains: concurrency and interleavings, disputed premises, contrarian, verifiers |
|---|---|---|---|---|
| normal | reading at most 75% and no override | Sonnet, medium | Opus; medium, high or xhigh by task difficulty | Fable; high by default, xhigh for the core-change lens and for verifiers of high-severity findings, medium only for trivial Fable work |
| high | user asks for high effort or a thorough review | Sonnet, high | Fable, high | Fable, xhigh |
| tight | reading above 75% and no override, or user asks for cheap | Sonnet, low | Sonnet, medium; Opus, medium for the single hardest task | Opus, high for the core-change lens; Opus, medium for contrarian and verifiers; verify cap halved |

Task difficulty for the Opus effort: medium for one file with a known question list, high for cross-file control
flow or test-fixture judgement, xhigh for ownership, lifecycle or recovery logic that is not the core change. The
template's roles are `lookup`, `task`, `taskHard`, `brain`, `core` and `verify`; assign each lens the role that
matches its work. Never spend a brain on a lookup and never spend a lookup model on an interleaving.

## Procedure

1. **Freeze and resolve the path.** Run `bash <skill dir>/scripts/freeze-and-path.sh <ref or base..head>
   "<description>"`. It prints `REVISION`, `BASE_REVISION`, `WORKTREE` and `REVIEW_PATH` before any side effect,
   then creates a detached worktree under `$TMPDIR`. A sandbox may refuse to create the review directory; that is
   a warning, the Write tool creates it in step 7. Every agent works only in `WORKTREE`. For a follow-up, the
   previous review file in the same directory is the checklist; read its recommended actions and any response.
2. **Scout inline, two minutes at most.** Run the usage script and pick the profile. Then
   `git log --oneline BASE_REVISION..REVISION`, `git diff --stat`, the response's disposition table or the PR
   description, the repository's style and test rules. Note premises from the previous review that the response
   disputes; they go into the workflow context as open questions, not facts.
3. **Set the deadlines.** With `now=$(date +%s)` compute `findDeadlineEpoch = now + agentMinutes*60`,
   `verifyDeadlineEpoch = findDeadlineEpoch + 60` and `hardDeadlineEpoch = now + timebox*60 - 120`, and pass them
   with `agentMinutes` and `verifyMinutes` as the Workflow `args`. Agents read `date` themselves, stop at their
   deadline and return what they have marked truncated; the script halves the verify cap when the find phase ran
   late and skips verification past the hard deadline, reporting both in its result.
4. **Author the workflow** from [`workflow-template.js`](workflow-template.js) and run it with the `Workflow`
   tool (not loose `Agent` calls): set `PROFILE`, `HAS_PREVIOUS_REVIEW` and `WT`, fill the placeholders (delta,
   key files with line numbers, disputed premises or claims source, style and test rules, source and test patterns,
   user instructions, core questions, hypotheses), pick the lens set below, keep the checklist lens with its schema,
   and let the verify stage run over medium-or-higher findings plus contradicted checklist rows, high severity
   first, deduplicated, capped by the sizing table.
5. **Do first-hand checks while it runs.** Re-read the two or three highest-stakes regions yourself and any
   artifact the response cites (negative-control logs, CI snapshots).
6. **Synthesize yourself.** Parse the result; keep the verifiers' corrected claims, not the originals; list
   refuted findings under their own heading; resolve any lens-versus-verifier disagreement with your own source
   read and say which side you took and why; accept premise corrections that the source supports and say so.
   Report missing or truncated lenses and any reduced or skipped verification.
7. **Re-check the world, then write.** `git fetch` and compare origin and the PR (body, comments, CI) with what
   you saw at the start; a push, a body edit or a CI run that landed during the review is a fact the reader needs.
   Write the file from [`review-template.md`](review-template.md) with the Write tool, then tell the user the
   path, the profile and usage reading, the verdict, the open items in priority order, what the clock cut, and
   the worktree cleanup command.

## Lens sets

| Repository or target | Minimum lenses |
|---|---|
| Code change (Java, Go, C++, Python, Node) | checklist or stated-claims, core change (role `core`), tests, docs and hygiene, contrarian |
| Docs or site change | stated claims versus the code or behaviour it documents, link and build consistency, terminology and audience, contrarian on misleading statements; no `core` lens |
| Design document versus code | claims versus code (role `task`), interleavings the document asserts (role `brain`), what the document omits (contrarian), planning-document consistency |

Add lenses for the change's own risk areas (compatibility of persisted or wire formats, configuration defaults,
performance claims) up to the sizing table.

## Sizing

| Time box | Lenses | Verify cap (normal or high) | Agent minutes | Extras |
|---|---|---|---|---|
| 10 min (default) | 5 to 7 | 8 | 4 | none |
| 15 min | 7 to 9 | 12 | 5 | second brain lens (for example concurrency plus contrarian) |
| 30 min or "thorough" | 9 to 12 | 20 | 6 | completeness critic after verify; at most two extra rounds, stop when a round adds nothing |

Small deltas take fewer lenses, never fewer than the minimum set for the target. The tight profile halves the
verify cap. A lens that returns null is reported as missing, not silently dropped.

## The review file

Use the template's sections in order: header (revision and base, worktree, delta, state observed, method with
profile, usage reading, agent count, duration, deadline handling), verdict, earlier feedback or stated claims
verified as a table, findings by severity with verified and unverified separated, refuted or downgraded, what
holds up, ordered actions, finding index with lens and verifier model and effort, limits. Every finding carries
`file:line` at the frozen revision. Say what was not run and what the clock cut.

## Common mistakes

| Mistake | Fix |
|---|---|
| Guessing the output directory or filename | Use the script; the path is derived from the main repo root and the date |
| Agents read the live checkout, or `git show <sha>:path` per file, while someone else pushes | Freeze a detached worktree once; agents only use it |
| Loose `Agent` calls with a `TaskStop` deadline | One `Workflow` with schemas, deadline args and sizing |
| No adversarial verification, only citation spot-checks | Verifiers on the profile's model refute each medium-or-higher finding, high severity first |
| Checklist rows presented as verified because a lookup lens produced them | Contradicted or unverified rows go through a verifier or your own read; say which |
| Free-text reports synthesized under time pressure | Structured schemas; synthesis is a parse plus your own re-check |
| Too few lenses, no contrarian, no checklist | Use the lens set for the target |
| Picking models by habit, or the cheapest available | Run the usage script; apply the profile table and the user's stated effort |
| Reading a stale cached usage number as current | "showing cached data" means unknown; use normal and say so |
| xhigh on a checklist, medium on an interleaving | Effort follows task difficulty within the profile |
| A follow-up template on a first review | Set `HAS_PREVIOUS_REVIEW = false`; the checklist lens checks stated claims |
| Java idioms in prompts for a Go, C++ or docs repository | Fill TEST_RULES, STYLE_RULES and patterns from the repository; pick the lens set for the target |
| Treating the response document's claims as verified | The checklist lens verifies rows against source, not against the response text |
| Reporting a verifier's counterclaim without reading the code | Resolve disagreements yourself and record the reasoning |
| Silently accepting or ignoring a premise correction | Verify it from source and state the outcome in the verdict |
| Forgetting that the branch moved | Step 7: re-fetch, compare, and report pushes, body edits, CI |

## Red flags

- "I'll read the working tree, it is faster than a worktree."
- "The findings look right, verification would blow the budget."
- "Usage is probably fine, I'll skip the script." / "The cached number is close enough."
- "The response says it was fixed."
- "One Fable agent can do all of it."
- "The agents will just finish; no need for deadlines."

All of these mean: go back to the procedure.
