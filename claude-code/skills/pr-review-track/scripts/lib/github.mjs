// GitHub queries specific to review tracking.
//
// Everything that can be batched is batched: GraphQL aliases let us fetch N pull
// requests in ONE request that costs ONE rate-limit point, which is what makes
// syncing 100+ tracked PRs cheap.

import { graphql, gh, rest, restRaw, parseBody, viewerLogin } from './gh.mjs';

const PR_CORE = `
  id number title url state isDraft merged mergedAt closedAt createdAt updatedAt
  additions deletions changedFiles headRefOid baseRefName authorAssociation
  reviewDecision mergeable
  author { login }
  labels(first: 20) { nodes { name } }
`;

const PR_DETAIL = `
  ${PR_CORE}
  body
  commits(last: 1) { nodes { commit {
    oid committedDate
    statusCheckRollup { state }
  } } }
  reviews(last: 60) {
    nodes { author { login } state submittedAt url commit { oid } body }
  }
  reviewThreads(first: 100) {
    nodes {
      id isResolved isOutdated isCollapsed path line startLine originalLine diffSide
      resolvedBy { login }
      comments(first: 100) {
        nodes { databaseId fullDatabaseId author { login } createdAt url body }
      }
    }
  }
  comments(last: 50) { nodes { author { login } createdAt url body } }
`;

/** Fetch one PR with full review/thread detail. */
export async function fetchPr(repo, number) {
  const [owner, name] = repo.split('/');
  const data = await graphql(
    `query($owner:String!,$name:String!,$number:Int!){
       repository(owner:$owner,name:$name){ pullRequest(number:$number){ ${PR_DETAIL} } }
     }`,
    { owner, name, number },
  );
  return data?.repository?.pullRequest ?? null;
}

/**
 * Fetch many PRs in as few requests as possible using field aliases.
 * `detail: false` fetches only the cheap core fields (state / head / updatedAt),
 * which is all `sync` needs to decide whether anything changed.
 */
export async function fetchPrsBatch(
  repo,
  numbers,
  { detail = false, batchSize = detail ? 8 : 40, concurrency = 3, onProgress = null } = {},
) {
  const [owner, name] = repo.split('/');
  const fields = detail ? PR_DETAIL : PR_CORE;
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < numbers.length; i += batchSize) chunks.push(numbers.slice(i, i + batchSize));

  const fetchChunk = async (chunk) => {
    const aliases = chunk.map((n) => `p${n}: pullRequest(number:${n}) { ${fields} }`).join('\n');
    const data = await graphql(
      `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ ${aliases} } }`,
      { owner, name },
    );
    const repoNode = data?.repository ?? {};
    for (const n of chunk) {
      const pr = repoNode[`p${n}`];
      if (pr) out.set(n, pr);
    }
  };

  // Light concurrency on reads only. Mutations stay strictly serialized.
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      await fetchChunk(chunk);
      done += 1;
      if (onProgress) onProgress(done, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return out;
}

/**
 * Open PRs in `repo` that the viewer has already engaged with: reviewed, or
 * commented on. Excludes the viewer's own PRs.
 * GitHub's search index lags a few minutes behind writes — acceptable here.
 */
export async function searchEngagedPrs(repo, login) {
  const queries = [
    `repo:${repo} is:pr is:open reviewed-by:${login} -author:${login}`,
    `repo:${repo} is:pr is:open commenter:${login} -author:${login}`,
    `repo:${repo} is:pr is:open review-requested:${login}`,
  ];
  const numbers = new Map(); // number -> Set<reason>
  for (const [i, q] of queries.entries()) {
    const reason = ['reviewed', 'commented', 'review-requested'][i];
    for (const n of await searchPrNumbers(q)) {
      if (!numbers.has(n)) numbers.set(n, new Set());
      numbers.get(n).add(reason);
    }
  }
  return numbers;
}

/** Paginate a GitHub code-search-style issue search, returning PR numbers. */
export async function searchPrNumbers(q, max = 1000) {
  const out = [];
  let cursor = null;
  // The search connection is capped at 1000 results by GitHub.
  while (out.length < max) {
    const data = await graphql(
      `query($q:String!,$after:String){
         search(query:$q, type:ISSUE, first:100, after:$after){
           pageInfo { hasNextPage endCursor }
           nodes { ... on PullRequest { number } }
         }
       }`,
      { q, after: cursor ?? undefined },
    );
    const s = data?.search;
    if (!s) break;
    for (const n of s.nodes) if (n?.number) out.push(n.number);
    if (!s.pageInfo.hasNextPage) break;
    cursor = s.pageInfo.endCursor;
  }
  return out;
}

/** Recent open PRs with the fields `latest` needs for ranking. */
export async function recentOpenPrs(repo, { limit = 100, includeDrafts = false } = {}) {
  const draft = includeDrafts ? '' : ' -is:draft';
  const q = `repo:${repo} is:pr is:open${draft} sort:updated-desc`;
  const out = [];
  let cursor = null;
  while (out.length < limit) {
    const data = await graphql(
      `query($q:String!,$after:String){
         search(query:$q, type:ISSUE, first:50, after:$after){
           pageInfo { hasNextPage endCursor }
           nodes { ... on PullRequest {
             ${PR_CORE}
             commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
             reviews(last:20){ nodes { author { login } state submittedAt commit { oid } } }
             comments { totalCount }
           } }
         }
       }`,
      { q, after: cursor ?? undefined },
    );
    const s = data?.search;
    if (!s) break;
    out.push(...s.nodes.filter(Boolean));
    if (!s.pageInfo.hasNextPage) break;
    cursor = s.pageInfo.endCursor;
  }
  return out.slice(0, limit);
}

/** The viewer's own reviews on a PR, newest first. */
export function myReviews(pr, login) {
  return (pr.reviews?.nodes ?? [])
    .filter((r) => r.author?.login === login)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

/** Review threads the viewer participates in. */
export function myThreads(pr, login) {
  return (pr.reviewThreads?.nodes ?? []).filter((t) =>
    (t.comments?.nodes ?? []).some((c) => c.author?.login === login),
  );
}

/** The diff of a PR, as unified-diff text. */
export async function prDiff(repo, number) {
  return gh(['pr', 'diff', String(number), '--repo', repo]);
}

/** The diff between two commits of a repo, via the compare API (works for forks). */
export async function compareDiff(repo, base, head) {
  return gh(['api', `repos/${repo}/compare/${base}...${head}`, '-H', 'Accept: application/vnd.github.v3.diff']);
}

/** Commits added between two SHAs on a PR. */
export async function compareCommits(repo, base, head) {
  const data = await rest('GET', `repos/${repo}/compare/${base}...${head}?per_page=100`);
  return (data?.commits ?? []).map((c) => ({
    oid: c.sha,
    message: c.commit.message.split('\n')[0],
    author: c.author?.login ?? c.commit.author?.name,
    date: c.commit.author?.date,
  }));
}

/** Turn a failed `gh api` result into a message that names what GitHub objected to. */
export function describeApiError(res) {
  const body = parseBody(res.stdout);
  if (!body) return (res.stderr || res.stdout || 'unknown error').trim();
  const parts = [body.message].filter(Boolean);
  for (const e of body.errors ?? []) {
    parts.push(
      typeof e === 'string' ? e : [e.resource, e.field, e.code, e.message].filter(Boolean).join(' '),
    );
  }
  if (body.documentation_url) parts.push(body.documentation_url);
  return parts.join(' | ') || (res.stderr || 'unknown error').trim();
}

/**
 * File-level comments cannot ride in the batch `comments[]` array: GitHub's
 * DraftPullRequestReviewComment type has no `subjectType` field, and the request
 * 422s with "Field is not defined on DraftPullRequestReviewComment" (verified
 * against the live API, 2026-08-21). They have to go through GraphQL's
 * addPullRequestReviewThread against a PENDING review instead, which is why a
 * review containing one is posted in three steps rather than one.
 */
export async function createPendingReview(repo, number, payload) {
  const body = { ...payload };
  delete body.event; // omitting `event` is what makes the review PENDING
  const res = await restRaw('POST', `repos/${repo}/pulls/${number}/reviews`, body);
  const parsed = parseBody(res.stdout);
  if (res.ok && parsed) return { ok: true, review: parsed };
  return { ok: false, error: describeApiError(res), raw: res.stdout };
}

export async function addFileThread({ reviewNodeId, pullRequestNodeId, path, body }) {
  try {
    const data = await graphql(
      `mutation($rid:ID!,$pid:ID!,$path:String!,$body:String!){
         addPullRequestReviewThread(input:{
           pullRequestReviewId:$rid, pullRequestId:$pid,
           path:$path, subjectType:FILE, body:$body
         }){ thread { id path subjectType } }
       }`,
      { rid: reviewNodeId, pid: pullRequestNodeId, path, body },
    );
    return { ok: true, thread: data?.addPullRequestReviewThread?.thread ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Submit a PENDING review with its final event. */
export async function submitPendingReview(repo, number, reviewId, { event, body }) {
  const payload = { event: event && event !== 'NONE' ? event : 'COMMENT' };
  if (body) payload.body = body;
  const res = await restRaw('POST', `repos/${repo}/pulls/${number}/reviews/${reviewId}/events`, payload);
  const parsed = parseBody(res.stdout);
  if (res.ok && parsed) return { ok: true, review: parsed };
  return { ok: false, error: describeApiError(res), raw: res.stdout };
}

export async function discardPendingReview(repo, number, reviewId) {
  const res = await restRaw('DELETE', `repos/${repo}/pulls/${number}/reviews/${reviewId}`);
  return res.ok;
}

/** Create and submit a review in one call. Returns {ok, review|error}. */
export async function submitReview(repo, number, payload) {
  const res = await restRaw('POST', `repos/${repo}/pulls/${number}/reviews`, payload);
  const body = parseBody(res.stdout);
  if (res.ok && body) return { ok: true, review: body };
  return { ok: false, error: describeApiError(res), raw: res.stdout };
}

/** Reply inside an existing review thread (REST id of the thread's FIRST comment). */
export async function replyToComment(repo, number, commentId, body) {
  const res = await restRaw('POST', `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, { body });
  const parsed = parseBody(res.stdout);
  if (res.ok && parsed) return { ok: true, comment: parsed };
  return { ok: false, error: describeApiError(res), raw: res.stdout };
}

export async function resolveThread(threadId, resolve = true) {
  const mutation = resolve ? 'resolveReviewThread' : 'unresolveReviewThread';
  try {
    await graphql(
      `mutation($id:ID!){ ${mutation}(input:{threadId:$id}){ thread { id isResolved } } }`,
      { id: threadId },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Any PENDING (unsubmitted) review the viewer left behind on this PR. */
export async function pendingReviews(repo, number) {
  const login = await viewerLogin();
  const data = await rest('GET', `repos/${repo}/pulls/${number}/reviews?per_page=100`);
  return (data ?? []).filter((r) => r.state === 'PENDING' && r.user?.login === login);
}

export async function deletePendingReview(repo, number, reviewId) {
  const res = await restRaw('DELETE', `repos/${repo}/pulls/${number}/reviews/${reviewId}`);
  return res.ok;
}
