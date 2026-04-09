---
name: fix-pulsar-flaky-tests
description: Fix flaky tests in apache/pulsar. Investigates Develocity failures, analyzes root causes using git blame, fixes tests, verifies with invocationCount, and creates PRs.
argument-hint: [--days N] [--max N] [--tag <tag>]
allowed-tools: Bash(*), Read, Write, Edit, Glob, Grep, Agent, Skill, SendMessage, WebFetch, TaskCreate, TaskUpdate
---

# Fix Pulsar Flaky Tests

End-to-end skill for investigating and fixing flaky tests in the Apache Pulsar project. Covers discovery, root cause analysis, fix implementation, verification, and PR creation.

## Overview

This skill orchestrates the full lifecycle of fixing flaky tests:
1. **Discover** failing tests via Develocity API (use `/develocity-investigate-test-failures`)
2. **Analyze** root causes by reading test code, production code, and git history
3. **Fix** the flaky tests while preserving original test intent
4. **Verify** fixes with `@Test(invocationCount=10)` (temporary, remove before PR)
5. **Create PRs** using the Pulsar PR template format

## Phase 1: Discover Flaky Tests

Use the `/develocity-investigate-test-failures` skill to query recent failures. Only consider builds matching:
- `Git repository` = `https://github.com/apache/pulsar`
- `Git branch` = `master`

Group related failures (same class, same module) for combined PRs. Unrelated failures get separate PRs.

Check for existing GitHub issues:
```bash
gh issue list --repo apache/pulsar --search "<testMethodName>" --state open --limit 3
```

## Phase 2: Root Cause Analysis

For each failing test, perform deep analysis in this order:

### 2a. Read the test code
- Find the test file using Glob/Grep
- Read the FULL test method, setup/teardown, and base class
- Understand what the test is ACTUALLY testing — the test name and assertions tell the story

### 2b. Git blame analysis (CRITICAL)
This step is mandatory. Understanding the test's history prevents breaking the original intent.

```bash
# Find who wrote the test and when
git blame <test-file> -L <start>,<end>

# Read the original commit to understand WHY the test was written
git log -p <commit-hash> --follow -- <test-file>

# Check if there were previous flakiness fixes
git log --all --oneline -- <test-file> | grep -i "flak\|fix.*test\|stab"
```

Key questions to answer:
- Was the test written to reproduce a specific bug? (check linked PR/issue)
- Was the test previously modified to fix flakiness? What changed?
- Are there comments explaining why certain assertions or delays exist?

### 2c. Read the production code under test
- Understand the async/sync guarantees of the code being tested
- Identify race conditions, timing dependencies, or state leaks

### 2d. Common flaky test patterns in Pulsar

| Pattern | Symptom | Typical Fix |
|---------|---------|-------------|
| **Async operation not awaited** | Assertion fails intermittently | Wrap in `Awaitility.await().untilAsserted()` |
| **EmbeddedChannel pending tasks** | Race in Netty handler tests | Add `channel.runPendingTasks()` between operations |
| **Mockito stubbing interference** | `UnfinishedStubbingException` | Move stubbing before `start()` / ensure thread safety |
| **Test isolation / shared state** | Wrong counts, stale data | Use unique names, clean up state, or add `updateAll()` |
| **Non-deterministic ordering** | Assertion depends on HashMap iteration | Fix data setup to be deterministic, or use order-independent assertions |
| **Insufficient timeout** | `ConditionTimeoutException` after N seconds | Increase timeout AND investigate why operation is slow |
| **Failover delay in tests** | Consumer notifications arrive late | Set `activeConsumerFailoverDelayTimeMillis=0` in test config |
| **Ledger roll race** | `ledgerCache.size()` wrong | Await `ledger.ledgers.size()` before reading |
| **Compacted ledger corruption** | Broker crash-loop on restart | Increase timeout, add logging, handle container restarts |

## Phase 3: Fix Implementation

### Rules
1. **Preserve test intent** — the fix must test the same scenario as the original
2. **Fix the ROOT CAUSE** — don't just retry or increase timeouts blindly
3. **Minimal changes** — don't refactor surrounding code
4. **Don't weaken assertions** — replacing `assertEquals(expected, actual)` with `assertTrue(actual <= expected)` is almost always wrong. If the count is wrong, find out WHY.

### Anti-patterns to avoid
- Replacing exact assertions with range checks (hides real bugs)
- Adding `Thread.sleep()` instead of proper synchronization
- Removing assertions that "sometimes fail"
- Changing test semantics (e.g., making async what was intentionally sync)
- Adding `@Test(enabled = false)` or `@Ignore`

### Verification
Add `@Test(invocationCount = 10)` temporarily to verify the fix:

```bash
# Unit tests
./gradlew :<module>:test --tests "<fully.qualified.TestClass.testMethod>" -x spotlessCheck -x checkstyleMain -x checkstyleTest

# Integration tests (require Docker image)
./gradlew :tests:java-test-image:dockerBuild
./pulsar-build/run_integration_group_gradle.sh <group>
```

**IMPORTANT**: Remove `invocationCount` before creating the PR. It was only for local verification.

## Phase 4: Deep Review

After implementing the fix, perform a self-review:

1. **Re-read the original test** from master: `git show master:<path-to-test-file>`
2. **Compare with your fix**: Does the test still verify the same thing?
3. **Check git blame**: Does the fix align with the original author's intent?
4. **Verify assertion strength**: Are assertions as strong as the original?
5. **Think about edge cases**: Could the fix introduce new flakiness?

If the fix weakens the test, go back and find a better approach.

## Phase 5: Create PRs

### Branch naming
```
fix-flaky-<TestClassName>[-<brief-description>]
```

### PR creation
Use the `/pulsar-create-pr` skill, which handles:
- Pushing to the `forked` remote
- Using the Pulsar PR template format from `.github/PULL_REQUEST_TEMPLATE.md`
- Requesting reviewers

### PR description format
Always use the Pulsar template with these sections:

```markdown
Fixes #<issue-number>

### Motivation
[Explain the flakiness: what fails, how often, root cause]

### Modifications
[Describe the fix and why it's correct]

### Verifying this change
- [ ] Make sure that the change passes the CI checks.

This change is already covered by existing tests, such as <TestClass.testMethod>. Verified with invocationCount=10 locally (10/10 passes).

### Does this pull request potentially affect one of the following parts:
- [ ] Dependencies (add or upgrade a dependency)
- [ ] The public API
- [ ] The schema
- [ ] The default values of configurations
- [ ] The threading model
- [ ] The binary protocol
- [ ] The REST endpoints
- [ ] The admin CLI options
- [ ] The metrics
- [ ] Anything that affects deployment
```

If there's an existing GitHub issue, include `Fixes #<number>` in the first line.

## Phase 6: Parallel Execution

When fixing multiple unrelated flaky tests, use Agent teams for parallelism:
- Launch up to 4 agents in separate worktrees (use `isolation: worktree`)
- Group related tests (same class/module) into the same agent
- Each agent: analyze, fix, verify, commit, create PR
- After agents complete, review each fix for correctness

## Module and Test Execution Reference

| Module | Gradle Task | Notes |
|--------|------------|-------|
| `pulsar-broker` | `:pulsar-broker:test` | Most broker unit tests |
| `managed-ledger` | `:managed-ledger:test` | ManagedLedger tests |
| `pulsar-broker-common` | `:pulsar-broker-common:test` | Bookie placement, shared broker code |
| `pulsar-client` | `:pulsar-client-original:test` | Client tests |
| `pulsar-proxy` | `:pulsar-proxy:test` | Proxy tests |
| `integration` | `:tests:integration:integrationTest` | Requires Docker image build first |

### Integration test Docker build
```bash
# Build the test Docker image (required before running integration tests)
./gradlew :tests:java-test-image:dockerBuild

# Run a specific integration test group
./pulsar-build/run_integration_group_gradle.sh <group>
# e.g., ./pulsar-build/run_integration_group_gradle.sh LOADBALANCE
```

### Skip code quality checks during development
```bash
./gradlew :<module>:test --tests "<test>" -x spotlessCheck -x checkstyleMain -x checkstyleTest
```
