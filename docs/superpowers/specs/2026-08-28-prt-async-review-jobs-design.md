# pr-review-track: asynchronous per-PR review jobs

*Design, 2026-08-28. Revised after a Codex review of the first draft; what that
review changed is recorded in "Review history" at the end.*

## The problem

Reviewing ten PRs is the most expensive thing this skill does, and today it is
also the most blocking. `re-review` and `review-latest` already fan out one
subagent per PR (SKILL.md:145, SKILL.md:212), so diffs, threads and findings
mostly stay out of the main context — but the procedure then waits for the whole
batch before it says anything. The terminal is tied up for the length of the
slowest PR, and there is no way to fire a review off and go do something else.

There is a second, quieter problem. Nothing on disk records that a review is
*running*. `pr.json` gains a status only once `prt draft` writes `review.md`, so
a subagent that dies at minute six leaves no trace: the PR looks untouched and
the work is silently lost. Tolerable while a human watches the batch; not
tolerable once jobs can be fired and forgotten.

## What this adds

A durable, per-repository job queue on disk, drained by whichever Claude session
is currently running a pr-review-track command. The queue survives session death;
the workers do not, and are restarted from the queue.

| Decision | Alternative rejected |
|---|---|
| The queue is durable and survives restarts | An in-session batch that dies with the session |
| The session is the engine; nothing runs while no session is attached | A headless `claude -p` drainer — its own permission posture, cost ceiling, and a reporting path for work nobody watched |
| Job kinds are `review`, `re-review`, `revise` | Including `nudge`, which the script already computes and renders deterministically |
| Interrupted work resumes, retry cap 2 | Report-and-ask, which turns "fire and forget overnight" into "re-authorise in the morning" |
| Resumption happens **only** when a pr-review-track command runs in a session | Resuming at session start, which would reach into unrelated sessions |
| Work you asked for just now jumps the queue | Strict FIFO |
| One drainer per repository | Multi-writer coordination |

## Two mechanisms, not one

The first draft conflated mutual exclusion with ownership and got both wrong.
They are separate, with different lifetimes:

**`jobs.lock` — a mutex.** Taken through the existing `store.acquireLock`
(store.mjs:227) for the milliseconds of a single job-state mutation, released
immediately. Exclusive `wx` creation means a loser gets `null` and retries, so
two `prt job next` processes in the *same* session cannot both select the same
queued job. Every mutation — `add`, `next`, `commit`, `done`, `fail`, `cancel` —
happens inside it. TTL 60 s, which is far longer than any critical section and
far shorter than any review.

**`drain.owner` — a policy record**, `{ session, pid, since, lastActivityAt }`,
rewritten under the mutex. It carries the one-drainer-per-repo rule and nothing
else:

| Holder | Outcome |
|---|---|
| Same `session` | Ours. Touch `lastActivityAt`, continue. |
| Different session, `pid` not alive | The owner crashed. Take it, then reap. |
| Different session, `pid` alive, idle > 30 min | Wedged. Take it, and say so in the output. |
| Different session, `pid` alive, active | **Refuse**, naming the owner, how long it has held, and `prt job release --force`. |

`pid` is `CLAUDE_PID` and `session` is `CLAUDE_CODE_SESSION_ID`. Checking pid
liveness is not proof that the *owner is working* — workers are separate agents,
and a live Claude process can be wedged — so liveness is a fast path, not the
whole rule: a dead pid is reclaimable at once instead of after a timeout, and
`lastActivityAt` catches everything else. If `CLAUDE_PID` is absent (prt run from
a plain terminal), the idle rule alone applies.

**Only starting work needs ownership.** `job add`, `job list` and every existing
read command work from any session — an accidental second session can queue work
and read the board, it simply cannot run anything. That is the whole of what the
rule protects.

## Where a job lives

On `pr.json`, one per tracked PR, beside the `asks` and `tracking` fields that
already extend that file:

```json
"job": {
  "kind": "review | re-review | revise",
  "state": "queued | running | failed",
  "priority": 0,                       // --priority now = 0, batch = 10
  "queuedAt": "…", "startedAt": "…", "committedAt": null,
  "owner": { "session": "e3707fbd-…", "attemptToken": "9f31c2…" },
  "attempts": 1,
  "tier": "consensus",
  "payload": { "instructions": "make the comments shorter", "since": "<sha>" },
  "lastError": null
}
```

`owner.session` is who may finish the job; `owner.attemptToken` is an
unguessable per-attempt token, minted when the job starts and handed to the
worker in its prompt. The two are distinct on purpose: the session says *who*,
the token says *which attempt*, and a restarted job mints a new token so the
previous worker's is dead on arrival.

The queue is "every tracked PR directory whose `pr.json` has a `job`", ordered by
`(priority, queuedAt)`. `prt list` and `prt board` already read every `pr.json`,
so the scan costs nothing at this scale.

**`writeState` gains a merge contract.** Codex found that `sync` (prt.mjs:300)
and `track` (prt.mjs:368) build a fresh state literal with no `...prev` — only
`refresh` and `draft` spread it — so the queue would have been erased by
`prt sync`, which is step 1 of re-review. `store.writeState` therefore preserves
`job` and `lastJob` from the existing document unless the caller explicitly
passes them, and a test asserts that property for every command that writes
state. Without this the feature deletes itself on the most common command in the
skill.

**There is no `done` state.** A job that succeeds is deleted and its outcome
recorded as `lastJob: { kind, finishedAt, outcome, attempts }`. A job that
exhausts its retries stays `failed`, because that one needs a human decision.
`prt draft` writing `review.md` does **not** clear the job — `job done` is the
only clearing transition, and the first draft's claim to the contrary was a
straight contradiction.

## prt is the only writer of `review.md`

The generator has always owned that file; workers now own it through the
generator rather than around it, because an unattended agent editing an action
file is exactly where a human's approval can get overwritten.

- A `review`/`re-review` worker calls `prt draft <N> --job-token T`.
- A `revise` worker writes its edited bytes to `cache/revise-<token>.md` and
  calls `prt job commit <N> --token T --from <that file>`.

Both paths, inside the mutex, immediately before the atomic write:

1. **re-check the token** — if `job.owner.attemptToken` no longer matches, this
   worker was superseded by a takeover or a retry. Refuse; write nothing.
2. **re-check line 1** — if the status is protected now, refuse. `draft` checks
   this at prt.mjs:542 and writes at prt.mjs:620 with a network round trip in
   between, so the human can arm the file inside the window. The check must
   happen where the write happens.
3. **record `committedAt`** in the same mutex-held update.

This closes the split-brain the first draft allowed, where a worker whose lease
had moved on was still authorised to finish and could overwrite the new worker's
draft — or a file the human had meanwhile set to `ready`.

## State machine

| From | Event | To |
|---|---|---|
| — | `job add` | `queued` |
| `queued` | `job next` selects it (ownership held, slot free, mutex held) | `running`, new `attemptToken`, `attempts + 1` |
| `running` | `job done` | deleted; `lastJob` written |
| `running` | `job fail`, or reaped because `owner.session` is not ours | `queued` below the cap, `failed` at it |
| `running` with `committedAt` set | reap or `fail` | **recovered**: `job done` is applied instead of a retry |
| `failed` | `job add` again — an explicit human act | `queued`, `attempts` reset |
| `queued` | `job cancel` | deleted |
| `running` | `job cancel --force` | deleted; stop the agent *first*, then cancel |

The `committedAt` row is the answer to "worker wrote the file, then crashed
before recording success". The artifact exists and is correct; re-running would
regenerate a `review` needlessly and would re-apply a `revise`'s instructions to
already-edited bytes. A committed job is finished, not retried.

`attempts` increments when a job **starts**, so a cap of 2 means at most two
starts. `job cancel --force` stops the agent first and deletes the record second;
the ordering plus the token check is what makes cancellation safe — a worker that
survives the stop cannot write, because its token is gone.

`lastJob.outcome` is the worker's own one-line summary: free text, for the board
and `prt list`, never parsed.

## CLI surface

```
prt job add <N>… --kind K [--priority now|batch] [--instructions "…"] [--tier T] [--since <sha>]
prt job list [--json]                       # ordered queue + owner. Read-only, no mutex.
prt job next [--max N] [--json]             # own, reap, start up to N, print them with tokens
prt job commit <N> --token T --from <file>  # token- and status-checked write of review.md
prt job done <N> --token T [--outcome "…"]
prt job fail <N> --token T --error "…"
prt job cancel <N>… | --all [--force]
prt job release [--force]
```

`job next` is the drain protocol in one call, entirely inside the mutex:

1. Resolve ownership per the table above; refuse or take over.
2. Reap: every `running` job whose `owner.session` is not this session is
   orphaned — `committedAt` recovers it, otherwise `attempts` decides requeue or
   park.
3. Free slots: `maxConcurrentJobs` (new config key, default 4) minus this
   session's running jobs, then `min(slots, --max)`.
4. Take that many from the head of the queue, mark them `running` with
   `startedAt`, a fresh `attemptToken` and `attempts + 1`, and print them as JSON.

The model never reasons about ordering or slot arithmetic; it asks for work and
spawns what it is handed.

## How the skill drives it

**Every routed request starts with a drain.** The first action of any
pr-review-track request is `node "$PRT" job next --max <slots>`. That call *is*
the resume rule: queued work only moves because a pr-review-track command ran in
this session. Nothing in `prt` runs on a timer, so a session that never touches
this skill never touches the queue.

**Batch requests stop spawning inline.** `review-latest` and `re-review` become
`prt track <N>…`, `prt job add <N>… --kind … --tier <batch tier>`, then a drain.
The tier is stamped at enqueue time, so a job resumed a week later keeps the tier
it was queued with rather than silently re-deciding the budget.

**Interactive requests are `now`-priority jobs.** "Revisit the draft for 26424"
enqueues a `revise` job at priority 0 with the human's words as
`payload.instructions`, and it takes the next free slot ahead of batch work.

**The loop that keeps the terminal responsive:**

1. `job next` returns up to N jobs, already `running`, each with its token.
2. Spawn one agent per job — PR number, repo, tier, payload, token, and the
   return contract — and **end the turn**. The human has the prompt back.
3. Each completion notification: print one line for that PR, `job next` to fill
   the freed slot, spawn, end the turn again.
4. Empty queue: the batch summary and the watcher, as today.

**Worker contract.** Run the existing procedure for the kind; write the action
file only through `prt draft --job-token` or `prt job commit`; record the outcome
with `job done` or `job fail`; return at most five lines — number, what happened,
recommended resolution, file path. Everything substantive is on disk; the return
value is a headline, not a report.

**The main agent is the backstop for a worker that dies.** A crashed agent cannot
call `job fail`. On every completion notification, if that PR's job is still
`running`, the worker vanished without recording anything and the main agent
records the failure itself. Reaping covers a dead *session*; this covers a dead
*agent* inside a live one.

What the human sees:

```
Queued 10 for apache/pulsar · 4 running (26412 26418 26423 26427) · 6 waiting.
I'll report each as it lands — terminal is yours.

  #26418 ✓ re-review · author fixed the permit leak, 2 threads still open → COMMENT
         ~/.claude/pr-review-track/apache/pulsar/pr-26418/review.md
  #26421 ✗ pr-review degraded (no worktree) · attempt 1 of 2, requeued
```

`prt board` shows running and queued jobs **as rows in the existing "reviews in
progress" section**, which today lists PRs with a `review.md` whose status is
neither `submitted` nor `skip` (render.mjs:559). A running review has no file
yet, and that section is precisely where a human looks for unfinished work — a
summary line elsewhere would leave the motivating case invisible in the view that
matters. `prt list` and `prt doctor` each gain one queue line.

## Failure semantics and existing invariants

- **Retry cap 2.** A third start is refused; the job parks as `failed` with
  `lastError`. Re-adding resets the count.
- **Protected files** are checked at `job add`, at worker start, and — the one
  that actually protects anything — inside the mutex immediately before the
  write.
- **`archive`/`cleanup`** use a **separate `jobBlocker()`**, never
  `archiveBlocker()`. Job-state `queued` and action-file `queued` are different
  concepts that happen to share a word, and reusing the existing function would
  blur an invariant about human approval into one about scheduling. Archiving
  refuses while a job is `running`, and **clears** a `queued` job into `lastJob`
  before the directory moves — otherwise `unarchive` resurrects work that was
  reported as dropped.
- **The human gate is untouched.** Jobs draft; nothing posts. `Status: ready` is
  still the only thing that fires `prt submit`. The first draft claimed the
  watcher's quiesce window protects a file a worker is editing; it does not —
  capture compares two reads 150 ms apart (submit.mjs:90) and then sets `queued`.
  What protects the file is that workers write only through prt, under the mutex,
  with the status re-checked at the write.
- **Scope boundary:** ownership and queue are per repository.

## Non-goals

- A headless drainer. The queue shape stays compatible with one; building it
  means a permission posture, a cost ceiling, log capture and a reporting path
  for work done while nobody was watching.
- More than one job per PR.
- Jobs for `sync`/`refresh`. Network-bound seconds, not model-bound minutes.
- Jobs for `nudge`. The script already computes eligibility and renders the
  reminder; a job kind existing for symmetry is a second code path for no gain.

## Files touched

| File | Change |
|---|---|
| `scripts/lib/jobs.mjs` | **new** — the pure state machine: order, slots, start, commit, done, fail, reap, recover, retry cap |
| `scripts/lib/store.mjs` | `maxConcurrentJobs`; the `writeState` merge contract; `jobs.lock` mutex and `drain.owner` helpers |
| `scripts/prt.mjs` | `COMMANDS.job`; `draft --job-token`; queue rows in `board`/`list`/`doctor`; `jobBlocker()`; archive clearing queued jobs |
| `scripts/lib/render.mjs` | job rows inside "reviews in progress" |
| `SKILL.md` | routing; `re-review`/`review-latest` enqueue-and-drain; `revisit-draft` as a `now` job; the job-queue section with the loop and worker contract; invariant note |
| `references/commands.md` | `prt job` reference |
| `scripts/test/jobs.test.mjs` | **new** |

`references/action-file.md` is untouched: jobs do not change the file format.

## Testing

Pure transition tests plus CLI-through-a-temp-store tests, following
`archive.test.mjs` and `pr-actions.test.mjs`:

- ordering by `(priority, queuedAt)`; a `now` job overtaking a queued batch;
- slot arithmetic against `maxConcurrentJobs`, and `--max` below the cap;
- `attempts` on start; requeue below the cap; park at it;
- **`sync`, `track`, `refresh`, `draft` and `ask --promote` each preserve an
  existing `job` and `lastJob`** — the regression that would have deleted the
  queue;
- two concurrent `job next` processes in one session start disjoint job sets;
- reap: a `running` job owned by another session is requeued; one owned by this
  session is left alone; one with `committedAt` is recovered rather than retried;
- ownership: same-session touch, dead-pid takeover, live-pid refusal, idle
  takeover past 30 minutes, `--force`;
- `prt draft --job-token` and `job commit` refusing a stale token, and refusing a
  file whose status became protected after the job started;
- `job cancel --force` leaving a token that can no longer write;
- archive refusing a running job and clearing a queued one, with `unarchive` not
  resurrecting it.

What the suite cannot verify is that the model spawns agents, ends its turn, and
reports incrementally. That lives in SKILL.md prose; saying so is better than
implying coverage that does not exist.

## Review history

Codex reviewed the first draft against the implementation and returned a
not-safe-to-implement verdict. What it changed:

- **`sync`/`track` erase unknown top-level fields** — verified; the queue would
  have deleted itself on step 1 of re-review. Fixed by the `writeState` merge
  contract and a test per writer.
- **Same-session drainers could race** — the ownership record was doing duty as a
  mutex. Split into `jobs.lock` and `drain.owner`.
- **Split-brain after takeover, and a protected-file TOCTOU** — job-state tokens
  never protected `review.md`. Fixed by making prt the only writer of the action
  file, with token and status re-checked inside the mutex at the write.
- **Two owners of the success transition** — removed; `job done` is the only one.
- **Artifact written, then crash** — added `committedAt` and the recover
  transition.
- **A wedged but live session blocked recovery forever** — added
  `lastActivityAt` and the 30-minute idle takeover.
- **`archiveBlocker()` reuse blurred two meanings of `queued`** — separate
  `jobBlocker()`; archive clears a queued job before the directory moves.
- **The board would not show running work** — job rows go in "reviews in
  progress", not a summary line elsewhere.
- **The watcher-protects-revisions claim was wrong** — removed and replaced with
  what actually protects the file.

Overstated, and not adopted as put: pid liveness was called useless because it is
not worker liveness. It is not sufficient, and the design no longer claims it is
"exact" — but a dead pid is reclaimable instantly rather than after a timeout, so
the check stays as a fast path in front of the idle rule. Cancellation can also
never be truly atomic with stopping an agent; ordering the stop first and killing
the token is as close as this gets.
