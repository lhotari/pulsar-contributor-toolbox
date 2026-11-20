// End-to-end engine test on a throwaway repository with a fake gh. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-test-'));
process.env.BPT_HOME = path.join(tmp, 'home');
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const ghLog = path.join(tmp, 'gh.log');
// Fake gh: records calls, answers the few queries the engine makes.
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$@" >> ${ghLog}
case "$1 $2" in
  "api graphql") echo '{"data":{"repository":{}}}' ;;
  "pr list") echo '[]' ;;
  "pr create") cat >/dev/null; echo 'https://github.com/apache/pulsar/pull/9001' ;;
  "pr checks") echo '[{"name":"unit","bucket":"pass","link":"l","workflow":"Pulsar CI"}]' ;;
  "run list") echo '[{"databaseId":1,"name":"Pulsar CI","status":"completed","conclusion":"success","url":"u","event":"workflow_dispatch"}]' ;;
  "pr comment") cat >/dev/null ;;
  *) ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const origin = path.join(tmp, 'origin.git'); const repo = path.join(tmp, 'repo');
sh(tmp, 'init', '-q', '--bare', '-b', 'master', origin);
sh(tmp, 'clone', '-q', origin, repo);
const src = (f) => path.join(repo, 'mod/src/main/java', f);
fs.mkdirSync(path.dirname(src('x')), { recursive: true });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `line ${i + 1} ${tag}`).join('\n') + '\n';
const edit = (f, i, text) => { const a = fs.readFileSync(src(f), 'utf8').split('\n'); a[i - 1] = text; fs.writeFileSync(src(f), a.join('\n')); };
const commit = (msg) => { sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', msg); return sh(repo, 'rev-parse', 'HEAD'); };

fs.writeFileSync(src('Foo.java'), lines(20, 'foo')); fs.writeFileSync(src('Bar.java'), lines(20, 'bar'));
commit('[fix][broker] base (#99)');
sh(repo, 'branch', 'branch-4.2'); sh(repo, 'branch', 'branch-4.0');
edit('Foo.java', 18, 'unrelated master-only change'); commit('[feat][broker] since point (#100)');
edit('Foo.java', 2, 'fixed line 2'); commit('[fix][broker] Fix line two (#101)');
edit('Bar.java', 5, 'refactored line 5'); commit('[improve][broker] Refactor bar (#102)');
edit('Bar.java', 5, 'refactored line 5 and fixed'); commit('[fix][broker] Fix the refactored line (#103)');
edit('Foo.java', 10, 'ci tweak'); commit('[improve][ci] Speed up CI (#104)');
fs.mkdirSync(path.join(repo, 'mod/src/test/java'), { recursive: true });
fs.writeFileSync(path.join(repo, 'mod/src/test/java/FooTest.java'), 'test\n'); commit('[fix][test] Fix flaky FooTest (#105)');
// Dependency upgrades and a fix that reached branch-4.2 through branch-specific PRs.
fs.writeFileSync(path.join(repo, 'deps.txt'), 'oxia 0.10.1\nother 1\n'); commit('[improve][build] Add deps file (#106)');
sh(repo, 'checkout', '-q', 'branch-4.2');
fs.writeFileSync(path.join(repo, 'deps.txt'), 'oxia 0.10.1\nother 1\n'); commit('[improve][build][branch-4.2] Add deps file');
fs.writeFileSync(path.join(repo, 'deps.txt'), 'oxia 0.10.4\nother 1\n'); commit('[improve][meta][branch-4.2] Upgrade Oxia Java client to 0.10.4 (#301)');
fs.writeFileSync(src('Foo.java'), fs.readFileSync(src('Foo.java'), 'utf8').replace('line 15 foo', 'line 15 foo fixed for 4.2'));
commit('[fix][client][branch-4.2] Fix the timer leak on 4.2 (#302)\n\nBackport of apache/pulsar#109.');
sh(repo, 'checkout', '-q', 'master');
fs.writeFileSync(path.join(repo, 'deps.txt'), 'oxia 0.10.2\nother 1\n'); commit('[improve][meta] Upgrade Oxia Java client to 0.10.2 (#107)');
fs.writeFileSync(path.join(repo, 'deps.txt'), 'oxia 0.10.4\nother 1\n'); commit('[improve][meta] Upgrade Oxia Java client to 0.10.4 (#108)');
edit('Foo.java', 15, 'line 15 foo fixed'); commit('[fix][client] Stop the timer that leaks (#109)');
sh(repo, 'push', '-q', 'origin', 'master', 'branch-4.2', 'branch-4.0');

const db = await import('../scripts/lib/db.mjs');
const plan = await import('../scripts/lib/plan.mjs');
const lane = await import('../scripts/lib/lane.mjs');
const autopilot = await import('../scripts/lib/autopilot.mjs');
const jobs = await import('../scripts/lib/jobs.mjs');
const SID = 'test-session';

test('discover classifies, dry-runs and finds blame dependencies', () => {
  plan.createSession({ id: SID, repo, remote: 'origin', sincePr: 100, branches: plan.parseBranches('branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2') });
  const r = plan.discover(SID, { log: () => {} });
  assert.equal(r.total, 9);
  const v = plan.planView(SID);
  const by = Object.fromEntries(v.items.map((i) => [i.pr, i]));
  assert.equal(by[104].excluded, '[improve][ci]');
  assert.equal(by[105].kind, 'flaky');
  assert.equal(by[101].targets['branch-4.2'].dryrun.state, 'clean');
  assert.equal(by[103].targets['branch-4.2'].dryrun.state, 'main');
  assert.ok(by[103].deps.some((d) => d.depends_on === 102 && d.source === 'blame'), 'blame finds #102 under #103');
  // Branch-specific PRs: same title, a newer upgrade, an explicit reference.
  const eq = (pr) => by[pr].targets['branch-4.2'];
  assert.equal(eq(108).on_branch, 2); assert.equal(eq(108).equiv.via, 'title'); assert.match(eq(108).equiv.subject, /#301/);
  assert.equal(eq(107).on_branch, 2); assert.equal(eq(107).equiv.via, 'upgrade');
  assert.equal(eq(109).on_branch, 2); assert.equal(eq(109).equiv.via, 'reference');
  assert.equal(by[109].targets['branch-4.0'].on_branch, 0, 'not on branch-4.0');
  // "Not the same" survives the next discover.
  plan.rejectEquivalent(SID, 109, 'branch-4.2');
  plan.discover(SID, { log: () => {} });
  assert.equal(db.get(`SELECT on_branch FROM targets WHERE session_id = ? AND pr = 109 AND branch = 'branch-4.2'`, SID).on_branch, 0);
});

test('verdict import (legacy keys) and accept recommendations', () => {
  const f = path.join(tmp, 'verdicts.json');
  fs.writeFileSync(f, JSON.stringify([
    { pr: 101, verdict42: 'pick', verdict40: 'pick', severity: 'medium', risk: 'low', impact: 'x', dependsOn: [99] },
    { pr: 102, verdict42: 'skip', verdict40: 'skip', reason: 'refactor' },
    { pr: 103, value: 'high', valueNote: 'operators', dependsOn: [102], branches: { 'branch-4.2': { verdict: 'pick' }, 'branch-4.0': { verdict: 'pick' } } },
  ]));
  assert.equal(plan.importVerdicts(SID, f).imported, 3);
  assert.equal(db.get(`SELECT COUNT(*) n FROM deps WHERE session_id = ? AND depends_on = 99`, SID).n, 0, '#99 predates the range and is on the branches');
  // Decisions start as the recommendation.
  const t = (pr, b = 'branch-4.2') => db.get('SELECT decision, decision_source, recommendation FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', SID, pr, b);
  assert.deepEqual({ ...t(101) }, { decision: 'backport', decision_source: 'recommended', recommendation: 'backport' });
  assert.equal(t(102).decision, 'skip');
  assert.deepEqual(plan.labelPlan(SID).add.map((x) => x.pr).sort(), [101, 101, 103, 103]);
  assert.equal(plan.planView(SID).items.find((i) => i.pr === 103).assessment.value, 'high');
  // #103 depends on #102: they form a group and change together.
  assert.deepEqual(plan.planView(SID).items.find((i) => i.pr === 103).groups['branch-4.2'], [102, 103]);
  // A decision changes only its PR by default, so a group can be split; group: true changes all members.
  assert.deepEqual(plan.setDecisions(SID, [{ pr: 103, branch: 'branch-4.2', decision: 'skip' }]).map((c) => c.pr), [103]);
  assert.equal(t(102).decision, 'skip'); assert.equal(t(102).decision_source, 'recommended');
  const changed = plan.setDecisions(SID, [{ pr: 103, branch: 'branch-4.2', decision: 'defer' }], { group: true });
  assert.deepEqual(changed.map((c) => c.pr).sort(), [102, 103]);
  assert.equal(t(102).decision, 'defer'); assert.equal(t(102).decision_source, 'user');
  assert.equal(t(102, 'branch-4.0').decision, 'skip', 'other branch untouched');
  // Reviewing one member of a group accepts the whole group.
  assert.deepEqual(plan.setReviewed(SID, [103]).sort(), [102, 103]);
  assert.ok(db.get('SELECT reviewed_at FROM items WHERE session_id = ? AND pr = 102', SID).reviewed_at);
  assert.equal(t(102, 'branch-4.0').decision_source, 'user', 'accepting makes the recommendation the decision');
  plan.setReviewed(SID, [102], false);
  assert.equal(db.get('SELECT reviewed_at FROM items WHERE session_id = ? AND pr = 103', SID).reviewed_at, null);
  // A user decision survives a re-import; the recommendation is still shown.
  plan.importVerdicts(SID, f);
  assert.equal(t(103).decision, 'defer'); assert.equal(t(103).recommendation, 'backport');
  // A user-set value survives a re-import too.
  plan.setValue(SID, 103, 'low', 'only with a non-default setting');
  plan.importVerdicts(SID, f);
  assert.equal(plan.planView(SID).items.find((i) => i.pr === 103).assessment.value, 'low');
  // Back to the starting point for the backport tests: no group edge, recommendations.
  db.run(`DELETE FROM deps WHERE session_id = ? AND source = 'evaluator'`, SID);
  assert.equal(plan.applyRecommendations(SID, { all: true }).changed > 0, true);
  assert.equal(t(102).decision, 'skip'); assert.equal(t(103).decision, 'backport');
});

test('a dependency found while backporting blocks the pick until decided', () => {
  db.run(`UPDATE deps SET status = 'dismissed' WHERE session_id = ?`, SID); // pretend planning dismissed the hint
  db.run(`DELETE FROM deps WHERE session_id = ?`, SID); // and that it was never found
  db.run(`UPDATE sessions SET status = 'backporting' WHERE id = ?`, SID);
  lane.startLane(SID, 'branch-4.2', { log: () => {} });
  const r = lane.pickAll(SID, 'branch-4.2', { log: () => {} });
  assert.equal(r.results[0].status, 'picked');
  assert.equal(r.last.status, 'blocked');
  assert.equal(r.last.pr, 103);
  const dep = db.get(`SELECT * FROM deps WHERE session_id = ? AND pr = 103 AND depends_on = 102 AND branch = 'branch-4.2'`, SID);
  assert.equal(dep.phase, 'backport');
  lane.setDep(SID, dep.id, 'accepted');
  const r2 = lane.pickAll(SID, 'branch-4.2', { log: () => {} });
  assert.equal(r2.last.status, 'done');
  const subjects = sh(repo, '-C', lane.worktreeDir(SID, 'branch-4.2'), 'log', '--format=%s', 'origin/branch-4.2..HEAD').split('\n');
  assert.deepEqual(subjects, ['[fix][broker] Fix the refactored line (#103)', '[improve][broker] Refactor bar (#102)', '[fix][broker] Fix line two (#101)']);
  assert.equal(db.lane(SID, 'branch-4.2').phase, 'picked');
});

test('autopilot runs verify as a Claude job; fixups squash to the same tree', () => {
  const steps = autopilot.advance(SID);
  assert.ok(steps.some((s) => s.note === 'verify build'));
  const j = db.get(`SELECT * FROM jobs WHERE session_id = ? AND type = 'verify'`, SID);
  assert.equal(j.runner, 'claude');
  assert.match(jobs.workerPrompt(jobs.job(j.id)), /fixup!/);
  jobs.finish(j.id, 'done', { summary: 'ok' });
  const wt = lane.worktreeDir(SID, 'branch-4.2');
  const p101 = lane.lanePicks(SID, 'branch-4.2').find((p) => p.pr === 101);
  fs.writeFileSync(path.join(wt, 'mod/src/main/java/Foo.java'), fs.readFileSync(path.join(wt, 'mod/src/main/java/Foo.java'), 'utf8') + 'adapted\n');
  sh(wt, 'commit', '-qam', `fixup! ${p101.picked_sha}`);
  lane.setPhase(SID, 'branch-4.2', 'verified');
});

test('test PR, CI green, squash, finalize, done', () => {
  const push = lane.pushTest(SID, 'branch-4.2');
  assert.equal(push.pr.number, 9001);
  assert.ok(sh(origin, 'branch', '--list', 'branch-4.2-backports-test-session'));
  assert.equal(lane.pollCi(SID, 'branch-4.2').phase, 'ci-green');
  const tested = sh(lane.worktreeDir(SID, 'branch-4.2'), 'rev-parse', 'HEAD^{tree}');
  const sq = lane.squash(SID, 'branch-4.2');
  assert.notEqual(sq.tested, sq.squashed);
  assert.equal(sh(lane.worktreeDir(SID, 'branch-4.2'), 'rev-parse', 'HEAD^{tree}'), tested);
  assert.equal(sh(lane.worktreeDir(SID, 'branch-4.2'), 'rev-list', '--count', 'origin/branch-4.2..HEAD'), '3');
  const f = lane.finalize(SID, 'branch-4.2');
  assert.equal(f.status, 'pushed');
  assert.equal(sh(origin, 'rev-parse', 'branch-4.2'), sq.squashed);
  assert.equal(lane.pollCi(SID, 'branch-4.2').phase, 'done');
  const calls = fs.readFileSync(ghLog, 'utf8');
  assert.match(calls, /workflow run pulsar-ci.yaml/);
  assert.match(calls, /--add-label cherry-picked\/branch-4.2 --add-label release\/4.2.6/);
  assert.match(calls, /pr close 9001/);
});

test('branch-4.0 lane reuses the squashed branch-4.2 commits', () => {
  assert.ok(autopilot.advance(SID).some((s) => s.branch === 'branch-4.0' && s.note === 'start lane'));
  db.run(`DELETE FROM jobs WHERE session_id = ? AND branch = 'branch-4.0'`, SID);
  lane.startLane(SID, 'branch-4.0', { log: () => {} });
  const picks = lane.lanePicks(SID, 'branch-4.0');
  const p42 = Object.fromEntries(lane.lanePicks(SID, 'branch-4.2').map((p) => [p.pr, p.picked_sha]));
  for (const p of picks) { assert.ok(p.detail.reused); assert.equal(p.source_sha, p42[p.pr]); }
  const rr = lane.pickAll(SID, 'branch-4.0', { log: () => {} });
  assert.equal(rr.last.status, 'blocked', 'the #102 dependency accepted on branch-4.2 is asked again');
  assert.deepEqual(rr.last.unmet.map((d) => d.depends_on), [102]);
  const dep = db.get(`SELECT id FROM deps WHERE session_id = ? AND pr = 103 AND depends_on = 102 AND branch = 'branch-4.0'`, SID);
  lane.setDep(SID, dep.id, 'accepted');
  assert.equal(lane.pickAll(SID, 'branch-4.0', { log: () => {} }).last.status, 'done');
  const msg = sh(lane.worktreeDir(SID, 'branch-4.0'), 'log', '-1', '--format=%B', 'HEAD~2');
  assert.equal((msg.match(/cherry picked from commit/g) || []).length, 1, 'no second trailer');
  assert.match(sh(lane.worktreeDir(SID, 'branch-4.0'), 'show', 'HEAD~2:mod/src/main/java/Foo.java'), /adapted/);
});

test('finalize refuses to push an untested rebase without confirmation', () => {
  // Someone pushes to branch-4.0 meanwhile.
  const other = path.join(tmp, 'other'); sh(tmp, 'clone', '-q', '-b', 'branch-4.0', origin, other);
  fs.writeFileSync(path.join(other, 'NOTE'), 'x'); sh(other, 'add', '-A'); sh(other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-qm', 'other (#200)'); sh(other, 'push', '-q', 'origin', 'branch-4.0');
  db.updateLane(SID, 'branch-4.0', { phase: 'ready', squashed_sha: sh(lane.worktreeDir(SID, 'branch-4.0'), 'rev-parse', 'HEAD') });
  const r = lane.finalize(SID, 'branch-4.0');
  assert.equal(r.status, 'needs-confirmation');
  assert.equal(sh(origin, 'log', '-1', '--format=%s', 'branch-4.0'), 'other (#200)');
  assert.equal(lane.finalize(SID, 'branch-4.0').status, 'needs-confirmation', 'still needs confirmation');
  const r2 = lane.finalize(SID, 'branch-4.0', { allowRebase: true });
  assert.equal(r2.status, 'pushed');
  assert.equal(sh(origin, 'rev-list', '--count', 'branch-4.0~3..branch-4.0'), '3');
});

test('queued PR comments are posted once every lane is done', () => {
  plan.setComment(SID, 105, '');
  assert.equal(plan.separateBackportText(SID, 104), 'This PR would need to be separately backported to branch-4.2 & branch-4.0.');
  plan.setComment(SID, 104, 'Needs its own backport to branch-4.2 & branch-4.0 since it depends on #102.');
  assert.equal(lane.pollCi(SID, 'branch-4.0').phase, 'done');
  const steps = autopilot.advance(SID);
  assert.ok(steps.some((s) => s.note === 'post queued PR comments'), JSON.stringify(steps));
  assert.deepEqual(plan.postComments(SID, { log: () => {} }), { posted: 1, failed: 0 });
  assert.match(fs.readFileSync(ghLog, 'utf8'), /pr comment 104/);
  assert.equal(plan.pendingComments(SID).length, 0);
  assert.throws(() => plan.setComment(SID, 104, 'again'), /already posted/);
});
