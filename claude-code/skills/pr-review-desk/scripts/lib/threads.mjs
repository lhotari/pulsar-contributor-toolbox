// Settling the open threads of an approved PR. GitHub refuses to merge while a conversation is unresolved
// (required_conversation_resolution), so an approved PR with open threads is stuck until someone closes them.
// A "threads" worker assesses each open thread and proposes one action; the human edits and applies them in the
// UI. Only apply() writes to GitHub: thread replies, follow-up issues and resolving threads.
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.mjs';
import * as P from './prt.mjs';
import { track } from './triage.mjs';

export const VERDICTS = ['ADDRESSED', 'OBSOLETE', 'NOT_ADDRESSED', 'FOLLOW_UP', 'NEEDS_HUMAN'];
export const ACTIONS = ['resolve', 'reply-resolve', 'nag', 'issue', 'leave'];
const idOf = (c) => (c ? String(c.fullDatabaseId ?? c.databaseId ?? '') || null : null);

function rawPr(repo, number) {
  const f = path.join(db.prDir(repo, number), 'pr.json');
  return fs.existsSync(f) ? db.J(fs.readFileSync(f, 'utf8')) : null;
}

/** Unresolved threads with their whole conversation, from the last full read of the PR. */
export function openThreads(repo, number, raw = rawPr(repo, number)) {
  return (raw?.reviewThreads?.nodes || []).filter((t) => !t.isResolved).map((t) => {
    const cs = t.comments?.nodes || [];
    return { id: t.id, path: t.path, line: t.line ?? t.originalLine ?? null, isOutdated: !!t.isOutdated, url: cs[0]?.url || null,
      reviewer: cs[0]?.author?.login || null, firstCommentId: idOf(cs[0]), lastCommentId: idOf(cs.at(-1)),
      comments: cs.map((c) => ({ author: c.author?.login || null, at: c.createdAt, url: c.url, body: c.body || '' })) };
  });
}

/** Why an approved PR cannot merge: its open threads. Null when it is not approved or nothing is open. */
export function mergeBlock(pr) {
  const open = pr?.analysis?.openThreads || [];
  const approved = pr?.review_decision === 'APPROVED' || pr?.analysis?.myLastSubstantiveState === 'APPROVED';
  return approved && open.length ? { open: open.length, outdated: open.filter((t) => t.isOutdated).length } : null;
}

export function actions(repo, number, { all = false } = {}) {
  return db.all(`SELECT * FROM thread_actions WHERE repo = ? AND number = ? ${all ? '' : `AND status IN ('proposed','failed')`} ORDER BY id`, repo, number)
    .map((r) => ({ ...r, include: !!r.include, result: db.J(r.result, {}) }));
}

function insert(repo, number, t, a, { jobId = null, head = null } = {}) {
  if (!ACTIONS.includes(a.action)) throw new Error(`thread ${t.id}: action must be one of ${ACTIONS.join(', ')}`);
  if (a.verdict && !VERDICTS.includes(a.verdict)) throw new Error(`thread ${t.id}: verdict must be one of ${VERDICTS.join(', ')}`);
  if (a.action === 'issue' && !a.issue?.title?.trim()) throw new Error(`thread ${t.id}: an "issue" action needs issue.title`);
  if (['nag', 'reply-resolve'].includes(a.action) && !a.reply?.trim()) throw new Error(`thread ${t.id}: a "${a.action}" action needs a reply`);
  const me = db.meta('login');
  // Resolving someone else's thread is their call unless they said so: proposed, but not ticked.
  const include = a.action === 'leave' ? 0 : (t.reviewer && me && t.reviewer !== me && a.action !== 'nag' ? 0 : 1);
  const r = db.run(`INSERT INTO thread_actions (repo, number, job_id, head_sha, thread_id, path, line, url, reviewer, last_comment_id, verdict, action, reply,
      issue_title, issue_body, evidence, include, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  repo, number, jobId, head, t.id, t.path, t.line, t.url, t.reviewer, t.lastCommentId, a.verdict || null, a.action, a.reply || null,
  a.issue?.title || null, a.issue?.body || null, a.evidence || null, a.include === undefined ? include : (a.include ? 1 : 0), db.now(), db.now());
  return Number(r.lastInsertRowid);
}

/** A worker's assessment: {head, threads: [{threadId, verdict, action, reply?, issue?: {title, body}, evidence}]}. Replaces earlier proposals. */
export function importPlan(job, plan) {
  const open = new Map(openThreads(job.repo, job.number).map((t) => [t.id, t]));
  const list = plan?.threads || [];
  const unknown = list.filter((x) => !open.has(x.threadId)).map((x) => x.threadId);
  if (unknown.length) throw new Error(`not open threads of #${job.number}: ${unknown.join(', ')}`);
  return db.tx(() => {
    db.run(`UPDATE thread_actions SET status = 'superseded', updated_at = ? WHERE repo = ? AND number = ? AND status IN ('proposed','failed')`, db.now(), job.repo, job.number);
    const ids = list.map((x) => insert(job.repo, job.number, open.get(x.threadId), x, { jobId: job.id, head: plan.head || job.head_sha }));
    const missed = [...open.keys()].filter((id) => !list.some((x) => x.threadId === id));
    db.event(job.repo, job.number, `#${job.number}: thread plan with ${ids.length} action(s)${missed.length ? `; ${missed.length} open thread(s) not assessed` : ''}`, { job: job.id });
    return { actions: ids.length, notAssessed: missed };
  });
}

/** One action added by hand (e.g. "follow-up issue and resolve" from the Threads tab). */
export function addAction(repo, number, a) {
  const t = openThreads(repo, number).find((x) => x.id === a.threadId);
  if (!t) throw new Error('that thread is not open (any more); sync the PR');
  db.run(`UPDATE thread_actions SET status = 'superseded', updated_at = ? WHERE repo = ? AND number = ? AND thread_id = ? AND status IN ('proposed','failed')`, db.now(), repo, number, t.id);
  return insert(repo, number, t, { ...a, include: true }, { head: db.pr(repo, number)?.head_sha });
}

export function updateAction(id, patch) {
  const cur = db.get('SELECT * FROM thread_actions WHERE id = ?', id);
  if (!cur) throw new Error(`no thread action ${id}`);
  if (patch.action && !ACTIONS.includes(patch.action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  const v = (k, col) => (patch[k] !== undefined ? patch[k] : cur[col]);
  db.run('UPDATE thread_actions SET action = ?, reply = ?, issue_title = ?, issue_body = ?, include = ?, updated_at = ? WHERE id = ?',
    v('action', 'action'), v('reply', 'reply'), v('issueTitle', 'issue_title'), v('issueBody', 'issue_body'),
    patch.include !== undefined ? (patch.include ? 1 : 0) : cur.include, db.now(), id);
}

/** The same lints as a review: no vulnerability disclosure, no description of how the review was run. */
export function lint(rows, ack = []) {
  const texts = rows.flatMap((r) => [[`thread ${r.path}:${r.line ?? ''} reply`, r.reply || ''], [`issue for ${r.path}:${r.line ?? ''}`, `${r.issue_title || ''}\n${r.issue_body || ''}`]]);
  const a = new Set(ack);
  const security = a.has('security') ? [] : P.securityHitsInTexts(texts.map(([, t]) => t));
  const tooling = P.toolingHitsInTexts(texts, [...a]);
  return { security, tooling, blocking: security.length > 0 || tooling.length > 0 };
}

export function issueText(pr, t, { title, body }) {
  const link = t.url || pr.url;
  const b = String(body || '').trim();
  return { title: title.trim(), body: `${b}${b.includes(link) ? '' : `${b ? '\n\n' : ''}Follow-up from ${link} in #${pr.number}.`}` };
}

export function replyWithIssue(reply, issue) {
  const r = String(reply || '').trim();
  if (!r) return `Thanks. This is tracked as a follow-up in #${issue}.`;
  return r.includes('{issue}') ? r.replaceAll('{issue}', `#${issue}`) : `${r}\n\nTracked in #${issue}.`;
}

/**
 * Apply the ticked actions on GitHub, in order. Re-reads the PR first: a thread resolved meanwhile is skipped,
 * and a thread with a new comment since the assessment is refused (the conversation moved on; re-assess it).
 */
export async function apply(repo, number, { ids = null, ack = [], gh = P } = {}) {
  let rows = actions(repo, number).filter((r) => r.include && r.action !== 'leave' && (!ids || ids.includes(r.id)));
  if (!rows.length) throw new Error('nothing to apply: tick at least one action');
  const l = lint(rows, ack);
  if (l.blocking) {
    const why = [l.security.length ? `the text mentions ${l.security.join(', ')}; never disclose a vulnerability on a public PR` : null,
      l.tooling.length ? `the text describes how the review was run: ${l.tooling.map((x) => x.label).join(', ')}` : null].filter(Boolean).join('. ');
    throw Object.assign(new Error(`refused: ${why}. Edit the text, or acknowledge to post it anyway.`), { code: 'LINT', lint: l });
  }
  await track(repo, number);
  const pr = db.pr(repo, number);
  if (pr.state !== 'OPEN') throw new Error(`#${number} is ${pr.state.toLowerCase()}`);
  const open = new Map(openThreads(repo, number).map((t) => [t.id, t]));
  const out = [];
  const done = (r, status, result) => {
    db.run('UPDATE thread_actions SET status = ?, result = ?, updated_at = ? WHERE id = ?', status, db.S(result), db.now(), r.id);
    out.push({ id: r.id, path: r.path, line: r.line, action: r.action, status, ...result });
  };
  for (const r of rows) {
    const t = open.get(r.thread_id);
    if (!t) { done(r, 'skipped', { note: 'already resolved on GitHub' }); continue; }
    if (r.last_comment_id && t.lastCommentId !== r.last_comment_id) { done(r, 'failed', { error: 'the thread has a new comment since it was assessed; re-assess it' }); continue; }
    try {
      const result = {};
      let reply = r.reply;
      if (r.action === 'issue') {
        const it = issueText(pr, t, { title: r.issue_title, body: r.issue_body });
        const created = await gh.rest('POST', `repos/${repo}/issues`, it);
        result.issue = created.number; result.issueUrl = created.html_url;
        reply = replyWithIssue(reply, created.number);
      }
      if (['reply-resolve', 'nag', 'issue'].includes(r.action) && reply?.trim()) {
        const res = await gh.replyToComment(repo, number, t.firstCommentId, reply);
        if (!res.ok) throw new Error(`reply failed: ${res.error}`);
        result.replyUrl = res.comment?.html_url || null;
      }
      if (r.action !== 'nag') {
        const res = await gh.resolveThread(t.id, true);
        if (!res.ok) throw new Error(`resolve failed: ${res.error}`);
        result.resolved = true;
      }
      done(r, 'applied', result);
    } catch (e) { done(r, 'failed', { error: e.message.split('\n')[0] }); }
  }
  const ok = out.filter((x) => x.status === 'applied');
  db.event(repo, number, `#${number}: threads — ${ok.filter((x) => x.resolved).length} resolved, ${ok.filter((x) => x.issue).length} follow-up issue(s)${ok.filter((x) => x.issue).map((x) => ` #${x.issue}`).join('')}, ${ok.filter((x) => x.action === 'nag').length} nudge(s)${out.length > ok.length ? `, ${out.length - ok.length} not applied` : ''}`,
    { level: out.some((x) => x.status === 'failed') ? 'warn' : 'info' });
  await track(repo, number).catch(() => {});
  return { results: out };
}
