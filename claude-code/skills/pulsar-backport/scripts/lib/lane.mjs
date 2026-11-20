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
import * as jobs from './jobs.mjs';
import { remote, remoteRef, depOnBranch, saveConfig, pullInDependencies } from './plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PHASES = ['not-started', 'picking', 'needs-attention', 'picked', 'verifying', 'verified', 'testing', 'ci-failed',
  'ci-green', 'ready', 'final-ci', 'final-ci-failed', 'done'];
const REUSABLE = ['ready', 'final-ci', 'final-ci-failed', 'done'];
/** Picking finished; a pick added now waits for a decision instead of being applied on top. */
export const POST_PICK = ['picked', 'verifying', 'verified', 'testing', 'ci-failed', 'ci-green', 'ready'];
/** Pushed to the real branch: the batch can no longer be rebuilt. */
export const PUSHED = ['final-ci', 'final-ci-failed', 'done'];
const COMMITTED = ['picked', 'needs-fix'];

function checkPickScript() {
  for (const p of [path.resolve(HERE, '../../../pulsar-cherry-pick/scripts/check-pick.sh'),
    path.join(process.env.HOME, '.claude/skills/pulsar-cherry-pick/scripts/check-pick.sh')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function worktreeDir(sid, branch) { return path.join(db.BPT_HOME, 'worktrees', sid, branch); }
export const localBranch = (sid, branch) => `bpt/${sid}/${branch}`;
export function testBranchName(cfg, sid, branch, round = 1) {
  const name = (cfg.testBranchPattern || '{branch}-backports-{id}').replaceAll('{branch}', branch).replaceAll('{id}', sid);
  return round > 1 ? `${name}-r${round}` : name;
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
  if (PUSHED.includes(l.phase)) return { added: 0, removed: 0, total: picks(sid, branch).length };
  const want = db.all(`SELECT i.pr, i.sha, i.master_order FROM items i JOIN targets t ON t.session_id = i.session_id AND t.pr = i.pr
                        WHERE i.session_id = ? AND t.branch = ? AND t.decision = 'backport' AND t.on_branch = 0 ORDER BY i.master_order`, sid, branch);
  const have = new Map(picks(sid, branch).map((p) => [p.pr, p]));
  const reuse = l.reuse_from ? new Map(picks(sid, l.reuse_from).filter((p) => p.status === 'picked').map((p) => [p.pr, p.picked_sha])) : new Map();
  let added = 0; let removed = 0;
  for (const w of want) {
    if (have.has(w.pr)) continue;
    const src = reuse.get(w.pr);
    db.run(`INSERT INTO picks (session_id, branch, pr, seq, source_sha, status, detail, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      sid, branch, w.pr, w.master_order, src || w.sha, 'pending', db.S({ reused: !!src, master: w.sha }), db.now());
    added++;
  }
  const wanted = new Set(want.map((w) => w.pr));
  for (const p of have.values()) {
    if (wanted.has(p.pr)) continue;
    if (p.status === 'pending' || p.status === 'blocked') { db.run('DELETE FROM picks WHERE session_id = ? AND branch = ? AND pr = ?', sid, branch, p.pr); removed++; }
    else if (COMMITTED.includes(p.status) && !p.detail.unwantedNoted) {
      setPick(sid, branch, p.pr, { detail: { ...p.detail, unwantedNoted: true } });
      db.event(sid, `#${p.pr} is no longer decided "backport" but is already ${p.status}; drop it or keep it under Decisions needed`, { branch, level: 'attention' });
    }
  }
  // Picks added while picking go in at their master position (pickNext rebuilds the lane if needed).
  // After picking finished they wait for a decision: rebuilding restarts verification and CI.
  if (added && ['needs-attention', 'picked'].includes(l.phase)) db.updateLane(sid, branch, { phase: 'picking', attention: null });
  else if (added && POST_PICK.includes(l.phase)) attention(sid, branch, `${added} PR(s) were added after picking finished; decide under Decisions needed how they go in`);
  return { added, removed, total: picks(sid, branch).length };
}

/** Dependencies that are not satisfied in this lane before the given pick. */
export function unmetDeps(sid, branch, pick) {
  const earlier = new Set(picks(sid, branch).filter((p) => ['picked', 'empty'].includes(p.status) && p.pr !== pick.pr).map((p) => p.pr));
  const rows = db.all(`SELECT d.*, t.on_branch, t.decision FROM deps d
       LEFT JOIN targets t ON t.session_id = d.session_id AND t.pr = d.depends_on AND t.branch = ?
       WHERE d.session_id = ? AND d.pr = ? AND (d.branch IS NULL OR d.branch = ?) AND d.status != 'dismissed'`, branch, sid, pick.pr, branch);
  // A dependency that merged after this PR on master and is a pick later in this batch is a follow-up, whichever way
  // the hint points: it goes in after this pick, in master order, and does not block it.
  const later = new Map(picks(sid, branch).filter((p) => ['pending', 'blocked', 'conflict'].includes(p.status) && p.seq > pick.seq).map((p) => [p.pr, p]));
  return rows.filter((d) => !earlier.has(d.depends_on) && !(d.on_branch ?? depOnBranch(sid, branch, d.depends_on)))
    .map((d) => (later.has(d.depends_on) ? { ...d, later: true } : d));
}

/** A blocked pick whose dependencies were since picked, or turned out to follow later in the batch, goes again. */
export function releaseBlocked(sid, branch) {
  const out = [];
  for (const p of picks(sid, branch).filter((x) => x.status === 'blocked')) {
    if (!unmetDeps(sid, branch, p).every((d) => d.later)) continue;
    setPick(sid, branch, p.pr, { status: 'pending', detail: { ...p.detail, unmet: undefined } });
    db.event(sid, `#${p.pr} is no longer blocked: its dependencies are picked or follow it in master order`, { branch });
    out.push(p.pr);
  }
  return out;
}

/** Pick the next pending commit. Returns {status, pr, ...}. */
export function pickNext(sid, branch) {
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch);
  const dir = l.worktree;
  let list = picks(sid, branch);
  // Master commit order is the rule: a pick that belongs before commits already in the lane (a dependency
  // accepted late, a decision changed while backporting) rebuilds the lane from that point, unless the user
  // approved putting it on top.
  const first = list.find((p) => p.status === 'pending');
  if (first && !first.detail.outOfOrder) {
    const later = list.filter((p) => p.seq > first.seq && [...COMMITTED, 'conflict', 'blocked'].includes(p.status));
    if (later.length) {
      const r = rewind(sid, branch, { before: first.seq, reason: `#${first.pr} goes before ${later.map((p) => `#${p.pr}`).join(', ')} in master order` });
      return { status: 'rewound', pr: first.pr, replay: r.replayed };
    }
  }
  const st = g.state(dir);
  if (st.cherryPicking || st.rebasing) return { status: 'in-progress', head: st.head };
  if (st.dirty) { attention(sid, branch, 'The lane worktree has uncommitted changes; commit or discard them before picking continues'); return { status: 'dirty' }; }
  releaseBlocked(sid, branch);
  list = picks(sid, branch);
  const stuck = list.find((p) => ['conflict', 'needs-fix', 'blocked'].includes(p.status));
  if (stuck) { db.updateLane(sid, branch, { phase: 'needs-attention' }); return { status: stuck.status, pr: stuck.pr }; }
  const next = list.find((p) => p.status === 'pending');
  if (!next) {
    db.updateLane(sid, branch, { phase: 'picked', head_sha: st.head, attention: null });
    db.event(sid, `All ${list.filter((p) => p.status === 'picked').length} picks applied; ready for build verification`, { branch });
    return { status: 'done' };
  }
  const detail = { ...next.detail, startHead: st.head };
  // Re-run the dependency analysis against this lane: a dependency may have surfaced only now
  // (a skip decision, a branch-specific gap, or a dependency on another pick of this batch).
  // A replayed pick (the lane was rebuilt) was analysed when it was first picked.
  if (!detail.reused && !detail.replay) {
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
  const hard = unmet.filter((d) => !d.later && (d.source !== 'blame' || !dry.clean));
  if (hard.length) {
    detail.unmet = hard.map((d) => ({ depends_on: d.depends_on, source: d.source, detail: d.detail, decision: d.decision }));
    setPick(sid, branch, next.pr, { status: 'blocked', detail });
    db.updateLane(sid, branch, { phase: 'needs-attention' });
    attention(sid, branch, `#${next.pr} depends on ${hard.map((d) => `#${d.depends_on}`).join(', ')}, which ${hard.length > 1 ? 'are' : 'is'} not on ${branch} or earlier in this batch. Decide in the plan: add the dependency, or dismiss it`);
    return { status: 'blocked', pr: next.pr, unmet: detail.unmet };
  }
  if (unmet.length) detail.warnings = unmet.map((d) => (d.later ? `#${d.depends_on} (${d.detail}) merged after it on master and follows later in this batch`
    : `applies cleanly although it builds on #${d.depends_on} (${d.detail})`));
  // A replayed pick is the lane's earlier commit (resolution included) followed by its fixups.
  const res = g.cherryPick(dir, [next.source_sha, ...(detail.extras || [])], { trailer: !detail.reused && !detail.replay });
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
    queueResolve(sid, branch, next.pr);
    return { status: 'conflict', pr: next.pr, conflicts: res.conflicts, conflictDeps: detail.conflictDeps };
  }
  const check = runCheck(dir, next.detail.master || next.source_sha, st.head);
  detail.check = check;
  const pickedSha = detail.extras?.length ? pickCommit(dir, st.head, next) : res.sha;
  setPick(sid, branch, next.pr, { status: check.ok ? 'picked' : 'needs-fix', picked_sha: pickedSha, detail });
  db.updateLane(sid, branch, { head_sha: res.sha });
  if (!check.ok) {
    db.updateLane(sid, branch, { phase: 'needs-attention' });
    attention(sid, branch, `#${next.pr} applied, but the post-pick check found leftover slog, markers or unguarded debug logging`);
    queueResolve(sid, branch, next.pr);
    return { status: 'needs-fix', pr: next.pr };
  }
  db.event(sid, `#${next.pr} ${detail.replay ? 're-applied' : 'picked'} as ${g.short(pickedSha)}${detail.warnings ? ` (${detail.warnings.length} dependency warning(s))` : ''}`, { branch });
  return { status: 'picked', pr: next.pr, sha: pickedSha, warnings: detail.warnings };
}

/**
 * A conflict (or a failed post-pick check) goes to a Claude resolve job right away, autopilot or not; after two
 * attempts that did not finish it, it waits for the user under Decisions needed. Session config autoResolve=false
 * turns this off.
 */
function queueResolve(sid, branch, pr) {
  if (db.session(sid).config.autoResolve === false) return null;
  const tries = db.get(`SELECT COUNT(*) n FROM jobs WHERE session_id = ? AND branch = ? AND type = 'resolve' AND json_extract(args, '$.pr') = ?
     AND status IN ('failed', 'done', 'cancelled')`, sid, branch, pr).n;
  return tries >= 2 ? null : jobs.enqueue(sid, branch, 'resolve', { pr });
}

const METHOD_RE = /^\s*(?:(?:public|protected|private|static|final|synchronized)\s+)*[\w<>[\],\s]+?\s+(\w+)\s*\([^;]*$/;
/**
 * Step 6 of the pulsar-cherry-pick per-commit loop, worked out for the resolver: the test methods the commit
 * added or modified, per module, as -Dtest values. A change outside any @Test method (setup, helpers, fields)
 * means the whole class. A commit that changes no test falls back to the branch's existing <Class>Test of the
 * classes it changes (the same fallback that skill describes).
 */
export function changedTests(sid, branch, pick) {
  const l = db.lane(sid, branch); const cfg = db.session(sid).config;
  const sha = pick.detail.master || pick.source_sha;
  const git = (args) => g.git(cfg.repo, args, { allowFail: true }).out || '';
  const files = git(['show', '--format=', '--name-only', sha]).split('\n').filter(Boolean);
  const tests = [];
  for (const f of files.filter((x) => g.isTestPath(x) && /\.java$/.test(x))) {
    const src = git(['show', `${sha}:${f}`]).split('\n'); if (src.length < 2) continue;
    if (!src.some((x) => /@Test\b/.test(x))) continue; // a helper or base class, not a test
    const changed = [];
    for (const m of git(['show', '--format=', '-U0', sha, '--', f]).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const from = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = from; i < from + Math.max(n, 1); i++) changed.push(i);
    }
    const methods = new Set(); let whole = false;
    const classAt = src.findIndex((x) => /^\s*(public\s+|final\s+|abstract\s+)*class\s/.test(x));
    for (const ln of changed) {
      // Imports, the header and blank lines select nothing.
      if (ln - 1 <= classAt || /^\s*(import\s|package\s|\/\/|\*|\/\*|$)/.test(src[ln - 1] ?? '')) continue;
      let name = null;
      for (let i = Math.min(ln, src.length) - 1; i >= 0; i--) {
        const mm = src[i].match(METHOD_RE);
        if (mm && !/^\s*(if|for|while|switch|catch|return|new)\b/.test(src[i])) {
          const annotated = src.slice(Math.max(0, i - 6), i).some((x) => /@Test\b/.test(x));
          name = annotated ? mm[1] : null; break;
        }
        if (/^\s*(public\s+|final\s+|abstract\s+)*class\s/.test(src[i])) break;
      }
      if (name) methods.add(name); else whole = true;
    }
    tests.push({ file: f, module: f.split('/src/')[0], cls: f.split('/').pop().replace(/\.java$/, ''), methods: whole ? null : [...methods] });
  }
  let fallback = false;
  if (!tests.length && l.worktree) {
    fallback = true;
    for (const f of files.filter((x) => !g.isTestPath(x) && /\.java$/.test(x)).slice(0, 10)) {
      const c = f.split('/').pop().replace(/\.java$/, '');
      const hit = (g.git(l.worktree, ['ls-files', `*/${c}Test.java`], { allowFail: true }).out || '').split('\n').filter(Boolean)[0];
      if (hit && tests.length < 3) tests.push({ file: hit, module: hit.split('/src/')[0], cls: c + 'Test', methods: null });
    }
  }
  const byModule = {};
  for (const t of tests) (byModule[t.module] ||= []).push(t.methods?.length ? `${t.cls}#${t.methods.join('+')}` : t.cls);
  return { tests, fallback, dtest: Object.fromEntries(Object.entries(byModule).map(([m, v]) => [m, v.join(',')])) };
}

/** The commit of `pick` among from..HEAD (its fixups may follow it). */
function pickCommit(dir, from, pick) {
  const master = pick.detail.master || pick.source_sha;
  for (const c of g.git(dir, ['log', '--format=%H%x1f%B%x1e', `${from}..HEAD`]).split('\x1e')) {
    const [sha, body] = c.trim().split('\x1f');
    if (sha && body && !/^(fixup|squash|amend)! /.test(body) && (body.includes(master) || body.split('\n')[0].includes(`(#${pick.pr})`))) return sha;
  }
  return null;
}

/** The lane's commits from its base, each mapped to its pick (by the cherry-pick trailer, else the PR number). */
function laneCommits(sid, branch) {
  const l = db.lane(sid, branch); const list = picks(sid, branch);
  const byMaster = new Map(list.map((p) => [p.detail.master || p.source_sha, p]));
  const byPr = new Map(list.map((p) => [p.pr, p]));
  const out = [];
  for (const line of g.git(l.worktree, ['log', '--reverse', '--format=%H%x1f%B%x1e', `${l.base_sha}..HEAD`]).split('\x1e')) {
    const [sha, body = ''] = line.trim().split('\x1f'); if (!sha) continue;
    const subject = body.split('\n')[0];
    const fixup = /^(fixup|squash|amend)! /.test(subject);
    const m = body.match(/cherry picked from commit ([0-9a-f]{40})/g);
    const pm = subject.match(g.PR_RE);
    const pick = fixup ? null : (m && byMaster.get(m.at(-1).slice(-40))) || (pm && byPr.get(Number(pm[1]))) || null;
    out.push({ sha, subject, fixup, pick });
  }
  return out;
}

/** Bookkeeping for a test branch that can no longer be fast-forwarded: the next push opens a new round. */
function retireTest(l, reason) {
  if (!l.test_branch) return { ...l.ci, test: undefined, squash: undefined, rebase: undefined };
  return { round: (l.ci.round || 1) + 1, retired: [...(l.ci.retired || []), { branch: l.test_branch, pr: l.test_pr, reason }] };
}

/** Close the test PRs of earlier rounds and delete their branches (test branches only, never a release branch). */
export function closeRetired(sid, branch) {
  const cfg = db.session(sid).config; const l = db.lane(sid, branch);
  const left = [];
  for (const t of l.ci.retired || []) {
    try {
      if (t.pr) gh.closePr(t.pr, `Superseded: ${t.reason || 'the backport batch was rebuilt'}. The rebuilt batch is tested in a new PR.`);
      g.git(cfg.repo, ['push', remote(cfg), '--delete', t.branch], { allowFail: true });
      db.event(sid, `Closed the earlier test PR${t.pr ? ` #${t.pr}` : ''} and deleted ${t.branch}`, { branch });
    } catch (e) { left.push(t); db.event(sid, `Could not close the earlier test PR #${t.pr}: ${e.message}`, { branch, level: 'warn' }); }
  }
  if ((l.ci.retired || []).length) db.updateLane(sid, branch, { ci: { ...l.ci, retired: left } });
}

/**
 * Rebuild the lane from the first commit that has to change: `drop` removes picks, `before` lets a pick that was
 * added late go in at its master position (every pick with a later master position is replayed after it).
 * Replayed picks are re-applied from their lane commits, so conflict resolutions are kept, and fixups ride along
 * with the pick they follow; fixups of a dropped pick go with it. Local only: a pushed test branch cannot be
 * rewritten (no force-push), so it is retired and the next push opens a new test PR.
 */
export function rewind(sid, branch, { drop = [], before = null, reason = '' } = {}) {
  const l = db.lane(sid, branch);
  if (PUSHED.includes(l.phase)) throw new Error(`${branch} is already pushed to the real branch; a change now needs a new commit on top`);
  if (l.phase === 'not-started' || !l.worktree) throw new Error(`the ${branch} lane has not started`);
  const dir = l.worktree;
  let st = g.state(dir);
  if (st.rebasing) throw new Error('a rebase is in progress in the lane worktree; finish or abort it first');
  if (st.cherryPicking) g.git(dir, ['cherry-pick', '--abort'], { allowFail: true });
  st = g.state(dir);
  if (st.dirty) throw new Error('the lane worktree has uncommitted changes; commit or discard them first');
  const dropSet = new Set(drop.map(Number));
  const commits = laneCommits(sid, branch);
  const cut = commits.findIndex((c) => c.pick && (dropSet.has(c.pick.pr) || (before != null && c.pick.seq > before)));
  const replayed = []; const dropped = [];
  if (cut >= 0) {
    const target = (c) => { const ref = c.subject.replace(/^(fixup|squash|amend)! /, ''); return commits.find((x) => x.pick && (x.sha.startsWith(ref) || x.subject === ref)) || null; };
    // Every other commit keeps its place: it rides with the nearest kept pick before it (fixups usually sit at the
    // top of the lane, so they stay last and autosquash moves them later). A fixup of a dropped pick goes with it.
    const groups = []; const orphans = [];
    for (const c of commits.slice(cut)) {
      if (c.pick) { groups.push({ pick: c.pick, shas: [c.sha] }); continue; }
      if (c.fixup && dropSet.has(target(c)?.pick?.pr)) continue;
      const owner = groups.findLast((x) => !dropSet.has(x.pick.pr));
      if (owner) owner.shas.push(c.sha); else orphans.push(c.sha);
    }
    const head0 = st.head;
    g.git(dir, ['reset', '--quiet', '--hard', cut === 0 ? l.base_sha : commits[cut - 1].sha]);
    // Commits with no kept pick before them (a fixup of an earlier pick after only dropped ones) go right back on.
    if (orphans.length) {
      const rr = g.cherryPick(dir, orphans, { trailer: false });
      if (!rr.ok) {
        g.git(dir, ['cherry-pick', '--abort'], { allowFail: true }); g.git(dir, ['reset', '--quiet', '--hard', head0]);
        throw new Error(`cannot rebuild the lane: ${orphans.map(g.short).join(', ')} no longer applies${rr.empty ? ' (empty)' : ''} once ${[...dropSet].map((x) => `#${x}`).join(', ')} is dropped; restored ${g.short(head0)}`);
      }
    }
    for (const { pick: p, shas } of groups) {
      if (dropSet.has(p.pr)) continue;
      const { check, conflicts, conflictDeps, error, unmet, startHead, ...keep } = p.detail;
      setPick(sid, branch, p.pr, { status: 'pending', picked_sha: null, source_sha: shas[0], detail: { ...keep, replay: true, extras: shas.slice(1) } });
      replayed.push(p.pr);
    }
  }
  // Picks that were not committed: a stopped cherry-pick or a blocked pick is tried again.
  for (const p of picks(sid, branch)) {
    if (!['conflict', 'blocked'].includes(p.status) || dropSet.has(p.pr)) continue;
    const { conflicts, conflictDeps, error, unmet, ...keep } = p.detail;
    setPick(sid, branch, p.pr, { status: 'pending', detail: keep });
  }
  for (const pr of dropSet) {
    const p = picks(sid, branch).find((x) => x.pr === pr); if (!p) continue;
    setPick(sid, branch, pr, { status: 'skipped', picked_sha: null, detail: { ...p.detail, reason: reason || 'dropped while backporting', dropped: true } });
    db.run(`UPDATE targets SET decision = 'skip', decision_source = 'user', decision_note = ?, decided_at = ? WHERE session_id = ? AND pr = ? AND branch = ?`,
      `dropped while backporting${reason ? `: ${reason}` : ''}`, db.now(), sid, pr, branch);
    dropped.push(pr);
  }
  const head = g.rev(dir, 'HEAD');
  const rebuilt = cut >= 0;
  db.updateLane(sid, branch, { phase: 'picking', head_sha: head, squashed_sha: null, attention: null,
    ...(rebuilt ? { ci: retireTest(l, reason), test_branch: null, test_pr: null, test_pr_url: null } : {}) });
  db.event(sid, `Lane rebuilt from ${rebuilt ? g.short(commits[cut].sha) : 'its head'}${dropped.length ? `; dropped ${dropped.map((x) => `#${x}`).join(', ')}` : ''}${replayed.length ? `; re-applying ${replayed.map((x) => `#${x}`).join(', ')}` : ''}${reason ? ` (${reason})` : ''}`,
    { branch, level: 'warn' });
  if (rebuilt && l.test_branch) db.event(sid, `${l.test_branch} cannot be fast-forwarded any more; the next test push opens a new PR`, { branch });
  const reusing = db.all(`SELECT branch FROM lanes WHERE session_id = ? AND reuse_from = ? AND phase != 'not-started'`, sid, branch);
  if (rebuilt && reusing.length) db.event(sid, `${reusing.map((x) => x.branch).join(', ')} already reuses the earlier ${branch} commits; reset ${reusing.length > 1 ? 'those lanes' : 'that lane'} to pick up the rebuilt batch`, { branch, level: 'attention' });
  return { dropped, replayed, head };
}

/** Throw away uncommitted tracked changes (a cancelled resolver's partial work); a stopped cherry-pick is aborted later. */
export function discardWorktreeChanges(dir) {
  const st = g.state(dir);
  if (st.dirty && !st.cherryPicking && !st.rebasing) g.git(dir, ['reset', '--quiet', '--hard', 'HEAD']);
}

/** Remove a pick from the lane. A committed pick rebuilds the lane from it; the decision becomes "skip". */
export function dropPick(sid, branch, pr, reason) {
  const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p) throw new Error(`#${pr} is not a pick of ${branch}`);
  if (COMMITTED.includes(p.status)) return rewind(sid, branch, { drop: [pr], reason: reason || `#${pr} dropped` });
  skipPick(sid, branch, pr, reason || 'dropped while backporting');
  return { dropped: [pr], replayed: [] };
}

/** Let a pending pick go on top of the lane although later master commits are already in it. */
export function pickOutOfOrder(sid, branch, pr, reason) {
  const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p || p.status !== 'pending') throw new Error(`#${pr} is not a pending pick of ${branch}`);
  if (!reason) throw new Error('say why it should not go in master order');
  setPick(sid, branch, pr, { detail: { ...p.detail, outOfOrder: reason } });
  db.updateLane(sid, branch, { phase: 'picking', attention: null });
  db.event(sid, `#${pr} goes on top, out of master order: ${reason}`, { branch, level: 'warn' });
}

/** Put the lane's pending picks in at their master position, rebuilding it if later commits are already in. */
export function placeInOrder(sid, branch) {
  const l = db.lane(sid, branch); const list = picks(sid, branch);
  const pending = list.filter((p) => p.status === 'pending' && !p.detail.outOfOrder);
  if (!pending.length) return null;
  const first = Math.min(...pending.map((p) => p.seq));
  if (list.some((p) => p.seq > first && COMMITTED.includes(p.status))) return rewind(sid, branch, { before: first, reason: `${pending.map((p) => `#${p.pr}`).join(', ')} added in master order` });
  if (l.phase !== 'picking') db.updateLane(sid, branch, { phase: 'picking', attention: null });
  return { dropped: [], replayed: [] };
}

/**
 * What keeps a lane past picking from moving on: picks added after picking finished, and committed picks whose
 * decision is no longer "backport". Autopilot waits and finalize refuses while any are open.
 */
export function holds(sid, branch) {
  const l = db.lane(sid, branch); const list = picks(sid, branch); const out = [];
  if (l.phase === 'not-started' || PUSHED.includes(l.phase)) return out;
  const committedMax = Math.max(-Infinity, ...list.filter((p) => COMMITTED.includes(p.status)).map((p) => p.seq));
  if (POST_PICK.includes(l.phase)) for (const p of list.filter((x) => x.status === 'pending')) out.push({ kind: 'added', pr: p.pr, inOrder: p.seq > committedMax });
  const unwanted = db.all(`SELECT p.pr FROM picks p JOIN targets t ON t.session_id = p.session_id AND t.pr = p.pr AND t.branch = p.branch
     WHERE p.session_id = ? AND p.branch = ? AND p.status IN ('picked', 'needs-fix') AND t.decision != 'backport'`, sid, branch);
  for (const u of unwanted) out.push({ kind: 'unwanted', pr: u.pr });
  return out;
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

function runCheck(dir, sha, base = null) {
  const script = checkPickScript();
  if (!script) return { ok: true, skipped: 'check-pick.sh not found' };
  // With a base, only lines added since it count (the pick and its fixups), not code already on the branch.
  const r = spawnSync('bash', [script, sha, ...(base ? [base] : [])], { cwd: dir, encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '').slice(-4000) };
}

export function pickAll(sid, branch, { log = console.log, max = 1000 } = {}) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = pickNext(sid, branch);
    results.push(r);
    log(`${r.status}${r.pr ? ` #${r.pr}` : ''}${r.sha ? ` ${g.short(r.sha)}` : ''}`);
    if (!['picked', 'empty', 'rewound'].includes(r.status)) return { last: r, results };
  }
  return { last: results.at(-1), results };
}

/** After a human or worker resolved a conflict (or fixed a needs-fix pick) and committed. */
export function markResolved(sid, branch, pr, { tests = null, result = null } = {}) {
  const l = db.lane(sid, branch); const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p) throw new Error(`#${pr} is not a pick of ${branch}`);
  const st = g.state(l.worktree);
  if (st.cherryPicking || st.rebasing) throw new Error('a cherry-pick or rebase is still in progress; finish it with git cherry-pick --continue first');
  if (st.dirty) throw new Error('uncommitted changes in the lane worktree');
  const master = p.detail.master || p.source_sha;
  // A replayed pick may be followed by its fixups: the pick's own commit is somewhere after the head it started from.
  const own = p.detail.startHead && p.detail.startHead !== st.head && g.isAncestor(l.worktree, p.detail.startHead, st.head) ? pickCommit(l.worktree, p.detail.startHead, p) : null;
  const msg = g.git(l.worktree, ['log', '-1', '--format=%B', 'HEAD']);
  if (!own && !msg.includes(master) && !msg.includes(`(#${pr})`)) throw new Error(`HEAD ${g.short(st.head)} does not look like the pick of #${pr} (no trailer or PR number)`);
  const check = runCheck(l.worktree, master, own ? p.detail.startHead : null);
  // Leftover slog, conflict markers, unguarded debug or Gradle files on a Maven branch are not a resolution yet.
  if (!check.ok) throw new Error(`check-pick.sh still reports findings for #${pr}; fix them (pulsar-cherry-pick skill: slog → slf4j, Gradle → Maven, guards) and amend, then run this again:\n${(check.output || '').slice(-1500)}`);
  // What validated the resolution: the tests the resolver ran and their outcome (none for a hand resolution without them).
  const validation = tests ? { tests: String(tests).split(',').map((x) => x.trim()).filter(Boolean), result: result || 'not reported', at: db.now() } : null;
  const detail = { ...p.detail, check, resolvedAt: db.now(), validation };
  setPick(sid, branch, pr, { status: 'picked', picked_sha: own || st.head, detail });
  db.updateLane(sid, branch, { head_sha: st.head, phase: 'picking', attention: null });
  db.event(sid, `#${pr} resolved as ${g.short(own || st.head)}${validation ? `; validated with ${validation.tests.length} test(s): ${validation.result}` : '; no tests reported'}`,
    { branch, level: validation ? 'info' : 'warn' });
  return { ok: true, check };
}

export function skipPick(sid, branch, pr, reason) {
  const l = db.lane(sid, branch); const p = picks(sid, branch).find((x) => x.pr === pr);
  if (!p) throw new Error(`#${pr} is not a pick of ${branch}`);
  if (COMMITTED.includes(p.status)) throw new Error(`#${pr} is already committed (${g.short(p.picked_sha)}); drop it instead (the lane is rebuilt from it)`);
  if (l.worktree && p.status === 'conflict' && g.state(l.worktree).cherryPicking) g.git(l.worktree, ['cherry-pick', '--abort']);
  setPick(sid, branch, pr, { status: 'skipped', detail: { ...p.detail, reason } });
  db.run(`UPDATE targets SET decision = 'skip', decision_source = 'user', decision_note = ?, decided_at = ? WHERE session_id = ? AND pr = ? AND branch = ?`,
    `skipped while backporting: ${reason}`, db.now(), sid, pr, branch);
  // Leaving out a PR added after picking finished changes nothing that was built or tested.
  if (!POST_PICK.includes(l.phase) || p.status !== 'pending') db.updateLane(sid, branch, { phase: 'picking', attention: null });
  else if (!holds(sid, branch).length) db.updateLane(sid, branch, { attention: null });
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
  closeRetired(sid, branch);
  const s = db.session(sid); const cfg = s.config; const l = db.lane(sid, branch); const r = remote(cfg);
  const tb = l.test_branch || testBranchName(cfg, sid, branch, l.ci.round || 1);
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
  const extra = [];
  for (const c of laneCommits(sid, branch)) {
    if (c.pick) setPick(sid, branch, c.pick.pr, { picked_sha: c.sha }); else extra.push({ sha: c.sha, subject: c.subject });
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
  const open = holds(sid, branch);
  if (open.length) throw new Error(`decisions are open for ${open.map((x) => `#${x.pr}`).join(', ')}; settle them under Decisions needed first`);
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
export function resetLane(sid, branch, reason = 'the lane was reset') {
  const s = db.session(sid); const l = db.lane(sid, branch);
  if (['final-ci', 'final-ci-failed', 'done'].includes(l.phase)) throw new Error('the lane was already pushed to the real branch');
  if (l.worktree && fs.existsSync(l.worktree)) g.git(s.config.repo, ['worktree', 'remove', '--force', l.worktree], { allowFail: true });
  if (l.local_branch) g.git(s.config.repo, ['branch', '-D', l.local_branch], { allowFail: true });
  db.run('DELETE FROM picks WHERE session_id = ? AND branch = ?', sid, branch);
  // The pushed test branch stays until the next push (or an abort) closes it; the next round gets a new one.
  const { round, retired } = retireTest(l, reason);
  db.updateLane(sid, branch, { phase: 'not-started', worktree: null, local_branch: null, base_sha: null, head_sha: null, squashed_sha: null, attention: null,
    test_branch: null, test_pr: null, test_pr_url: null, ci: { round, retired } });
  db.event(sid, `Lane reset: ${reason}`, { branch, level: 'warn' });
}

/**
 * Abort backporting to revisit the decisions: every lane that has not reached the real branch is reset (jobs
 * cancelled, worktree removed, test PR closed) and the session returns to planning. Start backporting again later.
 */
export function abortBackport(sid, { reason = 'backporting was aborted to revisit the decisions', cancel = () => {} } = {}) {
  db.run(`UPDATE sessions SET status = 'planning', updated_at = ? WHERE id = ?`, db.now(), sid);
  saveConfig(sid, { autopilot: false });
  const out = { reset: [], kept: [] };
  for (const { branch, phase } of db.all('SELECT branch, phase FROM lanes WHERE session_id = ? ORDER BY seq DESC', sid)) {
    if (PUSHED.includes(phase)) { out.kept.push(branch); continue; }
    for (const j of db.all(`SELECT id FROM jobs WHERE session_id = ? AND branch = ? AND status IN ('queued', 'running', 'waiting')`, sid, branch)) cancel(j.id);
    if (phase !== 'not-started') resetLane(sid, branch, reason);
    closeRetired(sid, branch);
    out.reset.push(branch);
  }
  db.event(sid, `Backporting aborted: ${out.reset.length ? `reset ${out.reset.join(', ')}` : 'nothing to reset'}${out.kept.length ? `; ${out.kept.join(', ')} already pushed, kept` : ''}. Revisit the plan and start again`, { level: 'attention' });
  return out;
}

/**
 * The user (or a worker's proposal the user approved) says `pr` needs `dep` on this branch: record it, bring the
 * dependency into the plan if it merged before the range, decide it "backport" and put it in at its master
 * position. A lane past picking is rebuilt right away; that is what the approval was for.
 */
export function addDependency(sid, branch, pr, dep, detail = 'added while backporting') {
  if (pr === dep) throw new Error('a PR cannot depend on itself');
  db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    sid, pr, dep, branch, 'manual', detail, 'backport', db.now());
  const d = db.get(`SELECT id FROM deps WHERE session_id = ? AND pr = ? AND depends_on = ? AND IFNULL(branch, '') = IFNULL(?, '') AND source = 'manual'`, sid, pr, dep, branch);
  const pulled = pullInDependencies(sid);
  if (pulled.missing.includes(dep)) throw new Error(`#${dep} is not a merged master PR`);
  setDep(sid, d.id, 'accepted');
  const t = db.get('SELECT on_branch FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, dep, branch);
  const l = db.lane(sid, branch);
  const rebuilt = POST_PICK.includes(l.phase) ? placeInOrder(sid, branch) : null;
  return { pulledIn: pulled.added, onBranch: !!t?.on_branch, rebuilt };
}

/** Accept recorded dependencies on this lane; one merged before the plan's range joins the plan first. */
export function acceptDeps(sid, branch, ids) {
  for (const id of ids) setDep(sid, id, 'accepted');
  const pulled = pullInDependencies(sid);
  if (pulled.added.length) syncPicks(sid, branch);
  // The picks waiting on these dependencies go back to pending, so the next pick looks at them again.
  for (const id of ids) {
    const d = db.get('SELECT pr FROM deps WHERE id = ?', id);
    if (d) unblock(sid, branch, d.pr);
  }
  const l = db.lane(sid, branch);
  return { pulledIn: pulled.added, rebuilt: POST_PICK.includes(l.phase) ? placeInOrder(sid, branch) : null };
}
