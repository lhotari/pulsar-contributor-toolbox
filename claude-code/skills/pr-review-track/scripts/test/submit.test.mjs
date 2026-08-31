// node --test scripts/test/submit.test.mjs
//
// The transaction machine, driven against a fake `gh`. These are the tests that
// matter most: everything here only runs when something has already gone wrong,
// which is exactly why it cannot be checked by reading the code.
//
// The pipeline-mechanics lint lives in `tooling-lint.test.mjs`, which reaches
// GitHub for nothing. The one test kept here is the one that has to prove
// `preflight` consults it at all.
//
// The lint HATCHES are here too, at the other end of their life: what survives
// `prt draft` regenerating the file underneath them. That half is only provable
// by running the generator, and the fake `gh` this file already sets up is what
// makes running it cheap.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseActionFile, HUMAN_DOC_KEYS } from '../lib/actionfile.mjs';
import { renderActionFile } from '../lib/render.mjs';
import { carryDocHatches } from '../lib/submit.mjs';

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
function prJson({ state = 'OPEN', head = HEAD, author = 'someone', threads = [] } = {}) {
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
          reviewThreads: { nodes: threads },
          comments: { nodes: [] },
        },
      },
    },
  });
}

/** Rules every scenario needs: identity, PR fetch, diff, pending-review check. */
function baseRules(extra = [], { prState = 'OPEN', head = HEAD, author = 'someone', threads = [] } = {}) {
  return [
    ...extra,
    { when: { args: ['graphql'], body: 'viewer' }, stdout: '{"data":{"viewer":{"login":"me"}}}' },
    { when: { args: ['graphql'], body: 'pullRequest' }, stdout: prJson({ state: prState, head, author, threads }) },
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

function actionFile({ event = 'COMMENT', body = 'Summary.', inline = true, head = HEAD, doc = [] } = {}) {
  const parts = [
    'Status: ready',
    '',
    '<!-- prt:doc',
    'schema: 1',
    `repo: ${REPO}`,
    `pr: ${PR}`,
    `head: ${head}`,
    'base-ref: master',
    ...doc,
    '-->',
    '',
    '<!-- prt:verdict',
    `event: ${event}`,
    '-->',
    '',
  ];
  if (body) parts.push('<!-- prt:body -->', body, '<!-- /prt -->', '');
  if (inline) {
    const text = inline === true ? 'Inline text.' : inline;
    parts.push('<!-- prt:inline', 'id: i1', 'path: A.java', 'line: 11', 'side: RIGHT', '-->', text, '<!-- /prt -->', '');
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

// The title used to read "--dry-run never writes", which is not a property this
// code has: the dry run goes through `capture()` first, so it writes a whole
// `outbox/<ts>/` — `approved.md` plus a `tx.json` marked abandoned — and it
// rewrites `BOARD.md`. What it never does, and what the assertion here has
// always actually checked, is reach GitHub, including by resuming a transaction
// an earlier crash left open. The file the human is editing is untouched, and
// that is now asserted rather than assumed.
test('--dry-run reaches GitHub for nothing, and leaves review.md alone', () => {
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
  const review = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  const r = runPrt(['submit', '1', '--repo', REPO, '--dry-run'], scenario);
  assert.equal(calls(log2).filter(isWrite).length, 0, 'a dry run must never resume a transaction into GitHub');
  assert.match(`${r.stdout}`, /would/i);
  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8'), review, 'the file the human edits is byte-identical');
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

// ---------------------------------------------------------- pipeline mechanics
//
// Only the wiring lives here — `toolingLint: true` in DEFAULT_CONFIG, the
// `preflight` gate, and the refusal text the human actually reads. What the
// lint does and does not flag is `tooling-lint.test.mjs`, which needs no `gh`.

test('preflight refuses a review that describes how it was run, and the hatch it prints clears it', () => {
  const leak = actionFile({ body: 'One process note: this was not the two-model consensus pipeline.' });
  const accept = [{
    when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' },
    stdout: '{"id":99,"state":"COMMENTED","html_url":"https://x/1#r99"}',
  }];

  const dir = setupPr(leak);
  const log = path.join(ROOT, 'tooling.jsonl');
  runPrt(['submit', '1', '--repo', REPO], writeScenario('tooling', baseRules(accept), log));

  assert.equal(calls(log).filter(isWrite).length, 0, 'nothing reaches GitHub');
  const out = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(out.split('\n')[0], 'Status: blocked');
  // The refusal has to be actionable on its own: it names the hits and the exact
  // line that clears them, because the human reading it cannot see this code.
  assert.match(out, /tooling-reviewed: pipeline-shape, consensus/);

  // And that line does clear it. Same bytes, one POST.
  setupPr(leak.replace('base-ref: master', 'base-ref: master\ntooling-reviewed: pipeline-shape, consensus'));
  const log2 = path.join(ROOT, 'tooling-hatched.jsonl');
  const r = runPrt(['submit', '1', '--repo', REPO], writeScenario('tooling-hatched', baseRules(accept), log2));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(log2).filter(isWrite).length, 1, 'the hatch lets the same bytes post');
});

// -------------------------------------------------- acknowledgements that last
//
// `renderActionFile` emits a fixed key list into `prt:doc`, so until this was
// fixed EVERY hatch the human had typed was destroyed by the next `prt draft` —
// the pre-existing `security-reviewed: yes` included, which meant the documented
// escape from the security lint had to be re-typed against text nobody had
// changed. These pin both halves of the rule that replaced it: an
// acknowledgement is carried forward, but only over hits the human has seen.

/** A tracked PR with no action file yet, so the first `draft` carries nothing. */
function setupEmptyPr() {
  const dir = setupPr('');
  fs.unlinkSync(path.join(dir, 'review.md'));
  return dir;
}

function writeFindings(name, summary) {
  const p = path.join(ROOT, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ summary, recommendedEvent: 'COMMENT' }));
  return p;
}

/** The `prt:doc` fields of a generated file. */
const docOf = (text) => parseActionFile(text).doc;

/** Verbatim from the pipeline-mechanics fixtures; trips exactly `tier`. */
const TIER_LEAK = 'The rollout is staged: Tier 2 first, then the standard tier.';

test('a hatch the human typed survives the next `prt draft`, and only while it is still earned', () => {
  const dir = setupEmptyPr();
  const review = path.join(dir, 'review.md');
  const scenario = writeScenario('carry', baseRules(), path.join(ROOT, 'carry.jsonl'));
  const leak = writeFindings('carry-leak', TIER_LEAK);
  const clean = writeFindings('carry-clean', 'Two small things below; nothing blocking.');
  const draft = (findings) => {
    const r = runPrt(['draft', '1', '--repo', REPO, '--findings', findings], scenario);
    assert.equal(r.status, 0, r.stderr);
    return `${r.stdout}${r.stderr}`;
  };

  draft(leak);
  assert.equal(docOf(fs.readFileSync(review, 'utf8'))['tooling-reviewed'], undefined, 'the generator never writes a hatch itself');

  // The human judges the hit benign and says so, in the one place only they may
  // write. Nothing else about the file changes.
  fs.writeFileSync(review, fs.readFileSync(review, 'utf8').replace('base-ref: master', 'base-ref: master\ntooling-reviewed: tier'));

  const second = draft(leak);
  const gen2 = fs.readFileSync(review, 'utf8');
  assert.equal(docOf(gen2)['tooling-reviewed'], 'tier', 'the acknowledgement survived the regeneration');
  assert.equal(docOf(gen2).generation, '2', 'and it is genuinely a new generation, not the old file');
  assert.match(second, /kept your `tooling-reviewed: tier`/, 'carrying it is never silent');

  // The findings change and the passage is gone. The hatch has no work left, so
  // it does not stay behind armed against whatever the next round writes.
  const third = draft(clean);
  assert.equal(docOf(fs.readFileSync(review, 'utf8'))['tooling-reviewed'], undefined, 'the text it excused is gone, so it is gone');
  assert.match(third, /dropped your `tooling-reviewed`/);
});

test('--no-carry drops the acknowledgement along with the notes', () => {
  const dir = setupEmptyPr();
  const review = path.join(dir, 'review.md');
  const scenario = writeScenario('nocarry', baseRules(), path.join(ROOT, 'nocarry.jsonl'));
  const leak = writeFindings('nocarry-leak', TIER_LEAK);

  runPrt(['draft', '1', '--repo', REPO, '--findings', leak], scenario);
  fs.writeFileSync(review, fs.readFileSync(review, 'utf8').replace('base-ref: master', 'base-ref: master\ntooling-reviewed: tier'));
  const r = runPrt(['draft', '1', '--repo', REPO, '--findings', leak, '--no-carry'], scenario);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(docOf(fs.readFileSync(review, 'utf8'))['tooling-reviewed'], undefined);
});

test('a whole-file `yes` carries only over outgoing text the human already read', () => {
  const known = 'The CVE-2026-12345 mitigation is already public in the PR title.';
  const hatched = (body) => actionFile({ body, doc: ['security-reviewed: yes'] });

  // Same bytes, still tripping: carried, and the human is not asked again. This
  // is the whole point — a new commit regenerates an identical review body.
  assert.deepEqual(
    carryDocHatches(hatched(known), actionFile({ body: known })).carried,
    { 'security-reviewed': 'yes' },
  );

  // A second CVE appended to the SAME paragraph. `securityLint` takes the first
  // match of each pattern per text, so it reports one hit either way and a
  // hit-by-hit comparison would carry the hatch straight over the new one.
  const grew = carryDocHatches(hatched(known), actionFile({ body: `${known}\n\nSeparately, CVE-2026-99999 is not.` }));
  assert.deepEqual(grew.carried, {});
  assert.match(grew.dropped[0].why, /outgoing text that was not in the one you read/);

  // An untouched body, but a new inline comment nobody has read.
  const added = carryDocHatches(hatched(known), actionFile({ body: known, inline: 'A different inline comment.' }));
  assert.deepEqual(added.carried, {});

  // Gone entirely: nothing left to excuse.
  const gone = carryDocHatches(hatched(known), actionFile({ body: 'Nothing to report.' }));
  assert.deepEqual(gone.carried, {});
  assert.match(gone.dropped[0].why, /nothing in this generation trips that lint/);

  // And a previous file this tool cannot read carries nothing: no blocks, no
  // outgoing text, no hit to cover. The failure direction is the safe one.
  assert.deepEqual(carryDocHatches('not an action file at all\nsecurity-reviewed: yes\n', hatched(known)).carried, {});
});

test('a labelled hatch carries label by label, and can only ever shrink', () => {
  const both = `${TIER_LEAK}\n\nThe reviewers split on the pooling question.`;
  const prev = actionFile({ body: both, doc: ['tooling-reviewed: tier, reviewer-split'] });

  assert.deepEqual(
    carryDocHatches(prev, actionFile({ body: both })).carried,
    { 'tooling-reviewed': 'tier, reviewer-split' },
  );
  // Only `tier` is still tripped, so only `tier` comes back.
  assert.deepEqual(
    carryDocHatches(prev, actionFile({ body: TIER_LEAK })).carried,
    { 'tooling-reviewed': 'tier' },
  );
  // A label the previous hatch never named is never acquired by carrying.
  const narrow = actionFile({ body: both, doc: ['tooling-reviewed: tier'] });
  assert.deepEqual(carryDocHatches(narrow, actionFile({ body: both })).carried, { 'tooling-reviewed': 'tier' });
});

test('nothing but a human decision is eligible to travel between generations', () => {
  // The direction that matters more. `head`, `base`, `base-ref` and
  // `diff-fingerprint` are the submitter's preconditions, re-checked against
  // live GitHub before anything posts; a carried one would be checked against
  // itself and pass every time.
  const machine = ['schema', 'repo', 'pr', 'kind', 'generation', 'generated', 'reviewer',
    'head', 'base', 'base-ref', 'diff-fingerprint', 'reviewed-at'];
  for (const key of machine) assert.equal(HUMAN_DOC_KEYS.includes(key), false, key);

  // The renderer is the second lock: a caller handing it a whole previous doc
  // gets the analysis's head back, not the one it passed.
  const stale = renderActionFile({
    repo: REPO,
    analysis: { number: PR, title: 't', url: 'u', author: 'a', authorAssociation: 'MEMBER', headOid: HEAD,
      baseRefName: 'master', additions: 1, deletions: 0, changedFiles: 1, labels: [], threads: [],
      threadCounts: {}, newIssueComments: [], newReviewsByOthers: [] },
    kind: 're-review',
    reviewerLogin: 'me',
    carriedDoc: { head: 'f'.repeat(40), 'diff-fingerprint': 'sha256:stale', 'security-reviewed': 'yes' },
  });
  assert.equal(docOf(stale).head, HEAD);
  assert.equal(stale.includes('f'.repeat(40)), false, 'the stale head reached the file nowhere');
  assert.equal(stale.includes('sha256:stale'), false);
  assert.equal(docOf(stale)['security-reviewed'], 'yes', 'the human key on the same object still travels');

  // And every hatch the submitter actually reads is on the list, so adding a
  // fourth lint cannot quietly reintroduce the treadmill this replaced.
  const source = fs.readFileSync(path.join(SKILL, 'scripts/lib/submit.mjs'), 'utf8');
  const read = [...source.matchAll(/doc\??\.?\[\s*'([a-z][a-z-]*-reviewed)'\s*\]/g)].map((m) => m[1]);
  assert.equal(read.length >= 3, true, 'the scan still finds the hatch reads it is guarding');
  for (const key of new Set(read)) assert.equal(HUMAN_DOC_KEYS.includes(key), true, key);
});

// ---------------------------------------------------------------------------
// Staging: `event: REPLY` writes into a PENDING review and never submits it.
//
// The mode exists so a round of comments can be prepared where the author
// cannot see them and the human can rewrite them in GitHub's UI before anyone
// else reads a word. Two things have to hold for that to mean anything: nothing
// in the pass may submit, and a later pass must complete THAT review rather
// than post a second one beside it.

const THREAD = {
  id: 'PRRT_1',
  isResolved: false,
  isOutdated: false,
  path: 'A.java',
  line: 11,
  diffSide: 'RIGHT',
  comments: { nodes: [{ databaseId: 5, fullDatabaseId: 5, author: { login: 'someone' }, createdAt: '2026-01-01T00:00:00Z', url: 'u', body: 'q' }] },
};

const STAGE_RULES = [
  {
    when: { args: ['graphql'], body: 'addPullRequestReviewThreadReply(' },
    stdout: '{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_2","databaseId":502,"url":"https://x/c502"}}}}',
  },
  {
    when: { args: ['graphql'], body: 'addPullRequestReviewThread(' },
    stdout: '{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_new","path":"A.java","subjectType":"LINE","comments":{"nodes":[{"databaseId":501,"url":"https://x/c501"}]}}}}}',
  },
  {
    when: { args: ['graphql'], body: 'addPullRequestReview(' },
    stdout: '{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_77","databaseId":77,"url":"https://x/1#pullrequestreview-77","state":"PENDING"}}}}',
  },
];

/** A file that stages one new thread and one reply into a thread I own. */
function replyFile({ event = 'REPLY', inline = true, thread = true, body = '' } = {}) {
  const parts = [
    'Status: ready', '',
    '<!-- prt:doc', 'schema: 1', `repo: ${REPO}`, `pr: ${PR}`, `head: ${HEAD}`, 'base-ref: master', '-->', '',
    '<!-- prt:verdict', `event: ${event}`, '-->', '',
  ];
  if (body) parts.push('<!-- prt:body -->', body, '<!-- /prt -->', '');
  if (inline) parts.push('<!-- prt:inline', 'id: i1', 'path: A.java', 'line: 11', 'side: RIGHT', '-->', 'New thread text.', '<!-- /prt -->', '');
  if (thread) parts.push('<!-- prt:thread', 'id: t1', 'thread: PRRT_1', 'reply-to: 5', '-->', 'Reply text.', '<!-- /prt -->', '');
  return `${parts.join('\n')}\n`;
}

const stateOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pr.json'), 'utf8'));
const graphqlCalls = (log) => calls(log).filter((c) => c.args.includes('graphql')).map((c) => c.args.join(' '));

test('event REPLY stages comments into an unsubmitted review and submits nothing', () => {
  const dir = setupPr(replyFile());
  const log = path.join(ROOT, 'stage.jsonl');
  const scenario = writeScenario('stage', baseRules(STAGE_RULES, { threads: [THREAD] }), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(calls(log).filter(isWrite), [], 'staging writes nothing over REST — no review is created or submitted');
  const mutations = graphqlCalls(log).filter((q) => q.includes('mutation'));
  assert.equal(mutations.length, 3, 'start the review, stage the thread, stage the reply');
  assert.equal(mutations.filter((q) => q.includes('addPullRequestReview(input:')).length, 1);
  assert.equal(mutations.filter((q) => q.includes('addPullRequestReviewThread(input:')).length, 1);
  assert.equal(mutations.filter((q) => q.includes('addPullRequestReviewThreadReply(input:')).length, 1);
  assert.equal(
    graphqlCalls(log).some((q) => q.includes('submitPullRequestReview') || q.includes('/events')),
    false,
    'nothing submits the review it just started',
  );

  const file = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(file.split('\n')[0], 'Status: submitted');
  assert.match(file, /actions staged/);
  assert.match(file, /UNSUBMITTED review/);

  // The record the next round turns on.
  assert.equal(stateOf(dir).staged.reviewDatabaseId, '77');
  assert.equal(stateOf(dir).staged.reviewNodeId, 'PRR_77');
});

test('a second REPLY pass adds to the review the first one staged', () => {
  const dir = setupPr(replyFile({ inline: false }));
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
    schema: 1, repo: REPO, number: PR, title: 't', state: 'OPEN',
    staged: { reviewDatabaseId: '77', reviewNodeId: 'PRR_77', url: 'https://x/1#pullrequestreview-77' },
  }));
  const log = path.join(ROOT, 'stage-again.jsonl');
  const scenario = writeScenario('stage-again', baseRules([
    ...STAGE_RULES,
    {
      when: { arg: 'pulls/1/reviews', args: ['--paginate'] },
      stdout: '[[{"id":77,"node_id":"PRR_77","state":"PENDING","user":{"login":"me"},"html_url":"https://x/1#pullrequestreview-77"}]]',
    },
  ], { threads: [THREAD] }), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(r.status, 0, r.stderr);
  const mutations = graphqlCalls(log).filter((q) => q.includes('mutation'));
  assert.equal(
    mutations.filter((q) => q.includes('addPullRequestReview(input:')).length, 0,
    'GitHub allows one pending review per person, so the second pass reuses it rather than asking for a second',
  );
  assert.equal(mutations.filter((q) => q.includes('addPullRequestReviewThreadReply(input:')).length, 1);
});

test('a pending review prt did not stage still blocks, as it always did', () => {
  const dir = setupPr(actionFile());
  const log = path.join(ROOT, 'stranger.jsonl');
  const scenario = writeScenario('stranger', baseRules([
    {
      when: { arg: 'pulls/1/reviews', args: ['--paginate'] },
      stdout: '[[{"id":88,"node_id":"PRR_88","state":"PENDING","user":{"login":"me"},"html_url":"https://x/1#pullrequestreview-88"}]]',
    },
  ]), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.notEqual(r.status, 0);
  assert.deepEqual(calls(log).filter(isWrite), [], 'nothing was posted');
  const file = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(file.split('\n')[0], 'Status: blocked');
  assert.match(file, /prt did not stage/);
});

test('a later verdict submits the staged review, with the summary from the file', () => {
  const dir = setupPr(actionFile({ inline: false }));
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
    schema: 1, repo: REPO, number: PR, title: 't', state: 'OPEN',
    staged: { reviewDatabaseId: '77', reviewNodeId: 'PRR_77', url: 'https://x/1#pullrequestreview-77' },
  }));
  const log = path.join(ROOT, 'complete.jsonl');
  const scenario = writeScenario('complete', baseRules([
    {
      when: { arg: 'pulls/1/reviews', args: ['--paginate'] },
      stdout: '[[{"id":77,"node_id":"PRR_77","state":"PENDING","user":{"login":"me"},"html_url":"https://x/1#pullrequestreview-77"}]]',
    },
    {
      when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews/77/events' },
      stdout: '{"id":77,"state":"COMMENTED","html_url":"https://x/1#pullrequestreview-77"}',
    },
  ]), log);

  const r = runPrt(['submit', '1', '--repo', REPO], scenario);
  assert.equal(r.status, 0, r.stderr);
  const posts = calls(log).filter(isWrite);
  assert.equal(posts.length, 1, 'the staged review is submitted, not duplicated by a new one');
  assert.match(posts[0].args.join(' '), /pulls\/1\/reviews\/77\/events/);
  assert.deepEqual(JSON.parse(posts[0].stdin), { event: 'COMMENT', body: 'Summary.' });

  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').split('\n')[0], 'Status: submitted');
  assert.equal(stateOf(dir).staged ?? null, null, 'a submitted review is no longer a draft anyone can edit');
});

test('a staged review comes back into the next draft as context, not as blocks', () => {
  const dir = setupEmptyPr();
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
    schema: 1, repo: REPO, number: PR, title: 't', state: 'OPEN',
    staged: { reviewDatabaseId: '77', reviewNodeId: 'PRR_77', url: 'https://x/1#pullrequestreview-77' },
  }));
  const findings = path.join(ROOT, 'staged-findings.json');
  fs.writeFileSync(findings, JSON.stringify({
    summary: 'Two things.',
    recommendedEvent: 'COMMENT',
    findings: [
      { id: 'i1', severity: 'BUG', claim: 'same anchor', path: 'A.java', line: 11, side: 'RIGHT', body: 'The same point again.' },
      { id: 'i2', severity: 'BUG', claim: 'different anchor', path: 'A.java', line: 12, side: 'RIGHT', body: 'A different line.' },
    ],
  }));
  const scenario = writeScenario('staged-draft', baseRules([
    {
      when: { arg: 'pulls/1/reviews/77/comments', args: ['--paginate'] },
      stdout: '[[{"id":501,"path":"A.java","line":11,"side":"RIGHT","body":"The staged wording, as I edited it on GitHub.","html_url":"https://x/c501"}]]',
    },
    {
      when: { arg: 'pulls/1/reviews', args: ['--paginate'] },
      stdout: '[[{"id":77,"node_id":"PRR_77","state":"PENDING","user":{"login":"me"},"html_url":"https://x/1#pullrequestreview-77"}]]',
    },
  ]), path.join(ROOT, 'staged-draft.jsonl'));

  const r = runPrt(['draft', '1', '--repo', REPO, '--findings', findings], scenario);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');

  assert.match(text, /## Already staged on GitHub/);
  assert.match(text, /The staged wording, as I edited it on GitHub\./, 'GitHub\'s text, not the store\'s');
  assert.match(`${r.stdout}${r.stderr}`, /staged in an unsubmitted review/);

  // The staged comment is context. The finding that lands on its anchor is
  // disarmed rather than dropped; the one on a different line is untouched.
  const p = parseActionFile(text);
  const byId = new Map(p.inline.map((c) => [c.id, c]));
  assert.equal(byId.get('i1').post, false);
  assert.match(byId.get('i1').body, /already staged at this anchor/);
  assert.equal(byId.get('i2').post, true);
});
