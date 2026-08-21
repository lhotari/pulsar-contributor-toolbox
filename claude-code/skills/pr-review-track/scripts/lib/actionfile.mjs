// Parser and writer for the human-editable action file (`review.md`).
//
// Invariants this format exists to protect:
//
//   1. NOTHING is posted unless it sits inside an explicit `<!-- prt:KIND -->`
//      block. Everything else in the file is context for the human.
//   2. Machine fields live INSIDE the HTML-comment sentinel; block bodies are
//      byte-for-byte free-form markdown. A body may contain `##` headings,
//      `---`, fenced code, YAML, or HTML comments of its own — the parser only
//      recognises a column-0 `<!-- prt:` / `<!-- /prt -->` line.
//   3. Line 1 is always `Status: <value>`, so a human, `sed -n 1p`, and the
//      watcher all read the gate the same way with no markdown parsing.
//   4. The submitter never edits an approved payload: it posts exactly the
//      bytes between the sentinels, or it refuses and explains why.

import { createHash } from 'node:crypto';

/** Line-1 gate values. Only `ready` authorises posting. */
export const STATUSES = [
  'draft',      // AI prepared it; the human is editing. Never acted on.
  'ready',      // human authorisation. The submitter may capture and post it.
  'queued',     // an immutable snapshot was captured; edits no longer affect this run.
  'partial',    // some approved actions posted, some did not. Needs reconciliation.
  'submitted',  // every approved action verified on GitHub.
  'blocked',    // a pre-flight check refused it. Nothing was posted.
  'error',      // posting failed before anything was posted.
  'hold',       // parked by the human. sync/re-review will not regenerate over it.
  'skip',       // the human decided not to review this PR.
];

/** Statuses whose file a generator must never overwrite. */
// `submitted` is deliberately NOT protected: the approved bytes and the posted
// URLs are preserved in history/ and outbox/, so the next round's draft has
// nothing to destroy. Protecting it would make `--force` a routine habit — and
// `--force` also overrides `ready` and `hold`, which must never be routine.
export const PROTECTED_STATUSES = new Set(['ready', 'queued', 'partial', 'hold', 'skip']);

/** Statuses that need reconciliation before cleanup may archive the PR. */
export const IN_FLIGHT_STATUSES = new Set(['queued', 'partial']);

/** Blocks that carry a free-form body and therefore need a `<!-- /prt -->`. */
const BODY_KINDS = new Set(['body', 'inline', 'thread', 'issue-comment', 'log', 'notes', 'context']);
/** Blocks that are attributes only; the opening sentinel is the whole block. */
const ATTR_KINDS = new Set(['doc', 'verdict']);

const OPEN_START = /^<!--\s*prt:([a-z][a-z-]*)\s*(.*)$/;
const CLOSE = /^<!--\s*\/prt\s*-->\s*$/;
const COMMENT_END = /-->\s*$/;

export function parseStatus(text) {
  const m = /^Status:\s*([A-Za-z-]+)/.exec((text.split('\n', 1)[0] ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

export function setStatus(text, status) {
  const lines = text.split('\n');
  if (/^Status:\s*/.test(lines[0] ?? '')) lines[0] = `Status: ${status}`;
  else lines.unshift(`Status: ${status}`);
  return lines.join('\n');
}

/** Parse the `key: value` lines inside a sentinel. Values are plain scalars. */
function parseSentinelFields(lines) {
  const fields = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === '-->') continue;
    const m = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fields[m[1].toLowerCase()] = v;
  }
  return fields;
}

/**
 * Tokenise the file into blocks.
 * Returns [{kind, fields, body, startLine, unterminated}]. Content outside any
 * block is discarded — by design.
 */
export function tokenize(text) {
  // The one sanctioned deviation from byte-for-byte: strip a BOM and normalise
  // CRLF to LF. A stray \r inside a ```suggestion block corrupts the code
  // GitHub offers to apply, and editors introduce them without being asked.
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = OPEN_START.exec(lines[i]);
    if (!m) { i++; continue; }
    const kind = m[1];
    const startLine = i + 1;
    const sentinelLines = [];
    let rest = m[2];
    // The sentinel may be one line (`<!-- prt:body -->`) or span lines until `-->`.
    if (COMMENT_END.test(rest)) {
      sentinelLines.push(rest.replace(COMMENT_END, ''));
      i++;
    } else {
      sentinelLines.push(rest);
      i++;
      while (i < lines.length && !COMMENT_END.test(lines[i])) {
        sentinelLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        sentinelLines.push(lines[i].replace(COMMENT_END, ''));
        i++;
      }
    }
    const fields = parseSentinelFields(sentinelLines);

    if (ATTR_KINDS.has(kind)) {
      out.push({ kind, fields, body: '', startLine, unterminated: false });
      continue;
    }
    const bodyLines = [];
    let closed = false;
    while (i < lines.length) {
      if (CLOSE.test(lines[i])) { closed = true; i++; break; }
      if (OPEN_START.test(lines[i])) break; // next block started: treat as unterminated
      bodyLines.push(lines[i]);
      i++;
    }
    out.push({ kind, fields, body: bodyLines.join('\n'), startLine, unterminated: !closed });
  }
  return out;
}

const TRUE_WORDS = new Set(['y', 'yes', 'true', '1', 'on']);
const FALSE_WORDS = new Set(['n', 'no', 'false', '0', 'off']);

/**
 * Booleans are strict on purpose. `post: ture` silently meaning `false` would
 * drop a comment the human believed was armed — in a tool whose whole contract
 * is "post exactly what was approved", a typo must stop the run, not change it.
 */
function truthy(v, dflt = false, onError = null, where = '') {
  if (v === undefined || v === '') return dflt;
  const t = String(v).trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  if (onError) onError(`${where}: "${v}" is not yes or no`);
  return dflt;
}

/**
 * A column-0 sentinel counts everywhere, including inside a fenced code block.
 * The usual symptom of tripping over that is a body whose ``` fences no longer
 * balance, so flag it rather than silently posting a truncated comment.
 */
function fenceWarning(body, where) {
  // CommonMark allows ~~~ fences and up to three leading spaces.
  const fences = (body.match(/^ {0,3}(?:```|~~~)/gm) ?? []).length;
  if (fences % 2 === 1) {
    return `${where}: unbalanced \`\`\` fence — a column-0 \`<!-- /prt -->\` inside a code block ends the block early. Indent it by one space to keep it as text.`;
  }
  return null;
}

function parseIntOrNull(v) {
  if (v === undefined || v === '') return null;
  return /^\d+$/.test(String(v).trim()) ? Number(v) : NaN;
}

/**
 * Parse a complete action file into the action plan the submitter executes.
 */
export function parseActionFile(text) {
  const r = {
    status: parseStatus(text),
    doc: {},
    event: null,
    body: null,
    inline: [],
    threads: [],
    issueComments: [],
    context: [],
    log: [],
    errors: [],
    warnings: [],
  };
  if (r.status === null) r.errors.push('line 1 must be `Status: <draft|ready|hold|skip>`');
  if (r.status && !STATUSES.includes(r.status)) r.errors.push(`unknown status "${r.status}"`);

  const bad = (msg) => r.errors.push(msg);
  const seenIds = new Set();
  const claimId = (id, where) => {
    if (!id) { r.errors.push(`${where}: missing \`id:\``); return; }
    if (seenIds.has(id)) r.errors.push(`${where}: duplicate id "${id}"`);
    seenIds.add(id);
  };

  for (const b of tokenize(text)) {
    const where = `<!-- prt:${b.kind} --> at line ${b.startLine}`;
    if (b.unterminated && BODY_KINDS.has(b.kind)) {
      r.errors.push(`${where} is missing its \`<!-- /prt -->\` terminator`);
      continue;
    }
    switch (b.kind) {
      case 'doc':
        r.doc = b.fields;
        break;

      case 'verdict': {
        const e = (b.fields.event || '').toUpperCase();
        if (!e) r.errors.push(`${where}: missing \`event:\``);
        else if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'NONE'].includes(e)) {
          r.errors.push(`${where}: event must be APPROVE, REQUEST_CHANGES, COMMENT or NONE (got "${e}")`);
        } else r.event = e;
        break;
      }

      case 'body': {
        r.body = b.body.trim() || null;
        const w = r.body && fenceWarning(r.body, where);
        if (w) r.warnings.push(w);
        break;
      }

      case 'issue-comment': {
        const body = b.body.trim();
        claimId(b.fields.id, where);
        if (truthy(b.fields.post, true, bad, `${where} post`) && body) {
          r.issueComments.push({ id: b.fields.id, body, startLine: b.startLine });
        }
        break;
      }

      case 'inline': {
        claimId(b.fields.id, where);
        const line = parseIntOrNull(b.fields.line);
        const startLine = parseIntOrNull(b.fields['start-line']);
        const c = {
          id: b.fields.id,
          post: truthy(b.fields.post, true, bad, `${where} post`),
          subject: (b.fields.subject || (b.fields.line ? 'line' : 'file')).toLowerCase(),
          path: b.fields.path || null,
          line,
          startLine,
          side: (b.fields.side || 'RIGHT').toUpperCase(),
          startSide: (b.fields['start-side'] || b.fields.side || 'RIGHT').toUpperCase(),
          onAnchorFail: (b.fields['on-anchor-fail'] || 'block').toLowerCase(),
          body: b.body.replace(/^\n+/, '').replace(/\s+$/, ''),
          sourceLine: b.startLine,
        };
        if (c.post) {
          if (!c.path) r.errors.push(`${where}: missing \`path:\``);
          if (!c.body) r.errors.push(`${where}: empty comment body`);
          if (!['LEFT', 'RIGHT'].includes(c.side)) r.errors.push(`${where}: \`side:\` must be LEFT or RIGHT`);
          if (!['file', 'line', 'range'].includes(c.subject)) r.errors.push(`${where}: \`subject:\` must be file, line or range`);
          if (c.subject !== 'file') {
            if (Number.isNaN(c.line) || c.line === null) r.errors.push(`${where}: \`line:\` must be a line number`);
          }
          if (c.subject === 'range') {
            if (Number.isNaN(c.startLine) || c.startLine === null) r.errors.push(`${where}: range needs \`start-line:\``);
            else if (c.line !== null && c.startLine > c.line) r.errors.push(`${where}: \`start-line:\` must be <= \`line:\``);
          }
          if (!['block', 'demote', 'drop'].includes(c.onAnchorFail)) {
            r.errors.push(`${where}: \`on-anchor-fail:\` must be block, demote or drop`);
          }
          const w = fenceWarning(c.body, where);
          if (w) r.warnings.push(w);
        }
        r.inline.push(c);
        break;
      }

      case 'thread': {
        claimId(b.fields.id, where);
        const t = {
          id: b.fields.id,
          post: truthy(b.fields.post, true, bad, `${where} post`),
          threadNodeId: b.fields.thread || null,
          // REST integer id of the thread's FIRST comment, kept as a string.
          replyToCommentId: b.fields['reply-to'] || null,
          resolve: truthy(b.fields.resolve, false, bad, `${where} resolve`),
          unresolve: truthy(b.fields.unresolve, false, bad, `${where} unresolve`),
          expectResolved: b.fields['expect-resolved'] === undefined ? null : truthy(b.fields['expect-resolved'], false, bad, `${where} expect-resolved`),
          expectLastCommentId: b.fields['expect-last-comment'] || null,
          body: b.body.replace(/^\n+/, '').replace(/\s+$/, ''),
          sourceLine: b.startLine,
        };
        if (t.post) {
          if (!t.threadNodeId) r.errors.push(`${where}: missing \`thread:\` node id`);
          if (t.body && !t.replyToCommentId) r.errors.push(`${where}: has a reply body but no \`reply-to:\` comment id`);
          if (t.resolve && t.unresolve) r.errors.push(`${where}: both \`resolve:\` and \`unresolve:\` are set`);
          if (!t.body && !t.resolve && !t.unresolve) t.post = false; // nothing to do
          const w = t.body && fenceWarning(t.body, where);
          if (w) r.warnings.push(w);
        }
        r.threads.push(t);
        break;
      }

      case 'context':
      case 'notes':
        r.context.push(b.body.trim());
        break;

      case 'log':
        r.log.push(b.body.trim());
        break;

      default:
        r.warnings.push(`ignoring unknown block \`<!-- prt:${b.kind} -->\` at line ${b.startLine}`);
    }
  }

  // A review is only created when there is something to say.
  const liveInline = r.inline.filter((c) => c.post);
  // Posting a review payload with no `event` creates an UNSUBMITTED (pending)
  // review that nobody but the author can see — and that then blocks every
  // later submit on this PR. A deleted verdict block must be an error, not a
  // silent fall-through.
  if (!r.event && (r.body || liveInline.length > 0)) {
    r.errors.push('there is a review body or inline comments but no `<!-- prt:verdict --> event:` block — restore it, or set `event: NONE` and `post: false`');
  }
  if (r.event && r.event !== 'NONE' && !r.body && liveInline.length === 0 && r.event === 'COMMENT') {
    r.errors.push('event is COMMENT but there is no review body and no inline comments — use `event: NONE` to post only replies');
  }
  if (r.event === 'REQUEST_CHANGES' && !r.body && liveInline.length === 0) {
    r.errors.push('REQUEST_CHANGES needs a review body or at least one inline comment');
  }
  if (r.event === 'NONE' && (r.body || liveInline.length > 0)) {
    r.errors.push('event is NONE but the file still has a review body or inline comments — set `post: false` on them, or pick a real event');
  }
  return r;
}

/** The list of discrete actions the submitter will perform, in order. */
export function planActions(parsed) {
  const actions = [];
  const liveInline = parsed.inline.filter((c) => c.post);
  if ((parsed.event && parsed.event !== 'NONE') || parsed.body || liveInline.length > 0) {
    actions.push({ kind: 'review', id: 'review', event: parsed.event, body: parsed.body, comments: liveInline });
  }
  for (const t of parsed.threads.filter((x) => x.post)) {
    if (t.body) actions.push({ kind: 'thread-reply', id: `${t.id}:reply`, thread: t });
    if (t.resolve) actions.push({ kind: 'thread-resolve', id: `${t.id}:resolve`, thread: t });
    if (t.unresolve) actions.push({ kind: 'thread-unresolve', id: `${t.id}:unresolve`, thread: t });
  }
  for (const c of parsed.issueComments) actions.push({ kind: 'issue-comment', id: `${c.id}:comment`, body: c.body });
  return actions;
}

export function isEmptyAction(parsed) {
  return planActions(parsed).length === 0;
}

/**
 * Hash of the human-meaningful content: everything except line 1 (the gate) and
 * the trailing log block. Detects "the human has edited this draft".
 */
export function contentHash(text) {
  const withoutStatus = text.split('\n').slice(1).join('\n');
  const withoutLog = withoutStatus.split(/^<!--\s*prt:log[^>]*-->\s*$/m)[0];
  return `sha256:${createHash('sha256').update(withoutLog.trim()).digest('hex').slice(0, 24)}`;
}

/** Hash over exactly the bytes that will be posted. Pins the approved payload. */
export function payloadHash(parsed) {
  const canonical = JSON.stringify({
    event: parsed.event,
    body: parsed.body,
    inline: parsed.inline.filter((c) => c.post).map((c) => [c.id, c.subject, c.path, c.startLine, c.line, c.startSide, c.side, c.body]),
    threads: parsed.threads.filter((t) => t.post).map((t) => [t.id, t.threadNodeId, t.replyToCommentId, t.resolve, t.unresolve, t.body]),
    issue: parsed.issueComments.map((c) => [c.id, c.body]),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/** Append a timestamped entry to the activity log at the end of the file. */
export function appendLog(text, entry) {
  const stamp = new Date().toISOString();
  const line = `- ${stamp} — ${String(entry).replace(/\n/g, '\n  ')}`;
  const base = text.replace(/\s*$/, '');
  const marker = /^<!--\s*prt:log[^>]*-->\s*$/m;
  if (marker.test(base)) {
    // The FIRST terminator after the log sentinel — not the file's last one,
    // which may belong to a block someone appended below the log.
    const logIdx = base.search(marker);
    const idx = base.indexOf('<!-- /prt -->', logIdx);
    if (idx !== -1) return `${base.slice(0, idx)}${line}\n${base.slice(idx)}\n`;
    return `${base}\n${line}\n`;
  }
  // The heading lives INSIDE the block so `contentHash` can cut the whole log
  // off at the sentinel and stay stable as entries accumulate.
  return `${base}\n\n<!-- prt:log -->\n\n## Activity log\n\n${line}\n\n<!-- /prt -->\n`;
}
