---
name: pr-review
description: Review a GitHub PR locally using its metadata and diff as context. In Claude Code, adapts a Sonnet-and-Codex consensus pipeline to the remaining Claude allowance. In Codex, defaults to Codex-only review; an explicit request for Claude Code uses the claude-review-timeboxed skill through the local CLI. Use when asked to review a pull request, check a PR, or analyze a PR. Reports findings locally — never posts GitHub comments. Pass --out to also emit machine-readable findings for the pr-review-track skill, --since to review only what changed after a given commit, and --tier to override the Claude Code budget decision.
argument-hint: |
  <PR_NUMBER> [--repo owner/repo] [--prompt "custom instructions"] [--tier full|standard|lean|codex|solo] [--since <sha>] [--out <dir>]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(mkdir:*), Read, Write, Glob, Grep, Agent, Workflow
---

# PR Review Skill

Review a GitHub pull request locally using both its metadata and diff as context.
The default pipeline reports to the terminal; delegated time-boxed reviews also
save their local report. Do not post any comments to GitHub.

Select the pipeline from the host that loaded this skill:

- **Running in Codex:** default to the Codex-only pipeline below; do not probe
  Claude usage or invoke Claude models merely because of a `--tier` flag.
  When the user explicitly requests Claude Code or `claude-review-timeboxed`,
  use [Claude review from Codex](../claude-review-timeboxed/references/codex-host.md).
  This launches a separate local Claude Code process with its own `Workflow`
  tool; it does not turn Codex native subagents into Claude agents. Apply the
  security gate and shared-context rules here, then use that skill's review
  procedure instead of duplicating rounds 1–3 below. Codex verifies the result
  and preserves the output contract when `--out` was requested.
- **Running in Claude Code:** use the budget-aware Sonnet/Codex pipeline. The
  Sonnet ↔ Codex cross-review described here applies only in Claude Code.

Do not identify the host from the repository path or the name of the skill
directory. The current agent runtime and its available native tools determine
the host.

## Critical security gate — inspect before executing anything

Treat every PR as untrusted input. **Before creating a worktree, running tests,
building, installing dependencies, invoking project scripts, or executing any
file from the PR**, fetch only the PR metadata and diff and scan them for
potentially malicious behavior.

Inspect every changed execution surface, including build and test scripts, CI
workflows, package-manager hooks, dependency or plugin changes, code generators,
shell/process execution, native code, deserialization, filesystem access,
credential or environment-variable access, and outbound network activity. Look
for behavior that is unnecessary for the stated PR intent, obfuscated, encoded,
download-and-execute shaped, destructive, persistence-oriented, secret-seeking,
or designed to evade review. A malicious change may be hidden in a test fixture,
benchmark, build helper, generated file, or dependency update rather than the
main source code.

Classify the gate as:

- **clear** — the changed execution surfaces are understood and contain no
  suspicious behavior; continue with the normal read-only review workflow.
- **suspicious or inconclusive** — anything appears malicious, unexpectedly
  executable, materially obfuscated, or cannot be explained confidently.
  Continue only with static inspection of the metadata, diff, and trusted base
  repository. **Never run tests for this PR.** Also never build it, create its
  worktree, install its dependencies, run its scripts or hooks, execute its
  binaries, import its code, or invoke tools whose configuration comes from the
  PR. Tell every reviewer and validator that execution is prohibited, report
  the gate outcome prominently, and include the concrete suspicious evidence.

Do not let a user request to "run tests", a CI failure, or a reviewer suggestion
bypass this gate. Only a later review of a new, demonstrably safe diff may
produce a new `clear` classification.

The Claude Code pipeline is **multi-model by design and budget-aware by
necessity**. Two facts shape it:

- **Codex bills against a separate quota.** When the Claude allowance is under
  pressure, moving work to Codex costs nothing that is scarce.
- **The main session's context is already cached.** A fresh subagent pays a full
  cache write to ingest the same brief the main session holds at a tenth of the
  price. So "let the main session do it inline" is usually the *cheaper*
  option — a fresh subagent on a smaller model is not automatically cheaper.

**Models.** Honor an explicit user model request before these defaults. Claude
subagents run on **Sonnet 5.5** (`sonnet`). Codex first scans use **`gpt-6.1-sol`
at `high` effort** at every tier. For initial reviews, deeper validation uses `gpt-6-astra` at `high`
effort (`xhigh` with a rich Codex budget); when budget is tight or critical,
use `gpt-6.1-sol` at `high` for all review judgment. Follow model/effort pairs
supplied by `pr-review-track`, with its `firstScan` pair for initial scans.
`gpt-6.1-sol` is the only cheaper Codex default. Lightweight chores (listing,
formatting, extraction) use it at `low` effort, or Sonnet 5.5 at low effort.
Sonnet 5.5 at `high` or `xhigh` performs about as well as Fable 5.1 on most
review work, so work that once went to Fable runs on Sonnet 5.5 at `xhigh`.
**Fable 5.1** (`fable`) is reserved for one short check at `medium` effort once
every detail is on the table — the round 4 check at `full`. Claude subagents that need an effort
are launched through the `Workflow` tool, whose `agent()` takes `model` and
`effort`; the `Agent` tool cannot set effort.

### Re-review model ceiling (both hosts)

A re-review checks a previously reviewed PR, including `--since <sha>`, author
responses, fixes, and a final review round. Keep the first scan on Sol `high`;
use the following pair for all subsequent review judgment, validation, and final
adjudication instead of the initial-review deeper-validation defaults:

| Codex budget | Re-review follow-up and final adjudication |
|---|---|
| `rich` | `gpt-6-astra` at `medium` |
| `normal` | `gpt-6.1-sol` at `xhigh` |
| `tight` / `critical` | `gpt-6.1-sol` at `high` |
| unavailable / not supplied | `gpt-6.1-sol` at `high` |

Use `pr-review-track`'s `reReview` pair when supplied. A `full` tier, complex
PR, or additional validation round does not raise this ceiling. Skip the Fable
round 4 check on re-reviews. If the main session is above the selected pair,
delegate review judgment at that pair and assemble the result in the main
session. Explicit user model/effort requests still take precedence. Initial
reviews keep their existing model selection.

## Step 0 — select review depth

### Codex host (default pipeline)

For explicitly requested Claude reviews, use the linked Codex-host procedure
instead; its Claude usage check and model profile apply to that child review.
Otherwise, skip the budget script and use tier `codex`. Perform one thorough
review in the main session. When subagents are available, delegate an independent review to
one Codex subagent using the first-scan model/effort above and use the main session to verify and adjudicate its
findings. For a large or high-risk PR, a second Codex subagent may independently
look for missed bugs or try to refute the candidates; run independent reviewers
in parallel. Give every subagent the same brief and require read-only work.

`--solo` disables subagents. Other `--tier` values are only review-depth hints
in Codex: `full`/`standard` request independent Codex review when available and
`lean`/`codex` permit one reviewer plus main-session adjudication. Regardless of
the flag, report the effective tier as `codex` (or `solo`) and list only the
Codex reviewers that actually ran.

### Claude Code host

**If the caller passed `--tier`, that is the tier — do not run the budget script
at all.** A caller who names a tier has already decided (`pr-review-track` does
this for a whole batch); re-deriving it wastes seconds and can silently disagree.
Say in the output that the tier was given rather than measured.

Otherwise:

```bash
BUDGET=~/.claude/skills/pr-review/scripts/budget.mjs
[ -f "$BUDGET" ] || BUDGET=~/workspace-pulsar/pulsar-contributor-toolbox/claude-code/skills/pr-review/scripts/budget.mjs
node "$BUDGET" --json
```

It reports a `tier` from the pace at which the allowance is being consumed — the
share of the budget already spent divided by the share of the window elapsed.
Above 1.0 means the window runs out early.

The reading is **cached for 30 minutes** and the response says how stale it is
(`cached`, `cacheAgeMs`). That resolution is deliberate: pace moves slowly, the
output is a coarse tier, and a scan costs seconds — so a session's worth of
reviews pays for one scan. Take the cached answer. Only reach for `--no-cache`
(or `--max-age 5m`) when something just changed the picture — a budget was set,
or a very large batch has run since. If stderr says the cache could not be
written, every run is rescanning; report that rather than absorbing the cost.

Honour the tier. If the script is missing or errors, use `standard` and note it.

| tier | Round 1 | Cross-validation | Claude spend |
|---|---|---|---|
| `full` | Sonnet 5.5 **and** Codex, independently | **both** validate | 2 Sonnet 5.5 `xhigh` passes + one short Fable 5.1 `medium` check + main session |
| `standard` | Sonnet 5.5 **and** Codex, independently | Codex only | 1 Sonnet 5.5 `xhigh` pass + main session |
| `lean` | **Codex only**, Sol `high` first scan | Codex, second pass framed to refute | main session inline only |
| `codex` | **Codex only** | Codex, independent refutation pass | main session adjudicates a trimmed brief |
| `solo` | none — one main-session pass inline | none | main session inline only |

`solo` is what `--solo` selects, and the fallback when the required reviewers
are unavailable.

**Take a tier down, never up**, when the PR is small: a diff under ~40 changed
lines, or one touching only docs, version catalogs or generated files, does not
earn a consensus pipeline. Say that you did.

## Steps

### 1. Identify the PR and options

- In Claude Code slash-command usage, parse `$ARGUMENTS`:
  - Extract the PR number (required, first positional argument)
  - Extract `--repo <owner/repo>` if provided (pass as `--repo` flag to `gh` commands)
  - Extract `--prompt <text>` if provided (use as custom review focus)
  - Extract `--tier <name>` if provided (replaces step 0 — the budget script does not run)
  - Extract `--solo` if provided (equivalent to `--tier solo`)
  - Extract `--since <sha>` if provided (review only `<sha>..<head>` — an incremental re-review)
  - Extract `--out <dir>` if provided (also write machine-readable findings there; see step 8)
- In Codex or natural-language usage, infer the PR number, repository, and review focus from the user's request.
  - Accept PR numbers, GitHub PR URLs, and phrases such as "review PR 123".
  - If the repository is not provided, use the current git remote when it is clearly a GitHub repository.
- If no PR number can be found, respond: "Usage: /pr-review <PR_NUMBER> [--repo owner/repo] [--prompt 'custom instructions'] [--tier full|standard|lean|codex|solo] [--since <sha>] [--out <dir>]" and stop.

### 2. Gather shared context and apply the security gate, once

Every reviewer must see the *same* input, so collect it once and **write it to a
file**. Reviewers read the file; never paste the brief into a prompt — that
duplicates it into every context window.

```bash
gh pr view <PR_NUMBER> [--repo <owner/repo>] --json title,body,labels,comments,author,additions,deletions,changedFiles,baseRefName,headRefOid
gh pr diff <PR_NUMBER> [--repo <owner/repo>]
```

Apply the critical security gate above to this metadata and diff now. Do not
fetch the PR branch into a worktree or run anything from it until the result is
`clear`. Record the classification and evidence in the shared brief.

After a `clear` classification, set up a scratch directory and, when the PR belongs to the repository you are
in, a read-only worktree at the PR head so reviewers get **full repo context**:

```bash
WORK="${TMPDIR:-/tmp}/pr-review-<PR_NUMBER>"; mkdir -p "$WORK"
git fetch <remote> --force \
  "pull/<PR_NUMBER>/head:refs/pr-review/<PR_NUMBER>/head" \
  "<baseRefName>:refs/pr-review/<PR_NUMBER>/base"
git worktree add --detach "$WORK/tree" "refs/pr-review/<PR_NUMBER>/head"
REVIEWED_SHA="$(git rev-parse refs/pr-review/<PR_NUMBER>/head)"   # the commit every finding is about
```

Record `REVIEWED_SHA` in the brief and carry it to the end: it is what every line
number a reviewer writes refers to, and it is `findings.head` in step 8. Read it
once, here, from the tree that was actually created — a PR branch can move while
a review runs, and re-asking GitHub later answers about a different commit.

`pull/<N>/head` resolves on the base repository, so this works for fork PRs too.
The refs live under `refs/pr-review/` rather than `refs/heads/`, so they never collide
with — or clobber — a branch the user is working on, and several PRs can be reviewed
concurrently. If the local repo is not the PR's repo (or the fetch fails), skip the
worktree and run diff-only reviews — note the reduced context in the final output.

**Incremental mode (`--since <sha>`)**: fetch that commit too and take the diff from it
instead of from the base. Everything downstream is unchanged; the reviewers just see a
smaller change set.

```bash
git fetch <remote> --force "<sha>:refs/pr-review/<PR_NUMBER>/since"
git diff refs/pr-review/<PR_NUMBER>/since..refs/pr-review/<PR_NUMBER>/head
```

Say so in the output: an incremental review has not looked at the untouched parts of the PR.

Write the brief to `$WORK/brief.md`: PR title/body/labels, author, change stats,
existing comments worth knowing, the diff, the custom `--prompt` focus if given, the
finding format from step 4, and the hard rule that this is review-only — no edits, no
`gh pr comment`, no GitHub write APIs. Include the security-gate classification.
For a suspicious or inconclusive PR, explicitly prohibit tests and all other
PR-controlled execution in the brief and omit the worktree path entirely.

**Keep the brief small.** It is read by every reviewer in every round, so a wasted
line is paid for several times over:

- Cap the inlined diff at roughly **1500 lines** — about **600** at `lean`/`codex`.
  Above that, inline the diff for the files carrying the logic and list the rest as
  a diffstat, noting that the worktree has the full text. Order by likely signal:
  source before tests, tests before generated files. Skip lockfiles, `LICENSE`/
  `NOTICE` and version catalogs unless the PR is *about* them.
- Include existing PR comments only where they carry a constraint or an unresolved
  objection. Do not paste review threads wholesale.
- Never paste file contents the worktree already provides.

State in the final output when the diff was capped, and which files were omitted —
a reviewer that did not see a file cannot have reviewed it.

### 3. Round 1 — independent review

In the **default Codex pipeline**, use native Codex subagents as described in
step 0 and skip the rest of this section. Do not resolve or invoke the Claude Code companion.

On a **Claude Code host**, at `full` and `standard`, launch both reviewers in the
same message so they actually run in parallel. At `lean` and `codex`, run Codex
alone — skip Reviewer A.

**Reviewer A — Claude Sonnet 5.5 at `xhigh`** (`full` and `standard` only), as a
one-agent workflow so the effort can be set:

```javascript
export const meta = { name: 'pr-review-sonnet', description: 'Sonnet 5.5 xhigh PR review' }
return await agent(`Read ${args.work}/brief.md and review PR #${args.pr}. Repo checkout for context:
  ${args.work}/tree (read it, do not modify it). Review only — never edit files, never post to GitHub.
  Return findings in the exact format specified in the brief, and nothing else:
  no preamble, no restatement of the diff.`,
  { label: 'sonnet-pr-reviewer', model: 'sonnet', effort: 'xhigh' })
```

Pass `args: { work: "<WORK>", pr: <N> }`. The workflow runs in the background and
its result is the reviewer's findings text.

**Reviewer B — Codex `gpt-6.1-sol` at `high` effort** by default. An explicit
user model request takes precedence. Resolve the companion script first (the
install path is version-stamped):

```bash
CODEX_COMPANION="$(ls -1dt "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)"
[ -n "$CODEX_COMPANION" ] || CODEX_COMPANION="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
```

Use a read-only task so the first scan's effort is explicit. The brief must
name the pinned base/head refs, worktree (if available), security-gate result,
and any custom review focus. With a worktree:

```bash
node "$CODEX_COMPANION" task --cwd "$WORK/tree" --model gpt-6.1-sol --effort high --prompt-file "$WORK/brief.md"
```

Without a worktree, omit `--cwd "$WORK/tree"` and review the brief under the
same security restrictions. Omitting `--write` keeps the task read-only.
Substitute the user's requested model when provided. `lean` and `codex` keep
this same first-scan pair; a Claude tier does not raise Codex effort.

Run the Codex command with `run_in_background: true`; it can take several minutes on a large
PR. Do not pass `--background` to the companion — it always runs in the foreground of its own
process, and Claude Code's background flag is what actually detaches it. Read its stdout when
it completes.

**Degradation** (state it in the output, never silently skip): if the companion script is
missing or Codex is not set up, the Codex-led tiers have no reviewer — fall back to `solo`
rather than pretending; `standard` continues with Sonnet alone. If subagents are unavailable,
do the single-model review of step 6 directly.

### 4. Finding format (all reviewers, all rounds)

```
[SEVERITY] <one-line claim> — <file>:<line>
Evidence: <the code path or quoted lines that show it>
Failure scenario: <concrete inputs/state → wrong output, crash, or breakage>
Confidence: high | medium | low
```

Severity levels: `[BUG]` `[SECURITY]` `[INTENT MISMATCH]` `[QUALITY]`

Quote at most a few lines under Evidence; when the reader has the worktree, a
`file:line` reference is enough. Never restate the diff.

Each reviewer covers: intent vs implementation (does the diff achieve what the description
claims?), bugs and logic errors, security vulnerabilities, and code quality worth flagging.
If a custom `--prompt` was provided, focus the review on that instruction instead.
The shared security-gate decision is binding: reviewers must never run tests or
execute PR-controlled code when it is suspicious or inconclusive.

### 5. Rounds 2–3 — synthesize, then cross-validate

**Round 2 — candidate review (the host's main session; do not delegate).**
In Claude Code this is the main session; in Codex it is the current Codex model.
Never call Claude models for this default Codex pipeline. Explicit Claude delegation uses the
separate time-boxed workflow. The main session already holds this context; a
subagent would pay to load it again.
Merge the reviews: dedupe findings that describe the same defect, keep the sharpest
evidence of each, and record which reviewer(s) raised it. Verify every finding against
the actual diff and code yourself — drop anything you cannot anchor to a real code path,
keeping the reason. Write the result to `$WORK/candidate.md`.

**Round 3 — cross-validation.** Who validates depends on the tier:

- Default Codex pipeline — a native Codex subagent, when warranted and available.
  Frame the pass to refute the candidates and find material misses. Never use
  Claude models in this pipeline.
- `full` — both reviewers, concurrently, neither seeing the other's verdict
  (the Sonnet validator is another `model: 'sonnet', effort: 'xhigh'` workflow agent).
- `standard` — Codex only.
- `lean` / `codex` — Codex only, a second pass explicitly framed to *refute*:
  `task --model <validation-model> --effort <validation-effort> --cwd "$WORK/tree" --prompt-file "$WORK/crossvalidate.md"`.
  Select the validation pair from the Models rule above (the re-review ceiling
  for re-reviews), respecting explicit user
  model requests. Independence comes from the refutation brief and fresh pass;
  tight budgets keep Sol at `high` for both passes.
- `solo` — none.

**Skip round 3 entirely when round 2 produced no findings.** There is nothing to
validate, and an empty candidate still costs a full context load to say so.

`$WORK/crossvalidate.md` holds the candidate plus a pointer to the brief and the
worktree — **never a second copy of the diff**. Ask each validator for, per finding:

- **CONFIRM** — with the evidence that makes it real
- **REFUTE** — with the concrete counter-argument (why the code is actually correct)
- **NEEDS EVIDENCE** — plausible but unproven
- a severity challenge (over- or under-rated), and
- any **material finding both rounds missed**.

### 6. Converge on the final review

Adjudicate in the main session, with the code open:

- Confirmed by ≥1 validator and refuted by none → **include**.
- Refuted by both with a concrete counter-argument → **drop** (list under "Dropped", with the reason).
- Split verdict → re-read the code and decide yourself; state the disagreement in the output.
- New finding from a validator → include only after you verify it against the diff yourself.
- Severity is yours to set; reviewer disagreement on severity is a note, not a veto.

With a single validator (`standard` and below) a lone REFUTE is not a majority —
re-read the code and decide, rather than deferring to it.

**Round 4 — a short Fable 5.1 check (initial reviews at `full` only).** Once adjudication is drafted,
every detail exists: write `$WORK/final.md` with the surviving findings, the dropped
ones with reasons, and the split verdicts you settled. Then ask one
`model: 'fable', effort: 'medium'` workflow agent to read it (and the worktree where it
must) and return **at most ten lines**: a finding that is wrong, a severity that is
off, a material miss. Use `effort: 'high'` only when the context is well defined: a
few surviving findings, each pinned to specific code, and no open split verdicts.
It is a sanity check on a finished review, not another
reviewer — do not hand it the brief to re-review from scratch. Verify anything it
raises against the code before changing the review. Skip it when adjudication left
nothing to check.

Run at most **one** extra targeted round, and only at `full`/`standard` in Claude
Code or when a Codex-hosted review used independent reviewers, and only if
cross-validation surfaced a new `[BUG]` or `[SECURITY]` finding — scope it to
that finding alone. Then stop.

Finally, clean up:

```bash
git worktree remove --force "$WORK/tree"
git update-ref -d "refs/pr-review/<PR_NUMBER>/head"
git update-ref -d "refs/pr-review/<PR_NUMBER>/base"
git update-ref -d "refs/pr-review/<PR_NUMBER>/since" 2>/dev/null || true
```

### 7. Do not

Post any GitHub comments, use `gh pr comment`, call any GitHub write API, or modify the
working tree of the PR. This holds for every reviewer and every round. Never run
tests or any other PR-controlled code when the security gate is suspicious or
inconclusive.

Posting is deliberately somebody else's job. The **`pr-review-track`** skill turns a
review into a markdown file a human edits and arms; its `prt submit` is the only thing
in this toolbox that writes to GitHub. If the user wants the review posted, hand off to
that skill rather than reaching for `gh` yourself.

### 8. Machine-readable output (`--out <dir>`)

When `--out` is given, also write `<dir>/findings.json` — the contract `pr-review-track`
consumes to build an action file. Terminal output is unchanged; this is in addition to it.

The full schema lives in `../pr-review-track/references/findings-schema.md`. In short:

```json
{
  "schema": 1, "repo": "apache/pulsar", "pr": 26289, "head": "<sha>",
  "kind": "initial",
  "tier": "standard",
  "reviewers": ["Claude Sonnet 5.5", "Codex gpt-6.1-sol", "<actual validator/adjudicator>"],
  "coverage": "full-repo",
  "summary": "<the Summary section, as markdown>",
  "recommendedEvent": "COMMENT",
  "recommendedEventWhy": "<one line>",
  "findings": [{
    "id": "i1", "severity": "BUG", "claim": "<the one-line claim>",
    "path": "<file>", "line": 1015, "endLine": null, "side": "RIGHT", "subject": "line",
    "body": "<evidence + failure scenario, as markdown — this is what gets posted>",
    "confidence": "high", "agreement": "both reviewers", "crossValidation": "confirmed by both"
  }],
  "dropped": [{"claim": "…", "reason": "refuted because …"}]
}
```

Rules that matter:

- `head` is the commit you **read**, and the only commit `pr-review-track` will build
  permalinks against. Take it from the worktree —
  `git rev-parse refs/pr-review/<PR_NUMBER>/head` — not from a fresh `gh pr view`: if
  the author pushed while the review ran, those two disagree and every line number in
  this file belongs to the first one. `prt draft` refuses the file when `head` is
  missing, is a ref name, or is no longer the PR's head, so a mid-review push costs an
  incremental re-review (`--since <the head you read>`) rather than a draft full of
  comments pointing at code nobody looked at.
- `path` / `line` / `side` must land on a line **this PR's diff** allows a comment on.
  `node <skills>/pr-review-track/scripts/prt.mjs anchors <N>` lists them. A finding you
  cannot anchor still belongs in the file — give it `"subject": "file"` or set
  `"post": false` and explain in the body, rather than dropping it or guessing a line.
- `body` is posted verbatim. No `[SEVERITY]` prefix — the generator adds the bold claim
  line from `severity` + `claim`.
- `coverage` must say `diff-only` when the worktree was unavailable, `reviewers` must list
  only the reviewers that actually ran, and `tier` must be the tier actually used.
- **`summary` and every `body` are the two fields that reach a public pull request**, so
  write them as if a Pulsar committer who has never heard of this skill is the only
  reader — evidence, file:line, failure scenario, nothing else. Keep this pipeline's
  internal mechanics out of them: the tier, the effort, round numbers, internal roles
  (adjudicator, validator, refutation pass), the shape (`two-model`, `single-reviewer`),
  and which pass raised the finding. Those facts are not lost — they have their own
  fields. `reviewers` and `coverage` become a `**Draft produced by:**` line in the
  draft's `prt:context`, and `confidence` / `agreement` / `crossValidation` become an
  italic line above the comment; both stay on the human's machine, and `tier` stays in
  the JSON and in the terminal report below. Saying that AI
  assisted, or naming the models, is a separate matter and is fine in outgoing text —
  it is a disclosure the human makes on purpose. `pr-review-track`'s pipeline-mechanics
  lint refuses a submit whose outgoing text carries the mechanics, so a `body` written
  the wrong way costs the human a round.

## Output format

This is the **terminal report**, written for the one person running the session on
their own machine. It is not a draft comment and no part of it is posted — which is
exactly why the `Tier`, `Reviewers`, `Agreement` and `Cross-validation` lines belong
here and only here. Do not carry them into `summary` or a finding `body` (above); a
finding is not more true for having been raised in round 2.

```
## PR #<NUMBER> Review: <title>

**Author**: ...   **Changes**: +X / -Y across N files
**Tier**: <tier> (<why — budget pace, small diff, override, or degradation>)
**Reviewers**: <only those that actually ran, and in which round>
**Security gate**: clear | suspicious | inconclusive — <evidence and execution restrictions>

### Summary
<brief overall assessment>

### Findings
1. [SEVERITY] <finding> — <file>:<line if known>
   <explanation + failure scenario>
   Agreement: <which reviewers raised it>  ·  Cross-validation: confirmed / refuted / single validator

...

### Dropped candidate findings
- <finding> — refuted because <reason>   (omit the section when empty)

No issues found. ✓  (if nothing survives)
```

The **Tier** line is not decoration. A `lean` Claude Code review saw one
independent reviewer, not two; a Codex-hosted review used only the Codex
reviewers listed. The user running this review is entitled to know that before
trusting it. Never present a thinner review as a full consensus one — and if the
diff was capped or the worktree was unavailable, say that here too. The PR author
is not that reader: what reaches them is `summary` and the finding bodies, and
those are entitled to the evidence, not to the provenance.
