// Preparing a change to someone else's PR: new commits on top of the PR head that address review threads (one or
// several) and/or the user's own instructions, in one batch. A "change" worker (or the human, in the worktree the
// engine creates) commits on top of the pinned head; the engine checks and pins the result; the human reviews the
// commits and the diff in the UI and only their click pushes them to the PR branch (a fast-forward, never a force
// push) and then replies to and resolves the threads they chose.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as db from './db.mjs';
import * as P from './prt.mjs';
import { job, worktree, cleanupWorktree, finish } from './jobs.mjs';
import { openThreads } from './threads.mjs';
import { track } from './triage.mjs';

const git = (dir, args, opts = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
export const changeRef = (j) => `refs/pr-desk/${j.number}/change-${j.id}`;
const MAX_DIFF = 400_000;

/** Refuse early what cannot be pushed: a fork PR whose author does not allow maintainer edits, a closed PR. */
export async function pushable(repo, number, { gh = P } = {}) {
  const pr = await gh.rest('GET', `repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open') throw new Error(`#${number} is ${pr.state}`);
  if (!pr.head.repo) throw new Error('the head repository was deleted');
  const sameRepo = pr.head.repo.full_name === pr.base.repo.full_name;
  if (!sameRepo && !pr.maintainer_can_modify) throw new Error('the author has not allowed edits from maintainers on this PR; ask them to enable "Allow edits from maintainers", or suggest the change in a review instead');
  return pr;
}

/** The threads a change job addresses, with their whole conversation (from the last full read of the PR). */
export function threadsFor(j) {
  const ids = j.args.threadIds || [];
  return openThreads(j.repo, j.number).filter((t) => ids.includes(t.id));
}

/** Create the job's worktree at the pinned head (security gate must be clear). Commits go on top of it. */
export function start(id) {
  const j = job(id);
  if (j.type !== 'change') throw new Error(`job ${id} is a ${j.type} job`);
  const wt = worktree(id);
  db.event(j.repo, j.number, `#${j.number}: worktree for a change at ${j.head_sha.slice(0, 10)}: ${wt}`, { job: id });
  return { worktree: wt, head: j.head_sha, threads: threadsFor(j).map((t) => ({ id: t.id, path: t.path, line: t.line, reviewer: t.reviewer })) };
}

/**
 * Check the commits on top of the pinned head and pin them: at least one, no merge commit, a clean tree, no
 * operation in progress, no conflict markers. `replies`: [{threadId, reply, resolve}] proposed for the threads.
 */
export function ready(id, { replies = null } = {}) {
  const j = job(id);
  if (j.type !== 'change') throw new Error(`job ${id} is a ${j.type} job`);
  if (!j.worktree || !fs.existsSync(j.worktree)) throw new Error('no worktree: run `prd job change-start` first');
  const wt = j.worktree;
  const gd = git(wt, ['rev-parse', '--git-dir']).stdout.trim();
  for (const f of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (fs.existsSync(`${gd}/${f}`)) throw new Error(`an operation is in progress in the worktree (${f}); finish or abort it first`);
  }
  const status = git(wt, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  if (status) throw new Error(`the worktree has uncommitted changes; commit them (or discard them) first:\n${status.slice(0, 600)}`);
  const sha = git(wt, ['rev-parse', 'HEAD']).stdout.trim();
  if (git(wt, ['merge-base', '--is-ancestor', j.head_sha, sha]).status !== 0) throw new Error(`HEAD ${sha.slice(0, 10)} is not on top of the PR head ${j.head_sha.slice(0, 10)}: add new commits, never rewrite the PR's own`);
  const commits = git(wt, ['log', '--reverse', '--format=%H%x09%P%x09%an <%ae>%x09%s', `${j.head_sha}..${sha}`]).stdout.split('\n').filter(Boolean)
    .map((l) => { const [c, parents, author, subject] = l.split('\t'); return { sha: c, merge: parents.split(' ').length > 1, author, subject }; });
  if (!commits.length) throw new Error('no commits on top of the PR head yet');
  const merges = commits.filter((c) => c.merge);
  if (merges.length) throw new Error(`merge commit(s) ${merges.map((c) => c.sha.slice(0, 10)).join(', ')}: a change is plain commits on top of the head (to merge the latest base branch, use "Merge <base>" in the Branch panel)`);
  const changed = git(wt, ['diff', '--name-only', j.head_sha, sha]).stdout.split('\n').filter(Boolean);
  const markers = changed.length ? git(wt, ['grep', '-n', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)', sha, '--', ...changed]).stdout.trim() : '';
  if (markers) throw new Error(`conflict markers left:\n${markers.slice(0, 600)}`);
  const stat = git(wt, ['diff', '--stat', j.head_sha, sha]).stdout.trim();
  const diff = git(wt, ['diff', j.head_sha, sha]).stdout;
  const prev = j.result?.change || {};
  // Replies: the worker's proposal, else what was there (the user's edits survive a re-check), else a default.
  const byId = new Map((replies || prev.replies || []).map((r) => [r.threadId, r]));
  const rs = threadsFor(j).map((t) => {
    const r = byId.get(t.id);
    return { threadId: t.id, path: t.path, line: t.line, reviewer: t.reviewer, url: t.url,
      reply: r?.reply ?? 'Addressed in {commits}.', resolve: r?.resolve ?? true };
  });
  git(db.repo(j.repo).checkout, ['update-ref', changeRef(j), sha]);
  const res = { sha, head: j.head_sha, ref: changeRef(j), commits: commits.map(({ merge, ...c }) => c), stat: stat.split('\n').slice(-1)[0] || '',
    statFull: stat, files: changed, diff: diff.slice(0, MAX_DIFF), diffTruncated: diff.length > MAX_DIFF, replies: rs, checkedAt: db.now() };
  db.run(`UPDATE jobs SET result = json_set(COALESCE(result, '{}'), '$.change', json(?)) WHERE id = ?`, db.S(res), id);
  db.event(j.repo, j.number, `#${j.number}: change checked: ${commits.length} commit(s) on ${j.head_sha.slice(0, 10)}, ${res.stat}`, { job: id });
  return res;
}

/** Links to the pushed commits for a thread reply: "{commits}" in the reply becomes them. */
export function replyText(reply, { repo, commits }) {
  const links = commits.map((c) => `https://github.com/${repo}/commit/${c.sha}`);
  const list = links.length === 1 ? links[0] : links.join(', ');
  const r = String(reply || '').trim();
  if (!r) return `Addressed in ${list}.`;
  return r.includes('{commits}') ? r.replaceAll('{commits}', list) : r;
}

/** The same lints as a review and the thread actions: no vulnerability disclosure, no review mechanics. */
export function lint(replies, ack = []) {
  const texts = replies.map((r) => [`reply on ${r.path}:${r.line ?? ''}`, r.reply || '']);
  const a = new Set(ack);
  const security = a.has('security') ? [] : P.securityHitsInTexts(texts.map(([, t]) => t));
  const tooling = P.toolingHitsInTexts(texts, [...a]);
  return { security, tooling, blocking: security.length > 0 || tooling.length > 0 };
}

/**
 * The human's click: push the pinned commits to the PR branch (fast-forward only), then post the chosen replies
 * and resolve the chosen threads. `replies` (optional) replaces the stored ones: [{threadId, reply, resolve, post}].
 */
export async function push(id, { replies = null, ack = [], gh = P, urlFor = (full) => `https://github.com/${full}.git`, pushFn = null } = {}) {
  const j = job(id); const r = db.repo(j.repo);
  const c = j.result?.change;
  if (!c?.sha) throw new Error('this job has no checked change: "Check commits" first');
  if (j.result?.pushed) throw new Error(`already pushed (${j.result.pushed.at})`);
  if (['queued', 'running'].includes(j.status)) throw new Error('the change job is still running; wait for it to finish (or cancel it)');
  if (j.worktree && fs.existsSync(j.worktree) && git(j.worktree, ['rev-parse', 'HEAD']).stdout.trim() !== c.sha) {
    throw new Error('the worktree has commits that were not checked: "Check commits" again, so you push what you reviewed');
  }
  const rs = (replies || c.replies || []).filter((x) => x.post !== false && (x.reply?.trim() || x.resolve));
  const l = lint(rs.filter((x) => x.reply?.trim()), ack);
  if (l.blocking) {
    const why = [l.security.length ? `a reply mentions ${l.security.join(', ')}; never disclose a vulnerability on a public PR` : null,
      l.tooling.length ? `a reply describes how the review was run: ${l.tooling.map((x) => x.label).join(', ')}` : null].filter(Boolean).join('. ');
    throw Object.assign(new Error(`refused: ${why}. Edit the text, or acknowledge to post it anyway.`), { code: 'LINT', lint: l });
  }
  const pr = await pushable(j.repo, j.number, { gh });
  if (pr.head.sha !== c.head) throw new Error(`the PR head moved to ${pr.head.sha.slice(0, 10)} since the change was made on ${c.head.slice(0, 10)}; prepare it again`);
  const url = urlFor(pr.head.repo.full_name);
  const p = pushFn ? pushFn(url, c.sha, pr.head.ref)
    : git(r.checkout, ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', url, `${c.sha}:refs/heads/${pr.head.ref}`]);
  if (p.status !== 0) throw new Error(`push failed: ${(p.stderr || '').trim().slice(0, 800)}`);
  // My commits are not new work by the author for the follow-up lane (like "Update branch").
  db.meta(`branchUpdate:${j.repo}#${j.number}`, JSON.stringify({ from: c.head, to: c.sha, at: db.now() }));
  const pushed = { at: db.now(), to: `${pr.head.repo.full_name}:${pr.head.ref}`, sha: c.sha };
  db.run(`UPDATE jobs SET result = json_set(COALESCE(result, '{}'), '$.pushed', json(?)) WHERE id = ?`, db.S(pushed), id);
  db.event(j.repo, j.number, `#${j.number}: pushed ${c.commits.length} commit(s) (${c.head.slice(0, 10)}..${c.sha.slice(0, 10)}) to ${pushed.to}`, { job: id });
  // Threads: re-read so a thread resolved meanwhile is skipped.
  await track(j.repo, j.number).catch(() => {});
  const open = new Map(openThreads(j.repo, j.number).map((t) => [t.id, t]));
  const out = [];
  for (const x of rs) {
    const t = open.get(x.threadId);
    if (!t) { out.push({ threadId: x.threadId, status: 'skipped', note: 'not open any more' }); continue; }
    try {
      const o = { threadId: x.threadId, path: t.path, line: t.line, status: 'applied' };
      if (x.reply?.trim()) {
        const res = await gh.replyToComment(j.repo, j.number, t.firstCommentId, replyText(x.reply, { repo: j.repo, commits: c.commits }));
        if (!res.ok) throw new Error(`reply failed: ${res.error}`);
        o.replyUrl = res.comment?.html_url || null;
      }
      if (x.resolve) {
        const res = await gh.resolveThread(t.id, true);
        if (!res.ok) throw new Error(`resolve failed: ${res.error}`);
        o.resolved = true;
      }
      out.push(o);
    } catch (e) { out.push({ threadId: x.threadId, path: t.path, line: t.line, status: 'failed', error: e.message.split('\n')[0] }); }
  }
  db.run(`UPDATE jobs SET result = json_set(COALESCE(result, '{}'), '$.threadResults', json(?)) WHERE id = ?`, db.S(out), id);
  if (out.length) {
    db.event(j.repo, j.number, `#${j.number}: change threads: ${out.filter((x) => x.replyUrl).length} replied, ${out.filter((x) => x.resolved).length} resolved${out.some((x) => x.status === 'failed') ? `, ${out.filter((x) => x.status === 'failed').length} failed` : ''}`,
      { job: id, level: out.some((x) => x.status === 'failed') ? 'warn' : 'info' });
  }
  if (job(id).status === 'waiting') finish(id, 'done', { summary: `pushed by the user: ${c.commits.length} commit(s)` });
  cleanupWorktree(job(id), { force: true });
  await track(j.repo, j.number).catch(() => {});
  return { pushed: c.sha, to: pushed.to, threads: out };
}

/** Throw the prepared change away: the worktree, its commits and the pinned ref. */
export function discard(id) {
  const j = job(id);
  if (j.type !== 'change') throw new Error(`job ${id} is a ${j.type} job`);
  if (j.result?.pushed) throw new Error('already pushed');
  if (['queued', 'running'].includes(j.status)) throw new Error('the job is still running: cancel it first');
  const r = db.repo(j.repo);
  cleanupWorktree(j, { force: true });
  git(r.checkout, ['update-ref', '-d', changeRef(j)]);
  db.run(`UPDATE jobs SET result = json_set(COALESCE(result, '{}'), '$.discarded', ?) WHERE id = ?`, db.now(), id);
  if (j.status === 'waiting') db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`, db.now(), id);
  db.event(j.repo, j.number, `#${j.number}: discarded the prepared change of job ${id}`, { job: id });
  return { discarded: id };
}
