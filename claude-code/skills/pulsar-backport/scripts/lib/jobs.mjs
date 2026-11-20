// Job queue. Engine jobs run `bpt job run <id>` as a child process. Claude jobs run headless
// `claude -p` on the user's Claude Code login (no API key), or wait for an interactive session to claim them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import { sessionDir } from './plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BPT = path.resolve(HERE, '..', 'bpt.mjs');
export const ENGINE = ['discover', 'start-lane', 'pick-all', 'push-test', 'rerun', 'squash', 'finalize', 'push-final-fix', 'apply-labels', 'post-comments'];
export const CLAUDE = ['triage', 'resolve', 'verify', 'fix-ci'];
export const ACTIVE = ['queued', 'running', 'waiting'];

export function enqueue(sid, branch, type, args = {}) {
  const runner = ENGINE.includes(type) ? 'engine' : CLAUDE.includes(type) ? 'claude' : null;
  if (!runner) throw new Error(`unknown job type ${type}`);
  const dup = db.get(`SELECT id FROM jobs WHERE session_id = ? AND IFNULL(branch,'') = IFNULL(?,'') AND type = ? AND status IN ('queued','running','waiting')`, sid, branch, type);
  if (dup) return dup.id;
  const r = db.run('INSERT INTO jobs (session_id, branch, type, runner, args, created_at) VALUES (?,?,?,?,?,?)',
    sid, branch, type, runner, db.S(args), db.now());
  const id = Number(r.lastInsertRowid);
  db.event(sid, `Queued ${type}${args.pr ? ` #${args.pr}` : ''} (${runner === 'claude' ? 'Claude Code' : 'engine'})`, { branch, job: id });
  return id;
}

export function job(id) {
  const j = db.get('SELECT * FROM jobs WHERE id = ?', id);
  if (!j) throw new Error(`no job ${id}`);
  return { ...j, args: db.J(j.args, {}), result: db.J(j.result) };
}

export function activeJob(sid, branch) {
  return db.get(`SELECT * FROM jobs WHERE session_id = ? AND IFNULL(branch,'') = IFNULL(?,'') AND status IN ('queued','running','waiting') ORDER BY id LIMIT 1`, sid, branch);
}

export function finish(id, status, result) {
  const j = job(id);
  db.run('UPDATE jobs SET status = ?, result = ?, finished_at = ?, pid = NULL WHERE id = ?', status, db.S(result ?? null), db.now(), id);
  const msg = result?.summary || result?.error || result?.question || '';
  db.event(j.session_id, `${j.type}${j.args.pr ? ` #${j.args.pr}` : ''} ${status}${msg ? `: ${String(msg).slice(0, 500)}` : ''}`,
    { branch: j.branch, job: id, level: status === 'failed' ? 'error' : status === 'waiting' ? 'attention' : 'info' });
}

/** An interactive Claude Code session takes the oldest queued Claude job. */
export function claim(sid, who = 'interactive') {
  const j = db.get(`SELECT id FROM jobs WHERE runner = 'claude' AND status = 'queued' ${sid ? 'AND session_id = ?' : ''} ORDER BY id LIMIT 1`, ...(sid ? [sid] : []));
  if (!j) return null;
  const r = db.run(`UPDATE jobs SET status = 'running', claimed_by = ?, started_at = ? WHERE id = ? AND status = 'queued'`, who, db.now(), j.id);
  return r.changes ? job(j.id) : null;
}

export function logPath(id) {
  const dir = path.join(db.BPT_HOME, 'logs'); fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `job-${id}.log`);
}

// --- prompts for Claude Code workers ---

export function workerPrompt(j) {
  const head = `You are a headless worker for the pulsar-backport skill. Load the pulsar-backport skill and follow its "Worker jobs" section.
Job ${j.id}: ${j.type}${j.branch ? ` on ${j.branch}` : ''}, session ${j.session_id}.
Engine: node ${BPT}
Start with: node ${BPT} job show ${j.id}
End with exactly one of: job done ${j.id} --summary "...", job fail ${j.id} --reason "...", or job ask ${j.id} --question "..." (when only the user can decide).
Never push, never open or edit PRs, never change labels: the engine and the user do that.`;
  const extra = {
    resolve: `Resolve pick #${j.args.pr} with the pulsar-cherry-pick skill's per-commit loop (conflicts, slog→slf4j, Gradle→Maven, compile the module, run the changed tests). Commit with git cherry-pick --continue (or amend for a needs-fix pick), then run: node ${BPT} lane resolved ${j.session_id} ${j.branch} ${j.args.pr}. If the pick needs another PR first, record it with: node ${BPT} dep add ${j.session_id} ${j.args.pr} <dep-pr> --branch ${j.branch} --detail "why", leave the cherry-pick in place, and finish with job ask.`,
    verify: `Verify the whole lane builds: compile every module the picks touched (install shared modules first), run the tests each pick added or changed, and fix problems with fixup! commits (git commit --fixup=<pick commit>). When it builds and the tests pass, run node ${BPT} lane phase ${j.session_id} ${j.branch} verified.`,
    'fix-ci': `CI ${j.args.kind === 'final' ? `on ${j.branch} itself` : 'on the test PR'} failed. Investigate with the investigate-ci skill. A flaky or pre-existing failure: run node ${BPT} ci rerun ${j.session_id} ${j.branch}. A real failure caused by a pick: fix it locally${j.args.kind === 'final' ? ' as a new commit on top of HEAD (the branch is already pushed; the user pushes the fix from the UI)' : ` with a fixup! commit for that pick, run the affected tests, then node ${BPT} lane phase ${j.session_id} ${j.branch} verified (the engine pushes it)`}.`,
    triage: `Triage the untriaged PRs of the plan: follow the pulsar-backport-plan skill's "Triage" section (export batches, run evaluator subagents, import the verdicts).`,
  }[j.type] || '';
  return `${head}\n\n${extra}${j.args.instructions ? `\n\nUser instructions: ${j.args.instructions}` : ''}`;
}

/** Start a job's process. Returns the child, or null if the job is left for an interactive session. */
export function launch(j, cfg) {
  const lp = logPath(j.id);
  const out = fs.openSync(lp, 'a');
  let child;
  if (j.runner === 'engine') {
    child = spawn(process.execPath, [BPT, 'job', 'run', String(j.id)], { stdio: ['ignore', out, out], detached: false });
  } else {
    if (cfg.runner === 'interactive') return null;
    const claudeSession = j.claude_session || crypto.randomUUID();
    const lane = j.branch ? db.get('SELECT worktree FROM lanes WHERE session_id = ? AND branch = ?', j.session_id, j.branch) : null;
    const cwd = lane?.worktree && fs.existsSync(lane.worktree) ? lane.worktree : (fs.mkdirSync(sessionDir(j.session_id), { recursive: true }), sessionDir(j.session_id));
    const resume = j.args.reply && j.claude_session;
    const args = ['-p', resume ? j.args.reply : workerPrompt(j), '--output-format', 'stream-json', '--verbose',
      '--permission-mode', cfg.permissionMode || 'auto',
      '--add-dir', db.BPT_HOME, '--add-dir', cfg.repo,
      // Workers commit locally only. The engine pushes, and only on the user's or autopilot's request.
      '--disallowedTools', 'Bash(git push *)', 'Bash(/usr/bin/git push *)', 'Bash(git -C * push *)', 'Bash(/usr/bin/git -C * push *)',
      'Bash(gh pr create *)', 'Bash(gh pr merge *)', 'Bash(gh pr edit *)', 'Bash(gh pr comment *)', 'Bash(gh pr close *)',
      'Bash(gh pr review *)', 'Bash(gh issue *)', 'Bash(gh label *)'];
    if (resume) args.push('--resume', j.claude_session); else args.push('--session-id', claudeSession);
    if (cfg.model) args.push('--model', cfg.model);
    child = spawn(process.env.BPT_CLAUDE || 'claude', args, { cwd, stdio: ['ignore', out, out], env: { ...process.env, BPT_JOB: String(j.id) } });
    db.run('UPDATE jobs SET claude_session = ? WHERE id = ?', claudeSession, j.id);
  }
  db.run(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), pid = ?, log_path = ?, claimed_by = 'server' WHERE id = ?`, db.now(), child.pid, lp, j.id);
  child.on('exit', (code) => {
    fs.closeSync(out);
    const now = job(j.id);
    if (now.status === 'running') finish(j.id, code === 0 && j.runner === 'engine' ? 'done' : 'failed',
      { error: j.runner === 'claude' ? `worker exited (${code}) without reporting; see the log` : `exit ${code}` });
  });
  return child;
}

/** Send a user reply to a waiting Claude job: the worker's Claude Code session is resumed with it. */
export function reply(id, text) {
  const j = job(id);
  if (j.runner !== 'claude') throw new Error('only Claude jobs take replies');
  db.run(`UPDATE jobs SET status = 'queued', args = ?, finished_at = NULL WHERE id = ?`, db.S({ ...j.args, reply: text }), id);
  db.event(j.session_id, `Reply sent to job ${id}`, { branch: j.branch, job: id });
}

export function cancel(id) {
  const j = job(id);
  if (j.pid) { try { process.kill(j.pid, 'SIGTERM'); } catch { /* already gone */ } }
  finish(id, 'cancelled', { summary: 'cancelled by the user' });
}

/** Human-readable lines from a job log (stream-json for Claude, plain text for the engine). */
export function readLog(id, offset = 0) {
  const j = job(id); if (!j.log_path || !fs.existsSync(j.log_path)) return { lines: [], offset };
  const buf = fs.readFileSync(j.log_path, 'utf8'); const chunk = buf.slice(offset);
  const lines = [];
  for (const raw of chunk.split('\n')) {
    if (!raw.trim()) continue;
    if (j.runner !== 'claude' || raw[0] !== '{') { lines.push({ kind: 'text', text: raw }); continue; }
    let o; try { o = JSON.parse(raw); } catch { lines.push({ kind: 'text', text: raw }); continue; }
    if (o.type === 'assistant') {
      for (const c of o.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) lines.push({ kind: 'say', text: c.text });
        if (c.type === 'tool_use') lines.push({ kind: 'tool', text: `${c.name}: ${toolSummary(c)}` });
      }
    } else if (o.type === 'result') {
      lines.push({ kind: 'result', text: `${o.subtype}${o.num_turns ? `, ${o.num_turns} turns` : ''}${o.duration_ms ? `, ${Math.round(o.duration_ms / 60000)} min` : ''}` });
    }
  }
  return { lines, offset: buf.length };
}

function toolSummary(c) {
  const i = c.input || {};
  return String(i.command || i.file_path || i.pattern || i.description || i.prompt || JSON.stringify(i)).split('\n')[0].slice(0, 240);
}
