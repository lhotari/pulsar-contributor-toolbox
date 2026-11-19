// Lane engine: cherry-picks for one target branch, test PR, CI, squash, finalize.
// Phases: not-started → picking ⇄ needs-attention → picked → verifying → verified → testing ⇄ ci-failed
//         → ci-green → ready → final-ci ⇄ final-ci-failed → done
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import * as g from './git.mjs';
import * as gh from './gh.mjs';
import { remote, remoteRef, depOnBranch } from './plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PHASES = ['not-started', 'picking', 'needs-attention', 'picked', 'verifying', 'verified', 'testing', 'ci-failed',
  'ci-green', 'ready', 'final-ci', 'final-ci-failed', 'done'];
const REUSABLE = ['ready', 'final-ci', 'final-ci-failed', 'done'];

function checkPickScript() {
  for (const p of [path.resolve(HERE, '../../../pulsar-cherry-pick/scripts/check-pick.sh'),
    path.join(process.env.HOME, '.claude/skills/pulsar-cherry-pick/scripts/check-pick.sh')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function worktreeDir(sid, branch) { return path.join(db.BPT_HOME, 'worktrees', sid, branch); }
export const localBranch = (sid, branch) => `bpt/${sid}/${branch}`;
export function testBranchName(cfg, sid, branch) {
  return (cfg.testBranchPattern || '{branch}-backports-{id}').replaceAll('{branch}', branch).replaceAll('{id}', sid);
}
const picks = (sid, branch) => db.all('SELECT * FROM picks WHERE session_id = ? AND branch = ? ORDER BY seq, pr', sid, branch)
  .map((p) => ({ ...p, detail: db.J(p.detail, {}) }));
function setPick(sid, branch, pr, fields) {
  const keys = Object.keys(fields);
  db.run(`UPDATE picks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE session_id = ? AND branch = ? AND pr = ?`,
    ...keys.map((k) => (k === 'detail' ? db.S(fields[k]) : fields[k])), db.now(), sid, branch, pr);
}
const attention = (sid, branch, text, level = 'attention') => {
  db.updateLane(sid, branch, { attention: text });
  if (text) db.event(sid, text, { branch, level });
};

/** Create the lane worktree and its pick list. */
export function startLane(sid, branch, { log = console.log } = {}) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch);
  if (l.phase !== 'not-started') return l;
  if (l.reuse_from) {
    const src = db.lane(sid, l.reuse_from);
    if (!REUSABLE.includes(src.phase)) throw new Error(`${branch} reuses ${l.reuse_from}, which is not ready (phase ${src.phase})`);
  }
  g.fetch(cfg.repo, remote(cfg), [branch]);
  const base = g.rev(cfg.repo, remoteRef(cfg, branch));
  const dir = worktreeDir(sid, branch);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  g.addWorktree(cfg.repo, dir, localBranch(sid, branch), base);
  db.updateLane(sid, branch, { phase: 'picking', worktree: dir, local_branch: localBranch(sid, branch), base_sha: base, head_sha: base, attention: null });
  const n = syncPicks(sid, branch);
  if (l.reuse_from) {
    // Dependencies accepted while backporting to the source lane usually hold here too: ask again for this branch.
    const carried = db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, status, phase, created_at)
       SELECT d.session_id, d.pr, d.depends_on, ?, d.source, 'accepted on ' || d.branch || ': ' || IFNULL(d.detail, ''), 'open', 'backport', ?
       FROM deps d JOIN picks p ON p.session_id = d.session_id AND p.pr = d.pr AND p.branch = ?
       WHERE d.session_id = ? AND d.branch = ? AND d.status = 'accepted'`, branch, db.now(), branch, sid, l.reuse_from);
    if (carried.changes) db.event(sid, `${carried.changes} dependency decision(s) from ${l.reuse_from} carried over for review`, { branch, level: 'attention' });
  }
  db.event(sid, `Lane started at ${g.short(base)} with ${n.total} picks in ${dir}`, { branch });
  log(`worktree ${dir}, ${n.total} picks`);
  return db.lane(sid, branch);
}

/** Align the pick list with the plan's decisions (backport, not already on the branch), in master order. */
export function syncPicks(sid, branch) {
  const l = db.lane(sid, branch);
  const want = db.all(`SELECT i.pr, i.sha, i.master_order FROM items i JOIN targets t ON t.session_id = i.session_id AND t.pr = i.pr
                        WHERE i.session_id = ? AND t.branch = ? AND t.decision = 'backport' AND t.on_branch = 0 ORDER BY i.master_order`, sid, branch);
  const have = new Map(picks(sid, branch).map((p) => [p.pr, p]));
  const reuse = l.reuse_from ? new Map(picks(sid, l.reuse_from).filter((p) => p.status === 'picked').map((p) => [p.pr, p.picked_sha])) : new Map();
  const lastPicked = Math.max(-1, ...[...have.values()].filter((p) => p.status !== 'pending').map((p) => p.seq));
  let added = 0; let removed = 0;
  for (const w of want) {
    if (have.has(w.pr)) continue;
    const src = reuse.get(w.pr);
    db.run(`INSERT INTO picks (session_id, branch, pr, seq, source_sha, status, detail, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      sid, branch, w.pr, w.master_order, src || w.sha, 'pending', db.S({ reused: !!src, master: w.sha }), db.now());
    added++;
    if (w.master_order < lastPicked) db.event(sid, `#${w.pr} was added after later commits were already picked; it will be picked out of master order`, { branch, level: 'warn' });
  }
  const wanted = new Set(want.map((w) => w.pr));
  for (const p of have.values()) {
    if (wanted.has(p.pr)) continue;
    if (p.status === 'pending' || p.status === 'blocked') { db.run('DELETE FROM picks WHERE session_id = ? AND branch = ? AND pr = ?', sid, branch, p.pr); removed++; }
    else if (p.status !== 'skipped') db.event(sid, `#${p.pr} is no longer decided "backport" but is already ${p.status}; reset it by hand if it must go`, { branch, level: 'warn' });
  }
  return { added, removed, total: picks(sid, branch).length };
}

/** Dependencies that are not satisfied in this lane before the given pick. */
export function unmetDeps(sid, branch, pick) {
  const earlier = new Set(picks(sid, branch).filter((p) => ['picked', 'empty'].includes(p.status) && p.pr !== pick.pr).map((p) => p.pr));
  const rows = db.all(`SELECT d.*, t.on_branch, t.decision FROM deps d
       LEFT JOIN targets t ON t.session_id = d.session_id AND t.pr = d.depends_on AND t.branch = ?
       WHERE d.session_id = ? AND d.pr = ? AND (d.branch IS NULL OR d.branch = ?) AND d.status != 'dismissed'`, branch, sid, pick.pr, branch);
  return rows.filter((d) => !earlier.has(d.depends_on) && !(d.on_branch ?? depOnBranch(sid, branch, d.depends_on)));
}

/** Pick the next pending commit. Returns {status, pr, ...}. */
export function pickNext(sid, branch) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch);
  const dir = l.worktree;
  const st = g.state(dir);
  if (st.cherryPicking || st.rebasing) return { status: 'in-progress', head: st.head };
  if (st.dirty) { attention(sid, branch, 'The lane worktree has uncommitted changes; commit or discard them before picking continues'); return { status: 'dirty' }; }
  const list = picks(sid, branch);
  const stuck = list.find((p) => ['conflict', 'needs-fix', 'blocked'].includes(p.status));
  if (stuck) { db.updateLane(sid, branch, { phase: 'needs-attention' }); return { status: stuck.status, pr: stuck.pr }; }
  const next = list.find((p) => p.status === 'pending');
  if (!next) {
    db.updateLane(sid, branch, { phase: 'picked', head_sha: st.head, attention: null });
    db.event(sid, `All ${list.filter((p) => p.status === 'picked').length} picks applied; ready for build verification`, { branch });
    return { status: 'done' };
  }
  const detail = { ...next.detail };
  // Re-run the dependency analysis against this lane: a dependency may have surfaced only now
  // (a skip decision, a branch-specific gap, or a dependency on another pick of this batch).
  if (!detail.reused) {
    const item = db.get('SELECT * FROM items WHERE session_id = ? AND pr = ?', sid, next.pr);
    const all = db.all('SELECT pr, sha, master_order FROM items WHERE session_id = ?', sid);
    const r = remote(cfg); const branchRef = `${r}/${branch}`;
    const onB = g.pickedOnBranch(cfg.repo, branchRef, `${r}/${cfg.source}`);
    for (const p of list) if (['picked', 'empty'].includes(p.status)) onB.prs.add(p.pr);
    const found = (awaitBlame(sid, cfg.repo, item, all, onB, branch));
    if (found.length) detail.newDeps = found;
  }
  const unmet = unmetDeps(sid, branch, next);
  const dry = g.dryPick(dir, 'HEAD', next.source_sha, `${next.source_sha}^`);
  const hard = unmet.filter((d) => d.source !== 'blame' || !dry.clean);
  if (hard.length) {
    detail.unmet = hard.map((d) => ({ depends_on: d.depends_on, source: d.source, detail: d.detail, decision: d.decision }));
    setPick(sid, branch, next.pr, { status: 'blocked', detail });
    db.updateLane(sid, branch, { phase: 'needs-attention' });
    attention(sid, branch, `#${next.pr} depends on ${hard.map((d) => `#${d.depends_on}`).join(', ')}, which ${hard.length > 1 ? 'are' : 'is'} not on ${branch} or earlier in this batch. Decide in the plan: add the dependency, or dismiss it`);
    return { status: 'blocked', pr: next.pr, unmet: detail.unmet };
  }
  if (unmet.length) detail.warnings = unmet.map((d) => `applies cleanly although it builds on #${d.depends_on} (${d.detail})`);
  const res = g.cherryPick(dir, next.source_sha, { trailer: !detail.reused });
  if (res.empty) {
    setPick(sid, branch, next.pr, { status: 'empty', detail: { ...detail, note: 'the change is already on the branch' } });
    db.event(sid, `#${next.pr} is already on the branch (empty cherry-pick), skipped`, { branch, level: 'warn' });
    return { status: 'empty', pr: next.pr };
  }
  if (!res.ok) {
    detail.conflicts = res.conflicts; detail.error = res.error?.slice(0, 2000);
    detail.conflictDeps = conflictDeps(sid, cfg, branch, next, res.conflicts);
    setPick(sid, branch, next.pr, { status: 'conflict', detail });
    db.updateLane(sid, branch, { phase: 'needs-attention' });
    attention(sid, branch, `#${next.pr} conflicts in ${res.conflicts.map((f) => f.split('/').pop()).join(', ')}`);
    return { status: 'conflict', pr: next.pr, conflicts: res.conflicts, conflictDeps: detail.conflictDeps };
  }
  const check = runCheck(dir, next.detail.master || next.source_sha);
  detail.check = check;
  setPick(sid, branch, next.pr, { status: check.ok ? 'picked' : 'needs-fix', picked_sha: res.sha, detail });
  db.updateLane(sid, branch, { head_sha: res.sha });
  if (!check.ok) {
    db.updateLane(sid, branch, { phase: 'needs-attention' });
    attention(sid, branch, `#${next.pr} applied, but the post-pick check found leftover slog, markers or unguarded debug logging`);
    return { status: 'needs-fix', pr: next.pr };
  }
  db.event(sid, `#${next.pr} picked as ${g.short(res.sha)}${detail.warnings ? ` (${detail.warnings.length} dependency warning(s))` : ''}`, { branch });
  return { status: 'picked', pr: next.pr, sha: res.sha, warnings: detail.warnings };
}

function awaitBlame(sid, repo, item, all, onB, branch) {
  const shaToPr = new Map(all.map((x) => [x.sha, x.pr]));
  const order = new Map(all.map((x) => [x.pr, x.master_order]));
  const before = db.all('SELECT depends_on FROM deps WHERE session_id = ? AND pr = ? AND (branch = ? OR branch IS NULL)', sid, item.pr, branch).map((d) => d.depends_on);
  const hits = g.blameDependencies(repo, item.sha);
  const found = [];
  for (const h of hits) {
    const dep = shaToPr.get(h.sha);
    if (!dep || dep === item.pr || order.get(dep) >= order.get(item.pr) || onB.prs.has(dep) || onB.shas.has(h.sha) || before.includes(dep)) continue;
    const detail = `${h.lines} changed line(s) in ${[...h.files].map((f) => f.split('/').pop()).join(', ')} were last changed by #${dep}`;
    db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      sid, item.pr, dep, branch, 'blame', detail, 'backport', db.now());
    found.push({ depends_on: dep, detail });
    db.event(sid, `New dependency found while backporting: #${item.pr} builds on #${dep} (${detail})`, { branch, level: 'warn' });
  }
  return found;
}

/** Master commits in the session range that touched the conflicted files and are missing from the lane. */
function conflictDeps(sid, cfg, branch, pick, files) {
  const master = pick.detail.master || pick.source_sha;
  const inLane = new Set(picks(sid, branch).filter((p) => ['picked', 'empty'].includes(p.status)).map((p) => p.pr));
  const out = [];
  for (const f of files.slice(0, 20)) {
    const log = g.git(cfg.repo, ['log', '--first-parent', '--format=%H %s', `${cfg.sinceSha}..${master}^`, '--', f], { allowFail: true }).out;
    for (const line of log.split('\n').filter(Boolean)) {
      const m = line.match(g.PR_RE); if (!m) continue;
      const dep = Number(m[1]);
      const t = db.get('SELECT on_branch, decision FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, dep, branch);
      if (!t || t.on_branch || inLane.has(dep)) continue;
      out.push({ depends_on: dep, file: f.split('/').pop(), decision: t.decision, title: line.slice(41).replace(g.PR_RE, '').trim() });
      db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        sid, pick.pr, dep, branch, 'conflict', `also changed ${f.split('/').pop()}, which conflicts`, 'backport', db.now());
    }
  }
  return out;
}

function runCheck(dir, sha) {
  const script = checkPickScript();
  if (!script) return { ok: true, skipped: 'check-pick.sh not found' };
  const r = spawnSync('bash', [script, sha], { cwd: dir, encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '').slice(-4000) };
}

export function pickAll(sid, branch, { log = console.log, max = 1000 } = {}) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = pickNext(sid, branch);
    results.push(r);
    log(`${r.status}${r.pr ? ` #${r.pr}` : ''}${r.sha ? ` ${g.short(r.sha)}` : ''}`);
    if (!['picked', 'empty'].includes(r.status)) return { last: r, results };
  }
  return { last: results.at(-1), results };
}

/** After a human or worker resolved a conflict (or fixed a needs-fix pick) and committed. */
export function markResolved(sid, branch, pr) {
  const l = db.lane(sid, branch); const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p) throw new Error(`#${pr} is not a pick of ${branch}`);
  const st = g.state(l.worktree);
  if (st.cherryPicking || st.rebasing) throw new Error('a cherry-pick or rebase is still in progress; finish it with git cherry-pick --continue first');
  if (st.dirty) throw new Error('uncommitted changes in the lane worktree');
  const msg = g.git(l.worktree, ['log', '-1', '--format=%B', 'HEAD']);
  const master = p.detail.master || p.source_sha;
  if (!msg.includes(master) && !msg.includes(`(#${pr})`)) throw new Error(`HEAD ${g.short(st.head)} does not look like the pick of #${pr} (no trailer or PR number)`);
  const check = runCheck(l.worktree, master);
  const detail = { ...p.detail, check, resolvedAt: db.now() };
  setPick(sid, branch, pr, { status: 'picked', picked_sha: st.head, detail });
  db.updateLane(sid, branch, { head_sha: st.head, phase: 'picking', attention: null });
  db.event(sid, `#${pr} resolved as ${g.short(st.head)}${check.ok ? '' : ' (check-pick still reports findings)'}`, { branch });
  return { ok: true, check };
}

export function skipPick(sid, branch, pr, reason) {
  const l = db.lane(sid, branch); const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p) throw new Error(`#${pr} is not a pick of ${branch}`);
  if (['picked', 'needs-fix'].includes(p.status)) throw new Error(`#${pr} is already committed (${g.short(p.picked_sha)}); drop it with an interactive rebase by hand or reset the lane`);
  const st = g.state(l.worktree);
  if (st.cherryPicking) {
    const cph = g.git(l.worktree, ['rev-parse', 'CHERRY_PICK_HEAD'], { allowFail: true }).out;
    if (cph === p.source_sha) g.git(l.worktree, ['cherry-pick', '--abort']);
  }
  setPick(sid, branch, pr, { status: 'skipped', detail: { ...p.detail, reason } });
  db.run(`UPDATE targets SET decision = 'skip', decision_source = 'user', decision_note = ?, decided_at = ? WHERE session_id = ? AND pr = ? AND branch = ?`,
    `skipped while backporting: ${reason}`, db.now(), sid, pr, branch);
  db.updateLane(sid, branch, { phase: 'picking', attention: null });
  db.event(sid, `#${pr} skipped: ${reason}`, { branch, level: 'warn' });
}

/** Return a blocked pick to pending after its dependencies were decided. */
export function unblock(sid, branch, pr) {
  const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p || p.status !== 'blocked') return false;
  syncPicks(sid, branch);
  setPick(sid, branch, pr, { status: 'pending', detail: { ...p.detail, unmet: undefined } });
  db.updateLane(sid, branch, { phase: 'picking', attention: null });
  return true;
}

export function setPhase(sid, branch, phase, note) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
  db.updateLane(sid, branch, { phase, attention: null });
  db.event(sid, `Phase → ${phase}${note ? `: ${note}` : ''}`, { branch });
}

function prBody(sid, branch, l) {
  const list = picks(sid, branch).filter((p) => p.status === 'picked');
  const items = new Map(db.all('SELECT pr, title FROM items WHERE session_id = ?', sid).map((x) => [x.pr, x.title]));
  return `### Motivation

CI run for the ${l.release ? `${l.release} ` : ''}backports to \`${branch}\` (backport session \`${sid}\`). **Do not merge.** After CI passes, the commits are pushed to \`${branch}\` directly and this PR is closed.

### Modifications

${list.length} cherry-picks from \`master\`, in master commit order:

${list.map((p) => `- #${p.pr} ${items.get(p.pr) || ''}`).join('\n')}

Fixes for CI failures are added as \`fixup!\` commits and squashed into the matching cherry-pick before the final push; the tested tree and the pushed tree are identical.

### Verifying this change

- [x] Make sure that the change passes the CI checks.

### Documentation

- [ ] \`doc\`
- [ ] \`doc-required\`
- [x] \`doc-not-needed\`
- [ ] \`doc-complete\`
`;
}

/** Push the lane to its test branch on apache/pulsar (never forced) and open or reuse the test PR. */
export function pushTest(sid, branch) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch); const r = remote(cfg);
  const tb = l.test_branch || testBranchName(cfg, sid, branch);
  const head = g.rev(l.worktree, 'HEAD');
  const remoteHead = g.git(cfg.repo, ['ls-remote', r, `refs/heads/${tb}`]).split(/\s/)[0];
  if (remoteHead && remoteHead !== head) {
    g.git(cfg.repo, ['fetch', '--quiet', r, `refs/heads/${tb}`]);
    if (!g.isAncestor(l.worktree, remoteHead, head)) throw new Error(`${r}/${tb} (${g.short(remoteHead)}) is not an ancestor of the lane head; refusing to force-push`);
  }
  if (remoteHead !== head) g.git(l.worktree, ['push', r, `HEAD:refs/heads/${tb}`]);
  let pr = l.test_pr ? { number: l.test_pr, url: l.test_pr_url } : gh.findPr(tb);
  if (!pr || pr.state === 'CLOSED') {
    pr = gh.createPr({ base: branch, head: tb, labels: ['ready-to-test', 'doc-not-needed'],
      title: `[improve][ci] Run CI for the ${l.release || ''} backports to ${branch} (do not merge)`.replace(/\s+/g, ' '),
      body: prBody(sid, branch, l) });
    db.event(sid, `Opened test PR #${pr.number}`, { branch, data: pr });
  }
  const ci = { ...l.ci, test: { sha: head, state: 'pending', pushedAt: db.now(), reruns: l.ci.test?.sha === head ? l.ci.test.reruns || 0 : 0 } };
  db.updateLane(sid, branch, { phase: 'testing', test_branch: tb, test_pr: pr.number, test_pr_url: pr.url, head_sha: head, ci, attention: null });
  db.event(sid, `Pushed ${g.short(head)} to ${r}/${tb}`, { branch });
  return { testBranch: tb, pr };
}

/** Poll CI for the test PR or the final push. */
export function pollCi(sid, branch) {
  const l = db.lane(sid, branch);
  const final = ['final-ci', 'final-ci-failed'].includes(l.phase);
  const kind = final ? 'final' : 'test';
  const prev = l.ci[kind] || {};
  if (!prev.sha) return { state: 'none' };
  const res = final ? gh.commitChecks(prev.sha) : gh.prChecks(l.test_pr);
  const ci = { ...l.ci, [kind]: { ...prev, ...res, polledAt: db.now() } };
  let phase = l.phase;
  if (res.state === 'success') phase = final ? 'done' : 'ci-green';
  else if (res.state === 'failure') phase = final ? 'final-ci-failed' : 'ci-failed';
  db.updateLane(sid, branch, { ci, phase });
  if (phase !== l.phase) {
    const failed = res.failed?.map((f) => f.name).slice(0, 8).join(', ');
    db.event(sid, `${kind} CI ${res.state}${failed ? `: ${failed}` : ''}`, { branch, level: res.state === 'success' ? 'info' : 'attention' });
    if (phase === 'done') afterDone(sid, branch);
  }
  return { kind, ...res, phase };
}

export function rerunFailed(sid, branch) {
  const l = db.lane(sid, branch);
  const final = l.phase.startsWith('final');
  const kind = final ? 'final' : 'test';
  const c = l.ci[kind]; if (!c?.sha) throw new Error('no CI run to rerun');
  const ids = gh.failedRunIds(c.sha);
  for (const id of ids) gh.rerunFailed(id);
  const ci = { ...l.ci, [kind]: { ...c, state: 'pending', reruns: (c.reruns || 0) + 1 } };
  db.updateLane(sid, branch, { ci, phase: final ? 'final-ci' : 'testing', attention: null });
  db.event(sid, `Re-ran failed jobs of ${ids.length} workflow run(s) (rerun ${ci[kind].reruns})`, { branch });
  return { runs: ids };
}

/** Fold fixup! commits into their cherry-picks. The resulting tree must equal the tested tree. */
export function squash(sid, branch) {
  const l = db.lane(sid, branch); const dir = l.worktree;
  const before = g.rev(dir, 'HEAD');
  const subjects = g.git(dir, ['log', '--format=%s', `${l.base_sha}..HEAD`]).split('\n');
  if (subjects.some((x) => /^(fixup|squash|amend)! /.test(x))) {
    const r = g.git(dir, ['rebase', '-i', '--autosquash', l.base_sha], { allowFail: true, env: { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' } });
    if (!r.ok) { g.git(dir, ['rebase', '--abort'], { allowFail: true }); throw new Error(`autosquash failed: ${r.err}`); }
    const diff = g.git(dir, ['diff', '--stat', before, 'HEAD']);
    if (diff) { g.git(dir, ['reset', '--hard', before]); throw new Error(`autosquash changed the tree; restored ${g.short(before)}:\n${diff}`); }
  }
  const after = g.rev(dir, 'HEAD');
  // Map the final commits back to their picks.
  const list = picks(sid, branch); const byMaster = new Map(list.map((p) => [p.detail.master || p.source_sha, p]));
  const extra = [];
  for (const line of g.git(dir, ['log', '--reverse', '--format=%H%x1f%B%x1e', `${l.base_sha}..HEAD`]).split('\x1e')) {
    const [sha, body] = line.trim().split('\x1f'); if (!sha) continue;
    const m = (body || '').match(/cherry picked from commit ([0-9a-f]{40})/g);
    const src = m ? m.at(-1).slice(-40) : null;
    const p = src && byMaster.get(src);
    if (p) setPick(sid, branch, p.pr, { picked_sha: sha }); else extra.push({ sha, subject: body.split('\n')[0] });
  }
  const ci = { ...l.ci, squash: { tested: before, squashed: after, extra } };
  db.updateLane(sid, branch, { squashed_sha: after, head_sha: after, phase: 'ready', ci,
    attention: 'Tested and squashed. Finalize from the UI to fast-forward the branch' });
  db.event(sid, `Squashed ${g.short(before)} → ${g.short(after)} (same tree)${extra.length ? `; ${extra.length} commit(s) without a cherry-pick trailer` : ''}`, { branch });
  return { tested: before, squashed: after, extra };
}

/**
 * Fast-forward the real branch to the squashed lane head and dispatch CI. Only called from an explicit user action.
 * If someone pushed to the branch meanwhile, the lane is rebased; pushing that untested combination needs allowRebase.
 */
export function finalize(sid, branch, { allowRebase = false } = {}) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch); const r = remote(cfg);
  if (l.phase !== 'ready') throw new Error(`lane is ${l.phase}; finalize needs "ready"`);
  g.fetch(cfg.repo, r, [branch]);
  const target = g.rev(cfg.repo, `${r}/${branch}`);
  let head = l.squashed_sha;
  const pending = l.ci.rebase;
  if (pending?.onto === target && target === l.base_sha && pending.head === head) {
    if (!allowRebase) return { status: 'needs-confirmation', moved: pending.moved, head };
  } else if (target !== l.base_sha) {
    if (!g.isAncestor(cfg.repo, l.base_sha, target)) throw new Error(`${branch} was rewritten since the lane started; resolve by hand`);
    const moved = g.git(cfg.repo, ['log', '--oneline', `${l.base_sha}..${target}`]).split('\n').filter(Boolean);
    const rb = g.git(l.worktree, ['rebase', '--onto', target, l.base_sha], { allowFail: true });
    if (!rb.ok) {
      g.git(l.worktree, ['rebase', '--abort'], { allowFail: true });
      attention(sid, branch, `${branch} moved by ${moved.length} commit(s) and the batch no longer rebases cleanly; resolve by hand`);
      return { status: 'rebase-conflict', moved };
    }
    head = g.rev(l.worktree, 'HEAD');
    db.updateLane(sid, branch, { base_sha: target, squashed_sha: head, head_sha: head, ci: { ...l.ci, rebase: { onto: target, head, moved } } });
    if (!allowRebase) {
      attention(sid, branch, `${branch} moved by ${moved.length} commit(s) (${moved.slice(0, 3).join('; ')}). The batch rebased cleanly onto it, but that combination is untested. Use "Push rebased" to accept it`);
      return { status: 'needs-confirmation', moved, head };
    }
  }
  g.git(l.worktree, ['push', r, `${head}:refs/heads/${branch}`]);
  for (const wf of cfg.finalWorkflows || ['pulsar-ci.yaml', 'pulsar-ci-flaky.yaml', 'ci-go-functions.yaml', 'ci-python-functions.yaml']) {
    try { gh.dispatch(wf, branch); } catch (e) { db.event(sid, `Could not dispatch ${wf}: ${e.message}`, { branch, level: 'warn' }); }
  }
  db.updateLane(sid, branch, { final_sha: head, head_sha: head, phase: 'final-ci', attention: null,
    ci: { ...db.lane(sid, branch).ci, final: { sha: head, state: 'pending', pushedAt: db.now(), reruns: 0 } } });
  db.event(sid, `Pushed ${branch} ${g.short(target)}..${g.short(head)} and dispatched CI`, { branch });
  return { status: 'pushed', from: target, to: head };
}

/** A fix for a final-CI failure, committed on top of the pushed head. Fast-forward only. */
export function pushFinalFix(sid, branch) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch); const r = remote(cfg);
  const head = g.rev(l.worktree, 'HEAD');
  if (!g.isAncestor(l.worktree, l.final_sha, head) || head === l.final_sha) throw new Error('no new commits on top of the pushed head');
  g.git(l.worktree, ['push', r, `HEAD:refs/heads/${branch}`]);
  for (const wf of cfg.finalWorkflows || ['pulsar-ci.yaml', 'pulsar-ci-flaky.yaml', 'ci-go-functions.yaml', 'ci-python-functions.yaml']) {
    try { gh.dispatch(wf, branch); } catch { /* reported by the next poll */ }
  }
  db.updateLane(sid, branch, { final_sha: head, head_sha: head, phase: 'final-ci', ci: { ...l.ci, final: { sha: head, state: 'pending', pushedAt: db.now(), reruns: 0 } } });
  db.event(sid, `Pushed fix ${g.short(l.final_sha)}..${g.short(head)} to ${branch} and dispatched CI`, { branch });
}

/** After final CI is green: labels, close the test PR, delete the test branch. */
export function afterDone(sid, branch) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch); const r = remote(cfg);
  const done = picks(sid, branch).filter((p) => p.status === 'picked');
  for (const p of done) {
    const add = [`cherry-picked/${branch}`]; if (l.release) add.push(`release/${l.release}`);
    try { gh.editLabels(p.pr, { add }); } catch (e) { db.event(sid, `Labels on #${p.pr} failed: ${e.message}`, { branch, level: 'warn' }); }
  }
  if (l.test_pr) gh.closePr(l.test_pr, `CI passed; the commits were pushed to \`${branch}\` as ${g.short(l.base_sha)}..${g.short(l.final_sha)}.`);
  if (l.test_branch) g.git(cfg.repo, ['push', r, '--delete', l.test_branch], { allowFail: true });
  db.updateLane(sid, branch, { attention: null });
  db.event(sid, `Done: labelled ${done.length} PRs cherry-picked/${branch}, closed the test PR and deleted ${l.test_branch}`, { branch });
}

/** Accept (add the dependency to the batch) or dismiss a dependency, then re-plan the affected lanes. */
export function setDep(sid, id, status) {
  const d = db.get('SELECT * FROM deps WHERE session_id = ? AND id = ?', sid, id);
  if (!d) throw new Error(`no dependency ${id}`);
  if (!['open', 'accepted', 'dismissed'].includes(status)) throw new Error('status: open | accepted | dismissed');
  db.run('UPDATE deps SET status = ? WHERE id = ?', status, id);
  const branches = d.branch ? [d.branch] : db.all('SELECT branch FROM lanes WHERE session_id = ?', sid).map((l) => l.branch);
  for (const b of branches) {
    if (status === 'accepted') {
      db.run(`UPDATE targets SET decision = 'backport', decision_source = 'user', decision_note = COALESCE(decision_note, ?), decided_at = ?
              WHERE session_id = ? AND pr = ? AND branch = ? AND on_branch = 0`, `dependency of #${d.pr}`, db.now(), sid, d.depends_on, b);
    }
    const l = db.get('SELECT phase FROM lanes WHERE session_id = ? AND branch = ?', sid, b);
    if (l && l.phase !== 'not-started') { syncPicks(sid, b); if (status !== 'open') unblock(sid, b, d.pr); }
  }
  db.event(sid, `Dependency #${d.pr} → #${d.depends_on} ${status}`, { branch: d.branch });
}

export function lanePicks(sid, branch) { return picks(sid, branch); }

/** Remove the lane's worktree and local branch and forget its picks. The remote test branch is left alone. */
export function resetLane(sid, branch) {
  const s = db.session(sid); const l = db.lane(sid, branch);
  if (['final-ci', 'final-ci-failed', 'done'].includes(l.phase)) throw new Error('the lane was already pushed to the real branch');
  if (l.worktree && fs.existsSync(l.worktree)) g.git(s.config.repo, ['worktree', 'remove', '--force', l.worktree], { allowFail: true });
  if (l.local_branch) g.git(s.config.repo, ['branch', '-D', l.local_branch], { allowFail: true });
  db.run('DELETE FROM picks WHERE session_id = ? AND branch = ?', sid, branch);
  db.updateLane(sid, branch, { phase: 'not-started', worktree: null, local_branch: null, base_sha: null, head_sha: null, squashed_sha: null, attention: null, ci: {} });
  db.event(sid, 'Lane reset', { branch, level: 'warn' });
}
