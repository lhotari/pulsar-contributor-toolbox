// Resolving a PR's merge conflicts: merge the PR's base branch (from the upstream repo, e.g. master or
// branch-4.2) into a pinned checkout of the PR head. The engine fetches and starts the merge, a "merge" worker
// resolves the conflicts and commits, the engine checks and pins the result, and only the human's click pushes
// it to the PR branch (a fast-forward: the merge commit is a descendant of the head; never a force push).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as db from './db.mjs';
import * as P from './prt.mjs';
import { job, worktree } from './jobs.mjs';
import { track } from './triage.mjs';

const git = (dir, args, opts = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
const mergeRef = (j) => `refs/pr-desk/${j.number}/merge-${j.id}`;
const baseRef = (j) => `refs/pr-desk/${j.number}/base-${j.id}`;

/** Fetch the base branch from the upstream remote and start `git merge` in the job's worktree. */
export function start(id) {
  const j = job(id);
  if (j.type !== 'merge') throw new Error(`job ${id} is a ${j.type} job`);
  const pr = db.pr(j.repo, j.number); const r = db.repo(j.repo);
  const wt = worktree(id);   // refuses unless the security gate is clear for the pinned head
  const f = git(r.checkout, ['fetch', '--no-tags', '--force', r.remote || 'origin', `refs/heads/${pr.base_ref}:${baseRef(j)}`]);
  if (f.status !== 0) throw new Error(`fetching ${pr.base_ref} failed: ${f.stderr.trim()}`);
  const base = git(r.checkout, ['rev-parse', baseRef(j)]).stdout.trim();
  if (git(wt, ['merge-base', '--is-ancestor', base, 'HEAD']).status === 0) return { base, baseRef: pr.base_ref, upToDate: true, conflicts: [] };
  const m = git(wt, ['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${pr.base_ref}' of https://github.com/${j.repo} into the PR branch`, base]);
  const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
  db.event(j.repo, j.number, `#${j.number}: merging ${pr.base_ref} (${base.slice(0, 10)}) into ${j.head_sha.slice(0, 10)}: ${conflicts.length ? `${conflicts.length} conflicted file(s)` : m.status === 0 ? 'merged cleanly' : 'merge failed'}`, { job: id });
  if (m.status !== 0 && !conflicts.length) throw new Error(`git merge failed: ${(m.stderr || m.stdout).trim().slice(0, 800)}`);
  return { worktree: wt, base, baseRef: pr.base_ref, conflicts, committed: m.status === 0 };
}

/** Check the worker's result and pin it: a merge commit of (pinned head, fetched base), clean tree, no markers left. */
export function ready(id) {
  const j = job(id); const r = db.repo(j.repo);
  if (!j.worktree || !fs.existsSync(j.worktree)) throw new Error('no worktree: run `prd job merge-start` first');
  const wt = j.worktree;
  const base = git(r.checkout, ['rev-parse', baseRef(j)]).stdout.trim();
  if (fs.existsSync(`${git(wt, ['rev-parse', '--git-dir']).stdout.trim()}/MERGE_HEAD`)) throw new Error('the merge is still in progress: resolve, `git add` and `git commit` first');
  const status = git(wt, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  if (status) throw new Error(`the worktree has uncommitted changes:\n${status.slice(0, 600)}`);
  const sha = git(wt, ['rev-parse', 'HEAD']).stdout.trim();
  const parents = git(wt, ['rev-list', '--parents', '-n', '1', sha]).stdout.trim().split(' ').slice(1);
  if (parents.length !== 2 || parents[0] !== j.head_sha || parents[1] !== base) {
    throw new Error(`HEAD ${sha.slice(0, 10)} is not one merge commit of the PR head ${j.head_sha.slice(0, 10)} and the base ${base.slice(0, 10)} (parents: ${parents.map((p) => p.slice(0, 10)).join(', ') || 'none'})`);
  }
  // Only where the merge changed the PR's files: fixtures elsewhere may contain marker-like lines.
  const changed = git(wt, ['diff', '--name-only', j.head_sha, sha]).stdout.split('\n').filter(Boolean);
  const markers = changed.length ? git(wt, ['grep', '-n', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)', sha, '--', ...changed]).stdout.trim() : '';
  if (markers) throw new Error(`conflict markers left:\n${markers.slice(0, 600)}`);
  // What the resolution changed beyond a plain merge: the files that conflicted, and the merge's own diff.
  const touched = git(wt, ['diff', '--stat', `${parents[1]}...${sha}`]).stdout.trim().split('\n').slice(-1)[0] || '';
  const cc = git(wt, ['show', '--cc', '--format=', sha]).stdout;
  git(r.checkout, ['update-ref', mergeRef(j), sha]);
  const res = { mergeSha: sha, base, baseRef: db.pr(j.repo, j.number).base_ref, head: j.head_sha, ref: mergeRef(j), combinedDiff: cc.slice(0, 60_000), stat: touched };
  db.run(`UPDATE jobs SET result = json_set(COALESCE(result, '{}'), '$.merge', json(?)) WHERE id = ?`, db.S(res), id);
  return res;
}

/** The human's click: push the pinned merge commit to the PR's head branch. Fast-forward only. */
export async function push(id, { urlFor = (full) => `https://github.com/${full}.git` } = {}) {
  const j = job(id); const r = db.repo(j.repo);
  const m = j.result?.merge;
  if (!m?.mergeSha) throw new Error('this job has no checked merge commit');
  if (j.result?.pushed) throw new Error(`already pushed (${j.result.pushed.at})`);
  const pr = await P.rest('GET', `repos/${j.repo}/pulls/${j.number}`);
  if (pr.state !== 'open') throw new Error(`#${j.number} is ${pr.state}`);
  if (pr.head.sha !== m.head) throw new Error(`the PR head moved to ${pr.head.sha.slice(0, 10)} since the merge was made on ${m.head.slice(0, 10)}; resolve again`);
  const sameRepo = pr.head.repo?.full_name === pr.base.repo.full_name;
  if (!sameRepo && !pr.maintainer_can_modify) throw new Error('the author has not allowed edits from maintainers on this PR; ask them to merge the base branch, or to enable "Allow edits from maintainers"');
  if (!pr.head.repo) throw new Error('the head repository was deleted');
  const url = urlFor(pr.head.repo.full_name);
  const p = git(r.checkout, ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', url, `${m.mergeSha}:refs/heads/${pr.head.ref}`]);
  if (p.status !== 0) throw new Error(`push failed: ${(p.stderr || '').trim().slice(0, 800)}`);
  // Like "Update branch": my merge commit is not new work by the author for the follow-up lane.
  db.meta(`branchUpdate:${j.repo}#${j.number}`, JSON.stringify({ from: m.head, to: m.mergeSha, at: db.now() }));
  db.run(`UPDATE jobs SET result = json_set(COALESCE(result, '{}'), '$.pushed', json(?)) WHERE id = ?`, db.S({ at: db.now(), to: `${pr.head.repo.full_name}:${pr.head.ref}` }), id);
  db.event(j.repo, j.number, `#${j.number}: pushed the merge of ${m.baseRef} (${m.mergeSha.slice(0, 10)}) to ${pr.head.repo.full_name}:${pr.head.ref}`);
  await track(j.repo, j.number).catch(() => {});
  return { pushed: m.mergeSha, to: `${pr.head.repo.full_name}:${pr.head.ref}` };
}
