// CI hand-off at approval time: approve the workflow runs GitHub holds for approval (fork PRs from outside
// contributors), and optionally update the PR branch from its base first so CI runs on the latest base
// before the PR is merged. Runs only on the human's submit click, never from a worker.
import * as db from './db.mjs';
import * as P from './prt.mjs';

const DAY = 86_400_000;
export const QUIET_DAYS = 7;

const isPending = (r) => r.status === 'action_required' || r.conclusion === 'action_required';
const runAt = (r) => r.run_started_at || r.created_at;

export async function runsFor(repo, sha) {
  const r = await P.rest('GET', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
  return (r?.workflow_runs || []).map((x) => ({ id: x.id, name: x.name, event: x.event, status: x.status, conclusion: x.conclusion,
    at: runAt(x), url: x.html_url, pending: isPending(x) }));
}

/** What the submit dialog needs: runs waiting for approval, how stale the branch is, and the defaults. */
export async function status(repo, number) {
  const pr = await P.rest('GET', `repos/${repo}/pulls/${number}`);
  const sha = pr.head.sha;
  const [runs, commit, cmp] = await Promise.all([
    runsFor(repo, sha),
    P.rest('GET', `repos/${repo}/commits/${sha}`).catch(() => null),
    P.rest('GET', `repos/${repo}/compare/${encodeURIComponent(pr.base.ref)}...${sha}?per_page=1`).catch(() => null),
  ]);
  const lastCommitAt = commit?.commit?.committer?.date || null;
  const lastRunAt = runs.map((r) => r.at).filter(Boolean).sort().at(-1) || null;
  const latest = [lastCommitAt, lastRunAt].filter(Boolean).sort().at(-1) || null;
  const quiet = !latest || Date.now() - Date.parse(latest) > QUIET_DAYS * DAY;
  const sameRepo = pr.head.repo?.full_name === pr.base.repo.full_name;
  const canUpdate = sameRepo || !!pr.maintainer_can_modify;
  const behindBy = cmp ? cmp.behind_by : null;
  const it = db.item(repo, number);
  const gateBlocks = ['flagged', 'suspicious'].includes(it?.gate) && it.gate_sha === sha;
  return {
    head: sha, base: pr.base.ref, behindBy, canUpdate, lastCommitAt, lastRunAt, quiet, quietDays: QUIET_DAYS,
    pending: runs.filter((r) => r.pending), runs: runs.length, gate: it?.gate || null, gateBlocks,
    defaults: { approveRuns: !gateBlocks, updateBranch: !gateBlocks && canUpdate && quiet && behindBy !== 0 },
  };
}

/** Approve every run on `sha` that waits for approval. */
export async function approveRuns(repo, sha) {
  const out = { approved: [], errors: [] };
  for (const r of (await runsFor(repo, sha)).filter((x) => x.pending)) {
    try { await P.rest('POST', `repos/${repo}/actions/runs/${r.id}/approve`); out.approved.push(r.name || String(r.id)); }
    catch (e) { out.errors.push(`${r.name || r.id}: ${e.message.split('\n')[0]}`); }
  }
  return out;
}

/** Merge the base into the PR branch (GitHub's "Update branch"); refuses if the head moved meanwhile. */
export async function updateBranch(repo, number, expectedSha) {
  await P.rest('PUT', `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: expectedSha });
  // The merge commit GitHub creates is ours, not the author's: the follow-up lane must not treat it as new work.
  db.meta(`branchUpdate:${repo}#${number}`, JSON.stringify({ from: expectedSha, at: db.now() }));
}

/** A head the desk itself moved with "Update branch" from the commit my review read. */
export function updatedByMe(repo, number, reviewedOid, headOid) {
  const m = db.J(db.meta(`branchUpdate:${repo}#${number}`));
  if (!m || !reviewedOid || m.from !== reviewedOid) return false;
  if (m.to) return m.to === headOid;
  // Not resolved yet (the follow-up is still waiting for the merge commit): trust it only briefly.
  return Date.now() - Date.parse(m.at) < 10 * 60_000;
}

/**
 * After "Update branch": wait for the merge commit, then approve the runs it triggers as they appear.
 * Background, best effort; everything it does lands in the activity log.
 */
export async function followUp(repo, number, fromSha, { onDone = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), polls = 30 } = {}) {
  let head = fromSha;
  for (let i = 0; i < 18 && head === fromSha; i++) { await sleep(5000); head = (await P.rest('GET', `repos/${repo}/pulls/${number}`).catch(() => null))?.head?.sha || head; }
  if (head === fromSha) { db.event(repo, number, `#${number}: the branch update has not produced a new head yet; approve its workflow runs on GitHub`, { level: 'warn' }); return onDone(); }
  db.meta(`branchUpdate:${repo}#${number}`, JSON.stringify({ from: fromSha, to: head, at: db.now() }));
  db.event(repo, number, `#${number}: branch updated from ${fromSha.slice(0, 7)} to ${head.slice(0, 7)}`);
  const approved = []; let seen = 0; let quiet = 0;
  for (let i = 0; i < polls && quiet < 3; i++) {
    await sleep(10_000);
    const runs = await runsFor(repo, head).catch(() => []);
    const r = await approveRuns(repo, head).catch((e) => ({ approved: [], errors: [e.message] }));
    approved.push(...r.approved);
    if (r.errors.length) db.event(repo, number, `#${number}: approving workflow runs failed: ${r.errors.join('; ')}`, { level: 'warn' });
    // Stop once runs exist and a few polls pass with nothing left to approve.
    if (runs.length && runs.length === seen && !runs.some((x) => x.pending)) quiet++; else quiet = 0;
    seen = runs.length;
  }
  db.event(repo, number, approved.length ? `#${number}: approved ${approved.length} workflow run(s) on ${head.slice(0, 7)}: ${[...new Set(approved)].join(', ')}`
    : `#${number}: no workflow runs on ${head.slice(0, 7)} needed approval`);
  return onDone();
}
