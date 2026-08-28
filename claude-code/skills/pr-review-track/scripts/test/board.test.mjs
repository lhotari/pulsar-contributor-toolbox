// node --test scripts/test/board.test.mjs
//
// The board through the real CLI, against a temp store. No network: `--repo`
// short-circuits repo resolution and a config.json supplies the reviewer, so
// `board` never reaches for `gh`.
//
// prt.test.mjs pins how `renderBoard` formats a link. Only this pins that the
// link RESOLVES — the path arithmetic in `writeBoard` that turns a store layout
// into `pr-<N>/review.md`. A pure test cannot reach it: hand-feeding
// `reviewPath` as a string is exactly the half that cannot be wrong.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRT = path.resolve(HERE, '../prt.mjs');
const REPO = 'o/r';

let ROOT;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-board-'));
  // A cached reviewer keeps `context()` off `gh api user`.
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ reviewer: 'me' }));
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A tracked PR in the store. `status: null` means no review.md was ever written. */
function trackPr(number, { status = 'draft', state = 'OPEN' } = {}) {
  const dir = path.join(ROOT, 'o', 'r', `pr-${number}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pr.json'),
    JSON.stringify({
      schema: 1,
      repo: REPO,
      number,
      title: `pr ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      author: 'someone',
      state,
      updatedAt: new Date().toISOString(),
      analysis: { number, author: 'someone', threadCounts: {}, threads: [], ci: 'SUCCESS' },
    }),
  );
  if (status) fs.writeFileSync(path.join(dir, 'review.md'), `Status: ${status}\n\n# ${number}\n`);
  return dir;
}

function board() {
  const r = spawnSync(process.execPath, [PRT, 'board', '--repo', REPO, '--root', ROOT, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `prt board failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('every review.md link on the board resolves to a file that exists', () => {
  trackPr(42, { status: 'draft' });
  trackPr(43, { status: 'submitted' });
  trackPr(44, { status: null });

  const { file, content } = board();
  assert.equal(file, path.join(ROOT, 'o', 'r', 'BOARD.md'));

  const hrefs = [...content.matchAll(/\]\(([^)]*review\.md)\)/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0, 'the draft on #42 must be linked');
  for (const href of hrefs) {
    // Absolute would still "resolve" below, and most markdown viewers refuse
    // it — so relativeness is asserted on its own, not inferred from existence.
    assert.equal(path.isAbsolute(href), false, `${href} must be relative to the board`);
    assert.ok(
      fs.existsSync(path.resolve(path.dirname(file), href)),
      `${href} does not resolve to a file next to BOARD.md`,
    );
  }
  assert.deepEqual([...new Set(hrefs)], ['pr-42/review.md']);
});

test('the in-progress section names only the reviews that are unfinished', () => {
  const { content } = board();
  const section = content.slice(
    content.indexOf('## reviews in progress'),
    content.indexOf('## waiting-for-author'),
  );
  assert.match(section, /\(1\)/);
  assert.match(section, /#42/);
  assert.doesNotMatch(section, /#43/, 'submitted is finished');
  assert.doesNotMatch(section, /#44/, 'no review.md means no review was started');

  // ...and the bucket table below carries the same link on its status cell.
  assert.match(content, /\| \[`draft`\]\(pr-42\/review\.md\) \|/);
  assert.match(content, /\| `submitted` \|/);
  assert.match(content, /\| `none` \|/);
});

test('a board with nothing half-finished has no section and no links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-board-clean-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ reviewer: 'me' }));
    const dir = path.join(root, 'o', 'r', 'pr-7');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pr.json'),
      JSON.stringify({ number: 7, title: 't', state: 'OPEN', analysis: { threadCounts: {}, threads: [] } }),
    );
    const r = spawnSync(process.execPath, [PRT, 'board', '--repo', REPO, '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const { content } = JSON.parse(r.stdout);
    assert.doesNotMatch(content, /reviews in progress/);
    assert.doesNotMatch(content, /review\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
