// GitHub queries specific to review tracking.
//
// Everything that can be batched is batched: GraphQL aliases let us fetch N pull
// requests in ONE request that costs ONE rate-limit point, which is what makes
// syncing 100+ tracked PRs cheap.

import { graphql, gh, rest, restAll, restRaw, parseBody, viewerLogin } from './gh.mjs';

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
  latestOpinionatedReviews(first: 100) {
    nodes { author { login } state submittedAt url commit { oid } }
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

/** Open PRs whose configured reviewer currently has an APPROVED verdict on them. */
export async function approvedPrs(repo, login) {
  const numbers = await searchPrNumbers(`repo:${repo} is:pr is:open reviewed-by:${login} -author:${login}`);
  const details = await fetchPrsBatch(repo, numbers, { detail: true });
  return numbers
    .map((number) => details.get(number))
    .filter((pr) => pr && isApprovedByReviewer(pr, login))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Whether the reviewer's latest non-comment verdict is still APPROVED. */
export function isApprovedByReviewer(pr, login) {
  // `latestOpinionatedReviews` is one current verdict per reviewer and does not
  // get crowded out by GitHub's empty COMMENTED artifacts for thread replies.
  const source = pr.latestOpinionatedReviews?.nodes ?? pr.reviews?.nodes ?? [];
  const verdicts = source
    .filter((r) => r.author?.login === login && r.state !== 'COMMENTED' && r.submittedAt)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  return verdicts[0]?.state === 'APPROVED';
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

/**
 * Compare two commits, keeping the fields that reveal a force-push.
 *
 * `compare/A...B` is a MERGE-BASE comparison. After a rebase, A is stranded on
 * an abandoned branch, the merge base falls back to the old fork point, and the
 * "delta" balloons to include every upstream commit since then — which would
 * make every review thread look like the author touched it. `merge_base_commit`
 * is what tells us that happened: on an honest fast-forward it equals A.
 */
export async function comparePr(repo, base, head) {
  const data = await rest('GET', `repos/${repo}/compare/${base}...${head}?per_page=100`);
  return {
    status: data?.status ?? null,
    mergeBase: data?.merge_base_commit?.sha ?? null,
    aheadBy: data?.ahead_by ?? 0,
    behindBy: data?.behind_by ?? 0,
    commits: (data?.commits ?? []).map((c) => ({
      oid: c.sha,
      message: c.commit.message.split('\n')[0],
      author: c.author?.login ?? c.commit.author?.name,
      date: c.commit.author?.date,
    })),
  };
}

/**
 * HTTP status of a failed `gh api` call. GitHub echoes it in the error body
 * (`"status": "422"`), and `gh` also prints it on stderr.
 */
export function httpStatusOf(res) {
  const body = parseBody(res.stdout);
  const fromBody = body?.status ?? body?.statusCode;
  if (fromBody && /^\d{3}$/.test(String(fromBody))) return Number(fromBody);
  const m = /\bHTTP (\d{3})\b/.exec(`${res.stderr ?? ''}`);
  return m ? Number(m[1]) : null;
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
  return { ok: false, error: describeApiError(res), status: httpStatusOf(res), raw: res.stdout };
}

/**
 * Add a NEW thread — line, range or whole-file — to a pending review.
 *
 * The same mutation `addFileThread` has always used for file comments, with the
 * line arguments filled in. It is the only way to put a thread in a review that
 * already exists: REST's `comments[]` array is a create-time argument, so a
 * pending review started earlier (by `event: REPLY`, or by a hand in the UI)
 * cannot be added to that way.
 *
 * `line`/`side` are omitted entirely for a file-level thread — sending them with
 * `subjectType: FILE` is a 422 — and `startLine` only appears for a range.
 */
export async function addReviewThread({
  reviewNodeId, pullRequestNodeId, path, body,
  subject = 'line', line = null, side = 'RIGHT', startLine = null, startSide = null,
}) {
  const file = subject === 'file';
  const range = subject === 'range' && startLine !== null;
  const input = [
    'pullRequestReviewId:$rid', 'pullRequestId:$pid', 'path:$path', 'body:$body',
    `subjectType:${file ? 'FILE' : 'LINE'}`,
    ...(file ? [] : ['line:$line', 'side:$side']),
    ...(range ? ['startLine:$startLine', 'startSide:$startSide'] : []),
  ];
  const params = [
    '$rid:ID!', '$pid:ID!', '$path:String!', '$body:String!',
    ...(file ? [] : ['$line:Int!', '$side:DiffSide!']),
    ...(range ? ['$startLine:Int!', '$startSide:DiffSide!'] : []),
  ];
  const vars = { rid: reviewNodeId, pid: pullRequestNodeId, path, body };
  if (!file) {
    vars.line = line;
    vars.side = side;
  }
  if (range) {
    vars.startLine = startLine;
    vars.startSide = startSide || side;
  }
  try {
    const data = await graphql(
      `mutation(${params.join(',')}){
         addPullRequestReviewThread(input:{${input.join(', ')}}){
           thread { id path subjectType comments(first:1){ nodes { databaseId url } } }
         }
       }`,
      vars,
    );
    return { ok: true, thread: data?.addPullRequestReviewThread?.thread ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Start a review and leave it PENDING — GitHub's "Start a review", the state in
 * which comments are visible to nobody but their author.
 *
 * GraphQL rather than the REST create: it takes no comments, and it hands back
 * the node id every later staging mutation needs, so nothing has to translate a
 * REST id into one. Omitting `event` is what makes it pending, exactly as it is
 * over REST.
 */
export async function startPendingReview({ pullRequestNodeId, commitOid }) {
  try {
    const data = await graphql(
      `mutation($pid:ID!,$oid:GitObjectID){
         addPullRequestReview(input:{ pullRequestId:$pid, commitOID:$oid }){
           pullRequestReview { id databaseId url state }
         }
       }`,
      { pid: pullRequestNodeId, oid: commitOid || null },
    );
    const review = data?.addPullRequestReview?.pullRequestReview ?? null;
    if (!review) return { ok: false, error: 'the review was not returned by addPullRequestReview' };
    return { ok: true, review };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Reply inside an existing thread, as part of a PENDING review.
 *
 * The staged counterpart of `replyToComment`. It keys off the thread's node id —
 * the `thread:` field a `prt:thread` block already carries — rather than the
 * REST id of the thread's first comment, and the reply stays invisible until the
 * review is submitted.
 */
export async function addThreadReply({ reviewNodeId, threadNodeId, body }) {
  try {
    const data = await graphql(
      `mutation($rid:ID!,$tid:ID!,$body:String!){
         addPullRequestReviewThreadReply(input:{
           pullRequestReviewId:$rid, pullRequestReviewThreadId:$tid, body:$body
         }){ comment { id databaseId url } }
       }`,
      { rid: reviewNodeId, tid: threadNodeId, body },
    );
    return { ok: true, comment: data?.addPullRequestReviewThreadReply?.comment ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** The comments held by one review — the only way to read a PENDING one's. */
export async function reviewComments(repo, number, reviewId) {
  return (await restAll(`repos/${repo}/pulls/${number}/reviews/${reviewId}/comments`)) ?? [];
}

/** Submit a PENDING review with its final event. */
export async function submitPendingReview(repo, number, reviewId, { event, body }) {
  const payload = { event: event && event !== 'NONE' ? event : 'COMMENT' };
  if (body) payload.body = body;
  const res = await restRaw('POST', `repos/${repo}/pulls/${number}/reviews/${reviewId}/events`, payload);
  const parsed = parseBody(res.stdout);
  if (res.ok && parsed) return { ok: true, review: parsed };
  return { ok: false, error: describeApiError(res), status: httpStatusOf(res), raw: res.stdout };
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
  return { ok: false, error: describeApiError(res), status: httpStatusOf(res), raw: res.stdout };
}

/**
 * Reply inside an existing review thread. `commentId` must be the REST id of
 * the thread's FIRST (top-level) comment — replying to a reply's id fails.
 */
export async function replyToComment(repo, number, commentId, body) {
  const res = await restRaw('POST', `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, { body });
  const parsed = parseBody(res.stdout);
  if (res.ok && parsed) return { ok: true, comment: parsed };
  return { ok: false, error: describeApiError(res), status: httpStatusOf(res), raw: res.stdout };
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

/**
 * Every file in the repository at one commit, in one request.
 *
 * Used to turn a bare `ClassName.java:123` in a review into a permalink when the
 * PR's own diff does not contain that file — the caller, the test, the
 * definition a comment points at. `truncated` is GitHub's answer for a tree too
 * large to return whole; the paths that did arrive are still usable, and a
 * reference that misses simply stays unlinked.
 */
export async function repoTree(repo, sha) {
  const data = await rest('GET', `repos/${repo}/git/trees/${sha}?recursive=1`);
  return {
    paths: (data?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path),
    truncated: !!data?.truncated,
  };
}

/** Any PENDING (unsubmitted) review the viewer left behind on this PR. */
export async function pendingReviews(repo, number) {
  const login = await viewerLogin();
  const data = await restAll(`repos/${repo}/pulls/${number}/reviews`);
  return (data ?? []).filter((r) => r.state === 'PENDING' && r.user?.login === login);
}

export async function deletePendingReview(repo, number, reviewId) {
  const res = await restRaw('DELETE', `repos/${repo}/pulls/${number}/reviews/${reviewId}`);
  return res.ok;
}
