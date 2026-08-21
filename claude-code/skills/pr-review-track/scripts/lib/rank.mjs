// Ranking for `latest`: which unreviewed PRs deserve my attention next.
//
// The score is a sum of named, inspectable contributions so the output can
// explain itself — a ranked list nobody can audit is a ranked list nobody
// trusts.

const DAY = 86400000;

export function scorePr(pr, { login, priorityAuthors = [], reviewRequested = new Set() }) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => {
    if (n === 0) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };

  const author = pr.author?.login ?? '';
  const prio = priorityAuthors.indexOf(author);
  if (prio !== -1) add(1000 - prio * 10, `author is ${author} (priority list)`);

  if (reviewRequested.has(pr.number)) add(400, 'my review was explicitly requested');

  if (pr.authorAssociation === 'MEMBER') add(120, 'author is an ASF member/committer');
  else if (pr.authorAssociation === 'CONTRIBUTOR') add(30, 'author is a returning contributor');
  else if (pr.authorAssociation === 'FIRST_TIME_CONTRIBUTOR' || pr.authorAssociation === 'FIRST_TIMER') {
    add(45, 'first-time contributor — a review unblocks them');
  }

  const reviews = pr.reviews?.nodes ?? [];
  const others = reviews.filter((r) => r.author?.login !== login);
  if (reviews.length === 0) add(80, 'nobody has reviewed it yet');
  else if (others.length > 0 && !reviews.some((r) => r.author?.login === login)) {
    add(20, `${others.length} review(s) by others, none by me`);
  }

  // `latest` means latest: recency outweighs review debt, which gets a nod but
  // must not float three-year-old PRs above this week's work.
  const ageDays = (Date.now() - Date.parse(pr.createdAt)) / DAY;
  const idleDays = (Date.now() - Date.parse(pr.updatedAt)) / DAY;
  if (idleDays < 2) add(110, 'updated in the last 2 days');
  else if (idleDays < 7) add(70, 'updated this week');
  else if (idleDays < 21) add(25, 'updated this month');
  else if (idleDays > 45) add(-50, `not touched for ${Math.round(idleDays)} days`);
  if (ageDays > 14 && reviews.length === 0 && idleDays < 45) {
    add(25, `open ${Math.round(ageDays)} days and still nobody has reviewed it`);
  }

  const size = (pr.additions ?? 0) + (pr.deletions ?? 0);
  if (size <= 60) add(45, 'small diff — quick to review');
  else if (size <= 400) add(20, 'moderate diff');
  else if (size > 2000) add(-35, `very large diff (${size} lines)`);

  const ci = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  if (ci === 'SUCCESS') add(25, 'CI is green');
  else if (ci === 'FAILURE' || ci === 'ERROR') add(-45, 'CI is red — the author still has work to do');
  else if (ci === 'PENDING') add(-10, 'CI still running');

  if (pr.isDraft) add(-200, 'draft PR');

  const labels = (pr.labels?.nodes ?? []).map((l) => l.name.toLowerCase());
  if (labels.some((l) => l.includes('ready-to-test') || l.includes('ready to test'))) add(15, 'labelled ready-to-test');
  if (labels.some((l) => l.includes('doc-required') || l.includes('release/'))) add(5, 'release/doc labelled');

  const title = (pr.title ?? '').toLowerCase();
  if (/^\[fix\]|\bregression\b|\bdata loss\b|\bdeadlock\b/.test(title)) add(35, 'fix/regression in the title');
  if (/^\[improve\]\[pip\]|\bpip-\d+/i.test(pr.title ?? '')) add(25, 'PIP proposal');

  return { score: Math.round(score), reasons };
}

/**
 * Rank, then thin out author runs. A shortlist where one contributor holds six
 * of the ten slots is a worse queue than one that spreads across the project,
 * so beyond `maxPerAuthor` a PR is demoted rather than dropped: it still
 * appears, just below everyone else's first picks. Authors on the priority list
 * are exempt.
 */
export function rankCandidates(prs, opts = {}) {
  const { maxPerAuthor = 2, priorityAuthors = [] } = opts;
  const scored = prs
    .map((pr) => ({ pr, ...scorePr(pr, opts) }))
    .sort((a, b) => b.score - a.score || Date.parse(b.pr.updatedAt) - Date.parse(a.pr.updatedAt));

  if (!maxPerAuthor) return scored;
  const seen = new Map();
  const primary = [];
  const overflow = [];
  for (const row of scored) {
    const author = row.pr.author?.login ?? '';
    const n = (seen.get(author) ?? 0) + 1;
    seen.set(author, n);
    if (n <= maxPerAuthor || priorityAuthors.includes(author)) {
      primary.push(row);
    } else {
      overflow.push({ ...row, reasons: [...row.reasons, `demoted: ${author} already has ${maxPerAuthor} PRs higher up`] });
    }
  }
  return [...primary, ...overflow];
}

/** Urgency ranking for PRs already tracked — used to order `re-review`. */
export function scoreTracked(analysis, { priorityAuthors = [] } = {}) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => {
    if (n === 0) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };

  const prio = priorityAuthors.indexOf(analysis.author ?? '');
  if (prio !== -1) add(1000 - prio * 10, `author is ${analysis.author} (priority list)`);

  const c = analysis.threadCounts ?? {};
  if ((c['awaiting-my-reply'] ?? 0) > 0) add(300 * c['awaiting-my-reply'], 'the author is waiting on my reply');
  if ((c['resolved-without-code-change'] ?? 0) > 0) add(120 * c['resolved-without-code-change'], 'thread resolved with no code change behind it');
  if (analysis.headMoved) add(150, 'new commits since my review');
  if ((analysis.newIssueComments?.length ?? 0) > 0) add(60, 'new conversation comments');
  if ((c['code-changed'] ?? 0) > 0) add(40 * c['code-changed'], 'code changed at one of my anchors');
  if (analysis.authorAssociation === 'MEMBER') add(30, 'ASF member/committer');
  if (analysis.ci === 'FAILURE') add(-40, 'CI is red');
  if (analysis.isDraft) add(-200, 'draft PR');
  const idleDays = (Date.now() - Date.parse(analysis.updatedAt)) / DAY;
  if (idleDays > 60) add(-60, `untouched for ${Math.round(idleDays)} days`);

  return { score: Math.round(score), reasons };
}
