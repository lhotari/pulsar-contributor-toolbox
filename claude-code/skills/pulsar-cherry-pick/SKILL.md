---
name: pulsar-cherry-pick
description: Cherry-pick (backport) one or more apache/pulsar commits onto a release/maintenance branch, resolving conflicts and adapting for branch differences. Use this whenever the user asks to cherry-pick, backport, port, or "apply commit X to branch Y" — especially when porting commits from master to an older release branch (branch-4.0/4.1/4.2/3.x etc.), where the logging framework (slog vs slf4j) and build system (Gradle vs Maven) differ and naive cherry-picks fail to compile.
---

# Cherry-picking apache/pulsar commits onto a release branch

Porting commits from `master` to a maintenance branch is rarely a clean `git cherry-pick`. Two project-wide differences cause most of the friction, and both can silently break the build if you only resolve the textual conflict:

1. **Logging framework.** `master` (5.x) uses a structured "slog" logger (`@CustomLog`, `log.info().attr("k", v).log("msg")`). Older release branches use plain **slf4j** (`@Slf4j`, `log.info("msg {}", v)`). The slog API does not exist on those branches, so any slog code a cherry-pick drags in — whether from a conflict region or an auto-merged hunk — fails to compile. See [references/slog-to-slf4j.md](references/slog-to-slf4j.md).
2. **Build system.** `master` is **Gradle** (`gradle/libs.versions.toml`, `*.build.gradle.kts`). Older branches are **Maven** (`pom.xml`, `./mvnw`). Gradle-only commits (dependency/version bumps) hit `modify/delete` conflicts; re-apply the change in the Maven equivalent and drop the stray Gradle files.

Always confirm what the **target branch** uses before starting — don't assume. Check the project's `CLAUDE.md`, and:

```shell
ls pom.xml mvnw gradlew settings.gradle 2>/dev/null   # Maven branch has pom.xml/mvnw; Gradle branch has gradlew
grep -rl '@CustomLog' <some-source-dir>/src/main 2>/dev/null | head -1   # non-empty => slog branch
```

If the source commit and target branch use the *same* build system and logging, most of this skill's adaptation work disappears — you still follow the per-commit loop, just with fewer conversions.

## The per-commit loop

Process commits **one at a time, in the order given**. Later commits often depend on earlier ones. For each commit:

1. **Cherry-pick with provenance.** `git cherry-pick -x <sha>` (the `-x` appends `(cherry picked from commit …)`, which reviewers and future backporters rely on). If it applies and commits cleanly, still run steps 4–6 — an auto-merge can drag in slog that compiles nowhere.
2. **Read the source commit** to understand intent before touching conflicts: `git show <sha>` and `git show <sha> --stat`. Knowing what the fix *does* tells you which side of a conflict to keep.
3. **Resolve conflicts** (see below). Use a 3-way view so you can see the base, not just the two sides.
4. **Scan for leftover slog and markers** across every file the commit touched — including auto-merged ones, not just the conflicted ones. Run `scripts/check-pick.sh <sha>` (greps for conflict markers, slog patterns, and added unguarded debug/trace). Convert any slog to slf4j.
5. **Compile.** Rebuild the changed module(s). This is your safety net: leftover slog or a missing symbol fails here, not in CI hours later. If the commit changed a *shared* module (e.g. `pulsar-client`, `pulsar-broker-common`), `install` it first so dependent modules pick up the new classes.
6. **Run the changed tests.** Find the test methods the commit added or modified and run exactly those (full classes are slow). Fix any failure before moving on.
7. **Finish the commit.** `git add` the resolved files, then `git -c core.editor=true cherry-pick --continue`. If the cherry-pick already auto-committed (clean apply) but you then fixed a leaked slog, amend instead: `git commit --amend --no-edit`.

Track progress with a todo list when doing many commits — it's easy to lose your place mid-conflict, and the user can see where you are.

## Resolving conflicts

Enable diff3 so you can see the common ancestor — it makes "which side is the real change" obvious:

```shell
git config merge.conflictStyle zdiff3
```

Conflict markers then show `<<<<<<< HEAD` (target branch), `||||||| parent of <sha>` (base), `======= ` / `>>>>>>>` (the commit's version). General approach:

- **Take "theirs" (the commit's change) for the logic**, then re-skin it to the target branch's conventions — slf4j logging, and any API the branch lacks. The point of the cherry-pick is the fix; the branch's job is only to host it idiomatically.
- **Preserve the target branch's surrounding style.** If HEAD logged `log.info("[{}] ... {}", topic, x)`, keep that message shape when you convert the incoming slog, rather than inventing a new one.
- **Verify symbols exist on the branch.** Commits often rename or remove methods (e.g. `getMigratedClusterUrl()` → `getMigratedClusterUrlAsync()`). After resolving, `grep` the branch for the new symbol and for lingering references to the old one. A clean compile is the proof.
- **Watch auto-merged hunks.** A non-conflicting hunk can still insert slog or call a method that doesn't exist on the branch. That's why step 4 scans *all* touched files, and step 5 always compiles.
- **`modify/delete` conflicts** mean the file doesn't exist on the branch (usually a Gradle file on a Maven branch). Don't resurrect it — `git rm` it and apply the intended change to the Maven equivalent (see below).

## slog → slf4j conversion

This is the most common and most error-prone adaptation. Full patterns and examples are in **[references/slog-to-slf4j.md](references/slog-to-slf4j.md)** — read it whenever a cherry-pick brings in slog. The essentials:

| slog (master)                                       | slf4j (release branch)                                  |
| --------------------------------------------------- | ------------------------------------------------------- |
| `@CustomLog` + `import lombok.CustomLog;`            | `@Slf4j` + `import lombok.extern.slf4j.Slf4j;`          |
| `log.info().attr("k", v).log("msg")`                | `log.info("msg k={}", v)`                               |
| `log.warn().exceptionMessage(e).log("msg")`         | `log.warn("msg", e)` (throwable as **last** arg)        |
| `log.error().attr("k", v).exception(e).log("msg")`  | `log.error("msg k={}", v, e)`                           |
| `log.debug().attr("k", v).log("msg")`               | `if (log.isDebugEnabled()) { log.debug("msg k={}", v); }` |

Two rules that are easy to get wrong:

- **A trailing throwable gets no `{}` placeholder.** Both `.exceptionMessage(e)` and `.exception(e)` map to passing `e` as the final argument with no matching `{}` — that's what makes slf4j log the stack trace.
- **Guard every debug/trace you convert *that has arguments*.** slog evaluates `.debug()`/`.trace()` lazily, so it is implicitly cheap when the level is off. slf4j is **not** lazy — an unguarded `log.debug("x={}", v)` builds its argument array (and boxes primitives) every call. Wrap converted debug/trace that take arguments in `if (log.isDebugEnabled())` / `if (log.isTraceEnabled())` (Pulsar's coding convention also requires this). **A debug/trace whose only argument is a constant string needs no guard** — there is nothing to build, so `log.debug("Skipping read, pending task")` stays unguarded (matching how upstream wrote it). Don't add guards around constant-message calls; it's pure noise. After finishing, verify the diff added no unguarded *argument-bearing* debug/trace: `git diff <base>..HEAD -- '*.java' | grep -E '^\+' | grep -E 'log\.(debug|trace)\('` — each hit with a `{}` placeholder / arguments must sit inside a guard; constant-string hits are fine unguarded.

## Maven adaptation for Gradle-only commits

Dependency bumps and version changes on `master` live in `gradle/libs.versions.toml` and `*.build.gradle.kts`, which don't exist on a Maven branch. For each such commit:

- `git rm` the Gradle files git left in the tree (`gradle/libs.versions.toml`, the `*.build.gradle.kts` files).
- Re-apply the version change in the Maven location: a `<*.version>` property in the root `pom.xml`, and/or the `<dependency>` block in the relevant module `pom.xml`. Search for the old version string to find where: `grep -rn '3\.21\.0' pom.xml */pom.xml`.
- Mirror non-code artifacts too — e.g. bundled-jar version lines in `distribution/*/src/assemble/LICENSE.bin.txt`.
- If the commit "drops an unused dependency", remove its `<dependency>` and version property on the Maven side as well, then confirm nothing else references them.
- Verify a consumer module still compiles (and, for a major-version bump, that a runtime test of that consumer passes) before continuing.

## Build & test commands

These are the source of truth in the project's own `CLAUDE.md` — defer to it. Useful invocations from real backport work:

**Maven branch** (`./mvnw`):

```shell
# Compile one module (main + test). Add -o to go offline if deps are already cached.
./mvnw -q -pl <module> test-compile -DskipTests -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dlicense.skip=true

# Install a shared module so dependents see its new classes (do this BEFORE compiling dependents)
./mvnw -q -pl <module> install -DskipTests -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dlicense.skip=true

# Run specific changed test methods (fast). '+' separates methods, ',' separates classes.
./mvnw -q -pl <module> test -DexcludedGroups='' -DredirectTestOutputToFile=false -DtestRetryCount=0 \
  -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dlicense.skip=true \
  -Dtest='SomeTest#testA+testB,OtherTest#testC'
```

**Gradle branch** (`./gradlew`): follow the project `CLAUDE.md` (typically `./gradlew :<module>:compileTestJava` and `./gradlew :<module>:test --tests 'ClassName.method'`).

Find the changed test methods to run:

```shell
git show <sha> -- '<path/to/SomeTest.java>' | grep -nE 'void test|@Test'
```

**Sandbox note:** Pulsar's Maven build runs a `lightproto` code generator that writes temp files, and offline runs may need to fetch a just-bumped artifact. Both can fail under a restrictive command sandbox with "Operation not permitted" or download errors. Re-run the build with the sandbox disabled when you see that — it's an environment restriction, not a code problem.

## Pre-`--continue` checklist

Before finishing each commit, confirm:

- No conflict markers remain in tracked files: `git diff --check` and a grep for `^<<<<<<<|^=======|^>>>>>>>`.
- No slog leaked into any touched file (run `scripts/check-pick.sh <sha>`).
- The changed module(s) compile.
- The commit's added/modified tests pass.
- Converted **argument-bearing** debug/trace calls are guarded; constant-string debug/trace calls are left unguarded (no guard needed when there's nothing to build).

## Notes & gotchas

- **`.orig` files** that appear are local backups; they're typically gitignored and not yours to commit — leave them. They are not conflict state.
- **Don't push or open PRs** unless asked — finish the local cherry-picks and report. Backport PRs to apache/pulsar follow the same conventions as any PR; if asked, see the `pulsar-create-pr` skill.
- **Keep the original commit message** (cherry-pick does this) including the `(cherry picked from commit …)` line from `-x`. Don't rewrite the subject.
- When a commit's only changed test is a large class, still scope the run to the changed methods with `-Dtest='Class#method'`; only fall back to the whole class when the change is structural enough to warrant it.
