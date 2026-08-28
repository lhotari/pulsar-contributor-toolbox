// The GitHub writer. This is the only code in the skill that mutates GitHub,
// and it is deliberately dumb: it posts the bytes the human approved, or it
// refuses and says why. It never rewrites, trims, reorders, or "fixes" an
// approved payload.
//
// Posting is a journalled transaction so a crash mid-flight can never
// double-post and never silently lose an action:
//
//   ready → capture (immutable snapshot + tx.json) → queued
//         → preflight (all preconditions re-checked against live GitHub)
//         → execute (one action at a time, journalled before and after)
//         → reconcile (verify every action landed)
//         → submitted | partial | blocked

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { parseActionFile, planActions, contentHash, payloadHash, setStatus, setPrActionField, appendLog, blockingAsks } from './actionfile.mjs';
import { parseDiff, commentableAnchors, validateAnchor } from './diff.mjs';
import {
  prDiff, fetchPr, submitReview, replyToComment, resolveThread, pendingReviews, describeApiError, httpStatusOf,
  createPendingReview, addFileThread, submitPendingReview,
} from './github.mjs';
import { rest, restAll, restRaw, parseBody, viewerLogin } from './gh.mjs';
import { writeAtomic, acquireLock, archiveActionFile } from './store.mjs';

const MUTATION_SPACING_MS = 1200; // GitHub asks for >=1s between mutating requests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Words that suggest an undisclosed vulnerability. See SECURITY.md / CLAUDE.md rule 6. */
const SECURITY_PATTERNS = [
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\bvulnerab(le|ility|ilities)\b/i,
  /\bexploit(able|ation)?\b/i,
  /\bremote code execution\b|\bRCE\b/i,
  /\bprivilege escalation\b/i,
  /\bauth(entication|orization) bypass\b/i,
  /\bsecurity (hole|flaw|issue|vulnerability)\b/i,
];

export class Blocked extends Error {
  constructor(reasons, extra = {}) {
    super(Array.isArray(reasons) ? reasons.join('; ') : String(reasons));
    this.name = 'Blocked';
    this.reasons = Array.isArray(reasons) ? reasons : [reasons];
    Object.assign(this, extra);
  }
}

export function diffFingerprint(diffText) {
  const files = parseDiff(diffText);
  const canonical = [...files.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}|${f.status}|${f.binary ? 'bin' : f.hunks.map((h) => `${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`).join(';')}`)
    .join('\n');
  return `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/** Transaction states that no automatic run may touch again. */
export const TERMINAL_TX_STATES = new Set(['complete', 'blocked', 'abandoned', 'needs-manual-resolution']);

function txDir(prPath, txId) {
  return path.join(prPath, 'outbox', txId);
}

function readTx(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeTx(file, tx) {
  tx.updatedAt = new Date().toISOString();
  writeAtomic(file, `${JSON.stringify(tx, null, 2)}\n`);
}

/** Any transaction in this PR dir that has not reached a terminal state. */
export function findOpenTx(prPath) {
  const outbox = path.join(prPath, 'outbox');
  if (!fs.existsSync(outbox)) return null;
  const dirs = fs.readdirSync(outbox).sort();
  for (const d of dirs.reverse()) {
    const f = path.join(outbox, d, 'tx.json');
    if (!fs.existsSync(f)) continue;
    const tx = readTx(f);
    if (!TERMINAL_TX_STATES.has(tx.state)) return { tx, file: f, dir: path.join(outbox, d) };
  }
  return null;
}

/**
 * Step 1 — capture. Reads `review.md` twice and requires the two reads to be
 * identical, so a half-saved editor buffer can never be captured. Produces an
 * immutable snapshot; from here on the human may keep editing the file without
 * affecting what gets posted.
 */
export async function capture(ctx) {
  const { prPath, actionPath, repo, number } = ctx;
  const first = fs.readFileSync(actionPath, 'utf8');
  await sleep(150);
  const second = fs.readFileSync(actionPath, 'utf8');
  if (first !== second) throw new Blocked('the file changed while it was being read — try again once the editor has settled');

  const parsed = parseActionFile(first);
  // A dry run answers "would this post?", so it is allowed on a draft too.
  const gateOk = parsed.status === 'ready' || (ctx.dryRun && ['draft', 'blocked', 'error'].includes(parsed.status));
  if (!gateOk) throw new Blocked(`status is "${parsed.status}", not "ready"`);
  if (parsed.errors.length) throw new Blocked(parsed.errors);

  const actions = planActions(parsed);
  if (actions.length === 0) throw new Blocked('nothing to post: every block is `post: false` and `event:` is NONE');

  const txId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${payloadHash(parsed).slice(-8)}`;
  const dir = txDir(prPath, txId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, 'approved.md'), first);

  const tx = {
    txId,
    repo,
    pr: number,
    createdAt: new Date().toISOString(),
    state: 'captured',
    generation: parsed.doc.generation ?? null,
    contentHash: contentHash(first),
    payloadHash: payloadHash(parsed),
    preconditions: {
      head: parsed.doc.head ?? null,
      baseRef: parsed.doc['base-ref'] ?? null,
      base: parsed.doc.base ?? null,
      diffFingerprint: parsed.doc['diff-fingerprint'] ?? null,
    },
    event: parsed.event,
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      state: 'pending',
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    })),
  };
  const file = path.join(dir, 'tx.json');
  writeTx(file, tx);
  return { tx, file, dir, parsed, text: first, actions };
}

/**
 * Step 2 — preflight. Every precondition is re-checked against live GitHub.
 * Returns a list of blocking reasons (empty means "safe to post").
 */
export async function preflight(ctx, parsed, tx) {
  const { repo, number, config } = ctx;
  const reasons = [];
  const planned = planActions(parsed);
  const login = await viewerLogin();
  const pr = await fetchPr(repo, number);
  if (!pr) return { reasons: [`PR ${repo}#${number} could not be fetched`], pr: null };

  if (pr.state !== 'OPEN') reasons.push(`the PR is ${pr.state.toLowerCase()} — nothing will be posted`);
  if (pr.author?.login === login && tx.event === 'APPROVE') {
    reasons.push('GitHub does not allow approving your own pull request');
  }
  if (pr.author?.login === login && tx.event === 'REQUEST_CHANGES') {
    reasons.push('GitHub does not allow requesting changes on your own pull request');
  }
  // Diff state, not just the head SHA: the base can move under a stable head.
  const currentDiff = await prDiff(repo, number);
  const fp = diffFingerprint(currentDiff);
  if (tx.preconditions.head && pr.headRefOid !== tx.preconditions.head) {
    reasons.push(`the PR head moved: drafted against ${short(tx.preconditions.head)}, now ${short(pr.headRefOid)}`);
  }
  if (tx.preconditions.baseRef && pr.baseRefName !== tx.preconditions.baseRef) {
    reasons.push(`the PR was retargeted: base was ${tx.preconditions.baseRef}, now ${pr.baseRefName}`);
  }
  if (tx.preconditions.diffFingerprint && fp !== tx.preconditions.diffFingerprint) {
    reasons.push('the effective diff changed since this draft was generated (base advanced or the PR was rebased)');
  }

  // A pending review we did not create may hold comments this file knows nothing about.
  const pending = await pendingReviews(repo, number);
  if (pending.length) {
    reasons.push(
      `you have ${pending.length} unsubmitted (PENDING) review(s) on this PR — submit or discard them on GitHub first: ${pending
        .map((p) => p.html_url || `review ${p.id}`)
        .join(', ')}`,
    );
  }

  // Anchors. Never relocate or demote silently: refuse, and say where it moved to.
  const anchors = commentableAnchors(parseDiff(currentDiff));
  const anchorProblems = [];
  const plannedInline = planned
    .filter((a) => a.kind === 'review')
    .flatMap((a) => a.comments);
  for (const c of plannedInline) {
    if (c.subject === 'file') {
      if (!anchors.has(c.path)) anchorProblems.push({ c, reason: `file "${c.path}" is not part of this diff`, nearest: null });
      continue;
    }
    const v = validateAnchor(anchors, {
      file: c.path,
      line: c.subject === 'range' ? c.startLine : c.line,
      endLine: c.line,
      side: c.side,
      startSide: c.startSide,
    });
    if (!v.ok) anchorProblems.push({ c, reason: v.reason, nearest: v.nearest });
  }
  for (const p of anchorProblems) {
    if (p.c.onAnchorFail === 'block') {
      reasons.push(
        `comment "${p.c.id}" no longer anchors: ${p.reason}${p.nearest ? ` (nearest commentable line: ${p.nearest})` : ''}`,
      );
    }
  }

  // Thread preconditions: never reply into a thread that moved under us.
  const threadsById = new Map((pr.reviewThreads?.nodes ?? []).map((t) => [t.id, t]));
  const plannedThreads = new Map(
    planned
      .filter((a) => a.kind.startsWith('thread-'))
      .map((a) => [a.thread.id, a.thread]),
  );
  for (const t of plannedThreads.values()) {
    const live = threadsById.get(t.threadNodeId);
    if (!live) {
      reasons.push(`thread "${t.id}" (${t.threadNodeId}) no longer exists on this PR`);
      continue;
    }
    if (t.expectResolved !== null && !!live.isResolved !== t.expectResolved) {
      reasons.push(`thread "${t.id}" is now ${live.isResolved ? 'resolved' : 'unresolved'}; the draft expected the opposite`);
    }
    if (t.expectLastCommentId) {
      const comments = live.comments?.nodes ?? [];
      const lastId = String(comments[comments.length - 1]?.fullDatabaseId ?? comments[comments.length - 1]?.databaseId ?? '');
      if (lastId && lastId !== String(t.expectLastCommentId)) {
        reasons.push(`thread "${t.id}" has a newer comment since the draft was generated — re-read it before replying`);
      }
    }
  }

  if (config.securityLint) {
    const hits = securityLint(parsed);
    if (hits.length) {
      reasons.push(
        `the outgoing text mentions ${hits.join(', ')}. Never disclose a vulnerability in a public PR (SECURITY.md). ` +
          'If this is genuinely not a disclosure, add `security-reviewed: yes` to the `<!-- prt:doc -->` block.',
      );
    }
  }

  // An unanswered note of your own refuses the post. This lives in preflight,
  // not in `parseActionFile`: an open ask is the NORMAL state of a draft being
  // worked on, so as a parse error it would make every mid-round `prt validate`
  // fail — and the revisit loop depends on that signal staying clean.
  //
  // The failure it prevents is real: arming a batch days later with your own
  // objection three lines above, and posting under your own name a review you
  // had already said was wrong.
  for (const ask of blockingAsks(parsed)) {
    reasons.push(
      `note "${ask.id}"${ask.re && ask.re !== 'general' ? ` (on ${ask.re})` : ''} is still open: ` +
        `"${firstLine(ask.question)}". Answer it, or set \`blocking: no\` to defer it, or \`closed: yes\` to withdraw it.`,
    );
  }

  if (config.askQuoteLint !== false) {
    const quoted = askQuoteLint(parsed);
    if (quoted.length) {
      reasons.push(
        `outgoing text repeats ${quoted.length === 1 ? 'a private note' : 'private notes'} to the assistant verbatim ` +
          `(${quoted.map((q) => `${q.id}: "${q.excerpt}…"`).join(', ')}). Notes in \`prt:ask\` are yours, not the author's. ` +
          'Rewrite the passage, or add `ask-quote-reviewed: yes` to the `<!-- prt:doc -->` block if it genuinely belongs in the review.',
      );
    }
  }

  return { reasons, pr, currentDiff, anchorProblems };
}

function firstLine(s, max = 90) {
  const line = String(s ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Words, punctuation flattened. Two normalisations, because either alone has a
 * blind spot: dropping code spans loses a note written mostly in backticks
 * (reviewers write `symbolNames` constantly), while keeping them lets a shared
 * identifier drag unrelated prose over the threshold.
 */
function wordsOf(s, { code = 'strip' } = {}) {
  let t = String(s ?? '');
  t = code === 'strip'
    ? t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    : t.replace(/`+/g, ' ');
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The one leak the parser cannot close: the model folding a private note into
 * outgoing prose during a revision pass. SKILL.md already warns that revision
 * is where tooling attribution leaks, for the same reason — prose gets
 * reshuffled and provenance is lost.
 *
 * 12 consecutive words with code stripped is essentially copy-paste detection.
 * A shorter run false-positives on the common case, where the note IS a
 * technical objection and its sentence is also the right sentence for the
 * review — and the escape hatch is one only the human may use, since the model
 * is forbidden to touch `prt:doc`.
 */
export function askQuoteLint(parsed, { run = 12, whole = 6 } = {}) {
  if (parsed.doc?.['ask-quote-reviewed'] === 'yes') return [];
  if (!parsed.asks?.length) return [];
  const outgoing = [];
  for (const action of planActions(parsed)) {
    if (action.kind === 'review') {
      if (action.body) outgoing.push(action.body);
      outgoing.push(...action.comments.map((c) => c.body));
    } else if (action.kind === 'thread-reply') outgoing.push(action.thread.body);
    else if (action.kind === 'issue-comment') outgoing.push(action.body);
  }
  const modes = ['strip', 'keep'];
  const haystacks = new Map(modes.map((m) => [m, outgoing.map((t) => wordsOf(t, { code: m }).join(' '))]));
  const hits = [];
  for (const ask of parsed.asks) {
    let hit = null;
    for (const mode of modes) {
      const w = wordsOf(ask.question, { code: mode });
      const hay = haystacks.get(mode);
      if (!w.length) continue;
      // A note reproduced in FULL is a paste however short it is. The sliding
      // window alone missed "do not mention the netty regression it is
      // embargoed" — ten words, and exactly the kind of note that must not go
      // out. `whole` floors it so a three-word note cannot false-positive.
      if (w.length >= whole && w.length < run) {
        const all = w.join(' ');
        if (hay.some((h) => h.includes(all))) { hit = w.slice(0, 8).join(' '); break; }
      }
      if (w.length < run) continue;
      for (let i = 0; i + run <= w.length; i++) {
        const needle = w.slice(i, i + run).join(' ');
        if (hay.some((h) => h.includes(needle))) { hit = w.slice(i, i + 8).join(' '); break; }
      }
      if (hit) break;
    }
    if (hit) hits.push({ id: ask.id, excerpt: hit });
  }
  return hits;
}

export function securityLint(parsed) {
  if (parsed.doc['security-reviewed'] === 'yes') return [];
  const texts = [];
  for (const action of planActions(parsed)) {
    if (action.kind === 'review') {
      if (action.body) texts.push(action.body);
      texts.push(...action.comments.map((c) => c.body));
    } else if (action.kind === 'thread-reply') {
      texts.push(action.thread.body);
    } else if (action.kind === 'issue-comment') {
      texts.push(action.body);
    }
  }
  const hits = new Set();
  for (const t of texts) {
    for (const re of SECURITY_PATTERNS) {
      const m = re.exec(t);
      if (m) hits.add(`"${m[0]}"`);
    }
  }
  return [...hits];
}

/**
 * Did the request definitely NOT reach GitHub?
 *
 * Only a 4xx proves that: GitHub looked at the request and refused it. Anything
 * else — a timeout, a killed process, an empty stderr, a 5xx — may have been
 * applied before the connection died. For content-creating calls the safe
 * default is therefore "unknown, go and look" rather than "failed, retry",
 * because a wrong retry is a duplicate comment on someone's PR.
 */
function isAmbiguous(status) {
  if (typeof status === 'number') return !(status >= 400 && status < 500);
  return true;
}

function short(sha) {
  return String(sha ?? '').slice(0, 8);
}

function normalizeBody(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * Step 3 — execute. Each action is journalled as `calling` BEFORE the request
 * and reconciled after, so an interrupted run is always recoverable.
 */
export async function execute(ctx, parsed, txState) {
  const { repo, number } = ctx;
  const { tx, file } = txState;
  const actions = planActions(parsed);
  const byId = new Map(actions.map((a) => [a.id, a]));

  tx.state = 'executing';
  writeTx(file, tx);

  for (const entry of tx.actions) {
    if (entry.state === 'done') continue;
    if (entry.state === 'needs-manual-resolution') {
      // A pending review is sitting on GitHub with approved content in it.
      // Retrying would create a second one. Stop and let the human finish it.
      tx.state = 'needs-manual-resolution';
      writeTx(file, tx);
      return tx;
    }
    const action = byId.get(entry.id);
    if (!action) {
      entry.state = 'failed';
      entry.error = 'action disappeared from the approved payload';
      writeTx(file, tx);
      continue;
    }

    if (entry.state === 'calling' || entry.state === 'unknown') {
      // A previous run may have completed this on GitHub without recording it.
      const found = await findExisting(ctx, action, tx);
      if (found) {
        entry.state = 'done';
        entry.result = found;
        entry.finishedAt = new Date().toISOString();
        entry.note = 'recovered: an identical post already exists on GitHub';
        writeTx(file, tx);
        continue;
      }
      entry.state = 'pending';
    }

    entry.state = 'calling';
    entry.startedAt = new Date().toISOString();
    writeTx(file, tx);
    ctx.lock?.heartbeat?.();

    let res;
    try {
      // Anything the action learns mid-flight (a pending review id) is written
      // to the journal immediately, before the next network call.
      res = await performAction(ctx, action, tx, (extra) => {
        Object.assign(entry, extra);
        writeTx(file, tx);
      });
    } catch (e) {
      res = { ok: false, error: e.message, ambiguous: true };
    }

    if (res.ok) {
      entry.state = 'done';
      entry.result = res.result ?? null;
      entry.error = null;
    } else if (res.pendingReviewId) {
      // A pending review exists on GitHub holding approved content. That is a
      // half-completed action a human must finish or discard — never a retry.
      entry.state = 'needs-manual-resolution';
      entry.error = res.error;
    } else {
      // A content-creating request that failed ambiguously must never be
      // auto-retried; mark it unknown so reconcile decides.
      entry.state = res.ambiguous ? 'unknown' : 'failed';
      entry.error = res.error;
    }
    entry.finishedAt = new Date().toISOString();
    writeTx(file, tx);

    if (entry.state !== 'done') break; // stop at the first failure; leave the rest pending
    await sleep(MUTATION_SPACING_MS);
  }

  const done = tx.actions.filter((a) => a.state === 'done').length;
  const stuck = tx.actions.some((a) => a.state === 'needs-manual-resolution');
  tx.state = stuck ? 'needs-manual-resolution' : done === tx.actions.length ? 'complete' : done > 0 ? 'partial' : 'failed';
  writeTx(file, tx);
  return tx;
}

async function performAction(ctx, action, tx, journal = () => {}) {
  const { repo, number } = ctx;
  switch (action.kind) {
    case 'review': {
      const lineComments = action.comments.filter((c) => c.subject !== 'file');
      const fileComments = action.comments.filter((c) => c.subject === 'file');

      const payload = { commit_id: tx.preconditions.head || undefined };
      if (action.body) payload.body = action.body;
      if (lineComments.length) {
        payload.comments = lineComments.map((c) => {
          const o = { path: c.path, body: c.body, line: c.line, side: c.side };
          if (c.subject === 'range') {
            o.start_line = c.startLine;
            o.start_side = c.startSide;
          }
          return o;
        });
      }

      // Belt to the parser's brace: an eventless review payload is a PENDING
      // review, which is invisible and wedges the next submit. Never send one.
      if (!action.event || action.event === 'NONE') {
        return { ok: false, error: 'refusing to post a review with no event — that would create an invisible pending review' };
      }

      // Fast path: no file-level comments, so one request does everything.
      if (fileComments.length === 0) {
        payload.event = action.event;
        const r = await submitReview(repo, number, payload);
        if (r.ok) {
          return { ok: true, result: { reviewDatabaseId: String(r.review.id), url: r.review.html_url, state: r.review.state } };
        }
        return { ok: false, error: r.error, ambiguous: isAmbiguous(r.status) };
      }

      // Three-step path: PENDING review -> GraphQL file threads -> submit.
      // Journal the pending review id the moment it exists, so an interrupted
      // run leaves something recoverable rather than an orphan.
      const created = await createPendingReview(repo, number, payload);
      if (!created.ok) return { ok: false, error: created.error, ambiguous: isAmbiguous(created.status) };
      const reviewId = String(created.review.id);
      const reviewNodeId = created.review.node_id;
      journal({ pendingReviewId: reviewId, pendingReviewNodeId: reviewNodeId });

      const prNodeId = ctx.pullRequestNodeId ?? (await fetchPr(repo, number))?.id;
      if (!prNodeId) {
        return { ok: false, error: `created pending review ${reviewId} but could not resolve the PR node id; discard or submit it on GitHub`, pendingReviewId: reviewId };
      }
      for (const c of fileComments) {
        await sleep(MUTATION_SPACING_MS);
        const t = await addFileThread({ reviewNodeId, pullRequestNodeId: prNodeId, path: c.path, body: c.body });
        if (!t.ok) {
          return {
            ok: false,
            error: `file-level comment on ${c.path} failed: ${t.error}. Pending review ${created.review.html_url} was left unsubmitted — submit or discard it on GitHub.`,
            pendingReviewId: reviewId,
          };
        }
      }
      await sleep(MUTATION_SPACING_MS);
      const submitted = await submitPendingReview(repo, number, reviewId, { event: action.event, body: action.body });
      if (submitted.ok) {
        return { ok: true, result: { reviewDatabaseId: reviewId, url: submitted.review.html_url, state: submitted.review.state } };
      }
      return {
        ok: false,
        error: `${submitted.error} (pending review ${created.review.html_url} still holds the comments)`,
        pendingReviewId: reviewId,
        ambiguous: isAmbiguous(submitted.status),
      };
    }
    case 'thread-reply': {
      const r = await replyToComment(repo, number, action.thread.replyToCommentId, action.thread.body);
      if (r.ok) return { ok: true, result: { commentDatabaseId: String(r.comment.id), url: r.comment.html_url } };
      return { ok: false, error: r.error, ambiguous: isAmbiguous(r.status) };
    }
    case 'thread-resolve':
    case 'thread-unresolve': {
      const r = await resolveThread(action.thread.threadNodeId, action.kind === 'thread-resolve');
      return r.ok ? { ok: true, result: { threadNodeId: action.thread.threadNodeId } } : { ok: false, error: r.error };
    }
    case 'issue-comment': {
      const r = await restRaw('POST', `repos/${repo}/issues/${number}/comments`, { body: action.body });
      const c = parseBody(r.stdout);
      if (r.ok && c) return { ok: true, result: { commentDatabaseId: String(c.id), url: c.html_url } };
      return { ok: false, error: describeApiError(r), ambiguous: isAmbiguous(httpStatusOf(r)) };
    }
    case 'update-branch': {
      const expected = tx.preconditions.head;
      const pr = await fetchPr(repo, number);
      if (!pr) return { ok: false, error: 'the PR could not be fetched', ambiguous: false };
      // Asking first costs one read and saves a pointless merge commit on a
      // branch that is already current — the common case when the human armed
      // the flag optimistically.
      const behind = await behindBy(repo, pr.baseRefName, pr.headRefOid);
      if (behind === 0) {
        return { ok: true, result: { headSha: pr.headRefOid, note: 'already up to date with the base branch' } };
      }
      // `expected_head_sha` makes GitHub enforce what preflight checked: if the
      // author pushed between capture and here, this updates nothing.
      const r = await restRaw('PUT', `repos/${repo}/pulls/${number}/update-branch`,
        expected ? { expected_head_sha: expected } : {});
      if (!r.ok) {
        const status = httpStatusOf(r);
        // 422 is GitHub's answer to both "the head moved" and "it does not
        // merge cleanly". Neither is retryable and neither is ambiguous: in
        // both cases nothing was written.
        return { ok: false, error: describeApiError(r), ambiguous: status === 422 ? false : isAmbiguous(status) };
      }
      // GitHub applies the merge asynchronously and answers 202 with a message,
      // not a SHA — reading the head back here would as likely return the old
      // one as the new. Whoever needs the new head reads it when it needs it.
      return {
        ok: true,
        result: { updated: true, previousHead: expected, note: parseBody(r.stdout)?.message ?? 'branch update requested' },
      };
    }
    case 'approve-workflows': {
      // After a branch update the runs that matter belong to the NEW head; the
      // ones on the old head are about to be superseded. GitHub creates them a
      // few seconds later, so this is the one place the submitter waits.
      const updated = tx.actions.find((a) => a.kind === 'update-branch' && a.state === 'done' && a.result?.updated);
      let head = tx.preconditions.head;
      let runs;
      if (updated) {
        // The head this transaction just moved is not knowable up front, and
        // the runs on it appear a few seconds later still, so the wait re-reads
        // both together.
        ({ runs, head } = await waitForRunsOnCurrentHead(repo, number, workflowWaitMs(ctx)));
      } else {
        runs = await pendingWorkflowRuns(repo, number, head);
      }
      if (updated && runs.length === 0) {
        // Not a failure: a repo that does not gate this PR's workflows has
        // nothing to approve, and so does one whose runs have not appeared yet.
        return { ok: true, result: { approvedWorkflowRunIds: [], head, note: 'no runs were waiting for approval' } };
      }
      const approvedWorkflowRunIds = [];
      for (const run of runs) {
        const r = await restRaw('POST', `repos/${repo}/actions/runs/${run.id}/approve`);
        if (!r.ok) {
          // The endpoint has no useful idempotent success response. Re-query:
          // if the run is no longer action_required, this request or another
          // maintainer already approved it and recovery can safely continue.
          const stillPending = await pendingWorkflowRuns(repo, number, head);
          if (!stillPending.some((x) => String(x.id) === String(run.id))) {
            approvedWorkflowRunIds.push(String(run.id));
            continue;
          }
          return { ok: false, error: describeApiError(r), ambiguous: isAmbiguous(httpStatusOf(r)) };
        }
        approvedWorkflowRunIds.push(String(run.id));
        journal({ approvedWorkflowRunIds: [...approvedWorkflowRunIds] });
        await sleep(MUTATION_SPACING_MS);
      }
      return { ok: true, result: { approvedWorkflowRunIds, head } };
    }
    default:
      return { ok: false, error: `unknown action kind "${action.kind}"` };
  }
}

/**
 * Recovery: has this exact action already landed on GitHub?
 *
 * Body equality alone is NOT enough, and getting this wrong is expensive in
 * both directions — a false match silently drops content the human approved, a
 * false miss double-posts. So every match is additionally constrained by:
 *
 *   - time: it must have been created at or after this transaction started;
 *   - target: a reply must sit in the thread we meant to reply to;
 *   - substance: an empty body never matches anything. GitHub creates an
 *     empty-bodied COMMENTED review object for every standalone reply, so
 *     "review with no body" would otherwise match one of those.
 */
async function findExisting(ctx, action, tx) {
  const { repo, number } = ctx;
  const login = await viewerLogin();
  // 120s of slack: GitHub timestamps at second resolution and clocks drift.
  const floor = Date.parse(tx.createdAt) - 120_000;
  const atOrAfterFloor = (iso) => !!iso && Date.parse(iso) >= floor;

  try {
    if (action.kind === 'review') {
      const want = normalizeBody(action.body);
      const reviews = await restAll(`repos/${repo}/pulls/${number}/reviews`);
      const hit = (reviews ?? []).find((r) => {
        if (r.user?.login !== login || r.state === 'PENDING') return false;
        if (!atOrAfterFloor(r.submitted_at)) return false;
        if (want) return normalizeBody(r.body) === want;
        // A body-less review is only ours if it landed on the commit we pinned.
        return !normalizeBody(r.body) && r.commit_id === tx.preconditions.head;
      });
      return hit ? { reviewDatabaseId: String(hit.id), url: hit.html_url, state: hit.state } : null;
    }

    if (action.kind === 'thread-reply') {
      const want = normalizeBody(action.thread.body);
      if (!want) return null;
      const comments = await restAll(`repos/${repo}/pulls/${number}/comments`);
      const hit = (comments ?? []).find(
        (c) =>
          c.user?.login === login &&
          atOrAfterFloor(c.created_at) &&
          // The reply must be in the thread we targeted, not merely say the same words.
          String(c.in_reply_to_id ?? '') === String(action.thread.replyToCommentId ?? '') &&
          normalizeBody(c.body) === want,
      );
      return hit ? { commentDatabaseId: String(hit.id), url: hit.html_url } : null;
    }

    if (action.kind === 'issue-comment') {
      const want = normalizeBody(action.body);
      if (!want) return null;
      const comments = await restAll(`repos/${repo}/issues/${number}/comments`);
      const hit = (comments ?? []).find(
        (c) => c.user?.login === login && atOrAfterFloor(c.created_at) && normalizeBody(c.body) === want,
      );
      return hit ? { commentDatabaseId: String(hit.id), url: hit.html_url } : null;
    }

    if (action.kind === 'thread-resolve' || action.kind === 'thread-unresolve') {
      // Resolution is idempotent and observable, so state equality is enough.
      const pr = await fetchPr(repo, number);
      const t = (pr?.reviewThreads?.nodes ?? []).find((x) => x.id === action.thread.threadNodeId);
      if (!t) return null;
      const want = action.kind === 'thread-resolve';
      return !!t.isResolved === want ? { threadNodeId: t.id, isResolved: t.isResolved } : null;
    }

    if (action.kind === 'update-branch') {
      // Observable end state, the argument thread-resolve uses: if the head has
      // moved off the SHA we captured AND the branch is no longer behind its
      // base, the update landed — by the crashed run, or by a hand on the
      // button. Either way, doing it again would merge nothing and add noise.
      const pr = await fetchPr(repo, number);
      if (!pr || !tx.preconditions.head || pr.headRefOid === tx.preconditions.head) return null;
      const behind = await behindBy(repo, pr.baseRefName, pr.headRefOid);
      return behind === 0
        ? { headSha: pr.headRefOid, previousHead: tx.preconditions.head, updated: true }
        : null;
    }

    if (action.kind === 'approve-workflows') {
      // Same head the action would have targeted, so a resumed run does not
      // check the pre-update head and conclude there is nothing left to do.
      const updated = tx.actions.find((a) => a.kind === 'update-branch' && a.state === 'done' && a.result?.updated);
      const head = updated ? (await fetchPr(repo, number))?.headRefOid ?? tx.preconditions.head : tx.preconditions.head;
      const remaining = await pendingWorkflowRuns(repo, number, head);
      return remaining.length === 0 ? { approvedWorkflowRunIds: [], head } : null;
    }
  } catch {
    return null; // could not verify — the caller keeps the action `unknown`
  }
  return null;
}

/**
 * How many commits the base branch is ahead of this head, or null when GitHub
 * cannot say (a fork head it will not compare, a transient error). Only ever
 * used to skip a pointless update, so "don't know" means "ask GitHub anyway".
 */
async function behindBy(repo, baseRef, head) {
  if (!baseRef || !head) return null;
  try {
    const data = await rest('GET', `repos/${repo}/compare/${encodeURIComponent(baseRef)}...${head}`);
    return Number.isFinite(data?.behind_by) ? data.behind_by : null;
  } catch {
    return null;
  }
}

const WORKFLOW_POLL_MS = 5000;

/** How long to wait for a freshly updated head's workflow runs to appear. */
function workflowWaitMs(ctx) {
  const s = Number(ctx.config?.workflowApprovalWaitSeconds);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 60_000;
}

/**
 * Runs waiting for approval on whatever the PR head is *now*.
 *
 * Two things are asynchronous after a branch update, and this waits out both:
 * GitHub moves the head some time after answering 202, and creates that head's
 * workflow runs some time after that. So the head is re-read on every poll
 * rather than pinned once — pinning it would mean approving runs on the head we
 * just replaced, or on nothing at all. This is the only place the submitter
 * waits, and only when this transaction moved the head itself.
 */
async function waitForRunsOnCurrentHead(repo, number, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let head = null;
  for (;;) {
    head = (await fetchPr(repo, number))?.headRefOid ?? head;
    const runs = head ? await pendingWorkflowRuns(repo, number, head) : [];
    if (runs.length) return { runs, head };
    const left = deadline - Date.now();
    if (left <= 0) return { runs: [], head };
    await sleep(Math.min(WORKFLOW_POLL_MS, left));
  }
}

/** Workflow runs for this PR head that show GitHub's "Approve workflows to run" gate. */
async function pendingWorkflowRuns(repo, number, head) {
  if (!head) return [];
  const q = new URLSearchParams({ head_sha: head, status: 'action_required', event: 'pull_request', per_page: '100' });
  const data = await rest('GET', `repos/${repo}/actions/runs?${q}`);
  return (data?.workflow_runs ?? []).filter((run) => {
    if (run.head_sha && run.head_sha !== head) return false;
    const prs = run.pull_requests ?? [];
    return prs.length === 0 || prs.some((pr) => Number(pr.number) === Number(number));
  });
}

/**
 * Full run: capture → preflight → execute → write the outcome back to the file.
 * `ctx.dryRun` stops after preflight, restores the previous status, and reports
 * exactly what would have been posted.
 */
export async function submitReady(ctx) {
  const { prPath, actionPath } = ctx;
  const lock = acquireLock(prPath);
  if (!lock) return { ok: false, status: null, message: 'another submitter holds the lock for this PR' };
  ctx = { ...ctx, lock };
  try {
    const open = findOpenTx(prPath);

    // A dry run must never touch GitHub, and resuming does. Report and stop.
    if (open && ctx.dryRun) {
      return {
        ok: false,
        status: 'would-block',
        dryRun: true,
        plan: [],
        reasons: [`transaction ${open.tx.txId} is open in state "${open.tx.state}" — resolve it before submitting`],
        message: `would BLOCK: an open transaction (${open.tx.txId}, state ${open.tx.state}) must be resolved first — run \`prt recover ${ctx.number}\``,
      };
    }

    if (open && open.tx.state === 'needs-manual-resolution') {
      const stuck = open.tx.actions.filter((a) => a.state === 'needs-manual-resolution');
      return {
        ok: false,
        status: 'partial',
        message: `transaction ${open.tx.txId} needs you: ${stuck.map((a) => a.error).join('; ')}`,
        txId: open.tx.txId,
      };
    }

    if (open) {
      // Resume from the SNAPSHOT, whatever phase it died in. A `captured` tx
      // crashed during preflight — nothing was posted, but the live file is now
      // `queued`, which `capture()` rejects. Re-running preflight from
      // approved.md is the only way out that neither wedges the PR nor posts
      // anything unchecked.
      const live = await fetchPr(ctx.repo, ctx.number);
      if (live && live.state !== 'OPEN') {
        open.tx.state = 'blocked';
        open.tx.blockedReasons = [`the PR is ${live.state.toLowerCase()}; the remaining actions were not posted`];
        writeTx(open.file, open.tx);
        const t = appendLog(setStatus(fs.readFileSync(actionPath, 'utf8'), 'blocked'),
          `resume abandoned: the PR is ${live.state.toLowerCase()}`);
        writeAtomic(actionPath, t);
        return { ok: false, status: 'blocked', message: `the PR is ${live.state.toLowerCase()}` };
      }

      const parsed = parseActionFile(fs.readFileSync(path.join(open.dir, 'approved.md'), 'utf8'));

      if (open.tx.state === 'captured') {
        // Nothing has been posted yet, so every precondition still applies.
        const pre = await preflight(ctx, parsed, open.tx);
        if (pre.reasons.length) {
          open.tx.state = 'blocked';
          open.tx.blockedReasons = pre.reasons;
          writeTx(open.file, open.tx);
          let out = setStatus(fs.readFileSync(actionPath, 'utf8'), 'blocked');
          out = appendLog(out, `BLOCKED on resume — nothing was posted:\n${pre.reasons.map((x) => `  - ${x}`).join('\n')}`);
          writeAtomic(actionPath, out);
          return { ok: false, status: 'blocked', message: pre.reasons.join('; '), reasons: pre.reasons };
        }
      }

      const tx = await execute(ctx, parsed, open);
      return finish(ctx, tx, `resumed transaction ${tx.txId}`);
    }

    const captured = await capture(ctx);
    if (!ctx.dryRun) {
      // Stamp the status onto the bytes we captured, never onto an earlier read:
      // an edit landing in between would otherwise be silently reverted on disk.
      writeAtomic(actionPath, setStatus(captured.text, 'queued'));
    }

    const pre = await preflight(ctx, captured.parsed, captured.tx);

    if (ctx.dryRun) {
      captured.tx.state = 'abandoned';
      captured.tx.note = 'dry run';
      writeTx(captured.file, captured.tx);
      const plan = planActions(captured.parsed).map((a) => {
        if (a.kind === 'review') {
          return `review ${a.event ?? 'NONE'} · body ${a.body ? `${a.body.length} chars` : '(none)'} · ${a.comments.length} inline comment(s)`;
        }
        if (a.kind === 'thread-reply') return `reply in thread ${a.thread.threadNodeId} (${a.thread.body.length} chars)`;
        if (a.kind === 'thread-resolve') return `resolve thread ${a.thread.threadNodeId}`;
        if (a.kind === 'thread-unresolve') return `unresolve thread ${a.thread.threadNodeId}`;
        if (a.kind === 'update-branch') return 'update this PR branch from its base (GitHub\'s "Update branch")';
        if (a.kind === 'approve-workflows') return 'approve eligible GitHub Actions workflow runs for this PR head';
        return `${a.kind} (${a.body?.length ?? 0} chars)`;
      });
      return {
        ok: pre.reasons.length === 0,
        status: pre.reasons.length ? 'would-block' : 'would-post',
        dryRun: true,
        plan,
        reasons: pre.reasons,
        message: pre.reasons.length
          ? `would BLOCK:\n${pre.reasons.map((x) => `  - ${x}`).join('\n')}`
          : `would post ${plan.length} action(s):\n${plan.map((x) => `  - ${x}`).join('\n')}`,
      };
    }

    if (pre.reasons.length) {
      captured.tx.state = 'blocked';
      captured.tx.blockedReasons = pre.reasons;
      writeTx(captured.file, captured.tx);
      let out = setStatus(fs.readFileSync(actionPath, 'utf8'), 'blocked');
      out = appendLog(out, `BLOCKED — nothing was posted:\n${pre.reasons.map((x) => `  - ${x}`).join('\n')}`);
      writeAtomic(actionPath, out);
      return { ok: false, status: 'blocked', message: pre.reasons.join('; '), reasons: pre.reasons };
    }

    const tx = await execute(ctx, captured.parsed, captured);
    return finish(ctx, tx, `transaction ${tx.txId}`);
  } finally {
    lock.release();
  }
}

/**
 * What a PR-level action did, for the activity log. Neither produces a URL, so
 * without this both would log as a bare tick and the human could not tell an
 * approval of four runs from one that found nothing to approve.
 */
function prActionDetail(a) {
  if (a.kind === 'update-branch') {
    return a.result?.note ?? 'branch updated from its base';
  }
  if (a.kind === 'approve-workflows') {
    const ids = a.result?.approvedWorkflowRunIds ?? [];
    if (!ids.length) return a.result?.note ?? 'no runs were waiting for approval';
    return `approved ${ids.length} workflow run(s)${a.result?.head ? ` on ${short(a.result.head)}` : ''}`;
  }
  return null;
}

function finish(ctx, tx, label) {
  const { actionPath, prPath, repo, number } = ctx;
  const done = tx.actions.filter((a) => a.state === 'done');
  const failed = tx.actions.filter((a) => a.state !== 'done');
  const status = failed.length === 0 ? 'submitted' : done.length > 0 ? 'partial' : 'error';

  const lines = [`${label}: ${done.length}/${tx.actions.length} actions posted`];
  for (const a of done) {
    lines.push(`  ✓ ${a.id} (${a.kind}) ${prActionDetail(a) ?? a.result?.url ?? ''}`.trimEnd());
  }
  for (const a of failed) {
    lines.push(`  ✗ ${a.id} (${a.kind}) [${a.state}] ${a.error ?? ''}`.trimEnd());
  }

  let out = setStatus(fs.readFileSync(actionPath, 'utf8'), status);
  // Disarm only the flags whose action actually landed. One that failed stays
  // `true` so `prt recover` retries what the human asked for, rather than the
  // file quietly forgetting it was ever asked.
  for (const [kind, field] of [['update-branch', 'update-branch'], ['approve-workflows', 'trigger-ci']]) {
    if (done.some((a) => a.kind === kind)) out = setPrActionField(out, field, 'false');
  }
  out = appendLog(out, lines.join('\n'));
  writeAtomic(actionPath, out);
  if (status === 'submitted') archiveActionFile(ctx.root, repo, number);

  return {
    ok: status === 'submitted',
    status,
    message: lines.join('\n'),
    urls: done.map((a) => a.result?.url).filter(Boolean),
    txId: tx.txId,
  };
}
