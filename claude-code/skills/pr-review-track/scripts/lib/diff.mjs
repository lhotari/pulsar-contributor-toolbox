// Unified-diff parsing and comment-anchor computation.
//
// GitHub only accepts a review comment whose (path, line, side) falls inside a
// hunk of the diff being reviewed. Anything else is a 422 that aborts the WHOLE
// review — losing every other comment in the batch. So we compute the legal
// anchor set locally and demote anything that does not fit into the review body
// instead of letting GitHub reject the batch.

/**
 * Parse a unified diff into per-file records.
 * Returns: Map<path, {path, oldPath, status, binary, hunks:[{oldStart,oldLines,newStart,newLines,lines:[...]}]}>
 * `status` is one of added | deleted | modified | renamed.
 */
export function parseDiff(text) {
  const files = new Map();
  if (!text) return files;
  const lines = text.split('\n');
  let cur = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (cur) files.set(cur.path, cur);
    cur = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      flush();
      // Paths may contain spaces; "a/<x> b/<y>" is ambiguous in general, but the
      // ---/+++ headers below give the authoritative values, so seed loosely.
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = {
        path: m ? m[2] : '',
        oldPath: m ? m[1] : '',
        status: 'modified',
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) {
      if (line.startsWith('rename to ')) cur.path = line.slice('rename to '.length);
      if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { cur.binary = true; continue; }

    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p === '/dev/null') cur.status = 'added';
      else cur.oldPath = stripPrefix(p);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p === '/dev/null') cur.status = 'deleted';
      else cur.path = stripPrefix(p);
      continue;
    }

    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hm) {
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      cur.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const kind = line[0];
    if (kind === '+') {
      hunk.lines.push({ kind: '+', newNo, text: line.slice(1) });
      newNo++;
    } else if (kind === '-') {
      hunk.lines.push({ kind: '-', oldNo, text: line.slice(1) });
      oldNo++;
    } else if (kind === ' ' || line === '') {
      hunk.lines.push({ kind: ' ', oldNo, newNo, text: line.slice(1) });
      oldNo++;
      newNo++;
    }
  }
  flush();
  // A deleted file keeps its old path as the comment path.
  for (const f of files.values()) {
    if (f.status === 'deleted' && f.oldPath) f.path = f.oldPath;
  }
  return files;
}

function stripPrefix(p) {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/**
 * Commentable positions, per GitHub's rule: any line that appears in a hunk.
 *  - '+' lines  -> RIGHT at its new line number
 *  - '-' lines  -> LEFT  at its old line number
 *  - ' ' lines  -> RIGHT at new number AND LEFT at old number
 * Binary files have no line anchors (file-level comments only).
 *
 * Returns Map<path, {right:Set<number>, left:Set<number>, binary:boolean, status:string}>
 */
export function commentableAnchors(files) {
  const out = new Map();
  for (const f of files.values()) {
    const right = new Set();
    const left = new Set();
    const hunkRanges = [];
    for (const h of f.hunks) {
      const rl = [];
      const ll = [];
      for (const l of h.lines) {
        if (l.kind === '+') { right.add(l.newNo); rl.push(l.newNo); }
        else if (l.kind === '-') { left.add(l.oldNo); ll.push(l.oldNo); }
        else {
          right.add(l.newNo);
          left.add(l.oldNo);
          rl.push(l.newNo);
          ll.push(l.oldNo);
        }
      }
      hunkRanges.push({
        right: rl.length ? { from: Math.min(...rl), to: Math.max(...rl) } : null,
        left: ll.length ? { from: Math.min(...ll), to: Math.max(...ll) } : null,
      });
    }
    out.set(f.path, { right, left, hunkRanges, binary: f.binary, status: f.status });
    if (f.oldPath && f.oldPath !== f.path && !out.has(f.oldPath)) {
      // Allow addressing a renamed file by either name; GitHub wants the new
      // one. Never overwrite a real entry — an A→B / B→A swap would otherwise
      // alias each file onto the other's line numbers.
      out.set(f.oldPath, out.get(f.path));
    }
  }
  return out;
}

/**
 * Validate one comment target against the anchor set.
 * Returns {ok:true, target:{...}} or {ok:false, reason:'...', nearest:number|null}
 */
/**
 * Validate a comment target. `line` is the range START, `endLine` its END —
 * which is the opposite of the action file's naming, where `line:` is the end
 * and `start-line:` the start. Callers translate; keep that in mind when
 * reading them.
 */
export function validateAnchor(anchors, { file, line, endLine, side = 'RIGHT', startSide = null }) {
  const a = anchors.get(file);
  if (!a) return { ok: false, reason: `file "${file}" is not part of this diff`, nearest: null };
  if (a.binary) return { ok: false, reason: `"${file}" is a binary file — no line anchors`, nearest: null };

  const endSet = side === 'LEFT' ? a.left : a.right;
  if (endSet.size === 0) {
    return { ok: false, reason: `"${file}" has no commentable ${side} lines (status: ${a.status})`, nearest: null };
  }
  const end = endLine ?? line;
  if (!endSet.has(end)) {
    return { ok: false, reason: `${file}:${end} (${side}) is outside the diff hunks`, nearest: nearestLine(endSet, end) };
  }

  const isRange = endLine !== undefined && endLine !== null && endLine !== line;
  if (isRange) {
    // A range may start on the other side of the diff, so validate the start
    // against start-side rather than assuming both ends share a side.
    const sSide = startSide || side;
    const startSet = sSide === 'LEFT' ? a.left : a.right;
    if (!startSet.has(line)) {
      return { ok: false, reason: `${file}:${line} (range start, ${sSide}) is outside the diff hunks`, nearest: nearestLine(startSet, line) };
    }
    if (line >= end) {
      return { ok: false, reason: `range start ${line} must be before its end ${end}`, nearest: null };
    }
    // GitHub rejects a range that spans two hunks; the lines in between do not
    // exist in the diff, so there is nothing to anchor the middle of it to.
    if (!sameHunk(a, sSide, line, side, end)) {
      return { ok: false, reason: `${file}:${line}-${end} spans more than one diff hunk`, nearest: null };
    }
  }
  return { ok: true };
}

/** Are two anchors inside the same hunk? Ranges may not cross a hunk boundary. */
function sameHunk(a, startSide, startLine, endSide, endLine) {
  if (!a.hunkRanges) return true; // older anchor maps: skip rather than false-block
  const find = (sideName, n) =>
    a.hunkRanges.findIndex((h) => {
      const r = sideName === 'LEFT' ? h.left : h.right;
      return r && n >= r.from && n <= r.to;
    });
  const i = find(startSide, startLine);
  const j = find(endSide, endLine);
  return i !== -1 && i === j;
}

function nearestLine(set, n) {
  let best = null;
  let bestD = Infinity;
  for (const v of set) {
    const d = Math.abs(v - n);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

/** Files touched between two revisions, from `git diff --name-only`-style text. */
export function changedPaths(files) {
  return [...files.values()].map((f) => f.path);
}

/**
 * Does a given (path, line) sit inside the changed region of `files`?
 * Used to decide whether a review thread's anchor was touched by new commits.
 */
export function touchesAnchor(files, path, line) {
  const f = files.get(path);
  if (!f) return false;
  if (line == null) return true; // file changed at all
  for (const h of f.hunks) {
    // Widen by 5 lines: an edit just above shifts and effectively rewrites context.
    if (line >= h.newStart - 5 && line <= h.newStart + h.newLines + 5) return true;
  }
  return false;
}
