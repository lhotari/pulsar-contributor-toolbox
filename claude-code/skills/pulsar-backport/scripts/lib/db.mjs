// SQLite state for backport sessions. One database holds every session.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BPT_HOME = process.env.BPT_HOME
  || path.join(os.homedir(), 'workspace-pulsar', 'pulsar-cherry-picking');
export const DB_PATH = process.env.BPT_DB || path.join(BPT_HOME, 'database', 'backports.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One row per master PR in the session's range.
CREATE TABLE IF NOT EXISTS items (
  session_id TEXT NOT NULL,
  pr INTEGER NOT NULL,
  sha TEXT NOT NULL,
  master_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  merged_at TEXT,
  kind TEXT NOT NULL DEFAULT 'code',          -- code | flaky
  excluded TEXT,                               -- pre-filter reason, NULL when in scope
  labels TEXT NOT NULL DEFAULT '[]',
  stats TEXT NOT NULL DEFAULT '{}',            -- files, main files, adds, dels
  assessment TEXT,                             -- evaluator JSON (impact, severity, risk, ...)
  round INTEGER NOT NULL DEFAULT 1,            -- discover round that first saw the PR
  reviewed_at TEXT,                            -- set when the user accepted the row's decisions
  comment TEXT,                                -- posted on the PR once every lane is done
  comment_state TEXT,                          -- JSON: {status: pending|posted|failed, url, postedAt, error}
  PRIMARY KEY (session_id, pr)
);
-- Per PR and target branch: facts, evaluator verdict and the human decision.
CREATE TABLE IF NOT EXISTS targets (
  session_id TEXT NOT NULL,
  pr INTEGER NOT NULL,
  branch TEXT NOT NULL,
  on_branch INTEGER NOT NULL DEFAULT 0,          -- 0 no | 1 same commit (PR number / trailer) | 2 equivalent change
  equiv TEXT,                                    -- JSON: how an equivalent branch commit was matched (or rejected)
  verdict TEXT,                                -- pick | maybe | skip | already
  lean TEXT,
  bug TEXT,
  evidence TEXT,
  adapt TEXT,
  note TEXT,                                   -- port note shown in the plan
  dryrun TEXT,                                 -- JSON: {state: clean|tests|main|error, files:[...]}
  decision TEXT NOT NULL DEFAULT 'undecided',  -- undecided | backport | skip | defer
  recommendation TEXT,                         -- derived from verdict + lean
  decision_source TEXT NOT NULL DEFAULT 'none', -- none | recommended | user
  decision_note TEXT,
  decided_at TEXT,
  PRIMARY KEY (session_id, pr, branch)
);
CREATE TABLE IF NOT EXISTS deps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  pr INTEGER NOT NULL,
  depends_on INTEGER NOT NULL,
  branch TEXT,                                 -- NULL: all branches
  source TEXT NOT NULL,                        -- evaluator | blame | conflict | build | manual
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',         -- open | accepted | dismissed
  phase TEXT NOT NULL DEFAULT 'plan',          -- plan | backport (found while backporting)
  created_at TEXT NOT NULL,
  UNIQUE (session_id, pr, depends_on, branch, source)
);
-- A lane is the backport of one session to one target branch.
CREATE TABLE IF NOT EXISTS lanes (
  session_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  release TEXT,
  seq INTEGER NOT NULL,
  reuse_from TEXT,
  phase TEXT NOT NULL DEFAULT 'not-started',
  worktree TEXT,
  local_branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  squashed_sha TEXT,
  test_branch TEXT,
  test_pr INTEGER,
  test_pr_url TEXT,
  final_sha TEXT,
  ci TEXT NOT NULL DEFAULT '{}',               -- latest CI summary per kind
  attention TEXT,                              -- what the lane waits for, shown in the UI
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, branch)
);
CREATE TABLE IF NOT EXISTS picks (
  session_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source_sha TEXT NOT NULL,                    -- master sha, or the reused lane's commit
  picked_sha TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | picked | conflict | blocked | skipped
  detail TEXT,                                 -- JSON: conflicts, check output, notes
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, branch, pr)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  branch TEXT,
  type TEXT NOT NULL,
  runner TEXT NOT NULL,                        -- engine | claude
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | waiting | done | failed | cancelled
  args TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  claude_session TEXT,
  claimed_by TEXT,                             -- server | interactive
  pid INTEGER,
  log_path TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  branch TEXT,
  job_id INTEGER,
  ts TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',          -- info | warn | error | attention
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, id);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, runner);
`;

let db;
export function open(dbPath = DB_PATH) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release of the schema.
function migrate(d) {
  const cols = new Set(d.prepare('PRAGMA table_info(targets)').all().map((c) => c.name));
  if (!cols.has('recommendation')) d.exec('ALTER TABLE targets ADD COLUMN recommendation TEXT');
  const icols = new Set(d.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  if (!icols.has('reviewed_at')) d.exec('ALTER TABLE items ADD COLUMN reviewed_at TEXT');
  if (!icols.has('comment')) d.exec('ALTER TABLE items ADD COLUMN comment TEXT');
  if (!icols.has('comment_state')) d.exec('ALTER TABLE items ADD COLUMN comment_state TEXT');
  if (!cols.has('equiv')) d.exec('ALTER TABLE targets ADD COLUMN equiv TEXT');
  if (!cols.has('decision_source')) d.exec("ALTER TABLE targets ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'none'");
}

export const now = () => new Date().toISOString();
export const J = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
export const S = (o) => JSON.stringify(o ?? null);

export function all(sql, ...p) { return open().prepare(sql).all(...p); }
export function get(sql, ...p) { return open().prepare(sql).get(...p); }
export function run(sql, ...p) { return open().prepare(sql).run(...p); }
export function tx(fn) {
  const d = open();
  d.exec('BEGIN IMMEDIATE');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function event(sessionId, message, { branch = null, job = null, level = 'info', data = null } = {}) {
  run('INSERT INTO events (session_id, branch, job_id, ts, level, message, data) VALUES (?,?,?,?,?,?,?)',
    sessionId, branch, job, now(), level, message, data == null ? null : S(data));
}

export function session(id) {
  const s = get('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) throw new Error(`no session ${id}`);
  return { ...s, config: J(s.config, {}) };
}

export function touchSession(id) { run('UPDATE sessions SET updated_at = ? WHERE id = ?', now(), id); }

export function lane(sessionId, branch) {
  const l = get('SELECT * FROM lanes WHERE session_id = ? AND branch = ?', sessionId, branch);
  if (!l) throw new Error(`no lane ${branch} in ${sessionId}`);
  return { ...l, ci: J(l.ci, {}) };
}

export function updateLane(sessionId, branch, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const vals = keys.map((k) => (k === 'ci' ? S(fields[k]) : fields[k]));
  run(`UPDATE lanes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE session_id = ? AND branch = ?`,
    ...vals, now(), sessionId, branch);
}
