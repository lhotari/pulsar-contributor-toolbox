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
//     _archive/<owner>/<repo>/pr-<N>/     out of the way: closed/merged PRs moved
//                                         here by cleanup, or ones set aside by
//                                         `prt archive`. `prt unarchive` reverses it.

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
  // How many review jobs may run at once. Each one is a subagent that spawns
  // its own reviewers, so this is a ceiling on fan-out, not on ambition.
  maxConcurrentJobs: 4,
  // A file must be unmodified for this long before the watcher acts on it. With
  // `capture`'s double read it is the second half of the defence against
  // submitting a buffer mid-write; neither alone is a proof.
  quiesceSeconds: 3,
  // Remind an author about points they have not answered, once the oldest has
  // gone unanswered this long.
  nudgeAfterDays: 2,
  // ...but never twice inside this many days, and never while I have said
  // anything at all on the PR more recently than that.
  nudgeCooldownDays: 7,
  // Beyond this the PR needs a decision (close, reassign, re-review), not a
  // reminder. `prt nudge` reports those separately instead of drafting one.
  nudgeMaxAgeDays: 90,
  // After `update-branch` moves the head, how long to wait for GitHub to create
  // that head's workflow runs before deciding there are none to approve.
  workflowApprovalWaitSeconds: 60,
  // Refuse to post text that looks like an undisclosed vulnerability report.
  // See CLAUDE.md critical rule 6 / SECURITY.md.
  securityLint: true,
  // Refuse to post text describing the pipeline's internal mechanics — tier,
  // effort, rounds, roles, shape, which pass raised a finding. NOT the fact that
  // AI assisted, which is a deliberate disclosure. See SKILL.md, "Keep the
  // pipeline's internal mechanics out of anything that posts".
  toolingLint: true,
  // Keep the generator from writing APPROVE; the human types the verdict, and
  // `Status: ready` then authorises the whole action file without a second flag.
  // This is the only thing enforcing that, so turning it off really does let a
  // draft arrive pre-approved.
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

export function archiveRepoDir(root, repo) {
  const [owner, name] = repo.split('/');
  return path.join(root, '_archive', owner, name);
}

export function archiveDir(root, repo, number) {
  return path.join(archiveRepoDir(root, repo), `pr-${number}`);
}

/** Written into an archived directory so a human browsing the tree knows why. */
export const ARCHIVE_MARKER = 'ARCHIVED.txt';

export function ensurePrDir(root, repo, number) {
  const d = prDir(root, repo, number);
  fs.mkdirSync(path.join(d, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(d, 'history'), { recursive: true });
  return d;
}

function listPrNumbers(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^pr-\d+$/.test(e.name))
    .map((e) => Number(e.name.slice(3)))
    .sort((a, b) => b - a);
}

export function listTracked(root, repo) {
  return listPrNumbers(repoDir(root, repo));
}

/**
 * PRs moved out of the live tree — by `cleanup` once they closed, or by hand to
 * drop one off the radar. Nothing else in the tool looks inside `_archive`, so
 * this is also what "ignored" means: `latest` consults it so an archived PR is
 * not offered up again the next time the backlog is ranked.
 */
export function listArchived(root, repo) {
  return listPrNumbers(archiveRepoDir(root, repo));
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
  return readStateFrom(prDir(root, repo, number));
}

/** The same read, for a PR directory that is not (or is no longer) in the live tree. */
export function readStateFrom(dir) {
  const p = path.join(dir, 'pr.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p} is corrupt: ${e.message}`);
  }
}

/**
 * Fields that belong to the store rather than to any one command, and so must
 * survive a writer that does not know about them.
 *
 * `sync` and `track` build a fresh document instead of spreading the previous
 * one, which was harmless while every field was theirs. The job queue is not:
 * losing it on `prt sync` — step 1 of every re-review — would be
 * indistinguishable from work that was never queued at all.
 */
const CARRIED_KEYS = ['job', 'lastJob'];

export function writeState(root, repo, number, state) {
  ensurePrDir(root, repo, number);
  const p = path.join(prDir(root, repo, number), 'pr.json');
  let prev = null;
  // A corrupt document must not stop the write that replaces it.
  try { prev = readStateFrom(prDir(root, repo, number)); } catch { prev = null; }

  const merged = { ...state };
  for (const key of CARRIED_KEYS) {
    if (key in state) {
      if (state[key] == null) delete merged[key];   // an explicit null deletes
      continue;
    }
    if (prev?.[key] != null) merged[key] = prev[key];
  }
  writeAtomic(p, `${JSON.stringify(merged, null, 2)}\n`);
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

// ------------------------------------------------------- the job queue's locks
//
// Two things that look alike and are not. `withJobLock` is mutual exclusion: one
// process inside a read-then-write of the queue at a time. `drain.owner` is
// policy: which session may start work for this repository at all. Answering
// only the second — as the first draft of this feature did — leaves two
// `prt job next` calls in one session free to select the same job.

/** A live owner that has done nothing for this long is wedged, not working. */
export const IDLE_TAKEOVER_MS = 30 * 60_000;

const ownerPath = (root, repo) => path.join(repoDir(root, repo), 'drain.owner');

/**
 * Is that process still there?
 *
 * EPERM means it exists and belongs to somebody else, which for this purpose is
 * the same answer as yes. Anything else — ESRCH, a nonsense pid — is no.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function readOwner(root, repo) {
  const p = ownerPath(root, repo);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Place an owner record without going through the claim rules. Tests only. */
export function writeOwnerForTest(root, repo, owner) {
  fs.mkdirSync(repoDir(root, repo), { recursive: true });
  writeAtomic(ownerPath(root, repo), `${JSON.stringify(owner, null, 2)}\n`);
}

/**
 * Take, keep, or be refused the right to run jobs for this repository.
 *
 * One drainer per repo guards against starting a second session's batch by
 * accident; it is not a distributed-systems claim. So the rules are the cheap
 * ones that answer exactly that: it is ours, its process is gone, or it has
 * done nothing for half an hour. Otherwise somebody is working, and we are not
 * going to trample them.
 */
export function claimOwner(root, repo, { session, pid, now = Date.now(), force = false } = {}) {
  const held = readOwner(root, repo);
  const stamp = new Date(now).toISOString();
  const take = (how) => {
    writeOwnerForTest(root, repo, { session, pid, since: stamp, lastActivityAt: stamp });
    return { ok: true, how };
  };

  if (!held) return take('new');
  if (held.session === session) {
    writeOwnerForTest(root, repo, { ...held, session, pid, lastActivityAt: stamp });
    return { ok: true, how: 'ours' };
  }
  if (force) return take('forced');
  if (!pidAlive(held.pid)) return take('crashed');

  const idleMs = now - Date.parse(held.lastActivityAt ?? held.since ?? stamp);
  if (idleMs > IDLE_TAKEOVER_MS) return take('idle');

  const mins = Math.max(1, Math.round((now - Date.parse(held.since ?? stamp)) / 60_000));
  return {
    ok: false,
    owner: held,
    reason: `${repo} jobs are owned by session ${held.session} (pid ${held.pid}), held ${mins}m. `
      + 'Use that session, or `prt job release --force` to take it.',
  };
}

/** Mark the lease as still doing something. Activity, not existence, keeps it. */
export function touchOwner(root, repo, { session, pid, now = Date.now() } = {}) {
  const held = readOwner(root, repo);
  if (!held || held.session !== session) return false;
  writeOwnerForTest(root, repo, { ...held, pid: pid ?? held.pid, lastActivityAt: new Date(now).toISOString() });
  return true;
}

export function releaseOwner(root, repo, { session, force = false } = {}) {
  const held = readOwner(root, repo);
  if (!held) return false;
  if (!force && held.session !== session) return false;
  try { fs.unlinkSync(ownerPath(root, repo)); } catch { /* already gone */ }
  return true;
}

/**
 * Run one job-state mutation with nobody else inside.
 *
 * Callers must return their refusals rather than exiting: `die()` calls
 * process.exit, which does not run a `finally`, and an exit from in here would
 * leave the lock behind until its TTL broke it.
 */
export function withJobLock(root, repo, fn, { ttlMs = 60_000, attempts = 50, waitMs = 100 } = {}) {
  const dir = repoDir(root, repo);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < attempts; i++) {
    const lock = acquireLock(dir, 'jobs.lock', ttlMs);
    if (lock) {
      try { return fn(); } finally { lock.release(); }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  throw new Error(`the job queue for ${repo} is busy — another prt process is holding jobs.lock`);
}
