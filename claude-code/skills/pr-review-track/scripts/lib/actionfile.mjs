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
const BODY_KINDS = new Set(['body', 'inline', 'thread', 'issue-comment', 'log', 'notes', 'context', 'ask', 'answer']);
/** Blocks that are attributes only; the opening sentinel is the whole block. */
const ATTR_KINDS = new Set(['doc', 'verdict']);

/**
 * Blocks whose body can reach GitHub. A human note that lands inside one of
 * these is a leak, so `@ai` there is an error rather than something to strip:
 * the format promises a body is posted byte for byte, and quietly editing it
 * would decouple the posted bytes from `outbox/<txId>/approved.md`.
 */
const POSTABLE_KINDS = new Set(['body', 'inline', 'thread', 'issue-comment']);
/** Never-posted blocks. `@ai` inside one is merely misplaced, so: a warning. */
const INERT_KINDS = new Set(['context', 'notes', 'log', 'ask', 'answer']);

const OPEN_START = /^<!--\s*prt:([a-z][a-z-]*)\s*(.*)$/;
const CLOSE = /^<!--\s*\/prt\s*-->\s*$/;
const COMMENT_END = /-->\s*$/;

/** The human's shorthand for a note to the model. Column 0, outside every block. */
export const SHORTHAND = /^@ai\b[:,]?[ \t]*(.*)$/;
/** Targets that are symbolic rather than a block id, so they never need rebinding. */
const SYMBOLIC_TARGETS = new Set(['verdict', 'body', 'general', 'gone']);
const KNOWN_KINDS = [...BODY_KINDS, ...ATTR_KINDS];

/** Levenshtein, capped — only used to spot a typo'd block kind. */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const DISPOSITIONS = new Set(['addressed', 'declined', 'deferred']);
const DID_VERBS = /^(drop-inline\s+\S+|edit-inline\s+\S+|edit-thread\s+\S+|edit-body|edit-verdict|answer-only|none)$/;

// A BOM ahead of `Status:` must not hide the gate. Editors add one unasked, and
// a file whose line 1 stopped being readable would get a SECOND status line
// prepended — leaving two, with the submitter reading the one nobody edited.
const stripBom = (s) => String(s ?? '').replace(/^\uFEFF/, '');

export function parseStatus(text) {
  const m = /^Status:\s*([A-Za-z-]+)/.exec(stripBom(text.split('\n', 1)[0] ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

export function setStatus(text, status) {
  const lines = text.split('\n');
  if (/^Status:\s*/.test(stripBom(lines[0] ?? ''))) lines[0] = `Status: ${status}`;
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
    let malformedSentinel = false;
    // The sentinel may be one line (`<!-- prt:body -->`) or span lines until `-->`.
    if (COMMENT_END.test(rest)) {
      sentinelLines.push(rest.replace(COMMENT_END, ''));
      i++;
    } else {
      sentinelLines.push(rest);
      i++;
      let terminated = false;
      while (i < lines.length) {
        // Stop at the next sentinel or terminator. Without this guard an
        // unterminated `<!-- prt:ask` scans on to the *next* block's `-->`,
        // absorbing that block's `id:`/`path:`/`line:` into its own fields and
        // its comment text as its body — so an armed inline comment vanishes
        // with no error and no warning. Silent loss of a comment the human
        // approved is the worst failure this format can have.
        if (OPEN_START.test(lines[i]) || CLOSE.test(lines[i])) break;
        if (COMMENT_END.test(lines[i])) {
          sentinelLines.push(lines[i].replace(COMMENT_END, ''));
          i++;
          terminated = true;
          break;
        }
        sentinelLines.push(lines[i]);
        i++;
      }
      malformedSentinel = !terminated;
    }
    const fields = parseSentinelFields(sentinelLines);

    if (ATTR_KINDS.has(kind)) {
      out.push({ kind, fields, body: '', startLine, endLine: i, unterminated: false, malformedSentinel });
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
    out.push({
      kind, fields, body: bodyLines.join('\n'), startLine, endLine: i,
      unterminated: !closed, malformedSentinel,
    });
  }
  return out;
}

/**
 * The byte ranges `tokenize` discards: everything outside every sentinel block.
 * Returns [{startLine, endLine, lines}] with 1-based inclusive line numbers.
 *
 * This is the ONLY region a shorthand note may live in, which is what makes the
 * never-posted guarantee structural rather than a promise: the gaps cannot
 * overlap a postable body by construction.
 */
export function gapsOf(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const covered = new Array(lines.length).fill(false);
  for (const b of tokenize(text)) {
    for (let k = b.startLine - 1; k < b.endLine && k < lines.length; k++) covered[k] = true;
  }
  const gaps = [];
  let run = null;
  for (let k = 0; k < lines.length; k++) {
    if (covered[k]) {
      if (run) { gaps.push(run); run = null; }
      continue;
    }
    if (!run) run = { startLine: k + 1, endLine: k + 1, lines: [] };
    run.endLine = k + 1;
    run.lines.push(lines[k]);
  }
  if (run) gaps.push(run);
  return gaps;
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
    // Notes between the human and the model. Deliberately NOT read by
    // `planActions`, which is what makes them structurally unpostable.
    asks: [],
    answers: [],
    errors: [],
    warnings: [],
  };
  if (r.status === null) r.errors.push('line 1 must be `Status: <draft|ready|hold|skip>`');
  if (r.status && !STATUSES.includes(r.status)) r.errors.push(`unknown status "${r.status}"`);

  const bad = (msg) => r.errors.push(msg);
  let sawBody = false;
  let sawVerdict = false;
  const seenIds = new Set();
  const claimId = (id, where) => {
    if (!id) { r.errors.push(`${where}: missing \`id:\``); return; }
    if (seenIds.has(id)) r.errors.push(`${where}: duplicate id "${id}"`);
    seenIds.add(id);
  };

  for (const b of tokenize(text)) {
    const where = `<!-- prt:${b.kind} --> at line ${b.startLine}`;
    if (b.malformedSentinel) {
      r.errors.push(`${where}: the sentinel is missing its \`-->\` — add it, or the block below is swallowed`);
      continue;
    }
    if (b.unterminated && BODY_KINDS.has(b.kind)) {
      r.errors.push(`${where} is missing its \`<!-- /prt -->\` terminator`);
      continue;
    }
    // A note typed inside a body that posts is a leak. Refuse rather than strip:
    // the format promises the body is posted byte for byte, so quietly editing
    // it would decouple the posted bytes from outbox/<txId>/approved.md.
    if (POSTABLE_KINDS.has(b.kind) && /^@ai\b/m.test(b.body)) {
      r.errors.push(`${where}: an \`@ai\` note is inside text that gets posted. Move it outside the block, or indent it one space to keep it as prose.`);
    } else if (INERT_KINDS.has(b.kind) && b.kind !== 'ask' && b.kind !== 'answer' && /^@ai\b/m.test(b.body)) {
      // An error, not a warning. The block is inert so nothing leaks — but the
      // note would be collected by nothing and reported by nothing, and the
      // review would post as if it had never been written. `prt submit` prints
      // no warnings, so a warning here is indistinguishable from silence.
      r.errors.push(`${where}: an \`@ai\` note is inside a block, so it will not be collected. Move it outside the block, or indent it one space to keep it as prose.`);
    }
    switch (b.kind) {
      case 'doc':
        r.doc = b.fields;
        break;

      case 'verdict': {
        if (sawVerdict) {
          r.errors.push(`${where}: a second \`<!-- prt:verdict -->\` block — the review has one resolution, so delete one.`);
          break;
        }
        sawVerdict = true;
        const e = (b.fields.event || '').toUpperCase();
        if (!e) r.errors.push(`${where}: missing \`event:\``);
        else if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'REPLY', 'NONE'].includes(e)) {
          r.errors.push(`${where}: event must be APPROVE, REQUEST_CHANGES, COMMENT, REPLY or NONE (got "${e}")`);
        } else r.event = e;
        break;
      }

      case 'body': {
        // A second body used to overwrite the first without a word, so a
        // duplicated block — easy to produce by pasting a revision below the
        // original — silently posted only the last one.
        if (sawBody) {
          r.errors.push(`${where}: a second \`<!-- prt:body -->\` block. Only one review summary can be posted — delete or merge one.`);
          break;
        }
        sawBody = true;
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
          // Provenance: which ask caused this comment to be stood down. Purely
          // a record — `post: false` is what actually stops it being posted.
          droppedBy: b.fields['dropped-by'] || null,
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

      // A note from the human to the model. Never posted: it produces no action
      // in `planActions`, so no code path that builds a request can reach it.
      case 'ask': {
        const question = b.body.replace(/^\n+/, '').replace(/\s+$/, '');
        // An empty ask is a no-op, not an error — that keeps a stub free.
        if (!question) break;
        claimId(b.fields.id, where);
        const re = (b.fields.re || 'general').trim();
        const ask = {
          id: b.fields.id,
          re,
          blocking: truthy(b.fields.blocking, true, bad, `${where} blocking`),
          closed: truthy(b.fields.closed, false, bad, `${where} closed`),
          follows: b.fields.follows || null,
          raised: b.fields.raised || null,
          was: b.fields.was || null,
          question,
          sourceLine: b.startLine,
        };
        const w = fenceWarning(question, where);
        if (w) r.warnings.push(w);
        r.asks.push(ask);
        break;
      }

      // The model's reply to an ask. Also never posted. It carries no `id:` —
      // it is not postable, so it must not claim a slot in the id namespace.
      case 'answer': {
        const to = (b.fields.to || '').trim();
        const disposition = (b.fields.disposition || '').trim().toLowerCase();
        const did = (b.fields.did || '').trim();
        const body = b.body.replace(/^\n+/, '').replace(/\s+$/, '');
        if (!to) r.errors.push(`${where}: missing \`to:\` — an answer must name the ask it answers`);
        if (!disposition) r.errors.push(`${where}: missing \`disposition:\``);
        else if (!DISPOSITIONS.has(disposition)) {
          r.errors.push(`${where}: \`disposition:\` must be addressed, declined or deferred (got "${disposition}")`);
        }
        // Guard 1: the model cannot mark its own homework done without showing
        // the work. A terminal disposition with no prose is an error.
        if (!body && (disposition === 'addressed' || disposition === 'declined')) {
          r.errors.push(`${where}: \`disposition: ${disposition}\` needs a body saying what was done and why`);
        }
        if (did && !DID_VERBS.test(did)) {
          r.errors.push(`${where}: \`did:\` must be one of drop-inline <id>, edit-inline <id>, edit-thread <id>, edit-body, edit-verdict, answer-only, none (got "${did}")`);
        }
        r.answers.push({ to, disposition, did: did || null, in: b.fields.in || null, body, sourceLine: b.startLine });
        break;
      }

      case 'context':
      case 'notes':
        r.context.push(b.body.trim());
        break;

      case 'log':
        r.log.push(b.body.trim());
        break;

      default: {
        // A near-miss is a typo, and a typo'd block is silently dropped — the
        // exact failure the ask mechanism exists to prevent. `prt:note` for
        // `prt:ask` costs the human their instruction and posts the review
        // anyway, so name it as an error rather than a warning nobody sees.
        const near = KNOWN_KINDS.find((k) => editDistance(k, b.kind) <= 1);
        if (near) {
          r.errors.push(`${where}: unknown block kind "${b.kind}" — did you mean \`prt:${near}\`? Its contents are being ignored.`);
        } else {
          r.warnings.push(`ignoring unknown block \`<!-- prt:${b.kind} -->\` at line ${b.startLine}`);
        }
        break;
      }
    }
  }

  // ---- notes to the model -------------------------------------------------
  // An un-promoted `@ai` line is an ERROR, not a warning. C3's worst outcome is
  // an instruction that is silently swallowed, and a warning is silent in
  // practice — nobody reads stderr at 23:00. As an error it reaches both
  // consumers already wired up: `prt validate` (exit 1) and `capture()`, which
  // throws `Blocked` on `parsed.errors`. Promoted, or the submit stops. No
  // third path.
  for (const gap of gapsOf(text)) {
    gap.lines.forEach((line, k) => {
      if (!SHORTHAND.test(line)) return;
      r.errors.push(`line ${gap.startLine + k}: un-promoted \`@ai\` note — run \`prt ask <N> --promote\` (or \`prt draft\`) to turn it into a prt:ask block`);
    });
  }

  const askById = new Map(r.asks.map((a) => [a.id, a]));
  const terminalByAsk = new Map();
  for (const ans of r.answers) {
    if (ans.to && !askById.has(ans.to)) {
      r.errors.push(`<!-- prt:answer --> at line ${ans.sourceLine}: \`to: ${ans.to}\` does not match any ask in this file`);
      continue;
    }
    if (ans.disposition === 'addressed' || ans.disposition === 'declined') {
      if (terminalByAsk.has(ans.to)) {
        r.errors.push(`<!-- prt:answer --> at line ${ans.sourceLine}: ask "${ans.to}" already has a terminal answer at line ${terminalByAsk.get(ans.to)}`);
      } else terminalByAsk.set(ans.to, ans.sourceLine);
    }
    // Guard 2: a claim that an inline was dropped is cross-checked against the
    // file. The model can write a wrong paragraph; it cannot write one that
    // contradicts the file's own state.
    const m = /^drop-inline\s+(\S+)$/.exec(ans.did ?? '');
    if (m) {
      const target = r.inline.find((c) => c.id === m[1]);
      if (!target) r.errors.push(`<!-- prt:answer --> at line ${ans.sourceLine}: \`did: drop-inline ${m[1]}\` but there is no inline "${m[1]}" in this file`);
      else if (target.post) r.errors.push(`<!-- prt:answer --> at line ${ans.sourceLine}: \`did: drop-inline ${m[1]}\` but inline "${m[1]}" still has \`post: true\``);
      // Provenance should name the note that actually claimed the drop. A
      // warning rather than an error: only one ask fits in `dropped-by:`, so a
      // comment dropped for two reasons would otherwise be unresolvable.
      else if (target.droppedBy && ans.to && target.droppedBy !== ans.to) {
        r.warnings.push(`inline "${m[1]}" says \`dropped-by: ${target.droppedBy}\` but the answer claiming the drop is for ask "${ans.to}"`);
      }
    }
  }
  for (const a of r.asks) {
    if (a.follows && !askById.has(a.follows)) {
      r.warnings.push(`ask "${a.id}": \`follows: ${a.follows}\` names an ask that is no longer in this file (it may have been retired to history/)`);
    }
  }
  // `dropped-by:` is provenance that outlives the ask it names, so a missing
  // ask is a warning. As an error it would make every file unparseable two
  // rounds later, once carry-over has retired the ask.
  for (const c of r.inline) {
    if (c.droppedBy && !askById.has(c.droppedBy)) {
      r.warnings.push(`inline "${c.id}": \`dropped-by: ${c.droppedBy}\` names an ask no longer in this file`);
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

// ---------------------------------------------------------------- ask lifecycle

/**
 * An ask's state is DERIVED from the answers pointing at it, never stored.
 *
 * A stored `state:` field and an answer body are two independent facts that can
 * disagree — "addressed" with nothing to show for it. Deriving makes that
 * disagreement unrepresentable: there is no `addressed` without its
 * justification, because `addressed` *is* an answer block carrying one.
 *
 * There is deliberately no reopen transition. Unsatisfied by an answer? Write a
 * new ask with `follows:`, which keeps the chain linear and auditable. Deleting
 * the answer block also reopens the ask, precisely because the state is derived.
 */
export function askState(ask, answers) {
  if (ask.closed) return { state: 'withdrawn', open: false, disposition: null, answer: null };
  const mine = answers.filter((a) => a.to === ask.id);
  const terminal = mine.filter((a) => a.disposition === 'addressed' || a.disposition === 'declined').pop();
  if (terminal) return { state: terminal.disposition, open: false, disposition: terminal.disposition, answer: terminal };
  const deferred = mine.filter((a) => a.disposition === 'deferred').pop();
  return { state: deferred ? 'deferred' : 'open', open: true, disposition: deferred ? 'deferred' : null, answer: deferred ?? null };
}

/** Every ask in a file with its derived state, newest answer attached. */
export function collectAsks(text) {
  const parsed = parseActionFile(text);
  const asks = parsed.asks.map((a) => ({ ...a, ...askState(a, parsed.answers) }));
  return { asks, answers: parsed.answers, errors: parsed.errors, warnings: parsed.warnings };
}

/** Open asks that would stop a submit. */
export function blockingAsks(parsed) {
  return parsed.asks
    .map((a) => ({ ...a, ...askState(a, parsed.answers) }))
    .filter((a) => a.open && a.blocking);
}

const ASK_ORDINAL = /^a(\d+)$/;

/** Highest `a<n>` ordinal anywhere in the text, so a retired id is never reissued. */
export function maxAskOrdinal(text) {
  let max = 0;
  for (const b of tokenize(text)) {
    if (b.kind !== 'ask') continue;
    const m = ASK_ORDINAL.exec(String(b.fields.id ?? '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Turn `@ai …` lines in the gaps into canonical `prt:ask` blocks.
 *
 * Pure: returns new text plus a report of every promotion, so nothing is
 * inferred silently. A note runs to the next blank line or the next column-0
 * `<!--`. An optional leading target token binds it; otherwise it binds to the
 * nearest preceding block id, because that is where a human types a reaction.
 */
export function promoteShorthand(text, { startOrdinal = 1, generation = null } = {}) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const blocks = tokenize(src);
  const gaps = gapsOf(src);
  const promoted = [];
  let ordinal = startOrdinal;

  // line number (1-based) -> id of the block that ends at or before it
  const precedingId = (lineNo) => {
    let best = null;
    for (const b of blocks) {
      if (b.startLine > lineNo) break;
      if (b.kind === 'verdict') best = 'verdict';
      else if (b.kind === 'body') best = 'body';
      else if (b.fields?.id && (b.kind === 'inline' || b.kind === 'thread' || b.kind === 'issue-comment')) best = b.fields.id;
    }
    return best ?? 'general';
  };

  const replacements = []; // {from, to, text} — 1-based inclusive line range
  for (const gap of gaps) {
    let k = 0;
    while (k < gap.lines.length) {
      const m = SHORTHAND.exec(gap.lines[k]);
      if (!m) { k++; continue; }
      const firstLineNo = gap.startLine + k;
      const collected = [m[1]];
      let j = k + 1;
      while (j < gap.lines.length) {
        const nxt = gap.lines[j];
        if (!nxt.trim()) break;
        if (/^<!--/.test(nxt)) break;
        if (SHORTHAND.test(nxt)) break;
        collected.push(nxt);
        j++;
      }
      const raw = collected.join('\n').trim();
      // Lift an explicit target off the front: `i3 …`, `verdict …`, `follows a5 …`
      let re = null;
      let follows = null;
      let bodyText = raw;
      // A leading token sets the target. It is only CONSUMED when a punctuation
      // separator follows, because a bare space is ambiguous: "general cleanup
      // of the summary" and "i1 is fine, it is i2 that is wrong" both open with
      // a token that is also an ordinary word, and eating it would delete a
      // word the human wrote. Losing their words is never an acceptable cost
      // for a tidier body, so without punctuation the target is read and the
      // text is kept whole.
      const SEP = /^[ \t]*[:,.—–-]+[ \t]*/;
      let mt = /^follows\s+(a\d+)\b/i.exec(raw);
      if (mt) {
        follows = mt[1];
        const rest = raw.slice(mt[0].length);
        const sep = SEP.exec(rest);
        bodyText = sep ? rest.slice(sep[0].length) : rest.replace(/^[ \t]+/, '');
      } else {
        mt = /^([A-Za-z][\w-]*)\b/.exec(raw);
        if (mt) {
          const tok = mt[1].toLowerCase();
          const isBlockId = blocks.some((b) => b.fields?.id === mt[1]);
          if (SYMBOLIC_TARGETS.has(tok) || isBlockId) {
            re = isBlockId ? mt[1] : tok;
            const rest = raw.slice(mt[0].length);
            const sep = SEP.exec(rest);
            bodyText = sep ? rest.slice(sep[0].length) : raw;
          }
        }
      }
      const inferred = !re;
      if (!re) re = follows ? 'general' : precedingId(firstLineNo);
      const id = `a${ordinal++}`;
      const sentinel = ['<!-- prt:ask', `id: ${id}`, `re: ${re}`];
      if (follows) sentinel.push(`follows: ${follows}`);
      if (generation) sentinel.push(`raised: g${generation}`);
      sentinel.push('-->');
      replacements.push({
        from: firstLineNo,
        to: gap.startLine + j - 1,
        text: `${sentinel.join('\n')}\n${bodyText.trim()}\n<!-- /prt -->`,
      });
      promoted.push({ id, re, follows, inferred, line: firstLineNo, firstLine: bodyText.trim().split('\n')[0] });
      k = j;
    }
  }

  if (!replacements.length) return { text: src, promoted };
  const out = [];
  let cursor = 0; // 0-based
  for (const rep of replacements.sort((a, b) => a.from - b.from)) {
    for (let z = cursor; z < rep.from - 1; z++) out.push(lines[z]);
    out.push(rep.text);
    cursor = rep.to;
  }
  for (let z = cursor; z < lines.length; z++) out.push(lines[z]);
  return { text: out.join('\n'), promoted };
}

/** Render one ask (plus its answers) back to canonical block text. */
export function renderAsk(ask, answers = []) {
  const s = ['<!-- prt:ask', `id: ${ask.id}`, `re: ${ask.re}`];
  if (ask.blocking === false) s.push('blocking: no');
  if (ask.closed) s.push('closed: yes');
  if (ask.follows) s.push(`follows: ${ask.follows}`);
  if (ask.raised) s.push(`raised: ${ask.raised}`);
  if (ask.was) s.push(`was: ${ask.was}`);
  s.push('-->');
  const out = [s.join('\n'), ask.question, '<!-- /prt -->'];
  for (const ans of answers) {
    const a = ['<!-- prt:answer', `to: ${ans.to}`, `disposition: ${ans.disposition}`];
    if (ans.did) a.push(`did: ${ans.did}`);
    if (ans.in) a.push(`in: ${ans.in}`);
    a.push('-->');
    out.push('', a.join('\n'), ans.body, '<!-- /prt -->');
  }
  return out.join('\n');
}

/**
 * Carry asks from the previous generation of an action file into the next one.
 *
 * `prt draft` regenerates review.md wholesale from findings.json, so without
 * this every note the human wrote would be destroyed by the next round — which
 * would make the whole feature a trap. The old file is still archived to
 * `history/` first, so nothing here is the last line of defence.
 *
 * `newIds` is the set of block ids the regenerated file will contain. An ask
 * whose target survives is kept as-is; one whose target moved is rebound by an
 * EXACT anchor match; anything else is orphaned to `re: gone` with `was:`
 * recording where it pointed. Two exact tiers only — no fuzzy path-only match,
 * because a mis-bound note is worse than an orphaned one.
 */
export function carryAsks(oldText, { newIds = new Set(), newAnchors = new Map(), generation = 1, ordinalFloor = 0, keepClosedFor = 1 } = {}) {
  const { asks, answers, errors } = collectAsks(oldText);
  const changes = [];
  const warnings = [];

  // Refuse rather than silently drop: a file whose notes cannot be read is one
  // where the human's words are at risk, and `--no-carry` is the explicit exit.
  //
  // The check must NOT require `asks.length` — a note whose sentinel is
  // malformed never reaches that array, and it is exactly the one in danger.
  const structural = errors.filter((e) => /prt:(ask|answer)|un-promoted/.test(e));
  if (structural.length) {
    return { asks: [], answers: [], changes: [], warnings, promoted: [], maxOrdinal: ordinalFloor, structuralErrors: structural };
  }

  // Where each block id pointed in the OLD file. Inline ids are positional
  // (`i1..iN` in findings order), so "the new file also has an i3" is NOT
  // evidence that i3 is the same comment — next round's i3 may be an entirely
  // different finding. Identity is the anchor, never the id.
  const oldAnchors = new Map();
  for (const c of parseActionFile(oldText).inline) {
    if (c.path) oldAnchors.set(c.id, { path: c.path, line: c.line, side: c.side ?? 'RIGHT' });
  }
  const sameAnchor = (a, b) => !!a && !!b
    && a.path === b.path && String(a.line) === String(b.line) && (a.side ?? 'RIGHT') === (b.side ?? 'RIGHT');

  const kept = [];
  for (const ask of asks) {
    const next = { ...ask };
    if (!SYMBOLIC_TARGETS.has(next.re)) {
      const want = oldAnchors.get(next.re) ?? null;
      if (!want) {
        // A non-inline target (thread/issue-comment id): fall back to id identity.
        if (!newIds.has(next.re)) {
          changes.push({ id: next.id, kind: 'orphaned', from: next.re, to: 'gone' });
          next.was = next.was ?? next.re;
          next.re = 'gone';
        }
      } else if (sameAnchor(want, newAnchors.get(next.re))) {
        // Same id AND same anchor: genuinely the same comment.
      } else {
        const matches = [];
        for (const [id, a] of newAnchors) if (sameAnchor(want, a)) matches.push(id);
        const rebound = matches[0] ?? null;
        if (rebound) {
          // Two findings can land on one line. Picking silently would make the
          // note look authoritative about a comment it was never written for.
          if (matches.length > 1) {
            warnings.push(`ask "${next.id}" could belong to ${matches.join(' or ')} — both are at ${want.path}:${want.line}. Bound to ${rebound}; move it if that is wrong.`);
          }
          changes.push({ id: next.id, kind: 'rebound', from: next.re, to: rebound, ambiguous: matches.length > 1 });
          next.re = rebound;
        } else {
          changes.push({ id: next.id, kind: 'orphaned', from: next.re, to: 'gone' });
          next.was = next.was ?? `${want.path}:${want.line}`;
          next.re = 'gone';
        }
      }
    }
    if (!next.raised) next.raised = `g${generation}`;
    kept.push(next);
  }

  // Keep every open ask, plus closed ones for one more generation so a human
  // who skipped a round still finds the answer to their own question in the
  // file rather than only in history/.
  const survives = (a) => {
    if (a.open) return true;
    const ans = answers.filter((x) => x.to === a.id).pop();
    const inGen = Number(String(ans?.in ?? '').replace(/^g/, ''));
    if (!Number.isFinite(inGen)) return true; // no stamp: keep one round rather than lose it
    return inGen >= generation - keepClosedFor;
  };
  const keep = kept.filter(survives);
  const retired = kept.length - keep.length;

  let maxOrdinal = ordinalFloor;
  for (const a of kept) {
    const m = ASK_ORDINAL.exec(a.id ?? '');
    if (m) maxOrdinal = Math.max(maxOrdinal, Number(m[1]));
  }

  return {
    asks: keep,
    answers: answers.filter((x) => keep.some((a) => a.id === x.to)),
    changes,
    warnings,
    promoted: [],
    retired,
    maxOrdinal,
    structuralErrors: [],
  };
}

/** The list of discrete actions the submitter will perform, in order. */
export function planActions(parsed) {
  const actions = [];
  // REPLY is an intentionally incomplete pass: publish only replies inside
  // file review threads. It neither submits a review verdict nor resolves a
  // thread, and it defers ordinary PR-conversation comments to a later normal
  // verdict. The approved file remains the record of everything deferred.
  if (parsed.event === 'REPLY') {
    for (const t of parsed.threads.filter((x) => x.post && x.body)) {
      actions.push({ kind: 'thread-reply', id: `${t.id}:reply`, thread: t });
    }
    return actions;
  }
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
  // Approving the PR also approves any GitHub Actions runs that are waiting for
  // the maintainer's "Approve workflows to run" decision on this exact head.
  if (parsed.event === 'APPROVE') actions.push({ kind: 'approve-workflows', id: 'approve-workflows' });
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
