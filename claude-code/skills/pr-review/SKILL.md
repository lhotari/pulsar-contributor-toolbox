---
name: pr-review
description: Review a GitHub PR locally using its metadata and diff as context. In Claude Code, adapts a Fable-and-Codex consensus pipeline to the remaining Claude allowance. In Codex, runs a Codex-only review and never invokes Claude models. Use when asked to review a pull request, check a PR, or analyze a PR. Outputs findings to terminal only — never posts GitHub comments. Pass --out to also emit machine-readable findings for the pr-review-track skill, --since to review only what changed after a given commit, and --tier to override the Claude Code budget decision.
argument-hint: |
  <PR_NUMBER> [--repo owner/repo] [--prompt "custom instructions"] [--tier full|standard|lean|codex|solo] [--since <sha>] [--out <dir>]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(mkdir:*), Read, Write, Glob, Grep, Agent
---

# PR Review Skill

Review a GitHub pull request locally using both its metadata and diff as context.
Output all findings to the terminal only. Do not post any comments to GitHub.

Select the pipeline from the host that loaded this skill:

- **Running in Codex:** use the Codex-only pipeline below. Never invoke Claude
  Opus, Fable, the Claude `Agent` tool, or the Claude Code Codex companion. Do
  not run the Claude allowance script. This rule also applies when `--tier
  full` or `--tier standard` was passed by `pr-review-track`; those flags may
  change review depth, but never the model family.
- **Running in Claude Code:** use the budget-aware Fable/Codex pipeline. The
  Fable ↔ Codex cross-review described here applies only in Claude Code.

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
  price. So "let Opus do it inline" is usually the *cheaper* option — the
  intuition that the bigger model always costs more does not hold here.

## Step 0 — select review depth

### Codex host

Skip the budget script and use tier `codex`. Perform one thorough review in the
main session. When subagents are available, delegate an independent review to
one Codex subagent and use the main session to verify and adjudicate its
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
| `full` | Fable **and** Codex, independently | **both** validate | 2 Fable passes + Opus |
| `standard` | Fable **and** Codex, independently | Codex only | 1 Fable pass + Opus |
| `lean` | **Codex only**, `--effort xhigh` | Codex, second pass framed to refute | Opus inline only |
| `codex` | **Codex only** | Codex, varied effort as the adversary | Opus adjudicates a trimmed brief |
| `solo` | none — one Opus pass inline | none | Opus inline only |

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

On a **Codex host**, use native Codex subagents as described in step 0 and skip
the rest of this section. Do not resolve or invoke the Claude Code companion.

On a **Claude Code host**, at `full` and `standard`, launch both reviewers in the
same message so they actually run in parallel. At `lean` and `codex`, run Codex
alone — skip Reviewer A.

**Reviewer A — Claude Fable** (`full` and `standard` only):

```typescript
Agent({
  subagent_type: "general-purpose",
  model: "fable",
  name: "fable-pr-reviewer",
  description: "Fable PR review",
  prompt: `Read ${WORK}/brief.md and review PR #<N>. Repo checkout for context: ${WORK}/tree
           (read it, do not modify it). Review only — never edit files, never post to GitHub.
           Return findings in the exact format specified in the brief, and nothing else:
           no preamble, no restatement of the diff.`,
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

At `lean` and `codex`, Codex carries the review alone, so raise the effort to
`--effort xhigh`. Its quota is not the one under pressure — spend it.

Run the Codex command with `run_in_background: true`; it can take several minutes on a large
PR. Do not pass `--background` to the companion — it always runs in the foreground of its own
process, and Claude Code's background flag is what actually detaches it. Read its stdout when
it completes.

Notes:
- `/codex:review` itself is `disable-model-invocation: true`, so invoke the companion script directly.
- `review` accepts no custom focus text. If `--prompt` was given and you are on the native path,
  pass the focus to Codex with `adversarial-review --cwd "$WORK/tree" --base "refs/pr-review/<PR_NUMBER>/base" --model gpt-5.6-sol "<focus>"` instead.

**Degradation** (state it in the output, never silently skip): if the companion script is
missing or Codex is not set up, the Codex-led tiers have no reviewer — fall back to `solo`
rather than pretending; `standard` continues with Fable alone. If subagents are unavailable,
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
In Claude Code this is Opus; in Codex it is the current Codex model. Never call
Opus from a Codex host. The main session already holds this context; a subagent
would pay to load it again.
Merge the reviews: dedupe findings that describe the same defect, keep the sharpest
evidence of each, and record which reviewer(s) raised it. Verify every finding against
the actual diff and code yourself — drop anything you cannot anchor to a real code path,
keeping the reason. Write the result to `$WORK/candidate.md`.

**Round 3 — cross-validation.** Who validates depends on the tier:

- Codex host — a native Codex subagent, when warranted and available. Frame the
  pass to refute the candidates and find material misses. Never use Fable or
  Opus.
- `full` — both reviewers, concurrently, neither seeing the other's verdict.
- `standard` — Codex only.
- `lean` / `codex` — Codex only, a second pass explicitly framed to *refute*:
  `task --model gpt-5.6-sol --effort high --cwd "$WORK/tree" --prompt-file "$WORK/crossvalidate.md"`.
  At `codex`, vary that pass (a different effort, or another Codex model) so it is a
  genuinely independent look rather than the same reasoning run twice.
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
