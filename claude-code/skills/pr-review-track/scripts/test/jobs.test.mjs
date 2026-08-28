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

// ----------------------------------------------------------------- ownership
//
// One drainer per repository, so a second session cannot start the same batch
// by accident. The rules answer that question and no more: it is ours, its
// process is gone, or it has done nothing for half an hour.

const NO_SUCH_PID = 999_999_999;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const resetOwner = () => store.releaseOwner(ROOT, REPO, { session: 'x', force: true });

test('the first session to ask owns the repo, and asking again is a no-op', () => {
  resetOwner();
  const first = store.claimOwner(ROOT, REPO, { session: 's1', pid: process.pid });
  assert.equal(first.ok, true);
  assert.equal(first.how, 'new');
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's1', pid: process.pid }).how, 'ours');
});

test('a second live session is refused, and told who holds it', () => {
  resetOwner();
  store.claimOwner(ROOT, REPO, { session: 's1', pid: process.pid });
  const r = store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid });
  assert.equal(r.ok, false);
  assert.equal(r.owner.session, 's1');
  assert.match(r.reason, /s1/);
});

test('a crashed owner is taken over at once, without waiting out a timeout', () => {
  resetOwner();
  store.writeOwnerForTest(ROOT, REPO, { session: 'dead', pid: NO_SUCH_PID, since: iso(), lastActivityAt: iso() });
  const r = store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'crashed');
});

test('a live but wedged owner is taken over after 30 minutes of no activity', () => {
  resetOwner();
  const stale = iso(31 * 60_000);
  store.writeOwnerForTest(ROOT, REPO, { session: 'wedged', pid: process.pid, since: stale, lastActivityAt: stale });
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid }).how, 'idle');

  resetOwner();
  const recent = iso(29 * 60_000);
  store.writeOwnerForTest(ROOT, REPO, { session: 'busy', pid: process.pid, since: recent, lastActivityAt: recent });
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid }).ok, false, '29 minutes is still working');
});

test('activity keeps a lease alive; only the holder may touch it', () => {
  resetOwner();
  const stale = iso(29 * 60_000);
  store.writeOwnerForTest(ROOT, REPO, { session: 's1', pid: process.pid, since: stale, lastActivityAt: stale });
  assert.equal(store.touchOwner(ROOT, REPO, { session: 's2' }), false, 'not the holder');
  assert.equal(store.touchOwner(ROOT, REPO, { session: 's1' }), true);
  assert.ok(Date.parse(store.readOwner(ROOT, REPO).lastActivityAt) > Date.parse(stale));
});

test('force takes it, and release only works for the holder unless forced', () => {
  resetOwner();
  store.writeOwnerForTest(ROOT, REPO, { session: 'busy', pid: process.pid, since: iso(), lastActivityAt: iso() });
  assert.equal(store.claimOwner(ROOT, REPO, { session: 's2', pid: process.pid, force: true }).how, 'forced');
  assert.equal(store.releaseOwner(ROOT, REPO, { session: 'not-s2' }), false);
  assert.equal(store.releaseOwner(ROOT, REPO, { session: 's2' }), true);
  assert.equal(store.readOwner(ROOT, REPO), null);
});

// --------------------------------------------------------------------- mutex

test('the mutex serialises: a second holder cannot enter while the first is inside', () => {
  let inner = 'not run';
  store.withJobLock(ROOT, REPO, () => {
    assert.throws(
      () => store.withJobLock(ROOT, REPO, () => { inner = 'ran'; }, { attempts: 1, waitMs: 1 }),
      /busy/,
    );
  });
  assert.equal(inner, 'not run');
  assert.equal(store.withJobLock(ROOT, REPO, () => 'ok'), 'ok', 'and it is released afterwards');
});

test('the mutex is released even when the body throws', () => {
  assert.throws(() => store.withJobLock(ROOT, REPO, () => { throw new Error('boom'); }), /boom/);
  assert.equal(store.withJobLock(ROOT, REPO, () => 'ok'), 'ok');
});

// -------------------------------------------------------------- the machine
//
// Pure transitions over plain objects. The rules worth pinning are the ones a
// human would get wrong: what a dead session leaves behind, and when a retry is
// the wrong answer because the work already landed.

import {
  newJob, orderQueue, planNext, startedJob, failedJob, finishedJob, RETRY_CAP,
} from '../lib/jobs.mjs';

const at = (s) => Date.parse(s);
const queued = (over = {}) => ({
  ...newJob({ kind: 'review', tier: 'consensus', now: at('2026-08-28T10:00:00Z') }),
  ...over,
});
const entry = (number, job) => ({ number, job });
const stubToken = () => 'tok';

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
  entries.push(entry(9, { ...queued(), state: 'running', owner: { session: 's1', attemptToken: 'x' } }));
  const plan = planNext(entries, { session: 's1', maxConcurrent: 4, mintToken: stubToken });
  assert.equal(plan.start.length, 3, 'four slots, one already running');
  assert.deepEqual(plan.start.map((e) => e.number), [1, 2, 3]);
});

test('--max asks for fewer than the free slots', () => {
  const entries = [1, 2, 3].map((n) => entry(n, queued({ queuedAt: `2026-08-28T0${n}:00:00Z` })));
  assert.equal(planNext(entries, { session: 's1', maxConcurrent: 4, max: 1, mintToken: stubToken }).start.length, 1);
});

test('starting a job stamps the owner, a fresh token, and one more attempt', () => {
  const started = startedJob(queued(), { session: 's1', token: 'abc', now: at('2026-08-28T12:00:00Z') });
  assert.equal(started.state, 'running');
  assert.equal(started.attempts, 1);
  assert.equal(started.owner.session, 's1');
  assert.equal(started.owner.attemptToken, 'abc');
  assert.equal(started.startedAt, '2026-08-28T12:00:00.000Z');
});

test('a job owned by another session is orphaned and started again', () => {
  const orphan = { ...queued(), state: 'running', attempts: 1, owner: { session: 'dead', attemptToken: 'x' } };
  const plan = planNext([entry(7, orphan)], { session: 's1', maxConcurrent: 4, mintToken: stubToken });
  assert.deepEqual(plan.reaped.map((e) => e.number), [7]);
  assert.equal(plan.start[0].job.state, 'running');
  assert.equal(plan.start[0].job.attempts, 2);
});

test('a job running under this session is left alone by the reaper', () => {
  const mine = { ...queued(), state: 'running', attempts: 1, owner: { session: 's1', attemptToken: 'x' } };
  const plan = planNext([entry(7, mine)], { session: 's1', maxConcurrent: 4, mintToken: stubToken });
  assert.deepEqual(plan.reaped, []);
  assert.deepEqual(plan.start, []);
  assert.deepEqual(plan.running.map((e) => e.number), [7]);
});

test('a job that already wrote its file is recovered, never re-run', () => {
  const committed = {
    ...queued(), state: 'running', attempts: 1, committedAt: '2026-08-28T12:30:00Z',
    owner: { session: 'dead', attemptToken: 'x' },
  };
  const plan = planNext([entry(8, committed)], { session: 's1', maxConcurrent: 4, mintToken: stubToken });
  assert.deepEqual(plan.recovered.map((e) => e.number), [8]);
  assert.deepEqual(plan.start, [], 're-running would re-apply a revise to bytes it already revised');
  assert.match(plan.recovered[0].lastJob.outcome, /recovered/);
});

test('a failed job is never picked up again on its own', () => {
  const parked = { ...queued(), state: 'failed', attempts: 2 };
  const plan = planNext([entry(5, parked)], { session: 's1', maxConcurrent: 4, mintToken: stubToken });
  assert.deepEqual(plan.start, []);
  assert.deepEqual(plan.reaped, []);
});

test('the second failure parks the job instead of looping', () => {
  const once = failedJob({ ...queued(), state: 'running', attempts: 1 }, { error: 'no worktree' });
  assert.equal(once.state, 'queued');
  assert.equal(once.lastError, 'no worktree');
  const twice = failedJob({ ...once, state: 'running', attempts: RETRY_CAP }, { error: 'again' });
  assert.equal(twice.state, 'failed');
});

test('finishing produces the lastJob row the board shows', () => {
  const last = finishedJob({ ...queued(), state: 'running', attempts: 1 }, {
    outcome: 'drafted, 2 findings', now: at('2026-08-28T13:00:00Z'),
  });
  assert.deepEqual(last, {
    kind: 'review', outcome: 'drafted, 2 findings', attempts: 1, finishedAt: '2026-08-28T13:00:00.000Z',
  });
});

test('a job kind or priority nobody defined is refused at the door', () => {
  assert.throws(() => newJob({ kind: 'nudge' }), /not a job kind/);
  assert.throws(() => newJob({ kind: 'review', priority: 'urgent' }), /not a priority/);
});
