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
  "api graphql") if [ -f ${tmp}/graphql.json ]; then cat ${tmp}/graphql.json; else echo '{"data":{"repository":{}}}'; fi ;;
  "pr list")
    L=""; prev=""; for a in "$@"; do [ "$prev" = "--label" ] && L="$a"; prev="$a"; done
    f="${tmp}/labelled/$(echo "$L" | tr / _).json"
    if [ -n "$L" ] && [ -f "$f" ]; then cat "$f"; else echo '[]'; fi ;;
  "pr create") cat >/dev/null; echo 'https://github.com/apache/pulsar/pull/9001' ;;
  "pr checks") echo '[{"name":"unit","bucket":"pass","link":"l","workflow":"Pulsar CI"}]' ;;
  "run list") echo '[{"databaseId":1,"name":"Pulsar CI","status":"completed","conclusion":"success","url":"u","event":"workflow_dispatch"},{"databaseId":2,"name":"Pulsar CI Flaky","status":"completed","conclusion":"success","url":"u2","event":"workflow_dispatch"},{"databaseId":3,"name":"CI - Go Functions","status":"completed","conclusion":"skipped","url":"u3","event":"workflow_dispatch"},{"databaseId":4,"name":"CI - Python Functions","status":"completed","conclusion":"success","url":"u4","event":"workflow_dispatch"}]' ;;
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
  plan.saveConfig(SID, { diffReview: false }); // the diff review has its own test
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
  assert.deepEqual(plan.labelPlan(SID).add.filter((x) => x.kind === 'decision').map((x) => x.pr).sort(), [101, 101, 103, 103]);
  // Branch-specific PRs found by title or patch-id: the master PR gets the missing cherry-picked label (no release
  // label: there is no previous release tag); a newer upgrade of the dependency (#107) is a different change.
  assert.deepEqual(plan.labelPlan(SID).add.filter((x) => x.kind === 'on-branch').map((x) => `${x.pr} ${x.label}`).sort(), ['106 cherry-picked/branch-4.2', '108 cherry-picked/branch-4.2']);
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
  // A hint pointing at a PR that merged later and is a pick later in this batch does not block: it follows in master order.
  db.run(`INSERT INTO deps (session_id, pr, depends_on, branch, source, detail, status, phase, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    SID, 101, 103, 'branch-4.2', 'followup', 'follow-up named the wrong way round', 'accepted', 'plan', db.now());
  lane.startLane(SID, 'branch-4.2', { log: () => {} });
  const r = lane.pickAll(SID, 'branch-4.2', { log: () => {} });
  assert.equal(r.results[0].status, 'picked');
  assert.match(db.get(`SELECT detail FROM picks WHERE session_id = ? AND branch = 'branch-4.2' AND pr = 101`, SID).detail, /#103 .*follows later in this batch/);
  db.run(`DELETE FROM deps WHERE session_id = ? AND source = 'followup'`, SID);
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

test('test branch CI (dispatched, no PR), squash, finalize, done', () => {
  const push = lane.pushTest(SID, 'branch-4.2');
  assert.equal(push.dispatched.length, 4);
  assert.match(fs.readFileSync(ghLog, 'utf8'), /workflow run pulsar-ci.yaml -R apache\/pulsar --ref branch-4.2-backports-test-session/);
  // The verify fixup went into #101's own commit before the push; the pick shas follow the rewritten lane.
  const wt = lane.worktreeDir(SID, 'branch-4.2');
  assert.doesNotMatch(sh(wt, 'log', '--format=%s', 'origin/branch-4.2..HEAD'), /fixup!/);
  const p101 = lane.lanePicks(SID, 'branch-4.2').find((p) => p.pr === 101);
  assert.match(sh(wt, 'show', `${p101.picked_sha}:mod/src/main/java/Foo.java`), /adapted/);
  assert.match(sh(wt, 'log', '-1', '--format=%s', p101.picked_sha), /\(#101\)/);
  assert.ok(sh(origin, 'branch', '--list', 'branch-4.2-backports-test-session'));
  assert.equal(lane.pollCi(SID, 'branch-4.2').phase, 'ci-green');
  assert.deepEqual(db.all(`SELECT workflow, run_id, ref FROM ci_runs WHERE session_id = ? AND branch = 'branch-4.2' AND kind = 'test' ORDER BY run_id`, SID).map((r) => [r.run_id, r.ref]),
    [1, 2, 3, 4].map((id) => [id, 'branch-4.2-backports-test-session']), 'the deciding run ids are stored');
  assert.deepEqual(lane.trackedRuns(SID, 'branch-4.2', 'test', db.lane(SID, 'branch-4.2').ci.test.sha), { 'Pulsar CI': 1, 'Pulsar CI Flaky': 2, 'CI - Go Functions': 3, 'CI - Python Functions': 4 });
  const tested = sh(lane.worktreeDir(SID, 'branch-4.2'), 'rev-parse', 'HEAD^{tree}');
  const sq = lane.squash(SID, 'branch-4.2');
  assert.equal(sq.tested, sq.squashed, 'nothing left to squash');
  assert.equal(sh(lane.worktreeDir(SID, 'branch-4.2'), 'rev-parse', 'HEAD^{tree}'), tested);
  assert.equal(sh(lane.worktreeDir(SID, 'branch-4.2'), 'rev-list', '--count', 'origin/branch-4.2..HEAD'), '3');
  const f = lane.finalize(SID, 'branch-4.2');
  assert.equal(f.status, 'pushed');
  assert.equal(sh(origin, 'rev-parse', 'branch-4.2'), sq.squashed);
  assert.equal(sh(repo, 'rev-parse', 'refs/heads/branch-4.2'), sq.squashed, 'the local branch was fast-forwarded and pushed');
  assert.equal(lane.pollCi(SID, 'branch-4.2').phase, 'done');
  assert.deepEqual(lane.pollCi(SID, 'branch-4.2'), { state: 'none', phase: 'done' }, 'a done lane stays done when polled again');
  assert.equal(db.lane(SID, 'branch-4.2').phase, 'done');
  const calls = fs.readFileSync(ghLog, 'utf8');
  assert.match(calls, /workflow run pulsar-ci.yaml/);
  assert.match(calls, /--add-label cherry-picked\/branch-4.2 --add-label release\/4.2.6/);
  assert.doesNotMatch(calls, /pr create/, 'CI runs on the test branch, never in a PR');
  assert.match(calls, /run list -R apache\/pulsar --commit \w+ --event workflow_dispatch .*--branch branch-4.2-backports-test-session/);
});

test('branch-4.0 lane reuses the squashed branch-4.2 commits', () => {
  assert.ok(autopilot.advance(SID).some((s) => s.branch === 'branch-4.0' && s.note === 'start lane'));
  db.run(`DELETE FROM jobs WHERE session_id = ? AND branch = 'branch-4.0'`, SID);
  lane.startLane(SID, 'branch-4.0', { log: () => {} });
  const picks = lane.lanePicks(SID, 'branch-4.0');
  const p42 = Object.fromEntries(lane.lanePicks(SID, 'branch-4.2').map((p) => [p.pr, p.picked_sha]));
  for (const p of picks) { assert.ok(p.detail.reused); assert.equal(p.source_sha, p42[p.pr]); }
  // branch-4.2 accepted the #102 dependency while backporting, so branch-4.0 (which reuses branch-4.2's commits)
  // got the same decision then: it is not asked again.
  assert.equal(db.get(`SELECT status FROM deps WHERE session_id = ? AND pr = 103 AND depends_on = 102 AND branch = 'branch-4.0'`, SID).status, 'accepted');
  assert.match(db.get(`SELECT decision_note FROM targets WHERE session_id = ? AND pr = 102 AND branch = 'branch-4.0'`, SID).decision_note, /as on branch-4\.2/);
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
  // branch-4.0 is checked out in a worktree: Finalize fast-forwards it there and pushes that branch.
  const wt40 = path.join(tmp, 'wt-branch-4.0'); sh(repo, 'worktree', 'add', '-q', wt40, 'branch-4.0');
  const r2 = lane.finalize(SID, 'branch-4.0', { allowRebase: true });
  assert.equal(r2.status, 'pushed');
  assert.equal(sh(wt40, 'rev-parse', 'HEAD'), sh(origin, 'rev-parse', 'branch-4.0'));
  assert.equal(sh(wt40, 'status', '--porcelain'), '');
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

test('a dependency merged before the plan\'s range joins the plan and its group', () => {
  // Fresh master commits: #110 lands before the new plan's first PR (#111) and is on no branch.
  sh(repo, 'checkout', '-q', 'master'); sh(repo, 'pull', '-q', 'origin', 'master');
  edit('Bar.java', 12, 'line 12 prerequisite'); commit('[improve][broker] Prerequisite (#110)');
  edit('Bar.java', 18, 'line 18 since'); commit('[fix][broker] Since point (#111)');
  edit('Bar.java', 12, 'line 12 prerequisite and fixed'); commit('[fix][broker] Fix on top of the prerequisite (#112)');
  edit('Foo.java', 6, 'line 6 other'); commit('[fix][broker] Another fix (#113)');
  sh(repo, 'push', '-q', 'origin', 'master');
  const sid = 'pull-in-session';
  plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 111, branches: plan.parseBranches('branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2') });
  plan.discover(sid, { log: () => {}, blame: false });
  assert.equal(db.get('SELECT 1 x FROM items WHERE session_id = ? AND pr = 110', sid), undefined);
  // An evaluator hint for a PR skipped everywhere does not pull anything in.
  const dep = (pr, on, source) => db.run(`INSERT INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`, sid, pr, on, null, source, 'x', 'plan', db.now());
  dep(113, 110, 'evaluator');
  plan.setDecisions(sid, ['branch-4.2', 'branch-4.0'].map((branch) => ({ pr: 113, branch, decision: 'skip' })));
  assert.deepEqual(plan.pullInDependencies(sid).added, []);
  // A manual dependency does: in master order before the range, never pre-filtered, grouped with its dependent.
  dep(112, 110, 'manual');
  assert.deepEqual(plan.pullInDependencies(sid), { added: [110], missing: [] });
  const v = plan.planView(sid); const it = v.items.find((x) => x.pr === 110);
  assert.ok(it.master_order < 0 && v.items[0].pr === 110, 'ordered before the range');
  assert.deepEqual(it.stats.pulledIn, [112]);
  assert.equal(it.targets['branch-4.2'].on_branch, 0); assert.equal(it.targets['branch-4.2'].dryrun.state, 'clean');
  // Once in the plan, #110 groups through every grouping edge (the evaluator's from #113 too).
  assert.deepEqual([...plan.dependencyGroups(sid).get('branch-4.2').get(112)].sort(), [110, 112, 113]);
  // Idempotent; a number that is not a merged master PR is reported, not invented.
  assert.deepEqual(plan.pullInDependencies(sid), { added: [], missing: [] });
  dep(112, 4242, 'manual');
  assert.deepEqual(plan.pullInDependencies(sid).missing, [4242]);
  // The next discover keeps it and refreshes it.
  plan.discover(sid, { log: () => {}, blame: false });
  assert.equal(plan.planView(sid).items.find((x) => x.pr === 110).targets['branch-4.2'].on_branch, 0);
});

test('a pushed lane takes a backport and a revert on top; the report lists both', async () => {
  const B = 'branch-4.0'; const wt = lane.worktreeDir(SID, B);
  assert.equal(db.lane(SID, B).phase, 'done');
  // #113 merged after the plan was made: it joins the plan and goes on top of the pushed head with -x.
  const r = lane.pickOnTop(SID, B, 113, { reason: 'follow-up fix', log: () => {} });
  assert.equal(r.status, 'picked');
  assert.ok(db.get('SELECT 1 x FROM items WHERE session_id = ? AND pr = 113', SID));
  assert.match(sh(wt, 'log', '-1', '--format=%B'), /cherry picked from commit/);
  assert.throws(() => lane.pickOnTop(SID, B, 113, { log: () => {} }), /already picked/);
  // A pushed pick that needs a fix first is reverted with an ordinary revert commit.
  const rv = lane.revertOnTop(SID, B, 101, { reason: 'needs a fix first', log: () => {} });
  assert.match(sh(wt, 'log', '-1', '--format=%s'), /^Revert ".*\(#101\)"$/);
  assert.match(sh(wt, 'log', '-1', '--format=%b'), /This reverts commit [0-9a-f]{40}/);
  assert.equal(lane.lanePicks(SID, B).find((p) => p.pr === 101).status, 'reverted');
  assert.deepEqual(lane.unpushedOnTop(SID, B).map((x) => [x.kind, x.pr]), [['revert', 101], ['backport', 113]]);
  const { laneReport } = await import('../scripts/lib/report.mjs');
  let md = laneReport(SID, B);
  assert.match(md, /## Reverted[\s\S]*#101[\s\S]*not pushed yet[\s\S]*needs a fix first/);
  assert.match(md, /backported on top of the pushed batch \(follow-up fix\), not pushed yet/);
  assert.doesNotMatch(md.split('## Cherry-picks')[1], /### \d+\. \[#101\]/, 'a reverted pick is not listed as a cherry-pick');
  // Pushed by the user (fast-forward of the local branch), then CI again; the labels leave the reverted PR.
  lane.pushFinalFix(SID, B);
  assert.equal(sh(origin, 'rev-parse', B), rv.sha);
  assert.deepEqual(lane.unpushedOnTop(SID, B), []);
  md = laneReport(SID, B);
  assert.doesNotMatch(md, /not pushed yet/);
  assert.equal(lane.pollCi(SID, B).phase, 'done');
  assert.match(fs.readFileSync(ghLog, 'utf8'), /pr edit 101 -R apache\/pulsar --remove-label cherry-picked\/branch-4.0 --remove-label release\/4.0.15/);
  assert.throws(() => lane.revertOnTop(SID, B, 101, { reason: 'x' }), /not a committed pick/);
});

test('autopilot finishes the session when everything is done; a finished session is read-only, its reports are not', async () => {
  for (const b of ['branch-4.2', 'branch-4.0']) assert.equal(db.lane(SID, b).phase, 'done');
  db.run(`UPDATE jobs SET status = 'done' WHERE session_id = ? AND status IN ('queued','running','waiting')`, SID);
  assert.deepEqual(plan.pendingComments(SID), []);
  assert.ok(autopilot.advance(SID).some((x) => x.note === 'session finished'));
  assert.equal(db.session(SID).status, 'finished');
  assert.deepEqual(autopilot.advance(SID), [{ note: 'the session is finished (read-only)' }]);
  assert.throws(() => jobs.enqueue(SID, null, 'discover'), /finished and read-only/);
  const cli = (...args) => execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '../scripts/bpt.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => cli('plan', 'decide', SID, '101', 'branch-4.2', 'skip'), /finished and read-only/);
  assert.throws(() => cli('lane', 'revert', SID, 'branch-4.2', '102', '--reason', 'x'), /finished and read-only/);
  // Reading and the reports still work.
  assert.match(cli('report', SID, 'branch-4.2'), /^# Backports to branch-4.2/);
  assert.ok(JSON.parse(cli('lane', 'show', SID, 'branch-4.2')).picks.length);
  const { laneReport } = await import('../scripts/lib/report.mjs');
  assert.match(laneReport(SID, 'branch-4.0'), /## Cherry-picks/);
  // The escape hatch: CLI only, with a reason; autopilot stays off until it is turned on again.
  assert.throws(() => cli('session', 'reopen', SID), /--reason/);
  cli('session', 'reopen', SID, '--reason', 'correct a lane');
  assert.equal(db.session(SID).status, 'backporting');
  assert.equal(db.session(SID).config.autopilot, false);
});

test('while backporting: late picks go in master order, drops rebuild the lane, workers propose, abort resets', async () => {
  const control = await import('../scripts/lib/control.mjs');
  sh(repo, 'checkout', '-q', 'master'); sh(repo, 'pull', '-q', 'origin', 'master');
  edit('Foo.java', 8, 'line 8 fixed'); commit('[fix][broker] Fix line eight (#114)');
  edit('Bar.java', 3, 'line 3 fixed'); commit('[fix][broker] Fix line three (#115)');
  sh(repo, 'push', '-q', 'origin', 'master');
  const sid = 'control-session'; const B = 'branch-4.2';
  plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 111, branches: plan.parseBranches('branch-4.2:4.2.7') });
  plan.discover(sid, { log: () => {}, blame: false });
  plan.setDecisions(sid, [[112, 'skip'], [113, 'backport'], [114, 'backport'], [115, 'backport']].map(([pr, decision]) => ({ pr, branch: B, decision })));
  db.run(`UPDATE sessions SET status = 'backporting' WHERE id = ?`, sid);
  lane.startLane(sid, B, { log: () => {} });
  assert.equal(lane.pickAll(sid, B, { log: () => {} }).last.status, 'done');
  const wt = lane.worktreeDir(sid, B);
  const subjects = () => sh(wt, 'log', '--format=%s', `origin/${B}..HEAD`).split('\n').map((x) => x.replace('[fix][broker] ', ''));
  const pick = (pr) => lane.lanePicks(sid, B).find((p) => p.pr === pr);
  // A verify fix for #113, then the test PR.
  edit2(wt, 'Foo.java', 6, 'line 6 other, adapted'); sh(wt, 'commit', '-qam', 'x', `--fixup=${pick(113).picked_sha}`);
  lane.setPhase(sid, B, 'verified'); lane.pushTest(sid, B);
  const firstTest = db.lane(sid, B).test_branch;

  // #112 is decided "backport" while CI runs: it belongs before #113, so the lane waits for a decision.
  plan.setDecisions(sid, [{ pr: 112, branch: B, decision: 'backport' }]); lane.syncPicks(sid, B);
  const added = control.list(sid).find((d) => d.key === `added:${B}:112`);
  assert.deepEqual(added.options.map((o) => o.id), ['repick', 'on-top', 'skip']);
  assert.ok(autopilot.advance(sid).some((s) => /waits for a decision on #112/.test(s.note)));
  // Re-pick in master order: #113..#115 are re-applied after #112 (#113 with its fix inside), the test branch is retired.
  assert.deepEqual(control.apply(sid, added.key, 'repick').replayed, [113, 114, 115]);
  assert.equal(db.lane(sid, B).phase, 'picking'); assert.equal(db.lane(sid, B).test_branch, null); assert.equal(db.lane(sid, B).ci.round, 2);
  const r = lane.pickAll(sid, B, { log: () => {} });
  assert.deepEqual([r.last.status, r.last.pr], ['conflict', 112], '#112 needs #110, which is not on the branch');
  // The conflict goes to a Claude resolve job at once (no autopilot here), with the commit's changed tests worked out.
  const queued = db.get(`SELECT id, args FROM jobs WHERE session_id = ? AND type = 'resolve' AND status = 'queued'`, sid);
  assert.equal(db.J(queued.args).pr, 112);
  assert.deepEqual(lane.changedTests(sid, B, pick(112)), { tests: [], fallback: true, dtest: {} }, 'no test changed, no <Class>Test on the branch');

  // A worker asks, proposing the dependency; approving it pulls #110 into the plan and puts it first.
  const jid = jobs.enqueue(sid, B, 'resolve', { pr: 112 });
  jobs.finish(jid, 'waiting', { question: '#112 builds on #110', proposals: control.parseProposals('dep:110', 112) });
  const q = control.list(sid).find((d) => d.key === `job:${jid}`);
  assert.equal(q.options[0].label, 'Backport #110 before #112 (master order)');
  assert.deepEqual(control.apply(sid, q.key, 'p0').pulledIn, [110]);
  assert.equal(jobs.job(jid).status, 'done');
  assert.equal(lane.pickAll(sid, B, { log: () => {} }).last.status, 'done');
  assert.equal(pick(115).picked_sha, sh(wt, 'rev-parse', 'HEAD'), 'the verify fixup was squashed into #113 before the first push');
  assert.match(sh(wt, 'show', `${pick(113).picked_sha}:mod/src/main/java/Foo.java`), /line 6 other, adapted/);
  assert.deepEqual(subjects(), ['Fix line three (#115)', 'Fix line eight (#114)', 'Another fix (#113)',
    'Fix on top of the prerequisite (#112)', '[improve][broker] Prerequisite (#110)']);

  // Dropping a committed pick rebuilds the lane without it (and the fix squashed into it).
  assert.deepEqual(lane.dropPick(sid, B, 113, 'not needed on 4.2'), { dropped: [113], replayed: [114, 115], head: sh(wt, 'rev-parse', 'HEAD') });
  assert.equal(lane.pickAll(sid, B, { log: () => {} }).last.status, 'done');
  assert.deepEqual(subjects(), ['Fix line three (#115)', 'Fix line eight (#114)', 'Fix on top of the prerequisite (#112)', '[improve][broker] Prerequisite (#110)']);
  assert.equal(db.get('SELECT decision FROM targets WHERE session_id = ? AND pr = 113 AND branch = ?', sid, B).decision, 'skip');
  assert.doesNotMatch(sh(wt, 'show', 'HEAD:mod/src/main/java/Foo.java'), /line 6 other/);

  // The next test push starts round 2 and deletes the superseded test branch (no force-push).
  lane.setPhase(sid, B, 'verified');
  assert.equal(lane.pushTest(sid, B).testBranch, `${firstTest}-r2`);
  assert.equal(sh(origin, 'branch', '--list', firstTest), '');

  // A picked PR decided "skip" again holds the lane until dropped or kept.
  plan.setDecisions(sid, [{ pr: 114, branch: B, decision: 'skip' }]); lane.syncPicks(sid, B);
  assert.throws(() => { db.updateLane(sid, B, { phase: 'ready' }); lane.finalize(sid, B); }, /decisions are open for #114/);
  control.apply(sid, `unwanted:${B}:114`, 'keep');
  assert.equal(lane.holds(sid, B).length, 0);

  // Skipping or dropping a pick cancels the job working on it first.
  const rj = jobs.enqueue(sid, B, 'resolve', { pr: 115 });
  assert.deepEqual(control.cancelPickJobs(sid, B, 115, 'test'), [rj]);
  assert.equal(jobs.job(rj).status, 'cancelled');

  // Abort: the lane is reset, its test PR closed and its branch deleted; the session is back in planning.
  const out = lane.abortBackport(sid, { cancel: (id) => jobs.cancel(id) });
  assert.deepEqual(out, { reset: [B], kept: [] });
  assert.equal(db.lane(sid, B).phase, 'not-started'); assert.equal(db.lane(sid, B).ci.round, 3);
  assert.equal(fs.existsSync(wt), false); assert.equal(db.session(sid).status, 'planning');
  assert.equal(sh(origin, 'branch', '--list', `${firstTest}-r2`), '');
  assert.equal(db.get('SELECT decision FROM targets WHERE session_id = ? AND pr = 110 AND branch = ?', sid, B).decision, 'backport', 'decisions stay');
});

test('a dependency left out in review is not asked again: the pick goes on without it', async () => {
  const control = await import('../scripts/lib/control.mjs');
  const sid = 'excluded-session'; const B = 'branch-4.2';
  plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 111, branches: plan.parseBranches('branch-4.2:4.2.8') });
  plan.discover(sid, { log: () => {}, blame: false });
  db.run(`INSERT INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`, sid, 112, 110, null, 'manual', 'builds on it', 'plan', db.now());
  assert.deepEqual(plan.pullInDependencies(sid).added, [110]);
  // The user leaves #110 out in review; #112 is still wanted.
  plan.setDecisions(sid, [[110, 'skip'], [112, 'backport'], [113, 'skip'], [114, 'skip'], [115, 'skip']].map(([pr, decision]) => ({ pr, branch: B, decision })));
  db.run(`UPDATE sessions SET status = 'backporting' WHERE id = ?`, sid);
  lane.startLane(sid, B, { log: () => {} });
  const r = lane.pickAll(sid, B, { log: () => {} });
  assert.deepEqual([r.last.status, r.last.pr], ['conflict', 112], 'not blocked on #110: it was left out in review');
  const p = lane.lanePicks(sid, B).find((x) => x.pr === 112);
  assert.equal(p.detail.unmet, undefined);
  // #110 is before the since point, so the conflict scan does not see it; a hint for it as the scan would record it:
  db.run(`UPDATE picks SET detail = ? WHERE session_id = ? AND branch = ? AND pr = 112`,
    db.S({ ...p.detail, conflictDeps: [{ depends_on: 110, file: 'Bar.java', decision: 'skip', title: 'Prerequisite' }] }), sid, B);
  // The resolve worker sees it in its context, and asking for it is answered at once; the job stays the worker's.
  const jid = db.get(`SELECT id FROM jobs WHERE session_id = ? AND type = 'resolve' AND status = 'queued'`, sid).id;
  db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, jid);
  const bpt = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'bpt.mjs');
  const ctx = JSON.parse(execFileSync('node', [bpt, 'job', 'show', String(jid)], { encoding: 'utf8' }));
  assert.deepEqual(ctx.pick.excludedInReview.map((x) => x.pr), [110]);
  const said = execFileSync('node', [bpt, 'job', 'ask', String(jid), '--question', 'needs #110', '--propose', 'dep:112:110'], { encoding: 'utf8' });
  assert.match(said, /NOT ASKED/);
  assert.equal(jobs.job(jid).status, 'running');
  // Once no job works on it, the conflict decision does not offer #110 again.
  jobs.finish(jid, 'failed', { error: 'test' });
  const d = control.list(sid).find((x) => x.key === `conflict:${B}:112`);
  assert.ok(!d.options.some((o) => o.id === 'add:110'), 'no "Backport #110 first" option');
  assert.match(d.text, /without #110, left out in review/);
  // A blocked pick whose only missing dependency is later left out in review goes again.
  lane.resetLane(sid, B, 'test');
  plan.setDecisions(sid, [{ pr: 110, branch: B, decision: 'undecided' }]);
  lane.startLane(sid, B, { log: () => {} });
  assert.deepEqual(lane.pickAll(sid, B, { log: () => {} }).last.status, 'blocked');
  plan.setDecisions(sid, [{ pr: 110, branch: B, decision: 'skip' }]);
  assert.deepEqual(lane.releaseBlocked(sid, B), [112]);
});

test('every pick passes the build check; a fix for an earlier pick is squashed into it and the shas follow', async () => {
  // Fake Maven: records its arguments; fails compile/test while the FAIL marker exists.
  const mvnLog = path.join(tmp, 'mvn.log'); const failMark = path.join(tmp, 'mvn.fail');
  const fake = path.join(bin, 'fake-mvn');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${mvnLog}\ncase "$*" in *checkstyle:check*) exit 0 ;; esac\n[ -e ${failMark} ] && { echo "[ERROR] COMPILATION ERROR: cannot find symbol"; cat ${failMark}; exit 1; }\nexit 0\n`, { mode: 0o755 });
  process.env.BPT_MVN = fake;
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\npom.xml\n');
  try {
    const sid = 'build-session'; const B = 'branch-4.2';
    plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 113, branches: plan.parseBranches('branch-4.2:4.2.9') });
    plan.discover(sid, { log: () => {}, blame: false });
    plan.setDecisions(sid, [114, 115].map((pr) => ({ pr, branch: B, decision: 'backport' })));
    db.run(`UPDATE sessions SET status = 'backporting' WHERE id = ?`, sid);
    lane.startLane(sid, B, { log: () => {} });
    const wt = lane.worktreeDir(sid, B);
    fs.writeFileSync(path.join(wt, 'mod/pom.xml'), '<project/>');
    const pick = (pr) => lane.lanePicks(sid, B).find((p) => p.pr === pr);
    const r = lane.pickAll(sid, B, { log: () => {} });
    assert.equal(r.last.status, 'done');
    assert.deepEqual(r.results.map((x) => x.status), ['picked', 'built', 'picked', 'built', 'done'], 'each pick is built before the next one');
    assert.equal(pick(114).detail.build.ok, true); assert.deepEqual(pick(114).detail.build.modules, ['mod']);
    const calls = fs.readFileSync(mvnLog, 'utf8');
    assert.match(calls, /-pl mod -am package/);
    assert.match(calls, /-pl mod initialize checkstyle:check -Dcheckstyle.includes=\*\*\/Foo.java/);

    // The check fails for #114 (built again, e.g. after a rebuild): the pick needs a fix and goes to a resolve job.
    fs.writeFileSync(failMark, '');
    db.run(`UPDATE picks SET detail = json_remove(detail, '$.build') WHERE session_id = ? AND pr = 114`, sid);
    db.updateLane(sid, B, { phase: 'picking' });
    const f = lane.pickAll(sid, B, { log: () => {} }).last;
    assert.deepEqual([f.status, f.pr], ['needs-fix', 114]);
    assert.match(pick(114).detail.build.output, /cannot find symbol/);
    assert.ok(db.get(`SELECT 1 x FROM jobs WHERE session_id = ? AND type = 'resolve' AND json_extract(args, '$.pr') = 114`, sid));
    // The worker fixes it where it belongs, in #114's commit (not HEAD): a fixup the engine squashes in.
    const old114 = pick(114).picked_sha; const old115 = pick(115).picked_sha;
    edit2(wt, 'Foo.java', 9, 'line 9 fixed for the branch'); sh(wt, 'commit', '-qam', `fixup! ${sh(wt, 'log', '-1', '--format=%s', old114)}`);
    fs.rmSync(failMark);
    const res = lane.markResolved(sid, B, 114);
    assert.deepEqual(res.amended, [114]);
    assert.doesNotMatch(sh(wt, 'log', '--format=%s', `origin/${B}..HEAD`), /fixup!/);
    assert.notEqual(pick(114).picked_sha, old114); assert.notEqual(pick(115).picked_sha, old115);
    assert.equal(pick(115).picked_sha, sh(wt, 'rev-parse', 'HEAD'));
    assert.match(sh(wt, 'show', `${pick(114).picked_sha}:mod/src/main/java/Foo.java`), /line 9 fixed/);
    assert.equal(pick(115).detail.build.ok, true, 'a pick that was only rewritten keeps its check');
    const d = lane.pickAll(sid, B, { log: () => {} });
    assert.deepEqual(d.results.map((x) => x.status), ['built', 'done'], 'the amended pick is checked again');

    // A later pick's check fails on lines an earlier pick wrote: the earlier pick is named, and can be dropped from the decision.
    fs.writeFileSync(failMark, `[ERROR] ${wt}/mod/src/main/java/Foo.java:[8,5] cannot find symbol\n`);
    db.run(`UPDATE picks SET detail = json_remove(detail, '$.build') WHERE session_id = ? AND pr = 115`, sid);
    db.updateLane(sid, B, { phase: 'picking' });
    assert.deepEqual(lane.pickAll(sid, B, { log: () => {} }).last.status, 'needs-fix');
    assert.deepEqual(pick(115).detail.build.suspects.map((x) => [x.pr, x.file, x.line]), [[114, 'mod/src/main/java/Foo.java', 8]]);
    db.run(`UPDATE jobs SET status = 'cancelled' WHERE session_id = ? AND status = 'queued'`, sid);
    const control = await import('../scripts/lib/control.mjs');
    const dec = control.list(sid).find((x) => x.key === `needs-fix:${B}:115`);
    assert.ok(dec.options.some((o) => o.id === 'drop:114')); assert.match(dec.text, /come from earlier picks: #114 \(Foo.java:8\)/);
    fs.rmSync(failMark);
  } finally { delete process.env.BPT_MVN; }
});

test('diff review: picks are reviewed after picking, a concern holds the squash, a changed pick is reviewed again', async () => {
  const control = await import('../scripts/lib/control.mjs');
  const review = await import('../scripts/lib/review.mjs');
  const sid = 'review-session'; const B = 'branch-4.2';
  plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 113, branches: plan.parseBranches('branch-4.2:4.2.10') });
  plan.discover(sid, { log: () => {}, blame: false });
  plan.setDecisions(sid, [114, 115].map((pr) => ({ pr, branch: B, decision: 'backport' })));
  db.run(`UPDATE sessions SET status = 'backporting' WHERE id = ?`, sid);
  lane.startLane(sid, B, { log: () => {} });
  assert.equal(lane.pickAll(sid, B, { log: () => {} }).last.status, 'done');
  assert.deepEqual(review.unreviewed(sid, B), [114, 115]);
  // After picking, autopilot reviews before it verifies.
  assert.ok(autopilot.advance(sid).some((s) => /review\/analysis of #114, #115/.test(s.note)));
  const j = db.get(`SELECT id, args FROM jobs WHERE session_id = ? AND type = 'review' AND status = 'queued'`, sid);
  assert.deepEqual(db.J(j.args), { prs: [114, 115], review: [114, 115], analyze: [114, 115] });
  assert.match(jobs.workerPrompt(jobs.job(j.id)), /pick review/);
  // Both sides, file by file.
  const d = review.pickDiffs(sid, B, 114);
  assert.deepEqual(d.files.map((f) => [f.path, !!f.master, !!f.backport]), [['mod/src/main/java/Foo.java', true, true]]);
  assert.match(review.diffText(d), /----- master[\s\S]*----- backport/);
  review.record(sid, B, 114, { verdict: 'ok', summary: 'same change', job: j.id });
  assert.throws(() => review.record(sid, B, 115, { verdict: 'concern', summary: 's' }), /needs --concerns/);
  review.record(sid, B, 115, { verdict: 'concern', summary: 'drops a hunk', concerns: 'line 3 is not fixed', job: j.id });
  jobs.finish(j.id, 'done', { summary: 'reviewed' });
  assert.deepEqual(review.unreviewed(sid, B), []);
  // Explain: a read-only worker beside the lane's jobs (no branch), one per pick; its write-up is kept on the pick.
  const e1 = jobs.enqueue(sid, null, 'explain', { branch: B, pr: 115 });
  assert.equal(jobs.enqueue(sid, null, 'explain', { branch: B, pr: 115 }), e1, 'one per pick');
  assert.notEqual(jobs.enqueue(sid, null, 'explain', { branch: B, pr: 114 }), e1);
  assert.equal(jobs.activeJob(sid, B)?.type, undefined, 'the lane is not held up');
  const ep = jobs.workerPrompt(jobs.job(e1));
  assert.match(ep, /read only/); assert.match(ep, /pick compare review-session branch-4\.2 115 --identical/); assert.match(ep, /pick explain review-session branch-4\.2 115 --file/);
  review.recordExplanation(sid, B, 115, '## Summary\nLine 3 differs because …', e1);
  assert.match(review.comparePickHunks(sid, B, 115).explanations[0].text, /Line 3 differs/);
  // Ask a question: a job per question; answers accumulate, a new explanation replaces the old one.
  const q1 = jobs.enqueue(sid, null, 'explain', { branch: B, pr: 115, question: 'Why is line 3 kept?' });
  assert.notEqual(q1, e1);
  const qp = jobs.workerPrompt(jobs.job(q1));
  assert.match(qp, /Answer the user's question[\s\S]*> Why is line 3 kept\?/); assert.doesNotMatch(qp, /\*\*Verdict\*\*/);
  assert.match(ep, /\*\*Verdict\*\*/);
  review.recordExplanation(sid, B, 115, 'Because the branch has no helper.', q1);
  review.recordExplanation(sid, B, 115, '## Summary\nRewritten.', e1);
  assert.deepEqual(review.comparePickHunks(sid, B, 115).explanations.map((x) => [x.question, x.text.split('\n').pop()]),
    [[null, 'Rewritten.'], ['Why is line 3 kept?', 'Because the branch has no helper.']]);
  for (const x of db.all(`SELECT id FROM jobs WHERE session_id = ? AND type = 'explain'`, sid)) jobs.finish(x.id, 'done', {});
  // The concern is a decision, and it holds the squash.
  const dec = control.list(sid).find((x) => x.key === `review:${B}:115`);
  assert.deepEqual(dec.options.map((o) => o.id), ['fix', 'accept', 'drop']);
  db.updateLane(sid, B, { phase: 'ci-green' });
  plan.saveConfig(sid, { analysis: false }); // the analysis has its own part below
  assert.ok(autopilot.advance(sid).some((s) => /waits for the review concerns of #115/.test(s.note)));
  plan.saveConfig(sid, { analysis: true });
  control.apply(sid, dec.key, 'accept', 'not a problem on 4.2');
  assert.deepEqual(review.concerns(sid, B), []);
  // A rebuilt lane with the same patch keeps the review; a changed patch is reviewed again.
  const p114 = lane.lanePicks(sid, B).find((x) => x.pr === 114);
  db.run(`UPDATE picks SET picked_sha = ? WHERE session_id = ? AND branch = ? AND pr = 114`, sh(lane.worktreeDir(sid, B), 'rev-parse', 'HEAD'), sid, B);
  assert.deepEqual(review.unreviewed(sid, B), [114], 'a different patch');
  db.run(`UPDATE picks SET picked_sha = ?, detail = ? WHERE session_id = ? AND branch = ? AND pr = 114`, p114.picked_sha, db.S(p114.detail), sid, B);
  assert.deepEqual(review.unreviewed(sid, B), []);
  // The backport report: each cherry-pick with why, adaptation and validation, and the CI state.
  const { laneReport } = await import('../scripts/lib/report.mjs');
  const md = laneReport(sid, B);
  assert.match(md, /^# Backports to branch-4\.2 \(4\.2\.10\)/);
  assert.match(md, /### 1\. \[#114\]\(https:\/\/github\.com\/apache\/pulsar\/pull\/114\) \[fix\]\[broker\] Fix line eight/);
  assert.match(md, /Diff review: \*\*ok\*\* — same change/);
  assert.match(md, /Diff review: \*\*concern \(accepted\)\*\*.*Accepted: not a problem on 4\.2/);
  assert.match(md, /CI: not run yet for the current batch/);
  assert.match(md, /Compatibility: \*\*0 potential breaking change\(s\)\*\*.*\(2 not analyzed yet\)/);
  // The analysis is recorded once (review jobs) and the report reads it; a breaking change is highlighted at the top.
  assert.deepEqual(review.unanalyzed(sid, B), [114, 115]);
  assert.throws(() => review.recordAnalysis(sid, B, 115, { fixes: 'f', relevance: 'r', reason: 'bug', compat: 'breaking' }), /needs --compat-note/);
  review.recordAnalysis(sid, B, 114, { fixes: 'Line eight was wrong.', relevance: 'Foo is the same on the branch.', reason: 'divergence', compat: 'none' });
  review.recordAnalysis(sid, B, 115, { fixes: 'Line three was wrong.', relevance: 'The bug is on the branch.', reason: 'bug', compat: 'breaking', compatNote: 'line three now rejects old input (#4242)' });
  assert.deepEqual(review.unanalyzed(sid, B), []);
  const md2 = laneReport(sid, B);
  assert.match(md2, /## Potential breaking changes\n\n- \[#115\].*line three now rejects old input \(\[#4242\]\(https:\/\/github\.com\/apache\/pulsar\/issues\/4242\)\)/);
  assert.match(md2, /- \*\*Fixes:\*\* Line eight was wrong\.\n- \*\*Why on this branch:\*\* Foo is the same on the branch\. _\(avoids divergence from master\)_/);
  assert.match(md2, /\*\*potential breaking change\*\*: line three/);
});

function edit2(dir, f, i, text) { const p = path.join(dir, 'mod/src/main/java', f); const a = fs.readFileSync(p, 'utf8').split('\n'); a[i - 1] = text; fs.writeFileSync(p, a.join('\n')); }

test('PRs labelled for the release join the plan; changes already on the branch get the missing labels', () => {
  sh(repo, 'fetch', '-q', 'origin'); sh(repo, 'checkout', '-q', '--detach', 'origin/branch-4.2');
  sh(repo, 'tag', 'v4.2.5');   // the branch's previous release
  sh(repo, 'checkout', '-q', '--detach', 'origin/master');
  const f = (n) => path.join(repo, 'mod/src/main/java', n);
  fs.writeFileSync(f('Lab.java'), lines(40, 'lab')); const c117 = commit('[fix][broker] Add Lab (#117)');
  edit2(repo, 'Lab.java', 2, 'fixed line 2'); commit('[fix][broker] Labelled fix not picked yet (#118)');
  edit2(repo, 'Lab.java', 10, 'fixed line 10'); const c119 = commit('[fix][broker] Labelled fix with its own branch PR (#119)');
  edit2(repo, 'Lab.java', 18, 'since'); commit('[fix][broker] Since point (#120)');
  edit2(repo, 'Lab.java', 26, 'ci'); commit('[improve][ci] Labelled CI change (#121)');
  edit2(repo, 'Lab.java', 34, 'fixed line 34'); const c122 = commit('[fix][broker] Picked by someone else (#122)');
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/master');
  // branch-4.2 after v4.2.5: #117 cherry-picked, a branch-specific PR for #119, #122 cherry-picked; no labels set.
  sh(repo, 'checkout', '-q', '--detach', 'origin/branch-4.2');
  sh(repo, 'cherry-pick', '-x', c117);
  sh(repo, 'cherry-pick', '-n', c119); sh(repo, 'commit', '-q', '-m', '[fix][broker][branch-4.2] Fix line ten on 4.2 (#320)\n\nThis is a backport of apache/pulsar#119 adapted to branch-4.2.');
  sh(repo, 'cherry-pick', '-x', c122);
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/branch-4.2');
  fs.mkdirSync(path.join(tmp, 'labelled'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'labelled', 'release_4.2.6.json'), JSON.stringify([118, 119, 121].map((n) => ({ number: n, title: `#${n}`, baseRefName: 'master' }))));
  const meta = (n, labels) => [`p${n}`, { number: n, body: '', mergedAt: null, author: null, labels: { nodes: labels.map((name) => ({ name })) } }];
  fs.writeFileSync(path.join(tmp, 'graphql.json'), JSON.stringify({ data: { repository: Object.fromEntries([meta(118, ['release/4.2.6']), meta(119, ['release/4.2.6']), meta(121, ['release/4.2.6'])]) } }));
  try {
    const sid = 'labelled-session';
    plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 120, branches: plan.parseBranches('branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2') });
    const r = plan.discover(sid, { log: () => {}, blame: false });
    assert.deepEqual(r.labelledPulledIn.sort(), [118, 119]);
    const by = Object.fromEntries(plan.planView(sid).items.map((i) => [i.pr, i]));
    assert.deepEqual(by[118].stats.labelledIn, ['release/4.2.6']); assert.ok(by[118].master_order < 0);
    assert.equal(by[118].targets['branch-4.2'].on_branch, 0, 'labelled but not picked: it is in the plan to decide');
    assert.equal(by[119].targets['branch-4.2'].on_branch, 2); assert.equal(by[119].targets['branch-4.2'].equiv.via, 'reference');
    assert.equal(by[121].excluded, null, 'a release label overrides the pre-filter');
    assert.equal(by[122].targets['branch-4.2'].on_branch, 1);
    const lp = plan.labelPlan(sid);
    assert.equal(lp.cycles['branch-4.2'], 'v4.2.5'); assert.equal(lp.cycles['branch-4.0'], null);
    const onb = lp.add.filter((x) => x.kind === 'on-branch').map((x) => `${x.pr} ${x.label}`).sort();
    assert.deepEqual(onb, ['119 cherry-picked/branch-4.2', '122 cherry-picked/branch-4.2', '122 release/4.2.6']);
    // The next discover refreshes the labelled PRs and adds nothing twice.
    assert.deepEqual(plan.discover(sid, { log: () => {}, blame: false }).labelledPulledIn, []);
  } finally {
    fs.rmSync(path.join(tmp, 'graphql.json'), { force: true }); fs.rmSync(path.join(tmp, 'labelled'), { recursive: true, force: true });
  }
});

test('a session continues after the previous one: range, labelled only, or both; archive and delete', () => {
  const prev = 'labelled-session';
  sh(repo, 'checkout', '-q', '--detach', 'origin/master');
  const f = (n) => path.join(repo, 'mod/src/main/java', n);
  fs.writeFileSync(f('Next.java'), lines(30, 'next')); commit('[fix][broker] After the previous session (#130)');
  edit2(repo, 'Next.java', 15, 'labelled'); commit('[fix][broker] Labelled after the previous session (#131)');
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/master');
  // v4.2.6 is not tagged: the next session adds to 4.2.6. Tagged, it moves to 4.2.7.
  const n = plan.nextSession(prev);
  assert.equal(n.sinceSha, db.session(prev).config.masterHeadSha);
  assert.match(n.sinceTitle, /#122/);
  assert.equal(n.branches, 'branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2');
  sh(repo, 'tag', 'v4.2.6', 'origin/branch-4.2');
  assert.equal(plan.nextSession(prev).branches, 'branch-4.2:4.2.7,branch-4.0:4.0.15<branch-4.2');
  assert.equal(plan.nextSession(prev).title, 'Backports for 4.2.7 and 4.0.15');
  sh(repo, 'tag', '-d', 'v4.2.6');
  fs.mkdirSync(path.join(tmp, 'labelled'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'labelled', 'release_4.2.6.json'), JSON.stringify([118, 131].map((x) => ({ number: x, title: `#${x}`, baseRefName: 'master' }))));
  const meta = (x) => [`p${x}`, { number: x, body: '', mergedAt: null, author: null, labels: { nodes: [{ name: 'release/4.2.6' }] } }];
  fs.writeFileSync(path.join(tmp, 'graphql.json'), JSON.stringify({ data: { repository: Object.fromEntries([meta(118), meta(131)]) } }));
  try {
    const prs = (sid) => plan.planView(sid).items.map((i) => i.pr).sort((a, b) => a - b);
    for (const [sid, scope, want] of [['next-range', 'range', [130, 131]], ['next-labelled', 'labelled', [118, 131]], ['next-both', 'both', [118, 130, 131]]]) {
      const s = plan.createSession({ id: sid, after: prev, scope });
      assert.equal(s.config.after, prev); assert.equal(s.config.sinceSha, n.sinceSha); assert.equal(s.config.scope, scope);
      plan.discover(sid, { log: () => {}, blame: false });
      assert.deepEqual(prs(sid), want, scope);
    }
  } finally {
    fs.rmSync(path.join(tmp, 'graphql.json'), { force: true }); fs.rmSync(path.join(tmp, 'labelled'), { recursive: true, force: true });
  }
  // Archive: read-only (jobs and edits refused) until unarchived.
  assert.equal(plan.archiveSession('next-range', true, 'superseded'), true);
  assert.equal(db.session('next-range').config.autopilot, false);
  assert.throws(() => jobs.enqueue('next-range', null, 'discover'), /archived and read-only/);
  assert.equal(plan.archiveSession('next-range', false), true);
  db.assertEditable('next-range');
  // Delete: only a session that never started backporting.
  assert.deepEqual(plan.deleteBlockers('next-both'), []);
  plan.deleteSession('next-both');
  assert.equal(db.get('SELECT 1 x FROM sessions WHERE id = ?', 'next-both'), undefined);
  assert.equal(db.get('SELECT COUNT(*) n FROM items WHERE session_id = ?', 'next-both').n, 0);
  assert.ok(!fs.existsSync(plan.sessionDir('next-both')));
  assert.throws(() => plan.deleteSession(SID), /cannot be deleted .*archive it instead/);
});

test('triage runs one worker per batch and imports when the last one is done', () => {
  const sid = 'next-labelled';   // planning, untriaged PRs
  const cli = (...args) => execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '../scripts/bpt.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  const t = jobs.enqueue(sid, null, 'triage', { size: 1 });
  assert.equal(jobs.job(t).runner, 'engine');
  cli('job', 'run', String(t));
  assert.equal(jobs.job(t).status, 'done', JSON.stringify(jobs.job(t).result));
  const batches = db.all(`SELECT id, runner, args FROM jobs WHERE session_id = ? AND type = 'triage-batch' ORDER BY id`, sid).map((x) => ({ ...x, args: db.J(x.args) }));
  assert.ok(batches.length >= 2, 'one job per batch (size 1)');
  assert.ok(batches.every((b) => b.runner === 'claude' && b.args.out && b.args.brief));
  assert.match(jobs.workerPrompt(jobs.job(batches[0].id)), /Do not hand the work to subagents/);
  // The first batch writes its verdicts; nothing is imported while another batch runs.
  fs.writeFileSync(batches[0].args.out, '[]');
  jobs.finish(batches[0].id, 'done', { summary: 'ok' });
  assert.equal(db.get(`SELECT COUNT(*) n FROM jobs WHERE session_id = ? AND type = 'triage-import'`, sid).n, 0);
  for (const b of batches.slice(1)) jobs.finish(b.id, 'failed', { error: 'worker exited' });
  const imp = db.get(`SELECT id, args FROM jobs WHERE session_id = ? AND type = 'triage-import'`, sid);
  const a = db.J(imp.args);
  assert.deepEqual(a.files, [batches[0].args.out]);
  assert.deepEqual(a.missing, batches.slice(1).map((b) => b.args.batch));
  assert.match(jobs.workerPrompt(jobs.job(imp.id)), /wrote no verdicts/);
});

test('a custom session backports only the listed PRs and commits, with instructions for the workers', () => {
  const sid = 'custom-list';
  // A branch none of the earlier tests picked onto.
  const base = sh(repo, 'log', '--format=%H', '--fixed-strings', '--grep=(#99)', 'origin/master');
  sh(repo, 'push', '-q', 'origin', `${base}:refs/heads/branch-4.1`);
  const sha101 = sh(repo, 'log', '--format=%H', '--fixed-strings', '--grep=(#101)', 'origin/master');
  assert.throws(() => plan.createSession({ id: 'custom-bad', repo, remote: 'origin', list: '#103 nope', branches: plan.parseBranches('branch-4.1:4.1.9') }), /not a PR number or commit/);
  assert.throws(() => plan.createSession({ id: 'custom-bad', repo, remote: 'origin', list: '#4242', branches: plan.parseBranches('branch-4.1:4.1.9') }), /#4242 is not a PR merged/);
  const s = plan.createSession({ id: sid, repo, remote: 'origin', list: `https://github.com/apache/pulsar/pull/103, ${sha101.slice(0, 10)}`,
    instructions: 'Keep the branch API unchanged.', branches: plan.parseBranches('branch-4.1:4.1.9') });
  assert.equal(s.config.scope, 'list');
  assert.deepEqual(s.config.list.map((x) => x.pr), [103, 101]);
  assert.equal(s.config.sinceSha, sh(repo, 'rev-parse', `${sha101}^`), 'starts right before the oldest listed commit');
  plan.saveConfig(sid, { diffReview: false });
  const r = plan.discover(sid, { log: () => {} });
  assert.equal(r.total, 2); assert.deepEqual(r.listedNotFound, []);
  const items = db.all('SELECT pr, excluded FROM items WHERE session_id = ? ORDER BY master_order', sid);
  assert.deepEqual(items.map((x) => x.pr), [101, 103], 'only the listed PRs, in master order');
  const t = db.all(`SELECT pr, decision, decision_source, on_branch FROM targets WHERE session_id = ? ORDER BY pr`, sid);
  assert.ok(t.every((x) => x.decision === 'backport' && x.decision_source === 'user'), JSON.stringify(t));
  // A decision the user changes stays on the next discover.
  plan.setDecision(sid, 101, 'branch-4.1', 'defer');
  plan.discover(sid, { log: () => {} });
  assert.equal(db.get(`SELECT decision FROM targets WHERE session_id = ? AND pr = 101`, sid).decision, 'defer');
  // Every Claude worker gets the session's instructions.
  const id = jobs.enqueue(sid, 'branch-4.1', 'resolve', { pr: 103, instructions: 'only this job' });
  const p = jobs.workerPrompt(jobs.job(id));
  assert.match(p, /custom backport session: the user listed the master PRs to backport \(#103, #101\)/);
  assert.match(p, /Keep the branch API unchanged\./); assert.match(p, /User instructions: only this job/);
  db.run(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`, id);
  plan.setInstructions(sid, '');
  assert.doesNotMatch(jobs.workerPrompt(jobs.job(id)), /Keep the branch API/);
  // Edit the list: an older PR moves the starting point back; a removed one is skipped.
  const e = plan.editList(sid, { add: '#105 103', remove: '101' });
  assert.deepEqual(e.added, [105]); assert.deepEqual(e.removed, [101]);
  plan.discover(sid, { log: () => {} });
  assert.equal(db.get(`SELECT decision FROM targets WHERE session_id = ? AND pr = 105`, sid).decision, 'backport');
  assert.equal(db.get(`SELECT decision FROM targets WHERE session_id = ? AND pr = 101`, sid).decision, 'skip');
  assert.ok(!db.get(`SELECT 1 FROM items WHERE session_id = ? AND pr IN (102, 104)`, sid), 'unlisted PRs in the range stay out');
  assert.throws(() => plan.editList(sid, { remove: '103 105' }), /at least one/);
});

test('listed PRs on top of a session with a starting point', () => {
  const sid = 'range-plus-list';
  const s = plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 102, scope: 'range', list: '#101 105', branches: plan.parseBranches('branch-4.1:4.1.10') });
  assert.equal(s.config.scope, 'range', 'a starting point keeps the scope');
  assert.equal(s.config.sinceSha, sh(repo, 'log', '--format=%H', '--fixed-strings', '--grep=(#102)', 'origin/master'));
  plan.saveConfig(sid, { diffReview: false });
  const r = plan.discover(sid, { log: () => {}, blame: false });
  assert.deepEqual(r.listedPulledIn, [101], 'listed before the starting point: pulled in');
  const dec = (pr) => db.get(`SELECT decision, decision_source FROM targets WHERE session_id = ? AND pr = ?`, sid, pr);
  assert.equal(dec(101).decision, 'backport'); assert.equal(dec(105).decision, 'backport'); assert.equal(dec(105).decision_source, 'user');
  assert.equal(dec(103).decision, 'undecided', 'the range is evaluated as usual');
  assert.ok(db.get(`SELECT 1 FROM items WHERE session_id = ? AND pr = 104`, sid), 'unlisted PRs in the range stay in the plan');
  assert.match(jobs.workerPrompt(jobs.job(jobs.enqueue(sid, 'branch-4.1', 'verify', {}))), /Besides the PRs the plan found, the user listed these master PRs to backport: #101, #105/);
  db.run(`UPDATE jobs SET status = 'cancelled' WHERE session_id = ?`, sid);
  // Removing: in the range it goes back to the recommendation; only-listed is skipped.
  plan.editList(sid, { remove: '105 101' });
  assert.equal(dec(105).decision_source, 'recommended');
  assert.equal(dec(101).decision, 'skip');
  plan.discover(sid, { log: () => {}, blame: false });
  assert.equal(dec(105).decision_source, 'recommended', 'not listed again by the next discover');
  // Adding later works the same way.
  plan.editList(sid, { add: '105' });
  plan.discover(sid, { log: () => {}, blame: false });
  assert.equal(dec(105).decision, 'backport');
  assert.equal(plan.discover(sid, { log: () => {}, blame: false }).listedNotFound.length, 0);
});

test('a new session keeps the skips decided in an earlier session', () => {
  const prev = 'range-plus-list';
  const dec = (sid, pr) => db.get(`SELECT decision, decision_source, decision_note FROM targets WHERE session_id = ? AND pr = ? AND branch = 'branch-4.1'`, sid, pr);
  plan.setDecision(prev, 103, 'branch-4.1', 'skip', 'not for 4.1');
  plan.setDecision(prev, 104, 'branch-4.1', 'skip');
  plan.setDecision(prev, 104, 'branch-4.1', 'backport');   // the latest decision counts
  const sid = 'after-skips';
  plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 102, scope: 'range', list: '105', branches: plan.parseBranches('branch-4.1:4.1.10') });
  plan.setDecision(prev, 105, 'branch-4.1', 'skip');
  const r = plan.discover(sid, { log: () => {}, blame: false });
  assert.deepEqual(r.carriedSkips, [103]);
  assert.equal(dec(sid, 103).decision, 'skip'); assert.equal(dec(sid, 103).decision_source, 'user');
  assert.equal(dec(sid, 103).decision_note, `skipped in session ${prev}: not for 4.1`);
  assert.ok(db.get('SELECT reviewed_at FROM items WHERE session_id = ? AND pr = 103', sid).reviewed_at, 'decided: not in the review list');
  assert.notEqual(dec(sid, 104).decision, 'skip');
  assert.equal(dec(sid, 105).decision, 'backport', 'listed now: the earlier skip does not count');
  // A decision changed in this session stays.
  plan.setDecision(sid, 103, 'branch-4.1', 'backport');
  assert.deepEqual(plan.discover(sid, { log: () => {}, blame: false }).carriedSkips, []);
  assert.equal(dec(sid, 103).decision, 'backport');
});

test('labelled PRs from before the range that are on every branch they are labelled for are not in the plan', () => {
  sh(repo, 'fetch', '-q', 'origin'); sh(repo, 'checkout', '-q', '--detach', 'origin/master');
  const f = (n) => path.join(repo, 'mod/src/main/java', n);
  fs.writeFileSync(f('Drop.java'), lines(40, 'drop')); const c140 = commit('[fix][broker] Labelled 4.2 only, cherry-picked (#140)');
  edit2(repo, 'Drop.java', 10, 'both'); const c141 = commit('[fix][broker] Labelled for both, only on 4.2 (#141)');
  edit2(repo, 'Drop.java', 20, 'later'); const c143 = commit('[fix][broker] Labelled 4.2 only, picked later (#143)');
  edit2(repo, 'Drop.java', 30, 'since'); commit('[fix][broker] Since point (#142)');
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/master');
  sh(repo, 'checkout', '-q', '--detach', 'origin/branch-4.2');
  sh(repo, 'cherry-pick', '-x', c140); sh(repo, 'cherry-pick', '-x', c141);
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/branch-4.2');
  const labels = { 140: ['release/4.2.6', 'cherry-picked/branch-4.2'], 141: ['release/4.2.6', 'release/4.0.15', 'cherry-picked/branch-4.2'], 143: ['release/4.2.6'] };
  const fixtures = () => {
    fs.mkdirSync(path.join(tmp, 'labelled'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'labelled', 'release_4.2.6.json'), JSON.stringify([140, 141, 143].map((n) => ({ number: n, title: `#${n}`, baseRefName: 'master' }))));
    fs.writeFileSync(path.join(tmp, 'labelled', 'release_4.0.15.json'), JSON.stringify([141].map((n) => ({ number: n, title: `#${n}`, baseRefName: 'master' }))));
    fs.writeFileSync(path.join(tmp, 'graphql.json'), JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(labels).map(([n, ls]) =>
      [`p${n}`, { number: Number(n), body: '', mergedAt: null, author: null, labels: { nodes: ls.map((name) => ({ name })) } }])) } }));
  };
  try {
    fixtures();
    const sid = 'labelled-left-out';
    plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 142, branches: plan.parseBranches('branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2') });
    const r = plan.discover(sid, { log: () => {}, blame: false });
    const prs = () => plan.planView(sid).items.map((i) => i.pr).filter((x) => x >= 140 && x < 150).sort();
    assert.deepEqual(prs(), [141, 143], '#140 is done: on the only branch it is labelled for');
    assert.ok(!r.labelledPulledIn.includes(140));
    // #143 is cherry-picked and labelled later: the next discover takes it out.
    sh(repo, 'checkout', '-q', '--detach', 'origin/branch-4.2'); sh(repo, 'cherry-pick', '-x', c143);
    sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/branch-4.2');
    labels[143].push('cherry-picked/branch-4.2'); fixtures();
    const r2 = plan.discover(sid, { log: () => {}, blame: false });
    assert.deepEqual(r2.labelledLeftOut, [143]);
    assert.deepEqual(prs(), [141], '#141 is labelled for 4.0.15 and not on branch-4.0 yet');
    assert.equal(db.get('SELECT COUNT(*) n FROM targets WHERE session_id = ? AND pr = 143', sid).n, 0);
  } finally {
    fs.rmSync(path.join(tmp, 'graphql.json'), { force: true }); fs.rmSync(path.join(tmp, 'labelled'), { recursive: true, force: true });
  }
});

test('PRs labelled skip-cherry-pick are left out, even with a release label', () => {
  sh(repo, 'fetch', '-q', 'origin'); sh(repo, 'checkout', '-q', '--detach', 'origin/master');
  const f = (n) => path.join(repo, 'mod/src/main/java', n);
  fs.writeFileSync(f('Skip.java'), lines(40, 'skip')); commit('[fix][broker] Before the range, labelled for the release and skip (#150)');
  edit2(repo, 'Skip.java', 10, 'since'); commit('[fix][broker] Since point (#152)');
  edit2(repo, 'Skip.java', 20, 'in range'); commit('[fix][broker] In the range, skip-cherry-pick (#153)');
  edit2(repo, 'Skip.java', 30, 'listed'); commit('[fix][broker] Listed although skip-cherry-pick (#154)');
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/master');
  const labels = { 150: ['release/4.2.6', 'skip-cherry-pick'], 153: ['release/4.2.6', 'skip-cherry-pick'], 154: ['skip-cherry-pick'] };
  fs.mkdirSync(path.join(tmp, 'labelled'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'labelled', 'release_4.2.6.json'), JSON.stringify([150, 153].map((n) => ({ number: n, title: `#${n}`, baseRefName: 'master' }))));
  fs.writeFileSync(path.join(tmp, 'graphql.json'), JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(labels).map(([n, ls]) =>
    [`p${n}`, { number: Number(n), body: '', mergedAt: null, author: null, labels: { nodes: ls.map((name) => ({ name })) } }])) } }));
  try {
    const sid = 'skip-label';
    plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 152, list: '154', branches: plan.parseBranches('branch-4.2:4.2.6') });
    const r = plan.discover(sid, { log: () => {}, blame: false });
    assert.ok(!r.labelledPulledIn.includes(150), 'not pulled in by its release label');
    assert.equal(db.get('SELECT 1 x FROM items WHERE session_id = ? AND pr = 150', sid), undefined);
    assert.equal(db.get('SELECT excluded FROM items WHERE session_id = ? AND pr = 153', sid).excluded, 'labelled skip-cherry-pick');
    assert.equal(db.get('SELECT excluded FROM items WHERE session_id = ? AND pr = 154', sid).excluded, null, 'listed by the user: kept');
  } finally {
    fs.rmSync(path.join(tmp, 'graphql.json'), { force: true }); fs.rmSync(path.join(tmp, 'labelled'), { recursive: true, force: true });
  }
});

test('a dependency accepted on branch-4.2 while backporting also holds on the branch-4.0 lane that reuses it', () => {
  const sid = 'mirror-deps';
  plan.createSession({ id: sid, repo, remote: 'origin', sincePr: 152, list: '154', branches: plan.parseBranches('branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2') });
  plan.discover(sid, { log: () => {}, blame: false });
  const t = (pr, b) => db.get('SELECT on_branch, decision, decision_source, decision_note FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, pr, b);
  assert.equal(t(154, 'branch-4.0').decision, 'backport');
  plan.addPrs(sid, [118], { reason: 'test' });
  assert.equal(t(118, 'branch-4.0').on_branch, 0);
  db.run(`INSERT INTO deps (session_id, pr, depends_on, branch, source, detail, status, phase, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    sid, 154, 118, 'branch-4.2', 'manual', 'proposed by a worker', 'open', 'backport', db.now());
  const id = db.get('SELECT id FROM deps WHERE session_id = ? AND branch = ?', sid, 'branch-4.2').id;
  lane.setDep(sid, id, 'accepted');
  assert.equal(t(118, 'branch-4.2').decision, 'backport');
  assert.equal(t(118, 'branch-4.0').decision, 'backport', 'the same decision on the reusing lane');
  assert.match(t(118, 'branch-4.0').decision_note, /as on branch-4\.2/);
  const m = db.get(`SELECT status, detail FROM deps WHERE session_id = ? AND pr = 154 AND depends_on = 118 AND branch = 'branch-4.0'`, sid);
  assert.equal(m.status, 'accepted'); assert.match(m.detail, /^as on branch-4\.2/);
  // A decision the user made for branch-4.0 stays; a dependent that does not go to branch-4.0 mirrors nothing.
  plan.setDecision(sid, 118, 'branch-4.0', 'skip', 'not on 4.0');
  lane.setDep(sid, id, 'dismissed'); lane.setDep(sid, id, 'accepted');
  assert.equal(t(118, 'branch-4.0').decision, 'skip');
});
