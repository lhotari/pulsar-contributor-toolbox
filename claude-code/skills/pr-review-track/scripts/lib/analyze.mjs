// Turns raw GitHub data into the review-tracking judgements the human cares
// about: what changed since I last looked, and did the author actually act on
// each thing I asked for?

import { parseDiff, touchesAnchor } from './diff.mjs';
import { myReviews, myThreads, compareDiff, comparePr } from './github.mjs';

/** Thread verdicts, ordered by how much attention they need. */
export const THREAD_STATES = {
  AWAITING_MY_REPLY: 'awaiting-my-reply',
  RESOLVED_WITHOUT_CHANGE: 'resolved-without-code-change',
  CODE_CHANGED: 'code-changed',
  RESOLVED_UNVERIFIED: 'resolved-but-unverified',
  UNTOUCHED: 'untouched',
  RESOLVED_BY_ME: 'resolved-by-me',
  RESOLVED_WITH_CHANGE: 'resolved-with-code-change',
};

const ATTENTION_ORDER = [
  THREAD_STATES.AWAITING_MY_REPLY,
  THREAD_STATES.RESOLVED_WITHOUT_CHANGE,
  THREAD_STATES.RESOLVED_UNVERIFIED,
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
function normalize(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

/** REST database id of a review comment, as a decimal string. */
function idOf(comment) {
  if (!comment) return null;
  const v = comment.fullDatabaseId ?? comment.databaseId;
  return v === null || v === undefined ? null : String(v);
}

export function analyzePr(pr, login, options = {}) {
  const { deltaDiff = null, newCommits = [], reviewedOidHint = null } = options;
  const mine = myReviews(pr, login);
  // GitHub creates an empty-bodied COMMENTED review object for every standalone
  // reply to a thread — including the ones this tool posts. Treating one of
  // those as "where I last reviewed" would move the watermark to today's head
  // and make every later re-review report "nothing changed" for code nobody
  // re-read. Only a review that actually said something sets the watermark.
  const substantiveMine = mine.filter((r) => normalize(r.body) !== '' || r.state !== 'COMMENTED');
  const lastReview = substantiveMine[0] ?? mine[0] ?? null;
  const lastSubstantive = mine.find((r) => r.state !== 'COMMENTED') ?? null;
  const reviewedOid = reviewedOidHint ?? substantiveMine[0]?.commit?.oid ?? null;
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
      else if (codeChanged === true || t.isOutdated) state = THREAD_STATES.RESOLVED_WITH_CHANGE;
      // codeChanged === null means no delta was fetched (every sync/refresh).
      // "Resolved" on its own is not evidence the point was addressed, and
      // guessing the calm answer is the unsafe direction.
      else state = THREAD_STATES.RESOLVED_UNVERIFIED;
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
      // How long this point of mine has gone unanswered. Only meaningful for a
      // thread nobody has touched; that is the only place it is read.
      daysSinceMyLastComment: myLast ? Math.floor((Date.now() - Date.parse(myLast.createdAt)) / 86400000) : null,
      url: (comments[0] ?? {}).url ?? null,
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
  const nudge = assessNudge({ pr, login, threads, headMoved, options });
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
    nudge,
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
    const cmp = await comparePr(repo, reviewedOid, headOid);
    // The branch was rebased or force-pushed: the commit I reviewed is no longer
    // an ancestor of head. A merge-base diff here would show every upstream
    // commit as if the author had made it, which reads as "they addressed
    // everything" — the most dangerous possible wrong answer.
    if (cmp.mergeBase && cmp.mergeBase !== reviewedOid) {
      return {
        diff: null,
        commits: [],
        error: `the branch was rebased or force-pushed: the commit I reviewed (${reviewedOid.slice(0, 8)}) is no longer an ancestor of head (merge base is ${cmp.mergeBase.slice(0, 8)}, ${cmp.behindBy} commit(s) behind)`,
        forcePushed: true,
      };
    }
    const diff = await compareDiff(repo, reviewedOid, headOid);
    return { diff, commits: cmp.commits, status: cmp.status };
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


/**
 * Should the author be reminded about points they have not answered?
 *
 * The bar is deliberately conservative. A nudge costs the author a
 * notification and costs me goodwill if it is wrong, so every one of these
 * conditions has to hold:
 *
 *   - at least one thread of mine has had no reply and no code change at its
 *     anchor for longer than `afterDays`;
 *   - the head has not moved since I reviewed — if the author pushed, they are
 *     working, and the right response is to re-review, not to prod;
 *   - I have not said anything on this PR inside the cooldown. This is the real
 *     "do not nag" rule, and deriving it from GitHub rather than local state
 *     means it holds across machines and survives a lost tracking directory;
 *   - the PR is open, not a draft, and not mine.
 *
 * The result is a proposal either way: `due` PRs get a draft the human edits
 * and arms, and `reasonNotDue` explains the silence for the ones that do not.
 */
export function assessNudge({ pr, login, threads, headMoved, options = {} }) {
  const afterDays = options.nudgeAfterDays ?? 2;
  const cooldownDays = options.nudgeCooldownDays ?? 7;
  // Past this, a reminder stops being follow-up and becomes noise. A comment
  // nobody answered in three months is not waiting on a nudge; the PR needs
  // closing, reassigning, or a fresh review — decisions a person makes.
  const maxAgeDays = options.nudgeMaxAgeDays ?? 90;
  const now = Date.now();
  const daysAgo = (iso) => (iso ? (now - Date.parse(iso)) / 86400000 : Infinity);

  const untouched = threads.filter(
    (t) => t.state === THREAD_STATES.UNTOUCHED && (t.daysSinceMyLastComment ?? 0) >= afterDays,
  );

  // The most recent thing I said anywhere on this PR: a review, an issue
  // comment, or a thread comment.
  const mySignals = [
    ...(pr.reviews?.nodes ?? []).filter((r) => r.author?.login === login).map((r) => r.submittedAt),
    ...(pr.comments?.nodes ?? []).filter((c) => c.author?.login === login).map((c) => c.createdAt),
    ...threads.map((t) => t.myLastComment?.createdAt).filter(Boolean),
  ].filter(Boolean).sort();
  const lastWordByMe = mySignals[mySignals.length - 1] ?? null;
  const quietDays = daysAgo(lastWordByMe);

  const base = {
    due: false,
    afterDays,
    cooldownDays,
    untouchedCount: untouched.length,
    oldestUntouchedDays: untouched.length ? Math.max(...untouched.map((t) => t.daysSinceMyLastComment ?? 0)) : null,
    daysSinceMyLastWord: Number.isFinite(quietDays) ? Math.floor(quietDays) : null,
    maxAgeDays,
    lastWordByMe,
    // `side` rides along so a renderer can tell whether the head permalink means
    // this line: a LEFT anchor counts lines in the base, not in the head.
    threads: untouched.map((t) => ({ id: t.id, path: t.path, line: t.line, side: t.side, url: t.url, days: t.daysSinceMyLastComment })),
  };

  if (pr.author?.login === login) return { ...base, reasonNotDue: 'it is my own PR' };
  if (pr.state !== 'OPEN') return { ...base, reasonNotDue: `the PR is ${String(pr.state).toLowerCase()}` };
  if (pr.isDraft) return { ...base, reasonNotDue: 'the PR is a draft — the author is still working' };
  if (!untouched.length) {
    return { ...base, reasonNotDue: `no thread of mine has been unanswered for ${afterDays}+ days` };
  }
  if (headMoved) {
    return { ...base, reasonNotDue: 'the author has pushed since my review — re-review rather than prod' };
  }
  if (quietDays < cooldownDays) {
    return { ...base, reasonNotDue: `I last commented ${Math.floor(quietDays)} day(s) ago; the cooldown is ${cooldownDays}` };
  }
  if (base.oldestUntouchedDays > maxAgeDays) {
    return {
      ...base,
      reasonNotDue: `the oldest point is ${base.oldestUntouchedDays} days old (over the ${maxAgeDays}-day limit) — this needs a decision, not a reminder`,
      abandoned: true,
    };
  }
  return { ...base, due: true, reasonNotDue: null };
}
