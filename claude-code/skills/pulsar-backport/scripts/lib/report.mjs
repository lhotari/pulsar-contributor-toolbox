// The backport report of one lane: every cherry-pick in master order with why it is backported (the plan's
// assessment and branch evidence), how it was adapted to the maintenance branch (plan notes, the conflict
// resolution, the diff review) and how it was validated (build check, intent check, CI); then what was left out.
// Markdown, so it reads the same in the UI, in a downloaded file, in VS Code and in a gist.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as db from './db.mjs';
import * as g from './git.mjs';
import * as gh from './gh.mjs';

const REPO_URL = 'https://github.com/apache/pulsar';
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s, n = 400) => { const t = one(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const strip = (t) => one(t).replace(/\s*\(#\d+\)\s*$/, '');
const prRef = (pr) => `[#${pr}](${REPO_URL}/pull/${pr})`;
const commitRef = (sha) => `[\`${g.short(sha)}\`](${REPO_URL}/commit/${sha})`;

export function laneReport(sid, branch) {
  const s = db.session(sid); const l = db.lane(sid, branch);
  if (!l) throw new Error(`no lane ${branch}`);
  const ci = typeof l.ci === 'string' ? db.J(l.ci, {}) : (l.ci || {});
  const items = new Map(db.all('SELECT pr, title, sha, kind, assessment FROM items WHERE session_id = ?', sid).map((x) => [x.pr, { ...x, assessment: db.J(x.assessment, {}) }]));
  const targets = new Map(db.all('SELECT * FROM targets WHERE session_id = ? AND branch = ?', sid, branch).map((t) => [t.pr, t]));
  const picks = db.all('SELECT * FROM picks WHERE session_id = ? AND branch = ? ORDER BY seq, pr', sid, branch).map((p) => ({ ...p, detail: db.J(p.detail, {}) }));
  const committed = picks.filter((p) => ['picked', 'needs-fix', 'empty'].includes(p.status));
  const open = picks.filter((p) => ['pending', 'conflict', 'blocked'].includes(p.status));
  const title = (pr) => strip(items.get(pr)?.title || '');
  const verdicts = {}; for (const p of committed) { const v = p.detail.review?.sha === p.picked_sha ? (p.detail.review.accepted ? 'concern accepted' : p.detail.review.verdict) : 'not reviewed'; verdicts[v] = (verdicts[v] || 0) + 1; }

  // Commits that are on apache/pulsar: the head that CI tested (the test branch) and the finalized release branch.
  const pushed = new Set();
  for (const head of [ci.test?.sha, ci.final?.sha]) {
    if (!head || !l.base_sha) continue;
    const r = g.git(l.worktree || s.config.repo, ['rev-list', `${l.base_sha}..${head}`], { allowFail: true });
    for (const x of (r.out || '').split('\n').filter(Boolean)) pushed.add(x);
  }
  const w = [];
  w.push(`# Backports to ${branch}${l.release ? ` (${l.release})` : ''}\n`);
  w.push(`${s.title}. Lane phase **${l.phase}**${l.head_sha ? `, head \`${g.short(l.head_sha)}\`` : ''}${l.base_sha ? ` on \`${g.short(l.base_sha)}\`` : ''}${l.test_branch ? `, test branch \`${l.test_branch}\`` : l.test_pr_url ? `, test PR ${l.test_pr_url}` : ''}${ci.test?.state ? ` (CI ${ci.test.state})` : ''}. Generated ${db.now().slice(0, 16).replace('T', ' ')} UTC from session \`${sid}\`.\n`);
  w.push(`- **${committed.length} cherry-picks**${committed.filter((p) => p.status === 'empty').length ? ` (${committed.filter((p) => p.status === 'empty').length} already on the branch)` : ''}, in master merge order${open.length ? `; **${open.length} not picked yet** (${['pending', 'conflict', 'blocked'].map((st) => [st, open.filter((p) => p.status === st).length]).filter(([, n]) => n).map(([st, n]) => `${n} ${st}`).join(', ')}), listed after them` : ''}.`);
  w.push(`- Diff review: ${Object.entries(verdicts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}.`);
  const an = new Map(db.all('SELECT * FROM analysis WHERE session_id = ? AND branch = ?', sid, branch).map((x) => [x.pr, x]));
  const analyzed = committed.filter((p) => an.has(p.pr));
  const byCompat = (c) => analyzed.filter((p) => an.get(p.pr).compat === c);
  w.push(`- Compatibility: **${byCompat('breaking').length} potential breaking change(s)**, ${byCompat('behavior').length} behavior change(s), ${byCompat('none').length} without user-visible change${committed.length - analyzed.length ? ` (${committed.length - analyzed.length} not analyzed yet)` : ''}.`);
  const ciw = ciSection(l, ci);
  w.push(`- ${ciw.summary}\n`);
  w.push('Each entry: **Fixes** (the problem the PR fixes), **Why on this branch** (why it matters for the branch: the bug is present, avoiding divergence from master, a dependency…, with the plan\'s assessment), **Compatibility** (backwards compatibility and breaking changes), **Adaptation** (how the change differs from master and why), **Validation** (checks the pick passed at its own commit).\n');

  // Highlighted at the top: what can change for users or operators.
  const compatList = (list) => list.map((p) => `- ${prRef(p.pr)} ${title(p.pr)}: ${one(an.get(p.pr).compat_note)}`);
  w.push('## Potential breaking changes\n');
  w.push(...(byCompat('breaking').length ? compatList(byCompat('breaking')) : [analyzed.length ? 'None found in the analyzed picks.' : 'Not analyzed yet.']), '');
  if (byCompat('behavior').length) { w.push('### Behavior changes (compatible)\n'); w.push(...compatList(byCompat('behavior')), ''); }

  w.push(...ciw.lines);
  w.push('## Cherry-picks\n');
  const issues = fixedIssues(sid, committed.map((p) => p.pr));
  committed.forEach((p, i) => {
    const it = items.get(p.pr) || {}; const a = it.assessment || {}; const t = targets.get(p.pr) || {}; const d = p.detail;
    w.push(`### ${i + 1}. ${prRef(p.pr)} ${title(p.pr)}\n`);
    const master = d.master || it.sha || p.source_sha;
    w.push(`${p.picked_sha && pushed.has(p.picked_sha) ? commitRef(p.picked_sha) : `\`${g.short(p.picked_sha) || '–'}\``} cherry-picked from ${master ? commitRef(master) : '–'}${p.status === 'empty' ? ' · already on the branch (empty pick)' : ''}${d.reused ? ' · reused from the tested commits of the source lane' : ''}\n`);
    const x = an.get(p.pr);
    const REASON = { bug: 'bug fix', security: 'security fix', divergence: 'avoids divergence from master', dependency: 'dependency of another pick', test: 'test reliability', build: 'build', other: 'other' };
    const iss = issues.get(p.pr) || [];
    const issueText = iss.length ? ` Fixed issue${iss.length > 1 ? 's' : ''}: ${iss.map((x) => `[#${x.number}](${REPO_URL}/issues/${x.number})${x.title ? ` ${one(x.title)}` : ''}`).join('; ')}.` : '';
    w.push(`- **Fixes:** ${x ? one(x.fixes) : a.impact ? `${one(a.impact)} _(plan assessment; not analyzed yet)_` : '_not analyzed yet_'}${issueText}`);
    // Why
    const why = [];
    if (x) why.push(`${one(x.relevance)} _(${REASON[x.reason] || x.reason})_`);
    else if (a.impact) { /* shown under Fixes */ }
    const meta = [a.severity && `severity ${a.severity}`, a.risk && `risk ${a.risk}`, a.value && `value ${a.value}${a.valueNote ? ` (${one(a.valueNote)})` : ''}`].filter(Boolean);
    if (meta.length) why.push(`${meta.join(', ')}.`);
    if (t.bug) why.push(`Bug present on ${branch}: ${one(t.bug)}${t.evidence ? ` (${one(t.evidence)})` : ''}.`);
    if (a.riskNote) why.push(`Risk: ${one(a.riskNote)}`);
    if (t.decision_note) why.push(`Decision note: ${one(t.decision_note)}`);
    if (!why.length && a.reason) why.push(one(a.reason));
    w.push(`- **Why on this branch:** ${why.join(' ') || '_no assessment recorded_'}`);
    w.push(`- **Compatibility:** ${!x ? '_not analyzed yet_' : x.compat === 'none' ? 'no user-visible change' : `${x.compat === 'breaking' ? '**potential breaking change**' : 'behavior change (compatible)'}: ${one(x.compat_note)}`}`);
    // Adaptation
    const ad = [];
    const r = d.review?.sha === p.picked_sha ? d.review : null;
    if (r) ad.push(`Diff review: **${r.verdict}${r.accepted ? ' (accepted)' : ''}** — ${one(r.summary)}${r.concerns ? ` Concern: ${one(r.concerns)}` : ''}${r.accepted ? ` Accepted: ${one(r.accepted)}` : ''}`);
    if (t.adapt) ad.push(`Plan: ${one(t.adapt)}`);
    if (t.note && t.note !== t.adapt) ad.push(`Port note: ${one(t.note)}`);
    if (d.conflicts?.length || d.resolvedAt) ad.push(`Conflict${d.conflicts?.length ? ` in ${d.conflicts.map((f) => `\`${f.split('/').pop()}\``).join(', ')}` : ''} resolved${d.validation ? `; validated with ${d.validation.tests.join(', ')}: ${cap(d.validation.result)}` : ''}.`);
    if (d.warnings?.length) ad.push(d.warnings.map(one).join('; '));
    if (d.outOfOrder) ad.push(`Out of master order: ${one(d.outOfOrder)}`);
    w.push(`- **Adaptation:** ${ad.join(' ') || 'none; the change applies as on master.'}`);
    // Validation
    const b = d.build;
    const va = [];
    if (b) va.push(b.skipped ? `build check skipped (${b.skipped})` : b.ok ? `build check passed (${(b.modules || []).join(', ')}${b.tests ? `; tests ${b.tests}` : ''}; checkstyle)` : b.accepted ? `build check failure accepted: ${one(b.accepted)}` : `build check **failed** (${b.stage})`);
    for (const x of b?.intent || []) va.push(`intent: ${x.module} ${x.to} in Maven (${x.maven.map((m) => m.version).join(', ') || 'not declared'})`);
    if (d.check && !d.check.ok) va.push('post-pick check reported findings');
    w.push(`- **Validation:** ${va.join('; ') || '_no checks recorded_'}\n`);
  });

  if (open.length) {
    w.push('## Not picked yet\n');
    w.push('| PR | Status |'); w.push('|---|---|');
    for (const p of open) {
      const d = p.detail; const why = p.status === 'conflict' ? `conflict${d.conflicts?.length ? ` in ${d.conflicts.map((f) => f.split('/').pop()).join(', ')}` : ''}`
        : p.status === 'blocked' ? `blocked on ${(d.unmet || []).map((u) => `#${u.depends_on}`).join(', ')}` : 'pending';
      w.push(`| ${prRef(p.pr)} ${title(p.pr).replace(/\|/g, '\\|')} | ${why} |`);
    }
    w.push('');
  }
  return linkPrNumbers(w.join('\n'));
}

/**
 * Every PR or issue number the text mentions (#12345, apache/pulsar#12345) becomes a link, except inside code spans
 * and existing links. GitHub's /issues/N URL opens the pull request when N is one, so one link form covers both.
 */
export function linkPrNumbers(md) {
  return md.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part
    : part.replace(/(?<![\[\w&`#])(?<![A-Za-z][\w.-]*\/)(apache\/pulsar)?#(\d{3,6})\b(?!\]\()/g, (_, repo, n) => `[${repo || ''}#${n}](${REPO_URL}/issues/${n})`))).join('');
}

const RESULT = (r) => (r.status !== 'completed' ? `⏳ ${r.status}` : r.conclusion === 'success' ? '✅ success' : ['skipped', 'neutral'].includes(r.conclusion) ? `➖ ${r.conclusion}` : `❌ ${r.conclusion}`);

/** The lane's latest CI run (the release branch after finalize, else the test branch): its workflow runs, linked, with a summary. */
export function ciSection(l, ci) {
  const lines = []; let summary;
  const block = (title, sha, intro, branch) => {
    const runs = sha ? gh.workflowRuns(sha, branch) : [];
    const done = runs.filter((r) => r.status === 'completed');
    const bad = done.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion));
    const pending = runs.length - done.length;
    const state = !runs.length ? 'no workflow runs found' : bad.length ? `${bad.length} of ${runs.length} workflow runs failed` : pending ? `${pending} of ${runs.length} workflow runs still running` : `all ${runs.length} workflow runs passed`;
    lines.push(`### ${title}\n`);
    lines.push(`${intro} Commit \`${g.short(sha)}\`: **${state}**.\n`);
    if (runs.length) {
      lines.push('| Workflow | Result | Attempt | Run |'); lines.push('|---|---|---|---|');
      for (const r of runs) lines.push(`| ${r.name.replace(/\|/g, '\\|')} | ${RESULT(r)} | ${r.attempt || 1} | [${r.id}](${r.url}) |`);
      lines.push('');
    }
    return { runs, bad, pending, state };
  };
  lines.push('## CI\n');
  const t = ci.test; const f = ci.final;
  if (f?.sha) {
    const r = block(`${l.branch} after finalize`, f.sha, `The batch was fast-forwarded to \`${l.branch}\` and CI dispatched there.`, f.branch || l.branch);
    summary = `CI on ${l.branch}: ${r.state}.`;
  }
  else if (t?.sha) {
    const tb = t.branch || l.test_branch;
    const where = t.branch ? `[\`${tb}\`](${t.url || `${REPO_URL}/actions`})` : l.test_pr_url || `\`${tb || ''}\``;
    const r = block(`Test branch ${tb || ''}`.trim(), t.sha,
      `The batch was pushed to the test branch \`${tb || ''}\` ${t.branch ? 'and the CI workflows were dispatched on it' : `and tested in a pull request against \`${l.branch}\` (${l.test_pr_url || ''})`}${t.reruns ? ` (failed jobs re-run ${t.reruns} time(s))` : ''}.${ci.squash ? ` The fixups were then squashed: \`${g.short(ci.squash.squashed)}\` has the same tree as the tested \`${g.short(ci.squash.tested)}\`.` : ''}`,
      t.branch ? tb : null);
    summary = `Test CI: ${r.state} (${where}).`;
  }
  if (!t?.sha && !f?.sha) { lines.push('No CI run for the current batch yet.\n'); summary = 'CI: not run yet for the current batch.'; }
  return { summary, lines };
}

const FIXES_RE = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s*(?:https:\/\/github\.com\/apache\/pulsar\/issues\/|apache\/pulsar#|#)(\d+)/gi;

/**
 * The issues each PR fixes, from its metadata on GitHub (closing issue references, and "Fixes #N" lines in the
 * description). Fetched once per PR in batched GraphQL queries and stored in items.stats.fixedIssues
 * ([{number, title}], empty when there is none), so a report does not fetch them again.
 */
export function fixedIssues(sid, prs) {
  const rows = new Map(db.all(`SELECT pr, stats FROM items WHERE session_id = ? AND pr IN (${prs.map(() => '?').join(',') || 'NULL'})`, sid, ...prs)
    .map((r) => [r.pr, db.J(r.stats, {})]));
  const todo = prs.filter((pr) => rows.has(pr) && !Array.isArray(rows.get(pr).fixedIssues));
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const query = `query { repository(owner: "apache", name: "pulsar") { ${batch.map((pr) => `p${pr}: pullRequest(number: ${pr}) { body closingIssuesReferences(first: 10) { nodes { number title } } }`).join(' ')} } }`;
    const r = spawnSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) break; // offline or rate limited: the report shows what is stored, the next one tries again
    const repo = db.J(r.stdout, {})?.data?.repository || {};
    for (const pr of batch) {
      const node = repo[`p${pr}`]; if (!node) continue;
      const list = new Map((node.closingIssuesReferences?.nodes || []).map((x) => [x.number, { number: x.number, title: x.title }]));
      for (const m of String(node.body || '').matchAll(FIXES_RE)) { const n = Number(m[1]); if (n !== pr && !list.has(n)) list.set(n, { number: n, title: null }); }
      const stats = { ...rows.get(pr), fixedIssues: [...list.values()] };
      db.run('UPDATE items SET stats = ? WHERE session_id = ? AND pr = ?', db.S(stats), sid, pr);
      rows.set(pr, stats);
    }
  }
  return new Map([...rows].map(([pr, st]) => [pr, st.fixedIssues || []]));
}

export function reportFile(sid, branch) {
  const dir = path.join(db.BPT_HOME, 'reports'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}-${branch}-backports.md`);
  fs.writeFileSync(file, laneReport(sid, branch));
  return file;
}

/** A secret gist of the report (gh gist create is secret unless --public). */
export function createGist(sid, branch) {
  const file = reportFile(sid, branch);
  const l = db.lane(sid, branch);
  const r = spawnSync('gh', ['gist', 'create', file, '--desc', `Pulsar backports to ${branch}${l.release ? ` (${l.release})` : ''}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh gist create failed: ${(r.stderr || '').trim()}`);
  const url = (r.stdout || '').trim().split('\n').pop();
  db.event(sid, `Backport report for ${branch} published as a secret gist: ${url}`, { branch });
  return { url, file };
}
