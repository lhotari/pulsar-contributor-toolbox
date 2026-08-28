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

// ------------------------------------------------------------- guarded writes
//
// prt is the only writer of review.md, and both halves of the permission are
// re-asked at the moment of writing: is this still the current attempt, and is
// the file still one a worker may touch. Checking either when the job started
// would be checking it minutes too early.

function reviewFile(number, status = 'draft') {
  fs.writeFileSync(
    path.join(prDir(number), 'review.md'),
    `Status: ${status}\n\n<!-- prt:verdict\nevent: COMMENT\n-->\n\n<!-- prt:body -->\nold\n<!-- /prt -->\n`,
  );
}

/** Take the queue back: the test above deliberately hands it to another session. */
const reclaim = () => {
  run(['job', 'release', '--force']);
  run(['job', 'cancel', '--all', '--force']);
};

function startJob(number, kind = 'revise') {
  track(number);
  reviewFile(number);
  run(['job', 'add', String(number), '--kind', kind]);
  return run(['job', 'next']).json.started.find((s) => s.number === number).token;
}

test('a revise worker commits through prt, and the bytes land', () => {
  reclaim();
  const token = startJob(20);
  const from = path.join(ROOT, 'revised.md');
  fs.writeFileSync(from, 'Status: draft\n\nrevised body\n');

  assert.equal(run(['job', 'commit', '20', '--token', token, '--from', from]).status, 0);
  assert.match(fs.readFileSync(path.join(prDir(20), 'review.md'), 'utf8'), /revised body/);
  assert.ok(jobRow(20).committedAt, 'a crash after this recovers rather than re-runs');
  assert.equal(fs.readdirSync(path.join(prDir(20), 'history')).length, 1, 'the replaced file is kept');
});

test('a superseded worker cannot overwrite the draft that replaced it', () => {
  reclaim();
  const stale = startJob(21);
  // The job is restarted — a takeover, or a retry — and mints a new token.
  run(['job', 'fail', '21', '--token', stale, '--error', 'crashed']);
  run(['job', 'next']);

  const from = path.join(ROOT, 'stale.md');
  fs.writeFileSync(from, 'Status: draft\n\nstale body\n');
  const r = run(['job', 'commit', '21', '--token', stale, '--from', from]);
  assert.notEqual(r.status, 0);
  assert.match(r.json.error, /not the current attempt/);
  assert.doesNotMatch(fs.readFileSync(path.join(prDir(21), 'review.md'), 'utf8'), /stale body/);
});

test('a file the human armed while the job ran is never written', () => {
  reclaim();
  const token = startJob(22);
  reviewFile(22, 'ready');                       // the human arms it mid-job

  const from = path.join(ROOT, 'late.md');
  fs.writeFileSync(from, 'Status: draft\n\nlate body\n');
  const r = run(['job', 'commit', '22', '--token', token, '--from', from]);
  assert.notEqual(r.status, 0);
  assert.match(r.json.error, /ready/);
  assert.match(fs.readFileSync(path.join(prDir(22), 'review.md'), 'utf8'), /Status: ready/);
  assert.doesNotMatch(fs.readFileSync(path.join(prDir(22), 'review.md'), 'utf8'), /late body/);
});

test('the mutex is not left behind by a refused write', () => {
  // A refusal that exited while holding the lock would make the next command
  // report a busy queue for no reason anyone could see.
  assert.equal(run(['job', 'list']).status, 0);
  assert.equal(run(['job', 'cancel', '--all', '--force']).status, 0);
});

// ------------------------------------------------------------------ archiving
//
// Job state and action-file state share the word `queued` and mean different
// things, so they get different checks. What archiving must never do is take a
// directory out from under a live worker, or leave a queued job in it for
// `unarchive` to resurrect months later.

test('a running job blocks archiving, and a queued one is dropped by it', () => {
  reclaim();
  track(30); track(31);
  run(['job', 'add', '30', '31', '--kind', 'review']);
  run(['job', 'next', '--max', '1']);            // one starts, one stays queued

  const running = jobRow(30).state === 'running' ? 30 : 31;
  const waiting = running === 30 ? 31 : 30;

  const blocked = run(['archive', String(running)]);
  assert.notEqual(blocked.status, 0);
  assert.match(JSON.stringify(blocked.json), /running/);
  assert.ok(fs.existsSync(prDir(running)), 'still live');

  assert.equal(run(['archive', String(waiting)]).status, 0);
  const moved = path.join(ROOT, '_archive', 'o', 'r', `pr-${waiting}`, 'pr.json');
  const state = JSON.parse(fs.readFileSync(moved, 'utf8'));
  assert.equal(state.job, undefined, 'unarchive must not resurrect work reported as dropped');
  assert.match(state.lastJob.outcome, /archived/);
});
