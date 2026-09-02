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
  pendingReviews, reviewComments, repoTree,
} from './lib/github.mjs';
import { analyzePr, fetchDelta, summarizeCounts, THREAD_STATES } from './lib/analyze.mjs';
import { rankCandidates, scoreTracked } from './lib/rank.mjs';
import {
  renderActionFile, renderNudgeFile, renderBoard, bucketOf, inlineIdFor, expectedBlockIds,
  disarmStagedDuplicates,
} from './lib/render.mjs';
import { parseDiff, commentableAnchors, validateAnchor } from './lib/diff.mjs';
import { blobUrl, codeLink, parseLocation, isSha, linkifyCode, pathIndex, auditPermalinks } from './lib/links.mjs';
import {
  parseActionFile, parseStatus, setStatus, contentHash, appendLog, planActions,
  PROTECTED_STATUSES, IN_FLIGHT_STATUSES, STATUSES,
  carryAsks, collectAsks, maxAskOrdinal, promoteShorthand, askState, ensurePrActions,
  relocateResolvedAsks, unpromotedNotes, notesLostByRegenerating,
} from './lib/actionfile.mjs';

/** Statuses only the submitter may write. */
const MACHINE_ONLY_STATUSES = new Set(['queued', 'submitting', 'submitted', 'partial', 'blocked', 'error', 'superseded']);
import {
  newJob, planNext, orderQueue, finishedJob, failedJob, JOB_KINDS, mintToken,
} from './lib/jobs.mjs';
import { submitReady, diffFingerprint, findOpenTx, contentRefusals, carryDocHatches } from './lib/submit.mjs';
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
    permalink <N> <path>:<lines>... [--sha S] [--markdown]
                                           blob permalinks at the tracked head, for a review to link
    draft <N> [--findings f.json] [--kind initial|re-review]
                                           write review.md (carries notes; never over a protected file)
    ask [<N>...] [--promote] [--tidy]      read notes, promote @ai shorthand, file answered ones
    job add|list|next|done|fail|cancel|release   the background review queue
    open <N>...                            open review.md in the configured editor
    nudge [<N>...] [--limit 10]            draft reminders for unanswered feedback

  Posting  (the only commands that write to GitHub)
    validate <N>...                        parse + lint (fetches the diff to check anchors)
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
    const q = queueLine(base);
    if (q) say(`  ${q}`);
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
 * The unsubmitted review an `event: REPLY` pass left on GitHub, with its
 * comments as they stand NOW — which is not what this store last wrote. Staging
 * hands the text over: the human edits those comments in GitHub's UI, so the
 * copy on GitHub is the authoritative one and the round that follows has to
 * read it rather than draft over it.
 *
 * Returns null, and forgets the record, when the review is no longer pending —
 * submitted or discarded by hand. That is a normal end to a staged review, not
 * an error, and leaving the record behind would make every later round quote a
 * review that no longer exists.
 */
async function readStagedReview(base, n, prev) {
  const rec = prev?.staged;
  if (!rec?.reviewDatabaseId) return null;
  const live = (await pendingReviews(base.repo, n)).find((p) => String(p.id) === String(rec.reviewDatabaseId));
  if (!live) {
    if (prev) store.writeState(base.root, base.repo, n, { ...prev, staged: null });
    return null;
  }
  const comments = await reviewComments(base.repo, n, rec.reviewDatabaseId);
  return {
    reviewDatabaseId: String(live.id),
    url: live.html_url ?? rec.url ?? null,
    at: rec.at ?? null,
    comments: comments.map((c) => ({
      id: String(c.id),
      path: c.path,
      // `line` is null on a file-level comment and on one GitHub has outdated;
      // `original_line` is the number the comment was written against.
      line: c.line ?? c.original_line ?? null,
      side: c.side ?? 'RIGHT',
      inReplyToId: c.in_reply_to_id ? String(c.in_reply_to_id) : null,
      body: c.body ?? '',
      url: c.html_url ?? null,
    })),
  };
}

/**
 * Every prose field of a findings document that can carry a code reference,
 * paired with the file a path-less `:749-755` inside it means.
 *
 * That pairing is the whole reason this is a list rather than a walk: `:749-755`
 * in a finding's body means the file the finding is anchored to, the same words
 * in a thread reply mean the file that thread is on, and in the review summary
 * they mean nothing at all. A `LEFT`-side anchor counts lines in the base, so it
 * contributes no self path either: a head permalink there would quote lines the
 * comment is not about.
 */
function proseFields(findings, analysis) {
  const threads = new Map((analysis?.threads ?? []).map((t) => [t.id, t]));
  const selfOf = (anchor) => {
    if (!anchor?.path) return null;
    return (anchor.side ?? 'RIGHT') === 'LEFT' || anchor.isOutdated ? null : anchor.path;
  };
  const out = [];
  const add = (obj, key, selfPath = null) => {
    if (obj && typeof obj[key] === 'string' && obj[key]) out.push({ obj, key, selfPath });
  };
  add(findings, 'summary');
  for (const f of findings?.findings ?? []) {
    add(f, 'claim', selfOf(f));
    add(f, 'body', selfOf(f));
  }
  for (const d of findings?.dropped ?? []) add(d, 'reason');
  for (const t of findings?.threadAssessments ?? []) {
    const self = selfOf(threads.get(t.threadId));
    add(t, 'why', self);
    add(t, 'reply', self);
    (t.evidence ?? []).forEach((_, i) => add(t.evidence, i, self));
  }
  for (const c of findings?.issueCommentAssessments ?? []) {
    add(c, 'why');
    add(c, 'reply');
  }
  return out;
}

/** The repo's file list at `sha`, cached per commit so a round costs one request at most. */
async function repoPaths(base, n, sha) {
  const file = store.cacheFile(base.root, base.repo, n, 'tree.json');
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.sha === sha && Array.isArray(cached.paths)) return cached.paths;
  } catch { /* no usable cache */ }
  try {
    const tree = await repoTree(base.repo, sha);
    store.ensurePrDir(base.root, base.repo, n);
    store.writeAtomic(file, `${JSON.stringify({ sha, ...tree })}\n`);
    return tree.paths;
  } catch {
    // A tree we cannot read leaves references unlinked, which is the state they
    // were already in. It is not a reason to fail a draft.
    return [];
  }
}

/** `7ac6b40b` — a commit as it reads in a sentence. */
function shortSha(sha) {
  return String(sha ?? '').slice(0, 8);
}

/**
 * The commit every permalink in this draft is built against.
 *
 * Not the head fetched a moment ago — the head the review **read**. Those are
 * the same commit almost always and a different one exactly when it matters: a
 * review takes minutes, an author can push inside them, and `fetchPr` a minute
 * later happily returns the commit nobody reviewed. Every line number in a
 * findings document is a line of the tree the reviewers had open. Stamping a
 * newer commit on those numbers produces links that resolve, render, and quote
 * the wrong code — the failure with no symptom, because a permalink to the
 * wrong commit looks exactly like a permalink to the right one.
 *
 * So `findings.head` is not decoration: it is the reviewer stating which tree
 * those numbers came from, and this refuses to draft rather than guess when it
 * is missing or when the branch has moved out from under it. An abbreviation is
 * accepted and widened to the full oid — `prt context` prints the whole thing,
 * but a human writing the file by hand types eight characters.
 *
 * With no findings there is nothing to link and nothing to check: the draft is
 * about the PR as GitHub has it now, which is the head.
 */
function reviewedHead(findings, pr, number) {
  const head = String(pr.headRefOid ?? '').toLowerCase();
  if (!findings) return head;
  const declared = String(findings.head ?? '').trim().toLowerCase();
  if (!declared) {
    die(`the findings for #${number} do not say which commit they were read at.\n`
      + 'Add `"head": "<sha>"` — the commit the review had checked out (`prt context '
      + `${number}\` reports it as \`analysis.headOid\`). Without it every line number in the file `
      + 'is a number with no tree behind it, and the permalinks built from them would be a guess.');
  }
  if (!isSha(declared)) {
    die(`the findings for #${number} give \`head: "${findings.head}"\`, which is not a commit.\n`
      + 'A branch or tag name cannot anchor a review: the lines behind it drift, and the links start '
      + 'quoting code the review never read.');
  }
  if (!head.startsWith(declared)) {
    die(`#${number} is at ${shortSha(head)}, but these findings were read at ${shortSha(declared)} — `
      + 'the branch moved while the review was running.\n'
      + `Every line number in the file is a line of ${shortSha(declared)}, so drafting now would anchor `
      + 'the comments and point the permalinks at code nobody looked at.\n'
      + `Re-review against the new head — \`pr-review ${number} --since ${shortSha(declared)}\` covers only `
      + 'what the author pushed — and draft from those findings instead.');
  }
  return head;
}

/**
 * The permalinks the review wrote itself, checked against the commit it read.
 *
 * `linkifyFindings` below cannot get this wrong; a URL that arrived in the
 * findings already written can. A branch link is refused outright — it is wrong
 * for everyone who ever reads the comment, including the author reading it
 * today. Another commit is only reported: a reply that deliberately links how
 * the code stood two rounds ago is doing something legitimate, and only the
 * human can tell that apart from a stale `prt permalink`.
 */
function auditWrittenLinks(findings, analysis, repo, sha) {
  const seen = new Set();
  const out = { refs: [], commits: [] };
  for (const f of proseFields(findings, analysis)) {
    const audit = auditPermalinks(f.obj[f.key], { repo, sha });
    for (const kind of ['refs', 'commits']) {
      for (const link of audit[kind]) {
        // The same URL twice — a finding and the summary both citing it — is one
        // thing to check, not two.
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        out[kind].push(link);
      }
    }
  }
  return out;
}

/**
 * Turn the code references the reviewer wrote in prose into permalinks, in
 * place, before any of it reaches the file.
 *
 * `sha` is `reviewedHead`'s answer — the commit the review read, which is the
 * only commit these line numbers mean anything at. It is also what the repo tree
 * is fetched at, so a name is resolved against the files that existed then.
 *
 * The PR's own files answer nearly every reference and cost nothing — they are
 * already parsed out of the diff. Only when something is left over is the repo
 * tree fetched, which is what makes a reference to a caller or a test the PR
 * does not touch linkable without paying a request per round for it. The second
 * pass rewrites the ORIGINAL text rather than the once-linked text, so a name
 * the tree resolves cannot land inside a link the first pass already made.
 */
async function linkifyFindings(base, n, { findings, analysis, sha, diffPaths }) {
  const fields = proseFields(findings, analysis);
  if (!fields.length || !isSha(sha)) return { links: 0, unresolved: [], fetchedTree: false };
  const originals = fields.map((f) => f.obj[f.key]);
  const index = pathIndex(diffPaths);
  const pass = () => {
    let links = 0;
    const unresolved = new Set();
    fields.forEach((f, i) => {
      const r = linkifyCode(originals[i], { repo: base.repo, sha, resolve: index.resolve, selfPath: f.selfPath });
      links += r.links;
      for (const u of r.unresolved) unresolved.add(u);
      f.obj[f.key] = r.text;
    });
    return { links, unresolved: [...unresolved] };
  };
  let res = pass();
  let fetchedTree = false;
  if (res.unresolved.length) {
    const paths = await repoPaths(base, n, sha);
    if (paths.length) {
      fetchedTree = true;
      index.add(paths);
      res = pass();
    }
  }
  return { ...res, fetchedTree };
}

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
    // Comments already staged in an unsubmitted review. They are on GitHub, the
    // human may have rewritten them there, and raising any of them again would
    // put a second copy in the same review — so they are context to read, never
    // findings to repeat.
    staged: await readStagedReview(base, n, store.readState(base.root, base.repo, n)),
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

COMMANDS.permalink = async () => {
  // Offline on purpose: everything it needs is the tracked head SHA, and a
  // command a worker calls once per code reference must not cost a request per
  // link. It also skips `context()`, whose reviewer lookup this has no use for.
  const root = argv.flags.root || store.DEFAULT_ROOT;
  const repo = await resolveRepo(argv.flags.repo);
  const n = assertSafeNumber(argv._[1] ?? die('usage: prt permalink <PR number> <path>:<line>[-<line>]...'));
  const specs = argv._.slice(2);
  if (!specs.length) die('usage: prt permalink <PR number> <path>:<line>[-<line>]...  (repo-relative paths; `prt anchors` lists them)');

  const state = store.readState(root, repo, n);
  // `--sha reviewed` is the code as it stood when I last reviewed — the version
  // an author's "I fixed that" is being compared against.
  const asked = argv.flags.sha === true ? null : argv.flags.sha;
  const named = { head: state?.headOid ?? state?.analysis?.headOid, reviewed: state?.analysis?.myLastReview?.oid };
  // A name the store knows but has no commit for must say so. Falling through
  // to "not a commit SHA" would send the reader looking at their spelling
  // instead of at the PR nobody has reviewed yet.
  if (asked && asked in named && !named[asked]) {
    die(`no ${asked} commit recorded for ${repo}#${n} — run \`prt refresh ${n}\`, or pass the SHA itself`);
  }
  const sha = asked ? (named[asked] ?? asked) : named.head;
  if (!sha) die(`no head SHA for ${repo}#${n} — run \`prt track ${n}\` first, or pass --sha <commit>`);
  if (!isSha(sha)) die(`--sha needs a commit, not "${sha}" — a branch link renders whatever that branch says later`);

  // The repo's own file list at that commit, when a draft has already fetched it
  // for this head. It turns the one mistake this command cannot otherwise catch
  // — a path read out of some other tree, a rename, a file that only exists on
  // master — into a refusal here rather than a link that 404s in a posted
  // comment. Only when the cache is for this exact commit and GitHub did not
  // truncate it: absence has to mean absence before it can mean anything.
  let treePaths = null;
  try {
    const cached = JSON.parse(fs.readFileSync(store.cacheFile(root, repo, n, 'tree.json'), 'utf8'));
    if (cached.sha === sha && !cached.truncated && Array.isArray(cached.paths)) treePaths = new Set(cached.paths);
  } catch { /* no usable tree for this commit; the check simply does not run */ }

  const links = [];
  for (const spec of specs) {
    let loc;
    try { loc = parseLocation(spec); } catch (e) { die(e.message); }
    if (!loc.path.includes('/')) {
      die(`give the repo-relative path, not just "${loc.path}" — \`prt anchors ${n}\` lists every path in this PR`);
    }
    if (treePaths && !treePaths.has(loc.path)) {
      die(`${repo} has no ${loc.path} at ${sha.slice(0, 8)}.\nEither the path is wrong (\`prt anchors ${n}\` lists every file in this PR) or the commit is — a line number read from one tree does not belong to another.`);
    }
    let url;
    try { url = blobUrl(repo, sha, loc.path, loc); } catch (e) { die(e.message); }
    links.push({ ...loc, sha, url, markdown: codeLink(repo, sha, loc.path, { ...loc, full: false }) });
  }

  emit({ repo, number: n, sha, links });
  // One URL per line and nothing else: that is the form GitHub expands, so it
  // is paste-ready into a blank line of a comment. `--markdown` gives the inline
  // form instead, for prose, lists and tables, where nothing expands.
  if (!JSON_OUT) for (const l of links) say(argv.flags.markdown || argv.flags.md ? l.markdown : l.url);
};

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

  // What an earlier `event: REPLY` pass already put on GitHub. Read before the
  // state below, because a review that is no longer pending is forgotten here
  // and `prev` must see the document that leaves.
  const staged = await readStagedReview(base, n, store.readState(base.root, base.repo, n));

  const reStaged = disarmStagedDuplicates(findings, staged);

  // Which commit this draft is entitled to link. Everything below — the links
  // the generator makes, the links the review made for itself, and the `head:`
  // the submitter re-checks — is that one commit or the draft does not happen.
  const reviewedAt = reviewedHead(findings, pr, n);

  // Links that arrived already written. Checked before anything is generated:
  // a branch link is wrong for every reader of the comment, and a draft is
  // cheaper to refuse than a posted comment is to take back.
  const written = auditWrittenLinks(findings, analysis, base.repo, reviewedAt);
  if (written.refs.length) {
    die(`refusing to draft #${n}: ${written.refs.length} permalink(s) in the findings name a branch or a tag `
      + 'rather than a commit, so they will quote whatever that ref says on the day somebody reads the comment:\n  '
      + written.refs.map((l) => l.url).join('\n  ')
      + `\nRebuild them at ${shortSha(reviewedAt)} — \`prt permalink ${n} <path>:<line>\` does it — or just name `
      + 'the location in prose and let the draft link it.');
  }

  // A review that says `Consumer.java:1015` sends the reader off to find it; the
  // rule is in SKILL.md and a model follows it about as often as it writes the
  // reference. So the generator links them itself, on the way into the file,
  // where the human sees every link before arming anything — never at submit
  // time, where a body is posted byte for byte.
  const linked = await linkifyFindings(base, n, {
    findings, analysis, sha: reviewedAt, diffPaths: [...parseDiff(fullDiff).keys()],
  });

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
    const { text: promotedText, promoted, refused } = promoteShorthand(existing, { startOrdinal: floor + 1, generation });
    // A note that is still an `@ai` line after promotion is one regeneration
    // from being gone: `carryAsks` carries `prt:ask` blocks and nothing else, so
    // the words would move to history/ and out of the working copy without a
    // word. Same refusal, same escape hatch as an unreadable note.
    //
    // The gate is what the SCANNER still sees, not what the lift refused. Those
    // are different sets: the lift never looks inside `prt:log` or a block's
    // header, so gating on `refused` alone missed exactly the notes nothing can
    // rescue — the ones most in need of a stop.
    const lost = notesLostByRegenerating(promotedText, refused);
    if (lost.length) {
      die(`refusing to regenerate #${n}: an \`@ai\` note in the existing review.md would not survive it:\n  ${lost.map((r) => `<!-- prt:${r.where} --> at line ${r.line}: ${r.why}`).join('\n  ')}\nFix it, or pass --no-carry to drop it (the old file is kept in history/).`);
    }
    // Thread and conversation-comment ids count too. Building this from
    // findings alone orphaned every `t*`/`c*`-bound note on every draft.
    const { ids: newIds, anchors: newAnchors } = expectedBlockIds({ analysis, findings });
    carried = { ...carryAsks(promotedText, { newIds, newAnchors, generation, ordinalFloor: floor }), promoted };
    if (carried.structuralErrors?.length) {
      die(`refusing to regenerate #${n}: the existing review.md has notes this tool cannot read safely:\n  ${carried.structuralErrors.join('\n  ')}\nFix them, or pass --no-carry to drop them (the old file is kept in history/).`);
    }
  }

  const renderOpts = {
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
    // Read, not regenerated: see `readStagedReview`.
    staged,
  };

  // The human's `*-reviewed:` acknowledgements, carried the same way their notes
  // are — and for the same reason. Without this, `security-reviewed: yes` was
  // destroyed by every regeneration and had to be re-typed against text nobody
  // had changed.
  //
  // The draft is rendered once with no hatches, so `carryDocHatches` sees what
  // this generation trips unexcused, and re-rendered with whatever survived.
  // Two renders rather than one splice: the renderer stays the only thing that
  // ever writes `prt:doc`, which is the rule that keeps a stale `head:` out of
  // it. Linting the first render answers for the second because every postable
  // body is written from `findings` and `analysis` alone — nothing outgoing is
  // clock- or filesystem-dependent, so the two renders differ only in the
  // `generated:` stamp and the lines below. Keep that true of any new block
  // whose body can post, or this decision stops being about what will post.
  //
  // `--no-carry` drops these too. It is the "start this file clean" exit, and an
  // acknowledgement is the human's decision exactly as their notes are.
  let hatches = { carried: {}, dropped: [] };
  let text = renderActionFile(renderOpts);
  if (existing && !argv.flags['no-carry']) {
    hatches = carryDocHatches(existing, text);
    if (Object.keys(hatches.carried).length) text = renderActionFile({ ...renderOpts, carriedDoc: hatches.carried });
  }

  const target = argv.flags.to
    ? path.join(ctx.prPath, String(argv.flags.to))
    : store.actionFilePath(base.root, base.repo, n);

  // A worker's permission to write is re-asked where the write happens, not
  // where the command started: everything between those two points is a network
  // round trip long, which is time enough for the human to arm the file or for
  // this attempt to be superseded. A human running `prt draft` by hand has no
  // token and is covered by the protected-status check at the top.
  const jobToken = argv.flags['job-token'];
  const writeIt = () => {
    if (jobToken && !argv.flags.to) {
      const guard = guardJobWrite(base, n, jobToken);
      if (!guard.ok) return guard.reason;
    }
    if (existing) store.archiveActionFile(base.root, base.repo, n);
    store.ensurePrDir(base.root, base.repo, n);
    store.writeAtomic(target, text);
    return null;
  };
  const refusal = jobToken ? store.withJobLock(base.root, base.repo, writeIt) : writeIt();
  if (refusal) die(refusal);

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
    // The job, if this draft was one, is now the reason not to re-run it.
    ...(jobToken && prev?.job ? { job: { ...prev.job, committedAt: new Date().toISOString() } } : {}),
  });
  writeBoard(base);
  const openAsks = carried.asks.filter((x) => x.open);
  emit({
    number: n, file: target, generation,
    asks: {
      carried: carried.asks.length, open: openAsks.length, retired: carried.retired ?? 0,
      promoted: carried.promoted, changes: carried.changes,
    },
    doc: hatches,
    staged: staged ? { url: staged.url, comments: staged.comments.length, disarmed: reStaged } : null,
    links: { ...linked, at: reviewedAt, writtenAtOtherCommits: written.commits.map((l) => l.url) },
  });
  say(`drafted ${target}`);
  if (linked.links) {
    say(`  linked ${linked.links} code reference(s) at ${shortSha(reviewedAt)}${linked.fetchedTree ? ' (repo tree consulted for names outside the diff)' : ''}`);
  }
  // Not an error — a reply may mean to link an older round — but never silent:
  // this is what a stale `prt permalink` looks like from the outside.
  for (const l of written.commits) {
    say(`  permalink at ${shortSha(l.ref)}, not ${shortSha(reviewedAt)} — check it means that commit: ${l.url}`);
  }
  if (linked.unresolved.length) {
    say(`  left as plain text, no single file matches: ${linked.unresolved.slice(0, 8).join(', ')}${linked.unresolved.length > 8 ? `, +${linked.unresolved.length - 8} more` : ''}`);
  }
  if (staged) {
    say(`  ${staged.comments.length} comment(s) are staged in an unsubmitted review on GitHub — shown as context, not redrafted`);
    for (const id of reStaged) {
      say(`  finding ${id} lands on a staged comment's anchor, so it was written \`post: false\` — enable it only if it says something different`);
    }
  }
  for (const p of carried.promoted ?? []) {
    const from = p.lifted ? `, lifted out of <!-- prt:${p.lifted} -->` : '';
    say(`  promoted @ai note → ask ${p.id} (re: ${p.re}${p.follows ? `, follows: ${p.follows}` : ''}${p.inferred ? ', inferred from position' : ''}) at line ${p.line}${from}`);
  }
  for (const c of carried.changes ?? []) {
    say(c.kind === 'rebound'
      ? `  ask ${c.id}: re-targeted ${c.from} → ${c.to}`
      : `  ask ${c.id}: its target ${c.from} is gone — if an earlier round posted that comment, check outbox/`);
  }
  if (openAsks.length) say(`  ${openAsks.length} open note(s) carried: ${openAsks.map((x) => x.id).join(', ')}`);
  // Filing was the one transition this report stayed silent about. The
  // generation that RETIRES a pair says so on the next line; the generation that
  // MOVED it to the foot of the file said nothing, so a human looking for a note
  // they had just answered had to go and find where it went.
  const filedAsks = carried.asks.filter((x) => x.open === false);
  if (filedAsks.length) {
    say(`  ${filedAsks.length} answered note(s) filed under "## Resolved notes": ${filedAsks.map((x) => x.id).join(', ')}`);
  }
  if (carried.retired) say(`  ${carried.retired} answered note(s) retired to history/`);
  // Never silent in either direction. A carried hatch is one the human is no
  // longer being asked about, and a dropped one is a submit that is about to
  // block again — both are things they would rather read here than discover.
  for (const [k, v] of Object.entries(hatches.carried)) {
    say(`  kept your \`${k}: ${v}\` — this generation still trips that lint`);
  }
  for (const d of hatches.dropped) say(`  dropped your \`${d.key}\` acknowledgement — ${d.why}`);
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
      const { text: promotedText, refused } = promoteShorthand(before, { startOrdinal: askFloor + 1, generation });
      // Same reason the reminder skips an unreadable file: a note that survives
      // promotion would be overwritten by the nudge, and a reminder can wait
      // where a retyped note cannot. Same gate as `prt draft`, and for the same
      // reason it is the scanner's answer and not the lift's.
      const lost = notesLostByRegenerating(promotedText, refused);
      if (lost.length) {
        skipped.push({ number: n, why: `its review.md has an @ai note that would not survive a rewrite: ${lost[0].why}` });
        say(`  #${n}: SKIPPED — an @ai note inside <!-- prt:${lost[0].where} --> at line ${lost[0].line} would not survive a rewrite, so the file was left alone.`);
        say(`      ${lost[0].why}`);
        continue;
      }
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
    // No `carryDocHatches` here, and that is the rule's own answer rather than
    // an omission: a reminder replaces the review's outgoing text with generated
    // boilerplate, so every acknowledgement the review carried has nothing left
    // to excuse and would be dropped by the same check `prt draft` applies.
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
 * Read the notes in an action file, promote any `@ai` shorthand into canonical
 * blocks, and file answered notes into the `## Resolved notes` log at the end.
 *
 * There is deliberately no `--addressed` flag. Closing a note requires prose
 * saying what was done, prose is judgement, and judgement is the model's half
 * of the split — a flag that closed one without a body is exactly what the
 * mandatory-answer-body rule exists to forbid.
 *
 * `--tidy` is opt-in for the same reason `--promote` is: it rewrites a file the
 * human is editing, so no command performs the move on a file nobody asked to
 * touch. Without it a pair is filed one generation later, when `prt draft` next
 * regenerates — too late to be the answer to "after resolving, move it".
 */
/**
 * The two note collections in a file, in the one shape every `prt ask` row uses.
 *
 * `notes` is the half that used to be missing: an `@ai` line the human typed and
 * never promoted is a note, and listing notes is what this command is for.
 * Reading only `prt:ask` blocks is how one goes unseen — the same silence the
 * shorthand exists to end — and it is the state a file is in for every minute
 * between typing a note and running `--promote`, which is most of the minutes
 * there are.
 */
function askRow(text) {
  const { asks, answers } = collectAsks(text);
  return {
    asks: asks.map((a) => ({
      id: a.id, re: a.re, state: a.state, open: a.open, blocking: a.blocking,
      raised: a.raised, follows: a.follows, was: a.was, question: a.question,
      answer: (answers.filter((x) => x.to === a.id).pop() ?? null),
    })),
    notes: unpromotedNotes(text),
  };
}

COMMANDS.ask = async () => {
  const base = await context();
  const numbers = (argv._.slice(1).length ? argv._.slice(1) : store.listTracked(base.root, base.repo)).map(assertSafeNumber);
  const rows = [];
  // "no notes" is the message for a run that found nothing to say. Printed under
  // "LEFT ALONE — the @ai note in <!-- prt:body -->", or under a refusal to touch
  // a `ready` file, it is the tool contradicting itself two lines apart — and a
  // tool that says "no notes" about a file with notes in it is doing the one
  // thing this whole mechanism exists to stop. Counting the lines actually
  // printed is the only predicate that cannot drift from what was printed: the
  // row-shape predicate this replaces missed both cases above, because neither
  // branch fills in the field it looked at.
  let said = 0;
  const report = (line) => { said++; say(line); };
  for (const n of numbers) {
    const file = store.actionFilePath(base.root, base.repo, n);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const status = parseStatus(text);

    if (argv.flags.promote || argv.flags.tidy) {
      // Never rewrite a file a submission may be reading or about to capture.
      if (PROTECTED_STATUSES.has(status) && status !== 'hold') {
        report(`#${n}: "${status}" — refusing to rewrite. Set it back to draft or hold first.`);
        // What was refused, so `--json` carries the same fact the line does.
        rows.push({ number: n, status, file, refusedToRewrite: status, ...askRow(text) });
        continue;
      }
      const prev = store.readState(base.root, base.repo, n);
      const floor = Math.max(prev?.asks?.ordinalFloor ?? 0, maxAskOrdinal(text));
      const generation = prev?.tracking?.generation ?? 1;
      const { text: promotedText, promoted, refused, resealed } = argv.flags.promote
        ? promoteShorthand(text, { startOrdinal: floor + 1, generation })
        : { text, promoted: [], refused: [], resealed: [] };
      // Promote first, then file: a note promoted in this same run may already
      // have an answer beside it, and it belongs in the log with the rest rather
      // than a round later. One write for both, so `--promote --tidy` archives
      // once — two archives in the same millisecond collide on the ISO stamp.
      const tidied = argv.flags.tidy
        ? relocateResolvedAsks(promotedText)
        : { text: promotedText, moved: [], skipped: [], reopened: [], refreshed: [], refused: null };
      const nextText = ensurePrActions(tidied.text, { merged: !!prev?.merged });
      if (nextText !== text) {
        // Lifting a note edits prose the human typed inside a block — the only
        // writer here that does — so it is the only one that owes them an undo.
        // Inside the conditional on purpose: `prt ask --promote` with no
        // arguments walks every tracked PR, and archiving the unchanged ones
        // would bury the copies that matter under sixty that do not.
        store.archiveActionFile(base.root, base.repo, n);
        store.writeAtomic(file, nextText);
      }
      if (promoted.length) {
        store.writeState(base.root, base.repo, n, {
          ...(prev ?? {}),
          asks: { ordinalFloor: Math.max(floor, maxAskOrdinal(promotedText)) },
        });
      }
      for (const p of promoted) {
        const from = p.lifted ? `, lifted out of <!-- prt:${p.lifted} -->` : '';
        report(`#${n}: promoted @ai note → ask ${p.id} (re: ${p.re}${p.follows ? `, follows: ${p.follows}` : ''}${p.inferred ? ', inferred from position' : ''}) at line ${p.line}${from}`);
      }
      // Say it out loud. A note left behind still blocks the submit, but the
      // human has to know it is theirs to fix — silence here reads exactly like
      // "there was nothing to promote".
      for (const rf of refused) {
        report(`#${n}: LEFT ALONE — the @ai note in <!-- prt:${rf.kind} --> at line ${rf.line}: ${rf.why}`);
      }
      for (const m of tidied.moved) report(`#${n}: filed ${m.id} (${m.state}) under "## Resolved notes"`);
      // The other direction says so too, and says what it means: an ask that
      // reopened is live work again, and the human has just been told the log
      // stopped claiming otherwise.
      for (const rr of tidied.reopened) {
        report(`#${n}: took ${rr.id} back out of "## Resolved notes" — its answer is gone, so it is open again (re: ${rr.re})`);
      }
      // "It now reads addressed" on its own named the one thing that had not
      // changed, on a run that had just replaced the whole line. The line is the
      // tool's, but it is a line in a section a human reads, so a rewrite that
      // takes bytes with it says which bytes.
      // Ellipsed from BOTH ends: words a human appended sit at the tail, and a
      // head-only clip of a long derived gist shows them none of it.
      const clip = (s) => (s.length <= 100 ? s : `${s.slice(0, 40)}…${s.slice(-55)}`);
      for (const rf of tidied.refreshed) {
        report(rf.replaced
          ? `#${n}: rewrote the handling line for ${rf.id} — it now reads ${rf.state}, replacing "${clip(rf.replaced)}" (the old file is in history/)`
          : `#${n}: re-derived the handling line for ${rf.id} — it now reads ${rf.state}`);
      }
      // Every pair that did not move says why, so "nothing to file" is never read
      // as "and I am not telling you what I skipped".
      for (const s of tidied.skipped) report(`#${n}: left ${s.id} where it is — ${s.why}`);
      if (tidied.refused) report(`#${n}: not tidying — ${tidied.refused}`);
      // A resealed note is the human's edit being ACCEPTED as the question. It
      // has to be said out loud for the same reason a lift does: the command
      // just rewrote two sentinels in a file they are reading, and the note they
      // typed over is now live work that nothing has answered.
      for (const rs of resealed) {
        report(`#${n}: ${rs.id}'s question has been rewritten since it was answered — it is open again, and the old answer is now marked as answering the old wording`);
      }
      // The notes nothing can lift: inside `prt:log`, inside a block's header,
      // inside a block whose sentinel or terminator is broken, inside a block of
      // an unknown kind. `promoted` and `refused` both come from the LIFT, and
      // the lift never looks at any of those — so both counters read 0 and this
      // command answered `no un-promoted @ai notes` over a file that plainly had
      // one, while `prt validate` went on refusing that same file over that same
      // note. The scanner sees all four places, and carries the remedy that
      // applies to each, so it is what the sentence is derived from.
      const unliftable = argv.flags.promote ? unpromotedNotes(nextText).filter((x) => !x.liftable) : [];
      for (const x of unliftable) {
        const at = x.where === 'gap' ? 'in a gap' : `in <!-- prt:${x.where} -->`;
        report(`#${n}: NOT PROMOTED — the @ai note ${at} at line ${x.line}: ${x.remedy.replace(/<N>/g, String(n))}`);
      }
      if (argv.flags.promote && !promoted.length && !refused.length && !resealed.length && !unliftable.length) {
        report(`#${n}: no un-promoted @ai notes`);
      }
      if (argv.flags.tidy && !tidied.moved.length && !tidied.reopened.length && !tidied.refreshed.length
        && !tidied.skipped.length && !tidied.refused) {
        report(`#${n}: no answered notes to file`);
      }
      rows.push({
        number: n, status, file, promoted, refused, resealed, unliftable,
        moved: tidied.moved, skipped: tidied.skipped, notTidied: tidied.refused,
        reopened: tidied.reopened, refreshed: tidied.refreshed,
        // What the file still holds after the rewrite, so the row is about the
        // file and not only about this one command's edits — and in the same
        // shape the read mode below emits, because one key with two shapes is a
        // trap for whoever consumes `--json`.
        ...askRow(nextText),
      });
      continue;
    }

    const row = { number: n, status, file, ...askRow(text) };
    rows.push(row);
    if (!JSON_OUT && (row.asks.length || row.notes.length)) {
      const open = row.asks.filter((x) => x.open);
      const un = row.notes.length ? `, ${row.notes.length} un-promoted` : '';
      report(`#${n} [${status}] — ${row.asks.length} note(s), ${open.length} open${un}`);
      for (const a of row.asks) {
        const mark = a.open ? (a.blocking ? '●' : '○') : '✓';
        report(`  ${mark} ${a.id}  re: ${a.re}  ${a.state}${a.raised ? `  (${a.raised})` : ''}`);
        report(`      ${a.question.split('\n')[0].slice(0, 100)}`);
      }
      // The notes nothing has promoted yet, listed with the ones that have been.
      //
      // The remedy is the scanner's own, not a fixed `--promote`. This line used
      // to name `--promote` for every note, including the ones `--promote` is
      // documented as unable to lift — a note in `prt:log`, in a block's header,
      // in a block whose sentinel the human broke. `--promote` then answered "no
      // un-promoted @ai notes" while `prt validate` went on refusing the file
      // over exactly those notes: the tool contradicting itself two commands
      // apart, which is the silence this mechanism exists to end wearing a
      // different hat.
      for (const x of row.notes) {
        const at = x.where === 'gap' ? 'in a gap' : `in <!-- prt:${x.where} -->`;
        report(`  ! un-promoted, ${at} at line ${x.line} — ${x.remedy.replace(/<N>/g, String(n))}`);
        report(`      ${x.text.split('\n')[0].slice(0, 100)}`);
      }
    }
  }
  emit({ rows });
  if (!JSON_OUT && !said) say('no notes');
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
    const q = queueLine(base);
    if (q) say(q);
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
      job: st.job ?? null,
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

/**
 * Who this session is, for the ownership record.
 *
 * Both come from the harness. Falling back to the process keeps `prt` usable
 * from a plain terminal, where there is no session to speak of and the only
 * honest answer is "whoever is typing".
 */
function sessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
}
function sessionPid() {
  const n = Number(process.env.CLAUDE_PID);
  return Number.isInteger(n) && n > 0 ? n : process.pid;
}

/** The queue: every tracked PR carrying a job, as `{ number, job }`. */
function jobEntries(base) {
  return store.listTracked(base.root, base.repo)
    .map((number) => ({ number, job: store.readState(base.root, base.repo, number)?.job ?? null }))
    .filter((e) => e.job);
}

function saveJob(base, number, job) {
  const prev = store.readState(base.root, base.repo, number) ?? {};
  store.writeState(base.root, base.repo, number, { ...prev, job });
}

/** One line of queue state, for the commands a human reads first. */
function queueLine(base) {
  const q = jobEntries(base);
  if (!q.length) return null;
  const n = (state) => q.filter((e) => e.job.state === state).length;
  const owner = store.readOwner(base.root, base.repo);
  const who = owner ? (owner.session === sessionId() ? 'this session' : `session ${owner.session}`) : 'nobody';
  return `queue: ${n('running')} running, ${n('queued')} queued, ${n('failed')} failed · owner: ${who}`;
}

/**
 * Ownership, as a value rather than an exit.
 *
 * `die()` calls process.exit, which does not run a `finally` — so anything that
 * exits while holding the mutex leaks it until the TTL breaks it, and the next
 * command reports a busy queue for no reason a human could see. Every refusal
 * decided inside the lock is returned and acted on after it releases.
 */
function ownRepo(base, { force = false } = {}) {
  return store.claimOwner(base.root, base.repo, { session: sessionId(), pid: sessionPid(), force });
}

/**
 * May this worker write the action file, right now?
 *
 * Both halves have to be answered at the moment of writing rather than when the
 * job started. A token that is no longer the current attempt belongs to a
 * worker that was superseded — by a takeover or a retry — whose output would
 * overwrite the draft that replaced it. And a status can become `ready` while a
 * job runs: `draft` checks it before a network round trip and writes long
 * afterwards, which is exactly the window in which a human arms a file.
 */
function guardJobWrite(base, number, token) {
  const state = store.readState(base.root, base.repo, number);
  const job = state?.job;
  if (!job) return { ok: false, reason: `#${number} has no running job — nothing handed you a token` };
  if (job.owner?.attemptToken !== token) {
    return { ok: false, reason: `#${number}: that token is not the current attempt — this job was restarted or cancelled, so nothing was written` };
  }
  const existing = store.readActionFile(base.root, base.repo, number);
  const status = existing ? parseStatus(existing) : null;
  if (PROTECTED_STATUSES.has(status)) {
    return { ok: false, reason: `#${number}: review.md is "${status}" now — refusing to write over it` };
  }
  return { ok: true, state, job };
}

/**
 * The background review queue.
 *
 * Every verb that mutates job state does so inside `store.withJobLock`, and
 * every refusal decided in there comes back as a value. Reading — `list` — takes
 * neither the lock nor ownership, so a second session can always see what is
 * happening even when it may not touch it.
 */
COMMANDS.job = async () => {
  const base = await context();
  const verb = argv._[1] ?? die('usage: prt job add|list|next|commit|done|fail|cancel|release');
  const numbers = argv._.slice(2).filter((a) => /^\d+$/.test(a)).map(assertSafeNumber);
  const session = sessionId();

  if (verb === 'list') {
    const rows = orderQueue(jobEntries(base)).map(({ number, job }) => ({
      number, kind: job.kind, state: job.state, priority: job.priority,
      attempts: job.attempts, queuedAt: job.queuedAt, tier: job.tier ?? null,
      token: job.owner?.attemptToken ?? null, committedAt: job.committedAt ?? null,
      lastError: job.lastError ?? null,
    }));
    const owner = store.readOwner(base.root, base.repo);
    emit({ repo: base.repo, owner, jobs: rows });
    if (!JSON_OUT) {
      say(owner ? `queue owner: session ${owner.session} (pid ${owner.pid}), since ${owner.since}` : 'queue owner: nobody');
      for (const r of rows) {
        say(`  #${r.number}  ${r.state.padEnd(7)} ${r.kind}${r.attempts ? `  attempt ${r.attempts}` : ''}${r.lastError ? `  — ${r.lastError}` : ''}`);
      }
      if (!rows.length) say('  (empty)');
    }
    return;
  }

  if (verb === 'add') {
    const kind = argv.flags.kind ?? die('--kind review|re-review|revise is required');
    if (!JOB_KINDS.has(kind)) die(`not a job kind: ${kind}`);
    if (!numbers.length) die('usage: prt job add <PR number>... --kind K');
    const skipped = [];
    const added = store.withJobLock(base.root, base.repo, () => {
      const out = [];
      for (const n of numbers) {
        const state = store.readState(base.root, base.repo, n);
        if (!state) { skipped.push({ number: n, why: 'not tracked' }); continue; }
        if (state.job?.state === 'running') { skipped.push({ number: n, why: 'already running' }); continue; }
        saveJob(base, n, newJob({
          kind,
          priority: argv.flags.priority ?? 'batch',
          instructions: argv.flags.instructions ?? null,
          since: argv.flags.since ?? null,
          tier: argv.flags.tier ?? null,
        }));
        out.push(n);
      }
      return out;
    });
    emit({ added, skipped });
    if (!JSON_OUT) {
      for (const s of skipped) say(`#${s.number} skipped — ${s.why}`);
      say(added.length ? `queued ${added.length} job(s): ${added.join(', ')}` : 'nothing queued');
    }
    return;
  }

  if (verb === 'next') {
    const max = argv.flags.max ? Number(argv.flags.max) : Infinity;
    const result = store.withJobLock(base.root, base.repo, () => {
      // Claiming inside the mutex is what makes "one drainer" true: two sessions
      // asking at the same instant are serialised here, so exactly one writes
      // the owner record and the other reads it and loses.
      const claim = ownRepo(base, { force: !!argv.flags.force });
      if (!claim.ok) return { refused: claim };

      const plan = planNext(jobEntries(base), {
        session, maxConcurrent: base.cfg.maxConcurrentJobs ?? 4, max, mintToken,
      });
      for (const e of plan.recovered) {
        const prev = store.readState(base.root, base.repo, e.number) ?? {};
        store.writeState(base.root, base.repo, e.number, { ...prev, job: null, lastJob: e.lastJob });
      }
      for (const e of plan.reaped) saveJob(base, e.number, e.job);
      for (const e of plan.start) saveJob(base, e.number, e.job);
      store.touchOwner(base.root, base.repo, { session, pid: sessionPid() });
      return { plan, how: claim.how };
    });
    if (result.refused) die(result.refused.reason);

    const started = result.plan.start.map((e) => ({
      number: e.number, kind: e.job.kind, tier: e.job.tier,
      token: e.job.owner.attemptToken, payload: e.job.payload, attempts: e.job.attempts,
    }));
    emit({
      repo: base.repo, owner: result.how, started,
      reaped: result.plan.reaped.map((e) => ({ number: e.number, state: e.job.state })),
      recovered: result.plan.recovered.map((e) => ({ number: e.number, outcome: e.lastJob.outcome })),
      running: result.plan.running.map((e) => e.number),
    });
    if (!JSON_OUT) {
      if (result.how === 'crashed' || result.how === 'idle') say(`took over the queue from a ${result.how === 'crashed' ? 'crashed' : 'stalled'} session`);
      for (const e of result.plan.recovered) say(`#${e.number} recovered — its draft was already written`);
      for (const e of result.plan.reaped) say(`#${e.number} was orphaned → ${e.job.state}`);
      for (const s of started) say(`#${s.number} start ${s.kind} (attempt ${s.attempts}) token ${s.token}`);
      if (!started.length) say('nothing to start');
    }
    return;
  }

  if (verb === 'done' || verb === 'fail') {
    const n = numbers[0] ?? die(`usage: prt job ${verb} <PR number> --token T`);
    const tok = argv.flags.token ?? die('--token is required — `job next` hands it to the worker');
    const refusal = store.withJobLock(base.root, base.repo, () => {
      const state = store.readState(base.root, base.repo, n);
      if (!state) return `#${n} is not tracked`;
      const job = state.job;
      if (!job) return `#${n} has no job`;
      // Finishing is allowed by whoever started it, even after the repo changed
      // hands: what a superseded worker must not do is start or write anything.
      if (job.owner?.attemptToken !== tok) {
        return `#${n}: that token is not the current attempt — this job was restarted or cancelled`;
      }
      if (verb === 'done') {
        store.writeState(base.root, base.repo, n, {
          ...state, job: null, lastJob: finishedJob(job, { outcome: argv.flags.outcome ?? 'done' }),
        });
      } else {
        saveJob(base, n, failedJob(job, { error: argv.flags.error ?? 'failed' }));
      }
      store.touchOwner(base.root, base.repo, { session, pid: sessionPid() });
      return null;
    });
    if (refusal) die(refusal);
    emit({ number: n, verb });
    say(`#${n} ${verb === 'done' ? 'done' : 'failed'}`);
    return;
  }

  if (verb === 'cancel') {
    const targets = argv.flags.all ? jobEntries(base).map((e) => e.number) : numbers;
    if (!targets.length) die('usage: prt job cancel <PR number>... | --all');
    const refused = [];
    const cancelled = store.withJobLock(base.root, base.repo, () => {
      const out = [];
      for (const n of targets) {
        const state = store.readState(base.root, base.repo, n);
        if (!state?.job) continue;
        // Dropping the record of a job whose agent is still running would leave
        // a worker with a token nobody is expecting. Stop the agent first.
        if (state.job.state === 'running' && !argv.flags.force) {
          refused.push(n);
          continue;
        }
        store.writeState(base.root, base.repo, n, {
          ...state,
          job: null,
          lastJob: { kind: state.job.kind, outcome: 'cancelled', attempts: state.job.attempts, finishedAt: new Date().toISOString() },
        });
        out.push(n);
      }
      return out;
    });
    emit({ cancelled, refused });
    if (!JSON_OUT) {
      for (const n of refused) say(`#${n} is running — stop its agent first, then \`prt job cancel ${n} --force\``);
      say(`cancelled ${cancelled.length} job(s)`);
    }
    return;
  }

  if (verb === 'commit') {
    const n = numbers[0] ?? die('usage: prt job commit <PR number> --token T --from <file>');
    const tok = argv.flags.token ?? die('--token is required');
    const from = argv.flags.from ?? die('--from <file> is required');
    if (!fs.existsSync(from)) die(`no such file: ${from}`);
    const text = fs.readFileSync(from, 'utf8');
    const refusal = store.withJobLock(base.root, base.repo, () => {
      const guard = guardJobWrite(base, n, tok);
      if (!guard.ok) return guard.reason;
      store.archiveActionFile(base.root, base.repo, n);
      store.writeActionFile(base.root, base.repo, n, text);
      store.writeState(base.root, base.repo, n, {
        ...guard.state, job: { ...guard.job, committedAt: new Date().toISOString() },
      });
      store.touchOwner(base.root, base.repo, { session, pid: sessionPid() });
      return null;
    });
    if (refusal) die(refusal);
    emit({ number: n, committed: true });
    say(`#${n} review.md written`);
    return;
  }

  if (verb === 'release') {
    const released = store.releaseOwner(base.root, base.repo, { session, force: !!argv.flags.force });
    emit({ released });
    say(released ? `released the ${base.repo} queue` : 'not the owner — use --force to take it anyway');
    return;
  }

  die(`"${verb}" is not a job verb`);
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
    // `refusals` are the things `prt submit` will stop on that are not parse
    // errors. They are counted separately from `errors` — the file still parses,
    // and `--json` consumers read `errors` for that — but they carry the same
    // weight in the two things a script actually reads: the mark and the exit
    // code. See the verdict below.
    //
    // Every one of them comes from `contentRefusals`, which is the function
    // `preflight` runs: written out twice they drifted, and this command printed
    // `✓` over a file carrying "remote code execution" because its copy had the
    // pipeline-mechanics lint and none of the other three.
    const row = { number: n, status: parsed.status, errors: parsed.errors, warnings: parsed.warnings, refusals: [], actions: [] };
    if (!parsed.errors.length) {
      row.actions = planActions(parsed).map((a) => ({ id: a.id, kind: a.kind }));
      row.refusals.push(...contentRefusals(parsed, base.cfg));
      // An `edited` note that is NOT blocking is the one thing in this family
      // `prt submit` does not refuse, so it cannot be a refusal here — but the
      // file still reads as settled, with an `addressed` answer sitting under a
      // question that has moved, and the only thing saying otherwise is a hash.
      // So it is named as a warning: the point of the whole mechanism is that a
      // rewritten question is never silent.
      for (const ask of collectAsks(text).asks) {
        if (ask.state === 'edited' && !ask.blocking) {
          row.warnings.push(
            `note "${ask.id}" was rewritten after it was answered — the answer under it is not an answer to it. `
            + 'It is `blocking: no`, so this does not stop a submit; answer it again to close it',
          );
        }
      }
      // Anchor check against the live diff. `on-anchor-fail` decides whether a
      // dead anchor is fatal, and the verdict has to read it the same way
      // `preflight` does: a `demote`/`drop` comment whose anchor is gone does
      // not stop the post, so reporting it as an error here would exit 1 over a
      // file that submits cleanly — the same drift as the lints above, in the
      // other direction.
      try {
        const anchors = commentableAnchors(parseDiff(await prDiff(base.repo, n)));
        for (const c of parsed.inline.filter((x) => x.post)) {
          const v = c.subject === 'file'
            ? (anchors.has(c.path) ? { ok: true } : { ok: false, reason: `file "${c.path}" is not part of this diff`, nearest: null })
            : validateAnchor(anchors, {
              file: c.path, line: c.subject === 'range' ? c.startLine : c.line,
              endLine: c.line, side: c.side, startSide: c.startSide,
            });
          if (v.ok) continue;
          const why = `inline "${c.id}": ${v.reason}${v.nearest ? ` (nearest ${v.nearest})` : ''}`;
          if (c.onAnchorFail === 'block') row.errors.push(why);
          else row.warnings.push(`${why} — \`on-anchor-fail: ${c.onAnchorFail}\`, so the submit will ${c.onAnchorFail === 'drop' ? 'drop it' : 'demote it to a file comment'} rather than stop`);
        }
      } catch (e) {
        row.warnings.push(`could not fetch the diff to validate anchors: ${e.message}`);
      }
    }
    rows.push(row);
    if (!JSON_OUT) {
      // What the mark and the exit code promise, in the one direction they can:
      // ✗ / exit 1 means `prt submit` refuses this file — every check above is
      // one of its refusals, run through the same code, and `on-anchor-fail` is
      // read the way the submitter reads it.
      //
      // ✓ / exit 0 does NOT promise the reverse, and saying it did was the bug:
      // this printed `✓` over files carrying a security leak, an unanswered
      // note, or a quoted note, because it had its own copy of one lint out of
      // four. What ✓ means now is that nothing in the BYTES stops the post. The
      // rest is live state read at submit time — the PR still open, the head
      // unmoved, no pending review of yours, the threads where the draft left
      // them — plus the two questions about when rather than what: `Status:` has
      // to read `ready`, and there has to be something left to post.
      const mark = row.errors.length || row.refusals.length ? '✗' : '✓';
      say(`${mark} #${n} [${row.status}] ${row.actions.length} action(s)`);
      for (const e of row.errors) say(`    error:   ${e}`);
      for (const r of row.refusals) say(`    refuses: ${r}`);
      for (const w of row.warnings) say(`    warning: ${w}`);
    }
  }
  emit({ rows });
  if (rows.some((r) => r.errors.length || r.refusals.length)) process.exitCode = 1;
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
    const blocker = archiveBlocker(status) ?? jobBlocker(st?.job);
    if (blocker) {
      kept.push(n);
      say(`#${n} is ${prState} but its action file is "${status}" — ${blocker}. Run \`prt recover ${n}\`, or \`prt status ${n} skip\` to let cleanup take it.`);
      continue;
    }
    if (!dryRun) dropQueuedJob(base, n);
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
 * Why the queue objects to a review leaving the live tree, or null.
 *
 * Deliberately not folded into archiveBlocker(). That one speaks about the
 * action file's authority — a human signature, an open submit transaction — and
 * job state happens to share the word `queued` while meaning something entirely
 * different. One function answering both would let a scheduling concept stand
 * in for an approval one, which is the sort of blur that gets a review posted
 * that nobody approved.
 */
function jobBlocker(job) {
  if (job?.state === 'running') return 'a review job is running — stop its agent first';
  return null;
}

/**
 * Take a queued job off a directory that is about to leave the live tree.
 *
 * The move alone would be enough to get it out of the queue, since the queue is
 * just the live directories. But `unarchive` restores what it took, so a job
 * left in place comes back as work still waiting — months after it was reported
 * as dropped.
 */
function dropQueuedJob(base, number) {
  let state = null;
  try { state = store.readState(base.root, base.repo, number); } catch { return false; }
  if (!state?.job || state.job.state === 'running') return false;
  store.writeState(base.root, base.repo, number, {
    ...state,
    job: null,
    lastJob: {
      kind: state.job.kind,
      outcome: 'cancelled — the PR was archived',
      attempts: state.job.attempts,
      finishedAt: new Date().toISOString(),
    },
  });
  return true;
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
    let job = null;
    try { job = store.readState(base.root, base.repo, n)?.job ?? null; } catch { /* corrupt: the status check still applies */ }
    const blocker = archiveBlocker(status) ?? jobBlocker(job);
    if (blocker) {
      refused.push({ number: n, why: blocker, status });
      say(`#${n} is "${status}" — ${blocker}. Run \`prt recover ${n}\`, or \`prt status ${n} hold\` and archive it then.`);
      continue;
    }
    dropQueuedJob(base, n);

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
