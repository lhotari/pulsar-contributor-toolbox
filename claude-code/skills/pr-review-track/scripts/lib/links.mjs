// Permalinks to code — how a review shows the lines it is talking about instead
// of naming them and making the reader go and find them.
//
// GitHub expands a blob permalink that sits alone in its own paragraph into the
// code it points at, so `Consumer.java:1015` can arrive as the actual fifteen
// lines. That expansion is only worth having if the URL is exact:
// `blob/master/…` renders whatever master says on the day someone reads the
// comment, which is not the code the review read. So nothing here builds a link
// without a commit SHA — a ref name is refused rather than turned into a link
// that goes quietly wrong within the week.

const SHA = /^[0-9a-f]{7,40}$/i;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** `path/to/File.java:192-206`, `…:192`, `…#L192-L206`, or a bare path. */
const LOCATION = /^(?<path>\S+?)(?:[:#]L?(?<start>\d+)(?:\s*[-–]\s*L?(?<end>\d+))?)?$/;

export function isSha(s) {
  return SHA.test(String(s ?? ''));
}

/**
 * Split a `file:line` reference the way a reviewer types one.
 *
 * Returns `{ path, line, endLine }` with `line` null for a bare path. A
 * backwards range is normalised rather than refused: `:206-192` means the same
 * six lines to whoever typed it, and GitHub renders `#L206-L192` as nothing.
 */
export function parseLocation(spec) {
  const s = String(spec ?? '').trim();
  const m = LOCATION.exec(s);
  if (!m?.groups?.path) throw new Error(`not a code location: ${spec}`);
  const start = m.groups.start ? Number(m.groups.start) : null;
  const end = m.groups.end ? Number(m.groups.end) : null;
  if (start === 0 || end === 0) throw new Error(`line numbers start at 1: ${spec}`);
  return {
    path: m.groups.path,
    line: start === null ? null : Math.min(start, end ?? start),
    endLine: end === null ? null : Math.max(start, end),
  };
}

/**
 * The permalink itself. `line`/`endLine` are the range GitHub will highlight —
 * and, when the URL stands alone in a paragraph, render.
 */
export function blobUrl(repo, sha, filePath, { line = null, endLine = null } = {}) {
  if (!REPO.test(String(repo ?? ''))) throw new Error(`not an owner/repo: ${repo}`);
  if (!isSha(sha)) {
    throw new Error(`a permalink needs a commit SHA, not "${sha}" — a branch link points at whatever that branch says later`);
  }
  const p = String(filePath ?? '').replace(/^\/+/, '');
  if (!p) throw new Error('a permalink needs a file path');
  const from = line === null ? null : Math.min(line, endLine ?? line);
  const to = endLine === null || endLine === line ? null : Math.max(line, endLine);
  const frag = from === null ? '' : to === null ? `#L${from}` : `#L${from}-L${to}`;
  const encoded = p.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/${sha}/${encoded}${frag}`;
}

/** `Consumer.java:1015`, or the whole path with `full: true`. */
export function locationLabel(filePath, { line = null, endLine = null, full = false } = {}) {
  const name = full ? String(filePath) : String(filePath).split('/').pop();
  if (line === null) return name;
  return endLine && endLine !== line ? `${name}:${line}-${endLine}` : `${name}:${line}`;
}

/**
 * The inline form: ``[`Consumer.java:1015`](https://github.com/…#L1015)``.
 *
 * This is the shape that works everywhere — mid-sentence, in a list, in a table
 * — because GitHub only expands a *bare* URL that owns its paragraph, and a
 * bullet is not a paragraph.
 *
 * **It degrades to a plain code span rather than throwing.** A caller that has
 * no SHA (an anchor on the LEFT side, a thread GitHub marked outdated, an
 * analysis old enough to predate the field) still gets the reference it was
 * going to print. Failing the whole draft over a link would be a much worse
 * trade than losing the link.
 */
export function codeLink(repo, sha, filePath, opts = {}) {
  const label = opts.label ?? locationLabel(filePath, opts);
  try {
    return `[\`${label}\`](${blobUrl(repo, sha, filePath, opts)})`;
  } catch {
    return `\`${label}\``;
  }
}

// ---------------------------------------------------------------- linkifying
//
// The rule above — link the code, do not name it — was written as an
// instruction to a model, and a model writes `ScalableConsumerClient.java:749`
// or a bare `:749-755` about as often as it writes the URL. Naming it is the
// habit; the link is the effort. So the generator closes the gap itself, over
// the bodies it writes out of `findings.json`, where the rewrite is still a
// generation rather than an edit to bytes a human approved.
//
// It only ever ADDS a link. A reference it cannot resolve to an exact path, or
// cannot build a URL for, is left byte-for-byte as it was: a wrong permalink
// quotes the author code they did not write, and no link at all is merely the
// text they already had.

/**
 * A reference as a reviewer types one: `path/to/File.java:192-206`, the bare
 * `File.java:192`, or a path-less `:749-755` meaning "in the file this comment
 * is already about".
 *
 * The lookbehind is what keeps `localhost:8080`, `1.2.3:4` and a URL's own
 * `:443` out: the character before the reference may not be one that could be
 * part of a longer token. The trailing guard rejects only another digit or a
 * decimal tail, so a sentence-ending full stop after `:1015` stays a full stop
 * rather than blocking the match.
 */
const REFERENCE_SOURCE = String.raw`(?<![\w./$-])(?<path>[A-Za-z0-9_$][\w.$/-]*\.[A-Za-z][A-Za-z0-9]*)?[:#]L?(?<start>\d{1,7})(?:\s*[-–]\s*L?(?<end>\d{1,7}))?(?!\d)(?!\.\d)`;
const REFERENCE = new RegExp(REFERENCE_SOURCE, 'g');
/** The same reference, and nothing else — what an all-code-span one must be. */
const REFERENCE_ONLY = new RegExp(`^${REFERENCE_SOURCE}$`);

/** Regions whose insides are not prose: an existing link, a URL, a code span. */
const PROTECTED = /\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]+>|https?:\/\/\S+|(`+)(?:(?!\1)[\s\S])*\1/g;

/** A line of a stack trace. Its line numbers belong to some other build. */
const STACK_FRAME = /^\s*(?:at\s|Caused by:|\.{3}\s*\d+\s+more)/;

/**
 * Index of the repo-relative paths a reference may resolve to.
 *
 * Resolution is by **suffix**, which makes one rule out of three cases: the
 * full path matches itself, `service/Consumer.java` matches the file it is the
 * tail of, and a bare `Consumer.java` matches when the corpus holds exactly
 * one. Exactly one — two files with the same tail resolve to nothing, because
 * guessing which `Consumer.java` was meant is how a link quotes the wrong file.
 */
export function pathIndex(paths) {
  // A Set for "is this the path itself", a list to scan for tails, and a cache
  // so a name repeated through a review is resolved once. The corpus is a whole
  // repository tree — tens of thousands of paths — so membership has to be a
  // lookup rather than a scan, or extending the index costs a second.
  const all = new Set((paths ?? []).filter(Boolean));
  const cache = new Map();
  return {
    get size() { return all.size; },
    add(more) {
      for (const p of more ?? []) if (p) all.add(p);
      cache.clear();
      return this;
    },
    resolve(ref) {
      if (!ref) return null;
      if (cache.has(ref)) return cache.get(ref);
      let hit = all.has(ref) ? ref : null;
      if (!hit) {
        const tail = `/${ref}`;
        for (const p of all) {
          if (!p.endsWith(tail)) continue;
          // Two files with the same tail resolve to nothing: guessing which
          // `Consumer.java` was meant is how a link quotes the wrong file.
          if (hit) { hit = null; break; }
          hit = p;
        }
      }
      cache.set(ref, hit);
      return hit;
    },
  };
}

/** Split `text` into fenced-code and prose runs, in order. */
function fencedRuns(text) {
  const runs = [];
  let fence = null;
  let buf = [];
  let code = false;
  const flush = () => {
    if (buf.length) runs.push({ code, text: buf.join('\n') });
    buf = [];
  };
  for (const line of String(text ?? '').split('\n')) {
    const open = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (!code && open) {
      flush();
      code = true;
      fence = open[1][0];
      buf.push(line);
      continue;
    }
    if (code && open && open[1][0] === fence) {
      buf.push(line);
      flush();
      code = false;
      fence = null;
      continue;
    }
    buf.push(line);
  }
  flush();
  return runs;
}

/**
 * Turn every code reference in `text` into an inline permalink.
 *
 * Inline, never the bare-URL rendered form: a rewrite that changed how a
 * paragraph displays would be editing the review rather than linking it, and
 * the model's own deliberate rendered snippets are bare URLs this skips.
 *
 * `resolve(ref)` maps a written reference to a repo-relative path (see
 * `pathIndex`); `selfPath` is what a path-less `:749-755` means — the file the
 * comment it sits in is already about, and null when that file's line numbers
 * are not the head's (a `LEFT`-side anchor), where a head permalink would quote
 * the wrong lines. Returns the rewritten text, how many links it made, and the
 * references that resolved to nothing, so a caller with a second corpus to try
 * knows whether it is worth fetching.
 */
export function linkifyCode(text, { repo, sha, resolve = () => null, selfPath = null } = {}) {
  const src = String(text ?? '');
  if (!src || !isSha(sha)) return { text: src, unresolved: [] };
  const unresolved = [];
  let count = 0;

  const link = (raw, name, start, end) => {
    const target = name ? resolve(name) : selfPath;
    if (!target) {
      if (name) unresolved.push(name);
      return raw;
    }
    try {
      const url = blobUrl(repo, sha, target, { line: start, endLine: end });
      count += 1;
      return `[\`${raw}\`](${url})`;
    } catch {
      return raw;
    }
  };

  // A code span that is ENTIRELY a reference is a reference someone chose to set
  // in code — the commonest way one is written, and the shape the rule in
  // SKILL.md asks for. A span with anything else in it is code and stays code,
  // as does every other protected region: an existing link, a bare URL.
  const span = (region) => {
    const inner = /^(`+)([^`]+)\1$/.exec(region)?.[2]?.trim();
    const m = inner && REFERENCE_ONLY.exec(inner);
    if (!m) return region;
    const start = Number(m.groups.start);
    const end = m.groups.end ? Number(m.groups.end) : null;
    if (!start || (end !== null && !end)) return region;
    const linked = link(inner, m.groups.path ?? null, Math.min(start, end ?? start), end === null ? null : Math.max(start, end));
    return linked === inner ? region : linked;
  };

  const prose = (chunk) => chunk.replace(REFERENCE, (raw, path, startStr, endStr, offset, whole) => {
    // A stack frame's numbers are from the build that threw, not from this
    // commit, so linking one quotes lines nobody has read at that SHA.
    const lineStart = whole.lastIndexOf('\n', offset) + 1;
    if (STACK_FRAME.test(whole.slice(lineStart, offset))) return raw;
    const start = Number(startStr);
    const end = endStr ? Number(endStr) : null;
    if (!start || (end !== null && !end)) return raw;
    return link(raw, path ?? null, Math.min(start, end ?? start), end === null ? null : Math.max(start, end));
  });

  const out = fencedRuns(src).map((run) => {
    if (run.code) return run.text;
    let last = 0;
    let result = '';
    for (const m of run.text.matchAll(PROTECTED)) {
      result += prose(run.text.slice(last, m.index));
      result += span(m[0]);
      last = m.index + m[0].length;
    }
    return result + prose(run.text.slice(last));
  });

  return { text: out.join('\n'), links: count, unresolved: [...new Set(unresolved)] };
}

// ------------------------------------------------------------------- auditing
//
// Everything above BUILDS a link, and a built link is right by construction. The
// links a review *wrote* are the other half: `prt permalink` stamps whatever
// commit the store last recorded, a model can assemble a URL by hand out of
// something it saw in the diff, and a revision edits bytes nothing regenerates.
// Any of those can carry a commit that is not the one the review read.
//
// Nothing about the result looks wrong. A permalink to the wrong commit renders
// exactly like a permalink to the right one — the same box, the same file name,
// fifteen lines of real code — and the reader has no way to tell that the lines
// quoted at them are not the lines the review is talking about. So the commit in
// a written link is checked rather than trusted.

/** Every `blob` link in `text` that points into `repo`, with the ref it names. */
export function permalinksIn(text, repo) {
  const want = String(repo ?? '').toLowerCase();
  const out = [];
  const re = /https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/blob\/([^/\s)<>\]]+)\/([^\s)<>\]]*)/g;
  for (const m of String(text ?? '').matchAll(re)) {
    if (m[1].toLowerCase() !== want) continue;
    out.push({ url: m[0], ref: m[2], path: m[3].split('#')[0] });
  }
  return out;
}

/**
 * The links into `repo` that do not point at `sha`.
 *
 * `refs` name a branch or a tag — always wrong, whatever the review meant,
 * because the lines behind a moving ref drift away from the ones it was written
 * about. `commits` name some other commit, which is *sometimes* deliberate — a
 * reply comparing the code to how it stood two rounds ago is entitled to link
 * two rounds ago — and is therefore reported rather than refused.
 *
 * An abbreviated ref matches: `blob/7ac6b40b/…` is the same commit as
 * `blob/7ac6b40b153d…/…` and GitHub resolves both.
 */
export function auditPermalinks(text, { repo, sha }) {
  const at = String(sha ?? '').toLowerCase();
  const refs = [];
  const commits = [];
  for (const link of permalinksIn(text, repo)) {
    if (!isSha(link.ref)) refs.push(link);
    else if (!isSha(at) || !at.startsWith(link.ref.toLowerCase())) commits.push(link);
  }
  return { refs, commits };
}
