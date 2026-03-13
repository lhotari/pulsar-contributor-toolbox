---
name: investigate-ci
description: Investigate failing GitHub Actions CI tests for a PR or recent workflow runs. Downloads logs and optionally surefire reports to find Java/Maven test failures and their stack traces.
argument-hint: [PR_NUMBER] [--repo owner/repo] [--artifacts] [--workflow <name>]
allowed-tools: Bash(gh *), Bash(python3 *), Bash(unzip *), Bash(find *), Bash(grep *), Bash(xmllint *), Bash(python *), Read, Glob, Grep
---

# Investigate CI Skill

Investigate failing GitHub Actions CI for a Maven/Java project. Finds test failures, downloads logs and optionally surefire reports for deep analysis. Ends with a summary and offer to fix.

## Argument Parsing

Parse `$ARGUMENTS`:
- First positional argument: PR number (optional)
- `--repo <owner/repo>`: override repo (optional, defaults to current repo from `gh repo view --json nameWithOwner -q .nameWithOwner`)
- `--artifacts`: also download surefire report artifacts for deeper analysis
- `--workflow <name>`: filter to a specific workflow name or filename (optional)

If arguments are missing or invalid, respond with usage:
```
Usage: /investigate-ci [PR_NUMBER] [--repo owner/repo] [--artifacts] [--workflow <name>]
```

---

## Phase 1: Discover Failing Runs

### If PR number is provided:

1. Get PR info:
   ```bash
   gh pr view <PR_NUMBER> [--repo <repo>] --json title,headRefName,headRefOid,author,state,url
   ```

2. List checks for the PR:
   ```bash
   gh pr checks <PR_NUMBER> [--repo <repo>] --json name,state,link,bucket
   ```
   Filter for checks with `bucket == "fail"` or `state == "FAILURE"` or `state == "TIMED_OUT"`.

3. Extract the run IDs from the failing check links. The link format is typically:
   `https://github.com/<owner>/<repo>/actions/runs/<RUN_ID>/jobs/<JOB_ID>`
   Extract `<RUN_ID>` with: `echo "<link>" | grep -oP 'runs/\K[0-9]+'`

### If no PR number (checking recent runs):

1. List recent workflow runs on the default branch:
   ```bash
   gh run list [--repo <repo>] --branch master --limit 20 --json databaseId,name,status,conclusion,workflowName,headBranch,url,createdAt
   ```
   If `--workflow` was specified, add `--workflow <name>`.

2. For each workflow, take only the **most recent run**. If its `conclusion` is `"success"`, skip it — it's passing. Only investigate runs that are `"failure"`, `"timed_out"`, or still `"in_progress"` with a bad conclusion.

3. Collect the failing run IDs.

---

## Phase 2: Download and Filter Logs

For each failing run ID:

1. Show the run summary:
   ```bash
   gh run view <RUN_ID> [--repo <repo>] --json name,status,conclusion,jobs,url
   ```

2. List failed jobs in the run:
   ```bash
   gh run view <RUN_ID> [--repo <repo>] --json jobs --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | {id,name,conclusion,url}'
   ```

3. For each failed job, download the log:
   ```bash
   gh run view <RUN_ID> [--repo <repo>] --log-failed 2>/dev/null
   ```
   This outputs all failed-step logs to stdout. Capture and parse it.

   **Alternative if `--log-failed` doesn't give enough detail**, download the full job log via the API. Get a GitHub token:
   ```bash
   GH_TOKEN=$(gh auth token)
   ```
   Then for each job ID:
   ```bash
   curl -s -L -H "Authorization: token $GH_TOKEN" \
     "https://api.github.com/repos/<owner>/<repo>/actions/jobs/<JOB_ID>/logs"
   ```

4. **Filter the log for Maven Surefire test failures:**

   Look for lines matching these patterns:
   - `[ERROR] <TestClass>.<testMethod>  Time elapsed: ... <<< FAILURE!`
   - `[ERROR] <TestClass>.<testMethod>  Time elapsed: ... <<< ERROR!`
   - Lines starting with stack trace indicators after the failure line

   Extract:
   - The test class name
   - The test method name
   - The failure/error type (FAILURE vs ERROR)
   - The exception class (first line after the `<<<` line, e.g., `java.lang.AssertionError`)
   - The stack trace (lines from the exception class until the next `[ERROR]` or `[INFO]` line)

   Present the extracted failures grouped by job name.

---

## Phase 3: Artifact Download (only if `--artifacts` flag was given)

For each failing run:

1. List available artifacts:
   ```bash
   gh run download <RUN_ID> [--repo <repo>] --dry-run 2>/dev/null || \
   gh api repos/<owner>/<repo>/actions/runs/<RUN_ID>/artifacts --jq '.artifacts[] | {id,name,size_in_bytes}'
   ```

2. Filter for artifacts whose name contains `test` and (`surefire` or `reports`) — case-insensitive. Also match `test-reports` or `tests-reports`.

3. For each matching artifact, download it to a temp directory:
   ```bash
   TMPDIR=$(mktemp -d)
   gh run download <RUN_ID> [--repo <repo>] --name "<ARTIFACT_NAME>" --dir "$TMPDIR"
   ```

4. Unzip any zip files found:
   ```bash
   find "$TMPDIR" -name "*.zip" -exec unzip -q {} -d "$TMPDIR" \;
   ```

5. For each failing test found in Phase 2, search for its surefire output:

   a. **Find the `.txt` report** (stdout/stderr during the test run):
      ```bash
      find "$TMPDIR" -name "*<TestClass>*" -o -name "*<testMethod>*" | grep -E '\.(txt|xml)$'
      ```
      The txt file is typically named `TEST-<fully.qualified.TestClass>-output.txt` or similar.

   b. **Find the surefire XML**:
      ```bash
      find "$TMPDIR" -name "TEST-*<TestClass>*.xml"
      ```

   c. Read the `.txt` output file — it contains everything printed to stdout/stderr during the test. Look at lines **before** the failure for context clues (thread dumps, OOM indicators, connection errors, etc.).

   d. Read the surefire XML — it contains the `<failure>` or `<error>` element with the full stack trace, plus `<system-out>` and `<system-err>`. Parse the `<failure message="...">` text for the exception and the full stack trace inside the element.

   Present the relevant excerpts with context.

---

## Phase 4: Analysis and Output

Present findings in this format:

```
## CI Investigation: <PR title or "recent runs">

### Failing Workflows
- <workflow name> — Run #<id> — <url>
  Failed jobs: <job names>

---

### Test Failures

#### <TestClass>.<testMethod>
**Job**: <job name>
**Failure type**: FAILURE | ERROR
**Exception**: <exception class and message>

**Stack trace**:
```
<trimmed stack trace — first 15 lines or until first "at org.apache.pulsar" frame>
```

**Log context** (lines before failure): *(only if --artifacts and txt file found)*
```
<last 20 lines before the test failure in the output log>
```

**Root cause assessment**: <1-2 sentence analysis of what likely caused this>

---

*(repeat for each test failure)*

### Summary
<Overall assessment: flaky test, real bug, environment issue, etc.>
```

---

## Phase 5: Offer Next Steps

After presenting findings, always end with:

```
---
**Next steps:**
- Ask me to **fix** a specific test failure: e.g., "fix the <TestClass>.<testMethod> failure"
- Ask me to **investigate deeper** a specific failure (I'll read more log context)
- Ask me to **skip this test** if it's a known flake
- Ask me to **open an issue** to track this failure
```

Do NOT make any code changes automatically. Wait for the user to ask.

---

## Notes on log parsing

When parsing `gh run view --log-failed` output, the format is:
```
<JOB_NAME>\t<STEP_NAME>\t<LOG_LINE>
```

Maven Surefire failure pattern to match:
```
[ERROR] <ClassName>.<methodName>  Time elapsed: <N> s  <<< FAILURE!
[ERROR] <ClassName>.<methodName>  Time elapsed: <N> s  <<< ERROR!
```

The exception follows immediately on the next line (e.g., `java.lang.AssertionError: expected...`), followed by the stack trace (`\tat ...` lines).

End of exception block is signaled by an empty line or a line starting with `[` (like `[INFO]` or `[ERROR]`).

For thread dump detection (JVM hung/timeout), look for lines starting with `"main" #1 prio=` or `Full thread dump`.
