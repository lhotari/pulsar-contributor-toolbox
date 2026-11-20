#!/usr/bin/env node
// A stateful stand-in for `gh`: one repo (o/r), PRs from $FAKE_GH_STATE, pending reviews kept in that file.
// Enough of GraphQL and REST for sync, scan, stage, sync-from-GitHub and submit.
import fs from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* none */ }
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 1));
const ok = (o) => { process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o)); save(); process.exit(0); };
const fail = (m, code = 1) => { process.stderr.write(m); save(); process.exit(code); };
st.calls = st.calls || []; st.calls.push(args.join(' ').slice(0, 300));
const vars = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') { const [k, ...v] = args[i + 1].split('='); vars[k] = v.join('='); }
const q = vars.query || '';
const pr = (n) => st.prs[n];
const core = (p) => ({ id: `PR_${p.number}`, number: p.number, title: p.title, url: `https://github.com/o/r/pull/${p.number}`, state: 'OPEN', isDraft: false, merged: false,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: p.updatedAt, additions: 3, deletions: 0, changedFiles: 1, headRefOid: p.head, baseRefName: 'main',
  authorAssociation: p.association, reviewDecision: null, author: { login: p.author }, labels: { nodes: [] },
  commits: { nodes: [{ commit: { oid: p.head, statusCheckRollup: { state: 'SUCCESS' } } }] }, reviews: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
  reviewThreads: { nodes: [] }, comments: { nodes: [] }, body: 'body' });
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
  if (/issues\/\d+\/comments$/.test(path) && method === 'POST') { st.issueComments = [...(st.issueComments || []), body.body]; ok({ id: 77, html_url: 'u77' }); }
  fail(`fake-gh: unknown api ${method} ${path}`);
}
fail(`fake-gh: unknown command ${args.join(' ')}`);
