// The lane state machine: decides the next job for each lane. Called by the server's tick when autopilot is on,
// and by the "Next step" button. It never pushes to a real release branch: that stays a user action (finalize).
import * as db from './db.mjs';
import * as jobs from './jobs.mjs';
import * as lane from './lane.mjs';
import * as plan from './plan.mjs';

const POLL_MS = Number(process.env.BPT_POLL_MS || 5 * 60 * 1000);
const REUSABLE = ['ready', 'final-ci', 'final-ci-failed', 'done'];

function attemptsFor(sid, branch, type, key) {
  return db.all(`SELECT args FROM jobs WHERE session_id = ? AND branch = ? AND type = ? AND status IN ('failed','done','cancelled')`, sid, branch, type)
    .map((j) => db.J(j.args, {})).filter((a) => !key || Object.entries(key).every(([k, v]) => a[k] === v)).length;
}

/** One step for every lane of the session. Returns what was done, for the UI. */
export function advance(sid, { force = false } = {}) {
  const s = db.session(sid); const cfg = s.config;
  if (s.status !== 'backporting') return [{ note: 'the session is still planning; start backporting first' }];
  const steps = [];
  const lanes = db.all('SELECT * FROM lanes WHERE session_id = ? ORDER BY seq', sid).map((l) => ({ ...l, ci: db.J(l.ci, {}) }));
  for (const l of lanes) {
    const b = l.branch;
    if (jobs.activeJob(sid, b)) continue;
    const say = (note) => steps.push({ branch: b, note });
    switch (l.phase) {
      case 'not-started': {
        if (l.reuse_from) {
          const src = lanes.find((x) => x.branch === l.reuse_from);
          if (!src || !REUSABLE.includes(src.phase)) { say(`waits for ${l.reuse_from} to pass CI`); break; }
        }
        jobs.enqueue(sid, b, 'start-lane'); say('start lane'); break;
      }
      case 'picking': jobs.enqueue(sid, b, 'pick-all'); say('pick'); break;
      case 'needs-attention': {
        const p = lane.lanePicks(sid, b).find((x) => ['conflict', 'needs-fix'].includes(x.status));
        if (!p) {
          const blocked = lane.lanePicks(sid, b).find((x) => x.status === 'blocked');
          say(blocked ? `#${blocked.pr} waits for a dependency decision` : (l.attention || 'waits for the user'));
          if (!blocked && !l.attention) { lane.setPhase(sid, b, 'picking'); }
          break;
        }
        if (attemptsFor(sid, b, 'resolve', { pr: p.pr }) >= 2 && !force) { say(`#${p.pr}: two resolve attempts failed; waits for the user`); break; }
        jobs.enqueue(sid, b, 'resolve', { pr: p.pr }); say(`resolve #${p.pr}`); break;
      }
      case 'picked': lane.setPhase(sid, b, 'verifying'); jobs.enqueue(sid, b, 'verify'); say('verify build'); break;
      case 'verifying':
        if (attemptsFor(sid, b, 'verify') >= 2 && !force) { say('verification failed twice; waits for the user'); break; }
        jobs.enqueue(sid, b, 'verify'); say('verify build'); break;
      case 'verified':
        if (!cfg.autoPushTest && !force) { db.updateLane(sid, b, { attention: 'Verified locally. Push the test branch from the UI' }); say('waits for push'); break; }
        jobs.enqueue(sid, b, 'push-test'); say('push test branch'); break;
      case 'testing': case 'final-ci': {
        const kind = l.phase === 'final-ci' ? 'final' : 'test';
        const last = Date.parse(l.ci[kind]?.polledAt || 0);
        if (force || Date.now() - last > POLL_MS) {
          try { const r = lane.pollCi(sid, b); say(`CI ${r.state}`); } catch (e) { say(`CI poll failed: ${e.message}`); }
        }
        break;
      }
      case 'ci-failed': case 'final-ci-failed': {
        const kind = l.phase === 'final-ci-failed' ? 'final' : 'test';
        const sha = l.ci[kind]?.sha;
        if (attemptsFor(sid, b, 'fix-ci', { kind, sha }) >= 1 && !force) { say('a CI fix attempt for this commit already ran; waits for the user'); break; }
        jobs.enqueue(sid, b, 'fix-ci', { kind, sha }); say(`investigate ${kind} CI failure`); break;
      }
      case 'ci-green': jobs.enqueue(sid, b, 'squash'); say('squash fixups'); break;
      case 'ready': say('ready to finalize (user action)'); break;
      default: break;
    }
  }
  // Every lane pushed and green: post the comments queued during planning (e.g. "needs a separate backport").
  if (lanes.length && lanes.every((l) => db.get('SELECT phase FROM lanes WHERE session_id = ? AND branch = ?', sid, l.branch).phase === 'done')
      && plan.pendingComments(sid).some((c) => c.state.status === 'pending') && !jobs.activeJob(sid, null)) {
    jobs.enqueue(sid, null, 'post-comments'); steps.push({ note: 'post queued PR comments' });
  }
  return steps;
}

/** Start queued jobs, respecting the Claude worker limit. */
export function dispatch(running) {
  const queued = db.all(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id`);
  const started = [];
  for (const j0 of queued) {
    const j = jobs.job(j0.id); const cfg = db.session(j.session_id).config;
    if (j.runner === 'claude') {
      if (cfg.runner === 'interactive') continue;
      const busy = db.get(`SELECT COUNT(*) n FROM jobs WHERE runner = 'claude' AND status = 'running' AND claimed_by = 'server'`).n;
      if (busy >= (cfg.maxClaudeWorkers || 1)) continue;
    }
    if (j.branch && db.get(`SELECT 1 FROM jobs WHERE session_id = ? AND branch = ? AND status = 'running' AND id != ?`, j.session_id, j.branch, j.id)) continue;
    const child = jobs.launch(j, cfg);
    if (child) { running.set(j.id, child); started.push(j.id); }
  }
  return started;
}

/** Jobs left "running" by a server that died. */
export function recover() {
  for (const j of db.all(`SELECT id, pid, claimed_by FROM jobs WHERE status = 'running' AND claimed_by = 'server'`)) {
    let alive = false; try { if (j.pid) { process.kill(j.pid, 0); alive = true; } } catch { /* gone */ }
    if (!alive) jobs.finish(j.id, 'failed', { error: 'the server restarted while the job was running' });
  }
}
