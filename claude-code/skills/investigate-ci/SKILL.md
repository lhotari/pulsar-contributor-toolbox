---
name: investigate-ci
description: Investigate failing GitHub Actions CI tests for a PR, a specific workflow run (by URL), or recent workflow runs. Auto-detects Maven vs Gradle for the target branch and parses failures in the right format. Downloads logs and optionally test report artifacts for deep analysis.
argument-hint: [PR_NUMBER | GH_ACTIONS_URL] [--repo owner/repo] [--artifacts] [--workflow <name>] [--job <name>] [--check-flaky-tests]
allowed-tools: Bash(gh *), Bash(git *), Bash(python3 *), Bash(unzip *), Bash(find *), Bash(grep *), Bash(xmllint *), Bash(python *), Read, Glob, Grep
---

# Investigate CI Skill

Investigate failing GitHub Actions CI for a Java project built with Maven or Gradle. Automatically detects which build tool the target branch uses, finds test failures, downloads logs and optionally test-report artifacts for deep analysis, extracts Gradle build-scan URLs when present, and ends with a summary and offer to fix.

## Argument Parsing

Parse `$ARGUMENTS`:
- First positional argument (optional): one of
  - **PR number** — digits only, e.g. `25561`
  - **GitHub Actions URL** — starts with `http://` or `https://` and contains `/actions/runs/<RUN_ID>`. Two accepted shapes:
    - `https://github.com/<owner>/<repo>/actions/runs/<RUN_ID>` — investigate the full run
    - `https://github.com/<owner>/<repo>/actions/runs/<RUN_ID>/job/<JOB_ID>` — investigate only the specified job within the run

  Detection: if the argument starts with `http://` or `https://`, treat it as a URL; else if it matches `^[0-9]+$`, treat it as a PR number; otherwise fall back to recent-runs mode and warn if the argument shape is unrecognized.

  When a URL is supplied, extract these values with `grep -oP`:
  ```bash
  OWNER=$(echo "$ARG" | grep -oP 'github\.com/\K[^/]+')
  REPO_NAME=$(echo "$ARG" | grep -oP 'github\.com/[^/]+/\K[^/]+')
  URL_RUN_ID=$(echo "$ARG" | grep -oP 'runs/\K[0-9]+')
  URL_JOB_ID=$(echo "$ARG" | grep -oP 'job/\K[0-9]+')   # empty if URL targets the whole run
  REPO="${OWNER}/${REPO_NAME}"
  ```
  A URL-derived `REPO` takes precedence over `--repo`. A URL-derived `URL_JOB_ID` takes precedence over `--job` (URL is an exact ID; `--job` is a name substring).

- `--repo <owner/repo>`: override repo (optional, defaults to current repo from `gh repo view --json nameWithOwner -q .nameWithOwner`; ignored if the first arg is a URL that already specifies the repo)
- `--artifacts`: also download test-report artifacts for deeper analysis
- `--workflow <name>`: filter to a specific workflow — matched case-insensitively against the workflow's display name or filename (substring match)
- `--job <name>`: filter to a specific job — matched case-insensitively against the job name (substring match). Overridden by a URL-supplied job ID.
- `--check-flaky-tests`: download logs for the most recent run of the specified workflow (and optionally job), **regardless of whether it passed or failed** — used to inspect tests that may be flaky

If arguments are missing or invalid, respond with usage:
```
Usage: /investigate-ci [PR_NUMBER | GH_ACTIONS_URL] [--repo owner/repo] [--artifacts] [--workflow <name>] [--job <name>] [--check-flaky-tests]

Examples:
  /investigate-ci 25561
  /investigate-ci https://github.com/apache/pulsar/actions/runs/24775322750
  /investigate-ci https://github.com/apache/pulsar/actions/runs/24775322750/job/72493182352
```

---

## Phase 1: Discover Failing Runs

### If a GitHub Actions URL is provided:

The URL already pins the run (and optionally a specific job), so skip PR-checks discovery entirely.

1. Use `URL_RUN_ID` as the single run ID to investigate. Fetch metadata to surface context and to feed Phase 1b:
   ```bash
   gh run view <URL_RUN_ID> --repo <REPO> --json databaseId,name,status,conclusion,workflowName,headBranch,headSha,event,url
   ```
   - `headBranch` → `TARGET_BRANCH` (used by Phase 1b for build-tool detection)
   - `event` → if `"pull_request"`, note that the run is PR-driven; otherwise it's a push to `headBranch` (or a scheduled/manual run)

2. If `URL_JOB_ID` is set, record it as the only job to investigate — Phase 2 filters by `databaseId == URL_JOB_ID` instead of the usual name-substring match.

3. Regardless of the run's `conclusion`, proceed. The user explicitly chose this run — do NOT skip it even if it succeeded. This is equivalent to `--check-flaky-tests` mode **for this run only**: list all jobs (or the one targeted by `URL_JOB_ID`) regardless of per-job conclusion, and download full logs. `--check-flaky-tests` on the command line still applies to any other implicit behavior but is not required when a URL is given.

### If PR number is provided:

1. Get PR info (including `baseRefName`, which Phase 1b uses for build-tool detection):
   ```bash
   gh pr view <PR_NUMBER> [--repo <repo>] --json title,headRefName,baseRefName,headRefOid,author,state,url
   ```

2. List checks for the PR:
   ```bash
   gh pr checks <PR_NUMBER> [--repo <repo>] --json name,state,link,bucket
   ```
   Filter for checks with `bucket == "fail"` or `state == "FAILURE"` or `state == "TIMED_OUT"`.

3. Extract the run IDs from the failing check links. The link format is typically:
   `https://github.com/<owner>/<repo>/actions/runs/<RUN_ID>/jobs/<JOB_ID>`
   Extract `<RUN_ID>` with: `echo "<link>" | grep -oP 'runs/\K[0-9]+'`

Capture `BASE_REF` from the PR JSON — this is the branch Phase 1b inspects.

### If no PR number (checking recent runs):

1. List recent workflow runs on the default branch:
   ```bash
   gh run list [--repo <repo>] --branch master --limit 50 --json databaseId,name,status,conclusion,workflowName,headBranch,url,createdAt
   ```
   Capture the branch being queried (default `master`) as `CURRENT_BRANCH` — Phase 1b uses it.

2. **Workflow filtering** (if `--workflow` was specified): filter runs where `workflowName` contains the given `--workflow` value, case-insensitively (substring match). Do NOT pass `--workflow` to `gh run list` directly — fetch all runs and filter in the result.

3. For each workflow name, take only the **most recent run**.

   - **Normal mode** (no `--check-flaky-tests`): if the most recent run's `conclusion` is `"success"`, skip it — it's passing. Only investigate runs that are `"failure"`, `"timed_out"`, or still `"in_progress"` with a bad conclusion.
   - **`--check-flaky-tests` mode**: take the most recent run **regardless of conclusion**, including successful ones. This is for inspecting tests in a passing run that might be flaky.

4. Collect the run IDs to investigate.

### Job filtering (if `--job` was specified)

After identifying runs to investigate, apply job filtering in Phase 2:
- In normal mode: filter `failed` jobs to those whose `name` contains the `--job` value, case-insensitively.
- In `--check-flaky-tests` mode: include **all** jobs (not just failed ones) whose `name` contains the `--job` value, case-insensitively.

---

## Phase 1b: Detect Build System

Resolve a single variable `BUILD_TOOL ∈ {gradle, maven}` by inspecting the target branch's repo root. Phases 2–4 branch on this value.

`TARGET_BRANCH` resolution, in order of the input that was provided:
- **URL input** → use `headBranch` from the `gh run view` call in Phase 1. (For PR-triggered runs the `headBranch` is the PR's head branch, which may be a fork branch — that's fine for build-tool detection because the file layout on the head is what the run actually built against.)
- **PR number** → `BASE_REF` (PR base, e.g. `master` / `branch-4.1`).
- **Recent-runs mode** → `CURRENT_BRANCH` (the `--branch` value, default `master`).

**Step 1 — authoritative: list the root tree on the target branch via the GitHub API.**

```bash
TREE=$(gh api "repos/<owner>/<repo>/contents/?ref=${TARGET_BRANCH}" --jq '.[].name' 2>/dev/null)
if echo "$TREE" | grep -qE '^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew)$'; then
  BUILD_TOOL=gradle
elif echo "$TREE" | grep -q '^pom\.xml$'; then
  BUILD_TOOL=maven
fi
```
Using `gh api` (rather than local `git`) keeps this working when the skill is invoked against `--repo <other>` or from outside a local checkout.

**Step 2 — fallback: local checkout at the CWD root.** If Step 1 returned nothing (network issue, unusual repo), check the working tree:
```bash
if ls build.gradle build.gradle.kts settings.gradle settings.gradle.kts gradlew 2>/dev/null | grep -q .; then
  BUILD_TOOL=gradle
elif [ -f pom.xml ]; then
  BUILD_TOOL=maven
fi
```

**Step 3 — last-resort name heuristic** (only if Steps 1 and 2 both yield nothing): treat `master`/`main` as `gradle`; treat `branch-3.*` and `branch-4.[012]` as `maven`. For apache/pulsar these mappings are accurate today:
- **master** → Gradle
- **branch-3.0 / branch-4.0 / branch-4.1 / branch-4.2** → Maven

This is a fallback, not the primary path — the repo-tree lookup in Step 1 is authoritative.

Announce the decision to the user once resolved:
```
Detected build tool: <gradle|maven> (branch: <TARGET_BRANCH>)
```

If no signal could be obtained at all, stop and ask the user to clarify — do not guess.

---

## Phase 2: Download and Filter Logs

For each run ID to investigate:

1. Show the run summary:
   ```bash
   gh run view <RUN_ID> [--repo <repo>] --json name,status,conclusion,jobs,url
   ```

2. List jobs to inspect:
   - **URL mode** (a GitHub Actions URL was the first argument):
     - If `URL_JOB_ID` was extracted, select exactly that job regardless of conclusion:
       ```bash
       gh run view <RUN_ID> --repo <REPO> --json jobs --jq ".jobs[] | select(.databaseId == <URL_JOB_ID>) | {id,name,conclusion,url}"
       ```
     - Otherwise list all jobs in the run (regardless of conclusion):
       ```bash
       gh run view <RUN_ID> --repo <REPO> --json jobs --jq '.jobs[] | {id,name,conclusion,url}'
       ```
   - **Normal mode** (PR number): list failed jobs:
     ```bash
     gh run view <RUN_ID> [--repo <repo>] --json jobs --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | {id,name,conclusion,url}'
     ```
   - **`--check-flaky-tests` mode**: list all jobs (regardless of conclusion):
     ```bash
     gh run view <RUN_ID> [--repo <repo>] --json jobs --jq '.jobs[] | {id,name,conclusion,url}'
     ```
   - Additional name filter: if `--job` was specified (and no `URL_JOB_ID` overrode it), narrow the result to jobs whose `name` contains the `--job` value (case-insensitive substring match). A URL-supplied `URL_JOB_ID` wins over `--job`.

3. For each selected job, download the log:
   - Normal mode:
     ```bash
     gh run view <RUN_ID> [--repo <repo>] --log-failed 2>/dev/null
     ```
   - `--check-flaky-tests` mode (or when `--job` filtering is needed): download the full log for the specific job ID via the API:
     ```bash
     GH_TOKEN=$(gh auth token)
     curl -s -L -H "Authorization: token $GH_TOKEN" \
       "https://api.github.com/repos/<owner>/<repo>/actions/jobs/<JOB_ID>/logs"
     ```
   Capture and parse the output.

4. **Filter the log for test failures — use the format that matches `BUILD_TOOL`.**

   ### Maven (`BUILD_TOOL=maven`)

   Look for lines matching these Surefire patterns:
   - `[ERROR] <TestClass>.<testMethod>  Time elapsed: ... <<< FAILURE!`
   - `[ERROR] <TestClass>.<testMethod>  Time elapsed: ... <<< ERROR!`
   - Lines starting with stack trace indicators after the failure line

   Extract:
   - The test class name
   - The test method name
   - The failure/error type (FAILURE vs ERROR)
   - The exception class (first line after the `<<<` line, e.g. `java.lang.AssertionError`)
   - The stack trace (lines from the exception class until the next `[ERROR]` or `[INFO]` line)

   ### Gradle (`BUILD_TOOL=gradle`)

   Gradle test output uses a different shape. Look for these patterns:
   - **Per-test failure header** (printed during the test run):
     ```
     <fully.qualified.TestClass> > <testMethod> FAILED
     ```
     Parameterized methods appear as `<testMethod>(arg1, arg2) FAILED`. Repeated-test / test-factory cases may add a `[N]` index (e.g. `<testMethod>[1] FAILED`).
   - **Exception line**: the next non-empty line following the header is the exception class + message, indented 4 spaces, e.g.:
     ```
         org.opentest4j.AssertionFailedError: expected: <X> but was: <Y>
     ```
   - **Stack trace**: subsequent `    at <frame>` lines, continuing until a blank line, another `FAILED`/`PASSED`/`SKIPPED` line, or a Gradle status line (any line starting with `> Task :`).
   - **Task failure line**: `> Task :<module>:test FAILED` tells you which module's `test` task failed — include the module name when grouping failures by job.
   - **End-of-run failure summary** (printed by Gradle after the task finishes):
     ```
     <TestClass> > <testMethod> FAILED
         java.lang.AssertionError at TestFile.java:42
     ```
     Parse this as a secondary source — it lists every failure even if the inline output was truncated.

   Extract per failure:
   - Fully qualified test class name
   - Test method name (including any parameterization / index suffix)
   - Exception class and message
   - Stack trace (trimmed)
   - Module name from the nearest preceding `> Task :<module>:test` line

5. **(Gradle only) Extract build-scan URLs from the log.** The setup-gradle action publishes every build's scan URL to the log via Gradle's "Publishing build scan..." step. Record at most one URL per job:
   ```bash
   grep -oE 'https://(scans\.gradle\.com|develocity\.apache\.org|ge\.apache\.org)/s/[A-Za-z0-9]+' <log> | head -1
   ```
   The same URL is also surfaced in the job's `$GITHUB_STEP_SUMMARY` (visible under "Summary" in the GitHub UI), but GitHub does not expose that markdown via a stable REST endpoint — the log is the reliable programmatic source.

   For fork PRs against `master`, `secrets.DEVELOCITY_ACCESS_KEY` is unavailable and the scan is published to **`scans.gradle.com`**. For pushes to `master` (and PRs from branches inside the repo), the key is present and the scan goes to **`develocity.apache.org`**.

6. Present the extracted failures grouped by job name (and, for Gradle, by module when multiple modules' tests ran in the same job).

---

## Phase 3: Artifact Download (only if `--artifacts` flag was given)

For each failing run:

1. List available artifacts:
   ```bash
   gh run download <RUN_ID> [--repo <repo>] --dry-run 2>/dev/null || \
   gh api repos/<owner>/<repo>/actions/runs/<RUN_ID>/artifacts --jq '.artifacts[] | {id,name,size_in_bytes}'
   ```

2. Filter for artifacts whose name looks like a test report — match `test-reports`, `tests-reports`, or (Maven-specific) `surefire`, case-insensitively.

3. For each matching artifact, download it to a temp directory:
   ```bash
   TMPDIR=$(mktemp -d)
   gh run download <RUN_ID> [--repo <repo>] --name "<ARTIFACT_NAME>" --dir "$TMPDIR"
   ```

4. Unzip any zip files found:
   ```bash
   find "$TMPDIR" -name "*.zip" -exec unzip -q {} -d "$TMPDIR" \;
   ```

5. Locate the report for each failing test — the layout differs by build tool.

   ### Maven (`BUILD_TOOL=maven`)

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

   ### Gradle (`BUILD_TOOL=gradle`)

   Gradle publishes HTML test reports by default. If the artifact ships XML-format reports too, prefer them; otherwise fall back to HTML.

   a. **Prefer XML** if present (surefire-compatible, easy to parse):
      ```bash
      find "$TMPDIR" -name "TEST-*<TestClass>*.xml" -o -name "*<TestClass>*.xml"
      ```
      If matches are found, parse `<testcase>` elements for `<failure>`/`<error>` children to extract the full stack trace and message — identical handling to the Maven XML path above.

   b. **Fall back to HTML**. The artifact layout is `{module}/build/reports/tests/test/{hash}/index.html`, with each `{hash}/` directory representing a test class. Individual per-test HTML files live inside it, and `{module}/build/reports/tests/test/index.html` at the top is the summary page.

      Locate candidate HTML files:
      ```bash
      # All per-test-class index pages (skip the top-level summary index)
      find "$TMPDIR" -path "*/build/reports/tests/test/*/index.html" -not -path "*/build/reports/tests/test/index.html"

      # Direct search for the failing class name
      grep -rl "<TestClass>" "$TMPDIR" --include="*.html" | head -20
      ```

      Read the relevant `index.html` to find the failing test class, then open the individual per-method HTML file in the same directory. These files contain the full standard output, standard error, and stack traces for the test.

   (This mirrors the HTML-report handling in `/Users/lari/.claude/skills/develocity-investigate-test-failures/SKILL.md` Phase 6.)

6. Present the relevant excerpts with context (lines before the failure, stack trace, stdout/stderr).

---

## Phase 4: Analysis and Output

Present findings in this format:

```
## CI Investigation: <PR title | "run <RUN_ID>" (when invoked with a URL) | "recent runs">

**Build tool**: <maven|gradle>    *(always present)*
**Base branch**: <TARGET_BRANCH>

### Failing Workflows
- <workflow name> — Run #<id> — <url>
  Failed jobs: <job names>
  Build scan: <URL>    *(Gradle only, when found)*

---

### Test Failures

#### <TestClass>.<testMethod>
**Job**: <job name>
**Module**: <module>    *(Gradle only)*
**Failure type**: FAILURE | ERROR
**Exception**: <exception class and message>

**Stack trace**:
```
<trimmed stack trace — first 15 lines or until first "at org.apache.pulsar" frame>
```

**Log context** (lines before failure): *(only if --artifacts and txt/HTML output found)*
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

When `BUILD_TOOL=gradle` **and** a `develocity.apache.org` scan URL was found, append:
```
- Ask me to run `/develocity-investigate-test-failures` for Failures-API drill-down on this run
```
If the scan URL is on `scans.gradle.com` (fork PR to `master`), the scan is publicly viewable in a browser but the Failures API is not available — do not add this bullet.

Do NOT make any code changes automatically. Wait for the user to ask.

---

## Notes on log parsing

When parsing `gh run view --log-failed` output, the format is:
```
<JOB_NAME>\t<STEP_NAME>\t<LOG_LINE>
```

### Maven Surefire

Failure pattern:
```
[ERROR] <ClassName>.<methodName>  Time elapsed: <N> s  <<< FAILURE!
[ERROR] <ClassName>.<methodName>  Time elapsed: <N> s  <<< ERROR!
```

The exception follows immediately on the next line (e.g., `java.lang.AssertionError: expected...`), followed by the stack trace (`\tat ...` lines). End of the exception block is signaled by an empty line or a line starting with `[` (like `[INFO]` or `[ERROR]`).

For thread dump detection (JVM hung/timeout), look for lines starting with `"main" #1 prio=` or `Full thread dump`.

### Gradle test output

Failure patterns:
```
<fully.qualified.TestClass> > <testMethod> FAILED
    <ExceptionClass>: <message>
        at <frame>
        ...

> Task :<module>:test FAILED
```

End-of-run summary (also present):
```
<TestClass> > <testMethod> FAILED
    <ExceptionClass> at <File>.java:<line>
```

Stack-trace block ends at a blank line, another `FAILED`/`PASSED`/`SKIPPED` line, or a `> Task :` status line.

### Build scans and Develocity

Build-scan URLs in the log match:
```
https://(scans\.gradle\.com|develocity\.apache\.org|ge\.apache\.org)/s/<id>
```

`add-job-summary: always` in the repo's `.github/actions/setup-gradle/action.yml` makes the URL also appear in the job's "Summary" tab, but there is no stable REST API to fetch the summary markdown — parse the log instead.

Fork PRs do not receive `secrets.DEVELOCITY_ACCESS_KEY`, so their scans go to the public `scans.gradle.com`. Pushes to `master` (and in-repo PRs) publish to `develocity.apache.org`, which the `/develocity-investigate-test-failures` skill can query via the Failures API.
