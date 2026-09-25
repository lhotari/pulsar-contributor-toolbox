# Running a Claude review from Codex

Use this path when the user requests Claude Code or this time-boxed skill from
a Codex session. A normal review request or a `--tier` flag does not select
Claude. The request authorizes the local review, not edits, commits, pushes,
comments, CI triggers or other publication.

## Check the local runtime

Resolve `claude` with `command -v claude` and inspect `claude --help`; use the
installed CLI's supported flags rather than a guessed version or tool name.
Codex's native agent API does not accept Claude models. Launch a fresh local
`claude -p` process instead; do not use cloud `ultrareview` or attach to an
unrelated interactive session.

Run this skill's `scripts/claude-usage.sh` and use its profile rules. A known
fresh reading from the host can be passed to the child with its timestamp;
there is no need for each lens to probe usage again. A stale-token error from
the usage endpoint alone does not prove the CLI cannot authenticate. A minimal
CLI capability call can refresh normal local authentication; retry the usage
script once if it does. Never print or copy credentials. If authentication
still fails, explain the blocker instead of repeatedly retrying. Follow the
skill's unknown-usage and high-usage rules; do not invent a reading.

If Workflow availability is unknown, make a small capability call asking the
child whether `Workflow` is in its actual callable tool list. This does not
count as a review. The review brief must explicitly instruct the child to use
one Workflow with the skill's lenses, structured outputs and adversarial
verification. Verify that it actually ran. If the CLI or Workflow is absent,
report the limitation; a solo/static fallback must be labeled as such, not as
the completed time-boxed workflow.

## Freeze the exact content and pass a bounded brief

Apply `pr-review`'s execution-surface gate before creating PR worktrees. For
committed targets, use `scripts/freeze-and-path.sh` as usual. For uncommitted
local follow-ups, freeze the starting HEAD in a separate detached worktree,
then apply an exact `git diff --no-ext-diff --binary HEAD` snapshot there.
Include intended untracked files explicitly, or report their exclusion; never
silently omit them. Do not commit, stash, reset or otherwise change the user's
worktree to obtain a review target.

Record HEAD, the overlay SHA-256, included paths and snapshot path. Verify the
snapshot matches before launch and the original worktree is unchanged after
review. Compare hashes using the same diff command and configuration: `--binary`
uses full index hashes, so its digest differs from plain `git diff`. Agents
review the frozen files and `git diff HEAD`, not an empty HEAD-to-HEAD range.
Report citations as HEAD plus overlay, not as content already in the PR commit.
When batching PRs, keep each snapshot and prior-review checklist distinct.

The brief should point to this SKILL.md, workflow-template.js, review-template.md,
the frozen targets, previous findings and dispositions, relevant investigation
context, and existing validation evidence. State the questions to challenge,
known evidence limits, time box, output destination and restrictions. Include
needed generated-source evidence from the exact validated build, or mark those
semantics unverified rather than inferring them from handwritten call sites. Pass
confidentiality and no-publication instructions to **every** lens and verifier.
Do not copy private investigation material into source files or outgoing draft
text. For confidential work, use an owner-only directory (`umask 077`) outside
source checkouts for prompts, logs and output; this overrides the default
review-file location. No tests or builds run under this read-only skill.

## Launch and supervise

This invocation shape has been exercised with the local CLI. Check flags first
and adapt paths and tool permissions to the task. Run from the frozen worktree;
pass the brief through stdin so shell quoting cannot execute its contents.
The coordinator runs on Sonnet 5 (`review_model=sonnet`); choose its effort
from the request and skill profile (`xhigh` for high or thorough reviews).

```sh
umask 077
claude -p --model "$review_model" --effort "$review_effort" \
  --no-session-persistence --no-chrome --strict-mcp-config \
  --setting-sources '' --settings '{"disableAllHooks":true}' \
  --permission-mode dontAsk \
  --tools 'Read,Glob,Grep,Bash,Workflow' \
  --allowedTools 'Read' 'Glob' 'Grep' 'Workflow' \
    'Bash(date *)' 'Bash(git diff *)' 'Bash(git show *)' \
    'Bash(git log *)' 'Bash(git status *)' 'Bash(git rev-parse *)' \
  --output-format stream-json --verbose \
  < "$review_brief" > "$review_stream" 2> "$review_stderr"
```

This excludes edit tools and inherited MCP configuration/hooks. Provide the
repository rules explicitly because settings/discovery may differ from the
interactive session. Remove task-specific secrets from the child's environment
when relevant, while preserving the normal Claude authentication mechanism.
For multiple snapshots, allow narrowly scoped `git -C <snapshot> <read-command>`
forms as needed. Do not grant unrestricted Bash or bypass permissions just to
make a review work. Compound commands containing `cd`, loops or shell plumbing
may be denied even when their individual reads are allowed: ask for individual
commands or Read/Glob/Grep instead. Record any resulting coverage limitation.

Have the child return the complete report as final text; the host saves it to
the chosen file, so Claude needs no Write permission. The child may supply the
Workflow script inline. Starting a CLI process or receiving a capability answer
is not completion: monitor its output while doing useful host-side source
checks, keep the user informed, and observe the agreed wall-clock limit. If it
overruns or fails, report completed and missing work rather than inventing a
successful review. Do not kill unrelated Claude sessions.

Parse the stream as JSON lines and inspect the final `type: result` record,
including `is_error`, permission denials and actual workflow completion. Save
its `result` text as the report; retain logs privately where needed for evidence.
Record actual models/efforts, lenses, verification results and truncation, not
just the requested configuration. The host rechecks important findings against
source and the relevant test evidence, then performs the final PR/head metadata
comparison from the skill. The child need not receive network tools for this.

## Return to PR tracking

For a committed PR review, the Codex host can convert verified findings to the
existing `pr-review --out` contract, recording the real reviewed SHA and actual
reviewers. Time-boxed profiles are not new `pr-review`/`prt --tier` options. The
tracker's normal head validation, job ownership, draft creation and human
posting gate still apply; never let the Claude child operate the tracker.

For a local overlay review, keep findings in the private report. Do not present
overlay line numbers as findings on the public PR head or generate publishable
comments from them. Respect a local-review-only workflow and existing draft
holds. Clean up only temporary snapshots owned by this review, or give their
cleanup commands; preserve the user's review worktrees. Tell the user the
verdict and link the saved report, including any limitations or remaining work.
