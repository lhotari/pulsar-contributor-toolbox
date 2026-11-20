// Review rounds: findings → draft → (the human edits) → staged as a PENDING review on GitHub (where more
// comments can be added by hand) → submitted with the event the human picked. This file and the server
// are the only code that writes to GitHub, and only on a request that came from the web UI.
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.mjs';
import * as P from './prt.mjs';
import { diffFor, refreshItem, track, draftStaleness } from './triage.mjs';

export const EVENTS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];
const SHA = /^[0-9a-f]{7,40}$/i;

function touch(reviewId) { db.run('UPDATE reviews SET updated_at = ? WHERE id = ?', db.now(), reviewId); }

async function anchorsAt(repo, number, sha) {
  const { text } = await diffFor(repo, number, sha);
  const files = P.parseDiff(text);
  return { files, anchors: P.commentableAnchors(files) };
}

/** Resolve file names in prose to permalinks at the reviewed head: PR files first, then the repo tree. */
async function linker(repo, number, sha, files) {
  const index = P.pathIndex([...files.keys()]);
  let treeLoaded = false;
  return async (text, selfPath = null) => {
    let r = P.linkifyCode(text, { repo, sha, resolve: index.resolve, selfPath });
    if (r.unresolved?.length && !treeLoaded) {
      treeLoaded = true;
      const cache = path.join(db.prDir(repo, number), `tree-${sha}.json`);
      try {
        const tree = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : await P.repoTree(repo, sha);
        fs.writeFileSync(cache, JSON.stringify(tree));
        index.add(tree.paths);
        r = P.linkifyCode(text, { repo, sha, resolve: index.resolve, selfPath });
      } catch { /* leave unlinked */ }
    }
    return r;
  };
}

function anchorError(anchors, c) {
  if (c.kind === 'reply' || c.kind === 'issue') return null;
  if (!c.path) return 'no file given';
  if (c.kind === 'file') return anchors.has(c.path) ? null : `"${c.path}" is not part of this diff`;
  if (!c.line) return 'no line given';
  const v = P.validateAnchor(anchors, { file: c.path, line: c.start_line ?? c.line, endLine: c.start_line ? c.line : null, side: c.side || 'RIGHT' });
  return v.ok ? null : `${v.reason}${v.nearest ? ` (nearest commentable line: ${v.nearest})` : ''}`;
}

function insertComment(reviewId, c, seq) {
  const t = db.now();
  const r = db.run(`INSERT INTO comments (review_id, kind, path, line, start_line, side, thread_id, in_reply_to, resolve, severity, claim, body, body_ai,
      meta, include, source, anchor_error, seq, gh_id, gh_node, gh_url, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  reviewId, c.kind, c.path ?? null, c.line ?? null, c.start_line ?? null, c.side || 'RIGHT', c.thread_id ?? null, c.in_reply_to ?? null, c.resolve ? 1 : 0,
  c.severity ?? null, c.claim ?? null, c.body, c.source === 'ai' ? c.body : null, db.S(c.meta || {}), c.include === false ? 0 : 1, c.source || 'ai',
  c.anchor_error ?? null, seq, c.gh_id ?? null, c.gh_node ?? null, c.gh_url ?? null, c.state || 'local', t, t);
  return Number(r.lastInsertRowid);
}

/**
 * Turn a pr-review findings.json (the pr-review-track contract, schema 1) into a review round.
 * A draft from an earlier round is superseded; the comments the human wrote on it carry over.
 * A round that is already staged on GitHub receives the new comments as unstaged additions.
 */
export async function importFindings(repo, number, findings, { jobId = null, kind = null, gate = null, basisAt = null } = {}) {
  if (findings.schema !== 1) throw new Error('findings.schema must be 1');
  if (findings.pr && Number(findings.pr) !== number) throw new Error(`findings are for #${findings.pr}, not #${number}`);
  if (findings.repo && findings.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`findings are for ${findings.repo}, not ${repo}`);
  const pr = db.pr(repo, number);
  if (!SHA.test(findings.head || '')) throw new Error('findings.head must be the commit the review read (a SHA), not a ref name');
  const job = jobId ? db.get('SELECT head_sha FROM jobs WHERE id = ?', jobId) : null;
  const known = [pr.head_sha, job?.head_sha].filter(Boolean);
  const head = known.find((s) => s.startsWith(findings.head.toLowerCase())) || findings.head;
  const warnings = [];
  if (head !== pr.head_sha) warnings.push(`The PR head moved to ${pr.head_sha.slice(0, 10)} after this review read ${head.slice(0, 10)}. Comments anchor to the reviewed commit; consider a follow-up review of the new commits.`);
  const { files, anchors } = await anchorsAt(repo, number, head);
  const link = await linker(repo, number, head, files);
  const unresolved = new Set();
  const L = async (text, self) => { const r = await link(text || '', self); r.unresolved?.forEach((u) => unresolved.add(u)); return r.text; };

  const comments = [];
  for (const f of findings.findings || []) {
    const subject = f.subject || (f.line ? 'line' : 'file');
    const range = f.endLine && f.endLine !== f.line;
    const c = {
      kind: subject === 'file' ? 'file' : 'inline', path: f.path, side: f.side || 'RIGHT',
      line: range ? f.endLine : f.line, start_line: range ? f.line : null,
      severity: f.severity, claim: f.claim, source: 'ai',
      meta: { id: f.id, confidence: f.confidence, agreement: f.agreement, crossValidation: f.crossValidation },
    };
    const head1 = f.claim ? `**[${f.severity || 'NOTE'}] ${await L(f.claim)}**\n\n` : '';
    c.body = `${head1}${await L(f.body, c.side === 'LEFT' ? null : f.path)}`.trim();
    c.anchor_error = anchorError(anchors, c);
    c.include = f.post !== false && !c.anchor_error;
    if (f.post === false && !c.anchor_error) c.meta.notPostedWhy = 'the review marked this finding as not to be posted';
    comments.push(c);
  }
  const threads = [];
  for (const t of findings.threadAssessments || []) {
    threads.push({ threadId: t.threadId, assessment: t.assessment, why: await L(t.why), evidence: await Promise.all((t.evidence || []).map((e) => L(e))) });
    if (t.reply || t.resolve) {
      comments.push({ kind: 'reply', thread_id: t.threadId, body: await L(t.reply || ''), resolve: !!t.resolve, source: 'ai',
        include: !!t.reply, meta: { assessment: t.assessment, why: t.why, resolveOnly: !t.reply } });
    }
  }
  for (const ic of findings.issueCommentAssessments || []) {
    if (ic.reply) comments.push({ kind: 'issue', in_reply_to: ic.url, body: await L(ic.reply), source: 'ai', meta: { assessment: ic.assessment, why: ic.why } });
  }
  const body = await L(findings.summary || '');
  for (const text of [body, ...comments.map((c) => c.body)]) {
    const audit = P.auditPermalinks(text, { repo, sha: head });
    for (const r of audit.refs) warnings.push(`A link names a branch or tag instead of a commit: ${r.url}`);
    for (const r of audit.commits) warnings.push(`A link points at another commit than the reviewed head: ${r.url}`);
  }
  if (unresolved.size) warnings.push(`Not linked (no single matching file): ${[...unresolved].slice(0, 8).join(', ')}`);
  // When the review saw the PR: author activity after this makes the draft stale (see draftStaleness).
  const basis = basisAt || db.now();
  const meta = {
    basisAt: basis,
    tier: findings.tier || null, reviewers: findings.reviewers || [], coverage: findings.coverage || null,
    dropped: findings.dropped || [], threads, gate, warnings,
  };
  const recommended = EVENTS.includes(findings.recommendedEvent) ? findings.recommendedEvent : 'COMMENT';

  // A staged round on the same head takes the new comments as unstaged additions. A staged round on an older
  // head is superseded like a draft: its comments (yours and those added on GitHub) are pulled in first and
  // carried over, and its pending review is deleted on GitHub afterwards (GitHub allows one per reviewer).
  let cur0 = db.currentReview(repo, number);
  const supersedeStaged = cur0?.status === 'staged' && cur0.head_sha !== head;
  if (supersedeStaged) { await syncStaged(cur0.id); cur0 = db.currentReview(repo, number); }
  const res = db.tx(() => {
    const cur = db.currentReview(repo, number);
    let reviewId; let carried = 0;
    if (cur?.status === 'staged' && cur.head_sha === head) {
      reviewId = cur.id;
      const m = { ...cur.meta, basisAt: basis, warnings: [...(cur.meta.warnings || []), ...warnings, 'A later review round added comments to this staged review; they are not on GitHub until you stage again.'], threads, dropped: meta.dropped };
      db.run('UPDATE reviews SET meta = ?, updated_at = ? WHERE id = ?', db.S(m), db.now(), reviewId);
    } else {
      const t = db.now();
      const r = db.run(`INSERT INTO reviews (repo, number, kind, status, head_sha, since_sha, body, body_ai, recommended_event, recommended_why, meta, job_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, repo, number, kind || findings.kind || 'initial', 'draft', head, findings.since || null, body, body,
      recommended, findings.recommendedEventWhy || null, db.S(meta), jobId, t, t);
      reviewId = Number(r.lastInsertRowid);
      if (cur?.status === 'draft' || cur?.status === 'staged') {
        for (const c of db.comments(cur.id).filter((x) => ['human', 'github'].includes(x.source) && x.state !== 'removed')) {
          const err = anchorError(anchors, c);
          insertComment(reviewId, { ...c, source: 'human', gh_id: null, gh_node: null, gh_url: null, resolve: !!c.resolve, include: !!c.include && !err,
            anchor_error: err, state: 'local', meta: { ...c.meta, carriedFrom: cur.id } }, c.seq);
          carried++;
        }
        db.run(`UPDATE reviews SET status = 'discarded', meta = json_set(meta, '$.supersededBy', ?) WHERE id = ?`, reviewId, cur.id);
      }
    }
    let seq = (db.get('SELECT MAX(seq) m FROM comments WHERE review_id = ?', reviewId).m || 0);
    for (const c of comments) insertComment(reviewId, c, ++seq);
    db.event(repo, number, `#${number}: ${kind || findings.kind || 'initial'} review imported — ${comments.length} comment(s)${carried ? `, ${carried} of yours carried over` : ''}`, { job: jobId });
    return { review: reviewId, comments: comments.length, carried, warnings };
  });
  if (supersedeStaged && cur0?.gh_review_id) {
    const ok = await P.deletePendingReview(repo, number, cur0.gh_review_id);
    db.event(repo, number, `#${number}: the out-of-date pending review was ${ok ? 'deleted on GitHub; its comments moved to the new draft' : 'NOT deleted on GitHub (delete it there before staging again)'}`, { level: ok ? 'info' : 'warn' });
  }
  refreshItem(repo, number);
  return res;
}

/** A round the human starts by hand (no AI draft), at the current head. */
export async function startManual(repo, number) {
  const cur = db.currentReview(repo, number);
  if (cur && cur.status !== 'submitted') return cur.id;
  const pr = db.pr(repo, number);
  await diffFor(repo, number, pr.head_sha);
  const t = db.now();
  const r = db.run(`INSERT INTO reviews (repo, number, kind, status, head_sha, body, recommended_event, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    repo, number, 'manual', 'draft', pr.head_sha, '', 'COMMENT', db.S({ warnings: [] }), t, t);
  refreshItem(repo, number);
  return Number(r.lastInsertRowid);
}

// --- GitHub mutations the prt library does not have ---

async function updateGhComment(node, body) {
  await P.graphql(`mutation($id:ID!,$body:String!){ updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id, body:$body}){ pullRequestReviewComment { id } } }`, { id: node, body });
}
async function deleteGhComment(node) {
  await P.graphql(`mutation($id:ID!){ deletePullRequestReviewComment(input:{id:$id}){ pullRequestReview { id } } }`, { id: node });
}

export async function addComment(reviewId, c) {
  const rv = db.review(reviewId);
  if (rv.status === 'submitted' || rv.status === 'discarded') throw new Error(`review ${reviewId} is ${rv.status}`);
  if (!c.body?.trim()) throw new Error('empty comment');
  const kind = c.kind || (c.line ? 'inline' : 'file');
  const { anchors } = await anchorsAt(rv.repo, rv.number, rv.head_sha);
  const row = { kind, path: c.path, line: c.line ? Number(c.line) : null, start_line: c.startLine ? Number(c.startLine) : null, side: c.side || 'RIGHT',
    thread_id: c.threadId || null, body: c.body, source: 'human', meta: {} };
  row.anchor_error = anchorError(anchors, row);
  if (row.anchor_error) throw new Error(row.anchor_error);
  const seq = (db.get('SELECT MAX(seq) m FROM comments WHERE review_id = ?', reviewId).m || 0) + 1;
  const id = insertComment(reviewId, row, seq);
  touch(reviewId);
  return id;
}

/** Edit text, include flag, anchor or resolve flag. A staged comment is updated (or removed) on GitHub too. */
export async function updateComment(id, patch) {
  const c = db.comment(id); const rv = db.review(c.review_id);
  if (rv.status === 'submitted' || c.state === 'posted') throw new Error('this comment is already posted');
  const next = { ...c };
  if (patch.body !== undefined) { if (!String(patch.body).trim()) throw new Error('empty comment'); next.body = String(patch.body); }
  if (patch.include !== undefined) next.include = patch.include ? 1 : 0;
  if (patch.resolve !== undefined) next.resolve = patch.resolve ? 1 : 0;
  if (patch.line !== undefined || patch.path !== undefined || patch.side !== undefined || patch.startLine !== undefined || patch.kind !== undefined) {
    if (c.state === 'staged') throw new Error('re-anchoring a staged comment is not possible; remove it and add a new one');
    Object.assign(next, { path: patch.path ?? c.path, line: patch.line === undefined ? c.line : patch.line && Number(patch.line),
      start_line: patch.startLine === undefined ? c.start_line : patch.startLine && Number(patch.startLine), side: patch.side ?? c.side, kind: patch.kind ?? c.kind });
    const { anchors } = await anchorsAt(rv.repo, rv.number, rv.head_sha);
    next.anchor_error = anchorError(anchors, next);
  }
  if (next.include && next.anchor_error) throw new Error(`cannot include: ${next.anchor_error}`);
  let state = c.state;
  if (c.state === 'staged' && c.gh_node) {
    if (!next.include) { await deleteGhComment(c.gh_node); state = 'local'; }
    else if (next.body !== c.body) await updateGhComment(c.gh_node, next.body);
  }
  db.run(`UPDATE comments SET body = ?, include = ?, resolve = ?, path = ?, line = ?, start_line = ?, side = ?, kind = ?, anchor_error = ?, state = ?,
      gh_id = CASE WHEN ? = 'local' THEN NULL ELSE gh_id END, gh_node = CASE WHEN ? = 'local' THEN NULL ELSE gh_node END,
      meta = CASE WHEN ? THEN json_set(meta, '$.editedBy', ?) ELSE meta END, updated_at = ? WHERE id = ?`,
  next.body, next.include, next.resolve, next.path, next.line, next.start_line, next.side, next.kind, next.anchor_error ?? null, state, state, state,
  patch.body !== undefined && patch.body !== c.body ? 1 : 0, patch.by || 'human', db.now(), id);
  touch(c.review_id);
  return db.comment(id);
}

export async function removeComment(id) {
  const c = db.comment(id);
  if (c.state === 'posted') throw new Error('already posted');
  if (c.state === 'staged' && c.gh_node) await deleteGhComment(c.gh_node);
  if (c.source === 'human' || c.source === 'github') db.run('DELETE FROM comments WHERE id = ?', id);
  else db.run(`UPDATE comments SET include = 0, state = 'local', gh_id = NULL, gh_node = NULL, updated_at = ? WHERE id = ?`, db.now(), id);
  touch(c.review_id);
}

export function setBody(reviewId, body, by = 'human') {
  const rv = db.review(reviewId);
  if (rv.status === 'submitted') throw new Error('already submitted');
  db.run(`UPDATE reviews SET body = ?, meta = json_set(meta, '$.bodyEditedBy', ?), updated_at = ? WHERE id = ?`, String(body ?? ''), by, db.now(), reviewId);
}

export function ackLints(reviewId, labels) {
  db.run('UPDATE reviews SET lint_ack = ?, updated_at = ? WHERE id = ?', db.S([...new Set(labels)]), db.now(), reviewId);
}

/** What would be posted, and what the lints say about it. */
export function outgoing(reviewId, { body } = {}) {
  const rv = db.review(reviewId);
  const cs = db.comments(reviewId).filter((c) => c.include && !c.anchor_error && ['local', 'staged', 'failed'].includes(c.state));
  const texts = [['review body', body ?? rv.body], ...cs.map((c) => [`comment ${c.id}${c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : ''}`, c.body])];
  const ack = new Set(rv.lint_ack);
  const security = ack.has('security') ? [] : P.securityHitsInTexts(texts.map(([, t]) => t));
  const tooling = P.toolingHitsInTexts(texts, [...ack]);
  return { comments: cs, security, tooling, blocking: security.length > 0 || tooling.length > 0 };
}

function lintMessage(o) {
  const r = [];
  if (o.security.length) r.push(`the text mentions ${o.security.join(', ')}; never disclose a vulnerability on a public PR (acknowledge "security" if this is not a disclosure)`);
  if (o.tooling.length) r.push(`the text describes how the review was run: ${o.tooling.map((h) => `${h.label} (in ${h.where.join(', ')})`).join('; ')} (acknowledge the label if intended)`);
  return r.join('. ');
}

async function prNode(repo, number) {
  const core = (await P.fetchPrsBatch(repo, [number], { detail: false })).get(number);
  if (!core) throw new Error(`${repo}#${number} not found`);
  if (core.state !== 'OPEN') throw new Error(`#${number} is ${core.merged ? 'merged' : core.state.toLowerCase()}`);
  db.run('UPDATE prs SET head_sha = ?, node_id = ? WHERE repo = ? AND number = ?', core.headRefOid, core.id, repo, number);
  return core;
}

/** Comments in the pending review on GitHub: ours (by gh_id) updated, new ones (added in GitHub's UI) imported. */
export async function syncStaged(reviewId) {
  const rv = db.review(reviewId);
  if (!rv.gh_review_id) return { status: rv.status };
  const remote = await P.rest('GET', `repos/${rv.repo}/pulls/${rv.number}/reviews/${rv.gh_review_id}`).catch((e) => (/404|Not Found/.test(e.message) ? null : Promise.reject(e)));
  if (!remote) {
    db.run(`UPDATE reviews SET status = 'draft', gh_review_id = NULL, gh_review_node = NULL, updated_at = ? WHERE id = ?`, db.now(), reviewId);
    db.run(`UPDATE comments SET state = 'local', gh_id = NULL, gh_node = NULL WHERE review_id = ? AND state = 'staged' AND source != 'github'`, reviewId);
    db.run(`DELETE FROM comments WHERE review_id = ? AND source = 'github'`, reviewId);
    db.event(rv.repo, rv.number, `#${rv.number}: the pending review was discarded on GitHub; the draft is local again`, { level: 'warn' });
    refreshItem(rv.repo, rv.number);
    return { status: 'draft', discardedOnGitHub: true };
  }
  const list = await P.reviewComments(rv.repo, rv.number, rv.gh_review_id);
  const byId = new Map(list.map((x) => [Number(x.id), x]));
  const ours = db.comments(reviewId).filter((c) => c.gh_id);
  let edited = 0; let added = 0; let removed = 0;
  for (const c of ours) {
    const g = byId.get(Number(c.gh_id));
    if (!g) {
      if (c.state === 'staged') { db.run(`UPDATE comments SET state = 'removed', include = 0, updated_at = ? WHERE id = ?`, db.now(), c.id); removed++; }
      continue;
    }
    byId.delete(Number(c.gh_id));
    if (g.body !== c.body) { db.run(`UPDATE comments SET body = ?, meta = json_set(meta, '$.editedBy', 'github'), updated_at = ? WHERE id = ?`, g.body, db.now(), c.id); edited++; }
  }
  let seq = db.get('SELECT MAX(seq) m FROM comments WHERE review_id = ?', reviewId).m || 0;
  for (const g of byId.values()) {
    const replyTo = g.in_reply_to_id ? db.get('SELECT thread_id FROM comments WHERE review_id = ? AND gh_id = ?', reviewId, g.in_reply_to_id) : null;
    insertComment(reviewId, {
      kind: g.in_reply_to_id ? 'reply' : g.subject_type === 'file' ? 'file' : 'inline', path: g.path, line: g.line ?? g.original_line ?? null,
      start_line: g.start_line ?? null, side: g.side || 'RIGHT', thread_id: replyTo?.thread_id ?? null, body: g.body, source: 'github',
      gh_id: g.id, gh_node: g.node_id, gh_url: g.html_url, state: remote.state === 'PENDING' ? 'staged' : 'posted',
      meta: { inReplyTo: g.in_reply_to_id || null },
    }, ++seq);
    added++;
  }
  if (remote.state !== 'PENDING') {
    db.run(`UPDATE reviews SET status = 'submitted', event = ?, gh_url = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      { APPROVED: 'APPROVE', CHANGES_REQUESTED: 'REQUEST_CHANGES' }[remote.state] || 'COMMENT', remote.html_url, remote.submitted_at || db.now(), db.now(), reviewId);
    db.run(`UPDATE comments SET state = 'posted' WHERE review_id = ? AND state = 'staged'`, reviewId);
    db.event(rv.repo, rv.number, `#${rv.number}: the review was submitted on GitHub (${remote.state})`);
    refreshItem(rv.repo, rv.number);
    return { status: 'submitted', submittedOnGitHub: true, edited, added, removed };
  }
  touch(reviewId);
  if (edited || added || removed) db.event(rv.repo, rv.number, `#${rv.number}: synced the pending review — ${added} added, ${edited} edited, ${removed} removed on GitHub`);
  return { status: 'staged', edited, added, removed };
}

/**
 * Put the included comments into a PENDING review on GitHub. Nobody but the reviewer sees it until it is
 * submitted, here or in GitHub's own "Finish your review" dialog. A pending review the reviewer started on
 * GitHub is adopted rather than duplicated (GitHub allows one per reviewer and PR).
 */
export async function stage(reviewId) {
  const rv = db.review(reviewId);
  if (!['draft', 'staged'].includes(rv.status)) throw new Error(`review ${reviewId} is ${rv.status}`);
  const o = outgoing(reviewId);
  if (o.blocking) throw new Error(`refused: ${lintMessage(o)}`);
  const core = await prNode(rv.repo, rv.number);
  let reviewNode = rv.gh_review_node; let reviewDb = rv.gh_review_id;
  if (reviewDb) {
    const s = await syncStaged(reviewId);
    if (s.status !== 'staged') { reviewNode = null; reviewDb = null; if (s.status === 'submitted') throw new Error('the review was already submitted on GitHub'); }
  }
  if (!reviewDb) {
    const existing = (await P.pendingReviews(rv.repo, rv.number))[0];
    if (existing) {
      reviewDb = existing.id; reviewNode = existing.node_id;
      db.run(`UPDATE reviews SET gh_review_id = ?, gh_review_node = ?, status = 'staged', staged_at = ? WHERE id = ?`, reviewDb, reviewNode, db.now(), reviewId);
      db.event(rv.repo, rv.number, `#${rv.number}: adopted the pending review already open on GitHub`);
      await syncStaged(reviewId);
    } else {
      const r = await P.startPendingReview({ pullRequestNodeId: core.id, commitOid: rv.head_sha });
      if (!r.ok) throw new Error(`could not start a pending review: ${r.error}`);
      reviewDb = r.review.databaseId; reviewNode = r.review.id;
      db.run(`UPDATE reviews SET gh_review_id = ?, gh_review_node = ?, gh_url = ?, status = 'staged', staged_at = ?, updated_at = ? WHERE id = ?`,
        reviewDb, reviewNode, r.review.url, db.now(), db.now(), reviewId);
    }
  }
  let staged = 0; const failed = [];
  for (const c of outgoing(reviewId).comments.filter((x) => x.state !== 'staged' && x.kind !== 'issue')) {
    let res;
    if (c.kind === 'reply') res = await P.addThreadReply({ reviewNodeId: reviewNode, threadNodeId: c.thread_id, body: c.body });
    else {
      res = await P.addReviewThread({ reviewNodeId: reviewNode, pullRequestNodeId: core.id, path: c.path, body: c.body,
        subject: c.kind === 'file' ? 'file' : c.start_line ? 'range' : 'line', line: c.line, side: c.side || 'RIGHT', startLine: c.start_line, startSide: c.side || 'RIGHT' });
    }
    const node = c.kind === 'reply' ? res.comment : res.thread?.comments?.nodes?.[0];
    if (res.ok && node) {
      db.run(`UPDATE comments SET state = 'staged', gh_id = ?, gh_url = ?, error = NULL, updated_at = ? WHERE id = ?`, node.databaseId, node.url, db.now(), c.id);
      if (c.kind !== 'reply' && res.thread?.id) db.run('UPDATE comments SET thread_id = ? WHERE id = ?', res.thread.id, c.id);
      staged++;
    } else {
      db.run(`UPDATE comments SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`, String(res.error || 'no comment returned').slice(0, 1000), db.now(), c.id);
      failed.push({ id: c.id, error: res.error });
    }
  }
  // gh_node of new comments: read back from the pending review (REST ids → node ids).
  const list = await P.reviewComments(rv.repo, rv.number, reviewDb);
  for (const g of list) db.run('UPDATE comments SET gh_node = ? WHERE review_id = ? AND gh_id = ?', g.node_id, reviewId, g.id);
  db.event(rv.repo, rv.number, `#${rv.number}: staged ${staged} comment(s) as a pending review on GitHub${failed.length ? `; ${failed.length} failed` : ''}`, { level: failed.length ? 'warn' : 'info' });
  refreshItem(rv.repo, rv.number);
  return { staged, failed, reviewUrl: `https://github.com/${rv.repo}/pull/${rv.number}/files` };
}

/**
 * Submit with the event the human chose. Stages first when needed, picks up what was added on GitHub,
 * then posts conversation replies and resolves the threads flagged for it.
 */
export async function submit(reviewId, { event, body } = {}) {
  const rv = db.review(reviewId);
  if (!EVENTS.includes(event)) throw new Error(`event must be one of ${EVENTS.join(', ')}`);
  if (rv.status === 'submitted') throw new Error('already submitted');
  if (body !== undefined) setBody(reviewId, body);
  const text = (body ?? rv.body).trim();
  if (event === 'REQUEST_CHANGES' && !text && !outgoing(reviewId).comments.length) throw new Error('requesting changes needs a body or comments');
  await prNode(rv.repo, rv.number);
  // Fresh facts, then refuse a round the PR has moved past: new commits, or the author answering after it was written.
  await track(rv.repo, rv.number);
  const stale = draftStaleness(db.review(reviewId), db.pr(rv.repo, rv.number));
  if (stale.length) {
    db.run(`UPDATE reviews SET meta = json_set(meta, '$.blockedAt', ?, '$.blockedWhy', json(?)) WHERE id = ?`, db.now(), db.S(stale), reviewId);
    db.event(rv.repo, rv.number, `#${rv.number}: submit blocked — ${stale.join('; ')}`, { level: 'warn' });
    refreshItem(rv.repo, rv.number);
    throw Object.assign(new Error(`Submitting is blocked: ${stale.join('; ')}. Revisit the draft first (Re-review).`), { code: 'STALE', reasons: stale });
  }
  const o = outgoing(reviewId, { body: text });
  if (o.blocking) throw new Error(`refused: ${lintMessage(o)}`);
  const st = await stage(reviewId);
  if (st.failed.length) throw new Error(`${st.failed.length} comment(s) could not be staged (see them in the review); fix or exclude them, then submit again`);
  const sync = await syncStaged(reviewId);
  if (sync.status === 'submitted') return { submittedOnGitHub: true };
  const cur = db.review(reviewId);
  const hasComments = db.get(`SELECT COUNT(*) n FROM comments WHERE review_id = ? AND state = 'staged'`, reviewId).n;
  if (event === 'COMMENT' && !text && !hasComments) throw new Error('nothing to submit: no body and no comments');
  const r = await P.submitPendingReview(rv.repo, rv.number, cur.gh_review_id, { event, body: text });
  if (!r.ok) throw new Error(`GitHub refused the submission: ${r.error}`);
  db.run(`UPDATE reviews SET status = 'submitted', event = ?, body = ?, gh_url = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
    event, text, r.review.html_url || null, db.now(), db.now(), reviewId);
  db.run(`UPDATE comments SET state = 'posted', updated_at = ? WHERE review_id = ? AND state = 'staged'`, db.now(), reviewId);
  const after = [];
  for (const c of db.comments(reviewId).filter((x) => x.kind === 'issue' && x.include && x.state !== 'posted')) {
    try {
      const res = await P.rest('POST', `repos/${rv.repo}/issues/${rv.number}/comments`, { body: c.body });
      db.run(`UPDATE comments SET state = 'posted', gh_id = ?, gh_url = ? WHERE id = ?`, res.id, res.html_url, c.id);
    } catch (e) { db.run(`UPDATE comments SET state = 'failed', error = ? WHERE id = ?`, e.message.slice(0, 1000), c.id); after.push(`comment ${c.id}: ${e.message}`); }
  }
  for (const c of db.comments(reviewId).filter((x) => x.resolve && x.thread_id && (x.include || x.meta.resolveOnly))) {
    const res = await P.resolveThread(c.thread_id, true);
    if (!res.ok) after.push(`resolve ${c.thread_id}: ${res.error}`);
  }
  db.event(rv.repo, rv.number, `#${rv.number}: review submitted (${event})${after.length ? `; follow-up errors: ${after.join('; ')}` : ''}`, { level: after.length ? 'warn' : 'info' });
  // Re-read the PR so the desk knows about the review it just posted (lane: approved / waiting for author).
  try { await track(rv.repo, rv.number); } catch { refreshItem(rv.repo, rv.number); }
  return { url: r.review.html_url, event, errors: after };
}

/** Drop a round. A staged one is deleted on GitHub as well (only pending reviews can be). */
export async function discard(reviewId) {
  const rv = db.review(reviewId);
  if (rv.status === 'submitted') throw new Error('already submitted');
  if (rv.status === 'staged' && rv.gh_review_id) await P.deletePendingReview(rv.repo, rv.number, rv.gh_review_id);
  db.run(`UPDATE reviews SET status = 'discarded', updated_at = ? WHERE id = ?`, db.now(), reviewId);
  db.event(rv.repo, rv.number, `#${rv.number}: review round ${reviewId} discarded${rv.status === 'staged' ? ' (and its pending review on GitHub)' : ''}`);
  refreshItem(rv.repo, rv.number);
}

/** Parsed diff for the UI, with every comment of the round attached to its line. */
export async function diffView(repo, number, sha) {
  const { text } = await diffFor(repo, number, sha);
  const files = [...P.parseDiff(text).values()].map((f) => {
    let n = 0;
    const hunks = f.hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, oldLines: h.oldLines, newLines: h.newLines,
      lines: h.lines.filter(() => ++n <= 4000) }));
    return { path: f.path, oldPath: f.oldPath, status: f.status, binary: f.binary, truncated: n > 4000, lines: n, hunks };
  });
  return { sha, files };
}
