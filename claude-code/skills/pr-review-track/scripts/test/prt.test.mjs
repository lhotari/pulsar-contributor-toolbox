// node --test scripts/test/prt.test.mjs
//
// Everything here is pure: no network, no filesystem outside a temp dir. The
// GitHub writer is covered by `prt submit --dry-run`, which exercises capture
// and preflight against live data without posting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseActionFile, planActions, parseStatus, setStatus, contentHash, payloadHash,
  appendLog, tokenize, PROTECTED_STATUSES,
} from '../lib/actionfile.mjs';
import { parseDiff, commentableAnchors, validateAnchor, touchesAnchor } from '../lib/diff.mjs';
import { renderActionFile, bucketOf } from '../lib/render.mjs';
import { scorePr, rankCandidates } from '../lib/rank.mjs';
import { securityLint, diffFingerprint } from '../lib/submit.mjs';
import { analyzePr, recommendEvent, THREAD_STATES } from '../lib/analyze.mjs';

// --------------------------------------------------------------- action file

const MINIMAL = `Status: draft

<!-- prt:doc
repo: apache/pulsar
pr: 1
head: abc123
-->

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Summary text.
<!-- /prt -->
`;

test('status is read from and written to line 1', () => {
  assert.equal(parseStatus(MINIMAL), 'draft');
  assert.equal(parseStatus(setStatus(MINIMAL, 'ready')).valueOf(), 'ready');
  assert.equal(setStatus(MINIMAL, 'ready').split('\n')[0], 'Status: ready');
  // A file with no status line gets one prepended rather than losing content.
  assert.equal(setStatus('# hi', 'draft').split('\n')[0], 'Status: draft');
  assert.equal(setStatus('# hi', 'draft').includes('# hi'), true);
});

test('a body is preserved byte for byte, including markdown that looks structural', () => {
  const body = [
    '## This is a heading inside the body',
    '',
    '---',
    '',
    'Some `code` and a fence:',
    '',
    '```java',
    'if (x) { return; }   // ### not a heading',
    '```',
    '',
    '<!-- an ordinary html comment -->',
    '',
    ' <!-- /prt --> (indented, so it stays text)',
  ].join('\n');
  const file = `Status: draft\n\n<!-- prt:body -->\n${body}\n<!-- /prt -->\n`;
  const p = parseActionFile(file);
  assert.equal(p.errors.length, 0, p.errors.join('; '));
  assert.equal(p.body, body);
});

test('a column-0 terminator inside a fence truncates the block and is warned about', () => {
  const file = [
    'Status: draft',
    '',
    '<!-- prt:body -->',
    'before',
    '```',
    '<!-- /prt -->',
    'after',
    '```',
    '<!-- /prt -->',
  ].join('\n');
  const p = parseActionFile(file);
  assert.equal(p.body, 'before\n```');
  assert.match(p.warnings.join(' '), /unbalanced/);
});

test('inline comments parse their machine fields and default sensibly', () => {
  const file = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:inline
id: i1
path: a/B.java
line: 10
-->
body one
<!-- /prt -->

<!-- prt:inline
id: i2
post: false
path: a/B.java
line: 20
side: LEFT
-->
body two
<!-- /prt -->

<!-- prt:inline
id: i3
subject: range
path: a/B.java
start-line: 30
line: 34
-->
body three
<!-- /prt -->
`;
  const p = parseActionFile(file);
  assert.deepEqual(p.errors, []);
  assert.equal(p.inline.length, 3);
  assert.equal(p.inline[0].side, 'RIGHT');
  assert.equal(p.inline[0].subject, 'line');
  assert.equal(p.inline[0].onAnchorFail, 'block', 'blocking must be the default');
  assert.equal(p.inline[1].post, false);
  assert.equal(p.inline[1].side, 'LEFT');
  assert.equal(p.inline[2].subject, 'range');
  assert.equal(p.inline[2].startLine, 30);
  assert.equal(p.inline[2].line, 34);
  // post:false blocks are not actions.
  const actions = planActions(p);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].comments.length, 2);
});

test('structural mistakes are errors, not silent data loss', () => {
  const missingTerminator = `Status: draft\n\n<!-- prt:inline\nid: i1\npath: a\nline: 1\n-->\nbody\n`;
  assert.match(parseActionFile(missingTerminator).errors.join(' '), /terminator/);

  const dupIds = `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:inline
id: i1
post: false
path: a
line: 1
-->
x
<!-- /prt -->
<!-- prt:inline
id: i1
post: false
path: a
line: 2
-->
y
<!-- /prt -->
`;
  assert.match(parseActionFile(dupIds).errors.join(' '), /duplicate id/);

  const badEvent = `Status: draft\n<!-- prt:verdict\nevent: LGTM\n-->\n`;
  assert.match(parseActionFile(badEvent).errors.join(' '), /event must be/);

  const noStatus = `# no gate here\n`;
  assert.match(parseActionFile(noStatus).errors.join(' '), /line 1/);
});

test('event NONE means replies only', () => {
  const withBody = `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:body -->
text
<!-- /prt -->
`;
  assert.match(parseActionFile(withBody).errors.join(' '), /event is NONE/);

  const repliesOnly = `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:thread
id: t1
thread: PRRT_x
reply-to: 123
-->
a reply
<!-- /prt -->
`;
  const p = parseActionFile(repliesOnly);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(planActions(p).map((a) => a.kind), ['thread-reply']);
});

test('an empty COMMENT review is rejected rather than posted as an empty review', () => {
  const empty = `Status: draft\n<!-- prt:verdict\nevent: COMMENT\n-->\n`;
  assert.match(parseActionFile(empty).errors.join(' '), /no review body and no inline comments/);
});

test('a reply with a body needs the REST comment id to reply to', () => {
  const f = `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:thread
id: t1
thread: PRRT_x
-->
reply text
<!-- /prt -->
`;
  assert.match(parseActionFile(f).errors.join(' '), /reply-to/);
});

test('resolve without a reply is a valid, single action', () => {
  const f = `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:thread
id: t1
thread: PRRT_x
resolve: yes
-->
<!-- /prt -->
`;
  const p = parseActionFile(f);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(planActions(p).map((a) => a.kind), ['thread-resolve']);
});

test('content hash ignores the status line and the activity log', () => {
  const a = MINIMAL;
  const b = setStatus(MINIMAL, 'ready');
  const c = appendLog(MINIMAL, 'posted something');
  assert.equal(contentHash(a), contentHash(b));
  assert.equal(contentHash(a), contentHash(c));
  const d = MINIMAL.replace('Summary text.', 'Different text.');
  assert.notEqual(contentHash(a), contentHash(d));
});

test('payload hash changes when anything postable changes', () => {
  const base = parseActionFile(MINIMAL);
  const changed = parseActionFile(MINIMAL.replace('Summary text.', 'Other.'));
  assert.notEqual(payloadHash(base), payloadHash(changed));
  // A change outside a block must NOT change the payload.
  const cosmetic = parseActionFile(MINIMAL.replace('Status: draft', 'Status: draft') + '\n\nfree prose\n');
  assert.equal(payloadHash(base), payloadHash(cosmetic));
});

test('appendLog is idempotent in structure and keeps the terminator last', () => {
  let t = appendLog(MINIMAL, 'first');
  t = appendLog(t, 'second');
  const logs = (t.match(/^<!-- prt:log -->$/gm) ?? []).length;
  assert.equal(logs, 1);
  const p = parseActionFile(t);
  assert.deepEqual(p.errors, []);
  assert.match(p.log.join('\n'), /first/);
  assert.match(p.log.join('\n'), /second/);
});

test('unknown blocks warn but never post', () => {
  const f = `${MINIMAL}\n<!-- prt:mystery -->\nstuff\n<!-- /prt -->\n`;
  const p = parseActionFile(f);
  assert.match(p.warnings.join(' '), /mystery/);
  assert.deepEqual(planActions(p).map((a) => a.kind), ['review']);
});

test('protected statuses are the ones a generator must not clobber', () => {
  for (const s of ['ready', 'queued', 'partial', 'submitted', 'hold', 'skip']) {
    assert.equal(PROTECTED_STATUSES.has(s), true, s);
  }
  assert.equal(PROTECTED_STATUSES.has('draft'), false);
});

// ---------------------------------------------------------------------- diff

const DIFF = `diff --git a/src/Modified.java b/src/Modified.java
index 111..222 100644
--- a/src/Modified.java
+++ b/src/Modified.java
@@ -10,6 +10,7 @@ class Modified {
 context10
-removed11
+added11
+added12
 context12
 context13
 context14
diff --git a/src/Added.java b/src/Added.java
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/Added.java
@@ -0,0 +1,3 @@
+one
+two
+three
diff --git a/src/Gone.java b/src/Gone.java
deleted file mode 100644
index 444..000
--- a/src/Gone.java
+++ /dev/null
@@ -1,2 +0,0 @@
-bye1
-bye2
diff --git a/img/logo.png b/img/logo.png
index 555..666 100644
Binary files a/img/logo.png and b/img/logo.png differ
diff --git a/src/Old.java b/src/New.java
similarity index 95%
rename from src/Old.java
rename to src/New.java
index 777..888 100644
--- a/src/Old.java
+++ b/src/New.java
@@ -5,3 +5,3 @@ class X {
 keep5
-old6
+new6
`;

test('parseDiff classifies added, deleted, renamed, and binary files', () => {
  const files = parseDiff(DIFF);
  assert.equal(files.get('src/Modified.java').status, 'modified');
  assert.equal(files.get('src/Added.java').status, 'added');
  assert.equal(files.get('src/Gone.java').status, 'deleted');
  assert.equal(files.get('img/logo.png').binary, true);
  assert.equal(files.get('src/New.java').status, 'renamed');
  assert.equal(files.get('src/New.java').oldPath, 'src/Old.java');
});

test('commentable anchors follow GitHub rules for each side', () => {
  const a = commentableAnchors(parseDiff(DIFF));

  const mod = a.get('src/Modified.java');
  // hunk: @@ -10,6 +10,7 @@ -> context10 is old10/new10, removed11 is old11,
  // added11/added12 are new11/new12, then three context lines.
  assert.deepEqual([...mod.right].sort((x, y) => x - y), [10, 11, 12, 13, 14, 15]);
  assert.deepEqual([...mod.left].sort((x, y) => x - y), [10, 11, 12, 13, 14]);

  const added = a.get('src/Added.java');
  assert.deepEqual([...added.right].sort((x, y) => x - y), [1, 2, 3]);
  assert.equal(added.left.size, 0, 'a new file has no LEFT side');

  const gone = a.get('src/Gone.java');
  assert.equal(gone.right.size, 0, 'a deleted file has no RIGHT side');
  assert.deepEqual([...gone.left].sort((x, y) => x - y), [1, 2]);

  assert.equal(a.get('img/logo.png').binary, true);
  // A rename is addressable by either name.
  assert.ok(a.get('src/Old.java'));
  assert.equal(a.get('src/Old.java'), a.get('src/New.java'));
});

test('validateAnchor refuses out-of-diff targets and offers the nearest line', () => {
  const a = commentableAnchors(parseDiff(DIFF));

  assert.equal(validateAnchor(a, { file: 'src/Modified.java', line: 11, side: 'RIGHT' }).ok, true);
  assert.equal(validateAnchor(a, { file: 'src/Modified.java', line: 10, side: 'LEFT' }).ok, true);

  const far = validateAnchor(a, { file: 'src/Modified.java', line: 900, side: 'RIGHT' });
  assert.equal(far.ok, false);
  assert.equal(far.nearest, 15);

  const noFile = validateAnchor(a, { file: 'nope.java', line: 1 });
  assert.equal(noFile.ok, false);
  assert.match(noFile.reason, /not part of this diff/);

  const binary = validateAnchor(a, { file: 'img/logo.png', line: 1 });
  assert.equal(binary.ok, false);
  assert.match(binary.reason, /binary/);

  const wrongSide = validateAnchor(a, { file: 'src/Added.java', line: 1, side: 'LEFT' });
  assert.equal(wrongSide.ok, false);

  // A range needs BOTH ends inside the diff.
  assert.equal(validateAnchor(a, { file: 'src/Modified.java', line: 11, endLine: 13, side: 'RIGHT' }).ok, true);
  assert.equal(validateAnchor(a, { file: 'src/Modified.java', line: 5, endLine: 13, side: 'RIGHT' }).ok, false);
});

test('touchesAnchor detects whether new commits reached a thread anchor', () => {
  const files = parseDiff(DIFF);
  assert.equal(touchesAnchor(files, 'src/Modified.java', 12), true);
  assert.equal(touchesAnchor(files, 'src/Modified.java', 500), false);
  assert.equal(touchesAnchor(files, 'untouched/File.java', 1), false);
  assert.equal(touchesAnchor(files, 'src/Modified.java', null), true, 'null line means "file changed at all"');
});

test('diffFingerprint is stable for the same diff and moves when hunks move', () => {
  assert.equal(diffFingerprint(DIFF), diffFingerprint(DIFF));
  const shifted = DIFF.replace('@@ -10,6 +10,7 @@', '@@ -20,6 +20,7 @@');
  assert.notEqual(diffFingerprint(DIFF), diffFingerprint(shifted));
});

// -------------------------------------------------------------------- render

function fixtureAnalysis(over = {}) {
  return {
    number: 42,
    title: 'a title with a | pipe',
    url: 'https://example.invalid/42',
    author: 'someone',
    authorAssociation: 'CONTRIBUTOR',
    state: 'OPEN',
    isDraft: false,
    headOid: 'a'.repeat(40),
    baseRefName: 'master',
    updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    labels: [],
    reviewDecision: 'REVIEW_REQUIRED',
    ci: 'SUCCESS',
    myLastReview: { state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString(), oid: 'b'.repeat(40) },
    myLastSubstantiveState: 'CHANGES_REQUESTED',
    headMoved: true,
    newCommits: [],
    threads: [],
    threadCounts: {},
    newIssueComments: [],
    newReviewsByOthers: [],
    needsAttention: true,
    ...over,
  };
}

test('a generated file parses cleanly and plans exactly what it shows', () => {
  const analysis = fixtureAnalysis({
    threads: [{
      id: 'PRRT_1',
      path: 'src/Modified.java',
      line: 11,
      side: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      resolvedBy: null,
      state: THREAD_STATES.AWAITING_MY_REPLY,
      codeChanged: true,
      replyToCommentId: 999,
      myLastComment: { body: 'my point', createdAt: '2026-01-01T00:00:00Z' },
      lastComment: { author: 'someone', body: 'fixed it', createdAt: '2026-01-02T00:00:00Z' },
      commentCount: 2,
    }],
    threadCounts: { [THREAD_STATES.AWAITING_MY_REPLY]: 1 },
  });
  const findings = {
    summary: 'Looks better.\n\n## Detail\n\nStill one thing.',
    recommendedEvent: 'COMMENT',
    findings: [{
      id: 'i1', severity: 'BUG', claim: 'off by one',
      path: 'src/Modified.java', line: 11, side: 'RIGHT',
      body: 'Concretely: with n=0 this underflows.\n\n```java\nint x = -1;\n```',
    }],
    threadAssessments: [{ threadId: 'PRRT_1', assessment: 'LIKELY_ADDRESSED', evidence: ['commit abc'], reply: 'Thanks, confirmed.', resolve: true }],
    dropped: [{ claim: 'x', reason: 'refuted' }],
  };

  const text = renderActionFile({
    repo: 'apache/pulsar',
    analysis,
    delta: { commits: [{ oid: 'c'.repeat(40), message: 'fix', author: 'someone' }], diff: DIFF },
    findings,
    kind: 're-review',
    generation: 2,
    diffFingerprint: diffFingerprint(DIFF),
    reviewerLogin: 'lhotari',
  });

  assert.equal(text.split('\n')[0], 'Status: draft');
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, [], p.errors.join('; '));
  assert.deepEqual(p.warnings, [], p.warnings.join('; '));

  assert.equal(p.doc.pr, '42');
  assert.equal(p.doc.head, 'a'.repeat(40));
  assert.equal(p.doc.generation, '2');
  assert.equal(p.event, 'COMMENT');
  assert.match(p.body, /Looks better/);
  assert.match(p.body, /## Detail/, 'a heading inside the summary survives');

  assert.equal(p.inline.length, 1);
  assert.equal(p.inline[0].path, 'src/Modified.java');
  assert.equal(p.inline[0].line, 11);
  assert.match(p.inline[0].body, /off by one/);
  assert.match(p.inline[0].body, /```java/, 'a fenced block inside a comment survives');

  assert.equal(p.threads.length, 1);
  assert.equal(p.threads[0].threadNodeId, 'PRRT_1');
  assert.equal(p.threads[0].replyToCommentId, '999');
  assert.equal(p.threads[0].resolve, true);
  assert.equal(p.threads[0].post, true);

  const kinds = planActions(p).map((a) => a.kind);
  assert.deepEqual(kinds, ['review', 'thread-reply', 'thread-resolve']);
});

test('a generated file with no findings still parses and posts nothing accidentally', () => {
  const text = renderActionFile({
    repo: 'apache/pulsar',
    analysis: fixtureAnalysis({ headMoved: false, myLastReview: null }),
    delta: { commits: [], diff: null },
    findings: null,
    kind: 'initial',
    reviewerLogin: 'lhotari',
  });
  const p = parseActionFile(text);
  // No body and no comments under COMMENT is an error by design — it tells the
  // human the file is not ready rather than creating an empty GitHub review.
  assert.equal(p.inline.filter((c) => c.post).length, 0, 'the inline template must not parse as a live comment');
  assert.equal(p.threads.filter((t) => t.post).length, 0);
});

test('APPROVE is never written into a generated file', () => {
  const analysis = fixtureAnalysis({
    threads: [{ id: 'T', path: 'a', line: 1, state: THREAD_STATES.CODE_CHANGED, isResolved: false, isOutdated: true, commentCount: 1 }],
    threadCounts: { [THREAD_STATES.CODE_CHANGED]: 1 },
  });
  assert.equal(recommendEvent(analysis).event, 'APPROVE', 'the recommendation itself may be APPROVE');
  const text = renderActionFile({
    repo: 'r/r', analysis, delta: { commits: [], diff: null }, findings: null,
    kind: 're-review', reviewerLogin: 'me', requireExplicitApprove: true,
  });
  assert.equal(parseActionFile(text).event, 'COMMENT');
  assert.match(text, /Recommended: \*\*APPROVE\*\*/);
  assert.match(text, /approve-authorised: yes/);
});

test('board buckets put an author waiting on me above everything else', () => {
  const waiting = { analysis: fixtureAnalysis({ threadCounts: { [THREAD_STATES.AWAITING_MY_REPLY]: 1 } }), status: 'none' };
  assert.equal(bucketOf(waiting), 'author-replied-to-me');

  const resolvedNoChange = { analysis: fixtureAnalysis({ threadCounts: { [THREAD_STATES.RESOLVED_WITHOUT_CHANGE]: 1 } }), status: 'none' };
  assert.equal(bucketOf(resolvedNoChange), 'resolved-without-change');

  const ancient = {
    analysis: fixtureAnalysis({
      threadCounts: { [THREAD_STATES.AWAITING_MY_REPLY]: 1 },
      updatedAt: new Date(Date.now() - 400 * 86400000).toISOString(),
    }),
    status: 'none',
  };
  assert.equal(bucketOf(ancient), 'stale', 'a four-year-old PR is not really waiting on me');

  assert.equal(bucketOf({ analysis: fixtureAnalysis(), status: 'ready' }), 'my-queue');
  assert.equal(bucketOf({ analysis: fixtureAnalysis(), status: 'blocked' }), 'my-queue');
  assert.equal(bucketOf({ analysis: fixtureAnalysis(), status: 'hold' }), 'parked');
});

// ------------------------------------------------------------------- ranking

function candidate(over = {}) {
  return {
    number: 1,
    title: '[fix][broker] something',
    author: { login: 'someone' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    additions: 20,
    deletions: 5,
    reviews: { nodes: [] },
    labels: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...over,
  };
}

test('merlimat outranks everything, including a perfect PR by someone else', () => {
  const perfect = candidate({ number: 2, authorAssociation: 'MEMBER', additions: 3, deletions: 0 });
  const merlimatWorst = candidate({
    number: 3,
    author: { login: 'merlimat' },
    authorAssociation: 'MEMBER',
    additions: 5000,
    deletions: 5000,
    updatedAt: new Date(Date.now() - 90 * 86400000).toISOString(),
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  });
  const ranked = rankCandidates([perfect, merlimatWorst], { login: 'me', priorityAuthors: ['merlimat'] });
  assert.equal(ranked[0].pr.number, 3);
  assert.match(ranked[0].reasons.join(' '), /merlimat/);
});

test('ranking explains itself and penalises drafts and red CI', () => {
  const { score, reasons } = scorePr(candidate({ isDraft: true }), { login: 'me' });
  assert.match(reasons.join(' '), /draft PR/);
  const green = scorePr(candidate(), { login: 'me' }).score;
  assert.ok(score < green);

  const red = scorePr(candidate({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }), { login: 'me' });
  assert.ok(red.score < green);
  assert.match(red.reasons.join(' '), /CI is red/);
});

test('an explicit review request beats ordinary membership', () => {
  const member = candidate({ number: 5, authorAssociation: 'MEMBER' });
  const requested = candidate({ number: 6, authorAssociation: 'NONE' });
  const ranked = rankCandidates([member, requested], { login: 'me', reviewRequested: new Set([6]) });
  assert.equal(ranked[0].pr.number, 6);
});

// ------------------------------------------------------------------ analysis

function prFixture(over = {}) {
  return {
    number: 1,
    title: 't',
    url: 'u',
    author: { login: 'author' },
    authorAssociation: 'CONTRIBUTOR',
    state: 'OPEN',
    merged: false,
    isDraft: false,
    headRefOid: 'head'.padEnd(40, '0'),
    baseRefName: 'master',
    updatedAt: new Date().toISOString(),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    labels: { nodes: [] },
    reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...over,
  };
}

function thread(over = {}) {
  return {
    id: 'PRRT_1',
    isResolved: false,
    isOutdated: false,
    path: 'src/Modified.java',
    line: 11,
    diffSide: 'RIGHT',
    resolvedBy: null,
    comments: { nodes: [{ databaseId: 1, author: { login: 'me' }, body: 'my point', createdAt: '2026-01-01T00:00:00Z' }] },
    ...over,
  };
}

test('a thread the author replied to is the top attention state', () => {
  const pr = prFixture({
    reviewThreads: { nodes: [thread({
      comments: { nodes: [
        { databaseId: 1, author: { login: 'me' }, body: 'my point', createdAt: '2026-01-01T00:00:00Z' },
        { databaseId: 2, author: { login: 'author' }, body: 'fixed', createdAt: '2026-01-02T00:00:00Z' },
      ] },
    })] },
  });
  const a = analyzePr(pr, 'me');
  assert.equal(a.threads[0].state, THREAD_STATES.AWAITING_MY_REPLY);
  // Comment ids are kept as decimal STRINGS: GitHub's are large and must never
  // pass through anything lossier than an exact integer.
  assert.equal(a.threads[0].replyToCommentId, '1', 'replies go to the FIRST comment of the thread');
  assert.equal(a.threads[0].lastCommentId, '2', 'the newest comment is armed as a precondition');
});

test('fullDatabaseId is preferred over the deprecated databaseId', () => {
  const pr = prFixture({
    reviewThreads: { nodes: [thread({
      comments: { nodes: [{ databaseId: 1, fullDatabaseId: '9007199254740993', author: { login: 'me' }, body: 'x', createdAt: '2026-01-01T00:00:00Z' }] },
    })] },
  });
  assert.equal(analyzePr(pr, 'me').threads[0].replyToCommentId, '9007199254740993');
});

test('resolved with no code change behind it is flagged, not trusted', () => {
  const pr = prFixture({ reviewThreads: { nodes: [thread({ isResolved: true, resolvedBy: { login: 'author' } })] } });
  // An empty delta diff means: new commits exist but none touched this anchor.
  const a = analyzePr(pr, 'me', { deltaDiff: 'diff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-x\n+y\n' });
  assert.equal(a.threads[0].state, THREAD_STATES.RESOLVED_WITHOUT_CHANGE);
});

test('resolved WITH a code change is a different, calmer state', () => {
  const pr = prFixture({ reviewThreads: { nodes: [thread({ isResolved: true, resolvedBy: { login: 'author' } })] } });
  const a = analyzePr(pr, 'me', { deltaDiff: DIFF });
  assert.equal(a.threads[0].state, THREAD_STATES.RESOLVED_WITH_CHANGE);
});

test('my own resolution is never something I need to look at again', () => {
  const pr = prFixture({ reviewThreads: { nodes: [thread({ isResolved: true, resolvedBy: { login: 'me' } })] } });
  assert.equal(analyzePr(pr, 'me').threads[0].state, THREAD_STATES.RESOLVED_BY_ME);
});

test('an untouched thread stays untouched, and the review SHA is recorded', () => {
  const pr = prFixture({
    reviews: { nodes: [{ author: { login: 'me' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'old'.padEnd(40, '0') } }] },
    reviewThreads: { nodes: [thread()] },
  });
  const a = analyzePr(pr, 'me', { deltaDiff: 'diff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-x\n+y\n' });
  assert.equal(a.threads[0].state, THREAD_STATES.UNTOUCHED);
  assert.equal(a.myLastReview.oid, 'old'.padEnd(40, '0'));
  assert.equal(a.headMoved, true);
  assert.equal(recommendEvent(a).event, 'REQUEST_CHANGES', 'an unaddressed CHANGES_REQUESTED stays REQUEST_CHANGES');
});

test('threads are ordered by how much attention they need', () => {
  const pr = prFixture({
    reviewThreads: { nodes: [
      thread({ id: 'calm', isResolved: true, resolvedBy: { login: 'me' } }),
      thread({ id: 'loud', comments: { nodes: [
        { databaseId: 1, author: { login: 'me' }, body: 'x', createdAt: '2026-01-01T00:00:00Z' },
        { databaseId: 2, author: { login: 'author' }, body: 'y', createdAt: '2026-01-02T00:00:00Z' },
      ] } }),
    ] },
  });
  assert.equal(analyzePr(pr, 'me').threads[0].id, 'loud');
});

// ------------------------------------------------------------------ security

test('the security lint catches disclosure-shaped text and can be acknowledged', () => {
  const withCve = parseActionFile(MINIMAL.replace('Summary text.', 'This fixes CVE-2026-12345.'));
  assert.deepEqual(securityLint(withCve), ['"CVE-2026-12345"']);

  const withWord = parseActionFile(MINIMAL.replace('Summary text.', 'This is an auth bypass vulnerability.'));
  assert.ok(securityLint(withWord).length > 0);

  const acked = parseActionFile(
    MINIMAL.replace('Summary text.', 'This fixes CVE-2026-12345.').replace('head: abc123', 'head: abc123\nsecurity-reviewed: yes'),
  );
  assert.deepEqual(securityLint(acked), []);

  assert.deepEqual(securityLint(parseActionFile(MINIMAL)), []);
});

test('the lint reads inline and thread bodies too, not just the summary', () => {
  const f = `Status: draft
<!-- prt:verdict
event: COMMENT
-->
<!-- prt:inline
id: i1
path: a
line: 1
-->
this is remotely exploitable
<!-- /prt -->
`;
  assert.ok(securityLint(parseActionFile(f)).length > 0);
});

// -------------------------------------------------------------------- syntax

test('tokenize ignores prose outside blocks entirely', () => {
  const f = `Status: draft

# A heading

Some prose the human typed. It mentions <!-- prt:inline --> inline, mid-sentence.

<!-- prt:body -->
real
<!-- /prt -->

More prose.
`;
  const kinds = tokenize(f).map((b) => b.kind);
  // The mid-sentence mention is not at column 0, so it is not a sentinel.
  assert.deepEqual(kinds, ['body']);
});
