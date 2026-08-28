#!/usr/bin/env node
// prt — the deterministic engine behind the `pr-review-track` skill.
//
// Division of labour:
//   * This script owns everything mechanical: GitHub reads, on-disk state, the
//     action-file format, and the ONLY code that writes to GitHub.
//   * The skill (a model) owns judgement: reading the diff, deciding whether
//     the author addressed a point, drafting the words.
//   * The human owns the gate: nothing is posted until line 1 says `ready`.
//
// Run `prt help` for the command list.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { viewerLogin, resolveRepo, rateLimit, GhError } from './lib/gh.mjs';
import {
  fetchPr, fetchPrsBatch, searchEngagedPrs, recentOpenPrs, approvedPrs, prDiff, compareDiff,
} from './lib/github.mjs';
import { analyzePr, fetchDelta, summarizeCounts, THREAD_STATES } from './lib/analyze.mjs';
import { rankCandidates, scoreTracked } from './lib/rank.mjs';
import { renderActionFile, renderNudgeFile, renderBoard, bucketOf, inlineIdFor, expectedBlockIds } from './lib/render.mjs';
import { parseDiff, commentableAnchors, validateAnchor } from './lib/diff.mjs';
import {
  parseActionFile, parseStatus, setStatus, contentHash, appendLog, planActions,
  PROTECTED_STATUSES, IN_FLIGHT_STATUSES, STATUSES,
  carryAsks, collectAsks, maxAskOrdinal, promoteShorthand, askState, ensurePrActions,
} from './lib/actionfile.mjs';

/** Statuses only the submitter may write. */
const MACHINE_ONLY_STATUSES = new Set(['queued', 'submitting', 'submitted', 'partial', 'blocked', 'error', 'superseded']);
import { submitReady, diffFingerprint, findOpenTx } from './lib/submit.mjs';
import * as store from './lib/store.mjs';

const VERSION = '1.0.0';

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const CMD = argv._[0] ?? 'help';
const JSON_OUT = !!argv.flags.json;

function say(...a) { if (!JSON_OUT) console.log(...a); }
function emit(obj) { if (JSON_OUT) console.log(JSON.stringify(obj, null, 2)); }
function die(msg, code = 1) {
  if (JSON_OUT) console.log(JSON.stringify({ error: String(msg) }, null, 2));
  else console.error(`prt: ${msg}`);
  process.exit(code);
}

// A PR directory must stay inside the tracking root and be named pr-<digits>.
function assertSafeNumber(n) {
  if (!/^\d+$/.test(String(n))) throw new Error(`not a pull request number: ${n}`);
  return Number(n);
}

async function context() {
  const root = argv.flags.root || store.DEFAULT_ROOT;
  let cfg = store.loadConfig(root);
  const repo = await resolveRepo(argv.flags.repo);
  cfg = store.repoConfig(cfg, repo);
  if (!cfg.reviewer) cfg.reviewer = await viewerLogin();
  return { root, repo, cfg, login: cfg.reviewer };
}

function nudgeOpts(base) {
  return {
    nudgeAfterDays: base.cfg.nudgeAfterDays,
    nudgeCooldownDays: base.cfg.nudgeCooldownDays,
    nudgeMaxAgeDays: base.cfg.nudgeMaxAgeDays,
  };
}

function prCtx(base, number) {
  assertSafeNumber(number);
  const prPath = store.prDir(base.root, base.repo, number);
  return {
    ...base,
    number,
    prPath,
    actionPath: store.actionFilePath(base.root, base.repo, number),
    config: base.cfg,
  };
}

// ------------------------------------------------------------------ commands

const COMMANDS = {};

COMMANDS.help = () => {
  console.log(`prt ${VERSION} — pull-request review tracking

  Discovery
    latest [--limit N] [--include-drafts]  rank open PRs I have not reviewed yet
    sync [--limit N] [--prune]             reconcile GitHub <-> local tracking baseline
    board [--bucket B]                     the attention board (also writes BOARD.md)
    list [--status S]                      tracked PRs, one line each
    approved                               open PRs currently approved by me

  Per PR
    track <N>...                           start tracking, fetch the baseline
    refresh <N>...                         re-fetch GitHub state for tracked PRs
    context <N>                            full analysis as JSON (input for the model)
    diff <N> [--since <sha>]               the diff, or the diff since my last review
    anchors <N>                            commentable (path,line,side) positions
    draft <N> [--findings f.json] [--kind initial|re-review]
                                           write review.md (carries notes; never over a protected file)
    ask [<N>...] [--promote]               read notes to the assistant, or promote @ai shorthand
    open <N>...                            open review.md in the configured editor
    nudge [<N>...] [--limit 10]            draft reminders for unanswered feedback

  Posting  (the only commands that write to GitHub)
    validate <N>...                        parse + preflight without posting
    submit <N>... | --all-ready            post files whose line 1 says "ready"
    watch [--interval S] [--once]          poll for "ready" files and post them
    recover <N>                            reconcile an interrupted transaction

  Housekeeping
    cleanup [--purge] [--dry-run]          archive tracking for closed/merged PRs
    archive <N>... [--reason "why"]        set a review aside; \`latest\` stops offering it
    archive [--list]                       what is in the archive
    unarchive <N>...                       bring one back, draft and cache intact
    status <N> [<status>]                  read or set line 1
    doctor                                 environment + rate-limit check

  Aliases
    show-latest = latest    queue = list    scan = sync    post = submit
    ignore = archive        restore = unarchive

  Global flags: --repo owner/repo  --root DIR  --json  --limit N

  re-review and review-latest are workflows of the pr-review-track SKILL, not of
  this script: they combine these commands with a model's judgement.
`);
};

COMMANDS.doctor = async () => {
  const base = await context();
  const rl = await rateLimit();
  const repos = store.listRepos(base.root);
  const info = {
    version: VERSION,
    root: base.root,
    repo: base.repo,
    reviewer: base.login,
    editor: `${base.cfg.editorCmd} ${base.cfg.editorArgs.join(' ')}`.trim(),
    graphqlRateLimit: rl,
    trackedRepos: repos.map((r) => ({ repo: r, prs: store.listTracked(base.root, r).length })),
  };
  emit(info);
  if (!JSON_OUT) {
    say(`prt ${VERSION}`);
    say(`  root       ${info.root}`);
    say(`  repo       ${info.repo}`);
    say(`  reviewer   ${info.reviewer}`);
    say(`  editor     ${info.editor}`);
    say(`  graphql    ${rl.remaining}/${rl.limit} points, resets ${rl.resetAt}`);
    for (const r of info.trackedRepos) say(`  tracking   ${r.repo}: ${r.prs} PR(s)`);
  }
};

COMMANDS.latest = async () => {
  const base = await context();
  const limit = Number(argv.flags.limit ?? base.cfg.latestLimit);
  const pool = Number(argv.flags.pool ?? 120);

  const [candidates, engaged] = await Promise.all([
    recentOpenPrs(base.repo, { limit: pool, includeDrafts: !!argv.flags['include-drafts'] }),
    searchEngagedPrs(base.repo, base.login),
  ]);
  const tracked = new Set(store.listTracked(base.root, base.repo));
  // Archiving a PR is how the reviewer says "not this one". Ranking it back to
  // the top of the list tomorrow would make that gesture meaningless.
  const archived = new Set(store.listArchived(base.root, base.repo));
  const reviewRequested = new Set(
    [...engaged.entries()].filter(([, why]) => why.has('review-requested')).map(([n]) => n),
  );

  const eligible = candidates.filter((pr) => {
    if (pr.author?.login === base.login) return false;
    if (base.cfg.ignoreAuthors.includes(pr.author?.login)) return false;
    if (tracked.has(pr.number) || archived.has(pr.number)) return false;
    // Exclude only PRs I have actually engaged with. A PR where my review was
    // *requested* and I have not answered is the single most relevant thing
    // this command can surface — filtering it out as "engaged" hid exactly the
    // PRs most explicitly waiting on me.
    const why = engaged.get(pr.number);
    if (why && (why.has('reviewed') || why.has('commented'))) return false;
    return true;
  });

  const ranked = rankCandidates(eligible, {
    login: base.login,
    priorityAuthors: base.cfg.priorityAuthors,
    reviewRequested,
    maxPerAuthor: Number(argv.flags['max-per-author'] ?? base.cfg.maxPerAuthor ?? 2),
  }).slice(0, limit);

  const rows = ranked.map(({ pr, score, reasons }) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login,
    authorAssociation: pr.authorAssociation,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    ci: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    reviewCount: (pr.reviews?.nodes ?? []).length,
    score,
    reasons,
  }));
  emit({ repo: base.repo, considered: eligible.length, rows });
  if (!JSON_OUT) {
    say(`Top ${rows.length} of ${eligible.length} open PRs in ${base.repo} that I have not engaged with:\n`);
    for (const [i, r] of rows.entries()) {
      say(`${String(i + 1).padStart(2)}. #${r.number}  ${r.title}`);
      say(`    ${r.author} (${r.authorAssociation})  ·  +${r.additions}/-${r.deletions} in ${r.changedFiles} files  ·  CI ${r.ci ?? '?'}  ·  score ${r.score}`);
      say(`    ${r.reasons.slice(0, 4).join(', ')}`);
      say(`    ${r.url}`);
    }
  }
};

COMMANDS.approved = async () => {
  const base = await context();
  const prs = await approvedPrs(base.repo, base.login);
  const rows = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? null,
    updatedAt: pr.updatedAt,
  }));
  emit({ repo: base.repo, reviewer: base.login, rows });
  if (!JSON_OUT) {
    if (!rows.length) {
      say(`No open PRs in ${base.repo} are currently approved by ${base.login}.`);
      return;
    }
    say(`Open PRs currently approved by ${base.login}:`);
    say('');
    for (const row of rows) {
      say(`- #${row.number} ${row.title}${row.author ? ` — @${row.author}` : ''}`);
      say(`  ${row.url}`);
    }
    say('');
    say(`${rows.length} approved PR(s).`);
  }
};

/**
 * Give an existing `review.md` the `prt:pr-actions` block if it was drafted
 * before that block existed.
 *
 * Every command that rewrites the file runs this, so the two buttons turn up on
 * the drafts already sitting in the tree rather than only on the next
 * regenerated one. Nothing is written when there is nothing to add, and the
 * flags always arrive `false` — see `ensurePrActions` for what it declines to
 * touch.
 */
function backfillPrActions(base, number, merged) {
  const file = store.actionFilePath(base.root, base.repo, number);
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const next = ensurePrActions(text, { merged });
  if (next === text) return false;
  store.writeAtomic(file, next);
  return true;
}

COMMANDS.sync = async () => {
  const base = await context();
  const limit = argv.flags.limit ? Number(argv.flags.limit) : Infinity;

  const engaged = await searchEngagedPrs(base.repo, base.login);
  const tracked = new Set(store.listTracked(base.root, base.repo));
  const remote = new Set(engaged.keys());

  const missing = [...remote].filter((n) => !tracked.has(n)).slice(0, limit);
  const all = [...new Set([...tracked, ...remote])];

  say(`${base.repo}: ${remote.size} PR(s) I have engaged with on GitHub, ${tracked.size} tracked locally.`);
  if (missing.length) say(`Adding ${missing.length} missing tracking director${missing.length === 1 ? 'y' : 'ies'}…`);

  const details = await fetchPrsBatch(base.repo, all, {
    detail: true,
    onProgress: (d, t) => { if (!JSON_OUT) process.stderr.write(`\r[prt] fetching ${d}/${t} batches…`); },
  });
  if (!JSON_OUT) process.stderr.write('\r' + ' '.repeat(40) + '\r');

  const added = [];
  const updated = [];
  const closed = [];
  const backfilled = [];
  for (const number of all) {
    const pr = details.get(number);
    if (!pr) continue;
    const wasTracked = tracked.has(number);
    if (!wasTracked && !remote.has(number)) continue;

    const analysis = analyzePr(pr, base.login, nudgeOpts(base));
    const prev = wasTracked ? store.readState(base.root, base.repo, number) : null;
    const state = {
      schema: 1,
      repo: base.repo,
      number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? null,
      authorAssociation: pr.authorAssociation,
      state: pr.state,
      merged: !!pr.merged,
      isDraft: !!pr.isDraft,
      headOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      updatedAt: pr.updatedAt,
      engagedBecause: [...(engaged.get(number) ?? ['tracked'])],
      tracking: prev?.tracking ?? { addedAt: new Date().toISOString(), addedBy: 'sync', generation: 0 },
      lastSyncAt: new Date().toISOString(),
      analysis,
    };
    store.writeState(base.root, base.repo, number, state);
    if (backfillPrActions(base, number, state.merged)) backfilled.push(number);
    if (pr.state !== 'OPEN') closed.push(number);
    else if (wasTracked) updated.push(number);
    else added.push(number);
  }

  writeBoard(base);
  emit({ repo: base.repo, added, updated, closed, backfilled, engaged: remote.size, tracked: all.length });
  if (!JSON_OUT) {
    say(`  added   ${added.length}${added.length ? `: ${added.slice(0, 15).join(', ')}${added.length > 15 ? '…' : ''}` : ''}`);
    say(`  updated ${updated.length}`);
    if (backfilled.length) say(`  pr-actions block added to ${backfilled.length} draft(s): ${backfilled.join(', ')}`);
    say(`  closed/merged ${closed.length}${closed.length ? ` (run \`prt cleanup\`)` : ''}`);
    say('');
    say(`Baseline written. Ask for a re-review to draft responses: \`prt list --status draft\``);
  }
};

COMMANDS.track = async () => {
  const base = await context();
  const numbers = argv._.slice(1).map(assertSafeNumber);
  if (!numbers.length) die('usage: prt track <PR number>...');
  const out = [];
  for (const n of numbers) {
    const pr = await fetchPr(base.repo, n);
    if (!pr) { out.push({ number: n, error: 'not found' }); continue; }
    const analysis = analyzePr(pr, base.login, nudgeOpts(base));
    store.writeState(base.root, base.repo, n, {
      schema: 1,
      repo: base.repo,
      number: n,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? null,
      authorAssociation: pr.authorAssociation,
      state: pr.state,
      merged: !!pr.merged,
      isDraft: !!pr.isDraft,
      headOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      updatedAt: pr.updatedAt,
      engagedBecause: ['manual'],
      tracking: { addedAt: new Date().toISOString(), addedBy: 'track', generation: 0 },
      lastSyncAt: new Date().toISOString(),
      analysis,
    });
    out.push({ number: n, title: pr.title, dir: store.prDir(base.root, base.repo, n) });
    say(`tracking ${base.repo}#${n} — ${pr.title}`);
  }
  writeBoard(base);
  emit({ tracked: out });
};

COMMANDS.refresh = async () => {
  const base = await context();
  const numbers = (argv._.slice(1).length ? argv._.slice(1) : store.listTracked(base.root, base.repo)).map(assertSafeNumber);
  const details = await fetchPrsBatch(base.repo, numbers, { detail: true });
  const rows = [];
  for (const n of numbers) {
    const pr = details.get(n);
    if (!pr) continue;
    const prev = store.readState(base.root, base.repo, n);
    const analysis = analyzePr(pr, base.login, nudgeOpts(base));
    store.writeState(base.root, base.repo, n, {
      ...(prev ?? {}),
      schema: 1,
      repo: base.repo,
      number: n,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? null,
      authorAssociation: pr.authorAssociation,
      state: pr.state,
      merged: !!pr.merged,
      isDraft: !!pr.isDraft,
      headOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      updatedAt: pr.updatedAt,
      lastSyncAt: new Date().toISOString(),
      analysis,
    });
    const backfilled = backfillPrActions(base, n, !!pr.merged);
    rows.push({ number: n, headMoved: analysis.headMoved, threads: analysis.threadCounts, backfilled });
  }
  writeBoard(base);
  emit({ refreshed: rows });
  if (!JSON_OUT) for (const r of rows) say(`#${r.number}  ${r.headMoved ? 'head moved' : 'head unchanged'}  ·  ${summarizeCounts(r.threads)}${r.backfilled ? '  ·  pr-actions block added' : ''}`);
};

/**
 * Everything the model needs to judge one PR, as JSON: the analysis, the
 * incremental diff since my last review, my open threads with their full text,
 * and the legal comment anchors.
 */
COMMANDS.context = async () => {
  const base = await context();
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt context <PR number>'));
  const pr = await fetchPr(base.repo, n);
  if (!pr) die(`${base.repo}#${n} not found`);

  const analysis0 = analyzePr(pr, base.login, nudgeOpts(base));
  const delta = await fetchDelta(base.repo, { reviewedOid: analysis0.myLastReview?.oid, headOid: pr.headRefOid });
  const analysis = analyzePr(pr, base.login, { ...nudgeOpts(base), deltaDiff: delta.diff, newCommits: delta.commits });

  const fullDiff = await prDiff(base.repo, n);
  const files = parseDiff(fullDiff);
  const anchors = commentableAnchors(files);

  store.ensurePrDir(base.root, base.repo, n);
  fs.writeFileSync(store.cacheFile(base.root, base.repo, n, 'diff.patch'), fullDiff);
  if (delta.diff) fs.writeFileSync(store.cacheFile(base.root, base.repo, n, 'delta.patch'), delta.diff);

  const out = {
    repo: base.repo,
    number: n,
    reviewer: base.login,
    prBody: pr.body,
    analysis,
    delta: { commits: delta.commits, error: delta.error ?? null, hasDiff: !!delta.diff },
    diffFingerprint: diffFingerprint(fullDiff),
    files: [...files.values()].map((f) => ({
      path: f.path,
      status: f.status,
      binary: f.binary,
      commentableRight: [...(anchors.get(f.path)?.right ?? [])].sort((a, b) => a - b),
      commentableLeft: [...(anchors.get(f.path)?.left ?? [])].sort((a, b) => a - b),
    })),
    cache: {
      fullDiff: store.cacheFile(base.root, base.repo, n, 'diff.patch'),
      deltaDiff: delta.diff ? store.cacheFile(base.root, base.repo, n, 'delta.patch') : null,
    },
    urgency: scoreTracked(analysis, { priorityAuthors: base.cfg.priorityAuthors }),
  };

  // Notes the human left on the existing draft. Surfaced here as well as in
  // `prt ask` so a subagent that already calls `context` cannot miss them —
  // an unanswered note is the most important thing in the file.
  const existing = store.readActionFile(base.root, base.repo, n);
  if (existing) {
    const { asks, answers } = collectAsks(existing);
    out.asks = asks.map((a) => ({
      id: a.id, re: a.re, state: a.state, open: a.open, blocking: a.blocking,
      raised: a.raised, follows: a.follows, was: a.was, question: a.question,
      answer: answers.filter((x) => x.to === a.id).pop() ?? null,
    }));
  } else out.asks = [];

  console.log(JSON.stringify(out, null, 2));
};

COMMANDS.diff = async () => {
  const base = await context();
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt diff <PR number> [--since <sha>]'));
  if (argv.flags.since || argv.flags.delta) {
    const pr = await fetchPr(base.repo, n);
    if (!pr) die(`${base.repo}#${n} not found`);
    const a = analyzePr(pr, base.login, nudgeOpts(base));
    const since = argv.flags.since === true || !argv.flags.since ? a.myLastReview?.oid : argv.flags.since;
    if (!since) die('no previous review of mine to diff against; omit --since for the full diff');
    process.stdout.write(await compareDiff(base.repo, since, pr.headRefOid));
    return;
  }
  process.stdout.write(await prDiff(base.repo, n));
};

COMMANDS.anchors = async () => {
  const base = await context();
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt anchors <PR number>'));
  const files = parseDiff(await prDiff(base.repo, n));
  const anchors = commentableAnchors(files);
  const rows = [...anchors.entries()].map(([p, a]) => ({
    path: p,
    status: a.status,
    binary: a.binary,
    right: compress([...a.right]),
    left: compress([...a.left]),
  }));
  emit({ repo: base.repo, number: n, files: rows });
  if (!JSON_OUT) for (const r of rows) say(`${r.path}  [${r.status}]  RIGHT ${r.right || '-'}  LEFT ${r.left || '-'}`);
};

function compress(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

COMMANDS.draft = async () => {
  const base = await context();
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt draft <PR number> [--findings file.json]'));
  const ctx = prCtx(base, n);

  const existing = store.readActionFile(base.root, base.repo, n);
  const existingStatus = existing ? parseStatus(existing) : null;
  if (existing && PROTECTED_STATUSES.has(existingStatus) && !argv.flags.force) {
    die(`review.md for #${n} is "${existingStatus}" — refusing to overwrite. Use --force, or --to review.next.md`);
  }

  let findings = null;
  if (argv.flags.findings) {
    findings = JSON.parse(fs.readFileSync(argv.flags.findings, 'utf8'));
  }

  const pr = await fetchPr(base.repo, n);
  if (!pr) die(`${base.repo}#${n} not found`);
  const a0 = analyzePr(pr, base.login, nudgeOpts(base));
  const delta = await fetchDelta(base.repo, { reviewedOid: a0.myLastReview?.oid, headOid: pr.headRefOid });
  const analysis = analyzePr(pr, base.login, { ...nudgeOpts(base), deltaDiff: delta.diff, newCommits: delta.commits });
  const fullDiff = await prDiff(base.repo, n);

  // Anchors are validated at generation time as well as at submit time, so the
  // human never spends effort editing a comment that could never be posted.
  if (findings?.findings?.length) {
    const anchors = commentableAnchors(parseDiff(fullDiff));
    for (const f of findings.findings) {
      if (!f.path || !f.line) continue;
      const v = validateAnchor(anchors, { file: f.path, line: f.endLine ? Math.min(f.line, f.endLine) : f.line, endLine: f.endLine ?? f.line, side: f.side ?? 'RIGHT' });
      if (!v.ok) {
        f.post = false;
        f.body = `${f.body}\n\n<!-- prt: this anchor is not in the diff (${v.reason}${v.nearest ? `; nearest commentable line ${v.nearest}` : ''}), so post is false. Fix line/side, or set subject: file. -->`;
      }
    }
  }

  const prev = store.readState(base.root, base.repo, n);
  const generation = (prev?.tracking?.generation ?? 0) + 1;

  // Carry the human's notes into the new generation. Without this, every round
  // would destroy them and the whole mechanism would be a trap.
  let carried = { asks: [], answers: [], promoted: [], changes: [], retired: 0, maxOrdinal: 0, structuralErrors: [], dropped: [] };
  if (existing && argv.flags['no-carry']) {
    // Name what is being left behind. "carried: 0" reads like "there were none".
    const { asks: wouldCarry } = collectAsks(existing);
    carried.dropped = wouldCarry.map((a) => a.id);
    carried.maxOrdinal = maxAskOrdinal(existing);
  }
  if (existing && !argv.flags['no-carry']) {
    const floor = Math.max(prev?.asks?.ordinalFloor ?? 0, maxAskOrdinal(existing));
    // Promotion happens on an in-memory copy only. Writing a normalisation back
    // into a file that may be `ready` under a running watcher is the one thing
    // that must never happen here.
    const { text: promotedText, promoted } = promoteShorthand(existing, { startOrdinal: floor + 1, generation });
    // Thread and conversation-comment ids count too. Building this from
    // findings alone orphaned every `t*`/`c*`-bound note on every draft.
    const { ids: newIds, anchors: newAnchors } = expectedBlockIds({ analysis, findings });
    carried = { ...carryAsks(promotedText, { newIds, newAnchors, generation, ordinalFloor: floor }), promoted };
    if (carried.structuralErrors?.length) {
      die(`refusing to regenerate #${n}: the existing review.md has notes this tool cannot read safely:\n  ${carried.structuralErrors.join('\n  ')}\nFix them, or pass --no-carry to drop them (the old file is kept in history/).`);
    }
  }

  const text = renderActionFile({
    repo: base.repo,
    analysis,
    delta,
    findings,
    kind: argv.flags.kind ?? (a0.myLastReview ? 're-review' : 'initial'),
    generation,
    diffFingerprint: diffFingerprint(fullDiff),
    baseOid: null,
    reviewerLogin: base.login,
    requireExplicitApprove: base.cfg.requireExplicitApprove,
    carriedAsks: carried.asks,
    carriedAnswers: carried.answers,
    askChanges: carried.changes,
  });

  const target = argv.flags.to
    ? path.join(ctx.prPath, String(argv.flags.to))
    : store.actionFilePath(base.root, base.repo, n);
  if (existing) store.archiveActionFile(base.root, base.repo, n);
  store.ensurePrDir(base.root, base.repo, n);
  store.writeAtomic(target, text);
  store.writeState(base.root, base.repo, n, {
    ...(prev ?? {}),
    schema: 1,
    repo: base.repo,
    number: n,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? null,
    authorAssociation: pr.authorAssociation,
    state: pr.state,
    merged: !!pr.merged,
    isDraft: !!pr.isDraft,
    headOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    updatedAt: pr.updatedAt,
    lastSyncAt: new Date().toISOString(),
    analysis,
    tracking: { ...(prev?.tracking ?? { addedAt: new Date().toISOString(), addedBy: 'draft' }), generation },
    // A retired ask id must never be reissued, or a `follows:` chain in an
    // archived file would point at somebody else's question.
    asks: { ordinalFloor: Math.max(prev?.asks?.ordinalFloor ?? 0, carried.maxOrdinal ?? 0) },
    draft: { path: target, generatedAt: new Date().toISOString(), contentHash: contentHash(text) },
  });
  writeBoard(base);
  const openAsks = carried.asks.filter((x) => x.open);
  emit({
    number: n, file: target, generation,
    asks: {
      carried: carried.asks.length, open: openAsks.length, retired: carried.retired ?? 0,
      promoted: carried.promoted, changes: carried.changes,
    },
  });
  say(`drafted ${target}`);
  for (const p of carried.promoted ?? []) {
    say(`  promoted @ai note → ask ${p.id} (re: ${p.re}${p.inferred ? ', inferred from position' : ''}) at line ${p.line}`);
  }
  for (const c of carried.changes ?? []) {
    say(c.kind === 'rebound'
      ? `  ask ${c.id}: re-targeted ${c.from} → ${c.to}`
      : `  ask ${c.id}: its target ${c.from} is gone — if an earlier round posted that comment, check outbox/`);
  }
  if (openAsks.length) say(`  ${openAsks.length} open note(s) carried: ${openAsks.map((x) => x.id).join(', ')}`);
  if (carried.retired) say(`  ${carried.retired} answered note(s) retired to history/`);
  for (const w of carried.warnings ?? []) say(`  warning: ${w}`);
  if (carried.dropped?.length) {
    say(`  --no-carry: dropped ${carried.dropped.length} note(s) — ${carried.dropped.join(', ')}. The previous file is in history/.`);
  }
};

/**
 * Propose reminders for authors who have not answered points I raised.
 * Produces the same kind of draft as everything else: nothing is sent until a
 * human reads it and sets `Status: ready`.
 */
COMMANDS.nudge = async () => {
  const base = await context();
  const explicit = argv._.slice(1).map(assertSafeNumber);
  const numbers = explicit.length ? explicit : store.listTracked(base.root, base.repo);
  const limit = Number(argv.flags.limit ?? 10);

  const details = await fetchPrsBatch(base.repo, numbers, {
    detail: true,
    onProgress: (d, t) => { if (!JSON_OUT) process.stderr.write(`\r[prt] checking ${d}/${t} batches…`); },
  });
  if (!JSON_OUT) process.stderr.write('\r' + ' '.repeat(40) + '\r');

  const due = [];
  const skipped = [];
  for (const n of numbers) {
    const pr = details.get(n);
    if (!pr) continue;
    const analysis = analyzePr(pr, base.login, nudgeOpts(base));
    if (!analysis.nudge?.due) {
      skipped.push({
        number: n,
        author: analysis.author,
        why: analysis.nudge?.reasonNotDue ?? 'not due',
        abandoned: !!analysis.nudge?.abandoned,
        oldestDays: analysis.nudge?.oldestUntouchedDays ?? null,
      });
      continue;
    }
    const existing = store.readActionFile(base.root, base.repo, n);
    const st = existing ? parseStatus(existing) : null;
    if (existing && PROTECTED_STATUSES.has(st) && !argv.flags.force) {
      skipped.push({ number: n, why: `an action file is already "${st}"` });
      continue;
    }
    due.push({ number: n, analysis });
  }

  const batch = explicit.length ? due : due.slice(0, limit);
  const written = [];
  for (const { number: n, analysis } of batch) {
    const prev = store.readState(base.root, base.repo, n);
    const generation = (prev?.tracking?.generation ?? 0) + 1;
    const before = store.readActionFile(base.root, base.repo, n);
    // A nudge-due PR is exactly one where a review was drafted and never
    // posted, so it is precisely where unanswered notes live. `draft` is not a
    // protected status, so without this the reminder would destroy them.
    let nudgeAsks = { asks: [], answers: [], maxOrdinal: 0 };
    let askFloor = prev?.asks?.ordinalFloor ?? 0;
    if (before) {
      askFloor = Math.max(askFloor, maxAskOrdinal(before));
      const { text: promotedText } = promoteShorthand(before, { startOrdinal: askFloor + 1, generation });
      nudgeAsks = carryAsks(promotedText, { generation, ordinalFloor: askFloor });
      // Overwriting a file whose notes cannot be read would destroy them from
      // the working copy. Skip the reminder instead — it can wait; the notes
      // cannot be retyped.
      if (nudgeAsks.structuralErrors?.length) {
        skipped.push({ number: n, why: `its review.md has notes that cannot be parsed: ${nudgeAsks.structuralErrors[0]}` });
        say(`  #${n}: SKIPPED — the existing review.md has notes this tool cannot read safely, so it was left alone.`);
        for (const e of nudgeAsks.structuralErrors) say(`      ${e}`);
        continue;
      }
      store.archiveActionFile(base.root, base.repo, n);
      askFloor = Math.max(askFloor, nudgeAsks.maxOrdinal ?? 0);
      if (nudgeAsks.asks.length) {
        say(`  #${n}: carried ${nudgeAsks.asks.length} note(s) into the reminder draft`);
      }
    }
    const text = renderNudgeFile({
      repo: base.repo, analysis, generation, reviewerLogin: base.login,
      carriedAsks: nudgeAsks.asks, carriedAnswers: nudgeAsks.answers,
    });
    store.ensurePrDir(base.root, base.repo, n);
    store.writeAtomic(store.actionFilePath(base.root, base.repo, n), text);
    store.writeState(base.root, base.repo, n, {
      ...(prev ?? {}), schema: 1, repo: base.repo, number: n,
      title: analysis.title, url: analysis.url, author: analysis.author,
      authorAssociation: analysis.authorAssociation, state: analysis.state,
      isDraft: analysis.isDraft, headOid: analysis.headOid, baseRefName: analysis.baseRefName,
      updatedAt: analysis.updatedAt, lastSyncAt: new Date().toISOString(), analysis,
      tracking: { ...(prev?.tracking ?? { addedAt: new Date().toISOString(), addedBy: 'nudge' }), generation },
      // Advance the floor here too. On a PR that only ever saw nudges, nothing
      // else records it, and a retired ask id would be handed out a second time.
      asks: { ordinalFloor: askFloor },
    });
    written.push({
      number: n,
      author: analysis.author,
      unanswered: analysis.nudge.untouchedCount,
      oldestDays: analysis.nudge.oldestUntouchedDays,
      file: store.actionFilePath(base.root, base.repo, n),
    });
  }
  writeBoard(base);
  emit({ repo: base.repo, drafted: written, skipped, dueTotal: due.length });
  if (!JSON_OUT) {
    if (!written.length) {
      say(`no reminders are due (checked ${numbers.length} PR(s), threshold ${base.cfg.nudgeAfterDays} days)`);
    } else {
      say(`drafted ${written.length} reminder(s)${due.length > written.length ? ` of ${due.length} due` : ''}:`);
      for (const w of written) {
        say(`  #${w.number}  ${w.author}  ${w.unanswered} unanswered, oldest ${w.oldestDays}d`);
      }
      say('');
      say('Nothing is sent. Read each one, edit it, then set line 1 to "Status: ready".');
    }
    const abandoned = skipped.filter((x) => x.abandoned);
    if (abandoned.length) {
      say('');
      say(`${abandoned.length} PR(s) are past the ${base.cfg.nudgeMaxAgeDays}-day limit — these need a decision, not a reminder:`);
      for (const x of abandoned) say(`  #${x.number}  ${x.author}  oldest point ${x.oldestDays}d`);
    }
  }
};

/**
 * Read the notes in an action file, and promote any `@ai` shorthand into
 * canonical blocks.
 *
 * There is deliberately no `--addressed` flag. Closing a note requires prose
 * saying what was done, prose is judgement, and judgement is the model's half
 * of the split — a flag that closed one without a body is exactly what the
 * mandatory-answer-body rule exists to forbid.
 */
COMMANDS.ask = async () => {
  const base = await context();
  const numbers = (argv._.slice(1).length ? argv._.slice(1) : store.listTracked(base.root, base.repo)).map(assertSafeNumber);
  const rows = [];
  for (const n of numbers) {
    const file = store.actionFilePath(base.root, base.repo, n);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const status = parseStatus(text);

    if (argv.flags.promote) {
      // Never rewrite a file a submission may be reading or about to capture.
      if (PROTECTED_STATUSES.has(status) && status !== 'hold') {
        say(`#${n}: "${status}" — refusing to rewrite. Set it back to draft or hold first.`);
        continue;
      }
      const prev = store.readState(base.root, base.repo, n);
      const floor = Math.max(prev?.asks?.ordinalFloor ?? 0, maxAskOrdinal(text));
      const generation = prev?.tracking?.generation ?? 1;
      const { text: promotedText, promoted } = promoteShorthand(text, { startOrdinal: floor + 1, generation });
      const nextText = ensurePrActions(promotedText, { merged: !!prev?.merged });
      if (nextText !== text) store.writeAtomic(file, nextText);
      if (promoted.length) {
        store.writeState(base.root, base.repo, n, {
          ...(prev ?? {}),
          asks: { ordinalFloor: Math.max(floor, maxAskOrdinal(promotedText)) },
        });
      }
      for (const p of promoted) {
        say(`#${n}: promoted @ai note → ask ${p.id} (re: ${p.re}${p.inferred ? ', inferred from position' : ''}) at line ${p.line}`);
      }
      if (!promoted.length) say(`#${n}: no un-promoted @ai notes`);
      rows.push({ number: n, promoted });
      continue;
    }

    const { asks, answers } = collectAsks(text);
    const row = {
      number: n,
      status,
      file,
      asks: asks.map((a) => ({
        id: a.id, re: a.re, state: a.state, open: a.open, blocking: a.blocking,
        raised: a.raised, follows: a.follows, was: a.was, question: a.question,
        answer: (answers.filter((x) => x.to === a.id).pop() ?? null),
      })),
    };
    rows.push(row);
    if (!JSON_OUT && row.asks.length) {
      const open = row.asks.filter((x) => x.open);
      say(`#${n} [${status}] — ${row.asks.length} note(s), ${open.length} open`);
      for (const a of row.asks) {
        const mark = a.open ? (a.blocking ? '●' : '○') : '✓';
        say(`  ${mark} ${a.id}  re: ${a.re}  ${a.state}${a.raised ? `  (${a.raised})` : ''}`);
        say(`      ${a.question.split('\n')[0].slice(0, 100)}`);
      }
    }
  }
  emit({ rows });
  if (!JSON_OUT && !rows.some((r) => r.asks?.length || r.promoted?.length)) say('no notes');
};

COMMANDS.open = async () => {
  const base = await context();
  const numbers = (argv._.slice(1).length ? argv._.slice(1) : readyOrDraftNumbers(base)).map(assertSafeNumber);
  const files = numbers.map((n) => store.actionFilePath(base.root, base.repo, n)).filter((f) => fs.existsSync(f));
  if (!files.length) die('no review.md files to open');
  const cmd = base.cfg.editorCmd;
  const args = [...base.cfg.editorArgs, ...files];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  emit({ opened: files });
  say(`opened ${files.length} file(s) in ${cmd}`);
};

function readyOrDraftNumbers(base) {
  return store.listTracked(base.root, base.repo).filter((n) => {
    const t = store.readActionFile(base.root, base.repo, n);
    return t && ['draft', 'blocked', 'error', 'partial'].includes(parseStatus(t));
  });
}

COMMANDS.list = async () => {
  const base = await context();
  const wanted = argv.flags.status ? String(argv.flags.status).split(',') : null;
  const rows = [];
  for (const n of store.listTracked(base.root, base.repo)) {
    const st = store.readState(base.root, base.repo, n);
    const text = store.readActionFile(base.root, base.repo, n);
    const status = text ? parseStatus(text) : null;
    if (wanted && !wanted.includes(status ?? 'none')) continue;
    rows.push({
      number: n,
      title: st?.title ?? '(unknown)',
      author: st?.author,
      prState: st?.state,
      status: status ?? 'none',
      bucket: st?.analysis ? bucketOf({ analysis: st.analysis, status }) : 'unknown',
      threads: st?.analysis ? summarizeCounts(st.analysis.threadCounts) : '',
      urgency: st?.analysis ? scoreTracked(st.analysis, { priorityAuthors: base.cfg.priorityAuthors }).score : 0,
      file: store.actionFilePath(base.root, base.repo, n),
    });
  }
  rows.sort((a, b) => b.urgency - a.urgency);
  emit({ repo: base.repo, rows });
  if (!JSON_OUT) {
    for (const r of rows) {
      say(`#${String(r.number).padEnd(6)} ${String(r.status).padEnd(10)} ${String(r.bucket).padEnd(24)} ${r.title.slice(0, 60)}`);
      if (r.threads) say(`${' '.repeat(8)}${r.threads}`);
    }
    say(`\n${rows.length} tracked PR(s) in ${base.repo}.`);
  }
};

function writeBoard(base) {
  const dir = store.repoDir(base.root, base.repo);
  const rows = [];
  for (const n of store.listTracked(base.root, base.repo)) {
    const st = store.readState(base.root, base.repo, n);
    if (!st) continue;
    const text = store.readActionFile(base.root, base.repo, n);
    const status = text ? parseStatus(text) : null;
    const analysis = st.analysis ?? {};
    rows.push({
      number: n,
      title: st.title,
      url: st.url,
      author: st.author,
      prState: st.state,
      status: status ?? 'none',
      // Relative to the board's own directory, and derived from the store
      // layout rather than re-spelling `pr-<N>/review.md` in a second place.
      reviewPath: text
        ? path.relative(dir, store.actionFilePath(base.root, base.repo, n)).split(path.sep).join('/')
        : null,
      bucket: st.analysis ? bucketOf({ analysis, status }) : 'unknown',
      threads: st.analysis ? summarizeCounts(analysis.threadCounts) : '',
      ci: analysis.ci,
      updatedAt: st.updatedAt,
      urgency: st.analysis ? scoreTracked(analysis, { priorityAuthors: base.cfg.priorityAuthors }).score : 0,
    });
  }

  const file = path.join(dir, 'BOARD.md');
  const archived = store.listArchived(base.root, base.repo);
  store.writeAtomic(file, renderBoard({ repo: base.repo, rows, storeDir: dir, archived }));
  return file;
}

COMMANDS.board = async () => {
  const base = await context();
  const file = writeBoard(base);
  if (JSON_OUT) emit({ file, content: fs.readFileSync(file, 'utf8') });
  else process.stdout.write(fs.readFileSync(file, 'utf8'));
};

COMMANDS.status = async () => {
  const base = await context();
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt status <PR number> [<new status>]'));
  const file = store.actionFilePath(base.root, base.repo, n);
  if (!fs.existsSync(file)) die(`no review.md for #${n}`);
  const next = argv._[2];
  if (!next) {
    const s = parseStatus(fs.readFileSync(file, 'utf8'));
    emit({ number: n, status: s });
    say(s);
    return;
  }
  if (!STATUSES.includes(next)) {
    die(`"${next}" is not a status. Valid: ${STATUSES.join(', ')}`);
  }
  if (MACHINE_ONLY_STATUSES.has(next)) {
    die(`"${next}" is written by the submitter, not by hand.`);
  }
  if (next === 'ready') {
    // Arming a file is the human's signature. Making it unreachable through the
    // CLI means invariant 2 rests on the tool, not on an agent's good manners.
    die(`prt will not set "ready" — that is the approval signature.\n  Open ${file} and change line 1 yourself.`);
  }
  const merged = !!store.readState(base.root, base.repo, n)?.merged;
  const text = ensurePrActions(setStatus(fs.readFileSync(file, 'utf8'), next), { merged });
  store.writeAtomic(file, text);
  emit({ number: n, status: next });
  say(`#${n} → ${next}`);
};

COMMANDS.validate = async () => {
  const base = await context();
  const numbers = (argv._.slice(1).length ? argv._.slice(1) : store.listTracked(base.root, base.repo)).map(assertSafeNumber);
  const rows = [];
  for (const n of numbers) {
    const file = store.actionFilePath(base.root, base.repo, n);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseActionFile(text);
    const row = { number: n, status: parsed.status, errors: parsed.errors, warnings: parsed.warnings, actions: [] };
    if (!parsed.errors.length) {
      row.actions = planActions(parsed).map((a) => ({ id: a.id, kind: a.kind }));
      // Anchor check against the live diff.
      try {
        const anchors = commentableAnchors(parseDiff(await prDiff(base.repo, n)));
        for (const c of parsed.inline.filter((x) => x.post && x.subject !== 'file')) {
          const v = validateAnchor(anchors, {
            file: c.path, line: c.subject === 'range' ? c.startLine : c.line,
            endLine: c.line, side: c.side, startSide: c.startSide,
          });
          if (!v.ok) row.errors.push(`inline "${c.id}": ${v.reason}${v.nearest ? ` (nearest ${v.nearest})` : ''}`);
        }
      } catch (e) {
        row.warnings.push(`could not fetch the diff to validate anchors: ${e.message}`);
      }
    }
    rows.push(row);
    if (!JSON_OUT) {
      const mark = row.errors.length ? '✗' : '✓';
      say(`${mark} #${n} [${row.status}] ${row.actions.length} action(s)`);
      for (const e of row.errors) say(`    error:   ${e}`);
      for (const w of row.warnings) say(`    warning: ${w}`);
    }
  }
  emit({ rows });
  if (rows.some((r) => r.errors.length)) process.exitCode = 1;
};

COMMANDS.submit = async () => {
  const base = await context();
  let numbers;
  if (argv.flags['all-ready']) numbers = readyNumbers(base);
  else numbers = argv._.slice(1).map(assertSafeNumber);
  if (!numbers.length) {
    emit({ submitted: [] });
    say('nothing is marked ready');
    return;
  }
  const results = [];
  for (const n of numbers) {
    const ctx = prCtx(base, n);
    if (!fs.existsSync(ctx.actionPath)) { results.push({ number: n, ok: false, message: 'no review.md' }); continue; }
    const status = parseStatus(fs.readFileSync(ctx.actionPath, 'utf8'));
    const dryRun = !!argv.flags['dry-run'];
    // An open transaction outranks the status line. A crash mid-flight leaves
    // the file saying `error` while a captured snapshot still needs finishing;
    // refusing to look at it because line 1 is not "ready" would strand the PR
    // with no way forward but hand-editing.
    const hasOpenTx = !!findOpenTx(ctx.prPath);
    if (!dryRun && !hasOpenTx && status !== 'ready' && !['queued', 'partial'].includes(status)) {
      results.push({ number: n, ok: false, status, message: `status is "${status}", not "ready"` });
      continue;
    }
    let res;
    try {
      res = await submitReady({ ...ctx, dryRun });
    } catch (e) {
      res = { ok: false, status: dryRun ? 'would-block' : 'error', message: e.message };
      // A dry run answers a question; it never changes the answer.
      if (!dryRun) {
        const t = appendLog(setStatus(fs.readFileSync(ctx.actionPath, 'utf8'), 'error'), `submit failed: ${e.message}`);
        store.writeAtomic(ctx.actionPath, t);
      }
    }
    // Parse warnings were previously visible only to `prt validate`, so a note
    // the parser could see but not collect — one inside an inert block, or in a
    // block whose kind was mistyped — was reported nowhere while the review
    // posted anyway. On the path where bytes leave the machine, say them.
    const warnings = parseActionFile(fs.readFileSync(ctx.actionPath, 'utf8')).warnings;
    results.push({ number: n, ...res, warnings });
    if (!JSON_OUT) {
      say(`#${n} → ${res.status ?? 'error'}`);
      say(String(res.message).split('\n').map((l) => `    ${l}`).join('\n'));
      for (const w of warnings) say(`    warning: ${w}`);
    }
  }
  writeBoard(base);
  emit({ submitted: results });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
};

function readyNumbers(base) {
  return store.listTracked(base.root, base.repo).filter((n) => {
    const t = store.readActionFile(base.root, base.repo, n);
    return t && ['ready', 'queued', 'partial'].includes(parseStatus(t));
  });
}

COMMANDS.recover = async () => {
  const base = await context();
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt recover <PR number>'));
  const ctx = prCtx(base, n);
  const open = findOpenTx(ctx.prPath);
  if (!open) { say(`#${n}: no interrupted transaction`); emit({ number: n, recovered: false }); return; }
  say(`#${n}: resuming transaction ${open.tx.txId} (state ${open.tx.state})`);
  const res = await submitReady(ctx);
  emit({ number: n, ...res });
  say(String(res.message));
};

/**
 * The watcher. Deliberately a poll over the tracking tree rather than fs
 * events: editors save through temp-file replacement, events get coalesced,
 * and a missed event here means a review silently never posts.
 */
COMMANDS.watch = async () => {
  const base = await context();
  const interval = Number(argv.flags.interval ?? base.cfg.watchIntervalSeconds) * 1000;
  const quiesce = Number(argv.flags.quiesce ?? base.cfg.quiesceSeconds) * 1000;
  const once = !!argv.flags.once;
  const repos = argv.flags['all-repos'] ? store.listRepos(base.root) : [base.repo];

  const seen = new Map();     // "repo#n" -> {mtime, at} when first seen ready
  const failures = new Map(); // "repo#n" -> {count, until} exponential backoff
  let running = true;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { running = false; console.log(`[prt] watch stopping (${sig})`); });
  }

  console.log(`[prt] watching ${repos.join(', ')} every ${interval / 1000}s — set "Status: ready" on line 1 to post`);
  while (running) {
    for (const repo of repos) {
      // Each repo carries its own repo.json overrides; applying the cwd repo's
      // settings to all of them would silently change behaviour per repo.
      const rcfg = store.repoConfig(store.loadConfig(base.root), repo);
      const rbase = { ...base, repo, cfg: { ...rcfg, reviewer: base.login } };
      for (const n of store.listTracked(base.root, repo)) {
        const file = store.actionFilePath(base.root, repo, n);
        if (!fs.existsSync(file)) continue;
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const status = parseStatus(text);
        const key = `${repo}#${n}`;
        if (!['ready', 'queued', 'partial'].includes(status)) { seen.delete(key); continue; }

        // cleanup (or anything else) can rename this directory out from under
        // the poll. A watcher that dies here stops posting approved reviews
        // silently — the exact failure polling was chosen to avoid.
        let mtime;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          seen.delete(key);
          continue;
        }
        const backoff = failures.get(key);
        if (backoff && Date.now() < backoff.until) continue;
        const first = seen.get(key);
        if (first === undefined || first.mtime !== mtime) {
          seen.set(key, { mtime, at: Date.now() });
          continue; // wait for the file to settle
        }
        if (Date.now() - first.at < quiesce) continue;

        console.log(`[prt] ${key} is ${status} — submitting`);
        let failed = false;
        try {
          const res = await submitReady(prCtx(rbase, n));
          const icon = res.ok ? '✅' : res.status === 'blocked' ? '⛔' : '⚠️';
          console.log(`${icon} [prt] ${key} → ${res.status}: ${String(res.message).split('\n')[0]}`);
          for (const u of res.urls ?? []) console.log(`[prt] ${key} posted ${u}`);
          failed = !res.ok && res.status !== 'blocked';
        } catch (e) {
          console.log(`⚠️ [prt] ${key} submit threw: ${e.message}`);
          failed = true;
        }
        if (failed) {
          // Without backoff a PR that cannot succeed (outage, wedged state) is
          // retried every tick forever, burning preflight calls and drowning
          // the chat in identical lines.
          const n2 = (failures.get(key)?.count ?? 0) + 1;
          const waitMs = Math.min(30 * 60_000, interval * 2 ** n2);
          failures.set(key, { count: n2, until: Date.now() + waitMs });
          console.log(`[prt] ${key} failed ${n2}x — next attempt in ${Math.round(waitMs / 1000)}s`);
        } else {
          failures.delete(key);
        }
        seen.delete(key);
        try { writeBoard(rbase); } catch { /* a board write must never kill the watch */ }
      }
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, interval));
  }
};

COMMANDS.cleanup = async () => {
  const base = await context();
  const dryRun = !!argv.flags['dry-run'];
  const purge = argv.flags.purge || base.cfg.cleanupMode === 'purge';
  const numbers = store.listTracked(base.root, base.repo);
  if (!numbers.length) { say('nothing tracked'); emit({ removed: [] }); return; }

  // Refresh state cheaply first so the decision uses live data.
  const details = await fetchPrsBatch(base.repo, numbers, { detail: false });
  const removed = [];
  const kept = [];
  for (const n of numbers) {
    const pr = details.get(n);
    const st = store.readState(base.root, base.repo, n);
    const prState = pr?.state ?? st?.state;
    const isClosed = prState && prState !== 'OPEN';
    const text = store.readActionFile(base.root, base.repo, n);
    const status = text ? parseStatus(text) : null;

    if (!isClosed) { kept.push(n); continue; }
    const blocker = archiveBlocker(status);
    if (blocker) {
      kept.push(n);
      say(`#${n} is ${prState} but its action file is "${status}" — ${blocker}. Run \`prt recover ${n}\`, or \`prt status ${n} skip\` to let cleanup take it.`);
      continue;
    }
    const dir = store.prDir(base.root, base.repo, n);
    const dest = store.archiveDir(base.root, base.repo, n);
    removed.push({ number: n, state: prState, from: dir, to: purge ? null : dest });
    if (dryRun) continue;
    if (purge) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(dir, dest);
      fs.writeFileSync(path.join(dest, store.ARCHIVE_MARKER), `${prState} · archived ${new Date().toISOString()}\n`);
    }
  }
  if (!dryRun) writeBoard(base);
  emit({ removed, kept: kept.length, mode: purge ? 'purge' : 'archive', dryRun });
  if (!JSON_OUT) {
    say(`${dryRun ? '[dry run] ' : ''}${purge ? 'deleted' : 'archived'} ${removed.length} closed/merged PR(s); ${kept.length} still tracked`);
    for (const r of removed) say(`  #${r.number} ${r.state}`);
  }
};

/**
 * Why a review may not be moved out of the live tree, or null if it may.
 *
 * `cleanup` and `archive` ask this for opposite reasons — one on GitHub's
 * authority that the PR is dead, the other because I said so — but the thing
 * being protected is the same, so the rule lives in one place. `ready` is a
 * human signature that has not been posted yet; filing it away would throw that
 * approval out silently. An in-flight status means a submit transaction is open,
 * and moving the directory under it loses the record needed to reconcile.
 */
function archiveBlocker(status) {
  if (IN_FLIGHT_STATUSES.has(status)) return 'a transaction is still open';
  if (status === 'ready') return 'you approved it but it was never posted';
  return null;
}

/**
 * Set a review aside without finishing it.
 *
 * `cleanup` archives what GitHub has settled; this archives what I have.
 * "I am not going to review this one" needs somewhere for the directory to go
 * that is neither the live tree nor the bin, and `_archive` is already exactly
 * that place — the one part of the store nothing else reads. `latest` is taught
 * to consult it, so an ignored PR does not get ranked back onto the board
 * tomorrow, which is the whole point of ignoring it.
 *
 * Reversible on purpose: `prt unarchive <N>` puts it back, still holding
 * whatever draft, notes and cache it had when it left.
 */
COMMANDS.archive = async () => {
  const base = await context();
  const numbers = argv._.slice(1).map(assertSafeNumber);
  if (!numbers.length || argv.flags.list) return reportArchive(base);

  const reason = typeof argv.flags.reason === 'string' ? argv.flags.reason : null;
  const archived = [];
  const refused = [];
  for (const n of numbers) {
    const dir = store.prDir(base.root, base.repo, n);
    if (!fs.existsSync(dir)) {
      const why = fs.existsSync(store.archiveDir(base.root, base.repo, n))
        ? 'already archived'
        : 'not tracked';
      refused.push({ number: n, why });
      say(`#${n}: ${why}`);
      continue;
    }
    const text = store.readActionFile(base.root, base.repo, n);
    const status = text ? parseStatus(text) : null;
    const blocker = archiveBlocker(status);
    if (blocker) {
      refused.push({ number: n, why: blocker, status });
      say(`#${n} is "${status}" — ${blocker}. Run \`prt recover ${n}\`, or \`prt status ${n} hold\` and archive it then.`);
      continue;
    }

    // Read the state before the move: a corrupt pr.json must not leave the
    // directory relocated but unmarked.
    let st = null;
    try {
      st = store.readState(base.root, base.repo, n);
    } catch { /* the marker just says "unknown" then */ }

    const dest = store.archiveDir(base.root, base.repo, n);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(dir, dest);
    fs.writeFileSync(
      path.join(dest, store.ARCHIVE_MARKER),
      `${st?.state ?? 'unknown'} · archived ${new Date().toISOString()} · by hand${reason ? ` · ${reason}` : ''}\n`,
    );
    archived.push({ number: n, status: status ?? 'none', to: dest });
  }

  if (archived.length) writeBoard(base);
  emit({ archived, refused });
  if (!JSON_OUT && archived.length) {
    say(`archived ${archived.length} PR(s); \`prt unarchive <N>\` brings one back`);
    for (const a of archived) say(`  #${a.number} (${a.status})`);
  }
  // Anything refused is a non-zero exit even when the rest went: a caller that
  // asked for four and got three should not read that as success.
  if (refused.length) process.exitCode = 1;
};

/** Put an archived PR back in the live tree, draft and cache intact. */
COMMANDS.unarchive = async () => {
  const base = await context();
  const numbers = argv._.slice(1).map(assertSafeNumber);
  if (!numbers.length) {
    reportArchive(base);
    die('usage: prt unarchive <PR number>...');
  }

  const restored = [];
  const refused = [];
  for (const n of numbers) {
    const src = store.archiveDir(base.root, base.repo, n);
    const dest = store.prDir(base.root, base.repo, n);
    if (!fs.existsSync(src)) {
      refused.push({ number: n, why: 'not in the archive' });
      say(`#${n} is not in the archive`);
      continue;
    }
    // Never merge two histories: if the PR was tracked again after being
    // archived, the live copy is the newer one and only the human can choose.
    if (fs.existsSync(dest)) {
      refused.push({ number: n, why: 'tracked again already' });
      say(`#${n} is tracked again already — remove ${dest} first if the archived copy is the one you want`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    fs.rmSync(path.join(dest, store.ARCHIVE_MARKER), { force: true });
    restored.push({ number: n, to: dest });
  }

  if (restored.length) writeBoard(base);
  emit({ restored, refused });
  if (!JSON_OUT && restored.length) {
    say(`restored ${restored.length} PR(s) — their GitHub state is as stale as the day they were archived:`);
    say(`  prt refresh ${restored.map((r) => r.number).join(' ')}`);
  }
  if (refused.length) process.exitCode = 1;
};

/** What is in the archive, so that bringing something back is possible. */
function reportArchive(base) {
  const rows = store.listArchived(base.root, base.repo).map((n) => {
    const dir = store.archiveDir(base.root, base.repo, n);
    // One unreadable archived PR must not hide the rest of the list.
    let st = null;
    try {
      st = store.readStateFrom(dir);
    } catch { /* listed by number alone */ }
    let marker = null;
    try {
      marker = fs.readFileSync(path.join(dir, store.ARCHIVE_MARKER), 'utf8').trim();
    } catch { /* archived by an older version, or by hand */ }
    return { number: n, title: st?.title ?? null, state: st?.state ?? null, url: st?.url ?? null, marker };
  });
  emit({ repo: base.repo, archived: rows });
  if (JSON_OUT) return;
  if (!rows.length) { say(`nothing archived for ${base.repo}`); return; }
  say(`${rows.length} archived PR(s) in ${base.repo} — \`prt unarchive <N>\` brings one back:\n`);
  for (const r of rows) {
    say(`  #${r.number}  ${r.title ?? ''}`);
    if (r.marker) say(`      ${r.marker}`);
  }
}

// ------------------------------------------------------------------- dispatch

// Aliases for the names the skill and the user actually say out loud.
const ALIASES = {
  'show-latest': 'latest',
  next: 'latest',
  queue: 'list',
  scan: 'sync',
  post: 'submit',
  ignore: 'archive',
  restore: 'unarchive',
};

const handler = COMMANDS[CMD] ?? COMMANDS[ALIASES[CMD]];
if (!handler) {
  COMMANDS.help();
  process.exit(CMD === 'help' ? 0 : 2);
}
try {
  await handler();
} catch (e) {
  if (e instanceof GhError) die(e.message);
  if (process.env.PRT_DEBUG) console.error(e);
  die(e.message ?? String(e));
}
