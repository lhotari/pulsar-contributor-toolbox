// CI polling of dispatched workflow runs: a failed gh listing is not "no runs", and a later run of the same
// workflow never hides the result of the run that was seen first. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-ci-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const runs = path.join(tmp, 'runs.json');
// Fake gh: `run list` prints runs.json, or fails when it is missing (network error, rate limit).
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "run list" ] || exit 0\n[ -f ${runs} ] || exit 1\ncat ${runs}\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const gh = await import('../scripts/lib/gh.mjs');

const run = (id, name, status, conclusion, createdAt) => ({ databaseId: id, name, status, conclusion, url: `u${id}`, event: 'workflow_dispatch', headBranch: 'branch-4.2', createdAt });
const set = (list) => (list ? fs.writeFileSync(runs, JSON.stringify(list)) : fs.rmSync(runs, { force: true }));

test('a failed listing is unknown; the runs seen first stay tracked when the workflow runs again', () => {
  set(null);
  assert.equal(gh.commitChecks('abc', 'branch-4.2').state, 'unknown');
  set([run(1, 'Pulsar CI', 'in_progress', '', '2026-11-21T18:59:31Z'), run(2, 'Go', 'completed', 'success', '2026-11-21T18:59:35Z')]);
  const first = gh.commitChecks('abc', 'branch-4.2');
  assert.equal(first.state, 'pending');
  assert.deepEqual(first.tracked, { 'Pulsar CI': 1, Go: 2 });
  // Pulsar CI fails, and a second dispatch starts a newer Pulsar CI run: the tracked failure still counts.
  set([run(3, 'Pulsar CI', 'in_progress', '', '2026-11-21T19:59:53Z'), run(1, 'Pulsar CI', 'completed', 'failure', '2026-11-21T18:59:31Z'), run(2, 'Go', 'completed', 'success', '2026-11-21T18:59:35Z')]);
  const later = gh.commitChecks('abc', 'branch-4.2', { tracked: first.tracked });
  assert.equal(later.state, 'failure');
  assert.deepEqual(later.runs.sort(), [1, 2]);
  assert.deepEqual(gh.failedRunIds('abc', 'branch-4.2', { tracked: first.tracked }), [1]);
  // Untracked, the newest run per workflow counts.
  assert.equal(gh.commitChecks('abc', 'branch-4.2').state, 'pending');
  // A listing that misses a tracked run is incomplete, not a result.
  set([run(3, 'Pulsar CI', 'in_progress', '', '2026-11-21T19:59:53Z')]);
  assert.equal(gh.commitChecks('abc', 'branch-4.2', { tracked: first.tracked }).state, 'unknown');
});
