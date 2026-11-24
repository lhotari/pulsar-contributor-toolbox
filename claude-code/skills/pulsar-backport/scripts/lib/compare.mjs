// Hunk-level comparison of a pick with its master commit, and the rules that fail a backport whose intent is not
// achieved. A hunk is identical when its lines (context included) are the same on both sides; "context" when only
// the surrounding lines differ; "modified" when a master hunk and a backport hunk change mostly the same lines;
// "master-only" / "backport-only" otherwise.
//
// Rules (lib/intent.mjs runs them with the dependency check; a "fail" makes the build check fail):
// - main-dropped (fail): a master hunk in main code has no counterpart in the backport, and the file exists on the
//   branch. The fix, or part of it, is not there. (A file the branch does not have is a warning: the code may not
//   exist there; the diff review says whether that is right.)
// - main-missing (fail): the master commit changes main code and the backport changes none: only its tests went in.
// - test-dropped (fail): a test method the master commit adds is not in the backport, nor already on the branch.
// - test-changed / test-hunk-dropped (fail): a hunk of the master commit's test changes is changed or left out in
//   the backport (imports aside). The tests are what pins the intent; an adapted test may no longer test the fix.
//   test-extra (warn): a hunk only the backport adds to a test file the master commit changes.
// - assertions-dropped (fail): a test file of the backport adds fewer assertion lines than the master commit adds
//   to it. The test no longer pins what master pins.
// - main-modified / main-extra (warn): a main-code hunk changed differently from master, or main code the master
//   commit does not touch. Allowed, but the diff review must explain it (it cannot record "ok").
import * as g from './git.mjs';

const TEST = /(^|\/)src\/test\/|^testmocks\/|(^|\/)tests?\/|(^|\/)test-[^/]*\/|Test[^/]*\.(java|kt|scala|py|go|cc|cpp|h)$|_test\.(go|py)$/;
// Build and CI files differ by design between master (Gradle) and the branches (Maven); the dependency check covers
// version upgrades.
const BUILD = /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|gradlew(\.bat)?|pom\.xml)$|^(gradle|build-logic|buildSrc|\.github|\.mvn)\//;
export const kindOf = (p) => (BUILD.test(p) ? 'build' : TEST.test(p) ? 'test' : 'main');

const ASSERT = /\b(assert\w*|verify|expect\w*|fail|await(ility)?)\s*\(|\.(isEqualTo|isNotEqualTo|isTrue|isFalse|isNull|isNotNull|isSameAs|isInstanceOf|isEmpty|isNotEmpty|isPresent|hasSize|contains\w*|startsWith|endsWith|matches|isGreaterThan\w*|isLessThan\w*|hasMessage\w*|isInstanceOf\w*|untilAsserted|until)\s*\(/;
const IMPORT = /^[+-]\s*(import\s|package\s)/;

/** Hunks of one file's diff text (the part after the headers, as lib/review.mjs splitDiff returns it). */
export function hunks(diff) {
  const out = []; let cur = null;
  for (const line of String(diff || '').split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) { cur = { header: line, oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }; out.push(cur); continue; }
    if (!cur || line.startsWith('\\ No newline')) continue;
    cur.lines.push(line);
  }
  return out.map((h) => {
    const lines = h.lines.map((l) => l.replace(/\s+$/, ''));
    const changes = lines.filter((l) => l[0] === '+' || l[0] === '-');
    return { ...h, lines, changes, key: lines.join('\n'), changeKey: changes.map(norm).join('\n'),
      importOnly: changes.length > 0 && changes.every((l) => IMPORT.test(l) || /^[+-]\s*$/.test(l)) };
  });
}

/** A changed line without its indentation and with single spaces: re-indented code is the same change. */
const norm = (l) => `${l[0]}${l.slice(1).trim().replace(/\s+/g, ' ')}`;

/** The changed lines of `a` that `b` does not have (as multisets, normalized), with their indexes in a.lines. */
function unmatched(a, b) {
  const count = new Map();
  for (const l of b?.changes || []) count.set(norm(l), (count.get(norm(l)) || 0) + 1);
  const out = [];
  a.lines.forEach((l, i) => {
    if (l[0] !== '+' && l[0] !== '-') return;
    const k = norm(l); const c = count.get(k);
    if (c) count.set(k, c - 1); else out.push(i);
  });
  return out;
}

/** Similarity of two hunks: the shared changed lines over the larger hunk's. */
function similarity(a, b) {
  const shared = a.changes.length - unmatched(a, b).length;
  return shared / Math.max(a.changes.length, b.changes.length, 1);
}

/** Pair the hunks of one file: [{kind, master, backport, similarity?}] in file order. */
export function compareHunks(masterDiff, backportDiff) {
  const M = hunks(masterDiff); const B = hunks(backportDiff);
  const pairM = new Map(); const usedB = new Set();
  const pass = (kind, match) => {
    for (const [i, m] of M.entries()) {
      if (pairM.has(i)) continue;
      const j = B.findIndex((b, k) => !usedB.has(k) && match(m, b));
      if (j >= 0) { pairM.set(i, { kind, j }); usedB.add(j); }
    }
  };
  pass('identical', (m, b) => m.key === b.key);
  pass('context', (m, b) => m.changeKey === b.changeKey);
  // Modified: the best remaining partner, if they share enough changed lines.
  for (const [i, m] of M.entries()) {
    if (pairM.has(i)) continue;
    let best = -1; let score = 0;
    for (const [k, b] of B.entries()) { if (usedB.has(k)) continue; const s = similarity(m, b); if (s > score) { score = s; best = k; } }
    if (best >= 0 && score >= 0.3) { pairM.set(i, { kind: 'modified', j: best, similarity: Math.round(score * 100) / 100 }); usedB.add(best); }
  }
  const rows = M.map((m, i) => {
    const p = pairM.get(i);
    return p ? { kind: p.kind, master: m, backport: B[p.j], similarity: p.similarity, at: B[p.j].newStart } : { kind: 'master-only', master: m, backport: null, at: m.newStart };
  });
  for (const [k, b] of B.entries()) if (!usedB.has(k)) rows.push({ kind: 'backport-only', master: null, backport: b, at: b.newStart });
  return rows.sort((a, b) => a.at - b.at);
}

const where = (rows) => rows.map((r) => (r.master || r.backport)).map((h) => h.header.replace(/^@@ [^@]+ @@\s*/, '').trim() || `line ${h.newStart}`).slice(0, 4).join('; ');
export const SAME = ['identical', 'context', 'logging', 'imports'];
const strip = (h, marks) => (h ? { header: h.header, lines: h.lines, importOnly: h.importOnly, marks } : null);
const trivial = (l) => IMPORT.test(l) || /^[+-]\s*$/.test(l);

/**
 * What really differs in a paired row: the changed lines of each side the other lacks, without imports and blank
 * lines, and without master's removals of lines the branch does not have (nothing to remove there).
 */
function delta(r, branchHas) {
  let m = r.master ? unmatched(r.master, r.backport) : []; let b = r.backport ? unmatched(r.backport, r.master) : [];
  // Logging: master logs with slog (log.warn().attr(..).log(..)), the branches with slf4j (log.warn("{}", ..), debug
  // guarded by isDebugEnabled). Differing log statements are the same change when both sides have the same
  // statements, by sign and level; then they are no difference at all.
  let logging = false;
  if (r.master && r.backport) {
    const lm = logLines(r.master); const lb = logLines(r.backport);
    const sm = m.filter((i) => lm.has(i)); const sb = b.filter((i) => lb.has(i));
    if ((sm.length || sb.length) && sameStatements(r.master, lm, sm, r.backport, lb, sb)) {
      logging = true;
      // A guard's closing brace: the diff may pair another `}` line, so drop as many unmatched bare braces.
      const dropBraces = (idx, hk, map) => {
        let n = idx.filter((i) => map.get(i)?.level === 'guard').length;
        return idx.filter((i) => !map.has(i)).filter((i) => !(n > 0 && hk.lines[i].slice(1).trim() === '}' && n--));
      };
      m = dropBraces(m, r.master, lm); b = dropBraces(b, r.backport, lb);
    }
  }
  const keepM = m.filter((i) => { const l = r.master.lines[i]; return !trivial(l) && !(l[0] === '-' && !branchHas(l.slice(1))); });
  const keepB = b.filter((i) => !trivial(r.backport.lines[i]));
  return { m, b, real: keepM.length + keepB.length, keepM, keepB, logging };
}

/**
 * The two sides may cut the same change into hunks differently (e.g. two nearby insertions are one hunk on the
 * branch, where shorter log statements bring them closer, and two on master): a changed line that differs in one
 * hunk and turns up on the other side in another hunk of the same file is no difference. Rows whose differences all
 * cancel out this way are the same change ("context").
 */
export function regroup(rows) {
  const items = { m: [], b: [] };
  for (const [ri, r] of rows.entries()) {
    const take = (side, hk, idx) => { for (const i of idx) if (!trivial(hk.lines[i])) items[side].push({ ri, i, key: norm(hk.lines[i]) }); };
    if (r.kind === 'modified') { take('m', r.master, r.marks.keepM); take('b', r.backport, r.marks.keepB); }
    else if (r.kind === 'master-only') take('m', r.master, r.master.lines.map((_, i) => i).filter((i) => r.master.lines[i][0] !== ' '));
    else if (r.kind === 'backport-only') take('b', r.backport, r.backport.lines.map((_, i) => i).filter((i) => r.backport.lines[i][0] !== ' '));
  }
  const pool = new Map();
  for (const x of items.b) (pool.get(x.key) || pool.set(x.key, []).get(x.key)).push(x);
  const cancelled = new Set();
  for (const x of items.m) {
    const q = pool.get(x.key); if (!q?.length || q[0].ri === x.ri) continue;   // the same line elsewhere in the file
    const y = q.shift(); cancelled.add(`m${x.ri}:${x.i}`); cancelled.add(`b${y.ri}:${y.i}`);
  }
  if (!cancelled.size) return rows;
  return rows.map((r, ri) => {
    const left = (side) => items[side].filter((x) => x.ri === ri && !cancelled.has(`${side}${ri}:${x.i}`)).length;
    const had = items.m.some((x) => x.ri === ri) || items.b.some((x) => x.ri === ri);
    if (!had || left('m') || left('b')) {
      if (r.kind !== 'modified') return r;
      const keep = (side, idx) => idx.filter((i) => !cancelled.has(`${side}${ri}:${i}`));
      return { ...r, marks: { ...r.marks, m: keep('m', r.marks.m), b: keep('b', r.marks.b) } };
    }
    return { ...r, kind: 'context', regrouped: true, marks: r.marks ? { ...r.marks, m: [], b: [] } : undefined };
  });
}

const LOG_START = /^(?:this\.)?(?:log|LOG|logger|LOGGER)\.(trace|debug|info|warn|error)\b/;
const LOG_GUARD = /^if \((?:this\.)?(?:log|LOG|logger|LOGGER)\.is\w+Enabled\(\)\) \{$/;
const LOG_DECL = /^@(CustomLog|Slf4j)\b|LoggerFactory\.getLogger\(|^private static final (Logger|org\.slf4j\.Logger) /;

/**
 * The lines of a hunk that belong to log statements: index → {stmt, level, sign}. A statement runs from its
 * `log.<level>` line to the line that ends it with `;` (a slog chain spans several). The isXEnabled() guards count
 * as logging too (level "guard"); their closing braces are matched in delta().
 */
export function logLines(hk) {
  const out = new Map(); const L = hk.lines;
  // The old side (context and - lines) and the new side (context and + lines) are separate texts.
  for (const side of ['-', '+']) {
    const idx = L.map((l, i) => i).filter((i) => L[i][0] === ' ' || L[i][0] === side);
    for (let p = 0; p < idx.length; p++) {
      const i = idx[p]; const code = L[i].slice(1).trim();
      if (LOG_GUARD.test(code) || LOG_DECL.test(code)) { if (L[i][0] === side) out.set(i, { stmt: i, level: LOG_GUARD.test(code) ? 'guard' : 'decl', sign: side }); continue; }
      const s = code.match(LOG_START); if (!s) continue;
      let q = p;
      while (q < idx.length - 1 && q - p < 15 && !/;\s*(\/\/.*)?$/.test(L[idx[q]].slice(1).trim())) q++;
      for (let k = p; k <= q; k++) if (L[idx[k]][0] === side) out.set(idx[k], { stmt: i, level: s[1], sign: side });
      p = q;
    }
  }
  return out;
}

/** Both sides have the same log statements among their differing lines: the same levels with the same signs. */
function sameStatements(ma, lm, sm, ba, lb, sb) {
  const key = (map, idx) => {
    const seen = new Map();
    for (const i of idx) { const x = map.get(i); if (['guard', 'decl'].includes(x.level)) continue; seen.set(`${x.stmt}${x.sign}`, `${x.sign}${x.level}`); }
    return [...seen.values()].sort().join(',');
  };
  return key(lm, sm) === key(lb, sb);
}

/**
 * Compare a pick, given its file pairs ({path, master, backport} from review.pickDiffs). Returns
 * {files: [{path, kind, status, rows, counts}], counts, rules}. `exists(path)` says whether the file was on the
 * branch before the pick; `onBranch(path, method)` whether the branch has a test method already.
 */
export function comparePick(files, { exists = () => true, onBranch = () => false, fileAt = () => null, identical = false } = {}) {
  const total = { identical: 0, context: 0, logging: 0, imports: 0, modified: 0, 'master-only': 0, 'backport-only': 0 };
  const out = []; const rules = [];
  const fail = (rule, file, message) => rules.push({ rule, level: 'fail', file, message });
  const warn = (rule, file, message) => rules.push({ rule, level: 'warn', file, message });
  for (const f of files) {
    const kind = kindOf(f.path);
    const raw = f.master || f.backport ? compareHunks(f.master?.diff || '', f.backport?.diff || '') : [];
    const text = fileAt(f.path);
    const lines = text == null ? null : new Set(text.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')));
    const branchHas = (l) => !lines || lines.has(l.trim().replace(/\s+/g, ' '));
    // A modified pair whose differences are imports, blank lines or removals the branch has nothing for is the same change.
    let rows = regroup(raw.map((r) => {
      if (r.kind !== 'modified') return r;
      const d = delta(r, branchHas);
      return { ...r, kind: d.real ? 'modified' : d.logging ? 'logging' : 'context', marks: d };
    }));
    // In tests, plain import changes (a hunk of imports only, or differing import lines) are not worth a look.
    if (kind === 'test') {
      rows = rows.map((r) => {
        const onlyImports = (r.kind === 'master-only' && r.master.importOnly) || (r.kind === 'backport-only' && r.backport.importOnly)
          || (r.kind === 'modified' && r.master.importOnly && r.backport.importOnly);
        if (onlyImports) return { ...r, kind: 'imports' };
        if (!r.marks) return r;
        const keep = (hk, idx) => idx.filter((i) => !IMPORT.test(hk.lines[i]));
        return { ...r, marks: { ...r.marks, m: keep(r.master, r.marks.m), b: keep(r.backport, r.marks.b) } };
      });
    }
    const counts = Object.fromEntries(Object.keys(total).map((k) => [k, rows.filter((r) => r.kind === k).length]));
    for (const [k, v] of Object.entries(counts)) total[k] += v;
    out.push({ path: f.path, kind, status: { master: f.master?.status || null, backport: f.backport?.status || null }, counts,
      same: rows.length > 0 && rows.every((r) => SAME.includes(r.kind)),
      // The same change (identical, or only the surrounding lines differ) is hidden unless asked for.
      rows: rows.filter((r) => identical || !SAME.includes(r.kind)).map((r) => ({ kind: r.kind, similarity: r.similarity,
        master: strip(r.master, r.marks?.m), backport: strip(r.backport, r.marks?.b) })) });

    if (kind === 'main') {
      const dropped = rows.filter((r) => r.kind === 'master-only' && !r.master.importOnly);
      // A hunk that removes or replaces lines none of which are on the branch changes code the branch does not have.
      const absent = (r) => { const del = r.master.changes.filter((l) => l[0] === '-' && !trivial(l)); return del.length > 0 && del.every((l) => !branchHas(l.slice(1))); };
      const missing = f.master?.status === 'added' || exists(f.path) ? dropped.filter((r) => !absent(r)) : [];
      const notThere = dropped.filter((r) => !missing.includes(r));
      if (missing.length) fail('main-dropped', f.path, `${missing.length} of the master commit's ${rows.filter((r) => r.master).length} hunk(s) in ${f.path} are not in the backport (${where(missing)})`);
      if (notThere.length) warn('main-absent', f.path, `${notThere.length} master hunk(s) in ${f.path} change code that is not on the branch (${where(notThere)})`);
      const modified = rows.filter((r) => r.kind === 'modified');
      if (modified.length) warn('main-modified', f.path, `${modified.length} hunk(s) in ${f.path} change the code differently from master`);
      const extra = rows.filter((r) => r.kind === 'backport-only' && !r.backport.importOnly);
      if (extra.length) warn('main-extra', f.path, f.master ? `${extra.length} hunk(s) in ${f.path} are only in the backport` : `${f.path} is changed only in the backport`);
    }
    if (kind === 'test' && f.master) {
      // The master commit's tests are what pins its intent: a backport that changes them may no longer test the fix.
      const changed = rows.filter((r) => r.kind === 'modified');
      if (changed.length) fail('test-changed', f.path, `${changed.length} hunk(s) of the master commit's test changes in ${f.path} are changed in the backport (${where(changed)})`);
      const droppedT = rows.filter((r) => r.kind === 'master-only' && !r.master.importOnly);
      if (droppedT.length) fail('test-hunk-dropped', f.path, `${droppedT.length} hunk(s) of the master commit's test changes in ${f.path} are not in the backport (${where(droppedT)})`);
      const extraT = rows.filter((r) => r.kind === 'backport-only' && !r.backport.importOnly);
      if (extraT.length) warn('test-extra', f.path, `${extraT.length} hunk(s) in ${f.path} are only in the backport`);
      for (const name of addedTests(f.master.diff)) {
        if (f.backport && addedTests(f.backport.diff).includes(name)) continue;
        if (onBranch(f.path, name)) continue;
        fail('test-dropped', f.path, `test ${name} (added by the master commit in ${f.path}) is not in the backport`);
      }
      if (f.backport) {
        const a = assertions(f.master.diff); const b = assertions(f.backport.diff);
        if (b < a) fail('assertions-dropped', f.path, `the backport adds ${a - b} fewer assertion line(s) to ${f.path} than the master commit (${b} vs ${a})`);
      }
    }
  }
  const mainM = files.filter((f) => kindOf(f.path) === 'main' && f.master);
  const mainB = files.filter((f) => kindOf(f.path) === 'main' && f.backport);
  if (mainM.length && !mainB.length) fail('main-missing', null, `the master commit changes main code (${mainM.map((f) => f.path.split('/').pop()).join(', ')}) and the backport changes none`);
  return { files: out, counts: total, rules };
}

/** Test methods a diff adds: a `+ @Test` line followed by the method's declaration. */
export function addedTests(diff) {
  const lines = String(diff || '').split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\+\s*@(Test|ParameterizedTest)\b/.test(lines[i])) continue;
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
      const m = lines[k].match(/^\+.*\bvoid\s+(\w+)\s*\(/);
      if (m) { out.push(m[1]); break; }
    }
  }
  return out;
}

/** Net assertion lines a diff adds (added minus removed). */
export function assertions(diff) {
  let n = 0;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+') && ASSERT.test(l)) n++;
    else if (l.startsWith('-') && ASSERT.test(l)) n--;
  }
  return n;
}

/** The branch-side helpers comparePick needs, for a pick committed as `sha` in `dir`. */
export function branchProbes(dir, sha) {
  const exists = (p) => g.git(dir, ['cat-file', '-e', `${sha}^:${p}`], { allowFail: true }).ok;
  const cache = new Map();
  const fileAt = (p) => {
    if (!cache.has(p)) { const r = g.git(dir, ['show', `${sha}^:${p}`], { allowFail: true, trim: false }); cache.set(p, r.ok ? r.out : null); }
    return cache.get(p);
  };
  const onBranch = (p, name) => new RegExp(`\\bvoid\\s+${name}\\s*\\(`).test(fileAt(p) || '');
  return { exists, onBranch, fileAt };
}
