// node --test scripts/test/prt.test.mjs
//
// Everything here is pure: no network, no filesystem outside a temp dir. The
// GitHub writer is covered by `prt submit --dry-run`, which exercises capture
// and preflight against live data without posting. The `prt ask` reporting
// tests at the foot of the file do drive the real CLI, against a temp store
// with a cached reviewer so `context()` never reaches for `gh`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseActionFile, planActions, parseStatus, setStatus, contentHash, payloadHash,
  appendLog, tokenize, PROTECTED_STATUSES,
  askState, blockingAsks, carryAsks, promoteShorthand,
  relocateResolvedAsks, askHandlingLine, collectAsks, unpromotedNotes, notesLostByRegenerating,
  NOTE_LINE, questionHash, resealEditedAsks, renderAsk,
} from '../lib/actionfile.mjs';
import { parseDiff, commentableAnchors, validateAnchor, touchesAnchor } from '../lib/diff.mjs';
import { renderActionFile, renderBoard, bucketOf, isReviewInProgress, REVIEW_IN_PROGRESS_STATUSES } from '../lib/render.mjs';
import { scorePr, rankCandidates } from '../lib/rank.mjs';
import { securityLint, askQuoteLint, diffFingerprint } from '../lib/submit.mjs';
import { analyzePr, recommendEvent, assessNudge, THREAD_STATES } from '../lib/analyze.mjs';
import { renderNudgeFile } from '../lib/render.mjs';
import { isApprovedByReviewer } from '../lib/github.mjs';

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

test('approved scan uses the reviewer latest substantive verdict', () => {
  const pr = {
    latestOpinionatedReviews: { nodes: [
      { author: { login: 'me' }, state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
      { author: { login: 'other' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T00:00:00Z' },
    ] },
    reviews: { nodes: Array.from({ length: 60 }, (_, i) => ({
      author: { login: 'me' }, state: 'COMMENTED', submittedAt: `2026-02-01T00:00:${String(i).padStart(2, '0')}Z`,
    })) },
  };
  assert.equal(isApprovedByReviewer(pr, 'me'), true, 'thread-reply artifacts do not hide the approval');
  pr.latestOpinionatedReviews.nodes[0].state = 'DISMISSED';
  assert.equal(isApprovedByReviewer(pr, 'me'), false, 'a dismissed approval is not current');
});

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
  const file = `Status: draft\n\n<!-- prt:verdict\nevent: COMMENT\n-->\n\n<!-- prt:body -->\n${body}\n<!-- /prt -->\n`;
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

test('event REPLY posts only file-thread replies and defers every other action', () => {
  const f = `Status: draft
<!-- prt:verdict
event: REPLY
-->
<!-- prt:body -->
final review summary
<!-- /prt -->
<!-- prt:inline
id: i1
path: a
line: 1
-->
new finding
<!-- /prt -->
<!-- prt:thread
id: t1
thread: PRRT_x
reply-to: 123
resolve: yes
-->
file-thread reply
<!-- /prt -->
<!-- prt:issue-comment
id: c1
-->
ordinary discussion reply
about a security vulnerability
<!-- /prt -->
`;
  const p = parseActionFile(f);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(planActions(p).map((a) => a.kind), ['thread-reply']);
  assert.deepEqual(securityLint(p), [], 'security lint examines only the reply-only action set');
});

test('an empty COMMENT review is rejected rather than posted as an empty review', () => {
  const empty = `Status: draft\n<!-- prt:verdict\nevent: COMMENT\n-->\n`;
  assert.match(parseActionFile(empty).errors.join(' '), /no review body and no inline comments/);
});

// ---- `post:` on the review summary ---------------------------------------
// The summary used to be the one postable block with no switch: holding it back
// meant deleting the text, so `event: NONE` cost the human the draft they had
// just read. `post: false` keeps the words in the file and out of the review.

const HELD_BACK = (text = 'A summary I drafted and decided not to post.') => `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:body
post: false
-->
${text}
<!-- /prt -->
<!-- prt:thread
id: t1
thread: PRRT_x
reply-to: 123
-->
a reply
<!-- /prt -->
`;

test('`post: false` holds the review summary back without deleting it', () => {
  const p = parseActionFile(HELD_BACK());
  assert.deepEqual(p.errors, [], p.errors.join('; '));
  assert.equal(p.bodyPost, false);
  assert.equal(p.bodyText, 'A summary I drafted and decided not to post.', 'the words stay in the file');
  assert.equal(p.body, null, 'and out of everything that reads what posts');
  assert.deepEqual(planActions(p).map((a) => a.kind), ['thread-reply']);
});

test('a held-back summary is byte-for-byte the same payload as no summary at all', () => {
  const deleted = HELD_BACK().replace(/\npost: false\n-->\n.*\n/, '\n-->\n');
  const p = parseActionFile(deleted);
  assert.deepEqual(p.errors, [], p.errors.join('; '));
  assert.equal(
    payloadHash(parseActionFile(HELD_BACK())), payloadHash(p),
    'the approved payload cannot tell them apart, which is what "never posted" means here',
  );
});

test('a held-back summary is not linted, because it is not going anywhere', () => {
  const p = parseActionFile(HELD_BACK('This is a remote code execution hole, exploitable without auth.'));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(securityLint(p), [], 'the lint reads what planActions posts, and this posts nothing');
});

test('a typo in the summary `post:` flag stops the run rather than deciding for you', () => {
  const f = MINIMAL.replace('<!-- prt:body -->', '<!-- prt:body\npost: ture\n-->');
  assert.match(parseActionFile(f).errors.join(' '), /"ture" is not yes or no/);
});

test('COMMENT over a held-back summary names the flag instead of claiming there is none', () => {
  const f = `Status: draft\n<!-- prt:verdict\nevent: COMMENT\n-->\n<!-- prt:body\npost: false\n-->\nA summary.\n<!-- /prt -->\n`;
  const errs = parseActionFile(f).errors.join(' ');
  assert.match(errs, /event is COMMENT/);
  assert.match(errs, /post: false/, 'the human can see the summary right there — say what is holding it');
});

test('a generated draft arms its summary explicitly', () => {
  const text = renderActionFile({
    repo: 'r/r',
    analysis: fixtureAnalysis({ headMoved: false, myLastReview: null }),
    delta: { commits: [], diff: null },
    findings: { summary: 'Looks fine.', recommendedEvent: 'COMMENT', findings: [] },
    kind: 'initial',
    reviewerLogin: 'me',
  });
  assert.match(text, /^<!-- prt:body\npost: true\n-->$/m, 'the flag is in the file, so flipping it is an edit not a lookup');
  assert.equal(parseActionFile(text).bodyPost, true);
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
  for (const s of ['ready', 'queued', 'partial', 'hold', 'skip']) {
    assert.equal(PROTECTED_STATUSES.has(s), true, s);
  }
  assert.equal(PROTECTED_STATUSES.has('draft'), false);
  // `submitted` is deliberately NOT protected: the approved bytes live on in
  // history/ and outbox/, and protecting it would make `--force` — which also
  // overrides `ready` and `hold` — a routine part of every re-review round.
  assert.equal(PROTECTED_STATUSES.has('submitted'), false);
});

test('a review with no verdict block is an error, not a pending review', () => {
  // Omitting `event` from POST /pulls/{n}/reviews creates an UNSUBMITTED review
  // that nobody can see and that blocks every later submit on the PR.
  const noVerdict = `Status: draft\n\n<!-- prt:body -->\nSummary.\n<!-- /prt -->\n`;
  assert.match(parseActionFile(noVerdict).errors.join(' '), /no `<!-- prt:verdict --> event:` block/);

  const noVerdictInline = `Status: draft
<!-- prt:inline
id: i1
path: a
line: 1
-->
x
<!-- /prt -->
`;
  assert.match(parseActionFile(noVerdictInline).errors.join(' '), /prt:verdict/);
});

test('an unrecognised boolean is an error, never a silent false', () => {
  const typo = `Status: draft
<!-- prt:verdict
event: NONE
-->
<!-- prt:thread
id: t1
thread: PRRT_x
reply-to: 1
resolve: reslove
-->
reply
<!-- /prt -->
`;
  assert.match(parseActionFile(typo).errors.join(' '), /"reslove" is not yes or no/);
  // `post: ture` silently meaning false would drop a comment the human armed.
  const postTypo = typo.replace('resolve: reslove', 'post: ture');
  assert.match(parseActionFile(postTypo).errors.join(' '), /"ture" is not yes or no/);
});

test('CRLF is normalised so a suggestion block is not corrupted', () => {
  const crlf = 'Status: draft\r\n<!-- prt:verdict\r\nevent: COMMENT\r\n-->\r\n<!-- prt:body -->\r\n```suggestion\r\nint x = 1;\r\n```\r\n<!-- /prt -->\r\n';
  const p = parseActionFile(crlf);
  assert.deepEqual(p.errors, []);
  assert.equal(p.body.includes('\r'), false, 'a stray CR inside a suggestion breaks the applied patch');
  assert.equal(p.body, '```suggestion\nint x = 1;\n```');
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

test('a fresh draft carries the pr-actions block, unless the PR is already merged', () => {
  const draftFor = (over) => renderActionFile({
    repo: 'apache/pulsar',
    analysis: fixtureAnalysis(over),
    kind: 'initial',
    diffFingerprint: 'deadbeef',
    reviewerLogin: 'lhotari',
  });
  assert.match(draftFor({}), /<!-- prt:pr-actions\nupdate-branch: false\ntrigger-ci: false\n-->/);
  assert.equal(
    draftFor({ state: 'MERGED', merged: true }).includes('prt:pr-actions'),
    false,
    'a merged PR has no branch left to update and no CI left to release',
  );
});

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
  assert.doesNotMatch(text, /approve-authorised/);
  assert.match(text, /Status: ready/);
});

test('ordinary author questions can be drafted as gated conversation replies', () => {
  const analysis = fixtureAnalysis({
    newIssueComments: [{ author: 'author', createdAt: new Date().toISOString(), url: 'https://x/c1', body: 'Do you still need this test?' }],
  });
  const text = renderActionFile({
    repo: 'r/r', analysis, delta: { commits: [], diff: null },
    findings: { issueCommentAssessments: [{ url: 'https://x/c1', assessment: 'RESPONSE_NEEDED', why: 'author asked a question', reply: 'Yes, because it covers the compatibility path.' }] },
    kind: 're-review', reviewerLogin: 'me', requireExplicitApprove: true,
  });
  const p = parseActionFile(text);
  assert.equal(p.issueComments.length, 1);
  assert.equal(p.issueComments[0].body, 'Yes, because it covers the compatibility path.');
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

  // An unverified resolution must never reach ready-to-approve just because
  // nothing contradicted it — nothing has looked.
  const unverified = {
    analysis: fixtureAnalysis({
      headMoved: false,
      threads: [{ id: 'T' }],
      threadCounts: { [THREAD_STATES.RESOLVED_UNVERIFIED]: 2 },
    }),
    status: 'none',
  };
  assert.equal(bucketOf(unverified), 'resolved-unverified');

  assert.equal(bucketOf({ analysis: fixtureAnalysis(), status: 'ready' }), 'my-queue');
  assert.equal(bucketOf({ analysis: fixtureAnalysis(), status: 'blocked' }), 'my-queue');
  assert.equal(bucketOf({ analysis: fixtureAnalysis(), status: 'hold' }), 'parked');
});

test('a review is "in progress" until it is submitted or skipped', () => {
  for (const st of ['draft', 'ready', 'queued', 'partial', 'blocked', 'error', 'hold']) {
    assert.equal(isReviewInProgress(st), true, `${st} is unfinished work`);
  }
  assert.equal(isReviewInProgress('submitted'), false);
  assert.equal(isReviewInProgress('skip'), false);
  assert.equal(isReviewInProgress('none'), false, 'no file means no review was ever started');
  assert.equal(isReviewInProgress(null), false);
  // Anything unrecognised errs towards being surfaced: losing a draft is worse
  // than one spurious row.
  assert.equal(isReviewInProgress('submitting'), true);
  assert.deepEqual(
    REVIEW_IN_PROGRESS_STATUSES,
    ['draft', 'ready', 'queued', 'partial', 'blocked', 'error', 'hold'],
    'derived from STATUSES, so a new status defaults to being shown',
  );
});

function boardRow(over = {}) {
  return {
    number: 1, title: 'a title', url: 'https://x/1', author: 'someone', prState: 'OPEN',
    status: 'none', reviewPath: null, bucket: 'waiting-for-author', threads: '', ci: 'SUCCESS',
    urgency: 0, ...over,
  };
}

test('the board links every unfinished review.md and gathers them at the top', () => {
  const md = renderBoard({
    repo: 'r/r',
    generatedAt: 'T',
    storeDir: '/store/r/r',
    rows: [
      boardRow({ number: 4, status: 'hold', reviewPath: 'pr-4/review.md', bucket: 'parked', urgency: 1 }),
      boardRow({ number: 1, status: 'draft', reviewPath: 'pr-1/review.md', bucket: 'author-replied-to-me', urgency: 9 }),
      boardRow({ number: 2, status: 'submitted', reviewPath: 'pr-2/review.md', urgency: 5 }),
      boardRow({ number: 3, status: 'none', urgency: 4 }),
      boardRow({ number: 5, status: 'skip', reviewPath: 'pr-5/review.md', bucket: 'parked', urgency: 3 }),
    ],
  });

  assert.match(md, /## reviews in progress \(2\)/);
  assert.match(md, /\[review\.md\]\(pr-1\/review\.md\)/);
  assert.match(md, /\[review\.md\]\(pr-4\/review\.md\)/);
  assert.doesNotMatch(md, /pr-2\/review\.md/, 'a submitted review is finished');
  assert.doesNotMatch(md, /pr-5\/review\.md/, 'a skip file holds a real draft, but the human declined it');
  assert.match(md, /Links are relative to `\/store\/r\/r`/);

  // The section sits above the buckets, and is ordered by the same urgency.
  const section = md.indexOf('## reviews in progress');
  assert.ok(section < md.indexOf('## author-replied-to-me'), 'unfinished drafts come first');
  assert.ok(md.indexOf('pr-1/review.md') < md.indexOf('pr-4/review.md'), 'most urgent first');

  // ...and the status cell inside the bucket table is itself the link, so a row
  // is reachable from wherever the reader happens to be looking.
  assert.match(md, /\| \[`draft`\]\(pr-1\/review\.md\) \|/);
  assert.match(md, /\| `submitted` \|/, 'a finished review keeps a plain status cell');
  assert.match(md, /\| `none` \|/);
});

test('the board renders unchanged when nothing is half-finished', () => {
  const md = renderBoard({
    repo: 'r/r', generatedAt: 'T',
    rows: [boardRow({ number: 7, status: 'submitted', reviewPath: 'pr-7/review.md' })],
  });
  assert.doesNotMatch(md, /reviews in progress/);
  assert.doesNotMatch(md, /review\.md/);
  assert.match(md, /## waiting-for-author \(1\)/);
});

test('an unfinished draft on a closed PR is linked before cleanup archives it', () => {
  const md = renderBoard({
    repo: 'r/r', generatedAt: 'T',
    rows: [boardRow({ number: 8, prState: 'MERGED', status: 'draft', reviewPath: 'pr-8/review.md' })],
  });
  assert.match(md, /## closed or merged/);
  assert.match(md, /unfinished draft: \[review\.md\]\(pr-8\/review\.md\)/);
});

test('a pipe in a PR title cannot break the board table', () => {
  const md = renderBoard({
    repo: 'r/r', generatedAt: 'T',
    rows: [boardRow({ title: 'a | b', status: 'draft', reviewPath: 'pr-1/review.md' })],
  });
  assert.doesNotMatch(md, /\| a \| b \|/);
  assert.match(md, /a \\\| b/);
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

test('a resolved thread with no delta fetched is unverified, not "addressed"', () => {
  // sync/refresh never fetch a delta, so codeChanged is null for every thread
  // they classify. Guessing the calm answer there is the unsafe direction: it
  // feeds the APPROVE recommendation with no evidence at all.
  const pr = prFixture({ reviewThreads: { nodes: [thread({ isResolved: true, resolvedBy: { login: 'author' } })] } });
  const a = analyzePr(pr, 'me');
  assert.equal(a.threads[0].state, THREAD_STATES.RESOLVED_UNVERIFIED);
  assert.notEqual(a.threads[0].state, THREAD_STATES.RESOLVED_WITH_CHANGE);
});

test('an empty COMMENTED review does not move the "where I last reviewed" watermark', () => {
  // GitHub creates one of these for every standalone reply — including the
  // replies this tool posts. Letting one set the watermark would make the next
  // re-review report "nothing changed" for code nobody re-read.
  const realReview = { author: { login: 'me' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z', body: 'please fix', commit: { oid: 'old'.padEnd(40, '0') } };
  const replyArtifact = { author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-02-01T00:00:00Z', body: '', commit: { oid: 'new'.padEnd(40, '0') } };
  const pr = prFixture({ headRefOid: 'new'.padEnd(40, '0'), reviews: { nodes: [realReview, replyArtifact] } });

  const a = analyzePr(pr, 'me');
  assert.equal(a.myLastReview.oid, 'old'.padEnd(40, '0'));
  assert.equal(a.headMoved, true, 'the head moved past my real review, and that must stay visible');
});

test('an explicit hint overrides the derived review watermark', () => {
  const pr = prFixture({ reviews: { nodes: [{ author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-01-01T00:00:00Z', body: 'x', commit: { oid: 'a'.repeat(40) } }] } });
  const a = analyzePr(pr, 'me', { reviewedOidHint: 'b'.repeat(40) });
  assert.equal(a.headMoved, true);
});

test('a range is validated against start-side and may not cross a hunk', () => {
  const a = commentableAnchors(parseDiff(DIFF));

  // LICENSE-style file with two separate hunks: 10-15 and (none) — use Modified,
  // which has one hunk, plus a synthetic two-hunk file.
  const twoHunks = parseDiff([
    'diff --git a/T.java b/T.java',
    '--- a/T.java',
    '+++ b/T.java',
    '@@ -10,2 +10,2 @@',
    ' a',
    '+b',
    '@@ -50,2 +50,2 @@',
    ' c',
    '+d',
    '',
  ].join('\n'));
  const ta = commentableAnchors(twoHunks);
  assert.equal(validateAnchor(ta, { file: 'T.java', line: 10, endLine: 11, side: 'RIGHT' }).ok, true);
  const crossing = validateAnchor(ta, { file: 'T.java', line: 10, endLine: 51, side: 'RIGHT' });
  assert.equal(crossing.ok, false);
  assert.match(crossing.reason, /more than one diff hunk/);

  // A range whose start sits on the other side must be checked against that side.
  const mixed = validateAnchor(a, { file: 'src/Modified.java', line: 11, endLine: 13, side: 'RIGHT', startSide: 'LEFT' });
  assert.equal(mixed.ok, true, 'LEFT 11 and RIGHT 13 both exist in the same hunk');
  const badStartSide = validateAnchor(a, { file: 'src/Added.java', line: 1, endLine: 3, side: 'RIGHT', startSide: 'LEFT' });
  assert.equal(badStartSide.ok, false, 'a new file has no LEFT side for the range to start on');

  // start must precede end
  assert.equal(validateAnchor(a, { file: 'src/Modified.java', line: 13, endLine: 11, side: 'RIGHT' }).ok, false);
});

// --------------------------------------------------------------------- nudge

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** A PR with one thread of mine that nobody has answered for `age` days. */
function unansweredPr({ age = 5, author = 'someone', state = 'OPEN', isDraft = false, extraComments = [] } = {}) {
  return prFixture({
    state,
    isDraft,
    author: { login: author },
    reviews: { nodes: [{ author: { login: 'me' }, state: 'CHANGES_REQUESTED', body: 'please fix', submittedAt: daysAgo(age), commit: { oid: 'head'.padEnd(40, '0') } }] },
    reviewThreads: { nodes: [thread({
      comments: { nodes: [{ databaseId: 1, author: { login: 'me' }, body: 'my point', createdAt: daysAgo(age) }] },
    })] },
    comments: { nodes: extraComments },
  });
}

function nudgeOf(pr, opts = {}) {
  return analyzePr(pr, 'me', { nudgeAfterDays: 2, nudgeCooldownDays: 7, nudgeMaxAgeDays: 90, ...opts }).nudge;
}

test('a point unanswered past the threshold, with me quiet, is due', () => {
  const n = nudgeOf(unansweredPr({ age: 9 }));
  assert.equal(n.due, true, n.reasonNotDue);
  assert.equal(n.untouchedCount, 1);
  assert.equal(n.oldestUntouchedDays, 9);
});

test('nothing is due before the threshold', () => {
  const n = nudgeOf(unansweredPr({ age: 1 }));
  assert.equal(n.due, false);
  assert.match(n.reasonNotDue, /unanswered for 2\+ days/);
});

test('a push since my review means re-review, not a reminder', () => {
  // The thread is old and unanswered, but the author has been working.
  const pr = unansweredPr({ age: 30 });
  pr.headRefOid = 'moved'.padEnd(40, 'f');
  const n = nudgeOf(pr);
  assert.equal(n.due, false);
  assert.match(n.reasonNotDue, /pushed since my review/);
});

test('the cooldown stops a second reminder, and reads GitHub rather than local state', () => {
  // I said something on the PR yesterday, so I am not owed a reply yet.
  const pr = unansweredPr({ age: 30, extraComments: [{ author: { login: 'me' }, body: 'ping', createdAt: daysAgo(1) }] });
  const n = nudgeOf(pr);
  assert.equal(n.due, false);
  assert.match(n.reasonNotDue, /cooldown is 7/);
  assert.equal(n.daysSinceMyLastWord, 1);
});

test('an ancient point needs a decision, not a reminder', () => {
  const n = nudgeOf(unansweredPr({ age: 400 }));
  assert.equal(n.due, false);
  assert.equal(n.abandoned, true);
  assert.match(n.reasonNotDue, /needs a decision, not a reminder/);
});

test('drafts, closed PRs and my own PRs are never nudged', () => {
  assert.match(nudgeOf(unansweredPr({ age: 30, isDraft: true })).reasonNotDue, /draft/);
  assert.match(nudgeOf(unansweredPr({ age: 30, state: 'CLOSED' })).reasonNotDue, /closed/);
  assert.match(nudgeOf(unansweredPr({ age: 30, author: 'me' })).reasonNotDue, /my own PR/);
});

test('a thread the author replied to is not "unanswered"', () => {
  const pr = unansweredPr({ age: 30 });
  pr.reviewThreads.nodes[0].comments.nodes.push({ databaseId: 2, author: { login: 'someone' }, body: 'done', createdAt: daysAgo(3) });
  const n = nudgeOf(pr);
  assert.equal(n.untouchedCount, 0);
  assert.equal(n.due, false);
});

test('a nudge file parses, and posts exactly one comment and no review', () => {
  const a = analyzePr(unansweredPr({ age: 9 }), 'me', { nudgeAfterDays: 2, nudgeCooldownDays: 7 });
  const text = renderNudgeFile({ repo: 'apache/pulsar', analysis: a, reviewerLogin: 'me' });

  assert.equal(text.split('\n')[0], 'Status: draft', 'a nudge is a proposal like everything else');
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, [], p.errors.join('; '));
  assert.deepEqual(planActions(p).map((x) => x.kind), ['issue-comment']);
  assert.equal(p.event, null, 'a nudge is not a review');

  const body = p.issueComments[0].body;
  assert.match(body, /@someone/);
  assert.match(body, /a\/B\.java|src\/Modified\.java|Consumer\.java|\.java/, 'it names the actual open point');
  assert.equal(/\bplease\s+(fix|address|respond)\b/i.test(body), false, 'the default wording must not read as chasing');
});

test('a nudge files resolved notes the same way the review draft does', () => {
  // If the two renderers disagreed about where a resolved note lives, a nudge
  // would silently pull one back up the file.
  const a = analyzePr(unansweredPr({ age: 9 }), 'me', { nudgeAfterDays: 2, nudgeCooldownDays: 7 });
  const text = renderNudgeFile({
    repo: 'apache/pulsar', analysis: a, reviewerLogin: 'me',
    carriedAsks: [
      { id: 'a1', re: 'body', blocking: true, closed: false, raised: 'g1', open: false, state: 'declined', question: 'answered one' },
      { id: 'a2', re: 'body', blocking: true, closed: false, raised: 'g2', open: true, state: 'open', question: 'still open one' },
    ],
    carriedAnswers: [{ to: 'a1', disposition: 'declined', in: 'g1', body: 'Kept it: the claim holds.' }],
  });
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, [], p.errors.join('; '));
  assert.deepEqual(planActions(p).map((x) => x.kind), ['issue-comment'], 'still exactly one comment, no review');
  const heading = text.search(/^## Resolved notes$/m);
  assert.ok(heading !== -1);
  assert.ok(text.indexOf('still open one') < heading, 'the open note stays under "Notes to the assistant"');
  assert.ok(text.indexOf('answered one') > heading, 'the answered one is filed');
  assert.match(text, /^\*a1 · declined · g1\* — Kept it: the claim holds\.$/m);
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


// ------------------------------------------------- notes to the assistant

const WITH_ASK = `Status: draft

<!-- prt:doc
repo: apache/pulsar
pr: 1
head: abc123
generation: 4
-->

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Summary text.
<!-- /prt -->

<!-- prt:inline
id: i1
post: true
subject: line
path: src/Main.java
line: 10
-->
**[BUG] the claim**

evidence
<!-- /prt -->

<!-- prt:ask
id: a1
re: i1
-->
this one is wrong, the null check is upstream
<!-- /prt -->
`;

test('an ask never becomes an action, so it can never be posted', () => {
  const p = parseActionFile(WITH_ASK);
  assert.deepEqual(p.errors, []);
  assert.equal(p.asks.length, 1);
  assert.equal(p.asks[0].re, 'i1');
  // The whole never-posted guarantee: asks produce no action, and planActions
  // has no fall-through that could sweep them in.
  assert.deepEqual(planActions(p).map((a) => a.kind), ['review']);
  const review = planActions(p).find((a) => a.kind === 'review');
  assert.equal(review.body.includes('null check is upstream'), false);
  assert.equal(review.comments.some((c) => c.body.includes('null check is upstream')), false);
});

test('editing a note does not change the approved payload, but does change the content hash', () => {
  const edited = WITH_ASK.replace('this one is wrong, the null check is upstream', 'actually I withdraw this');
  assert.equal(payloadHash(parseActionFile(WITH_ASK)), payloadHash(parseActionFile(edited)));
  assert.notEqual(contentHash(WITH_ASK), contentHash(edited));
});

test('an ask defaults to blocking, and blocks only until it is answered', () => {
  const p = parseActionFile(WITH_ASK);
  assert.equal(p.asks[0].blocking, true);
  assert.deepEqual(blockingAsks(p).map((a) => a.id), ['a1']);

  const answered = WITH_ASK + `
<!-- prt:answer
to: a1
disposition: addressed
did: answer-only
in: g5
-->
Checked: the upstream null check is on a different path, so the comment stands.
<!-- /prt -->
`;
  const q = parseActionFile(answered);
  assert.deepEqual(q.errors, []);
  assert.deepEqual(blockingAsks(q).map((a) => a.id), []);
  assert.equal(askState(q.asks[0], q.answers).state, 'addressed');
});

test('blocking: no defers a note without stopping the submit', () => {
  const p = parseActionFile(WITH_ASK.replace('re: i1', 're: i1\nblocking: no'));
  assert.deepEqual(p.errors, []);
  assert.equal(p.asks[0].blocking, false);
  assert.deepEqual(blockingAsks(p), []);
});

test('closed: yes withdraws a note', () => {
  const p = parseActionFile(WITH_ASK.replace('re: i1', 're: i1\nclosed: yes'));
  assert.equal(askState(p.asks[0], p.answers).state, 'withdrawn');
  assert.deepEqual(blockingAsks(p), []);
});

// ---------------------------------------------------------------------------
// Editing an answered note reopens it.
//
// The failure these pin, measured on a scratch copy of the real pr-26433:
// rewriting an ask's question in place — the natural way to escalate when the
// model got it wrong — changed nothing. `prt ask` printed the new words over a
// `✓ addressed`, `--promote` said "no un-promoted @ai notes", `validate` said
// `✓`, the submit gate was empty, and the next `prt draft` retired the pair to
// `history/`. The words were `*@ai STOP … Do not post until that is fixed.`

/** WITH_ASK, but a1 carries the creation stamp `promoteShorthand` now writes. */
const STAMPED_ASK = WITH_ASK.replace(
  're: i1\n-->\nthis one is wrong, the null check is upstream',
  `re: i1\nq: ${questionHash('this one is wrong, the null check is upstream')}\n-->\nthis one is wrong, the null check is upstream`,
);
const ANSWER_TO_A1 = `
<!-- prt:answer
to: a1
disposition: addressed
did: answer-only
in: g4
-->
Checked: the upstream null check is on a different path, so the comment stands.
<!-- /prt -->
`;

test('the question stamp survives an editor, and nothing else', () => {
  const q = 'this one is wrong, the null check is upstream';
  // The three an editor makes on its own. Each of these reopening an answered
  // note would make the mechanism unusable — a file opened somewhere else would
  // block a submit that was ready.
  assert.equal(questionHash(q), questionHash(`﻿${q}`), 'a BOM is not the human saying anything');
  assert.equal(questionHash('one\ntwo'), questionHash('one\r\ntwo'), 'CRLF is not either');
  assert.equal(questionHash('one  \ntwo\t'), questionHash('one\ntwo'), 'nor is trailing whitespace');
  assert.equal(questionHash(`  ${q}\n\n`), questionHash(q), 'nor is padding at the ends');
  // And the ones that are.
  assert.notEqual(questionHash(q), questionHash(`${q}.`), 'a changed character is');
  assert.notEqual(questionHash(q), questionHash(`${q}\n\nand another thing`), 'so is an added paragraph');
  assert.notEqual(questionHash('one\ntwo'), questionHash('one two'), 'so is a re-wrap');
});

test('a note the tool created carries what it wrote, so an edit to it is visible', () => {
  const p = parseActionFile(STAMPED_ASK);
  assert.deepEqual(p.errors, []);
  assert.equal(p.asks[0].q, questionHash('this one is wrong, the null check is upstream'));
  // Unedited and answered: closed, exactly as before the field existed.
  const settled = parseActionFile(STAMPED_ASK + ANSWER_TO_A1);
  assert.equal(askState(settled.asks[0], settled.answers).state, 'addressed');
  assert.deepEqual(blockingAsks(settled), []);
});

test('rewriting an answered note reopens it, blocks the submit, and keeps its answer on the page', () => {
  const escalated = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const p = parseActionFile(escalated);
  assert.deepEqual(p.errors, [], 'the file still parses; the reopen is a state, not a syntax error');
  const st = askState(p.asks[0], p.answers);
  // `edited`, not a bare `open`: an answer is visibly sitting under it, and a
  // human shown "open" there would go looking for the answer, not their edit.
  assert.equal(st.state, 'edited');
  assert.equal(st.open, true);
  assert.equal(st.answer, null, 'the stale answer is not offered as the answer to this question');
  assert.deepEqual(blockingAsks(p).map((a) => a.id), ['a1'], 'and it stops the submit');
  // The stale answer is still IN the file — the conversation stays on the page
  // rather than only in history/.
  assert.match(escalated, /disposition: addressed/);
  assert.equal(p.answers.length, 1);
});

test('a deferred answer goes stale the same way a terminal one does', () => {
  const deferred = STAMPED_ASK + `
<!-- prt:answer
to: a1
disposition: deferred
in: g4
-->
Parking this until the base branch settles.
<!-- /prt -->
`;
  const before = parseActionFile(deferred);
  assert.equal(askState(before.asks[0], before.answers).state, 'deferred');
  const after = parseActionFile(deferred.replace('this one is wrong, the null check is upstream', 'no — it is worse than that'));
  assert.equal(askState(after.asks[0], after.answers).state, 'edited');
});

test('withdrawing a note outranks an edit to it, because only the human writes `closed:`', () => {
  const withdrawn = (STAMPED_ASK + ANSWER_TO_A1)
    .replace('re: i1\nq:', 're: i1\nclosed: yes\nq:')
    .replace('this one is wrong, the null check is upstream', 'never mind, I was wrong');
  const p = parseActionFile(withdrawn);
  assert.equal(askState(p.asks[0], p.answers).state, 'withdrawn');
  assert.deepEqual(blockingAsks(p), [], 'a withdrawn note does not come back by being retyped');
});

test('the reseal accepts the new wording and pins the old answer to the old one', () => {
  const escalated = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const was = questionHash('this one is wrong, the null check is upstream');
  const now = questionHash('STOP — it is still in i1. Do not post until that is fixed.');
  const { text, resealed } = resealEditedAsks(escalated);
  assert.deepEqual(resealed, [{ id: 'a1', from: was, to: now }]);
  assert.match(text, new RegExp(`q: ${now}`), 'the ask now records the question it actually carries');
  assert.match(text, new RegExp(`re-q: ${was}`), 'and the answer records the one it answered');

  // Still open afterwards: the reseal accepts the human's edit as the question,
  // it does not accept the model's old reply as an answer to it.
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, []);
  assert.equal(askState(p.asks[0], p.answers).state, 'edited');
  assert.deepEqual(blockingAsks(p).map((a) => a.id), ['a1']);

  // Idempotent, and a no-op on a file with nothing to reseal.
  assert.equal(resealEditedAsks(text).text, text);
  assert.deepEqual(resealEditedAsks(text).resealed, []);
  assert.equal(resealEditedAsks(STAMPED_ASK + ANSWER_TO_A1).text, STAMPED_ASK + ANSWER_TO_A1);
});

test('a reopened note is closed again by answering it, not by regenerating over it', () => {
  const escalated = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const { text } = resealEditedAsks(escalated);
  // The model's next answer carries no `re-q:` of its own, so it inherits the
  // ask's current `q:` — which is the question it is looking at. Nothing new for
  // the model to write, and nothing it can forget.
  const answeredAgain = text + `
<!-- prt:answer
to: a1
disposition: addressed
did: edit-inline i1
in: g5
-->
You are right, i1 still carried it. Rewritten.
<!-- /prt -->
`;
  const p = parseActionFile(answeredAgain);
  assert.deepEqual(p.errors, []);
  assert.equal(askState(p.asks[0], p.answers).state, 'addressed');
  assert.deepEqual(blockingAsks(p), [], 'the reopen is consumable, not a one-way trap');
});

test('one terminal answer per QUESTION, so a rewritten note can be answered a second time', () => {
  // The double-answer guard used to key on the ask id, which was the same thing
  // as "the same question" right up until a question could be rewritten under
  // its answer. Keyed that way it made the reopen a dead end: the second answer
  // was a hard parse error, so the note could never close and the file could
  // never post.
  const escalated = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const second = `
<!-- prt:answer
to: a1
disposition: addressed
did: edit-inline i1
in: g5
-->
You are right, i1 still carried it. Rewritten.
<!-- /prt -->
`;
  // Two answers to two different questions: legal, and the later one is live.
  assert.deepEqual(parseActionFile(resealEditedAsks(escalated).text + second).errors, []);
  // Two answers to the SAME question: still the error it always was. Neither
  // carries a `re-q:`, so both inherit the one `q:` and collide on it.
  assert.match(
    parseActionFile(STAMPED_ASK + ANSWER_TO_A1 + second).errors.join(' '),
    /ask "a1" already has a terminal answer/,
  );
  // And on a file with no stamp anywhere, exactly as before.
  assert.match(
    parseActionFile(WITH_ASK + ANSWER_TO_A1 + second).errors.join(' '),
    /ask "a1" already has a terminal answer/,
  );
});

test('regeneration copies the stamp rather than recomputing it, so it cannot launder an edit', () => {
  const escalated = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const { text } = resealEditedAsks(escalated);
  const carried = carryAsks(text, {
    newIds: new Set(['i1']),
    newAnchors: new Map([['i1', { path: 'src/Main.java', line: 10, side: 'RIGHT' }]]),
    generation: 5,
    ordinalFloor: 0,
  });
  assert.deepEqual(carried.asks.map((a) => a.id), ['a1'], 'an edited note is open, so it is carried, never retired');
  assert.equal(carried.answers.length, 1, 'and its stale answer travels with it — the chain, not just the words');

  const rendered = renderAsk(carried.asks[0], carried.answers);
  const round = parseActionFile(`Status: draft\n\n<!-- prt:verdict\nevent: NONE\n-->\n\n${rendered}\n`);
  assert.deepEqual(round.errors, []);
  assert.equal(askState(round.asks[0], round.answers).state, 'edited',
    'a re-rendered file says the same thing: recomputing `q:` here would re-close it a round later');
  assert.match(rendered, new RegExp(`q: ${questionHash('STOP — it is still in i1. Do not post until that is fixed.')}`));
  assert.match(rendered, new RegExp(`re-q: ${questionHash('this one is wrong, the null check is upstream')}`));

  // The invariant on its own, because the assertion above is held up by the
  // `re-q:` the reseal wrote and would survive a `renderAsk` that recomputed.
  // The renderer is a COPIER: given a stamp that does not match the question in
  // front of it, it writes the stamp it was given.
  assert.match(
    renderAsk({ id: 'a1', re: 'i1', q: 'sha256:000000000000000000000000', question: 'anything at all' }, []),
    /^<!-- prt:ask\nid: a1\nre: i1\nq: sha256:000000000000000000000000\n-->\nanything at all\n/,
  );
});

test('a note edited but not yet resealed is not re-closed by regenerating over it', () => {
  // The laundering path, with the reseal deliberately skipped. `prt draft`
  // reseals on its way through `promoteShorthand`, but `carryAsks` is reachable
  // from `prt nudge` too, and a renderer that recomputed `q:` would hand the
  // stale answer a stamp that matched — closing, in the regenerated file, a note
  // the human had just reopened by rewriting it. `blockingAsks` on the result is
  // the assertion that matters: it is what the submit gate reads.
  const escalated = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const before = parseActionFile(escalated);
  assert.equal(before.answers[0].reQ, null, 'nothing has pinned the old answer yet');
  const carried = carryAsks(escalated, {
    newIds: new Set(['i1']),
    newAnchors: new Map([['i1', { path: 'src/Main.java', line: 10, side: 'RIGHT' }]]),
    generation: 5,
    ordinalFloor: 0,
  });
  const next = `Status: draft\n\n<!-- prt:verdict\nevent: NONE\n-->\n\n${
    renderAsk(carried.asks[0], carried.answers)}\n`;
  const p = parseActionFile(next);
  assert.deepEqual(p.errors, []);
  assert.equal(askState(p.asks[0], p.answers).state, 'edited');
  assert.deepEqual(blockingAsks(p).map((a) => a.id), ['a1'], 'still blocking a round later');
});

test('a note edited while it sits in the resolved log comes back out of it', () => {
  const filed = relocateResolvedAsks(STAMPED_ASK + ANSWER_TO_A1);
  assert.deepEqual(filed.moved.map((m) => m.id), ['a1'], 'answered, so it is filed under the log heading');
  const escalated = filed.text.replace(
    'this one is wrong, the null check is upstream',
    'STOP — it is still in i1. Do not post until that is fixed.',
  );
  const p = parseActionFile(escalated);
  assert.equal(askState(p.asks[0], p.answers).state, 'edited',
    'the state is derived from the bytes, so where the pair sits does not change it');
  assert.deepEqual(blockingAsks(p).map((a) => a.id), ['a1']);
  // And the log stops claiming otherwise the moment anything tidies the file.
  const back = relocateResolvedAsks(escalated);
  assert.deepEqual(back.reopened.map((r) => r.id), ['a1']);
  assert.doesNotMatch(back.text, /## Resolved notes/, 'nothing is left under the heading, so it goes too');
});

test('editing the ANSWER body is not an edit to the question, and says so by doing nothing', () => {
  // The decision, stated as a test: `q:`/`re-q:` fingerprint the QUESTION only.
  // An answer is the model's record of what it did; rewriting it does not change
  // what was asked. A human who disagrees with an answer types a note under it,
  // and that note is lifted into a new ask with `follows:` — the path that
  // already exists, and the one that keeps the chain auditable.
  const p = parseActionFile((STAMPED_ASK + ANSWER_TO_A1).replace(
    'Checked: the upstream null check is on a different path, so the comment stands.',
    'Nonsense — this is not what I asked for.',
  ));
  assert.deepEqual(p.errors, []);
  assert.equal(askState(p.asks[0], p.answers).state, 'addressed');
  assert.deepEqual(blockingAsks(p), []);

  // The supported escalation, for contrast: a note under the answer.
  const note = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'Checked: the upstream null check is on a different path, so the comment stands.',
    'Checked: the upstream null check is on a different path, so the comment stands.\n\n@ai not good enough — check the other path too',
  );
  const { promoted } = promoteShorthand(note, { startOrdinal: 7, generation: 5 });
  assert.deepEqual(promoted.map((x) => [x.id, x.follows]), [['a7', 'a1']]);
});

test('a note typed under an answered question is lifted, and the question goes back to reading as it did', () => {
  // The ordering `promoteShorthand` depends on. A note typed inside an ask body
  // is part of that question's bytes until the lift takes it out, so the ask is
  // `edited` while it is there — and once the lift has removed it, the question
  // is byte-for-byte what the tool wrote, so the reseal must not have moved `q:`
  // onto the version that included the note.
  const withNote = (STAMPED_ASK + ANSWER_TO_A1).replace(
    'this one is wrong, the null check is upstream\n<!-- /prt -->',
    'this one is wrong, the null check is upstream\n\n@ai and check the other path too\n<!-- /prt -->',
  );
  const before = parseActionFile(withNote);
  assert.equal(askState(before.asks[0], before.answers).state, 'edited', 'the extra line is part of the question');

  const { text, promoted, resealed } = promoteShorthand(withNote, { startOrdinal: 7, generation: 5 });
  assert.deepEqual(promoted.map((x) => [x.id, x.follows]), [['a7', 'a1']]);
  assert.deepEqual(resealed, [], 'the lift restored the question, so there was nothing left to reseal');
  const after = parseActionFile(text);
  assert.deepEqual(after.errors, []);
  assert.equal(askState(after.asks.find((a) => a.id === 'a1'), after.answers).state, 'addressed');
  assert.deepEqual(blockingAsks(after).map((a) => a.id), ['a7'], 'the new words block instead');
});

test('the model cannot mark its own homework done without showing the work', () => {
  const empty = WITH_ASK + `
<!-- prt:answer
to: a1
disposition: addressed
-->
<!-- /prt -->
`;
  assert.match(parseActionFile(empty).errors.join(' '), /needs a body saying what was done/);
});

test('a claim that an inline was dropped is cross-checked against the file', () => {
  const lying = WITH_ASK + `
<!-- prt:answer
to: a1
disposition: addressed
did: drop-inline i1
-->
Dropped it.
<!-- /prt -->
`;
  // i1 still says post: true, so the claim contradicts the file.
  assert.match(parseActionFile(lying).errors.join(' '), /still has `post: true`/);

  const honest = lying.replace('id: i1\npost: true', 'id: i1\npost: false\ndropped-by: a1');
  assert.deepEqual(parseActionFile(honest).errors, []);
});

test('an unstamped answer keeps the cross-check honest, because a missing `in:` is not generation zero', () => {
  // The carry exemption exists so an answer written in an EARLIER round is not
  // re-checked against a file whose inlines have since been regenerated. A
  // hand-written answer carries no `in:` at all, and that shape must stay
  // checked — `Number('')` is 0, which would read as carried against any real
  // generation and quietly retire the guard.
  const unstamped = WITH_ASK + `
<!-- prt:answer
to: a1
disposition: addressed
did: drop-inline i9
-->
Dropped it.
<!-- /prt -->
`;
  assert.match(
    parseActionFile(unstamped).errors.join(' '),
    /has no inline "i9"/,
    'an answer with no `in:` belongs to this round, so the claim is checked',
  );

  // Stamped with an earlier generation than the file's (WITH_ASK is g4): this
  // is the case the exemption is actually for, and it still passes.
  const carried = unstamped.replace('did: drop-inline i9\n', 'did: drop-inline i9\nin: g1\n');
  assert.deepEqual(parseActionFile(carried).errors, []);
});

test('a disposition typo is an error, never a silent value', () => {
  const f = WITH_ASK + `
<!-- prt:answer
to: a1
disposition: adressed
-->
body
<!-- /prt -->
`;
  assert.match(parseActionFile(f).errors.join(' '), /must be addressed, declined or deferred/);
});

test('an answer pointing at no ask is an error', () => {
  const f = WITH_ASK + `
<!-- prt:answer
to: a99
disposition: addressed
-->
body
<!-- /prt -->
`;
  assert.match(parseActionFile(f).errors.join(' '), /does not match any ask/);
});

// ---- the shorthand, and the leak paths it must not open --------------------

test('an un-promoted @ai note is an error, so it is never silently swallowed', () => {
  const f = MINIMAL + '\n@ai the summary is too soft here\n';
  assert.match(parseActionFile(f).errors.join(' '), /un-promoted/);
});

test('@ai inside text that gets posted is refused, not stripped', () => {
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
@ai remember to soften this
<!-- /prt -->
`;
  const p = parseActionFile(f);
  assert.match(p.errors.join(' '), /inside text that gets posted/);
  // And the bytes are untouched: refusing beats editing what the human approved.
  assert.match(p.body, /@ai remember to soften this/);
});

test('backticks are the escape in a gap too, and indenting is no longer one', () => {
  // The gap used to have its own escape — indent the line one space and it stayed
  // prose — and that escape is what the tolerant leader class costs. It is a
  // deliberate trade: the leader is what lets a decorated note in a gap be seen
  // at all, and one escape that works in every part of the file beats two that
  // disagree. Measured over the 12,459 gap lines of the live store, tolerating
  // decoration newly matches exactly one line, and it is a real note.
  const indented = MINIMAL + '\n  @ai this reads as a note now, because it is one\n';
  assert.match(parseActionFile(indented).errors.join(' '), /un-promoted/);
  assert.equal(promoteShorthand(indented, { startOrdinal: 1 }).promoted.length, 1);

  // The escape that does work, and works identically inside a block.
  const quoted = MINIMAL + '\n  The `@ai` token leaves a note; `@ai verdict …` binds it.\n';
  assert.deepEqual(parseActionFile(quoted).errors, []);
  assert.deepEqual(promoteShorthand(quoted, { startOrdinal: 1 }).promoted, []);
});

test('promotion turns shorthand into a canonical block and reports what it inferred', () => {
  const f = WITH_ASK.replace(/<!-- prt:ask[\s\S]*<!-- \/prt -->\n$/, '@ai drop this, the null check is upstream\n');
  const { text, promoted } = promoteShorthand(f, { startOrdinal: 7, generation: 4 });
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].id, 'a7');
  // No explicit target, so it binds to the nearest preceding block — i1.
  assert.equal(promoted[0].re, 'i1');
  assert.equal(promoted[0].inferred, true);
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, []);
  assert.equal(p.asks[0].question, 'drop this, the null check is upstream');
  assert.equal(p.asks[0].raised, 'g4');
});

test('an explicit target on the shorthand wins over position', () => {
  // With a punctuation separator the target token is consumed, giving a clean body.
  const f = MINIMAL + '\n@ai verdict — COMMENT is too soft, two reviewers disagreed\n';
  const { promoted, text } = promoteShorthand(f, { startOrdinal: 1, generation: 2 });
  assert.equal(promoted[0].re, 'verdict');
  assert.equal(promoted[0].inferred, false);
  assert.equal(parseActionFile(text).asks[0].question, 'COMMENT is too soft, two reviewers disagreed');
});

test('a target token separated by only a space is read but never eaten', () => {
  // "general cleanup of the summary" and "i1 is fine, it is i2 that is wrong" both
  // open with a token that is also an ordinary word. Consuming it on a bare space
  // deleted a word the human wrote, which is never an acceptable price for a
  // tidier body — so the target is read and the text is kept whole.
  const g = promoteShorthand(MINIMAL + '\n@ai general cleanup of the summary\n', { startOrdinal: 1 });
  assert.equal(g.promoted[0].re, 'general');
  assert.equal(parseActionFile(g.text).asks[0].question, 'general cleanup of the summary');

  const withInline = MINIMAL + `
<!-- prt:inline
id: i1
post: true
subject: line
path: src/Main.java
line: 10
-->
**[BUG] c**

body
<!-- /prt -->

@ai i1 is fine, it is i2 that is wrong
`;
  const h = promoteShorthand(withInline, { startOrdinal: 1 });
  assert.equal(h.promoted[0].re, 'i1');
  assert.equal(parseActionFile(h.text).asks[0].question, 'i1 is fine, it is i2 that is wrong');
});

test('a mistyped block kind is an error, not a silently dropped note', () => {
  const f = MINIMAL + '\n<!-- prt:note -->\ndrop the third comment\n<!-- /prt -->\n';
  assert.match(parseActionFile(f).errors.join(' '), /did you mean `prt:notes`|did you mean `prt:ask`/);
});

test('@ai inside an inert block is an error, because nothing else would report it', () => {
  const f = MINIMAL + '\n<!-- prt:context -->\n@ai drop the third comment\n<!-- /prt -->\n';
  assert.match(parseActionFile(f).errors.join(' '), /inside a block, so it will not be collected/);
});

// ---- lifting a note back out of the block it was typed in ------------------
//
// The real one that got through began `*@ai Don't mention anything about the
// tier level…` inside a prt:body. Column-0 detection never saw it, `prt ask`
// said "no notes", and the note was one submit away from being posted to the PR.

const withNote = (line, tail = '') => `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
${line}

Real summary prose.${tail}
<!-- /prt -->
`;

test('a note wearing markdown decoration is seen, and backticks still keep the token as prose', () => {
  for (const l of ["*@ai don't mention the tier", '  @ai soften this', '> @ai and this', '- @ai and this']) {
    assert.match(parseActionFile(withNote(l)).errors.join(' '), /inside text that gets posted/, l);
    assert.equal(promoteShorthand(withNote(l), { startOrdinal: 1 }).promoted.length, 1, l);
  }
  // The token written ABOUT rather than typed as a note. This is the escape the
  // error message names, and it is also the generator's own hint line.
  const prose = withNote('The `@ai` token leaves me a note, and `@ai verdict …` binds it.');
  assert.deepEqual(parseActionFile(prose).errors, []);
  assert.deepEqual(promoteShorthand(prose, { startOrdinal: 1 }).promoted, []);
});

test('a lifted note leaves the block, binds to it, and does not disturb a byte around it', () => {
  // The note sits BETWEEN two paragraphs on purpose. A lift that took only the
  // note's own line would leave its separating blank behind, and `body.trim()`
  // hides that at the edges — mid-body it is a visible change to posted bytes.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
First paragraph.

*@ai soften the second paragraph

Second paragraph.
<!-- /prt -->
`;
  const { text, promoted, refused } = promoteShorthand(f, { startOrdinal: 3, generation: 2 });
  assert.deepEqual(refused, []);
  assert.deepEqual(
    promoted.map((p) => [p.id, p.re, p.lifted]), [['a3', 'body', 'body']],
    'the note is about the block it was typed in, so that is what it binds to',
  );
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, []);
  assert.equal(p.asks[0].question, 'soften the second paragraph');
  // The whole point: the posted bytes are the human's prose and nothing else,
  // with the paragraphs closed up exactly as if the note had never been typed.
  assert.equal(p.body, 'First paragraph.\n\nSecond paragraph.');
  // And the ask lands right under the block it came out of, not somewhere later.
  // `q:` is the creation stamp — the one moment the tool can honestly record
  // what it wrote — and it is written here, on the way out of the lift.
  assert.match(text, new RegExp(
    `<!-- /prt -->\\n\\n<!-- prt:ask\\nid: a3\\nre: body\\nraised: g2\\nq: ${questionHash('soften the second paragraph')}\\n-->\\nsoften the second paragraph\\n<!-- /prt -->`,
  ));
});

test('a note butted under prose keeps the blank below it, so two paragraphs never weld', () => {
  // The blank line below a note belongs to the note only when the note stands in
  // its own paragraph. Butted up under prose, that blank is the separator the
  // paragraph BELOW needs: taking it welds two paragraphs into one, and turns the
  // paragraph after a list into a lazy continuation of the last item. Either way
  // the posted bytes change well beyond the note that was lifted.
  const mk = (body) => `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
${body}
<!-- /prt -->
`;
  const under = promoteShorthand(mk('Para A.\n*@ai soften this\n\nPara B.'), { startOrdinal: 1 });
  assert.equal(under.promoted.length, 1);
  assert.equal(parseActionFile(under.text).body, 'Para A.\n\nPara B.');

  const list = promoteShorthand(mk('- item one\n- item two\n@ai soften this\n\nPara B.'), { startOrdinal: 1 });
  assert.equal(parseActionFile(list.text).body, '- item one\n- item two\n\nPara B.');

  // A note that IS in its own paragraph still takes its blank, or the lift would
  // leave a double blank where the note used to sit.
  const alone = promoteShorthand(mk('Para A.\n\n@ai soften this\n\nPara B.'), { startOrdinal: 1 });
  assert.equal(parseActionFile(alone.text).body, 'Para A.\n\nPara B.');
});

test('a note butted against prose is refused rather than swallowing the sentence below it', () => {
  // Applying the gap run rule here would take "The naming is off" into the note
  // and delete it from the review. There is no signal that tells the rest of a
  // note from the rest of a summary, so the ambiguous case is not guessed at.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
@ai soften this
The naming is off — see below.
<!-- /prt -->
`;
  const { text, promoted, refused } = promoteShorthand(f, { startOrdinal: 1 });
  assert.equal(text, f, 'not one byte moves');
  assert.deepEqual(promoted, []);
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /blank line after the note/);
  // And the refusal is not a pass: the parse error stands, so capture() still
  // throws Blocked and nothing is posted.
  assert.match(parseActionFile(text).errors.join(' '), /inside text that gets posted/);
});

test('a note that is the whole body is refused, not lifted into a summary-less review', () => {
  // An emptied prt:body becomes `body: null`, and a review that also carries an
  // inline comment then parses CLEAN and posts with no summary at all.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
@ai rewrite the summary from scratch
<!-- /prt -->

<!-- prt:inline
id: i1
post: true
subject: line
path: src/Main.java
line: 10
-->
**[BUG] npe**

body
<!-- /prt -->
`;
  const { text, promoted, refused } = promoteShorthand(f, { startOrdinal: 1 });
  assert.equal(text, f);
  assert.deepEqual(promoted, []);
  assert.match(refused[0].why, /the whole block/);
  // What the lift would otherwise have armed, for the record.
  const emptied = parseActionFile(f.replace('@ai rewrite the summary from scratch\n', ''));
  assert.deepEqual(emptied.errors, [], 'nothing else in the parser catches this');
  assert.equal(planActions(emptied).find((a) => a.kind === 'review').body, null);
});

test('a gap note and an in-block note in one file: neither is duplicated, both keep file order', () => {
  // The lift is a delete plus a zero-width insert after the block terminator. Fed
  // through a splice that sorted on `from` alone and assigned `cursor = rep.to`,
  // the insert's lower `to` rewound the cursor and the tail was emitted twice —
  // putting a raw `@ai` line back in the file, which trips the un-promoted error,
  // matches carryAsks' structural filter and wedges `prt draft`.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
@ai soften this

Real summary prose.
<!-- /prt -->
@ai and the verdict is too kind
`;
  const { text, promoted, refused } = promoteShorthand(f, { startOrdinal: 1, generation: 2 });
  assert.deepEqual(refused, []);
  assert.equal(text.split('\n').filter((l) => /^@ai/.test(l)).length, 0, 'no raw note survives');
  assert.equal(text.match(/Real summary prose\./g).length, 1, 'and no line is emitted twice');
  assert.deepEqual(
    promoted.map((p) => [p.id, p.line, p.lifted]), [['a1', 8, 'body'], ['a2', 12, null]],
    'ordinals run down the page, whichever kind of note came first',
  );
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.asks.map((a) => a.question), ['soften this', 'and the verdict is too kind']);
  // The lifted ask goes directly under its own block's terminator, ahead of the
  // gap note that was typed on the very next line. Both ops start on that line,
  // so only the splice's tie-break keeps them in this order.
  assert.ok(text.indexOf('soften this') < text.indexOf('and the verdict is too kind'), 'the lifted ask sits under its block');
  // …and separated from it. The two blocks used to be written with no blank
  // line between them, which parses but reads as one run-on block in the file
  // the human is about to edit.
  assert.doesNotMatch(text, /<!-- \/prt -->\n<!-- prt:ask/, 'a terminator is never butted against the next sentinel');
  // Only when one is needed: the blank the file already had is not doubled.
  assert.doesNotMatch(text, /\n\n\n/, 'and no blank line is doubled');
  // Idempotent: the second promote finds nothing left to do and changes nothing.
  assert.equal(promoteShorthand(text, { startOrdinal: 3, generation: 2 }).text, text);
});

test('a note is never lifted out of a block whose extent is a guess', () => {
  // The terminator is missing, so tokenize runs this body to the next sentinel.
  // Deleting a line by a line number derived from that span could take a byte
  // out of the block below instead.
  const f = `Status: draft

<!-- prt:body -->
Real summary.
@ai soften this

<!-- prt:context -->
context
<!-- /prt -->
`;
  const { text, promoted, refused } = promoteShorthand(f, { startOrdinal: 1 });
  assert.equal(text, f, 'the ask would otherwise be spliced in on the strength of a guessed endLine');
  assert.deepEqual(promoted, []);
  assert.deepEqual(refused, []);
  assert.match(parseActionFile(f).errors.join(' '), /missing its `<!-- \/prt -->` terminator/);
});

test('every kind that can be lifted out of is, and `prt:log` is the one that must not be', () => {
  // Set membership, not message prose: the message is the thing most likely to be
  // reworded, and a test that only reads it would let the log arm be deleted
  // silently. Both arms are pinned, because both changed here — every kind below
  // used to be "an error, full stop", and all but the log are now "an error until
  // promoted, then lifted".
  const openers = {
    body: '<!-- prt:body -->',
    inline: '<!-- prt:inline\nid: i1\npath: a\nline: 1\n-->',
    thread: '<!-- prt:thread\nid: t1\nthread: PRRT_x\nreply-to: 123\n-->',
    'issue-comment': '<!-- prt:issue-comment\nid: c1\n-->',
    context: '<!-- prt:context -->',
    notes: '<!-- prt:notes -->',
    // The note channel itself is liftable too. It was excluded on the claim that
    // a note there is "carried forward whole", which `carryAsks` disproves: an
    // answered pair retires to `history/`, so a second thought typed under an
    // answer was destroyed rather than carried.
    ask: '<!-- prt:ask\nid: a5\nre: general\n-->',
    answer: '<!-- prt:ask\nid: a5\nre: general\n-->\nThe question.\n<!-- /prt -->\n\n<!-- prt:answer\nto: a5\ndisposition: addressed\ndid: none\n-->',
  };
  // Every kind but `body` needs a body beside it, or the review is empty and the
  // parse error under test is drowned out by "no review body and no inline
  // comments".
  const file = (kind, opener) => `Status: draft
<!-- prt:verdict
event: COMMENT
-->
${kind === 'body' ? '' : '<!-- prt:body -->\nA summary that keeps the review postable.\n<!-- /prt -->\n'}${opener}
Real prose that must survive.
@ai lift me

<!-- /prt -->
`;

  for (const [kind, opener] of Object.entries(openers)) {
    const f = file(kind, opener);
    assert.match(parseActionFile(f).errors.join(' '), /an `@ai` note/, `${kind}: un-lifted, it is an error`);
    const { promoted, refused, text } = promoteShorthand(f, { startOrdinal: 1 });
    assert.deepEqual(refused, [], kind);
    assert.deepEqual(promoted.map((p) => p.lifted), [kind], `${kind}: and --promote lifts it out`);
    assert.deepEqual(parseActionFile(text).errors, [], kind);
  }

  // The log is machine territory, so the note stays put and the plain error stands.
  const log = file('log', '<!-- prt:log -->');
  const out = promoteShorthand(log, { startOrdinal: 1 });
  assert.equal(out.text, log, 'not one byte of the submitter own record moves');
  assert.deepEqual(out.promoted, []);
  assert.deepEqual(out.refused, [], 'and it is not a refusal either — the parse error is the whole story');
  assert.match(parseActionFile(log).errors.join(' '), /othing lifts a note out of `prt:log`/);

  // Pinned to the mechanism rather than to the set literal, so the exclusion
  // cannot be deleted as arbitrary: a lifted ask is emitted after its block's
  // terminator, and `contentHash` cuts the file at the `prt:log` sentinel — so a
  // note lifted out of the log would land below the cut and stop counting as
  // "the human edited this draft".
  const lifted = `${log.replace('@ai lift me\n\n', '')}\n<!-- prt:ask\nid: a1\nre: general\n-->\nlift me\n<!-- /prt -->\n`;
  assert.equal(
    contentHash(lifted), contentHash(lifted.replace('lift me', 'lift me now')),
    'below the log sentinel, editing the note moves no hash at all',
  );
});

// ---- the invariant: seen, then promoted or refused. Never silently ignored --
//
// **Any line a human could reasonably believe is an `@ai` note ends promoted or
// refused, in every location, under every decoration. Silence is the one
// forbidden outcome.**
//
// It was reached three times by narrowing. First the gap and the inside of a
// block were scanned by two different regexes and the gap's was the strict one,
// so `*@ai …` in a gap was reported by nothing — the maintainer's own note, in
// the one place it was not read. Then the notes nothing can LIFT (`prt:log`, a
// block's header) turned out to be outside the `prt draft` guard, which gated on
// what the lift refused instead of on what the scanner saw. Then an exhaustive
// probe found four families still silent in every one of their cells: a note
// inside a `prt:ask` or `prt:answer` body, an ordered-list note (`1. @ai …`,
// `1) @ai …`), a `+ @ai …` note, and a note inside a block whose sentinel or
// kind the human had broken mid-edit.
//
// Each of those was a hole one location or one decoration wide, and each was
// argued for on its own terms. The matrix below is the answer to that: the whole
// cross-product, walked, so no cell can be reopened one reasonable-sounding
// special case at a time.

/**
 * A file with exactly one note, at `where`, wearing `note`, sitting `placement`.
 *
 * The block order is a real draft's: doc, context, verdict, body, inline,
 * thread, notes, an answered ask pair, then the log — because several of the
 * things that go wrong are about what a note's neighbours are.
 */
function noteAt(where, note, placement = 'alone') {
  const at = (k) => (where === k ? note : null);
  const hdr = (kind, fields) => `<!-- prt:${kind}\n${fields}${at(`${kind}-header`) ? `${at(`${kind}-header`)}\n` : ''}-->`;
  // `sole` is the note as a block's whole content, `last` its final line,
  // `butted` with prose hard against it, `alone` in its own paragraph.
  const place = (inner) => {
    if (placement === 'sole') return note;
    if (placement === 'last') return `${inner}\n\n${note}`;
    if (placement === 'butted') return `${inner}\n${note}\nMore prose here.`;
    return `${inner}\n\n${note}\n\nMore prose here.`;
  };
  const bodyOf = (kind, inner) => (where === `${kind}-body` ? place(inner) : inner);
  const gapAt = (k) => {
    if (where !== k) return null;
    if (placement === 'butted') return `\nProse above.\n${note}\nProse below.\n`;
    if (placement === 'sole') return `\n${note}\n`;
    return `\n${note}\n\nTrailing gap prose.\n`;
  };
  const parts = [
    'Status: draft',
    '',
    hdr('doc', 'repo: apache/pulsar\npr: 1\nhead: abc123\n'),
    gapAt('gap-top'),
    `<!-- prt:context -->\n${bodyOf('context', 'Reviewer context.')}\n<!-- /prt -->`,
    gapAt('gap-mid'),
    hdr('verdict', 'event: COMMENT\n'),
    '',
    `<!-- prt:body -->\n${bodyOf('body', 'Real summary.')}\n<!-- /prt -->`,
    '',
    `${hdr('inline', 'id: i1\npost: true\nsubject: line\npath: src/Main.java\nline: 10\n')}\n${bodyOf('inline', '**[BUG] c**')}\n<!-- /prt -->`,
    '',
    `${hdr('thread', 'id: t1\npost: false\nthread: T_1\nreply-to: 9\n')}\n${bodyOf('thread', 'A reply.')}\n<!-- /prt -->`,
    gapAt('gap-after-posting'),
    `<!-- prt:notes -->\n${bodyOf('notes', 'Generator notes.')}\n<!-- /prt -->`,
    '',
    `${hdr('ask', 'id: a9\nre: body\nraised: g1\n')}\n${bodyOf('ask', 'The original question.')}\n<!-- /prt -->`,
    '',
    `${hdr('answer', 'to: a9\ndisposition: addressed\ndid: edit-body\nin: g1\n')}\n${bodyOf('answer', 'What I did about it.')}\n<!-- /prt -->`,
    '',
    // A block the human broke while typing: no terminator at all.
    where === 'unterminated' ? `<!-- prt:issue-comment\nid: c1\npost: false\n-->\n${place('An issue comment.')}\n` : null,
    // …and one whose opening sentinel never reaches its `-->`.
    where === 'malformed-sentinel' ? `<!-- prt:issue-comment\nid: c2\npost: false\n${note}\nSome body text.\n<!-- /prt -->\n` : null,
    // A kind nothing knows: far from any real one, and one typo away from one.
    where === 'unknown-kind' ? `<!-- prt:scratchpad -->\n${place('Scratch text.')}\n<!-- /prt -->\n` : null,
    where === 'typo-kind' ? `<!-- prt:note -->\n${place('Scratch text.')}\n<!-- /prt -->\n` : null,
    `<!-- prt:log -->\n${bodyOf('log', 'g1 drafted')}\n<!-- /prt -->`,
    gapAt('gap-end'),
  ];
  // `null` means "this location is not in play"; `''` is a blank line.
  return `${parts.filter((p) => p !== null).join('\n')}\n`;
}

// `unterminated` and `malformed-sentinel` name a broken block rather than a
// region, because a broken block has no reliable region: its body runs on to the
// next sentinel and its header swallows whatever follows.
const NOTE_LOCATIONS = [
  'gap-top', 'gap-mid', 'gap-after-posting', 'gap-end',
  'doc-header', 'inline-header',
  'context-body', 'body-body', 'inline-body', 'thread-body', 'notes-body',
  'ask-body', 'answer-body', 'log-body',
  'unterminated', 'malformed-sentinel', 'unknown-kind', 'typo-kind',
];
// Every CommonMark bullet and ordered marker, the blockquote and emphasis
// leaders, leading whitespace, and the combinations that come of typing a note
// into a quoted list. `+`, `1.` and `1)` are here because each was silent in all
// fourteen locations at once.
const NOTE_DECORATIONS = [
  '@ai please fix', '@ai: please fix', '@ai, please fix',
  '*@ai please fix', '_@ai please fix', '**@ai please fix',
  '> @ai please fix', '>@ai please fix', '> > @ai please fix',
  '- @ai please fix', '* @ai please fix', '+ @ai please fix',
  '1. @ai please fix', '1) @ai please fix', '12. @ai please fix',
  '  @ai please fix', '\t@ai please fix', '   - @ai please fix',
  '> - *@ai please fix', '> 1. @ai please fix', '  + @ai please fix',
  '- 1. @ai please fix',
];
const NOTE_PLACEMENTS = ['alone', 'butted', 'last', 'sole'];

/**
 * What became of the one note in `f`: `promoted`, `refused`, or `silent`.
 *
 * The four verdicts are the four things a human can observe, so a cell that
 * scores anything but `silent` is a cell where they were answered. `is-the-ask`
 * is the one outcome that needs the file to prove it: the note is not reported
 * because the `prt:ask` wrapped around it IS the promotion, and the proof is
 * that the ask's question is those very bytes.
 */
function fateOfNoteIn(f, note) {
  const scanned = unpromotedNotes(f);
  const errs = parseActionFile(f).errors.filter((e) => /`@ai`/.test(e));
  const { promoted, refused, text } = promoteShorthand(f, { startOrdinal: 1, generation: 2 });
  const lost = notesLostByRegenerating(text, refused);
  const asks = collectAsks(f).asks;
  if (!scanned.length && asks.some((a) => a.question.split('\n').includes(note))) {
    return { verdict: 'is-the-ask', scanned, errs, promoted, refused, lost, text };
  }
  if (promoted.length) return { verdict: 'promoted', scanned, errs, promoted, refused, lost, text };
  if (refused.length) return { verdict: 'refused-by-lift', scanned, errs, promoted, refused, lost, text };
  if (lost.length) return { verdict: 'refused-nothing-lifts', scanned, errs, promoted, refused, lost, text };
  return { verdict: 'silent', scanned, errs, promoted, refused, lost, text };
}

test('every note, in every location, under every decoration: promoted or refused, never silent', () => {
  const silent = [];
  let cells = 0;
  for (const where of NOTE_LOCATIONS) {
    for (const decoration of NOTE_DECORATIONS) {
      for (const placement of NOTE_PLACEMENTS) {
        cells++;
        const at = `${where} / ${JSON.stringify(decoration)} / ${placement}`;
        const f = noteAt(where, decoration, placement);
        const r = fateOfNoteIn(f, decoration);
        if (r.verdict === 'silent') { silent.push(at); continue; }

        // `is-the-ask` is the only verdict reached without a scanner row, and it
        // owes the file its proof rather than a claim: `fateOfNoteIn` has already
        // checked that a `prt:ask` in this file carries those exact bytes as its
        // question. Everything else must be named on its own line, once.
        if (r.verdict !== 'is-the-ask') {
          assert.equal(r.scanned.length, 1, `${at}: exactly one scanner row`);
          assert.equal(r.errs.length, 1, `${at}: and exactly one error names it`);
          assert.ok(r.scanned[0].remedy, `${at}: and the row carries a remedy`);
        }

        if (r.verdict === 'promoted') {
          const after = parseActionFile(r.text);
          assert.deepEqual(after.errors, [], `${at}: promoting clears the error`);
          // What must never survive the lift is the decoration itself.
          assert.equal(
            after.asks.find((a) => a.id === r.promoted[0].id).question.split('\n')[0], 'please fix',
            `${at}: decoration is not part of the note`,
          );
        } else if (r.verdict === 'refused-by-lift') {
          assert.equal(r.text, f, `${at}: a refusal moves nothing`);
          assert.ok(r.refused[0].line > 0 && r.refused[0].why, `${at}: and names a line and a reason`);
        } else if (r.verdict === 'refused-nothing-lifts') {
          assert.equal(r.text, f, `${at}: nothing is spliced where a splice would destroy state`);
          // The reason `prt draft` refuses with is the reason `prt ask` prints
          // beside the `!` row: one scanner, one remedy, no contradiction.
          assert.equal(r.lost[0].why, r.scanned[0].remedy, at);
        }
      }
    }
  }
  assert.deepEqual(silent, [], `${silent.length} of ${cells} cells silent`);
  assert.equal(cells, NOTE_LOCATIONS.length * NOTE_DECORATIONS.length * NOTE_PLACEMENTS.length);
});

test('a note lifted out of the note channel chains with `follows:`, not by position', () => {
  // The natural place to object to an answer is under it — and inside the block,
  // if that is where the cursor was. Position cannot bind that note: the nearest
  // preceding block with an id is whatever inline comment came last, which the
  // note was never about. `follows:` is the field that exists for ask-to-ask
  // chaining, and it is the only shape that reopens a closed conversation.
  //
  // The target it inherits is the chained ask's own — a9 in this file is
  // `re: body`, so the follow-up lands beside the body too. One rule for all
  // three ways of chaining (`follows a9`, `a9: …`, lifted out of a9's pair),
  // because they mean the same thing; see `chainTarget`.
  for (const where of ['ask-body', 'answer-body']) {
    const f = noteAt(where, '@ai NO. Put the flaky-test paragraph back before this posts.', 'last');
    const { promoted, text } = promoteShorthand(f, { startOrdinal: 1, generation: 2 });
    assert.deepEqual(promoted.map((p) => [p.re, p.follows, p.lifted]), [['body', 'a9', where.replace('-body', '')]], where);
    assert.equal(promoted[0].inferred, true, `${where}: the human did not name that target`);
    const raised = parseActionFile(text).asks.find((a) => a.id === 'a1');
    assert.equal(raised.question, 'NO. Put the flaky-test paragraph back before this posts.', where);
    assert.equal(raised.follows, 'a9', where);
    // And it reopens the submit gate the answered pair had closed.
    assert.deepEqual(blockingAsks(parseActionFile(text)).map((a) => a.id), ['a1'], where);
  }

  // An explicit target still wins over the chain, because the human named it.
  const explicit = noteAt('answer-body', '@ai i1: this comment is on the wrong line', 'last');
  const { promoted } = promoteShorthand(explicit, { startOrdinal: 1 });
  assert.deepEqual(promoted.map((p) => [p.re, p.follows]), [['i1', null]]);
});

test('naming an ask chains off it — it never binds as if the ask were a comment', () => {
  // `## Resolved notes` makes this the natural follow-up: the human reads an
  // answer at the foot of the file and types `@ai a1: not good enough`. `a1` is
  // a block with an id, so it bound `re: a1` — and the next `prt draft`, which
  // rebinds against the ids the NEW file will carry, found no comment `a1`,
  // orphaned the note to `re: gone  was: a1`, and hoisted it under a banner
  // saying the comment was posted and to check `outbox/`. It was never a
  // comment, and a1 was fifty lines down the same file.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
<!-- /prt -->

<!-- prt:inline
id: i1
post: true
subject: line
path: src/Main.java
line: 10
-->
**[BUG] c**
<!-- /prt -->

## Resolved notes

*a1 · addressed · edit-body · g1* — Done.

<!-- prt:ask
id: a1
re: i1
raised: g1
-->
drop this comment
<!-- /prt -->

<!-- prt:answer
to: a1
disposition: addressed
did: none
in: g1
-->
Done.
<!-- /prt -->

@ai a1: your answer here is not good enough, try again
`;
  const { promoted, text } = promoteShorthand(f, { startOrdinal: 2, generation: 2 });
  assert.deepEqual(promoted.map((p) => [p.re, p.follows]), [['i1', 'a1']]);
  const a2 = parseActionFile(text).asks.find((a) => a.id === 'a2');
  assert.equal(a2.question, 'your answer here is not good enough, try again');

  // And the regeneration that used to orphan it now has nothing to rebind.
  const carried = carryAsks(text, {
    newIds: new Set(['i1']),
    newAnchors: new Map([['i1', { path: 'src/Main.java', line: 10, side: 'RIGHT' }]]),
    generation: 3,
    ordinalFloor: 2,
  });
  assert.deepEqual(carried.changes, []);
  assert.deepEqual(carried.asks.map((a) => [a.id, a.re, a.was, a.follows]), [['a2', 'i1', null, 'a1']]);
});

test("a `prt:ask`'s own question is not a second note, because the block around it is the promotion", () => {
  // `pr-26433`'s ask a2 carries its leader verbatim — `*@ai Don't mention
  // anything about the tier level…` — because it was written before the leader
  // class tolerated decoration. Those words were collected, handed to the model
  // and answered. Reporting them as an un-promoted note would be the tool
  // claiming a loss that demonstrably did not happen, and `--promote` would then
  // try to lift the ask's only line out of the ask.
  const f = noteAt('ask-body', "*@ai Don't mention anything about the tier level.", 'sole');
  assert.deepEqual(unpromotedNotes(f), []);
  assert.deepEqual(parseActionFile(f).errors.filter((e) => /`@ai`/.test(e)), []);
  assert.equal(promoteShorthand(f, { startOrdinal: 1 }).text, f, 'and nothing is spliced');
  assert.equal(
    collectAsks(f).asks.find((a) => a.id === 'a9').question,
    "*@ai Don't mention anything about the tier level.",
    'the words are the question — that is what "already promoted" means here',
  );

  // Only the opening line. A second thought typed under a question that has
  // already been answered is never re-read, and `carryAsks` retires the pair to
  // history/ two generations later — so it is scanned like any other note.
  const second = noteAt('ask-body', '@ai and also drop inline 3', 'last');
  assert.deepEqual(unpromotedNotes(second).map((n) => [n.where, n.region]), [['ask', 'body']]);
});

test('a note in a block the human broke mid-edit stops the regeneration that would destroy it', () => {
  // Breaking a sentinel while hand-editing is the single most likely way a human
  // damages an action file, and it is exactly when they are mid-thought. Both
  // shapes used to be skipped by the scanner outright, so `notesLostByRegenerating`
  // returned nothing and `prt draft` overwrote the note at exit 0.
  for (const [where, pattern] of [
    ['unterminated', /has no `<!-- \/prt -->`/],
    ['malformed-sentinel', /sentinel at line \d+ never closes with `-->`/],
    ['unknown-kind', /`prt:scratchpad` is not a block kind this tool knows/],
    ['typo-kind', /`prt:note` is not a block kind this tool knows/],
  ]) {
    const f = noteAt(where, '@ai this must not be lost');
    const seen = unpromotedNotes(f);
    assert.equal(seen.length, 1, where);
    assert.equal(seen[0].liftable, false, `${where}: and a splice there could delete the wrong lines`);
    assert.match(seen[0].remedy, pattern, where);

    // The guard both `prt draft` and `prt nudge` read.
    const { text, refused } = promoteShorthand(f, { startOrdinal: 1 });
    assert.equal(text, f, `${where}: nothing is spliced`);
    const lost = notesLostByRegenerating(text, refused);
    assert.deepEqual(lost.map((l) => l.line), [seen[0].line], where);
    assert.match(lost[0].why, pattern, where);
    // And the same sentence reaches `prt validate`.
    assert.match(parseActionFile(f).errors.join('\n'), pattern, where);
  }
});

test('a note in a block header is reported, because that is where the file itself drops it', () => {
  // The most completely lost of the lot: `parseSentinelFields` keeps
  // `key: value` and discards the rest, so a note typed between
  // `<!-- prt:inline` and its `-->` left no field, no body and no gap line —
  // nothing anywhere to report it from. It is error-only on purpose: a splice
  // inside a sentinel is how a block loses its `id:` or its `post:`.
  const f = noteAt('inline-header', '@ai this comment is about the wrong line');
  const err = parseActionFile(f).errors.find((e) => /`@ai`/.test(e));
  assert.match(err, /inside the block's header, where it is read as a field and dropped/);
  assert.match(err, /Move it below the `-->`/);
  const { text, promoted, refused } = promoteShorthand(f, { startOrdinal: 1 });
  assert.equal(text, f, 'and the sentinel is not spliced');
  assert.deepEqual([promoted, refused], [[], []]);

  // The header of every kind is scanned, `prt:ask`'s and `prt:doc`'s included:
  // nothing anywhere reads a non-field line out of a sentinel.
  const inDoc = MINIMAL.replace('head: abc123', 'head: abc123\n@ai regenerate against the new head');
  assert.match(parseActionFile(inDoc).errors.join(' '), /inside the block's header/);

  // A real field line is still a field, not a note.
  assert.deepEqual(parseActionFile(MINIMAL).errors, []);
  assert.equal(parseActionFile(MINIMAL).doc.head, 'abc123');
});

test('the regeneration guard covers the notes nothing can lift, not only the ones it refused', () => {
  // `prt draft` and `prt nudge` overwrite the working copy, and `carryAsks`
  // carries `prt:ask` blocks and nothing else. Gating that on `refused` alone
  // left a hole exactly where it mattered most: the lift never looks inside
  // `prt:log` or a block's header, so those two — the notes nothing can rescue —
  // were the ones the guard could not see, and `prt draft` regenerated over them
  // at exit 0.
  const withLogNote = `${MINIMAL}
<!-- prt:log -->
g1 drafted
@ai why did this take two rounds
<!-- /prt -->
`;
  const promotedLog = promoteShorthand(withLogNote, { startOrdinal: 1 });
  assert.deepEqual(promotedLog.refused, [], 'the lift does not even look here');
  const lostLog = notesLostByRegenerating(promotedLog.text, promotedLog.refused);
  assert.deepEqual(lostLog.map((r) => [r.where, r.region]), [['log', 'body']]);
  assert.match(lostLog[0].why, /nothing lifts a note out of `prt:log`/);

  const lostHeader = notesLostByRegenerating(noteAt('inline-header', '@ai wrong line'));
  assert.deepEqual(lostHeader.map((r) => [r.where, r.region]), [['inline', 'header']]);

  // A note the lift DID refuse keeps the lift's own reason, which is the one
  // thing the scanner cannot know.
  const butted = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
@ai soften this
More prose.
<!-- /prt -->
`;
  const p = promoteShorthand(butted, { startOrdinal: 1 });
  const lost = notesLostByRegenerating(p.text, p.refused);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].why, p.refused[0].why);

  // And a file whose notes all promoted has nothing left to lose.
  const clean = promoteShorthand(MINIMAL + '\n@ai soften the summary\n', { startOrdinal: 1 });
  assert.deepEqual(notesLostByRegenerating(clean.text, clean.refused), []);
});

test('a note in a gap is read exactly as one inside a block is, decoration and all', () => {
  // The real note, in the place it was NOT seen before: a gap.
  const f = MINIMAL + "\n*@ai Don't mention anything about the tier level.\n";
  assert.match(parseActionFile(f).errors.join(' '), /un-promoted/);
  const { promoted, text } = promoteShorthand(f, { startOrdinal: 1, generation: 3 });
  assert.deepEqual(promoted.map((p) => [p.re, p.lifted]), [['body', null]]);
  assert.equal(parseActionFile(text).asks[0].question, "Don't mention anything about the tier level.");
});

test('`@ai` is a whole token, so a handle that merely starts with it is never a note', () => {
  // `@ai\b` matched at a hyphen and at a dot. That was not only a wrong flag: a
  // `> @ai-worker …` line quoted in a prt:body and fenced by a blank line was
  // DELETED by the lift, out of bytes the format promises to post verbatim, and
  // reported as a success.
  const quoting = (line) => `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
The author quoted this from the CI log:

${line}

So the retry never fired.
<!-- /prt -->
`;
  for (const l of ['> @ai-worker started at 12:04', '- @ai-reviewer flagged this too',
    '@ai-generated code, per AGENTS.md', '  @ai.assistant@example.com wrote',
    '@aider rewrote the method', '@ai_bot left this']) {
    const f = quoting(l);
    assert.deepEqual(parseActionFile(f).errors, [], l);
    const { promoted, refused, text } = promoteShorthand(f, { startOrdinal: 1 });
    assert.deepEqual([promoted, refused], [[], []], l);
    assert.ok(parseActionFile(text).body.includes(l.trim()), `${l}: and the quoted line still posts`);
  }
  // The separators a human actually types after the token all still read.
  for (const l of ['@ai soften this', '@ai: soften this', '@ai, soften this']) {
    assert.equal(promoteShorthand(quoting(l), { startOrdinal: 1 }).promoted.length, 1, l);
  }
});

test('the leader class is markdown decoration and nothing else, and it terminates', () => {
  // The leader is now exactly what `LIST_ITEM` calls an opener, plus `>` and `_`.
  // Widening it is what let `1. @ai …`, `1) @ai …` and `+ @ai …` be heard at all —
  // each was silent in every location, gaps included, because the file's model of
  // "list item" and its model of "note" disagreed about the same three markers.
  for (const l of ['@ai fix', '+ @ai fix', '1. @ai fix', '1) @ai fix', '12. @ai fix',
    '1.@ai fix', '- 1. @ai fix', '> 1. @ai fix', '   \t> * + 3) _@ai fix']) {
    assert.ok(NOTE_LINE.test(l), `${JSON.stringify(l)} is a note`);
  }
  // And nothing else gets in. `@ai` after a word is prose, and a line that merely
  // opens a numbered list is a numbered list.
  for (const l of ['`@ai` is the token', 'Note: @ai fix', 'see @ai for more',
    '1. an ordinary numbered item', '+++ b/src/Main.java', '2026. was the year']) {
    assert.ok(!NOTE_LINE.test(l), `${JSON.stringify(l)} is not a note`);
  }

  // The ordered-marker alternative sits inside a `*` loop, which is where a
  // catastrophic backtracker would live. Every input below is a leader that never
  // reaches the token, so the engine must exhaust the loop and give up.
  for (const unit of ['1.', '12345678.', '> - ', '9', '1.1']) {
    const s = `${unit.repeat(Math.ceil(20000 / unit.length)).slice(0, 20000)}x`;
    const t0 = process.hrtime.bigint();
    NOTE_LINE.test(s);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 250, `${JSON.stringify(unit)} x20000 took ${ms.toFixed(1)}ms`);
  }
});

test('a bulleted note is lifted, because the next item cannot be the rest of it', () => {
  // `- @ai …` is a form the docs advertise and the natural one to type while
  // reading a bulleted body — and it is by construction butted against the next
  // item, so the one-line rule refused every one of them. A sibling item settles
  // the only question that rule asks: where the note ends.
  const mk = (body) => `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
${body}
<!-- /prt -->
`;
  const middle = promoteShorthand(mk('- item one\n- @ai soften this\n- item three'), { startOrdinal: 1 });
  assert.deepEqual(middle.refused, []);
  assert.equal(parseActionFile(middle.text).asks[0].question, 'soften this');
  assert.equal(parseActionFile(middle.text).body, '- item one\n- item three', 'the list closes up around it');

  const first = promoteShorthand(mk('- @ai soften this\n- item two\n- item three'), { startOrdinal: 1 });
  assert.equal(parseActionFile(first.text).body, '- item two\n- item three');

  // An OUTDENTED item ends the note's item too; a DEEPER one may be its child.
  const outdent = promoteShorthand(mk('- item one\n  - @ai soften this\n- item three'), { startOrdinal: 1 });
  assert.deepEqual(outdent.refused, []);
  assert.equal(parseActionFile(outdent.text).body, '- item one\n- item three');
  const nested = promoteShorthand(mk('- item one\n- @ai soften this\n  - a nested point'), { startOrdinal: 1 });
  assert.deepEqual(nested.promoted, [], 'a child item could be part of the note, so this stays refused');
  assert.equal(nested.refused.length, 1);

  // And the rule needs the NOTE to be an item as well: bullets under a note that
  // is not one are the note's own, and taking only the first line would truncate
  // the human's instruction into the review.
  const bulletsBelow = promoteShorthand(mk('Real summary.\n\n@ai please:\n- do X\n- do Y'), { startOrdinal: 1 });
  assert.deepEqual(bulletsBelow.promoted, []);
  assert.equal(bulletsBelow.refused.length, 1);
});

test('a bulleted note in a gap stops at its sibling item instead of swallowing it', () => {
  // In a gap a note runs to the end of its paragraph, which is free because no
  // gap line is posted — but it is not free to the note, which would arrive at
  // the model carrying two bullets the human never meant to say.
  const f = `${MINIMAL}
## Notes

- keep this bullet
- @ai soften the summary
- and keep this one
`;
  const { promoted, text } = promoteShorthand(f, { startOrdinal: 1 });
  assert.equal(promoted.length, 1);
  assert.equal(parseActionFile(text).asks[0].question, 'soften the summary');
  assert.match(text, /- keep this bullet/);
  assert.match(text, /- and keep this one/);
});

test('the refusal names a remedy the human can actually apply', () => {
  // It used to end "put a blank line after the note, or fold it onto one line" —
  // and a note is exactly one line by rule, so half the advice could never apply
  // to this refusal. The reading it never covered is the one that matters: the
  // line was never a note, and backticks are how you say so.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
@ai soften this
The naming is off — see below.
<!-- /prt -->
`;
  const { refused } = promoteShorthand(f, { startOrdinal: 1 });
  assert.equal(refused.length, 1);
  assert.doesNotMatch(refused[0].why, /fold it onto one line/);
  assert.match(refused[0].why, /blank line after the note/);
  assert.match(refused[0].why, /backticks/);
});

test('on an armed file the remedy names the precondition it would otherwise trip over', () => {
  // The likeliest moment to type a note is while reading a file that is already
  // armed — and `prt ask --promote` refuses to rewrite one. The remedy named
  // `--promote` regardless, so the first thing the human was told to do was the
  // thing that would refuse them, with the precondition mentioned nowhere.
  const f = (status) => `Status: ${status}

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
@ai soften this

<!-- /prt -->
`;
  for (const status of ['draft', 'hold']) {
    assert.doesNotMatch(unpromotedNotes(f(status))[0].remedy, /Status: draft/, status);
  }
  for (const status of ['ready', 'queued', 'partial', 'skip']) {
    const row = unpromotedNotes(f(status))[0];
    assert.match(row.remedy, /set `Status: draft` first/, status);
    assert.match(row.remedy, new RegExp(`not rewrite a "${status}" file`), status);
    // One scanner, one remedy: the parse error `prt validate` prints carries it too.
    assert.match(parseActionFile(f(status)).errors.find((e) => /`@ai`/.test(e)), /set `Status: draft` first/, status);
  }
});

test('the remedy the refusal leads with does not post the note it was refusing to lift', () => {
  // The refusal used to lead with "put a blank line after the note". Follow that
  // on the case the reference doc singles out — `@ai please:` and the bullets
  // that say what to please do — and the blank fences the note at its first
  // line: the lift takes `please:`, the bullets stay in the body, and the
  // human's private instruction is POSTED, with no refusal and a clean parse. A
  // remedy that causes the harm the tool exists to prevent is worse than none,
  // so the remedy is asserted here by EXECUTION, not by wording.
  const mk = (body, tail = '') => `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
${body}
<!-- /prt -->
${tail}`;
  const postedAfterPromote = (src) => parseActionFile(promoteShorthand(src, { startOrdinal: 1 }).text).body ?? '';
  const askedAfterPromote = (src) => parseActionFile(promoteShorthand(src, { startOrdinal: 1 }).text).asks.map((a) => a.question);

  // Reading one: a note whose bullets belong to it.
  const typed = mk('Some prose.\n\n@ai please:\n- do X\n- do Y\n\nMore prose.');
  const { refused } = promoteShorthand(typed, { startOrdinal: 1 });
  assert.equal(refused.length, 1);

  // What the OLD remedy did, kept as the reason this test exists.
  const blanked = mk('Some prose.\n\n@ai please:\n\n- do X\n- do Y\n\nMore prose.');
  assert.match(postedAfterPromote(blanked), /do X/, 'a blank line alone would post the bullets');

  // What the remedy the message now LEADS with does, on the same note.
  const moved = mk('Some prose.\n\nMore prose.', '\n@ai please:\n- do X\n- do Y\n');
  assert.deepEqual(askedAfterPromote(moved), ['please:\n- do X\n- do Y'], 'the whole note reaches the model');
  assert.equal(postedAfterPromote(moved), 'Some prose.\n\nMore prose.', 'and none of it reaches GitHub');

  // Reading two: a bulleted note with a nested child. `endsListItem` does not
  // fence a deeper item, so this trips the same refusal — and the message must
  // not call that line "prose", because it is not.
  const nested = mk('Some prose.\n\n- @ai drop this and the nested detail\n  - nested detail\n\nMore prose.');
  assert.equal(promoteShorthand(nested, { startOrdinal: 1 }).refused.length, 1);
  assert.doesNotMatch(refused[0].why, /is prose/);
  const nestedMoved = mk('Some prose.\n\nMore prose.', '\n- @ai drop this and the nested detail\n  - nested detail\n');
  assert.deepEqual(
    askedAfterPromote(nestedMoved),
    ['drop this and the nested detail\n  - nested detail'],
    'moving it out carries the child with it here too',
  );
  assert.equal(postedAfterPromote(nestedMoved), 'Some prose.\n\nMore prose.');

  // And the message says which remedy is which, so the human chooses knowing.
  assert.match(refused[0].why, /out of the block into a gap/);
  assert.match(refused[0].why, /FIRST LINE ONLY/);
  assert.match(refused[0].why, /backticks/);
});

test('the parser and the promote report name the same line for the same note', () => {
  // `prt validate` anchored on the block's opening sentinel and `prt ask
  // --promote` on the note's own line, so one file with one note produced two
  // outputs that read as if they were about two different notes.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.

Another paragraph.
@ai soften this
More prose.
<!-- /prt -->
`;
  const err = parseActionFile(f).errors.find((e) => /`@ai`/.test(e));
  const { refused } = promoteShorthand(f, { startOrdinal: 1 });
  assert.match(err, new RegExp(`at line ${refused[0].line}:`));
  assert.equal(unpromotedNotes(f)[0].line, refused[0].line);
});

test('two notes in one block are two errors, because they are two lines to go and fix', () => {
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.

@ai soften this

@ai and drop the last inline

Closing prose.
<!-- /prt -->
`;
  assert.equal(parseActionFile(f).errors.filter((e) => /`@ai`/.test(e)).length, 2);
  assert.equal(promoteShorthand(f, { startOrdinal: 1 }).promoted.length, 2);
});

test('a second review body is an error rather than silently replacing the first', () => {
  const f = MINIMAL + '\n<!-- prt:body -->\nA revised summary I pasted below the original.\n<!-- /prt -->\n';
  assert.match(parseActionFile(f).errors.join(' '), /a second .*prt:body/);
});

test('a BOM on line 1 does not hide the gate or duplicate the status line', () => {
  const withBom = '\uFEFF' + MINIMAL;
  assert.equal(parseStatus(withBom), 'draft');
  const armed = setStatus(withBom, 'ready');
  assert.equal(armed.split('\n').filter((l) => /^\uFEFF?Status:/.test(l)).length, 1);
  assert.equal(parseStatus(armed), 'ready');
});

test('a note reproduced in full is caught even when it is under twelve words', () => {
  const note = 'do not mention the netty regression it is embargoed';
  const f = WITH_ASK
    .replace('this one is wrong, the null check is upstream', note)
    .replace('Summary text.', 'Also: ' + note + '.');
  const hits = askQuoteLint(parseActionFile(f));
  assert.equal(hits.length, 1, 'a ten-word note pasted verbatim is still a paste');
});

test('a note written mostly in backticks is still caught', () => {
  const note = 'the \`assertion\` in \`testFoo\` is \`bogus\` and the \`author\` told me \`privately\`';
  const f = WITH_ASK
    .replace('this one is wrong, the null check is upstream', note)
    .replace('Summary text.', note);
  assert.ok(askQuoteLint(parseActionFile(f)).length > 0, 'code spans must not hide a verbatim paste');
});

test('a follows chain is lifted off the shorthand', () => {
  const f = MINIMAL + '\n@ai follows a5 still not convinced, the clamp moved\n';
  const { promoted } = promoteShorthand(f, { startOrdinal: 6, generation: 3 });
  assert.equal(promoted[0].follows, 'a5');
});

// ---- the tokenizer hazard --------------------------------------------------

test('an unterminated sentinel never swallows the block below it', () => {
  // The closing --> is missing from the ask. Before the guard, the scan ran on
  // to the inline's -->, absorbed its id/path/line as the ask's own fields and
  // its text as the ask's body — and the armed inline comment vanished with no
  // error at all.
  const f = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:ask
id: a1
re: general

a note whose sentinel is broken
<!-- /prt -->

<!-- prt:inline
id: i1
post: true
subject: line
path: src/Main.java
line: 10
-->
**[BUG] a real finding that must not disappear**
<!-- /prt -->
`;
  const kinds = tokenize(f).map((b) => b.kind);
  assert.ok(kinds.includes('inline'), 'the inline block must still be seen');
  const p = parseActionFile(f);
  assert.match(p.errors.join(' '), /missing its/);
});

// ---- the resolved-note log --------------------------------------------------

/** A note, its answer, and the `<details>` envelope today's generator wraps a closed pair in. */
const RESOLVED = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body
post: true
-->
Summary text.
<!-- /prt -->

<details><summary>ask a1 — addressed</summary>

<!-- prt:ask
id: a1
re: body
raised: g1
-->
drop the wire-protocol section
<!-- /prt -->

<!-- prt:answer
to: a1
disposition: addressed
did: edit-body
in: g1
-->
Deleted it, and the analysis is kept under "Considered and dropped".

The verdict still stands, but on a narrower base, so read i2 before you arm it.
<!-- /prt -->

</details>

## Inline comments

<details><summary>What I said</summary>

an unrelated disclosure block

</details>
`;

test('an answered note moves to the log at the end, verbatim and with its answer', () => {
  const { text, moved, skipped, refused } = relocateResolvedAsks(RESOLVED);
  assert.equal(refused, null);
  assert.deepEqual(skipped, []);
  assert.deepEqual(moved, [{ id: 'a1', state: 'addressed' }]);

  // The pair is one contiguous slice of the original file, byte for byte: the
  // question is the human's words and the answer is the model's, and neither is
  // re-rendered on the way.
  const span = RESOLVED.slice(RESOLVED.indexOf('<!-- prt:ask'), RESOLVED.indexOf('</details>'));
  assert.ok(text.includes(span.trimEnd()), 'the ask and its answer moved as one verbatim block');
  assert.match(text, /## Resolved notes/);
  assert.ok(text.indexOf('## Resolved notes') > text.indexOf('## Inline comments'), 'at the end');
  assert.equal(text.slice(0, text.indexOf('## Resolved notes')).includes('drop the wire-protocol section'), false,
    'and nothing is left behind where it was');
});

test('relocation strands no `<details>` wrapper, and leaves unrelated ones alone', () => {
  const { text } = relocateResolvedAsks(RESOLVED);
  assert.equal((text.match(/<details><summary>ask /g) ?? []).length, 0, 'no orphaned opener');
  assert.equal((text.match(/<\/details>/g) ?? []).length, 1, 'no orphaned closer');
  assert.ok(text.includes('<details><summary>What I said</summary>'), 'a disclosure block that is not a note survives');
  assert.deepEqual(parseActionFile(text).errors, []);

  // Half a wrapper is not a wrapper. A pair that merely happens to sit above
  // somebody else's `</details>` must not take that line with it — dropping it
  // would orphan an opener that had nothing to do with the note.
  const bare = RESOLVED.replace('<details><summary>ask a1 — addressed</summary>\n\n', '');
  const r = relocateResolvedAsks(bare);
  assert.deepEqual(r.moved, []);
  assert.equal(r.text, bare, 'unchanged');
  assert.match(r.skipped[0].why, /wrapper is unbalanced/);
});

test('a `## ` heading inside a body is the human\'s markdown, not this log\'s', () => {
  // A review summary that quotes this section's own heading would otherwise be
  // found as the destination, and the pairs spliced into the middle of text
  // bound for the PR. The heading is only a section boundary where it is gap
  // text, which is the one place nothing posts.
  const quoting = MINIMAL.replace('Summary text.', 'Summary text.\n\n## Resolved notes\n\nThe rename left this stale.') + `
<!-- prt:ask
id: a1
re: body
raised: g1
-->
q
<!-- /prt -->

<!-- prt:answer
to: a1
disposition: addressed
did: edit-body
in: g1
-->
Done.
<!-- /prt -->
`;
  const before = parseActionFile(quoting);
  const { text, moved } = relocateResolvedAsks(quoting);
  const after = parseActionFile(text);
  assert.deepEqual(moved, [{ id: 'a1', state: 'addressed' }]);
  assert.equal(after.body, before.body, 'not one byte was spliced into the posted summary');
  assert.equal(payloadHash(after), payloadHash(before));
  // The log was CREATED past the end of the body, not found inside it: its
  // heading is the last one in the file and the moved pair follows it.
  assert.equal((text.match(/^## Resolved notes$/gm) ?? []).length, 2, 'the body keeps its own copy');
  assert.ok(text.lastIndexOf('## Resolved notes') > text.indexOf('Summary text.'));
  assert.ok(text.lastIndexOf('<!-- prt:ask') > text.lastIndexOf('## Resolved notes'));
});

test('relocation changes where a note lives, never what any of it says', () => {
  const before = parseActionFile(RESOLVED);
  const { text } = relocateResolvedAsks(RESOLVED);
  const after = parseActionFile(text);
  assert.deepEqual(after.errors, before.errors);
  assert.deepEqual(after.warnings, before.warnings);
  // The approved payload is the thing that must not move at all.
  assert.equal(payloadHash(after), payloadHash(before));
  const shape = (t) => collectAsks(t).asks.map((a) => [a.id, a.re, a.state, a.open, a.question]);
  assert.deepEqual(shape(text), shape(RESOLVED));
  // Answer order is load-bearing: `askState` and `carryAsks` both take the LAST
  // answer via `.pop()`, so a move that reshuffled them would flip a state.
  const answers = (t) => parseActionFile(t).answers.map((a) => [a.to, a.disposition, a.in, a.body]);
  assert.deepEqual(answers(text), answers(RESOLVED));
});

test('a second tidy is a byte-for-byte no-op, and never a second heading', () => {
  const once = relocateResolvedAsks(RESOLVED).text;
  const twice = relocateResolvedAsks(once);
  assert.equal(twice.text, once);
  assert.deepEqual(twice.moved, []);
  assert.equal((once.match(/^## Resolved notes$/gm) ?? []).length, 1);
});

test('a later answered note is appended to the existing log, in resolution order', () => {
  const first = relocateResolvedAsks(RESOLVED).text;
  const second = first.replace('## Inline comments', `<!-- prt:ask
id: a2
re: body
raised: g2
-->
and this one
<!-- /prt -->

<!-- prt:answer
to: a2
disposition: declined
in: g2
-->
Kept it: the claim holds.
<!-- /prt -->

## Inline comments`);
  const { text, moved } = relocateResolvedAsks(second);
  assert.deepEqual(moved.map((m) => m.id), ['a2']);
  assert.equal((text.match(/^## Resolved notes$/gm) ?? []).length, 1);
  assert.deepEqual([...text.matchAll(/^id: (a\d+)$/gm)].map((m) => m[1]), ['a1', 'a2']);
  assert.deepEqual(parseActionFile(text).errors, []);
});

test('the log sits above the activity log, so appendLog still writes into its own block', () => {
  const { text } = relocateResolvedAsks(appendLog(RESOLVED, 'drafted'));
  const lines = text.split('\n');
  assert.ok(lines.indexOf('## Resolved notes') < lines.findIndex((l) => /^<!-- prt:log/.test(l)));

  // `appendLog` splices at the FIRST `<!-- /prt -->` after the log sentinel. A
  // note below that sentinel would own that terminator, and the timestamped
  // entry would land inside the human's note instead of in the log.
  const logged = parseActionFile(appendLog(text, 'posted the review'));
  assert.deepEqual(logged.errors, []);
  assert.ok(logged.log.join('\n').includes('posted the review'));
  assert.ok(!logged.asks.some((a) => a.question.includes('posted the review')));
});

test('the log is not inside prt:log, because a note cannot survive there', () => {
  // Three mechanics, one fixture: tokenize has no nesting, so the ask ends the
  // log block; the file then refuses to parse at all.
  const nested = MINIMAL + `
<!-- prt:log -->

## Activity log

<!-- prt:ask
id: a1
re: body
-->
a note
<!-- /prt -->

<!-- /prt -->
`;
  assert.match(parseActionFile(nested).errors.join(' '), /prt:log --> at line \d+ is missing its/);
  // And the note would fall outside the hash that records "the human edited this".
  assert.equal(contentHash(nested), contentHash(nested.replace('a note', 'a different note')));
});

test('relocation refuses on a file whose blocks do not close', () => {
  const broken = RESOLVED.replace('Summary text.\n<!-- /prt -->', 'Summary text.');
  const r = relocateResolvedAsks(broken);
  assert.equal(r.text, broken, 'unchanged');
  assert.deepEqual(r.moved, []);
  assert.match(r.refused, /prt:body --> at line \d+ is not terminated/);
});

test('two blocks claiming one id are not a pair this knows how to move', () => {
  // Which of the two is "the" note is not a question a byte move can answer, and
  // moving one of them would split a duplicate the parser is already shouting
  // about. Both are left alone, and the skip names the reason rather than
  // leaving "nothing to file" to stand in for it.
  const twins = RESOLVED.replace('<!-- prt:answer', '<!-- prt:ask\nid: a1\nre: body\nraised: g1\n-->\nsecond, same id\n<!-- /prt -->\n\n<!-- prt:answer');
  const r = relocateResolvedAsks(twins);
  assert.equal(r.text, twins, 'unchanged');
  assert.deepEqual(r.moved, []);
  assert.ok(r.skipped.every((s) => /2 blocks claim that id/.test(s.why)), JSON.stringify(r.skipped));
  assert.match(parseActionFile(twins).errors.join(' '), /duplicate id "a1"/);
});

test('a pair with the human\'s words between the note and its answer is left where it is', () => {
  const stray = RESOLVED.replace('<!-- /prt -->\n\n<!-- prt:answer', '<!-- /prt -->\n\nstill thinking about this\n\n<!-- prt:answer');
  const r = relocateResolvedAsks(stray);
  assert.equal(r.text, stray, 'a move that cannot be proved lossless does not happen');
  assert.deepEqual(r.moved, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /sits between the note and its answer/);
});

/** The real pr-26433 shape: two answered notes, hand-placed with reversed ordinals. */
const TWO_RESOLVED = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body
post: true
-->
Summary text.
<!-- /prt -->

<!-- prt:ask
id: a2
re: body
raised: g1
-->
drop the tier level from the summary
<!-- /prt -->

<!-- prt:answer
to: a2
disposition: addressed
did: edit-body
in: g1
-->
Swept it out of everything that posts.
<!-- /prt -->

<!-- prt:ask
id: a1
re: body
raised: g1
-->
no wire-protocol compatibility across 5.0.0-Mx
<!-- /prt -->

<!-- prt:answer
to: a1
disposition: addressed
did: drop-inline i1
in: g1
-->
Dropped inline 1 and the summary section with it.
<!-- /prt -->

## Inline comments

<!-- prt:inline
id: i1
post: false
dropped-by: a1
subject: line
path: src/Main.java
line: 10
-->
**[BUG] c**
<!-- /prt -->
`;

test('two notes filed in one run keep the order they were written in, not the order of their ids', () => {
  // The real file this was built against has a2 above a1: the human answered the
  // second note first and hand-placed the pairs in the order they read. The log
  // is the only feedback on where a note went, so it follows the page, not the
  // ordinals — the same file-order rule `promoteShorthand` assigns ordinals by.
  const { text, moved } = relocateResolvedAsks(TWO_RESOLVED);
  assert.deepEqual(moved.map((m) => m.id), ['a2', 'a1']);
  const section = text.slice(text.search(/^## Resolved notes$/m));
  assert.deepEqual([...section.matchAll(/^id: (a\d+)$/gm)].map((m) => m[1]), ['a2', 'a1']);
  assert.deepEqual([...section.matchAll(/^\*(a\d+) · /gm)].map((m) => m[1]), ['a2', 'a1'],
    'each handling line still sits above its own pair');
  assert.deepEqual(parseActionFile(text).errors, []);
  // Both pairs left, and neither was copied rather than moved.
  assert.equal(text.slice(0, text.search(/^## Resolved notes$/m)).includes('<!-- prt:ask'), false);
});

test('a filed pair takes the blank line that followed it, but never one holding prose apart', () => {
  // Same rule, and the same reason, as a lifted `@ai` note: a pair fenced by
  // blank lines on both sides takes one with it so the seam closes up, and a
  // pair butted straight under prose leaves the blank behind, because there it
  // is the separator for whatever comes next. Getting this wrong welds two
  // paragraphs of the human's own text together — a change to bytes that are
  // nothing to do with the note.
  const fenced = relocateResolvedAsks(TWO_RESOLVED).text;
  assert.match(fenced, /Summary text\.\n<!-- \/prt -->\n\n## Inline comments\n/,
    'exactly one blank line where the two pairs used to be, not three');

  // Butt the whole run of pairs up against the body's terminator. The blank line
  // BELOW them now separates the heading from the block above, so taking it
  // welds `## Inline comments` onto `<!-- /prt -->` and the heading stops being
  // a heading.
  const butted = TWO_RESOLVED.replace('<!-- /prt -->\n\n<!-- prt:ask\nid: a2', '<!-- /prt -->\n<!-- prt:ask\nid: a2')
    .replace('<!-- /prt -->\n\n<!-- prt:ask\nid: a1', '<!-- /prt -->\n<!-- prt:ask\nid: a1');
  assert.match(relocateResolvedAsks(butted).text, /Summary text\.\n<!-- \/prt -->\n\n## Inline comments\n/,
    'the blank under a butted pair belongs to what follows it, not to the pair');
});

test('an open or deferred note stays beside its target; only !open moves', () => {
  const deferred = RESOLVED.replace('disposition: addressed', 'disposition: deferred');
  assert.deepEqual(relocateResolvedAsks(deferred).moved, [], 'deferred is still live work');
  const open = RESOLVED.replace(/<!-- prt:answer[\s\S]*?<!-- \/prt -->\n/, '');
  assert.deepEqual(relocateResolvedAsks(open).moved, []);
  // withdrawn has no answer at all, and still moves.
  const withdrawn = open.replace('raised: g1', 'raised: g1\nclosed: yes');
  assert.deepEqual(relocateResolvedAsks(withdrawn).moved, [{ id: 'a1', state: 'withdrawn' }]);
});

test('the handling line is derived from the disposition and the answer, not invented', () => {
  const p = parseActionFile(RESOLVED);
  const line = askHandlingLine(p.asks[0], p.answers);
  assert.match(line, /^\*a1 · addressed · edit-body · g1\* — /);
  // The LAST paragraph: an answer closes with what the human still has to weigh.
  assert.match(line, /read i2 before you arm it/);
  assert.equal(line.includes('\n'), false, 'one line');
  // Deleting the answer deletes the line's content: the state is derived, never stored.
  assert.match(askHandlingLine(p.asks[0], []), /^\*a1 · open\* — closed with no answer written\.$/);
});

test('the handling line reports the facts the disposition alone would lose', () => {
  const answers = parseActionFile(RESOLVED).answers;
  // `askState` returns `answer: null` for a withdrawn ask whatever was written
  // for it, so without the fallback the one line in the log about a note the
  // human answered AND then withdrew would read "closed with no answer written".
  const withdrawn = askHandlingLine({ id: 'a1', re: 'body', closed: true }, answers);
  assert.match(withdrawn, /^\*a1 · withdrawn · edit-body · g1\* — /);
  assert.match(withdrawn, /read i2 before you arm it/, 'the answer is still shown');

  // `did: none` is a real verb — "I answered, I changed nothing" — and it is
  // the one that says nothing the disposition has not already said.
  const none = askHandlingLine({ id: 'a2', re: 'body', closed: false },
    [{ to: 'a2', disposition: 'declined', did: 'none', in: 'g2', body: 'The claim holds.' }]);
  assert.equal(none, '*a2 · declined · g2* — The claim holds.');
});

test('deleting an answer takes the pair back out of the log, and the line with it', () => {
  // The state is derived on every read, so the ask reopens and blocks the submit
  // the moment the answer goes. The SECTION is bytes: the handling line and the
  // pair's placement were written when it was filed. While only `prt draft`
  // re-derived them, the file said "handled" — under a heading whose own framing
  // says none of these block a submit — about a note `blockingAsks` would stop
  // the submit over, and a second `--tidy` could not repair it.
  const filed = relocateResolvedAsks(RESOLVED).text;
  assert.match(filed, /^\*a1 · addressed · edit-body · g1\* — /m);

  // The human deletes the answer block, the way they would in an editor.
  const reopened = filed.replace(/<!-- prt:answer\nto: a1[\s\S]*?<!-- \/prt -->\n/, '');
  assert.equal(collectAsks(reopened).asks[0].open, true, 'the derived state already says open');

  const r = relocateResolvedAsks(reopened);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.reopened, [{ id: 'a1', state: 'open', re: 'body' }]);
  assert.doesNotMatch(r.text, /\*a1 · addressed/, 'the line that said "handled" is gone');
  assert.doesNotMatch(r.text, /## Resolved notes/, 'and so is a section with nothing left in it');

  // The note itself is untouched, and back where the renderer puts an open one:
  // after the block it is `re:` bound to.
  const lines = r.text.split('\n');
  assert.ok(lines.indexOf('drop the wire-protocol section') > lines.indexOf('Summary text.'));
  assert.equal(collectAsks(r.text).asks[0].question, 'drop the wire-protocol section');
  assert.deepEqual(parseActionFile(r.text).errors, []);
  assert.equal(relocateResolvedAsks(r.text).text, r.text, 'and a second run is still a no-op');
});

test('an answer edited under a filed note re-derives the line above it', () => {
  // `declined` rewritten to `addressed` left the log stating the disposition the
  // human overwrote — the same stale-bytes failure, one field narrower.
  const filed = relocateResolvedAsks(RESOLVED).text;
  const edited = filed
    .replace('disposition: addressed\ndid: edit-body', 'disposition: declined\ndid: none')
    .replaceAll('The verdict still stands, but on a narrower base, so read i2 before you arm it.',
      'On reflection the section stays: it is the only place the format is written down.');
  const r = relocateResolvedAsks(edited);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.reopened, []);
  assert.deepEqual(r.refreshed, [{ id: 'a1', state: 'declined' }]);
  assert.match(r.text, /^\*a1 · declined · g1\* — On reflection the section stays: /m);
  assert.doesNotMatch(r.text, /\*a1 · addressed/);
  // The pair itself is still verbatim, and still filed.
  assert.match(r.text, /On reflection the section stays: it is the only place the format is written down\./);
  assert.equal(relocateResolvedAsks(r.text).text, r.text);
});

test('taking a pair back never deletes words the human put in the section', () => {
  // The heading and its framing go only when what is left really is nothing but
  // them. A paragraph typed into the section is the human's, and words are not
  // what this deletes.
  const filed = relocateResolvedAsks(RESOLVED).text;
  const withProse = filed.replace(
    '*Kept for one more round, then retired to `history/`. Never posted.*',
    '*Kept for one more round, then retired to `history/`. Never posted.*\n\nI am keeping this paragraph.',
  );
  const r = relocateResolvedAsks(withProse.replace(/<!-- prt:answer\nto: a1[\s\S]*?<!-- \/prt -->\n/, ''));
  assert.deepEqual(r.reopened.map((x) => x.id), ['a1']);
  assert.match(r.text, /## Resolved notes/, 'the heading stays while something of theirs is under it');
  assert.match(r.text, /I am keeping this paragraph\./);
});

test('the handling line reads as one line when the answer ends in a list, a fence or a table', () => {
  // "The last paragraph" is right for prose and was noise for the two shapes a
  // "what I did" answer routinely ends in.
  const ask = { id: 'a1', re: 'body', closed: false };
  const line = (body) => askHandlingLine(ask, [{ to: 'a1', disposition: 'addressed', did: 'edit-body', in: 'g1', body }]);

  // A list is the summary; it just has to read as a line. And the sentence clip
  // is skipped, or three items would summarise as the first one.
  assert.equal(
    line('- dropped the tier sentence\n- reworded i3\n- left i5 alone'),
    '*a1 · addressed · edit-body · g1* — dropped the tier sentence; reworded i3; left i5 alone',
  );
  assert.equal(
    line('1. dropped the tier sentence\n2. reworded i3'),
    '*a1 · addressed · edit-body · g1* — dropped the tier sentence; reworded i3',
  );

  // A closing fence or table summarises nothing, so the search steps back to the
  // last paragraph that is words.
  assert.equal(line('Removed the paragraph. The diff is:\n\n```diff\n- old\n+ new\n```'),
    '*a1 · addressed · edit-body · g1* — Removed the paragraph.');
  assert.equal(line('Reworded it. The counts are now:\n\n| a | b |\n| - | - |\n| 1 | 2 |'),
    '*a1 · addressed · edit-body · g1* — Reworded it.');

  // …and when there is no such paragraph, the last one is used anyway: an
  // awkward line beats an empty one.
  assert.match(line('```diff\n- old\n```'), /— ```diff/);

  // Prose is untouched: still the LAST paragraph's first sentence.
  assert.match(
    line('Deleted it.\n\nThe verdict still stands, but on a narrower base, so read i2 before you arm it.'),
    /— The verdict still stands, but on a narrower base, so read i2 before you arm it\.$/,
  );
});

test('the handling line survives prose that would break its markdown', () => {
  const ask = { id: 'a9', re: 'body', closed: false };
  const long = `x`.repeat(40) + ' `an unclosed span that runs past the cap ' + 'y'.repeat(200);
  const line = askHandlingLine(ask, [{ to: 'a9', disposition: 'declined', in: 'g2', body: long }]);
  assert.equal((line.match(/`/g) ?? []).length % 2, 0, 'no dangling backtick opens a code span');
  assert.ok(line.endsWith('…'));
  // Only the closed-vocabulary tokens are italicised, so `*` in the prose is inert.
  const starred = askHandlingLine(ask, [{ to: 'a9', disposition: 'declined', in: 'g2', body: '**bold** and *italic* prose' }]);
  assert.match(starred, /^\*a9 · declined · g2\* — \*\*bold\*\* and \*italic\* prose$/);
});

test('the generator and the tidy command write the same section', () => {
  // Two producers, one shape. If they disagreed, a file would look different
  // depending on whether the pair got there by `--tidy` or by regeneration.
  const ask = { id: 'a1', re: 'body', blocking: true, closed: false, raised: 'g1', open: false, state: 'addressed', question: 'drop the wire-protocol section' };
  const answer = { to: 'a1', disposition: 'addressed', did: 'edit-body', in: 'g1', body: 'Deleted it, and the analysis is kept under "Considered and dropped".\n\nThe verdict still stands, but on a narrower base, so read i2 before you arm it.' };
  const generated = renderActionFile({
    repo: 'apache/pulsar', analysis: fixtureAnalysis(), delta: null,
    findings: { summary: 'Summary text.', recommendedEvent: 'COMMENT', findings: [] },
    kind: 'initial', generation: 2, reviewerLogin: 'lhotari',
    carriedAsks: [ask], carriedAnswers: [answer],
  });
  // Anchored on the heading LINE: the footer also mentions the section by name.
  const sectionOf = (t) => t.slice(t.search(/^## Resolved notes$/m)).trimEnd();
  assert.equal(sectionOf(generated), sectionOf(relocateResolvedAsks(RESOLVED).text));
  assert.deepEqual(parseActionFile(generated).errors, []);
});

test('a resolved note is not also rendered beside its target, and never twice', () => {
  const text = renderActionFile({
    repo: 'apache/pulsar', analysis: fixtureAnalysis(), delta: null,
    kind: 'initial', generation: 2, reviewerLogin: 'lhotari',
    findings: {
      summary: 'S', recommendedEvent: 'COMMENT',
      findings: [{ id: 'i1', severity: 'BUG', claim: 'c', path: 'src/Main.java', line: 10, side: 'RIGHT', body: 'why' }],
    },
    carriedAsks: [
      { id: 'a1', re: 'i1', blocking: true, closed: false, raised: 'g1', open: false, state: 'declined', question: 'resolved one' },
      { id: 'a2', re: 'i1', blocking: true, closed: false, raised: 'g2', open: true, state: 'open', question: 'open one' },
    ],
    carriedAnswers: [{ to: 'a1', disposition: 'declined', in: 'g1', body: 'The claim holds.' }],
  });
  const p = parseActionFile(text);
  assert.deepEqual(p.errors, [], p.errors.join('; ')); // a duplicate id would be an error here
  assert.deepEqual(p.asks.map((a) => a.id), ['a2', 'a1'], 'the open one beside i1, the resolved one at the end');
  const heading = text.search(/^## Resolved notes$/m);
  assert.ok(text.indexOf('resolved one') > heading, 'the answered note is in the log');
  assert.ok(text.indexOf('open one') < heading, 'the open one is still beside i1');
  // The section is flat: the handling line is already the collapsed view, and
  // the material that decides whether to arm the review is in the answer body.
  assert.equal((text.match(/<details/g) ?? []).length, 0);
  assert.match(text, /note\(s\) already handled: a1 — see `## Resolved notes` below/);
});

test('an ask that reaches the renderer with no derived state falls on the open side', () => {
  // The split is `open === false`, not `!open`, and it fails on the safe side on
  // purpose: a note wrongly left beside its target is noise the human reads and
  // ignores, while a note wrongly filed is one they stop being asked about. So
  // an ask that arrived without an `open` — a hand-written carry, a caller this
  // function does not know about — is treated as live work.
  const text = renderActionFile({
    repo: 'apache/pulsar', analysis: fixtureAnalysis(), delta: null,
    kind: 'initial', generation: 2, reviewerLogin: 'lhotari',
    findings: {
      summary: 'S', recommendedEvent: 'COMMENT',
      findings: [{ id: 'i1', severity: 'BUG', claim: 'c', path: 'src/Main.java', line: 10, side: 'RIGHT', body: 'why' }],
    },
    carriedAsks: [{ id: 'a1', re: 'i1', blocking: true, closed: false, raised: 'g1', question: 'stateless one' }],
    carriedAnswers: [],
  });
  assert.equal(/^## Resolved notes$/m.test(text), false, 'nothing was filed');
  assert.match(text, /stateless one/);
  assert.deepEqual(parseActionFile(text).asks.map((a) => a.id), ['a1']);
});

test('a note typed under the new heading binds to general, not to the last inline', () => {
  // The file now ends with a heading humans read and type under. Without the
  // heading reset, `precedingId` walks back to whatever inline block was last.
  const text = renderActionFile({
    repo: 'apache/pulsar', analysis: fixtureAnalysis(), delta: null,
    kind: 'initial', generation: 2, reviewerLogin: 'lhotari',
    findings: {
      summary: 'S', recommendedEvent: 'COMMENT',
      findings: [{ id: 'i1', severity: 'BUG', claim: 'c', path: 'src/Main.java', line: 10, side: 'RIGHT', body: 'why' }],
    },
    carriedAsks: [{ id: 'a1', re: 'body', blocking: true, closed: false, raised: 'g1', open: false, state: 'addressed', question: 'q' }],
    carriedAnswers: [{ to: 'a1', disposition: 'addressed', did: 'edit-body', in: 'g1', body: 'Done.' }],
  });
  const { promoted } = promoteShorthand(`${text.trimEnd()}\n\n@ai and one more thing\n`, { startOrdinal: 2, generation: 2 });
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].re, 'general');
});

test('only a `## ` heading in a gap is a section boundary — one inside a body is prose', () => {
  // The same rule `relocateResolvedAsks` and `ensurePrActions` apply, applied
  // here too. While this one scanned raw lines, a `prt:notes` or `prt:context`
  // whose body happened to carry a heading — a review summary routinely does —
  // silently rebound the note below it from its inline target to `general`.
  const f = (notesBody) => `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
<!-- /prt -->

<!-- prt:inline
id: i1
post: true
subject: line
path: src/Main.java
line: 10
-->
**[BUG] c**
<!-- /prt -->

<!-- prt:notes -->
${notesBody}
<!-- /prt -->

@ai this one is wrong
`;
  const re = (t) => promoteShorthand(t, { startOrdinal: 1 }).promoted.map((p) => p.re);
  assert.deepEqual(re(f('Generator notes.')), ['i1']);
  assert.deepEqual(re(f('## Not a section boundary\nGenerator notes.')), ['i1'],
    'a heading inside a body does not move the binding');
  // And the gap heading still resets it, which is what the rule is for.
  assert.deepEqual(
    re(f('Generator notes.').replace('@ai this one is wrong', '## Considered and dropped\n\n@ai this one is wrong')),
    ['general'],
  );
});

test('filing a note changes nothing carry-over reads', () => {
  const moved = relocateResolvedAsks(RESOLVED).text;
  const anchors = new Map([['i1', { path: 'src/Main.java', line: 10, side: 'RIGHT' }]]);
  for (const generation of [1, 2, 3]) {
    const before = carryAsks(RESOLVED, { newIds: new Set(['i1']), newAnchors: anchors, generation, ordinalFloor: 0 });
    const after = carryAsks(moved, { newIds: new Set(['i1']), newAnchors: anchors, generation, ordinalFloor: 0 });
    assert.deepEqual(after.asks.map((a) => a.id), before.asks.map((a) => a.id), `g${generation}`);
    assert.deepEqual(after.answers.map((a) => [a.to, a.in]), before.answers.map((a) => [a.to, a.in]));
    assert.equal(after.maxOrdinal, before.maxOrdinal);
    assert.equal(after.retired, before.retired);
  }
  // keepClosedFor = 1: still carried at g2, retired at g3, wherever it sits.
  assert.equal(carryAsks(moved, { newIds: new Set(['i1']), newAnchors: anchors, generation: 2 }).asks.length, 1);
  assert.equal(carryAsks(moved, { newIds: new Set(['i1']), newAnchors: anchors, generation: 3 }).asks.length, 0);
});

// ---- carry-over ------------------------------------------------------------

test('open notes survive regeneration; answered ones age out', () => {
  const answered = WITH_ASK + `
<!-- prt:answer
to: a1
disposition: addressed
in: g1
-->
Done.
<!-- /prt -->

<!-- prt:ask
id: a2
re: verdict
-->
why COMMENT and not REQUEST_CHANGES?
<!-- /prt -->
`;
  const newAnchors = new Map([['i1', { path: 'src/Main.java', line: 10, side: 'RIGHT' }]]);
  const out = carryAsks(answered, { newIds: new Set(['i1']), newAnchors, generation: 4, ordinalFloor: 0 });
  const ids = out.asks.map((a) => a.id);
  assert.ok(ids.includes('a2'), 'the open note survives');
  assert.ok(!ids.includes('a1'), 'an answer from g1 is too old to carry into g4');
  assert.equal(out.maxOrdinal, 2, 'a retired id is never reissued');
});

test('a note is rebound by anchor, not by id, when the comment moves', () => {
  // Next round the same finding is i2, and a different finding took id i1.
  const newAnchors = new Map([
    ['i1', { path: 'src/Other.java', line: 99, side: 'RIGHT' }],
    ['i2', { path: 'src/Main.java', line: 10, side: 'RIGHT' }],
  ]);
  const out = carryAsks(WITH_ASK, { newIds: new Set(['i1', 'i2']), newAnchors, generation: 5, ordinalFloor: 0 });
  assert.equal(out.asks[0].re, 'i2', 'follows the anchor, not the recycled id');
  assert.deepEqual(out.changes.map((c) => c.kind), ['rebound']);
});

test('a note whose comment is gone is orphaned loudly, never dropped', () => {
  const out = carryAsks(WITH_ASK, { newIds: new Set(), newAnchors: new Map(), generation: 5, ordinalFloor: 0 });
  assert.equal(out.asks.length, 1);
  assert.equal(out.asks[0].re, 'gone');
  assert.equal(out.asks[0].was, 'src/Main.java:10');
  assert.deepEqual(out.changes.map((c) => c.kind), ['orphaned']);
});

test('carry-over refuses rather than dropping notes it cannot read', () => {
  const broken = WITH_ASK.replace('<!-- prt:ask\nid: a1\nre: i1\n-->', '<!-- prt:ask\nid: a1\nre: i1');
  const out = carryAsks(broken, { newIds: new Set(['i1']), newAnchors: new Map(), generation: 2 });
  assert.ok(out.structuralErrors.length > 0);
  assert.deepEqual(out.asks, []);
});

test('a carried note keeps its blank lines through the generator squeeze', () => {
  const ask = {
    id: 'a1', re: 'verdict', blocking: true, closed: false, raised: 'g2', open: true, state: 'open',
    question: 'first paragraph\n\n\n\nfourth line after three blanks',
  };
  const text = renderActionFile({
    repo: 'apache/pulsar',
    analysis: {
      number: 1, title: 't', url: 'u', author: 'a', authorAssociation: 'CONTRIBUTOR',
      updatedAt: new Date().toISOString(), additions: 1, deletions: 0, changedFiles: 1,
      ci: 'SUCCESS', reviewDecision: null, myLastReview: null, headMoved: false,
      threadCounts: {}, labels: [], threads: [], newIssueComments: [], newReviewsByOthers: [],
      headOid: 'abc', baseRefName: 'master',
    },
    delta: null, findings: null, kind: 'initial', generation: 2, reviewerLogin: 'me',
    carriedAsks: [ask], carriedAnswers: [],
  });
  assert.match(text, /first paragraph\n\n\n\nfourth line/, 'the human bytes are not reflowed');
});

test('a private note repeated verbatim in outgoing text is caught before it posts', () => {
  const leaked = WITH_ASK
    .replace('this one is wrong, the null check is upstream',
      'the clamp in getMaxEntriesInThisBatch re-clamps per consumer so this whole claim is simply wrong here')
    .replace('Summary text.',
      'the clamp in getMaxEntriesInThisBatch re-clamps per consumer so this whole claim is simply wrong here');
  const hits = askQuoteLint(parseActionFile(leaked));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a1');
  // The human, and only the human, can clear it.
  const ok = leaked.replace('head: abc123', 'head: abc123\nask-quote-reviewed: yes');
  assert.deepEqual(askQuoteLint(parseActionFile(ok)), []);
});

test('a short shared phrase does not false-positive the quote lint', () => {
  const p = parseActionFile(WITH_ASK.replace('Summary text.', 'the null check is upstream'));
  assert.deepEqual(askQuoteLint(p), []);
});


test('a body containing the whitespace-guard token is not spliced into another block', () => {
  // The generator masks ask/answer spans before squeezing blank lines. If a
  // finding body happened to contain the mask token, restoring it would splice
  // an ask block into a comment that was about to be posted — truncating it.
  const analysis = {
    number: 1, title: 't', url: 'u', author: 'a', authorAssociation: 'CONTRIBUTOR',
    updatedAt: new Date().toISOString(), additions: 1, deletions: 0, changedFiles: 1,
    ci: 'SUCCESS', reviewDecision: null, myLastReview: null, headMoved: false,
    threadCounts: {}, labels: [], threads: [], newIssueComments: [], newReviewsByOthers: [],
    headOid: 'abc', baseRefName: 'master',
  };
  const text = renderActionFile({
    repo: 'apache/pulsar', analysis, delta: null, kind: 'initial', generation: 1, reviewerLogin: 'me',
    findings: {
      summary: 'Summary', recommendedEvent: 'COMMENT',
      findings: [{
        id: 'i1', severity: 'BUG', claim: 'c', path: 'src/Main.java', line: 10, side: 'RIGHT',
        body: 'This code emits @@PRTASK0@@ literally.\n\nSecond paragraph that must survive.',
      }],
    },
    carriedAsks: [{
      id: 'a1', re: 'verdict', blocking: true, closed: false, raised: 'g1', open: true, state: 'open',
      question: 'is this right?',
    }],
    carriedAnswers: [],
  });
  const review = planActions(parseActionFile(text)).find((a) => a.kind === 'review');
  const inline = review.comments.find((c) => c.id === 'i1');
  assert.ok(inline.body.includes('Second paragraph that must survive.'), 'the comment is not truncated');
  assert.ok(inline.body.includes('@@PRTASK0@@'), 'the literal survives untouched');
  assert.ok(!inline.body.includes('prt:ask'), 'no note is spliced into a postable body');
});

// ---- `prt ask` never says "no notes" about a file that has notes -----------
//
// Through the real CLI against a temp store, because the lie lived in the shape
// of the rows the command pushed and not in anything a pure call returns: two
// branches printed a line about a PR and then `continue`d without filling in the
// field the summary predicate read. The predicate now counts printed lines,
// which is the only thing that cannot drift from what was printed.

const CLI_REPO = 'o/r';

/** A temp store holding one PR whose review.md is `text`. Returns the root. */
function storeWith(number, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-ask-'));
  // A cached reviewer keeps `context()` off `gh api user`.
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ reviewer: 'me' }));
  const dir = path.join(root, 'o', 'r', `pr-${number}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
    schema: 1, repo: CLI_REPO, number, title: `pr ${number}`,
    url: `https://github.com/o/r/pull/${number}`, author: 'someone', state: 'OPEN',
    updatedAt: new Date().toISOString(),
    analysis: { number, author: 'someone', threadCounts: {}, threads: [], ci: 'SUCCESS' },
  }));
  fs.writeFileSync(path.join(dir, 'review.md'), text);
  return root;
}

function ask(root, args) {
  const prt = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prt.mjs');
  const r = spawnSync(process.execPath, [prt, 'ask', ...args, '--repo', CLI_REPO, '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `prt ask failed: ${r.stderr}`);
  return r.stdout;
}

const IN_BODY_NOTE = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.

*@ai Don't mention the tier level.

More summary.
<!-- /prt -->
`;

test('`prt ask` lists a note that is not a prt:ask block yet, instead of reporting none', () => {
  // The state every file is in between the human typing a note and running
  // `--promote`, which is most of the minutes there are. Reading only `prt:ask`
  // blocks made this the tool's most confident lie: the note is a hard parse
  // error blocking the submit at the same moment `prt ask` says there are none.
  const root = storeWith(42, IN_BODY_NOTE);
  try {
    const out = ask(root, ['42']);
    assert.doesNotMatch(out, /no notes/);
    assert.match(out, /1 un-promoted/);
    assert.match(out, /in <!-- prt:body --> at line \d+/);
    assert.match(out, /Don't mention the tier level\./);
    // And the JSON carries the same fact the human is shown.
    const j = JSON.parse(ask(root, ['42', '--json']));
    assert.equal(j.rows[0].notes.length, 1);
    assert.equal(j.rows[0].notes[0].where, 'body');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`prt ask --promote` does not follow a refusal to rewrite with "no notes"', () => {
  // The most likely moment for the maintainer to type a note is while reading an
  // armed file — and then the one command that could rescue it refuses, and used
  // to say "no notes" on the very next line.
  const root = storeWith(42, IN_BODY_NOTE.replace('Status: draft', 'Status: ready'));
  try {
    const out = ask(root, ['42', '--promote']);
    assert.match(out, /refusing to rewrite/);
    assert.doesNotMatch(out, /no notes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`prt ask --tidy` on a file with notes reports the file, not an empty one', () => {
  const root = storeWith(42, IN_BODY_NOTE);
  try {
    const out = ask(root, ['42', '--tidy']);
    assert.match(out, /no answered notes to file/);
    assert.doesNotMatch(out, /no notes/, 'the file plainly has one');
    // `--tidy` does not promote, so the note is still there afterwards, and the
    // row says so rather than describing only what this command did.
    const j = JSON.parse(ask(root, ['42', '--tidy', '--json']));
    assert.equal(j.rows[0].notes.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('"no notes" still prints for a file that genuinely has none', () => {
  const root = storeWith(42, MINIMAL);
  try {
    assert.match(ask(root, ['42']), /no notes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the `!` row names the remedy that works, not `--promote` for a note nothing lifts', () => {
  // The `!` row used to end `run \`prt ask <N> --promote\`` for every note,
  // including the two kinds `--promote` is documented as unable to lift. Taking
  // that advice printed "no un-promoted @ai notes" while `prt validate` went on
  // refusing the same file over the same note — the tool contradicting itself two
  // commands apart, which is the failure the printed-line counter was added to
  // remove, wearing a different hat.
  const withLogNote = `${IN_BODY_NOTE.replace('*@ai Don\'t mention the tier level.\n\n', '')}
<!-- prt:log -->
g1 drafted
@ai why did this take two rounds
<!-- /prt -->
`;
  const root = storeWith(42, withLogNote);
  try {
    const out = ask(root, ['42']);
    assert.match(out, /in <!-- prt:log --> at line \d+ — nothing lifts a note out of `prt:log` — move it outside the block/);
    assert.doesNotMatch(out, /--promote/, 'the one command that cannot help is not the one offered');
    // And `--promote` no longer contradicts the row. It used to answer "no
    // un-promoted @ai notes" here — `promoted` and `refused` both come from the
    // LIFT, and the lift never looks inside `prt:log`, so both counters read 0 —
    // while `prt validate` went on refusing this same file over this same note.
    // It now names the note it could not lift, with the same remedy the `!` row
    // printed, and reserves the all-clear for a file that really has none.
    const promoted = ask(root, ['42', '--promote']);
    assert.doesNotMatch(promoted, /no un-promoted @ai notes/, 'a file with a note is never told it has none');
    assert.match(promoted, /NOT PROMOTED — the @ai note in <!-- prt:log --> at line \d+: nothing lifts a note out of `prt:log` — move it outside the block/);
    // A note that IS liftable still gets the command that lifts it.
    const lift = storeWith(43, IN_BODY_NOTE);
    try {
      assert.match(ask(lift, ['43']), /— run `prt ask 43 --promote` to lift it out/);
    } finally {
      fs.rmSync(lift, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- the store that already exists ----------------------------------------
//
// `q:`/`re-q:` did not exist when the live store was written, and the one thing
// the mechanism must not do is reopen notes it has no record of. These run
// against the real bytes of `apache/pulsar#26433`'s answered pair — the file
// this defect was found on — copied verbatim out of
// `~/.claude/pr-review-track/apache/pulsar/pr-26433/review.md` (ask a2, lines
// 99–115, generation 1, answered by the revise job on 2026-08-29). It is the
// only ask anywhere in that store, and it carries the awkward shape too: a
// question that still reads `*@ai …` because it was promoted before the leader
// class tolerated decoration. So it is precisely the ask that a structural
// "does this look like a fresh note" rule would have mis-read.

const LEGACY_PAIR = `Status: draft

<!-- prt:doc
repo: apache/pulsar
pr: 26433
head: 2a1f44db0af7284c3a80332e9c8d199e2f9b9713
generation: 1
-->

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Summary text.
<!-- /prt -->

<!-- prt:ask
id: a2
re: body
raised: g1
-->
*@ai Don't mention anything about the tier level which is completely internal information.
<!-- /prt -->

<!-- prt:answer
to: a2
disposition: addressed
did: edit-body
in: g1
-->
Removed the "Review scope" paragraph from the summary, then swept everything that would post — the summary and every inline body — for the tier, model names, effort levels and any description of how the review was produced.
<!-- /prt -->
`;

test('a note written before the stamp existed is read exactly as it was', () => {
  const p = parseActionFile(LEGACY_PAIR);
  assert.deepEqual(p.errors, []);
  assert.equal(p.asks[0].q, null, 'nothing in this file records what the tool wrote');
  assert.equal(p.answers[0].reQ, null);
  // The safe default, and the whole of backwards compatibility: no stamp means
  // no opinion, so the answer still closes it.
  assert.equal(askState(p.asks[0], p.answers).state, 'addressed');
  assert.deepEqual(blockingAsks(p), [], 'a file nobody touched does not start refusing to post');
  // Not even the awkward shape reopens it. a2's question IS an `@ai` line, and a
  // rule that read that as "a human typed this" would have refused the one real
  // ask in the store. The stamp is the only evidence used, and there is none.
  assert.match(p.asks[0].question, NOTE_LINE);
});

test('nothing rewrites a pre-existing file, and an edit to it is not detectable — say so', () => {
  // Both halves of the boundary, pinned together so neither can be read alone.
  //
  // The first is the requirement: `--promote` leaves a file it has nothing to
  // promote byte for byte, a back-filled stamp included. A stamp taken from
  // bytes on disk records what the file SAYS, not what the tool WROTE, so it
  // would bless whatever it found — an edit already made included.
  const lifted = promoteShorthand(LEGACY_PAIR, { startOrdinal: 9, generation: 2 });
  assert.equal(lifted.text, LEGACY_PAIR, 'byte for byte');
  assert.deepEqual(lifted.promoted, []);
  assert.deepEqual(lifted.resealed, []);
  // And through the CLI, where `ensurePrActions` may still append the section a
  // fixture this small predates. What must not appear there is a stamp.
  const root = storeWith(26433, LEGACY_PAIR);
  try {
    assert.match(ask(root, ['26433', '--promote']), /no un-promoted @ai notes/);
    const after = fs.readFileSync(path.join(root, 'o', 'r', 'pr-26433', 'review.md'), 'utf8');
    assert.doesNotMatch(after, /^q:/m, 'no stamp was invented for an ask the tool did not write');
    assert.doesNotMatch(after, /^re-q:/m);
    assert.match(after, /^\*@ai Don't mention anything about the tier level/m, 'and the question is untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The second is what the first costs, and it is the honest limit of the
  // mechanism: an unstamped ask cannot be told apart from an edited one, because
  // nothing in the file records the other wording. Rewriting this question does
  // NOT reopen it. Every ask made from here on is stamped at birth by
  // `promoteShorthand` and `carryAsks` retires this generation's unstamped ones
  // within a round or two, so the gap is a window rather than a hole — but while
  // it is open it is silent, and a test that did not say so would read as a
  // guarantee the code does not give.
  const escalated = parseActionFile(LEGACY_PAIR.replace(
    "*@ai Don't mention anything about the tier level which is completely internal information.",
    '*@ai STOP - the tier text is STILL in inline i7. Do not post until that is fixed.',
  ));
  assert.equal(askState(escalated.asks[0], escalated.answers).state, 'addressed');
  assert.deepEqual(blockingAsks(escalated), []);
});

test('the same note, promoted by the tool of today, does reopen when it is rewritten', () => {
  // The counterpart to the limit above, on the same words. What makes the
  // difference is not the wording — it is whether the tool recorded what it
  // wrote. Replayed from the real g1 draft: the line below is the one the
  // maintainer actually typed into pr-26433's summary, decoration and all.
  const draft = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.

*@ai Don't mention anything about the tier level which is completely internal information.

More summary.
<!-- /prt -->
`;
  const { text, promoted } = promoteShorthand(draft, { startOrdinal: 2, generation: 1 });
  assert.deepEqual(promoted.map((x) => x.id), ['a2']);
  const born = parseActionFile(text);
  assert.equal(
    born.asks[0].q,
    questionHash("Don't mention anything about the tier level which is completely internal information."),
    'the tool created it, so the tool knows what it put there',
  );

  const answered = `${text}
<!-- prt:answer
to: a2
disposition: addressed
did: edit-body
in: g1
-->
Swept the summary and every inline body for the tier and the effort levels.
<!-- /prt -->
`;
  const settled = parseActionFile(answered);
  assert.equal(askState(settled.asks[0], settled.answers).state, 'addressed');

  const escalated = parseActionFile(answered.replace(
    "Don't mention anything about the tier level which is completely internal information.",
    'STOP - the tier text is STILL in inline i7. Do not post until that is fixed.',
  ));
  assert.deepEqual(escalated.errors, []);
  assert.equal(askState(escalated.asks[0], escalated.answers).state, 'edited');
  assert.deepEqual(blockingAsks(escalated).map((a) => a.id), ['a2']);
});

test('`prt ask` shows a rewritten note as open, and `--promote` says what it did about it', () => {
  const stamped = `Status: draft

<!-- prt:verdict
event: COMMENT
-->

<!-- prt:body -->
Real summary.
<!-- /prt -->

<!-- prt:ask
id: a2
re: body
raised: g1
q: ${questionHash('Do not mention the tier level.')}
-->
STOP - the tier text is STILL in inline i7. Do not post until that is fixed.
<!-- /prt -->

<!-- prt:answer
to: a2
disposition: addressed
did: edit-body
in: g1
-->
Swept the summary for it.
<!-- /prt -->
`;
  const root = storeWith(26433, stamped);
  try {
    const listed = ask(root, ['26433']);
    assert.match(listed, /1 open/);
    assert.match(listed, /● a2 {2}re: body {2}edited/);
    const promoted = ask(root, ['26433', '--promote']);
    assert.doesNotMatch(promoted, /no un-promoted @ai notes/,
      'a command that has just rewritten two sentinels must not report finding nothing');
    assert.match(promoted, /a2's question has been rewritten since it was answered/);
    // Still open after the reseal, and still open when it is listed again.
    assert.match(ask(root, ['26433']), /● a2 {2}re: body {2}edited/);
    const j = JSON.parse(ask(root, ['26433', '--json']));
    assert.equal(j.rows[0].asks[0].state, 'edited');
    assert.equal(j.rows[0].asks[0].open, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
