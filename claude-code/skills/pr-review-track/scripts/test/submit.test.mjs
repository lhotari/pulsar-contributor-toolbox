// node --test scripts/test/submit.test.mjs
//
// The transaction machine, driven against a fake `gh`. These are the tests that
// matter most: everything here only runs when something has already gone wrong,
// which is exactly why it cannot be checked by reading the code.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '../..');

let ROOT;
let BIN;

const HEAD = 'a'.repeat(40);
const REPO = 'o/r';
const PR = 1;

const DIFF = `diff --git a/A.java b/A.java
--- a/A.java
+++ b/A.java
@@ -10,3 +10,4 @@
 ctx10
+add11
+add12
 ctx13
`;

/** The GraphQL PR payload preflight fetches. */
function prJson({ state = 'OPEN', head = HEAD, author = 'someone' } = {}) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: 'PR_1',
          number: PR,
          title: 't',
          url: 'u',
          state,
          isDraft: false,
          merged: false,
          headRefOid: head,
          baseRefName: 'master',
          authorAssociation: 'MEMBER',
          author: { login: author },
          labels: { nodes: [] },
          commits: { nodes: [] },
          reviews: { nodes: [] },
          reviewThreads: { nodes: [] },
          comments: { nodes: [] },
        },
      },
    },
  });
}

/** Rules every scenario needs: identity, PR fetch, diff, pending-review check. */
function baseRules(extra = [], { prState = 'OPEN', head = HEAD, author = 'someone' } = {}) {
  return [
    ...extra,
    { when: { args: ['graphql'], body: 'viewer' }, stdout: '{"data":{"viewer":{"login":"me"}}}' },
    { when: { args: ['graphql'], body: 'pullRequest' }, stdout: prJson({ state: prState, head, author }) },
    { when: { args: ['pr', 'diff'] }, stdout: DIFF },
    { when: { arg: 'pulls/1/reviews', args: ['--paginate'] }, stdout: '[[]]' },
    { when: { arg: 'pulls/1/comments', args: ['--paginate'] }, stdout: '[[]]' },
    { when: { arg: 'issues/1/comments', args: ['--paginate'] }, stdout: '[[]]' },
    { when: { arg: 'actions/runs?head_sha=', args: ['--method', 'GET'] }, stdout: '{"workflow_runs":[]}' },
  ];
}

function writeScenario(name, rules, callLog) {
  const p = path.join(ROOT, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ callLog, rules }, null, 2));
  try { fs.unlinkSync(`${p}.fired`); } catch { /* fresh run */ }
  return p;
}

function actionFile({ event = 'COMMENT', body = 'Summary.', inline = true, head = HEAD } = {}) {
  const parts = [
    'Status: ready',
    '',
    '<!-- prt:doc',
    'schema: 1',
    `repo: ${REPO}`,
    `pr: ${PR}`,
    `head: ${head}`,
    'base-ref: master',
    '-->',
    '',
    '<!-- prt:verdict',
    `event: ${event}`,
    '-->',
    '',
  ];
  if (body) parts.push('<!-- prt:body -->', body, '<!-- /prt -->', '');
  if (inline) {
    parts.push('<!-- prt:inline', 'id: i1', 'path: A.java', 'line: 11', 'side: RIGHT', '-->', 'Inline text.', '<!-- /prt -->', '');
  }
  return `${parts.join('\n')}\n`;
}

/** Run `prt submit` with the fake gh first on PATH. */
function runPrt(args, scenarioPath, env = {}) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, [path.join(SKILL, 'scripts/prt.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      PRT_ROOT: ROOT,
      PRT_FAKE_GH: scenarioPath,
      ...env,
    },
  });
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-tx-'));
  BIN = path.join(ROOT, 'bin');
  fs.mkdirSync(BIN, { recursive: true });
  const shim = path.join(BIN, 'gh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(SKILL, 'scripts/test/helpers/fake-gh.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function setupPr(text) {
  const dir = path.join(ROOT, 'o', 'r', 'pr-1');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), text);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ schema: 1, repo: REPO, number: PR, title: 't', state: 'OPEN' }));
  return dir;
}

function calls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const isWrite = (c) => c.args.includes('--method') && c.args.includes('POST');

test('happy path: one review POST carrying exactly the approved bytes', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'happy.jsonl');
  const scenario = writeScenario('happy', baseRules([
    {
      when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' },
      stdout: '{"id":99,"state":"COMMENTED","html_url":"https://x/1#r99"}',
    },
  ]), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(r.status, 0, r.stderr);

  const posts = calls(log).filter(isWrite);
  assert.equal(posts.length, 1, 'exactly one write');
  const payload = JSON.parse(posts[0].stdin);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.body, 'Summary.');
  assert.equal(payload.commit_id, HEAD);
  assert.deepEqual(payload.comments, [{ path: 'A.java', body: 'Inline text.', line: 11, side: 'RIGHT' }]);

  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').split('\n')[0], 'Status: submitted');
});

test('Status ready authorises an APPROVE workflow without a second doc flag', () => {
  const dir = setupPr(actionFile({ event: 'APPROVE' }));
  const log = path.join(ROOT, 'approve.jsonl');
  const scenario = writeScenario('approve', baseRules([
    {
      when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' },
      stdout: '{"id":100,"state":"APPROVED","html_url":"https://x/1#r100"}',
    },
  ]), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(r.status, 0, r.stderr);
  const posts = calls(log).filter(isWrite);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].stdin).event, 'APPROVE');
  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').split('\n')[0], 'Status: submitted');
});

test('APPROVE also approves every action_required workflow run on the PR head', () => {
  const dir = setupPr(actionFile({ event: 'APPROVE' }));
  const log = path.join(ROOT, 'approve-runs.jsonl');
  const pendingRuns = JSON.stringify({ workflow_runs: [
    { id: 701, head_sha: HEAD, pull_requests: [{ number: PR }] },
    { id: 702, head_sha: HEAD, pull_requests: [{ number: PR }] },
    { id: 999, head_sha: HEAD, pull_requests: [{ number: 99 }] },
  ] });
  const scenario = writeScenario('approve-runs', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, stdout: '{"id":101,"state":"APPROVED","html_url":"https://x/1#r101"}' },
    { when: { args: ['--method', 'GET'], arg: 'actions/runs?head_sha=' }, stdout: pendingRuns },
    { when: { args: ['--method', 'POST'], arg: 'actions/runs/701/approve' }, stdout: '' },
    { when: { args: ['--method', 'POST'], arg: 'actions/runs/702/approve' }, stdout: '' },
  ]), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(r.status, 0, r.stderr);
  const postTargets = calls(log).filter(isWrite).map((c) => c.args.find((x) => x.includes('repos/o/r/')));
  assert.deepEqual(postTargets, [
    'repos/o/r/pulls/1/reviews',
    'repos/o/r/actions/runs/701/approve',
    'repos/o/r/actions/runs/702/approve',
  ]);
  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').split('\n')[0], 'Status: submitted');
});

test('a review payload is never sent without an event', () => {
  // An eventless POST creates an invisible PENDING review that then blocks
  // every later submit on the PR.
  const dir = setupPr(actionFile().replace('<!-- prt:verdict\nevent: COMMENT\n-->\n\n', ''));
  const log = path.join(ROOT, 'noevent.jsonl');
  const scenario = writeScenario('noevent', baseRules(), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.notEqual(r.status, 0);
  assert.equal(calls(log).filter(isWrite).length, 0, 'nothing was posted');
  assert.match(fs.readFileSync(path.join(dir, 'review.md'), 'utf8'), /prt:verdict/);
});

test('preflight blocks and posts nothing when the head has moved', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'moved.jsonl');
  const scenario = writeScenario('moved', baseRules([], { head: 'b'.repeat(40) }), log);

  runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(calls(log).filter(isWrite).length, 0);
  const out = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(out.split('\n')[0], 'Status: blocked');
  assert.match(out, /head moved/);
});

test('a crash during preflight does not wedge the PR: the next run recovers', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'crash-pre.jsonl');

  // Die on the pending-review check, which happens after capture: the file is
  // already `queued` and the transaction already `captured`.
  const crash = writeScenario('crash-pre', baseRules([
    { when: { arg: 'pulls/1/reviews', args: ['--paginate'] }, die: true },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], crash);
  assert.equal(calls(log).filter(isWrite).length, 0, 'nothing posted before the crash');

  // Second run: the file says `queued`, not `ready`. Re-running preflight from
  // the snapshot is the only way out that neither wedges nor posts unchecked.
  const log2 = path.join(ROOT, 'crash-pre2.jsonl');
  const ok = writeScenario('crash-pre2', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, stdout: '{"id":7,"state":"COMMENTED","html_url":"u7"}' },
  ]), log2);
  const r2 = runPrt(['submit', '1', '--repo', REPO], ok);
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.equal(calls(log2).filter(isWrite).length, 1, 'the resumed run posted exactly once');
  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').split('\n')[0], 'Status: submitted');
});

test('a crash mid-POST is reconciled, not re-posted', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'crash-post.jsonl');

  const crash = writeScenario('crash-post', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, die: true },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], crash);

  // The review actually landed on GitHub before the connection died. Recovery
  // must find it by body + commit + time and NOT post a second one.
  const log2 = path.join(ROOT, 'crash-post2.jsonl');
  const landed = JSON.stringify([[{
    id: 55,
    user: { login: 'me' },
    state: 'COMMENTED',
    body: 'Summary.',
    commit_id: HEAD,
    submitted_at: new Date(Date.now() + 1000).toISOString(),
    html_url: 'https://x/1#r55',
  }]]);
  const recover = writeScenario('crash-post2', [
    { when: { arg: 'pulls/1/reviews', args: ['--paginate'] }, stdout: landed },
    ...baseRules(),
  ], log2);

  const r2 = runPrt(['recover', '1', '--repo', REPO], recover);
  assert.equal(calls(log2).filter(isWrite).length, 0, 'recovery must not re-post');
  // The action is reconciled against the review that already landed, and its
  // URL is reported — the human sees where their words went.
  assert.match(`${r2.stdout}`, /r55/);
  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').split('\n')[0], 'Status: submitted');
});

test('recovery refuses to match a stale look-alike review', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'stale.jsonl');
  const crash = writeScenario('stale', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, die: true },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], crash);

  // Same body, but submitted long before this transaction started: it is a
  // different review and must not be mistaken for ours.
  const log2 = path.join(ROOT, 'stale2.jsonl');
  const old = JSON.stringify([[{
    id: 1,
    user: { login: 'me' },
    state: 'COMMENTED',
    body: 'Summary.',
    commit_id: HEAD,
    submitted_at: '2020-01-01T00:00:00Z',
    html_url: 'old',
  }]]);
  const scenario = writeScenario('stale2', [
    { when: { arg: 'pulls/1/reviews', args: ['--paginate'] }, stdout: old },
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, stdout: '{"id":2,"state":"COMMENTED","html_url":"new"}' },
    ...baseRules(),
  ], log2);
  runPrt(['recover', '1', '--repo', REPO], scenario);
  assert.equal(calls(log2).filter(isWrite).length, 1, 'a pre-transaction review is not our post; the action must run');
});

test('an empty-bodied review never matches a reply artifact', () => {
  // GitHub creates an empty COMMENTED review for every standalone reply. If a
  // body-less review of ours matched one, the inline comments would be dropped
  // while the file claimed success.
  const dir = setupPr(actionFile({ body: '' }));
  const log = path.join(ROOT, 'empty.jsonl');
  const crash = writeScenario('empty', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, die: true },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], crash);

  const log2 = path.join(ROOT, 'empty2.jsonl');
  const artifact = JSON.stringify([[{
    id: 3,
    user: { login: 'me' },
    state: 'COMMENTED',
    body: '',
    commit_id: 'c'.repeat(40), // a DIFFERENT commit: not the one we pinned
    submitted_at: new Date(Date.now() + 1000).toISOString(),
    html_url: 'artifact',
  }]]);
  const scenario = writeScenario('empty2', [
    { when: { arg: 'pulls/1/reviews', args: ['--paginate'] }, stdout: artifact },
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, stdout: '{"id":4,"state":"COMMENTED","html_url":"real"}' },
    ...baseRules(),
  ], log2);
  runPrt(['recover', '1', '--repo', REPO], scenario);
  assert.equal(calls(log2).filter(isWrite).length, 1, 'the artifact is not our review; the real post must still happen');
});

test('--dry-run never writes, even with an interrupted transaction open', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'dry.jsonl');
  const crash = writeScenario('dry', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, die: true },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], crash);
  const before = calls(log).filter(isWrite).length;

  const log2 = path.join(ROOT, 'dry2.jsonl');
  const scenario = writeScenario('dry2', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, stdout: '{"id":9,"state":"COMMENTED","html_url":"u"}' },
  ]), log2);
  const r = runPrt(['submit', '1', '--repo', REPO, '--dry-run'], scenario);
  assert.equal(calls(log2).filter(isWrite).length, 0, 'a dry run must never resume a transaction into GitHub');
  assert.match(`${r.stdout}`, /would/i);
  assert.ok(before >= 0);
});

test('a 5xx leaves the action unknown so recovery looks before retrying', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'five.jsonl');
  const scenario = writeScenario('five', baseRules([
    {
      when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' },
      exit: 1,
      stdout: '{"message":"Server Error","status":"500"}',
      stderr: 'gh: Server Error (HTTP 500)\n',
    },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], scenario);

  const outbox = path.join(dir, 'outbox');
  const txDirs = fs.readdirSync(outbox);
  const tx = JSON.parse(fs.readFileSync(path.join(outbox, txDirs[txDirs.length - 1], 'tx.json'), 'utf8'));
  assert.equal(tx.actions[0].state, 'unknown', 'a 5xx may have been applied; it is not a clean failure');
});

test('a 422 is a definite rejection and is not retried', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'fourtwotwo.jsonl');
  const scenario = writeScenario('fourtwotwo', baseRules([
    {
      when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' },
      exit: 1,
      stdout: '{"message":"Unprocessable Entity","errors":["bad line"],"status":"422"}',
      stderr: 'gh: HTTP 422\n',
    },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], scenario);

  const outbox = path.join(dir, 'outbox');
  const txDirs = fs.readdirSync(outbox);
  const tx = JSON.parse(fs.readFileSync(path.join(outbox, txDirs[txDirs.length - 1], 'tx.json'), 'utf8'));
  assert.equal(tx.actions[0].state, 'failed');
  assert.match(tx.actions[0].error, /Unprocessable Entity|bad line/);
  const out = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(out.split('\n')[0], 'Status: error');
});

test('the approved snapshot, not later edits, is what gets posted', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'snap.jsonl');
  const scenario = writeScenario('snap', baseRules([
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, die: true },
  ]), log);
  runPrt(['submit', '1', '--repo', REPO], scenario);

  // Human keeps editing after arming. The open transaction must still carry the
  // bytes they approved, not the ones they are still working on.
  const outbox = path.join(dir, 'outbox');
  const txDir = path.join(outbox, fs.readdirSync(outbox).pop());
  const approved = fs.readFileSync(path.join(txDir, 'approved.md'), 'utf8');
  assert.match(approved, /Summary\./);
  fs.writeFileSync(path.join(dir, 'review.md'), actionFile({ body: 'COMPLETELY DIFFERENT' }));
  assert.match(fs.readFileSync(path.join(txDir, 'approved.md'), 'utf8'), /Summary\./);
  assert.equal(approved.includes('COMPLETELY DIFFERENT'), false);
});
