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
const ATTR_KINDS = new Set(['doc', 'verdict', 'pr-actions']);

/** Fields of `prt:pr-actions`, mapped to the names the plan uses. */
const PR_ACTION_FIELDS = { 'update-branch': 'updateBranch', 'trigger-ci': 'triggerCi' };

/**
 * The `prt:doc` keys that record a decision the HUMAN made, as opposed to a
 * fact the generator measured. These are the only keys a regenerated file may
 * inherit from the file it replaces, and `renderActionFile` emits a carried key
 * only if it appears here.
 *
 * Every other key in `prt:doc` — `head`, `base`, `base-ref`,
 * `diff-fingerprint`, `generation`, `generated`, `reviewed-at` — describes one
 * particular generation, and four of them are the submitter's preconditions
 * (`capture` in submit.mjs). Preflight re-checks those against live GitHub and
 * refuses when the PR has moved underneath the draft. Inheriting one would hand
 * that check the previous generation's answer to compare against, which is a
 * check that always passes. That asymmetry — a lost hatch costs the human one
 * retyped line, a stale `head:` costs the author a review posted against code
 * nobody read — is why this is an allow-list of human keys rather than a
 * deny-list of machine ones: a key added to the renderer later cannot be
 * carried until somebody deliberately adds it here.
 *
 * The three values are the lint hatches (`submit.mjs`). Each records a
 * judgement only the human may make — "this CVE mention is not a disclosure" —
 * and destroying it on every regeneration made them re-type it every round,
 * which is how a hatch stops being read before it is typed. WHICH of them
 * survives a given regeneration is decided by `carryDocHatches`, which owns the
 * lints; this list only says which keys are eligible to travel at all.
 */
export const HUMAN_DOC_KEYS = ['security-reviewed', 'ask-quote-reviewed', 'tooling-reviewed'];

/**
 * Blocks whose body can reach GitHub. A human note that lands inside one of
 * these is a leak, so `@ai` there is an error rather than something to strip:
 * the format promises a body is posted byte for byte, and quietly editing it
 * would decouple the posted bytes from `outbox/<txId>/approved.md`.
 */
const POSTABLE_KINDS = new Set(['body', 'inline', 'thread', 'issue-comment']);

/**
 * Blocks `promoteShorthand` will lift a note back OUT of, on disk, before
 * anything is armed. That is the sanctioned way to honour a note typed in the
 * wrong place: a visible edit the human reviews, never a submit-time strip.
 *
 * `prt:log` is deliberately absent even though it is scanned, and the reason is
 * mechanical rather than a matter of taste. A lifted ask is emitted after its
 * own block's terminator, and `contentHash` cuts the file at the `prt:log`
 * sentinel — so a note lifted out of the log would land below that cut and stop
 * counting as "the human edited this draft". The lift would also delete lines
 * out of the submitter's append-only record on the way. A note there keeps the
 * plain error telling the human to move it themselves.
 *
 * `ask` and `answer` ARE here. A note typed under an answer is the human
 * objecting to it, and the only shape that reopens the conversation is an ask of
 * its own — so it is lifted into one, bound with `follows:` to the pair it was
 * written under, which is the field that exists for exactly that chaining.
 */
const LIFTABLE_KINDS = new Set([...POSTABLE_KINDS, 'context', 'notes', 'ask', 'answer']);

/**
 * Blocks a lift must never empty, because an empty one is not an empty block —
 * it is a different file. A postable block emptied by a lift posts a review with
 * no summary; an emptied `prt:ask` parses as a free stub and takes its `id:` and
 * its `blocking:` with it; an emptied `prt:answer` with a terminal disposition
 * becomes a parse error over the model's own words.
 */
const NEVER_EMPTY_KINDS = new Set([...POSTABLE_KINDS, 'ask', 'answer']);

const OPEN_START = /^<!--\s*prt:([a-z][a-z-]*)\s*(.*)$/;
const CLOSE = /^<!--\s*\/prt\s*-->\s*$/;
const COMMENT_END = /-->\s*$/;

/**
 * The human's shorthand for a note to the model — one rule for the whole file.
 *
 * A note used to be detected by two different rules: column 0 in a gap, markdown
 * decoration tolerated inside a block. The gap was the strict one, so the very
 * keystrokes that were read inside a `prt:body` vanished in a gap — not
 * promoted, not refused, not a parse error, not listed by `prt ask`, not
 * reported by `prt validate`. The note this whole mechanism exists for was typed
 * `*@ai Don't mention anything about the tier level…`, one stray italic marker
 * left over from the surrounding prose; the same words two lines lower, in the
 * gap under the block, were lost without a word. Two rules is what made that
 * possible, so there is now one.
 *
 * The leader class is markdown decoration only, so the line has to be *nothing
 * but* decoration before the token: `` `@ai` `` in backticks does not match,
 * which is what makes backticks the single escape for writing about the token as
 * prose. It replaces the gap's old "indent it one space", which the tolerant
 * leader necessarily retires — and one escape that works everywhere is the point.
 * Measured on 2026-08-29 over every `.md` file under `~/.claude/pr-review-track`
 * — 110 of them, `gapsOf` giving 14,437 gap lines and `tokenize` 10,196 lines of
 * block body (counting the bodies of blocks that have one; counting every block
 * gives 10,456, because an attribute-only block's empty body splits to a single
 * line) — tolerating decoration in a gap newly matches exactly one line,
 * and that line is the real note above. The population is named so a re-measure
 * can be the same measurement; the store grows every session, so the totals will
 * not be, and the figure the class is calibrated on is that single hit anyway.
 *
 * CALIBRATION (2026-08-29). The leader class is exactly the set of openers
 * `LIST_ITEM` recognises, plus `>` and `_`. Those two regexes are this file's
 * model of "list item" and its model of "note", and while they disagreed the
 * file contradicted itself: a numbered note — `1. @ai …`, `1) @ai …` — was
 * fenced as a list item by `endsListItem` and matched as a note by nothing, so
 * it was silent in all fourteen locations, gaps included, with 38 ordered-list
 * lines already sitting in the block bodies of that store's 29 tracked
 * `review.md` files (98 across every `.md` in it).
 *
 * `+` was excluded once, to keep the class off the diff-add marker a review body
 * quotes. It bought nothing: `-` is the diff-REMOVE marker and has always been
 * in the class, so quoted diff text was never actually excluded — the exclusion
 * only cost `+ @ai …` its voice, everywhere, for a bullet style with zero
 * occurrences in the 24,893 store lines measured above. A `+`/`-` line that
 * really is quoted diff takes the escape every other reading takes: backticks,
 * or a `` ``` `` fence, around the quote.
 *
 * The token must be whole. `@ai` followed by anything that can continue a handle
 * or an address — `@ai-worker`, `@ai.assistant@example.com`, `@aider`, `@ai_bot`
 * — is not a note. `\b` let all of those through, and that was not merely a
 * mis-flag: a `> @ai-worker …` line quoted inside a `prt:body` and fenced by a
 * blank line was DELETED by the lift, out of bytes the format promises to post
 * verbatim. No corpus witness exists (0 hits in 1.15M lines of Pulsar plus this
 * toolbox); the witness is a constructed repro that ran end to end on a real
 * draft.
 *
 * A fenced code block is NOT excluded, and that is deliberate. Fence parity on
 * an unbalanced ``` — which a body quoting a diff carries easily — would decide
 * that a real note is code and drop it, which is the one failure this rule
 * exists to remove. So a `@ai` line inside a fence is a note like any other:
 * seen, and then promoted or refused, never silent.
 */
export const NOTE_LINE = /^(?:[ \t>*_+-]|\d{1,9}[.)])*@ai(?![\w.@-])[:,]?[ \t]*(.*)$/;

/**
 * A line that opens a markdown list item, with its indent captured.
 *
 * This is what makes `- @ai …` — a form the docs advertise — actually usable. A
 * note written as a list item is by construction butted against the next item,
 * so the one-line rule in `promoteShorthand` refused every bulleted note. A
 * sibling item at the same indent or shallower cannot be the rest of the note
 * above it: it begins a new block-level element. A deeper one can be a nested
 * child, so it is not a fence; and a note that is not itself a list item is
 * never fenced by a list, because `@ai please:` followed by `- do X` is a note
 * whose bullets are part of the note.
 *
 * Its marker set and `NOTE_LINE`'s leader class must stay the same set. While
 * they differed — this one admitting `+`, `1.` and `1)` and that one not — the
 * file said a numbered line opens a list item and also that it cannot carry a
 * note, so `1. @ai …` was fenced correctly by a rule that never ran.
 */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** True when `next` opens the list item that ends the one `line` is written as. */
function endsListItem(line, next) {
  if (line === undefined || next === undefined) return false;
  const here = LIST_ITEM.exec(line);
  const there = LIST_ITEM.exec(next);
  return !!here && !!there && there[1].length <= here[1].length;
}
/** Targets that are symbolic rather than a block id, so they never need rebinding. */
const SYMBOLIC_TARGETS = new Set(['verdict', 'body', 'general', 'gone', 'pr-actions']);
const KNOWN_KINDS = [...BODY_KINDS, ...ATTR_KINDS];
const KNOWN_KIND_SET = new Set(KNOWN_KINDS);

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

/**
 * Rewrite one field of the `prt:pr-actions` sentinel in place, touching nothing
 * else in the file.
 *
 * This is how an armed flag is disarmed once its action has actually landed:
 * the alternative — regenerating the block — would rewrite bytes the human is
 * still editing. A file with no such block, or no such field, comes back
 * unchanged, because "the human deleted the block" is not an error worth having.
 */
export function setPrActionField(text, field, value) {
  const lines = text.split('\n');
  let inSentinel = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inSentinel) {
      const m = OPEN_START.exec(lines[i]);
      if (m && m[1] === 'pr-actions') {
        // A one-line `<!-- prt:pr-actions update-branch: true -->` has no field
        // lines to rewrite; leave it be rather than reflow the human's markup.
        if (COMMENT_END.test(m[2])) return text;
        inSentinel = true;
      }
      continue;
    }
    if (COMMENT_END.test(lines[i]) || OPEN_START.test(lines[i]) || CLOSE.test(lines[i])) break;
    const m = new RegExp(`^(\\s*${field}\\s*:)`).exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]} ${value}`;
      break;
    }
  }
  return lines.join('\n');
}

/**
 * The `prt:pr-actions` section, exactly as a fresh draft writes it.
 *
 * It lives with the format rather than in the renderer because a file drafted
 * before the block existed gets it backfilled (`ensurePrActions`), and a
 * backfilled block whose wording had drifted from the generated one would read
 * as a second, subtly different feature.
 */
export const PR_ACTIONS_SECTION = [
  '## Pull request actions',
  '',
  '<!-- prt:pr-actions',
  'update-branch: false',
  'trigger-ci: false',
  '-->',
  '',
  '*Run when you set line 1 to `ready`, after everything above has been posted, then set back to `false`.*',
  '',
  '- `update-branch` — merge the base branch into this PR, as the **Update branch** button does.',
  '  It updates nothing if the head has moved since this file was drafted, and reports a merge',
  '  conflict rather than guessing at it.',
  "- `trigger-ci` — GitHub's **Approve workflows to run** for this PR's waiting runs. `event: APPROVE`",
  '  already does this, so it is for letting CI run *without* approving the PR.',
  '',
  'Both together update the branch first, then approve the runs that appear on the new head.',
];

/** Line-1 values whose bytes belong to the human or to the submitter mid-flight. */
const NO_BACKFILL_STATUSES = new Set(['ready', 'queued', 'partial']);

/**
 * Give a file drafted before `prt:pr-actions` existed the block it is missing,
 * directly below the verdict the two flags are armed alongside.
 *
 * Both flags land `false`: this adds the buttons, it never presses them
 * (invariant 3). The text comes back byte-for-byte unchanged when the block is
 * already there, when there is no verdict to hang it under, when the PR is
 * merged — neither updating the branch nor releasing CI means anything after a
 * merge — or when line 1 says the human has armed the file or the submitter is
 * part-way through it.
 */
export function ensurePrActions(text, { merged = false } = {}) {
  if (merged) return text;
  if (NO_BACKFILL_STATUSES.has(parseStatus(text) ?? '')) return text;

  const lines = text.split('\n');
  const bare = (s) => String(s ?? '').replace(/\r$/, '');
  const sentinelOf = (i) => OPEN_START.exec(bare(lines[i]));

  /** Last line of the sentinel opening at `i`, or -1 if it never closes. */
  const sentinelEnd = (i, rest) => {
    if (COMMENT_END.test(rest)) return i;
    for (let j = i + 1; j < lines.length; j++) {
      const line = bare(lines[j]);
      // A sentinel that opens before this one closed never closed at all: the
      // next block's own `-->` is not this block's terminator.
      if (OPEN_START.test(line) || CLOSE.test(line)) break;
      if (COMMENT_END.test(line)) return j;
    }
    return -1;
  };

  let verdictEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = sentinelOf(i);
    if (!m) continue;
    // Already present — wherever the human moved it to.
    if (m[1] === 'pr-actions') return text;
    if (m[1] === 'verdict' && verdictEnd < 0) {
      verdictEnd = sentinelEnd(i, m[2]);
      // An unterminated verdict is a parse error the human has to see, not
      // something to build on top of.
      if (verdictEnd < 0) return text;
    }
  }
  if (verdictEnd < 0) return text;

  // "Below the verdict" means where a fresh draft puts it: after the verdict's
  // prose and any notes attached to it, above whatever section comes next. A
  // `##` inside a block body is markdown the human wrote rather than a heading,
  // so those blocks are stepped over whole.
  let at = lines.length;
  for (let i = verdictEnd + 1; i < lines.length; i++) {
    const m = sentinelOf(i);
    if (m && (m[1] === 'ask' || m[1] === 'answer')) {
      const end = sentinelEnd(i, m[2]);
      i = end < 0 ? lines.length : end;
      while (i < lines.length && !CLOSE.test(bare(lines[i]))) i++;
      continue;
    }
    if (m || /^##\s/.test(bare(lines[i]))) {
      at = i;
      break;
    }
  }

  const cr = /\r\n/.test(text) ? '\r' : '';
  const block = [...PR_ACTIONS_SECTION, ''];
  if (at > 0 && bare(lines[at - 1]) !== '') block.unshift('');
  lines.splice(at, 0, ...block.map((l) => l + cr));
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
 * Returns [{kind, fields, sentinel, body, startLine, bodyStartLine, endLine, unterminated}].
 * Content outside any block is discarded — by design.
 *
 * `sentinel` is the raw header lines, kept alongside the `fields` parsed out of
 * them because `parseSentinelFields` drops anything that is not `key: value`
 * without a word. That is right for parsing and wrong for the one line it must
 * never lose: an `@ai` note typed into a block's header used to disappear there
 * completely — no field, no error, no promotion. `sentinel[k]` is file line
 * `startLine + k`; the opener's own remainder is `sentinel[0]`.
 *
 * `bodyStartLine` is the 1-based line of the body's FIRST line (null for an
 * attribute-only block). It cannot be derived afterwards from `endLine` and the
 * body's length: a one-line empty body and a zero-line body both join to `''`,
 * and an unterminated block's `endLine` is the next opener rather than a
 * terminator. `promoteShorthand` needs an exact number to delete a note by, so
 * the tokenizer records it while it still knows.
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
      out.push({ kind, fields, sentinel: sentinelLines, body: '', startLine, bodyStartLine: null, endLine: i, unterminated: false, malformedSentinel });
      continue;
    }
    // `i` is the 0-based index of the first body line here — every sentinel
    // line, one or many, has already been consumed above.
    const bodyStartLine = i + 1;
    const bodyLines = [];
    let closed = false;
    while (i < lines.length) {
      if (CLOSE.test(lines[i])) { closed = true; i++; break; }
      if (OPEN_START.test(lines[i])) break; // next block started: treat as unterminated
      bodyLines.push(lines[i]);
      i++;
    }
    out.push({
      kind, fields, sentinel: sentinelLines, body: bodyLines.join('\n'), startLine, bodyStartLine, endLine: i,
      unterminated: !closed, malformedSentinel,
    });
  }
  return out;
}

/**
 * The byte ranges `tokenize` discards: everything outside every sentinel block.
 * Returns [{startLine, endLine, lines}] with 1-based inclusive line numbers.
 *
 * This is the only region a shorthand note may REST in, which is what makes the
 * never-posted guarantee structural rather than a promise: the gaps cannot
 * overlap a postable body by construction.
 *
 * A note can still be TYPED inside a block — humans do, and refusing to see it
 * only meant it posted. `promoteShorthand` lifts such a note back out into a
 * `prt:ask`, on disk and before anything is armed, so the note ends up in a gap
 * after all and the guarantee is restored rather than weakened. Nothing is ever
 * stripped at submit time; see the POSTABLE_KINDS comment at the top.
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

/**
 * The body-line index a `prt:ask` block's question opens on, or -1.
 *
 * A `prt:ask` body IS a note — it is the promoted form of one — and the block
 * around it is the promotion. So the line its question opens on is already
 * promoted, and reading it as a second, un-promoted note would be the tool
 * telling the human that words it demonstrably collected were lost. That is not
 * hypothetical: `pr-26433`'s ask a2 carries its leader verbatim
 * (`*@ai Don't mention anything about the tier level…`) because it was written
 * before the leader class tolerated decoration, and the model answered it.
 *
 * Only the opening line. Everything below it in the same body is scanned, which
 * is what closes the reachable half of the hole: a second thought typed under a
 * question that has already been answered is never re-read, and `carryAsks`
 * retires the pair to `history/` two generations later. The gap collector in
 * `promoteShorthand` breaks at the next `NOTE_LINE`, so a question this tool
 * wrote can never itself contain a second `@ai` line — every one found below the
 * opening line was typed by a human afterwards.
 */
function askQuestionLine(b) {
  if (b.kind !== 'ask') return -1;
  return b.body.split('\n').findIndex((l) => l.trim() !== '');
}

/**
 * Every `@ai` line a human could reasonably believe is a note, wherever it sits,
 * with the one edit that actually fixes it.
 *
 * The single scanner. `parseActionFile`'s error, `promoteShorthand`'s report,
 * `notesLostByRegenerating`'s guard and `prt ask`'s listing all read this one
 * function, so they cannot disagree about what counts as a note, about which
 * line it is on, or about what to do next — the same note named at a block's
 * opening sentinel by one command and at its own line by another reads as two
 * different notes, and a `!` row naming a command that cannot lift that note is
 * the tool contradicting itself two commands apart.
 *
 * It looks EVERYWHERE, and that is the property to preserve: every block's
 * header, every block's body, every gap, and — this is what the last three holes
 * had in common — blocks this file has no model for. A block whose terminator or
 * sentinel the human broke mid-edit, and a block whose kind is a typo, were both
 * skipped; both are exactly when a human is mid-thought, and in both the words
 * went to `history/` on the next `prt draft` with nothing said. The one line it
 * does not report is a `prt:ask`'s own question; see `askQuestionLine`.
 *
 * Each row carries `where` (`'gap'` or the block kind), `region` (`'gap'`,
 * `'body'` or `'header'`), `liftable` — whether `promoteShorthand` may take this
 * one out on disk — and `remedy`, the imperative that fixes it. Only a body note
 * in an intact block of a known, liftable kind is ever liftable: deleting a line
 * out of a sentinel is how a block loses its `id:` or its `post:`, and splicing a
 * block whose extent is a guess deletes lines that may belong to a different one.
 *
 * The header is scanned at all because `parseSentinelFields` keeps `key: value`
 * lines and drops the rest without a word — so a note typed between
 * `<!-- prt:inline` and its `-->` was the most completely lost of the lot: no
 * field, no body, no gap, nothing to report it. Injecting one note at every line
 * of a real 364-line draft put 609 of 2,548 cases exactly there.
 */
export function unpromotedNotes(text) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const out = [];
  // The likeliest moment to type a note is while reading an ARMED file, and
  // `prt ask --promote` refuses to rewrite one \u2014 so a remedy that just said
  // "run `--promote`" sent the human into a refusal without naming its
  // precondition. Said once, here, so the parse error `prt validate` prints and
  // the `!` row `prt ask` prints carry the same sentence: both read this one
  // function. (`notesLostByRegenerating` prefers the lift's own `why` where
  // there is one, and `prt draft` will not touch a protected file anyway.)
  const status = parseStatus(src);
  const gate = PROTECTED_STATUSES.has(status) && status !== 'hold'
    ? ` (set \`Status: draft\` first \u2014 \`prt ask\` will not rewrite a "${status}" file)`
    : '';
  const remedy = (s) => (gate && s.includes('--promote') ? `${s}${gate}` : s);
  for (const b of tokenize(src)) {
    const at = `<!-- prt:${b.kind} --> at line ${b.startLine}`;
    // A block whose extent is a guess, or whose kind this file has no model for,
    // is reported and never lifted — and its remedy names the damage rather than
    // a `--promote` that cannot reach past it.
    const blocked = b.malformedSentinel
      ? `the \`<!-- prt:${b.kind}\` sentinel at line ${b.startLine} never closes with \`-->\`, so where this note ends is a guess — close the sentinel, then run \`prt ask <N> --promote\``
      : (b.unterminated
        ? `${at} has no \`<!-- /prt -->\`, so where this note ends is a guess — add the terminator, then run \`prt ask <N> --promote\``
        : (KNOWN_KIND_SET.has(b.kind)
          ? null
          : `\`prt:${b.kind}\` is not a block kind this tool knows, so nothing reads a note out of it — fix the block kind, or move the note into a gap`));
    // Every kind's HEADER is scanned, `prt:ask`'s and `prt:doc`'s included,
    // because nothing anywhere reads a non-`key: value` line out of a sentinel.
    (b.sentinel ?? []).forEach((line, k) => {
      const m = NOTE_LINE.exec(line);
      if (!m) return;
      out.push({
        where: b.kind, region: 'header', line: b.startLine + k, text: m[1].trim(), liftable: false,
        remedy: remedy(blocked ?? 'move it below the `-->`, into a gap, and it will be promoted — a splice inside a sentinel is how a block loses its `id:`'),
      });
    });
    if (b.bodyStartLine == null) continue;
    // `prt:ask` and `prt:answer` bodies are scanned like every other never-posted
    // block. They were skipped, on the claim that a note there is "carried into
    // the next generation" — but `carryAsks` retires an answered pair to
    // `history/`, so a second thought typed under an answer was not carried, it
    // was destroyed, and nothing said so on the way.
    const questionAt = askQuestionLine(b);
    const liftable = !blocked && LIFTABLE_KINDS.has(b.kind);
    b.body.split('\n').forEach((line, k) => {
      if (k === questionAt) return;
      const m = NOTE_LINE.exec(line);
      if (!m) return;
      out.push({
        where: b.kind, region: 'body', line: b.bodyStartLine + k, text: m[1].trim(), liftable,
        remedy: remedy(blocked ?? (liftable
          ? 'run `prt ask <N> --promote` to lift it out into a `prt:ask` block, or put the token in backticks to keep it as prose'
          : `nothing lifts a note out of \`prt:${b.kind}\` — move it outside the block`)),
      });
    });
  }
  for (const gap of gapsOf(src)) {
    gap.lines.forEach((line, k) => {
      const m = NOTE_LINE.exec(line);
      if (!m) return;
      out.push({
        where: 'gap', region: 'gap', line: gap.startLine + k, text: m[1].trim(), liftable: true,
        remedy: remedy('run `prt ask <N> --promote` (or `prt draft`) to turn it into a prt:ask block'),
      });
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Every note that regenerating over `promotedText` would destroy, with a reason.
 *
 * `prt draft` and `prt nudge` both overwrite the working copy, and `carryAsks`
 * carries `prt:ask` blocks and nothing else — so any note still written as an
 * `@ai` line after promotion moves to `history/` and out of the file the human
 * is reading, without a word. That set is not `refused`: `refused` names only
 * what the LIFT declined, and the lift never looks at `prt:log` or at a block's
 * header, which are precisely the two places nothing can lift from. Reading the
 * scanner's own answer instead is what makes the guard mean what it says.
 *
 * `refused` is still passed in, because it carries the one thing the scanner
 * cannot know: why the lift declined this particular line. Everything else is
 * the scanner's own `remedy`, so the reason `prt draft` prints for refusing and
 * the reason `prt ask` prints beside the `!` row are the same sentence.
 */
export function notesLostByRegenerating(promotedText, refused = []) {
  const why = new Map(refused.map((r) => [r.line, r.why]));
  return unpromotedNotes(promotedText).map((n) => ({
    ...n,
    why: why.get(n.line) ?? n.remedy,
  }));
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
    // PR-level actions the human arms alongside the verdict. Both default off:
    // a file with no `prt:pr-actions` block behaves exactly as it always did.
    prActions: { updateBranch: false, triggerCi: false },
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
  let sawPrActions = false;
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
    switch (b.kind) {
      case 'doc':
        r.doc = b.fields;
        break;

      case 'pr-actions': {
        // Two of these would let one say yes and the other no about the same
        // GitHub write, and the file would still look armed either way.
        if (sawPrActions) {
          r.errors.push(`${where}: a second \`<!-- prt:pr-actions -->\` block — the PR has one set of actions, so delete one.`);
          break;
        }
        sawPrActions = true;
        for (const [field, key] of Object.entries(PR_ACTION_FIELDS)) {
          r.prActions[key] = truthy(b.fields[field], false, bad, `${where} ${field}`);
        }
        // A misspelled flag reads as armed and does nothing at all, which is the
        // one outcome the human cannot tell apart from "it ran and did nothing".
        for (const field of Object.keys(b.fields)) {
          if (!(field in PR_ACTION_FIELDS)) {
            r.errors.push(`${where}: unknown field "${field}" — this block takes ${Object.keys(PR_ACTION_FIELDS).join(' and ')}`);
          }
        }
        break;
      }

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
          // What the TOOL wrote here, recorded when it wrote it. Absent on every
          // ask written before the field existed, which is what makes the
          // absence mean "no opinion" rather than "unchanged" — see `askState`.
          q: b.fields.q || null,
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
        // `re-q:` is the question this answer was written against, and it is
        // written only when that stops being the question the ask carries. An
        // answer without one inherits the ask's `q:`; see `askState`.
        r.answers.push({ to, disposition, did: did || null, in: b.fields.in || null, reQ: b.fields['re-q'] || null, body, sourceLine: b.startLine });
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
  //
  // A note typed inside a body that posts is a leak; a note inside an inert
  // block leaks nothing but is collected by nothing, so the review posts as if
  // it had never been written. Both are errors for the same reason a gap note
  // is — `prt submit` prints no warnings, so a warning here is indistinguishable
  // from silence.
  //
  // The in-block case stays a REFUSAL and not a submit-time strip. The format
  // promises the body is posted byte for byte, so quietly editing it here would
  // decouple the posted bytes from outbox/<txId>/approved.md. The remedy the
  // message names is `prt ask <N> --promote`, which lifts the note out on disk
  // before anything is armed — a change the human can read in the file and in
  // the history/ copy, which a strip could never be.
  //
  // Same scanner as `promoteShorthand` and `prt ask`, and anchored on the note's
  // own line rather than on the block's opening sentinel, so the promote report
  // and this error name the same line for the same note. Each note is named
  // once: two notes in one block are two errors, because the human has two lines
  // to go and fix.
  //
  // Every branch below states the SITUATION and then hands over to the scanner's
  // own `remedy`, so the sentence this error ends with is the same one `prt ask`
  // prints beside the `!` row and the same one `prt draft` refuses with. The
  // three used to be written out separately, and the `!` row drifted into naming
  // `--promote` for notes `--promote` is documented as unable to lift.
  const sentence = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  for (const note of unpromotedNotes(text)) {
    if (note.region === 'gap') {
      r.errors.push(`line ${note.line}: un-promoted \`@ai\` note — ${note.remedy}`);
      continue;
    }
    // A note in a block's HEADER is the one the file itself throws away:
    // `parseSentinelFields` keeps `key: value` and nothing else. Nothing lifts it
    // either, because a splice inside a sentinel is how a block loses its `id:`.
    if (note.region === 'header') {
      r.errors.push(`<!-- prt:${note.where} --> at line ${note.line}: an \`@ai\` note is inside the block's header, where it is read as a field and dropped. ${sentence(note.remedy)}`);
      continue;
    }
    const what = POSTABLE_KINDS.has(note.where)
      ? 'is inside text that gets posted'
      : 'is inside a block, so it will not be collected';
    r.errors.push(`<!-- prt:${note.where} --> at line ${note.line}: an \`@ai\` note ${what}. ${sentence(note.remedy)}`);
  }

  const askById = new Map(r.asks.map((a) => [a.id, a]));
  const terminalByAsk = new Map();
  for (const ans of r.answers) {
    if (ans.to && !askById.has(ans.to)) {
      r.errors.push(`<!-- prt:answer --> at line ${ans.sourceLine}: \`to: ${ans.to}\` does not match any ask in this file`);
      continue;
    }
    if (ans.disposition === 'addressed' || ans.disposition === 'declined') {
      // One terminal answer per QUESTION, not per ask id. The guard exists to
      // stop the model closing the same question twice, and it read "twice" as
      // "two blocks with the same `to:`" — which was the same thing right up
      // until a question could be rewritten under its answer. A reopened ask
      // needs a second terminal answer, or it can never close: the reseal has
      // pinned the first one to the wording it actually answered, so the two are
      // replies to two different questions and only one of them is live. Keyed
      // on that reference, the guard still catches the case it was written for —
      // two answers with no `re-q:` inherit the same `q:` and collide.
      const ask = askById.get(ans.to);
      const key = `${ans.to} ${ans.reQ ?? ask?.q ?? ''}`;
      if (terminalByAsk.has(key)) {
        r.errors.push(`<!-- prt:answer --> at line ${ans.sourceLine}: ask "${ans.to}" already has a terminal answer at line ${terminalByAsk.get(key)}`);
      } else terminalByAsk.set(key, ans.sourceLine);
    }
    // Guard 2: a claim that an inline was dropped is cross-checked against the
    // file. The model can write a wrong paragraph; it cannot write one that
    // contradicts the file's own state.
    const m = /^drop-inline\s+(\S+)$/.exec(ans.did ?? '');
    if (m) {
      const target = r.inline.find((c) => c.id === m[1]);
      // The check is against THIS file, so it means two different things
      // depending on when the answer was written, and reading it as one thing
      // wedged a live file permanently.
      //
      // In the round that wrote the answer, "there is no i1" means the model
      // claimed a drop it did not make: an error, and the whole point of the
      // guard. One round later it means the finding is gone from
      // `findings.json` and the comment was not regenerated — which is what
      // dropping it MEANS. The claim was already verified, as an error, in the
      // generation it was written in; re-checking it against a file that has
      // moved on turns an honest answer into a parse error, and because
      // `carryAsks` refuses to regenerate over a file whose notes it cannot
      // read, the `prt draft` that would have retired the pair is refused too.
      // The only exits were `--no-carry` (drops the human's words) or editing
      // `did:` to `answer-only` (falsifies the record of what the model did).
      //
      // So the round is what decides. `in:` names the generation the answer was
      // written in; an answer with no stamp is read as belonging to this one,
      // because that is the shape of a hand-written answer and the guard has to
      // keep its teeth in exactly that case.
      // `parseIntOrNull`, not `Number`: `Number('')` is 0, so a missing `in:`
      // read as generation 0 — carried against any real generation, leaving the
      // guard toothless for exactly the hand-written answer the paragraph above
      // says it must catch. `null` and `NaN` both fail `isFinite`, so an absent
      // or malformed stamp keeps the teeth.
      const wroteIn = parseIntOrNull(String(ans.in ?? '').replace(/^g/i, ''));
      const fileGen = parseIntOrNull(r.doc?.generation);
      const carried = Number.isFinite(wroteIn) && Number.isFinite(fileGen) && wroteIn < fileGen;
      if (!target && !carried) {
        r.errors.push(
          `inline "${m[1]}": the answer at line ${ans.sourceLine} says \`did: drop-inline ${m[1]}\`, `
          + `but this file has no inline "${m[1]}". Name the comment you really dropped, or use \`did: answer-only\`. `
          + `If it was dropped in an earlier round, stamp that answer with \`in: g<N>\` — the check only applies to the round it was written in.`,
        );
      } else if (target?.post) {
        r.errors.push(`inline "${m[1]}": the answer at line ${ans.sourceLine} says \`did: drop-inline ${m[1]}\`, but that comment still has \`post: true\``);
      } else if (target && target.droppedBy && ans.to && target.droppedBy !== ans.to) {
        // Provenance should name the note that actually claimed the drop. A
        // warning rather than an error: only one ask fits in `dropped-by:`, so a
        // comment dropped for two reasons would otherwise be unresolvable.
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
 * The fingerprint of an ask's question, as the tool wrote it.
 *
 * Short — 24 hex, the width `contentHash` already uses — because it is a field a
 * human reads past in a sentinel, not a cryptographic commitment: what it has to
 * survive is an editor, not an adversary.
 *
 * Three normalisations, and no more. A BOM, CRLF, and trailing whitespace on a
 * line are what an editor changes without being asked; none of the three is the
 * human saying anything, and each would otherwise reopen an answered note the
 * moment the file was opened somewhere else. Everything else is left alone
 * deliberately — re-wrapping a paragraph, changing a word, adding a sentence,
 * deleting one, are all the human saying something, and this is the function
 * that has to notice.
 */
export function questionHash(text) {
  const norm = stripBom(String(text ?? ''))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
  return `sha256:${createHash('sha256').update(norm).digest('hex').slice(0, 24)}`;
}

/**
 * Whether an answer still answers the question its ask now carries.
 *
 * The reference bytes are the answer's own `re-q:` when it has one, and the
 * ask's creation stamp `q:` otherwise — because an answer written under a
 * question nobody has touched since IS an answer to `q:`, and making the common
 * case cost the model a field it could forget is how a guarantee becomes
 * advisory. `resealEditedAsks` is what writes `re-q:`, and it writes it at the
 * one moment the value is known: when it moves `q:` off the bytes that answer
 * was written against.
 *
 * Neither field present is a file written before either existed. It answers
 * `true`. The one thing this must not do is reopen every note in a store that
 * predates it — what the tool did not record, it does not get to have an opinion
 * about.
 */
function answersCurrentQuestion(ask, answer, now) {
  const ref = answer.reQ ?? ask.q ?? null;
  return ref === null || ref === now;
}

/**
 * An ask's state is DERIVED from the answers pointing at it, never stored.
 *
 * A stored `state:` field and an answer body are two independent facts that can
 * disagree — "addressed" with nothing to show for it. Deriving makes that
 * disagreement unrepresentable: there is no `addressed` without its
 * justification, because `addressed` *is* an answer block carrying one.
 *
 * There is deliberately no reopen transition the human can WRITE. Unsatisfied by
 * an answer? A new ask with `follows:` keeps the chain linear and auditable, and
 * deleting the answer block reopens the ask precisely because the state is
 * derived.
 *
 * EDITING THE QUESTION reopens it too, for exactly that reason: an answer
 * answers a question, so once the question is no longer the one that was
 * answered, there is no answer left to derive `addressed` from. That is not a
 * second place state is stored — it is the same derivation, reading one more
 * fact the file already carries.
 *
 * It matters because rewriting the question in place is the natural way to
 * escalate: the model got it wrong, the words are right there, and the human
 * types over them. Before this, those words were printed by `prt ask`, ignored
 * by `--promote`, waved through by `validate`, posted by `submit`, and retired
 * to `history/` by the next `prt draft` — silent in every one of those
 * directions. The note in the live store this was found on read `*@ai STOP …
 * Do not post until that is fixed.`
 *
 * `edited` is its own state rather than a bare `open` because the two are not
 * the same situation: `open` is a question nobody has answered, and `edited` is
 * a question whose answer is stale and still sitting on the page under it. The
 * `prt ask` row, `askHandlingLine` and the submit refusal all read the name, and
 * a human shown `open` above an answer they can see would be right to conclude
 * the tool had lost track.
 */
export function askState(ask, answers) {
  if (ask.closed) return { state: 'withdrawn', open: false, disposition: null, answer: null };
  const now = questionHash(ask.question);
  const mine = answers.filter((a) => a.to === ask.id);
  const live = mine.filter((a) => answersCurrentQuestion(ask, a, now));
  const terminal = live.filter((a) => a.disposition === 'addressed' || a.disposition === 'declined').pop();
  if (terminal) return { state: terminal.disposition, open: false, disposition: terminal.disposition, answer: terminal };
  const deferred = live.filter((a) => a.disposition === 'deferred').pop();
  if (deferred) return { state: 'deferred', open: true, disposition: 'deferred', answer: deferred };
  // Answers exist, and none of them is about this question any more. They stay
  // attached to the ask — `askHandlingLine` and the renderer both fall back to
  // the last answer of any disposition — so the conversation stays on the page
  // rather than only in `history/`.
  if (mine.length) return { state: 'edited', open: true, disposition: null, answer: null, edited: true };
  return { state: 'open', open: true, disposition: null, answer: null };
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

/**
 * Highest `a<n>` ordinal anywhere in the text.
 *
 * Half of "a retired id is never reissued", and only half: a retired ask is not
 * in the text any more, so callers take the max of this and the high-water mark
 * they keep in the PR's `state.json`. Both call sites do. This function alone
 * would hand out `a1` again the round after `carryAsks` retired `a1`..`a3`.
 */
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
 * Turn `@ai …` notes into canonical `prt:ask` blocks.
 *
 * Pure: returns new text plus a report of every promotion and every refusal, so
 * nothing is inferred silently. An optional leading target token binds a note;
 * otherwise it binds to the nearest preceding block id, because that is where a
 * human types a reaction — and for a note typed INSIDE a block that resolves to
 * the block itself, which is exactly what the note is about.
 *
 * A note in a gap is promoted in place, and runs to the next blank line or the
 * next column-0 `<!--`. A note inside a block is LIFTED: its lines are deleted
 * and the `prt:ask` is emitted after that block's terminator. The lift is a
 * visible on-disk edit made before anything is armed, because the alternative —
 * a submit-time strip — would decouple the posted bytes from
 * `outbox/<txId>/approved.md`. `refused` names every note that could not be
 * lifted safely; those stay where the human put them, parse error and all.
 *
 * A note lifted out of a `prt:ask` or `prt:answer` body binds with `follows:`
 * rather than by position. The human wrote it under a question or under its
 * answer, so what they meant is "and about that one" — which is the one thing
 * `follows:` records, and the only shape that reopens a closed conversation.
 *
 * **Every note this function LOOKS AT leaves it either promoted or refused.**
 * That is the invariant the two collectors below are shaped around, and it is
 * narrower than "every note in the file" on purpose: this function looks at
 * gaps and at the bodies of `LIFTABLE_KINDS`, and at nothing else. A note in a
 * `prt:log` body, in any block's header, in a block whose sentinel or terminator
 * is broken, or in a block of an unknown kind is deliberately outside its reach —
 * see `LIFTABLE_KINDS` and `unpromotedNotes` for why a splice there would
 * destroy the thing the block exists for — so those appear in neither
 * `promoted` nor `refused`. `notesLostByRegenerating` is the predicate that
 * covers the whole file; use that one, not `refused`, before overwriting a
 * draft.
 *
 * Within that reach nothing is dropped on the floor: both collectors scan with
 * `NOTE_LINE`, the same regex `unpromotedNotes` and `parseActionFile` use, so
 * there is no note the parser calls an error here and this function cannot
 * account for. The gap collector's run rule always terminates, so a gap note is
 * always promotable; only the block collector can refuse, and it names a line
 * and a reason every time it does. A note the human cannot see the tool react
 * to is worse than an error, because they believe they have been heard.
 */
export function promoteShorthand(text, { startOrdinal = 1, generation = null } = {}) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const blocks = tokenize(src);
  const gaps = gapsOf(src);
  const promoted = [];
  const refused = [];
  let ordinal = startOrdinal;

  // Which lines a block owns, so a `## ` heading can be told from the human's
  // markdown inside a body. Same shape as `gapsOf`'s `covered`.
  const inBlock = new Array(lines.length).fill(false);
  for (const b of blocks) for (let k = b.startLine - 1; k < b.endLine && k < lines.length; k++) inBlock[k] = true;

  // line number (1-based) -> id of the block that ends at or before it
  const precedingId = (lineNo) => {
    let best = null;
    let bestEnd = 0;
    for (const b of blocks) {
      if (b.startLine > lineNo) break;
      if (b.kind === 'verdict') { best = 'verdict'; bestEnd = b.endLine; }
      else if (b.kind === 'body') { best = 'body'; bestEnd = b.endLine; }
      else if (b.fields?.id && (b.kind === 'inline' || b.kind === 'thread' || b.kind === 'issue-comment')) {
        best = b.fields.id;
        bestEnd = b.endLine;
      }
    }
    // A `## ` heading between that block and the note starts a new section, and
    // a note under a new heading is not a reaction to what came before it. The
    // file now ends with `## Resolved notes` — a heading humans read and type
    // under — so without this a note left there binds to whatever inline block
    // happened to be last, hundreds of lines above.
    //
    // Gap text only, the same rule `relocateResolvedAsks` and `ensurePrActions`
    // apply, and for the same reason: a review summary routinely carries `## `
    // headings, and one INSIDE a body is the human's markdown, not a section
    // boundary. Scanning raw lines made an intervening `prt:context`/`prt:notes`
    // whose body happened to carry a heading rebind the note to `general`.
    for (let k = bestEnd; k < lineNo - 1 && k < lines.length; k++) {
      if (!inBlock[k] && /^##\s/.test(lines[k])) return 'general';
    }
    return best ?? 'general';
  };

  // Lift an explicit target off the front: `i3 …`, `verdict …`, `follows a5 …`
  //
  // A leading token sets the target. It is only CONSUMED when a punctuation
  // separator follows, because a bare space is ambiguous: "general cleanup of
  // the summary" and "i1 is fine, it is i2 that is wrong" both open with a
  // token that is also an ordinary word, and eating it would delete a word the
  // human wrote. Losing their words is never an acceptable cost for a tidier
  // body, so without punctuation the target is read and the text is kept whole.
  //
  // `chain` is the ask a note was typed underneath — set only for a note lifted
  // out of a `prt:ask` or `prt:answer` body. It supplies `follows:` when the
  // human did not name a target themselves, because position cannot: a note
  // written inside an answer sits below whatever inline block came last, and
  // binding it there would attach it to a comment it was never about.
  // The target a note inherits when it chains off an ask — written `follows a1`,
  // typed as `a1: …`, or lifted out of a1's own pair. One rule for all three,
  // because all three mean "and about that one", and three answers to one
  // question is how a file starts contradicting itself.
  //
  // It inherits the ask's OWN target, so the follow-up lands beside the comment
  // the conversation is about rather than in the general pile. `gone` is not a
  // target but a tombstone: inheriting it would hoist the new note under the
  // "the comment these were about is no longer in the draft — check `outbox/`"
  // banner, over a comment this note was never about, so that one falls back.
  const chainTarget = (askId) => {
    const b = blocks.find((x) => x.kind === 'ask' && String(x.fields?.id ?? '').trim() === askId);
    const t = String(b?.fields?.re ?? '').trim();
    return t && t !== 'gone' ? t : 'general';
  };

  const bind = (raw, lineNo, chain = null) => {
    let re = null;
    let follows = null;
    // Whether the HUMAN named the target, which is what `inferred` reports. A
    // chained note has a `re:` either way, so `re` alone stopped answering it.
    let named = false;
    let bodyText = raw;
    const SEP = /^[ \t]*[:,.—–-]+[ \t]*/;
    let mt = /^follows\s+(a\d+)\b/i.exec(raw);
    if (mt) {
      follows = mt[1];
      re = chainTarget(follows);
      named = true;
      const rest = raw.slice(mt[0].length);
      const sep = SEP.exec(rest);
      bodyText = sep ? rest.slice(sep[0].length) : rest.replace(/^[ \t]+/, '');
    } else {
      mt = /^([A-Za-z][\w-]*)\b/.exec(raw);
      if (mt) {
        const tok = mt[1].toLowerCase();
        const target = blocks.find((b) => b.fields?.id === mt[1]);
        if (SYMBOLIC_TARGETS.has(tok) || target) {
          // Naming an ASK is chaining, not targeting. `re: a1` says "this note
          // is about comment a1", and `a1` is not a comment — so the next
          // `prt draft`, which rebinds against the ids the new file will carry,
          // found no such comment and orphaned the note to `re: gone  was: a1`
          // under a banner telling the human to check `outbox/` for something
          // that was never posted, while a1 sat fifty lines below under
          // `## Resolved notes`. `follows:` is the field that exists for this.
          if (target?.kind === 'ask') {
            follows = String(target.fields.id ?? '').trim();
            re = chainTarget(follows);
          } else {
            re = target ? mt[1] : tok;
          }
          named = true;
          const rest = raw.slice(mt[0].length);
          const sep = SEP.exec(rest);
          bodyText = sep ? rest.slice(sep[0].length) : raw;
        }
      }
      // A note lifted out of a `prt:ask` or `prt:answer` body the human did not
      // target themselves. Position cannot bind it — it sits below whatever
      // inline block came last — so it chains, by the same rule.
      if (!named && chain) {
        follows = chain;
        re = chainTarget(chain);
      }
    }
    return { re: re ?? precedingId(lineNo), follows, bodyText, inferred: !named };
  };

  // Every note in the file, collected before any of them is rendered, so the
  // `a<n>` ordinals run down the page in FILE order whether a note was typed in
  // a gap or lifted out of a block — the promote report is the only feedback
  // the human gets, and it should list their notes in the order they wrote them.
  //   `del`    the 1-based inclusive line span to remove
  //   `after`  the terminator line to emit the ask after; null = emit in place
  const candidates = [];

  for (const gap of gaps) {
    let k = 0;
    while (k < gap.lines.length) {
      const m = NOTE_LINE.exec(gap.lines[k]);
      if (!m) { k++; continue; }
      const firstLineNo = gap.startLine + k;
      const collected = [m[1]];
      let j = k + 1;
      while (j < gap.lines.length) {
        const nxt = gap.lines[j];
        if (!nxt.trim()) break;
        if (/^<!--/.test(nxt)) break;
        if (NOTE_LINE.test(nxt)) break;
        // A note written as a list item ends at the next sibling item, the same
        // rule the lift uses below. Tested against the NOTE's line, not the last
        // line collected, so a nested item still reads as part of the note.
        if (endsListItem(gap.lines[k], nxt)) break;
        collected.push(nxt);
        j++;
      }
      candidates.push({
        line: firstLineNo,
        raw: collected.join('\n').trim(),
        lifted: null,
        del: { from: firstLineNo, to: gap.startLine + j - 1 },
        after: null,
      });
      k = j;
    }
  }

  // ---- notes typed INSIDE a block -----------------------------------------
  //
  // Two rules govern the lift, and neither of them is the gap rule above. In a
  // gap a note may run to the end of its paragraph, which costs nothing because
  // no gap line is ever posted. Inside a block every other line is either bytes
  // bound for GitHub or bytes a generator owns, so:
  //
  //   * A note is exactly ONE line. In a body the line after a note is normally
  //     just the next sentence of the review, and nothing in the text tells "the
  //     rest of my note" apart from "the rest of my summary" — collecting it
  //     would delete outgoing prose the human had already written.
  //   * That line must be FENCED on the right by a blank line, an HTML comment,
  //     another note, the sibling list item that ends it, or the end of the
  //     body. A note butted straight up against prose is precisely the ambiguous
  //     case rule one refuses to guess at, so it is left alone and reported
  //     instead.
  //
  // The sibling-list-item arm is what makes `- @ai …` work at all. A bulleted
  // note is by construction butted against the next item, so before it every
  // bulleted note was refused — a form the docs advertise and the natural one to
  // type while reading a bulleted body. A sibling item cannot be the rest of the
  // note above it, which is the one thing rule one needs to know, so the
  // ambiguity the refusal exists for is simply not present. `endsListItem`
  // requires the NOTE to be a list item too: `@ai please:` followed by `- do X`
  // is a note whose bullets belong to it, and that stays refused.
  //
  // A note that stands in its own paragraph takes the blank line below it with
  // it, so the prose on either side closes up exactly as if the note had never
  // been typed. A note butted up under prose does NOT: there the blank below is
  // the separator the paragraph BELOW needs, and taking it welds two paragraphs
  // (or a list and the paragraph after it) into one — a change to posted bytes
  // well beyond the note. So the left side is tested with the same vocabulary as
  // the right, and only a note fenced on both sides owns the blank.
  for (const b of blocks) {
    if (!LIFTABLE_KINDS.has(b.kind)) continue;
    // Never edit a block whose extent is a guess: an unterminated block runs on
    // to the next sentinel, so the lines this would delete may belong to a
    // different block. Its own parse error comes first.
    if (b.unterminated || b.malformedSentinel || b.bodyStartLine == null) continue;

    const bodyLines = b.body.split('\n');
    // The one line the scanner does not report, and so the one line this must
    // not lift: a `prt:ask`'s own question. See `askQuestionLine`.
    const questionAt = askQuestionLine(b);
    // `follows:` for anything lifted out of the note channel itself.
    const chain = b.kind === 'ask'
      ? (String(b.fields.id ?? '').trim() || null)
      : (b.kind === 'answer' ? (String(b.fields.to ?? '').trim() || null) : null);
    const found = [];
    const dropped = new Set();
    for (let k = 0; k < bodyLines.length; k++) {
      if (k === questionAt) continue;
      const m = NOTE_LINE.exec(bodyLines[k]);
      if (!m) continue;
      const next = bodyLines[k + 1];
      const prev = k === 0 ? undefined : bodyLines[k - 1];
      const fences = (l) => l === undefined || !l.trim() || /^<!--/.test(l) || NOTE_LINE.test(l);
      const fenced = fences(next) || endsListItem(bodyLines[k], next);
      if (!fenced) {
        refused.push({
          kind: b.kind,
          line: b.bodyStartLine + k,
          // The remedy that LEADS has to be safe under both readings of the
          // ambiguity this refusal exists for, because only the human knows
          // which one is true. "Put a blank line after the note" is not. Under
          // the reading the reference doc singles out — `@ai please:` followed
          // by the bullets that say what to please do — the blank fences the
          // note at its first line, so the lift takes `please:`, the bullets
          // stay in the block, and the human's private instruction is POSTED,
          // with no refusal and a clean `prt validate`. A remedy that causes
          // the one harm the tool exists to prevent is worse than no remedy.
          //
          // Moving the note out of the block is safe under both, and that is
          // why it leads: a gap note runs to the end of its paragraph, so the
          // continuation travels with it whether or not it was ever part of the
          // note. The blank line is still named — under the other reading it is
          // the one-keystroke fix — but with what it actually does, so the
          // choice is the human's and is made with the outcome in front of
          // them. Backticks stay for the third reading: never a note at all.
          //
          // "not blank" rather than "is prose": a deeper list item under a
          // bulleted note trips the same refusal (`endsListItem` deliberately
          // does not fence a nested child), and calling that prose described a
          // file the human was not looking at.
          why: 'the line below it is not blank, so the lift cannot tell where the note ends — move the note, with everything that belongs to it, out of the block into a gap, where a note runs to the end of its paragraph. A blank line after the note instead lifts its FIRST LINE ONLY and posts the rest, so use that only if what follows is the review\'s own text; and if the line was never a note, put the token in backticks',
        });
        continue;
      }
      // Only the blank below is ever taken, and only from a note that stands
      // alone; a sibling list item is a fence, never a line this may delete.
      const last = (fences(prev) && next !== undefined && !next.trim()) ? k + 1 : k;
      found.push({ line: b.bodyStartLine + k, raw: m[1].trim(), from: b.bodyStartLine + k, to: b.bodyStartLine + last });
      for (let z = k; z <= last; z++) dropped.add(z);
    }
    if (!found.length) continue;

    // Refuse to empty a block whose emptiness changes the file. `r.body =
    // b.body.trim() || null` turns an emptied prt:body into no body at all, and a
    // review that also carries an inline comment then parses clean and posts with
    // no summary — the human's own words lost silently, on the one path that
    // reaches GitHub. `NEVER_EMPTY_KINDS` names the rest. Whether the block
    // should go is their call, not this function's.
    const remaining = bodyLines.filter((_, z) => !dropped.has(z)).join('\n').trim();
    if (!remaining && NEVER_EMPTY_KINDS.has(b.kind)) {
      refused.push({
        kind: b.kind,
        line: found[0].line,
        why: 'the note is the whole block — delete the block, or give it something to say, then promote again',
      });
      continue;
    }
    for (const f of found) {
      candidates.push({ line: f.line, raw: f.raw, lifted: b.kind, chain, del: { from: f.from, to: f.to }, after: b.endLine });
    }
  }

  // `{from, to, text}` over 1-based inclusive line ranges, in two forms the
  // splice below understands: `to === from - 1` inserts before `from` without
  // consuming a line, and `text: null` deletes the span outright.
  const replacements = [];
  const inserts = new Map(); // terminator line -> the ask blocks to emit after it
  for (const c of candidates.sort((a, b) => a.line - b.line)) {
    const { re, follows, bodyText, inferred } = bind(c.raw, c.line, c.chain ?? null);
    const id = `a${ordinal++}`;
    const sentinel = ['<!-- prt:ask', `id: ${id}`, `re: ${re}`];
    if (follows) sentinel.push(`follows: ${follows}`);
    if (generation) sentinel.push(`raised: g${generation}`);
    // The only moment the tool can HONESTLY stamp a question is the moment it
    // writes one. Every other write — a regeneration, a tidy, a reseal — is
    // copying bytes it found on disk, and stamping there records what the file
    // says now rather than what the tool put there. See `resealEditedAsks`.
    sentinel.push(`q: ${questionHash(bodyText.trim())}`);
    sentinel.push('-->');
    const asBlock = `${sentinel.join('\n')}\n${bodyText.trim()}\n<!-- /prt -->`;
    promoted.push({ id, re, follows, inferred, line: c.line, lifted: c.lifted, firstLine: bodyText.trim().split('\n')[0] });
    if (c.after === null) {
      replacements.push({ from: c.del.from, to: c.del.to, text: asBlock });
    } else {
      replacements.push({ from: c.del.from, to: c.del.to, text: null });
      if (!inserts.has(c.after)) inserts.set(c.after, []);
      inserts.get(c.after).push(asBlock);
    }
  }
  // One insert per block, carrying that block's asks in file order, so no two
  // zero-width ops ever share a line coordinate.
  //
  // The trailing blank is conditional on what the source line after the
  // terminator actually is. Unconditionally it would double a blank the file
  // already had; without it, a gap note sitting on the very next line — which is
  // where a human writes a second thought — had its own `prt:ask` written hard
  // against this one's `<!-- /prt -->`, and the two read as a single run-on
  // block in the file the human is about to edit.
  for (const [after, asks] of inserts) {
    const nextLine = lines[after]; // 0-based index of the line after `after`
    const tail = nextLine !== undefined && nextLine.trim() ? [''] : [];
    replacements.push({ from: after + 1, to: after, text: [...asks.flatMap((a) => ['', a]), ...tail].join('\n') });
  }

  // The lift runs FIRST and the reseal reads what it left, never the other way
  // round. A note typed under an answered question is part of that question's
  // bytes until the lift takes it out, so a reseal in front of the lift would
  // move `q:` onto text the lift is about to delete — and the ask would then be
  // permanently `edited`, against a question that had gone back to reading
  // exactly as the tool wrote it.
  if (!replacements.length) return { ...resealEditedAsks(src), promoted, refused };
  // The ops share line coordinates without overlapping: a lift deletes lines
  // inside a block and inserts after that block's terminator, and a gap note may
  // begin on the very next line — so two ops have the same `from` and the insert
  // is the one with `to === from - 1`. Sorting on `from` alone left that pair in
  // push order and moved `cursor` BACKWARDS, which re-emitted the tail: the raw
  // `@ai` line came back into the file, tripped the un-promoted error, matched
  // carryAsks' structural filter and wedged `prt draft` on a file only a
  // hand-edit or `--no-carry` could rescue.
  //
  // The tie-break on `to` is what fixes that, and is what the test pins. The
  // `Math.max` is the invariant stated as code — the cursor never rewinds — and
  // is unreachable while every op comes from the two collectors above. It stays
  // because a third op shape is what would reintroduce the duplication, and
  // silently.
  const out = [];
  let cursor = 0; // 0-based index of the next source line still to copy
  for (const rep of replacements.sort((a, b) => (a.from - b.from) || (a.to - b.to))) {
    for (let z = cursor; z < rep.from - 1; z++) out.push(lines[z]);
    if (rep.text !== null) out.push(rep.text);
    cursor = Math.max(cursor, rep.to);
  }
  for (let z = cursor; z < lines.length; z++) out.push(lines[z]);
  return { ...resealEditedAsks(out.join('\n')), promoted, refused };
}

/**
 * Move `q:` onto the question a human has rewritten, and freeze the answers that
 * were written against the old one.
 *
 * Pure, byte-for-byte unchanged when there is nothing to do, and idempotent: a
 * second run finds every `q:` already matching and returns its input.
 *
 * This is the half of the mechanism that makes the reopen CONSUMABLE. `askState`
 * reopens an ask the moment its question stops matching `q:`, which is what has
 * to happen — but on its own that reopen is permanent, because the next answer
 * the model writes carries no `re-q:` and so inherits the same stale `q:` and is
 * stale on arrival. So exactly one writer moves the two fields, together and in
 * one direction:
 *
 *   - `q:` moves forward to the question as it now reads, and
 *   - every answer that was relying on the old `q:` gets it written out as its
 *     own `re-q:`, so it keeps pointing at the question it actually answered.
 *
 * The ask stays open across that — the old answers are still stale, they are
 * just stale explicitly now — and the NEXT answer, with no `re-q:` of its own,
 * inherits the new `q:` and closes it. The human's edit is accepted as the
 * question; the model's earlier reply is not accepted as its answer.
 *
 * An ask with no `q:` at all is left completely alone — not resealed, and not
 * back-filled either. Back-filling was written first and the suite refused it,
 * correctly: `promoteShorthand` is pinned to change nothing in a file it has
 * nothing to promote, and a stamp taken from bytes on disk records what the file
 * says now rather than what the tool wrote, which is the one thing this field is
 * for. So the protection begins where the stamp can be honest — at creation, in
 * `promoteShorthand` — and an ask written before the field existed never gains
 * one. There are two such asks in the live store and `carryAsks` retires both
 * within a generation.
 */
export function resealEditedAsks(text) {
  const src = stripBom(text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const blocks = tokenize(src);
  const resealed = [];
  const inserts = new Map();  // 0-based line index -> lines to emit BEFORE it
  const rewrite = new Map();  // 0-based line index -> the line it should read
  const addInsert = (at, line) => {
    if (!inserts.has(at)) inserts.set(at, []);
    inserts.get(at).push(line);
  };
  // The `-->` line of a multi-line sentinel: `tokenize` strips the `-->` off the
  // last sentinel line it keeps, so that line is the terminator's. A one-line
  // sentinel has no room for a field and is skipped — an `<!-- prt:ask -->` with
  // no `id:` is a free stub anyway.
  const closerOf = (b) => (b.sentinel.length >= 2 ? b.startLine + b.sentinel.length - 2 : -1);

  for (const b of blocks) {
    if (b.kind !== 'ask' || b.unterminated || b.malformedSentinel) continue;
    const id = String(b.fields.id ?? '').trim();
    if (!id) continue;
    const question = b.body.replace(/^\n+/, '').replace(/\s+$/, '');
    if (!question) continue; // an emptied ask is a free stub, not a question
    const now = questionHash(question);
    const have = b.fields.q || null;
    if (have === null || have === now) continue;

    const k = b.sentinel.findIndex((l) => /^\s*q\s*:/i.test(l));
    if (k < 0) continue; // the field parsed but is not on its own line: leave it
    const qAt = b.startLine - 1 + k;
    // Replace only the VALUE. The last sentinel line can carry the `-->` that
    // `tokenize` stripped before handing it over, and rewriting the whole line
    // would take the terminator with it.
    rewrite.set(qAt, lines[qAt].replace(/^(\s*[qQ]\s*:\s*)\S*/, `$1${now}`));
    for (const ab of blocks) {
      if (ab.kind !== 'answer' || ab.unterminated || ab.malformedSentinel) continue;
      if (String(ab.fields.to ?? '').trim() !== id) continue;
      if (ab.fields['re-q']) continue; // already pinned to a question of its own
      const aAt = closerOf(ab);
      if (aAt >= 0) addInsert(aAt, 're-q: ' + have);
    }
    resealed.push({ id, from: have, to: now });
  }

  if (!inserts.size && !rewrite.size) return { text, resealed: [] };
  const out = [];
  for (let z = 0; z < lines.length; z++) {
    if (inserts.has(z)) out.push(...inserts.get(z));
    out.push(rewrite.has(z) ? rewrite.get(z) : lines[z]);
  }
  return { text: out.join('\n'), resealed };
}

/**
 * Render one ask (plus its answers) back to canonical block text.
 *
 * `q:` and `re-q:` are copied, never recomputed. Recomputing `q:` from
 * `ask.question` here would make every regeneration launder an edit the human
 * had just made: `prt draft` would write back a stamp that matched the edited
 * words, the stale answer would start closing the ask again, and the reopen
 * would last exactly until the next round — which is the failure, with a longer
 * fuse. There is one writer for those two fields, `resealEditedAsks`, and it
 * moves them together.
 */
export function renderAsk(ask, answers = []) {
  const s = ['<!-- prt:ask', `id: ${ask.id}`, `re: ${ask.re}`];
  if (ask.blocking === false) s.push('blocking: no');
  if (ask.closed) s.push('closed: yes');
  if (ask.follows) s.push(`follows: ${ask.follows}`);
  if (ask.raised) s.push(`raised: ${ask.raised}`);
  if (ask.was) s.push(`was: ${ask.was}`);
  if (ask.q) s.push(`q: ${ask.q}`);
  s.push('-->');
  const out = [s.join('\n'), ask.question, '<!-- /prt -->'];
  for (const ans of answers) {
    const a = ['<!-- prt:answer', `to: ${ans.to}`, `disposition: ${ans.disposition}`];
    if (ans.did) a.push(`did: ${ans.did}`);
    if (ans.in) a.push(`in: ${ans.in}`);
    if (ans.reQ) a.push(`re-q: ${ans.reQ}`);
    a.push('-->');
    out.push('', a.join('\n'), ans.body, '<!-- /prt -->');
  }
  return out.join('\n');
}

// -------------------------------------------------------- resolved-note log

/**
 * Heading and framing for the log of notes that have already been handled.
 *
 * It lives here, beside `PR_ACTIONS_SECTION` and for the same reason: two
 * things write this section — the generator places resolved notes here on every
 * regeneration, and `relocateResolvedAsks` moves them here in-round — and a
 * heading whose wording had drifted between them would read as two sections
 * that happen to be about the same thing. Worse, `relocateResolvedAsks` matches
 * `RESOLVED_HEADING` to find the section it must append to, so a drift would
 * silently produce a second one.
 *
 * The framing says "log" on purpose. `prt:log` is the submitter's own
 * append-only record and renders its own `## Activity log` heading, and a note
 * cannot live inside it (see `relocateResolvedAsks`). Naming this one a log in
 * the prose rather than in the heading keeps exactly one `log` heading in the
 * file while still answering to the name the human asked for.
 *
 * What the framing must not do is state the section's contents as a fact. It
 * said "each one has an answer, so none of them blocks a submit", and the
 * section is BYTES while that is DERIVED: delete an answer and the note reopens
 * and stops the submit, and until the next `prt draft` or `prt ask --tidy` the
 * heading goes on saying otherwise about a pair sitting right under it. So the
 * framing says what the section IS and names the command that reconciles it,
 * which is true on every byte of every file at every moment.
 */
export const RESOLVED_NOTES_SECTION = [
  '## Resolved notes',
  '',
  '*Notes that had been handled when this section was last written. It is text, not state:*',
  '*`prt ask <N>` derives what each note actually is now, and `prt ask <N> --tidy` reconciles this.*',
  '*Kept for one more round, then retired to `history/`. Never posted.*',
];

/** Matches the heading above, so the section is found rather than duplicated. */
export const RESOLVED_HEADING = /^##\s+Resolved notes\s*$/;

/**
 * Clip to `max` on a word boundary, without leaving an unbalanced code span.
 *
 * A cut that lands mid-backtick opens a span that swallows the rest of the
 * line, so the summary would render as code and hide the state tokens in front
 * of it.
 */
function clipGist(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  let out = space > max * 0.6 ? cut.slice(0, space) : cut;
  while (out.length && (out.match(/`/g) ?? []).length % 2 === 1) out = out.slice(0, out.lastIndexOf('`'));
  return `${out.replace(/[\s,;:—–-]+$/, '')}…`;
}

/**
 * The one useful sentence of an answer, for the summary line.
 *
 * The LAST paragraph, not the first: an answer opens with what was changed and
 * closes with what the human still has to weigh, and the closing half is the
 * half that decides whether the pair is worth opening. The real answers in this
 * store have first *lines* of 492 and 895 characters — a whole paragraph each —
 * so "the first line, truncated" summarises nothing. A single-paragraph answer
 * has one paragraph either way, so the rule costs nothing in the common case.
 *
 * 180 characters is the shortest cap that still reaches the actionable clause of
 * the only real multi-paragraph answer in the store ("…so it is worth a look
 * before you arm it"); at 160 that clause is cut off mid-phrase.
 *
 * Two shapes an answer routinely ends in are not sentences, and the first-sentence
 * rule turned both into noise:
 *
 *   - A LIST. "I did this, this and this" is a real summary — it just has to
 *     read as one line, so the markers come off and the items are joined. The
 *     sentence clip is skipped there, or a list of three would summarise as its
 *     first item.
 *   - A CODE FENCE or a TABLE. Neither summarises anything in a one-line log, so
 *     the search steps back to the last paragraph that is words. If there is no
 *     such paragraph the last one is used anyway: a line that says something
 *     awkward beats a line that says nothing.
 */
function answerGist(body, max = 180) {
  const paras = String(body ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return '';
  const rows = (p) => p.split('\n').filter((l) => l.trim());
  const isFence = (p) => /^ {0,3}(?:```|~~~)/.test(p);
  const isTable = (p) => rows(p).every((l) => /^\s*\|/.test(l));
  const isList = (p) => rows(p).every((l) => LIST_ITEM.test(l));
  const pick = [...paras].reverse().find((p) => !isFence(p) && !isTable(p)) ?? paras[paras.length - 1];
  if (isList(pick)) {
    return clipGist(rows(pick).map((l) => l.replace(LIST_ITEM, '').trim()).join('; '), max);
  }
  const last = pick.replace(/\s+/g, ' ');
  const sentence = /^[\s\S]*?[.?!](?=\s|$)/.exec(last)?.[0] ?? last;
  return clipGist(sentence, max);
}

/**
 * One line saying how a note was handled, for the `## Resolved notes` log.
 *
 * Derived from the ask and its answers rather than stored as a field: a stored
 * field is a third fact that can disagree with the other two, which is what
 * `askState`'s "derived, never stored" rule exists to make unrepresentable.
 *
 * Both writers that can put this line on disk re-derive it. `prt draft`
 * re-renders the whole file from the carried asks, and `relocateResolvedAsks` —
 * which writes the line as ordinary gap text when it files a pair — reads every
 * pair already in the section on each run: a line that describes a state the
 * file no longer has is rewritten in place, and a pair whose ask has REOPENED is
 * taken back out of the section, beside its target where the renderer would put
 * it, with this line dropped rather than carried.
 *
 * "Rewritten in place" is bounded by one rule, because the section is text a
 * human reads and the line is the natural place to react to what the model
 * reported: a line that STARTS with the currently derived one is that line plus
 * words they typed after it, and it is left alone. Only a line that no longer
 * derives at all is replaced, and the replacement says what it took with it.
 *
 * `prt draft` does that unconditionally. `relocateResolvedAsks` does it for
 * every pair it can move losslessly, and NAMES the ones it cannot — a pair with
 * a stray line between the note and its answer, two blocks claiming one id — the
 * same refusals that govern the filing direction, so the exceptions are the ones
 * already documented there rather than a second set.
 *
 * What the stored line is not is live. Between the human's edit and the next of
 * those two commands it still reads as it was last written, and nothing but
 * those two rewrites it — so a reader who needs the current state reads
 * `askState`, which is derived on every call, rather than this line.
 *
 * Only the tokens with a closed vocabulary — the id, the derived state, the
 * `did:` verb, the generation — are italicised. The prose after them is the
 * model's own bytes and may contain `*`, `_` or a code span; wrapping it would
 * break the line, and escaping it would edit the model's words to make a
 * summary look tidy.
 */
export function askHandlingLine(ask, answers = []) {
  const st = askState(ask, answers);
  const mine = answers.filter((x) => x.to === ask.id);
  // A withdrawn ask has `answer: null` even when one was written, so fall back
  // to the last answer of any disposition rather than showing nothing.
  const ans = st.answer ?? mine[mine.length - 1] ?? null;
  const facts = [ask.id, st.state];
  if (ans?.did && ans.did !== 'none') facts.push(ans.did);
  if (ans?.in) facts.push(ans.in);
  const gist = answerGist(ans?.body);
  const head = `*${facts.join(' · ')}*`;
  return gist ? `${head} — ${gist}` : `${head} — closed with no answer written.`;
}

/**
 * Reconcile the `## Resolved notes` log at the end of the file with the state
 * the asks actually have: answered notes move in, reopened ones move back out.
 *
 * Pure, and byte-for-byte unchanged when there is nothing to do, in the style of
 * `ensurePrActions`. A pair is MOVED as a verbatim slice of the file, never
 * re-rendered: the question is the human's bytes and the answer is the model's,
 * and reflowing either to tidy a section is the failure this format exists to
 * avoid. It moves and never copies — two blocks claiming one id is a hard parse
 * error in `claimId`.
 *
 * Both directions, because the section is bytes while the state it describes is
 * derived on every read. Filing alone left the file able to say the opposite of
 * the truth: delete an answer and `askState` reopens the ask and `blockingAsks`
 * stops the submit, while the pair sits on under a heading whose own framing
 * says none of these block a submit. So this also re-derives a stale handling
 * line in place, moves a reopened pair back beside the block it is `re:` bound
 * to, and drops the heading and its framing when nothing is left under them. A
 * second run is still a byte-for-byte no-op: what it filed is closed and stays,
 * what it took back is open and is no longer in the section.
 *
 * The destination is deliberately NOT inside `prt:log`, even though that block
 * is literally the log at the end of the file. All three reasons are mechanical:
 *
 *   - `tokenize` has no nesting, so a `prt:ask` inside `prt:log` ends the log at
 *     the ask's opening sentinel. The file then reports "`<!-- prt:log -->` is
 *     missing its `<!-- /prt -->` terminator" and `capture()` refuses to submit.
 *   - `appendLog` splices at the FIRST `<!-- /prt -->` after the log sentinel,
 *     which would then be the ask's — so the next submit writes its timestamped
 *     line into the middle of the human's note.
 *   - `contentHash` cuts the file at that sentinel, so a note moved inside it
 *     drops out of the hash that records "the human edited this draft".
 *
 * Skips, rather than mangles, anything it cannot move losslessly, in either
 * direction and with the same reason printed: a file with an unterminated block
 * (whose spans run into the next block), a pair with text between the note and
 * its answer, and a pair whose id two blocks claim. A pair that is already in
 * the section and still resolved is left exactly where it is — the third skip,
 * and the one that makes a second run a byte-for-byte no-op.
 */
export function relocateResolvedAsks(text) {
  const src = stripBom(text).replace(/\r\n/g, '\n');
  const blocks = tokenize(src);
  // A byte move never runs on a file we cannot read. An unterminated block runs
  // its span to the next block's start, so a move computed from those spans can
  // drag a live inline comment into the log. Checked structurally rather than by
  // matching an error message, which would drift the moment one is reworded.
  const broken = blocks.find((b) => b.malformedSentinel || (b.unterminated && BODY_KINDS.has(b.kind)));
  if (broken) {
    return {
      text,
      moved: [],
      skipped: [],
      reopened: [],
      refreshed: [],
      refused: `<!-- prt:${broken.kind} --> at line ${broken.startLine} is not terminated — fix that before tidying.`,
    };
  }
  const parsed = parseActionFile(src);
  const lines = src.split('\n');

  const covered = new Array(lines.length).fill(false);
  for (const b of blocks) for (let k = b.startLine - 1; k < b.endLine && k < lines.length; k++) covered[k] = true;
  // A `## ` heading bounds a section only when it is gap text. Inside a body it
  // is the human's markdown — a review summary routinely carries `## ` headings.
  const isHeading = (k) => !covered[k] && /^##\s/.test(lines[k]);

  const logAt = lines.findIndex((l) => /^<!--\s*prt:log[^>]*-->\s*$/.test(l));
  const headingAt = lines.findIndex((l, k) => !covered[k] && RESOLVED_HEADING.test(l));
  // Where an existing section ends: the next gap heading, or the log, or EOF.
  let sectionEnd = logAt === -1 ? lines.length : logAt;
  if (headingAt !== -1) {
    for (let k = headingAt + 1; k < sectionEnd; k++) {
      if (isHeading(k) && !RESOLVED_HEADING.test(lines[k])) { sectionEnd = k; break; }
    }
  }

  const drop = new Array(lines.length).fill(false);
  const entries = [];
  const moved = [];
  // One row per (id, reason). A duplicate id is the one skip a single ask can
  // reach twice — `parsed.asks` has an entry per block, so both claimants report
  // it — and printing the identical sentence twice reads as two problems.
  const skipped = [];
  const skippedSeen = new Set();
  const skip = (id, why) => {
    const k = `${id} ${why}`;
    if (skippedSeen.has(k)) return;
    skippedSeen.add(k);
    skipped.push({ id, why });
  };
  const reopened = [];
  const refreshed = [];
  const rewrite = new Map();      // 0-based line index -> the line it should read
  const restoreAfter = new Map(); // 0-based line index -> the pair to emit after it
  const nonBlankAbove = (k) => { while (k >= 0 && !lines[k].trim()) k--; return k; };
  const nonBlankBelow = (k) => { while (k < lines.length && !lines[k].trim()) k++; return k < lines.length ? k : -1; };
  /** The stored handling line above a pair, or -1: `*a3 · addressed · …*` — see `askHandlingLine`. */
  const handlingLineAbove = (id, from) => {
    const k = nonBlankAbove(from - 2);
    return k > headingAt && lines[k].startsWith(`*${id} · `) ? k : -1;
  };

  for (const ask of parsed.asks) {
    const st = askState(ask, parsed.answers);
    if (st.open) continue;
    const own = blocks.filter((b) => b.kind === 'ask' && String(b.fields.id ?? '').trim() === ask.id);
    if (own.length !== 1) {
      // Which of the two is "the" note is not a question this can answer.
      skip(ask.id, `${own.length} blocks claim that id`);
      continue;
    }
    const members = [own[0], ...blocks.filter((b) => b.kind === 'answer' && String(b.fields.to ?? '').trim() === ask.id)];
    const from = Math.min(...members.map((b) => b.startLine)); // 1-based, inclusive
    const to = Math.max(...members.map((b) => b.endLine));     // 1-based, inclusive

    // Already in the log. Skipping is what makes a second run a no-op: without
    // it the pair would be lifted and re-appended, reordering the section.
    if (headingAt !== -1 && from - 1 > headingAt && to <= sectionEnd) continue;

    const mine = new Array(lines.length).fill(false);
    for (const b of members) for (let k = b.startLine - 1; k < b.endLine; k++) mine[k] = true;
    let strayAt = 0;
    for (let k = from - 1; k < to && !strayAt; k++) if (!mine[k] && lines[k].trim()) strayAt = k + 1;
    if (strayAt) {
      skip(ask.id, `line ${strayAt} sits between the note and its answer`);
      continue;
    }

    // A closed pair that came from the generator is wrapped in a `<details>`
    // envelope `tokenize` cannot see, so a move that took only the block spans
    // would strand the opener and leave a `<summary>` claiming a note that is
    // no longer under it. Matched on `<summary>ask <id>` rather than on
    // `<details>` alone: bodies in this store really do carry unrelated
    // `<details><summary>What I said</summary>` blocks.
    const opener = `<details><summary>ask ${ask.id} — `;
    const above = nonBlankAbove(from - 2);
    const below = nonBlankBelow(to);
    const wrapOpen = above >= 0 && lines[above].startsWith(opener) && lines[above].endsWith('</summary>');
    const wrapClose = below !== -1 && lines[below].trim() === '</details>';
    if (wrapOpen !== wrapClose) {
      skip(ask.id, 'its `<details>` wrapper is unbalanced');
      continue;
    }
    // The wrapper is the generator's, not the human's, so it is dropped rather
    // than carried: the log states the disposition on its own line instead.
    const cutFrom = wrapOpen ? above + 1 : from;
    let cutTo = wrapClose ? below + 1 : to;
    // Take the blank line that separated the pair from what follows it, so the
    // removal does not leave a double blank where the pair used to be.
    if ((cutFrom - 2 < 0 || !lines[cutFrom - 2].trim()) && cutTo < lines.length && !lines[cutTo].trim()) cutTo++;
    for (let k = cutFrom - 1; k < cutTo; k++) drop[k] = true;

    entries.push({ handling: askHandlingLine(ask, parsed.answers), body: lines.slice(from - 1, to) });
    moved.push({ id: ask.id, state: st.state });
  }

  // ---- and take back the pairs that stopped being resolved -----------------
  //
  // The section is BYTES: the handling line and the pair's placement were
  // derived once, when it was filed, and written into the file as ordinary gap
  // text. The state above them is not — `askState` re-derives it on every read —
  // so the moment a human deletes an answer, or rewrites one to a different
  // disposition, the two disagree: the section goes on saying "handled", under
  // a heading that says none of these block a submit, about a note `blockingAsks`
  // will now stop the submit over. Only `prt draft` repaired that, and a draft is
  // exactly what a human working through answers is not about to run.
  //
  // So the pass that files a pair also takes one back. Same direction, same
  // proof obligations, one command. A reopened pair returns to where the
  // renderer would have put it — after the block it is `re:` bound to — with its
  // stale handling line dropped; a pair still closed whose answer changed under
  // it gets that line re-derived in place; and a section left with nothing in it
  // takes its heading and framing with it, because "the log of notes already
  // handled" over an empty log is the same false sentence in a shorter form.
  if (headingAt !== -1) {
    for (const ask of parsed.asks) {
      const own = blocks.filter((b) => b.kind === 'ask' && String(b.fields.id ?? '').trim() === ask.id);
      const st = askState(ask, parsed.answers);
      if (own.length !== 1) {
        // A closed one was already reported by the loop above; an open one was
        // skipped before it got there, so it is reported here instead.
        if (st.open) skip(ask.id, `${own.length} blocks claim that id`);
        continue;
      }
      const members = [own[0], ...blocks.filter((b) => b.kind === 'answer' && String(b.fields.to ?? '').trim() === ask.id)];
      const from = Math.min(...members.map((b) => b.startLine));
      const to = Math.max(...members.map((b) => b.endLine));
      if (!(from - 1 > headingAt && to <= sectionEnd)) continue; // not in the section
      const hAt = handlingLineAbove(ask.id, from);

      if (!st.open) {
        // Still resolved, so it stays — but the line above it is re-derived, or
        // an answer edited from `declined` to `addressed` leaves the section
        // stating the disposition the human overwrote.
        //
        // "Differs from what it derives to" is not the trigger, though it was:
        // the line sits in a `## Resolved notes` section a human reads, and
        // appending a reaction to it — "<- I disagree, revisit next round" — is
        // the obvious way to push back on what the model just reported. Under a
        // bare `!==` the next `--tidy` replaced the whole line, printed "it now
        // reads addressed" (the one thing that had not changed), and said
        // nothing about the sentence it had just deleted.
        //
        // A line that STARTS with what the state derives to now is that line
        // with the human's words after it: the derived half is already correct,
        // so there is nothing to refresh and their half stays. Anything else is
        // a line describing a state the file no longer has, and is rewritten.
        const want = askHandlingLine(ask, parsed.answers);
        if (hAt !== -1 && !lines[hAt].startsWith(want)) {
          // Say when the replacement took bytes the TOOL did not write, rather
          // than reporting only the state change. A tail that is the gist of one
          // of this ask's own answers is a line the tool wrote and has now
          // re-derived — nothing to report. Anything else is the human's, and
          // they are owed the sentence "something you wrote is gone" even though
          // `history/` has the old file either way.
          const tail = lines[hAt].replace(/^\*[^*]*\*\s*(?:—\s*)?/, '').trim();
          const toolWrote = tail === '' || tail === 'closed with no answer written.'
            || parsed.answers.some((a) => a.to === ask.id && answerGist(a.body) === tail);
          rewrite.set(hAt, want);
          refreshed.push({ id: ask.id, state: st.state, ...(toolWrote ? {} : { replaced: tail }) });
        }
        continue;
      }

      // Reopened. Everything a move needs to be lossless is checked again here,
      // because this direction moves the same bytes: a stray line between the
      // note and its answer would be dragged out with them or left behind.
      const mine = new Array(lines.length).fill(false);
      for (const b of members) for (let k = b.startLine - 1; k < b.endLine; k++) mine[k] = true;
      let strayAt = 0;
      for (let k = from - 1; k < to && !strayAt; k++) if (!mine[k] && lines[k].trim()) strayAt = k + 1;
      if (strayAt) {
        skip(ask.id, `line ${strayAt} sits between the note and its answer`);
        continue;
      }

      // Home is the block the note is about, which is where `prt draft` puts an
      // open ask — never back inside the section, and never below the log.
      const target = String(ask.re ?? '').trim();
      const home = blocks.find((b) => {
        if (b.startLine - 1 > headingAt) return false;
        const id = String(b.fields?.id ?? '').trim();
        return (id !== '' && id === target)
          || (target === 'body' && b.kind === 'body')
          || (target === 'verdict' && b.kind === 'verdict');
      });
      // `general`, `gone`, and a target that has since been deleted have no
      // block to sit beside, so they land just above the heading — still in the
      // live part of the file, which is the only property that matters here.
      let anchor = home ? home.endLine - 1 : nonBlankAbove(headingAt - 1);
      while (anchor >= 0 && drop[anchor]) anchor--;
      if (anchor < 0) {
        skip(ask.id, 'there is nowhere above the log to put it back');
        continue;
      }

      const cutFrom = hAt !== -1 ? hAt + 1 : from; // 1-based, inclusive
      let cutTo = to;
      // A run, not one line, unlike the filing direction: what this takes back
      // is a pair a human has just been editing, and deleting an answer block in
      // an editor routinely leaves the blank line that separated it behind. The
      // guard is the same though — the blank above the pair is the separator
      // that stays, so at least one always does.
      while ((cutFrom - 2 < 0 || !lines[cutFrom - 2].trim()) && cutTo < lines.length && !lines[cutTo].trim()) cutTo++;
      for (let k = cutFrom - 1; k < cutTo; k++) drop[k] = true;
      // The pair only. The handling line is not carried: it said "handled", and
      // that is the sentence that stopped being true.
      if (!restoreAfter.has(anchor)) restoreAfter.set(anchor, []);
      restoreAfter.get(anchor).push(...lines.slice(from - 1, to));
      reopened.push({ id: ask.id, state: st.state, re: target });
    }
  }

  // An emptied section takes its own furniture with it — but only when what is
  // left really is nothing but that furniture. A human who typed a paragraph
  // into the section wrote words, and words are never what this deletes.
  if (headingAt !== -1 && !entries.length) {
    const boilerplate = new Set(RESOLVED_NOTES_SECTION);
    let onlyFurniture = true;
    for (let k = headingAt; k < sectionEnd; k++) {
      if (drop[k] || !lines[k].trim()) continue;
      if (!boilerplate.has(lines[k])) { onlyFurniture = false; break; }
    }
    if (onlyFurniture && reopened.length) for (let k = headingAt; k < sectionEnd; k++) drop[k] = true;
  }

  if (!moved.length && !reopened.length && !refreshed.length) {
    return { text, moved: [], skipped, reopened: [], refreshed: [], refused: null };
  }

  const section = [];
  if (entries.length && headingAt === -1) section.push(...RESOLVED_NOTES_SECTION, '');
  for (const e of entries) section.push(e.handling, '', ...e.body, '');

  // Before the log sentinel when there is one, so the three mechanics above stay
  // true; at the end of an existing section when there is one, so the log keeps
  // a single heading and the pairs keep the order they were resolved in.
  const insertAt = headingAt !== -1 ? sectionEnd : (logAt === -1 ? lines.length : logAt);
  const out = [];
  const flush = () => {
    if (!section.length) return;
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
    out.push(...section);
  };
  for (let k = 0; k < lines.length; k++) {
    if (k === insertAt) flush();
    if (!drop[k]) out.push(rewrite.has(k) ? rewrite.get(k) : lines[k]);
    if (restoreAfter.has(k)) {
      if (out.length && out[out.length - 1].trim()) out.push('');
      out.push(...restoreAfter.get(k));
      // A blank after it only when something non-blank actually follows, so a
      // restore never leaves a double blank where the file had one.
      let z = k + 1;
      while (z < lines.length && drop[z]) z++;
      if (z < lines.length && lines[z].trim()) out.push('');
    }
  }
  if (insertAt >= lines.length) flush();
  return { text: `${out.join('\n').replace(/\s*$/, '')}\n`, moved, skipped, reopened, refreshed, refused: null };
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
/**
 * The two actions that act on the pull request itself rather than on its
 * conversation. They come after everything that posts text, and in this order,
 * because updating the branch replaces the head whose workflow runs
 * `approve-workflows` then has to approve — approving the old head's runs first
 * would approve exactly the runs the update is about to supersede.
 *
 * `APPROVE` implies the workflow approval (it is what the GitHub UI does when a
 * maintainer approves), so `event: APPROVE` and `trigger-ci: true` together
 * still plan one action, not two.
 */
function prLevelActions(parsed, actions) {
  if (parsed.prActions?.updateBranch) actions.push({ kind: 'update-branch', id: 'update-branch' });
  if (parsed.prActions?.triggerCi || parsed.event === 'APPROVE') {
    actions.push({ kind: 'approve-workflows', id: 'approve-workflows' });
  }
}

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
    // The PR-level flags are orthogonal to the verdict, and silently dropping
    // an armed one here would be indistinguishable from having run it.
    prLevelActions(parsed, actions);
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
  prLevelActions(parsed, actions);
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
    prActions: [parsed.prActions?.updateBranch ?? false, parsed.prActions?.triggerCi ?? false],
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
