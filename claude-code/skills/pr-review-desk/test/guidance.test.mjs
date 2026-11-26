// Contributor guidance: semantic titles, CI log classification, Personal CI signs, the texts and the body guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PRD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-guidance-'));
const g = await import('../scripts/lib/guidance.mjs');

test('semantic titles', () => {
  assert.equal(g.titleProblem('[fix][broker] Fix the race'), null);
  assert.equal(g.titleProblem('[improve] Better logs'), null, 'the component is optional');
  assert.equal(g.titleProblem('[fix][broker][branch-4.0] Fix it'), null);
  assert.match(g.titleProblem('Fix the race'), /does not start with/);
  assert.match(g.titleProblem('[bugfix][broker] Fix'), /`\[bugfix\]` is not one of the types/);
  assert.match(g.titleProblem('[fix][core] Fix'), /`\[core\]` is not one of the components/);
  assert.match(g.titleProblem('[fix][broker]'), /summary after the prefix is empty/);
  assert.ok(g.enabled('apache/pulsar') && g.enabled('someone/pulsar') && !g.enabled('apache/bookkeeper'));
});

test('CI logs: checkstyle, license and format failures; compile failures', () => {
  const ts = '2026-11-24T10:00:00.1234567Z ';
  const cs = g.classifyLog([`${ts}> Task :pulsar-broker:checkstyleMain FAILED`, `${ts}[ant:checkstyle] [ERROR] /w/pulsar-broker/src/main/java/A.java:12:5: Unused import [UnusedImports]`,
    `${ts}Execution failed for task ':pulsar-broker:checkstyleMain'.`].join('\n'));
  assert.deepEqual(cs.compile, []);
  assert.match(cs.checkstyle[0], /^\[ant:checkstyle\] \[ERROR\] .*A\.java:12:5/);
  assert.equal(g.classifyLog(`Execution failed for task ':spotlessJavaCheck'.\nThe following files had format violations:`).checkstyle.length > 0, true);
  assert.ok(g.classifyLog('[ERROR] Failed to execute goal org.apache.maven.plugins:maven-checkstyle-plugin:3.6.0:check (checkstyle) on project pulsar-broker').checkstyle.length);
  const cc = g.classifyLog(`${ts}/w/pulsar-client/src/main/java/B.java:40: error: cannot find symbol\n${ts}Execution failed for task ':pulsar-client:compileJava'.`);
  assert.match(cc.compile[0], /B\.java:40: error: cannot find symbol/); assert.deepEqual(cc.checkstyle, []);
  assert.ok(g.classifyLog('[ERROR] COMPILATION ERROR :\n[ERROR] /w/C.java:[10,5] cannot find symbol').compile[0].includes('C.java:[10,5]'));
  assert.deepEqual(g.classifyLog('Tests run: 5, Failures: 1'), { checkstyle: [], compile: [] });
  // A dependency download failure fails compileJava too; it is not a compile error of the PR.
  assert.deepEqual(g.classifyLog([`${ts}> Task :pulsar-common:compileJava FAILED`, `${ts}Execution failed for task ':pulsar-common:compileJava' (registered by plugin class 'org.gradle.api.plugins.JavaBasePlugin').`,
    `${ts}   > Could not resolve org.roaringbitmap:RoaringBitmap:1.6.30.`, `${ts}                > Received status code 429 from server: Too Many Requests`].join('\n')), { checkstyle: [], compile: [] });
});

test('failed checks: logs of the build job are read first, at most maxLogs', async () => {
  const calls = [];
  const fake = {
    rest: async (m, p) => ({ check_runs: [
      { id: 1, name: 'CI - Unit - Brokers', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/apache/pulsar/actions/runs/9/job/1' },
      { id: 2, name: 'Build and License check', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/apache/pulsar/actions/runs/9/job/2' },
      { id: 3, name: 'Check pull request title', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/apache/pulsar/actions/runs/8/job/3' },
      { id: 4, name: 'CI - Unit - Proxy', status: 'completed', conclusion: 'success', html_url: 'x' }] }),
    restRaw: async (m, p) => { calls.push(p); return { ok: true, stdout: p.includes('/2/') ? '[ant:checkstyle] [ERROR] A.java:1:1: x' : 'Z.java:3: error: cannot find symbol\nCompilation failed; see the compiler error output' }; },
  };
  const r = await g.ciFailures('apache/pulsar', 'a'.repeat(40), { gh: fake });
  assert.equal(calls[0], 'repos/apache/pulsar/actions/jobs/2/logs', 'the build job first');
  assert.equal(r.checkstyle.job, 'Build and License check'); assert.equal(r.compile.job, 'CI - Unit - Brokers');
  assert.equal(r.titleCheck.job, 'Check pull request title'); assert.deepEqual(r.failed.length, 3);
});

test('Personal CI signs and the guidance texts', () => {
  assert.ok(g.personalCiSigns('alice', ['PR in forked repository: https://github.com/alice/pulsar/pull/12']));
  assert.ok(g.personalCiSigns('alice', ['I ran it with Personal CI']));
  assert.ok(!g.personalCiSigns('alice', ['PR in forked repository: <!-- ENTER URL HERE -->', 'https://github.com/bob/pulsar/pull/3']));
  const base = { gradle: true, firstTimer: false, personalCiSigns: false, titleProblem: null, ci: { failed: [] }, said: {} };
  assert.deepEqual(g.items(base), []);
  const cs = g.items({ ...base, ci: { checkstyle: { job: 'Build and License check', url: 'https://x/1', lines: ['l'] } } });
  assert.equal(cs[0].key, 'checkstyle'); assert.match(cs[0].text, /`\.\/gradlew quickCheck` before pushing changes to the PR branch/); assert.match(cs[0].text, /\[Build and License check\]\(https:\/\/x\/1\)/);
  assert.match(g.items({ ...base, gradle: false, ci: { checkstyle: { job: 'j' } } })[0].text, /mvn .*verify -DskipTests/);
  const cc = g.items({ ...base, firstTimer: true, ci: { compile: { job: 'Build', url: 'u' } } });
  assert.deepEqual(cc.map((x) => x.key), ['personal-ci'], 'compile failure: Personal CI once, not also the first-timer note');
  assert.match(cc[0].text, /does not compile/); assert.ok(cc[0].text.includes(g.LINKS.personalCi));
  assert.match(cc[0].text, /no need to wait for a maintainer to approve the CI runs/); assert.match(cc[0].text, /saves the project's CI resources/);
  assert.match(g.items(base, ['personal-ci'])[0].text, /have not been built and tested yet/);
  const ft = g.items({ ...base, firstTimer: true });
  assert.equal(ft[0].key, 'first-timer'); assert.match(ft[0].text, /wait here until a maintainer approves them/); assert.match(ft[0].text, /saves the project's CI resources/);
  assert.deepEqual(g.items({ ...base, firstTimer: true, personalCiSigns: true }), [], 'already uses Personal CI');
  assert.deepEqual(g.items({ ...base, firstTimer: true, said: { personalCi: true } }), [], 'already told on the PR');
  const t = g.items({ ...base, titleProblem: '`[bugfix]` is not one of the types' });
  assert.ok(t[0].text.includes(g.LINKS.semanticTitle)); assert.deepEqual(g.items({ ...base, titleProblem: 'x', said: { title: true } }), []);
});

test('accountability: replies about Personal CI that the fork does not back', async () => {
  const none = { repo: 'bob/pulsar', prs: 0, runs: 0 };
  assert.match(g.unbackedPersonalCi({ author: 'bob', authorTexts: ["I'll get a Personal CI run going in my fork once this head is merged"], fork: none }), /mention Personal CI, but bob\/pulsar has no pull requests/);
  assert.match(g.unbackedPersonalCi({ author: 'bob', authorTexts: ['Thanks, fixed'], askedForPersonalCi: true, fork: none }), /was pointed at Personal CI/);
  assert.equal(g.unbackedPersonalCi({ author: 'bob', authorTexts: ['Personal CI is running'], fork: { ...none, runs: 3 } }), null, 'the fork has runs');
  assert.equal(g.unbackedPersonalCi({ author: 'bob', authorTexts: ['Thanks, fixed'], fork: none }), null, 'nothing about Personal CI');
  assert.equal(g.unbackedPersonalCi({ author: 'bob', authorTexts: ['Personal CI later'], fork: { ...none, prs: null } }), null, 'unknown: not claimed');
  const fake = (pulls, runs) => ({ rest: async (m, p) => (p.includes('/pulls') ? pulls : runs) });
  assert.deepEqual(await g.forkActivity('apache/pulsar', 'bob', { gh: fake([], { total_count: 0 }) }), { repo: 'bob/pulsar', prs: 0, runs: 0 });
  assert.deepEqual(await g.forkActivity('apache/pulsar', 'bob', { gh: { rest: async () => { throw new Error('HTTP 404: Not Found'); } } }), { repo: 'bob/pulsar', prs: 0, runs: 0, missing: true });
  assert.equal(await g.forkActivity('apache/pulsar', 'bob', { gh: { rest: async () => { throw new Error('HTTP 502'); } } }), null);
  const base = { gradle: true, firstTimer: false, personalCiSigns: false, titleProblem: null, ci: { failed: [] }, said: {} };
  const acc = g.items({ ...base, accountability: 'the author\'s replies mention Personal CI, but bob/pulsar has no pull requests and no workflow runs', fork: none });
  assert.equal(acc[0].key, 'accountability');
  assert.ok(acc[0].text.startsWith('Looking at https://github.com/bob/pulsar/pulls, it appears you haven\'t tried using [Personal CI]'));
  assert.ok(acc[0].text.includes(g.AI_POLICY_QUOTE)); assert.ok(acc[0].text.includes(g.LINKS.aiPolicy));
  assert.deepEqual(g.items({ ...base, accountability: 'x', fork: none, said: { accountability: true } }), [], 'quoted on the PR already');
  const req = g.items({ ...base, said: { accountability: true } }, ['accountability']);
  assert.equal(req[0].key, 'accountability', 'the reviewer asks again with new evidence'); assert.ok(req[0].text.startsWith('Please make sure'));
  assert.deepEqual(g.ensure(`Thanks.\n\n${req[0].text}`, req).added, [], 'the quote is the marker');
});

test('ensure appends only what the body leaves out', () => {
  const list = g.items({ gradle: true, firstTimer: true, personalCiSigns: false, titleProblem: 'it does not start with `[type]`', ci: { checkstyle: { job: 'B', url: 'u' } }, said: {} });
  const r = g.ensure(`Thanks for the PR! Please run \`./gradlew quickCheck\` before pushing.`, list);
  assert.deepEqual(r.added, ['first-timer', 'title']);
  assert.ok(r.body.startsWith('Thanks for the PR!')); assert.ok(r.body.includes(g.LINKS.personalCi)); assert.ok(r.body.includes(g.LINKS.semanticTitle));
  assert.deepEqual(g.ensure(r.body, list).added, [], 'idempotent');
});
