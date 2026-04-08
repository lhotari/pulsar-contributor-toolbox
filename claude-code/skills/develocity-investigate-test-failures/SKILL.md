---
name: develocity-investigate-test-failures
description: Investigate test failures for a project using the Develocity REST API. Queries failed builds, extracts test and build failures with stacktraces.
argument-hint: [--days N] [--max N] [--tag <tag>]
allowed-tools: Bash(curl *), Bash(jq *), Bash(python3 *), Bash(gh *), Bash(unzip *), Bash(find *), Read, Glob, Grep
---

# Develocity Investigate Test Failures

Query the Develocity REST API to find recent failed builds for a project, extract test and build failures with stacktraces, and present a structured report. Optionally drill into specific failures using GitHub Actions artifacts.

## Phase 1: Parse Arguments and Validate Environment

Parse `$ARGUMENTS`:
- `--days N`: how many days back to search (default: 7)
- `--max N`: maximum number of failed builds to fetch (default: 10)
- `--tag <tag>`: additional tag filter (optional)

If arguments are missing or invalid, respond with usage:
```
Usage: /develocity-investigate-test-failures [--days N] [--max N] [--tag <tag>]
```

Validate required environment variables. If any are missing, print an error and stop:
```bash
: "${DEVELOCITY_SERVER:?DEVELOCITY_SERVER is not set}"
: "${DEVELOCITY_TOKEN:?DEVELOCITY_TOKEN is not set}"
: "${DEVELOCITY_PROJECT:?DEVELOCITY_PROJECT is not set}"
```

Set defaults:
```bash
DAYS=${DAYS:-7}
MAX=${MAX:-10}
```

---

## Phase 2: Query Failed Builds

Build the search query. The Develocity advanced search syntax uses space-separated field filters:

```
project:${DEVELOCITY_PROJECT} buildOutcome:failed buildStartTime>-${DAYS}d
```

If `--tag` was specified, append `tag:${TAG}` to the query.

Fetch failed builds with inline `gradleAttributes` model to avoid N+1 calls:

```bash
QUERY="project:${DEVELOCITY_PROJECT} buildOutcome:failed buildStartTime>-${DAYS}d"
# append tag filter if specified
if [ -n "${TAG}" ]; then
  QUERY="${QUERY} tag:${TAG}"
fi

curl -s -f \
  -H "Authorization: Bearer ${DEVELOCITY_TOKEN}" \
  -H "Accept: application/json" \
  "${DEVELOCITY_SERVER}/api/builds?$(python3 -c "import urllib.parse; print(urllib.parse.urlencode({'query': '${QUERY}', 'maxBuilds': ${MAX}, 'models': 'gradleAttributes'}))")" \
  -o "$TMPDIR/builds.json"
```

Check for errors:
- If curl fails with a non-zero exit code, check the HTTP status and report the error.
- If the response is an empty array `[]`, report: "No failed builds found for project '${DEVELOCITY_PROJECT}' in the last ${DAYS} days." and suggest adjusting `--days` or `--tag`.

Display a summary of found builds:
```bash
jq -r '.[] | "- \(.id) | \(.buildToolType) | \((.availableAt / 1000) | strftime("%Y-%m-%d %H:%M:%S UTC"))"' "$TMPDIR/builds.json"
```

---

## Phase 3: Get Failures for Each Build

For each build, call the Failures API (Beta) to get detailed build and test failures:

```bash
BUILD_ID="<id from builds.json>"
curl -s -f \
  -H "Authorization: Bearer ${DEVELOCITY_TOKEN}" \
  -H "Accept: application/json" \
  "${DEVELOCITY_SERVER}/api/failures/builds/${BUILD_ID}" \
  -o "$TMPDIR/failures_${BUILD_ID}.json"
```

Extract failures based on `buildToolType` from the builds response. For Gradle builds:
```bash
# Test failures
jq '.gradle.testFailures // []' "$TMPDIR/failures_${BUILD_ID}.json"

# Build failures
jq '.gradle.buildFailures // []' "$TMPDIR/failures_${BUILD_ID}.json"
```

For Maven builds (if any):
```bash
jq '.maven.testFailures // []' "$TMPDIR/failures_${BUILD_ID}.json"
jq '.maven.buildFailures // []' "$TMPDIR/failures_${BUILD_ID}.json"
```

**Fallback**: If the Failures API returns 404 (feature not enabled), fall back to the build-level `hasFailed` flag from `gradleAttributes` already fetched in Phase 2. Report that detailed failures are unavailable and suggest checking the build scan directly.

Also extract metadata from the `gradleAttributes` model (already inlined in builds.json):
```bash
# GitHub Actions build URL
jq -r '.models.gradleAttributes.model.links[] | select(.label == "GitHub Actions build") | .url' <<< "$BUILD_JSON"

# Custom values: CI workflow, CI run, Git branch, Git commit id
jq -r '.models.gradleAttributes.model.values[] | select(.name == "CI workflow" or .name == "CI run" or .name == "Git branch" or .name == "Git commit id") | "\(.name): \(.value)"' <<< "$BUILD_JSON"
```

---

## Phase 4: Present Results

Present findings in this format:

```
## Develocity Test Failure Investigation

**Project**: ${DEVELOCITY_PROJECT}
**Server**: ${DEVELOCITY_SERVER}
**Period**: Last N days | **Failed builds found**: M

---

### Build <BUILD_ID>
**Build scan**: ${DEVELOCITY_SERVER}/s/<BUILD_ID>
**GitHub Actions**: <GitHub Actions build link>
**CI workflow**: <workflow name> | **CI run**: <run id>
**Branch**: <branch> | **Commit**: <commit id>
**Started**: <timestamp> | **Duration**: <duration>
**Tags**: <tags>

#### Test Failures (<count>)

##### <suiteName>.<testName>
**Work unit**: <workUnitName>
**Message**:
```
<message>
```

**Stack trace**:
```
<stacktrace (first 30 lines)>
```

---

#### Build Failures (<count>)

##### <header>
**Message**: <message>
```
<relevantLog (first 20 lines)>
```

---

*(repeat for each build)*

### Summary
- **Total builds examined**: M
- **Total test failures**: N
- **Total build failures**: K
- **Unique failing test classes**: L
```

After collecting all failures, identify tests that fail across multiple builds by grouping on `suiteName + testName`. Report these as potential flaky tests or persistent failures.

---

## Phase 5: Offer Next Steps

After presenting findings, always end with:

```
---
**Next steps:**
- Ask me to **investigate a specific test failure deeper** (downloads test reports from GitHub Actions artifacts)
- Ask me to **check if a test is flaky** by looking at its pass/fail history across builds
- Ask me to **find the source code** for a failing test and suggest a fix
- Ask me to **open an issue** to track a recurring failure
```

Do NOT make any code changes automatically. Wait for the user to ask.

---

## Phase 6: Deeper Analysis (on user request)

When the user asks to investigate a specific test failure deeper:

1. **Extract the GitHub Actions run ID** from the build metadata collected in Phase 3:
   - From the `CI run` custom value in `gradleAttributes.values`, OR
   - Parse from the `GitHub Actions build` link URL (format: `https://github.com/{owner}/{repo}/actions/runs/{RUN_ID}`)
   ```bash
   RUN_ID=$(echo "${GH_ACTIONS_URL}" | grep -oP 'runs/\K[0-9]+')
   ```

2. **Extract the repo** from the `GitHub Actions build` link:
   ```bash
   REPO=$(echo "${GH_ACTIONS_URL}" | grep -oP 'github.com/\K[^/]+/[^/]+')
   ```

3. **List available artifacts** for the run:
   ```bash
   gh api "repos/${REPO}/actions/runs/${RUN_ID}/artifacts" --jq '.artifacts[] | select(.name | test("test-reports"; "i")) | {id, name, size_in_bytes}'
   ```

4. **Download matching test report artifacts**:
   ```bash
   TMPDIR_ARTIFACTS=$(mktemp -d)
   gh run download "${RUN_ID}" --repo "${REPO}" --name "<ARTIFACT_NAME>" --dir "$TMPDIR_ARTIFACTS"
   ```

5. **Search for test reports** in the downloaded artifacts. The artifact contains Gradle HTML test reports. If XML files are present (future improvement), prefer those.

   **Check for XML reports first** (preferred if available):
   ```bash
   find "$TMPDIR_ARTIFACTS" -name "TEST-*<TestClass>*.xml" -o -name "*<TestClass>*.xml"
   ```
   If XML files are found, parse them for `<testcase>` elements with `<failure>` or `<error>` children to extract the full stack trace and message.

   **Fall back to HTML reports** (current format):
   The artifact structure is: `{module}/build/reports/tests/test/{hash}/index.html` where each `{hash}/` directory is a test class, and individual test HTML files are within it. The top-level `{module}/build/reports/tests/test/index.html` is the summary page.

   To find HTML reports for a specific test class:
   ```bash
   # Find all index.html files in test report directories
   find "$TMPDIR_ARTIFACTS" -path "*/build/reports/tests/test/*/index.html" -not -path "*/build/reports/tests/test/index.html"
   ```

   Read the relevant `index.html` files to find the failing test class. Each test class directory's `index.html` lists all test methods with their outcomes. The individual test HTML files (non-index files in the same directory) contain the full test output log and stack trace.

   ```bash
   # Search HTML files for the failing test class name
   grep -rl "<TestClass>" "$TMPDIR_ARTIFACTS" --include="*.html" | head -20
   ```

   Once the right HTML file is found, read it and extract the test output/log from the HTML content. The HTML contains the full standard output, standard error, and stack traces for the test.

6. Present the detailed findings with log context from the test reports.

---

## Notes

- The build scan URL format is `${DEVELOCITY_SERVER}/s/<BUILD_ID>`
- The Failures API (`/api/failures/builds/{id}`) is in Beta and may change in future versions
- The `models` query parameter on `/api/builds` avoids N+1 API calls by inlining model data
- TestFailure schema: `{ id: { workUnitName, suiteName, testName }, message, stacktrace }`
- BuildFailure schema: `{ header, message, relevantLog, taskPath, stacktrace }`
- Query syntax reference: `project:<name>`, `buildOutcome:failed`, `tag:<tag>`, `buildStartTime>-Nd`
- All `jq` filters use `// []` or `// empty` to handle null fields gracefully
