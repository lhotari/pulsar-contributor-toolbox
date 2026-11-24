// Hunk compare and the intent rules: a backport that drops main code or changes master's tests fails. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { comparePick, compareHunks, addedTests, kindOf } from '../scripts/lib/compare.mjs';
import { intentCheck } from '../scripts/lib/intent.mjs';

const MAIN = 'broker/src/main/java/Dedup.java';
const TEST = 'broker/src/test/java/DedupTest.java';
const file = (p, diff, status = 'modified') => ({ path: p, old: p, status, diff });

const mainHunk = `@@ -10,4 +10,7 @@ class Dedup {
     boolean isDuplicate(Ctx c) {
         if (!enabled) {
             return false;
         }
+        if (c.producer() == null) {
+            return false;
+        }`;
const testHunk = (expected, indent = '        ') => `@@ -20,3 +20,9 @@ class DedupTest {
     }

+    @Test
+    public void restProduce() {
+${indent}Result r = publishWithoutProducer();
+${indent}assertEquals(r.errorCode(), ${expected});
+${indent}assertEquals(r.entries(), 4);
+    }`;

test('file kinds', () => {
  assert.equal(kindOf(MAIN), 'main'); assert.equal(kindOf(TEST), 'test');
  assert.equal(kindOf('pulsar-broker/build.gradle.kts'), 'build'); assert.equal(kindOf('pom.xml'), 'build');
  assert.deepEqual(addedTests(testHunk(0)), ['restProduce']);
});

test('identical hunks pass and are hidden; the same change in other context or indentation is not a difference', () => {
  const same = comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: file(MAIN, mainHunk) }, { path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, testHunk(0)) }]);
  assert.deepEqual(same.rules, []);
  assert.equal(same.counts.identical, 2);
  assert.deepEqual(same.files.map((f) => f.rows.length), [0, 0], 'identical hunks are left out by default');
  assert.equal(comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: file(MAIN, mainHunk) }], { identical: true }).files[0].rows.length, 1);

  const moved = mainHunk.replace('@@ -10,4 +10,7 @@', '@@ -30,4 +31,7 @@').replace('if (!enabled) {', 'if (!isEnabled()) {');
  const reindented = testHunk(0, '            ');
  const c = comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: file(MAIN, moved) }, { path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, reindented) }]);
  assert.deepEqual(c.rules, []);
  assert.equal(c.counts.context, 2);
  assert.deepEqual(c.files.map((f) => f.rows.length), [0, 0], 'the same change in other context is hidden too');
});

test('a dropped main hunk, a test-only backport and a changed test fail', () => {
  const dropped = comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: null }, { path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, testHunk(0)) }]);
  assert.deepEqual(dropped.rules.map((r) => [r.level, r.rule]), [['fail', 'main-dropped'], ['fail', 'main-missing']]);

  const changed = comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: file(MAIN, mainHunk) }, { path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, testHunk(2)) }]);
  assert.deepEqual(changed.rules.map((r) => r.rule), ['test-changed']);
  const row = changed.files[1].rows[0];
  assert.equal(row.kind, 'modified');
  assert.deepEqual(row.backport.marks.map((i) => row.backport.lines[i]), ['+        assertEquals(r.errorCode(), 2);'], 'the differing line is marked');

  const weaker = comparePick([{ path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, testHunk(0).replace(/\n\+ +assertEquals\(r\.entries\(\), 4\);/, '')) }]);
  assert.deepEqual(weaker.rules.map((r) => r.rule).sort(), ['assertions-dropped', 'test-changed']);

  const noTest = comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: file(MAIN, mainHunk) }, { path: TEST, master: file(TEST, testHunk(0)), backport: null }]);
  assert.deepEqual(noTest.rules.map((r) => r.rule).sort(), ['test-dropped', 'test-hunk-dropped']);
});

test('code the branch does not have is a warning; an import-only difference is none; extra main code is a warning', () => {
  const replace = `@@ -5,3 +5,3 @@ class Dedup {
     void close() {
-        legacy.shutdown();
+        legacy.close();
     }`;
  const absent = comparePick([{ path: MAIN, master: file(MAIN, replace), backport: null }], { fileAt: () => 'class Dedup {\n    void close() {\n    }\n}\n' });
  assert.deepEqual(absent.rules.map((r) => [r.level, r.rule]), [['warn', 'main-absent'], ['fail', 'main-missing']]);

  const imports = (extra) => `@@ -1,3 +1,4 @@\n import a.B;\n+import a.C;${extra}\n import a.D;`;
  assert.deepEqual(comparePick([{ path: TEST, master: file(TEST, imports('')), backport: file(TEST, imports('\n+import a.E;')) }]).rules, []);

  const extra = comparePick([{ path: MAIN, master: file(MAIN, mainHunk), backport: file(MAIN, `${mainHunk}\n@@ -90,2 +93,3 @@\n     void x() {\n+        hack();\n     }`) }]);
  assert.deepEqual(extra.rules.map((r) => [r.level, r.rule]), [['warn', 'main-extra']]);
  assert.deepEqual(compareHunks(mainHunk, mainHunk).map((r) => r.kind), ['identical']);
});

test('intentCheck fails a pick that changes master\'s test, until the user accepts it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-compare-'));
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const write = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  const main = (fixed) => `class Dedup {\n    boolean isDuplicate(Ctx c) {\n${fixed ? '        if (c.producer() == null) {\n            return false;\n        }\n' : ''}        return seen(c);\n    }\n}\n`;
  const tst = (expected) => `class DedupTest {\n${expected == null ? '' : `    @Test\n    public void restProduce() {\n        assertEquals(publish().errorCode(), ${expected});\n    }\n`}}\n`;
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo); sh(repo, 'init', '-q', '-b', 'master');
  write(repo, MAIN, main(false)); write(repo, TEST, tst(null)); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'branch', 'branch-4.2');
  write(repo, MAIN, main(true)); write(repo, TEST, tst(0)); sh(repo, 'commit', '-qam', 'fix (#1)');
  const master = sh(repo, 'rev-parse', 'HEAD');

  sh(repo, 'checkout', '-q', 'branch-4.2');
  write(repo, MAIN, main(true)); write(repo, TEST, tst(2)); sh(repo, 'commit', '-qam', 'fix (#1), test adapted');
  const picked = sh(repo, 'rev-parse', 'HEAD');
  const bad = intentCheck({ repo, master, dir: repo, picked });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /^test-changed: .*DedupTest\.java/);
  assert.equal(intentCheck({ repo, master, dir: repo, picked, accepted: [`test-changed:${TEST}`] }).ok, true);

  write(repo, TEST, tst(0)); sh(repo, 'commit', '-qa', '--amend', '-m', 'fix (#1)');
  assert.deepEqual(intentCheck({ repo, master, dir: repo, picked: sh(repo, 'rev-parse', 'HEAD') }), { ok: true, checks: [], problems: [], rules: [] });
});

test('slog on master and slf4j on the branch are the same change; a dropped or different-level log is not', () => {
  const P = 'client/src/main/java/ProducerImpl.java';
  const master = `@@ -10,3 +10,7 @@ class ProducerImpl {
             if (superseded(cnx)) {
+                log.debug().attr("connection", cnx.channel())
+                        .log("Ignoring the response to a superseded attempt");
+                return;
+            }
             connect();`;
  const branch = `@@ -12,3 +12,9 @@ class ProducerImpl {
             if (superseded(cnx)) {
+                if (log.isDebugEnabled()) {
+                    log.debug("[{}] Ignoring the response to a superseded attempt on {}", topic,
+                            cnx.channel());
+                }
+                return;
+            }
             connect();`;
  const same = comparePick([{ path: P, master: file(P, master), backport: file(P, branch) }]);
  assert.deepEqual(same.rules, []);
  assert.equal(same.counts.logging, 1);
  assert.deepEqual(same.files[0].rows, [], 'hidden like an identical hunk');

  const warn = comparePick([{ path: P, master: file(P, master), backport: file(P, branch.replace('log.debug(', 'log.warn(')) }]);
  assert.deepEqual(warn.rules.map((r) => r.rule), ['main-modified'], 'another level is a difference');
  const dropped = comparePick([{ path: P, master: file(P, master), backport: file(P, `@@ -12,3 +12,5 @@ class ProducerImpl {
             if (superseded(cnx)) {
+                return;
+            }
             connect();`) }]);
  assert.deepEqual(dropped.rules.map((r) => r.rule), ['main-modified'], 'a log statement left out is a difference');
});

test('the same lines cut into hunks differently on the two sides are the same change', () => {
  const P = 'ml/src/main/java/Cursor.java';
  const master = `@@ -10,6 +10,7 @@ class Cursor {
             if (fatal(rc)) {
+                close(lh);
                 log.error().attr("rc", rc)
                         .attr("ledger", id)
                         .log("Error reading");
                 return;
@@ -20,5 +21,6 @@ class Cursor {
             } else if (rc != OK) {
+                close(lh);
                 log.warn().attr("rc", rc)
                         .log("Error reading");`;
  const branch = `@@ -10,10 +10,12 @@ class Cursor {
             if (fatal(rc)) {
+                close(lh);
                 log.error("Error reading {} {}", rc, id);
                 return;
             } else if (rc != OK) {
+                close(lh);
                 log.warn("Error reading {}", rc);`;
  const c = comparePick([{ path: P, master: file(P, master), backport: file(P, branch) }]);
  assert.deepEqual(c.rules, [], 'no main-dropped: both insertions are there');
  assert.equal(c.counts['master-only'], 0);
  const dropped = comparePick([{ path: P, master: file(P, master), backport: file(P, branch.replace(/(\} else if \(rc != OK\) \{\n)\+ +close\(lh\);\n/, '$1')) }]);
  assert.deepEqual(dropped.rules.map((r) => r.rule), ['main-dropped'], 'one insertion really missing');
});

test('in tests, plain import changes are hidden; in main code an extra import is not a finding either', () => {
  const imports = `@@ -20,6 +20,7 @@\n import static org.mockito.Mockito.mock;\n+import static org.mockito.Mockito.verify;\n import org.testng.annotations.Test;`;
  const c = comparePick([{ path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, `${imports}\n${testHunk(0).replace('@@ -20,3 +20,9 @@', '@@ -40,3 +41,9 @@')}`) }]);
  assert.deepEqual(c.rules, []);
  assert.equal(c.counts.imports, 1);
  assert.deepEqual(c.files[0].rows, [], 'hidden by default');
  assert.equal(comparePick([{ path: TEST, master: file(TEST, testHunk(0)), backport: file(TEST, `${imports}\n${testHunk(0)}`) }], { identical: true }).files[0].rows.find((r) => r.kind === 'imports').backport.lines.length, 3);
});
