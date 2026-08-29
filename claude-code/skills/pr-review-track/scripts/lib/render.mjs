// Generates the human-editable action file from the analysis plus (optionally)
// the findings a `pr-review` run produced.
//
// Everything the generator proposes is a proposal. The file always lands as
// `Status: draft`; the human is the only thing that turns it into `ready`.

import { parseDiff } from './diff.mjs';
import { THREAD_STATES, summarizeCounts, recommendEvent } from './analyze.mjs';
import { renderAsk, askHandlingLine, STATUSES, PR_ACTIONS_SECTION, RESOLVED_NOTES_SECTION, HUMAN_DOC_KEYS } from './actionfile.mjs';

const EVIDENCE_LABEL = {
  [THREAD_STATES.AWAITING_MY_REPLY]: 'the author replied and is waiting on me',
  [THREAD_STATES.RESOLVED_WITHOUT_CHANGE]: 'resolved, but I see no code change behind it — verify',
  [THREAD_STATES.RESOLVED_UNVERIFIED]: 'resolved — but nothing has checked whether the code actually changed',
  [THREAD_STATES.UNTOUCHED]: 'no reply, no code change at the anchor',
  [THREAD_STATES.CODE_CHANGED]: 'the code at the anchor changed',
  [THREAD_STATES.RESOLVED_WITH_CHANGE]: 'resolved and the code changed',
  [THREAD_STATES.RESOLVED_BY_ME]: 'I resolved this myself',
};

function fence(s) {
  return String(s ?? '').replace(/\r\n/g, '\n');
}

/**
 * Collapse the generator's own run-on blank lines, but never inside an ask or
 * answer block: those bodies are the human's bytes (or the model's answer to
 * them), and reflowing words nobody asked us to reflow is the failure this
 * whole mechanism exists to avoid.
 *
 * The placeholder is grown until it is absent from the text, so a body that
 * happens to contain the token cannot be spliced into a different block on the
 * way back — that would silently truncate a comment that was going to be posted.
 */
function squeezeOutsideAsks(text) {
  let token = '@@PRTASK';
  while (text.includes(token)) token += 'X';
  const guarded = [];
  const masked = text.replace(/<!-- prt:(ask|answer)\n[\s\S]*?\n<!-- \/prt -->/g, (m) => {
    guarded.push(m);
    return `${token}${guarded.length - 1}@@`;
  });
  const squeezed = masked.replace(/\n{4,}/g, '\n\n\n');
  if (!guarded.length) return squeezed;
  return squeezed.replace(new RegExp(`${token.replace(/[@$]/g, '\\$&')}(\\d+)@@`, 'g'), (_, k) => guarded[Number(k)]);
}

function quote(s, max = 12) {
  const lines = fence(s).split('\n');
  const head = lines.slice(0, max);
  const out = head.map((l) => `> ${l}`).join('\n');
  return lines.length > max ? `${out}\n> …(${lines.length - max} more lines)` : out;
}

function ago(iso) {
  if (!iso) return 'never';
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h ago`;
  return `${Math.round(days)}d ago`;
}

/** Top-level Maven/Gradle modules a diff touches — cheap Pulsar-specific context. */
export function modulesOf(paths) {
  const mods = new Set();
  for (const p of paths) {
    const first = p.split('/')[0];
    if (first) mods.add(first);
  }
  return [...mods].sort();
}

/** The id the generator will give finding `f` at index `i`. Shared with carry-over. */
export function inlineIdFor(f, i) {
  return f.id || `i${i + 1}`;
}

/**
 * Every block id the next generation of the file will contain.
 *
 * Carry-over needs this to tell "your target survived" from "your target is
 * gone". Deriving it here — from the same filters the renderer uses — keeps one
 * source of truth; computing it separately in prt.mjs is how thread-bound notes
 * ended up orphaned on every single draft.
 */
export function expectedBlockIds({ analysis, findings }) {
  const ids = new Set(['verdict', 'body', 'general', 'gone']);
  const anchors = new Map();
  (findings?.findings ?? []).forEach((f, i) => {
    const id = inlineIdFor(f, i);
    ids.add(id);
    if (f.path) anchors.set(id, { path: f.path, line: f.line, side: f.side ?? 'RIGHT' });
  });
  const actionableThreads = (analysis?.threads ?? []).filter((t) => t.state !== THREAD_STATES.RESOLVED_BY_ME);
  actionableThreads.forEach((_, i) => ids.add(`t${i + 1}`));
  const discussionAssessments = new Map(
    (findings?.issueCommentAssessments ?? []).map((x) => [String(x.url ?? ''), x]),
  );
  (analysis?.newIssueComments ?? [])
    .filter((c) => discussionAssessments.get(String(c.url ?? ''))?.reply?.trim())
    .forEach((_, i) => ids.add(`c${i + 1}`));
  return { ids, anchors };
}

export function renderActionFile({
  repo,
  analysis,
  delta,
  findings,
  kind,
  generation = 1,
  diffFingerprint,
  baseOid,
  reviewerLogin,
  requireExplicitApprove = true,
  carriedAsks = [],
  carriedAnswers = [],
  askChanges = [],
  carriedDoc = {},
}) {
  // An OPEN ask is rendered beside whatever it is about: a note on inline i7 is
  // unjudgeable away from i7's text. Orphans get their own section, since they
  // have no target left to sit beside.
  //
  // A RESOLVED one has already been acted on, so it no longer needs its target
  // beside it — it goes to the `## Resolved notes` log at the end, one line of
  // disposition each. That split is exhaustive by construction (`askState`
  // returns exactly one of open/deferred, which are open, and
  // addressed/declined/withdrawn, which are not), so every carried ask reaches
  // the file: the ones that are open through `emitted` plus the unplaced sweep,
  // the rest through the log. A note that is rendered nowhere is a note
  // destroyed, and neither half can drop one silently.
  //
  // The test is `open === false`, not `!open`: an ask that reached here without
  // a derived state must fall on the open side. A note wrongly left open is
  // noise; a note wrongly filed is one the human stops being asked about.
  const emitted = new Set();
  const resolvedAsks = carriedAsks.filter((a) => a.open === false);
  const asksFor = (target) => carriedAsks.filter((a) => a.open !== false && a.re === target);
  const answersFor = (askId) => carriedAnswers.filter((x) => x.to === askId);
  const emitAsks = (out, target) => {
    for (const a of asksFor(target)) {
      emitted.add(a.id);
      out.push(renderAsk(a, answersFor(a.id)));
      out.push('');
    }
  };
  const a = analysis;
  const rec = recommendEvent(a);
  const proposed = findings?.recommendedEvent ?? rec.event;
  // APPROVE is not written into the file automatically: the human types it.
  // That is `requireExplicitApprove`, which defaults to true — it is a config
  // key rather than a hard-coded rule, so the sentence is about the shipped
  // default, and a store that turns it off gets a generated `event: APPROVE`.
  // (The model is separately forbidden to write one; SKILL.md invariant 3.)
  const event = requireExplicitApprove && proposed === 'APPROVE' ? 'COMMENT' : proposed;

  const deltaFiles = delta?.diff ? parseDiff(delta.diff) : null;
  const deltaPaths = deltaFiles ? [...deltaFiles.values()].map((f) => f.path) : [];

  const out = [];
  out.push('Status: draft');
  out.push('');
  out.push(`# ${repo}#${a.number} — ${a.title}`);
  out.push('');
  out.push(`<${a.url}>`);
  out.push('');
  out.push('<!-- prt:doc');
  out.push('schema: 1');
  out.push(`repo: ${repo}`);
  out.push(`pr: ${a.number}`);
  out.push(`kind: ${kind}`);
  out.push(`generation: ${generation}`);
  out.push(`generated: ${new Date().toISOString()}`);
  out.push(`reviewer: ${reviewerLogin}`);
  out.push(`head: ${a.headOid}`);
  out.push(`base-ref: ${a.baseRefName}`);
  if (baseOid) out.push(`base: ${baseOid}`);
  if (diffFingerprint) out.push(`diff-fingerprint: ${diffFingerprint}`);
  if (a.myLastReview?.oid) out.push(`reviewed-at: ${a.myLastReview.oid}`);
  // The human's own acknowledgements, last, after everything measured. They
  // reach here already re-earned against this generation's outgoing text by
  // `carryDocHatches`; the allow-list is a second lock on the same door, so that
  // a caller handing the renderer a whole previous `prt:doc` cannot smuggle a
  // stale `head:` or `diff-fingerprint:` past the submitter's preflight. Every
  // key above comes from this call's own arguments — `carriedDoc` can add a
  // line here, and can never rewrite one of those.
  for (const key of HUMAN_DOC_KEYS) {
    if (carriedDoc[key] !== undefined) out.push(`${key}: ${carriedDoc[key]}`);
  }
  out.push('-->');
  out.push('');

  // ---------- context (never posted) ----------
  out.push('## Context');
  out.push('');
  out.push('<!-- prt:context -->');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Author | ${a.author} (${a.authorAssociation}) |`);
  out.push(`| Updated | ${ago(a.updatedAt)} |`);
  out.push(`| Size | +${a.additions} / -${a.deletions} across ${a.changedFiles} files |`);
  out.push(`| CI on head | ${a.ci ?? 'unknown'} |`);
  out.push(`| Review decision | ${a.reviewDecision ?? 'none'} |`);
  out.push(
    `| My last review | ${a.myLastReview ? `${a.myLastReview.state} at ${a.myLastReview.oid?.slice(0, 8)}, ${ago(a.myLastReview.submittedAt)}` : 'none'} |`,
  );
  out.push(`| Head moved since | ${a.headMoved ? `yes — ${delta?.commits?.length ?? '?'} new commit(s)` : 'no'} |`);
  out.push(`| My threads | ${summarizeCounts(a.threadCounts)} |`);
  if (a.labels.length) out.push(`| Labels | ${a.labels.join(', ')} |`);
  out.push('');

  if (delta?.error) {
    out.push(`> **No usable incremental diff.** ${delta.error}`);
    out.push('>');
    out.push('> There is no "what changed since I looked" for this PR — treat it as a full re-review,');
    out.push('> and do not read a thread being `isOutdated` as evidence the author addressed it: a');
    out.push('> rebase marks threads outdated without anyone touching the code they point at.');
    out.push('');
  }

  if (delta?.commits?.length) {
    out.push(`**${delta.commits.length} commit(s) since my review at \`${a.myLastReview?.oid?.slice(0, 8)}\`:**`);
    out.push('');
    for (const c of delta.commits.slice(0, 20)) {
      out.push(`- \`${c.oid.slice(0, 8)}\` ${c.message} — ${c.author}`);
    }
    if (delta.commits.length > 20) out.push(`- …and ${delta.commits.length - 20} more`);
    out.push('');
  }
  if (deltaPaths.length) {
    out.push(`**Files changed since my review** (modules: ${modulesOf(deltaPaths).join(', ')}):`);
    out.push('');
    for (const p of deltaPaths.slice(0, 40)) out.push(`- \`${p}\``);
    if (deltaPaths.length > 40) out.push(`- …and ${deltaPaths.length - 40} more`);
    out.push('');
  }
  if (a.newIssueComments.length) {
    out.push(`**${a.newIssueComments.length} new conversation comment(s) since my review:**`);
    out.push('');
    for (const c of a.newIssueComments.slice(0, 6)) {
      out.push(`- **${c.author}** (${ago(c.createdAt)}) — <${c.url}>`);
      out.push(quote(c.body, 6).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    out.push('');
  }
  if (a.newReviewsByOthers.length) {
    const summary = a.newReviewsByOthers.map((r) => `${r.author}: ${r.state}`).join(', ');
    out.push(`**Reviews by others since mine:** ${summary}`);
    out.push('');
  }
  if (findings?.reviewers) {
    out.push(`**Draft produced by:** ${findings.reviewers.join(' · ')}${findings.coverage ? ` (${findings.coverage})` : ''}`);
    out.push('');
  }
  out.push('<!-- /prt -->');
  out.push('');

  // ---------- verdict ----------
  out.push('## Verdict');
  out.push('');
  out.push('<!-- prt:verdict');
  out.push(`event: ${event}`);
  out.push('-->');
  out.push('');
  out.push(`Recommended: **${proposed}** — ${findings?.recommendedEventWhy ?? rec.why}.`);
  if (proposed === 'APPROVE' && requireExplicitApprove) {
    out.push('');
    out.push('> The generator never writes `APPROVE` on its own. To approve, set `event: APPROVE`');
    out.push('> in the block above, review the whole file, and set line 1 to `Status: ready`.');
  }
  out.push('');
  out.push('Valid values: `APPROVE`, `REQUEST_CHANGES`, `COMMENT`, `REPLY` (file-thread replies only; no resolution or completed review), `NONE` (no review).');
  out.push('');
  out.push('*Not happy with this call, or want something answered before you arm it? Type* `@ai verdict …` *below — it is never posted.*');
  out.push('');
  emitAsks(out, 'verdict');

  // ---------- PR-level actions ----------
  // Written `false` every time, like `event:` is never written APPROVE: both
  // are writes to the pull request, so the human types the word. A merged PR
  // has no branch left to update and no CI left to release, so it gets no
  // block at all — the same rule `ensurePrActions` backfills under.
  if (!a.merged) {
    out.push(...PR_ACTIONS_SECTION);
    out.push('');
    emitAsks(out, 'pr-actions');
  }

  // ---------- review body ----------
  out.push('## Review summary');
  out.push('');
  out.push('*Posted as the top comment of the review. Edit freely; delete the text to post no summary.*');
  out.push('');
  out.push('<!-- prt:body -->');
  out.push('');
  out.push(findings?.summary?.trim() || defaultSummary(a, delta));
  out.push('');
  out.push('<!-- /prt -->');
  out.push('');
  emitAsks(out, 'body');

  // ---------- threads ----------
  const actionableThreads = a.threads.filter((t) => t.state !== THREAD_STATES.RESOLVED_BY_ME);
  if (actionableThreads.length) {
    out.push('## My open threads');
    out.push('');
    out.push('*One block per thread I own. `post: false` skips it; `resolve: yes` resolves it after replying.*');
    out.push('');
    const assessments = new Map((findings?.threadAssessments ?? []).map((x) => [x.threadId, x]));
    let n = 0;
    for (const t of actionableThreads) {
      n += 1;
      const assess = assessments.get(t.id);
      const loc = `${t.path.split('/').pop()}:${t.line ?? '?'}`;
      out.push(`### thread ${n} — ${loc} — ${t.state}`);
      out.push('');
      out.push(`\`${t.path}\`${t.line ? `:${t.line}` : ''} · ${EVIDENCE_LABEL[t.state] ?? t.state}`);
      out.push('');
      if (assess?.evidence?.length) {
        out.push('Evidence:');
        for (const e of assess.evidence) out.push(`- ${e}`);
        out.push('');
      }
      if (assess?.assessment) {
        out.push(`Assessment: **${assess.assessment}**${assess.why ? ` — ${assess.why}` : ''}`);
        out.push('');
      }
      if (t.myLastComment) {
        out.push('<details><summary>What I said</summary>');
        out.push('');
        out.push(quote(t.myLastComment.body, 20));
        out.push('');
        out.push('</details>');
        out.push('');
      }
      if (t.lastComment && t.lastComment.author !== reviewerLogin) {
        out.push(`Last reply — **${t.lastComment.author}**, ${ago(t.lastComment.createdAt)}:`);
        out.push('');
        out.push(quote(t.lastComment.body, 20));
        out.push('');
      }
      out.push(`<!-- prt:thread`);
      out.push(`id: t${n}`);
      out.push(`post: ${assess?.reply || assess?.resolve ? 'true' : 'false'}`);
      out.push(`thread: ${t.id}`);
      if (t.replyToCommentId) out.push(`reply-to: ${t.replyToCommentId}`);
      out.push(`resolve: ${assess?.resolve ? 'yes' : 'no'}`);
      out.push(`expect-resolved: ${t.isResolved ? 'yes' : 'no'}`);
      if (t.lastCommentId) out.push(`expect-last-comment: ${t.lastCommentId}`);
      if (t.lastComment) out.push(`# last comment seen: ${t.lastComment.author} at ${t.lastComment.createdAt}`);
      out.push('-->');
      out.push('');
      out.push(assess?.reply?.trim() || '');
      out.push('');
      out.push('<!-- /prt -->');
      out.push('');
      emitAsks(out, `t${n}`);
    }
  }

  // ---------- ordinary PR conversation replies ----------
  const discussionAssessments = new Map(
    (findings?.issueCommentAssessments ?? []).map((x) => [String(x.url ?? ''), x]),
  );
  const discussionReplies = a.newIssueComments
    .map((comment) => ({ comment, assessment: discussionAssessments.get(String(comment.url ?? '')) }))
    .filter(({ assessment }) => assessment?.reply?.trim());
  if (discussionReplies.length) {
    out.push('## PR conversation replies');
    out.push('');
    out.push('*Ordinary PR comments. Posted with `APPROVE`, `REQUEST_CHANGES`, `COMMENT`, or `NONE`; deferred by `REPLY`.*');
    out.push('');
    let n = 0;
    for (const { comment, assessment } of discussionReplies) {
      n += 1;
      out.push(`### conversation reply ${n} — ${comment.author}`);
      out.push('');
      out.push(`In response to <${comment.url}>:`);
      out.push('');
      out.push(quote(comment.body, 20));
      out.push('');
      if (assessment.why) out.push(`Reason: ${assessment.why}`, '');
      out.push('<!-- prt:issue-comment');
      out.push(`id: c${n}`);
      out.push('-->');
      out.push(assessment.reply.trim());
      out.push('<!-- /prt -->');
      out.push('');
      emitAsks(out, `c${n}`);
    }
  }

  // ---------- new inline comments ----------
  const items = findings?.findings ?? [];
  out.push('## Inline comments');
  out.push('');
  if (items.length) {
    out.push('*One block per comment. `post: false` keeps it as a note without posting it.*');
    out.push('');
  } else {
    out.push('*No inline comments drafted. To add one, copy the template below and remove the*');
    out.push('*two leading spaces from the sentinel lines — a sentinel only counts at column 0.*');
    out.push('');
    out.push('```');
    out.push('  <!-- prt:inline');
    out.push('  id: i1');
    out.push('  post: true');
    out.push('  subject: line          # line | range | file');
    out.push('  path: path/to/File.java');
    out.push('  line: 123              # for a range, add start-line: 118');
    out.push('  side: RIGHT            # RIGHT = added/context, LEFT = removed');
    out.push('  -->');
    out.push('  **[BUG] one-line claim**');
    out.push('');
    out.push('  Why it breaks, and the failing input.');
    out.push('  <!-- /prt -->');
    out.push('```');
    out.push('');
    out.push('Run `prt anchors ' + a.number + '` to list every line this PR\'s diff allows a comment on.');
    out.push('');
  }
  items.forEach((f, i) => {
    const id = inlineIdFor(f, i);
    const loc = f.path ? `${f.path.split('/').pop()}:${f.line ?? '?'}` : 'general';
    out.push(`### inline ${i + 1} — ${loc}`);
    out.push('');
    const meta = [f.confidence && `confidence ${f.confidence}`, f.agreement && `raised by ${f.agreement}`, f.crossValidation]
      .filter(Boolean)
      .join(' · ');
    if (meta) {
      out.push(`*${meta}*`);
      out.push('');
    }
    out.push('<!-- prt:inline');
    out.push(`id: ${id}`);
    out.push(`post: ${f.post === false ? 'false' : 'true'}`);
    if (f.droppedBy) out.push(`dropped-by: ${f.droppedBy}`);
    out.push(`subject: ${f.subject || (f.endLine ? 'range' : f.line ? 'line' : 'file')}`);
    out.push(`path: ${f.path}`);
    if (f.endLine && f.line) {
      out.push(`start-line: ${Math.min(f.line, f.endLine)}`);
      out.push(`line: ${Math.max(f.line, f.endLine)}`);
    } else if (f.line) {
      out.push(`line: ${f.line}`);
    }
    out.push(`side: ${f.side || 'RIGHT'}`);
    if (f.startSide && f.startSide !== (f.side || 'RIGHT')) out.push(`start-side: ${f.startSide}`);
    out.push('-->');
    out.push('');
    out.push(`**[${f.severity ?? 'NOTE'}] ${f.claim ?? ''}**`.replace(/\*\*\s*\*\*/, ''));
    out.push('');
    out.push(fence(f.body).trim());
    out.push('');
    out.push('<!-- /prt -->');
    out.push('');
    emitAsks(out, id);
  });

  // ---------- notes with no home above ----------
  // Anything not already placed lands here: orphans, general notes, and — the
  // reason this is a sweep rather than two fixed targets — a note bound to a
  // block kind this function has not been taught to place. A note rendered
  // nowhere is a note destroyed, and that must not be possible by omission.
  const unplaced = carriedAsks.filter((a) => a.open !== false && !emitted.has(a.id));
  if (unplaced.length) {
    const orphans = unplaced.filter((a) => a.re === 'gone');
    out.push('## Notes to the assistant');
    out.push('');
    if (orphans.length) {
      out.push('> **The comment these were about is no longer in the draft.** If an earlier round');
      out.push('> already posted it, the note still applies to what is on GitHub — check `outbox/`');
      out.push('> before deciding it is moot.');
      out.push('');
    }
    for (const a of unplaced) {
      emitted.add(a.id);
      out.push(renderAsk(a, answersFor(a.id)));
      out.push('');
    }
  }

  // ---------- dropped ----------
  if (findings?.dropped?.length) {
    out.push('## Considered and dropped');
    out.push('');
    out.push('<!-- prt:notes -->');
    out.push('');
    for (const d of findings.dropped) out.push(`- **${d.claim}** — ${d.reason}`);
    out.push('');
    out.push('<!-- /prt -->');
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('*Set `Status: ready` on line 1 to post everything above that has `post: true`.*');
  out.push('*`Status: hold` parks this file so re-review will not regenerate it. `Status: skip` drops the PR.*');
  const stillOpen = carriedAsks.filter((x) => x.open);
  if (stillOpen.length) {
    const blocking = stillOpen.filter((x) => x.blocking);
    out.push('');
    out.push(`*${stillOpen.length} open note(s) to the assistant: ${stillOpen.map((x) => x.id).join(', ')}.${blocking.length ? ` ${blocking.length} of them will refuse a submit until answered.` : ''}*`);
  }
  // The footer names the log by its heading. The human asked for "the log at the
  // end of the file", and the file also ends with the submitter's `## Activity
  // log`, so the one pointer that matters is the one that says which is which.
  if (resolvedAsks.length) {
    out.push('');
    out.push(`*${resolvedAsks.length} note(s) already handled: ${resolvedAsks.map((x) => x.id).join(', ')} — see \`## Resolved notes\` below.*`);
  }
  out.push('');

  // ---------- the resolved-note log ----------
  // Last, so the top of the file is the work still to do. Deliberately not
  // collapsed behind `<details>`: the section is bounded to two generations by
  // `carryAsks`' `keepClosedFor`, the handling line is already the collapsed
  // view, and the material that decides whether to arm the review lands in the
  // answer body — burying that under a disclosure widget below the footer is
  // exactly the reading this section exists to make easy.
  if (resolvedAsks.length) {
    out.push(...RESOLVED_NOTES_SECTION);
    out.push('');
    for (const a of resolvedAsks) {
      emitted.add(a.id);
      out.push(askHandlingLine(a, answersFor(a.id)));
      out.push('');
      out.push(renderAsk(a, answersFor(a.id)));
      out.push('');
    }
  }

  return `${squeezeOutsideAsks(out.join('\n'))}\n`;
}

function defaultSummary(a, delta) {
  const lines = [];
  if (a.headMoved && delta?.commits?.length) {
    lines.push(`Re-reviewed at \`${a.headOid.slice(0, 8)}\` (${delta.commits.length} commit(s) since my last pass).`);
  }
  const untouched = a.threadCounts[THREAD_STATES.UNTOUCHED] ?? 0;
  const unresolved = a.threadCounts[THREAD_STATES.RESOLVED_WITHOUT_CHANGE] ?? 0;
  if (untouched + unresolved > 0) {
    lines.push('');
    lines.push(`${untouched + unresolved} of the points I raised still look open — see the inline threads.`);
  }
  return lines.length ? lines.join('\n') : '';
}

/**
 * Attention buckets, most urgent first. Ordering here is the ordering on the
 * board, so the list a maintainer reads top-down is already prioritised.
 */
export const BUCKETS = [
  'my-queue',                  // a file of mine is ready / blocked / partial — finish it
  'author-replied-to-me',      // the sharpest signal: someone is waiting on my answer
  'resolved-without-change',   // marked done with no code behind it — verify before trusting
  'resolved-unverified',       // marked done, and nobody has looked at whether that is true
  'new-commits-to-check',      // head moved since my review
  'ready-to-approve',          // every point I raised has a change behind it
  'nudge-due',                 // unanswered for days, and I have been quiet too
  'waiting-for-author',        // my points are still open and untouched
  'ci-blocking',               // red CI: the author still has work
  'stale',                     // nobody has touched it in months
  'parked',                    // hold / skip
];

export const STALE_AFTER_DAYS = 120;

export function bucketOf({ analysis: a, status, staleAfterDays = STALE_AFTER_DAYS }) {
  if (status === 'hold' || status === 'skip') return 'parked';
  if (['ready', 'queued', 'partial', 'blocked', 'error'].includes(status)) return 'my-queue';

  const c = a.threadCounts ?? {};
  const idleDays = a.updatedAt ? (Date.now() - Date.parse(a.updatedAt)) / 86400000 : 0;

  if ((c[THREAD_STATES.AWAITING_MY_REPLY] ?? 0) > 0) {
    // A years-old PR nobody has touched is not really waiting on me.
    return idleDays > staleAfterDays ? 'stale' : 'author-replied-to-me';
  }
  if ((c[THREAD_STATES.RESOLVED_WITHOUT_CHANGE] ?? 0) > 0) return 'resolved-without-change';
  // "Resolved" with no delta fetched is not evidence of anything. It must never
  // fall through to ready-to-approve just because nothing contradicted it.
  if ((c[THREAD_STATES.RESOLVED_UNVERIFIED] ?? 0) > 0 && idleDays <= staleAfterDays) return 'resolved-unverified';
  if (idleDays > staleAfterDays) return 'stale';
  if (a.headMoved) return 'new-commits-to-check';
  if (a.ci === 'FAILURE' || a.ci === 'ERROR') return 'ci-blocking';
  if (a.nudge?.due) return 'nudge-due';
  if ((c[THREAD_STATES.UNTOUCHED] ?? 0) > 0) return 'waiting-for-author';
  if (a.threads?.length) return 'ready-to-approve';
  return 'waiting-for-author';
}

/**
 * Statuses that mean the review file is done with: `submitted` posted
 * everything that was approved, `skip` decided this PR is not being reviewed.
 * Everything else — including a status added to STATUSES later, and including
 * text nobody recognises — counts as in progress, because the failure that
 * matters here is a half-written draft nobody can find again.
 */
const REVIEW_SETTLED_STATUSES = new Set(['submitted', 'skip']);

/** The statuses `reviews in progress` collects, derived from the one status list. */
export const REVIEW_IN_PROGRESS_STATUSES = STATUSES.filter((s) => !REVIEW_SETTLED_STATUSES.has(s));

/** True when a review.md exists for this PR and is neither finished nor abandoned. */
export function isReviewInProgress(status) {
  return !!status && status !== 'none' && !REVIEW_SETTLED_STATUSES.has(status);
}

/**
 * The attention board.
 *
 * Rows that still have an unfinished `review.md` link to it twice over: the
 * status cell in the bucket table becomes the link, and the same rows are
 * gathered into a section of their own at the top. The section is the point —
 * a started-but-unfinished draft scattered across eleven buckets is a review
 * that gets forgotten, and this file exists to stop exactly that.
 *
 * Links are relative to the board's own directory, so they resolve in an editor
 * without baking anyone's home directory into generated markdown.
 */
export function renderBoard({ repo, rows, generatedAt = new Date().toISOString(), storeDir = null, archived = [] }) {
  const ordered = [...rows].sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0));
  // A path is only a link when the file behind it is still live work.
  const draftLink = (r) => (r.reviewPath && isReviewInProgress(r.status) ? r.reviewPath : null);
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|');
  const title = (r) => cell(r.title).slice(0, 80);

  const out = [
    `# ${repo} — review board`,
    '',
    `_Generated ${generatedAt} · ${ordered.length} tracked PR(s). Do not edit; \`prt sync\` rewrites this file._`,
    '',
  ];

  // Unfinished means either half: a draft file that is not done with, or a job
  // that has not finished. The second half is the queue's whole point — work
  // that is running has no `review.md` yet, and a review nobody can see is
  // precisely what this section exists to prevent.
  const jobCell = (r) => (r.job
    ? `${r.job.kind} ${r.job.state}${r.job.attempts > 1 ? ` (attempt ${r.job.attempts})` : ''}${r.job.lastError ? ` — ${cell(r.job.lastError)}` : ''}`
    : '');
  const inProgress = ordered.filter((r) => draftLink(r) || r.job);
  if (inProgress.length) {
    out.push(`## reviews in progress (${inProgress.length})`, '');
    out.push('_Reviews I started and have not finished: a `review.md` exists and its status is');
    out.push(`neither \`submitted\` nor \`skip\`, or a job for it is queued, running or failed.${storeDir ? ` Links are relative to \`${storeDir}\`.` : ''}_`);
    out.push('');
    // The author is here for the same reason it is in every bucket table: whose
    // PR it is decides how a half-finished review gets picked back up.
    out.push('| PR | status | job | author | draft | bucket | title |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of inProgress) {
      const link = draftLink(r) ? `[review.md](${draftLink(r)})` : '—';
      out.push(`| [#${r.number}](${r.url}) | \`${r.status}\` | ${jobCell(r)} | ${r.author ?? '?'} | ${link} | ${r.bucket} | ${title(r)} |`);
    }
    out.push('');
  }

  for (const bucket of BUCKETS) {
    const inBucket = ordered.filter((r) => r.bucket === bucket);
    if (!inBucket.length) continue;
    out.push(`## ${bucket} (${inBucket.length})`, '');
    out.push('| PR | status | author | threads | CI | title |');
    out.push('|---|---|---|---|---|---|');
    for (const r of inBucket) {
      const href = draftLink(r);
      const status = href ? `[\`${r.status}\`](${href})` : `\`${r.status}\``;
      out.push(`| [#${r.number}](${r.url}) | ${status} | ${r.author ?? '?'} | ${r.threads ?? ''} | ${r.ci ?? '?'} | ${title(r)} |`);
    }
    out.push('');
  }

  const closed = ordered.filter((r) => r.prState && r.prState !== 'OPEN');
  if (closed.length) {
    out.push(`## closed or merged — run \`prt cleanup\` (${closed.length})`, '');
    // An unfinished draft on a closed PR is the one thing `cleanup` would
    // archive away, so it gets its link here too rather than only above.
    for (const r of closed) {
      const href = draftLink(r);
      out.push(`- [#${r.number}](${r.url}) ${r.prState} — ${r.title}${href ? ` — unfinished draft: [review.md](${href})` : ''}`);
    }
    out.push('');
  }

  // A count, not a list: the archive accumulates every PR cleanup has ever
  // taken, and the board is for what is still live. Enough to remember that
  // something was set aside, and to say how to get it back.
  if (archived.length) {
    out.push(
      `_${archived.length} archived PR(s) not shown — \`prt archive --list\` to see them, ` +
        '`prt unarchive <N>` to bring one back._',
      '',
    );
  }

  return out.join('\n');
}


/**
 * A reminder for an author who has not responded to points I raised.
 *
 * The default wording matters more than the mechanism. This is an Apache
 * project full of volunteers: a nudge that reads as chasing costs goodwill that
 * a review cannot buy back. So the draft names the specific open points rather
 * than pinging, assumes the author simply has not got to it, and offers a way
 * out that is not "do the work" — including handing it back to me. The human
 * edits it before it goes anywhere, as with every other action.
 */
export function renderNudgeFile({ repo, analysis, generation = 1, reviewerLogin, draftText = null, carriedAsks = [], carriedAnswers = [] }) {
  const a = analysis;
  const n = a.nudge ?? {};
  const out = [];

  out.push('Status: draft');
  out.push('');
  out.push(`# Nudge — ${repo}#${a.number}`);
  out.push('');
  out.push(`${a.title}`);
  out.push('');
  out.push(`<${a.url}>`);
  out.push('');
  out.push('<!-- prt:doc');
  out.push('schema: 1');
  out.push(`repo: ${repo}`);
  out.push(`pr: ${a.number}`);
  out.push('kind: nudge');
  out.push(`generation: ${generation}`);
  out.push(`generated: ${new Date().toISOString()}`);
  out.push(`reviewer: ${reviewerLogin}`);
  out.push(`head: ${a.headOid}`);
  out.push(`base-ref: ${a.baseRefName}`);
  out.push('-->');
  out.push('');

  out.push('## Why this is being proposed');
  out.push('');
  out.push('<!-- prt:context -->');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Author | ${a.author} (${a.authorAssociation}) |`);
  out.push(`| Unanswered points | ${n.untouchedCount ?? 0} |`);
  out.push(`| Oldest one | ${n.oldestUntouchedDays ?? '?'} days |`);
  out.push(`| Last thing I said here | ${n.daysSinceMyLastWord ?? '?'} days ago |`);
  out.push(`| Head moved since my review | ${a.headMoved ? 'yes' : 'no'} |`);
  out.push('');
  out.push('The points with no reply and no code change at the anchor:');
  out.push('');
  for (const t of n.threads ?? []) {
    out.push(`- \`${t.path}\`${t.line ? `:${t.line}` : ''} — ${t.days} days${t.url ? ` — <${t.url}>` : ''}`);
  }
  out.push('');
  out.push('> Check at least one of these yourself before arming this. An author who did');
  out.push('> reply somewhere this heuristic cannot see, or who answered in the PR body,');
  out.push('> should not receive a reminder.');
  out.push('');
  out.push('<!-- /prt -->');
  out.push('');

  out.push('## The comment');
  out.push('');
  out.push('*Posted as a single conversation comment — one notification rather than one per thread.*');
  out.push('');
  out.push('<!-- prt:issue-comment');
  out.push('id: nudge');
  out.push('post: true');
  out.push('-->');
  out.push('');
  out.push(draftText?.trim() || defaultNudgeText(a, n));
  out.push('');
  out.push('<!-- /prt -->');
  out.push('');

  // A nudge overwrites whatever draft was here, so any notes the human left on
  // it are carried across rather than destroyed. Same split as the review
  // renderer, and for the same reason: if the two disagreed about where a
  // resolved note lives, a nudge would silently pull one back up the file.
  const answersFor = (askId) => carriedAnswers.filter((x) => x.to === askId);
  const openAsks = carriedAsks.filter((x) => x.open !== false);
  const resolvedAsks = carriedAsks.filter((x) => x.open === false);
  if (openAsks.length) {
    out.push('## Notes to the assistant');
    out.push('');
    out.push('*Carried over from the review draft this reminder replaced. Never posted.*');
    out.push('');
    for (const ask of openAsks) {
      out.push(renderAsk(ask, answersFor(ask.id)));
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('*`Status: ready` posts the comment above. `Status: skip` drops it and stops this PR');
  out.push('being proposed again until something changes.*');
  out.push('');

  if (resolvedAsks.length) {
    out.push(...RESOLVED_NOTES_SECTION);
    out.push('');
    for (const ask of resolvedAsks) {
      out.push(askHandlingLine(ask, answersFor(ask.id)));
      out.push('');
      out.push(renderAsk(ask, answersFor(ask.id)));
      out.push('');
    }
  }

  return `${squeezeOutsideAsks(out.join('\n'))}\n`;
}

function defaultNudgeText(a, n) {
  const items = (n.threads ?? []).map((t) => `- \`${t.path}\`${t.line ? `:${t.line}` : ''}${t.url ? ` — ${t.url}` : ''}`);
  const count = items.length;
  const noun = count === 1 ? 'one comment' : `${count} comments`;
  return [
    `Hi @${a.author} — gentle ping on this one. ${count === 1 ? 'There is' : 'There are'} still ${noun} from my review that ${count === 1 ? "hasn't" : "haven't"} been picked up:`,
    '',
    ...items,
    '',
    'No rush if you are busy — I mostly want to make sure it is not blocked on something I said, or waiting on an answer from me. If any of it is unclear or you disagree, say so and I will take another look; if you would rather someone else carried it forward, that is fine too.',
  ].join('\n');
}
