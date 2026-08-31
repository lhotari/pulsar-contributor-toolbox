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
