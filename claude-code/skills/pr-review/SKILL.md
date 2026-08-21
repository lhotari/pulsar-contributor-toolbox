---
name: pr-review
description: Review a GitHub PR locally using metadata and diff as context. Runs independent Claude Fable and Codex gpt-5.6-sol reviews concurrently, synthesizes a candidate review with the default Claude model, then cross-validates it with both before converging on the final review. Use when asked to review a pull request, check a PR, or analyze a PR. Outputs findings to terminal only — never posts GitHub comments. Pass --out to also emit machine-readable findings for the pr-review-track skill, and --since to review only what changed after a given commit.
argument-hint: |
  <PR_NUMBER> [--repo owner/repo] [--prompt "custom instructions"] [--solo] [--since <sha>] [--out <dir>]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(mkdir:*), Read, Write, Glob, Grep, Agent
---

# PR Review Skill

Review a GitHub pull request locally using both its metadata and diff as context.
Output all findings to the terminal only. Do not post any comments to GitHub.

The default path is a **multi-model consensus review**: two independent reviewers
(Claude Fable and Codex `gpt-5.6-sol`) run concurrently, the default Claude model merges
their output into a *candidate* review, both reviewers then cross-validate that candidate,
and only findings that survive make it into the final review.

## Steps

### 1. Identify the PR and options

- In Claude Code slash-command usage, parse `$ARGUMENTS`:
  - Extract the PR number (required, first positional argument)
  - Extract `--repo <owner/repo>` if provided (pass as `--repo` flag to `gh` commands)
  - Extract `--prompt <text>` if provided (use as custom review focus)
  - Extract `--solo` if provided (skip the multi-model pipeline; do steps 2 and 6 only)
  - Extract `--since <sha>` if provided (review only `<sha>..<head>` — an incremental re-review)
  - Extract `--out <dir>` if provided (also write machine-readable findings there; see step 8)
- In Codex or natural-language usage, infer the PR number, repository, and review focus from the user's request.
  - Accept PR numbers, GitHub PR URLs, and phrases such as "review PR 123".
  - If the repository is not provided, use the current git remote when it is clearly a GitHub repository.
- If no PR number can be found, respond: "Usage: /pr-review <PR_NUMBER> [--repo owner/repo] [--prompt 'custom instructions'] [--solo] [--since <sha>] [--out <dir>]" and stop.

### 2. Gather shared context

Every reviewer must see the *same* input, so collect it once.

```bash
gh pr view <PR_NUMBER> [--repo <owner/repo>] --json title,body,labels,comments,author,additions,deletions,changedFiles,baseRefName,headRefOid
gh pr diff <PR_NUMBER> [--repo <owner/repo>]
```

Then set up a scratch directory and, when the PR belongs to the repository you are in, a
read-only worktree at the PR head so reviewers get **full repo context**, not just the diff:

```bash
WORK="${TMPDIR:-/tmp}/pr-review-<PR_NUMBER>"; mkdir -p "$WORK"
git fetch <remote> --force \
  "pull/<PR_NUMBER>/head:refs/pr-review/<PR_NUMBER>/head" \
  "<baseRefName>:refs/pr-review/<PR_NUMBER>/base"
git worktree add --detach "$WORK/tree" "refs/pr-review/<PR_NUMBER>/head"
```

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

Write the shared brief to `$WORK/brief.md`: PR title/body/labels, author, change stats,
existing comments worth knowing, the full diff, the custom `--prompt` focus if given, the
finding format from step 4, and the hard rule that this is review-only — no edits, no
`gh pr comment`, no GitHub write APIs.

### 3. Round 1 — two independent reviews, concurrently

**Launch both in the same message** so they actually run in parallel.

**Reviewer A — Claude Fable** (`Task` in harnesses where the tool is named that):

```typescript
Agent({
  subagent_type: "general-purpose",
  model: "fable",
  name: "fable-pr-reviewer",
  description: "Fable PR review",
  prompt: `Read ${WORK}/brief.md and review PR #<N>. Repo checkout for context: ${WORK}/tree
           (read it, do not modify it). Review only — never edit files, never post to GitHub.
           Return findings in the exact format specified in the brief.`,
  run_in_background: true
})
```

**Reviewer B — Codex `gpt-5.6-sol`**, via the Codex plugin's review runtime. Resolve the
companion script first (the install path is version-stamped):

```bash
CODEX_COMPANION="$(ls -1dt "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)"
[ -n "$CODEX_COMPANION" ] || CODEX_COMPANION="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
```

With a worktree, use Codex's native reviewer (best quality — it walks the repo itself):

```bash
node "$CODEX_COMPANION" review --cwd "$WORK/tree" --base "refs/pr-review/<PR_NUMBER>/base" --model gpt-5.6-sol
```

Without a worktree — or when the native reviewer rejects the target — fall back to a
read-only Codex task over the brief (omitting `--write` keeps the sandbox read-only):

```bash
node "$CODEX_COMPANION" task --model gpt-5.6-sol --effort high --prompt-file "$WORK/brief.md"
```

Run the Codex command with `run_in_background: true`; it can take several minutes on a large
PR. Do not pass `--background` to the companion — it always runs in the foreground of its own
process, and Claude Code's background flag is what actually detaches it. Read its stdout when
it completes.

Notes:
- `/codex:review` itself is `disable-model-invocation: true`, so invoke the companion script directly.
- `review` accepts no custom focus text. If `--prompt` was given and you are on the native path,
  pass the focus to Codex with `adversarial-review --cwd "$WORK/tree" --base "refs/pr-review/<PR_NUMBER>/base" --model gpt-5.6-sol "<focus>"` instead.

**Degradation** (state it in the output, never silently skip): if the companion script is
missing or Codex is not set up, continue with Fable + the default model. If subagents are
unavailable (e.g. running inside Codex), do the single-model review of step 6 directly.

### 4. Finding format (all reviewers, all rounds)

```
[SEVERITY] <one-line claim> — <file>:<line>
Evidence: <the code path or quoted lines that show it>
Failure scenario: <concrete inputs/state → wrong output, crash, or breakage>
Confidence: high | medium | low
```

Severity levels: `[BUG]` `[SECURITY]` `[INTENT MISMATCH]` `[QUALITY]`

Each reviewer covers: intent vs implementation (does the diff achieve what the description
claims?), bugs and logic errors, security vulnerabilities, and code quality worth flagging.
If a custom `--prompt` was provided, focus the review on that instruction instead.

### 5. Rounds 2–3 — synthesize, then cross-validate

**Round 2 — candidate review (default Claude model, in the main session; do not delegate).**
Merge both reviews: dedupe findings that describe the same defect, keep the sharpest evidence
of each, and record which reviewer(s) raised it. Verify every finding against the actual diff
and code yourself — drop anything you cannot anchor to a real code path, keeping the reason.
Write the result to `$WORK/candidate.md`.

**Round 3 — cross-validation.** Send the candidate to *both* reviewers concurrently (same
launch pattern as step 3, with the Codex side as `task --model gpt-5.6-sol --effort high
--cwd "$WORK/tree" --prompt-file "$WORK/crossvalidate.md"`). Ask each for, per finding:

- **CONFIRM** — with the evidence that makes it real
- **REFUTE** — with the concrete counter-argument (why the code is actually correct)
- **NEEDS EVIDENCE** — plausible but unproven
- a severity challenge (over- or under-rated), and
- any **material finding both rounds missed**.

Each validator sees the candidate, the diff, and the checkout — never the other validator's verdict.

### 6. Converge on the final review

Adjudicate in the main session, with the code open:

- Confirmed by ≥1 validator and refuted by none → **include**.
- Refuted by both with a concrete counter-argument → **drop** (list under "Dropped", with the reason).
- Split verdict → re-read the code and decide yourself; state the disagreement in the output.
- New finding from a validator → include only after you verify it against the diff yourself.
- Severity is yours to set; reviewer disagreement on severity is a note, not a veto.

Run at most **one** extra targeted round, and only if cross-validation surfaced a new
`[BUG]` or `[SECURITY]` finding — scope it to that finding alone. Then stop.

Finally, clean up:

```bash
git worktree remove --force "$WORK/tree"
git update-ref -d "refs/pr-review/<PR_NUMBER>/head"
git update-ref -d "refs/pr-review/<PR_NUMBER>/base"
git update-ref -d "refs/pr-review/<PR_NUMBER>/since" 2>/dev/null || true
```

### 7. Do not

Post any GitHub comments, use `gh pr comment`, call any GitHub write API, or modify the
working tree of the PR. This holds for every reviewer and every round.

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
  "reviewers": ["Claude Fable", "Codex gpt-5.6-sol", "<adjudicator>"],
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

- `path` / `line` / `side` must land on a line **this PR's diff** allows a comment on.
  `node <skills>/pr-review-track/scripts/prt.mjs anchors <N>` lists them. A finding you
  cannot anchor still belongs in the file — give it `"subject": "file"` or set
  `"post": false` and explain in the body, rather than dropping it or guessing a line.
- `body` is posted verbatim. No `[SEVERITY]` prefix — the generator adds the bold claim
  line from `severity` + `claim`.
- `coverage` must say `diff-only` when the worktree was unavailable, and `reviewers` must
  list only the reviewers that actually ran.

## Output format

```
## PR #<NUMBER> Review: <title>

**Author**: ...   **Changes**: +X / -Y across N files
**Reviewers**: Claude Fable · Codex gpt-5.6-sol · synthesized and adjudicated by <default model>

### Summary
<brief overall assessment>

### Findings
1. [SEVERITY] <finding> — <file>:<line if known>
   <explanation + failure scenario>
   Agreement: both / Fable only / Codex only  ·  Cross-validation: confirmed by both / split (<who, why>)

...

### Dropped candidate findings
- <finding> — refuted because <reason>   (omit the section when empty)

No issues found. ✓  (if nothing survives)
```

If a reviewer was unavailable or ran diff-only without repo context, say so under
**Reviewers** — a thinner review must never be presented as a full consensus one.
