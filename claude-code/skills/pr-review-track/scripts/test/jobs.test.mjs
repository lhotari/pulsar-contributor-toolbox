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
