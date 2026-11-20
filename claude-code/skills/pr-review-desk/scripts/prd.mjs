#!/usr/bin/env node
// prd — the pr-review-desk engine. State in SQLite ($PRD_HOME, default ~/.claude/pr-review-desk), GitHub through
// the gh CLI, AI work through Claude Code workers, the human's decisions through the web UI (prd serve).
// Staging and submitting reviews exist only in the web UI: no CLI command posts to GitHub.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as db from './lib/db.mjs';
import * as cfgm from './lib/config.mjs';
import * as triage from './lib/triage.mjs';
import * as review from './lib/review.mjs';
import * as jobs from './lib/jobs.mjs';
import * as autopilot from './lib/autopilot.mjs';
import { addRepo, here, parsePrRef } from './lib/repos.mjs';
import { scanSummary } from './lib/scan.mjs';
import { serve, token } from './lib/server.mjs';
import { urlFor } from './lib/listen.mjs';

const argv = process.argv.slice(2);
function opts(list) {
  const o = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) o[k] = v;
      else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) o[k] = list[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const die = (m) => { console.error(m); process.exit(1); };
const readText = (o, key = 'body') => (o[`${key}-file`] ? fs.readFileSync(o[`${key}-file`], 'utf8') : o[key] ?? o.text);

async function repoOf(o) {
  if (o.repo) return addRepo(o.repo).slug;
  if (process.env.PRD_JOB) return jobs.job(Number(process.env.PRD_JOB)).repo;
  return (await here(process.cwd())).slug;
}

function serverInfo() {
  const s = db.J(db.meta('server'));
  if (!s) return null;
  try { process.kill(s.pid, 0); } catch { return null; }
  const urls = (s.addresses || ['127.0.0.1']).map((a) => urlFor(a, s.port, token()));
  return { ...s, url: urls[0], urls };
}

function ensureServer(port = null) {
  const s = serverInfo(); if (s) return s;
  const log = path.join(db.HOME, 'server.log');
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, 'prd.mjs'), 'serve', ...(port ? ['--port', String(port)] : [])],
    { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PRD_JOB: '' } });
  child.unref();
  for (let i = 0; i < 40; i++) { spawnSync('sleep', ['0.25']); const x = serverInfo(); if (x && x.pid === child.pid) return { ...x, log }; }
  die(`the server did not start; see ${log}`);
}

function inJobGuard(what) {
  if (process.env.PRD_JOB) die(`refused: ${what} is the human's action (web UI only), not a worker's`);
}

function summary(slug) {
  const rows = db.all('SELECT lane, COUNT(*) n FROM items WHERE repo = ? GROUP BY lane', slug);
  const by = Object.fromEntries(rows.map((r) => [r.lane, r.n]));
  return triage.LANES.filter((l) => by[l]).map((l) => `${triage.LANE_TITLES[l]}: ${by[l]}`).join(' · ');
}

const HELP = `prd — pr-review-desk engine

  doctor                                   gh login, database, server, budget
  serve [--port 8766] [--open]             run the web UI in the foreground
  ui [--open]                              start the UI in the background if needed and print its link
  url [--open]                             the running server's link (exit 1 when it is not running)
  repo add [owner/repo] [--checkout DIR --remote NAME] | repo list | repo autopilot <slug> on|off
  repo config <slug> --json '{...}'        merge into the repo's rules (see lib/config.mjs)
  triage [--repo o/r] [--full]             sync, scan, apply rules; prints the lanes
  track <N|URL>... [--repo o/r] [--review] fetch PRs now; --review queues an AI review
  list [--lane L] [--repo o/r]             items by priority
  show <N> [--repo o/r]                    one PR: lane, reasons, gate, review round
  scan <N> [--repo o/r]                    run the security scan of the current head
  import-prt [--repo o/r]                  migrate pr-review-track drafts and tracked repos
  tick [--force]                           one autopilot pass without the server

Worker commands (inside a job):
  job show <id> | job claim [--wait SEC] | job done <id> --summary "…" | job fail <id> --reason "…"
  job ask <id> --question "…" | job worktree <id> | job list | job log <id> | job cancel <id>
  gate <job> clear|suspicious|inconclusive --evidence "…"
  review import <job> --findings FILE      draft from pr-review findings.json
  review body <job> --body-file FILE       replace the draft's summary (revise jobs)
  comment set <id> --body-file FILE | comment add <job> --path P --line N [--side LEFT] [--start-line N] --body-file FILE
  comment exclude <id> | comment include <id>`;

async function main() {
  const [cmd, sub, ...rest] = argv;
  const o = opts(argv.slice(1));
  db.open();
  switch (cmd) {
    case undefined: case 'help': case '--help': return out(HELP);
    case 'doctor': {
      const g = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
      const s = serverInfo();
      out([`gh: ${g.status === 0 ? 'logged in' : `NOT logged in: ${(g.stderr || '').trim().split('\n')[0]}`}`, `login: ${g.status === 0 ? await triage.login() : '?'}`,
        `database: ${db.DB_PATH}`, `repos: ${db.all('SELECT slug FROM repos').map((r) => r.slug).join(', ') || 'none'}`,
        `server: ${s ? `running (pid ${s.pid}) ${s.urls.join(' ')}` : 'not running (prd ui)'}`,
        `claude: ${spawnSync(process.env.PRD_CLAUDE || 'claude', ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'NOT FOUND'}`,
        `budget: ${jobs.reviewPlan('review').budget}`].join('\n'));
      return g.status === 0 ? undefined : process.exit(1);
    }
    case 'serve': return serve({ port: o.port ? Number(o.port) : null, open: !!o.open });
    case 'url': {
      const s = serverInfo();
      if (!s) { console.error('prd server is not running; start it with: prd ui'); process.exit(1); }
      if (o.open) spawn('open', [s.url], { detached: true, stdio: 'ignore' }).unref();
      console.log(s.urls.join('\n')); return;
    }
    case 'ui': {
      const s = ensureServer(o.port ? Number(o.port) : null);
      if (o.open) spawn('open', [s.url], { detached: true, stdio: 'ignore' }).unref();
      return out(s.urls.map((u) => `pr-review-desk UI: ${u}`).join('\n'));
    }
    case 'repo': {
      const p = opts(rest);
      if (sub === 'add') {
        const r = p._[0] ? addRepo(p._[0], { checkout: p.checkout || null, remote: p.remote || null }) : await here(process.cwd());
        return out(`${r.slug}: checkout ${r.checkout || '(none: diff-only reviews)'}${r.remote ? `, remote ${r.remote}` : ''}`);
      }
      if (sub === 'list') return out(db.all('SELECT slug, checkout, remote, enabled, autopilot, synced_at FROM repos'));
      if (sub === 'autopilot') { db.run('UPDATE repos SET autopilot = ? WHERE slug = ?', p._[1] === 'on' ? 1 : 0, p._[0]); return out(`autopilot ${p._[1]} for ${p._[0]}`); }
      if (sub === 'config') {
        const r = db.repo(p._[0]);
        if (p.json) db.run('UPDATE repos SET config = ? WHERE slug = ?', db.S(cfgm.apply(r.config, JSON.parse(p.json))), r.slug);
        return out(cfgm.effective(db.repo(r.slug).config));
      }
      return die('repo add|list|autopilot|config');
    }
    case 'triage': {
      const slug = await repoOf(o);
      const steps = await autopilot.tickRepo(slug, { force: true });
      if (o.full) await triage.sync(slug, { full: true });
      out(`${slug}: ${steps.join('; ')}\n${summary(slug)}`);
      const top = db.all(`SELECT i.number, i.score, i.lane, i.category, p.title, p.author FROM items i JOIN prs p USING (repo, number)
        WHERE i.repo = ? AND i.lane IN ('backlog','follow-up','check','security') ORDER BY CASE i.lane WHEN 'security' THEN 0 WHEN 'check' THEN 1 WHEN 'follow-up' THEN 2 ELSE 3 END, i.score DESC LIMIT 15`, slug);
      for (const t of top) out(`  ${t.lane.padEnd(10)} #${t.number} ${String(t.score).padStart(5)}  [${t.category}] ${t.title.slice(0, 90)} — ${t.author}`);
      const s = serverInfo();
      return out(s ? `UI: ${s.url}` : 'UI: run `prd ui` (or the skill starts it)');
    }
    case 'track': {
      const refs = o._;   // positional arguments only (option values such as --repo's are not refs)
      for (const ref of refs) {
        const p = parsePrRef(ref);
        const slug = p.repo ? addRepo(p.repo).slug : await repoOf(o);
        const it = await triage.track(slug, p.number);
        await triage.scan(slug, p.number).catch((e) => out(`scan failed: ${e.message}`));
        const after = db.item(slug, p.number);
        let line = `${slug}#${p.number}: lane ${after.lane}, score ${it.score}, gate ${after.gate} (${scanSummary(after.scan)})`;
        if (o.review) {
          if (['flagged', 'suspicious'].includes(after.gate)) line += ' — NOT queued: security hold; look at the evidence in the UI';
          else line += `, queued job ${jobs.enqueue(slug, p.number, db.pr(slug, p.number).analysis?.myLastReview ? 're-review' : 'review', { instructions: o.instructions || null })}`;
        }
        out(line);
      }
      return;
    }
    case 'list': {
      const slug = await repoOf(o);
      const rows = db.all(`SELECT i.number, i.lane, i.score, i.category, i.gate, p.title, p.author FROM items i JOIN prs p USING (repo, number)
        WHERE i.repo = ? AND (? IS NULL OR i.lane = ?) AND i.lane != 'done' ORDER BY i.score DESC LIMIT ?`, slug, o.lane || null, o.lane || null, Number(o.limit || 40));
      return out(o.json ? rows : rows.map((r) => `${r.lane.padEnd(10)} #${r.number} ${String(r.score).padStart(5)} ${r.gate.padEnd(9)} [${r.category}] ${r.title.slice(0, 80)} — ${r.author}`).join('\n'));
    }
    case 'show': {
      const p = parsePrRef(sub); const slug = p.repo || await repoOf(o);
      const pr = db.pr(slug, p.number); const it = db.item(slug, p.number); const rv = db.currentReview(slug, p.number);
      if (!pr) die('not on the desk; prd track it first');
      return out({ pr: { number: pr.number, title: pr.title, author: pr.author, head: pr.head_sha, state: pr.state }, lane: it.lane, score: it.score, reasons: it.reasons,
        flags: it.flags, gate: { state: it.gate, by: it.gate_by, note: it.gate_note, scan: scanSummary(it.scan) },
        review: rv ? { id: rv.id, status: rv.status, comments: db.comments(rv.id).length } : null });
    }
    case 'scan': {
      const p = parsePrRef(sub); const slug = p.repo || await repoOf(o);
      const it = await triage.scan(slug, p.number);
      return out({ gate: it.gate, summary: scanSummary(it.scan), hits: it.scan.hits, surfaces: it.scan.surfaces });
    }
    case 'import-prt': {
      const { importPrt } = await import('./lib/importprt.mjs');
      const r = await importPrt({ repo: o.repo || null });
      return out(`imported ${r.drafts} draft(s), ${r.ignored} skipped-as-ignored, ${r.repos} new repo(s)${r.skipped.length ? `\nnot imported:\n  ${r.skipped.join('\n  ')}` : ''}`);
    }
    case 'tick': return out((await autopilot.tick({ force: !!o.force })).join('\n') || 'nothing to do');
    case 'gate': {
      const j = jobs.job(Number(sub)); const p = opts(rest); const g = p._[0];
      if (!['clear', 'suspicious', 'inconclusive'].includes(g)) die('gate <job> clear|suspicious|inconclusive --evidence "…"');
      if (!p.evidence) die('--evidence is required');
      const it = db.item(j.repo, j.number);
      if (g === 'clear' && it.gate === 'flagged' && it.gate_sha === j.head_sha) die('refused: the security scan flagged this head; only the human can clear it (web UI)');
      if (it.gate_by === 'user' && it.gate_sha === j.head_sha) return out(`the human already decided "${it.gate}" for this head; kept`);
      db.run(`UPDATE items SET gate = ?, gate_sha = ?, gate_by = 'model', gate_note = ?, updated_at = ? WHERE repo = ? AND number = ?`, g, j.head_sha, p.evidence, db.now(), j.repo, j.number);
      db.event(j.repo, j.number, `#${j.number}: security gate ${g} (model): ${p.evidence}`, { job: j.id, level: g === 'clear' ? 'info' : 'security' });
      triage.refreshItem(j.repo, j.number);
      return out(g === 'clear' ? `gate clear; a worktree is available with: prd job worktree ${j.id}` : `gate ${g}: static review only. Do not build, run tests or execute anything from this PR.`);
    }
    case 'review': {
      const p = opts(rest);
      if (sub === 'import') {
        const j = jobs.job(Number(p._[0]));
        const f = JSON.parse(fs.readFileSync(p.findings, 'utf8'));
        const it = db.item(j.repo, j.number);
        const r = await review.importFindings(j.repo, j.number, f, { jobId: j.id, kind: j.type === 're-review' ? 're-review' : 'initial',
          basisAt: j.started_at || j.created_at,
          gate: { state: it.gate, by: it.gate_by, note: it.gate_note } });
        triage.refreshItem(j.repo, j.number);
        return out(r);
      }
      if (sub === 'body') {
        const j = jobs.job(Number(p._[0])); const rv = db.currentReview(j.repo, j.number);
        if (!rv) die('no review round');
        review.setBody(rv.id, readText(p), `job ${j.id}`);
        return out(`review ${rv.id} body updated`);
      }
      if (sub === 'stage' || sub === 'submit') inJobGuard(`review ${sub}`);
      return die('review import|body (staging and submitting are in the web UI)');
    }
    case 'comment': {
      const p = opts(rest);
      if (sub === 'set') return out(await review.updateComment(Number(p._[0]), { body: readText(p), by: process.env.PRD_JOB ? `job ${process.env.PRD_JOB}` : 'cli' }));
      if (sub === 'exclude' || sub === 'include') return out(await review.updateComment(Number(p._[0]), { include: sub === 'include' }));
      if (sub === 'add') {
        const j = jobs.job(Number(p._[0])); const rv = db.currentReview(j.repo, j.number);
        if (!rv) die('no review round');
        const id = await review.addComment(rv.id, { path: p.path, line: p.line, startLine: p['start-line'], side: p.side, kind: p.file ? 'file' : undefined, body: readText(p) });
        db.run(`UPDATE comments SET source = 'ai', body_ai = body WHERE id = ?`, id);
        return out(`comment ${id} added`);
      }
      return die('comment set|add|include|exclude');
    }
    case 'job': {
      const p = opts(rest);
      if (sub === 'list') return out(db.all(`SELECT id, repo, number, type, status, claimed_by, created_at FROM jobs ORDER BY id DESC LIMIT 30`));
      if (sub === 'show') return out(await jobs.context(Number(p._[0])));
      if (sub === 'worktree') return out(jobs.worktree(Number(p._[0])));
      if (sub === 'log') return out(jobs.readLog(Number(p._[0])).lines.map((l) => `${l.kind}: ${l.text}`).join('\n'));
      if (sub === 'cancel') { jobs.cancel(Number(p._[0])); return out('cancelled'); }
      if (sub === 'claim') {
        const until = Date.now() + Number(p.wait || 0) * 1000;
        for (;;) {
          const j = jobs.claim(p.as || 'interactive');
          if (j) return out({ prompt: jobs.workerPrompt(j), context: await jobs.context(j.id) });
          if (Date.now() >= until) return out('no queued jobs');
          spawnSync('sleep', ['5']);
        }
      }
      const id = Number(p._[0]); const j = jobs.job(id);
      if (sub === 'done') { jobs.finish(id, 'done', { summary: p['summary-file'] ? fs.readFileSync(p['summary-file'], 'utf8') : p.summary || '' }); return out(`job ${id} done`); }
      if (sub === 'fail') { jobs.finish(id, 'failed', { error: p.reason || 'no reason given' }); return out(`job ${id} failed`); }
      if (sub === 'ask') { jobs.finish(id, 'waiting', { question: p.question }); return out(`job ${id} waits for the user's answer in the UI (${j.repo}#${j.number})`); }
      return die('job list|show|claim|done|fail|ask|worktree|log|cancel');
    }
    default: die(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die(e.stack && process.env.PRD_DEBUG ? e.stack : `prd: ${e.message}`));
