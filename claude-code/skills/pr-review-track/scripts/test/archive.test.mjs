// node --test scripts/test/archive.test.mjs
//
// Setting a review aside and getting it back, through the real CLI against a
// temp store.
//
// `archive` is the only command that moves a directory the human has been
// editing, and `unarchive` is the only one that moves it back, so what these
// tests pin is the pair of promises around that move: nothing armed or in
// flight is taken, nothing already tracked is overwritten, and what comes back
// is what left — draft, notes and cache. The `latest` test is the point of the
// feature rather than a detail of it: an archived PR that gets ranked back onto
// the board tomorrow was never really ignored.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRT = path.resolve(HERE, '../prt.mjs');
const FAKE_GH = path.join(HERE, 'helpers/fake-gh.mjs');
const REPO = 'o/r';

let ROOT;
let BIN;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-archive-'));
  // A cached reviewer keeps `context()` off `gh api user`.
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ reviewer: 'me' }));
  BIN = path.join(ROOT, 'bin');
  fs.mkdirSync(BIN, { recursive: true });
  const shim = path.join(BIN, 'gh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const liveDir = (n) => path.join(ROOT, 'o', 'r', `pr-${n}`);
const archivedDir = (n) => path.join(ROOT, '_archive', 'o', 'r', `pr-${n}`);

/** A tracked PR with a half-written review and something in its cache. */
function trackPr(number, { status = 'draft', state = 'OPEN', author = 'someone' } = {}) {
  const dir = liveDir(number);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pr.json'),
    JSON.stringify({
      schema: 1,
      repo: REPO,
      number,
      title: `pr ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      author,
      state,
      analysis: { number, author, threadCounts: {}, threads: [], ci: 'SUCCESS' },
    }),
  );
  if (status) fs.writeFileSync(path.join(dir, 'review.md'), `Status: ${status}\n\n# ${number}\n`);
  fs.writeFileSync(path.join(dir, 'cache', 'findings.json'), '{"findings":[]}');
  return dir;
}

function run(args, { json = true, env = {} } = {}) {
  const r = spawnSync(
    process.execPath,
    [PRT, ...args, '--repo', REPO, '--root', ROOT, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...env } },
  );
  return { ...r, json: json && r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

test('archive moves the whole directory out of the live tree and says why', () => {
  trackPr(42);
  const r = run(['archive', '42', '--reason', 'not mine to review']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.archived.map((a) => a.number), [42]);

  assert.equal(fs.existsSync(liveDir(42)), false, 'the live directory must be gone');
  assert.ok(fs.existsSync(path.join(archivedDir(42), 'review.md')));
  const marker = fs.readFileSync(path.join(archivedDir(42), 'ARCHIVED.txt'), 'utf8');
  assert.match(marker, /OPEN · archived .* · by hand · not mine to review/);
});

test('the board drops it and reports the archive rather than listing it', () => {
  const { content } = run(['board']).json;
  assert.doesNotMatch(content, /#42/, 'an archived PR is not live work');
  assert.match(content, /1 archived PR\(s\) not shown/);
  assert.match(content, /prt unarchive <N>/);
});

test('archive --list is how you find something to bring back', () => {
  const rows = run(['archive', '--list']).json.archived;
  assert.deepEqual(rows.map((r) => r.number), [42]);
  assert.equal(rows[0].title, 'pr 42');
  assert.match(rows[0].marker, /not mine to review/);

  // Bare `prt archive` lists too — it used to be an alias for `cleanup`, and
  // reading the archive is the safe thing for that name to do bare.
  assert.deepEqual(run(['archive']).json.archived.map((r) => r.number), [42]);
});

test('unarchive brings back the draft and the cache, and clears the marker', () => {
  const r = run(['unarchive', '42']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.restored.map((x) => x.number), [42]);

  assert.equal(fs.readFileSync(path.join(liveDir(42), 'review.md'), 'utf8'), 'Status: draft\n\n# 42\n');
  assert.ok(fs.existsSync(path.join(liveDir(42), 'cache', 'findings.json')), 'the cache comes back too');
  assert.equal(fs.existsSync(path.join(archivedDir(42), 'ARCHIVED.txt')), false);
  assert.equal(fs.existsSync(archivedDir(42)), false);
  assert.match(run(['board']).json.content, /#42/, 'it is live work again');
});

test('a review the human armed is refused, not filed away', () => {
  trackPr(50, { status: 'ready' });
  const r = run(['archive', '50']);
  assert.notEqual(r.status, 0, 'refusing must be visible in the exit code');
  assert.equal(r.json.archived.length, 0);
  assert.match(r.json.refused[0].why, /never posted/);
  assert.ok(fs.existsSync(liveDir(50)), 'the directory stays exactly where it was');
});

test('a review with a transaction open is refused', () => {
  trackPr(51, { status: 'queued' });
  const r = run(['archive', '51']);
  assert.notEqual(r.status, 0);
  assert.match(r.json.refused[0].why, /transaction is still open/);
  assert.ok(fs.existsSync(liveDir(51)));
});

test('archiving what is not tracked, or is already archived, is refused by name', () => {
  assert.match(run(['archive', '999']).json.refused[0].why, /not tracked/);
  trackPr(52);
  run(['archive', '52']);
  assert.match(run(['archive', '52']).json.refused[0].why, /already archived/);
});

test('unarchive never overwrites a PR that is tracked again', () => {
  // #52 is in the archive; start tracking it afresh, as `track` would.
  trackPr(52, { status: 'draft' });
  const r = run(['unarchive', '52']);
  assert.notEqual(r.status, 0);
  assert.match(r.json.refused[0].why, /tracked again already/);
  assert.ok(fs.existsSync(path.join(archivedDir(52), 'pr.json')), 'the archived copy is left intact');
});

test('unarchiving something that was never archived fails loudly', () => {
  const r = run(['unarchive', '404']);
  assert.notEqual(r.status, 0);
  assert.match(r.json.refused[0].why, /not in the archive/);
});

test('latest does not offer a PR that was archived', () => {
  // #60 archived, #61 not: the ranking must show exactly one of them.
  trackPr(60);
  trackPr(61);
  run(['archive', '60']);
  fs.rmSync(liveDir(61), { recursive: true, force: true }); // untracked, so `latest` may offer it

  const pr = (number) => ({
    id: `x${number}`,
    number,
    title: `pr ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    merged: false,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    additions: 10,
    deletions: 1,
    changedFiles: 2,
    headRefOid: 'abc',
    baseRefName: 'master',
    authorAssociation: 'CONTRIBUTOR',
    author: { login: 'someone' },
    labels: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviews: { nodes: [] },
    comments: { totalCount: 0 },
  });
  const scenario = path.join(ROOT, 'latest.json');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      rules: [
        {
          when: { arg: 'sort:updated-desc' },
          stdout: JSON.stringify({
            data: { search: { pageInfo: { hasNextPage: false }, nodes: [pr(60), pr(61)] } },
          }),
        },
        // The three "have I already engaged with this" searches: nothing.
        {
          when: { arg: 'search' },
          stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }),
        },
      ],
    }),
  );

  const r = run(['latest'], { env: { PRT_FAKE_GH: scenario } });
  assert.equal(r.status, 0, r.stderr);
  const offered = r.json.rows.map((row) => row.number);
  assert.deepEqual(offered, [61], 'the archived PR must not come back as a suggestion');
});
