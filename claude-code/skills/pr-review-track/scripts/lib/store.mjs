// On-disk tracking store.
//
//   $PRT_ROOT/                           (default ~/.claude/pr-review-track)
//     config.json                        global defaults
//     <owner>/<repo>/
//       repo.json                        per-repo overrides + sync watermark
//       BOARD.md                         generated overview (never hand-edited)
//       pr-<N>/
//         pr.json                        machine state
//         review.md                      the human-editable action file
//         notes.md                       private notes, never posted
//         cache/                         diff, threads, findings from pr-review
//         history/                       archived action files, timestamped
//     _archive/<owner>/<repo>/pr-<N>/     closed/merged, moved here by cleanup

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_ROOT = process.env.PRT_ROOT || path.join(os.homedir(), '.claude', 'pr-review-track');

export const DEFAULT_CONFIG = {
  // Reviewer identity. null => resolved from `gh api user` and cached here.
  reviewer: null,
  // Command used to open files for editing. Args are appended.
  editorCmd: 'code',
  editorArgs: ['-r'],
  // Authors whose PRs always sort first in `latest`, in order.
  priorityAuthors: ['merlimat'],
  // Never surfaced by `latest`.
  ignoreAuthors: ['dependabot[bot]', 'github-actions[bot]', 'renovate[bot]'],
  // `latest` and `review-latest` default batch size.
  latestLimit: 10,
  // Watcher poll interval, seconds.
  watchIntervalSeconds: 20,
  // A file must be unmodified for this long before the watcher acts on it,
  // so a half-saved edit is never submitted.
  quiesceSeconds: 3,
  // Refuse to post text that looks like an undisclosed vulnerability report.
  // See CLAUDE.md critical rule 6 / SECURITY.md.
  securityLint: true,
  // Never let the tool post APPROVE without the human having typed it.
  // (The generator always proposes COMMENT; this is a second belt.)
  requireExplicitApprove: true,
  // Archive rather than delete on cleanup.
  cleanupMode: 'archive', // 'archive' | 'purge'
};

export function loadConfig(root = DEFAULT_ROOT) {
  const p = path.join(root, 'config.json');
  let user = {};
  if (fs.existsSync(p)) {
    try {
      user = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`${p} is not valid JSON: ${e.message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...user, _root: root, _path: p };
}

export function saveConfig(cfg) {
  const { _root, _path, ...rest } = cfg;
  fs.mkdirSync(path.dirname(_path), { recursive: true });
  writeAtomic(_path, `${JSON.stringify(rest, null, 2)}\n`);
}

export function repoConfig(cfg, repo) {
  const p = path.join(repoDir(cfg._root, repo), 'repo.json');
  let over = {};
  if (fs.existsSync(p)) {
    try {
      over = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore a corrupt overlay rather than blocking the run */ }
  }
  return { ...cfg, ...over, _repoPath: p };
}

export function repoDir(root, repo) {
  const [owner, name] = repo.split('/');
  return path.join(root, owner, name);
}

export function prDir(root, repo, number) {
  return path.join(repoDir(root, repo), `pr-${number}`);
}

export function archiveDir(root, repo, number) {
  const [owner, name] = repo.split('/');
  return path.join(root, '_archive', owner, name, `pr-${number}`);
}

export function ensurePrDir(root, repo, number) {
  const d = prDir(root, repo, number);
  fs.mkdirSync(path.join(d, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(d, 'history'), { recursive: true });
  return d;
}

export function listTracked(root, repo) {
  const d = repoDir(root, repo);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^pr-\d+$/.test(e.name))
    .map((e) => Number(e.name.slice(3)))
    .sort((a, b) => b - a);
}

export function listRepos(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const owner of fs.readdirSync(root, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.name.startsWith('_') || owner.name.startsWith('.')) continue;
    for (const name of fs.readdirSync(path.join(root, owner.name), { withFileTypes: true })) {
      if (name.isDirectory()) out.push(`${owner.name}/${name.name}`);
    }
  }
  return out;
}

export function readState(root, repo, number) {
  const p = path.join(prDir(root, repo, number), 'pr.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p} is corrupt: ${e.message}`);
  }
}

export function writeState(root, repo, number, state) {
  ensurePrDir(root, repo, number);
  const p = path.join(prDir(root, repo, number), 'pr.json');
  writeAtomic(p, `${JSON.stringify(state, null, 2)}\n`);
  return p;
}

export function actionFilePath(root, repo, number) {
  return path.join(prDir(root, repo, number), 'review.md');
}

export function readActionFile(root, repo, number) {
  const p = actionFilePath(root, repo, number);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function writeActionFile(root, repo, number, text) {
  ensurePrDir(root, repo, number);
  writeAtomic(actionFilePath(root, repo, number), text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Write via a temp file + rename so a reader (or the watcher) never sees a
 * half-written action file.
 */
export function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function cacheFile(root, repo, number, name) {
  return path.join(prDir(root, repo, number), 'cache', name);
}

export function archiveActionFile(root, repo, number) {
  const src = actionFilePath(root, repo, number);
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(prDir(root, repo, number), 'history', `${stamp}-review.md`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

/**
 * Cross-process advisory lock (O_EXCL) with an ownership token.
 *
 * The token matters: a legitimate submit can outlive the stale-lock TTL (four
 * gh retries with 60 s backoff, times several actions), after which a second
 * process breaks the lock — and the first process, finishing later, would
 * otherwise unlink the *second* process's lock and let a third in.
 * `heartbeat()` is the other half: a long-running submit keeps touching its
 * lock so it never looks stale in the first place.
 */
export function acquireLock(dir, name = 'submit.lock', ttlMs = 10 * 60_000, attempt = 0) {
  const p = path.join(dir, name);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx' });
    return {
      path: p,
      token,
      heartbeat() {
        try {
          const now = new Date();
          fs.utimesSync(p, now, now);
        } catch { /* the lock is gone; release() will notice */ }
      },
      release() {
        try {
          const held = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (held.token !== token) return; // somebody else owns it now
          fs.unlinkSync(p);
        } catch { /* already gone, or unreadable */ }
      },
    };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let age;
    try {
      age = Date.now() - fs.statSync(p).mtimeMs;
    } catch {
      return acquireLock(dir, name, ttlMs, attempt); // vanished between calls
    }
    // Break a lock left behind by a killed submitter, but only once: if another
    // process is racing us for it, losing the race is the correct outcome.
    if (age > ttlMs && attempt === 0) {
      try { fs.unlinkSync(p); } catch { /* another breaker won */ }
      return acquireLock(dir, name, ttlMs, 1);
    }
    return null;
  }
}
