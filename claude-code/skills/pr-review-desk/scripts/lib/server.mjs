// Local web UI. Binds to 127.0.0.1 unless servers.yaml lists more addresses (lib/listen.mjs) and checks the Host header; every API call needs the token printed at
// startup (it travels in the URL fragment, so it never reaches a server log or a Referer). Staging and
// submitting reviews happen only here, on the human's click.
import http from 'node:http';
import { listenConfig, listenAll, allowedHosts, hostOf, urlFor } from './listen.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import * as cfgm from './config.mjs';
import * as triage from './triage.mjs';
import * as review from './review.mjs';
import * as jobs from './jobs.mjs';
import * as autopilot from './autopilot.mjs';
import * as ci from './ci.mjs';
import { scanSummary } from './scan.mjs';
import { followUpReasons, draftStaleness } from './triage.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export const DEFAULT_PORT = Number(process.env.PRD_PORT || 8766);

export function token() {
  return db.meta('token') || db.meta('token', crypto.randomBytes(18).toString('base64url'));
}

function repoSummary(r) {
  const lanes = Object.fromEntries(db.all('SELECT lane, COUNT(*) n FROM items WHERE repo = ? GROUP BY lane', r.slug).map((x) => [x.lane, x.n]));
  return { slug: r.slug, checkout: r.checkout, remote: r.remote, enabled: !!r.enabled, autopilot: !!r.autopilot, synced_at: r.synced_at,
    sync_error: r.sync_error, syncing: triage.isSyncing(r.slug), lanes, config: db.J(r.config, {}), effective: cfgm.effective(db.J(r.config, {})) };
}

function state() {
  return {
    login: db.meta('login'), repos: db.all('SELECT * FROM repos ORDER BY slug').map(repoSummary), budget: db.J(db.meta('budget')),
    lanes: triage.LANES.map((id) => ({ id, title: triage.LANE_TITLES[id] })),
    jobs: db.all(`SELECT id, repo, number, type, status, claimed_by, created_at, started_at FROM jobs WHERE status IN ('queued','running','waiting') ORDER BY id`),
  };
}

function items(repo, lane) {
  const where = [repo ? 'i.repo = ?' : '1=1', lane ? 'i.lane = ?' : `i.lane != 'done'`];
  const rows = db.all(`SELECT i.*, p.title, p.url, p.author, p.association, p.draft, p.head_sha, p.additions, p.deletions, p.changed_files, p.labels, p.ci,
      p.updated_at, p.created_at pr_created_at, p.state, p.analysis
    FROM items i JOIN prs p ON p.repo = i.repo AND p.number = i.number WHERE ${where.join(' AND ')} ORDER BY i.score DESC LIMIT 400`,
  ...[repo, lane].filter(Boolean));
  return rows.map((x) => {
    const a = db.J(x.analysis, {}) || {};
    const rv = db.currentReview(x.repo, x.number);
    const cs = rv ? db.comments(rv.id) : [];
    const job = jobs.activeJob(x.repo, x.number);
    return { repo: x.repo, number: x.number, title: x.title, url: x.url, author: x.author, association: x.association, draft: !!x.draft,
      lane: x.lane, score: x.score, reasons: db.J(x.reasons, []), flags: db.J(x.flags, []), category: x.category, component: x.component,
      size: (x.additions || 0) + (x.deletions || 0), files: x.changed_files, labels: db.J(x.labels, []), ci: x.ci, updated_at: x.updated_at,
      gate: x.gate, gateCurrent: x.gate_sha === x.head_sha, scan: scanSummary(db.J(x.scan)), scanLevel: db.J(x.scan)?.level || null,
      hold: x.hold, hold_until: x.hold_until, note: x.note,
      myLast: a.myLastReview ? { state: a.myLastReview.state, at: a.myLastReview.submittedAt, oid: a.myLastReview.oid } : null, headMoved: !!a.headMoved,
      followUp: followUpReasons(a, x.author, { draft: rv?.status === 'draft' ? rv : null, pr: { head_sha: x.head_sha, analysis: a } }),
      threads: a.threadCounts || {},
      review: rv ? { id: rv.id, status: rv.status, kind: rv.kind, stale: draftStaleness(rv, { head_sha: x.head_sha, analysis: a }).length > 0, comments: cs.filter((c) => c.include && c.state !== 'removed').length,
        staged: cs.filter((c) => c.state === 'staged').length, recommended: rv.recommended_event } : null,
      job: job ? { id: job.id, type: job.type, status: job.status } : null };
  });
}

function prView(repo, number) {
  const pr = db.pr(repo, number); if (!pr) throw new Error(`${repo}#${number} not on the desk`);
  const it = db.item(repo, number);
  const rounds = db.all('SELECT id FROM reviews WHERE repo = ? AND number = ? ORDER BY id DESC', repo, number).map((r) => db.review(r.id));
  const cur = rounds.find((r) => r.status !== 'discarded') || null;
  return {
    pr: { ...pr, body: pr.body }, item: { ...it, scanSummary: scanSummary(it.scan) },
    review: cur ? { ...cur, comments: db.comments(cur.id), lints: review.outgoing(cur.id), stale: draftStaleness(cur, pr) } : null,
    rounds: rounds.map((r) => ({ id: r.id, kind: r.kind, status: r.status, head_sha: r.head_sha, event: r.event, created_at: r.created_at, submitted_at: r.submitted_at, gh_url: r.gh_url })),
    jobs: db.all('SELECT id, type, status, args, result, created_at, finished_at, head_sha FROM jobs WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT 20', repo, number)
      .map((j) => ({ ...j, args: db.J(j.args, {}), result: db.J(j.result) })),
    events: db.all('SELECT * FROM events WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT 60', repo, number),
    execAllowed: jobs.execAllowed(repo, number, pr.head_sha),
  };
}

const ACTIONS = {
  sync: async (a) => ({ steps: await autopilot.tickRepo(a.repo, { force: true }) }),
  track: async (a) => triage.track(a.repo, Number(a.number)),
  scan: async (a) => triage.scan(a.repo, Number(a.number)),
  review: (a) => {
    const n = Number(a.number); const it = db.item(a.repo, n);
    const type = ['review', 're-review'].includes(a.type) ? a.type : (db.pr(a.repo, n).analysis?.myLastReview ? 're-review' : 'review');
    return { job: jobs.enqueue(a.repo, n, type, { instructions: a.instructions || null, static: it.gate !== 'clear' }) };
  },
  revise: (a) => ({ job: jobs.enqueue(a.repo, Number(a.number), 'revise', { instructions: a.instructions, scope: a.scope || null }) }),
  ask: (a) => ({ job: jobs.enqueue(a.repo, Number(a.number), 'ask', { instructions: a.instructions }) }),
  hold: (a) => {
    const hold = a.hold || null;
    const until = hold === 'snoozed' ? new Date(Date.now() + (Number(a.days) || 3) * 86400000).toISOString() : null;
    db.run('UPDATE items SET hold = ?, hold_until = ?, hold_note = ?, updated_at = ? WHERE repo = ? AND number = ?', hold, until, a.note || null, db.now(), a.repo, Number(a.number));
    db.event(a.repo, Number(a.number), hold ? `#${a.number} ${hold}${until ? ` until ${until.slice(0, 10)}` : ''}${a.note ? `: ${a.note}` : ''}` : `#${a.number} back in triage`);
    return triage.refreshItem(a.repo, Number(a.number));
  },
  gate: (a) => {
    if (!['clear', 'suspicious'].includes(a.gate)) throw new Error('gate must be clear or suspicious');
    const pr = db.pr(a.repo, Number(a.number));
    if (!a.note?.trim()) throw new Error('say why (what you checked)');
    db.run(`UPDATE items SET gate = ?, gate_sha = ?, gate_by = 'user', gate_note = ?, updated_at = ? WHERE repo = ? AND number = ?`,
      a.gate, pr.head_sha, a.note, db.now(), a.repo, Number(a.number));
    db.event(a.repo, Number(a.number), `#${a.number}: you marked head ${pr.head_sha.slice(0, 10)} ${a.gate}: ${a.note}`, { level: a.gate === 'clear' ? 'info' : 'security' });
    return triage.refreshItem(a.repo, Number(a.number));
  },
  note: (a) => { db.run('UPDATE items SET note = ? WHERE repo = ? AND number = ?', a.note || null, a.repo, Number(a.number)); return {}; },
  'start-manual': async (a) => ({ review: await review.startManual(a.repo, Number(a.number)) }),
  discard: async (a) => { await review.discard(Number(a.review)); return {}; },
  stage: async (a) => review.stage(Number(a.review)),
  'sync-staged': async (a) => review.syncStaged(Number(a.review)),
  submit: async (a) => {
    const rid = Number(a.review);
    const want = a.event === 'APPROVE' ? { approveRuns: !!a.ci?.approveRuns, updateBranch: !!a.ci?.updateBranch } : {};
    const rv = db.review(rid);
    if (want.approveRuns || want.updateBranch) {
      const it = db.item(rv.repo, rv.number); const pr = db.pr(rv.repo, rv.number);
      if (['flagged', 'suspicious'].includes(it.gate) && it.gate_sha === pr.head_sha) throw new Error(`the security gate is "${it.gate}": refusing to approve workflow runs or update the branch`);
    }
    const r = await review.submit(rid, { event: a.event, body: a.body });
    if (r.submittedOnGitHub || !(want.approveRuns || want.updateBranch)) return r;
    const head = db.pr(rv.repo, rv.number).head_sha; r.ci = {};
    if (want.updateBranch) {
      try {
        await ci.updateBranch(rv.repo, rv.number, head);
        r.ci.updateBranch = 'requested';
        db.event(rv.repo, rv.number, `#${rv.number}: requested "Update branch"; workflow runs on the new head will be approved as they appear`);
        ci.followUp(rv.repo, rv.number, head, { onDone: () => triage.track(rv.repo, rv.number).catch(() => {}) })
          .catch((e) => db.event(rv.repo, rv.number, `#${rv.number}: branch-update follow-up failed: ${e.message}`, { level: 'warn' }));
      } catch (e) {
        r.ci.updateBranch = `failed: ${e.message.split('\n')[0]}`;
        db.event(rv.repo, rv.number, `#${rv.number}: "Update branch" failed: ${e.message.split('\n')[0]}`, { level: 'warn' });
        r.errors = [...(r.errors || []), `update branch: ${e.message.split('\n')[0]}`];
      }
    }
    // Runs on the reviewed head still need approval when the branch is not updated (or the update failed).
    if (want.approveRuns && r.ci.updateBranch !== 'requested') {
      const ap = await ci.approveRuns(rv.repo, head).catch((e) => ({ approved: [], errors: [e.message] }));
      r.ci.approved = ap.approved;
      if (ap.approved.length) db.event(rv.repo, rv.number, `#${rv.number}: approved ${ap.approved.length} workflow run(s): ${ap.approved.join(', ')}`);
      if (ap.errors.length) r.errors = [...(r.errors || []), ...ap.errors.map((x) => `approve run ${x}`)];
    }
    return r;
  },
  body: (a) => { review.setBody(Number(a.review), a.body); return {}; },
  ack: (a) => { review.ackLints(Number(a.review), a.labels || []); return review.outgoing(Number(a.review)); },
  'comment-add': async (a) => ({ id: await review.addComment(Number(a.review), a) }),
  'comment-update': async (a) => review.updateComment(Number(a.id), a.patch || {}),
  'comment-remove': async (a) => { await review.removeComment(Number(a.id)); return {}; },
  'comment-note': (a) => { db.run(`UPDATE comments SET meta = json_set(meta, '$.note', ?) WHERE id = ?`, a.note || null, Number(a.id)); return {}; },
  'cancel-job': (a) => { jobs.cancel(Number(a.job)); return {}; },
  'reply-job': (a) => { jobs.reply(Number(a.job), a.text); return {}; },
  budget: () => jobs.budget({ fresh: true }),
  repo: (a) => {
    const r = db.repo(a.slug);
    const cfg = a.config ? cfgm.apply(db.J(r.config, {}), a.config) : db.J(r.config, {});
    db.run('UPDATE repos SET checkout = ?, remote = ?, enabled = ?, autopilot = ?, config = ? WHERE slug = ?',
      a.checkout !== undefined ? a.checkout || null : r.checkout, a.remote !== undefined ? a.remote || null : r.remote,
      a.enabled !== undefined ? (a.enabled ? 1 : 0) : r.enabled, a.autopilot !== undefined ? (a.autopilot ? 1 : 0) : r.autopilot, db.S(cfg), a.slug);
    if (a.autopilot !== undefined) db.event(a.slug, null, `Autopilot ${a.autopilot ? 'on' : 'off'} for ${a.slug}`);
    return repoSummary(db.repo(a.slug));
  },
  'open-editor': (a) => { spawn('code', [a.path], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return {}; },
};

async function readBody(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 2e6) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

export function serve({ port = null, open = false } = {}) {
  db.open(); jobs.recover();
  const tok = token();
  const lc = listenConfig('prd', { port: port || process.env.PRD_PORT || null, defaultPort: 8766 });
  const allowed = allowedHosts(lc.bind);
  const running = new Map();
  const locks = new Map();   // one GitHub-writing action per PR at a time
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!allowed.has(hostOf(req.headers.host))) { res.writeHead(403).end('bad host'); return; }
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!url.pathname.startsWith('/api/')) {
      const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const p = path.join(WEB, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
      if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'", 'x-frame-options': 'DENY' });
      res.end(fs.readFileSync(p)); return;
    }
    if (req.headers['x-prd-token'] !== tok) { send(401, { error: 'missing or wrong token; open the URL printed by prd serve' }); return; }
    const q = Object.fromEntries(url.searchParams);
    const ep = url.pathname.slice(5);
    try {
      if (req.method === 'GET') {
        if (ep === 'state') return send(200, state());
        if (ep === 'items') return send(200, items(q.repo || null, q.lane || null));
        if (ep === 'pr') return send(200, prView(q.repo, Number(q.number)));
        if (ep === 'ci') return send(200, await ci.status(q.repo, Number(q.number)));
        if (ep === 'diff') return send(200, await review.diffView(q.repo, Number(q.number), q.sha || null));
        if (ep === 'rules') return send(200, autopilot.ruleCandidates(q.repo));
        if (ep === 'events') return send(200, db.all(`SELECT * FROM events WHERE (? IS NULL OR repo = ?) AND id > ? ORDER BY id DESC LIMIT 300`, q.repo || null, q.repo || null, Number(q.after || 0)));
        if (ep === 'jobs') return send(200, db.all('SELECT id, repo, number, type, status, args, result, created_at, started_at, finished_at, claimed_by FROM jobs ORDER BY id DESC LIMIT 150').map((j) => ({ ...j, args: db.J(j.args, {}), result: db.J(j.result) })));
        if (ep === 'job-log') return send(200, jobs.readLog(Number(q.id), Number(q.offset || 0)));
      }
      if (req.method === 'POST' && ep === 'action') {
        const a = await readBody(req); const fn = ACTIONS[a.action];
        if (!fn) return send(400, { error: `unknown action ${a.action}` });
        const key = a.review ? `r${a.review}` : a.id ? `c${a.id}` : a.number ? `${a.repo}#${a.number}` : null;
        const writes = ['stage', 'submit', 'sync-staged', 'discard', 'comment-update', 'comment-remove'].includes(a.action);
        if (writes && key) {
          if (locks.get(key)) return send(409, { error: 'another GitHub action on this review is still running' });
          locks.set(key, true);
        }
        try { const r = await fn(a); dispatch(); return send(200, r ?? {}); } finally { if (writes && key) locks.delete(key); }
      }
      send(404, { error: 'no such endpoint' });
    } catch (e) { send(e.code === 'STALE' ? 409 : 400, { error: e.message, code: e.code || null }); }
  };
  function dispatch() {
    try { jobs.reapOrphans(running); jobs.dispatch(running); } catch (e) { console.error(`dispatch: ${e.message}`); }
    for (const [id, c] of running) if (c.exitCode !== null) running.delete(id);
  }
  setInterval(dispatch, 10_000).unref?.();
  const loop = () => autopilot.tick().then((s) => s.length && console.log(s.join('\n'))).catch((e) => console.error(`tick: ${e.message}`)).finally(dispatch);
  setInterval(loop, 60_000).unref?.();
  const server = listenAll(() => http.createServer((req, res) => { handle(req, res).catch((e) => { res.writeHead(500).end(e.message); }); }), lc, (addresses) => {
    db.meta('server', JSON.stringify({ pid: process.pid, port: lc.port, addresses, at: db.now() }));
    const links = addresses.map((a) => urlFor(a, lc.port, tok));
    console.log(`${links.map((l) => `pr-review-desk UI: ${l}`).join('\n')}\nstate: ${db.DB_PATH}`);
    if (open) spawn('open', [links[0]], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    loop();
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
