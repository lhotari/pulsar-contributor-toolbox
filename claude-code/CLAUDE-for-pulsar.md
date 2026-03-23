# Apache Pulsar - Development Guide

## Project Overview

Apache Pulsar is a distributed messaging and streaming platform designed for high throughput, low latency, and horizontal scalability. The codebase is Java-based, built with Maven, and uses TestNG for testing.

## Quick Build

For most development work, building core modules is sufficient (skips connectors, offloaders, etc.):

```shell
mvn -Pcore-modules,-main -T 1C clean install -DskipTests -Dspotbugs.skip=true -DnarPluginPhase=none
```

Remove `clean` from the command when iterating quickly.

### Build Specific Changed Modules Only

```shell
mvn -pl <module-path> install -DskipTests -Dspotbugs.skip=true
```

### Full Build (all modules including connectors, offloaders)

```shell
mvn -T 1C clean install -DskipTests -Dspotbugs.skip=true -DShadeTests -DintegrationTests -DBackwardsCompatTests -Dtest=NoneTest -DfailIfNoTests=false
```

### License & Checkstyle Checks

```shell
mvn -ntp -T 1C -DskipSourceReleaseAssembly=true -DskipBuildDistribution=true -Dspotbugs.skip=true verify -DskipTests
```

## Running Tests

### Unit Tests

Before running the unit tests build the core-modules on the first run before executing the unit tests. If there are code changes in a module, only compile the changed module before running the unit tests. If only the test code changes, the unit tests can be run without rebuilding the module.

```shell
mvn -DtestFailFast=false -DexcludedGroups='' --fail-at-end -DredirectTestOutputToFile=false -DtestRetryCount=0 test -pl <module> -Dtest=<TestClass>
```

### Integration Tests

Integration tests use [TestContainers](https://www.testcontainers.org/) and require Docker.

**Build integration test dependencies:**
```shell
mvn -T 1C install -DskipTests -Dcheckstyle.skip=true -Dlicense.skip=true -Dspotbugs.skip=true -DintegrationTests -Dtest=NoneTest -DfailIfNoTests=false -am -pl tests/integration
```
There is no need to run this command if only test classes have changed since the last build.

**Run integration tests (uses `java-test-image`):**
```shell
export PULSAR_TEST_IMAGE_NAME=apachepulsar/java-test-image:latest
mvn test -DredirectTestOutputToFile=false -DtestRetryCount=0 -Dcheckstyle.skip=true -Dlicense.skip=true -Dspotbugs.skip=true -DintegrationTests -pl tests/integration -Dtest=<TestClass>
```

**Run system tests (uses `pulsar-test-latest-version` image):**
```shell
export PULSAR_TEST_IMAGE_NAME=apachepulsar/pulsar-test-latest-version:latest
mvn -T 1C test -DredirectTestOutputToFile=false -DtestRetryCount=0 -Dspotbugs.skip=true -DintegrationTests -pl tests/integration -Dtest=<TestClass>
```

## Docker Images for Testing

### java-test-image (lightweight)

Used by CI **integration tests**: Backwards Compatibility, Cli, Messaging, LoadBalance, Shade, Standalone, Transaction, Metrics, Upgrade, Kubernetes.

```shell
./build/build_java_test_image.sh
```

To build with async profiler support:
```shell
./build/build_java_test_image.sh -Ddocker.install.asyncprofiler=true
```

There is no need to rebuild the docker image if only test classes have changed since the last build.

### pulsar-test-latest-version image (full)

Used by CI **system tests**: Tiered FileSystem, Tiered JCloud, Function, Schema, Pulsar Connectors (Thread/Process), Pulsar IO, Plugin, Pulsar IO Oracle. These tests require connectors, offloaders, and full server distribution.

```shell
# Requires full build first
mvn clean install -DskipTests -Dspotbugs.skip=true -Dlicense.skip=true -Dcheckstyle.skip=true
mvn -B -f tests/docker-images/pom.xml install -am -Pdocker -Dspotbugs.skip=true -DskipTests
```

There is no need to rebuild the docker image if only test classes have changed since the last build.

## Coding Conventions

- **Indentation**: 4 spaces, no tabs
- **Braces**: always required, even for single-line `if`
- **No `@author` tags** in Javadoc
- **TODO comments** must reference a GitHub issue: `// TODO: https://github.com/apache/pulsar/issues/XXXX`
- **Logging**: SLF4J only, no `System.out`/`System.err`. Guard DEBUG/TRACE with `log.isDebugEnabled()`.
- **Testing**: TestNG framework, Mockito for mocking, prefer AssertJ assertions, use Awaitility for async assertions
- **Async**: prefer `CompletableFuture` over `ListenableFuture`. Never block in async paths. Methods returning `CompletableFuture` must not throw synchronous exceptions — use `CompletableFuture.failedFuture()`.
- **Collections**: prefer FastUtil for type-specific collections, JCTools for concurrent structures
- **Utilities**: prefer commons-lang3, Guava, commons-* libraries
- **Networking/Buffers**: prefer Netty `ByteBuf` over `ByteBuffer`
- **Resource management**: always use try-with-resources

## PR Conventions

PR title format: `[type][component] summary` (e.g., `[fix][broker] Fix race condition in dispatcher`)
See `.github/workflows/ci-semantic-pull-request.yml` for supported types and components.
Each PR should address only one issue and include tests for any feature or bug fix.
See `.github/PULL_REQUEST_TEMPLATE.md` for description format.
When creating a PR, add a ready-to-test label immediately after creating the PR so that the CI can run.
Always wait for approval or specific request for creating a PR or pushing commits to remote repositories.

## PIP (Pulsar Improment Proposal) Conventions

When working on a PIP (`pip/pip-*.md`) file, follow the conventions explained in `pip/README.md`.
There are good examples of PIPs in `pip/pip-379.md` and `pip-pip-430.md`.

## Profiling

For broker profiling with Async Profiler, see `tests/integration/src/test/java/org/apache/pulsar/tests/integration/profiling/PulsarProfilingTest.java` for a complete example including perf event tuning and JFR output.
The `testAsyncProfiler` maven profile defined in `pom.xml` contains some more details.
