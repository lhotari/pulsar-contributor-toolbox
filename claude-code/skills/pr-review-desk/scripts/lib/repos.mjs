// Repositories on the desk, and how a working directory maps to one (the skill can be invoked from any clone).
import { spawnSync } from 'node:child_process';
import * as db from './db.mjs';
import * as P from './prt.mjs';

export function addRepo(slug, { checkout = null, remote = null } = {}) {
  const s = P.normalizeSlug(slug);
  const have = db.get('SELECT * FROM repos WHERE slug = ?', s);
  if (have) {
    if (checkout && !have.checkout) db.run('UPDATE repos SET checkout = ?, remote = ? WHERE slug = ?', checkout, remote, s);
    return db.repo(s);
  }
  db.run('INSERT INTO repos (slug, checkout, remote, created_at) VALUES (?,?,?,?)', s, checkout, remote, db.now());
  db.event(s, null, `Added ${s} to the desk${checkout ? ` (checkout ${checkout}, remote ${remote})` : ' (no local checkout: diff-only reviews)'}`);
  return db.repo(s);
}

/** The remote of `dir` that points at `slug` (fork clones usually have the upstream under another name). */
export function remoteFor(dir, slug) {
  const out = spawnSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8' }).stdout || '';
  const want = slug.toLowerCase();
  for (const line of out.split('\n')) {
    const [name, url] = line.split(/\s+/);
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url || '');
    if (m && m[1].toLowerCase() === want) return name;
  }
  return null;
}

/** Repo for the current directory (upstream parent for a fork), registered with this clone as its checkout. */
export async function here(cwd = process.cwd(), explicit = null) {
  const slug = await P.resolveRepo(explicit, cwd);
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const checkout = top.status === 0 ? top.stdout.trim() : null;
  const remote = checkout ? remoteFor(checkout, slug) : null;
  return addRepo(slug, remote ? { checkout, remote } : {});
}

/** `123`, `#123`, or a PR URL (which also names the repo). */
export function parsePrRef(ref) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(ref);
  if (m) return { repo: m[1], number: Number(m[2]) };
  const n = Number(String(ref).replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a PR number or URL: ${ref}`);
  return { repo: null, number: n };
}
