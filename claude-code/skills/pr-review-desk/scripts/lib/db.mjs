// SQLite state for the review desk. One database holds every repository.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.PRD_HOME || path.join(os.homedir(), '.claude', 'pr-review-desk');
export const DB_PATH = process.env.PRD_DB || path.join(HOME, 'desk.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- A repository the desk triages. config holds rules, priorities and limits (see config.mjs).
CREATE TABLE IF NOT EXISTS repos (
  slug TEXT PRIMARY KEY,
  checkout TEXT,                       -- local clone used for reviewer worktrees (NULL: diff-only reviews)
  remote TEXT,                         -- remote name in that clone that points at slug
  enabled INTEGER NOT NULL DEFAULT 1,
  autopilot INTEGER NOT NULL DEFAULT 0, -- queue AI reviews automatically per config.auto
  config TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT,
  sync_error TEXT,
  created_at TEXT NOT NULL
);
-- Facts about a pull request, refreshed by sync.
CREATE TABLE IF NOT EXISTS prs (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  node_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  author TEXT,
  association TEXT,
  state TEXT,                          -- OPEN | CLOSED | MERGED
  draft INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,
  base_ref TEXT,
  additions INTEGER, deletions INTEGER, changed_files INTEGER,
  labels TEXT NOT NULL DEFAULT '[]',
  ci TEXT,
  review_decision TEXT,
  created_at TEXT, updated_at TEXT,
  body TEXT,
  analysis TEXT,                       -- JSON from prt's analyzePr: my reviews, threads, new comments
  detail_at TEXT,                      -- when the detail (threads, reviews) was last fetched
  seen_at TEXT,                        -- last sync that saw it
  PRIMARY KEY (repo, number)
);
-- The desk's view of a PR: lane, priority, category, security gate, the human's overrides.
CREATE TABLE IF NOT EXISTS items (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  lane TEXT NOT NULL DEFAULT 'backlog',
  score INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  category TEXT,                       -- fix | feat | improve | cleanup | doc | ci | build | deps | test | pip | revert | other
  component TEXT,
  flags TEXT NOT NULL DEFAULT '[]',    -- committer, review-requested, first-timer, priority-author, ...
  scan TEXT,                           -- JSON: deterministic security scan of scan_sha
  scan_sha TEXT,
  gate TEXT NOT NULL DEFAULT 'unscanned', -- unscanned | scanned | flagged | clear | suspicious | inconclusive
  gate_sha TEXT,                       -- head the gate decision applies to
  gate_by TEXT,                        -- scan | model | user
  gate_note TEXT,
  hold TEXT,                           -- NULL | parked | ignored | snoozed  (human)
  hold_until TEXT,
  hold_note TEXT,
  wanted INTEGER NOT NULL DEFAULT 0,   -- the human asked for a review (queues one when idle)
  note TEXT,                           -- private note, never posted
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- A review round: the AI draft, the human's edits, its staging on GitHub and submission.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- initial | re-review | manual
  status TEXT NOT NULL,                -- draft | staged | submitted | discarded
  head_sha TEXT,                       -- the commit the review read; comments anchor to it
  since_sha TEXT,                      -- re-review: the head of the previous review
  body TEXT NOT NULL DEFAULT '',
  body_ai TEXT,                        -- the body as generated, to show edits
  event TEXT,                          -- chosen by the human at submit time
  recommended_event TEXT,
  recommended_why TEXT,
  meta TEXT NOT NULL DEFAULT '{}',     -- tier, reviewers, coverage, dropped findings, gate, warnings
  gh_review_id INTEGER,                -- pending/submitted review on GitHub
  gh_review_node TEXT,
  gh_url TEXT,
  lint_ack TEXT NOT NULL DEFAULT '[]', -- lint labels the human acknowledged
  job_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  staged_at TEXT,
  submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS reviews_pr ON reviews (repo, number, id);
-- Comments of a review. kind: inline | file | reply (to a thread) | issue (PR conversation).
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,
  line INTEGER,                        -- end line of the anchor
  start_line INTEGER,                  -- range start, NULL for one line
  side TEXT DEFAULT 'RIGHT',
  thread_id TEXT,                      -- reply: GraphQL thread id
  in_reply_to TEXT,                    -- issue: URL of the comment answered
  resolve INTEGER NOT NULL DEFAULT 0,  -- reply: resolve the thread after submit
  severity TEXT, claim TEXT,
  body TEXT NOT NULL,
  body_ai TEXT,
  meta TEXT NOT NULL DEFAULT '{}',     -- confidence, agreement, crossValidation, assessment, why, evidence
  include INTEGER NOT NULL DEFAULT 1,  -- the human's yes/no
  source TEXT NOT NULL DEFAULT 'ai',   -- ai | human | github (added in GitHub's UI to the pending review)
  anchor_error TEXT,                   -- why the anchor cannot be posted
  seq INTEGER NOT NULL DEFAULT 0,
  gh_id INTEGER, gh_node TEXT, gh_url TEXT,
  state TEXT NOT NULL DEFAULT 'local', -- local | staged | posted | removed | failed
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_review ON comments (review_id, seq);
-- Claude Code work: review, re-review, revise, ask.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | waiting | done | failed | cancelled
  args TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  head_sha TEXT,                          -- pinned when the job was created
  dir TEXT,                               -- the job's scratch directory
  worktree TEXT,
  claimed_by TEXT, pid INTEGER, claude_session TEXT, log_path TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  repo TEXT, number INTEGER, job INTEGER,
  level TEXT NOT NULL DEFAULT 'info',     -- info | warn | error | attention | security
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authors (
  repo TEXT NOT NULL, login TEXT NOT NULL,
  permission TEXT,                        -- admin | maintain | write | triage | read | none (from the collaborators API)
  checked_at TEXT NOT NULL,
  PRIMARY KEY (repo, login)
);
`;

let handle = null;
export function open() {
  if (handle) return handle;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  handle = new DatabaseSync(DB_PATH);
  handle.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  handle.exec(SCHEMA);
  return handle;
}

export const now = () => new Date().toISOString();
export const S = (v) => JSON.stringify(v ?? null);
export function J(s, dflt = null) { if (s == null) return dflt; try { return JSON.parse(s); } catch { return dflt; } }
export const all = (sql, ...a) => open().prepare(sql).all(...a);
export const get = (sql, ...a) => open().prepare(sql).get(...a);
export const run = (sql, ...a) => open().prepare(sql).run(...a);
export function tx(fn) {
  const d = open(); d.exec('BEGIN IMMEDIATE');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function event(repo, number, message, { level = 'info', job = null } = {}) {
  run('INSERT INTO events (at, repo, number, job, level, message) VALUES (?,?,?,?,?,?)', now(), repo, number ?? null, job, level, String(message));
}

export function repo(slug) {
  const r = get('SELECT * FROM repos WHERE slug = ?', slug);
  if (!r) throw new Error(`repository ${slug} is not on the desk; run: prd repo add ${slug}`);
  return { ...r, config: J(r.config, {}) };
}

export function pr(repoSlug, number) {
  const p = get('SELECT * FROM prs WHERE repo = ? AND number = ?', repoSlug, number);
  return p ? { ...p, labels: J(p.labels, []), analysis: J(p.analysis) } : null;
}

export function item(repoSlug, number) {
  const i = get('SELECT * FROM items WHERE repo = ? AND number = ?', repoSlug, number);
  return i ? { ...i, reasons: J(i.reasons, []), flags: J(i.flags, []), scan: J(i.scan) } : null;
}

export function review(id) {
  const r = get('SELECT * FROM reviews WHERE id = ?', id);
  if (!r) throw new Error(`no review ${id}`);
  return { ...r, meta: J(r.meta, {}), lint_ack: J(r.lint_ack, []) };
}

/** The newest review round of a PR that is not discarded. */
export function currentReview(repoSlug, number) {
  const r = get(`SELECT id FROM reviews WHERE repo = ? AND number = ? AND status != 'discarded' ORDER BY id DESC LIMIT 1`, repoSlug, number);
  return r ? review(r.id) : null;
}

export function comments(reviewId) {
  return all('SELECT * FROM comments WHERE review_id = ? ORDER BY seq, id', reviewId).map((c) => ({ ...c, meta: J(c.meta, {}) }));
}

export function comment(id) {
  const c = get('SELECT * FROM comments WHERE id = ?', id);
  if (!c) throw new Error(`no comment ${id}`);
  return { ...c, meta: J(c.meta, {}) };
}

export function meta(key, value) {
  if (value === undefined) return get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  return value;
}

/** Directory for a PR's files: diffs, job scratch dirs, findings. */
export function prDir(repoSlug, number) {
  const d = path.join(HOME, 'prs', repoSlug.replace('/', '__'), `pr-${number}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
