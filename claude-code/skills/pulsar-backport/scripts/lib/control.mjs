// Decisions needed while backporting: every point where the process waits for the user, with the choices that
// carry it on. The UI shows them as one queue; `apply` runs the chosen option. Nothing here pushes to a release
// branch except the Finalize option, which is the same user action as the lane button.
import * as db from './db.mjs';
import * as jobs from './jobs.mjs';
import * as lane from './lane.mjs';
import * as review from './review.mjs';

const attempts = (sid, branch, type, key = {}) => db.all(`SELECT args FROM jobs WHERE session_id = ? AND branch = ? AND type = ? AND status IN ('failed','done','cancelled')`, sid, branch, type)
  .map((j) => db.J(j.args, {})).filter((a) => Object.entries(key).every(([k, v]) => a[k] === v)).length;

/** Jobs on the lane must not be working in the worktree while the lane changes; a waiting question is superseded. */
/**
 * Cancel the jobs working on one pick (a resolve job, queued, running or waiting) before the pick is skipped or
 * dropped. A cancelled resolver's half-done work in the worktree belongs to that pick and is discarded with it.
 */
export function cancelPickJobs(sid, branch, pr, why) {
  const js = db.all(`SELECT id, status FROM jobs WHERE session_id = ? AND branch = ? AND status IN ('queued', 'running', 'waiting')
     AND json_extract(args, '$.pr') = ?`, sid, branch, pr);
  for (const j of js) jobs.cancel(j.id, why);
  if (js.some((j) => j.status === 'running')) {
    const l = db.lane(sid, branch);
    if (l.worktree) { lane.discardWorktreeChanges(l.worktree); db.event(sid, `Discarded the cancelled resolver's uncommitted changes for #${pr}`, { branch, level: 'warn' }); }
  }
  return js.map((j) => j.id);
}

export function settle(sid, branch, why, except = null) {
  const run = db.get(`SELECT id, type FROM jobs WHERE session_id = ? AND branch = ? AND status = 'running'`, sid, branch);
  if (run) throw new Error(`job ${run.id} (${run.type}) is running on ${branch}; wait for it or cancel it first`);
  for (const j of db.all(`SELECT id FROM jobs WHERE session_id = ? AND branch = ? AND status IN ('queued', 'waiting') AND id != IFNULL(?, -1)`, sid, branch, except)) {
    jobs.finish(j.id, 'cancelled', { summary: `superseded: ${why}` });
  }
}

const enqueue = (sid, b, type, args) => ({ job: jobs.enqueue(sid, b, type, args) });
const proposalLabel = (p) => ({
  dep: `Backport #${p.dep} before #${p.pr} (master order)`,
  drop: `Drop #${p.pr} from this branch`,
  rerun: 'Re-run the failed CI jobs',
  reset: 'Reset the lane and start it again',
}[p.type] || p.type);

/** Parse `--propose` values: dep:<dep> | dep:<pr>:<dep> | drop:<pr> | rerun | reset, comma separated. */
export function parseProposals(spec, pr) {
  return String(spec || '').split(/[,\s]+/).filter(Boolean).map((x) => {
    const [type, a, b] = x.split(':');
    if (type === 'dep') return b ? { type, pr: Number(a), dep: Number(b) } : { type, pr: Number(pr), dep: Number(a) };
    if (type === 'drop' || type === 'skip') return { type: 'drop', pr: Number(a || pr) };
    if (type === 'rerun' || type === 'reset') return { type };
    throw new Error(`unknown proposal ${x} (dep:<dep> | dep:<pr>:<dep> | drop:<pr> | rerun | reset)`);
  }).map((p) => {
    if ((p.type === 'dep' && (!p.pr || !p.dep)) || (p.type === 'drop' && !p.pr)) throw new Error(`incomplete proposal ${JSON.stringify(p)}`);
    return p;
  });
}

function runProposal(sid, branch, p, job) {
  if (p.type === 'dep') { settle(sid, branch, `#${p.dep} added before #${p.pr}`, job); return lane.addDependency(sid, branch, p.pr, p.dep, 'proposed by a worker, approved by the user'); }
  if (p.type === 'drop') { settle(sid, branch, `#${p.pr} dropped`, job); return lane.dropPick(sid, branch, p.pr, 'proposed by a worker, approved by the user'); }
  if (p.type === 'rerun') return enqueue(sid, branch, 'rerun');
  if (p.type === 'reset') { settle(sid, branch, 'lane reset', job); lane.resetLane(sid, branch, 'reset on a worker\'s proposal'); return {}; }
  throw new Error(`unknown proposal ${p.type}`);
}

/** Everything the session waits for, most specific first. Options carry a `run` (dropped from the JSON). */
export function pending(sid) {
  db.session(sid); const out = [];
  const items = new Map(db.all('SELECT pr, title FROM items WHERE session_id = ?', sid).map((x) => [x.pr, x.title]));
  const title = (pr) => (items.get(pr) || '').replace(/\s*\(#\d+\)\s*$/, '');
  const add = (d) => out.push({ ...d, options: d.options.filter(Boolean) });

  // Questions from workers (job ask), with the actions they propose.
  for (const j0 of db.all(`SELECT id FROM jobs WHERE session_id = ? AND status = 'waiting' ORDER BY id`, sid)) {
    const j = jobs.job(j0.id); const b = j.branch;
    const props = j.result?.proposals || [];
    const done = (label) => { jobs.finish(j.id, 'done', { summary: `the user chose: ${label}` }); if (b) db.updateLane(sid, b, { attention: null }); };
    const rec = j.result?.recommendation || recommendationIn(j.result?.question);
    add({ key: `job:${j.id}`, kind: 'question', branch: b, pr: j.args.pr || null, job: j.id,
      title: `${j.type}${j.args.pr ? ` #${j.args.pr}` : ''} asks`, text: j.result?.question || '', recommendation: rec,
      options: [
        ...props.map((p, i) => ({ id: `p${i}`, label: proposalLabel(p), recommended: i === 0, run: () => { const r = runProposal(sid, b, p, j.id); if (jobs.job(j.id).status === 'waiting') done(proposalLabel(p)); return r; } })),
        ...(rec && !props.length ? [{ id: 'recommendation', label: 'Go with the recommendation', recommended: true,
          run: () => { jobs.reply(j.id, `Go ahead with your recommendation: ${rec}`); if (b) db.updateLane(sid, b, { attention: null }); return {}; } }] : []),
        { id: 'reply', label: 'Reply to the worker', input: 'Your answer; the worker resumes with it', recommended: !props.length && !rec, run: (text) => { if (!text) throw new Error('write a reply'); jobs.reply(j.id, text); if (b) db.updateLane(sid, b, { attention: null }); return {}; } },
        { id: 'cancel', label: 'Cancel the job', cls: 'ghost', run: () => { jobs.cancel(j.id); if (b) db.updateLane(sid, b, { attention: null }); return {}; } },
      ] });
  }

  for (const l0 of db.all('SELECT * FROM lanes WHERE session_id = ? ORDER BY seq', sid)) {
    const l = { ...l0, ci: db.J(l0.ci, {}) }; const b = l.branch;
    if (l.phase === 'not-started') continue;
    const active = jobs.activeJob(sid, b);
    const list = lane.lanePicks(sid, b);
    const byPr = new Map(list.map((p) => [p.pr, p]));
    const idle = !active;
    const later = (p) => list.filter((x) => x.seq > p.seq && ['picked', 'needs-fix'].includes(x.status)).map((x) => `#${x.pr}`);

    for (const h of lane.holds(sid, b)) {
      const p = byPr.get(h.pr);
      if (h.kind === 'added') {
        const after = later(p);
        add({ key: `added:${b}:${p.pr}`, kind: 'added', branch: b, pr: p.pr, title: `#${p.pr} ${title(p.pr)} was added after picking finished`,
          text: after.length ? `In master order it goes before ${after.join(', ')}. Re-picking in master order rebuilds the lane from there (resolutions and fixups are kept) and restarts verification and test CI.`
            : 'It comes after every commit in the lane, so it goes on top in master order; verification and test CI run again.',
          options: [
            after.length ? { id: 'repick', label: 'Re-pick in master order', recommended: true, run: () => { settle(sid, b, `#${p.pr} added in master order`); return lane.placeInOrder(sid, b); } }
              : { id: 'pick', label: `Pick #${p.pr} now`, recommended: true, run: () => { settle(sid, b, `#${p.pr} added`); return lane.placeInOrder(sid, b); } },
            after.length ? { id: 'on-top', label: 'Pick on top, out of order', input: 'Why it should not go in master order', run: (text) => { settle(sid, b, `#${p.pr} on top`); lane.pickOutOfOrder(sid, b, p.pr, text); return {}; } } : null,
            { id: 'skip', label: `Leave #${p.pr} out`, cls: 'ghost', run: () => { lane.skipPick(sid, b, p.pr, 'left out after picking finished'); return {}; } },
          ] });
      } else {
        add({ key: `unwanted:${b}:${p.pr}`, kind: 'unwanted', branch: b, pr: p.pr, title: `#${p.pr} ${title(p.pr)} is no longer decided "backport"`,
          text: `It is already picked as ${(p.picked_sha || '').slice(0, 11)}. Dropping it rebuilds the lane from that commit.`,
          options: [
            { id: 'drop', label: `Drop #${p.pr}`, recommended: true, run: () => { settle(sid, b, `#${p.pr} dropped`); return lane.dropPick(sid, b, p.pr, 'decision changed to skip'); } },
            { id: 'keep', label: 'Keep it (decide "backport" again)', run: () => {
              db.run(`UPDATE targets SET decision = 'backport', decision_source = 'user', decision_note = 'kept while backporting', decided_at = ? WHERE session_id = ? AND pr = ? AND branch = ?`, db.now(), sid, p.pr, b);
              return {}; } },
          ] });
      }
    }

    for (const p of list) {
      if (p.status === 'blocked' && idle) {
        const unmet = p.detail.unmet || [];
        const deps = db.all(`SELECT id, depends_on, source FROM deps WHERE session_id = ? AND pr = ? AND (branch IS NULL OR branch = ?) AND status != 'dismissed'`, sid, p.pr, b);
        const ids = (dep) => deps.filter((d) => d.depends_on === dep).map((d) => d.id);
        add({ key: `blocked:${b}:${p.pr}`, kind: 'blocked', branch: b, pr: p.pr, title: `#${p.pr} ${title(p.pr)} needs a dependency decision`,
          text: unmet.map((u) => `#${u.depends_on} ${title(u.depends_on)} (${u.source}${u.detail ? `: ${u.detail}` : ''}; plan decision ${u.decision || 'none'})`).join('\n'),
          options: [
            ...unmet.map((u, i) => ({ id: `add:${u.depends_on}`, label: `Backport #${u.depends_on} first`, recommended: i === 0,
              run: () => (ids(u.depends_on).length ? lane.acceptDeps(sid, b, ids(u.depends_on)) : lane.addDependency(sid, b, p.pr, u.depends_on, u.detail || 'accepted while backporting')) })),
            { id: 'dismiss', label: `Pick #${p.pr} without ${unmet.length > 1 ? 'them' : 'it'}`, run: () => { for (const u of unmet) for (const id of ids(u.depends_on)) lane.setDep(sid, id, 'dismissed'); lane.unblock(sid, b, p.pr);
              // setDep already unblocks the pick when its last dependency is dismissed.
              return { ok: lane.lanePicks(sid, b).find((x) => x.pr === p.pr)?.status !== 'blocked' }; } },
            { id: 'skip', label: `Leave #${p.pr} out`, cls: 'ghost', run: () => { lane.skipPick(sid, b, p.pr, 'left out: dependency not wanted'); return {}; } },
          ] });
      }
      if (['conflict', 'needs-fix'].includes(p.status) && idle) {
        const tries = lane.resolveAttempts(sid, b, p.pr);
        const bf = p.status === 'needs-fix' && p.detail.build && !p.detail.build.ok ? p.detail.build : null;
        const earlier = (bf?.suspects || []).filter((x) => x.pr && x.pr !== p.pr).slice(0, 3);
        const uniq = (p.detail.conflictDeps || []).filter((c, i, a) => a.findIndex((x) => x.depends_on === c.depends_on) === i);
        // A PR the user left out in review is not offered again: the pick is resolved without it.
        const left = uniq.filter((c) => c.excluded || lane.excludedInReview(sid, b, c.depends_on));
        const hints = uniq.filter((c) => !left.includes(c)).slice(0, 3);
        add({ key: `${p.status}:${b}:${p.pr}`, kind: p.status, branch: b, pr: p.pr,
          title: `#${p.pr} ${title(p.pr)} ${p.status === 'conflict' ? `conflicts in ${(p.detail.conflicts || []).map((f) => f.split('/').pop()).join(', ')}`
            : bf ? `fails the build check (${bf.stage})` : 'needs a fix after the post-pick check'}`,
          text: [tries ? `${tries} resolve attempt(s) did not finish it.` : '', hints.length ? `Missing master commits that touched these files: ${hints.map((c) => `#${c.depends_on} (${c.decision})`).join(', ')}.` : '',
            left.length ? `Resolved without ${left.map((c) => `#${c.depends_on}`).join(', ')}, left out in review.` : '',
            bf ? `Modules ${bf.modules.join(', ')}${bf.tests ? `, tests ${bf.tests}` : ''}; log ${bf.log}` : '',
            earlier.length ? `The failing lines come from earlier picks: ${earlier.map((x) => `#${x.pr} (${x.file.split('/').pop()}:${x.line})`).join(', ')}. Fix that pick, drop it, or backport what it is missing.` : ''].filter(Boolean).join(' '),
          options: [
            { id: 'resolve', label: tries ? 'Resolve with Claude again' : 'Resolve with Claude', recommended: true, input: tries ? 'Instructions for the worker (optional)' : null, optional: true, run: (text) => enqueue(sid, b, 'resolve', { pr: p.pr, instructions: text || undefined }) },
            ...hints.map((c) => ({ id: `add:${c.depends_on}`, label: `Backport #${c.depends_on} first`, run: () => { settle(sid, b, `#${c.depends_on} added before #${p.pr}`); return lane.addDependency(sid, b, p.pr, c.depends_on, `also changed ${c.file}, which conflicts`); } })),
            { id: 'resolved', label: 'I resolved it in the worktree', run: () => lane.markResolved(sid, b, p.pr) },
            ...earlier.map((x) => ({ id: `drop:${x.pr}`, label: `Drop #${x.pr} (the failing lines come from it)`, cls: 'ghost', confirm: `Drop #${x.pr}? The lane is rebuilt without it from its commit.`,
              run: () => { settle(sid, b, `#${x.pr} dropped`); return lane.dropPick(sid, b, x.pr, `its code fails the build check of #${p.pr}`); } })),
            bf ? { id: 'accept-build', label: 'Accept the failing check', input: 'Why it is not this pick (e.g. it fails on the branch too)', run: (text) => { if (!text) throw new Error('say why'); lane.acceptBuild(sid, b, p.pr, text); return {}; } } : null,
            { id: 'skip', label: `Leave #${p.pr} out`, cls: 'ghost', run: () => { if (p.status === 'needs-fix') return lane.dropPick(sid, b, p.pr, 'left out: could not be fixed'); lane.skipPick(sid, b, p.pr, 'left out: conflict'); return {}; } },
          ] });
      }
    }

    // A diff review concern: fix it in the pick, accept it, or drop the pick.
    if (idle && db.session(sid).config.diffReview !== false) {
      for (const p of review.concerns(sid, b)) {
        const r = p.detail.review;
        add({ key: `review:${b}:${p.pr}`, kind: 'review', branch: b, pr: p.pr, title: `#${p.pr} ${title(p.pr)}: the diff review found a problem`,
          text: `${r.concerns}\n\nReview: ${r.summary}`, recommendation: 'Fix it in the pick with Claude',
          options: [
            { id: 'fix', label: 'Fix it with Claude', recommended: true, input: 'Instructions for the worker (optional)', optional: true,
              run: (text) => enqueue(sid, b, 'resolve', { pr: p.pr, concerns: r.concerns, instructions: text || undefined }) },
            { id: 'accept', label: 'Accept as is', input: 'Why the backport is right as it is', run: (text) => { if (!text) throw new Error('say why'); review.accept(sid, b, p.pr, text); return {}; } },
            { id: 'drop', label: `Drop #${p.pr}`, cls: 'ghost', confirm: `Drop #${p.pr} from ${b}? The lane is rebuilt from its commit.`,
              run: () => { settle(sid, b, `#${p.pr} dropped`); return lane.dropPick(sid, b, p.pr, 'dropped after the diff review'); } },
          ] });
      }
    }

    if (!idle) continue;
    const lastJob = db.get(`SELECT id, type, runner, status, result FROM jobs WHERE session_id = ? AND branch = ? ORDER BY id DESC LIMIT 1`, sid, b);
    const lr = db.J(lastJob?.result, {});
    if (lastJob?.status === 'failed' && !lr.ack && !['resolve'].includes(lastJob.type)) {
      add({ key: `failed:${b}:${lastJob.id}`, kind: 'failed', branch: b, title: `${lastJob.type} failed on ${b}`, text: String(lr.error || '').slice(0, 600),
        options: [
          { id: 'retry', label: 'Retry', recommended: true, run: () => { const j = jobs.job(lastJob.id); return enqueue(sid, b, j.type, { ...j.args, reply: undefined }); } },
          { id: 'ack', label: 'Dismiss', cls: 'ghost', run: () => { db.run('UPDATE jobs SET result = ? WHERE id = ?', db.S({ ...lr, ack: true }), lastJob.id); db.updateLane(sid, b, { attention: null }); return {}; } },
        ] });
      continue;
    }
    if (l.phase === 'verifying' && attempts(sid, b, 'verify') >= 2) {
      add({ key: `verify:${b}`, kind: 'verify', branch: b, title: `Verifying ${b} did not succeed twice`, text: 'Look at the verify job logs. Drop the pick that does not build from the picks tab, or try again.',
        options: [
          { id: 'verify', label: 'Verify with Claude again', recommended: true, input: 'Instructions for the worker (optional)', optional: true, run: (text) => enqueue(sid, b, 'verify', { instructions: text || undefined }) },
          { id: 'mark', label: 'Mark verified', confirm: 'Mark the lane verified without a passing Claude build check?', run: () => { lane.setPhase(sid, b, 'verified', 'marked by the user'); return {}; } },
        ] });
    }
    if (['ci-failed', 'final-ci-failed'].includes(l.phase)) {
      const kind = l.phase === 'final-ci-failed' ? 'final' : 'test'; const c = l.ci[kind] || {};
      if (attempts(sid, b, 'fix-ci', { kind, sha: c.sha }) >= 1) {
        add({ key: `ci:${b}:${c.sha}`, kind: 'ci', branch: b, title: `${kind === 'final' ? b : 'The test branch'} CI still fails after a fix attempt`,
          text: `${(c.failed || []).map((f) => f.name).slice(0, 6).join(', ')}${c.reruns ? ` · ${c.reruns} rerun(s)` : ''}. ${kind === 'test' ? 'A pick that cannot be made to work can be dropped from the picks tab.' : ''}`,
          options: [
            { id: 'fix', label: 'Fix with Claude again', recommended: true, input: 'Instructions for the worker (optional)', optional: true, run: (text) => enqueue(sid, b, 'fix-ci', { kind, sha: c.sha, instructions: text || undefined }) },
            { id: 'rerun', label: 'Re-run failed jobs', run: () => enqueue(sid, b, 'rerun') },
          ] });
      }
    }
    if (l.phase === 'ready' && !lane.holds(sid, b).length) {
      add({ key: `ready:${b}`, kind: 'ready', branch: b, title: `${b} is tested and squashed`, text: l.ci.rebase ? `${b} moved since testing; the rebased batch is untested.` : `Finalize fast-forwards the local ${b} to the tested commits, pushes it and dispatches CI.`,
        options: [
          { id: 'finalize', label: `Finalize: fast-forward ${b}`, recommended: true, confirm: `Fast-forward the local ${b} to the tested commits, push it to apache/pulsar (fast-forward only) and dispatch CI?`, run: () => enqueue(sid, b, 'finalize', { allowRebase: false }) },
          l.ci.rebase ? { id: 'rebased', label: 'Push rebased (untested)', cls: 'danger', confirm: `${b} moved since testing. Push the rebased batch without testing that combination?`, run: () => enqueue(sid, b, 'finalize', { allowRebase: true }) } : null,
        ] });
    }
    if (l.phase === 'needs-attention' && l.attention && !list.some((p) => ['conflict', 'needs-fix', 'blocked'].includes(p.status))) {
      add({ key: `attention:${b}`, kind: 'attention', branch: b, title: `${b} waits`, text: l.attention,
        options: [{ id: 'continue', label: 'Continue picking', recommended: true, run: () => { db.updateLane(sid, b, { phase: 'picking', attention: null }); return enqueue(sid, b, 'pick-all'); } }] });
    }
  }
  return out;
}

/** Run the chosen option of a pending decision. */
export function apply(sid, key, option, text) {
  const d = pending(sid).find((x) => x.key === key);
  if (!d) throw new Error('that decision is no longer pending; refresh');
  const o = d.options.find((x) => x.id === option);
  if (!o) throw new Error(`no option ${option} for ${key}`);
  const r = o.run(text) || {};
  db.event(sid, `Decision: ${d.title} → ${o.label}${text ? ` (${String(text).slice(0, 200)})` : ''}`, { branch: d.branch || null });
  return r;
}

/** A worker that did not pass --recommend often ends its question with "I recommend ..."; use that sentence. */
export function recommendationIn(text) {
  const m = String(text || '').match(/(?:^|[.?!]\s+)((?:I(?:'d| would)? recommend|I suggest|Recommendation:)[^]*?)(?:[.!](?:\s|$)|$)/i);
  return m ? m[1].replace(/^(I(?:'d| would)? recommend(?: that)?|I suggest|Recommendation:)\s*/i, '').replace(/^./, (c) => c.toUpperCase()).trim() || null : null;
}

/** Apply the recommended option of every decision that needs no typed input or confirmation. */
export function applyRecommended(sid) {
  const done = []; const left = [];
  for (const d of pending(sid)) {
    const o = d.options.find((x) => x.recommended);
    if (!o || (o.input && !o.optional) || o.confirm) { left.push(d.key); continue; }
    // An earlier choice may have settled this one already (a rebuilt lane, an unblocked pick).
    if (!pending(sid).some((x) => x.key === d.key)) continue;
    try { apply(sid, d.key, o.id); done.push({ key: d.key, option: o.label }); } catch (e) { left.push(d.key); done.push({ key: d.key, error: e.message }); }
  }
  return { done, left };
}

/** JSON for the UI and the CLI (without the run functions). */
export function list(sid) {
  return pending(sid).map((d) => ({ ...d, options: d.options.map(({ run, ...o }) => o) }));
}
