# slog → slf4j conversion reference

Pulsar `master` (5.x) logs through a structured "slog" builder API; older release
branches use plain slf4j. When a cherry-pick brings slog into an slf4j branch it
won't compile, so every slog call must be rewritten. This file collects the
patterns. Match the *surrounding file's* existing slf4j style as you go — the goal
is code that reads like it was always on the branch.

## Logger declaration

slog declares the logger with Lombok's `@CustomLog` (wired to the slog factory via
`lombok.config`), which doesn't exist on slf4j branches.

```java
// slog
import lombok.CustomLog;
@CustomLog
public class Foo { ... }

// slf4j
import lombok.extern.slf4j.Slf4j;
@Slf4j
public class Foo { ... }
```

Some classes declare the logger by hand instead of via Lombok. On an slf4j branch
that is a normal slf4j logger, and it may be `static`:

```java
private static final Logger log = LoggerFactory.getLogger(Foo.class);
```

If a *new* file from the commit uses `@CustomLog`, switch it to `@Slf4j` (and fix
the import). If a `static` method needs to log, confirm the branch's `log` field is
`static` — `@Slf4j` generates a `private static final` logger, so it is.

Interface constants (`Logger LOG = LoggerFactory.getLogger(...)`) on an slf4j branch
already use slf4j; only the call sites that use slog builder syntax need changing.

## Call-site patterns

slog builds a statement fluently and ends with `.log("message")`. slf4j puts the
message first with `{}` placeholders and trailing arguments.

### Plain message

```java
// slog
log.info().log("Started");
// slf4j
log.info("Started");
```

### Attributes → placeholders

`.attr("key", value)` carries a structured field. On slf4j, fold it into the
message. Two idiomatic shapes, pick whichever matches the file:

```java
// slog
log.info().attr("topic", topic).attr("count", n).log("Updated");

// slf4j — values inline
log.info("Updated topic={} count={}", topic, n);
// slf4j — when the file uses a "[{}]" subject prefix convention
log.info("[{}] Updated count={}", topic, n);
```

### Exceptions

`.exceptionMessage(e)` and `.exception(e)` both attach a throwable. In slf4j, pass
the throwable as the **last argument with no matching `{}`** — that's the signal for
slf4j to render the stack trace rather than call `toString()`.

```java
// slog
log.warn().exceptionMessage(e).log("Close failed");
log.error().attr("topic", topic).exception(e).log("Apply failed");

// slf4j
log.warn("Close failed", e);
log.error("[{}] Apply failed", topic, e);   // topic -> {}, e -> trailing throwable
```

Common mistake: writing `log.error("Apply failed {}", e)`. That gives `e` a `{}` and
logs only `e.toString()` with no stack trace. Drop the `{}` for the throwable.

### Lambda/supplier attributes

slog sometimes defers work with a supplier, e.g.
`.attr("deliveryInMs", () -> deliverAt - clock.millis())`. slf4j has no lazy-arg
form for `info/warn/error`, so evaluate inline:

```java
// slog
log.debug().attr("deliveryInMs", () -> deliverAt - clock.millis()).log("Add message");
// slf4j (debug must also be guarded — see below)
if (log.isDebugEnabled()) {
    log.debug("Add message deliveryInMs={}", deliverAt - clock.millis());
}
```

## Debug and trace MUST be guarded

This is the subtle one. slog's `.debug()` / `.trace()` are lazy: the message and
attributes aren't built when the level is disabled, so an unguarded slog debug is
already cheap. slf4j is **not** lazy — `log.debug("x={}", expensive())` evaluates
`expensive()` and formats on every call regardless of level. Pulsar's coding
conventions therefore require a guard, and converting slog → slf4j without one is a
silent performance regression.

```java
// slog (implicitly guarded)
log.debug().attr("count", positions.size()).log("Get scheduled messages");

// slf4j (explicit guard)
if (log.isDebugEnabled()) {
    log.debug("Get scheduled messages count={}", positions.size());
}
```

Verify you introduced none unguarded. From the cherry-pick base to HEAD:

```shell
git diff <base>..HEAD -- '*.java' | grep -E '^\+' | grep -E 'log\.(debug|trace)\('
```

Each hit must sit inside an `isDebugEnabled()` / `isTraceEnabled()` block (or be a
line you took verbatim from the branch's already-guarded code).

## Worked examples from real backports

**Field log with subject prefix** (matched the file's `[{}]` convention):

```java
// slog
log.warn().attr("namespace", namespace).exception(ex).log("Close change_event reader fail.");
// slf4j
log.warn("[{}] Close change_event reader fail.", namespace, ex);
```

**Multi-attr error with throwable:**

```java
// slog
log.error()
        .attr("namespace", namespace)
        .attr("timeoutSeconds", timeoutSeconds)
        .log("Timed out initializing the topic policies cache; closing the stuck reader");
// slf4j
log.error("[{}] Timed out initializing the topic policies cache after {} seconds; closing the stuck reader",
        namespace, timeoutSeconds);
```

**Inside a `CompletableFuture.exceptionally`:**

```java
// slog
.exceptionally(e -> {
    log.warn().attr("bundle", bundle).exceptionMessage(e).log("Error finding bundle");
    return null;
});
// slf4j
.exceptionally(e -> {
    log.warn("Error when trying to find bundle {} on metadata store: {}", bundle, e);
    return null;
});
```

## After converting, prove it

The slog API is absent on the branch, so a clean `test-compile` of the changed
module is sufficient proof that no slog remains. Belt-and-suspenders grep over the
files the commit touched:

```shell
grep -nE 'log\.(debug|info|warn|error|trace)\(\)|\.attr\(|\.exceptionMessage\(|\.exception\(|@CustomLog' <files...>
```

Any hit is unconverted slog (or, for the empty-paren forms, an slf4j call that
happens to take no args — check the context).
