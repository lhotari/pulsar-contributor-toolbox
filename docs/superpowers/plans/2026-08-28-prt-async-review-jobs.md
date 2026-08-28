# Asynchronous per-PR review jobs — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `pr-review-track` a durable per-repository job queue so per-PR review work runs as background subagents, the terminal stays responsive, and interrupted work resumes instead of vanishing.

**Architecture:** Job records live on each PR's `pr.json`; the queue is "every tracked PR directory with a `job`". Two separate concurrency mechanisms: a short-lived `jobs.lock` mutex around every job-state mutation, and a `drain.owner` policy record enforcing one drainer per repository. Workers never write `review.md` directly — they go through `prt draft --job-token` or `prt job commit`, which re-check the attempt token and the file's status inside the mutex at the moment of writing.

**Tech Stack:** Node 20+ ESM, no dependencies, `node --test`. All state is JSON files under `$PRT_ROOT`.

**Spec:** `docs/superpowers/specs/2026-08-28-prt-async-review-jobs-design.md`

## Global Constraints

- **Nothing posts to GitHub.** Jobs draft only; `Status: ready` remains the sole human gate, and no code in this plan calls a GitHub mutation.
- **Job kinds are exactly `review`, `re-review`, `revise`.** Not `nudge`.
- **Retry cap is 2 starts.** `attempts` increments on start.
- **`maxConcurrentJobs` default 4**, in `store.DEFAULT_CONFIG`.
- **Idle takeover threshold is 30 minutes** of no `lastActivityAt` update.
- **Mutex TTL is 60 s**; it is held for a single mutation, never across model work.
- Every command that writes `pr.json` must preserve `job` and `lastJob`.
- Follow the existing house style: prose comments that explain *why*, tests whose names state the promise being kept.
- Run the whole suite with `bash scripts/test/run.sh` before each commit.

All paths below are relative to `claude-code/skills/pr-review-track/`.

---

### Task 1: `writeState` stops erasing unknown fields

The regression that would delete the queue on `prt sync`. Everything else depends on this holding.

**Files:**
- Modify: `scripts/lib/store.mjs:171-176`
- Test: `scripts/test/jobs.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `store.writeState(root, repo, number, state)` — unchanged signature; now carries `job` and `lastJob` forward from the existing document unless the caller passes them explicitly. Passing `null` for either deletes it.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/jobs.test.mjs`:

```js
// node --test scripts/test/jobs.test.mjs
//
// The job queue: what survives a write, who may start work, and what happens to
// a job whose session died. The queue lives on pr.json beside fields that
// several commands rewrite wholesale, so the first thing pinned here is that
// those commands stop erasing it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/store.mjs';

const REPO = 'o/r';
let ROOT;

before(() => { ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-jobs-')); });
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const base = (over = {}) => ({ schema: 1, repo: REPO, number: 1, title: 't', ...over });

test('a job survives a writer that rebuilds pr.json without mentioning it', () => {
  store.writeState(ROOT, REPO, 1, base({ job: { kind: 'review', state: 'queued' } }));
  // The shape `sync` and `track` use: a fresh literal, no spread of the old one.
  store.writeState(ROOT, REPO, 1, base({ title: 'refreshed' }));
  const after = store.readState(ROOT, REPO, 1);
  assert.deepEqual(after.job, { kind: 'review', state: 'queued' });
  assert.equal(after.title, 'refreshed', 'the write itself still happened');
});

test('an explicit job wins, and null deletes it', () => {
  store.writeState(ROOT, REPO, 2, base({ number: 2, job: { kind: 'review', state: 'queued' } }));
  store.writeState(ROOT, REPO, 2, base({ number: 2, job: { kind: 'revise', state: 'running' } }));
  assert.equal(store.readState(ROOT, REPO, 2).job.kind, 'revise');
  store.writeState(ROOT, REPO, 2, base({ number: 2, job: null }));
  assert.equal(store.readState(ROOT, REPO, 2).job, undefined);
});

test('lastJob is carried the same way', () => {
  store.writeState(ROOT, REPO, 3, base({ number: 3, lastJob: { kind: 'review', outcome: 'drafted' } }));
  store.writeState(ROOT, REPO, 3, base({ number: 3 }));
  assert.equal(store.readState(ROOT, REPO, 3).lastJob.outcome, 'drafted');
});

test('a corrupt existing document does not block the write that would heal it', () => {
  store.ensurePrDir(ROOT, REPO, 4);
  fs.writeFileSync(path.join(store.prDir(ROOT, REPO, 4), 'pr.json'), '{ not json');
  store.writeState(ROOT, REPO, 4, base({ number: 4 }));
  assert.equal(store.readState(ROOT, REPO, 4).number, 4);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/jobs.test.mjs`
Expected: the first three tests FAIL — `after.job` is `undefined`, because `writeState` replaces the whole document.

- [ ] **Step 3: Implement the merge contract**

In `scripts/lib/store.mjs`, replace `writeState`:

```js
/**
 * Fields that belong to the store rather than to any one command, and so must
 * survive a writer that does not know about them.
 *
 * `sync` and `track` build a fresh document instead of spreading the previous
 * one, which was harmless while every field was theirs. The job queue is not:
 * losing it on `prt sync` — step 1 of every re-review — would be
 * indistinguishable from work that was never queued at all.
 */
const CARRIED_KEYS = ['job', 'lastJob'];

export function writeState(root, repo, number, state) {
  ensurePrDir(root, repo, number);
  const p = path.join(prDir(root, repo, number), 'pr.json');
  let prev = null;
  // A corrupt document must not stop the write that replaces it.
  try { prev = readStateFrom(prDir(root, repo, number)); } catch { prev = null; }

  const merged = { ...state };
  for (const key of CARRIED_KEYS) {
    if (key in state) {
      if (state[key] == null) delete merged[key];   // explicit null deletes
      continue;
    }
    if (prev?.[key] != null) merged[key] = prev[key];
  }
  writeAtomic(p, `${JSON.stringify(merged, null, 2)}\n`);
  return p;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/jobs.test.mjs` — all four PASS.
Run: `bash scripts/test/run.sh` — the existing 142 still pass.

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/lib/store.mjs claude-code/skills/pr-review-track/scripts/test/jobs.test.mjs
git commit -m "Stop pr.json writers from erasing fields they do not own"
```

---

### Task 2: The mutex and the ownership record

**Files:**
- Modify: `scripts/lib/store.mjs` (append after `acquireLock`)
- Test: `scripts/test/jobs.test.mjs`

**Interfaces:**
- Consumes: `store.acquireLock(dir, name, ttlMs, attempt)` → `{ path, token, heartbeat(), release() }` or `null`.
- Produces:
  - `store.withJobLock(root, repo, fn)` — runs `fn()` holding `jobs.lock` in the repo directory; throws `Error('the job queue is busy')` if it cannot acquire within ~5 s.
  - `store.readOwner(root, repo)` → `{ session, pid, since, lastActivityAt } | null`
  - `store.claimOwner(root, repo, { session, pid, now, force })` → `{ ok: true, how: 'ours'|'new'|'crashed'|'idle'|'forced' }` or `{ ok: false, owner, reason }`
  - `store.touchOwner(root, repo, { session, pid, now })`
  - `store.releaseOwner(root, repo, { session, force })` → boolean
  - `store.IDLE_TAKEOVER_MS` = `30 * 60_000`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/jobs.test.mjs`:

```js
// --------------------------------------------------------------- ownership

const OTHER = { session: 'other-session', pid: 999_999_999 };

test('the first session to ask owns the repo, and asking again is a no-op', () => {
  const r1 = store.claimOwner(ROOT, REPO, { session: 's1', pid: process.pid });
  assert.equal(r1.ok, true);
  assert.equal(r1.how, 'new');
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's1', pid: process.pid }).how, 'ours');
});

test('a second live session is refused, and told who holds it', () => {
  store.claimOwner(ROOT, REPO, { session: 's1', pid: process.pid });
  const r = store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid });
  assert.equal(r.ok, false);
  assert.equal(r.owner.session, 's1');
  assert.match(r.reason, /s1/);
});

test('a crashed owner is taken over at once, without waiting out a timeout', () => {
  // A pid that cannot be running: claimed by nobody, far above the max.
  store.writeOwnerForTest(ROOT, REPO, { session: 'dead', pid: OTHER.pid, since: new Date().toISOString(), lastActivityAt: new Date().toISOString() });
  const r = store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'crashed');
});

test('a live but wedged owner is taken over after 30 minutes of no activity', () => {
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  store.writeOwnerForTest(ROOT, REPO, { session: 'wedged', pid: process.pid, since: old, lastActivityAt: old });
  const r = store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'idle');
  // 29 minutes is not enough.
  const recent = new Date(Date.now() - 29 * 60_000).toISOString();
  store.writeOwnerForTest(ROOT, REPO, { session: 'busy', pid: process.pid, since: recent, lastActivityAt: recent });
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid }).ok, false);
});

test('force takes it, and release only works for the holder unless forced', () => {
  store.writeOwnerForTest(ROOT, REPO, { session: 'busy', pid: process.pid, since: new Date().toISOString(), lastActivityAt: new Date().toISOString() });
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid, force: true }).how, 'forced');
  assert.equal(store.releaseOwner(ROOT, REPO, { session: 'not-s2' }), false);
  assert.equal(store.releaseOwner(ROOT, REPO, { session: 's2' }), true);
  assert.equal(store.readOwner(ROOT, REPO), null);
});

test('the mutex serialises: a second holder cannot enter while the first is inside', () => {
  let inner = 'not run';
  store.withJobLock(ROOT, REPO, () => {
    assert.throws(
      () => store.withJobLock(ROOT, REPO, () => { inner = 'ran'; }, { attempts: 1 }),
      /busy/,
    );
  });
  assert.equal(inner, 'not run');
  // And the lock is released afterwards.
  assert.equal(store.withJobLock(ROOT, REPO, () => 'ok'), 'ok');
});

test('the mutex is released even when the body throws', () => {
  assert.throws(() => store.withJobLock(ROOT, REPO, () => { throw new Error('boom'); }), /boom/);
  assert.equal(store.withJobLock(ROOT, REPO, () => 'ok'), 'ok');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/jobs.test.mjs`
Expected: FAIL — `store.claimOwner is not a function`.

- [ ] **Step 3: Implement**

Append to `scripts/lib/store.mjs`:

```js
/** A live owner that has done nothing for this long is wedged, not working. */
export const IDLE_TAKEOVER_MS = 30 * 60_000;

const ownerPath = (root, repo) => path.join(repoDir(root, repo), 'drain.owner');

/**
 * Is that process still there?
 *
 * EPERM means it exists and belongs to somebody else, which for our purposes is
 * the same answer as yes. Anything else — ESRCH, a nonsense pid — is no.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function readOwner(root, repo) {
  const p = ownerPath(root, repo);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Test seam: place an owner record without going through the claim rules. */
export function writeOwnerForTest(root, repo, owner) {
  fs.mkdirSync(repoDir(root, repo), { recursive: true });
  writeAtomic(ownerPath(root, repo), `${JSON.stringify(owner, null, 2)}\n`);
}

/**
 * Take, keep, or be refused the right to run jobs for this repository.
 *
 * One drainer per repo is a guard against running a second session's batch by
 * accident, not a distributed-systems claim. So the rules are the cheap ones
 * that answer that question exactly: it is ours, or its process is gone, or it
 * has done nothing for half an hour — otherwise somebody is working and we are
 * not going to trample them.
 */
export function claimOwner(root, repo, { session, pid, now = Date.now(), force = false } = {}) {
  const held = readOwner(root, repo);
  const stamp = new Date(now).toISOString();
  const take = (how) => {
    writeOwnerForTest(root, repo, { session, pid, since: stamp, lastActivityAt: stamp });
    return { ok: true, how };
  };

  if (!held) return take('new');
  if (held.session === session) {
    writeOwnerForTest(root, repo, { ...held, session, pid, lastActivityAt: stamp });
    return { ok: true, how: 'ours' };
  }
  if (force) return take('forced');
  if (!pidAlive(held.pid)) return take('crashed');

  const idleMs = now - Date.parse(held.lastActivityAt ?? held.since ?? stamp);
  if (idleMs > IDLE_TAKEOVER_MS) return take('idle');

  const mins = Math.max(1, Math.round((now - Date.parse(held.since ?? stamp)) / 60_000));
  return {
    ok: false,
    owner: held,
    reason: `${repo} jobs are owned by session ${held.session} (pid ${held.pid}), held ${mins}m. `
      + 'Use that session, or `prt job release --force` to take it.',
  };
}

export function touchOwner(root, repo, { session, pid, now = Date.now() } = {}) {
  const held = readOwner(root, repo);
  if (!held || held.session !== session) return false;
  writeOwnerForTest(root, repo, { ...held, pid: pid ?? held.pid, lastActivityAt: new Date(now).toISOString() });
  return true;
}

export function releaseOwner(root, repo, { session, force = false } = {}) {
  const held = readOwner(root, repo);
  if (!held) return false;
  if (!force && held.session !== session) return false;
  try { fs.unlinkSync(ownerPath(root, repo)); } catch { /* already gone */ }
  return true;
}

/**
 * Run one job-state mutation with nobody else inside.
 *
 * Ownership says which session may start work; this says that only one process
 * is reading-then-writing the queue at any instant. They are different
 * questions, and the first draft of this feature answered only the first — two
 * `prt job next` calls in the same session could select the same job.
 */
export function withJobLock(root, repo, fn, { ttlMs = 60_000, attempts = 50, waitMs = 100 } = {}) {
  const dir = repoDir(root, repo);
  for (let i = 0; i < attempts; i++) {
    const lock = acquireLock(dir, 'jobs.lock', ttlMs);
    if (lock) {
      try { return fn(); } finally { lock.release(); }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  throw new Error(`the job queue for ${repo} is busy — another prt process is holding jobs.lock`);
}
```

- [ ] **Step 4: Add the concurrency ceiling to the config**

In `store.DEFAULT_CONFIG`, beside `watchIntervalSeconds`:

```js
  // How many review jobs may run at once. Each one is a subagent that spawns
  // its own reviewers, so this is a ceiling on fan-out, not on ambition.
  maxConcurrentJobs: 4,
```

- [ ] **Step 5: Run the tests**

Run: `node --test scripts/test/jobs.test.mjs` — all PASS.
Run: `bash scripts/test/run.sh` — no regressions.
Run: `node scripts/prt.mjs doctor` — the config still loads.

- [ ] **Step 6: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/lib/store.mjs claude-code/skills/pr-review-track/scripts/test/jobs.test.mjs
git commit -m "Add the job mutex and the one-drainer-per-repo ownership record"
```

---

### Task 3: The job state machine

Pure functions, no I/O, so every transition is tested directly.

**Files:**
- Create: `scripts/lib/jobs.mjs`
- Test: `scripts/test/jobs.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `JOB_KINDS: Set<string>`, `PRIORITY: { now: 0, batch: 10 }`, `RETRY_CAP = 2`
  - `newJob({ kind, priority, instructions, since, tier, now }) → job`
  - `orderQueue(entries) → entries` where an entry is `{ number, job }`
  - `planNext(entries, { session, maxConcurrent, max, now, mintToken }) → { start, reaped, recovered, running }`
  - `startedJob(job, { session, token, now }) → job`
  - `failedJob(job, { error, now }) → job` (requeued or parked)
  - `recoveredJob(job) → { kind, outcome, attempts }` — the `lastJob` for a committed job
  - `finishedJob(job, { outcome, now }) → lastJob`
  - `mintToken() → string`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/jobs.test.mjs`:

```js
// ------------------------------------------------------------ state machine

import {
  newJob, orderQueue, planNext, startedJob, failedJob, finishedJob, RETRY_CAP,
} from '../lib/jobs.mjs';

const at = (iso) => Date.parse(iso);
const queued = (over = {}) => ({ ...newJob({ kind: 'review', tier: 'consensus', now: at('2026-08-28T10:00:00Z') }), ...over });
const entry = (number, job) => ({ number, job });
const token = (n) => `tok-${n}`;

test('the queue runs by priority first, then by when it was asked for', () => {
  const entries = [
    entry(1, queued({ priority: 10, queuedAt: '2026-08-28T10:00:00Z' })),
    entry(2, queued({ priority: 10, queuedAt: '2026-08-28T09:00:00Z' })),
    entry(3, queued({ priority: 0, queuedAt: '2026-08-28T11:00:00Z' })),
  ];
  assert.deepEqual(orderQueue(entries).map((e) => e.number), [3, 2, 1]);
});

test('a batch fills the free slots and no more', () => {
  const entries = [1, 2, 3, 4, 5, 6].map((n) => entry(n, queued({ queuedAt: `2026-08-28T0${n}:00:00Z` })));
  entries.push(entry(9, { ...queued(), state: 'running', owner: { session: 's1', attemptToken: token(9) } }));
  const plan = planNext(entries, { session: 's1', maxConcurrent: 4, now: Date.now(), mintToken: token });
  assert.equal(plan.start.length, 3, 'four slots, one already running');
  assert.deepEqual(plan.start.map((e) => e.number), [1, 2, 3]);
});

test('--max asks for fewer than the free slots', () => {
  const entries = [1, 2, 3].map((n) => entry(n, queued({ queuedAt: `2026-08-28T0${n}:00:00Z` })));
  const plan = planNext(entries, { session: 's1', maxConcurrent: 4, max: 1, now: Date.now(), mintToken: token });
  assert.equal(plan.start.length, 1);
});

test('starting a job stamps the owner, a fresh token, and one more attempt', () => {
  const started = startedJob(queued(), { session: 's1', token: 'abc', now: at('2026-08-28T12:00:00Z') });
  assert.equal(started.state, 'running');
  assert.equal(started.attempts, 1);
  assert.equal(started.owner.session, 's1');
  assert.equal(started.owner.attemptToken, 'abc');
  assert.equal(started.startedAt, '2026-08-28T12:00:00.000Z');
});

test('a job owned by another session is orphaned and requeued', () => {
  const orphan = { ...queued(), state: 'running', attempts: 1, owner: { session: 'dead', attemptToken: 'x' } };
  const plan = planNext([entry(7, orphan)], { session: 's1', maxConcurrent: 4, now: Date.now(), mintToken: token });
  assert.deepEqual(plan.reaped.map((e) => e.number), [7]);
  assert.equal(plan.start[0].job.state, 'running', 'and it is eligible to start again immediately');
  assert.equal(plan.start[0].job.attempts, 2);
});

test('a job running under this session is left alone by the reaper', () => {
  const mine = { ...queued(), state: 'running', attempts: 1, owner: { session: 's1', attemptToken: 'x' } };
  const plan = planNext([entry(7, mine)], { session: 's1', maxConcurrent: 4, now: Date.now(), mintToken: token });
  assert.deepEqual(plan.reaped, []);
  assert.deepEqual(plan.start, []);
});

test('a job that committed its file is recovered, never re-run', () => {
  const committed = {
    ...queued(), state: 'running', attempts: 1, committedAt: '2026-08-28T12:30:00Z',
    owner: { session: 'dead', attemptToken: 'x' },
  };
  const plan = planNext([entry(8, committed)], { session: 's1', maxConcurrent: 4, now: Date.now(), mintToken: token });
  assert.deepEqual(plan.recovered.map((e) => e.number), [8]);
  assert.deepEqual(plan.start, [], 're-running would re-apply a revise to already-edited bytes');
  assert.match(plan.recovered[0].lastJob.outcome, /recovered/);
});

test('the second failure parks the job instead of looping', () => {
  const once = failedJob({ ...queued(), state: 'running', attempts: 1 }, { error: 'no worktree', now: Date.now() });
  assert.equal(once.state, 'queued');
  assert.equal(once.lastError, 'no worktree');
  const twice = failedJob({ ...once, state: 'running', attempts: RETRY_CAP }, { error: 'again', now: Date.now() });
  assert.equal(twice.state, 'failed');
});

test('finishing produces the lastJob row the board shows', () => {
  const last = finishedJob({ ...queued(), state: 'running', attempts: 1 }, { outcome: 'drafted, 2 findings', now: at('2026-08-28T13:00:00Z') });
  assert.deepEqual(last, { kind: 'review', outcome: 'drafted, 2 findings', attempts: 1, finishedAt: '2026-08-28T13:00:00.000Z' });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/jobs.test.mjs`
Expected: FAIL — `Cannot find module '../lib/jobs.mjs'`.

- [ ] **Step 3: Implement**

Create `scripts/lib/jobs.mjs`:

```js
// The job queue's state machine, as pure functions over plain objects.
//
// Nothing here touches the filesystem. The rules that matter — what may start,
// what a dead session leaves behind, when a retry is the wrong answer — are
// exactly the things worth testing without a temp store in the way.
//
// The queue itself is not a file: it is every tracked PR whose pr.json carries
// a `job`. That means archiving a PR takes its job with it, and no reconciling
// pass can ever be needed between two records of the same thing.

import { randomBytes } from 'node:crypto';

export const JOB_KINDS = new Set(['review', 're-review', 'revise']);
export const PRIORITY = { now: 0, batch: 10 };

/** Two starts. A third would spend the budget again on a failure that repeats. */
export const RETRY_CAP = 2;

export const mintToken = () => randomBytes(12).toString('hex');

export function newJob({ kind, priority = 'batch', instructions = null, since = null, tier = null, now = Date.now() }) {
  if (!JOB_KINDS.has(kind)) throw new Error(`not a job kind: ${kind}`);
  if (!(priority in PRIORITY)) throw new Error(`not a priority: ${priority}`);
  return {
    kind,
    state: 'queued',
    priority: PRIORITY[priority],
    queuedAt: new Date(now).toISOString(),
    startedAt: null,
    committedAt: null,
    owner: null,
    attempts: 0,
    tier,
    payload: { instructions, since },
    lastError: null,
  };
}

/** What you asked for just now, then oldest first. */
export function orderQueue(entries) {
  return [...entries].sort(
    (a, b) => (a.job.priority - b.job.priority) || (Date.parse(a.job.queuedAt) - Date.parse(b.job.queuedAt)),
  );
}

export function startedJob(job, { session, token, now = Date.now() }) {
  return {
    ...job,
    state: 'running',
    startedAt: new Date(now).toISOString(),
    committedAt: null,
    owner: { session, attemptToken: token },
    attempts: job.attempts + 1,
  };
}

export function failedJob(job, { error, now = Date.now() }) {
  const parked = job.attempts >= RETRY_CAP;
  return {
    ...job,
    state: parked ? 'failed' : 'queued',
    owner: null,
    startedAt: parked ? job.startedAt : null,
    lastError: String(error ?? 'failed'),
    failedAt: new Date(now).toISOString(),
  };
}

export function finishedJob(job, { outcome, now = Date.now() }) {
  return {
    kind: job.kind,
    outcome: String(outcome ?? '').trim() || 'done',
    attempts: job.attempts,
    finishedAt: new Date(now).toISOString(),
  };
}

/**
 * Decide what this session should do next, without doing any of it.
 *
 * Reaping is a consequence of one drainer per repository rather than a
 * mechanism of its own: a running job owned by a different session can only
 * mean that session is gone, so no heartbeat and no timeout are involved. The
 * one case that is not a retry is a job that already wrote its file — re-running
 * that would regenerate a draft for nothing, or re-apply a revision to bytes it
 * already revised.
 */
export function planNext(entries, { session, maxConcurrent = 4, max = Infinity, now = Date.now(), mintToken: mint = mintToken }) {
  const recovered = [];
  const reaped = [];
  const running = [];
  const queue = [];

  for (const e of entries) {
    if (!e.job) continue;
    if (e.job.state === 'failed') continue;
    if (e.job.state === 'running') {
      if (e.job.owner?.session === session) { running.push(e); continue; }
      if (e.job.committedAt) {
        recovered.push({ ...e, lastJob: { ...finishedJob(e.job, { outcome: 'recovered — the draft was written before the session ended', now }) } });
        continue;
      }
      const next = failedJob(e.job, { error: 'the session running it ended', now });
      reaped.push({ ...e, job: next });
      if (next.state === 'queued') queue.push({ ...e, job: next });
      continue;
    }
    queue.push(e);
  }

  const slots = Math.max(0, Math.min(maxConcurrent - running.length, max));
  const start = orderQueue(queue).slice(0, slots)
    .map((e) => ({ ...e, job: startedJob(e.job, { session, token: mint(), now }) }));

  return { start, reaped, recovered, running };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/jobs.test.mjs` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/lib/jobs.mjs claude-code/skills/pr-review-track/scripts/test/jobs.test.mjs
git commit -m "Add the job state machine as pure transitions"
```

---

### Task 4: `prt job` — add, list, next, done, fail, cancel, release

**Files:**
- Modify: `scripts/prt.mjs` (new `COMMANDS.job`, help text)
- Test: `scripts/test/jobs-cli.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1–3.
- Produces the CLI contract the skill drives:
  - `prt job add <N>… --kind K [--priority now|batch] [--instructions "…"] [--tier T] [--since <sha>]`
  - `prt job list [--json]` → `{ owner, jobs: [{ number, kind, state, priority, attempts, queuedAt }] }`
  - `prt job next [--max N] [--json]` → `{ owner, started: [{ number, kind, tier, token, payload }], reaped, recovered }`
  - `prt job done <N> --token T [--outcome "…"]`, `prt job fail <N> --token T --error "…"`
  - `prt job cancel <N>… | --all [--force]`, `prt job release [--force]`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/jobs-cli.test.mjs`:

```js
// node --test scripts/test/jobs-cli.test.mjs
//
// The queue through the real CLI against a temp store. What is pinned here is
// the contract the skill drives: who may start work, what a worker is handed,
// and that a result can still be recorded by the session that produced it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRT = path.resolve(HERE, '../prt.mjs');
const REPO = 'o/r';
let ROOT;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-jobcli-'));
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ reviewer: 'me' }));
});
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function track(number, extra = {}) {
  const dir = path.join(ROOT, 'o', 'r', `pr-${number}`);
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
    schema: 1, repo: REPO, number, title: `pr ${number}`, author: 'someone', state: 'OPEN',
    analysis: { number, threadCounts: {}, threads: [] }, ...extra,
  }));
  return dir;
}

function run(args, { session = 's1', pid = process.pid } = {}) {
  const r = spawnSync(process.execPath, [PRT, ...args, '--repo', REPO, '--root', ROOT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(pid) },
  });
  return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

test('adding queues a job the list can see', () => {
  track(1);
  assert.equal(run(['job', 'add', '1', '--kind', 'review', '--tier', 'consensus']).status, 0);
  const list = run(['job', 'list']).json;
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].state, 'queued');
  assert.equal(list.jobs[0].kind, 'review');
});

test('next hands out work with a token, and marks it running', () => {
  const started = run(['job', 'next']).json.started;
  assert.equal(started.length, 1);
  assert.equal(started[0].number, 1);
  assert.match(started[0].token, /^[0-9a-f]{24}$/);
  assert.equal(run(['job', 'list']).json.jobs[0].state, 'running');
});

test('a second live session is refused the queue but can still read and add', () => {
  const refused = run(['job', 'next'], { session: 's2' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.error, /owned by session s1/);
  assert.equal(run(['job', 'list'], { session: 's2' }).status, 0, 'reading is never gated');
  track(2);
  assert.equal(run(['job', 'add', '2', '--kind', 'review'], { session: 's2' }).status, 0);
});

test('done clears the job and records what happened', () => {
  const token = run(['job', 'list']).json.jobs.find((j) => j.number === 1).token;
  assert.equal(run(['job', 'done', '1', '--token', token, '--outcome', 'drafted']).status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'o', 'r', 'pr-1', 'pr.json'), 'utf8'));
  assert.equal(state.job, undefined);
  assert.equal(state.lastJob.outcome, 'drafted');
});

test('a stale token cannot finish a job that was restarted', () => {
  const started = run(['job', 'next']).json.started;   // starts #2
  const stale = 'deadbeefdeadbeefdeadbeef';
  const r = run(['job', 'done', '2', '--token', stale]);
  assert.notEqual(r.status, 0);
  assert.match(r.json.error, /token/);
  assert.equal(run(['job', 'done', '2', '--token', started[0].token]).status, 0);
});

test('failing twice parks the job for a human', () => {
  track(3);
  run(['job', 'add', '3', '--kind', 'review']);
  let t = run(['job', 'next']).json.started[0].token;
  run(['job', 'fail', '3', '--token', t, '--error', 'no worktree']);
  assert.equal(run(['job', 'list']).json.jobs[0].state, 'queued');
  t = run(['job', 'next']).json.started[0].token;
  run(['job', 'fail', '3', '--token', t, '--error', 'again']);
  const job = run(['job', 'list']).json.jobs[0];
  assert.equal(job.state, 'failed');
  assert.equal(job.attempts, 2);
});

test('release hands the repo to another session', () => {
  assert.equal(run(['job', 'release']).status, 0);
  assert.equal(run(['job', 'next'], { session: 's2' }).status, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/jobs-cli.test.mjs`
Expected: FAIL — `prt: "job" is not a command`.

- [ ] **Step 3: Implement**

In `scripts/prt.mjs`, import the new modules and add the command. Place `COMMANDS.job` after `COMMANDS.ask`:

```js
import {
  newJob, planNext, orderQueue, finishedJob, failedJob, JOB_KINDS, mintToken,
} from './lib/jobs.mjs';

/** Who this session is, for the ownership record. */
function sessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
}
function sessionPid() {
  const n = Number(process.env.CLAUDE_PID);
  return Number.isInteger(n) && n > 0 ? n : process.pid;
}

/** Every tracked PR with a job, as `{ number, job }`. */
function jobEntries(base) {
  return store.listTracked(base.root, base.repo)
    .map((number) => ({ number, job: store.readState(base.root, base.repo, number)?.job ?? null }))
    .filter((e) => e.job);
}

function saveJob(base, number, job) {
  const prev = store.readState(base.root, base.repo, number) ?? {};
  store.writeState(base.root, base.repo, number, { ...prev, job });
}

/**
 * Ownership, as a value rather than an exit.
 *
 * `die()` calls process.exit, which does not run a `finally` — so anything that
 * exits while holding the mutex leaks it until the 60 s TTL breaks it, and the
 * next command says the queue is busy for no reason a human can see. Every
 * refusal inside the lock is therefore returned and acted on after it releases.
 */
function ownRepo(base, { force = false } = {}) {
  return store.claimOwner(base.root, base.repo, { session: sessionId(), pid: sessionPid(), force });
}

COMMANDS.job = async () => {
  const base = await context();
  const verb = argv._[1] ?? die('usage: prt job add|list|next|commit|done|fail|cancel|release');
  const numbers = argv._.slice(2).filter((a) => /^\d+$/.test(a)).map(assertSafeNumber);
  const session = sessionId();

  if (verb === 'list') {
    const rows = orderQueue(jobEntries(base)).map(({ number, job }) => ({
      number, kind: job.kind, state: job.state, priority: job.priority,
      attempts: job.attempts, queuedAt: job.queuedAt, token: job.owner?.attemptToken ?? null,
      committedAt: job.committedAt ?? null, lastError: job.lastError ?? null,
    }));
    const owner = store.readOwner(base.root, base.repo);
    emit({ repo: base.repo, owner, jobs: rows });
    if (!JSON_OUT) {
      say(owner ? `queue owner: session ${owner.session} (pid ${owner.pid})` : 'queue owner: nobody');
      for (const r of rows) say(`  #${r.number}  ${r.state.padEnd(7)} ${r.kind}${r.attempts ? `  attempt ${r.attempts}` : ''}${r.lastError ? `  — ${r.lastError}` : ''}`);
      if (!rows.length) say('  (empty)');
    }
    return;
  }

  if (verb === 'add') {
    const kind = argv.flags.kind ?? die('--kind review|re-review|revise is required');
    if (!JOB_KINDS.has(kind)) die(`not a job kind: ${kind}`);
    if (!numbers.length) die('usage: prt job add <PR number>... --kind K');
    const added = store.withJobLock(base.root, base.repo, () => {
      const out = [];
      for (const n of numbers) {
        const state = store.readState(base.root, base.repo, n);
        if (!state) { say(`#${n} is not tracked — run \`prt track ${n}\` first`); continue; }
        const existing = state.job;
        if (existing && existing.state === 'running') { say(`#${n} is already running`); continue; }
        const job = newJob({
          kind,
          priority: argv.flags.priority ?? 'batch',
          instructions: argv.flags.instructions ?? null,
          since: argv.flags.since ?? null,
          tier: argv.flags.tier ?? null,
        });
        saveJob(base, n, job);
        out.push(n);
      }
      return out;
    });
    emit({ added });
    if (added.length) say(`queued ${added.length} job(s): ${added.join(', ')}`);
    return;
  }

  if (verb === 'next') {
    const max = argv.flags.max ? Number(argv.flags.max) : Infinity;
    const result = store.withJobLock(base.root, base.repo, () => {
      // Claiming inside the mutex is what makes "one drainer" true: two
      // sessions asking at the same instant are serialised here, so exactly one
      // of them writes the owner record and the other reads it and loses.
      const claim = ownRepo(base, { force: !!argv.flags.force });
      if (!claim.ok) return { refused: claim };
      const plan = planNext(jobEntries(base), {
        session, maxConcurrent: base.cfg.maxConcurrentJobs ?? 4, max, mintToken,
      });
      for (const e of plan.recovered) {
        const prev = store.readState(base.root, base.repo, e.number) ?? {};
        store.writeState(base.root, base.repo, e.number, { ...prev, job: null, lastJob: e.lastJob });
      }
      for (const e of plan.reaped) saveJob(base, e.number, e.job);
      for (const e of plan.start) saveJob(base, e.number, e.job);
      store.touchOwner(base.root, base.repo, { session, pid: sessionPid() });
      return plan;
    });
    if (result.refused) die(result.refused.reason);
    const started = result.start.map((e) => ({
      number: e.number, kind: e.job.kind, tier: e.job.tier,
      token: e.job.owner.attemptToken, payload: e.job.payload, attempts: e.job.attempts,
    }));
    emit({
      repo: base.repo, started,
      reaped: result.reaped.map((e) => ({ number: e.number, state: e.job.state })),
      recovered: result.recovered.map((e) => ({ number: e.number, outcome: e.lastJob.outcome })),
      running: result.running.map((e) => e.number),
    });
    if (!JSON_OUT) {
      for (const e of result.recovered) say(`#${e.number} recovered — its draft was already written`);
      for (const e of result.reaped) say(`#${e.number} was orphaned → ${e.job.state}`);
      for (const s of started) say(`#${s.number} start ${s.kind} (attempt ${s.attempts})`);
      if (!started.length) say('nothing to start');
    }
    return;
  }

  if (verb === 'done' || verb === 'fail') {
    const n = numbers[0] ?? die(`usage: prt job ${verb} <PR number> --token T`);
    const tok = argv.flags.token ?? die('--token is required — it is handed to the worker by `job next`');
    const refusal = store.withJobLock(base.root, base.repo, () => {
      const state = store.readState(base.root, base.repo, n);
      if (!state) return `#${n} is not tracked`;
      const job = state.job;
      if (!job) return `#${n} has no job`;
      // Finishing is allowed by whoever started it, even after the repo changed
      // hands — what a stale worker must not do is start or overwrite anything.
      if (job.owner?.attemptToken !== tok) return `#${n}: that token is not the current attempt — this job was restarted or cancelled`;
      if (verb === 'done') {
        store.writeState(base.root, base.repo, n, {
          ...state, job: null, lastJob: finishedJob(job, { outcome: argv.flags.outcome ?? 'done' }),
        });
      } else {
        saveJob(base, n, failedJob(job, { error: argv.flags.error ?? 'failed' }));
      }
      store.touchOwner(base.root, base.repo, { session, pid: sessionPid() });
      return null;
    });
    if (refusal) die(refusal);
    emit({ number: n, verb });
    say(`#${n} ${verb === 'done' ? 'done' : 'failed'}`);
    return;
  }

  if (verb === 'cancel') {
    const targets = argv.flags.all ? jobEntries(base).map((e) => e.number) : numbers;
    if (!targets.length) die('usage: prt job cancel <PR number>... | --all');
    const cancelled = store.withJobLock(base.root, base.repo, () => {
      const out = [];
      for (const n of targets) {
        const state = store.readState(base.root, base.repo, n);
        if (!state?.job) continue;
        if (state.job.state === 'running' && !argv.flags.force) {
          say(`#${n} is running — stop its agent first, then \`prt job cancel ${n} --force\``);
          continue;
        }
        store.writeState(base.root, base.repo, n, {
          ...state, job: null,
          lastJob: { kind: state.job.kind, outcome: 'cancelled', attempts: state.job.attempts, finishedAt: new Date().toISOString() },
        });
        out.push(n);
      }
      return out;
    });
    emit({ cancelled });
    say(`cancelled ${cancelled.length} job(s)`);
    return;
  }

  if (verb === 'release') {
    const released = store.releaseOwner(base.root, base.repo, { session, force: !!argv.flags.force });
    emit({ released });
    say(released ? `released the ${base.repo} queue` : 'not the owner — use --force');
    return;
  }

  die(`"${verb}" is not a job verb`);
};
```

Add to `COMMANDS.help`, under `Per PR`:

```
    job add|list|next|done|fail|cancel|release    the background review queue
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/jobs-cli.test.mjs` — all PASS.
Run: `bash scripts/test/run.sh` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/prt.mjs claude-code/skills/pr-review-track/scripts/test/jobs-cli.test.mjs
git commit -m "Add prt job: the queue's command surface"
```

---

### Task 5: Guarded writes — `draft --job-token` and `job commit`

The change that makes prt the only writer of `review.md`.

**Files:**
- Modify: `scripts/prt.mjs` — `COMMANDS.draft` (guard before the write at prt.mjs:615-620), `COMMANDS.job` (add the `commit` verb)
- Test: `scripts/test/jobs-cli.test.mjs`

**Interfaces:**
- Consumes: Task 4's job records.
- Produces: `guardJobWrite(base, number, token)` — throws (exits) unless the token is the current attempt *and* the action file is not protected; returns the job. Called inside `withJobLock` immediately before any write of `review.md`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/jobs-cli.test.mjs`:

```js
// -------------------------------------------------------------- guarded write

function reviewFile(number, status = 'draft') {
  fs.writeFileSync(
    path.join(ROOT, 'o', 'r', `pr-${number}`, 'review.md'),
    `Status: ${status}\n\n<!-- prt:verdict\nevent: COMMENT\n-->\n\n<!-- prt:body -->\nold\n<!-- /prt -->\n`,
  );
}

test('a revise worker commits through prt, and the bytes land', () => {
  track(10);
  reviewFile(10);
  run(['job', 'add', '10', '--kind', 'revise', '--instructions', 'shorter']);
  const t = run(['job', 'next']).json.started.find((s) => s.number === 10).token;
  const from = path.join(ROOT, 'revised.md');
  fs.writeFileSync(from, 'Status: draft\n\nrevised body\n');
  assert.equal(run(['job', 'commit', '10', '--token', t, '--from', from]).status, 0);
  assert.match(fs.readFileSync(path.join(ROOT, 'o', 'r', 'pr-10', 'review.md'), 'utf8'), /revised body/);
  const job = run(['job', 'list']).json.jobs.find((j) => j.number === 10);
  assert.ok(job.committedAt, 'the commit is recorded, so a crash now recovers rather than re-runs');
});

test('a superseded worker cannot overwrite the draft that replaced it', () => {
  track(11);
  reviewFile(11);
  run(['job', 'add', '11', '--kind', 'revise']);
  const stale = run(['job', 'next']).json.started.find((s) => s.number === 11).token;
  // The job is restarted — a takeover, or a retry — and mints a new token.
  run(['job', 'fail', '11', '--token', stale, '--error', 'crashed']);
  run(['job', 'next']);
  const from = path.join(ROOT, 'stale.md');
  fs.writeFileSync(from, 'Status: draft\n\nstale body\n');
  const r = run(['job', 'commit', '11', '--token', stale, '--from', from]);
  assert.notEqual(r.status, 0);
  assert.match(r.json.error, /token/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'o', 'r', 'pr-11', 'review.md'), 'utf8'), /stale body/);
});

test('a file the human armed while the job ran is never written', () => {
  track(12);
  reviewFile(12);
  run(['job', 'add', '12', '--kind', 'revise']);
  const t = run(['job', 'next']).json.started.find((s) => s.number === 12).token;
  reviewFile(12, 'ready');            // the human arms it mid-job
  const from = path.join(ROOT, 'late.md');
  fs.writeFileSync(from, 'Status: draft\n\nlate body\n');
  const r = run(['job', 'commit', '12', '--token', t, '--from', from]);
  assert.notEqual(r.status, 0);
  assert.match(r.json.error, /ready/);
  assert.match(fs.readFileSync(path.join(ROOT, 'o', 'r', 'pr-12', 'review.md'), 'utf8'), /Status: ready/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/jobs-cli.test.mjs`
Expected: FAIL — `"commit" is not a job verb`.

- [ ] **Step 3: Implement**

Add the guard near `COMMANDS.job` in `scripts/prt.mjs`:

```js
/**
 * May this worker write the action file, right now?
 *
 * Both halves have to be answered at the moment of writing, not when the job
 * started. A token that is no longer the current attempt belongs to a worker
 * that was superseded — by a takeover or a retry — and whose output would
 * overwrite the draft that replaced it. And a status can become `ready` while a
 * job runs: `draft` checks it before a network round trip and writes long
 * afterwards, which is exactly the window in which a human arms a file.
 */
function guardJobWrite(base, number, token) {
  const state = store.readState(base.root, base.repo, number);
  const job = state?.job;
  if (!job) return { ok: false, reason: `#${number} has no running job — nothing handed you a token` };
  if (job.owner?.attemptToken !== token) {
    return { ok: false, reason: `#${number}: that token is not the current attempt — this job was restarted or cancelled, so nothing was written` };
  }
  const existing = store.readActionFile(base.root, base.repo, number);
  const status = existing ? parseStatus(existing) : null;
  if (PROTECTED_STATUSES.has(status)) {
    return { ok: false, reason: `#${number}: review.md is "${status}" now — refusing to write over it` };
  }
  return { ok: true, state, job };
}
```

Add the `commit` verb inside `COMMANDS.job`, before the final `die`:

```js
  if (verb === 'commit') {
    const n = numbers[0] ?? die('usage: prt job commit <PR number> --token T --from <file>');
    const tok = argv.flags.token ?? die('--token is required');
    const from = argv.flags.from ?? die('--from <file> is required');
    if (!fs.existsSync(from)) die(`no such file: ${from}`);
    const text = fs.readFileSync(from, 'utf8');
    const refusal = store.withJobLock(base.root, base.repo, () => {
      const guard = guardJobWrite(base, n, tok);
      if (!guard.ok) return guard.reason;
      const { state, job } = guard;
      store.archiveActionFile(base.root, base.repo, n);
      store.writeActionFile(base.root, base.repo, n, text);
      store.writeState(base.root, base.repo, n, {
        ...state, job: { ...job, committedAt: new Date().toISOString() },
      });
      store.touchOwner(base.root, base.repo, { session, pid: sessionPid() });
      return null;
    });
    if (refusal) die(refusal);
    emit({ number: n, committed: true });
    say(`#${n} review.md written`);
    return;
  }
```

In `COMMANDS.draft`, guard the write. Replace the write block at prt.mjs:615-620:

```js
  const target = argv.flags.to
    ? path.join(ctx.prPath, String(argv.flags.to))
    : store.actionFilePath(base.root, base.repo, n);

  // A worker's write is checked where it happens, not where it started: see
  // guardJobWrite. A human running `prt draft` by hand has no token and is
  // covered by the protected-status check at the top of this command.
  const writeIt = () => {
    if (argv.flags['job-token'] && !argv.flags.to) {
      const guard = guardJobWrite(base, n, argv.flags['job-token']);
      if (!guard.ok) return guard.reason;
    }
    if (existing) store.archiveActionFile(base.root, base.repo, n);
    store.ensurePrDir(base.root, base.repo, n);
    store.writeAtomic(target, text);
    if (argv.flags['job-token']) {
      const cur = store.readState(base.root, base.repo, n);
      if (cur?.job) store.writeState(base.root, base.repo, n, { ...cur, job: { ...cur.job, committedAt: new Date().toISOString() } });
    }
  };
  const refusal = argv.flags['job-token']
    ? store.withJobLock(base.root, base.repo, writeIt)
    : writeIt();
  if (refusal) die(refusal);
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/jobs-cli.test.mjs` — all PASS.
Run: `bash scripts/test/run.sh` — no regressions. `prt draft` without `--job-token` must behave exactly as before.

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/prt.mjs claude-code/skills/pr-review-track/scripts/test/jobs-cli.test.mjs
git commit -m "Make prt the only writer of review.md, checked at the write"
```

---

### Task 6: Archive and cleanup know about jobs

**Files:**
- Modify: `scripts/prt.mjs` — add `jobBlocker()`; call it in `COMMANDS.archive` and `COMMANDS.cleanup`; clear queued jobs before the move
- Test: `scripts/test/jobs-cli.test.mjs`

**Interfaces:**
- Consumes: Task 3–4.
- Produces: `jobBlocker(job)` → string reason or null. Deliberately *not* part of `archiveBlocker()`, which speaks only about action-file authority.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/jobs-cli.test.mjs`:

```js
// ------------------------------------------------------------------ archiving

test('a running job blocks archiving, and a queued one is dropped by it', () => {
  track(20);
  track(21);
  run(['job', 'add', '20', '21', '--kind', 'review']);
  run(['job', 'next', '--max', '1']);            // #20 starts, #21 stays queued

  const blocked = run(['archive', '20']);
  assert.match(JSON.stringify(blocked.json ?? blocked.stderr), /running/);
  assert.ok(fs.existsSync(path.join(ROOT, 'o', 'r', 'pr-20')), 'still live');

  assert.equal(run(['archive', '21']).status, 0);
  const moved = path.join(ROOT, '_archive', 'o', 'r', 'pr-21', 'pr.json');
  const state = JSON.parse(fs.readFileSync(moved, 'utf8'));
  assert.equal(state.job, undefined, 'unarchiving must not resurrect work reported as dropped');
  assert.equal(state.lastJob.outcome, 'cancelled');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/jobs-cli.test.mjs`
Expected: FAIL — `archive 20` succeeds and `pr-21`'s archived `pr.json` still carries `job`.

- [ ] **Step 3: Implement**

In `scripts/prt.mjs`, beside `archiveBlocker`:

```js
/**
 * Why a review may not be moved while the queue has an interest in it.
 *
 * Separate from archiveBlocker() on purpose. That one is about the action
 * file's authority — a human signature, an open submit transaction — and job
 * state happens to share the word `queued` while meaning something completely
 * different. Folding them together would let a scheduling concept quietly stand
 * in for an approval one.
 */
function jobBlocker(job) {
  if (job?.state === 'running') return 'a review job is running — stop it first';
  return null;
}

/** Take a queued job off a directory that is about to leave the live tree. */
function dropQueuedJob(base, number) {
  const state = store.readState(base.root, base.repo, number);
  if (!state?.job || state.job.state === 'running') return false;
  store.writeState(base.root, base.repo, number, {
    ...state,
    job: null,
    lastJob: { kind: state.job.kind, outcome: 'cancelled — the PR was archived', attempts: state.job.attempts, finishedAt: new Date().toISOString() },
  });
  return true;
}
```

In `COMMANDS.archive` and in `COMMANDS.cleanup`, where each currently consults `archiveBlocker(status)`, consult both and drop the queued job before moving:

```js
    const blocker = archiveBlocker(status) ?? jobBlocker(store.readState(base.root, base.repo, n)?.job);
    if (blocker) { /* existing refusal path, unchanged */ }
    dropQueuedJob(base, n);
    // …existing move…
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/jobs-cli.test.mjs` — PASS.
Run: `node --test scripts/test/archive.test.mjs` — the existing archive promises still hold.
Run: `bash scripts/test/run.sh`.

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/prt.mjs claude-code/skills/pr-review-track/scripts/test/jobs-cli.test.mjs
git commit -m "Keep archiving away from running jobs, and drop queued ones with it"
```

---

### Task 7: The board shows work that has no file yet

**Files:**
- Modify: `scripts/lib/render.mjs` — `renderBoard`'s "reviews in progress" section (render.mjs:589-613)
- Modify: `scripts/prt.mjs` — `writeBoard` passes each row's job; `COMMANDS.list` and `COMMANDS.doctor` gain a queue line
- Test: `scripts/test/board.test.mjs`

**Interfaces:**
- Consumes: job records from Task 3.
- Produces: `renderBoard({ repo, rows, … })` where a row may now carry `job: { kind, state, attempts }`. A row with a running or queued job appears in "reviews in progress" even with no `review.md`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/board.test.mjs`:

```js
test('a review that is running appears in reviews in progress before any file exists', () => {
  const md = renderBoard({
    repo: 'o/r',
    rows: [
      { number: 1, url: 'u1', title: 'running one', author: 'a', status: null, reviewPath: null, bucket: 'new-commits-to-check', job: { kind: 're-review', state: 'running', attempts: 1 } },
      { number: 2, url: 'u2', title: 'queued one', author: 'b', status: null, reviewPath: null, bucket: 'stale', job: { kind: 'review', state: 'queued', attempts: 0 } },
      { number: 3, url: 'u3', title: 'a real draft', author: 'c', status: 'draft', reviewPath: 'pr-3/review.md', bucket: 'stale' },
    ],
  });
  const section = md.slice(md.indexOf('## reviews in progress'), md.indexOf('## ', md.indexOf('## reviews in progress') + 5));
  assert.match(section, /#1/, 'running work is unfinished work, file or no file');
  assert.match(section, /re-review running/);
  assert.match(section, /#2/);
  assert.match(section, /#3/);
});

test('a failed job says so, because it needs a decision', () => {
  const md = renderBoard({
    repo: 'o/r',
    rows: [{ number: 4, url: 'u', title: 't', author: 'a', status: null, reviewPath: null, bucket: 'stale', job: { kind: 'review', state: 'failed', attempts: 2, lastError: 'no worktree' } }],
  });
  assert.match(md, /failed/);
  assert.match(md, /no worktree/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/test/board.test.mjs`
Expected: FAIL — rows 1, 2 and 4 have no `reviewPath`, so `draftLink` filters them out and the section never mentions them.

- [ ] **Step 3: Implement**

In `scripts/lib/render.mjs`, widen the section's membership and add a column:

```js
  // A row belongs here if there is unfinished work on it: a draft file that is
  // not done with, or a job that has not finished. The second half is the whole
  // point of the queue — work that is running has no file yet, and a review
  // nobody can see is exactly the thing this section exists to prevent.
  const jobCell = (r) => (r.job ? `${r.job.kind} ${r.job.state}${r.job.attempts > 1 ? ` (attempt ${r.job.attempts})` : ''}${r.job.lastError ? ` — ${cell(r.job.lastError)}` : ''}` : '');
  const unfinished = (r) => draftLink(r) || (r.job && r.job.state !== 'done');

  const inProgress = ordered.filter(unfinished);
  if (inProgress.length) {
    out.push(`## reviews in progress (${inProgress.length})`, '');
    out.push('_Reviews I started and have not finished: a `review.md` exists and its status is');
    out.push(`neither \`submitted\` nor \`skip\`, or a job for it is queued, running or failed.${storeDir ? ` Links are relative to \`${storeDir}\`.` : ''}_`);
    out.push('');
    out.push('| PR | status | job | author | draft | bucket | title |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of inProgress) {
      const link = draftLink(r) ? `[review.md](${draftLink(r)})` : '—';
      out.push(`| [#${r.number}](${r.url}) | \`${r.status ?? '—'}\` | ${jobCell(r)} | ${r.author ?? '?'} | ${link} | ${r.bucket} | ${title(r)} |`);
    }
    out.push('');
  }
```

In `scripts/prt.mjs`'s `writeBoard`, include `job: state.job ?? null` on each row it builds. In `COMMANDS.list` and `COMMANDS.doctor`, add one line:

```js
  const q = jobEntries(base);
  if (q.length) say(`queue: ${q.filter((e) => e.job.state === 'running').length} running, ${q.filter((e) => e.job.state === 'queued').length} queued, ${q.filter((e) => e.job.state === 'failed').length} failed`);
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/board.test.mjs` — PASS.
Run: `bash scripts/test/run.sh`.

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/scripts/lib/render.mjs claude-code/skills/pr-review-track/scripts/prt.mjs claude-code/skills/pr-review-track/scripts/test/board.test.mjs
git commit -m "Show running and queued reviews as unfinished work on the board"
```

---

### Task 8: Teach the skill to drive the queue

No test suite can check this one; it is the prose the model follows. Keep it short enough to be followed exactly.

**Files:**
- Modify: `SKILL.md` — routing table, invariants, `Re-review` step 3, `Review latest` step 4, `Revisit draft`, a new `## The job queue` section
- Modify: `references/commands.md` — a `prt job` reference section

- [ ] **Step 1: Rewrite the two batch procedures**

In `SKILL.md`, `Re-review` step 3 becomes:

```markdown
3. **Queue the batch, then drain it.**
   ```bash
   node "$PRT" job add <N>… --kind re-review --tier <batch tier>
   node "$PRT" job next --max 4
   ```
   `job next` prints one entry per job to start, each with a `token`. Spawn one
   agent per entry — never more than it handed you — and **end your turn**. The
   human gets the prompt back while the batch runs.
```

`Review latest` step 4 becomes the same two commands with `--kind review`.

`Revisit draft` gains, in place of editing the file directly:

```markdown
A revision is a `now`-priority job, so it takes the next free slot ahead of any
batch:

```bash
node "$PRT" job add <N> --kind revise --priority now --instructions "<their words>"
node "$PRT" job next --max 1
```

The worker edits the bytes it read, writes them to `cache/revise-<token>.md`, and
commits with `node "$PRT" job commit <N> --token <token> --from <that file>`.
It never writes `review.md` itself: the commit re-checks the token and line 1
under the queue lock, which is what stops a superseded worker — or one whose file
you armed while it was thinking — from overwriting your decision.
```

- [ ] **Step 2: Add the job-queue section**

Add to `SKILL.md` after `Arm the watcher`:

```markdown
## The job queue

Per-PR work runs as background jobs so the terminal stays yours. The queue is on
disk, so it survives this session ending; the workers do not, and are restarted
from it.

**Every request starts with a drain.** Before anything else, run
`node "$PRT" job next --max 4`. That is also the only thing that resumes queued
work — nothing runs on a timer, so a session that never invokes this skill never
touches the queue.

**One session drains a repo at a time.** If `job next` says another session owns
the queue, do not force it: tell the human which session has it. A crashed owner
is taken over automatically, and so is one that has done nothing for 30 minutes.

**The loop.** Spawn one agent per entry `job next` hands you, then end the turn.
When an agent completes: print one line for that PR, run `job next` again to
fill the freed slot, spawn, end the turn. When the queue is empty, give the batch
summary and arm the watcher.

**Every worker gets, in its prompt:** the PR number, the repo, the tier, the
payload, its `token`, and this contract —

> Do the work. Write `review.md` only through `prt draft <N> --job-token <token>`
> or `prt job commit <N> --token <token> --from <file>`. Finish with
> `prt job done <N> --token <token> --outcome "<one line>"`, or
> `prt job fail <N> --token <token> --error "<why>"`. Return at most five lines:
> number, what happened, recommended resolution, path to the file.

**If an agent finishes and its job is still `running`,** it died without
recording anything. Record it yourself with `job fail`, and say so in your report
— silently losing a job is the failure this queue exists to prevent.

**Never arm anything.** Jobs draft. `Status: ready` is still the human's, and
invariants 1–3 apply to workers exactly as they apply to you.
```

- [ ] **Step 3: Document the commands**

In `references/commands.md`, add a `### prt job …` section under **Per PR** covering the eight verbs, the ownership rules table from the spec, and a pointer to the design doc.

- [ ] **Step 4: Check the whole thing still runs**

Run: `bash scripts/test/run.sh` — everything passes.
Run: `node scripts/prt.mjs help` — the new command appears.
Run a real end-to-end against your own store, on one PR you do not mind re-drafting:
`node scripts/prt.mjs job add <N> --kind re-review --tier lean && node scripts/prt.mjs job next --max 1`

- [ ] **Step 5: Commit**

```bash
git add claude-code/skills/pr-review-track/SKILL.md claude-code/skills/pr-review-track/references/commands.md
git commit -m "Teach pr-review-track to run reviews as background jobs"
```

---

## Notes for the executor

- **Order matters.** Task 1 is a prerequisite for everything: without the merge contract, `prt sync` erases the queue between tasks and the later tests fail in confusing ways.
- **Don't widen the blast radius.** `prt draft` without `--job-token` must behave exactly as it does today; the existing suite is the check.
- **The house style is prose comments explaining why.** Match `store.mjs` and `submit.mjs`, not typical JSDoc.
- **Test names state promises**, e.g. "a superseded worker cannot overwrite the draft that replaced it" — not "test commit token".
