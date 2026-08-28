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
