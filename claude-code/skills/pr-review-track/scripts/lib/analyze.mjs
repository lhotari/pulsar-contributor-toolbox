// Turns raw GitHub data into the review-tracking judgements the human cares
// about: what changed since I last looked, and did the author actually act on
// each thing I asked for?

import { parseDiff, touchesAnchor } from './diff.mjs';
import { myReviews, myThreads, compareDiff, compareCommits } from './github.mjs';

/** Thread verdicts, ordered by how much attention they need. */
export const THREAD_STATES = {
  AWAITING_MY_REPLY: 'awaiting-my-reply',
  RESOLVED_WITHOUT_CHANGE: 'resolved-without-code-change',
  CODE_CHANGED: 'code-changed',
  UNTOUCHED: 'untouched',
  RESOLVED_BY_ME: 'resolved-by-me',
  RESOLVED_WITH_CHANGE: 'resolved-with-code-change',
};

const ATTENTION_ORDER = [
  THREAD_STATES.AWAITING_MY_REPLY,
  THREAD_STATES.RESOLVED_WITHOUT_CHANGE,
  THREAD_STATES.UNTOUCHED,
  THREAD_STATES.CODE_CHANGED,
  THREAD_STATES.RESOLVED_WITH_CHANGE,
  THREAD_STATES.RESOLVED_BY_ME,
];

export function attentionRank(state) {
  const i = ATTENTION_ORDER.indexOf(state);
  return i === -1 ? ATTENTION_ORDER.length : i;
}

/**
 * Analyse one PR against the viewer's review history.
 * `deltaDiff` is optional; pass it to get code-change evidence per thread.
 */
/** REST database id of a review comment, as a decimal string. */
function idOf(comment) {
  if (!comment) return null;
  const v = comment.fullDatabaseId ?? comment.databaseId;
  return v === null || v === undefined ? null : String(v);
}

export function analyzePr(pr, login, { deltaDiff = null, newCommits = [] } = {}) {
  const mine = myReviews(pr, login);
  const lastReview = mine[0] ?? null;
  const lastSubstantive = mine.find((r) => r.state !== 'COMMENTED') ?? null;
  const reviewedOid = lastReview?.commit?.oid ?? null;
  const headOid = pr.headRefOid;
  const deltaFiles = deltaDiff ? parseDiff(deltaDiff) : null;

  const threads = myThreads(pr, login).map((t) => {
    const comments = t.comments?.nodes ?? [];
    const last = comments[comments.length - 1] ?? null;
    const myLast = [...comments].reverse().find((c) => c.author?.login === login) ?? null;
    const firstComment = comments[0] ?? null;
    const codeChanged = deltaFiles ? touchesAnchor(deltaFiles, t.path, t.line ?? t.originalLine) : null;

    let state;
    if (t.isResolved) {
      const resolvedByMe = t.resolvedBy?.login === login;
      if (resolvedByMe) state = THREAD_STATES.RESOLVED_BY_ME;
      else if (codeChanged === false && !t.isOutdated) state = THREAD_STATES.RESOLVED_WITHOUT_CHANGE;
      else state = THREAD_STATES.RESOLVED_WITH_CHANGE;
    } else if (last && last.author?.login !== login && (!myLast || last.createdAt > myLast.createdAt)) {
      state = THREAD_STATES.AWAITING_MY_REPLY;
    } else if (t.isOutdated || codeChanged) {
      state = THREAD_STATES.CODE_CHANGED;
    } else {
      state = THREAD_STATES.UNTOUCHED;
    }

    return {
      id: t.id,
      path: t.path,
      line: t.line ?? t.originalLine ?? null,
      startLine: t.startLine ?? null,
      side: t.diffSide ?? 'RIGHT',
      isResolved: !!t.isResolved,
      isOutdated: !!t.isOutdated,
      resolvedBy: t.resolvedBy?.login ?? null,
      state,
      codeChanged,
      // REST database id of the FIRST comment: the id `POST .../comments/{id}/replies` wants.
      // Kept as a decimal string — these ids are large and must never round-trip
      // through anything lossier than an exact integer.
      replyToCommentId: idOf(firstComment),
      // The newest comment in the thread when this analysis ran. Armed as a
      // precondition so a reply drafted today cannot land into a conversation
      // that moved on yesterday.
      lastCommentId: idOf(last),
      myLastComment: myLast ? { body: myLast.body, createdAt: myLast.createdAt, url: myLast.url } : null,
      lastComment: last
        ? { author: last.author?.login, body: last.body, createdAt: last.createdAt, url: last.url }
        : null,
      commentCount: comments.length,
    };
  });

  threads.sort((a, b) => attentionRank(a.state) - attentionRank(b.state) || String(a.path).localeCompare(String(b.path)));

  const sinceIso = lastReview?.submittedAt ?? null;
  const newIssueComments = (pr.comments?.nodes ?? []).filter(
    (c) => c.author?.login !== login && (!sinceIso || c.createdAt > sinceIso),
  );
  const newReviewsByOthers = (pr.reviews?.nodes ?? []).filter(
    (r) => r.author?.login !== login && (!sinceIso || r.submittedAt > sinceIso),
  );

  const ci = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;

  const counts = {};
  for (const t of threads) counts[t.state] = (counts[t.state] ?? 0) + 1;

  const headMoved = !!reviewedOid && reviewedOid !== headOid;
  const needsAttention =
    headMoved ||
    (counts[THREAD_STATES.AWAITING_MY_REPLY] ?? 0) > 0 ||
    (counts[THREAD_STATES.RESOLVED_WITHOUT_CHANGE] ?? 0) > 0 ||
    newIssueComments.length > 0 ||
    !lastReview;

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? null,
    authorAssociation: pr.authorAssociation,
    state: pr.state,
    merged: !!pr.merged,
    isDraft: !!pr.isDraft,
    headOid,
    baseRefName: pr.baseRefName,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: (pr.labels?.nodes ?? []).map((l) => l.name),
    reviewDecision: pr.reviewDecision,
    ci,
    myLastReview: lastReview
      ? { state: lastReview.state, submittedAt: lastReview.submittedAt, oid: reviewedOid, url: lastReview.url }
      : null,
    myLastSubstantiveState: lastSubstantive?.state ?? null,
    headMoved,
    newCommits,
    threads,
    threadCounts: counts,
    newIssueComments: newIssueComments.map((c) => ({ author: c.author?.login, createdAt: c.createdAt, url: c.url, body: c.body })),
    newReviewsByOthers: newReviewsByOthers.map((r) => ({ author: r.author?.login, state: r.state, submittedAt: r.submittedAt })),
    needsAttention,
  };
}

/** Fetch the incremental diff and commit list between the reviewed SHA and head. */
export async function fetchDelta(repo, analysisInput) {
  const { reviewedOid, headOid } = analysisInput;
  if (!reviewedOid || reviewedOid === headOid) return { diff: null, commits: [] };
  try {
    const [diff, commits] = await Promise.all([
      compareDiff(repo, reviewedOid, headOid),
      compareCommits(repo, reviewedOid, headOid),
    ]);
    return { diff, commits };
  } catch (e) {
    // Force-push / rebase can make the reviewed SHA unreachable from head — but
    // so can a transient API failure, and silently degrading to "no delta" would
    // produce a draft that looks like nothing changed. Always say so.
    process.stderr.write(`[prt] could not compare ${reviewedOid?.slice(0, 8)}..${headOid?.slice(0, 8)}: ${e.message}\n`);
    return { diff: null, commits: [], error: e.message };
  }
}

/**
 * Recommended review event, given the analysis. APPROVE is only ever a
 * *recommendation*: the caller decides whether to write it into the file.
 */
export function recommendEvent(a) {
  const c = a.threadCounts;
  if ((c[THREAD_STATES.UNTOUCHED] ?? 0) > 0 || (c[THREAD_STATES.RESOLVED_WITHOUT_CHANGE] ?? 0) > 0) {
    return {
      event: a.myLastSubstantiveState === 'CHANGES_REQUESTED' ? 'REQUEST_CHANGES' : 'COMMENT',
      why: `${(c[THREAD_STATES.UNTOUCHED] ?? 0) + (c[THREAD_STATES.RESOLVED_WITHOUT_CHANGE] ?? 0)} of my threads look unaddressed`,
    };
  }
  if ((c[THREAD_STATES.AWAITING_MY_REPLY] ?? 0) > 0) {
    return { event: 'COMMENT', why: 'the author replied and is waiting on me' };
  }
  const addressed = (c[THREAD_STATES.CODE_CHANGED] ?? 0) + (c[THREAD_STATES.RESOLVED_WITH_CHANGE] ?? 0);
  if (addressed > 0 && a.threads.length > 0) {
    return { event: 'APPROVE', why: 'every thread I opened has a code change behind it — verify, then approve' };
  }
  return { event: 'COMMENT', why: 'no strong signal either way' };
}

export function summarizeCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => attentionRank(a[0]) - attentionRank(b[0]))
    .map(([k, v]) => `${v} ${k}`)
    .join(', ') || 'none';
}
