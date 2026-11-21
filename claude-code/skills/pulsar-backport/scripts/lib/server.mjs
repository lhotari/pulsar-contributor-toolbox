// Local web UI and job runner. Binds to 127.0.0.1 only; every API call needs the token printed at startup.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import * as plan from './plan.mjs';
import * as lane from './lane.mjs';
import * as jobs from './jobs.mjs';
import * as autopilot from './autopilot.mjs';
import * as control from './control.mjs';
import * as review from './review.mjs';
import * as report from './report.mjs';
import { listenConfig, listenAll, allowedHosts, hostOf, urlFor } from './listen.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** The running server (pid alive) and its link, or null. */
export function serverInfo() {
  const row = db.get(`SELECT value FROM meta WHERE key = 'server'`);
  const s = row ? JSON.parse(row.value) : null;
  if (!s) return null;
  try { process.kill(s.pid, 0); } catch { return null; }
  const urls = (s.addresses || ['127.0.0.1']).map((a) => urlFor(a, s.port, token()));
  return { ...s, url: urls[0], urls };
}

export function token() {
  const t = db.get(`SELECT value FROM meta WHERE key = 'token'`);
  if (t) return t.value;
  const v = crypto.randomBytes(18).toString('base64url');
  db.run(`INSERT INTO meta (key, value) VALUES ('token', ?)`, v);
  return v;
}

function sessionSummary(sid) {
  const s = db.session(sid);
  const lanes = db.all('SELECT * FROM lanes WHERE session_id = ? ORDER BY seq', sid).map((l) => {
    const p = lane.lanePicks(sid, l.branch);
    const count = (st) => p.filter((x) => x.status === st).length;
    return { ...l, ci: db.J(l.ci, {}), picks: { total: p.length, picked: count('picked'), pending: count('pending'), conflict: count('conflict'),
      blocked: count('blocked'), needsFix: count('needs-fix'), skipped: count('skipped'), empty: count('empty') } };
  });
  const decisions = db.all(`SELECT branch, decision, decision_source source, COUNT(*) n FROM targets t JOIN items i ON i.session_id = t.session_id AND i.pr = t.pr
     WHERE t.session_id = ? AND t.on_branch = 0 AND i.excluded IS NULL GROUP BY branch, decision, decision_source`, sid);
  const verdicts = db.all(`SELECT branch, IFNULL(verdict,'untriaged') verdict, COUNT(*) n FROM targets t JOIN items i ON i.session_id = t.session_id AND i.pr = t.pr
     WHERE t.session_id = ? AND t.on_branch = 0 AND i.excluded IS NULL GROUP BY branch, verdict`, sid);
  // Hints that matter: the PR is (or may be) going in, and the dependency is neither on the branch nor already decided "backport".
  const review = db.get(`SELECT SUM(reviewed_at IS NOT NULL) reviewed, COUNT(*) total FROM items i WHERE session_id = ? AND excluded IS NULL
     AND EXISTS (SELECT 1 FROM targets t WHERE t.session_id = i.session_id AND t.pr = i.pr AND t.on_branch = 0)`, sid);
  const openDeps = db.get(`SELECT COUNT(DISTINCT d.pr || '>' || d.depends_on) n FROM deps d
     JOIN targets t ON t.session_id = d.session_id AND t.pr = d.pr AND (d.branch IS NULL OR t.branch = d.branch)
     LEFT JOIN targets dt ON dt.session_id = d.session_id AND dt.pr = d.depends_on AND dt.branch = t.branch
     WHERE d.session_id = ? AND d.status = 'open' AND t.on_branch = 0
       AND (t.decision = 'backport' OR (t.decision = 'undecided' AND t.verdict IN ('pick', 'maybe')))
       AND IFNULL(dt.on_branch, 0) = 0 AND IFNULL(dt.decision, '') != 'backport'`, sid).n;
  const activeJobs = db.all(`SELECT id, branch, type, runner, status, args, result, claimed_by, started_at FROM jobs WHERE session_id = ? AND status IN ('queued','running','waiting') ORDER BY id`, sid)
    .map((j) => ({ ...j, args: db.J(j.args, {}), result: db.J(j.result) }));
  const comments = { pending: plan.pendingComments(sid).length,
    posted: db.get(`SELECT COUNT(*) n FROM items WHERE session_id = ? AND json_extract(comment_state, '$.status') = 'posted'`, sid).n };
  let needed = [];
  try { needed = control.list(sid); } catch (e) { needed = [{ key: 'error', kind: 'error', title: 'Could not compute the open decisions', text: e.message, options: [] }]; }
  return { ...s, lanes, decisions, verdicts, openDeps, activeJobs, review, comments, needed };
}

const ACTIONS = {
  discover: (sid) => ({ job: jobs.enqueue(sid, null, 'discover') }),
  triage: (sid, b, a) => ({ job: jobs.enqueue(sid, null, 'triage', { instructions: a.instructions }) }),
  'post-comments': (sid) => ({ job: jobs.enqueue(sid, null, 'post-comments') }),
  'apply-labels': (sid, b, a) => ({ job: jobs.enqueue(sid, null, 'apply-labels', { removals: !!a.removals }) }),
  report: (sid) => {
    const file = path.join(db.BPT_HOME, `${sid}-plan-${db.now().slice(0, 10)}.md`);
    fs.writeFileSync(file, plan.report(sid));
    spawn('code', [file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return { file };
  },
  'start-backport': (sid) => {
    db.run(`UPDATE sessions SET status = 'backporting', updated_at = ? WHERE id = ?`, db.now(), sid);
    db.event(sid, 'Backporting started'); return { steps: autopilot.advance(sid) };
  },
  'stop-backport': (sid) => { db.run(`UPDATE sessions SET status = 'planning' WHERE id = ?`, sid); plan.saveConfig(sid, { autopilot: false }); return {}; },
  // Reset every lane not yet pushed and return to planning; runs as an engine job (it deletes test branches).
  'abort-backport': (sid, b, a) => {
    db.run(`UPDATE sessions SET status = 'planning', updated_at = ? WHERE id = ?`, db.now(), sid); plan.saveConfig(sid, { autopilot: false });
    return { job: jobs.enqueue(sid, null, 'abort', { reason: a.reason || undefined }) };
  },
  advance: (sid, b, a) => ({ steps: autopilot.advance(sid, { force: !!a.force }) }),
  // lane actions
  start: (sid, b) => ({ job: jobs.enqueue(sid, b, 'start-lane') }),
  'pick-all': (sid, b) => ({ job: jobs.enqueue(sid, b, 'pick-all') }),
  resolve: (sid, b, a) => ({ job: jobs.enqueue(sid, b, 'resolve', { pr: Number(a.pr), instructions: a.instructions }) }),
  resolved: (sid, b, a) => lane.markResolved(sid, b, Number(a.pr)),
  // Skip and drop cancel the jobs working on that pick first (a running resolver is stopped).
  skip: (sid, b, a) => {
    const cancelled = control.cancelPickJobs(sid, b, Number(a.pr), `#${a.pr} skipped by the user`);
    lane.skipPick(sid, b, Number(a.pr), a.reason || 'skipped from the UI'); return { cancelled };
  },
  // A committed pick too: the lane is rebuilt from it, later picks re-applied from their lane commits.
  drop: (sid, b, a) => { control.cancelPickJobs(sid, b, Number(a.pr), `#${a.pr} dropped by the user`); control.settle(sid, b, `#${a.pr} dropped`); return lane.dropPick(sid, b, Number(a.pr), a.reason || 'dropped from the UI'); },
  'add-dep': (sid, b, a) => { control.settle(sid, b, `#${a.dep} added before #${a.pr}`); return lane.addDependency(sid, b, Number(a.pr), Number(a.dep), a.detail || 'added in the UI while backporting'); },
  'out-of-order': (sid, b, a) => { lane.pickOutOfOrder(sid, b, Number(a.pr), a.reason); return {}; },
  unblock: (sid, b, a) => ({ ok: lane.unblock(sid, b, Number(a.pr)) }),
  sync: (sid, b) => lane.syncPicks(sid, b),
  'report-open': (sid, b) => { const file = report.reportFile(sid, b); spawn('code', [file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return { file }; },
  'report-gist': (sid, b) => report.createGist(sid, b),
  'accept-review': (sid, b, a) => { review.accept(sid, b, Number(a.pr), a.reason); return {}; },
  'fix-review': (sid, b, a) => { const p = lane.lanePicks(sid, b).find((x) => x.pr === Number(a.pr)); return { job: jobs.enqueue(sid, b, 'resolve', { pr: p.pr, concerns: p.detail.review?.concerns, instructions: a.instructions || undefined }) }; },
  'review-again': (sid, b, a) => { const p = lane.lanePicks(sid, b).find((x) => x.pr === Number(a.pr)); db.run('UPDATE picks SET detail = json_remove(detail, \'$.review\') WHERE session_id = ? AND branch = ? AND pr = ?', sid, b, p.pr); return {}; },
  verify: (sid, b, a) => { lane.setPhase(sid, b, 'verifying'); return { job: jobs.enqueue(sid, b, 'verify', { instructions: a.instructions }) }; },
  'mark-verified': (sid, b) => { lane.setPhase(sid, b, 'verified', 'marked by the user'); return {}; },
  'push-test': (sid, b) => ({ job: jobs.enqueue(sid, b, 'push-test') }),
  poll: (sid, b) => lane.pollCi(sid, b),
  rerun: (sid, b) => ({ job: jobs.enqueue(sid, b, 'rerun') }),
  'fix-ci': (sid, b, a) => {
    const l = db.lane(sid, b); const kind = l.phase.startsWith('final') ? 'final' : 'test';
    return { job: jobs.enqueue(sid, b, 'fix-ci', { kind, sha: l.ci[kind]?.sha, instructions: a.instructions }) };
  },
  squash: (sid, b) => ({ job: jobs.enqueue(sid, b, 'squash') }),
  finalize: (sid, b, a) => ({ job: jobs.enqueue(sid, b, 'finalize', { allowRebase: !!a.allowRebase }) }),
  'push-final-fix': (sid, b) => ({ job: jobs.enqueue(sid, b, 'push-final-fix') }),
  phase: (sid, b, a) => { lane.setPhase(sid, b, a.phase, 'set from the UI'); return {}; },
  reset: (sid, b) => { lane.resetLane(sid, b); return {}; },
};

async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

export function serve({ port = null, open = false } = {}) {
  db.open(); autopilot.recover();
  const tok = token();
  const lc = listenConfig('bpt', { port, defaultPort: 8765 });
  const allowed = allowedHosts(lc.bind);
  const running = new Map();
  const handle = async (req, res) => {
    if (!allowed.has(hostOf(req.headers.host))) { res.writeHead(403).end('bad host'); return; }
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!url.pathname.startsWith('/api/')) {
      const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const p = path.join(WEB, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
      if (!p.startsWith(WEB) || !fs.existsSync(p)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(p)); return;
    }
    if (req.headers['x-bpt-token'] !== tok) { send(401, { error: 'missing or wrong token; open the URL printed by bpt serve' }); return; }
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
    try {
      const m = req.method;
      if (parts[0] === 'sessions' && parts.length === 1) {
        if (m === 'GET') return send(200, db.all('SELECT id, title, status, updated_at, created_at FROM sessions ORDER BY updated_at DESC'));
        if (m === 'POST') {
          const a = await body(req);
          const s = plan.createSession({ id: a.id, title: a.title, repo: a.repo || plan.DEFAULT_REPO, branches: plan.parseBranches(a.branches),
            sincePr: a.sincePr ? Number(a.sincePr) : null, sinceSha: a.sinceSha || null });
          if (a.discover !== false) jobs.enqueue(s.id, null, 'discover');
          return send(200, { id: s.id });
        }
      }
      if (parts[0] === 'sessions' && parts[1]) {
        const sid = parts[1]; const what = parts[2];
        if (!what && m === 'GET') return send(200, sessionSummary(sid));
        if (what === 'plan' && m === 'GET') return send(200, plan.planView(sid));
        if (what === 'labels' && m === 'GET') return send(200, plan.labelPlan(sid));
        if (what === 'events' && m === 'GET') {
          const after = Number(url.searchParams.get('after') || 0);
          return send(200, db.all('SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT 300', sid, after));
        }
        if (what === 'jobs' && m === 'GET') return send(200, db.all('SELECT id, branch, type, runner, status, args, result, created_at, started_at, finished_at FROM jobs WHERE session_id = ? ORDER BY id DESC LIMIT 100', sid).map((j) => ({ ...j, args: db.J(j.args, {}), result: db.J(j.result) })));
        if (what === 'lanes' && parts[3] && parts[4] === 'picks' && parts[5] && parts[6] === 'diff' && m === 'GET') return send(200, review.pickDiffs(sid, parts[3], Number(parts[5])));
        if (what === 'lanes' && parts[3] && parts[4] === 'report' && m === 'GET') return send(200, { markdown: report.laneReport(sid, parts[3]) });
        if (what === 'lanes' && parts[3] && m === 'GET') return send(200, { ...db.lane(sid, parts[3]), picks: lane.lanePicks(sid, parts[3]) });
        if (what === 'decision' && m === 'POST') {
          const a = await body(req);
          const changed = plan.setDecisions(sid, a.items || [a], { group: a.group === true });
          for (const l of db.all(`SELECT branch FROM lanes WHERE session_id = ? AND phase NOT IN ('not-started','done')`, sid)) lane.syncPicks(sid, l.branch);
          return send(200, { changed });
        }
        if (what === 'value' && m === 'POST') { const a = await body(req); plan.setValue(sid, Number(a.pr), a.value || null, a.note); return send(200, { ok: true }); }
        if (what === 'equiv' && m === 'POST') { const a = await body(req); plan.rejectEquivalent(sid, Number(a.pr), a.branch, a.rejected !== false); return send(200, { ok: true }); }
        if (what === 'review' && m === 'POST') { const a = await body(req); return send(200, { prs: plan.setReviewed(sid, a.prs || [a.pr], a.reviewed !== false) }); }
        if (what === 'comment' && m === 'POST') {
          const a = await body(req);
          const text = a.template === 'separate-backport' ? plan.separateBackportText(sid, Number(a.pr)) : a.text;
          if (a.template) return send(200, { text });
          plan.setComment(sid, Number(a.pr), text); return send(200, { ok: true });
        }
        if (what === 'note' && m === 'POST') {
          const a = await body(req);
          db.run('UPDATE targets SET note = ? WHERE session_id = ? AND pr = ? AND branch = ?', a.note, sid, Number(a.pr), a.branch);
          return send(200, { ok: true });
        }
        if (what === 'include' && m === 'POST') {
          const a = await body(req);
          db.run(`UPDATE items SET excluded = ?, stats = json_set(stats, '$.include', ?) WHERE session_id = ? AND pr = ?`,
            a.include ? null : 'manual exclude', a.include ? 1 : 0, sid, Number(a.pr));
          return send(200, { ok: true });
        }
        if (what === 'recommend' && m === 'POST') { const a = await body(req); return send(200, plan.applyRecommendations(sid, { branch: a.branch || null, all: !!a.all })); }
        if (what === 'deps' && m === 'POST') {
          const a = await body(req);
          if (a.id) lane.setDep(sid, Number(a.id), a.status);
          else {
            db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`,
              sid, Number(a.pr), Number(a.dependsOn), a.branch || null, 'manual', a.detail || 'added in the UI', 'plan', db.now());
          }
          // A dependency merged before the plan's range is not an item yet: pull it in so it can group and be picked.
          const p = plan.pullInDependencies(sid);
          if (p.added.length) for (const l of db.all(`SELECT branch FROM lanes WHERE session_id = ? AND phase != 'not-started'`, sid)) lane.syncPicks(sid, l.branch);
          return send(200, { ok: true, pulledIn: p.added, notOnMaster: p.missing });
        }
        if (what === 'config' && m === 'POST') return send(200, plan.saveConfig(sid, await body(req)));
        if (what === 'control' && m === 'GET') return send(200, control.list(sid));
        if (what === 'control' && m === 'POST') { const a = await body(req); const r = a.recommended ? control.applyRecommended(sid) : control.apply(sid, a.key, a.option, a.text); tick(); return send(200, r ?? {}); }
        if (what === 'action' && m === 'POST') {
          const a = await body(req); const fn = ACTIONS[a.action];
          if (!fn) return send(400, { error: `unknown action ${a.action}` });
          const r = fn(sid, a.branch || null, a.args || {});
          tick();
          return send(200, r ?? {});
        }
      }
      if (parts[0] === 'jobs' && parts[1]) {
        const id = Number(parts[1]);
        if (parts[2] === 'log' && m === 'GET') return send(200, jobs.readLog(id, Number(url.searchParams.get('offset') || 0)));
        if (parts[2] === 'cancel' && m === 'POST') { const c = running.get(id); if (c) c.kill('SIGTERM'); jobs.cancel(id); return send(200, { ok: true }); }
        if (parts[2] === 'reply' && m === 'POST') { const a = await body(req); jobs.reply(id, a.text); tick(); return send(200, { ok: true }); }
        if (parts[2] === 'retry' && m === 'POST') {
          const j = jobs.job(id); return send(200, { job: jobs.enqueue(j.session_id, j.branch, j.type, { ...j.args, reply: undefined }) });
        }
      }
      send(404, { error: 'no such endpoint' });
    } catch (e) { send(400, { error: e.message }); }
  };
  let ticking = false;
  function tick() {
    if (ticking) return; ticking = true;
    try {
      for (const s of db.all(`SELECT id, config FROM sessions WHERE status = 'backporting'`)) {
        if (db.J(s.config, {}).autopilot) { try { autopilot.advance(s.id); } catch (e) { db.event(s.id, `autopilot: ${e.message}`, { level: 'error' }); } }
      }
      autopilot.dispatch(running);
      for (const [id, c] of running) if (c.exitCode !== null) running.delete(id);
    } finally { ticking = false; }
  }
  setInterval(tick, 10_000).unref?.();
  const server = listenAll(() => http.createServer((req, res) => { handle(req, res).catch((e) => { res.writeHead(500).end(e.message); }); }), lc, (addresses) => {
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('server', ?)`, JSON.stringify({ pid: process.pid, port: lc.port, addresses, at: db.now() }));
    const links = addresses.map((a) => urlFor(a, lc.port, tok));
    console.log(`${links.map((l) => `bpt UI: ${l}`).join('\n')}\nstate: ${db.DB_PATH}`);
    if (open) spawn('open', [links[0]], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    tick();
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
