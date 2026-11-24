// Planning: discover master PRs, pre-filter, dry-run, dependency hints, verdict import, decisions, report.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as db from './db.mjs';
import * as g from './git.mjs';
import * as gh from './gh.mjs';

export const DEFAULT_REPO = process.env.BPT_PULSAR_REPO || path.join(os.homedir(), 'workspace-pulsar', 'pulsar');
export const sessionDir = (sid) => path.join(db.BPT_HOME, 'sessions', sid);

export function remote(cfg) { return cfg.remote || g.remoteFor(cfg.repo, gh.REPO); }
export const remoteRef = (cfg, branch) => `${remote(cfg)}/${branch}`;

/** Branch spec "branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2" (the "<" names the lane to reuse). */
export function parseBranches(spec) {
  return spec.split(',').map((s, i) => {
    const m = s.trim().match(/^([^:<]+)(?::([^<]+))?(?:<(.+))?$/);
    if (!m) throw new Error(`bad branch spec ${s}`);
    return { branch: m[1], release: m[2] || null, reuseFrom: m[3] || null, seq: i + 1 };
  });
}

/**
 * scope: which master PRs the plan evaluates —
 *   'both' (default): every PR merged after the since-commit, and PRs labelled for the session's releases merged before it;
 *   'range': only the PRs merged after the since-commit;
 *   'labelled': only PRs labelled for the session's releases (release/<version>), wherever they are on master.
 *   'list': a custom session: only the master PRs and commits the user listed (`list`), decided "backport" for every lane.
 * list: master PRs/commits the user wants backported. With scope 'list' they are the whole plan; with the other scopes
 *   they come on top of it (one merged before the starting point is pulled in), and are decided "backport" as well.
 * after: a previous session; the new one starts after the last master commit that session evaluated.
 * instructions: free text the user gives every Claude worker of the session (and the triage brief).
 */
export const SCOPES = ['both', 'range', 'labelled', 'list'];
/** The id to propose for a new session: "YYYY-mm-dd-backports", then "-2", "-3", ... for more sessions that day. */
export function proposeSessionId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-backports`;
  let id = base; for (let i = 2; db.get('SELECT 1 FROM sessions WHERE id = ?', id); i++) id = `${base}-${i}`;
  return id;
}
export function createSession({ id, title, repo = DEFAULT_REPO, branches, sincePr, sinceSha, source = 'master', remote: remoteName = null, scope = 'both', after = null, list = null, instructions = null }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,60}$/.test(id)) throw new Error('session id: lowercase letters, digits, . _ -');
  if (db.get('SELECT 1 FROM sessions WHERE id = ?', id)) throw new Error(`session ${id} exists`);
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  const refs = parseList(list);
  // Only a list, no starting point: a custom session.
  if (refs.length && !sincePr && !sinceSha && !after) scope = 'list';
  if (scope === 'list' && !refs.length) throw new Error('a custom session needs the master PRs or commits to backport (--list)');
  if (scope === 'list' && (sincePr || sinceSha || after)) throw new Error('a custom session has no starting point: it backports the listed PRs and commits');
  if (after) {
    const n = nextSession(after);
    if (!sinceSha && !sincePr) sinceSha = n.sinceSha;
    if (!branches) branches = parseBranches(n.branches);
    if (!title) title = n.title;
    const pc = db.session(after).config;
    repo = pc.repo || repo; remoteName = remoteName || pc.remote || null; source = pc.source || source;
  }
  if (!branches?.length) throw new Error('need --branches (or --after a previous session)');
  const cfg = { repo, remote: remoteName, source, branches, sincePr: sincePr || null, sinceSha: sinceSha || null, round: 0, scope, after: after || null,
    instructions: String(instructions || '').trim() || null,
    runner: 'headless', autopilot: false, autoPushTest: true, maxClaudeWorkers: 1, maxReruns: 3,
    permissionMode: 'auto', model: null, testBranchPattern: '{branch}-backports-{id}' };
  const r = remote(cfg);
  g.fetch(repo, r, [source]);
  if (scope === 'list') Object.assign(cfg, resolveList(cfg, refs));
  else if (refs.length) cfg.list = resolveList(cfg, refs).list;
  if (!cfg.sinceSha) {
    if (!sincePr) throw new Error('need --since-pr or --since-sha');
    const sha = g.git(repo, ['log', '--first-parent', '--format=%H', `--grep=(#${sincePr})$`, `${r}/${source}`]).split('\n')[0];
    if (!sha) throw new Error(`#${sincePr} not found on ${r}/${source}`);
    cfg.sinceSha = sha;
  }
  const ts = db.now();
  db.tx(() => {
    db.run('INSERT INTO sessions (id, title, status, config, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      id, title || id, 'planning', db.S(cfg), ts, ts);
    for (const b of branches) {
      db.run('INSERT INTO lanes (session_id, branch, release, seq, reuse_from, updated_at) VALUES (?,?,?,?,?,?)',
        id, b.branch, b.release, b.seq, b.reuseFrom, ts);
    }
  });
  if (scope !== 'list' && cfg.list?.length) db.event(id, `Also backporting the listed ${cfg.list.map((x) => `#${x.pr}`).join(', ')}`);
  if (scope === 'list') db.event(id, `Custom session created: ${branches.map((b) => b.branch).join(', ')}, backporting ${cfg.list.map((x) => `#${x.pr}`).join(', ')}${cfg.instructions ? '; with instructions for the workers' : ''}`);
  else db.event(id, `Session created: ${branches.map((b) => b.branch).join(', ')}, ${scope === 'labelled' ? 'PRs labelled for the releases' : `PRs merged after ${g.short(cfg.sinceSha)}${scope === 'both' ? ' and PRs labelled for the releases' : ''}`}${after ? ` (continues ${after})` : ''}`);
  return db.session(id);
}

/** "123, #124 https://github.com/apache/pulsar/pull/125 abcdef1" → ["#123", "#124", "#125", "abcdef1"] (PRs as #N, commits as given). */
export function parseList(list) {
  if (!list) return [];
  const toks = Array.isArray(list) ? list.map(String) : String(list).split(/[\s,;]+/);
  const out = [];
  for (const t0 of toks.map((x) => x.trim()).filter(Boolean)) {
    const t = t0.replace(/[).,]+$/, '');
    const m = t.match(/^(?:#|(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/))?(\d{1,6})(?:\/.*)?$/) ;
    const c = t.match(/^(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/commit\/)?([0-9a-f]{7,40})$/i);
    if (c && !/^\d{1,6}$/.test(t)) out.push(c[1].toLowerCase());
    else if (m) out.push(`#${Number(m[1])}`);
    else throw new Error(`not a PR number or commit hash: ${t0}`);
  }
  return [...new Set(out)];
}

/**
 * The listed refs on the session's master: each one's merged PR and its first-parent commit, and the starting point
 * (the parent of the oldest one) so that discover sees them all. A commit inside a merged PR's branch resolves to the PR.
 */
export function resolveList(cfg, refs) {
  const repo = cfg.repo; const masterRef = `${remote(cfg)}/${cfg.source}`;
  const byPr = (pr) => {
    const hits = g.git(repo, ['log', '--first-parent', '--fixed-strings', `--grep=(#${pr})`, '--format=%H%x1f%s', masterRef], { allowFail: true });
    return (hits.ok ? hits.out : '').split('\n').filter(Boolean).map((l) => l.split('\x1f')).find(([, subj]) => Number(subj.match(g.PR_RE)?.[1]) === pr)?.[0] || null;
  };
  const list = []; const bad = [];
  for (const ref of refs) {
    if (ref.startsWith('#')) {
      const pr = Number(ref.slice(1)); const sha = byPr(pr);
      if (sha) list.push({ ref, pr, sha }); else bad.push(`${ref} is not a PR merged to ${cfg.source}`);
      continue;
    }
    const v = g.git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true });
    if (!v.ok || !v.out) { bad.push(`${ref}: no such commit (fetched ${masterRef})`); continue; }
    if (!g.git(repo, ['merge-base', '--is-ancestor', v.out, masterRef], { allowFail: true }).ok) { bad.push(`${ref} is not on ${cfg.source}`); continue; }
    const subj = g.git(repo, ['log', '-1', '--format=%s', v.out]);
    const pr = Number(subj.match(g.PR_RE)?.[1]) || null;
    const sha = pr && byPr(pr);
    if (!sha) { bad.push(`${ref} (${subj.slice(0, 80)}) is not the commit of a PR merged to ${cfg.source}`); continue; }
    list.push({ ref, pr, sha });
  }
  if (bad.length) throw new Error(bad.join('; '));
  const uniq = [...new Map(list.map((x) => [x.pr, x])).values()];
  const dist = (sha) => Number(g.git(repo, ['rev-list', '--first-parent', '--count', `${sha}..${masterRef}`]));
  const oldest = uniq.reduce((a, x) => (dist(x.sha) > dist(a.sha) ? x : a));
  return { list: uniq, sinceSha: g.git(repo, ['rev-parse', `${oldest.sha}^`]) };
}

/**
 * Add or remove listed PRs/commits; the next discover brings new ones in (and decides them "backport"). A removed one
 * leaves a custom session ("skip"); in a session with a starting point it goes back to the recommendation when it is in
 * the range, and is skipped when it was only in the plan because it was listed.
 */
export function editList(sid, { add = null, remove = null } = {}) {
  const s = db.session(sid); const cfg = s.config; const custom = cfg.scope === 'list';
  const drop = new Set(parseList(remove).map((x) => x.replace(/^#/, '')));
  const picked = (x) => db.get(`SELECT 1 FROM picks WHERE session_id = ? AND pr = ? LIMIT 1`, sid, x.pr);
  const keep = (cfg.list || []).filter((x) => !(drop.has(String(x.pr)) || drop.has(x.ref.replace(/^#/, '')) || [...drop].some((d) => /^[0-9a-f]{7,}$/.test(d) && x.sha.startsWith(d))));
  const removed = (cfg.list || []).filter((x) => !keep.includes(x));
  const busy = removed.filter(picked);
  if (busy.length) throw new Error(`already cherry-picked: ${busy.map((x) => `#${x.pr}`).join(', ')}; drop the pick in its lane instead`);
  const known = new Set(keep.map((x) => x.pr));
  const adds = parseList(add);
  const fresh = adds.length ? resolveList(cfg, adds).list.filter((x) => !known.has(x.pr)) : [];
  const all = [...keep, ...fresh];
  if (custom && !all.length) throw new Error('a custom session needs at least one PR or commit');
  const sinceSha = custom ? resolveList(cfg, all.map((x) => x.ref)).sinceSha : cfg.sinceSha;
  db.tx(() => {
    for (const x of removed) {
      const it = db.get('SELECT stats FROM items WHERE session_id = ? AND pr = ?', sid, x.pr);
      const st = db.J(it?.stats, {});
      if (custom || st.listedOnly) {
        db.run(`UPDATE items SET excluded = 'removed from the list', stats = json_set(stats, '$.include', 0, '$.listed', 0) WHERE session_id = ? AND pr = ?`, sid, x.pr);
        db.run(`UPDATE targets SET decision = 'skip', decision_source = 'user', decision_note = 'removed from the list', decided_at = ? WHERE session_id = ? AND pr = ? AND on_branch = 0`, db.now(), sid, x.pr);
      } else if (it) {
        db.run(`UPDATE items SET stats = json_set(stats, '$.listed', 0) WHERE session_id = ? AND pr = ?`, sid, x.pr);
        db.run(`UPDATE targets SET decision = IFNULL(recommendation, 'undecided'), decision_source = 'recommended', decided_at = NULL
                WHERE session_id = ? AND pr = ? AND on_branch = 0 AND decision_note = 'listed by the user'`, sid, x.pr);
      }
    }
    saveConfig(sid, { list: all, sinceSha });
  });
  if (fresh.length || removed.length) db.event(sid, `Listed PRs: ${fresh.length ? `added ${fresh.map((x) => `#${x.pr}`).join(', ')}` : ''}${fresh.length && removed.length ? '; ' : ''}${removed.length ? `removed ${removed.map((x) => `#${x.pr}`).join(', ')}` : ''}`);
  return { list: all, added: fresh.map((x) => x.pr), removed: removed.map((x) => x.pr) };
}

/** The instructions every Claude worker of the session gets (null clears them). */
export function setInstructions(sid, text) {
  const t = String(text ?? '').trim() || null;
  saveConfig(sid, { instructions: t });
  db.event(sid, t ? 'Session instructions for the workers updated' : 'Session instructions cleared');
  return t;
}

const bump = (v) => { const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/); return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v; };

/**
 * What a session that continues `prev` starts from: the last master commit `prev` evaluated (master's head at its last
 * discover, else its latest PR), its branches, and each release bumped to the next patch once its tag exists (a
 * release that is not out yet stays: the new session adds to it). Returns {after, sinceSha, sinceTitle, branches, title, released}.
 */
export function nextSession(prev) {
  const s = db.session(prev); const cfg = s.config; const repo = cfg.repo; const r = remote(cfg);
  const resolve = (x) => x && g.git(repo, ['rev-parse', '--verify', '-q', `${x}^{commit}`], { allowFail: true });
  let sha = null;
  for (const x of [cfg.masterHeadSha, cfg.masterHead]) { const t = resolve(x); if (t?.ok) { sha = t.out; break; } }
  if (!sha) sha = db.get('SELECT sha FROM items WHERE session_id = ? ORDER BY master_order DESC LIMIT 1', prev)?.sha || null;
  if (!sha) throw new Error(`session ${prev} has evaluated no master commits yet (run discover first)`);
  const lanes = db.all('SELECT branch, release, reuse_from FROM lanes WHERE session_id = ? ORDER BY seq', prev);
  const released = {};
  for (const l of lanes) {
    if (!l.release) continue;
    const tag = `v${l.release}`;
    let ok = g.git(repo, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`], { allowFail: true }).ok;
    if (!ok) ok = !!g.git(repo, ['ls-remote', '--tags', r, `refs/tags/${tag}`], { allowFail: true }).out;
    released[l.branch] = ok;
  }
  const next = lanes.map((l) => ({ ...l, release: l.release && released[l.branch] ? bump(l.release) : l.release }));
  const branches = next.map((l) => `${l.branch}${l.release ? `:${l.release}` : ''}${l.reuse_from ? `<${l.reuse_from}` : ''}`).join(',');
  const rel = next.map((l) => l.release).filter(Boolean);
  return { after: prev, sinceSha: sha, sinceTitle: g.git(repo, ['log', '-1', '--format=%s', sha]), branches, released,
    title: rel.length ? `Backports for ${rel.join(' and ')}` : `Backports after ${prev}` };
}

// --- archive and delete ---

/** Archived sessions are hidden from the session list and read-only until unarchived. Nothing may be running. */
export function archiveSession(sid, archived = true, reason = null) {
  const s = db.session(sid);
  if (archived) {
    if (s.config.archived) return false;
    const active = db.get(`SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND status IN ('queued','running','waiting')`, sid).n;
    if (active) throw new Error(`session ${sid} has ${active} active job(s); cancel them or wait before archiving`);
    saveConfig(sid, { archived: { at: db.now(), reason: reason || null }, autopilot: false });
    db.event(sid, `Session archived${reason ? `: ${reason}` : ''}. It is read-only and hidden from the session list`, { level: 'warn' });
  } else {
    if (!s.config.archived) return false;
    saveConfig(sid, { archived: null });
    db.event(sid, 'Session unarchived');
  }
  return true;
}

/** Why a session cannot be deleted ([] when it can): only a session that never started backporting. */
export function deleteBlockers(sid) {
  const s = db.session(sid); const why = [];
  if (s.status !== 'planning') why.push(`it is ${s.status}`);
  const started = db.all(`SELECT branch, phase FROM lanes WHERE session_id = ? AND (phase != 'not-started' OR worktree IS NOT NULL OR test_branch IS NOT NULL OR final_sha IS NOT NULL)`, sid);
  if (started.length) why.push(`lanes started: ${started.map((l) => `${l.branch} (${l.phase})`).join(', ')}`);
  if (db.get('SELECT 1 FROM picks WHERE session_id = ? LIMIT 1', sid)) why.push('it has cherry-picks');
  if (db.get('SELECT 1 FROM ci_runs WHERE session_id = ? LIMIT 1', sid)) why.push('it has CI runs');
  const active = db.get(`SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND status IN ('queued','running','waiting')`, sid).n;
  if (active) why.push(`${active} job(s) active`);
  const posted = db.all(`SELECT pr FROM items WHERE session_id = ? AND json_extract(comment_state, '$.status') = 'posted'`, sid);
  if (posted.length) why.push(`PR comments were posted: ${posted.map((x) => `#${x.pr}`).join(', ')}`);
  return why;
}

/** Delete a session that never started backporting: its rows, job logs and session directory. Archive the others. */
export function deleteSession(sid) {
  db.session(sid);
  const why = deleteBlockers(sid);
  if (why.length) throw new Error(`session ${sid} cannot be deleted (${why.join('; ')}); archive it instead`);
  const logs = db.all('SELECT log_path FROM jobs WHERE session_id = ? AND log_path IS NOT NULL', sid).map((j) => j.log_path);
  db.tx(() => {
    for (const t of ['ci_runs', 'analysis', 'events', 'jobs', 'picks', 'deps', 'targets', 'items', 'lanes']) db.run(`DELETE FROM ${t} WHERE session_id = ?`, sid);
    db.run('DELETE FROM sessions WHERE id = ?', sid);
  });
  const dir = sessionDir(sid);
  for (const f of logs) { try { if (!path.resolve(f).startsWith(path.resolve(dir) + path.sep)) fs.rmSync(f, { force: true }); } catch {} }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function saveConfig(sid, patch) {
  const s = db.session(sid);
  const cfg = { ...s.config, ...patch };
  db.run('UPDATE sessions SET config = ?, updated_at = ? WHERE id = ?', db.S(cfg), db.now(), sid);
  return cfg;
}

// --- pre-filter: what gets evaluated at all ---
const TYPE_RE = /^\s*\[([a-z]+)\]\s*\[([a-z0-9-]+)\]/i;
export function classify(title) {
  const m = title.match(TYPE_RE);
  const type = m?.[1]?.toLowerCase(); const comp = m?.[2]?.toLowerCase();
  if (!type) return { excluded: 'no [type][component] prefix', kind: 'code', comp: '' };
  const kind = comp === 'test' ? 'flaky' : 'code';
  if (type === 'fix') {
    if (comp === 'ci' || comp === 'build') return { excluded: `[fix][${comp}]`, kind, comp };
    return { excluded: null, kind, comp };
  }
  if (type === 'improve') {
    if (['test', 'ci', 'build', 'pip', 'doc'].includes(comp)) return { excluded: `[improve][${comp}]`, kind, comp };
    return { excluded: null, kind, comp };
  }
  return { excluded: `[${type}]`, kind, comp };
}

/**
 * Refresh the session's PR list from master. Keeps decisions and verdicts; records new PRs with a new round number,
 * updates branch presence, labels and dry runs, and computes blame-based dependency hints.
 */
export function discover(sid, { log = console.log, blame = true } = {}) {
  const s = db.session(sid); const cfg = s.config; const repo = cfg.repo; const r = remote(cfg);
  const branches = db.all('SELECT * FROM lanes WHERE session_id = ? ORDER BY seq', sid).map((l) => l.branch);
  log(`fetching ${r}: ${cfg.source} ${branches.join(' ')}`);
  g.fetch(repo, r, [cfg.source, ...branches]);
  const masterRef = `${r}/${cfg.source}`;
  const scope = cfg.scope || 'both';
  const allCommits = g.firstParentCommits(repo, cfg.sinceSha, masterRef).filter((c) => c.pr);
  // A custom session: only the listed PRs (the range starts at the oldest one; the rest of it is not part of the plan).
  const custom = scope === 'list';
  const listed = cfg.list?.length || custom ? new Set((cfg.list || []).map((x) => x.pr)) : null;
  const position = new Map(allCommits.map((c, i) => [c.pr, i]));
  const onBranch = Object.fromEntries(branches.map((b) => [b, g.pickedOnBranch(repo, `${r}/${b}`, masterRef)]));
  const known = new Map(db.all('SELECT pr, round FROM items WHERE session_id = ?', sid).map((x) => [x.pr, x.round]));
  const round = (cfg.round || 0) + 1;
  log(`${allCommits.length} PRs on ${cfg.source} after ${g.short(cfg.sinceSha)}; fetching labels and descriptions`);
  const meta = gh.prMeta((custom ? allCommits.filter((c) => listed.has(c.pr) || known.has(c.pr)) : allCommits).map((c) => c.pr));
  const releaseLabels = sessionReleaseLabels(sid);
  // 'labelled': only the PRs labelled for the session's releases (and the ones already in the plan stay).
  const commits = custom ? allCommits.filter((c) => listed.has(c.pr) || (known.has(c.pr) && !db.J(db.get('SELECT stats FROM items WHERE session_id = ? AND pr = ?', sid, c.pr)?.stats, {}).listed))
    : scope !== 'labelled' ? allCommits : allCommits.filter((c) => known.has(c.pr)
    || releaseLabels.some((x) => (meta.get(c.pr)?.labels || []).includes(x)));
  const bodies = path.join(sessionDir(sid), 'prbody');
  fs.mkdirSync(bodies, { recursive: true });
  const heads = Object.fromEntries(branches.map((b) => [b, g.rev(repo, `${r}/${b}`)]));
  const order = position;
  log('matching branch-specific commits (patch-id, references, titles, upgrades, labels)');
  const equivs = Object.fromEntries(branches.map((b) => [b, findEquivalents(cfg, `${r}/${b}`, masterRef, commits, meta, onBranch[b], b)]));
  const shaToPr = new Map(allCommits.map((c) => [c.sha, c.pr]));
  let added = 0; let dry = 0;
  const newlyPicked = [];
  for (const [i, c] of commits.entries()) {
    const m = meta.get(c.pr) || { labels: [], body: '' };
    const at = position.get(c.pr);
    if (m.body) fs.writeFileSync(path.join(bodies, `${c.pr}.md`), m.body);
    const isNew = !known.has(c.pr);
    const cls = upsertCommit(sid, { repo, branches, onBranch, equivs, heads, newlyPicked, releaseLabels }, c, at, m, isNew ? round : known.get(c.pr),
      listed?.has(c.pr) ? { listed: 1, include: 1 } : {});
    if (isNew) added++;
    dry += cls.dry;
    if (blame && !cls.excluded && branches.some((b) => !(onBranch[b].prs.has(c.pr) || onBranch[b].shas.has(c.sha)))) {
      const st = db.J(db.get('SELECT stats FROM items WHERE session_id = ? AND pr = ?', sid, c.pr).stats, {});
      if (!st.blamed) {
        blameDeps(sid, repo, c, { shaToPr, order, onBranch, branches });
        db.run(`UPDATE items SET stats = json_set(stats, '$.blamed', 1) WHERE session_id = ? AND pr = ?`, sid, c.pr);
      }
    }
    if (i % 50 === 49) log(`  ${i + 1}/${commits.length}`);
  }
  // Listed PRs merged before the starting point join like a labelled PR (never in a custom session: it starts at the oldest).
  const before = listed && !custom ? [...listed].filter((pr) => !commits.some((c) => c.pr === pr)) : [];
  const listedIn = before.length ? importPrs(sid, new Map(before.map((pr) => [pr, []])), { log,
    reasonFor: () => 'listed by the user', statsFor: () => ({ listed: 1, listedOnly: 1 }) }) : { added: [], missing: [] };
  // Listed by the user: backport it to every lane where it is not yet (a decision the user changed stays).
  for (const pr of listed || []) {
    db.run(`UPDATE targets SET decision = 'backport', decision_source = 'user', decision_note = 'listed by the user', decided_at = ?
            WHERE session_id = ? AND pr = ? AND on_branch = 0 AND decision_source != 'user'`, db.now(), sid, pr);
  }
  const missingListed = listed ? [...listed].filter((pr) => !db.get('SELECT 1 FROM items WHERE session_id = ? AND pr = ?', sid, pr)) : [];
  const labelled = scope === 'range' || custom ? { added: [], missing: [], failed: [] } : pullInLabelled(sid, new Set(allCommits.map((c) => c.pr)), { log });
  const pulled = pullInDependencies(sid, { log, refresh: true });
  const carried = carryOverSkips(sid, { log });
  const headSha = g.rev(repo, masterRef);
  saveConfig(sid, { round, lastDiscover: db.now(), masterHead: g.short(headSha), masterHeadSha: headSha,
    heads: Object.fromEntries(branches.map((b) => [b, g.short(heads[b])])) });
  const summary = { round, scope, total: commits.length, onMaster: allCommits.length, added, dryRuns: dry, newlyPicked, pulledIn: pulled.added, depsNotOnMaster: pulled.missing,
    labelledPulledIn: labelled.added, labelledLeftOut: labelled.dropped || [], labelledNotOnMaster: labelled.missing, labelSearchFailed: labelled.failed, carriedSkips: carried, ...(listed ? { listed: listed.size, listedPulledIn: listedIn.added, listedNotFound: missingListed } : {}) };
  db.event(sid, `Discover round ${round}: ${commits.length} PRs, ${added} new, ${newlyPicked.length} newly on a branch`
    + `${labelled.added.length ? `, ${labelled.added.length} release-labelled PR(s) from before the range` : ''}`, { data: summary });
  return summary;
}

/**
 * Skips decided by the user in an earlier session carry over: a PR that is still not on a branch (e.g. a 4.2-only fix
 * labelled for both releases, skipped for branch-4.0) would otherwise be pulled into every new session again. The
 * latest earlier user decision for the PR and branch counts; when it is "skip", the target is decided "skip" here too,
 * unless this session already has a user decision or the user listed the PR. A row whose open targets are all decided
 * this way is marked reviewed, so it stays in the plan ("All items") but not in the review list. Off with
 * config carrySkips: false. Returns the PRs carried over.
 */
export function carryOverSkips(sid, { log = () => {} } = {}) {
  if (db.session(sid).config.carrySkips === false) return [];
  const rows = db.all(`SELECT t.pr, t.branch, (
        SELECT json_object('sid', p.session_id, 'decision', p.decision, 'note', p.decision_note) FROM targets p JOIN sessions ps ON ps.id = p.session_id
        WHERE p.pr = t.pr AND p.branch = t.branch AND p.session_id != t.session_id AND p.decision_source = 'user' AND p.decision IN ('skip', 'backport')
          AND ps.rowid < (SELECT rowid FROM sessions WHERE id = t.session_id)
        ORDER BY ps.rowid DESC LIMIT 1) prev
      FROM targets t JOIN items i ON i.session_id = t.session_id AND i.pr = t.pr
      WHERE t.session_id = ? AND t.on_branch = 0 AND t.decision_source != 'user' AND i.excluded IS NULL
        AND COALESCE(json_extract(i.stats, '$.listed'), 0) != 1`, sid);
  const carried = new Set(); const ts = db.now();
  db.tx(() => {
    for (const r of rows) {
      const p = db.J(r.prev);
      if (p?.decision !== 'skip') continue;
      const note = `skipped in session ${p.sid}${p.note && !/^skipped in session /.test(p.note) ? `: ${p.note}` : ''}`;
      db.run(`UPDATE targets SET decision = 'skip', decision_source = 'user', decision_note = ?, decided_at = ? WHERE session_id = ? AND pr = ? AND branch = ?`,
        note.slice(0, 300), ts, sid, r.pr, r.branch);
      carried.add(r.pr);
    }
    for (const pr of carried) {
      const open = db.get(`SELECT COUNT(*) n FROM targets WHERE session_id = ? AND pr = ? AND on_branch = 0 AND decision_source != 'user'`, sid, pr).n;
      if (!open) db.run('UPDATE items SET reviewed_at = COALESCE(reviewed_at, ?) WHERE session_id = ? AND pr = ?', ts, sid, pr);
    }
  });
  const list = [...carried].sort((a, b) => a - b);
  if (list.length) {
    log(`${list.length} PR(s) keep the skip decided in an earlier session`);
    db.event(sid, `Kept the skip decided in an earlier session for ${list.length} PR(s): ${list.map((x) => `#${x}`).join(', ')}`);
  }
  return list;
}

/** The release labels of the session's lanes ("release/4.2.6", ...). */
export function sessionReleaseLabels(sid) {
  return db.all('SELECT release FROM lanes WHERE session_id = ? AND release IS NOT NULL ORDER BY seq', sid).map((l) => `release/${l.release}`);
}

/**
 * Master PRs labelled for one of the session's releases that were merged before the plan's range (someone tagged
 * them for the release and they have not been picked, or they reached the branch through a branch-specific PR).
 * They join the plan like a pulled-in dependency, are never pre-filtered, and are refreshed on every discover.
 * Returns {added, missing, failed}.
 */
export function pullInLabelled(sid, inRange, { log = () => {} } = {}) {
  const cfg = db.session(sid).config;
  const want = new Map(); const failed = [];
  for (const label of sessionReleaseLabels(sid)) {
    const list = gh.mergedPrsWithLabel(label, { base: cfg.source });
    if (!list) { failed.push(label); log(`searching PRs labelled ${label} failed; labelled PRs before the range are not refreshed`); continue; }
    for (const p of list) if (!inRange.has(p.number)) (want.get(p.number) || want.set(p.number, []).get(p.number)).push(label);
  }
  // Cherry-picked (same PR on the branch) to every lane it is labelled for, with the labels set: not imported at all.
  const lanes = db.all('SELECT branch, release FROM lanes WHERE session_id = ? AND release IS NOT NULL', sid);
  const lanesOf = (pr) => lanes.filter((l) => want.get(pr).includes(`release/${l.release}`));
  const fresh = [...want.keys()].filter((pr) => lanesOf(pr).length && !db.get('SELECT 1 FROM items WHERE session_id = ? AND pr = ?', sid, pr));
  if (fresh.length) {
    const r0 = remote(cfg); const masterRef = `${r0}/${cfg.source}`; const on = {};
    const onB = (b) => (on[b] ||= g.pickedOnBranch(cfg.repo, `${r0}/${b}`, masterRef));
    const cands = fresh.filter((pr) => lanesOf(pr).every((l) => onB(l.branch).prs.has(pr)));
    const meta = cands.length ? gh.prMeta(cands) : new Map();
    for (const pr of cands) {
      const labels = meta.get(pr)?.labels || [];
      if (lanesOf(pr).every((l) => labels.includes(`cherry-picked/${l.branch}`))) want.delete(pr);
    }
  }
  const r = importPrs(sid, new Map([...want.keys()].map((pr) => [pr, []])), { log,
    reasonFor: (pr) => `labelled ${want.get(pr).join(', ')}`, statsFor: (pr) => ({ labelledIn: want.get(pr) }) });
  const dropped = dropBackportedLabelled(sid, { log });
  return { ...r, added: r.added.filter((pr) => !dropped.includes(pr)), dropped, failed };
}

/**
 * A release-labelled PR from before the range is done when it is on the branch of every lane it is labelled for
 * (release/4.2.6 only and cherry-picked to branch-4.2: that it is not on branch-4.0 is no question for this plan), and
 * it already has its cherry-picked/<branch> labels. It leaves the plan, unless the user listed it, a dependency
 * needs it, or it was picked here. Returns the PRs dropped.
 */
function dropBackportedLabelled(sid, { log = () => {} } = {}) {
  const lanes = db.all('SELECT branch, release FROM lanes WHERE session_id = ? AND release IS NOT NULL', sid);
  const items = db.all(`SELECT pr, labels, stats FROM items WHERE session_id = ? AND master_order < 0 AND json_extract(stats, '$.labelledIn') IS NOT NULL
                        AND json_extract(stats, '$.listed') IS NULL AND json_extract(stats, '$.pulledIn') IS NULL`, sid);
  const out = [];
  for (const it of items) {
    const labelledIn = db.J(it.stats, {}).labelledIn || []; const labels = db.J(it.labels, []);
    const mine = lanes.filter((l) => labelledIn.includes(`release/${l.release}`));
    if (!mine.length) continue;
    const done = mine.every((l) => {
      const t = db.get('SELECT on_branch, equiv FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, it.pr, l.branch);
      if (!t?.on_branch) return false;
      const e = t.on_branch === 2 ? db.J(t.equiv) : null;
      return labels.includes(`cherry-picked/${l.branch}`) || (e && !LABELLING_EQUIV.includes(e.via));
    });
    if (!done) continue;
    if (db.get('SELECT 1 FROM picks WHERE session_id = ? AND pr = ?', sid, it.pr)) continue;
    if (db.get(`SELECT 1 FROM deps WHERE session_id = ? AND depends_on = ? AND status != 'dismissed' AND (source != 'blame' OR status = 'accepted')`, sid, it.pr)) continue;
    db.tx(() => { for (const t of ['analysis', 'deps', 'targets', 'items']) db.run(`DELETE FROM ${t} WHERE session_id = ? AND pr = ?`, sid, it.pr); });
    out.push(it.pr);
  }
  if (out.length) {
    log(`${out.length} labelled PR(s) already on the branches they are labelled for: not in the plan`);
    db.event(sid, `Left out ${out.length} release-labelled PR(s) already on every branch they are labelled for: ${out.map((x) => `#${x}`).join(', ')}`);
  }
  return out;
}

/**
 * One master commit into the plan: the item (pre-filter class, labels, file stats) and a target per branch
 * (on the branch, an equivalent branch commit, or a dry-run cherry-pick). Returns the class plus the dry-run count.
 */
function upsertCommit(sid, ctx, c, order, m, round, extraStats = {}) {
  const { repo, branches, onBranch, equivs, heads, newlyPicked, releaseLabels = [] } = ctx;
  const cls = classify(c.title);
  // Someone labelled it for one of the session's releases: it is evaluated whatever its title says.
  const labelled = releaseLabels.filter((x) => (m.labels || []).includes(x));
  if (labelled.length) cls.excluded = null;
  const stats = g.commitFiles(repo, c.sha);
  db.run(`INSERT INTO items (session_id, pr, sha, master_order, title, merged_at, kind, excluded, labels, stats, round)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (session_id, pr) DO UPDATE SET sha = excluded.sha, master_order = excluded.master_order,
            title = excluded.title, labels = excluded.labels, merged_at = excluded.merged_at, kind = excluded.kind,
            stats = json_patch(items.stats, excluded.stats),
            excluded = CASE json_extract(items.stats, '$.include') WHEN 1 THEN NULL WHEN 0 THEN 'manual exclude' ELSE excluded.excluded END`,
    sid, c.pr, c.sha, order, c.title, m.mergedAt || c.date, cls.kind, extraStats.include === 1 ? null : cls.excluded, db.S(m.labels),
    db.S({ comp: cls.comp, files: stats.files.length, main: stats.main.length, add: stats.add, del: stats.del, releaseLabels: labelled, ...extraStats }), round);
  let dry = 0;
  for (const b of branches) {
    let on = onBranch[b].prs.has(c.pr) || onBranch[b].shas.has(c.sha) ? 1 : 0;
    const prev = db.get('SELECT on_branch, dryrun, equiv FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, c.pr, b);
    let equiv = null;
    const e = !on && equivs[b].get(c.pr);
    if (e) {
      const was = db.J(prev?.equiv);
      if (was?.rejected && was.commit === e.commit) equiv = was; // the user said it is not the same change
      else { equiv = e; on = 2; }
    }
    if (prev && !prev.on_branch && on) newlyPicked.push(`#${c.pr} → ${b}${on === 2 ? ' (equivalent)' : ''}`);
    let dryrun = prev?.dryrun ?? null;
    const item = db.get('SELECT excluded FROM items WHERE session_id = ? AND pr = ?', sid, c.pr);
    if (!on && !item.excluded) {
      const d = g.dryPick(repo, heads[b], c.sha);
      dryrun = db.S({ state: g.dryState(d), head: g.short(heads[b]), conflicts: d.conflicts.map((x) => ({ file: x.file.split('/').pop(), path: x.file, test: x.test, hunks: x.hunks })) });
      dry++;
    }
    db.run(`INSERT INTO targets (session_id, pr, branch, on_branch, dryrun, equiv) VALUES (?,?,?,?,?,?)
            ON CONFLICT (session_id, pr, branch) DO UPDATE SET on_branch = excluded.on_branch, dryrun = excluded.dryrun, equiv = excluded.equiv`,
      sid, c.pr, b, on, dryrun, equiv ? db.S(equiv) : null);
  }
  return { ...cls, dry };
}

/**
 * Dependencies that point outside the plan: a PR merged on master before the plan's first PR is not an item, so
 * it could never join a dependency group or be picked. Pull such PRs in (in master order, before the range) when a
 * dependency that counts for grouping names them — evaluator, follow-up, manual, conflict or an accepted hint — for a
 * PR that may still go in (a manual or accepted dependency always counts), and they are merged on master. An accepted dependency also marks them "backport". Works on the refs already fetched.
 */
export function pullInDependencies(sid, { log = () => {}, refresh = false } = {}) {
  const s = db.session(sid); const cfg = s.config; const repo = cfg.repo; const r = remote(cfg);
  const masterRef = `${r}/${cfg.source}`;
  const edges = db.all(`SELECT d.* FROM deps d WHERE d.session_id = ? AND d.status != 'dismissed' AND (d.source != 'blame' OR d.status = 'accepted')
                        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.session_id = d.session_id AND i.pr = d.depends_on
                                        AND NOT (? = 1 AND json_extract(i.stats, '$.pulledIn') IS NOT NULL))`, sid, refresh ? 1 : 0);
  // A hint for a PR that is skipped everywhere (or already on every branch) does not need its dependency.
  const needed = (e) => e.source === 'manual' || e.status === 'accepted'
    || !!db.get(`SELECT 1 FROM targets WHERE session_id = ? AND pr = ? AND (? IS NULL OR branch = ?) AND on_branch = 0 AND decision != 'skip'`, sid, e.pr, e.branch, e.branch);
  const want = new Map(); for (const e of edges.filter(needed)) (want.get(e.depends_on) || want.set(e.depends_on, []).get(e.depends_on)).push(e);
  return importPrs(sid, want, { log });
}

/**
 * Bring master PRs that are not items yet into the plan (merged before the plan's range), e.g. a follow-up fix
 * backported on top of a pushed batch. Returns {added, missing} (missing: not a merged master PR).
 */
export function addPrs(sid, prs, { reason, log = () => {} } = {}) {
  return importPrs(sid, new Map(prs.map((pr) => [pr, []])), { log, reason });
}

/** want: Map<pr, dependency edges that need it> (empty: added for `reason`). */
function importPrs(sid, want, { log = () => {}, reason = null, reasonFor = () => reason, statsFor = null } = {}) {
  const s = db.session(sid); const cfg = s.config; const repo = cfg.repo; const r = remote(cfg);
  const masterRef = `${r}/${cfg.source}`;
  const out = { added: [], missing: [] };
  if (!want.size) return out;
  const branches = db.all('SELECT * FROM lanes WHERE session_id = ? ORDER BY seq', sid).map((l) => l.branch);
  const onBranch = Object.fromEntries(branches.map((b) => [b, g.pickedOnBranch(repo, `${r}/${b}`, masterRef)]));
  const heads = Object.fromEntries(branches.map((b) => [b, g.rev(repo, `${r}/${b}`)]));
  const meta = gh.prMeta([...want.keys()]);
  const newlyPicked = [];
  const found = [];
  for (const [pr, es] of want) {
    const hits = g.git(repo, ['log', '--first-parent', '--fixed-strings', `--grep=(#${pr})`, '--format=%H%x1f%s%x1f%cI', masterRef], { allowFail: true });
    const c = (hits.ok ? hits.out : '').split('\n').filter(Boolean).map((l) => { const [sha, subject, date] = l.split('\x1f'); const mm = subject.match(g.PR_RE); return { sha, subject, date, pr: mm ? Number(mm[1]) : null, title: subject.replace(g.PR_RE, '').trim() }; })
      .find((x) => x.pr === pr);
    if (c) found.push([c, es]); else out.missing.push(pr);
  }
  if (!found.length) return out;
  const equivs = Object.fromEntries(branches.map((b) => [b, findEquivalents(cfg, `${r}/${b}`, masterRef, found.map(([c]) => c), meta, onBranch[b], b, { patchIds: false })]));
  for (const [c, es] of found) {
    const pr = c.pr;
    // Before the range: order by distance from the plan's first commit, so picks keep master order.
    const order = -Number(g.git(repo, ['rev-list', '--first-parent', '--count', `${c.sha}..${cfg.sinceSha}`]));
    const via = [...new Set(es.map((e) => e.pr))];
    const isNew = !db.get('SELECT 1 FROM items WHERE session_id = ? AND pr = ?', sid, pr);
    upsertCommit(sid, { repo, branches, onBranch, equivs, heads, newlyPicked, releaseLabels: sessionReleaseLabels(sid) }, c, order, meta.get(pr) || { labels: [] }, cfg.round || 1,
      statsFor ? { ...statsFor(pr), include: 1 } : { pulledIn: via, include: 1 });   // named as a dependency or labelled: never pre-filtered out
    if (!isNew) continue;   // refreshed (branch presence, dry runs); decided and announced when it came in
    for (const e of es.filter((x) => x.status === 'accepted')) {
      db.run(`UPDATE targets SET decision = 'backport', decision_source = 'user', decision_note = COALESCE(decision_note, ?), decided_at = ?
              WHERE session_id = ? AND pr = ? AND (? IS NULL OR branch = ?) AND on_branch = 0`, `dependency of #${e.pr}`, db.now(), sid, pr, e.branch, e.branch);
    }
    out.added.push(pr);
    const why = via.length ? `needed as a dependency of ${via.map((x) => `#${x}`).join(', ')}` : reasonFor(pr) || 'added by the user';
    db.event(sid, `#${pr} added to the plan: merged before the plan's range, ${why}`);
    log(`pulled in #${pr} (${why})`);
  }
  if (out.added.length) db.touchSession(sid);
  return out;
}

/**
 * Branch commits that carry a master PR's change under another PR (branch-specific PRs such as
 * "[improve][meta][branch-4.2] Upgrade Oxia Java client to 0.10.4 (#27227)"). Strongest signal first:
 * identical patch-id, an explicit reference to the master PR or commit, the same normalized title,
 * a newer upgrade of the same dependency, or a cherry-picked/<branch> label on the master PR.
 * Returns Map<masterPr, {via, commit, subject, branchPr, detail}>.
 */
export function findEquivalents(cfg, branchRef, masterRef, commits, meta, onB, branch, { patchIds = true } = {}) {
  const repo = cfg.repo;
  const out = new Map();
  const todo = commits.filter((c) => !(onB.prs.has(c.pr) || onB.shas.has(c.sha)));
  if (!todo.length) return out;
  const mb = onB.mergeBase;
  const masterPrs = new Set(commits.map((c) => c.pr));
  const bcommits = g.commitsWithBodies(repo, `${mb}..${branchRef}`)
    .filter((b) => !b.pr || !masterPrs.has(b.pr) || /\[branch-/.test(b.subject));
  const hit = (pr, via, b, detail) => { if (!out.has(pr)) out.set(pr, { via, commit: b.sha, subject: b.subject, branchPr: b.pr, detail }); };
  // 1. patch-id (skipped for a single pulled-in commit: it reads every diff on the branch, minutes on an old branch)
  if (patchIds) {
  const mPid = new Map([...g.patchIds(repo, `${cfg.sinceSha}..${masterRef}`, { firstParent: true })].map(([pid, sha]) => [sha, pid]));
  const bPid = g.patchIds(repo, `${mb}..${branchRef}`);
  for (const c of todo) { const pid = mPid.get(c.sha); const bsha = pid && bPid.get(pid); const b = bsha && bcommits.find((x) => x.sha === bsha);
    if (b) hit(c.pr, 'patch-id', b, 'identical diff'); }
  }
  // 2. explicit references in branch commit messages and in the branch PRs' descriptions
  const cutoff = Date.parse(g.git(repo, ['log', '-1', '--format=%cI', cfg.sinceSha])) - 45 * 864e5;
  // Branch commits near the plan's range, and everything since the branch's previous release (a branch-specific PR
  // for a release-labelled master PR merged long before the range is in this release's cycle).
  const cycle = releaseCycle(cfg, branch);
  const recent = bcommits.filter((b) => Date.parse(b.date) >= cutoff || cycle?.commits.has(b.sha));
  const branchPrBodies = gh.prMeta([...new Set(recent.map((b) => b.pr).filter((p) => p && !masterPrs.has(p)))]);
  for (const b of recent) {
    const text = `${b.body}
${branchPrBodies.get(b.pr)?.body || ''}`;
    for (const c of todo) {
      if (out.has(c.pr)) continue;
      const re = new RegExp(`(#|pull/)${c.pr}(?!\\d)|${c.sha.slice(0, 10)}`);
      if (re.test(text)) hit(c.pr, 'reference', b, `the branch commit or its PR mentions #${c.pr}`);
    }
  }
  // 3. same title
  const byTitle = new Map(); for (const b of bcommits) { const t = g.normalizeTitle(b.subject); if (t.length >= 12 && !byTitle.has(t)) byTitle.set(t, b); }
  for (const c of todo) { const b = byTitle.get(g.normalizeTitle(c.title)); if (b) hit(c.pr, 'title', b, 'same title'); }
  // 4. a newer upgrade of the same dependency
  const ups = bcommits.map((b) => ({ b, u: g.parseUpgrade(b.subject) })).filter((x) => x.u);
  for (const c of todo) {
    const u = g.parseUpgrade(c.title); if (!u) continue;
    const newer = ups.filter((x) => x.u.name === u.name && g.cmpVersion(x.u.version, u.version) >= 0)
      .sort((x, y) => g.cmpVersion(y.u.version, x.u.version))[0];
    if (newer) hit(c.pr, 'upgrade', newer.b, `${u.name} is at ${newer.u.version.join('.')} on the branch (master PR: ${u.version.join('.')})`);
  }
  // 5. label set by whoever cherry-picked it
  for (const c of todo) {
    if ((meta.get(c.pr)?.labels || []).includes(`cherry-picked/${branch}`)) {
      hit(c.pr, 'label', { sha: null, subject: null, pr: null }, `labelled cherry-picked/${branch}, but no matching commit was found`);
    }
  }
  return out;
}

/**
 * What reached a branch since its previous release: release 4.2.6 → the commits in v4.2.5..<remote>/branch-4.2.
 * Returns {tag, prs (master PR numbers in subjects), shas (cherry-picked-from master shas), commits (branch shas)}, or
 * null when the release is x.y.0 or the tag cannot be found (fetched once when missing). Cached per process.
 */
const cycleCache = new Map();
export function releaseCycle(cfg, branch) {
  const release = (cfg.branches || []).find((b) => b.branch === branch)?.release;
  const m = release?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m || Number(m[3]) === 0) return null;
  const tag = `v${m[1]}.${m[2]}.${Number(m[3]) - 1}`; const ref = remoteRef(cfg, branch);
  const key = `${cfg.repo}|${tag}|${ref}|${g.git(cfg.repo, ['rev-parse', '--verify', '-q', ref], { allowFail: true }).out}`;
  if (cycleCache.has(key)) return cycleCache.get(key);
  const has = () => g.git(cfg.repo, ['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`], { allowFail: true }).ok;
  if (!has()) g.git(cfg.repo, ['fetch', '--quiet', '--no-tags', remote(cfg), `+refs/tags/${tag}:refs/tags/${tag}`], { allowFail: true });
  let out = null;
  if (has()) {
    const list = g.commitsWithBodies(cfg.repo, `refs/tags/${tag}..${ref}`);
    const prs = new Set(); const shas = new Set();
    for (const c of list) {
      if (/^Revert\b/.test(c.subject)) continue;
      for (const x of c.subject.matchAll(/\(#(\d+)\)/g)) prs.add(Number(x[1]));
      for (const x of c.body.matchAll(/cherry picked from commit ([0-9a-f]{40})/g)) shas.add(x[1]);
    }
    out = { tag, prs, shas, commits: new Set(list.map((c) => c.sha)) };
  }
  cycleCache.set(key, out);
  return out;
}

/** The user says a detected equivalent is not the same change (or takes that back). */
export function rejectEquivalent(sid, pr, branch, rejected = true) {
  const t = db.get('SELECT equiv FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, pr, branch);
  const e = db.J(t?.equiv); if (!e) throw new Error(`#${pr} has no detected equivalent on ${branch}`);
  db.run('UPDATE targets SET equiv = ?, on_branch = ? WHERE session_id = ? AND pr = ? AND branch = ?', db.S({ ...e, rejected }), rejected ? 0 : 2, sid, pr, branch);
  db.event(sid, `#${pr}: ${rejected ? 'not' : 'confirmed as'} the same change as ${e.subject || e.via} on ${branch}`, { branch });
}

/** Record in-range master commits that a PR's changed lines were written on top of. */
export function blameDeps(sid, repo, c, { shaToPr, order, onBranch, branches }, phase = 'plan') {
  const hits = g.blameDependencies(repo, c.sha);
  const found = [];
  for (const h of hits) {
    const dep = shaToPr.get(h.sha);
    if (!dep || dep === c.pr || order.get(dep) >= order.get(c.pr)) continue;
    for (const b of branches) {
      if (onBranch[b].prs.has(dep) || onBranch[b].shas.has(h.sha)) continue;
      const detail = `${h.lines} changed line(s) in ${[...h.files].map((f) => f.split('/').pop()).join(', ')} were last changed by #${dep}`;
      const r = db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at)
                        VALUES (?,?,?,?,?,?,?,?)`, sid, c.pr, dep, b, 'blame', detail, phase, db.now());
      if (r.changes) found.push({ dep, branch: b, detail });
    }
  }
  return found;
}

// --- verdicts from triage ---

const depCache = new Map();
/** A dependency is met on a branch if its PR is on the branch, whether or not it is in the session's range. */
export function depOnBranch(sid, branch, dep) {
  const t = db.get('SELECT on_branch FROM targets WHERE session_id = ? AND pr = ? AND branch = ?', sid, dep, branch);
  if (t) return !!t.on_branch;
  const key = `${sid}|${branch}|${dep}`;
  if (!depCache.has(key)) {
    const cfg = db.session(sid).config; const r = remote(cfg);
    depCache.set(key, g.prOnBranch(cfg.repo, `${r}/${branch}`, `${r}/${cfg.source}`, dep));
  }
  return depCache.get(key);
}

const LEGACY = { 42: 'branch-4.2', 40: 'branch-4.0', 41: 'branch-4.1', 50: 'branch-5.0', 30: 'branch-3.0' };
/** Accepts the triage brief's format ({branches:{name:{verdict,...}}}) and the older verdict42/verdict40 keys. */
export function importVerdicts(sid, file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const lanes = new Set(db.all('SELECT branch FROM lanes WHERE session_id = ?', sid).map((l) => l.branch));
  let n = 0; const unknown = [];
  db.tx(() => {
    for (const v of list) {
      const pr = Number(v.pr);
      if (!db.get('SELECT 1 FROM items WHERE session_id = ? AND pr = ?', sid, pr)) { unknown.push(pr); continue; }
      const per = { ...(v.branches || {}) };
      for (const [suffix, branch] of Object.entries(LEGACY)) {
        if (v[`verdict${suffix}`]) {
          per[branch] = { verdict: v[`verdict${suffix}`], bug: v[`bug${suffix}`], evidence: v[`evidence${suffix}`], adapt: v[`adapt${suffix}`], ...(per[branch] || {}) };
        }
      }
      const prev = db.J(db.get('SELECT assessment FROM items WHERE session_id = ? AND pr = ?', sid, pr).assessment, {}) || {};
      const userValue = prev.valueSource === 'user';
      // Merge: a partial file (e.g. values only) keeps the other fields.
      const assessment = { impact: v.impact ?? prev.impact, severity: v.severity ?? prev.severity, risk: v.risk ?? prev.risk,
        riskNote: v.riskNote ?? prev.riskNote, reason: v.reason ?? prev.reason,
        dependsOn: v.dependsOn ?? prev.dependsOn ?? [], followUps: v.followUps ?? prev.followUps ?? [], lean: v.lean ?? prev.lean ?? null,
        // Value for Pulsar users/operators of having the fix on the branch; a user-set value is kept.
        value: userValue ? prev.value : (v.value || prev.value || null),
        valueNote: userValue ? prev.valueNote : (v.valueNote || prev.valueNote || null),
        valueSource: userValue ? 'user' : (v.value ? 'evaluator' : prev.valueSource || null) };
      db.run('UPDATE items SET assessment = ? WHERE session_id = ? AND pr = ?', db.S(assessment), sid, pr);
      for (const [branch, t] of Object.entries(per)) {
        if (!lanes.has(branch)) continue;
        const lean = t.lean ?? v.lean ?? null;
        const rec = recommend(t.verdict, lean);
        db.run(`UPDATE targets SET verdict = ?, bug = ?, evidence = ?, adapt = ?, note = COALESCE(?, note), lean = COALESCE(?, lean),
                  recommendation = ?,
                  decision = CASE WHEN decision_source = 'user' OR on_branch = 1 THEN decision ELSE ? END,
                  decision_source = CASE WHEN decision_source = 'user' OR on_branch = 1 THEN decision_source ELSE 'recommended' END
                WHERE session_id = ? AND pr = ? AND branch = ?`,
          t.verdict, t.bug ?? null, t.evidence ?? null, t.adapt ?? null, t.note ?? v.note ?? null, lean, rec, rec, sid, pr, branch);
        // A follow-up that fixes or adjusts this PR goes with it.
        for (const fu of v.followUps || []) {
          if (!db.get('SELECT 1 FROM items WHERE session_id = ? AND pr = ?', sid, Number(fu))) continue;
          db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, created_at)
                  VALUES (?,?,?,?,?,?,?)`, sid, Number(fu), pr, branch, 'followup', `follow-up of #${pr} named by the evaluator`, db.now());
        }
        for (const dep of v.dependsOn || []) {
          if (depOnBranch(sid, branch, Number(dep))) continue;
          db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, created_at)
                  VALUES (?,?,?,?,?,?,?)`, sid, pr, Number(dep), branch, 'evaluator', 'named by the evaluator', db.now());
        }
      }
      n++;
    }
  });
  db.event(sid, `Imported ${n} verdicts from ${path.basename(file)}${unknown.length ? `; ${unknown.length} unknown PRs ignored` : ''}`);
  return { imported: n, unknown };
}

/** Write triage batches (PRs without a verdict) and the brief for the evaluator subagents. */
export function exportTriage(sid, { size = 25, all = false, briefTemplate } = {}) {
  const dir = path.join(sessionDir(sid), 'triage', `round-${db.session(sid).config.round}`);
  fs.mkdirSync(path.join(dir, 'verdicts'), { recursive: true });
  const lanes = db.all('SELECT branch FROM lanes WHERE session_id = ? ORDER BY seq', sid).map((l) => l.branch);
  const items = db.all(`SELECT * FROM items i WHERE session_id = ? AND excluded IS NULL
     AND EXISTS (SELECT 1 FROM targets t WHERE t.session_id = i.session_id AND t.pr = i.pr AND t.on_branch = 0 ${all ? '' : 'AND t.verdict IS NULL'})
     ORDER BY master_order`, sid);
  const groups = {};
  for (const it of items) {
    const st = db.J(it.stats, {});
    const key = it.kind === 'flaky' ? 'flaky' : ['broker'].includes(st.comp) ? 'broker'
      : ['client', 'admin', 'cli', 'proxy', 'sec', 'txn', 'misc', 'common', 'websocket'].includes(st.comp) ? 'client' : 'other';
    (groups[key] ||= []).push(it);
  }
  const batches = [];
  for (const [key, list] of Object.entries(groups)) {
    for (let i = 0; i < list.length; i += size) {
      const name = `${key}${Math.floor(i / size) + 1}`;
      const lines = list.slice(i, i + size).map((it) => {
        const st = db.J(it.stats, {});
        const t = Object.fromEntries(db.all('SELECT branch, dryrun FROM targets WHERE session_id = ? AND pr = ?', sid, it.pr).map((x) => [x.branch, db.J(x.dryrun, {})]));
        const conf = lanes.map((b) => { const d = t[b] || {}; return `${b}=${d.state || '-'}${d.state === 'main' ? `(${d.conflicts.filter((c) => !c.test).map((c) => c.file).join(',')})` : ''}`; }).join(' ');
        const labels = db.J(it.labels, []).filter((l) => /^(release|cherry-picked)\//.test(l)).join(',') || '-';
        return [it.pr, g.short(it.sha), `+${st.add}-${st.del}`, st.main, conf, labels, it.title].join('\t');
      });
      const f = path.join(dir, `batch_${name}.txt`);
      fs.writeFileSync(f, lines.join('\n') + '\n');
      batches.push({ name, file: f, out: path.join(dir, 'verdicts', `${name}.json`), count: lines.length });
    }
  }
  if (briefTemplate) {
    const s = db.session(sid);
    const brief = fs.readFileSync(briefTemplate, 'utf8')
      .replaceAll('{{REPO}}', s.config.repo).replaceAll('{{REMOTE}}', remote(s.config))
      .replaceAll('{{SOURCE}}', s.config.source).replaceAll('{{SINCE}}', s.config.sinceSha)
      .replaceAll('{{BRANCHES}}', lanes.join(', ')).replaceAll('{{PRBODY}}', path.join(sessionDir(sid), 'prbody'))
      .replaceAll('{{BRANCH_KEYS}}', lanes.map((b) => `"${b}":{"bug":"yes|no|partial|n/a","evidence":"...","adapt":"...","verdict":"pick|maybe|skip|already"}`).join(','));
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), brief);
  }
  return { dir, brief: path.join(dir, 'BRIEF.md'), batches, total: items.length };
}

// --- decisions ---

export const DECISIONS = ['undecided', 'backport', 'skip', 'defer'];

/** The decision a verdict and lean suggest. */
export function recommend(verdict, lean) {
  if (verdict === 'pick') return 'backport';
  if (verdict === 'skip' || verdict === 'already') return 'skip';
  if (verdict === 'maybe') {
    const l = (lean || '').toLowerCase();
    if (l.startsWith('take')) return 'backport';
    if (l.startsWith('your call')) return 'undecided';
    return 'skip';
  }
  return 'undecided';
}

/**
 * Dependency groups per branch: PRs joined by evaluator, follow-up, manual or conflict dependencies, or by accepted
 * blame hints (open blame hints are too noisy to group by). Dismissed edges and PRs already on the branch don't join.
 * Returns Map<branch, Map<pr, Set<pr>>> where every member maps to the same set.
 */
export function dependencyGroups(sid) {
  const out = new Map();
  const lanes = db.all('SELECT branch FROM lanes WHERE session_id = ?', sid).map((l) => l.branch);
  const live = new Map(lanes.map((b) => [b, new Set(db.all('SELECT pr FROM targets WHERE session_id = ? AND branch = ? AND on_branch = 0', sid, b).map((t) => t.pr))]));
  const edges = db.all(`SELECT pr, depends_on, branch FROM deps WHERE session_id = ? AND status != 'dismissed'
                        AND (source != 'blame' OR status = 'accepted')`, sid);
  for (const b of lanes) {
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
    for (const e of edges) {
      if (e.branch && e.branch !== b) continue;
      if (!live.get(b).has(e.pr) || !live.get(b).has(e.depends_on)) continue;
      add(e.pr); add(e.depends_on); parent.set(find(e.pr), find(e.depends_on));
    }
    const sets = new Map(); const m = new Map();
    for (const x of parent.keys()) { const r = find(x); if (!sets.has(r)) sets.set(r, new Set()); sets.get(r).add(x); }
    for (const set of sets.values()) for (const x of set) m.set(x, set);
    out.set(b, m);
  }
  return out;
}

/**
 * Set decisions made by the user. Only the given PRs change unless group is set: then the whole dependency group of
 * each PR on that branch gets the same decision. Returns the [{pr, branch}] that changed, including group members.
 */
export function setDecisions(sid, list, { group = false } = {}) {
  const groups = group ? dependencyGroups(sid) : null;
  const changed = [];
  db.tx(() => {
    for (const d of list) {
      if (!DECISIONS.includes(d.decision)) throw new Error(`decision must be one of ${DECISIONS.join(', ')}`);
      const members = groups?.get(d.branch)?.get(Number(d.pr)) || new Set([Number(d.pr)]);
      for (const pr of members) {
        const note = pr === Number(d.pr) ? (d.note ?? null) : `set with its dependency group (via #${d.pr})`;
        const r = db.run(`UPDATE targets SET decision = ?, decision_source = 'user', decision_note = COALESCE(?, decision_note), decided_at = ?
                          WHERE session_id = ? AND pr = ? AND branch = ? AND on_branch = 0`, d.decision, note, db.now(), sid, pr, d.branch);
        if (!r.changes && pr === Number(d.pr)) throw new Error(`no target #${pr} ${d.branch} (or it is already on the branch)`);
        if (r.changes) changed.push({ pr, branch: d.branch, decision: d.decision, viaGroup: pr !== Number(d.pr) });
      }
    }
  });
  const extra = changed.filter((c) => c.viaGroup);
  if (extra.length) db.event(sid, `Group decision: ${extra.map((c) => `#${c.pr}`).join(', ')} set to ${extra[0].decision} with ${[...new Set(list.map((d) => `#${d.pr}`))].join(', ')}`, { branch: extra[0].branch });
  db.touchSession(sid);
  return changed;
}
export function setDecision(sid, pr, branch, decision, note, opts) { return setDecisions(sid, [{ pr, branch, decision, note }], opts); }

export const VALUES = ['high', 'medium', 'low'];
/** Set a PR's value for users/operators by hand. */
export function setValue(sid, pr, value, note) {
  if (value && !VALUES.includes(value)) throw new Error(`value must be one of ${VALUES.join(', ')}`);
  const row = db.get('SELECT assessment FROM items WHERE session_id = ? AND pr = ?', sid, pr);
  if (!row) throw new Error(`no PR #${pr} in ${sid}`);
  const a = db.J(row.assessment, {}) || {};
  Object.assign(a, { value: value || null, valueSource: 'user' }); if (note !== undefined) a.valueNote = note;
  db.run('UPDATE items SET assessment = ? WHERE session_id = ? AND pr = ?', db.S(a), sid, pr);
}

/** Groups for the plan list: the union of every branch's dependency groups. Map<pr, number[]> (members sorted). */
export function displayGroups(sid, groups = dependencyGroups(sid)) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const m of groups.values()) for (const [pr, set] of m) {
    if (!parent.has(pr)) parent.set(pr, pr);
    for (const o of set) { if (!parent.has(o)) parent.set(o, o); parent.set(find(pr), find(o)); }
  }
  const sets = new Map();
  for (const x of parent.keys()) { const r = find(x); (sets.get(r) || sets.set(r, []).get(r)).push(x); }
  const out = new Map();
  for (const list of sets.values()) { list.sort((a, b) => a - b); for (const x of list) out.set(x, list); }
  return out;
}

/**
 * Mark rows reviewed: the current decisions become the user's (a recommendation is accepted as is) and the rows
 * leave the review list. A dependency group is always reviewed as one. reviewed=false puts them back.
 */
export function setReviewed(sid, prs, reviewed = true) {
  const groups = displayGroups(sid);
  const all = new Set(); for (const p of prs) for (const x of groups.get(Number(p)) || [Number(p)]) all.add(x);
  db.tx(() => {
    for (const pr of all) {
      db.run('UPDATE items SET reviewed_at = ? WHERE session_id = ? AND pr = ?', reviewed ? db.now() : null, sid, pr);
      if (reviewed) db.run(`UPDATE targets SET decision_source = 'user', decided_at = COALESCE(decided_at, ?)
                            WHERE session_id = ? AND pr = ? AND on_branch = 0`, db.now(), sid, pr);
    }
  });
  db.event(sid, `${reviewed ? 'Reviewed' : 'Back in review'}: ${[...all].map((p) => `#${p}`).join(', ')}`);
  return [...all];
}

// --- comments posted after the backport ---

/** Queue (or clear, with an empty text) a comment that is posted on the PR once every lane is done. */
export function setComment(sid, pr, text) {
  const row = db.get('SELECT comment_state FROM items WHERE session_id = ? AND pr = ?', sid, pr);
  if (!row) throw new Error(`no PR #${pr} in ${sid}`);
  if (db.J(row.comment_state)?.status === 'posted') throw new Error(`the comment on #${pr} was already posted`);
  const t = (text || '').trim();
  db.run('UPDATE items SET comment = ?, comment_state = ? WHERE session_id = ? AND pr = ?',
    t || null, t ? db.S({ status: 'pending' }) : null, sid, pr);
  db.event(sid, t ? `Comment queued for #${pr}` : `Comment for #${pr} removed`);
}

/** The suggested text for a PR that is skipped because it needs its own backport. */
export function separateBackportText(sid, pr) {
  const lanes = db.all(`SELECT t.branch FROM targets t JOIN lanes l ON l.session_id = t.session_id AND l.branch = t.branch
                        WHERE t.session_id = ? AND t.pr = ? AND t.on_branch = 0 AND t.decision != 'backport' ORDER BY l.seq`, sid, pr).map((x) => x.branch);
  return `This PR would need to be separately backported to ${lanes.join(' & ') || 'the release branches'}.`;
}

/**
 * Mark a backport session finished: every lane done, nothing running or queued, every queued PR comment posted.
 * From then on the session is read-only (db.assertEditable); `reopenSession` is the CLI-only way back.
 */
export function finishSession(sid, reason) {
  const s = db.session(sid);
  if (s.status === 'finished') return false;
  const lanes = db.all('SELECT branch, phase FROM lanes WHERE session_id = ?', sid);
  const notDone = lanes.filter((l) => l.phase !== 'done').map((l) => `${l.branch} (${l.phase})`);
  const active = db.get(`SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND status IN ('queued','running','waiting')`, sid).n;
  const comments = pendingComments(sid);
  const why = [!lanes.length ? 'it has no lanes' : null, notDone.length ? `not done: ${notDone.join(', ')}` : null,
    active ? `${active} job(s) active` : null, comments.length ? `PR comments not posted: ${comments.map((c) => `#${c.pr}`).join(', ')}` : null].filter(Boolean);
  if (why.length) throw new Error(`session ${sid} cannot be finished: ${why.join('; ')}`);
  db.run(`UPDATE sessions SET status = 'finished', updated_at = ? WHERE id = ?`, db.now(), sid);
  db.event(sid, `Session finished${reason ? `: ${reason}` : ''}. It is read-only now; its reports can still be viewed, downloaded and published as gists`, { level: 'attention' });
  return true;
}

/** The escape hatch (CLI only): a finished session becomes editable again, e.g. to correct a lane on top. */
export function reopenSession(sid, reason) {
  if (!reason) throw new Error('reopening a finished session needs --reason');
  const s = db.session(sid);
  if (s.status !== 'finished') throw new Error(`session ${sid} is ${s.status}, not finished`);
  db.run(`UPDATE sessions SET status = 'backporting', updated_at = ? WHERE id = ?`, db.now(), sid);
  saveConfig(sid, { autopilot: false });
  db.event(sid, `Session reopened: ${reason}. Autopilot is off; turn it on to let it finish the session again`, { level: 'warn' });
}

export function pendingComments(sid) {
  return db.all(`SELECT pr, comment, comment_state FROM items WHERE session_id = ? AND comment IS NOT NULL ORDER BY master_order`, sid)
    .map((r) => ({ pr: r.pr, comment: r.comment, state: db.J(r.comment_state, {}) }))
    .filter((r) => r.state.status !== 'posted');
}

/** Post the queued comments (pending and previously failed). Each one is posted at most once. */
export function postComments(sid, { log = console.log } = {}) {
  const res = { posted: 0, failed: 0 };
  for (const c of pendingComments(sid)) {
    try {
      const url = gh.comment(c.pr, c.comment);
      db.run('UPDATE items SET comment_state = ? WHERE session_id = ? AND pr = ?', db.S({ status: 'posted', url: url.trim(), postedAt: db.now() }), sid, c.pr);
      db.event(sid, `Comment posted on #${c.pr}`, { data: { url } }); log(`#${c.pr} ${url}`); res.posted++;
    } catch (e) {
      db.run('UPDATE items SET comment_state = ? WHERE session_id = ? AND pr = ?', db.S({ status: 'failed', error: e.message.slice(0, 500), at: db.now() }), sid, c.pr);
      db.event(sid, `Comment on #${c.pr} failed: ${e.message}`, { level: 'error' }); res.failed++;
    }
  }
  return res;
}

/** Put decisions back to the recommendation; your own decisions stay unless all is set. */
export function applyRecommendations(sid, { branch = null, all = false } = {}) {
  const r = db.run(`UPDATE targets SET decision = IFNULL(recommendation, 'undecided'), decision_source = 'recommended', decided_at = NULL
     WHERE session_id = ? AND on_branch = 0 ${all ? '' : "AND decision_source != 'user'"} ${branch ? 'AND branch = ?' : ''}`,
  ...[sid, ...(branch ? [branch] : [])]);
  db.event(sid, `Recommendations applied to ${r.changes} PR/branch decisions${all ? ' (including your own)' : ''}`);
  return { changed: r.changes };
}

/** The full plan as plain objects, for the UI and the report. */
export function planView(sid) {
  const lanes = db.all('SELECT branch, release FROM lanes WHERE session_id = ? ORDER BY seq', sid);
  const items = db.all('SELECT * FROM items WHERE session_id = ? ORDER BY master_order', sid);
  const targets = db.all('SELECT * FROM targets WHERE session_id = ?', sid);
  const deps = db.all('SELECT * FROM deps WHERE session_id = ? ORDER BY id', sid);
  const tmap = new Map(); for (const t of targets) tmap.set(`${t.pr}|${t.branch}`, { ...t, dryrun: db.J(t.dryrun), equiv: db.J(t.equiv) });
  const dmap = new Map(); for (const d of deps) (dmap.get(d.pr) || dmap.set(d.pr, []).get(d.pr)).push(d);
  const groups = dependencyGroups(sid);
  const shown = displayGroups(sid, groups);
  return {
    lanes,
    items: items.map((it) => ({
      ...it, labels: db.J(it.labels, []), stats: db.J(it.stats, {}), assessment: db.J(it.assessment), comment_state: db.J(it.comment_state),
      targets: Object.fromEntries(lanes.map((l) => [l.branch, tmap.get(`${it.pr}|${l.branch}`) || null])),
      deps: dmap.get(it.pr) || [],
      groups: Object.fromEntries(lanes.map((l) => [l.branch, [...(groups.get(l.branch)?.get(it.pr) || [])].sort((a, b) => a - b)])),
      group: shown.get(it.pr) || null,
    })),
  };
}

// Equivalents that say the master PR's change is on the branch: not a newer upgrade of the same dependency (a
// different change) and not the label itself (nothing to add).
const LABELLING_EQUIV = ['patch-id', 'reference', 'title'];

/**
 * Label changes on the master PRs:
 * - kind 'decision': release labels implied by the decisions (added for backport, removed for skip);
 * - kind 'on-branch': a master PR whose change is already on the branch, cherry-picked or through a branch-specific
 *   PR, gets cherry-picked/<branch> when it is missing, and release/<release> when it reached the branch after the
 *   branch's previous release tag, so it shows up in the release notes.
 * Returns {add: [{pr, label, kind, why}], remove, cycles: {branch: previous tag | null}}.
 */
export function labelPlan(sid) {
  const cfg = db.session(sid).config;
  const { lanes, items } = planView(sid);
  const add = []; const remove = []; const cycles = {};
  for (const l of lanes) cycles[l.branch] = l.release ? releaseCycle(cfg, l.branch) : null;
  for (const it of items) {
    for (const l of lanes) {
      const t = it.targets[l.branch]; if (!t) continue;
      const label = l.release ? `release/${l.release}` : null; const has = (x) => it.labels.includes(x);
      if (!t.on_branch) {
        if (!label) continue;
        if (t.decision === 'backport' && !has(label)) add.push({ pr: it.pr, label, kind: 'decision', why: `decided backport to ${l.branch}` });
        if (t.decision === 'skip' && has(label)) remove.push({ pr: it.pr, label, kind: 'decision', why: `decided skip for ${l.branch}` });
        continue;
      }
      const e = t.on_branch === 2 ? t.equiv : null;
      if (e && (e.rejected || !LABELLING_EQUIV.includes(e.via))) continue;
      const via = e ? `${e.subject || e.commit} (${e.via})` : 'cherry-picked';
      const picked = `cherry-picked/${l.branch}`;
      if (!has(picked)) add.push({ pr: it.pr, label: picked, kind: 'on-branch', why: `on ${l.branch}: ${via}` });
      const cyc = cycles[l.branch];
      const inCycle = cyc && (e ? cyc.commits.has(e.commit) : cyc.prs.has(it.pr) || cyc.shas.has(it.sha));
      if (label && inCycle && !has(label)) add.push({ pr: it.pr, label, kind: 'on-branch', why: `on ${l.branch} since ${cyc.tag}: ${via}` });
    }
  }
  return { add, remove, cycles: Object.fromEntries(Object.entries(cycles).map(([b, c]) => [b, c?.tag || null])) };
}

export function applyLabels(sid, { removals = false } = {}) {
  const { add, remove } = labelPlan(sid);
  const by = new Map();
  for (const a of add) (by.get(a.pr) || by.set(a.pr, { add: [], remove: [] }).get(a.pr)).add.push(a.label);
  if (removals) for (const r of remove) (by.get(r.pr) || by.set(r.pr, { add: [], remove: [] }).get(r.pr)).remove.push(r.label);
  for (const [pr, ch] of by) {
    gh.editLabels(pr, ch);
    const it = db.get('SELECT labels FROM items WHERE session_id = ? AND pr = ?', sid, pr);
    const labels = new Set(db.J(it.labels, [])); ch.add.forEach((l) => labels.add(l)); ch.remove.forEach((l) => labels.delete(l));
    db.run('UPDATE items SET labels = ? WHERE session_id = ? AND pr = ?', db.S([...labels]), sid, pr);
  }
  db.event(sid, `Labels applied: ${add.length} added${removals ? `, ${remove.length} removed` : ''}`);
  return { added: add.length, removed: removals ? remove.length : 0 };
}

// --- markdown report ---
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const link = (p) => `[#${p}](https://github.com/${gh.REPO}/pull/${p})`;
const strip = (t) => t.replace(/^(\[[^\]]*\]\s*)+/, '');
export function report(sid) {
  const s = db.session(sid); const { lanes, items } = planView(sid);
  const scoped = items.filter((it) => !it.excluded && lanes.some((l) => it.targets[l.branch] && !it.targets[l.branch].on_branch));
  const w = []; const cols = lanes.map((l) => l.branch);
  w.push(`# ${s.title}\n`);
  w.push(`PRs merged to \`${s.config.source}\` after \`${g.short(s.config.sinceSha)}\`${s.config.masterHead ? ` up to \`${s.config.masterHead}\`` : ''}. Branch heads: ${cols.map((b) => `\`${b}\` ${s.config.heads?.[b] || ''}`).join(', ')}. Generated ${db.now().slice(0, 10)} from session \`${sid}\`.\n`);
  for (const l of lanes) {
    const c = (d) => scoped.filter((it) => it.targets[l.branch]?.decision === d).length;
    const v = (d) => scoped.filter((it) => it.targets[l.branch]?.verdict === d).length;
    w.push(`- **${l.branch}${l.release ? ` (${l.release})` : ''}:** verdicts ${v('pick')} pick, ${v('maybe')} maybe, ${v('skip')} skip; decisions ${c('backport')} backport, ${c('skip')} skip, ${c('defer')} defer, ${c('undecided')} undecided.`);
  }
  const sev = { high: 0, medium: 1, low: 2 };
  const section = (title, filter) => {
    const rows = scoped.filter(filter).sort((a, b) => (sev[a.assessment?.severity] ?? 3) - (sev[b.assessment?.severity] ?? 3) || a.master_order - b.master_order);
    if (!rows.length) return;
    w.push(`\n## ${title}\n`);
    w.push(`| PR | Value | Sev | Risk | What it fixes | ${cols.map((b) => `${b} verdict / dry run / decision`).join(' | ')} | Notes |`);
    w.push(`|---|---|---|---|---|${cols.map(() => '---').join('|')}|---|`);
    for (const it of rows) {
      const a = it.assessment || {};
      const per = cols.map((b) => { const t = it.targets[b]; if (!t) return '-'; if (t.on_branch) return 'on branch'; return `${t.verdict || '?'} / ${t.dryrun?.state || '-'} / **${t.decision}**`; });
      const notes = [...new Set(cols.map((b) => it.targets[b]?.note).filter(Boolean))].join(' ')
        + it.deps.filter((d) => d.status !== 'dismissed').map((d) => ` Depends on #${d.depends_on} (${d.source}${d.branch ? `, ${d.branch}` : ''}).`).join('');
      w.push(`| ${link(it.pr)} ${esc(strip(it.title))} | ${a.value || ''}${a.valueNote ? `: ${esc(a.valueNote)}` : ''} | ${a.severity || ''} | ${a.risk || ''} | ${esc(a.impact)} | ${per.join(' | ')} | ${esc(notes)} |`);
    }
  };
  const anyV = (it, vs) => cols.some((b) => vs.includes(it.targets[b]?.verdict));
  section('Recommended picks', (it) => it.kind === 'code' && anyV(it, ['pick']));
  section('Recommended flaky-test fixes', (it) => it.kind === 'flaky' && anyV(it, ['pick']));
  section('Needs a decision', (it) => !anyV(it, ['pick']) && anyV(it, ['maybe']));
  section('Not yet triaged', (it) => cols.every((b) => !it.targets[b] || it.targets[b].on_branch || !it.targets[b].verdict));
  w.push('\n## Skipped\n');
  w.push('| PR | Why |'); w.push('|---|---|');
  for (const it of scoped.filter((x) => cols.every((b) => ['skip', 'already', undefined].includes(x.targets[b]?.verdict) && x.targets[b]?.verdict))) {
    w.push(`| ${link(it.pr)} ${esc(strip(it.title))} | ${esc(it.assessment?.reason)} |`);
  }
  return w.join('\n') + '\n';
}
