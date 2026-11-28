#!/usr/bin/env node
// A stateful stand-in for `gh`: one repo (o/r), PRs from $FAKE_GH_STATE, pending reviews kept in that file.
// Enough of GraphQL and REST for sync, scan, stage, sync-from-GitHub and submit.
import fs from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* none */ }
// Atomic: gh calls run concurrently (Promise.all); a torn write would break the next reader.
const save = () => { const t = `${file}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(st, null, 1)); fs.renameSync(t, file); };
const ok = (o) => { process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o)); save(); process.exit(0); };
const fail = (m, code = 1) => { process.stderr.write(m); save(); process.exit(code); };
st.calls = st.calls || []; st.calls.push(args.join(' ').slice(0, 300));
const vars = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') { const [k, ...v] = args[i + 1].split('='); vars[k] = v.join('='); }
const q = vars.query || '';
const pr = (n) => st.prs[n];
const core = (p) => ({ id: `PR_${p.number}`, number: p.number, title: p.title, url: `https://github.com/o/r/pull/${p.number}`, state: 'OPEN', isDraft: false, merged: false,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: p.updatedAt, additions: 3, deletions: 0, changedFiles: 1, headRefOid: p.head, baseRefName: p.base || 'main',
  authorAssociation: p.association, reviewDecision: p.reviewDecision || null, mergeable: p.mergeable || 'MERGEABLE', author: { login: p.author }, labels: { nodes: [] },
  commits: { nodes: [{ commit: { oid: p.head, statusCheckRollup: { state: 'SUCCESS' } } }] }, reviews: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
  reviewThreads: { nodes: (p.threads || []).map((t) => ({ isOutdated: false, line: 2, diffSide: 'RIGHT', resolvedBy: null, ...t, isResolved: (st.resolved || []).includes(t.id) || !!t.isResolved,
    comments: { nodes: t.comments.map((c) => ({ databaseId: c.id, author: { login: c.author }, createdAt: c.at || '2026-11-10T00:00:00Z', url: c.url || `${t.id}-${c.id}`, body: c.body })) } })) }, comments: { nodes: (p.comments || []).map((c) => ({ author: { login: c.author }, createdAt: c.at, url: c.url || 'u', body: c.body || '' })) }, body: 'body' });
let nextId = () => (st.seq = (st.seq || 1000) + 1);

if (args[0] === 'auth') ok('logged in');
if (args[0] === 'pr' && args[1] === 'diff') ok(pr(Number(args[2])).diff);
if (args[0] === 'api' && args[1] === 'graphql') {
  if (q.includes('viewer')) ok({ data: { viewer: { login: 'me' } } });
  if (q.includes('search(')) {
    const nodes = /review-requested|reviewed-by|commenter/.test(vars.q || '') ? [] : Object.values(st.prs).map(core);
    ok({ data: { search: { pageInfo: { hasNextPage: false }, nodes } } });
  }
  if (q.includes('addPullRequestReviewThreadReply')) {
    const id = nextId(); st.review.comments.push({ id, node_id: `C${id}`, body: vars.body, in_reply_to_id: 1, path: 'a.txt', line: 1, side: 'RIGHT' });
    ok({ data: { addPullRequestReviewThreadReply: { comment: { id: `C${id}`, databaseId: id, url: `u${id}` } } } });
  }
  if (q.includes('addPullRequestReviewThread')) {
    const id = nextId(); st.review.comments.push({ id, node_id: `C${id}`, body: vars.body, path: vars.path, line: Number(vars.line) || null, side: vars.side || 'RIGHT' });
    ok({ data: { addPullRequestReviewThread: { thread: { id: `T${id}`, path: vars.path, subjectType: 'LINE', comments: { nodes: [{ databaseId: id, url: `u${id}` }] } } } } });
  }
  if (q.includes('addPullRequestReview(')) {
    st.review = { id: 500, node_id: 'R500', state: 'PENDING', commit: vars.oid, comments: [] };
    ok({ data: { addPullRequestReview: { pullRequestReview: { id: 'R500', databaseId: 500, url: 'https://github.com/o/r/pull/1#pullrequestreview-500', state: 'PENDING' } } } });
  }
  if (q.includes('updatePullRequestReviewComment')) { const c = st.review.comments.find((x) => x.node_id === vars.id); c.body = vars.body; ok({ data: {} }); }
  if (q.includes('deletePullRequestReviewComment')) { st.review.comments = st.review.comments.filter((x) => x.node_id !== vars.id); ok({ data: {} }); }
  if (q.includes('resolveReviewThread')) { st.resolved = [...(st.resolved || []), vars.id]; ok({ data: {} }); }
  if (q.includes('pullRequest(number:')) {
    const repo = {}; for (const m of q.matchAll(/p(\d+): pullRequest\(number:(\d+)\)/g)) if (pr(Number(m[2]))) repo[`p${m[1]}`] = core(pr(Number(m[2])));
    ok({ data: { repository: repo } });
  }
  fail(`fake-gh: unknown graphql ${q.slice(0, 120)}`);
}
if (args[0] === 'api') {
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
  const path = args.find((a) => /^repos\//.test(a)) || '';
  const body = stdin ? JSON.parse(stdin) : null;
  if (/collaborators\/[^/]+\/permission/.test(path)) ok({ permission: path.includes('committer') ? 'write' : 'read' });
  if (/git\/trees\//.test(path)) ok({ tree: [{ type: 'blob', path: 'a.txt' }, { type: 'blob', path: 'src/Other.java' }], truncated: false });
  if (/pulls\/\d+\/reviews\/500\/comments/.test(path)) ok([st.review?.comments || []]);
  if (/pulls\/\d+\/reviews\/500\/events$/.test(path) && method === 'POST') {
    st.review.state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[body.event] || 'COMMENTED'; st.review.body = body.body;
    ok({ id: 500, state: st.review.state, html_url: 'https://github.com/o/r/pull/1#pullrequestreview-500' });
  }
  if (/pulls\/\d+\/reviews\/500$/.test(path)) {
    if (method === 'DELETE') { st.review = null; ok({}); }
    if (!st.review) fail('HTTP 404: Not Found');
    ok({ id: 500, node_id: 'R500', state: st.review.state, html_url: 'https://github.com/o/r/pull/1#pullrequestreview-500' });
  }
  if (/pulls\/\d+\/reviews\?/.test(path)) ok([st.review ? [{ id: 500, node_id: 'R500', state: st.review.state, user: { login: 'me' } }] : []]);
  let mm;
  if ((mm = /pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(path)) && method === 'POST') {
    const id = nextId(); st.replies = [...(st.replies || []), { pr: Number(mm[1]), to: Number(mm[2]), body: body.body }]; ok({ id, html_url: `reply-${id}` });
  }
  if (/^repos\/o\/r\/issues$/.test(path) && method === 'POST') {
    const number = 900 + (st.issues || []).length + 1; st.issues = [...(st.issues || []), { number, ...body }]; ok({ number, html_url: `https://github.com/o/r/issues/${number}` });
  }
  if (/issues\/\d+\/comments$/.test(path) && method === 'POST') { st.issueComments = [...(st.issueComments || []), body.body]; ok({ id: 77, html_url: 'u77' }); }
  // Actions and branch state, per PR: p.runs [{id,name,status,conclusion,created_at,head_sha}], p.commitDate, p.behind, p.fork.
  const byHead = (sha) => Object.values(st.prs).find((p) => p.head === sha);
  let m;
  if ((m = /pulls\/(\d+)$/.exec(path)) && method === 'GET') {
    const p = pr(Number(m[1]));
    ok({ number: p.number, state: 'open', head: { sha: p.head, ref: 'feature', repo: { full_name: p.fork ? 'f/r' : 'o/r' } }, base: { ref: p.base || 'main', repo: { full_name: 'o/r' } }, maintainer_can_modify: !!p.canModify });
  }
  if ((m = /pulls\/(\d+)\/update-branch$/.exec(path)) && method === 'PUT') {
    const p = pr(Number(m[1]));
    if (body.expected_head_sha !== p.head) fail('HTTP 422: expected_head_sha does not match');
    p.head = 'e'.repeat(40); p.behind = 0; p.commitDate = new Date().toISOString();
    p.runs = [...(p.runs || []), { id: 801, name: 'CI', status: 'completed', conclusion: 'action_required', created_at: new Date().toISOString(), head_sha: p.head }];
    ok({ message: 'Updating pull request branch.' });
  }
  if ((m = /actions\/runs\?head_sha=([0-9a-f]+)/.exec(path))) {
    const p = byHead(m[1]); ok({ workflow_runs: (p?.runs || []).filter((r) => r.head_sha === m[1]) });
  }
  if ((m = /actions\/runs\/(\d+)\/approve$/.exec(path)) && method === 'POST') {
    for (const p of Object.values(st.prs)) for (const r of p.runs || []) if (r.id === Number(m[1])) { r.status = 'queued'; r.conclusion = null; }
    st.approved = [...(st.approved || []), Number(m[1])]; ok({});
  }
  if ((m = /commits\/([0-9a-f]{40})$/.exec(path))) ok({ commit: { committer: { date: byHead(m[1])?.commitDate || '2026-11-01T00:00:00Z' } } });
  if ((m = /compare\/[^/]+\.\.\.([0-9a-f]{40})/.exec(path))) ok({ behind_by: byHead(m[1])?.behind ?? 0 });
  fail(`fake-gh: unknown api ${method} ${path}`);
}
fail(`fake-gh: unknown command ${args.join(' ')}`);
