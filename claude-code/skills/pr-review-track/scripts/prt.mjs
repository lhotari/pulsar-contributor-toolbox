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
  fetchPr, fetchPrsBatch, searchEngagedPrs, recentOpenPrs, prDiff, compareDiff,
} from './lib/github.mjs';
import { analyzePr, fetchDelta, summarizeCounts, THREAD_STATES } from './lib/analyze.mjs';
import { rankCandidates, scoreTracked } from './lib/rank.mjs';
import { renderActionFile, renderNudgeFile, bucketOf, BUCKETS } from './lib/render.mjs';
import { parseDiff, commentableAnchors, validateAnchor } from './lib/diff.mjs';
import {
  parseActionFile, parseStatus, setStatus, contentHash, appendLog, planActions,
  PROTECTED_STATUSES, IN_FLIGHT_STATUSES, STATUSES,
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

  Per PR
    track <N>...                           start tracking, fetch the baseline
    refresh <N>...                         re-fetch GitHub state for tracked PRs
    context <N>                            full analysis as JSON (input for the model)
    diff <N> [--since <sha>]               the diff, or the diff since my last review
    anchors <N>                            commentable (path,line,side) positions
    draft <N> [--findings f.json] [--kind initial|re-review]
                                           write review.md (never over a protected file)
    open <N>...                            open review.md in the configured editor
    nudge [<N>...] [--limit 10]            draft reminders for unanswered feedback

  Posting  (the only commands that write to GitHub)
    validate <N>...                        parse + preflight without posting
    submit <N>... | --all-ready            post files whose line 1 says "ready"
    watch [--interval S] [--once]          poll for "ready" files and post them
    recover <N>                            reconcile an interrupted transaction

  Housekeeping
    cleanup [--purge] [--dry-run]          archive tracking for closed/merged PRs
    status <N> [<status>]                  read or set line 1
    doctor                                 environment + rate-limit check

  Aliases
    show-latest = latest    queue = list    scan = sync    post = submit    archive = cleanup

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
  const reviewRequested = new Set(
    [...engaged.entries()].filter(([, why]) => why.has('review-requested')).map(([n]) => n),
  );

  const eligible = candidates.filter((pr) => {
    if (pr.author?.login === base.login) return false;
    if (base.cfg.ignoreAuthors.includes(pr.author?.login)) return false;
    if (tracked.has(pr.number)) return false;
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
    if (pr.state !== 'OPEN') closed.push(number);
    else if (wasTracked) updated.push(number);
    else added.push(number);
  }

  writeBoard(base);
  emit({ repo: base.repo, added, updated, closed, engaged: remote.size, tracked: all.length });
  if (!JSON_OUT) {
    say(`  added   ${added.length}${added.length ? `: ${added.slice(0, 15).join(', ')}${added.length > 15 ? '…' : ''}` : ''}`);
    say(`  updated ${updated.length}`);
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
    rows.push({ number: n, headMoved: analysis.headMoved, threads: analysis.threadCounts });
  }
  writeBoard(base);
  emit({ refreshed: rows });
  if (!JSON_OUT) for (const r of rows) say(`#${r.number}  ${r.headMoved ? 'head moved' : 'head unchanged'}  ·  ${summarizeCounts(r.threads)}`);
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
    draft: { path: target, generatedAt: new Date().toISOString(), contentHash: contentHash(text) },
  });
  writeBoard(base);
  emit({ number: n, file: target, generation });
  say(`drafted ${target}`);
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
    if (store.readActionFile(base.root, base.repo, n)) store.archiveActionFile(base.root, base.repo, n);
    const text = renderNudgeFile({ repo: base.repo, analysis, generation, reviewerLogin: base.login });
    store.ensurePrDir(base.root, base.repo, n);
    store.writeAtomic(store.actionFilePath(base.root, base.repo, n), text);
    store.writeState(base.root, base.repo, n, {
      ...(prev ?? {}), schema: 1, repo: base.repo, number: n,
      title: analysis.title, url: analysis.url, author: analysis.author,
      authorAssociation: analysis.authorAssociation, state: analysis.state,
      isDraft: analysis.isDraft, headOid: analysis.headOid, baseRefName: analysis.baseRefName,
      updatedAt: analysis.updatedAt, lastSyncAt: new Date().toISOString(), analysis,
      tracking: { ...(prev?.tracking ?? { addedAt: new Date().toISOString(), addedBy: 'nudge' }), generation },
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
      bucket: st.analysis ? bucketOf({ analysis, status }) : 'unknown',
      threads: st.analysis ? summarizeCounts(analysis.threadCounts) : '',
      ci: analysis.ci,
      updatedAt: st.updatedAt,
      urgency: st.analysis ? scoreTracked(analysis, { priorityAuthors: base.cfg.priorityAuthors }).score : 0,
    });
  }
  rows.sort((a, b) => b.urgency - a.urgency);

  const out = [`# ${base.repo} — review board`, '', `_Generated ${new Date().toISOString()} · ${rows.length} tracked PR(s). Do not edit; \`prt sync\` rewrites this file._`, ''];
  for (const bucket of BUCKETS) {
    const inBucket = rows.filter((r) => r.bucket === bucket);
    if (!inBucket.length) continue;
    out.push(`## ${bucket} (${inBucket.length})`, '');
    out.push('| PR | status | author | threads | CI | title |');
    out.push('|---|---|---|---|---|---|');
    for (const r of inBucket) {
      out.push(`| [#${r.number}](${r.url}) | \`${r.status}\` | ${r.author ?? '?'} | ${r.threads} | ${r.ci ?? '?'} | ${String(r.title).replace(/\|/g, '\\|').slice(0, 80)} |`);
    }
    out.push('');
  }
  const closed = rows.filter((r) => r.prState && r.prState !== 'OPEN');
  if (closed.length) {
    out.push(`## closed or merged — run \`prt cleanup\` (${closed.length})`, '');
    for (const r of closed) out.push(`- [#${r.number}](${r.url}) ${r.prState} — ${r.title}`);
    out.push('');
  }
  const file = path.join(store.repoDir(base.root, base.repo), 'BOARD.md');
  store.writeAtomic(file, out.join('\n'));
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
  const text = setStatus(fs.readFileSync(file, 'utf8'), next);
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
    results.push({ number: n, ...res });
    if (!JSON_OUT) {
      say(`#${n} → ${res.status ?? 'error'}`);
      say(String(res.message).split('\n').map((l) => `    ${l}`).join('\n'));
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
    if (IN_FLIGHT_STATUSES.has(status) || status === 'ready') {
      // `ready` is a human signature that never got posted. Archiving it would
      // throw that approval away silently.
      kept.push(n);
      const why = status === 'ready'
        ? 'you approved it but it was never posted'
        : 'a transaction is still open';
      say(`#${n} is ${prState} but its action file is "${status}" — ${why}. Run \`prt recover ${n}\`, or \`prt status ${n} skip\` to let cleanup take it.`);
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
      fs.writeFileSync(path.join(dest, 'ARCHIVED.txt'), `${prState} · archived ${new Date().toISOString()}\n`);
    }
  }
  if (!dryRun) writeBoard(base);
  emit({ removed, kept: kept.length, mode: purge ? 'purge' : 'archive', dryRun });
  if (!JSON_OUT) {
    say(`${dryRun ? '[dry run] ' : ''}${purge ? 'deleted' : 'archived'} ${removed.length} closed/merged PR(s); ${kept.length} still tracked`);
    for (const r of removed) say(`  #${r.number} ${r.state}`);
  }
};

// ------------------------------------------------------------------- dispatch

// Aliases for the names the skill and the user actually say out loud.
const ALIASES = {
  'show-latest': 'latest',
  next: 'latest',
  queue: 'list',
  scan: 'sync',
  post: 'submit',
  archive: 'cleanup',
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
