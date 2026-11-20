#!/usr/bin/env node
// bpt: backport planning and execution engine for apache/pulsar. State: SQLite in $BPT_HOME/database.
// Run `node bpt.mjs help` for the command list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './lib/db.mjs';
import * as g from './lib/git.mjs';
import * as plan from './lib/plan.mjs';
import * as lane from './lib/lane.mjs';
import * as jobs from './lib/jobs.mjs';
import * as autopilot from './lib/autopilot.mjs';
import * as control from './lib/control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..', '..');

const HELP = `bpt — apache/pulsar backport sessions (state: ${db.DB_PATH})

  doctor
  serve [--port 8765] [--open]                      web UI + job runner + autopilot
  url [--open]                                      the running server's link (with its token)
  session create <id> --branches branch-4.2:4.2.6,branch-4.0:4.0.15<branch-4.2 (--since-pr N | --since-sha S) [--title T] [--repo DIR] [--remote NAME]
  session list | show <id> | start-backport <id> | config <id> key=value...
  plan discover <id> [--no-blame]                   refresh PRs, branch presence, labels, dry runs, dependency hints
  plan triage-export <id> [--all] [--size 25]       batches + BRIEF.md for evaluator subagents (prints JSON)
  plan import <id> <verdicts.json>...
  plan decide <id> <pr> <branch|all> <undecided|backport|skip|defer> [--note T] [--group]   (--group: the whole dependency group)
  plan value <id> <pr> <high|medium|low> [--note T]  value for users/operators (kept across re-imports)
  plan equiv <id> <pr> <branch> [--confirm]        mark a detected branch-specific equivalent as not the same (--confirm undoes)
  plan review <id> <pr>... [--undo]                 accept the rows' decisions (whole dependency groups) and hide them from review
  plan comment <id> <pr> (--text T | --separate-backport | --clear)   queue a comment, posted after every lane is done
  plan comments <id> | post-comments <id>          list queued comments / post them now
  plan recommend <id> [--branch B] [--all]          reset decisions to the recommendations (--all: also your own)
  plan show <id> [--pr N] | report <id> [--out FILE] | labels <id> [--apply] [--removals]
  dep add <id> <pr> <depends-on> [--branch B] [--detail T] | dep set <id> <dep-id> <open|accepted|dismissed>
  lane <start|pick|pick-all|show|push-test|poll|squash|reset|push-final-fix> <id> <branch>
  lane resolved <id> <branch> <pr> [--tests A#m1+m2,B] [--result T]   after resolving; the tests that validated it
  lane unblock <id> <branch> <pr>  |  lane skip|drop <id> <branch> <pr> --reason T   (drop: also a committed pick; the lane is rebuilt)
  lane add-dep <id> <branch> <pr> <dep> [--detail T]   backport <dep> before <pr>, in master order (rebuilds the lane if needed)
  lane out-of-order <id> <branch> <pr> --reason T      let a late pick go on top instead of in master order
  lane rewind <id> <branch> --before <master-order>    re-apply every pick after that position
  decisions <id>                                    what the backport waits for, with the options
  decisions <id> apply <key> <option> [--text T]    choose an option (the UI does the same)
  decisions <id> recommended                        choose the recommended option wherever it needs no input
  abort <id> [--reason T]                           reset every lane not yet pushed, close test PRs, back to planning
  lane phase <id> <branch> <phase>  |  lane finalize <id> <branch> [--allow-rebase]
  ci rerun <id> <branch>
  advance <id> [--force]                            one autopilot step
  job list [--session ID] | show|run|log|cancel <job> | claim [--session ID] [--wait SECONDS]
  job done <job> --summary T | fail <job> --reason T | reply <job> <text>
  job ask <job> --question T [--recommend T] [--propose dep:<pr>:<dep>,drop:<pr>,rerun,reset]   ask the user; proposals and the recommendation become one-click options
`;

function parse(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2); const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) opt[k] = true; else { opt[k] = n; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const need = (v, what) => { if (v === undefined || v === true) throw new Error(`missing ${what}`); return v; };

/** Context a worker needs, in one JSON document. */
function jobContext(id) {
  const j = jobs.job(id); const s = db.session(j.session_id);
  const ctx = { job: j, session: { id: s.id, title: s.title, repo: s.config.repo, source: s.config.source, sinceSha: s.config.sinceSha },
    skills: { cherryPick: path.join(SKILLS, 'pulsar-cherry-pick', 'SKILL.md'), investigateCi: path.join(SKILLS, 'investigate-ci', 'SKILL.md') } };
  if (j.branch) {
    const l = db.lane(j.session_id, j.branch);
    ctx.lane = { branch: l.branch, release: l.release, phase: l.phase, worktree: l.worktree, base: l.base_sha, head: l.head_sha,
      testBranch: l.test_branch, testPr: l.test_pr_url, ci: l.ci, attention: l.attention, reuseFrom: l.reuse_from };
    const items = new Map(plan.planView(j.session_id).items.map((it) => [it.pr, it]));
    const brief = (p) => {
      const it = items.get(p.pr) || {}; const t = it.targets?.[j.branch] || {};
      return { pr: p.pr, status: p.status, title: it.title, master: p.detail.master || p.source_sha, source: p.source_sha, picked: p.picked_sha,
        note: t.note, adapt: t.adapt, decisionNote: t.decision_note, detail: p.detail };
    };
    const picks = lane.lanePicks(j.session_id, j.branch);
    if (j.args.pr) {
      const p = picks.find((x) => x.pr === j.args.pr);
      const it = items.get(j.args.pr);
      ctx.pick = { ...brief(p), assessment: it?.assessment, deps: it?.deps, labels: it?.labels };
      if (j.type === 'resolve' && p) ctx.pick.tests = lane.changedTests(j.session_id, j.branch, p);
    }
    ctx.picks = picks.map((p) => ({ pr: p.pr, status: p.status, title: items.get(p.pr)?.title, picked: p.picked_sha, master: p.detail.master || p.source_sha,
      adapt: items.get(p.pr)?.targets?.[j.branch]?.adapt }));
    if (j.type === 'verify' && l.worktree) {
      const files = g.git(l.worktree, ['diff', '--name-only', `${l.base_sha}..HEAD`]).split('\n').filter(Boolean);
      ctx.modules = [...new Set(files.map((f) => f.split('/src/')[0]).filter((m) => m && !m.includes('.')))].sort();
    }
  }
  if (j.type === 'triage') ctx.planSkill = path.join(SKILLS, 'pulsar-backport-plan', 'SKILL.md');
  return ctx;
}

/** Engine jobs. Output goes to the job log; the summary goes to the job row. */
function runEngineJob(id) {
  const j = jobs.job(id); const sid = j.session_id; const b = j.branch;
  db.run(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), pid = ? WHERE id = ?`, db.now(), process.pid, id);
  try {
    let summary;
    switch (j.type) {
      case 'discover': { const r = plan.discover(sid); summary = `round ${r.round}: ${r.total} PRs, ${r.added} new`; break; }
      case 'start-lane': lane.startLane(sid, b); // fall through: picking starts right away
      case 'pick-all': { const r = lane.pickAll(sid, b); summary = `${r.results.filter((x) => x.status === 'picked').length} picked, stopped at ${r.last.status}${r.last.pr ? ` #${r.last.pr}` : ''}`; break; }
      case 'push-test': { const r = lane.pushTest(sid, b); summary = `pushed ${r.testBranch}, PR #${r.pr.number}`; break; }
      case 'rerun': { const r = lane.rerunFailed(sid, b); summary = `re-ran ${r.runs.length} run(s)`; break; }
      case 'squash': { const r = lane.squash(sid, b); summary = `squashed to ${g.short(r.squashed)}`; break; }
      case 'finalize': { const r = lane.finalize(sid, b, { allowRebase: !!j.args.allowRebase }); summary = r.status; break; }
      case 'push-final-fix': lane.pushFinalFix(sid, b); summary = 'pushed'; break;
      case 'post-comments': { const r = plan.postComments(sid); summary = `${r.posted} posted, ${r.failed} failed`; if (r.failed) throw new Error(summary); break; }
      case 'apply-labels': { const r = plan.applyLabels(sid, { removals: !!j.args.removals }); summary = `${r.added} added, ${r.removed} removed`; break; }
      case 'abort': { const r = lane.abortBackport(sid, { reason: j.args.reason || undefined, cancel: (jid) => jobs.cancel(jid) }); summary = `reset ${r.reset.join(', ') || 'nothing'}${r.kept.length ? `; kept ${r.kept.join(', ')}` : ''}`; break; }
      default: throw new Error(`not an engine job: ${j.type}`);
    }
    jobs.finish(id, 'done', { summary });
  } catch (e) {
    console.error(e.stack || e.message);
    jobs.finish(id, 'failed', { error: e.message });
    if (b) db.updateLane(sid, b, { attention: `${j.type} failed: ${e.message.slice(0, 300)}` });
    process.exitCode = 1;
  }
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  switch (cmd) {
    case undefined: case 'help': case '--help': return out(HELP);
    case 'doctor': {
      db.open();
      const repo = plan.DEFAULT_REPO;
      const checks = { db: db.DB_PATH, node: process.version, git: g.GIT, repo, remote: null, gh: null, claude: null };
      try { checks.remote = g.remoteFor(repo, 'apache/pulsar'); } catch (e) { checks.remote = `ERROR ${e.message}`; }
      const { spawnSync } = await import('node:child_process');
      const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }); checks.gh = gh.status === 0 ? 'ok' : (gh.stderr || '').trim();
      const cl = spawnSync(process.env.BPT_CLAUDE || 'claude', ['--version'], { encoding: 'utf8' }); checks.claude = cl.status === 0 ? cl.stdout.trim() : 'not found';
      checks.cherryPickSkill = fs.existsSync(path.join(SKILLS, 'pulsar-cherry-pick', 'SKILL.md'));
      const s = (await import('./lib/server.mjs')).serverInfo(); checks.server = s ? `running (pid ${s.pid}) ${s.url}` : 'not running (bpt serve)';
      return out(checks);
    }
    case 'url': {
      db.open();
      const s = (await import('./lib/server.mjs')).serverInfo();
      if (!s) { console.error('bpt server is not running; start it with: bpt serve [--port 8765]'); process.exit(1); }
      if (opt.open) (await import('node:child_process')).spawn('open', [s.url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      console.log(s.url); return;
    }
    case 'serve': {
      const { serve } = await import('./lib/server.mjs');
      return serve({ port: Number(opt.port || 8765), open: !!opt.open });
    }
    case 'session': {
      if (sub === 'list') return out(db.all('SELECT id, title, status, updated_at FROM sessions ORDER BY updated_at DESC'));
      if (sub === 'create') {
        const s = plan.createSession({ id: need(pos[0], 'session id'), title: opt.title, repo: opt.repo || plan.DEFAULT_REPO,
          branches: plan.parseBranches(need(opt.branches, '--branches')), sincePr: opt['since-pr'] && Number(opt['since-pr']), sinceSha: opt['since-sha'], remote: opt.remote || null });
        return out({ id: s.id, sinceSha: s.config.sinceSha, lanes: s.config.branches });
      }
      const sid = need(pos[0], 'session id');
      if (sub === 'show') return out({ ...db.session(sid), lanes: db.all('SELECT branch, release, phase, attention, test_pr_url FROM lanes WHERE session_id = ? ORDER BY seq', sid) });
      if (sub === 'start-backport') { db.run(`UPDATE sessions SET status = 'backporting', updated_at = ? WHERE id = ?`, db.now(), sid); db.event(sid, 'Backporting started'); return out('ok'); }
      if (sub === 'config') {
        const patch = {};
        for (const kv of pos.slice(1)) { const [k, ...v] = kv.split('='); const s = v.join('='); patch[k] = s === 'true' ? true : s === 'false' ? false : /^\d+$/.test(s) ? Number(s) : s === 'null' ? null : s; }
        return out(plan.saveConfig(sid, patch));
      }
      break;
    }
    case 'plan': {
      const sid = need(pos[0], 'session id');
      if (sub === 'discover') return out(plan.discover(sid, { blame: !opt['no-blame'] }));
      if (sub === 'triage-export') return out(plan.exportTriage(sid, { all: !!opt.all, size: Number(opt.size || 25), briefTemplate: path.join(SKILLS, 'pulsar-backport-plan', 'references', 'triage-brief.md') }));
      if (sub === 'import') { const r = pos.slice(1).map((f) => plan.importVerdicts(sid, f)); return out(r); }
      if (sub === 'decide') {
        const [, pr, branch, decision] = pos;
        const branches = branch === 'all' ? db.all('SELECT branch FROM lanes WHERE session_id = ?', sid).map((l) => l.branch) : [branch];
        return out(plan.setDecisions(sid, branches.map((b) => ({ pr: Number(pr), branch: b, decision, note: typeof opt.note === 'string' ? opt.note : null })), { group: !!opt.group }));
      }
      if (sub === 'value') { plan.setValue(sid, Number(pos[1]), pos[2], typeof opt.note === 'string' ? opt.note : undefined); return out('ok'); }
      if (sub === 'equiv') { plan.rejectEquivalent(sid, Number(pos[1]), need(pos[2], 'branch'), !opt.confirm); return out('ok'); }
      if (sub === 'review') return out(plan.setReviewed(sid, pos.slice(1).map(Number), !opt.undo));
      if (sub === 'comment') {
        const pr = Number(need(pos[1], 'pr'));
        const text = opt.clear ? '' : opt['separate-backport'] ? plan.separateBackportText(sid, pr) : need(opt.text, '--text');
        plan.setComment(sid, pr, text); return out(text ? { pr, comment: text } : 'removed');
      }
      if (sub === 'comments') return out(plan.pendingComments(sid));
      if (sub === 'post-comments') return out(plan.postComments(sid));
      if (sub === 'recommend') return out(plan.applyRecommendations(sid, { branch: opt.branch || null, all: !!opt.all }));
      if (sub === 'show') { const v = plan.planView(sid); return out(opt.pr ? v.items.find((x) => x.pr === Number(opt.pr)) : v); }
      if (sub === 'report') { const md = plan.report(sid); if (opt.out) { fs.writeFileSync(opt.out, md); return out(opt.out); } return out(md); }
      if (sub === 'labels') return out(opt.apply ? plan.applyLabels(sid, { removals: !!opt.removals }) : plan.labelPlan(sid));
      break;
    }
    case 'dep': {
      // A dependency merged before the plan's range joins the plan (and the started lanes' picks).
      const pullIn = (sid) => {
        const p = plan.pullInDependencies(sid);
        if (p.added.length) for (const l of db.all(`SELECT branch FROM lanes WHERE session_id = ? AND phase != 'not-started'`, sid)) lane.syncPicks(sid, l.branch);
        return p.added.length || p.missing.length ? { ok: true, pulledIn: p.added, notOnMaster: p.missing } : 'ok';
      };
      const sid = need(pos[0], 'session id');
      if (sub === 'add') {
        const [, pr, dep] = pos.map(Number);
        db.run(`INSERT OR IGNORE INTO deps (session_id, pr, depends_on, branch, source, detail, phase, created_at) VALUES (?,?,?,?,?,?,?,?)`,
          sid, pr, dep, opt.branch || null, 'manual', opt.detail || null, 'backport', db.now());
        db.event(sid, `Dependency recorded: #${pr} needs #${dep}${opt.detail ? ` (${opt.detail})` : ''}`, { branch: opt.branch || null, level: 'attention' });
        return out(pullIn(sid));
      }
      if (sub === 'set') { lane.setDep(sid, Number(pos[1]), pos[2]); return out(pullIn(sid)); }
      break;
    }
    case 'lane': {
      const [sid, branch, arg] = [need(pos[0], 'session id'), need(pos[1], 'branch'), pos[2]];
      switch (sub) {
        case 'start': return out(lane.startLane(sid, branch));
        case 'pick': return out(lane.pickNext(sid, branch));
        case 'pick-all': return out(lane.pickAll(sid, branch).last);
        case 'show': return out({ ...db.lane(sid, branch), picks: lane.lanePicks(sid, branch) });
        case 'resolved': return out(lane.markResolved(sid, branch, Number(need(arg, 'pr')), { tests: typeof opt.tests === 'string' ? opt.tests : null, result: typeof opt.result === 'string' ? opt.result : null }));
        case 'unblock': return out(lane.unblock(sid, branch, Number(need(arg, 'pr'))));
        case 'skip': lane.skipPick(sid, branch, Number(need(arg, 'pr')), need(opt.reason, '--reason')); return out('ok');
        case 'drop': return out(lane.dropPick(sid, branch, Number(need(arg, 'pr')), need(opt.reason, '--reason')));
        case 'add-dep': return out(lane.addDependency(sid, branch, Number(need(arg, 'pr')), Number(need(pos[3], 'dependency PR')), typeof opt.detail === 'string' ? opt.detail : undefined));
        case 'out-of-order': lane.pickOutOfOrder(sid, branch, Number(need(arg, 'pr')), need(opt.reason, '--reason')); return out('ok');
        case 'rewind': return out(lane.rewind(sid, branch, { before: Number(need(opt.before, '--before')), reason: typeof opt.reason === 'string' ? opt.reason : 'rewound from the CLI' }));
        case 'phase': lane.setPhase(sid, branch, need(arg, 'phase'), opt.note); return out('ok');
        case 'push-test': return out(lane.pushTest(sid, branch));
        case 'poll': return out(lane.pollCi(sid, branch));
        case 'squash': return out(lane.squash(sid, branch));
        case 'finalize': return out(lane.finalize(sid, branch, { allowRebase: !!opt['allow-rebase'] }));
        case 'push-final-fix': lane.pushFinalFix(sid, branch); return out('ok');
        case 'reset': lane.resetLane(sid, branch); return out('ok');
      }
      break;
    }
    case 'ci': {
      if (sub === 'rerun') {
        const [sid, branch] = pos; const l = db.lane(sid, branch); const cfg = db.session(sid).config;
        const kind = l.phase.startsWith('final') ? 'final' : 'test';
        if ((l.ci[kind]?.reruns || 0) >= (cfg.maxReruns || 3)) throw new Error(`rerun limit (${cfg.maxReruns || 3}) reached for this commit; ask the user`);
        return out(lane.rerunFailed(sid, branch));
      }
      break;
    }
    case 'advance': return out(autopilot.advance(need(sub, 'session id'), { force: !!opt.force }));
    case 'decisions': {
      const sid = need(sub, 'session id');
      if (pos[0] === 'recommended') return out(control.applyRecommended(sid));
      if (pos[0] === 'apply') return out(control.apply(sid, need(pos[1], 'decision key'), need(pos[2], 'option'), typeof opt.text === 'string' ? opt.text : undefined));
      return out(control.list(sid));
    }
    case 'abort': {
      const sid = need(sub, 'session id');
      return out(lane.abortBackport(sid, { reason: typeof opt.reason === 'string' ? opt.reason : undefined, cancel: (jid) => jobs.cancel(jid) }));
    }
    case 'job': {
      switch (sub) {
        case 'list': return out(db.all(`SELECT id, session_id, branch, type, runner, status, created_at, finished_at FROM jobs ${opt.session ? 'WHERE session_id = ?' : ''} ORDER BY id DESC LIMIT 50`, ...(opt.session ? [opt.session] : [])));
        case 'show': return out(jobContext(Number(need(pos[0], 'job id'))));
        case 'run': return runEngineJob(Number(need(pos[0], 'job id')));
        case 'log': return out(jobs.readLog(Number(need(pos[0], 'job id'))).lines.map((l) => `[${l.kind}] ${l.text}`).join('\n'));
        case 'cancel': jobs.cancel(Number(pos[0])); return out('ok');
        case 'claim': {
          const until = Date.now() + Number(opt.wait || 0) * 1000;
          for (;;) {
            const j = jobs.claim(opt.session || null);
            if (j) return out(jobContext(j.id));
            if (Date.now() >= until) return out({ job: null });
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        case 'done': jobs.finish(Number(pos[0]), 'done', { summary: need(opt.summary, '--summary') }); return out('ok');
        case 'fail': jobs.finish(Number(pos[0]), 'failed', { error: need(opt.reason, '--reason') }); return out('ok');
        case 'ask': {
          const id = Number(pos[0]); const j = jobs.job(id);
          const proposals = control.parseProposals(opt.propose === true ? '' : opt.propose, j.args.pr);
          const recommendation = typeof opt.recommend === 'string' ? opt.recommend : null;
          jobs.finish(id, 'waiting', { question: need(opt.question, '--question'), proposals, recommendation });
          if (j.branch) db.updateLane(j.session_id, j.branch, { attention: `Job ${id} asks a question (Decisions needed)` });
          return out('ok');
        }
        case 'reply': jobs.reply(Number(pos[0]), pos.slice(1).join(' ')); return out('ok');
      }
      break;
    }
  }
  throw new Error(`unknown command: ${[cmd, sub].filter(Boolean).join(' ')}\n\n${HELP}`);
}

main().catch((e) => { console.error(`bpt: ${e.message}`); process.exit(1); });
