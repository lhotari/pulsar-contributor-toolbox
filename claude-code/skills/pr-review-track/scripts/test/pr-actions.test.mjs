// node --test scripts/test/pr-actions.test.mjs
//
// The `prt:pr-actions` block: two flags the human arms alongside the verdict,
// which act on the pull request itself rather than on its conversation.
//
// What needs pinning is not that the two requests go out — it is the order and
// the disarming. Updating the branch replaces the head whose workflow runs the
// approval then has to approve, so approving first would approve exactly the
// runs the update supersedes; and a flag that stays `true` after its action
// landed would re-run a GitHub write on the next round, while one cleared after
// a failure would silently drop what the human asked for.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseActionFile, planActions, setPrActionField, ensurePrActions } from '../lib/actionfile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '../..');
const HEAD = 'a'.repeat(40);
const REPO = 'o/r';
const PR = 1;

let ROOT;
let BIN;

// ------------------------------------------------------------------ the block

function file({ status = 'ready', event = 'COMMENT', updateBranch = false, triggerCi = false, block = true, body = 'Summary.' } = {}) {
  const parts = [
    `Status: ${status}`,
    '',
    '<!-- prt:doc',
    'schema: 1',
    `repo: ${REPO}`,
    `pr: ${PR}`,
    `head: ${HEAD}`,
    'base-ref: master',
    '-->',
    '',
    '<!-- prt:verdict',
    `event: ${event}`,
    '-->',
    '',
  ];
  if (block) {
    parts.push('<!-- prt:pr-actions', `update-branch: ${updateBranch}`, `trigger-ci: ${triggerCi}`, '-->', '');
  }
  if (body) parts.push('<!-- prt:body -->', body, '<!-- /prt -->', '');
  return `${parts.join('\n')}\n`;
}

const kinds = (text) => planActions(parseActionFile(text)).map((a) => a.kind);

test('a file with no pr-actions block behaves exactly as it always did', () => {
  const p = parseActionFile(file({ block: false }));
  assert.deepEqual(p.prActions, { updateBranch: false, triggerCi: false });
  assert.deepEqual(kinds(file({ block: false })), ['review']);
});

test('the flags plan after everything that posts, branch update before CI approval', () => {
  assert.deepEqual(kinds(file({ updateBranch: true, triggerCi: true })), [
    'review',
    'update-branch',
    'approve-workflows',
  ]);
});

test('APPROVE already approves workflows, so trigger-ci does not plan a second one', () => {
  assert.deepEqual(kinds(file({ event: 'APPROVE', triggerCi: true })), ['review', 'approve-workflows']);
  assert.deepEqual(kinds(file({ event: 'APPROVE' })), ['review', 'approve-workflows']);
});

test('the flags are honoured in a REPLY round, which returns early from the plan', () => {
  // Silently dropping an armed flag here would be indistinguishable, to the
  // human, from having run it.
  assert.deepEqual(kinds(file({ event: 'REPLY', body: null, updateBranch: true })), ['update-branch']);
});

test('a file whose only action is a flag is a real action, not an empty one', () => {
  const text = file({ event: 'NONE', body: null, updateBranch: true });
  assert.deepEqual(kinds(text), ['update-branch']);
});

test('a misspelled flag is an error, not a flag that silently does nothing', () => {
  const text = file().replace('trigger-ci: false', 'triger-ci: true');
  const p = parseActionFile(text);
  assert.match(p.errors.join('\n'), /unknown field "triger-ci"/);
});

test('a value that is neither yes nor no is an error', () => {
  const p = parseActionFile(file().replace('update-branch: false', 'update-branch: maybe'));
  assert.match(p.errors.join('\n'), /"maybe" is not yes or no/);
});

test('two blocks are refused rather than one quietly winning', () => {
  const text = file({ updateBranch: true }).replace(
    '<!-- prt:body -->',
    '<!-- prt:pr-actions\nupdate-branch: false\ntrigger-ci: false\n-->\n\n<!-- prt:body -->',
  );
  assert.match(parseActionFile(text).errors.join('\n'), /a second `<!-- prt:pr-actions -->` block/);
});

test('setPrActionField rewrites one line and leaves every other byte alone', () => {
  const before = file({ updateBranch: true, triggerCi: true });
  const after = setPrActionField(before, 'update-branch', 'false');
  assert.match(after, /update-branch: false/);
  assert.match(after, /trigger-ci: true/, 'the other flag is untouched');
  assert.equal(
    before.split('\n').length,
    after.split('\n').length,
    'rewriting a field must not reflow the file',
  );
  // A file without the block is returned unchanged rather than repaired.
  const none = file({ block: false });
  assert.equal(setPrActionField(none, 'update-branch', 'false'), none);
});

// ------------------------------------------------------------- the backfill
//
// The block was added after drafts already existed. A file written before it
// would otherwise never gain the two buttons until the next full regeneration,
// which throws away every judgement call baked into its prose — so every
// command that rewrites `review.md` repairs the omission in place instead.

/** The fixture as it was drafted before the block existed. */
const old = (extra = {}) => file({ status: 'draft', block: false, ...extra });

test('a file drafted before the block gets one, directly below the verdict', () => {
  const after = ensurePrActions(old());
  assert.ok(
    after.indexOf('<!-- prt:pr-actions') > after.indexOf('<!-- prt:verdict'),
    'the block belongs under the verdict its flags are armed alongside',
  );
  assert.ok(
    after.indexOf('<!-- prt:pr-actions') < after.indexOf('<!-- prt:body'),
    'and above the sections that follow, where a fresh draft writes it',
  );
  const p = parseActionFile(after);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.prActions, { updateBranch: false, triggerCi: false });
  assert.deepEqual(kinds(after), ['review'], 'backfilling adds the buttons, it never presses them');
});

test('the backfilled block is byte-identical to a generated one', () => {
  const sentinel = (t) => t.slice(t.indexOf('<!-- prt:pr-actions')).split('\n').slice(0, 4).join('\n');
  assert.equal(sentinel(ensurePrActions(old())), sentinel(file({ status: 'draft' })));
});

test('backfilling twice changes nothing the second time', () => {
  const once = ensurePrActions(old());
  assert.equal(ensurePrActions(once), once);
});

test('a file that already has the block is returned untouched, wherever it sits', () => {
  const armed = file({ status: 'draft', updateBranch: true });
  assert.equal(ensurePrActions(armed), armed, 'an armed flag is never reset by a repair');
  const moved = old().replace(
    '<!-- prt:body -->',
    '<!-- prt:pr-actions\nupdate-branch: false\ntrigger-ci: false\n-->\n\n<!-- prt:body -->',
  );
  assert.equal(ensurePrActions(moved), moved);
});

test('a merged PR gets no block: no branch left to update, no CI left to release', () => {
  assert.equal(ensurePrActions(old(), { merged: true }), old());
});

test('an armed or in-flight file is never rewritten behind the human', () => {
  for (const status of ['ready', 'queued', 'partial']) {
    assert.equal(ensurePrActions(old({ status })), old({ status }), `${status} must not be touched`);
  }
  for (const status of ['draft', 'hold', 'blocked', 'submitted']) {
    assert.notEqual(ensurePrActions(old({ status })), old({ status }), `${status} is still being edited`);
  }
});

test('no verdict to hang it under means no block, not a guess', () => {
  const noVerdict = old().replace('<!-- prt:verdict\nevent: COMMENT\n-->\n\n', '');
  assert.equal(ensurePrActions(noVerdict), noVerdict);
  // Nor is an unterminated verdict quietly built on top of.
  const broken = old().replace('event: COMMENT\n-->', 'event: COMMENT');
  assert.equal(ensurePrActions(broken), broken);
});

test('a `##` heading inside a note is prose, not the next section', () => {
  const before = old().replace(
    '<!-- prt:body -->',
    '<!-- prt:ask\nid: a1\nre: verdict\n-->\n## why COMMENT?\n<!-- /prt -->\n\n## Review summary\n\n<!-- prt:body -->',
  );
  const after = ensurePrActions(before);
  assert.ok(
    after.indexOf('<!-- prt:pr-actions') > after.indexOf('## why COMMENT?'),
    'a note about the verdict stays attached to it',
  );
  assert.ok(after.indexOf('<!-- prt:pr-actions') < after.indexOf('## Review summary'));
  assert.deepEqual(parseActionFile(after).errors, []);
});

test('a CRLF file stays a CRLF file', () => {
  const after = ensurePrActions(old().replace(/\n/g, '\r\n'));
  assert.ok(after.includes('<!-- prt:pr-actions\r\nupdate-branch: false\r\n'));
  assert.equal(/[^\r]\n/.test(after), false, 'no bare LF was introduced');
  assert.deepEqual(parseActionFile(after).errors, []);
});

// --------------------------------------------------------------- through gh

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-pra-'));
  BIN = path.join(ROOT, 'bin');
  fs.mkdirSync(BIN, { recursive: true });
  const shim = path.join(BIN, 'gh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(SKILL, 'scripts/test/helpers/fake-gh.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  // No waiting in tests: the poll budget is what makes the wait loop bounded,
  // and zero still queries once.
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ reviewer: 'me', workflowApprovalWaitSeconds: 0 }));
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function prJson({ head = HEAD } = {}) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: 'PR_1', number: PR, title: 't', url: 'u', state: 'OPEN', isDraft: false, merged: false,
          headRefOid: head, baseRefName: 'master', authorAssociation: 'MEMBER', author: { login: 'someone' },
          labels: { nodes: [] }, commits: { nodes: [] }, reviews: { nodes: [] },
          reviewThreads: { nodes: [] }, comments: { nodes: [] },
        },
      },
    },
  });
}

const DIFF = `diff --git a/A.java b/A.java
--- a/A.java
+++ b/A.java
@@ -10,3 +10,4 @@
 ctx10
+add11
 ctx13
`;

function baseRules(extra = []) {
  return [
    ...extra,
    { when: { args: ['graphql'], body: 'viewer' }, stdout: '{"data":{"viewer":{"login":"me"}}}' },
    { when: { args: ['graphql'], body: 'pullRequest' }, stdout: prJson() },
    { when: { args: ['pr', 'diff'] }, stdout: DIFF },
    { when: { arg: 'pulls/1/reviews', args: ['--paginate'] }, stdout: '[[]]' },
    { when: { arg: 'pulls/1/comments', args: ['--paginate'] }, stdout: '[[]]' },
    { when: { arg: 'issues/1/comments', args: ['--paginate'] }, stdout: '[[]]' },
    { when: { args: ['--method', 'GET'], arg: 'compare/master...' }, stdout: '{"behind_by":3}' },
    { when: { args: ['--method', 'GET'], arg: 'actions/runs?head_sha=' }, stdout: '{"workflow_runs":[]}' },
    { when: { args: ['--method', 'POST'], arg: 'pulls/1/reviews' }, stdout: '{"id":9,"state":"COMMENTED","html_url":"https://x/1#r9"}' },
  ];
}

function scenario(name, rules, callLog) {
  const p = path.join(ROOT, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ callLog, rules }, null, 2));
  try { fs.unlinkSync(`${p}.fired`); } catch { /* fresh run */ }
  return p;
}

function setupPr(text) {
  const dir = path.join(ROOT, 'o', 'r', `pr-${PR}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), text);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ schema: 1, repo: REPO, number: PR, title: 't', state: 'OPEN' }));
  return dir;
}

function submit(scenarioPath) {
  return spawnSync(process.execPath, [path.join(SKILL, 'scripts/prt.mjs'), 'submit', String(PR), '--repo', REPO], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, PRT_ROOT: ROOT, PRT_FAKE_GH: scenarioPath },
  });
}

function calls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const target = (c) => c.args.find((x) => String(x).includes('repos/o/r/')) ?? c.args.join(' ');
const isWrite = (c) => c.args.includes('--method') && (c.args.includes('POST') || c.args.includes('PUT'));

test('update-branch pins the head it was drafted against, and disarms once it lands', () => {
  const dir = setupPr(file({ updateBranch: true }));
  const log = path.join(ROOT, 'update.jsonl');
  const s = scenario('update', baseRules([
    { when: { args: ['--method', 'PUT'], arg: 'pulls/1/update-branch' }, stdout: '{"message":"Updating pull request branch."}' },
  ]), log);

  const r = submit(s);
  assert.equal(r.status, 0, r.stderr);

  const writes = calls(log).filter(isWrite);
  assert.deepEqual(writes.map(target), ['repos/o/r/pulls/1/reviews', 'repos/o/r/pulls/1/update-branch']);
  assert.deepEqual(JSON.parse(writes[1].stdin), { expected_head_sha: HEAD },
    'without this GitHub would happily update a head nobody reviewed');

  const after = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(after.split('\n')[0], 'Status: submitted');
  assert.match(after, /update-branch: false/, 'the flag is disarmed once its action landed');
  assert.match(after, /Updating pull request branch/, 'the log says what GitHub answered');
});

test('an up-to-date branch is left alone instead of being merged into itself', () => {
  setupPr(file({ updateBranch: true }));
  const log = path.join(ROOT, 'uptodate.jsonl');
  const s = scenario('uptodate', baseRules([
    { when: { args: ['--method', 'GET'], arg: 'compare/master...' }, stdout: '{"behind_by":0}' },
  ]), log);

  const r = submit(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    calls(log).filter((c) => target(c).includes('update-branch')).length,
    0,
    'no branch update request at all',
  );
});

test('with both flags the branch is updated first, then the new head is read and its runs approved', () => {
  const dir = setupPr(file({ updateBranch: true, triggerCi: true }));
  const log = path.join(ROOT, 'both.jsonl');
  const s = scenario('both', baseRules([
    { when: { args: ['--method', 'PUT'], arg: 'pulls/1/update-branch' }, stdout: '{"message":"Updating pull request branch."}' },
    {
      when: { args: ['--method', 'GET'], arg: 'actions/runs?head_sha=' },
      stdout: JSON.stringify({ workflow_runs: [{ id: 55, head_sha: HEAD, pull_requests: [{ number: PR }] }] }),
    },
    { when: { args: ['--method', 'POST'], arg: 'actions/runs/55/approve' }, stdout: '' },
  ]), log);

  const r = submit(s);
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(calls(log).filter(isWrite).map(target), [
    'repos/o/r/pulls/1/reviews',
    'repos/o/r/pulls/1/update-branch',
    'repos/o/r/actions/runs/55/approve',
  ]);

  // The head the approval used must be re-read AFTER the update, not the one
  // captured at draft time — the update is what replaces it.
  const seq = calls(log).map(target);
  const put = seq.indexOf('repos/o/r/pulls/1/update-branch');
  const runsQuery = seq.findIndex((t, i) => i > put && String(t).includes('actions/runs?head_sha='));
  const headRead = seq.findIndex((t, i) => i > put && i < runsQuery && String(t).includes('graphql'));
  assert.ok(put > -1 && runsQuery > put, 'the runs are queried after the update');
  assert.ok(headRead > put, 'the PR head is re-read between the update and the runs query');

  const after = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.match(after, /update-branch: false/);
  assert.match(after, /trigger-ci: false/);
  assert.match(after, /approved 1 workflow run/);
});

test('when no runs are waiting after an update, that is recorded rather than failed', () => {
  const dir = setupPr(file({ updateBranch: true, triggerCi: true }));
  const log = path.join(ROOT, 'norun.jsonl');
  const s = scenario('norun', baseRules([
    { when: { args: ['--method', 'PUT'], arg: 'pulls/1/update-branch' }, stdout: '{"message":"Updating pull request branch."}' },
  ]), log);

  const r = submit(s);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(after.split('\n')[0], 'Status: submitted');
  assert.match(after, /no runs were waiting for approval/);
  assert.match(after, /trigger-ci: false/);
});

test('a branch that will not merge fails loudly and leaves the flag armed', () => {
  const dir = setupPr(file({ updateBranch: true }));
  const log = path.join(ROOT, 'conflict.jsonl');
  const s = scenario('conflict', baseRules([
    {
      when: { args: ['--method', 'PUT'], arg: 'pulls/1/update-branch' },
      stdout: '{"message":"merge conflict between base and head"}',
      stderr: 'gh: HTTP 422',
      exit: 1,
    },
  ]), log);

  const r = submit(s);
  assert.notEqual(r.status, 0, 'a failed action must not report success');

  const after = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(after.split('\n')[0], 'Status: partial', 'the review posted; the branch update did not');
  assert.match(after, /update-branch: true/, 'still armed, so `prt recover` retries what was asked for');
  assert.match(after, /merge conflict/);
});

// -------------------------------------------------- the backfill, through gh

function prt(...args) {
  return spawnSync(process.execPath, [path.join(SKILL, 'scripts/prt.mjs'), ...args, '--repo', REPO], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, PRT_ROOT: ROOT },
  });
}

test('a command that rewrites review.md repairs the missing block on the way past', () => {
  const dir = setupPr(old());
  const r = prt('status', String(PR), 'hold');
  assert.equal(r.status, 0, r.stderr);

  const after = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.equal(after.split('\n')[0], 'Status: hold', 'the status change still happened');
  assert.match(after, /<!-- prt:pr-actions\nupdate-branch: false\ntrigger-ci: false\n-->/);
  assert.deepEqual(parseActionFile(after).errors, []);
});

test('a merged PR keeps the file it has', () => {
  const dir = setupPr(old());
  fs.writeFileSync(
    path.join(dir, 'pr.json'),
    JSON.stringify({ schema: 1, repo: REPO, number: PR, title: 't', state: 'MERGED', merged: true }),
  );
  assert.equal(prt('status', String(PR), 'hold').status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'review.md'), 'utf8').includes('prt:pr-actions'), false);
});
