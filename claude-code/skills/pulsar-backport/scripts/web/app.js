// bpt web UI. Talks to the local bpt server; the token comes from the URL fragment printed by `bpt serve`.
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const chip = (text, cls = text) => h('span', { class: `chip ${cls || ''}` }, text);
const prTitle = (pr) => (S.plan?.items || []).find((it) => it.pr === Number(pr))?.title || null;
const prLink = (pr) => h('a', { href: `https://github.com/apache/pulsar/pull/${pr}`, target: '_blank', rel: 'noopener', title: prTitle(pr), onclick: (e) => e.stopPropagation() }, `#${pr}`);
/** Text with every #12345 turned into a link to the PR (its title on hover when the plan knows it). */
const linkPrs = (text) => String(text).split(/(?<![\w&])#(\d{3,6})\b/).map((part, i) => (i % 2 ? prLink(part) : part));
const short = (s) => (s || '').slice(0, 11);
const strip = (t) => (t || '').replace(/^(\[[^\]]*\]\s*)+/, '');
const when = (ts) => ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

// External links always open in a new tab, wherever they are rendered.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]'); if (!a) return;
  const url = new URL(a.href, location.href);
  if (url.origin === location.origin) return;
  e.preventDefault(); e.stopPropagation();
  window.open(url.href, '_blank', 'noopener');
}, true);

let TOKEN = location.hash.slice(1) || (() => { try { return sessionStorage.getItem('bpt-token'); } catch { return null; } })();
try { if (TOKEN) sessionStorage.setItem('bpt-token', TOKEN); } catch { /* private mode */ }
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

const S = { sessions: [], sid: null, summary: null, plan: null, tab: 'plan', lanePicks: {}, events: [], jobs: [],
  filter: { q: '', kind: 'all', show: 'actionable', verdict: 'any', decision: 'any', value: 'any', sort: 'order', branch: null }, open: new Set(), logJob: null, logOffset: 0 };
try { S.sid = localStorage.getItem('bpt-session'); S.tab = localStorage.getItem('bpt-tab') || 'plan'; } catch { /* ignore */ }

async function api(path, body) {
  const r = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-bpt-token': TOKEN || '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const COPY_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
/** A small button that copies the text to the clipboard. */
function copyBtn(text, what = 'path') {
  return h('button', { class: 'copy', type: 'button', title: `Copy ${what}: ${text}`, 'aria-label': `Copy ${what}`, html: COPY_SVG, onclick: async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`); } catch (err) { toast(`Copy failed: ${err.message}`, true); }
  } });
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, err ? 7000 : 2500);
}
async function act(action, branch, args, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try { const r = await api(`sessions/${S.sid}/action`, { action, branch, args }); toast(r.job ? `Queued job ${r.job}` : r.steps ? (r.steps.map((s) => `${s.branch ? s.branch + ': ' : ''}${s.note}`).join(' · ') || 'nothing to do') : 'Done'); await refresh(true); }
  catch (e) { toast(e.message, true); }
}

// ---------- sessions ----------
async function loadSessions() {
  S.sessions = await api('sessions');
  // Archived sessions are hidden unless "archived" is checked (the open one stays listed).
  const shown = S.sessions.filter((s) => $('#showArchived').checked || !s.archived || s.id === S.sid);
  const sel = $('#sessionPick'); sel.replaceChildren(...shown.map((s) => h('option', { value: s.id, selected: s.id === S.sid }, `${s.title} (${s.id})${s.archived ? ' — archived' : ''}`)));
  if (!shown.find((s) => s.id === S.sid)) S.sid = shown.find((s) => !s.archived)?.id || shown[0]?.id || null;
  sel.value = S.sid || '';
  $('#empty').hidden = !!S.sid; $('#session').hidden = !S.sid;
}
$('#sessionPick').onchange = (e) => { S.sid = e.target.value; S.plan = null; try { localStorage.setItem('bpt-session', S.sid); } catch {} refresh(true); };
$('#showArchived').onchange = async () => { await loadSessions(); refresh(true); };
$('#newSession').onclick = () => {
  const sel = $('#newAfter');
  sel.replaceChildren(h('option', { value: '' }, '— none: give the starting point —'),
    ...S.sessions.filter((s) => !s.archived || s.id === S.sid).map((s) => h('option', { value: s.id }, `${s.title} (${s.id})`)));
  const els = $('#newForm').elements; els.sincePr.disabled = els.sinceSha.disabled = false;
  $('#newAfterNote').textContent = 'Starts after the last master commit the chosen session evaluated, with its branches (a release that is already tagged moves to the next patch version).';
  $('#newDialog').showModal();
};
$('#newAfter').onchange = async (e) => {
  const f = $('#newForm').elements; const prev = e.target.value;
  f.sincePr.disabled = f.sinceSha.disabled = !!prev;
  if (!prev) return;
  try {
    const n = await api(`sessions/${encodeURIComponent(prev)}/next`);
    f.branches.value = n.branches; f.title.value = n.title; f.sincePr.value = ''; f.sinceSha.value = n.sinceSha;
    if (!f.id.value) {
      const base = `${new Date().toISOString().slice(0, 7)}-${n.branches.split(',').map((x) => x.split(/[:<]/)[1]).filter(Boolean).join('-')}`;
      let id = base; for (let i = 2; S.sessions.some((x) => x.id === id); i++) id = `${base}-${i}`;
      f.id.value = id;
    }
    $('#newAfterNote').textContent = `Starts after ${short(n.sinceSha)} ${n.sinceTitle}. ${Object.entries(n.released).map(([b, r]) => `${b}: ${r ? 'released, next patch version' : 'not released yet, same version'}`).join('; ')}.`;
  } catch (err) { toast(err.message, true); }
};
$('#newForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = Object.fromEntries(new FormData(e.target));
  if (f.after) { delete f.sincePr; f.sinceSha = e.target.elements.sinceSha.value; }
  try { const r = await api('sessions', f); S.sid = r.id; try { localStorage.setItem('bpt-session', r.id); } catch {} await loadSessions(); await refresh(true); toast('Session created; discovery queued'); }
  catch (err) { toast(err.message, true); }
});

// ---------- session header and lanes ----------
const STEPS = [['Pick', ['picking', 'needs-attention']], ['Verify', ['picked', 'verifying', 'verified']], ['Test CI', ['testing', 'ci-failed', 'ci-green']],
  ['Ready', ['ready']], ['Final CI', ['final-ci', 'final-ci-failed']], ['Done', ['done']]];
function steps(l) {
  const idx = STEPS.findIndex(([, ps]) => ps.includes(l.phase));
  return h('div', { class: 'steps' }, STEPS.map(([name], i) => {
    let cls = 'step';
    if (l.phase === 'done' || i < idx) cls += ' done';
    else if (i === idx) cls += /failed/.test(l.phase) ? ' bad' : l.phase === 'needs-attention' || l.attention ? ' attn' : ' now';
    return h('div', { class: cls }, name);
  }));
}

function laneButtons(l, sum) {
  const b = l.branch; const B = [];
  const btn = (label, action, args, opts = {}) => B.push(h('button', { class: opts.cls, disabled: opts.disabled, title: opts.title, onclick: () => act(action, b, args, opts.confirm) }, label));
  const job = sum.activeJobs.find((j) => j.branch === b);
  const src = l.reuse_from && sum.lanes.find((x) => x.branch === l.reuse_from);
  switch (l.phase) {
    case 'not-started': btn('Start lane', 'start', null, { cls: 'primary', disabled: sum.status !== 'backporting' || (src && !['ready', 'final-ci', 'final-ci-failed', 'done'].includes(src.phase)), title: src ? `Reuses ${src.branch}'s tested picks` : '' }); break;
    case 'picking': btn('Continue picking', 'pick-all', null, { cls: 'primary' }); break;
    case 'needs-attention': B.push(h('button', { class: 'primary', onclick: () => setTab(`picks:${b}`) }, 'Show picks')); btn('Continue picking', 'pick-all'); break;
    case 'picked': case 'verifying': btn('Verify with Claude', 'verify', null, { cls: 'primary' }); btn('Mark verified', 'mark-verified', null, { confirm: 'Mark the lane verified without a Claude build check?' }); break;
    case 'verified': btn('Push test branch + run CI', 'push-test', null, { cls: 'primary', confirm: `Push the lane to a test branch on apache/pulsar and dispatch CI there (no PR)?` }); break;
    case 'testing': btn('Poll CI now', 'poll'); break;
    case 'ci-failed': btn('Fix with Claude', 'fix-ci', null, { cls: 'primary' }); btn('Re-run failed jobs', 'rerun'); btn('Poll CI', 'poll'); break;
    case 'ci-green': btn('Squash fixups', 'squash', null, { cls: 'primary' }); break;
    case 'ready':
      btn(`Finalize: fast-forward ${b}`, 'finalize', {}, { cls: 'primary', confirm: `Fast-forward the local ${b} to the tested commits, push it to apache/pulsar (fast-forward only) and dispatch CI?` });
      if (l.ci?.rebase) btn('Push rebased (untested)', 'finalize', { allowRebase: true }, { cls: 'danger', confirm: `${b} moved since testing. Push the rebased batch without testing that combination?` });
      break;
    case 'final-ci': btn('Poll CI now', 'poll'); break;
    case 'final-ci-failed': btn('Fix with Claude', 'fix-ci', null, { cls: 'primary' }); btn('Re-run failed jobs', 'rerun'); break;
    default: break;
  }
  // Commits on top of the pushed head (a fix, a backport added later, a revert) wait for the user to push them.
  if (['final-ci', 'final-ci-failed', 'done'].includes(l.phase) && l.head_sha && l.final_sha && l.head_sha !== l.final_sha) {
    const onTop = (l.picks?.onTop || []).map((x) => `${x.kind} #${x.pr}`).join(', ');
    btn(`Push commits on top to ${b}${onTop ? ` (${onTop})` : ''}`, 'push-final-fix', null, { cls: 'primary', confirm: `Fast-forward the local ${b} to ${short(l.head_sha)} (${onTop || 'the commits on top'}), push it to apache/pulsar and dispatch CI?` });
  }
  if (!['not-started', 'final-ci', 'final-ci-failed', 'done'].includes(l.phase)) btn('Reset lane', 'reset', null, { cls: 'ghost danger', confirm: `Delete the ${b} lane worktree and forget its picks? The remote test branch stays.` });
  const wrap = h('div', { class: 'laneButtons' }, B);
  if (job) wrap.prepend(h('span', { class: 'small' }, chip(job.status, job.status), ' ', `${job.type}${job.args?.pr ? ` #${job.args.pr}` : ''} (${job.runner === 'claude' ? job.claimed_by === 'interactive' ? 'your Claude Code session' : 'Claude Code' : 'engine'}) `,
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLog(job.id); } }, 'log')));
  return wrap;
}

function laneCard(l, sum) {
  const p = l.picks; const ci = l.ci || {};
  const ciLine = (kind) => { const c = ci[kind]; if (!c) return null; return h('span', {}, `${kind === 'final' ? 'final' : 'test'} CI `, chip(c.state, c.state), c.failed?.length ? ` ${c.failed.length} failed` : '', c.reruns ? ` · ${c.reruns} rerun(s)` : ''); };
  return h('div', { class: 'lane' },
    h('div', { class: 'laneHead' }, h('b', {}, l.branch), l.release ? chip(l.release, '') : null, l.reuse_from ? h('span', { class: 'small muted' }, `reuses ${l.reuse_from}`) : null,
      h('span', { class: 'grow' }), (sum.needed || []).some((d) => d.branch === l.branch) ? chip(`${sum.needed.filter((d) => d.branch === l.branch).length} decision(s) needed`, 'blocked') : null,
      h('span', { class: 'small muted' }, l.phase)),
    steps(l),
    l.attention ? h('div', { class: 'attention small', title: l.attention }, h('span', { class: (sum.needed || []).some((d) => d.branch === l.branch) ? 'clamp' : '' }, ...linkPrs(l.attention))) : null,
    h('div', { class: 'laneStats' },
      h('span', {}, `${p.picked}/${p.total} picked`), p.conflict ? h('span', {}, chip(`${p.conflict} conflict`, 'conflict')) : null,
      p.blocked ? h('span', {}, chip(`${p.blocked} blocked`, 'blocked')) : null, p.needsFix ? h('span', {}, chip(`${p.needsFix} needs fix`, 'needs-fix')) : null,
      p.skipped ? h('span', {}, `${p.skipped} skipped`) : null,
      l.base_sha ? h('span', { class: 'mono' }, `${short(l.base_sha)}..${short(l.head_sha)}`) : null,
      l.worktree ? h('span', { class: 'small muted', title: l.worktree }, 'worktree ', copyBtn(l.worktree, 'worktree path')) : null,
      ci.test?.branch ? h('a', { href: ci.test.url, target: '_blank', title: 'workflow_dispatch runs on the test branch (no PR)' }, `test branch ${ci.test.branch}`)
        : l.test_pr_url ? h('a', { href: l.test_pr_url, target: '_blank' }, `test PR #${l.test_pr}`) : null, ciLine('test'), ciLine('final'),
      ci.test?.failed?.length && /failed/.test(l.phase) ? h('span', {}, ci.test.failed.slice(0, 4).map((f) => h('a', { href: f.link, target: '_blank', class: 'small' }, ` ${f.name}`))) : null),
    laneButtons(l, sum));
}

// ---------- decisions needed while backporting ----------
async function choose(d, o) {
  let text;
  if (o.input) { text = prompt(`${d.title}\n\n${o.label}: ${o.input}`, ''); if (text === null || (!text && !o.optional)) return; }
  if (o.confirm && !confirm(o.confirm)) return;
  try {
    const r = await api(`sessions/${S.sid}/control`, { key: d.key, option: o.id, text: text || undefined });
    const extra = [r.dropped?.length ? `dropped ${r.dropped.map((x) => `#${x}`).join(', ')}` : '', r.replayed?.length ? `re-applying ${r.replayed.map((x) => `#${x}`).join(', ')}` : '',
      r.rebuilt?.replayed?.length ? `rebuilt: re-applying ${r.rebuilt.replayed.map((x) => `#${x}`).join(', ')}` : '', r.pulledIn?.length ? `pulled in ${r.pulledIn.map((x) => `#${x}`).join(', ')}` : '', r.job ? `queued job ${r.job}` : ''].filter(Boolean);
    toast(`${o.label}${extra.length ? `: ${extra.join('; ')}` : ''}`); S.plan = null; await refresh(true);
  } catch (e) { toast(e.message, true); }
}
// Quoted code in a worker's text ('FutureUtils.exception(...)', `x`) shows as code; each line is a paragraph.
// A single quote opens only after a space or '(' and closes before a space or punctuation, so apostrophes stay text.
const CODE_RE = /`([^`]+)`|(?<=^|[\s(])'([^'\s][^'\n]*?[^'\s])'(?=$|[\s),.;:?!])/g;
function prose(text) {
  return String(text).split(/\n+/).filter((x) => x.trim()).map((para) => {
    const kids = []; let at = 0;
    for (const m of para.matchAll(CODE_RE)) {
      const code = m[1] ?? m[2];
      if (m[2] && !/[().;{}=<>\/#]/.test(code)) continue; // a quoted phrase, not code
      kids.push(...linkPrs(para.slice(at, m.index)), h('code', {}, code)); at = m.index + m[0].length;
    }
    kids.push(...linkPrs(para.slice(at)));
    return h('p', {}, ...kids);
  });
}
// The recommended option, when it can be applied with one click (no typed input, no confirmation).
const oneClick = (d) => d.options.find((o) => o.recommended && !(o.input && !o.optional) && !o.confirm);
async function continueRecommended(list) {
  const todo = list.filter(oneClick);
  if (!confirm(`Continue with the recommended action for ${todo.length} decision(s)?\n\n${todo.map((d) => `• ${d.pr ? `#${d.pr} ` : ''}${oneClick(d).label}${d.recommendation ? ` (${d.recommendation})` : ''}`).join('\n')}`)) return;
  try {
    const r = await api(`sessions/${S.sid}/control`, { recommended: true });
    const errs = r.done.filter((x) => x.error);
    toast(errs.length ? `${r.done.length - errs.length} done; ${errs.map((x) => x.error).join('; ')}` : `${r.done.length} decision(s) done`, !!errs.length);
    S.plan = null; await refresh(true);
  } catch (e) { toast(e.message, true); }
}
function renderNeeded(s) {
  const box = $('#needed'); const list = s.needed || [];
  box.hidden = !list.length; if (!list.length) { box.replaceChildren(); return; }
  const auto = list.filter(oneClick);
  box.replaceChildren(h('div', { class: 'needHead' }, h('h2', {}, `Decisions needed (${list.length})`), h('span', { class: 'grow' }),
    auto.length ? h('button', { class: 'primary', title: 'Choose the recommended option of each decision below that needs no typed input', onclick: () => continueRecommended(list) },
      auto.length === list.length ? 'Continue with recommended' : `Continue with recommended (${auto.length} of ${list.length})`) : null),
  ...list.map((d) => {
    const rec = d.options.find((o) => o.recommended);
    return h('div', { class: 'need' },
      h('div', { class: 'needTitle' }, d.branch ? chip(d.branch, '') : null, ' ', d.pr ? prLink(d.pr) : null, ' ', h('b', {}, ...linkPrs(d.pr ? d.title.replace(`#${d.pr} `, '') : d.title)),
        d.job ? h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); openLog(d.job); } }, ` job ${d.job} log`) : null),
      d.text ? h('div', { class: 'needText' }, prose(d.text)) : null,
      rec ? h('div', { class: 'needRec' }, h('span', { class: 'muted' }, 'Recommended: '), h('b', {}, ...linkPrs(rec.label)), ...(d.recommendation && rec.id === 'recommendation' ? [' — ', ...linkPrs(d.recommendation)] : [])) : null,
      h('div', { class: 'laneButtons' }, d.options.map((o) => h('button', { class: o.cls || (o.recommended ? 'primary' : ''), title: o.input || '', onclick: () => choose(d, o) }, o.label))));
  }));
}

function renderSession() {
  const s = S.summary; if (!s) return;
  renderNeeded(s);
  $('#sTitle').textContent = s.title;
  const v = (b) => Object.fromEntries(s.verdicts.filter((x) => x.branch === b).map((x) => [x.verdict, x.n]));
  const d = (b) => s.decisions.filter((x) => x.branch === b).reduce((o, x) => { o[x.decision] = (o[x.decision] || 0) + x.n; return o; }, {});
  $('#sMeta').replaceChildren(`${s.status} · PRs after ${short(s.config.sinceSha)}${s.config.masterHead ? ` up to ${s.config.masterHead}` : ''} · discover round ${s.config.round || 0}${s.config.lastDiscover ? ` (${when(s.config.lastDiscover)})` : ''}`,
    ...s.lanes.map((l) => { const vv = v(l.branch); const dd = d(l.branch); const mine = s.decisions.filter((x) => x.branch === l.branch && x.source === 'user').reduce((n, x) => n + x.n, 0);
      return h('div', {}, `${l.branch}: ${vv.pick || 0} pick · ${vv.maybe || 0} maybe · ${vv.untriaged || 0} untriaged — ${dd.backport || 0} backport, ${dd.undecided || 0} undecided (${mine} decided by you, the rest recommended)`); }),
    s.openDeps ? h('div', {}, chip(`${s.openDeps} open dependency hints on PRs that may go in`, 'blocked')) : '',
    s.comments?.pending || s.comments?.posted ? h('div', {}, `PR comments: ${s.comments.pending} queued (posted when every branch is done), ${s.comments.posted} posted`) : '');
  $('#autopilot').checked = !!s.config.autopilot; $('#runner').value = s.config.runner || 'headless'; $('#autoPushTest').checked = s.config.autoPushTest !== false;
  // A finished session is read-only: no actions, only its reports (the Report tab: download, VS Code, gist).
  const finished = s.status === 'finished'; const archived = !!s.config.archived;
  document.body.classList.toggle('finished', finished || archived);
  for (const id of ['#autopilot', '#runner', '#autoPushTest']) $(id).disabled = finished || archived;
  const lifecycle = sessionLifecycleButtons(s);
  if (archived) {
    $('#sessionActions').replaceChildren(h('div', { class: 'finishedNote' }, chip('archived', ''),
      ` Archived ${when(s.config.archived.at)}${s.config.archived.reason ? ` (${s.config.archived.reason})` : ''}: read-only and hidden from the session list. The reports stay available (Report tab). `), ...lifecycle);
    $('#lanes').replaceChildren(...s.lanes.map((l) => laneCard(l, s)));
    renderTabs();
    return;
  }
  if (finished) {
    $('#sessionActions').replaceChildren(h('div', { class: 'finishedNote' }, chip('finished', 'done'),
      ' Read-only: every lane is done and the queued PR comments are posted. The reports stay available (Report tab). To correct something: ',
      h('code', {}, `bpt session reopen ${S.sid} --reason "…"`)), ...lifecycle);
    $('#lanes').replaceChildren(...s.lanes.map((l) => laneCard(l, s)));
    renderTabs();
    return;
  }
  const A = [];
  const btn = (label, fn, cls) => A.push(h('button', { class: cls, onclick: fn }, label));
  btn('Discover new PRs', () => act('discover'));
  btn('Triage untriaged (Claude, one worker per batch)', () => act('triage', null, { instructions: prompt('Extra instructions for the triage worker (optional)') || undefined }));
  btn('Reset to recommendations…', async () => {
    const all = confirm('Reset decisions to the recommendations.\n\nOK: only the ones you have not changed yourself.\nCancel: choose next whether to reset everything.') ? false
      : confirm('Reset ALL decisions, including your own, to the recommendations?') ? true : null;
    if (all === null) return;
    try { const r = await api(`sessions/${S.sid}/recommend`, { all }); toast(`${r.changed} decisions reset`); S.plan = null; refresh(true); } catch (e) { toast(e.message, true); }
  }, 'ghost');
  btn('Labels…', showLabels);
  btn('Report → VS Code', () => act('report'), 'ghost');
  if (s.comments?.pending) btn(`Post ${s.comments.pending} comment(s) now`, () => act('post-comments', null, null, `Post the ${s.comments.pending} queued PR comment(s) on GitHub now, before the backport is finished?`), 'ghost');
  if (s.status === 'planning') btn('Start backporting', () => act('start-backport', null, null, 'Start backporting with the current decisions? Lanes start in order; later lanes wait for the lanes they reuse.'), 'primary');
  else { btn('Next step', () => act('advance', null, { force: true }), 'primary'); btn('Pause (back to planning)', () => act('stop-backport', null, null, 'Pause backporting? Running jobs continue; nothing new is started. The lanes keep their picks.'), 'ghost'); }
  const resettable = s.lanes.filter((l) => !['not-started', 'final-ci', 'final-ci-failed', 'done'].includes(l.phase));
  if (resettable.length) btn('Abort backporting…', () => {
    const reason = prompt(`Abort backporting and start again after revisiting the decisions?\n\nResets ${resettable.map((l) => l.branch).join(', ')}: cancels their jobs, deletes the lane worktrees and picks, and deletes their test branches. Lanes already pushed to the real branch are kept. The plan and its decisions stay.\n\nReason:`, 'revisiting the backport decisions');
    if (reason !== null) act('abort-backport', null, { reason });
  }, 'ghost danger');
  $('#sessionActions').replaceChildren(...A, ...lifecycle);
  $('#lanes').replaceChildren(...s.lanes.map((l) => laneCard(l, s)));
  renderTabs();
}
/** Archive / unarchive, and delete for a session that never started backporting. */
function sessionLifecycleButtons(s) {
  const out = [];
  const post = async (what, args, msg) => {
    try { await api(`sessions/${S.sid}/${what}`, args); toast(msg); if (what === 'delete') S.sid = null; await loadSessions(); await refresh(true); } catch (e) { toast(e.message, true); }
  };
  if (s.config.archived) out.push(h('button', { class: 'ghost', onclick: () => post('archive', { archived: false }, 'Unarchived') }, 'Unarchive'));
  else {
    out.push(h('button', { class: 'ghost', title: s.activeJobs?.length ? 'Cancel or wait for the active jobs first' : 'Read-only and hidden from the session list; can be unarchived',
      onclick: () => { const reason = prompt(`Archive session ${S.sid}? It becomes read-only and is hidden from the session list (autopilot off). Reason (optional):`, ''); if (reason !== null) post('archive', { reason: reason || null }, 'Archived'); } }, 'Archive…'));
  }
  if (!s.deleteBlockers?.length) {
    out.push(h('button', { class: 'ghost danger', title: 'Never started backporting: delete it with its plan and job logs',
      onclick: () => { if (confirm(`Delete "${s.title}" (${S.sid}) permanently?\n\nIt never started backporting. Its plan, decisions, triage files and job logs are removed; nothing on GitHub changes.`)) post('delete', { confirm: S.sid }, `Deleted ${S.sid}`); } }, 'Delete…'));
  }
  return out;
}
async function setConfig(patch) { try { await api(`sessions/${S.sid}/config`, patch); toast('Saved'); refresh(true); } catch (e) { toast(e.message, true); } }
$('#autopilot').onchange = (e) => setConfig({ autopilot: e.target.checked });
$('#runner').onchange = (e) => setConfig({ runner: e.target.value });
$('#autoPushTest').onchange = (e) => setConfig({ autoPushTest: e.target.checked });

async function showLabels() {
  const lp = await api(`sessions/${S.sid}/labels`);
  const list = (xs) => `${xs.slice(0, 20).map((x) => `#${x.pr} ${x.label}`).join(', ')}${xs.length > 20 ? ', …' : ''}`;
  const dec = lp.add.filter((x) => x.kind !== 'on-branch'); const onb = lp.add.filter((x) => x.kind === 'on-branch');
  const tags = Object.entries(lp.cycles || {}).map(([b, t]) => `${b} since ${t || '(no previous release tag)'}`).join(', ');
  const msg = `Release labels implied by the decisions:\n  add: ${dec.length} (${list(dec)})\n  remove: ${lp.remove.length} (${list(lp.remove)})\n`
    + `Master PRs already on a branch (cherry-picked or through a branch-specific PR) with missing labels:\n  add: ${onb.length} (${list(onb)})\n  release labels only for changes that reached the branch after its previous release: ${tags}\n\n`
    + 'OK applies the additions on GitHub. Removals are applied only if you confirm them next.';
  if (!lp.add.length && !lp.remove.length) { toast('Labels already match the decisions and the branches'); return; }
  if (!confirm(msg)) return;
  const removals = lp.remove.length ? confirm(`Also remove ${lp.remove.length} release label(s) from PRs decided "skip"?`) : false;
  act('apply-labels', null, { removals });
}

// ---------- tabs ----------
function setTab(t) { if (t === 'report') S.report = null; S.tab = t; try { localStorage.setItem('bpt-tab', t); } catch {} renderTabs(); refresh(); }
function renderTabs() {
  const s = S.summary;
  const started = s.lanes.filter((l) => l.phase !== 'not-started');
  const tabs = [['plan', 'Plan review'], ['all', 'All items'], ...started.map((l) => [`picks:${l.branch}`, `Picks ${l.branch}`]), ...(started.length ? [['report', 'Report']] : []), ['activity', 'Activity'], ['jobs', 'Jobs']];
  if (!tabs.find(([k]) => k === S.tab)) S.tab = 'plan';
  $('#tabs').replaceChildren(...tabs.map(([k, label]) => h('button', { class: S.tab === k ? 'on' : '', onclick: () => setTab(k) }, label)));
  if (S.tab === 'plan' || S.tab === 'all') renderPlan();
  else if (S.tab.startsWith('picks:')) renderPicks(S.tab.slice(6));
  else if (S.tab === 'activity') renderActivity();
  else if (S.tab === 'report') renderReport();
  else renderJobs();
}

// ---------- backport report ----------
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** The Markdown the report uses: headings, paragraphs, lists, tables, **bold**, _em_, `code`, [links](url). */
function mdInline(s) {
  return escHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https:\/\/github\.com\/[^\s)<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function mdToHtml(md) {
  const out = []; const lines = String(md).split('\n'); let i = 0;
  const cells = (l) => l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => mdInline(c.trim().replace(/\\\|/g, '|')));
  while (i < lines.length) {
    const l = lines[i];
    const hm = l.match(/^(#{1,4}) (.*)$/);
    if (hm) { out.push(`<h${hm[1].length + 1}>${mdInline(hm[2])}</h${hm[1].length + 1}>`); i++; continue; }
    if (l.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const body = rows.filter((r, k) => k !== 1 || !/^\|[\s|:-]+\|$/.test(r));
      out.push(`<table><thead><tr>${cells(body[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^- /.test(l)) { const it = []; while (i < lines.length && /^- /.test(lines[i])) it.push(lines[i++].slice(2)); out.push(`<ul>${it.map((x) => `<li>${mdInline(x)}</li>`).join('')}</ul>`); continue; }
    if (!l.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4} |- |\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${mdInline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
async function renderReport() {
  const lanes = S.summary.lanes.filter((l) => l.phase !== 'not-started');
  if (!lanes.find((l) => l.branch === S.reportBranch)) S.reportBranch = lanes[0]?.branch;
  const b = S.reportBranch; const body = $('#tabBody');
  const cached = S.report?.branch === b ? S.report.markdown : null;
  // Every request generates the report from the current state: the tab when opened or refreshed, the download, VS Code, the gist.
  const download = async () => {
    try {
      const md = (await api(`sessions/${S.sid}/lanes/${encodeURIComponent(b)}/report`)).markdown; S.report = { branch: b, markdown: md };
      const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `${S.sid}-${b}-backports.md` }); document.body.append(a); a.click(); a.remove(); renderReport();
    } catch (e) { toast(e.message, true); }
  };
  const gist = async () => {
    if (!confirm(`Create a secret GitHub gist of the ${b} backport report with your gh login? Anyone with the link can read a secret gist.`)) return;
    try { const r = await api(`sessions/${S.sid}/action`, { action: 'report-gist', branch: b }); S.gistUrl = r.url; toast(`Gist created: ${r.url}`); renderReport(); } catch (e) { toast(e.message, true); }
  };
  body.replaceChildren(h('div', { class: 'filters' },
    ...lanes.map((l) => h('button', { class: l.branch === b ? 'primary' : '', onclick: () => { S.reportBranch = l.branch; S.report = null; renderReport(); } }, l.branch)),
    h('span', { class: 'grow' }),
    h('button', { onclick: () => { S.report = null; renderReport(); } }, 'Refresh'),
    h('button', { onclick: download }, 'Download .md'),
    h('button', { onclick: () => act('report-open', b) }, 'Open in VS Code'),
    h('button', { onclick: gist }, 'Create secret gist'),
    S.gistUrl ? h('span', { class: 'small' }, h('a', { href: S.gistUrl, target: '_blank', rel: 'noopener' }, S.gistUrl), copyBtn(S.gistUrl, 'gist URL')) : null),
  cached ? h('article', { class: 'report', html: mdToHtml(cached) }) : h('p', { class: 'muted' }, 'Loading…'));
  if (!cached) {
    try { S.report = { branch: b, markdown: (await api(`sessions/${S.sid}/lanes/${encodeURIComponent(b)}/report`)).markdown }; if (S.tab === 'report') renderReport(); }
    catch (e) { toast(e.message, true); }
  }
}

// ---------- plan ----------
const DECISIONS = ['undecided', 'backport', 'skip', 'defer'];
// Open dependency hints that matter: the dependency is not on the branch and not already decided "backport".
function liveDeps(it) {
  const byPr = S.planIndex || (S.planIndex = new Map(S.plan.items.map((x) => [x.pr, x])));
  return it.deps.filter((d) => {
    if (d.status !== 'open') return false;
    const dep = byPr.get(d.depends_on); if (!dep) return true;
    const branches = d.branch ? [d.branch] : Object.keys(dep.targets);
    return branches.some((b) => { const t = dep.targets[b]; const mine = it.targets[b]; return mine && !mine.on_branch && (mine.decision === 'backport' || (mine.decision === 'undecided' && ['pick', 'maybe'].includes(mine.verdict))) && (!t || (!t.on_branch && t.decision !== 'backport')); });
  });
}
function visible(it, lanes) {
  const f = S.filter; const ts = lanes.map((l) => it.targets[l.branch]).filter(Boolean);
  if (f.q) { const q = f.q.toLowerCase(); if (!(`#${it.pr} ${it.title}`.toLowerCase().includes(q) || (it.assessment?.impact || '').toLowerCase().includes(q))) return false; }
  if (f.kind !== 'all' && it.kind !== f.kind) return false;
  if (f.show === 'actionable' && (it.excluded || ts.every((t) => t.on_branch))) return false;
  if (f.show === 'excluded' && !it.excluded) return false;
  if (f.show === 'equivalent' && !ts.some((t) => t.on_branch === 2 || t.equiv?.rejected)) return false;
  if (f.show === 'new' && it.round !== S.summary.config.round) return false;
  if (f.show === 'deps' && !liveDeps(it).length) return false;
  const tsel = f.branch ? [it.targets[f.branch]].filter(Boolean) : ts;
  if (f.verdict !== 'any' && !tsel.some((t) => (t.verdict || 'untriaged') === f.verdict)) return false;
  if (f.decision === 'changed') { if (!tsel.some((t) => !t.on_branch && t.recommendation && t.decision !== t.recommendation)) return false; }
  else if (f.decision !== 'any' && !tsel.some((t) => t.decision === f.decision && !t.on_branch)) return false;
  const val = it.assessment?.value || 'none';
  if (f.value !== 'any' && val !== f.value) return false;
  return true;
}
async function decide(items) {
  try {
    const { changed } = await api(`sessions/${S.sid}/decision`, { items });
    const map = new Map(changed.map((x) => [`${x.pr}|${x.branch}`, x.decision]));
    for (const it of S.plan.items) for (const b of Object.keys(it.targets)) { const k = `${it.pr}|${b}`; if (map.has(k) && it.targets[b]) { it.targets[b].decision = map.get(k); it.targets[b].decision_source = 'user'; } }
    const via = changed.filter((c) => c.viaGroup);
    if (via.length) toast(`Group changed together: ${via.map((c) => `#${c.pr}`).join(', ')} → ${via[0].decision} on ${via[0].branch}`);
    renderPlan(); refresh();
  } catch (e) { toast(e.message, true); }
}
async function setValue(pr, value, note) {
  try { await api(`sessions/${S.sid}/value`, { pr, value, note }); const it = S.plan.items.find((x) => x.pr === pr); it.assessment = { ...(it.assessment || {}), value, valueSource: 'user', ...(note !== undefined ? { valueNote: note } : {}) }; toast('Value saved'); renderPlan(); }
  catch (e) { toast(e.message, true); }
}
const VALUES = ['high', 'medium', 'low'];
const valueCls = (v) => (v === 'high' ? 'pick' : v === 'medium' ? 'maybe' : '');
async function review(prs, reviewed = true) {
  try {
    const r = await api(`sessions/${S.sid}/review`, { prs, reviewed });
    const set = new Set(r.prs);
    for (const it of S.plan.items) if (set.has(it.pr)) {
      it.reviewed_at = reviewed ? new Date().toISOString() : null;
      if (reviewed) for (const t of Object.values(it.targets)) if (t && !t.on_branch) t.decision_source = 'user';
    }
    toast(`${reviewed ? 'Accepted' : 'Back in review'}: ${r.prs.map((p) => `#${p}`).join(', ')}`);
    renderPlan(); refresh();
  } catch (e) { toast(e.message, true); }
}
function decisionSummary(it, lanes) {
  return lanes.map((l) => { const t = it.targets[l.branch]; return !t ? '' : t.on_branch ? `${l.branch}: on branch` : `${l.branch}: ${t.decision}`; }).filter(Boolean).join(', ');
}
function planRow(it, lanes, mode, inGroup) {
  const a = it.assessment || {};
  const openDeps = liveDeps(it);
  const reviewCell = inGroup ? h('td', { class: 'small muted' }, it.reviewed_at ? chip('reviewed', 'done') : 'with group')
    : it.reviewed_at
      ? h('td', {}, h('div', { class: 'cell2' }, chip('reviewed', 'done'), h('button', { class: 'ghost small', onclick: (e) => { e.stopPropagation(); review([it.pr], false); } }, 'Undo')))
      : h('td', {}, h('button', { class: 'primary small', title: `Accept: ${decisionSummary(it, lanes)}`, onclick: (e) => { e.stopPropagation(); review([it.pr]); } }, '✓ Accept'));
  const tr = h('tr', { class: `row${inGroup ? ' inGroup' : ''}${it.reviewed_at ? ' reviewed' : ''}`, onclick: () => { S.open.has(it.pr) ? S.open.delete(it.pr) : S.open.add(it.pr); renderPlan(); } },
    h('td', { class: 'title' }, prLink(it.pr), ' ', it.round === S.summary.config.round && S.summary.config.round > 1 ? chip('new', 'new') : null, ' ', strip(it.title),
      it.kind === 'flaky' ? h('span', {}, ' ', chip('flaky', '')) : null,
      it.stats?.pulledIn?.length ? h('span', { title: `Merged before the plan's first PR; added because ${it.stats.pulledIn.map((x) => `#${x}`).join(', ')} depend(s) on it` }, ' ', chip(`dependency of ${it.stats.pulledIn.map((x) => `#${x}`).join(', ')}`, 'maybe')) : null,
      it.stats?.labelledIn?.length ? h('span', { title: `Merged before the plan's first PR; added because it is labelled ${it.stats.labelledIn.join(', ')}` }, ' ', chip(`labelled ${it.stats.labelledIn.map((x) => x.replace('release/', '')).join(', ')}`, 'maybe'))
        : it.stats?.releaseLabels?.length ? h('span', { title: `Labelled ${it.stats.releaseLabels.join(', ')}: evaluated even if the pre-filter would leave it out` }, ' ', chip(it.stats.releaseLabels.map((x) => x.replace('release/', '')).join(', '), '')) : null,
      it.comment ? h('span', { title: it.comment }, ' ', commentChip(it)) : null,
      it.excluded ? h('div', { class: 'small muted' }, `excluded: ${it.excluded}`) : null,
      a.impact ? h('div', { class: 'small muted' }, a.impact) : null),
    h('td', { class: 'value' }, h('div', { class: 'cell2' },
      h('select', { class: `val ${valueCls(a.value)}`, title: a.valueSource === 'user' ? 'Set by you' : 'From triage; change it if you know better', onclick: (e) => e.stopPropagation(), onchange: (e) => setValue(it.pr, e.target.value || null) },
        h('option', { value: '', selected: !a.value }, '–'), ...VALUES.map((v) => h('option', { value: v, selected: a.value === v }, v))),
      a.valueNote ? h('span', { class: 'small muted' }, a.valueNote) : null,
      a.valueSource === 'user' ? h('span', { class: 'small muted' }, 'set by you') : null)),
    h('td', {}, h('div', { class: 'cell2' }, a.severity ? chip(a.severity, a.severity === 'high' ? 'conflict' : a.severity === 'medium' ? 'maybe' : '') : '', a.risk ? h('span', { class: 'small muted' }, `risk ${a.risk}`) : '')),
    ...lanes.map((l) => {
      const t = it.targets[l.branch];
      if (!t) return h('td', {}, '–');
      if (t.on_branch === 2) return h('td', {}, equivCell(it, l.branch, t));
      if (t.on_branch) return h('td', {}, chip('on branch', 'done'));
      return h('td', {}, h('div', { class: 'cell2' },
        h('span', {}, chip(t.verdict || 'untriaged', t.verdict), ' ', t.dryrun ? chip(t.dryrun.state === 'tests' ? 'tests conflict' : t.dryrun.state === 'main' ? 'main conflict' : t.dryrun.state, t.dryrun.state) : null),
        h('select', { class: `dec ${t.decision}`, onclick: (e) => e.stopPropagation(), onchange: (e) => decide([{ pr: it.pr, branch: l.branch, decision: e.target.value }]) },
          DECISIONS.map((d) => h('option', { value: d, selected: t.decision === d }, `${d}${d === t.recommendation ? ' (recommended)' : ''}`))),
        t.decision_source === 'user'
          ? h('span', { class: 'small' }, chip(it.reviewed_at ? 'accepted' : 'your decision', 'backport'), t.recommendation && t.recommendation !== t.decision ? h('span', { class: 'muted' }, ` · recommended ${t.recommendation}`) : null)
          : t.recommendation ? h('span', { class: 'small muted' }, 'recommended') : null,
        t.lean ? h('span', { class: 'small muted' }, `lean: ${t.lean}`) : null,
        t.equiv?.rejected ? h('span', { class: 'small muted' }, 'not the same as ', t.equiv.branchPr ? prLink(t.equiv.branchPr) : short(t.equiv.commit), ' ',
          h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); setEquiv(it.pr, l.branch, false); } }, 'undo')) : null));
    }),
    h('td', {}, openDeps.length ? chip(`${openDeps.length} open`, 'blocked') : it.deps.length ? h('span', { class: 'small muted' }, `${it.deps.length}`) : ''),
    reviewCell);
  const out = [tr];
  if (S.open.has(it.pr)) out.push(h('tr', { class: `detail${inGroup ? ' inGroup' : ''}` }, h('td', { colspan: 5 + lanes.length }, planDetail(it, lanes))));
  return out;
}
function groupHead(members, lanes, mode) {
  const mixed = lanes.filter((l) => new Set(members.map((m) => m.targets[l.branch]).filter((t) => t && !t.on_branch).map((t) => t.decision)).size > 1);
  const allReviewed = members.every((m) => m.reviewed_at);
  return h('tr', { class: 'groupHead' }, h('td', { colspan: 5 + lanes.length },
    h('div', { class: 'groupBar' },
      h('b', {}, `Dependency group of ${members.length}`), ' ', ...members.map((m) => h('span', {}, prLink(m.pr), ' ')),
      mixed.length ? chip(`decisions differ on ${mixed.map((l) => l.branch).join(', ')}`, 'conflict') : chip('decisions agree', 'done'),
      h('span', { class: 'small muted' }, 'Accepted together; each PR keeps its own decision. Dismiss a dependency in a row\'s details to split the group.'),
      h('span', { class: 'grow' }),
      allReviewed
        ? h('span', {}, chip('reviewed', 'done'), ' ', h('button', { class: 'ghost small', onclick: () => review(members.map((m) => m.pr), false) }, 'Undo'))
        : h('button', { class: 'primary', title: 'Accept every member\'s decisions', onclick: () => {
          if (mixed.length && !confirm(`The decisions in this group differ:\n\n${members.map((m) => `#${m.pr}: ${decisionSummary(m, lanes)}`).join('\n')}\n\nAccept them as they are?`)) return;
          review(members.map((m) => m.pr));
        } }, `✓ Accept group (${members.length})`))));
}
// One search box for the life of the page: re-renders (typing, the periodic refresh) reuse it, so the text being
// typed is never reset, and focus and the caret come back after the filter bar is rebuilt.
let searchEl = null;
function searchBox(f) {
  if (!searchEl) {
    searchEl = h('input', { type: 'search', placeholder: 'Search PR, title, impact', value: f.q,
      oninput: (e) => { clearTimeout(searchBox.t); searchBox.t = setTimeout(() => { if (f.q !== e.target.value) { f.q = e.target.value; renderPlan(); } }, 400); } });
  }
  return searchEl;
}

function renderPlan() {
  const typing = searchEl && document.activeElement === searchEl ? [searchEl.selectionStart, searchEl.selectionEnd] : null;
  try { renderPlanBody(); } finally {
    if (typing && searchEl.isConnected && document.activeElement !== searchEl) { searchEl.focus({ preventScroll: true }); searchEl.setSelectionRange(...typing); }
  }
}

function renderPlanBody() {
  const body = $('#tabBody');
  if (!S.plan) { body.replaceChildren(h('p', { class: 'muted' }, 'Loading plan…')); return; }
  const mode = S.tab === 'all' ? 'all' : 'review';
  const { lanes, items } = S.plan; const f = S.filter;
  const byPr = new Map(items.map((x) => [x.pr, x]));
  const rank = { high: 0, medium: 1, low: 2 };
  const pool = mode === 'all' ? items : items.filter((it) => !it.reviewed_at);
  const rows = pool.filter((it) => visible(it, lanes));
  if (f.sort === 'value') rows.sort((a, b) => (rank[a.assessment?.value] ?? 3) - (rank[b.assessment?.value] ?? 3) || a.master_order - b.master_order);
  if (f.sort === 'severity') rows.sort((a, b) => (rank[a.assessment?.severity] ?? 3) - (rank[b.assessment?.severity] ?? 3) || a.master_order - b.master_order);
  // Dependency groups stay together, at the position of their first matching member.
  const blocks = []; const placed = new Set();
  for (const it of rows) {
    if (placed.has(it.pr)) continue;
    if (it.group?.length > 1) {
      const members = it.group.map((p) => byPr.get(p)).filter((m) => m && (mode === 'all' || !m.reviewed_at));
      members.forEach((m) => placed.add(m.pr));
      blocks.push({ members });
    } else { placed.add(it.pr); blocks.push({ one: it }); }
  }
  const shownPrs = blocks.flatMap((b) => (b.members || [b.one]).map((m) => m.pr));
  const sel = (key, opts) => h('select', { onchange: (e) => { f[key] = e.target.value === '' ? null : e.target.value; renderPlan(); } }, opts.map(([v, l]) => h('option', { value: v ?? '', selected: (f[key] ?? '') === (v ?? '') }, l)));
  const rv = S.summary.review || {};
  const filters = h('div', { class: 'filters' },
    searchBox(f),
    sel('show', [['actionable', 'Not on branch, in scope'], ['new', 'New this round'], ['deps', 'Open dependency hints'], ['equivalent', 'On branch via another PR'], ['excluded', 'Excluded by pre-filter'], ['all', 'Everything']]),
    sel('kind', [['all', 'Code + flaky'], ['code', 'Code fixes'], ['flaky', 'Flaky-test fixes']]),
    sel('branch', [[null, 'Any branch'], ...lanes.map((l) => [l.branch, l.branch])]),
    sel('verdict', [['any', 'Any verdict'], ['pick', 'pick'], ['maybe', 'maybe'], ['skip', 'skip'], ['already', 'already'], ['untriaged', 'untriaged']]),
    sel('decision', [['any', 'Any decision'], ...DECISIONS.map((d) => [d, d]), ['changed', 'Differs from recommendation']]),
    sel('value', [['any', 'Any value'], ...VALUES.map((v) => [v, `value ${v}`]), ['none', 'value not assessed']]),
    sel('sort', [['order', 'Master order'], ['value', 'Value first'], ['severity', 'Severity first']]),
    h('span', { class: 'muted small' }, `${shownPrs.length} shown · ${blocks.filter((b) => b.members).length} groups · ${rv.reviewed || 0} of ${rv.total || 0} reviewed`),
    h('span', { class: 'grow' }),
    mode === 'review' && shownPrs.length ? h('button', { onclick: () => { if (confirm(`Accept the current decisions of all ${shownPrs.length} shown PRs (groups included) and remove them from the review list?`)) review(shownPrs); } }, `✓ Accept all shown (${shownPrs.length})`) : null,
    ...lanes.map((l) => h('select', { title: `Set the decision for every shown row on ${l.branch}`, onchange: (e) => { const d = e.target.value; e.target.value = ''; if (!d) return;
      const list = shownPrs.map((p) => byPr.get(p)).filter((it) => it.targets[l.branch] && !it.targets[l.branch].on_branch).map((it) => ({ pr: it.pr, branch: l.branch, decision: d }));
      if (confirm(`Set ${list.length} shown PRs to "${d}" on ${l.branch}?`)) decide(list); } },
    h('option', { value: '' }, `Bulk ${l.branch}…`), ...DECISIONS.map((d) => h('option', { value: d }, d)))));
  const head = h('tr', {}, h('th', {}, 'PR'), h('th', {}, 'Value for users'), h('th', {}, 'Sev / risk'), ...lanes.map((l) => h('th', {}, `${l.branch} decision`)), h('th', {}, 'Deps'), h('th', {}, mode === 'all' ? 'Review' : 'Accept'));
  const tbody = h('tbody');
  let n = 0;
  for (const b of blocks) {
    if (n > 600) break;
    if (b.members) {
      tbody.append(groupHead(b.members, lanes, mode));
      let last = null;
      for (const m of b.members) { const trs = planRow(m, lanes, mode, true); tbody.append(...trs); last = trs.at(-1); n++; }
      last?.classList.add('groupEnd'); // closes the group's frame, below an open details row too
    }
    else { tbody.append(...planRow(b.one, lanes, mode, false)); n++; }
  }
  const empty = !blocks.length ? h('p', { class: 'muted' }, mode === 'review' ? 'Nothing left to review with these filters. "All items" shows the reviewed ones.' : 'No rows match the filters.') : null;
  body.replaceChildren(filters, h('table', {}, h('thead', {}, head), tbody), empty, n > 600 ? h('p', { class: 'muted' }, 'Showing the first 600 rows; narrow the filter.') : '');
}
const VIA = { 'patch-id': 'identical diff', reference: 'branch PR references it', title: 'same title', upgrade: 'newer upgrade on the branch', label: 'cherry-picked label' };
function equivCell(it, branch, t) {
  const e = t.equiv || {};
  return h('div', { class: 'cell2' },
    h('span', {}, chip('on branch (equivalent)', 'done')),
    h('span', { class: 'small' }, e.branchPr ? prLink(e.branchPr) : null, e.commit ? h('span', { class: 'mono' }, ` ${short(e.commit)}`) : null),
    h('span', { class: 'small muted', title: e.subject || '' }, `${VIA[e.via] || e.via}${e.detail && e.via === 'upgrade' ? `: ${e.detail}` : ''}`),
    h('button', { class: 'ghost small', onclick: (ev) => { ev.stopPropagation(); setEquiv(it.pr, branch, true); }, title: 'The branch commit is a different change; plan this PR for the branch' }, 'Not the same'));
}
async function setEquiv(pr, branch, rejected) {
  try { await api(`sessions/${S.sid}/equiv`, { pr, branch, rejected }); toast(rejected ? `#${pr} back in the plan for ${branch}` : `#${pr} treated as on ${branch}`); S.plan = null; refresh(true); }
  catch (e) { toast(e.message, true); }
}
function commentChip(it) {
  const st = it.comment_state?.status || 'pending';
  return st === 'posted' ? chip('comment posted', 'done') : st === 'failed' ? chip('comment failed', 'failed') : chip('comment queued', 'blocked');
}
function commentEditor(it) {
  const st = it.comment_state || {};
  if (st.status === 'posted') {
    return h('div', { class: 'comment small' }, h('b', {}, 'Comment posted '), st.url ? h('a', { href: st.url, target: '_blank', rel: 'noopener' }, 'on GitHub') : null, h('div', { class: 'muted' }, it.comment));
  }
  const id = `cm-${it.pr}`;
  const save = async (text) => { try { await api(`sessions/${S.sid}/comment`, { pr: it.pr, text }); it.comment = text.trim() || null; it.comment_state = it.comment ? { status: 'pending' } : null; toast(it.comment ? 'Comment queued' : 'Comment removed'); renderPlan(); refresh(); } catch (e) { toast(e.message, true); } };
  return h('div', { class: 'comment', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'small' }, h('b', {}, 'Comment to post on this PR'), h('span', { class: 'muted' }, ' — posted from your gh account after every branch is pushed and green'),
      st.status === 'failed' ? h('span', {}, ' ', chip('failed', 'failed'), ` ${st.error || ''}`) : null),
    h('textarea', { id, rows: 3, placeholder: 'e.g. This PR would need to be separately backported to branch-4.2 & branch-4.0 since the fix depends on #27039.' }, it.comment || ''),
    h('div', { class: 'laneButtons' },
      h('button', { onclick: async () => { const r = await api(`sessions/${S.sid}/comment`, { pr: it.pr, template: 'separate-backport' }); const ta = $(`#${id}`); ta.value = r.text + (ta.value ? `\n\n${ta.value}` : ''); ta.focus(); } }, 'Insert "needs a separate backport"'),
      h('button', { class: 'primary', onclick: () => save($(`#${id}`).value) }, it.comment ? 'Update comment' : 'Queue comment'),
      it.comment ? h('button', { class: 'ghost', onclick: () => save('') }, 'Remove') : null));
}
function planDetail(it, lanes) {
  const a = it.assessment || {};
  const kv = (k, v) => v ? [h('div', { class: 'muted small' }, k), h('div', {}, v)] : [];
  const depRow = (d) => h('div', { class: 'dep small' }, chip(d.status, d.status === 'open' ? 'blocked' : d.status === 'accepted' ? 'backport' : 'skip'),
    'needs ', prLink(d.depends_on), ` ${d.branch || 'all branches'} · ${d.source}${d.phase === 'backport' ? ' (found while backporting)' : ''} · ${d.detail || ''}`,
    d.status !== 'accepted' ? h('button', { onclick: () => setDep(d.id, 'accepted'), title: 'Add the dependency to the batch' }, 'Accept') : null,
    d.status !== 'dismissed' ? h('button', { class: 'ghost', onclick: () => setDep(d.id, 'dismissed') }, 'Dismiss') : null);
  return h('div', {},
    h('div', { class: 'grid2' }, ...kv('Impact', a.impact), h('div', { class: 'muted small' }, 'Value note'),
      h('div', {}, h('input', { value: a.valueNote || '', size: 90, placeholder: 'Who benefits and how', onclick: (e) => e.stopPropagation(), onchange: (e) => setValue(it.pr, a.value || null, e.target.value) })), ...kv('Risk note', a.riskNote), ...kv('Reason', a.reason), ...kv('Labels', it.labels.join(', ')),
      ...kv('Change', `${it.stats.files} files, ${it.stats.main} main Java, +${it.stats.add} −${it.stats.del} · ${short(it.sha)} · merged ${when(it.merged_at)}`),
      ...lanes.flatMap((l) => { const t = it.targets[l.branch]; if (!t || t.on_branch) return [];
        return kv(l.branch, h('div', {}, t.evidence ? h('div', {}, `Bug: ${t.bug || '?'} — ${t.evidence}`) : null, t.adapt ? h('div', {}, `Adapt: ${t.adapt}`) : null,
          t.dryrun?.conflicts?.length ? h('div', { class: 'small' }, `Dry run on ${t.dryrun.head}: ${t.dryrun.conflicts.map((c) => `${c.file}${c.test ? ' (test)' : ''} ${c.hunks}h`).join(', ')}`) : null,
          h('div', {}, h('input', { value: t.note || '', placeholder: 'Port note', size: 70, onclick: (e) => e.stopPropagation(), onchange: (e) => api(`sessions/${S.sid}/note`, { pr: it.pr, branch: l.branch, note: e.target.value }).then(() => toast('Note saved')) })),
          t.decision_note ? h('div', { class: 'small muted' }, t.decision_note) : null)); })),
    commentEditor(it),
    h('div', { class: 'deps' }, ...it.deps.map(depRow),
      h('div', { class: 'dep small' }, 'Add dependency: #', h('input', { size: 7, id: `dep-${it.pr}`, onclick: (e) => e.stopPropagation() }),
        h('button', { onclick: async (e) => { e.stopPropagation(); const v = Number($(`#dep-${it.pr}`).value); if (!v) return; try { depToast(await api(`sessions/${S.sid}/deps`, { pr: it.pr, dependsOn: v }), `Dependency #${it.pr} → #${v} added`); } catch (err) { toast(err.message, true); } S.plan = null; refresh(true); } }, 'Add'),
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', onclick: (e) => { e.stopPropagation(); api(`sessions/${S.sid}/include`, { pr: it.pr, include: !!it.excluded }).then(() => { S.plan = null; refresh(true); }); } }, it.excluded ? 'Include in scope' : 'Exclude from scope'))));
}
// Says when a dependency brought a PR from before the plan's range into the plan, or names one not found on master.
function depToast(r, msg) {
  const extra = [r?.pulledIn?.length ? `${r.pulledIn.map((x) => `#${x}`).join(', ')} added to the plan (merged before its range)` : '',
    r?.notOnMaster?.length ? `${r.notOnMaster.map((x) => `#${x}`).join(', ')} is not a merged PR on master` : ''].filter(Boolean);
  toast(extra.length ? `${msg}; ${extra.join('; ')}` : msg, !!r?.notOnMaster?.length);
}
async function setDep(id, status) { try { depToast(await api(`sessions/${S.sid}/deps`, { id, status }), `Dependency ${status}`); S.plan = null; await refresh(true); } catch (e) { toast(e.message, true); } }

// ---------- picks ----------
function renderPicks(branch) {
  const d = S.lanePicks[branch]; const body = $('#tabBody');
  if (!d) { body.replaceChildren(h('p', { class: 'muted' }, 'Loading…')); return; }
  const pushed = ['final-ci', 'final-ci-failed', 'done'].includes(d.phase);
  const titles = new Map((S.plan?.items || []).map((it) => [it.pr, it.title]));
  const rows = d.picks.map((p, i) => {
    const det = p.detail || {};
    const extra = [];
    if (det.conflicts?.length) extra.push(h('div', { class: 'small' }, `Conflicts: ${det.conflicts.join(', ')}`));
    if (det.conflictDeps?.length) extra.push(h('div', { class: 'small' }, 'Missing master commits that also touch these files: ', ...det.conflictDeps.map((c) => h('span', {}, prLink(c.depends_on), ` (${c.decision}) `))));
    if (det.unmet?.length) extra.push(h('div', { class: 'small' }, 'Blocked on: ', ...det.unmet.map((u) => h('span', {}, prLink(u.depends_on), ` ${u.source}: ${u.detail || ''} `))));
    if (det.newDeps?.length) extra.push(h('div', { class: 'small' }, 'Found while backporting: ', ...det.newDeps.map((u) => h('span', {}, prLink(u.depends_on), ` ${u.detail} `))));
    if (det.warnings?.length) extra.push(h('div', { class: 'small muted' }, det.warnings.join('; ')));
    if (det.reason) extra.push(h('div', { class: 'small muted' }, `${det.dropped ? 'Dropped' : 'Skipped'}: ${det.reason}`));
    if (det.replay && p.status === 'pending') extra.push(h('div', { class: 'small muted' }, `Re-applied from the lane's earlier commit ${short(p.source_sha)}${det.extras?.length ? ` with ${det.extras.length} fixup(s)` : ''}`));
    if (det.validation) extra.push(h('div', { class: 'small muted' }, `Resolved; validated with ${det.validation.tests.join(', ').replaceAll('+', '+\u200b')}: ${det.validation.result}`));
    else if (det.resolvedAt) extra.push(h('div', { class: 'small muted' }, 'Resolved without reported tests'));
    if (det.outOfOrder) extra.push(h('div', { class: 'small muted' }, `Out of master order: ${det.outOfOrder}`));
    if (det.check && !det.check.ok) extra.push(h('pre', { class: 'check' }, det.check.output));
    const bc = det.build;
    if (bc) extra.push(h('div', { class: 'small muted' }, bc.skipped ? `Build check skipped: ${bc.skipped}`
      : `Build check ${bc.ok ? 'passed' : bc.accepted ? `failed, accepted: ${bc.accepted}` : `failed (${bc.stage})`}: ${bc.modules.join(', ')}${bc.tests ? `; tests ${bc.tests.replaceAll('+', '+\u200b')}` : '; no changed tests'}`));
    if (bc && !bc.ok && !bc.accepted) extra.push(h('pre', { class: 'check' }, bc.output));
    const B = [];
    const b = (label, action, args, opts = {}) => B.push(h('button', { class: opts.cls, onclick: () => act(action, branch, args, opts.confirm) }, label));
    // A job already working on this pick (a resolver, queued, running or waiting for an answer).
    const job = (S.summary?.activeJobs || []).find((j) => j.branch === branch && j.args?.pr === p.pr);
    const stop = job ? `\n\nThis cancels ${job.type} job ${job.id} (${job.status}) first${job.status === 'running' ? ' and discards its uncommitted changes' : ''}.` : '';
    if (job) B.push(h('span', { class: 'small' }, chip(job.status, job.status), ` ${job.type} job ${job.id} `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLog(job.id); } }, 'log')));
    if (['conflict', 'needs-fix'].includes(p.status) && !job) { b('Resolve with Claude', 'resolve', { pr: p.pr }, { cls: 'primary' }); b('I resolved it', 'resolved', { pr: p.pr }); }
    if (p.status === 'blocked') { b('Re-check', 'unblock', { pr: p.pr }); }
    if (['pending', 'conflict', 'blocked'].includes(p.status)) b('Skip', 'skip', { pr: p.pr, reason: '' }, { cls: 'ghost', confirm: `Skip #${p.pr} on ${branch}? Its decision becomes "skip".${stop}` });
    if (['picked', 'needs-fix'].includes(p.status) && !pushed) B.push(h('button', { class: 'ghost danger', onclick: () => {
      const reason = prompt(`Drop #${p.pr} from ${branch}? Its decision becomes "skip".${stop}\n\nThe lane is rebuilt from its commit: later picks are re-applied from their lane commits (resolutions and fixups kept), then verified and tested again. A pushed test branch is replaced by a new one (next round).\n\nReason:`, '');
      if (reason !== null) act('drop', branch, { pr: p.pr, reason: reason || 'dropped from the UI' });
    } }, 'Drop'));
    if (p.status !== 'skipped' && !pushed) B.push(h('button', { class: 'ghost', onclick: () => {
      const dep = prompt(`#${p.pr} needs another PR first on ${branch}? PR number of the dependency (it is backported in master order; the lane is rebuilt if later commits are already in):`, '');
      if (!dep || !/^\d+$/.test(dep.trim())) return;
      const detail = prompt('Why (optional):', '') || undefined;
      act('add-dep', branch, { pr: p.pr, dep: Number(dep.trim()), detail });
    } }, 'Add dependency…'));
    if (p.picked_sha) B.unshift(h('button', { onclick: () => openCompare(branch, p.pr) }, 'Compare'));
    const rv = reviewOf(p);
    if (rv && rv.verdict !== 'ok') extra.push(h('div', { class: 'small' }, chip(rv.label, rv.cls), ' ', prose(rv.r.concerns || rv.r.summary)));
    return h('tr', { class: 'pickRow' }, h('td', { class: 'muted small' }, i + 1), h('td', {}, prLink(p.pr), ' ', strip(titles.get(p.pr) || ''), det.reused ? h('span', { class: 'small muted' }, ' (reused)') : null, ...extra),
      h('td', {}, chip(p.status, p.status)), h('td', {}, rv ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openCompare(branch, p.pr); } }, chip(rv.label, rv.cls)) : h('span', { class: 'muted small' }, p.picked_sha ? 'not yet' : '')),
      h('td', { class: 'mono' }, short(p.picked_sha) || h('span', { class: 'muted' }, short(p.source_sha))), h('td', {}, h('div', { class: 'laneButtons' }, B)));
  });
  body.replaceChildren(h('div', { class: 'filters' }, h('span', { class: 'small muted' }, `Worktree ${d.worktree || '–'}`, d.worktree ? copyBtn(d.worktree, 'worktree path') : null, ` · local branch ${d.local_branch || '–'}`), h('span', { class: 'grow' }),
    h('button', { onclick: () => act('sync', branch) }, 'Sync with plan decisions')),
  h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'PR'), h('th', {}, 'Status'), h('th', {}, 'Review'), h('th', {}, 'Commit'), h('th', {}, ''))), h('tbody', {}, rows)));
}

// ---------- diff review: the master commit and the backport side by side ----------
/** The review of a pick for its current commit: {r, verdict, label, cls}, or null. */
function reviewOf(p) {
  const r = p.detail?.review;
  if (!r || r.sha !== p.picked_sha) return null;
  const accepted = r.verdict === 'concern' && r.accepted;
  return { r, verdict: r.verdict, label: accepted ? 'concern accepted' : r.verdict, cls: accepted ? 'review-accepted' : `review-${r.verdict}` };
}
function diffPre(text) {
  return h('pre', {}, String(text || '').split('\n').map((l) => h('span', { class: l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' }, l || ' ')));
}
const sameDiff = (f) => f.master && f.backport && f.master.diff.replace(/^@@.*$/gm, '') === f.backport.diff.replace(/^@@.*$/gm, '');
async function openCompare(branch, pr) {
  S.cmp = { branch, pr }; $('#cmpTitle').textContent = `#${pr} on ${branch}`; $('#cmpMeta').textContent = 'Loading…';
  $('#cmpReview').replaceChildren(); $('#cmpBody').replaceChildren(); $('#cmpDialog').showModal();
  try { S.cmp.d = await api(`sessions/${S.sid}/lanes/${encodeURIComponent(branch)}/picks/${pr}/diff`); renderCompare(); }
  catch (e) { $('#cmpMeta').textContent = e.message; }
}
function renderCompare() {
  const d = S.cmp?.d; if (!d) return;
  const showSame = $('#cmpSame').checked;
  $('#cmpTitle').replaceChildren(prLink(d.pr), ' ', strip(d.title || ''), h('span', { class: 'muted small' }, ` on ${d.branch}`));
  const onlyM = d.files.filter((f) => !f.backport).length; const onlyB = d.files.filter((f) => !f.master).length; const same = d.files.filter(sameDiff).length;
  $('#cmpMeta').replaceChildren(`master ${short(d.masterSha)} · backport ${short(d.backportSha) || '–'} · ${d.files.length} file(s): ${same} identical, ${onlyM} not in the backport, ${onlyB} only in the backport${d.truncated ? ' · diff truncated' : ''}`);
  const c = d.context || {};
  const ctx = [c.note && `Plan note: ${c.note}`, c.adapt && `Adaptation: ${c.adapt}`, c.leftOutInReview?.length && `Left out in review: ${c.leftOutInReview.map((x) => `#${x.pr}`).join(', ')}`,
    c.warnings?.length && `Warnings: ${c.warnings.join('; ')}`, c.buildCheck && `Build check: ${c.buildCheck.ok ? 'passed' : c.buildCheck.accepted ? `accepted (${c.buildCheck.accepted})` : `failed (${c.buildCheck.stage})`}${c.buildCheck.tests ? `, tests ${c.buildCheck.tests}` : ''}`,
    c.intent?.length && `Intent: ${c.intent.map((x) => `${x.module} ${x.to} → Maven ${x.maven.map((m) => m.version).join(', ') || 'not declared'}`).join('; ')}`].filter(Boolean);
  const r = d.review; const b = d.branch; const pr = d.pr;
  const reviewBox = h('div', { class: `review ${r ? (r.verdict === 'concern' && r.accepted ? 'adapted' : r.verdict) : ''}` },
    r ? h('div', {}, h('b', {}, `Diff review: ${r.verdict}${r.accepted ? ' (accepted)' : ''}`), h('span', { class: 'muted small' }, ` ${when(r.at)}${r.job ? ` · job ${r.job}` : ''}`)) : h('b', {}, 'Not reviewed yet'),
    r?.summary ? h('div', {}, prose(r.summary)) : null,
    r?.concerns ? h('div', {}, h('b', {}, 'Concerns: '), prose(r.concerns)) : null,
    r?.accepted ? h('div', { class: 'small' }, `Accepted: ${r.accepted}`) : null,
    d.analysis ? h('div', {}, h('b', {}, 'Fixes: '), ...linkPrs(d.analysis.fixes)) : null,
    d.analysis ? h('div', {}, h('b', {}, `Why on ${d.branch}: `), ...linkPrs(d.analysis.relevance), h('span', { class: 'muted small' }, ` (${d.analysis.reason})`)) : null,
    d.analysis ? h('div', {}, h('b', {}, 'Compatibility: '), d.analysis.compat === 'none' ? 'no user-visible change'
      : h('span', { class: d.analysis.compat === 'breaking' ? 'bad' : '' }, `${d.analysis.compat === 'breaking' ? 'potential breaking change' : 'behavior change'}: `, ...linkPrs(d.analysis.compat_note || ''))) : null,
    ...ctx.map((x) => h('div', { class: 'small muted' }, linkPrs(x))),
    h('div', { class: 'actions' },
      r?.verdict === 'concern' && !r.accepted ? h('button', { class: 'primary', onclick: async () => { const t = prompt('Instructions for the worker (optional):', ''); if (t === null) return; await act('fix-review', b, { pr, instructions: t || undefined }); $('#cmpDialog').close(); } }, 'Fix it with Claude') : null,
      r?.verdict === 'concern' && !r.accepted ? h('button', { onclick: async () => { const t = prompt('Why is the backport right as it is?', ''); if (!t) return; await act('accept-review', b, { pr, reason: t }); $('#cmpDialog').close(); } }, 'Accept as is') : null,
      r ? h('button', { class: 'ghost', onclick: async () => { await act('review-again', b, { pr }); $('#cmpDialog').close(); } }, 'Review again') : null));
  $('#cmpReview').replaceChildren(reviewBox);
  const files = d.files.filter((f) => showSame || !sameDiff(f));
  $('#cmpBody').replaceChildren(...(files.length ? files.map((f) => {
    const col = (side, label) => h('div', { class: 'cmpCol' }, h('div', { class: 'cmpLabel' }, side ? `${label} · ${side.status} +${side.added} −${side.removed}` : label),
      side ? diffPre(side.diff) : h('div', { class: 'cmpNone' }, label === 'master' ? 'not changed by the master commit' : 'not in the backport'));
    return h('div', { class: `cmpFile ${!f.backport ? 'onlyMaster' : !f.master ? 'onlyBackport' : ''}` },
      h('div', { class: 'cmpHead' }, h('span', {}, f.path), h('span', { class: 'grow' }), h('span', { class: 'muted' }, !f.backport ? 'not in the backport' : !f.master ? 'only in the backport' : sameDiff(f) ? 'identical' : 'differs')),
      h('div', { class: 'cmpCols' }, col(f.master, 'master'), col(f.backport, `backport (${b})`)));
  }) : [h('p', { class: 'muted' }, 'Every file is identical in both; tick "show identical files" to see them.')]));
}
$('#cmpSame').onchange = renderCompare;
$('#cmpClose').onclick = () => { $('#cmpDialog').close(); S.cmp = null; };

// ---------- activity and jobs ----------
function renderActivity() {
  $('#tabBody').replaceChildren(h('div', { class: 'feed' }, S.events.map((e) => h('div', { class: `ev ${e.level}` }, h('span', { class: 'muted small' }, when(e.ts)), h('span', { class: 'small' }, e.branch || ''),
    h('span', {}, e.message, e.job_id ? h('a', { href: '#', class: 'small', onclick: (x) => { x.preventDefault(); openLog(e.job_id); } }, ` job ${e.job_id}`) : '')))));
}
function renderJobs() {
  $('#tabBody').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ...['Job', 'Type', 'Lane', 'Runner', 'Status', 'Result', 'Started', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, S.jobs.map((j) => h('tr', {}, h('td', {}, j.id), h('td', {}, j.type, j.args?.pr ? ` #${j.args.pr}` : ''), h('td', {}, j.branch || ''), h('td', {}, j.runner),
      h('td', {}, chip(j.status, j.status)), h('td', { class: 'small' }, j.result?.summary || j.result?.error || j.result?.question || ''), h('td', { class: 'small muted' }, when(j.started_at || j.created_at)),
      h('td', {}, h('div', { class: 'laneButtons' }, h('button', { onclick: () => openLog(j.id) }, 'Log'),
        ['queued', 'running', 'waiting'].includes(j.status) ? h('button', { class: 'ghost danger', onclick: async () => { await api(`jobs/${j.id}/cancel`, {}); refresh(true); } }, 'Cancel') : null,
        ['failed', 'cancelled'].includes(j.status) ? h('button', { onclick: async () => { await api(`jobs/${j.id}/retry`, {}); refresh(true); } }, 'Retry') : null)))))));
}
async function openLog(id) {
  S.logJob = id; S.logOffset = 0; $('#logBody').replaceChildren(); $('#logDialog').showModal(); await pollLog();
}
async function pollLog() {
  if (!S.logJob || !$('#logDialog').open) return;
  const j = S.jobs.find((x) => x.id === S.logJob) || S.summary.activeJobs.find((x) => x.id === S.logJob);
  $('#logTitle').textContent = `Job ${S.logJob}${j ? `: ${j.type}${j.args?.pr ? ` #${j.args.pr}` : ''}` : ''}`;
  $('#logMeta').textContent = j ? `${j.status} · ${j.runner}${j.result?.question ? ` · asks: ${j.result.question}` : ''}` : '';
  $('#replyForm').hidden = !(j && j.status === 'waiting' && j.runner === 'claude');
  try {
    const r = await api(`jobs/${S.logJob}/log?offset=${S.logOffset}`);
    S.logOffset = r.offset; const pre = $('#logBody'); const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    for (const l of r.lines) pre.append(h('div', { class: l.kind }, l.kind === 'tool' ? `› ${l.text}` : l.text));
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  } catch (e) { toast(e.message, true); }
  clearTimeout(pollLog.t); pollLog.t = setTimeout(pollLog, 2500);
}
$('#logClose').onclick = () => { $('#logDialog').close(); S.logJob = null; };
$('#replyForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const text = new FormData(e.target).get('text'); if (!text) return;
  try { await api(`jobs/${S.logJob}/reply`, { text }); e.target.reset(); toast('Reply sent; the worker resumes'); refresh(true); } catch (err) { toast(err.message, true); }
});

// ---------- refresh loop ----------
let busy = false;
async function refresh(force = false) {
  if (!S.sid || busy) return; busy = true;
  try {
    S.summary = await api(`sessions/${S.sid}`);
    $('#conn').textContent = `updated ${new Date().toLocaleTimeString()}`;
    if (S.tab === 'plan' || S.tab === 'all' || S.tab.startsWith('picks:')) { if (!S.plan || force) { S.plan = await api(`sessions/${S.sid}/plan`); S.planIndex = null; } }
    if (S.tab.startsWith('picks:')) { const b = S.tab.slice(6); S.lanePicks[b] = await api(`sessions/${S.sid}/lanes/${encodeURIComponent(b)}`); }
    if (S.tab === 'activity') S.events = await api(`sessions/${S.sid}/events`);
    if (S.tab === 'jobs' || S.logJob) S.jobs = await api(`sessions/${S.sid}/jobs`);
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && $('#tabBody').contains(document.activeElement);
    if (!typing) renderSession();
  } catch (e) { $('#conn').textContent = e.message; }
  finally { busy = false; }
}
(async () => {
  if (!TOKEN) { document.body.replaceChildren(h('main', {}, h('div', { class: 'empty' }, h('h1', {}, 'Open the link printed by bpt serve'), h('p', { class: 'muted' }, 'It carries the access token after #.')))); return; }
  try { await loadSessions(); } catch (e) { document.body.replaceChildren(h('main', {}, h('div', { class: 'empty' }, h('h1', {}, 'Cannot reach bpt'), h('p', {}, e.message)))); return; }
  await refresh(true);
  setInterval(() => refresh(false), 4000);
  setInterval(() => { if (S.tab === 'plan' || S.tab === 'all') refresh(true); }, 30000);
})();

// Phones show each table row as a card (app.css): label every cell with its column heading
// (not the PR number and title, which speak for themselves).
const NO_LABEL = new Set(['#', 'PR', 'Title']);
function labelCells(root = document) {
  for (const t of root.querySelectorAll('table')) {
    const heads = [...(t.tHead?.rows[0]?.cells || [])].map((c) => c.textContent.replace(/[▲▼]/g, '').trim());
    if (!heads.length) continue;
    for (const tr of t.tBodies[0]?.rows || []) for (const td of tr.cells) {
      const head = heads[td.cellIndex] || '';
      const label = td.colSpan > 1 || NO_LABEL.has(head) ? '' : head;
      if (td.dataset.label !== label) td.dataset.label = label;
    }
  }
}
let labelQueued = false;
new MutationObserver(() => { if (!labelQueued) { labelQueued = true; queueMicrotask(() => { labelQueued = false; labelCells(); }); } })
  .observe(document.body, { childList: true, subtree: true });
