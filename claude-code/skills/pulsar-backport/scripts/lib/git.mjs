// Git helpers. Read-only analysis runs against the main clone; picks run in per-lane worktrees.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const GIT = process.env.BPT_GIT || (fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git');
const ID_ENV = {
  GIT_AUTHOR_NAME: 'bpt', GIT_AUTHOR_EMAIL: 'bpt@localhost',
  GIT_COMMITTER_NAME: 'bpt', GIT_COMMITTER_EMAIL: 'bpt@localhost',
};

export function git(cwd, args, { allowFail = false, input, env, trim = true } = {}) {
  const r = spawnSync(GIT, args, {
    cwd, input, encoding: 'utf8', maxBuffer: 1 << 30,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) },
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim().slice(0, 2000)}`);
  }
  const out = r.stdout ?? '';
  return allowFail ? { ok: r.status === 0, status: r.status, out: trim ? out.trim() : out, err: (r.stderr || '').trim() }
    : (trim ? out.trim() : out);
}

export const rev = (cwd, ref) => git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
export const short = (sha) => (sha || '').slice(0, 11);
export const isAncestor = (cwd, a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).ok;

export function remoteFor(cwd, slug) {
  const lines = git(cwd, ['remote', '-v']).split('\n');
  const re = new RegExp(`github\\.com[:/]${slug.replace('/', '\\/')}(\\.git)?\\s`);
  const hit = lines.find((l) => re.test(l + ' ') && l.endsWith('(push)'));
  if (!hit) throw new Error(`no git remote for ${slug} in ${cwd}`);
  return hit.split(/\s+/)[0];
}

export function fetch(cwd, remote, refs) {
  git(cwd, ['fetch', '--quiet', remote, ...refs.map((r) => `+refs/heads/${r}:refs/remotes/${remote}/${r}`)]);
}

export const PR_RE = /\(#(\d+)\)\s*$/;

/** First-parent commits of ref after sinceSha, oldest first. */
export function firstParentCommits(cwd, sinceSha, ref) {
  const out = git(cwd, ['log', '--first-parent', '--reverse', '--format=%H%x1f%s%x1f%cI', `${sinceSha}..${ref}`]);
  if (!out) return [];
  return out.split('\n').map((l) => {
    const [sha, subject, date] = l.split('\x1f');
    const m = subject.match(PR_RE);
    return { sha, subject, date, pr: m ? Number(m[1]) : null, title: subject.replace(PR_RE, '').trim() };
  });
}

/** PR numbers and source shas already on a branch (since it forked from master). */
export function pickedOnBranch(cwd, branchRef, masterRef) {
  const mb = git(cwd, ['merge-base', branchRef, masterRef]);
  const out = git(cwd, ['log', '--format=%s%x1f%B%x1e', `${mb}..${branchRef}`]);
  const prs = new Set(); const shas = new Set();
  for (const rec of out.split('\x1e')) {
    const i = rec.indexOf('\x1f');
    if (i < 0) continue;
    const subject = rec.slice(0, i).trim(); const body = rec.slice(i + 1);
    if (/^Revert\b/.test(subject)) continue;
    for (const m of subject.matchAll(/\(#(\d+)\)/g)) prs.add(Number(m[1]));
    for (const m of body.matchAll(/cherry picked from commit ([0-9a-f]{40})/g)) shas.add(m[1]);
  }
  return { prs, shas, mergeBase: mb };
}

/** Is PR #n on the branch (subject "(#n)" since the fork point)? For PRs outside a session's range. */
export function prOnBranch(cwd, branchRef, masterRef, n) {
  const mb = git(cwd, ['merge-base', branchRef, masterRef]);
  if (git(cwd, ['log', '-1', '--format=%H', '-F', `--grep=(#${n})`, `${mb}..${branchRef}`])) return true;
  // Older than the fork point: on the branch if it is on master before the fork.
  return !!git(cwd, ['log', '-1', '--first-parent', '--format=%H', '-F', `--grep=(#${n})`, mb]);
}

/** Commits in a range with subject, body and PR number. */
export function commitsWithBodies(cwd, range, { firstParent = false } = {}) {
  const out = git(cwd, ['log', ...(firstParent ? ['--first-parent'] : []), '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', range]);
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, date, subject, body] = r.split('\x1f');
    const m = subject.match(PR_RE);
    return { sha, date, subject, body: body || '', pr: m ? Number(m[1]) : null };
  });
}

/** patch-id → sha for every commit in a range (one git log -p stream). */
export function patchIds(cwd, range, { firstParent = false } = {}) {
  const r = spawnSync(GIT, ['log', '-p', '--no-color', ...(firstParent ? ['--first-parent'] : []), '--format=commit %H', range],
    { cwd, maxBuffer: 1 << 30 });
  const p = spawnSync(GIT, ['patch-id', '--stable'], { cwd, input: r.stdout, maxBuffer: 1 << 28, encoding: 'utf8' });
  const map = new Map();
  for (const line of (p.stdout || '').split('\n')) { const [pid, sha] = line.split(' '); if (pid && sha) map.set(pid, sha); }
  return map;
}

/** Title without [type][component][branch-x] prefixes, PR number and punctuation noise. */
export function normalizeTitle(t) {
  return (t || '').replace(PR_RE, '').replace(/\[[^\]]*\]/g, ' ').toLowerCase().replace(/[`'".,:;()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Upgrade Oxia Java client to 0.10.4" → {name: 'oxia java client', version: [0,10,4]} */
export function parseUpgrade(t) {
  const clean = (t || '').replace(PR_RE, '').replace(/\[[^\]]*\]/g, ' ').toLowerCase().replace(/[`'"(),:;]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(?:upgrade|bump|update)\s+(.+?)\s+(?:from\s+\S+\s+)?to\s+v?(\d+(?:\.\d+)+)/);
  if (!m) return null;
  return { name: m[1].replace(/\b(the|dependency|dependencies|version)\b/g, '').replace(/\s+/g, ' ').trim(), version: m[2].split('.').map(Number) };
}
export function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
  return 0;
}

export const isTestPath = (f) => /\/src\/test\/|^tests\/|\/src\/jmh\/|^microbench\//.test(f);

export function commitFiles(cwd, sha) {
  const files = git(cwd, ['show', '--format=', '--name-only', sha]).split('\n').filter(Boolean);
  const st = git(cwd, ['show', '--format=', '--shortstat', sha]);
  const add = Number((st.match(/(\d+) insertion/) || [0, 0])[1]);
  const del = Number((st.match(/(\d+) deletion/) || [0, 0])[1]);
  const main = files.filter((f) => !isTestPath(f) && /\.java$/.test(f));
  return { files, main, add, del };
}

/**
 * Dry-run cherry-pick of sha onto head with merge-tree. Does not touch any worktree.
 * Returns {clean, tree, conflicts:[{file, test, hunks}]}.
 */
export function dryPick(cwd, head, sha, parent = `${sha}^`) {
  const r = git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${parent}`, head, sha], { allowFail: true });
  const lines = r.out.split('\n');
  const tree = lines[0];
  if (r.ok) return { clean: true, tree, conflicts: [] };
  if (!/^[0-9a-f]{40}$/.test(tree)) return { clean: false, tree: null, error: r.err || r.out, conflicts: [] };
  const conflicts = lines.slice(1).filter(Boolean).map((file) => {
    const blob = git(cwd, ['show', `${tree}:${file}`], { allowFail: true });
    const hunks = blob.ok ? (blob.out.match(/^<<<<<<< /gm) || []).length : 0;
    return { file, test: isTestPath(file), hunks };
  });
  return { clean: false, tree, conflicts };
}

export function dryState(d) {
  if (d.error) return 'error';
  if (d.clean) return 'clean';
  return d.conflicts.every((c) => c.test) ? 'tests' : 'main';
}

/** Commit a merge-tree result on top of head (for chaining dry runs). */
export function commitTree(cwd, tree, head, msg) {
  return git(cwd, ['commit-tree', tree, '-p', head, '-m', msg], { env: ID_ENV });
}

/**
 * Lines a commit modifies or inserts next to, blamed in its parent. Commits that are not on the
 * branch are dependency candidates: the change was written on top of them.
 * Returns [{sha, lines, files:Set}] ordered by line count.
 */
export function blameDependencies(cwd, sha, { maxFiles = 40 } = {}) {
  const diff = git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', `${sha}^`, sha], { trim: false });
  const ranges = new Map(); let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) { file = line === '--- /dev/null' ? null : line.slice(6); continue; }
    if (!file || !line.startsWith('@@')) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+/);
    if (!m) continue;
    let start = Number(m[1]); let count = m[2] == null ? 1 : Number(m[2]);
    if (count === 0) { count = 2; start = Math.max(1, start); } // pure insertion: blame the neighbours
    if (!ranges.has(file)) ranges.set(file, []);
    ranges.get(file).push([start, start + count - 1]);
  }
  const hits = new Map();
  let n = 0;
  for (const [f, rs] of ranges) {
    if (++n > maxFiles) break;
    const args = ['blame', '--porcelain', ...rs.flatMap(([a, b]) => ['-L', `${a},${b}`]), `${sha}^`, '--', f];
    const r = git(cwd, args, { allowFail: true });
    if (!r.ok) continue;
    for (const l of r.out.split('\n')) {
      const m = l.match(/^([0-9a-f]{40}) \d+ \d+/);
      if (!m) continue;
      const h = hits.get(m[1]) || { sha: m[1], lines: 0, files: new Set() };
      h.lines++; h.files.add(f); hits.set(m[1], h);
    }
  }
  return [...hits.values()].sort((a, b) => b.lines - a.lines);
}

// --- worktree operations (mutating; only inside lane worktrees) ---

export function addWorktree(repo, dir, localBranch, startRef) {
  if (fs.existsSync(dir)) return;
  git(repo, ['worktree', 'add', '-B', localBranch, dir, startRef]);
  git(dir, ['config', 'merge.conflictStyle', 'zdiff3']);
}

export function state(cwd) {
  const gd = git(cwd, ['rev-parse', '--git-dir']);
  const abs = gd.startsWith('/') ? gd : `${cwd}/${gd}`;
  return {
    cherryPicking: fs.existsSync(`${abs}/CHERRY_PICK_HEAD`),
    rebasing: fs.existsSync(`${abs}/rebase-merge`) || fs.existsSync(`${abs}/rebase-apply`),
    dirty: git(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '',
    head: rev(cwd, 'HEAD'),
  };
}

export function cherryPick(cwd, sha, { trailer = true } = {}) {
  // One commit, or a commit followed by the commits that ride with it (fixups replayed with their pick).
  // On a conflict git stops the sequence; `cherry-pick --continue` applies the rest.
  const shas = [sha].flat();
  const args = ['cherry-pick'];
  if (trailer) args.push('-x');
  let r = git(cwd, [...args, ...shas], { allowFail: true });
  for (let i = 0; !r.ok && i <= shas.length; i++) {
    const unmerged = git(cwd, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    // rerere (rerere.autoupdate) replayed a recorded resolution and staged it: nothing is left to resolve, so the
    // pick goes on; the build check validates the result as for any pick.
    if (!unmerged.length && /Staged '|Resolved '/.test(r.err + r.out) && !git(cwd, ['diff', '--cached', '--quiet'], { allowFail: true }).ok) {
      r = git(cwd, ['-c', 'core.editor=true', 'cherry-pick', '--continue'], { allowFail: true });
      if (r.ok) continue;
      return { ok: false, conflicts: [], error: r.err };
    }
    if (unmerged.length || !/now empty|nothing to commit/.test(r.err + r.out)) return { ok: false, conflicts: unmerged, error: r.err };
    r = git(cwd, ['cherry-pick', '--skip'], { allowFail: true });
    if (shas.length === 1) return { ok: false, empty: true, conflicts: [] };
  }
  return r.ok ? { ok: true, sha: rev(cwd, 'HEAD') } : { ok: false, conflicts: [], error: r.err };
}
