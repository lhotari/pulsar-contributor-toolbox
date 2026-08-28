// node --test scripts/test/jobs-cli.test.mjs
//
// The queue through the real CLI against a temp store. What is pinned here is
// the contract the skill drives: who may start work, what a worker is handed,
// and that a result can still be recorded by the session that produced it.
//
// These run in order on one store, the way a session would: add, drain, finish.

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
  // A cached reviewer keeps `context()` off `gh api user`.
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ reviewer: 'me' }));
});
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const prDir = (n) => path.join(ROOT, 'o', 'r', `pr-${n}`);
const readState = (n) => JSON.parse(fs.readFileSync(path.join(prDir(n), 'pr.json'), 'utf8'));

function track(number) {
  fs.mkdirSync(path.join(prDir(number), 'cache'), { recursive: true });
  fs.writeFileSync(path.join(prDir(number), 'pr.json'), JSON.stringify({
    schema: 1, repo: REPO, number, title: `pr ${number}`, author: 'someone', state: 'OPEN',
    analysis: { number, threadCounts: {}, threads: [] },
  }));
  return prDir(number);
}

function run(args, { session = 's1', pid = process.pid } = {}) {
  const r = spawnSync(process.execPath, [PRT, ...args, '--repo', REPO, '--root', ROOT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(pid) },
  });
  return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const jobRow = (n) => run(['job', 'list']).json.jobs.find((j) => j.number === n);

test('adding queues a job the list can see', () => {
  track(1);
  assert.equal(run(['job', 'add', '1', '--kind', 'review', '--tier', 'consensus']).status, 0);
  const row = jobRow(1);
  assert.equal(row.state, 'queued');
  assert.equal(row.kind, 'review');
});

test('a job for a PR nobody is tracking is refused, not invented', () => {
  const r = run(['job', 'add', '404', '--kind', 'review']);
  assert.deepEqual(r.json.added, []);
});

test('next hands out work with a token, and marks it running', () => {
  const started = run(['job', 'next']).json.started;
  assert.equal(started.length, 1);
  assert.equal(started[0].number, 1);
  assert.match(started[0].token, /^[0-9a-f]{24}$/);
  assert.equal(started[0].tier, 'consensus', 'the tier is stamped at enqueue, not re-decided');
  assert.equal(jobRow(1).state, 'running');
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
  const { token } = jobRow(1);
  assert.equal(run(['job', 'done', '1', '--token', token, '--outcome', 'drafted']).status, 0);
  const state = readState(1);
  assert.equal(state.job, undefined);
  assert.equal(state.lastJob.outcome, 'drafted');
  assert.equal(state.title, 'pr 1', 'the rest of the document is untouched');
});

test('a stale token cannot finish a job, and the right one can', () => {
  const started = run(['job', 'next']).json.started;
  assert.deepEqual(started.map((s) => s.number), [2]);
  const stale = 'deadbeefdeadbeefdeadbeef';
  const r = run(['job', 'done', '2', '--token', stale]);
  assert.notEqual(r.status, 0);
  assert.match(r.json.error, /token/);
  assert.equal(run(['job', 'done', '2', '--token', started[0].token]).status, 0);
});

test('failing twice parks the job for a human instead of looping', () => {
  track(3);
  run(['job', 'add', '3', '--kind', 'review']);
  let token = run(['job', 'next']).json.started[0].token;
  run(['job', 'fail', '3', '--token', token, '--error', 'no worktree']);
  assert.equal(jobRow(3).state, 'queued', 'the first failure is a retry');

  token = run(['job', 'next']).json.started[0].token;
  run(['job', 'fail', '3', '--token', token, '--error', 'again']);
  const row = jobRow(3);
  assert.equal(row.state, 'failed');
  assert.equal(row.attempts, 2);
  assert.equal(row.lastError, 'again');

  // And a parked job is not handed out again on its own.
  assert.deepEqual(run(['job', 'next']).json.started, []);
});

test('what you ask for now goes ahead of a batch already waiting', () => {
  track(10); track(11);
  run(['job', 'cancel', '--all', '--force']);
  run(['job', 'add', '10', '--kind', 'review']);                       // batch
  run(['job', 'add', '11', '--kind', 'revise', '--priority', 'now', '--instructions', 'shorter']);
  const started = run(['job', 'next', '--max', '1']).json.started;
  assert.equal(started[0].number, 11);
  assert.equal(started[0].payload.instructions, 'shorter');
});

test('cancel refuses a running job unless forced, and always says so', () => {
  const before = jobRow(11);
  assert.equal(before.state, 'running');
  run(['job', 'cancel', '11']);
  assert.equal(jobRow(11).state, 'running', 'not dropped from under a live agent');
  run(['job', 'cancel', '11', '--force']);
  assert.equal(readState(11).job, undefined);
  assert.equal(readState(11).lastJob.outcome, 'cancelled');
});

test('release hands the repo to another session', () => {
  assert.equal(run(['job', 'release']).status, 0);
  assert.equal(run(['job', 'next'], { session: 's2' }).status, 0);
});
