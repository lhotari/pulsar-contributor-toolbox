// The pieces of pr-review-track's engine (prt) the desk builds on: GitHub I/O with retries, batched PR
// queries, pending-review mutations, diff anchors, permalinks, ranking and the outgoing-text lints.
// Importing them keeps one implementation of each; the desk adds the database, the lanes and the UI.
const PRT = '../../../pr-review-track/scripts/lib';

export const { gh, ghJson, graphql, rest, restAll, restRaw, viewerLogin, resolveRepo, normalizeSlug, rateLimit } = await import(`${PRT}/gh.mjs`);
export const {
  fetchPrsBatch, searchEngagedPrs, recentOpenPrs, prDiff, compareDiff, comparePr, myReviews, myThreads,
  startPendingReview, addReviewThread, addThreadReply, reviewComments, submitPendingReview, deletePendingReview,
  pendingReviews, resolveThread, repoTree, describeApiError,
} = await import(`${PRT}/github.mjs`);
export const { parseDiff, commentableAnchors, validateAnchor } = await import(`${PRT}/diff.mjs`);
export const { blobUrl, pathIndex, linkifyCode, auditPermalinks, isSha } = await import(`${PRT}/links.mjs`);
export const { scorePr, scoreTracked } = await import(`${PRT}/rank.mjs`);
export const { analyzePr, THREAD_STATES } = await import(`${PRT}/analyze.mjs`);
export const { securityHitsInTexts, toolingHitsInTexts } = await import(`${PRT}/submit.mjs`);
