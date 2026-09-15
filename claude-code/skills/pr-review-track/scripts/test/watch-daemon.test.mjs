// node --test scripts/test/watch-daemon.test.mjs
//
// The detached watcher. A watcher that dies with whatever started it stops
// posting approved reviews silently, and a harness monitor window is one of the
// things that ends — so `--detach` has to leave a process behind that nothing
// in the session owns, `--status` has to find it, `--stop` has to end it, and
// a second start has to reuse rather than race it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '../..');
const REPO = 'o/r';

let ROOT;
let BIN;
let SCENARIO;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-watch-'));
  BIN = path.join(ROOT, 'bin');
  fs.mkdirSync(BIN, { recursive: true });
  const shim = path.join(BIN, 'gh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(SKILL, 'scripts/test/helpers/fake-gh.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  SCENARIO = path.join(ROOT, 'scenario.json');
  fs.writeFileSync(SCENARIO, JSON.stringify({
    callLog: path.join(ROOT, 'calls.jsonl'),
    rules: [{ when: { args: ['graphql'], body: 'viewer' }, stdout: '{"data":{"viewer":{"login":"me"}}}' }],
  }));
  fs.mkdirSync(path.join(ROOT, 'o', 'r'), { recursive: true });
});

after(() => {
  // Never leave a watcher behind, whatever the assertions did.
  prt(['watch', '--stop']);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function prt(args) {
  return spawnSync(process.execPath, [path.join(SKILL, 'scripts/prt.mjs'), ...args, '--repo', REPO], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, PRT_ROOT: ROOT, PRT_FAKE_GH: SCENARIO },
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidfile = () => path.join(ROOT, 'watch', 'o__r.pid');

test('--detach leaves a watcher running that --status finds and --stop ends', async () => {
  assert.equal(prt(['watch', '--status']).status, 3, 'nothing running yet');

  const started = prt(['watch', '--detach', '--interval', '1', '--json']);
  assert.equal(started.status, 0, started.stderr);
  const rec = JSON.parse(started.stdout);
  assert.equal(rec.started, true);
  assert.ok(alive(rec.pid), 'the child is alive after the parent returned');
  assert.equal(JSON.parse(fs.readFileSync(pidfile(), 'utf8')).pid, rec.pid);

  const status = prt(['watch', '--status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, new RegExp(`running \\(pid ${rec.pid}\\)`));

  // The log is where its output goes, so a tail can surface it.
  await new Promise((r) => setTimeout(r, 300));
  assert.match(fs.readFileSync(rec.log, 'utf8'), /watching o\/r every 1s/);

  // A second start reuses it; a foreground start refuses it.
  const again = prt(['watch', '--detach', '--json']);
  assert.equal(again.status, 0);
  assert.deepEqual([JSON.parse(again.stdout).reused, JSON.parse(again.stdout).pid], [true, rec.pid]);
  const fg = prt(['watch', '--interval', '1']);
  assert.notEqual(fg.status, 0);
  assert.match(fg.stderr, /already running/);

  const stopped = prt(['watch', '--stop']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(alive(rec.pid), false, 'stopped within the interval, not after it');
  assert.equal(fs.existsSync(pidfile()), false, 'the pidfile went with it');
  assert.equal(prt(['watch', '--status']).status, 3);
});

test('a stale pidfile is not a running watcher', () => {
  fs.mkdirSync(path.dirname(pidfile()), { recursive: true });
  fs.writeFileSync(pidfile(), JSON.stringify({ pid: 2 ** 22 - 1, startedAt: 'never' }));
  const status = prt(['watch', '--status']);
  assert.equal(status.status, 3);
  assert.match(status.stdout, /not running/);
  assert.equal(fs.existsSync(pidfile()), false, 'and it is cleared on the way past');
});
