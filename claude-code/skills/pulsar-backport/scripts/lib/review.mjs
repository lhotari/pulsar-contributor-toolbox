// Diff review: each committed pick is compared with its master commit by a Claude review job, which records a verdict
// per pick: ok (the backport is the master change), adapted (it differs where the branch needs it to: a dependency or
// feature that is not on the branch, an API that differs, Java/logging/build adaptations, a left-out PR), or concern
// (part of the master change's intent is missing or wrong, or the backport adds something unrelated). A concern waits
// under Decisions needed: fix it in the pick (a resolve job), accept it, or drop the pick. A review belongs to the
// pick's patch: when the pick's commit changes (a fix squashed in), it is reviewed again; a rebuilt lane that
// re-applies the same patch keeps it.
import { spawnSync } from 'node:child_process';
import * as db from './db.mjs';
import * as g from './git.mjs';
import { comparePick, branchProbes } from './compare.mjs';

export const VERDICTS = ['ok', 'adapted', 'concern'];
const COMMITTED = ['picked', 'needs-fix'];

const picks = (sid, branch) => db.all('SELECT * FROM picks WHERE session_id = ? AND branch = ? ORDER BY seq, pr', sid, branch)
  .map((p) => ({ ...p, detail: db.J(p.detail, {}) }));
const setDetail = (sid, branch, pr, detail) => db.run('UPDATE picks SET detail = ?, updated_at = ? WHERE session_id = ? AND branch = ? AND pr = ?',
  db.S(detail), db.now(), sid, branch, pr);

/** git patch-id of a commit: the same change keeps it across rebases and rebuilds. */
export function patchId(dir, sha) {
  const show = spawnSync(g.GIT, ['show', '--format=', sha], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const r = spawnSync(g.GIT, ['patch-id', '--stable'], { cwd: dir, input: show.stdout, encoding: 'utf8' });
  return (r.stdout || '').split(' ')[0] || null;
}

/**
 * The committed picks that have no review for their current commit. A review made for an earlier commit of the
 * same patch is carried over (its sha updated); one for a different patch is dropped.
 */
export function unreviewed(sid, branch) {
  const l = db.lane(sid, branch); const out = [];
  for (const p of picks(sid, branch)) {
    if (!COMMITTED.includes(p.status) || !p.picked_sha) continue;
    const r = p.detail.review;
    if (r && r.sha === p.picked_sha) continue;
    if (r && l.worktree) {
      const id = patchId(l.worktree, p.picked_sha);
      if (id && id === r.patchId) { setDetail(sid, branch, p.pr, { ...p.detail, review: { ...r, sha: p.picked_sha } }); continue; }
      setDetail(sid, branch, p.pr, { ...p.detail, review: undefined, previousReview: r });
    }
    out.push(p.pr);
  }
  return out;
}

/** Open concerns: a review that found a problem and was neither fixed (the pick changed) nor accepted. */
export function concerns(sid, branch) {
  return picks(sid, branch).filter((p) => COMMITTED.includes(p.status) && p.detail.review?.verdict === 'concern'
    && !p.detail.review.accepted && p.detail.review.sha === p.picked_sha);
}

export function record(sid, branch, pr, { verdict, summary, concerns: text = null, job = null }) {
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`);
  if (!summary) throw new Error('a summary is required');
  if (verdict === 'concern' && !text) throw new Error('a concern needs --concerns: what is missing or wrong');
  const l = db.lane(sid, branch); const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p?.picked_sha) throw new Error(`#${pr} is not a committed pick of ${branch}`);
  // "ok" means the backport is the master change. Where the intent rules see a difference, the verdict says why.
  if (verdict === 'ok') {
    const hits = comparePickHunks(sid, branch, pr).rules;
    if (hits.length) throw new Error(`the backport differs from master where the intent rules check it; record "adapted" (say why each difference is right) or "concern":\n${hits.map((r) => `- ${r.level} ${r.rule}: ${r.message}`).join('\n')}`);
  }
  const review = { verdict, summary, concerns: text || undefined, sha: p.picked_sha, patchId: patchId(l.worktree, p.picked_sha), job, at: db.now() };
  setDetail(sid, branch, pr, { ...p.detail, review });
  db.event(sid, `Diff review of #${pr}: ${verdict}${verdict === 'ok' ? '' : ` — ${(text || summary).slice(0, 300)}`}`,
    { branch, job, level: verdict === 'concern' ? 'attention' : 'info' });
  return review;
}

export const REASONS = ['bug', 'security', 'divergence', 'dependency', 'test', 'build', 'other'];
export const COMPAT = ['none', 'behavior', 'breaking'];

/** The committed picks that have no analysis yet (what they fix, why for this branch, compatibility). */
export function unanalyzed(sid, branch) {
  const have = new Set(db.all('SELECT pr FROM analysis WHERE session_id = ? AND branch = ?', sid, branch).map((x) => x.pr));
  return picks(sid, branch).filter((p) => COMMITTED.includes(p.status) && p.picked_sha && !have.has(p.pr)).map((p) => p.pr);
}

export function analysisOf(sid, branch, pr) {
  return db.get('SELECT fixes, relevance, reason, compat, compat_note, job_id, created_at FROM analysis WHERE session_id = ? AND branch = ? AND pr = ?', sid, branch, pr) || null;
}

export function recordAnalysis(sid, branch, pr, { fixes, relevance, reason, compat, compatNote = null, job = null }) {
  if (!fixes || !relevance) throw new Error('--fixes and --relevance are required');
  if (!REASONS.includes(reason)) throw new Error(`--reason must be one of ${REASONS.join(', ')}`);
  if (!COMPAT.includes(compat)) throw new Error(`--compat must be one of ${COMPAT.join(', ')}`);
  if (compat !== 'none' && !compatNote) throw new Error('a behavior change or breaking change needs --compat-note: what changes and for whom');
  db.run(`INSERT OR REPLACE INTO analysis (session_id, pr, branch, fixes, relevance, reason, compat, compat_note, job_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    sid, pr, branch, fixes, relevance, reason, compat, compatNote, job, db.now());
  if (compat === 'breaking') db.event(sid, `#${pr} may be a breaking change on ${branch}: ${compatNote.slice(0, 300)}`, { branch, job, level: 'attention' });
  return analysisOf(sid, branch, pr);
}

/** An explain job's write-up of why the pick is backported the way it is (for the pick's current commit). */
export function recordExplanation(sid, branch, pr, text, job = null) {
  if (!String(text || '').trim()) throw new Error('the explanation is empty');
  const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p?.picked_sha) throw new Error(`#${pr} is not a committed pick of ${branch}`);
  setDetail(sid, branch, pr, { ...p.detail, explanation: { text: String(text), sha: p.picked_sha, job, at: db.now() } });
  db.event(sid, `#${pr}: explanation of the backport recorded`, { branch, job });
  return { ok: true };
}

export function accept(sid, branch, pr, reason) {
  const p = picks(sid, branch).find((x) => x.pr === pr);
  if (p?.detail.review?.verdict !== 'concern') throw new Error(`#${pr} has no review concern`);
  setDetail(sid, branch, pr, { ...p.detail, review: { ...p.detail.review, accepted: reason || 'accepted by the user', acceptedAt: db.now() } });
  db.event(sid, `Review concern for #${pr} accepted: ${reason || 'no reason given'}`, { branch, level: 'warn' });
}

/** Split `git show` output into files: [{path, old, status, diff}]. */
export function splitDiff(text) {
  const files = []; let cur = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) { cur = { old: m[1], path: m[2], status: 'modified', lines: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from')) cur.status = 'renamed';
    if (/^(index |similarity index|rename (from|to)|new file mode|deleted file mode|old mode|new mode)/.test(line)) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    cur.lines.push(line);
  }
  return files.map(({ lines, ...f }) => ({ ...f, diff: lines.join('\n').replace(/\n+$/, ''), added: lines.filter((x) => x.startsWith('+')).length, removed: lines.filter((x) => x.startsWith('-')).length }));
}

const MAX = 400_000;
export function show(dir, sha) {
  const r = spawnSync(g.GIT, ['show', '--format=', '-M', '--no-color', sha], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = r.stdout || '';
  return out.length > MAX ? { text: out.slice(0, MAX), truncated: true } : { text: out, truncated: false };
}

/** The files of both sides, paired by path (a file the backport renamed pairs by its old path). */
export function pairFiles(mf, bf) {
  const names = [...new Set([...mf.map((f) => f.path), ...bf.filter((f) => !mf.some((x) => x.path === f.old)).map((f) => f.path)])];
  return names.map((n) => ({ path: n, master: mf.find((f) => f.path === n) || null, backport: bf.find((f) => f.path === n || f.old === n) || null }));
}

/** Both sides of one pick, file by file, with what the reviewer needs to judge the differences. */
export function pickDiffs(sid, branch, pr) {
  const s = db.session(sid); const l = db.lane(sid, branch);
  const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p) throw new Error(`#${pr} is not a pick of ${branch}`);
  const item = db.get('SELECT title, sha FROM items WHERE session_id = ? AND pr = ?', sid, pr) || {};
  const t = db.get('SELECT note, adapt, decision_note FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, pr, branch) || {};
  const master = p.detail.master || item.sha || p.source_sha;
  const m = show(s.config.repo, master);
  const b = p.picked_sha ? show(l.worktree, p.picked_sha) : { text: '', truncated: false };
  const files = pairFiles(splitDiff(m.text), splitDiff(b.text));
  const left = db.all(`SELECT t.pr, i.title, t.decision FROM targets t JOIN items i ON i.session_id = t.session_id AND i.pr = t.pr
     WHERE t.session_id = ? AND t.branch = ? AND t.decision = 'skip' AND t.decision_source = 'user'
       AND t.pr IN (SELECT depends_on FROM deps WHERE session_id = ? AND pr = ?)`, sid, branch, sid, pr);
  const { review, build, check, warnings, conflicts, conflictDeps, validation } = p.detail;
  return {
    pr, branch, title: item.title, status: p.status, masterSha: master, backportSha: p.picked_sha,
    truncated: m.truncated || b.truncated, files,
    context: { note: t.note, adapt: t.adapt, decisionNote: t.decision_note, warnings, conflicts, conflictDeps, validation,
      leftOutInReview: left, intent: build?.intent, buildCheck: build ? { ok: build.ok, stage: build.stage, accepted: build.accepted, tests: build.tests } : null,
      checkPick: check ? { ok: check.ok } : null },
    review: review || null, previousReview: p.detail.previousReview || null,
    analysis: analysisOf(sid, branch, pr),
    // What other branches recorded for the same PR: what it fixes is the same, the relevance and compatibility may differ.
    otherAnalyses: db.all('SELECT branch, fixes, relevance, reason, compat, compat_note FROM analysis WHERE session_id = ? AND pr = ? AND branch != ?', sid, pr, branch),
  };
}

/**
 * The pick's hunks next to master's (lib/compare.mjs): {pr, branch, title, status, masterSha, backportSha, review,
 * files: [{path, kind, rows}], counts, rules}. Identical hunks are left out unless `identical`.
 */
export function comparePickHunks(sid, branch, pr, { identical = false } = {}) {
  const d = pickDiffs(sid, branch, pr); const l = db.lane(sid, branch);
  const p = picks(sid, branch).find((x) => x.pr === pr);
  const probes = d.backportSha ? branchProbes(l.worktree, d.backportSha) : {};
  const c = d.truncated ? { files: [], counts: {}, rules: [{ rule: 'too-large', level: 'warn', file: null, message: 'the diff is too large to compare hunk by hunk; see pick diff' }] }
    : comparePick(d.files, { ...probes, identical });
  const accepted = new Set(p?.detail.intentAccepted?.keys || []);
  const rules = c.rules.map((r) => (accepted.has(`${r.rule}:${r.file || ''}`) ? { ...r, accepted: true } : r));
  // The pick's commit is on GitHub once a pushed test branch (or the finalized branch) contains it.
  const ci = l.ci || {};
  const onGitHub = !!d.backportSha && [ci.final?.sha, ci.test?.sha].some((s) => s && g.isAncestor(l.worktree, d.backportSha, s));
  return { pr, branch, title: d.title, status: d.status, masterSha: d.masterSha, backportSha: d.backportSha, onGitHub, review: d.review,
    build: d.context.buildCheck, adaptations: p?.detail.adaptations || null, intentAccepted: p?.detail.intentAccepted || null,
    explanation: p?.detail.explanation || null,
    files: c.files, counts: c.counts, rules };
}

/** Every committed pick of a lane, in lane order, compared hunk by hunk. */
export function compareLane(sid, branch, { identical = false } = {}) {
  return picks(sid, branch).filter((p) => COMMITTED.includes(p.status) && p.picked_sha).map((p) => {
    try { return comparePickHunks(sid, branch, p.pr, { identical }); } catch (e) { return { pr: p.pr, branch, status: p.status, error: e.message, files: [], counts: {}, rules: [] }; }
  });
}

export function compareText(c) {
  const out = [`#${c.pr} ${c.title || ''} on ${c.branch}: ${Object.entries(c.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'no hunks'}`];
  for (const r of c.rules) out.push(`${r.level.toUpperCase()}${r.accepted ? ' (accepted)' : ''} ${r.rule}: ${r.message}`);
  for (const f of c.files) for (const r of f.rows) {
    out.push(`\n===== ${f.path} (${f.kind}): ${r.kind}${r.similarity != null ? ` ${r.similarity}` : ''}`);
    if (r.master) out.push(`----- master ${r.master.header}\n${r.master.lines.join('\n')}`);
    if (r.backport) out.push(`----- backport ${r.backport.header}\n${r.backport.lines.join('\n')}`);
  }
  return out.join('\n');
}

/** The text a reviewer reads for one pick. */
export function diffText(d) {
  const ctx = Object.entries(d.context).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const extra = [d.analysis ? `analysis (recorded): ${JSON.stringify(d.analysis)}` : null, ...(d.otherAnalyses || []).map((x) => `analysis on ${x.branch}: ${JSON.stringify(x)}`)].filter(Boolean).join('\n');
  const parts = [`#${d.pr} ${d.title || ''}\nmaster ${d.masterSha}  backport ${d.backportSha} (${d.branch})${d.truncated ? '\n(diff truncated)' : ''}\n${ctx}${extra ? `\n${extra}` : ''}`];
  for (const f of d.files) {
    parts.push(`\n===== ${f.path} ${f.master ? '' : '(only in the backport)'}${f.backport ? '' : '(not in the backport)'}`);
    if (f.master) parts.push(`----- master (${f.master.status}, +${f.master.added} -${f.master.removed})\n${f.master.diff}`);
    if (f.backport) parts.push(`----- backport (${f.backport.status}, +${f.backport.added} -${f.backport.removed})\n${f.backport.diff}`);
  }
  return parts.join('\n');
}
