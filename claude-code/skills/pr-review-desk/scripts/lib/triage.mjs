// Sync and triage: which open PRs exist, which ones I engaged with, how urgent each is and why, which lane
// it belongs in, and whether its diff trips the security scan. Reads GitHub only.
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.mjs';
import * as cfgm from './config.mjs';
import * as P from './prt.mjs';
import { scanDiff } from './scan.mjs';

const DAY = 86400000;
export const LANES = ['backlog', 'queued', 'reviewing', 'check', 'staged', 'follow-up', 'waiting', 'approved', 'security', 'parked', 'done'];
export const LANE_TITLES = {
  backlog: 'Backlog', queued: 'Queued for AI review', reviewing: 'AI reviewing', check: 'Your check', staged: 'Staged on GitHub',
  'follow-up': 'Follow-up', waiting: 'Waiting for author', approved: 'Approved', security: 'Security hold', parked: 'Parked', done: 'Closed / merged',
};

export async function login() {
  const cached = db.meta('login');
  if (cached) return cached;
  return db.meta('login', await P.viewerLogin());
}

export function category(title) {
  const t = String(title || '');
  const m = /^\s*\[([^\]]+)\](?:\s*\[([^\]]+)\])?/.exec(t);
  const type = (m?.[1] || '').toLowerCase().trim();
  const component = m?.[2]?.toLowerCase().trim() || null;
  let cat = { fix: 'fix', feat: 'feat', feature: 'feat', improve: 'improve', improvement: 'improve', cleanup: 'cleanup', refactor: 'cleanup',
    doc: 'doc', docs: 'doc', ci: 'ci', build: 'build', test: 'test', tests: 'test', revert: 'revert', pip: 'pip', fn: 'improve' }[type] || 'other';
  if (/\bpip-\d+\b/i.test(t) || component === 'pip') cat = 'pip';
  if (/\b(upgrade|bump|update)\b[^\n]*\b(to|from)\b\s*v?\d/i.test(t) || /\bdeps?\b|dependabot/i.test(component || '')) cat = cat === 'fix' ? 'fix' : 'deps';
  if (/^revert\b/i.test(t)) cat = 'revert';
  return { category: cat, component };
}

const COMMITTER_ASSOC = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);
const WRITE = new Set(['admin', 'maintain', 'write']);

/** Committer = org member/owner/collaborator per GitHub, or write access per the collaborators API (cached 14 days). */
export function isCommitter(repo, author, association) {
  if (COMMITTER_ASSOC.has(association)) return true;
  const a = db.get('SELECT permission FROM authors WHERE repo = ? AND login = ?', repo, author);
  return !!a && WRITE.has(a.permission);
}

async function refreshPermissions(repo, authors) {
  const stale = authors.filter((a) => {
    const r = db.get('SELECT checked_at FROM authors WHERE repo = ? AND login = ?', repo, a);
    return !r || Date.now() - Date.parse(r.checked_at) > 14 * DAY;
  }).slice(0, 25);
  for (const a of stale) {
    let perm = 'unknown';
    try { perm = (await P.rest('GET', `repos/${repo}/collaborators/${encodeURIComponent(a)}/permission`))?.permission || 'none'; } catch { /* needs push access; keep unknown */ }
    db.run(`INSERT INTO authors (repo, login, permission, checked_at) VALUES (?,?,?,?)
      ON CONFLICT(repo, login) DO UPDATE SET permission = excluded.permission, checked_at = excluded.checked_at`, repo, a, perm, db.now());
  }
}

function ignoredBy(cfg, pr) {
  if (cfg.ignoreAuthors.includes(pr.author)) return `author ${pr.author} is on the ignore list`;
  for (const re of cfg.ignoreTitle) if (new RegExp(re, 'i').test(pr.title)) return `title matches ${re}`;
  const hit = pr.labels.find((l) => cfg.ignoreLabels.includes(l));
  return hit ? `label ${hit}` : null;
}

function followUpReasons(a, author) {
  if (!a?.myLastReview) return [];
  const r = [];
  const c = a.threadCounts || {};
  if (a.headMoved) r.push('new commits since my review');
  if (c['awaiting-my-reply']) r.push(`${c['awaiting-my-reply']} thread(s) waiting on my reply`);
  if (c['resolved-without-code-change']) r.push(`${c['resolved-without-code-change']} thread(s) resolved without a code change`);
  const fromAuthor = (a.newIssueComments || []).filter((x) => x.author === author);
  if (fromAuthor.length) r.push(`${fromAuthor.length} new comment(s) from the author`);
  return r;
}

/** Lane from facts. The human's hold and an active job win; then the review round; then GitHub state. */
export function laneOf({ pr, item, review, job }) {
  if (!pr || pr.state !== 'OPEN') return 'done';
  if (item.hold === 'parked' || item.hold === 'ignored') return 'parked';
  if (item.hold === 'snoozed' && item.hold_until && Date.parse(item.hold_until) > Date.now()) return 'parked';
  if (['flagged', 'suspicious'].includes(item.gate) && item.gate_sha === pr.head_sha) return 'security';
  if (job) return job.status === 'queued' ? 'queued' : job.status === 'waiting' ? 'check' : 'reviewing';
  if (review?.status === 'draft') return 'check';
  if (review?.status === 'staged') return 'staged';
  const a = pr.analysis;
  if (a?.myLastReview) {
    if (followUpReasons(a, pr.author).length) return 'follow-up';
    if (a.myLastSubstantiveState === 'APPROVED') return 'approved';
    return 'waiting';
  }
  if (item.flags.includes('rule-ignored')) return 'parked';
  return 'backlog';
}

function scoreItem(repo, cfg, pr, raw, me, engagedReasons) {
  const reasons = [];
  let score = 0;
  const base = pr.analysis?.myLastReview
    ? P.scoreTracked(pr.analysis, { priorityAuthors: cfg.priorityAuthors })
    : P.scorePr(raw, { login: me, priorityAuthors: cfg.priorityAuthors, reviewRequested: new Set(engagedReasons?.has('review-requested') ? [pr.number] : []) });
  score += base.score; reasons.push(...base.reasons);
  const add = (n, why) => { if (!n) return; score += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };
  const flags = [];
  if (isCommitter(repo, pr.author, pr.association)) { flags.push('committer'); add(cfg.weights.committer, 'author is a committer'); }
  if (engagedReasons?.has('review-requested')) flags.push('review-requested');
  if (cfg.priorityAuthors.includes(pr.author)) flags.push('priority-author');
  if (['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER'].includes(pr.association)) flags.push('first-timer');
  const { category: cat, component } = category(pr.title);
  add(cfg.weights.categories[cat] || 0, `${cat} change`);
  for (const l of pr.labels) add(cfg.weights.labels[l] || 0, `label ${l}`);
  const item = db.item(repo, pr.number);
  const paths = item?.scan?.paths || [];
  for (const w of cfg.weights.paths) {
    const re = new RegExp(w.pattern);
    if (paths.some((p) => re.test(p))) add(w.weight, w.why || `touches ${w.pattern}`);
  }
  for (const r of followUpReasons(pr.analysis, pr.author)) reasons.push(`follow-up: ${r}`);
  const ign = ignoredBy(cfg, pr);
  if (ign) { flags.push('rule-ignored'); reasons.push(`ignored: ${ign}`); }
  return { score: Math.round(score), reasons, flags, category: cat, component };
}

function upsertPr(repo, raw, me) {
  const analysis = P.analyzePr(raw, me);
  const labels = (raw.labels?.nodes || []).map((l) => l.name);
  const state = raw.merged ? 'MERGED' : raw.state;
  db.run(`INSERT INTO prs (repo, number, node_id, title, url, author, association, state, draft, head_sha, base_ref, additions, deletions, changed_files,
      labels, ci, review_decision, created_at, updated_at, body, analysis, detail_at, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(repo, number) DO UPDATE SET node_id=excluded.node_id, title=excluded.title, url=excluded.url, author=excluded.author,
      association=excluded.association, state=excluded.state, draft=excluded.draft, head_sha=excluded.head_sha, base_ref=excluded.base_ref,
      additions=excluded.additions, deletions=excluded.deletions, changed_files=excluded.changed_files, labels=excluded.labels, ci=excluded.ci,
      review_decision=excluded.review_decision, created_at=excluded.created_at, updated_at=excluded.updated_at, body=excluded.body,
      analysis=excluded.analysis, detail_at=excluded.detail_at, seen_at=excluded.seen_at`,
  repo, raw.number, raw.id, raw.title, raw.url, raw.author?.login || null, raw.authorAssociation, state, raw.isDraft ? 1 : 0, raw.headRefOid,
  raw.baseRefName, raw.additions, raw.deletions, raw.changedFiles, db.S(labels), analysis.ci, raw.reviewDecision, raw.createdAt, raw.updatedAt,
  (raw.body || '').slice(0, 20000), db.S(analysis), db.now(), db.now());
  return db.pr(repo, raw.number);
}

/** Recompute an item's score, flags and lane. Called after every change that can move it. */
export function refreshItem(repo, number, { raw = null, me = null, engaged = null } = {}) {
  const r = db.repo(repo); const cfg = cfgm.effective(r.config);
  const pr = db.pr(repo, number);
  if (!pr) return null;
  let item = db.item(repo, number);
  const created = !item;
  if (created) {
    db.run('INSERT INTO items (repo, number, updated_at) VALUES (?,?,?)', repo, number, db.now());
    item = db.item(repo, number);
  }
  // A new head invalidates the security decision: it was about other code.
  if (item.gate_sha && item.gate_sha !== pr.head_sha && item.gate !== 'unscanned') {
    db.run(`UPDATE items SET gate = 'unscanned', gate_by = NULL, gate_note = ? WHERE repo = ? AND number = ?`,
      `head moved from ${item.gate_sha.slice(0, 10)}; earlier gate: ${item.gate}`, repo, number);
    item = db.item(repo, number);
  }
  if (raw && me) {
    const s = scoreItem(repo, cfg, pr, raw, me, engaged);
    db.run('UPDATE items SET score = ?, reasons = ?, flags = ?, category = ?, component = ? WHERE repo = ? AND number = ?',
      s.score, db.S(s.reasons), db.S(s.flags), s.category, s.component, repo, number);
    item = db.item(repo, number);
  }
  const job = db.get(`SELECT * FROM jobs WHERE repo = ? AND number = ? AND status IN ('queued','running','waiting') ORDER BY id LIMIT 1`, repo, number);
  const lane = laneOf({ pr, item, review: db.currentReview(repo, number), job });
  if (lane !== item.lane) {
    db.run('UPDATE items SET lane = ?, updated_at = ? WHERE repo = ? AND number = ?', lane, db.now(), repo, number);
    if (!created) db.event(repo, number, `#${number}: ${LANE_TITLES[item.lane] || item.lane} → ${LANE_TITLES[lane]}`);
  }
  return db.item(repo, number);
}

let syncing = new Set();
export function isSyncing(repo) { return syncing.has(repo); }

/** Discover and refresh. Cheap core fields for the pool, full detail only for PRs that changed. */
export async function sync(repo, { full = false, onProgress = null } = {}) {
  if (syncing.has(repo)) return { skipped: 'already syncing' };
  syncing.add(repo);
  try {
    const r = db.repo(repo); const cfg = cfgm.effective(r.config);
    const me = await login();
    const pool = await P.recentOpenPrs(repo, { limit: cfg.poolSize, includeDrafts: cfg.includeDrafts });
    const engaged = await P.searchEngagedPrs(repo, me);
    const known = db.all(`SELECT number FROM items WHERE repo = ? AND lane NOT IN ('done')`, repo).map((x) => x.number);
    const numbers = new Set([...pool.map((p) => p.number), ...engaged.keys(), ...known]);
    const poolBy = new Map(pool.map((p) => [p.number, p]));
    const unknownCore = [...numbers].filter((n) => !poolBy.has(n));
    const core = unknownCore.length ? await P.fetchPrsBatch(repo, unknownCore, { detail: false }) : new Map();
    const changed = [];
    for (const n of numbers) {
      const c = poolBy.get(n) || core.get(n);
      if (!c) continue;
      if (c.author?.login === me) continue;
      const have = db.pr(repo, n);
      if (full || !have || have.updated_at !== c.updatedAt || have.head_sha !== c.headRefOid || !have.detail_at) changed.push(n);
    }
    onProgress?.(`fetching ${changed.length} changed PR(s) of ${numbers.size}`);
    const detail = changed.length ? await P.fetchPrsBatch(repo, changed, { detail: true }) : new Map();
    await refreshPermissions(repo, [...new Set([...detail.values()].map((d) => d.author?.login).filter(Boolean))]);
    for (const [n, raw] of detail) {
      upsertPr(repo, raw, me);
      refreshItem(repo, n, { raw, me, engaged: engaged.get(n) });
      fs.writeFileSync(path.join(db.prDir(repo, n), 'pr.json'), JSON.stringify(raw, null, 1));
    }
    // Unchanged PRs: lanes can still move (snooze expired, job finished).
    for (const n of numbers) if (!detail.has(n) && db.pr(repo, n)) refreshItem(repo, n);
    db.run('UPDATE repos SET synced_at = ?, sync_error = NULL WHERE slug = ?', db.now(), repo);
    db.event(repo, null, `Synced ${repo}: ${numbers.size} PRs, ${detail.size} refreshed`);
    return { prs: numbers.size, refreshed: detail.size };
  } catch (e) {
    db.run('UPDATE repos SET sync_error = ? WHERE slug = ?', e.message.slice(0, 1000), repo);
    db.event(repo, null, `Sync failed: ${e.message}`, { level: 'error' });
    throw e;
  } finally { syncing.delete(repo); }
}

/** Fetch one PR now (e.g. the skill was asked to review a specific PR). */
export async function track(repo, number) {
  const me = await login();
  const raw = (await P.fetchPrsBatch(repo, [number], { detail: true })).get(number);
  if (!raw) throw new Error(`${repo}#${number} not found`);
  upsertPr(repo, raw, me);
  fs.writeFileSync(path.join(db.prDir(repo, number), 'pr.json'), JSON.stringify(raw, null, 1));
  return refreshItem(repo, number, { raw, me, engaged: new Set() });
}

/** The PR's diff at its current head, cached per sha. */
export async function diffFor(repo, number, sha) {
  const pr = db.pr(repo, number);
  const head = sha || pr.head_sha;
  const file = path.join(db.prDir(repo, number), `diff-${head}.patch`);
  if (fs.existsSync(file)) return { file, text: fs.readFileSync(file, 'utf8'), sha: head };
  if (head !== pr.head_sha) throw new Error(`no cached diff for ${head.slice(0, 10)}; the PR head is now ${pr.head_sha.slice(0, 10)}`);
  const text = await P.prDiff(repo, number);
  fs.writeFileSync(file, text);
  return { file, text, sha: head };
}

/** Deterministic security scan of the current head. Flags block execution until the human decides. */
export async function scan(repo, number) {
  const pr = db.pr(repo, number);
  let got;
  try { got = await diffFor(repo, number); } catch (e) {
    // GitHub returns no diff for very large PRs (HTTP 406, over 300 files). Without a diff nothing can be
    // scanned, so execution stays off ("inconclusive") and the scan is not retried for this head.
    if (!/too_large|HTTP 406|exceeded the maximum/.test(e.message)) throw e;
    const res = { level: 'unavailable', surfaces: [], hits: [], paths: [], sha: pr.head_sha, at: db.now(), error: 'GitHub does not return a diff this large (over 300 files)' };
    const item = db.item(repo, number);
    const keep = item.gate_by === 'user' && item.gate_sha === pr.head_sha;
    db.run('UPDATE items SET scan = ?, scan_sha = ?, gate = ?, gate_sha = ?, gate_by = ?, gate_note = ?, updated_at = ? WHERE repo = ? AND number = ?',
      db.S(res), pr.head_sha, keep ? item.gate : 'inconclusive', pr.head_sha, keep ? 'user' : 'scan', keep ? item.gate_note : `not scanned: ${res.error}; review it on GitHub or from a local fetch`,
      db.now(), repo, number);
    db.event(repo, number, `#${number}: diff too large to scan; execution stays off`, { level: 'warn' });
    return refreshItem(repo, number);
  }
  const { text, sha } = got;
  const files = P.parseDiff(text);
  const res = { ...scanDiff(files), paths: [...files.keys()], sha, at: db.now() };
  const item = db.item(repo, number);
  const userDecided = item.gate_by === 'user' && item.gate_sha === sha;
  const modelDecided = item.gate_sha === sha && ['clear', 'suspicious', 'inconclusive'].includes(item.gate);
  let gate = item.gate; let by = item.gate_by; let note = item.gate_note;
  if (!userDecided) {
    if (res.level === 'flagged') {
      gate = 'flagged'; by = 'scan';
      note = `flagged by the security scan: ${res.hits.filter((h) => h.severity === 'high')
        .map((h) => `${h.rule} (${h.path}${h.line ? `:${h.line}` : ''})`).slice(0, 6).join('; ')}`;
    } else if (!modelDecided) { gate = 'scanned'; by = 'scan'; note = null; }
  }
  db.run('UPDATE items SET scan = ?, scan_sha = ?, gate = ?, gate_sha = ?, gate_by = ?, gate_note = ?, updated_at = ? WHERE repo = ? AND number = ?',
    db.S(res), sha, gate, sha, by, note, db.now(), repo, number);
  if (gate === 'flagged' && !userDecided) db.event(repo, number, `#${number} red-flagged by the security scan — nothing from it will run`, { level: 'security' });
  return refreshItem(repo, number);
}

/** PRs whose current head has not been scanned, in the lanes that matter, best first. */
export function scanCandidates(repo, top = 40) {
  return db.all(`SELECT i.number FROM items i JOIN prs p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND p.state = 'OPEN' AND (i.scan_sha IS NULL OR i.scan_sha != p.head_sha) AND i.lane NOT IN ('done','parked')
    ORDER BY CASE WHEN i.lane = 'backlog' THEN 1 ELSE 0 END, i.score DESC LIMIT ?`, repo, top).map((x) => x.number);
}
