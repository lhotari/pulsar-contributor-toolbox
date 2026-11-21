// Intent check: a Gradle dependency upgrade on master must be in effect in the branch's Maven build. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { intentCheck, parseCatalog, compareVersions } from '../scripts/lib/intent.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-intent-'));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const write = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

const catalog = (jwt) => `[versions]\nauth0-java-jwt = "${jwt}"\njackson = "2.21.0"\n\n[libraries]\njava-jwt = { module = "com.auth0:java-jwt", version.ref = "auth0-java-jwt" }\njackson-bom = { module = "com.fasterxml.jackson:jackson-bom", version.ref = "jackson" }\n`;
const pom = (jwt) => `<project><properties><jackson.version>2.21.0</jackson.version><jwt.version>${jwt}</jwt.version></properties>
<dependencies><dependency><groupId>com.auth0</groupId><artifactId>java-jwt</artifactId><version>\${jwt.version}</version></dependency></dependencies></project>`;

test('parse a version catalog and compare versions', () => {
  const c = parseCatalog(catalog('4.6.2'));
  assert.equal(c.versions['auth0-java-jwt'], '4.6.2');
  assert.deepEqual(c.libraries.map((l) => [l.module, l.ref]), [['com.auth0:java-jwt', 'auth0-java-jwt'], ['com.fasterxml.jackson:jackson-bom', 'jackson']]);
  assert.equal(compareVersions('4.10.0', '4.6.2'), 1); assert.equal(compareVersions('4.3.0', '4.6.2'), -1); assert.equal(compareVersions('4.6.2', '4.6.2'), 0);
});

test('a Gradle upgrade that is not made in Maven fails; made in Maven (and LICENSE) it passes', () => {
  const master = path.join(tmp, 'master'); fs.mkdirSync(master); sh(master, 'init', '-q', '-b', 'master');
  write(master, 'gradle/libs.versions.toml', catalog('4.6.0')); sh(master, 'add', '-A'); sh(master, 'commit', '-qm', 'base');
  write(master, 'gradle/libs.versions.toml', catalog('4.6.2')); sh(master, 'commit', '-qam', '[fix][sec] Upgrade java-jwt to 4.6.2 (#1)');
  const up = sh(master, 'rev-parse', 'HEAD');

  const branch = path.join(tmp, 'branch'); fs.mkdirSync(branch); sh(branch, 'init', '-q', '-b', 'branch-4.2');
  write(branch, 'pom.xml', pom('4.3.0'));
  write(branch, 'distribution/server/src/assemble/LICENSE.bin.txt', '    - com.auth0-java-jwt-4.3.0.jar\n');
  sh(branch, 'add', '-A'); sh(branch, 'commit', '-qm', 'branch');

  const bad = intentCheck({ repo: master, master: up, dir: branch });
  assert.equal(bad.ok, false);
  assert.equal(bad.checks[0].module, 'com.auth0:java-jwt');
  assert.equal(bad.problems.length, 2, 'the Maven version and the LICENSE jar');
  assert.match(bad.problems[0], /4\.3\.0 in pom\.xml.*4\.6\.0 → 4\.6\.2/);

  write(branch, 'pom.xml', pom('4.6.2'));
  write(branch, 'distribution/server/src/assemble/LICENSE.bin.txt', '    - com.auth0-java-jwt-4.6.2.jar\n');
  const good = intentCheck({ repo: master, master: up, dir: branch });
  assert.deepEqual([good.ok, good.problems], [true, []]);
  // A branch that is already newer is fine; a commit without catalog changes has nothing to check.
  write(branch, 'pom.xml', pom('4.7.0')); write(branch, 'distribution/server/src/assemble/LICENSE.bin.txt', '');
  assert.equal(intentCheck({ repo: master, master: up, dir: branch }).ok, true);
  assert.deepEqual(intentCheck({ repo: master, master: sh(master, 'rev-parse', 'HEAD~1'), dir: branch }).checks, []);
});
