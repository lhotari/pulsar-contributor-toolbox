// GitHub access layer for pr-review-track.
// Everything goes through the `gh` CLI so we inherit the user's auth, and every
// call is retried on the failure modes GitHub actually produces (abuse/secondary
// rate limits, 5xx, transient network errors).

import { spawn } from 'node:child_process';

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

export class GhError extends Error {
  constructor(message, { code, stderr, stdout, status } = {}) {
    super(message);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.status = status;
  }
}

function run(args, { input, cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

// GitHub signals a secondary ("abuse") rate limit with 403 and a body that
// mentions retrying; the primary limit is a 403 with x-ratelimit-remaining: 0.
function retryDelayMs(stderr, attempt) {
  const retryAfter = /retry-after:\s*(\d+)/i.exec(stderr);
  if (retryAfter) return Number(retryAfter[1]) * 1000;
  const base = Math.min(60_000, 2000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 1000); // jitter: avoid lockstep retries
}

function isRetryable(res) {
  if (res.timedOut) return true;
  if (res.code === 0) return false;
  const s = `${res.stderr}\n${res.stdout}`;
  if (/HTTP 5\d\d/.test(s)) return true;
  if (/was submitted too quickly|secondary rate limit|abuse detection/i.test(s)) return true;
  if (/API rate limit exceeded/i.test(s)) return true;
  // Go's net package (which `gh` uses) words these differently from libc.
  if (/connection reset|ETIMEDOUT|ECONNRESET|EAI_AGAIN|TLS handshake/i.test(s)) return true;
  if (/i\/o timeout|dial tcp|no such host|connection refused|unexpected EOF|context deadline exceeded/i.test(s)) return true;
  return false;
}

export async function gh(args, opts = {}) {
  const attempts = opts.attempts ?? 4;
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await run(args, opts);
    if (last.code === 0) return last.stdout;
    if (!isRetryable(last) || attempt === attempts - 1) break;
    const delay = retryDelayMs(last.stderr, attempt);
    process.stderr.write(`[prt] gh retry ${attempt + 1}/${attempts - 1} in ${Math.round(delay / 1000)}s: ${last.stderr.trim().split('\n')[0]}\n`);
    await SLEEP(delay);
  }
  throw new GhError(`gh ${args.slice(0, 3).join(' ')} failed (exit ${last.code}): ${last.stderr.trim() || last.stdout.trim()}`, {
    code: last.code,
    stderr: last.stderr,
    stdout: last.stdout,
  });
}

export async function ghJson(args, opts = {}) {
  const out = await gh(args, opts);
  const text = out.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GhError(`gh returned non-JSON output: ${text.slice(0, 400)}`);
  }
}

/**
 * Run a GraphQL query. `vars` values are typed: strings via -f, everything else
 * via -F (gh coerces ints/bools/null for -F only).
 */
export async function graphql(query, vars = {}, opts = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    if (typeof v === 'string') args.push('-f', `${k}=${v}`);
    else args.push('-F', `${k}=${v}`);
  }
  const data = await ghJson(args, opts);
  if (data?.errors?.length) {
    // Partial data with errors is common (e.g. one aliased PR is inaccessible).
    // Surface the errors but keep whatever resolved.
    const msgs = data.errors.map((e) => e.message).join('; ');
    if (!data.data) throw new GhError(`GraphQL error: ${msgs}`);
    process.stderr.write(`[prt] GraphQL partial errors: ${msgs}\n`);
  }
  return data?.data ?? null;
}

/** REST call returning parsed JSON. */
export async function rest(method, path, body, opts = {}) {
  const args = ['api', '--method', method, path];
  if (body !== undefined) {
    args.push('--input', '-');
    return ghJson(args, { ...opts, input: JSON.stringify(body) });
  }
  return ghJson(args, opts);
}

/**
 * Parse the body of a raw `gh api` response. `gh` prints the response body on
 * stdout even for a 4xx, but it can also print nothing at all (network error),
 * so never assume the output is JSON.
 */
export function parseBody(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** REST call that returns the raw error so the caller can inspect a 422 body. */
export async function restRaw(method, path, body, opts = {}) {
  const args = ['api', '--method', method, path];
  const input = body === undefined ? undefined : JSON.stringify(body);
  if (input !== undefined) args.push('--input', '-');
  const res = await run(args, { ...opts, input });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr, code: res.code };
}

let cachedViewer = null;
export async function viewerLogin() {
  if (cachedViewer) return cachedViewer;
  const data = await graphql('query { viewer { login } }');
  cachedViewer = data.viewer.login;
  return cachedViewer;
}

export async function rateLimit() {
  const data = await graphql('query { rateLimit { limit cost remaining resetAt } }');
  return data.rateLimit;
}

/**
 * Resolve owner/repo for the current working directory. Falls back through:
 *   explicit --repo  ->  gh repo view  ->  origin remote URL
 * When the resolved repo is a fork, the upstream parent is preferred, because
 * reviews live on the upstream PR.
 */
export async function resolveRepo(explicit, cwd = process.cwd()) {
  if (explicit) return normalizeSlug(explicit);
  let cause = null;
  try {
    // Retry: a transient network blip here would otherwise look like "this is
    // not a GitHub repository", which sends you chasing the wrong problem.
    const info = await ghJson(['repo', 'view', '--json', 'nameWithOwner,isFork,parent'], { cwd, attempts: 3 });
    if (info?.isFork && info.parent?.nameWithOwner) return info.parent.nameWithOwner;
    if (info?.nameWithOwner) return info.nameWithOwner;
  } catch (e) {
    cause = e.message;
  }
  throw new GhError(
    `Could not determine the GitHub repository for ${cwd}. Pass --repo <owner>/<repo>.` +
      (cause ? `\n  gh said: ${cause}` : ''),
  );
}

export function normalizeSlug(s) {
  const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(s).trim());
  if (!m) throw new GhError(`Not a valid repository slug: ${s}`);
  return `${m[1]}/${m[2]}`;
}
