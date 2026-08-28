# pr-review-track: asynchronous per-PR review jobs

*Design, 2026-08-28.*

## The problem

Reviewing ten PRs is the most expensive thing this skill does, and today it is
also the most blocking. `re-review` and `review-latest` already fan out one
subagent per PR (SKILL.md:145, SKILL.md:212), so the diffs, threads and findings
mostly stay out of the main context — but the procedure then waits for the whole
batch before it says anything. The terminal is tied up for the length of the
slowest PR, and there is no way to fire a review off and go do something else.

There is a second, quieter problem. Nothing on disk records that a review is
*running*. `pr.json` gains a status only once `prt draft` writes `review.md`, so
a subagent that dies at minute six leaves no trace at all: the PR looks
untouched, and the work is silently lost. That is tolerable while a human is
watching the batch. It is not tolerable once jobs can be fired and forgotten.

## What this adds

A durable, per-repository job queue on disk, drained by whichever Claude session
is currently running a pr-review-track command. The queue survives session
death; the workers do not, and are restarted from the queue.

Decisions taken during design, recorded here because each one closed off a
cheaper alternative:

| Decision | Alternative rejected |
|---|---|
| The queue is durable and survives restarts | An in-session batch that dies with the session |
| The session is the engine; nothing runs while no session is attached | A headless `claude -p` drainer — needs its own permission posture, cost ceiling and a way to report into a session that was not there |
| Any per-PR model work is a job: `review`, `re-review`, `revise`, `nudge` | Reviews only |
| Interrupted work resumes, with a retry cap of 2 | Report-and-ask, which turns "fire and forget overnight" into "re-authorise in the morning" |
| Resumption happens **only** when a pr-review-track command runs in a session | Resuming at session start, which would reach into unrelated sessions |
| Work you asked for just now jumps the queue | Strict FIFO |
| **One drainer per repository**, enforced by a lease | Per-job leases and multi-writer coordination |

The last one is load-bearing beyond its stated purpose. With exactly one writer
of job state per repo, "a `running` job owned by another session" can only mean
that session died — so orphan detection needs no heartbeat, no TTL guess, and no
per-job lock.

## Where a job lives

On `pr.json`, one per tracked PR, beside the `asks` and `tracking` fields that
already extend that file:

```json
"job": {
  "kind": "review | re-review | revise | nudge",
  "state": "queued | running | failed",
  "priority": 0,                       // --priority now = 0, batch = 10
  "queuedAt": "2026-08-28T09:14:02.113Z",
  "startedAt": "2026-08-28T09:14:07.880Z",
  "owner": "e3707fbd-34d3-4842-9d19-27fa4007d3e4",
  "attempts": 1,
  "tier": "consensus",
  "payload": { "instructions": "make the comments shorter", "since": "<sha>" },
  "lastError": null
}
```

The queue is "every tracked PR directory whose `pr.json` has a `job`", ordered by
`(priority, queuedAt)`. `prt list` and `prt board` already read every `pr.json`,
so the scan costs nothing at this scale (~130 tracked, ~15 active).

Keeping the job here rather than in a `queue.json` avoids a second source of
truth: archiving a PR moves its job with the directory, and `prt draft` writing
`review.md` is the same act that clears the job. The cost is one job per PR at a
time, which is a constraint worth having — two agents drafting into the same
`review.md` is a bug, not a capability.

**There is no `done` state.** A job that succeeds is deleted, and its outcome is
recorded as `lastJob: { kind, finishedAt, outcome, attempts }`. The durable
evidence of success is `review.md` itself; keeping finished jobs in the queue
would mean inventing a garbage collector for them. A job that exhausts its
retries stays as `state: failed`, because that one needs a decision from a human.

## The repository lease

`<root>/<owner>/<repo>/drain.lock`, holding `{ session, pid, token, at }`, taken
in the shape of the existing `store.acquireLock` (store.mjs:227).

`session` is `CLAUDE_CODE_SESSION_ID`; `pid` is `CLAUDE_PID`, which is a live
process. That last point is what makes the lease exact rather than a timeout:

| Holder | Outcome |
|---|---|
| Same `session` | Ours. Refresh and continue. |
| Different session, `pid` not alive | The owner crashed. Take the lease, then reap. |
| Different session, `pid` alive | **Refuse.** Name the owner, how long it has held, and `prt job release --force`. |
| Unreadable / no `pid` | Fall back to the TTL break already implemented in `acquireLock`. |

**Only starting work needs the lease.** `job add`, `job list` and every existing
read command work from any session — so an accidental second session can still
queue work and still see the board; it simply cannot run anything. That is the
narrow thing being protected against, and nothing more is restricted.

**Finishing is always allowed by the session that started.** `job done` and
`job fail` require that the job's `owner` matches the caller's token, not that
the lease is still held. A worker whose session lost the lease mid-flight still
records the work it actually did; what it cannot do is start anything new.

Workers are handed the lease token in their prompt rather than inferring
ownership from their environment, so nothing depends on whether a subagent
inherits the parent session's variables.

## State machine

| From | Event | To |
|---|---|---|
| — | `job add` | `queued` |
| `queued` | `job next` picks it (lease held, slot free) | `running`, `attempts + 1` |
| `running` | `job done` | deleted; `lastJob` written |
| `running` | `job fail`, or reaped because `owner` is another session | `queued` below the cap, `failed` at it |
| `failed` | `job add` again — an explicit human act | `queued`, `attempts` reset |
| `queued` | `job cancel` | deleted |
| `running` | `job cancel --force` | deleted; the agent is stopped separately |


`attempts` increments when a job **starts**, so the cap of 2 means at most two
starts. Reaping and `job fail` share the same branch: below the cap, back to
`queued`; at the cap, park as `failed` with `lastError`.

`job cancel` drops a `queued` job outright. Cancelling a `running` one needs
`--force` and only stops the record: the agent itself is stopped with `TaskStop`,
and the two are deliberately separate acts because a job record that disagrees
with a live agent is worse than either alone.

`lastJob.outcome` is the worker's own one-line summary — free text, for the board
and for `prt list`, never parsed.

## CLI surface

```
prt job add <N>… --kind K [--priority now|batch] [--instructions "…"] [--tier T] [--since <sha>]
prt job list [--json]                       # ordered queue + lease holder. Read-only.
prt job next [--max N] [--json]             # lease, reap, start up to N, print them
prt job done <N> --token T [--outcome "…"]
prt job fail <N> --token T --error "…"
prt job cancel <N>… | --all [--force]
prt job release [--force]
```

`job next` is the entire drain protocol in one call:

1. Acquire or refresh the repo lease; refuse per the table above.
2. Reap: every `running` job whose `owner` is not this session is orphaned —
   `attempts` decides requeue or park.
3. Compute free slots: `maxConcurrentJobs` (new config key, default 4) minus the
   jobs this session has running, then `min(slots, --max)`.
4. Take that many from the head of the ordered queue, mark them `running` with
   `startedAt`, `owner` and `attempts + 1`, and print them as JSON with the
   lease token.

The model never reasons about ordering or slot arithmetic. It asks for work and
spawns what it is handed.

`prt board`, `prt list` and `prt doctor` each gain one queue line: lease holder,
depth, and anything `failed`.

## How the skill drives it

**Every routed request starts with a drain.** The first action of any
pr-review-track request is `node "$PRT" job next --max <slots>`. That call *is*
the resume rule: queued work only ever moves because a pr-review-track command
ran in this session. Nothing in `prt` runs on a timer, so a session that never
touches this skill never touches the queue.

**Batch requests stop spawning inline.** `review-latest` and `re-review` become
`prt track <N>…`, then `prt job add <N>… --kind … --tier <batch tier>`, then a
drain. The tier is stamped on the job at enqueue time, so a job resumed a week
later keeps the tier it was queued with rather than silently re-deciding the
budget.

**The loop that keeps the terminal responsive:**

1. `job next` returns up to N jobs, already marked `running`.
2. Spawn one agent per job — PR number, repo, tier, payload, lease token, and the
   return contract — and **end the turn**. The human has the prompt back.
3. Each completion notification: print one line for that PR, call `job next` to
   fill the freed slot, spawn, end the turn again.
4. Empty queue: the batch summary and the watcher, exactly as today.

**Worker contract.** A worker runs the existing procedure for its kind, records
its own outcome (`prt job done <N> --token T`, or `job fail --error …`), and
returns at most five lines: number, what happened, recommended resolution, file
path. Everything substantive is on disk; the return value is a headline, not a
report.

**The main agent is the backstop for a worker that dies.** A crashed agent
cannot call `job fail`. So on every completion notification, if that PR's job is
still `running`, the worker vanished without recording anything and the main
agent records the failure itself. Reaping covers a dead *session*; this covers a
dead *agent* inside a live one.

What the human sees:

```
Queued 10 for apache/pulsar · 4 running (26412 26418 26423 26427) · 6 waiting.
I'll report each as it lands — terminal is yours.

  #26418 ✓ re-review · author fixed the permit leak, 2 threads still open → COMMENT
         ~/.claude/pr-review-track/apache/pulsar/pr-26418/review.md
  #26421 ✗ pr-review degraded (no worktree) · attempt 1 of 2, requeued
```

## Failure semantics and existing invariants

- **Retry cap 2.** A third start is refused; the job parks as `failed` with
  `lastError` and appears on the board. Re-adding it is an explicit human act
  that resets the count.
- **Protected files are checked twice** — at `job add` and again by the worker at
  start, because the human may have armed the file in between. A `revise` job on
  a `ready` file fails fast with that reason rather than half-doing the work.
  `prt draft` already refuses on protected statuses; this makes the refusal early
  and legible instead of arriving after the expensive part.
- **`cleanup` and `archive`** reuse the existing `archiveBlocker()`: refuse to
  archive a PR whose job is `running`; drop a `queued` job with a note. An
  archived PR leaves the queue by virtue of its directory moving — no
  reconciliation pass.
- **The human gate is untouched.** Jobs draft; nothing posts. `Status: ready` is
  still the only thing that fires `prt submit`, and the watcher's quiesce window
  still protects a file a `revise` worker is mid-edit on. Background jobs sound
  like they might weaken invariants 1 and 2; they do not, and the skill's
  invariant list will say so where somebody changing this later will read it.
- **Scope boundary:** the lease and the queue are per repository. Cross-repo
  draining is out of scope; a session drains one repo at a time, as every other
  command already works.

## Non-goals

- A headless drainer. The design leaves the queue shape compatible with one, but
  building it means a permission posture, a cost ceiling, log capture and a
  reporting path for work done while nobody was watching.
- More than one job per PR.
- Making `sync`/`refresh` jobs. They are network-bound seconds, not model-bound
  minutes.
- Offloading the human's own conversation. A `revise` job carries instructions
  the human typed; it does not replace the conversation about them.

## Files touched

| File | Change |
|---|---|
| `scripts/lib/jobs.mjs` | **new** — the pure state machine: order, slots, start, done, fail, reap, retry cap |
| `scripts/lib/store.mjs` | `maxConcurrentJobs` default; lease helpers on the `acquireLock` shape, with session/pid/token and liveness |
| `scripts/prt.mjs` | `COMMANDS.job` and its seven verbs; queue line in `board`/`list`/`doctor`; job-aware `archiveBlocker()` |
| `scripts/lib/render.mjs` | the queue line on `BOARD.md` |
| `SKILL.md` | routing entries; `re-review` and `review-latest` rewritten to enqueue-and-drain; `revisit-draft` as a `now`-priority job; a job-queue section carrying the loop and the worker contract; invariant note |
| `references/commands.md` | `prt job` reference |
| `scripts/test/jobs.test.mjs` | **new** — see below |

`references/action-file.md` is untouched: jobs do not change the file format.

## Testing

Pure transition tests plus CLI-through-a-temp-store tests, following
`archive.test.mjs` and `pr-actions.test.mjs`:

- ordering by `(priority, queuedAt)`, and a `now` job overtaking a queued batch;
- slot arithmetic against `maxConcurrentJobs`, including `--max` below the cap;
- `attempts` incrementing on start; requeue below the cap; park at the cap;
- reap on takeover: a `running` job owned by another session is requeued, and one
  owned by *this* session is left alone;
- lease: same-session refresh, dead-pid takeover, live-pid refusal, `--force`;
- `job done` accepted from the owning session after the lease moved on, and
  refused once another owner has restarted the job;
- `job add` refusing a protected status; `cleanup` refusing to archive a running
  job;
- `job done` clearing the job and writing `lastJob`.

What the suite cannot verify is that the model actually spawns agents, ends its
turn, and reports incrementally. That behaviour lives in SKILL.md prose. Saying
so here is better than implying a coverage that does not exist.
