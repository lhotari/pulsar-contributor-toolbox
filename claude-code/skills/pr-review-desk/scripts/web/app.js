// PR review desk UI. Everything from a pull request (titles, bodies, diff text, comments) is untrusted: it is
// rendered with textContent, or through md() which escapes before adding the few tags it knows.
const $ = (s, el = document) => el.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;  // only for md() output
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const ext = (href, ...kids) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids);
const chip = (text, cls = '', title = null) => h('span', { class: `chip ${cls}`, title }, text);
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

// --- token, API ---
function storage(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { return null; }
  return null;
}
let TOKEN = null;
{
  const hash = location.hash.slice(1);
  if (hash && !hash.startsWith('/')) { TOKEN = hash; storage('prd-token', hash); history.replaceState(null, '', '#/'); }
  else TOKEN = storage('prd-token');
}
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/${path}`, { method, headers: { 'x-prd-token': TOKEN || '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, code: j.code });
  return j;
}
const action = (name, args = {}) => api('action', { method: 'POST', body: { action: name, ...args } });
let toastTimer;
function toast(msg, err = false, href = null) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}${href ? ' link' : ''}`; t.hidden = false;
  t.onclick = href ? () => { t.hidden = true; location.hash = href; } : null;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? (href ? 15000 : 9000) : 3500);
}
async function run(label, fn) {
  try { const r = await fn(); if (label) toast(label); return r; } catch (e) { toast(e.message, true); throw e; }
}

// --- markdown, escaped first ---
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url.length > 90 ? `${url.slice(0, 87)}…` : url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}
function md(text) {
  const out = []; const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0; let para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`); para = []; };
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s{0,3}(```+|~~~+)/.exec(l);
    if (fence) {
      flush(); const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    if (/^\s*$/.test(l)) { flush(); i++; continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hd) { flush(); out.push(`<p><strong>${inline(hd[2])}</strong></p>`); i++; continue; }
    if (/^\s*>/.test(l)) { flush(); const b = []; while (i < lines.length && /^\s*>/.test(lines[i])) b.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${inline(b.join('\n')).replace(/\n/g, '<br>')}</blockquote>`); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const ordered = /^\s*\d/.test(l); const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); else items[items.length - 1] += `\n${lines[i].trim()}`;
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^<\/?details>|^<summary>/.test(l.trim())) { flush(); out.push(`<p class="muted small">${esc(l.trim())}</p>`); i++; continue; }
    para.push(l); i++;
  }
  flush();
  return h('div', { class: 'md', html: out.join('') });
}

// --- app state ---
const S = { sort: { key: 'score', dir: 'desc' }, state: null, repo: storage('prd-repo') || '', lane: storage('prd-lane') || 'check', filter: '', pr: null, diff: null, tab: 'review',
  editing: new Set(), sel: null, newAt: null, openReasons: new Set(), submitting: new Map() };
// Submissions run in the background (staging, GitHub's submit, replies, a re-read): the UI goes straight back to
// the lane and shows them here, on the row and on the PR page until they finish.
const subKey = (repo, number) => `${repo}#${number}`;
function showSubmitting() {
  const c = $('#submitChip'); const n = S.submitting.size;
  c.hidden = !n;
  c.textContent = n ? `Submitting ${[...S.submitting.keys()].map((k) => `#${k.split('#')[1]}`).join(', ')}…` : '';
  c.title = n ? 'Staging, submitting and posting replies on GitHub' : '';
}
const LANE_INTRO = {
  backlog: 'Open PRs you have not engaged with, best first. The score reasons explain the order (committers, review requests and fixes rank up). "AI review" queues a Claude Code review; nothing is posted.',
  queued: 'AI reviews waiting for a Claude Code worker.',
  reviewing: 'AI reviews running now. Open the log to follow along.',
  check: 'Review drafts written for the PR\'s current head, waiting for you: first reviews and re-reviews of new commits (filter with kind:re-review or kind:initial). Read each comment next to its code, edit or drop it, add your own, then stage it on GitHub or submit.',
  staged: 'Pending reviews on GitHub, visible only to you. Add more comments on GitHub, then submit here (or with GitHub\'s "Finish your review").',
  'follow-up': 'PRs that changed since your review: new commits, replies waiting on you, threads resolved without a code change, or a draft of yours that fell behind the head. Highest priority first. "Re-review" drafts a new round: it checks each of your threads against the new code, reviews the new commits and drafts your replies; the draft then waits in Drafts to check.',
  waiting: 'You reviewed these and nothing has happened since.',
  approved: 'You approved these and the head has not moved.',
  security: 'Red-flagged by the security scan or a reviewer. Nothing from these PRs runs on this machine. Read the evidence and decide.',
  parked: 'Parked, snoozed or ignored by you, or by an ignore rule.',
  done: 'Closed or merged.',
};

async function refreshState() {
  try {
    S.state = await api('state');
    $('#conn').textContent = '';
  } catch (e) {
    $('#conn').textContent = e.status === 401 ? 'wrong token: open the link printed by prd ui' : 'server unreachable';
    return;
  }
  const pick = $('#repoPick'); const cur = S.repo;
  const slugs = S.state.repos.map((r) => r.slug).join(',');
  if (pick.dataset.slugs !== slugs) {
    pick.dataset.slugs = slugs;
    pick.replaceChildren(h('option', { value: '' }, 'All repositories'), ...S.state.repos.map((r) => h('option', { value: r.slug }, r.slug)));
    pick.value = S.state.repos.some((r) => r.slug === cur) ? cur : '';
  }
  const r = repoObj();
  $('#autoWrap').hidden = !r; $('#autopilot').checked = !!r?.autopilot;
  $('#syncBtn').textContent = S.state.repos.some((x) => x.syncing) ? 'Syncing…' : 'Sync';
  const b = S.state.budget;
  $('#budget').textContent = b?.available ? `Claude ${b.claude?.tier} · Codex ${b.codex?.budget}` : 'budget: unknown';
  $('#budget').title = b?.available ? `${b.claude?.why}\n${b.codex?.why}\nread ${ago(b.at)}` : 'review-budget.sh gave no reading';
  const running = S.state.jobs.filter((j) => j.status === 'running').length; const queued = S.state.jobs.filter((j) => j.status === 'queued').length;
  const waiting = S.state.jobs.filter((j) => j.status === 'waiting').length;
  $('#jobsChip').textContent = `jobs: ${running} running · ${queued} queued${waiting ? ` · ${waiting} waiting for you` : ''}`;
  $('#jobsChip').className = `chip ${waiting ? 'attn' : running ? 'running' : ''}`;
}
const repoObj = () => S.state?.repos.find((r) => r.slug === S.repo) || null;
function laneCounts() {
  const c = {};
  for (const r of S.state?.repos || []) if (!S.repo || r.slug === S.repo) for (const [k, v] of Object.entries(r.lanes)) c[k] = (c[k] || 0) + v;
  return c;
}

// --- router ---
function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('.topnav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === (p[0] === 'pr' || !p[0] || p[0] === 'lane' ? 'board' : p[0])));
  if (p[0] === 'pr') return showPr(`${p[1]}/${p[2]}`, Number(p[3]), p[4]);
  S.pr = null; S.diff = null;
  if (p[0] === 'jobs') return showJobs();
  if (p[0] === 'activity') return showActivity();
  if (p[0] === 'settings') return showSettings();
  if (p[0] === 'lane' && p[1]) { S.lane = p[1]; S.laneChosen = true; storage('prd-lane', S.lane); }
  return showBoard();
}
window.addEventListener('hashchange', route);
$('#repoPick').addEventListener('change', (e) => { S.repo = e.target.value; storage('prd-repo', S.repo); refreshState().then(route); });
$('#autopilot').addEventListener('change', (e) => run(e.target.checked ? 'Autopilot on: AI reviews are queued by the rules (nothing posts)' : 'Autopilot off',
  () => action('repo', { slug: S.repo, autopilot: e.target.checked })).then(refreshState));
$('#syncBtn').addEventListener('click', () => {
  const repos = S.repo ? [S.repo] : (S.state?.repos || []).map((r) => r.slug);
  $('#syncBtn').textContent = 'Syncing…';
  Promise.all(repos.map((slug) => action('sync', { repo: slug }))).then(() => toast('Synced')).catch((e) => toast(e.message, true)).finally(() => refreshState().then(route));
});

// --- board ---
let boardItems = [];
function laneNav(counts = laneCounts()) {
  return h('nav', { class: 'lanes', id: 'laneNav' }, S.state.lanes.flatMap((l) => [
    ['follow-up', 'security'].includes(l.id) ? h('div', { class: 'sep' }) : null,
    h('button', { class: `${l.id === S.lane ? 'on' : ''} ${l.id}`, onclick: () => { location.hash = `#/lane/${l.id}`; } },
      h('span', {}, l.title), h('span', { class: 'n' }, counts[l.id] || 0)),
  ]));
}

const itemsUrl = () => `items?lane=${S.lane}${S.repo ? `&repo=${encodeURIComponent(S.repo)}` : ''}`;
let boardSig = '';

/**
 * Background refresh of the board: no rebuild, no flash. The lane counts are swapped in place, and the rows are
 * re-rendered only when the data changed, keeping the scroll position and anything open in the table.
 */
async function refreshBoard() {
  const nav = $('#laneNav'); const rows = $('#rows');
  if (!nav || !rows) return showBoard();
  nav.replaceWith(laneNav());
  const fresh = await api(itemsUrl()).catch(() => null);
  if (!fresh) return;
  const sig = JSON.stringify(fresh);
  if (sig === boardSig) return;
  boardSig = sig; boardItems = fresh;
  const y = window.scrollY;
  renderRows();
  window.scrollTo(0, y);
}

async function showBoard() {
  const main = $('#main');
  if (!S.state?.repos.length) {
    main.replaceChildren(h('div', { class: 'empty' }, h('h1', {}, 'No repositories yet'),
      h('p', {}, 'Run the skill in a clone: ', h('code', {}, '/pr-review-desk triage'), ', or ', h('code', {}, 'prd repo add owner/repo'), '.')));
    return;
  }
  const counts = laneCounts();
  if (!S.laneChosen && !counts[S.lane]) S.lane = ['security', 'check', 'staged', 'follow-up', 'backlog'].find((l) => counts[l]) || 'backlog';
  const lanes = laneNav(counts);
  const body = h('section', {}, h('p', { class: 'laneIntro muted small' }, LANE_INTRO[S.lane] || ''));
  const search = h('input', { type: 'search', id: 'boardSearch', placeholder: 'Filter: title, #, author:login, label…', value: S.filter,
    oninput: (e) => setFilter(e.target.value, { fromInput: true }), onkeydown: (e) => { if (e.key === 'Escape') setFilter(''); } });
  const filters = h('div', { class: 'filters' }, search,
    h('button', { class: 'small ghost', id: 'clearFilter', hidden: !S.filter, onclick: () => setFilter('') }, 'Clear filter'),
    h('span', { class: 'small muted', id: 'filterCount' }),
    h('span', { class: 'grow' }),
    h('button', { class: 'small ghost', title: 'Sort by last update, newest first', onclick: () => { S.sort = { key: 'updated', dir: 'desc' }; renderRows(); } }, 'Newest activity'),
    h('button', { class: 'small ghost', title: 'Back to the default order', onclick: () => { S.sort = { key: 'score', dir: 'desc' }; renderRows(); } }, 'Reset sort'));
  if (S.lane === 'backlog' && S.repo) filters.append(h('button', { class: 'ghost small', onclick: previewRules }, 'What would Autopilot queue?'));
  if (S.lane === 'follow-up') {
    const n = h('select', { class: 'small', title: 'How many of the PRs shown (in the current order) to queue' },
      ...[3, 5, 10, 20].map((v) => h('option', { value: v, selected: v === 5 ? true : null }, String(v))));
    filters.append(h('span', { class: 'bulk' }, h('button', { class: 'small primary', onclick: () => bulkReReview(Number(n.value)) }, 'Re-review top'), n));
  }
  body.append(filters, h('div', { id: 'laneNote' }), h('div', { id: 'rows' }));
  main.replaceChildren(h('div', { class: 'board' }, lanes, body));
  boardItems = await api(itemsUrl()).catch((e) => { toast(e.message, true); return []; });
  boardSig = JSON.stringify(boardItems);
  renderRows();
  if (S.lane === 'follow-up') {
    const drafts = (await api(`items?lane=check${S.repo ? `&repo=${encodeURIComponent(S.repo)}` : ''}`).catch(() => [])).filter((it) => it.review?.kind === 're-review');
    if (drafts.length) $('#laneNote')?.replaceChildren(h('p', { class: 'small' }, `${drafts.length} PR(s) with new commits already have a re-review draft for the current head: `,
      h('a', { href: '#/lane/check', onclick: () => { S.filter = 'kind:re-review'; } }, 'check them in Drafts to check'), '.'));
  }
}

async function previewRules() {
  const c = await run(null, () => api(`rules?repo=${encodeURIComponent(S.repo)}`));
  if (!c.length) { toast('No PR matches the auto-review rules right now'); return; }
  // A dialog, not a toast: the reasons a PR waits are worth reading.
  const now = c.filter((x) => x.slot); const later = c.filter((x) => !x.slot);
  const reasons = [...new Set(later.map((x) => x.wait).filter(Boolean))].map((w) => w.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, (t) => new Date(t).toLocaleString()));
  const line = (x) => `#${x.number} ${x.type} (score ${x.score}${x.why ? `, ${x.why}` : ''})`;
  $('#logTitle').textContent = 'What autopilot would queue';
  $('#logBody').textContent = [
    now.length ? `Queued on the next tick:\n${now.map((x) => `  ${line(x)}`).join('\n')}` : 'Nothing gets queued on the next tick.',
    later.length ? `\nMatching, waiting for a slot:\n${later.map((x) => `  ${line(x)}`).join('\n')}\n\nWhy they wait:\n${reasons.map((r) => `  ${r}`).join('\n')}` : '',
    '\nThe limits are in Rules & repos: auto.review.maxQueued, auto.reReview.maxQueued, and auto.review.maxPerDay (a number, or "budget" to keep going while auto.budget.maxPercent of every Claude and Codex window is left).',
  ].join('\n');
  $('#logDialog').showModal();
}

function rowActions(it) {
  const a = [];
  const go = (label, fn, cls = 'small') => h('button', { class: cls, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
  const refresh = () => refreshState().then(refreshBoard);
  const isSec = ['flagged', 'suspicious'].includes(it.gate) && it.gateCurrent;
  if (['backlog', 'follow-up', 'waiting', 'approved'].includes(it.lane) && !isSec) {
    a.push(go(it.myLast ? 'Re-review' : 'AI review', () => run('Queued', () => action('review', { repo: it.repo, number: it.number })).then(refresh), 'small primary'));
  }
  if (['backlog', 'follow-up', 'waiting', 'approved'].includes(it.lane)) {
    a.push(go('Snooze 3d', () => run('Snoozed', () => action('hold', { repo: it.repo, number: it.number, hold: 'snoozed', days: 3 })).then(refresh)));
    a.push(go('Park', () => run('Parked', () => action('hold', { repo: it.repo, number: it.number, hold: 'parked' })).then(refresh)));
  }
  if (it.lane === 'parked') a.push(go('Unpark', () => run('Back in triage', () => action('hold', { repo: it.repo, number: it.number, hold: null })).then(refresh)));
  if (it.job && ['queued', 'running'].includes(it.job.status)) a.push(go('Log', () => openLog(it.job.id)), go('Cancel', () => run('Cancelled', () => action('cancel-job', { job: it.job.id })).then(refresh)));
  return h('div', { class: 'rowActions' }, a);
}

async function bulkReReview(n) {
  const shown = sortItems(boardItems.filter((it) => matchesFilter(it, S.filter)));
  const pick = shown.filter((it) => !it.job && !(['flagged', 'suspicious'].includes(it.gate) && it.gateCurrent)).slice(0, n);
  if (!pick.length) return toast('Nothing to queue: every PR shown has a job or is on security hold', true);
  if (!confirm(`Queue re-reviews for ${pick.length} PR(s), in this order?\n\n${pick.map((it) => `#${it.number} ${it.title}`).join('\n')}\n\nThey run on Claude Code a few at a time (the worker limit); nothing is posted.`)) return;
  let ok = 0;
  for (const it of pick) {
    try { await action('review', { repo: it.repo, number: it.number }); ok++; } catch (e) { toast(`#${it.number}: ${e.message}`, true); }
  }
  toast(`Queued ${ok} re-review(s)`);
  refreshState().then(refreshBoard);
}

/** `author:login` matches the author exactly; every other word must appear in the PR's number, title, author, category or labels. */
function matchesFilter(it, filter) {
  const words = String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `#${it.number} ${it.title} ${it.author} ${it.category} ${it.component} ${it.labels.join(' ')}`.toLowerCase();
  return words.every((w) => (w.startsWith('author:') ? (it.author || '').toLowerCase() === w.slice(7)
    : w.startsWith('kind:') ? (it.review?.kind || '') === w.slice(5) : w === 'is:stale' ? !!it.review?.stale : hay.includes(w)));
}

function setFilter(value, { fromInput = false } = {}) {
  S.filter = value;
  const input = $('#boardSearch');
  if (input && !fromInput) input.value = value;
  const clear = $('#clearFilter');
  if (clear) clear.hidden = !value;
  renderRows();
}

// Column sorts. A missing value sorts last in either direction; ties fall back to score, then number.
const SORTS = {
  number: { dir: 'desc', val: (it) => it.number },
  title: { dir: 'asc', val: (it) => (it.title || '').toLowerCase() },
  score: { dir: 'desc', val: (it) => it.score },
  size: { dir: 'asc', val: (it) => it.size },
  ci: { dir: 'asc', val: (it) => (it.ci ? { FAILURE: 0, ERROR: 0, PENDING: 1, EXPECTED: 1, SUCCESS: 2 }[it.ci] ?? 1 : null) },
  gate: { dir: 'asc', val: (it) => ({ flagged: 0, suspicious: 0, inconclusive: 1, unscanned: 2, scanned: 3, clear: 4 }[it.gateCurrent ? it.gate : 'unscanned'] ?? 2) },
  me: { dir: 'desc', val: (it) => it.myLast?.at || null },
  review: { dir: 'desc', val: (it) => (it.review ? ({ staged: 3, draft: 2, submitted: 1 }[it.review.status] || 0) * 1000 + it.review.comments : it.job ? 500 : null) },
  updated: { dir: 'desc', val: (it) => it.updated_at || null },
};
function sortItems(list) {
  const { key, dir } = SORTS[S.sort.key] ? S.sort : { key: 'score', dir: 'desc' };
  const val = SORTS[key].val; const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort((x, y) => {
    const a = val(x); const b = val(y);
    if (a == null || b == null) { if (a == null && b == null) return y.score - x.score; return a == null ? 1 : -1; }
    return sign * cmp(a, b) || y.score - x.score || y.number - x.number;
  });
}
function sortTh(key, label, cls = '') {
  const on = S.sort.key === key;
  const next = () => {
    S.sort = on ? { key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: SORTS[key].dir };
    renderRows();
  };
  return h('th', { class: `${cls} sortable ${on ? 'sorted' : ''}`, title: `Sort by ${label.toLowerCase()}`, 'aria-sort': on ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
    h('button', { class: 'thSort', onclick: next }, label, h('span', { class: 'arrow' }, on ? (S.sort.dir === 'asc' ? ' ▲' : ' ▼') : '')));
}

function renderRows() {
  const list = sortItems(boardItems.filter((it) => matchesFilter(it, S.filter)));
  const count = $('#filterCount');
  if (count) count.textContent = S.filter.trim() ? `${list.length} of ${boardItems.length} shown` : '';
  const rows = $('#rows'); if (!rows) return;
  if (!list.length) { rows.replaceChildren(h('div', { class: 'empty' }, 'Nothing here.')); return; }
  const showRepo = !S.repo;
  rows.replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, sortTh('number', 'PR'), sortTh('title', 'Title'), sortTh('score', 'Score', 'right'), sortTh('size', 'Size', 'hideS'),
      sortTh('ci', 'CI', 'hideS'), sortTh('gate', 'Security'), sortTh('me', 'Me', 'hideS'), sortTh('review', 'Review'), h('th', {}, ''))),
    h('tbody', {}, list.map((it) => {
      const key = `${it.repo}#${it.number}`; const open = S.openReasons.has(key);
      const prHref = `#/pr/${it.repo}/${it.number}`;
      const gate = it.gateCurrent || it.gate === 'unscanned' ? it.gate : 'unscanned';
      return h('tr', { class: 'row' },
        h('td', {}, h('a', { href: prHref }, `#${it.number}`), showRepo ? h('div', { class: 'muted small' }, it.repo) : null),
        h('td', { class: 'title' },
          h('a', { class: 't', href: prHref }, it.title), ' ', ext(it.url, '↗'),
          h('div', { class: 'meta' }, h('a', { href: '#', class: 'author', title: `Show only PRs by ${it.author}`,
            onclick: (e) => { e.preventDefault(); setFilter(`author:${it.author}`); } }, it.author), it.flags.includes('committer') ? chip('committer', 'committer') : null,
            it.flags.includes('review-requested') ? chip('review requested', 'attn') : null, it.flags.includes('first-timer') ? chip('first-timer', 'warn') : null,
            it.flags.includes('priority-author') ? chip('priority', 'attn') : null, it.draft ? chip('draft') : null,
            chip(`${it.category || 'other'}${it.component ? ` · ${it.component}` : ''}`, 'cat'), h('span', {}, `updated ${ago(it.updated_at)}`),
            it.note ? chip(`note: ${it.note.slice(0, 40)}`, 'info') : null),
          open ? h('ul', { class: 'reasons' }, it.reasons.map((r) => h('li', {}, r))) : null),
        h('td', { class: 'right' }, h('button', { class: 'ghost small', title: 'Why this score', onclick: () => { open ? S.openReasons.delete(key) : S.openReasons.add(key); renderRows(); } }, String(it.score))),
        h('td', { class: 'hideS small' }, `${it.size} lines`, h('div', { class: 'muted' }, `${it.files} files`)),
        h('td', { class: 'hideS' }, it.ci ? chip(it.ci.toLowerCase(), it.ci) : ''),
        h('td', {}, chip(gate, gate, it.scan), it.scanLevel === 'surface' ? h('div', { class: 'muted small', title: it.scan }, 'build/CI touched') : null),
        h('td', { class: 'hideS small' }, it.myLast ? [chip(it.myLast.state.toLowerCase().replace('_', ' '), it.myLast.state), h('div', { class: 'muted' }, ago(it.myLast.at))] : '',
          it.followUp?.length ? h('ul', { class: 'why' }, it.followUp.map((r) => h('li', {}, r))) : null),
        h('td', { class: 'small' }, S.submitting.has(key) ? h('div', {}, chip('submitting…', 'running')) : null,
          it.job ? chip(`${it.job.type} ${it.job.status}`, it.job.status) : null,
          it.review ? h('div', {}, chip(`${{ 're-review': 're-review', manual: 'your review', initial: 'first review' }[it.review.kind] || it.review.kind} ${it.review.status}`, it.review.status),
            it.review.stale ? [' ', chip('out of date', 'warn', 'The draft was written for an older head')] : null,
            h('div', { class: 'muted' }, `${it.review.comments} comment(s)`)) : null),
        h('td', {}, rowActions(it)));
    }))));
}

// --- PR page ---
let prTimer = null;
async function showPr(repo, number, tab) {
  if (tab) S.tab = tab;
  const fresh = !S.pr || S.pr.pr.repo !== repo || S.pr.pr.number !== number;
  if (fresh) { S.sel = null; S.newAt = null; S.editing.clear(); $('#main').replaceChildren(h('div', { class: 'empty' }, 'Loading…')); }
  // The user may navigate away while a request is in flight (a submit takes seconds): then nothing here may
  // touch the page or S.pr, which by then belongs to another view.
  const stillHere = () => onPrRoute(repo, number);
  let view; let diff = S.diff;
  try {
    view = await api(`pr?repo=${encodeURIComponent(repo)}&number=${number}`);
    const sha = view.review?.head_sha || view.pr.head_sha;
    if (!diff || diff.sha !== sha || fresh) diff = await api(`diff?repo=${encodeURIComponent(repo)}&number=${number}&sha=${sha}`).catch(() => null);
  } catch (e) { if (stillHere()) $('#main').replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
  if (!stillHere()) return;
  S.pr = view; S.diff = diff;
  renderPr();
  clearInterval(prTimer);
  prTimer = setInterval(() => {
    if (!onPrRoute(repo, number)) { clearInterval(prTimer); return; }
    if (S.editing.size || ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
    const busy = S.pr?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || S.pr?.review?.status === 'staged';
    if (busy) showPr(repo, number);
  }, 6000);
}
function onPrRoute(repo, number) {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  return p[0] === 'pr' && `${p[1]}/${p[2]}` === repo && Number(p[3]) === number;
}
/** Reload the PR page, but only while it is still the page being shown. */
const reloadPr = () => {
  const cur = S.pr?.pr;
  if (cur && onPrRoute(cur.repo, cur.number)) return showPr(cur.repo, cur.number);
  return undefined;
};

function renderPr() {
  const { pr, item, review } = S.pr;
  const scrollY = window.scrollY;
  const head = h('div', { class: 'panel' },
    h('div', { class: 'prHead' },
      h('div', {},
        h('div', { class: 'muted small' }, h('a', { href: `#/lane/${item.lane}` }, `← ${S.state?.lanes.find((l) => l.id === item.lane)?.title || item.lane}`), ` · ${pr.repo}`),
        h('h1', {}, `#${pr.number} `, pr.title),
        h('div', { class: 'meta' }, h('span', {}, pr.author), chip(pr.association?.toLowerCase().replace('_', ' ') || 'unknown'),
          item.flags.includes('committer') ? chip('committer', 'committer') : null, chip(`${item.category}${item.component ? ` · ${item.component}` : ''}`, 'cat'),
          h('span', {}, `+${pr.additions} −${pr.deletions} in ${pr.changed_files} files`), h('span', {}, `base ${pr.base_ref}`),
          pr.ci ? chip(`CI ${pr.ci.toLowerCase()}`, pr.ci) : null, pr.draft ? chip('draft') : null,
          ...pr.labels.map((l) => chip(l)), h('span', { class: 'mono' }, `head ${pr.head_sha.slice(0, 10)}`))),
      h('div', { class: 'actions' }, ext(pr.url, h('button', {}, 'PR on GitHub ↗')), ext(`${pr.url}/files`, h('button', {}, 'Files ↗')))));
  const tabs = h('nav', { class: 'tabs' }, [['review', `Review${review ? ` (${review.comments.filter((c) => c.include && c.state !== 'removed').length})` : ''}`], ['diff', `Diff (${S.diff?.files.length ?? '?'} files)`],
    ['threads', `Threads (${(pr.analysis?.openThreads || []).length})`], ['description', 'Description']]
    .map(([id, label]) => h('button', { class: S.tab === id ? 'on' : '', onclick: () => { S.tab = id; renderPr(); } }, label)));
  const body = h('div', {}, S.tab === 'diff' ? renderDiff() : S.tab === 'threads' ? renderThreads() : S.tab === 'description' ? h('div', { class: 'panel' }, md(pr.body || '_No description._')) : renderReview());
  $('#main').replaceChildren(head, h('div', { class: 'cols' }, h('div', {}, tabs, body), h('aside', { class: 'side' }, renderSide())));
  window.scrollTo(0, scrollY);
}

function renderSide() {
  const { pr, item, jobs } = S.pr;
  const out = [];
  // security
  const bad = ['flagged', 'suspicious'].includes(item.gate) && item.gate_sha === pr.head_sha;
  const scan = item.scan;
  const sec = h('div', { class: `panel ${bad ? 'securityBad' : ''}` }, h('h2', {}, 'Security gate'),
    h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'state'), h('span', {}, chip(item.gate, item.gate), item.gate_by ? ` by ${item.gate_by}` : '',
      item.gate_sha && item.gate_sha !== pr.head_sha ? h('div', { class: 'muted small' }, `decided for ${item.gate_sha.slice(0, 10)}, not the current head`) : null),
    h('span', { class: 'muted' }, 'scan'), h('span', { class: 'small' }, item.scanSummary),
    h('span', { class: 'muted' }, 'execution'), h('span', { class: 'small' }, S.pr.execAllowed ? 'allowed: workers may check out, build and test this head'
      : 'not allowed: workers review the diff only, with build and test commands denied')),
    item.gate_note ? h('p', { class: 'small' }, item.gate_note) : null,
    scan?.hits?.length ? h('ul', { class: 'hits' }, scan.hits.map((x) => h('li', {}, chip(x.severity, x.severity === 'high' ? 'bad' : 'warn'), ` ${x.rule} `,
      h('span', { class: 'mono small' }, `${x.path}${x.line ? `:${x.line}` : ''}`), x.text ? h('div', {}, h('code', {}, x.text)) : null))) : null,
    scan?.surfaces?.length ? h('details', {}, h('summary', { class: 'small' }, `${scan.surfaces.length} execution surface(s) changed`),
      h('ul', { class: 'hits' }, scan.surfaces.map((s) => h('li', {}, h('span', { class: 'mono' }, s.path), ` — ${s.why}`)))) : null,
    h('div', { class: 'actions', style: 'margin-top:8px' },
      h('button', { class: 'small', onclick: () => gateDecision('clear') }, 'I checked: clear'),
      h('button', { class: 'small danger', onclick: () => gateDecision('suspicious') }, 'Block (suspicious)'),
      h('button', { class: 'small ghost', onclick: () => run('Rescanned', () => action('scan', { repo: pr.repo, number: pr.number })).then(reloadPr) }, 'Rescan')));
  out.push(sec);
  // AI work
  const active = jobs.find((j) => ['queued', 'running', 'waiting'].includes(j.status));
  const instr = h('textarea', { rows: 2, placeholder: 'Optional instructions or a question for Claude…' });
  const isSec = bad;
  const ai = h('div', { class: 'panel' }, h('h2', {}, 'Claude Code'),
    active ? h('div', { class: 'small' }, chip(`${active.type} ${active.status}`, active.status), ' ', h('button', { class: 'small ghost', onclick: () => openLog(active.id) }, 'Log'),
      ' ', h('button', { class: 'small ghost', onclick: () => run('Cancelled', () => action('cancel-job', { job: active.id })).then(reloadPr) }, 'Cancel'),
      active.status === 'waiting' ? h('div', { style: 'margin-top:6px' }, h('p', {}, h('strong', {}, 'The worker asks: '), active.result?.question || ''),
        (() => { const t = h('textarea', { rows: 3, placeholder: 'Your answer (the worker session resumes with it)' }); return h('div', {}, t,
          h('button', { class: 'small primary', onclick: () => run('Sent', () => action('reply-job', { job: active.id, text: t.value })).then(reloadPr) }, 'Send answer')); })()) : null) : null,
    instr,
    h('div', { class: 'actions', style: 'margin-top:6px' },
      h('button', { class: 'small primary', disabled: isSec && !S.pr.execAllowed ? null : null, title: isSec ? 'Security hold: the worker reviews statically, nothing runs' : null,
        onclick: () => run('Queued', () => action('review', { repo: pr.repo, number: pr.number, instructions: instr.value || null })).then(reloadPr) },
      pr.analysis?.myLastReview ? 'Re-review' : 'AI review'),
      S.pr.review && S.pr.review.status !== 'submitted' ? h('button', { class: 'small', onclick: () => { if (!instr.value.trim()) return toast('Say what to change', true);
        run('Queued', () => action('revise', { repo: pr.repo, number: pr.number, instructions: instr.value })).then(reloadPr); } }, 'Revise draft') : null,
      h('button', { class: 'small', onclick: () => { if (!instr.value.trim()) return toast('Type the question first', true);
        run('Asked', () => action('ask', { repo: pr.repo, number: pr.number, instructions: instr.value })).then(reloadPr); } }, 'Ask')),
    jobs.filter((j) => j.type === 'ask' && j.status === 'done' && j.result?.summary).slice(0, 3).map((j) =>
      h('div', { class: 'card' }, h('div', { class: 'cardHead' }, `Answer (job ${j.id}, ${ago(j.finished_at)})`), h('div', { class: 'cardBody' }, md(j.result.summary)))));
  out.push(ai);
  // triage
  const note = h('textarea', { rows: 2, placeholder: 'Private note (never posted)', value: item.note || '',
    onblur: (e) => { if ((e.target.value || null) !== (item.note || null)) action('note', { repo: pr.repo, number: pr.number, note: e.target.value }).then(() => toast('Note saved')); } });
  const hold = (hv, days) => run(hv ? `Marked ${hv}` : 'Back in triage', () => action('hold', { repo: pr.repo, number: pr.number, hold: hv, days })).then(reloadPr);
  out.push(h('div', { class: 'panel' }, h('h2', {}, `Triage · score ${item.score}`), h('ul', { class: 'reasons' }, item.reasons.map((r) => h('li', {}, r))),
    h('div', { class: 'actions', style: 'margin:8px 0' }, item.hold ? h('span', { class: 'small' }, chip(item.hold, 'warn'), item.hold_until ? ` until ${item.hold_until.slice(0, 10)}` : '', ' ',
      h('button', { class: 'small', onclick: () => hold(null) }, 'Clear')) : [
      h('button', { class: 'small', onclick: () => hold('snoozed', 3) }, 'Snooze 3d'), h('button', { class: 'small', onclick: () => hold('snoozed', 14) }, '14d'),
      h('button', { class: 'small', onclick: () => hold('parked') }, 'Park'), h('button', { class: 'small ghost', onclick: () => hold('ignored') }, 'Ignore')]),
    note));
  // rounds + events
  out.push(h('div', { class: 'panel' }, h('h2', {}, 'History'),
    S.pr.rounds.map((r) => h('div', { class: 'small' }, `${r.created_at.slice(0, 16).replace('T', ' ')} `, chip(r.kind), ' ', chip(r.status, r.status), r.event ? ` ${r.event}` : '',
      r.gh_url ? [' ', ext(r.gh_url, 'GitHub')] : null)),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, S.pr.events.slice(0, 12).map((e) => h('div', {}, `${ago(e.at)} — ${e.message}`)))));
  return out;
}

async function gateDecision(gate) {
  const note = prompt(gate === 'clear' ? 'What did you check? (recorded with the decision; applies to this head only)' : 'Why is it suspicious?');
  if (!note) return;
  await run(gate === 'clear' ? 'Marked clear for this head' : 'Blocked', () => action('gate', { repo: S.pr.pr.repo, number: S.pr.pr.number, gate, note }));
  reloadPr();
}

// --- review tab ---
function snippetLines(c) {
  if (!S.diff || !c.path || !c.line) return null;
  const f = S.diff.files.find((x) => x.path === c.path); if (!f) return null;
  const side = c.side || 'RIGHT'; const key = side === 'LEFT' ? 'oldNo' : 'newNo';
  for (const hk of f.hunks) {
    const idx = hk.lines.findIndex((l) => l[key] === c.line && (side === 'LEFT' ? l.kind !== '+' : l.kind !== '-'));
    if (idx === -1) continue;
    const startNo = c.start_line || c.line;
    let from = hk.lines.findIndex((l) => l[key] === startNo); if (from === -1) from = idx;
    const lo = Math.max(0, Math.min(from, idx) - 3); const hi = Math.min(hk.lines.length, idx + 3);
    return hk.lines.slice(lo, hi).map((l) => ({ ...l, hl: l[key] >= startNo && l[key] <= c.line && (side === 'LEFT' ? l.kind !== '+' : l.kind !== '-') }));
  }
  return null;
}
function snippet(c) {
  const ls = snippetLines(c); if (!ls) return null;
  return h('pre', { class: 'snippet' }, ls.map((l) => h('div', { class: `${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''} ${l.hl ? 'hl' : ''}` },
    `${String(l.kind === '-' ? l.oldNo : l.newNo).padStart(5)} ${l.kind} ${l.text}`)));
}

function locLabel(c) {
  if (c.kind === 'reply') return 'reply in thread';
  if (c.kind === 'issue') return 'conversation reply';
  if (c.kind === 'file') return `${c.path} (file)`;
  return `${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}${c.side === 'LEFT' ? ' (old)' : ''}`;
}

function commentCard(c, { inDiff = false } = {}) {
  const rv = S.pr.review; const editable = rv && rv.status !== 'submitted' && c.state !== 'posted';
  const editing = S.editing.has(c.id);
  const thread = c.kind === 'reply' ? (S.pr.pr.analysis?.threads || []).find((t) => t.id === c.thread_id) : null;
  const toggle = h('input', { type: 'checkbox', checked: !!c.include, disabled: !editable || (!!c.anchor_error && !c.include),
    title: c.anchor_error || 'include in the review', onchange: (e) => run(null, () => action('comment-update', { id: c.id, patch: { include: e.target.checked } })).then(reloadPr) });
  const headBits = [h('label', { class: 'toggle' }, toggle, c.include ? 'post' : 'skip'),
    c.severity ? chip(c.severity, c.severity === 'BUG' || c.severity === 'SECURITY' ? 'bad' : c.severity === 'QUALITY' ? '' : 'warn') : null,
    h('a', { class: 'loc', href: '#', onclick: (e) => { e.preventDefault(); if (c.path) { S.tab = 'diff'; S.sel = c.id; renderPr(); setTimeout(() => document.getElementById(`c${c.id}`)?.scrollIntoView({ block: 'center' }), 50); } } }, locLabel(c)),
    chip(c.state, c.state), c.source !== 'ai' ? chip(c.source === 'github' ? 'added on GitHub' : 'yours', 'info') : null,
    c.meta.editedBy ? chip(`edited (${c.meta.editedBy})`) : null, c.resolve ? chip(c.meta.resolveOnly ? 'resolve only, no reply' : 'resolves thread', 'ok') : null,
    h('span', { class: 'grow' }), c.gh_url ? ext(c.gh_url, 'GitHub ↗') : null];
  const body = editing
    ? (() => {
      const t = h('textarea', { rows: Math.min(24, Math.max(5, c.body.split('\n').length + 2)), value: c.body,
        onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); if (e.key === 'Escape') { S.editing.delete(c.id); renderPr(); } } });
      const save = () => run(c.state === 'staged' ? 'Saved (and updated on GitHub)' : 'Saved', () => action('comment-update', { id: c.id, patch: { body: t.value } }))
        .then(() => { S.editing.delete(c.id); reloadPr(); });
      setTimeout(() => t.focus(), 0);
      return h('div', {}, t, h('div', { class: 'editRow' }, h('button', { class: 'small primary', onclick: save }, 'Save (⌘↩)'),
        h('button', { class: 'small ghost', onclick: () => { S.editing.delete(c.id); renderPr(); } }, 'Cancel'),
        c.body_ai && c.body_ai !== c.body ? h('button', { class: 'small ghost', onclick: () => { t.value = c.body_ai; } }, 'Restore AI text') : null));
    })()
    : md(c.body);
  const aimeta = [c.meta.confidence ? `confidence ${c.meta.confidence}` : null, c.meta.agreement, c.meta.crossValidation, c.meta.assessment ? `assessment ${c.meta.assessment}` : null]
    .filter(Boolean).join(' · ');
  const reviseInput = h('input', { placeholder: 'Ask Claude to change this comment…', style: 'flex:1; min-width:180px' });
  return h('div', { class: `card ${c.include ? '' : 'off'} ${S.sel === c.id ? 'sel' : ''}`, id: inDiff ? `c${c.id}` : `rc${c.id}` },
    h('div', { class: 'cardHead' }, headBits),
    !inDiff ? snippet(c) : null,
    thread?.lastComment ? h('div', { class: 'cardBody small' }, h('div', { class: 'muted' }, `${thread.lastComment.author} wrote (${thread.state}):`), md(thread.lastComment.body)) : null,
    h('div', { class: 'cardBody' },
      aimeta ? h('div', { class: 'aimeta' }, aimeta) : null,
      c.meta.why ? h('div', { class: 'aimeta' }, `why: ${c.meta.why}`) : null,
      c.meta.notPostedWhy ? h('div', { class: 'aimeta' }, c.meta.notPostedWhy) : null,
      c.anchor_error ? h('div', { class: 'warnings' }, `Cannot be posted where it is: ${c.anchor_error}. Fold the point into the review body, or re-add it on a line of the diff.`) : null,
      c.error ? h('div', { class: 'warnings' }, `GitHub said: ${c.error}`) : null,
      body),
    editable && !editing ? h('div', { class: 'cardFoot' },
      h('button', { class: 'small', onclick: () => { S.editing.add(c.id); renderPr(); } }, 'Edit'),
      c.kind === 'reply' ? h('label', { class: 'toggle small' }, h('input', { type: 'checkbox', checked: !!c.resolve,
        onchange: (e) => run(null, () => action('comment-update', { id: c.id, patch: { resolve: e.target.checked } })).then(reloadPr) }), 'resolve after submit') : null,
      reviseInput, h('button', { class: 'small', onclick: () => { if (!reviseInput.value.trim()) return;
        run('Queued a revision', () => action('revise', { repo: S.pr.pr.repo, number: S.pr.pr.number, instructions: `Comment ${c.id}: ${reviseInput.value}`, scope: [c.id] })).then(reloadPr); } }, 'Revise'),
      h('button', { class: 'small ghost danger', onclick: () => { if (confirm(c.source === 'ai' ? 'Exclude this comment?' : 'Delete this comment?')) run('Removed', () => action('comment-remove', { id: c.id })).then(reloadPr); } },
        c.source === 'ai' ? 'Drop' : 'Delete')) : null);
}

function renderReview() {
  const { review, pr } = S.pr;
  if (!review) {
    return h('div', { class: 'panel empty' }, h('p', {}, 'No review round yet.'),
      h('div', { class: 'actions', style: 'justify-content:center' },
        h('button', { class: 'primary', onclick: () => run('Queued', () => action('review', { repo: pr.repo, number: pr.number })).then(reloadPr) }, pr.analysis?.myLastReview ? 'Re-review with Claude' : 'AI review'),
        h('button', { onclick: () => run('Started', () => action('start-manual', { repo: pr.repo, number: pr.number })).then(() => { S.tab = 'diff'; reloadPr(); }) }, 'Review it myself (in the diff)')));
  }
  const editable = review.status !== 'submitted';
  const cs = review.comments.filter((c) => c.state !== 'removed');
  const order = { inline: 0, file: 0, reply: 1, issue: 2 };
  cs.sort((a, b) => order[a.kind] - order[b.kind] || String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0) || a.seq - b.seq);
  const warnings = review.meta.warnings || [];
  const bodyEditing = S.editing.has('body');
  const bodyBox = bodyEditing ? (() => {
    const t = h('textarea', { rows: 10, value: review.body });
    const save = () => run('Saved', () => action('body', { review: review.id, body: t.value })).then(() => { S.editing.delete('body'); reloadPr(); });
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); });
    setTimeout(() => t.focus(), 0);
    return h('div', {}, t, h('div', { class: 'editRow' }, h('button', { class: 'small primary', onclick: save }, 'Save (⌘↩)'), h('button', { class: 'small ghost', onclick: () => { S.editing.delete('body'); renderPr(); } }, 'Cancel')));
  })() : h('div', {}, review.body ? md(review.body) : h('p', { class: 'muted' }, 'No review body.'), editable ? h('button', { class: 'small', onclick: () => { S.editing.add('body'); renderPr(); } }, 'Edit body') : null);
  const m = review.meta;
  const staleBox = review.stale?.length && review.status !== 'submitted' ? h('div', { class: 'staleBox' },
    h('strong', {}, 'Submitting is blocked: this draft is out of date.'),
    h('ul', {}, review.stale.map((r) => h('li', {}, r))),
    h('p', {}, 'Revisit it first: a re-review reads the new commits and replies, keeps the points that still apply, carries over your own comments, and replaces this draft.'),
    h('button', { class: 'primary small', onclick: () => run('Re-review queued', () => action('review', { repo: pr.repo, number: pr.number,
      type: pr.analysis?.myLastReview ? 're-review' : 'review' })).then(reloadPr) }, 'Re-review to revisit the draft')) : null;
  const top = h('div', { class: 'panel' },
    h('div', { class: 'actions' }, h('h2', { style: 'margin:0' }, `${review.kind === 're-review' ? 'Re-review' : review.kind === 'manual' ? 'Your review' : 'Review'} `), chip(review.status, review.status),
      review.recommended_event ? chip(`recommended: ${review.recommended_event.toLowerCase().replace('_', ' ')}`, review.recommended_event === 'APPROVE' ? 'ok' : review.recommended_event === 'REQUEST_CHANGES' ? 'bad' : '') : null,
      h('span', { class: 'mono small muted' }, `read ${review.head_sha?.slice(0, 10)}`), review.head_sha !== pr.head_sha ? chip('head moved since', 'warn') : null),
    review.recommended_why ? h('p', { class: 'small muted' }, review.recommended_why) : null,
    h('p', { class: 'small muted' }, [m.reviewers?.length ? `Draft by ${m.reviewers.join(', ')}` : null, m.coverage, m.tier ? `tier ${m.tier}` : null, m.gate?.state ? `gate ${m.gate.state}` : null].filter(Boolean).join(' · '), ' (private, never posted)'),
    warnings.length ? h('ul', { class: 'warnings' }, warnings.map((w) => h('li', {}, w))) : null,
    h('h3', {}, 'Review body'), bodyBox);
  const dropped = m.dropped?.length ? h('details', { class: 'panel' }, h('summary', {}, `${m.dropped.length} dropped candidate finding(s)`),
    h('ul', { class: 'small' }, m.dropped.map((d) => h('li', {}, h('strong', {}, d.claim), ` — ${d.reason}`)))) : null;
  const assess = m.threads?.length ? h('details', { class: 'panel' }, h('summary', {}, `${m.threads.length} thread assessment(s)`),
    h('ul', { class: 'small' }, m.threads.map((t) => h('li', {}, chip(t.assessment, /ADDRESSED$/.test(t.assessment) && !/NOT|PARTIALLY/.test(t.assessment) ? 'ok' : 'warn'), ' ', md(t.why || ''),
      t.evidence?.length ? h('ul', {}, t.evidence.map((e) => h('li', {}, md(e)))) : null)))) : null;
  return h('div', {}, staleBox, top, cs.length ? cs.map((c) => commentCard(c)) : h('p', { class: 'muted' }, 'No comments. Add some in the Diff tab.'), assess, dropped, footbar());
}

function footbar() {
  const { review, pr } = S.pr;
  if (!review || review.status === 'submitted') {
    return review ? h('div', { class: 'footbar' }, chip('submitted', 'ok'), review.event ? ` as ${review.event}` : '', review.gh_url ? ext(review.gh_url, ' View on GitHub ↗') : '') : null;
  }
  if (S.submitting.has(subKey(pr.repo, pr.number))) {
    return h('div', { class: 'footbar' }, chip('submitting…', 'running'), h('span', { class: 'small muted' }, ' Being submitted to GitHub; this page updates when it is done.'));
  }
  const inc = review.comments.filter((c) => c.include && c.state !== 'removed' && !c.anchor_error);
  const staged = inc.filter((c) => c.state === 'staged').length;
  const local = inc.filter((c) => c.state !== 'staged' && c.kind !== 'issue').length;
  const lint = review.lints;
  return h('div', { class: 'footbar' },
    h('span', { class: 'small' }, `${inc.length} comment(s) to post`, review.status === 'staged' ? ` · ${staged} on GitHub (pending)${local ? ` · ${local} not staged yet` : ''}` : ''),
    lint?.blocking ? chip('lint: check before posting', 'bad') : null,
    h('span', { class: 'grow' }),
    h('button', { title: 'Create (or update) a pending review on GitHub. Only you see it. Add more comments there and submit when ready.',
      disabled: review.status === 'staged' && !local ? true : null,
      onclick: () => run(null, () => action('stage', { review: review.id })).then((r) => { toast(`Staged ${r.staged} comment(s)${r.failed.length ? `, ${r.failed.length} failed` : ''}. Continue on GitHub or submit here.`, !!r.failed.length); reloadPr(); }) },
    review.status === 'staged' ? 'Stage the rest' : 'Stage on GitHub'),
    review.status === 'staged' ? h('button', { onclick: () => run(null, () => action('sync-staged', { review: review.id })).then((r) => { toast(r.status === 'submitted' ? 'It was submitted on GitHub' : `Synced: ${r.added} added, ${r.edited} edited, ${r.removed} removed on GitHub`); reloadPr(); }) }, 'Sync from GitHub') : null,
    review.status === 'staged' ? ext(`${pr.url}/files`, h('button', {}, 'Continue on GitHub ↗')) : null,
    h('button', { class: 'primary', onclick: openSubmit, disabled: review.stale?.length ? true : null,
      title: review.stale?.length ? 'Out of date: revisit the draft first (see the note at the top)' : null }, 'Submit…'),
    h('button', { class: 'ghost danger', onclick: () => { if (confirm(review.status === 'staged' ? 'Discard this round and delete the pending review on GitHub?' : 'Discard this review round?')) run('Discarded', () => action('discard', { review: review.id })).then(reloadPr); } }, 'Discard'));
}

// --- submit ---
function openSubmit() {
  const { review, pr } = S.pr; const d = $('#submitDialog'); const f = $('#submitForm');
  const rec = review.recommended_event || 'COMMENT';
  f.event.value = rec === 'APPROVE' ? 'COMMENT' : rec;
  f.body.value = review.body;
  const inc = review.comments.filter((c) => c.include && c.state !== 'removed' && !c.anchor_error);
  $('#submitSummary').replaceChildren(...[h('p', {}, `${inc.length} comment(s): ${inc.filter((c) => c.kind === 'inline' || c.kind === 'file').length} on code, ${inc.filter((c) => c.kind === 'reply').length} thread replies, ${inc.filter((c) => c.kind === 'issue').length} conversation replies.`,
    review.status === 'staged' ? ' Comments added on GitHub to the pending review are included.' : ' They are staged and submitted in one go.'),
  rec === 'APPROVE' ? h('p', { class: 'warnings' }, 'The draft recommends approving. Choose Approve yourself if you agree.') : null].filter(Boolean));
  const lint = review.lints; const box = $('#submitLints'); box.replaceChildren();
  const acks = [];
  if (lint?.security?.length) { const cb = h('input', { type: 'checkbox', value: 'security' }); acks.push(cb); box.append(h('div', { class: 'lintBox' }, `The text mentions ${lint.security.join(', ')}. Never disclose a vulnerability on a public PR.`, h('label', {}, cb, 'This is not a disclosure'))); }
  for (const t of lint?.tooling || []) { const cb = h('input', { type: 'checkbox', value: t.label }); acks.push(cb); box.append(h('div', { class: 'lintBox' }, `The text describes how the review was run (${t.label}, in ${t.where.join(', ')}).`, h('label', {}, cb, 'Intended; post it'))); }
  // CI on approval: approve held workflow runs; update the branch from its base when the PR has been quiet.
  const ciBox = $('#submitCi'); const ciOpts = { approveRuns: null, updateBranch: null };
  const showCi = () => { ciBox.hidden = f.event.value !== 'APPROVE'; };
  for (const r of f.querySelectorAll('input[name=event]')) r.onchange = showCi;
  ciBox.replaceChildren(h('div', { class: 'muted' }, 'Checking workflow runs and the branch…')); showCi();
  const ciReq = S.pr.pr;
  api(`ci?repo=${encodeURIComponent(ciReq.repo)}&number=${ciReq.number}`).then((c) => {
    if (!d.open) return;
    const day = (t) => (t ? t.slice(0, 10) : 'never');
    const ap = h('input', { type: 'checkbox', checked: c.defaults.approveRuns, disabled: c.gateBlocks });
    const up = h('input', { type: 'checkbox', checked: c.defaults.updateBranch, disabled: c.gateBlocks || !c.canUpdate || c.behindBy === 0 });
    ciOpts.approveRuns = ap; ciOpts.updateBranch = up;
    ciBox.replaceChildren(...[
      c.gateBlocks ? h('div', { class: 'lintBox' }, `Security gate is "${c.gate}": workflow runs and branch updates are disabled.`) : null,
      h('label', {}, ap, h('span', {}, 'Approve workflow runs waiting for approval')),
      h('div', { class: 'why' }, c.pending.length ? `${c.pending.length} run(s) waiting: ${c.pending.map((r) => r.name).join(', ')}` : `None waiting right now on ${c.head.slice(0, 7)} (${c.runs} run(s) in total). Runs started by a branch update are approved too.`),
      h('label', {}, up, h('span', {}, `Update the branch from ${c.base} and approve the new runs`)),
      h('div', { class: 'why' }, [
        c.behindBy === 0 ? `Already up to date with ${c.base}.` : c.behindBy != null ? `${c.behindBy} commit(s) behind ${c.base}.` : '',
        !c.canUpdate ? 'Not possible: the fork does not allow maintainer edits.' : '',
        `Last commit ${day(c.lastCommitAt)}, last workflow run ${day(c.lastRunAt)}.`,
        c.quiet ? `No activity in ${c.quietDays} days: on by default so CI passes on the latest changes before merging.` : `Recent activity: off by default.`,
      ].filter(Boolean).join(' ')),
    ].filter(Boolean));
  }).catch((e) => { if (d.open) ciBox.replaceChildren(h('div', { class: 'lintBox' }, `Could not check workflow runs: ${e.message}`)); });
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    try {
      if (acks.length) {
        if (acks.some((a) => !a.checked)) throw new Error('acknowledge the lint findings, or edit the text');
        await action('ack', { review: review.id, labels: acks.map((a) => a.value) });
      }
    } catch (e) { toast(e.message, true); return; }
    // Straight back to the lane; the submission carries on in the background.
    const key = subKey(pr.repo, pr.number); const prHref = `#/pr/${pr.repo}/${pr.number}`;
    S.submitting.set(key, { at: Date.now() }); showSubmitting();
    toast(`Submitting #${pr.number} to GitHub…`);
    if (onPrRoute(pr.repo, pr.number)) location.hash = `#/lane/${S.lane}`;
    action('submit', { review: review.id, event: f.event.value, body: f.body.value,
      ci: { approveRuns: !!ciOpts.approveRuns?.checked, updateBranch: !!ciOpts.updateBranch?.checked } })
      .then((r) => toast(r.submittedOnGitHub ? `#${pr.number} had already been submitted on GitHub`
        : `#${pr.number}: review submitted (${r.event.toLowerCase().replace('_', ' ')})${r.ci?.updateBranch === 'requested' ? '; branch update requested, new runs get approved as they start' : ''}${r.ci?.approved?.length ? `; approved ${r.ci.approved.length} workflow run(s)` : ''}${r.errors?.length ? ` with follow-up errors: ${r.errors.join('; ')}` : ''}`,
      !!r.errors?.length, r.errors?.length ? prHref : null))
      .catch((e) => toast(`#${pr.number}: not submitted — ${e.message} (click to open)`, true, prHref))
      .finally(async () => {
        S.submitting.delete(key); showSubmitting();
        await refreshState();
        if ($('#rows')) { boardSig = ''; refreshBoard(); }
        if (onPrRoute(pr.repo, pr.number)) reloadPr();
      });
  };
  d.showModal();
}

// --- diff tab ---
function renderDiff() {
  if (!S.diff) return h('div', { class: 'panel empty' }, 'The diff could not be loaded.');
  const { review, pr } = S.pr;
  const cs = (review?.comments || []).filter((c) => c.state !== 'removed' && c.path);
  const at = new Map();
  for (const c of cs) { const k = `${c.path}|${c.side || 'RIGHT'}|${c.line ?? 'file'}`; if (!at.has(k)) at.set(k, []); at.get(k).push(c); }
  const canComment = !review || review.status !== 'submitted';
  const note = h('p', { class: 'small muted' }, canComment ? 'Click a line number to comment (old-side number for removed lines). Shift-click a second line in the same hunk for a range.' : 'This round is submitted.');
  return h('div', {}, note, S.diff.sha !== pr.head_sha ? h('p', { class: 'warnings' }, `Showing the diff at ${S.diff.sha.slice(0, 10)}, the commit this review read. The PR head is ${pr.head_sha.slice(0, 10)}.`) : null,
    S.diff.files.map((f) => {
      const fileCs = at.get(`${f.path}|RIGHT|file`) || [];
      const big = f.lines > 800 && !S.editing.has(`open:${f.path}`) && !cs.some((c) => c.path === f.path);
      const bodyEl = h('div', { class: 'diffBody' });
      if (!big) {
        for (const hk of f.hunks) {
          bodyEl.append(h('div', { class: 'hunk' }, `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`));
          for (const l of hk.lines) {
            const side = l.kind === '-' ? 'LEFT' : 'RIGHT'; const no = side === 'LEFT' ? l.oldNo : l.newNo;
            const selKey = `${f.path}|${side}|${no}`;
            const pick = (sideClicked, e) => {
              if (!canComment) return;
              const s = sideClicked; const n = s === 'LEFT' ? l.oldNo : l.newNo; if (!n) return;
              if (e.shiftKey && S.newAt && S.newAt.path === f.path && S.newAt.side === s) S.newAt = { ...S.newAt, start: Math.min(S.newAt.line, n), line: Math.max(S.newAt.line, n) };
              else S.newAt = { path: f.path, side: s, line: n, start: null };
              renderPr();
            };
            const inSel = S.newAt && S.newAt.path === f.path && S.newAt.side === side && no >= (S.newAt.start || S.newAt.line) && no <= S.newAt.line;
            bodyEl.append(h('div', { class: `row ${inSel ? 'sel' : ''}` },
              h('span', { class: 'num', onclick: (e) => pick('LEFT', e), title: l.oldNo ? 'comment on the old line' : null }, l.oldNo ?? ''),
              h('span', { class: 'num', onclick: (e) => pick(l.kind === '-' ? 'LEFT' : 'RIGHT', e), title: 'comment on this line' }, l.newNo ?? ''),
              h('span', { class: `ln ${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}` }, `${l.kind === ' ' ? ' ' : l.kind} ${l.text}`)));
            const here = at.get(selKey) || [];
            if (here.length) bodyEl.append(h('div', { class: 'inlineCards' }, here.map((c) => commentCard(c, { inDiff: true }))));
            if (S.newAt && S.newAt.path === f.path && S.newAt.side === side && S.newAt.line === no) bodyEl.append(h('div', { class: 'inlineCards' }, newCommentBox()));
          }
        }
        if (f.truncated) bodyEl.append(h('div', { class: 'hunk' }, 'Diff truncated here; the rest is on GitHub.'));
      } else {
        bodyEl.append(h('div', { class: 'hunk' }, h('button', { class: 'small', onclick: () => { S.editing.add(`open:${f.path}`); renderPr(); S.editing.delete(`open:${f.path}`); } }, `Show ${f.lines} lines`)));
      }
      return h('div', { class: 'diff' },
        h('div', { class: 'diffHead' }, chip(f.status), h('span', {}, f.path), f.oldPath && f.oldPath !== f.path ? h('span', { class: 'muted' }, `← ${f.oldPath}`) : null, h('span', { class: 'grow' }),
          canComment ? h('button', { class: 'small ghost', onclick: () => { S.newAt = { path: f.path, side: 'RIGHT', line: null, file: true }; renderPr(); } }, 'Comment on file') : null),
        S.newAt?.file && S.newAt.path === f.path ? h('div', { class: 'inlineCards' }, newCommentBox()) : null,
        fileCs.length ? h('div', { class: 'inlineCards' }, fileCs.map((c) => commentCard(c, { inDiff: true }))) : null,
        bodyEl);
    }));
}

function newCommentBox() {
  const a = S.newAt;
  const t = h('textarea', { rows: 5, placeholder: 'Your comment (markdown). ⌘↩ to add.' });
  const add = async () => {
    if (!t.value.trim()) return;
    await run('Added', async () => {
      let rid = S.pr.review?.id;
      if (!rid) rid = (await action('start-manual', { repo: S.pr.pr.repo, number: S.pr.pr.number })).review;
      await action('comment-add', { review: rid, path: a.path, line: a.line, startLine: a.start, side: a.side, kind: a.file ? 'file' : 'inline', body: t.value });
    });
    S.newAt = null; S.editing.delete('new'); reloadPr();
  };
  t.addEventListener('focus', () => S.editing.add('new'));
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); if (e.key === 'Escape') { S.newAt = null; S.editing.delete('new'); renderPr(); } });
  setTimeout(() => t.focus(), 0);
  return h('div', { class: 'card' }, h('div', { class: 'cardHead' }, `New comment on ${a.path}${a.file ? ' (file)' : `:${a.start ? `${a.start}-` : ''}${a.line}${a.side === 'LEFT' ? ' (old)' : ''}`}`),
    h('div', { class: 'cardBody' }, t, h('div', { class: 'editRow' }, h('button', { class: 'small primary', onclick: add }, 'Add comment'),
      h('button', { class: 'small ghost', onclick: () => { S.newAt = null; S.editing.delete('new'); renderPr(); } }, 'Cancel'))));
}

// --- threads tab ---
function renderThreads() {
  const a = S.pr.pr.analysis || {};
  const mine = a.threads || []; const others = (a.openThreads || []).filter((t) => !mine.some((m) => m.id === t.id));
  const reply = (t) => {
    const box = h('textarea', { rows: 3, placeholder: 'Reply (added to the review round; posted when you submit)' });
    return h('div', { class: 'editRow' }, box, h('button', { class: 'small', onclick: async () => {
      if (!box.value.trim()) return;
      await run('Reply added', async () => {
        let rid = S.pr.review?.id;
        if (!rid || S.pr.review.status === 'submitted') rid = (await action('start-manual', { repo: S.pr.pr.repo, number: S.pr.pr.number })).review;
        await action('comment-add', { review: rid, kind: 'reply', threadId: t.id, body: box.value });
      });
      reloadPr();
    } }, 'Add reply'));
  };
  return h('div', {},
    h('h3', {}, `Your threads (${mine.length})`),
    mine.length ? mine.map((t) => h('div', { class: 'card' }, h('div', { class: 'cardHead' }, chip(t.state, t.state === 'awaiting-my-reply' ? 'attn' : t.isResolved ? 'ok' : ''), h('span', { class: 'loc' }, `${t.path}:${t.line ?? ''}`),
      t.isOutdated ? chip('outdated') : null, h('span', { class: 'grow' }), t.url ? ext(t.url, 'GitHub ↗') : null),
    h('div', { class: 'cardBody' }, t.myLastComment ? h('div', { class: 'small muted' }, 'You:', md(t.myLastComment.body)) : null,
      t.lastComment && t.lastComment.author !== S.state?.login ? h('div', { class: 'small' }, `${t.lastComment.author}:`, md(t.lastComment.body)) : null,
      !t.isResolved ? reply(t) : null))) : h('p', { class: 'muted' }, 'None.'),
    h('h3', {}, `Other open threads (${others.length})`),
    others.map((t) => h('div', { class: 'small' }, h('span', { class: 'mono' }, `${t.path}:${t.line ?? ''}`), t.isOutdated ? ' (outdated) ' : ' ', t.url ? ext(t.url, 'open') : null)));
}

// --- jobs, activity, settings ---
async function openLog(id) {
  const d = $('#logDialog'); $('#logTitle').textContent = `Job ${id}`; const pre = $('#logBody'); pre.textContent = 'Loading…'; d.showModal();
  let offset = 0; pre.textContent = '';
  const pull = async () => {
    if (!d.open) return;
    const r = await api(`job-log?id=${id}&offset=${offset}`).catch(() => null);
    if (r) { offset = r.offset; for (const l of r.lines) pre.append(h('div', { class: l.kind }, l.text)); pre.scrollTop = pre.scrollHeight; }
    setTimeout(pull, 3000);
  };
  pull();
}
$('#logClose').addEventListener('click', () => $('#logDialog').close());

async function showJobs() {
  const list = await api('jobs').catch((e) => { toast(e.message, true); return []; });
  $('#main').replaceChildren(h('h1', {}, 'Jobs'), h('p', { class: 'muted small' }, 'Claude Code workers run headless (claude -p) on your Claude Code login, or are claimed by an interactive session (prd job claim). They draft; they never post.'),
    h('table', {}, h('thead', {}, h('tr', {}, ['Job', 'PR', 'Type', 'Status', 'Result', 'Created', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, list.map((j) => h('tr', {}, h('td', {}, String(j.id)), h('td', {}, h('a', { href: `#/pr/${j.repo}/${j.number}` }, `${j.repo}#${j.number}`)),
        h('td', {}, j.type, j.args?.auto ? chip('auto') : null), h('td', {}, chip(j.status, j.status), j.claimed_by && j.claimed_by !== 'server' ? h('div', { class: 'small muted' }, j.claimed_by) : null),
        h('td', { class: 'small' }, String(j.result?.summary || j.result?.error || j.result?.question || '').slice(0, 300)), h('td', { class: 'small' }, ago(j.created_at)),
        h('td', {}, h('div', { class: 'rowActions' }, h('button', { class: 'small ghost', onclick: () => openLog(j.id) }, 'Log'),
          ['queued', 'running', 'waiting'].includes(j.status) ? h('button', { class: 'small ghost', onclick: () => run('Cancelled', () => action('cancel-job', { job: j.id })).then(showJobs) }, 'Cancel') : null)))))));
}

async function showActivity() {
  const ev = await api(`events${S.repo ? `?repo=${encodeURIComponent(S.repo)}` : ''}`).catch(() => []);
  $('#main').replaceChildren(h('h1', {}, 'Activity'), ev.length ? h('div', { class: 'feed' }, ev.map((e) => h('div', { class: `ev ${e.level}` },
    h('span', { class: 'small muted' }, e.at.slice(0, 19).replace('T', ' ')),
    h('span', { class: 'small evRef' }, e.number ? h('a', { href: `#/pr/${e.repo}/${e.number}` }, `${e.repo}#${e.number}`) : e.repo || ''),
    h('span', { class: 'evMsg' }, e.message)))) : h('div', { class: 'empty' }, 'No activity yet.'));
}

const RULES_EXAMPLE = {
  priorityAuthors: ['merlimat'],
  ignoreTitle: ['^\\[improve\\]\\[ci\\]'],
  weights: { committer: 150, labels: { 'release/blocker': 300 }, paths: [{ pattern: '^pulsar-broker/src/main/', weight: 30, why: 'broker code' }] },
  auto: { review: { minScore: 300, maxQueued: 2, maxPerDay: 6, committersOnly: true }, reReview: { onHeadMoved: true, onAuthorReply: true } },
  maxClaudeWorkers: 2,
};

function showSettings() {
  const repos = (S.state?.repos || []).filter((r) => !S.repo || r.slug === S.repo);
  const b = S.state?.budget;
  const laneLine = (r) => S.state.lanes.filter((l) => r.lanes[l.id]).map((l) => `${l.title} ${r.lanes[l.id]}`).join(' · ') || 'no PRs yet';
  $('#main').replaceChildren(
    h('div', { class: 'pageHead' }, h('h1', {}, 'Rules & repositories'),
      h('span', { class: 'small muted' }, b?.available ? `Claude ${b.claude?.tier} (${b.claude?.why}) · Codex ${b.codex?.budget} (${b.codex?.why}) · read ${ago(b.at)}` : 'No budget reading.'),
      h('button', { class: 'small ghost', onclick: () => run('Budget refreshed', () => action('budget')).then(refreshState).then(showSettings) }, 'Refresh budget')),
    ...(repos.length ? [] : [h('div', { class: 'empty' }, 'No repositories yet. Run /pr-review-desk in a clone, or prd repo add owner/repo.')]),
    ...repos.map((r) => {
      const ta = h('textarea', { class: 'rulesEdit', rows: Math.max(8, JSON.stringify(r.config, null, 2).split('\n').length + 2), value: JSON.stringify(r.config, null, 2), spellcheck: 'false' });
      const checkout = h('input', { value: r.checkout || '', placeholder: 'local clone (empty: diff-only reviews)' });
      const remote = h('input', { value: r.remote || '', placeholder: 'remote' });
      const save = () => run('Saved; scores update on the next sync', async () => {
        let cfg; try { cfg = JSON.parse(ta.value || '{}'); } catch (e) { throw new Error(`rules are not valid JSON: ${e.message}`); }
        await action('repo', { slug: r.slug, checkout: checkout.value, remote: remote.value, config: cfg });
      }).then(refreshState).then(showSettings);
      return h('section', { class: 'panel repoPanel' },
        h('div', { class: 'repoHead' }, h('h2', {}, r.slug),
          r.syncing ? chip('syncing', 'running') : r.sync_error ? chip('sync failed', 'bad', r.sync_error) : h('span', { class: 'small muted' }, `synced ${ago(r.synced_at)}`),
          h('span', { class: 'grow' }),
          h('label', { class: 'toggle small' }, h('input', { type: 'checkbox', checked: r.enabled, onchange: (e) => action('repo', { slug: r.slug, enabled: e.target.checked }).then(refreshState) }), 'Sync'),
          h('label', { class: 'toggle small', title: 'Queue AI reviews by the rules below. Nothing posts without you.' },
            h('input', { type: 'checkbox', checked: r.autopilot, onchange: (e) => action('repo', { slug: r.slug, autopilot: e.target.checked }).then(refreshState) }), 'Autopilot')),
        h('p', { class: 'small muted' }, laneLine(r)),
        r.sync_error ? h('p', { class: 'warnings' }, `Last sync failed: ${r.sync_error}`) : null,
        h('div', { class: 'formGrid' },
          h('label', {}, h('span', {}, 'Checkout'), checkout),
          h('label', {}, h('span', {}, 'Remote'), remote),
          h('button', { class: 'small', onclick: save }, 'Save')),
        h('details', { class: 'rules' },
          h('summary', {}, 'Rules and priorities', Object.keys(r.config).length ? chip(`${Object.keys(r.config).length} override(s)`, 'info') : h('span', { class: 'small muted' }, ' (defaults)')),
          h('div', { class: 'rulesGrid' },
            h('div', {}, h('div', { class: 'small muted' }, 'Your overrides (JSON, merged over the defaults)'), ta,
              h('div', { class: 'editRow' }, h('button', { class: 'primary small', onclick: save }, 'Save rules'),
                h('button', { class: 'small ghost', onclick: () => { ta.value = JSON.stringify(RULES_EXAMPLE, null, 2); ta.rows = ta.value.split('\n').length + 2; } }, 'Insert example'),
                h('button', { class: 'small ghost', onclick: () => { S.repo = r.slug; previewRules(); } }, 'Preview auto-review'))),
            h('div', {}, h('div', { class: 'small muted' }, 'Effective configuration (read-only)'), h('pre', { class: 'log effective' }, JSON.stringify(r.effective, null, 2))))));
    }));
}

// --- boot ---
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="http"]');
  if (a && !a.target) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
});
await refreshState();
route();
setInterval(async () => {
  await refreshState();
  const onBoard = !location.hash.replace(/^#\/?/, '') || location.hash.startsWith('#/lane');
  if (onBoard && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) refreshBoard();
}, 15000);

// Phones show each table row as a card (app.css): label every cell with its column heading
// (not the PR number and title, which speak for themselves).
const NO_LABEL = new Set(['#', 'PR', 'Title']);
function labelCells(root = document) {
  for (const t of root.querySelectorAll('table')) {
    const heads = [...(t.tHead?.rows[0]?.cells || [])].map((c) => c.textContent.replace(/[▲▼↑↓]/g, '').trim());
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
