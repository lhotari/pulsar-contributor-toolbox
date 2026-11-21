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
  const review = { verdict, summary, concerns: text || undefined, sha: p.picked_sha, patchId: patchId(l.worktree, p.picked_sha), job, at: db.now() };
  setDetail(sid, branch, pr, { ...p.detail, review });
  db.event(sid, `Diff review of #${pr}: ${verdict}${verdict === 'ok' ? '' : ` — ${(text || summary).slice(0, 300)}`}`,
    { branch, job, level: verdict === 'concern' ? 'attention' : 'info' });
  return review;
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
function show(dir, sha) {
  const r = spawnSync(g.GIT, ['show', '--format=', '-M', '--no-color', sha], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = r.stdout || '';
  return out.length > MAX ? { text: out.slice(0, MAX), truncated: true } : { text: out, truncated: false };
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
  const mf = splitDiff(m.text); const bf = splitDiff(b.text);
  const names = [...new Set([...mf.map((f) => f.path), ...bf.map((f) => f.path)])];
  const files = names.map((n) => ({ path: n, master: mf.find((f) => f.path === n) || null, backport: bf.find((f) => f.path === n || f.old === n) || null }));
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
  };
}

/** The text a reviewer reads for one pick. */
export function diffText(d) {
  const ctx = Object.entries(d.context).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const parts = [`#${d.pr} ${d.title || ''}\nmaster ${d.masterSha}  backport ${d.backportSha} (${d.branch})${d.truncated ? '\n(diff truncated)' : ''}\n${ctx}`];
  for (const f of d.files) {
    parts.push(`\n===== ${f.path} ${f.master ? '' : '(only in the backport)'}${f.backport ? '' : '(not in the backport)'}`);
    if (f.master) parts.push(`----- master (${f.master.status}, +${f.master.added} -${f.master.removed})\n${f.master.diff}`);
    if (f.backport) parts.push(`----- backport (${f.backport.status}, +${f.backport.added} -${f.backport.removed})\n${f.backport.diff}`);
  }
  return parts.join('\n');
}
