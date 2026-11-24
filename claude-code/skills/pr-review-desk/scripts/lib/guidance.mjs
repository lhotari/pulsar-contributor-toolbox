// Contributor guidance for a review: deterministic signals the desk detects on the PR (CI failing on checkstyle or
// license/format checks, a compile failure, a title that breaks the semantic-title rules, a first-time contributor
// with no sign of Personal CI) and the paragraph each one adds to the review. The worker is told to work them into
// the summary; the import appends any it left out, so the guidance never depends on the model remembering it.
// Apache Pulsar conventions; on for repositories named */pulsar unless the repo config says otherwise.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.mjs';
import * as P from './prt.mjs';

export const LINKS = {
  personalCi: 'https://pulsar.apache.org/contribute/personal-ci/',
  semanticTitle: 'https://pulsar.apache.org/contribute/develop-semantic-title',
};

// .github/workflows/ci-semantic-pull-request.yml on apache/pulsar master; read from the checkout when it has one.
export const TITLE_RULES = {
  types: ['cleanup', 'feat', 'fix', 'improve', 'refactor', 'revert'],
  scopes: ['admin', 'bk', 'broker', 'build', 'ci', 'cli', 'client', 'doc', 'fn', 'io', 'meta', 'misc', 'ml', 'monitor', 'offload', 'proxy',
    'schema', 'sec', 'site', 'storage', 'test', 'txn', 'ws', 'zk', 'pip'],
};
const HEADER = /^\[(\w*?)\](?:\[(.*?)\])?(?:\s*)(.*)$/;

export function enabled(repo) {
  let g; try { g = db.repo(repo)?.config?.guidance; } catch { g = undefined; }
  if (g === true || g === false) return g;
  if (g && typeof g === 'object' && 'enabled' in g && g.enabled !== 'auto') return !!g.enabled;
  return /(^|\/)pulsar$/i.test(repo);
}

/** Why a title breaks the semantic-title rules, or null. */
export function titleProblem(title, rules = TITLE_RULES) {
  const m = String(title || '').trim().match(HEADER);
  if (!m) return 'it does not start with `[type]`';
  const [, type, scope, subject] = m;
  if (!rules.types.includes(type)) return `\`[${type}]\` is not one of the types (${rules.types.map((t) => `\`${t}\``).join(', ')})`;
  if (scope !== undefined) {
    const bad = scope.split(',').map((s) => s.trim()).filter((s) => !rules.scopes.includes(s));
    if (bad.length) return `\`[${scope}]\` is not one of the components (${rules.scopes.map((s) => `\`${s}\``).join(', ')})`;
  }
  if (!subject.trim()) return 'the summary after the prefix is empty';
  return null;
}

/** The rules from the workflow file at the PR's base, when the checkout has it. */
export function titleRules(repo, base) {
  const r = db.repo(repo);
  if (!r?.checkout || !fs.existsSync(r.checkout)) return TITLE_RULES;
  const s = spawnSync('git', ['-C', r.checkout, 'show', `${r.remote || 'origin'}/${base}:.github/workflows/ci-semantic-pull-request.yml`], { encoding: 'utf8' });
  if (s.status !== 0) return TITLE_RULES;
  const list = (key) => (s.stdout.match(new RegExp(`${key}:\\s*\\|\\n((?:\\s+[\\w-]+\\n?)+)`)) || [])[1]?.split('\n').map((x) => x.trim()).filter(Boolean);
  const types = list('types'); const scopes = list('scopes');
  return types?.length && scopes?.length ? { types, scopes } : TITLE_RULES;
}

/** Signs that the author runs CI in their fork: a Personal CI mention or a link to a PR/run in their fork. */
export function personalCiSigns(author, texts) {
  const fork = author ? new RegExp(`github\\.com/${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[\\w.-]+/(pull|actions)/`, 'i') : null;
  return texts.filter((t) => /personal[- ]ci/i.test(t || '') || (fork && fork.test(t || ''))).length > 0;
}

const stripTs = (l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;]*m/g, '');
// Only what the tools themselves print: "Execution failed for task ':x:compileJava'" alone is also what a dependency
// download failure (HTTP 429 from Maven Central) looks like, and that is not the author's problem.
const CHECKSTYLE = [
  /\[ant:checkstyle\] \[ERROR\]/, /Checkstyle rule violations were found/i, /Checkstyle (files with violations|errors?):?\s+[1-9]/i,
  /The following files had format violations/, /Unapproved licenses:|Too many files with unapproved license/i,
  /You have \d+ Checkstyle violations?/, /Failed to execute goal org\.apache\.maven\.plugins:maven-checkstyle-plugin/,
  /Failed to execute goal com\.mycila:license-maven-plugin/, /Missing header in: /,
];
const COMPILE = [
  /Compilation failed; see the compiler (error )?output/, /COMPILATION ERROR/, /Failed to execute goal org\.apache\.maven\.plugins:maven-compiler-plugin/, /\.java:\d+: error: /, /\[ERROR\] \S+\.java:\[\d+,\d+\]/,
];
const DETAIL = { checkstyle: /(\[ant:checkstyle\].*|\[(ERROR|WARN)\] .*\.java:\d+.*|Missing header in: .*|\S+\.java.*format violations?.*)/, compile: /(\S+\.java:\d+: error: .*|\[ERROR\] \S+\.java:\[\d+,\d+\].*)/ };

/** What a failed job's log says: {checkstyle: [lines], compile: [lines]} (empty when the kind is not there). */
export function classifyLog(text) {
  const lines = String(text || '').split('\n').map(stripTs);
  const out = { checkstyle: [], compile: [] };
  for (const [k, res] of [['checkstyle', CHECKSTYLE], ['compile', COMPILE]]) {
    if (!lines.some((l) => res.some((re) => re.test(l)))) continue;
    out[k] = [...new Set(lines.filter((l) => DETAIL[k].test(l)).map((l) => l.trim()))].slice(0, 8);
    if (!out[k].length) out[k] = [lines.find((l) => res.some((re) => re.test(l))).trim()];
  }
  return out;
}

/** The failed check runs on a head, and what the logs of the likely ones say. */
export async function ciFailures(repo, sha, { maxLogs = 4, gh = P } = {}) {
  const runs = [];
  for (let page = 1; page <= 3; page++) {
    const r = await gh.rest('GET', `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`).catch(() => null);
    runs.push(...(r?.check_runs || []));
    if (!r || (r.check_runs || []).length < 100) break;
  }
  const failed = runs.filter((c) => c.status === 'completed' && ['failure', 'timed_out'].includes(c.conclusion));
  const out = { failed: failed.map((c) => c.name), checkstyle: null, compile: null, titleCheck: null, pending: runs.some((c) => c.status !== 'completed') };
  const title = failed.find((c) => /pull request title/i.test(c.name));
  if (title) out.titleCheck = { job: title.name, url: title.html_url };
  // Build/check jobs first: they compile and run checkstyle; test jobs compile tests too.
  const rank = (c) => (/build|license|check|style|compile/i.test(c.name) ? 0 : /unit|test/i.test(c.name) ? 1 : 2);
  const actions = failed.filter((c) => c !== title && /github\.com\/[^/]+\/[^/]+\/actions\/runs\//.test(c.html_url || c.details_url || '')).sort((a, b) => rank(a) - rank(b));
  for (const c of actions.slice(0, maxLogs)) {
    if (out.checkstyle && out.compile) break;
    const log = await jobLog(gh, repo, c.id);
    if (log == null) continue;
    const k = classifyLog(log);
    for (const kind of ['checkstyle', 'compile']) if (!out[kind] && k[kind].length) out[kind] = { job: c.name, url: c.html_url, lines: k[kind] };
  }
  return out;
}

/** A job's log. Logs carry terminal colour codes, which gh only prints with --allow-escape-sequences (gh 2.8x+). */
async function jobLog(gh, repo, id) {
  const p = `repos/${repo}/actions/jobs/${id}/logs`;
  if (gh.gh) { try { const out = await gh.gh(['api', '--allow-escape-sequences', p], { timeoutMs: 120_000 }); if (out) return out; } catch {} }
  const r = await gh.restRaw?.('GET', p).catch(() => null);
  return r?.ok && r.stdout ? r.stdout : null;
}

function usesGradle(repo, base) {
  const r = db.repo(repo);
  if (r?.checkout && fs.existsSync(r.checkout)) {
    const s = spawnSync('git', ['-C', r.checkout, 'cat-file', '-e', `${r.remote || 'origin'}/${base}:gradlew`]);
    if (s.status === 0) return true;
    const m = spawnSync('git', ['-C', r.checkout, 'cat-file', '-e', `${r.remote || 'origin'}/${base}:pom.xml`]);
    if (m.status === 0) return false;
  }
  return base === 'master' || base === 'main';
}

// Why Personal CI: the two reasons that matter to a contributor and to the project.
const WHY_PERSONAL_CI = `There is no need to wait for a maintainer to approve the CI runs, and running the early rounds in your fork's own GitHub Actions saves the project's CI resources.`;
const job = (x) => (x?.url ? `[${x.job}](${x.url})` : x?.job ? `\`${x.job}\`` : 'CI');

/**
 * The guidance items for a PR head: [{key, why, text, marker}] (marker: what shows the text is in the body).
 * Cached per head once CI on it has finished. `extra`: keys the reviewer asked for (e.g. personal-ci when the PR was obviously not tested).
 */
export async function assess(repo, number, sha, { extra = [], gh = P, refresh = false } = {}) {
  if (!enabled(repo)) return { items: [], signals: null };
  const key = `guidance:${repo}#${number}@${sha}`;
  let signals = refresh ? null : db.J(db.meta(key));
  if (!signals) {
    const pr = db.pr(repo, number);
    const raw = rawPr(repo, number);
    const texts = [pr?.body || raw?.body || '', ...(raw?.comments?.nodes || []).map((c) => c.body), ...(raw?.reviews?.nodes || []).map((r) => r.body),
      ...(raw?.reviewThreads?.nodes || []).flatMap((t) => (t.comments?.nodes || []).map((c) => c.body))];
    const ci = await ciFailures(repo, sha, { gh });
    signals = {
      at: db.now(), base: pr?.base_ref, gradle: usesGradle(repo, pr?.base_ref || 'master'),
      firstTimer: ['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER'].includes(pr?.association), personalCiSigns: personalCiSigns(pr?.author, texts),
      title: pr?.title || '', titleProblem: titleProblem(pr?.title, titleRules(repo, pr?.base_ref || 'master')) || (ci.titleCheck ? 'the "Check pull request title" check fails' : null),
      ci,
      // Said on the PR already (by anyone, e.g. an earlier review): the title and first-timer notes are not repeated.
      said: { title: texts.some((t) => (t || '').includes(LINKS.semanticTitle)), personalCi: texts.slice(1).some((t) => (t || '').includes(LINKS.personalCi)) },
    };
    if (!ci.pending) db.meta(key, JSON.stringify(signals));
  }
  return { items: items(signals, extra), signals };
}

function rawPr(repo, number) {
  try { const f = path.join(db.prDir(repo, number), 'pr.json'); return fs.existsSync(f) ? db.J(fs.readFileSync(f, 'utf8')) : null; } catch { return null; }
}

export function items(s, extra = []) {
  const out = [];
  const quick = s.gradle ? '`./gradlew quickCheck`' : '`mvn -ntp -T 1C -DskipSourceReleaseAssembly=true -DskipBuildDistribution=true -Dspotbugs.skip=true verify -DskipTests`';
  if (s.ci?.checkstyle) {
    out.push({ key: 'checkstyle', marker: s.gradle ? 'quickCheck' : 'checkstyle', why: `${s.ci.checkstyle.job} fails on checkstyle, license headers or formatting`, lines: s.ci.checkstyle.lines,
      text: `The build fails on code style or license-header checks (${job(s.ci.checkstyle)}). Please run ${quick} before pushing changes to the PR branch${s.gradle ? ': it runs the license-header, checkstyle and spotless checks without compiling, so it takes a minute or two (`./gradlew spotlessApply` fixes the formatting)' : ''}. That catches these failures locally instead of in a CI round.` });
  }
  const untested = extra.includes('personal-ci');
  if (s.ci?.compile || untested) {
    out.push({ key: 'personal-ci', marker: LINKS.personalCi, why: s.ci?.compile ? `${s.ci.compile.job} fails to compile` : 'the review found that the PR was not tested', lines: s.ci?.compile?.lines,
      text: `${s.ci?.compile ? `The PR does not compile (${job(s.ci.compile)}). ` : 'It looks like the changes have not been built and tested yet. '}Please build and run the affected tests locally${s.gradle ? ' (`./gradlew sanityCheck` compiles the main and test sources of every module)' : ''}, and use [Personal CI](${LINKS.personalCi}) to run the full Pulsar CI in your fork before pushing to this PR. ${WHY_PERSONAL_CI}` });
  } else if (s.firstTimer && !s.personalCiSigns && !s.said?.personalCi) {
    out.push({ key: 'first-timer', marker: LINKS.personalCi, why: 'first-time contributor, no sign of Personal CI in the description or comments',
      text: `Since this is your first contribution to Apache Pulsar: you can run the full Pulsar CI in your own fork with [Personal CI](${LINKS.personalCi}). It is very useful: CI runs on PRs from first-time contributors wait here until a maintainer approves them, while in your fork they start right away, and running the early CI rounds in your fork's own GitHub Actions saves the project's CI resources. Add the link to the PR in your fork in the "Matching PR in forked repository" section of the description.` });
  }
  if (s.titleProblem && !s.said?.title) {
    out.push({ key: 'title', marker: LINKS.semanticTitle, why: `title: ${s.titleProblem}`,
      text: `The PR title doesn't follow the [semantic title guidelines](${LINKS.semanticTitle}): ${s.titleProblem}. The format is \`[type][component] summary\`, for example \`[fix][broker] Fix the race when closing a consumer\`; please update the title.` });
  }
  return out;
}

/** The body with each item that it does not mention yet appended. Returns {body, added: [keys]}. */
export function ensure(body, list) {
  let b = String(body || '').trimEnd(); const added = [];
  for (const it of list) {
    if (b.includes(it.marker)) continue;
    b = `${b}${b ? '\n\n' : ''}${it.text}`; added.push(it.key);
  }
  return { body: b, added };
}
