// The desk's background loop: sync repositories that are due, scan new heads, and apply the triage rules.
// Rules can queue AI reviews (only while a repo's Autopilot switch is on); nothing here posts anything.
import * as db from './db.mjs';
import * as cfgm from './config.mjs';
import * as triage from './triage.mjs';
import * as jobs from './jobs.mjs';

const DAY = 86400000;

function budgetPaused(cfg) {
  const b = jobs.budget();
  if (!b.available) return null;
  if (cfg.auto.pauseWhenClaudeTier.includes(b.claude?.tier)) return `Claude allowance is at tier ${b.claude.tier}`;
  if (cfg.auto.pauseWhenCodexBudget.includes(b.codex?.budget) || b.codex?.blocked) return `Codex budget is ${b.codex?.budget}`;
  return null;
}

/**
 * With auto.review.maxPerDay "budget": the reason automatic reviews stop now, or null while every usage window
 * is under auto.budget.maxPercent (and under auto.budget.maxPace when set). No reading means stop.
 */
export function budgetStop(cfg) {
  const b = jobs.budget({ maxAgeMinutes: 10 });
  if (!b.available) return 'no budget reading (review-budget.sh)';
  const { maxPercent, maxPace } = cfg.auto.budget;
  for (const [who, side] of [['Claude', b.claude], ['Codex', b.codex]]) {
    if (!side?.available) continue;
    for (const w of side.windows || []) {
      const resets = w.resets ? `; resets ${w.resets}` : '';
      if (w.percent != null && w.percent >= maxPercent) return `${who} ${w.window} at ${w.percent}% (auto.budget.maxPercent ${maxPercent}${resets})`;
      if (maxPace != null && w.counts && w.pace != null && w.pace > maxPace) return `${who} ${w.window} pace ${w.pace}× (auto.budget.maxPace ${maxPace}${resets})`;
    }
  }
  return null;
}

/** Which PRs the rules would queue right now, with the reason for each (also shown in the UI as a preview). */
export function ruleCandidates(repo) {
  const r = db.repo(repo); const cfg = cfgm.effective(r.config); const ar = cfg.auto.review; const rr = cfg.auto.reReview;
  const out = [];
  const active = (type) => db.get(`SELECT COUNT(*) n FROM jobs WHERE repo = ? AND type = ? AND status IN ('queued','running','waiting')`, repo, type).n;
  // The daily cap counts automatic reviews that ran or are running; ones the user cancelled do not use it up.
  const counted = db.all(`SELECT created_at FROM jobs WHERE repo = ? AND type IN ('review','re-review') AND json_extract(args,'$.auto') = 1
       AND status != 'cancelled' AND created_at > ? ORDER BY created_at`, repo, new Date(Date.now() - DAY).toISOString());
  const today = counted.length;
  const byBudget = ar.maxPerDay === 'budget';
  const stop = byBudget ? budgetStop(cfg) : null;
  const daily = byBudget ? (stop ? 0 : Infinity) : ar.maxPerDay - today;
  let reviewSlots = Math.max(0, Math.min(ar.maxQueued - active('review'), daily));
  let reSlots = Math.max(0, Math.min(rr.maxQueued - active('re-review'), daily - reviewSlots));
  // Why a matching PR gets no slot: the per-repo queue limit or the daily cap (and when its oldest entry ages out).
  const freeAt = counted.length ? new Date(Date.parse(counted[0].created_at) + DAY).toISOString() : null;
  const waitWhy = (type) => {
    const [max, n] = type === 'review' ? [ar.maxQueued, active('review')] : [rr.maxQueued, active('re-review')];
    if (n >= max) return `${n} ${type} job(s) already queued or running (auto.${type === 'review' ? 'review' : 'reReview'}.maxQueued ${max})`;
    if (stop) return `budget limit: ${stop}`;
    if (!byBudget && today >= ar.maxPerDay) return `daily limit reached: ${today} automatic reviews in the last 24 h (auto.review.maxPerDay ${ar.maxPerDay}); the next slot frees at ${freeAt}`;
    const free = Math.min(max - n, daily);
    const cap = byBudget ? `budget mode, ${today} automatic reviews in the last 24 h` : `${today}/${ar.maxPerDay} automatic reviews in the last 24 h`;
    return `${free} slot(s) free now (maxQueued ${max} with ${n} active, ${cap}); higher-scored PRs take them, the rest follow as jobs finish`;
  };
  const rows = db.all(`SELECT i.*, p.draft, p.additions, p.deletions, p.head_sha FROM items i JOIN prs p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.lane IN ('backlog','follow-up') ORDER BY i.score DESC`, repo);
  for (const it of rows) {
    const flags = db.J(it.flags, []);
    const blockedWhy = it.gate === 'flagged' || it.gate === 'suspicious' ? 'security hold'
      : it.scan_sha !== it.head_sha ? 'current head not scanned yet' : null;
    if (it.lane === 'backlog') {
      const why = blockedWhy || (it.score < ar.minScore ? `score ${it.score} < ${ar.minScore}` : null)
        || (ar.skipDrafts && it.draft ? 'draft' : null) || ((it.additions + it.deletions) > ar.maxLines ? `${it.additions + it.deletions} lines > ${ar.maxLines}` : null)
        || (ar.committersOnly && !flags.includes('committer') ? 'not a committer' : null);
      if (why) continue;
      const slot = reviewSlots-- > 0;
      out.push({ number: it.number, type: 'review', score: it.score, slot, wait: slot ? null : waitWhy('review') });
    } else {
      const a = db.pr(repo, it.number).analysis || {};
      const moved = rr.onHeadMoved && a.headMoved;
      const replied = rr.onAuthorReply && ((a.threadCounts?.['awaiting-my-reply'] || 0) > 0 || (a.newIssueComments || []).length > 0);
      if (blockedWhy || !(moved || replied)) continue;
      // Re-review once per head: a round that already read this head is not repeated automatically.
      const done = db.get(`SELECT 1 FROM jobs WHERE repo = ? AND number = ? AND type = 're-review' AND head_sha = ?`, repo, it.number, it.head_sha);
      if (done) continue;
      const slot = reSlots-- > 0;
      out.push({ number: it.number, type: 're-review', score: it.score, slot, wait: slot ? null : waitWhy('re-review'), why: moved ? 'new commits' : 'author replied' });
    }
  }
  return out;
}

export async function tickRepo(repo, { force = false } = {}) {
  const r = db.repo(repo); const cfg = cfgm.effective(r.config);
  const steps = [];
  const due = force || !r.synced_at || Date.now() - Date.parse(r.synced_at) > cfg.syncMinutes * 60_000;
  if (due && !triage.isSyncing(repo)) {
    try { const s = await triage.sync(repo); steps.push(`synced ${s.prs} PRs (${s.refreshed} changed)`); } catch (e) { steps.push(`sync failed: ${e.message}`); return steps; }
  }
  if (cfg.auto.scan) {
    for (const n of triage.scanCandidates(repo, 12)) {
      try { await triage.scan(repo, n); } catch (e) { db.event(repo, n, `scan of #${n} failed: ${e.message}`, { level: 'warn' }); }
    }
  }
  if (r.autopilot) {
    const paused = budgetPaused(cfg);
    if (paused) { steps.push(`autopilot paused: ${paused}`); return steps; }
    for (const c of ruleCandidates(repo).filter((x) => x.slot)) {
      jobs.enqueue(repo, c.number, c.type, { auto: 1, why: c.why || `score ${c.score}` });
      steps.push(`queued ${c.type} of #${c.number}`);
    }
  }
  return steps;
}

let busy = false;
export async function tick({ force = false } = {}) {
  if (busy) return [];
  busy = true;
  try {
    jobs.budget();   // cached 30 minutes; keeps the header's quota reading current
    const out = [];
    for (const r of db.all('SELECT slug FROM repos WHERE enabled = 1')) out.push(...(await tickRepo(r.slug, { force })).map((s) => `${r.slug}: ${s}`));
    return out;
  } finally { busy = false; }
}
