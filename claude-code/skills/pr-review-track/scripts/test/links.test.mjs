// node --test scripts/test/links.test.mjs
//
// Permalinks are quotations. A link with the wrong SHA or the wrong range shows
// the author code they did not write, under a review that says they did — and
// it is checkable in one click, so it is the loudest possible mistake. These
// tests pin the two halves of not making it: the URL is built from an exact
// commit or not at all, and a caller with no exact commit still gets its plain
// `path:line` back instead of a link to the wrong lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { blobUrl, codeLink, parseLocation, locationLabel, isSha } from '../lib/links.mjs';
import { renderActionFile, renderNudgeFile } from '../lib/render.mjs';
import { THREAD_STATES } from '../lib/analyze.mjs';

const SHA = '39784e085ef491ffe319433dc465ba9575cadc95';
const JAVA = 'pulsar-client-v5/src/main/java/org/apache/pulsar/client/impl/v5/ScalableConsumerClient.java';

test('a location parses the way a reviewer types one', () => {
  assert.deepEqual(parseLocation(`${JAVA}:192-206`), { path: JAVA, line: 192, endLine: 206 });
  assert.deepEqual(parseLocation(`${JAVA}:192`), { path: JAVA, line: 192, endLine: null });
  assert.deepEqual(parseLocation(`${JAVA}#L192-L206`), { path: JAVA, line: 192, endLine: 206 });
  assert.deepEqual(parseLocation(JAVA), { path: JAVA, line: null, endLine: null });
  // A backwards range means the same lines to whoever typed it; GitHub renders
  // `#L206-L192` as nothing at all, so normalise rather than refuse.
  assert.deepEqual(parseLocation(`${JAVA}:206-192`), { path: JAVA, line: 192, endLine: 206 });
  assert.throws(() => parseLocation(`${JAVA}:0`), /start at 1/);
  assert.throws(() => parseLocation(''), /not a code location/);
});

test('the URL is exactly the one GitHub expands', () => {
  assert.equal(
    blobUrl('apache/pulsar', SHA, JAVA, { line: 192, endLine: 206 }),
    `https://github.com/apache/pulsar/blob/${SHA}/${JAVA}#L192-L206`,
  );
  assert.equal(blobUrl('apache/pulsar', SHA, JAVA, { line: 192 }), `https://github.com/apache/pulsar/blob/${SHA}/${JAVA}#L192`);
  // A one-line "range" is a line, not `#L192-L192`.
  assert.equal(blobUrl('apache/pulsar', SHA, JAVA, { line: 192, endLine: 192 }), `https://github.com/apache/pulsar/blob/${SHA}/${JAVA}#L192`);
  assert.equal(blobUrl('apache/pulsar', SHA, JAVA), `https://github.com/apache/pulsar/blob/${SHA}/${JAVA}`);
  assert.equal(blobUrl('apache/pulsar', SHA, `/${JAVA}`), `https://github.com/apache/pulsar/blob/${SHA}/${JAVA}`);
  assert.match(blobUrl('apache/pulsar', SHA, 'docs/a b.md'), /a%20b\.md$/);
});

test('a ref name never becomes a permalink', () => {
  // The whole point of the SHA: `blob/master/…` renders whatever master says on
  // the day someone reads the comment, which is not the code the review read.
  assert.throws(() => blobUrl('apache/pulsar', 'master', JAVA, { line: 192 }), /needs a commit SHA/);
  assert.throws(() => blobUrl('apache/pulsar', null, JAVA), /needs a commit SHA/);
  assert.throws(() => blobUrl('apache/pulsar', SHA, ''), /needs a file path/);
  assert.throws(() => blobUrl('pulsar', SHA, JAVA), /not an owner\/repo/);
  assert.equal(isSha(SHA), true);
  assert.equal(isSha('master'), false);
});

test('a link with no exact commit degrades to the reference it replaced', () => {
  // Load-bearing for every renderer call: a LEFT-side anchor, an outdated
  // thread and an analysis predating `headOid` all arrive here with no SHA, and
  // losing the whole draft over a link would be a far worse trade than losing
  // the link.
  assert.equal(codeLink('apache/pulsar', null, JAVA, { line: 192 }), '`ScalableConsumerClient.java:192`');
  assert.equal(codeLink('apache/pulsar', 'master', JAVA, { line: 192, full: true }), `\`${JAVA}:192\``);
  assert.equal(
    codeLink('apache/pulsar', SHA, JAVA, { line: 192, endLine: 206 }),
    `[\`ScalableConsumerClient.java:192-206\`](https://github.com/apache/pulsar/blob/${SHA}/${JAVA}#L192-L206)`,
  );
  assert.equal(locationLabel(JAVA, { line: 192, endLine: 206 }), 'ScalableConsumerClient.java:192-206');
  assert.equal(locationLabel(JAVA, { full: true }), JAVA);
});

// ------------------------------------------------------- inside the draft

const BASE_ANALYSIS = {
  number: 26289,
  title: 'a title',
  url: 'https://github.com/apache/pulsar/pull/26289',
  author: 'someone',
  authorAssociation: 'MEMBER',
  state: 'OPEN',
  merged: false,
  isDraft: false,
  headOid: SHA,
  baseRefName: 'master',
  updatedAt: new Date().toISOString(),
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  labels: [],
  reviewDecision: null,
  ci: 'SUCCESS',
  myLastReview: { state: 'COMMENTED', submittedAt: new Date().toISOString(), oid: 'f102ddfabb4f741eba60181d1b91f6ee91cbd5e4' },
  headMoved: true,
  newCommits: [],
  threads: [],
  threadCounts: {},
  nudge: {},
  newIssueComments: [],
  newReviewsByOthers: [],
  needsAttention: true,
};

const thread = (over = {}) => ({
  id: 'PRRT_1',
  path: JAVA,
  line: 192,
  startLine: null,
  side: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  resolvedBy: null,
  state: THREAD_STATES.UNTOUCHED,
  codeChanged: false,
  replyToCommentId: '1',
  lastCommentId: '1',
  myLastComment: null,
  daysSinceMyLastComment: 3,
  url: 'https://github.com/apache/pulsar/pull/26289#discussion_r1',
  lastComment: null,
  commentCount: 1,
  ...over,
});

const draft = (over = {}) => renderActionFile({
  repo: 'apache/pulsar',
  analysis: { ...BASE_ANALYSIS, ...over.analysis },
  delta: over.delta ?? null,
  findings: over.findings ?? null,
  kind: 're-review',
  reviewerLogin: 'me',
});

test('the draft links the code it points the reader at', () => {
  const text = draft({
    analysis: { threads: [thread()] },
    delta: { commits: [], diff: `diff --git a/${JAVA} b/${JAVA}\n--- a/${JAVA}\n+++ b/${JAVA}\n@@ -1 +1 @@\n-a\n+b\n` },
    findings: {
      findings: [
        { id: 'i1', severity: 'BUG', claim: 'permits are lost', path: JAVA, line: 200, endLine: 206, side: 'RIGHT', body: 'why' },
      ],
    },
  });
  // The thread's anchor, the finding's range, and the file the delta touched.
  assert.match(text, new RegExp(`\\[\`${JAVA.replace(/[/.]/g, '\\$&')}:192\`\\]\\(https://github.com/apache/pulsar/blob/${SHA}/`));
  assert.match(text, new RegExp(`blob/${SHA}/${JAVA.replace(/[/.]/g, '\\$&')}#L200-L206`));
  assert.match(text, new RegExp(`\\*\\*Files changed since my review\\*\\*[\\s\\S]*blob/${SHA}/${JAVA.replace(/[/.]/g, '\\$&')}\\)`));
});

test('an anchor the head does not describe keeps its plain reference', () => {
  // A LEFT-side line counts in the base, and GitHub nulls an outdated thread's
  // `line` so what analysis carried is the original. Linking either at the head
  // would quote code the comment was never about.
  const left = draft({
    analysis: { threads: [thread({ side: 'LEFT' })] },
    findings: { findings: [{ id: 'i1', claim: 'c', path: JAVA, line: 40, side: 'LEFT', body: 'b' }] },
  });
  assert.doesNotMatch(left, /blob\//);
  assert.match(left, new RegExp(`\`${JAVA.replace(/[/.]/g, '\\$&')}:192\``));

  const outdated = draft({ analysis: { threads: [thread({ isOutdated: true, state: THREAD_STATES.CODE_CHANGED })] } });
  assert.doesNotMatch(outdated, /blob\//);
});

test('a nudge links the points it is reminding the author about', () => {
  const text = renderNudgeFile({
    repo: 'apache/pulsar',
    analysis: {
      ...BASE_ANALYSIS,
      headMoved: false,
      nudge: { untouchedCount: 1, oldestUntouchedDays: 9, daysSinceMyLastWord: 9, threads: [{ id: 'x', path: JAVA, line: 192, side: 'RIGHT', url: 'u', days: 9 }] },
    },
    reviewerLogin: 'me',
  });
  assert.match(text, new RegExp(`blob/${SHA}/${JAVA.replace(/[/.]/g, '\\$&')}#L192`));
});

// ------------------------------------------------------------------- the CLI

const PRT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prt.mjs');

function storeWithHead(number, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-links-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ reviewer: 'me' }));
  const dir = path.join(root, 'apache', 'pulsar', `pr-${number}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ schema: 1, repo: 'apache/pulsar', number, ...state }));
  return root;
}

function permalink(root, args) {
  return spawnSync(process.execPath, [PRT, 'permalink', ...args, '--repo', 'apache/pulsar', '--root', root], { encoding: 'utf8' });
}

test('`prt permalink` builds the link from the tracked head, with no network', () => {
  const root = storeWithHead(26289, {
    headOid: SHA,
    analysis: { headOid: SHA, myLastReview: { oid: 'f102ddfabb4f741eba60181d1b91f6ee91cbd5e4' } },
  });
  try {
    const r = permalink(root, ['26289', `${JAVA}:192-206`]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `https://github.com/apache/pulsar/blob/${SHA}/${JAVA}#L192-L206`);

    // Bare on its own line is the form GitHub expands; `--markdown` is the form
    // for prose, where nothing expands.
    const md = permalink(root, ['26289', `${JAVA}:192`, '--markdown']);
    assert.match(md.stdout.trim(), /^\[`ScalableConsumerClient\.java:192`\]\(https:\/\//);

    const reviewed = permalink(root, ['26289', `${JAVA}:192`, '--sha', 'reviewed']);
    assert.match(reviewed.stdout.trim(), /blob\/f102ddfabb4f741eba60181d1b91f6ee91cbd5e4\//);

    const many = permalink(root, ['26289', `${JAVA}:192`, `${JAVA}:300-310`]);
    assert.equal(many.stdout.trim().split('\n').length, 2);

    const json = JSON.parse(permalink(root, ['26289', `${JAVA}:192-206`, '--json']).stdout);
    assert.equal(json.sha, SHA);
    assert.deepEqual(json.links[0].line, 192);
    assert.deepEqual(json.links[0].endLine, 206);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`prt permalink` refuses what would produce a wrong link', () => {
  const root = storeWithHead(26289, { headOid: SHA, analysis: { headOid: SHA } });
  try {
    const branch = permalink(root, ['26289', `${JAVA}:192`, '--sha', 'master']);
    assert.equal(branch.status, 1);
    assert.match(branch.stderr, /needs a commit/);

    const bare = permalink(root, ['26289', 'ScalableConsumerClient.java:192']);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /repo-relative path/);

    const noReview = permalink(root, ['26289', `${JAVA}:192`, '--sha', 'reviewed']);
    assert.equal(noReview.status, 1);
    assert.match(noReview.stderr, /no reviewed commit recorded/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // An untracked PR has no head to link against, and says so rather than
  // inventing one.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-links-'));
  try {
    const r = permalink(empty, ['999', `${JAVA}:1`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no head SHA/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
