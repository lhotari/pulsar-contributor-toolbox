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

/** Which PRs the rules would queue right now, with the reason for each (also shown in the UI as a preview). */
export function ruleCandidates(repo) {
  const r = db.repo(repo); const cfg = cfgm.effective(r.config); const ar = cfg.auto.review; const rr = cfg.auto.reReview;
  const out = [];
  const active = (type) => db.get(`SELECT COUNT(*) n FROM jobs WHERE repo = ? AND type = ? AND status IN ('queued','running','waiting')`, repo, type).n;
  const today = db.get(`SELECT COUNT(*) n FROM jobs WHERE repo = ? AND type IN ('review','re-review') AND json_extract(args,'$.auto') = 1 AND created_at > ?`,
    repo, new Date(Date.now() - DAY).toISOString()).n;
  let reviewSlots = Math.max(0, Math.min(ar.maxQueued - active('review'), ar.maxPerDay - today));
  let reSlots = Math.max(0, Math.min(rr.maxQueued - active('re-review'), ar.maxPerDay - today - reviewSlots));
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
      out.push({ number: it.number, type: 'review', score: it.score, slot: reviewSlots-- > 0 });
    } else {
      const a = db.pr(repo, it.number).analysis || {};
      const moved = rr.onHeadMoved && a.headMoved;
      const replied = rr.onAuthorReply && ((a.threadCounts?.['awaiting-my-reply'] || 0) > 0 || (a.newIssueComments || []).length > 0);
      if (blockedWhy || !(moved || replied)) continue;
      // Re-review once per head: a round that already read this head is not repeated automatically.
      const done = db.get(`SELECT 1 FROM jobs WHERE repo = ? AND number = ? AND type = 're-review' AND head_sha = ?`, repo, it.number, it.head_sha);
      if (done) continue;
      out.push({ number: it.number, type: 're-review', score: it.score, slot: reSlots-- > 0, why: moved ? 'new commits' : 'author replied' });
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
