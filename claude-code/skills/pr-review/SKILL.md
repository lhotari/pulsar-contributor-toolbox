---
name: pr-review
description: Review a GitHub PR locally using metadata and diff as context. Use when asked to review a pull request, check a PR, or analyze a PR. Outputs findings to terminal only — never posts GitHub comments.
argument-hint: <PR_NUMBER> [--repo owner/repo] [--prompt "custom instructions"]
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*)
---

# PR Review Skill

Review a GitHub pull request locally using both its metadata and diff as context.
Output all findings to the terminal only. Do not post any comments to GitHub.

## Steps

1. **Parse arguments** from $ARGUMENTS:
   - Extract the PR number (required, first positional argument)
   - Extract `--repo <owner/repo>` if provided (pass as `--repo` flag to `gh` commands)
   - Extract `--prompt <text>` if provided (use as custom review focus)
   - If no PR number is found, respond: "Usage: /pr-review <PR_NUMBER> [--repo owner/repo] [--prompt 'custom instructions']" and stop.

2. **Fetch PR metadata** using:
   ```bash
   gh pr view <PR_NUMBER> [--repo <owner/repo>] --json title,body,labels,comments,author,additions,deletions,changedFiles
   ```

3. **Fetch PR diff** using:
   ```bash
   gh pr diff <PR_NUMBER> [--repo <owner/repo>]
   ```

4. **Review the PR** using both the metadata and the diff:
   - Use the title, body, and labels to understand the **stated intent** of the PR
   - Use the diff to evaluate the **actual implementation**
   - Use any existing comments for additional context

5. **Output findings to terminal** covering:
   - **Intent vs implementation**: Does the diff actually achieve what the description says?
   - **Bugs or logic errors**
   - **Security vulnerabilities**
   - **Code quality issues** worth flagging
   - **Summary**: A brief overall assessment

   If a custom `--prompt` was provided, focus the review on that instruction instead.

6. **Do not** post any GitHub comments, use `gh pr comment`, or call any GitHub write APIs.

## Output format

```
## PR #<NUMBER> Review: <title>

**Author**: ...   **Changes**: +X / -Y across N files

### Summary
<brief overall assessment>

### Findings
1. [SEVERITY] <finding> — <file>:<line if known>
   <explanation>

...

No issues found. ✓  (if nothing to report)
```

Severity levels: `[BUG]` `[SECURITY]` `[INTENT MISMATCH]` `[QUALITY]`
