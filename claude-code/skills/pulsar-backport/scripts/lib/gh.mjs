// GitHub access through the gh CLI. Everything that writes to GitHub goes through this file.
import { spawnSync } from 'node:child_process';

export const REPO = process.env.BPT_REPO_SLUG || 'apache/pulsar';

export function gh(args, { json = false, allowFail = false, input } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, input });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`gh ${args.slice(0, 4).join(' ')} failed: ${(r.stderr || '').trim().slice(0, 1500)}`);
  }
  return json ? JSON.parse(r.stdout || 'null') : r.stdout.trim();
}

/** Labels, body, merge time and author for many PRs, 40 per GraphQL request. */
export function prMeta(prs, repo = REPO) {
  const [owner, name] = repo.split('/');
  const out = new Map();
  for (let i = 0; i < prs.length; i += 40) {
    const chunk = prs.slice(i, i + 40);
    const q = `query{repository(owner:"${owner}",name:"${name}"){${chunk.map((p) =>
      `p${p}:pullRequest(number:${p}){number body mergedAt author{login} labels(first:40){nodes{name}}}`).join(' ')}}}`;
    const res = gh(['api', 'graphql', '-f', `query=${q}`], { json: true, allowFail: true });
    const repoData = res?.data?.repository || {};
    for (const v of Object.values(repoData)) {
      if (!v) continue;
      out.set(v.number, { body: v.body || '', mergedAt: v.mergedAt, author: v.author?.login,
        labels: v.labels.nodes.map((n) => n.name) });
    }
  }
  return out;
}

export function findPr(headBranch, repo = REPO) {
  const list = gh(['pr', 'list', '-R', repo, '--head', headBranch, '--state', 'all', '--json', 'number,url,state'], { json: true });
  return list?.find((p) => p.state === 'OPEN') || list?.[0] || null;
}

export function createPr({ base, head, title, body, labels = [] }, repo = REPO) {
  const url = gh(['pr', 'create', '-R', repo, '--base', base, '--head', head, '--title', title, '--body-file', '-'], { input: body });
  const number = Number(url.trim().split('/').pop());
  for (const l of labels) gh(['pr', 'edit', String(number), '-R', repo, '--add-label', l], { allowFail: true });
  return { number, url: url.trim() };
}

export function editLabels(pr, { add = [], remove = [] }, repo = REPO) {
  const args = ['pr', 'edit', String(pr), '-R', repo];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  if (add.length || remove.length) gh(args);
}

/** Returns the comment URL that gh prints. */
export function comment(pr, body, repo = REPO) {
  return gh(['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], { input: body });
}

export function closePr(pr, body, repo = REPO) {
  if (body) comment(pr, body, repo);
  gh(['pr', 'close', String(pr), '-R', repo], { allowFail: true });
}

function summarize(checks) {
  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const pending = checks.filter((c) => c.bucket === 'pending');
  const state = !checks.length ? 'pending' : failed.length ? (pending.length ? 'failing' : 'failure')
    : pending.length ? 'pending' : 'success';
  return { state, total: checks.length, pending: pending.length,
    failed: failed.map((c) => ({ name: c.name, link: c.link, workflow: c.workflow })) };
}

/** CI state of a PR's head commit. */
export function prChecks(pr, repo = REPO) {
  const checks = gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,bucket,link,workflow'], { json: true, allowFail: true }) || [];
  return summarize(checks);
}

/** CI state of a pushed commit (final branch pushes have no PR). */
export function commitChecks(sha, repo = REPO) {
  const runs = gh(['run', 'list', '-R', repo, '--commit', sha, '--json', 'databaseId,name,status,conclusion,url,event', '--limit', '50'], { json: true, allowFail: true }) || [];
  const checks = runs.map((r) => ({
    name: r.name, link: r.url, workflow: r.name,
    bucket: r.status !== 'completed' ? 'pending'
      : ['success', 'skipped', 'neutral'].includes(r.conclusion) ? 'pass' : 'fail',
  }));
  return { ...summarize(checks), runs: runs.map((r) => r.databaseId) };
}

/** The workflow runs of a commit, for reports: [{id, name, status, conclusion, url, event, attempt, createdAt}]. */
export function workflowRuns(sha, repo = REPO) {
  const fields = 'databaseId,name,status,conclusion,url,event,attempt,createdAt';
  const runs = gh(['run', 'list', '-R', repo, '--commit', sha, '--json', fields, '--limit', '100'], { json: true, allowFail: true })
    || gh(['run', 'list', '-R', repo, '--commit', sha, '--json', fields.replace(',attempt', ''), '--limit', '100'], { json: true, allowFail: true }) || [];
  return runs.map((r) => ({ id: r.databaseId, name: r.name, status: r.status, conclusion: r.conclusion, url: r.url, event: r.event, attempt: r.attempt, createdAt: r.createdAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function failedRunIds(sha, repo = REPO) {
  const runs = gh(['run', 'list', '-R', repo, '--commit', sha, '--json', 'databaseId,status,conclusion', '--limit', '50'], { json: true, allowFail: true }) || [];
  return runs.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion)).map((r) => r.databaseId);
}

/** Pulsar CI has no push trigger, so a pushed release branch needs workflow_dispatch runs. */
export function dispatch(workflow, ref, repo = REPO) {
  gh(['workflow', 'run', workflow, '-R', repo, '--ref', ref]);
}

export function rerunFailed(runId, repo = REPO) {
  gh(['run', 'rerun', String(runId), '-R', repo, '--failed']);
}
