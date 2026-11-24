// Job queue. Engine jobs run `bpt job run <id>` as a child process. Claude jobs run headless
// `claude -p` on the user's Claude Code login (no API key), or wait for an interactive session to claim them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import { sessionDir } from './plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BPT = path.resolve(HERE, '..', 'bpt.mjs');
export const ENGINE = ['discover', 'triage', 'start-lane', 'pick-all', 'push-test', 'rerun', 'squash', 'finalize', 'push-final-fix', 'apply-labels', 'post-comments', 'abort'];
// Triage: the engine job 'triage' exports the batches and queues one 'triage-batch' worker per batch (they run in
// parallel, each evaluating its batch itself: a headless claude -p stops background subagents 10 minutes after its last
// turn, so a worker must not hand the batches to subagents). When the last batch worker finishes, 'triage-import'
// spot-checks the verdict files and imports them.
export const CLAUDE = ['resolve', 'verify', 'fix-ci', 'review', 'triage-batch', 'triage-import', 'explain'];
// Read-only workers that run beside a lane's jobs: they have no branch (args.branch names the lane they read), so they
// neither wait for the lane's job nor hold it or the autopilot up, and they have their own worker limit.
export const SIDE = ['triage-batch', 'explain'];
export const ACTIVE = ['queued', 'running', 'waiting'];

export function enqueue(sid, branch, type, args = {}) {
  // An explanation only reads: a finished or archived session can have one too.
  if (sid && type !== 'explain') db.assertEditable(sid);
  const runner = ENGINE.includes(type) ? 'engine' : CLAUDE.includes(type) ? 'claude' : null;
  if (!runner) throw new Error(`unknown job type ${type}`);
  // One active job per session, branch and type; triage batches are told apart by their batch.
  const dup = db.get(`SELECT id FROM jobs WHERE session_id = ? AND IFNULL(branch,'') = IFNULL(?,'') AND type = ? AND status IN ('queued','running','waiting')
                      AND IFNULL(json_extract(args, '$.batch'), '') = IFNULL(?, '')
                      AND (type != 'explain' OR (json_extract(args, '$.branch') = ? AND json_extract(args, '$.pr') = ?
                           AND IFNULL(json_extract(args, '$.question'), '') = IFNULL(?, '')))`,
  sid, branch, type, args.batch ?? null, args.branch ?? null, args.pr ?? null, args.question ?? null);
  if (dup) return dup.id;
  const r = db.run('INSERT INTO jobs (session_id, branch, type, runner, args, created_at) VALUES (?,?,?,?,?,?)',
    sid, branch, type, runner, db.S(args), db.now());
  const id = Number(r.lastInsertRowid);
  db.event(sid, `Queued ${type}${args.pr ? ` #${args.pr}` : ''} (${runner === 'claude' ? 'Claude Code' : 'engine'})`, { branch, job: id });
  return id;
}

export function job(id) {
  const j = db.get('SELECT * FROM jobs WHERE id = ?', id);
  if (!j) throw new Error(`no job ${id}`);
  return { ...j, args: db.J(j.args, {}), result: db.J(j.result) };
}

export function activeJob(sid, branch) {
  return db.get(`SELECT * FROM jobs WHERE session_id = ? AND IFNULL(branch,'') = IFNULL(?,'') AND status IN ('queued','running','waiting') ORDER BY id LIMIT 1`, sid, branch);
}

export function finish(id, status, result) {
  const j = job(id);
  db.run('UPDATE jobs SET status = ?, result = ?, finished_at = ?, pid = NULL WHERE id = ?', status, db.S(result ?? null), db.now(), id);
  const msg = result?.summary || result?.error || result?.question || '';
  db.event(j.session_id, `${j.type}${j.args.pr ? ` #${j.args.pr}` : ''}${j.args.batch ? ` ${j.args.batch}` : ''} ${status}${msg ? `: ${String(msg).slice(0, 500)}` : ''}`,
    { branch: j.branch, job: id, level: status === 'failed' ? 'error' : status === 'waiting' ? 'attention' : 'info' });
  if (j.type === 'triage-batch' && status !== 'waiting') afterTriageBatch(j);
}

/** The last batch worker of a triage round is done: queue the import of the verdict files that were written. */
function afterTriageBatch(j) {
  const { dir, round } = j.args;
  const siblings = db.all(`SELECT id, status, args FROM jobs WHERE session_id = ? AND type = 'triage-batch'`, j.session_id)
    .map((x) => ({ ...x, args: db.J(x.args, {}) })).filter((x) => x.args.dir === dir);
  if (siblings.some((x) => ACTIVE.includes(x.status))) return;
  const written = siblings.filter((x) => x.args.out && fs.existsSync(x.args.out));
  const missing = siblings.filter((x) => !(x.args.out && fs.existsSync(x.args.out))).map((x) => x.args.batch);
  if (!written.length) { db.event(j.session_id, `Triage round ${round}: no batch wrote verdicts (${missing.join(', ')}); nothing to import`, { level: 'error' }); return; }
  try {
    enqueue(j.session_id, null, 'triage-import', { dir, round, files: written.map((x) => x.args.out), missing, instructions: j.args.instructions });
  } catch (e) { db.event(j.session_id, `Queuing the triage import failed: ${e.message}`, { level: 'error' }); }
}

/** An interactive Claude Code session takes the oldest queued Claude job. */
export function claim(sid, who = 'interactive') {
  const j = db.get(`SELECT id FROM jobs WHERE runner = 'claude' AND status = 'queued' ${sid ? 'AND session_id = ?' : ''} ORDER BY id LIMIT 1`, ...(sid ? [sid] : []));
  if (!j) return null;
  const r = db.run(`UPDATE jobs SET status = 'running', claimed_by = ?, started_at = ? WHERE id = ? AND status = 'queued'`, who, db.now(), j.id);
  return r.changes ? job(j.id) : null;
}

export function logPath(id) {
  const dir = path.join(db.BPT_HOME, 'logs'); fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `job-${id}.log`);
}

// --- prompts for Claude Code workers ---

const FIXRULE = 'A fix always goes into the cherry-pick commit it belongs to: for a problem this pick has, or one an earlier pick introduced (a later pick or CI may be the first to notice), commit it with git commit --fixup=<that pick\'s commit from ctx.picks> (never amend a commit that is not HEAD, never git rebase yourself); the engine squashes it into that commit and updates the shas of it and every commit after it. Only commits of this lane (ctx.picks) can take a fixup: a problem in code that was already on the branch goes into the pick that needs the change (the one whose check exposed it).';

/** The CI record of a fix-ci job's lane (test branch or the release branch). */
const ciOf = (j) => { try { return db.lane(j.session_id, j.branch).ci[j.args.kind === 'final' ? 'final' : 'test'] || {}; } catch { return {}; } };

export function workerPrompt(j) {
  const head = `You are a headless worker for the pulsar-backport skill. Load the pulsar-backport skill and follow its "Worker jobs" section.
Job ${j.id}: ${j.type}${j.branch ? ` on ${j.branch}` : ''}, session ${j.session_id}.
Engine: node ${BPT}
Start with: node ${BPT} job show ${j.id}
End with exactly one of: job done ${j.id} --summary "...", job fail ${j.id} --reason "...", or job ask ${j.id} --question "..." (when only the user can decide).
With job ask, add --propose with the actions you recommend, so the user can approve one with a click: dep:<pr>:<dependency> (backport that PR first, in master order), drop:<pr> (leave a pick out; the lane is rebuilt without it), rerun, reset. Comma separated, recommended first.
Keep --question short and plain: what you did, what stops you, the choices. Put what you would do in --recommend "<one sentence, imperative>" (e.g. "Mark it resolved as is"); the user can accept it with one click and you resume with it as the reply.
Never push, never open or edit PRs, never change labels: the engine and the user do that.`;
  const extra = {
    resolve: `Resolve pick #${j.args.pr} with the pulsar-cherry-pick skill's per-commit loop (conflicts, slog→slf4j, Gradle→Maven, compile the module). Step 6 of that loop (run the changed tests) is worked out in ctx.pick.tests (job show): the -Dtest value per module. The pick must compile, pass its changed tests and pass checkstyle for the changed files (./mvnw -pl <module> initialize checkstyle:check): the engine's build check runs exactly that after you report it resolved, and a failure comes back to you. A needs-fix pick from a failed build check has the failing stage, modules, tests and log in ctx.pick.detail.build. An intent failure means part of the master change is missing on the branch: master builds with Gradle, the branch with Maven, so a dependency upgrade in gradle/libs.versions.toml must be made in the branch's pom.xml (the property or version that Maven resolves for those coordinates) and in the distribution LICENSE files (the jar name); keep the change of the master commit, do not drop it with the Gradle file. An intent failure from the hunk rules (main-dropped, main-missing, test-changed, test-hunk-dropped, test-dropped, assertions-dropped; node ${BPT} pick compare ${j.session_id} ${j.branch} ${j.args.pr} shows each hunk next to master's) means the backport is not the master change: port the master hunk (adapted to the branch's code) and restore master's tests as master has them. The tests are what pins the fix: do not change them to make them pass, and never weaken an assertion. Keep a difference only where the branch cannot take master's version (an API or helper that differs, code that is not on the branch) and change as little as that needs; then prove the adapted test still tests the fix: undo the main-code part of the pick in the worktree (git stash push -m bpt-${j.id} -- <main files>, or git checkout <the pick>^ -- <main files>), run the test, it must fail; restore the fix and run it again, it must pass; leave no changes behind. Report each kept difference with lane resolved ... --adaptations "<file: what differs from master, why the branch needs it, and the test run without the fix that failed>"; the user decides on those, and they never accept anything themselves. A build failure can come from an earlier pick and only show now (it changed code another module or a later test uses): ctx.pick.detail.build.suspects lists the picks that last changed the failing lines. Find where the problem belongs and choose: fix this pick; fix the earlier pick (fixup of its commit); the earlier pick needs another master change first (job ask --propose dep:<earlier pr>:<missing pr>); or the earlier pick cannot work on this branch (job ask --propose drop:<earlier pr>). Prefer a fix when it is small and mechanical (an import, a helper the branch lacks, an API that differs); propose a dependency or a drop when it is not. ${FIXRULE} Commit a conflict with git cherry-pick --continue (fixups for earlier picks after that), then run: node ${BPT} lane resolved ${j.session_id} ${j.branch} ${j.args.pr} --tests "<what you ran>" --result "<passed | which failed and why that is not this pick>". PRs in ctx.pick.excludedInReview were left out of this branch in plan review on purpose: resolve without them (adapt the change to the branch's code) and do not propose them as dep:. If the pick needs another PR first, do not add it yourself: leave the cherry-pick in place and finish with job ask ${j.id} --question "<what it needs and why>" --propose dep:${j.args.pr}:<dep-pr>. If the pick cannot work on this branch, propose drop:${j.args.pr}.${j.args.concerns ? ` This pick is already committed; a diff review found a problem with it: ${j.args.concerns} Fix that in the pick's commit (git commit --fixup=<the pick's commit>), check it (compile, its changed tests, checkstyle), then run lane resolved as above; if the concern is wrong, finish with job ask and explain why, with --recommend.` : ''}`,
    verify: `Verify the whole lane builds: compile every module the picks touched (install shared modules first), run the tests each pick added or changed, and fix problems with fixup! commits (git commit --fixup=<pick commit>). ${FIXRULE} When it builds and the tests pass, run node ${BPT} lane phase ${j.session_id} ${j.branch} verified.`,
    'fix-ci': `CI ${j.args.kind === 'final' ? `on ${j.branch} itself` : `on the test branch ${ciOf(j).branch || ''}`} failed (workflow_dispatch runs, no PR: gh run list -R apache/pulsar --event workflow_dispatch --branch ${ciOf(j).branch || j.branch} --commit ${j.args.sha || ciOf(j).sha || '<sha>'}${(ciOf(j).failed || []).length ? `; failed: ${ciOf(j).failed.map((f) => `${f.name} ${f.link}`).join(', ')}` : ''}). Investigate with the investigate-ci skill, giving it the failed run URLs. Before calling any failure flaky, reproduce it locally in the lane worktree: build with the reactor (./mvnw -T 1C -pl <module> -am package -Dtest=<Class#method> -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false -DexcludedGroups= -DtestRetryCount=0 -Dcheckstyle.skip=true -Dspotbugs.skip=true -Dlicense.skip=true; never -o against ~/.m2 jars, which can be stale) and run each failed test at least 5 times. Report the counts (e.g. 'failed 5/5 locally'). A test that fails locally, or failed in both the first run and the in-run retry (surefire 'Run 1'/'Run 2'), is not flaky until shown otherwise: find the commit that causes it (git revert --no-commit <pick> in a scratch worktree, re-run) and check whether master has the same failure or a later fix (git log master -- <files>) that is not on the branch. Only a failure that passes locally every time and has a known infrastructure or timing cause is flaky. A flaky or pre-existing failure: run node ${BPT} ci rerun ${j.session_id} ${j.branch}. A real failure caused by a pick: fix it locally${j.args.kind === 'final' ? '' : ` (${FIXRULE})`}${j.args.kind === 'final' ? ' as a new commit on top of HEAD (the branch is already pushed; the user pushes the fix from the UI)' : ` with a fixup! commit for that pick, run the affected tests, then node ${BPT} lane phase ${j.session_id} ${j.branch} verified (the engine squashes the fix into that pick and pushes the rewritten lane as a new test round, no force-push)`}.`,
    review: `Review job for ${j.branch}. Do not change any code or commit anything: only judge and record.
${(j.args.review || j.args.prs || []).length ? `Diff review of ${(j.args.review || j.args.prs).map((x) => `#${x}`).join(', ')}.` : ''} ${(j.args.analyze || []).length ? `Analysis of ${j.args.analyze.map((x) => `#${x}`).join(', ')}.` : ''}
For each of these picks, run node ${BPT} pick diff ${j.session_id} ${j.branch} <pr> (both diffs file by file, the plan's assessment and port and adaptation notes, the PRs left out in review, the conflict hints, the build and intent checks, and any analysis recorded for another branch). Then run node ${BPT} pick compare ${j.session_id} ${j.branch} <pr>: only the hunks that are not identical to master's, and the intent rules that see a difference (a pick with any cannot be recorded "ok"). Look hardest at a backport that changes the master commit's tests: the tests pin what the fix does, so a changed test (an assertion, an expected value, a timing, a test left out, a setup that no longer reaches the fixed code) is a concern unless the branch cannot run master's version and the changed test still fails without the fix. Read the PR on GitHub (gh pr view <pr> -R apache/pulsar, read only) and the branch's code (the lane worktree, git show, git grep) when the diff does not say enough; do not assume.

Diff review (the picks listed for it): compare the backport with the master commit and record node ${BPT} pick review ${j.session_id} ${j.branch} <pr> --verdict ok|adapted|concern --summary "<one or two sentences>" [--concerns "<what is missing or wrong, and the fix>"].
- ok: the backport makes the master change (only context, line numbers or imports differ).
- adapted: it differs where the branch needs it: code the master commit changes that does not exist on ${j.branch} (a feature or PR that is not there or was left out in review), an API or signature that differs on the branch, slog to slf4j logging, Gradle to Maven build changes (a dependency upgrade in gradle/libs.versions.toml made in a pom.xml), Java 8 (branch-4.0 client modules) or Java 17 language level, tests adapted to the branch's test helpers. Say what was adapted and why it is right.
- concern: part of the master change's intent is missing or wrong on the branch: a main-code hunk dropped although the code exists on the branch, a behaviour that differs from master without a reason, a dependency upgrade or a config/doc change not made, a test the branch could run left out, a resolution that is wrong or incomplete, or unrelated changes in the backport. Name each problem and how to fix it.

Analysis (the picks listed for it), for the backport report: node ${BPT} pick analysis ${j.session_id} ${j.branch} <pr> --fixes "<the problem the PR fixes, as a release-notes reader needs it: symptom and cause, 1-3 sentences>" --relevance "<why it matters for ${j.branch}: the bug is present there (how it shows), or the class/module on the branch is otherwise identical to master and taking the fix avoids divergence that would make later fixes conflict (only for fixes and refactorings, never for new features), or it is a dependency of another pick, a security fix, a flaky-test or build fix>" --reason bug|security|divergence|dependency|test|build|other --compat none|behavior|breaking [--compat-note "<what changes for users or operators: public API, configuration and defaults, wire protocol, metrics names, REST/CLI behaviour, dependency versions, on-disk formats; who is affected and how to keep the old behaviour>"].
- compat none: no user-visible change beyond the bug no longer happening.
- behavior: compatible, but users or operators can notice it (a new config key with a default that keeps the old behaviour, different log or metric output, a stricter validation that only rejects invalid input, a dependency upgrade).
- breaking: an existing setup or client can stop working or behave differently without changing anything (a changed default, removed or renamed API/config/metric, a protocol or format change, a stricter check that rejects input that worked). Be specific; this is highlighted at the top of the report. Judge what is public API by how it is meant to be used, not by visibility: a symbol that is public or exported only because the project's own modules share it (an internal buffer, a runtime helper, an *Impl class, a package marked internal), that its documentation and examples do not use, is an implementation detail; changing it is not a breaking change. A breaking change needs a plausible user or operator who is affected.
When another branch already has an analysis for the PR, reuse what still holds (what it fixes is the same) and check the relevance and compatibility for ${j.branch}.

Judge each pick on its own; keep it short and concrete. When every listed pick is recorded, finish with job done ${j.id} --summary "<counts, the concerns and any breaking changes>".`,
    explain: explainPrompt(j),
    'triage-batch': `Evaluate one triage batch yourself, in this session: read ${j.args.brief} and follow it exactly. Your batch file is ${j.args.file}; write the result to ${j.args.out}. Put helper scripts in ${j.args.dir}, never in the repo worktree or /tmp. Do not hand the work to subagents (the Agent tool): this headless session stops background subagents 10 minutes after its last turn, and the engine already runs the other batches in parallel. When the result file is written and is valid JSON in the brief's format, finish with job done ${j.id} --summary "<counts of pick/maybe/skip/already>".`,
    'triage-import': `Import the triage verdicts of round ${j.args.round}: ${(j.args.files || []).join(' ')}.${(j.args.missing || []).length ? ` These batches wrote no verdicts (their worker failed): ${j.args.missing.join(', ')}; say so in the summary, their PRs stay untriaged.` : ''} First spot-check, as the pulsar-backport-plan skill's "Triage" section step 3 says: for every pick with medium+ risk, every skip whose reason is "depends on an absent PR", and every high-severity item, verify the load-bearing claim yourself in the session's repo (job show: session.repo), read-only and without checkout: git log <remote>/<branch> --grep='(#X)', git show <remote>/<branch>:<path>. Fix the JSON where it is wrong and say so in the PR's note. Do it yourself, without subagents. Then run node ${BPT} plan import ${j.session_id} <the files> and finish with job done ${j.id} --summary "<imported counts, the corrections you made>".`,
  }[j.type] || '';
  return `${head}\n\n${extra}${sessionInstructions(j)}${j.args.instructions ? `\n\nUser instructions: ${j.args.instructions}` : ''}`;
}

/** The session's free-text instructions (a custom session's purpose, or how to backport), for every Claude worker. */
function sessionInstructions(j) {
  let cfg = {}; try { cfg = db.session(j.session_id).config; } catch {}
  const list = cfg.scope === 'list' && cfg.list?.length ? `This is a custom backport session: the user listed the master PRs to backport (${cfg.list.map((x) => `#${x.pr}`).join(', ')}).` : '';
  const t = cfg.instructions ? `The user's instructions for this session (they apply to every job; a job's own instructions below take precedence where they differ):\n${cfg.instructions}` : '';
  return list || t ? `\n\n${[list, t].filter(Boolean).join('\n')}` : '';
}

function explainPrompt(j) {
  if (j.type !== 'explain') return '';
  const { branch, pr, question } = j.args; const s = j.session_id;
  const earlier = db.all(`SELECT id, type, status, result FROM jobs WHERE session_id = ? AND id != ? AND (branch = ? OR json_extract(args, '$.branch') = ?)
     AND (json_extract(args, '$.pr') = ? OR EXISTS (SELECT 1 FROM json_each(jobs.args, '$.prs') WHERE value = ?) OR type IN ('verify', 'fix-ci')) ORDER BY id`, s, j.id, branch, branch, pr, pr)
    .map((x) => `${x.id} (${x.type}, ${x.status}${db.J(x.result)?.summary ? `: ${String(db.J(x.result).summary).slice(0, 160)}` : ''})`);
  const out = path.join(sessionDir(s), 'explain', `${branch}-${pr}-${j.id}.md`);
  const task = question
    ? `Answer the user's question about pick #${pr} on ${branch} (the backport of the master commit to that branch):\n\n> ${String(question).replace(/\n/g, '\n> ')}\n\nThis is read only:`
    : `Explain in detail why pick #${pr} on ${branch} was backported the way it was. This is read only:`;
  const write = question
    ? `Then write the answer in Markdown to ${out} (create the directory), for a maintainer: the answer first, in a few sentences, then the evidence it rests on (quote the key lines, name commits and PRs as #12345, say what was checked and how). Gather only the evidence the question needs from the list above.`
    : null;
  return `${task} do not change any file in the repository or the lane worktree, do not commit, do not run builds that write into the worktree. Do not hand the work to subagents.

Gather the evidence first:
- node ${BPT} pick compare ${s} ${branch} ${pr} --identical: every hunk of the backport next to master's (identical, same change in other context, logging adapted, modified, master-only, backport-only) and the intent rules.
- node ${BPT} pick diff ${s} ${branch} ${pr}: the plan's assessment, port and adaptation notes, the PRs left out in review, the conflicts and the master commits that also touched those files, the resolver's validation and kept differences, the build check, the diff review and the analysis.
- The work done on this pick, from the logs of earlier jobs (node ${BPT} job log <id>): ${earlier.join('; ') || 'none'}.
- The branch's code before the pick (git -C <lane worktree> show <pick>^:<file>) and master's code before the master commit (git -C <session repo> show <master>^:<file>), to see what each side started from. Where they differ, find the master commits that made the difference and whether they are on ${branch} (git log -L, git log -S, git blame on master; the cherry-pick trailer or the PR number on the branch), and whether the plan left them out (pick diff lists them).
- The PR itself, read only: gh pr view ${pr} -R apache/pulsar --comments.

${write || `Then write the explanation in Markdown to ${out} (create the directory), for a maintainer who decides whether the backport is right:
1. **Summary**: two or three sentences: what the master change does, and how the backport differs from it overall.
2. **Differences from master**: one subsection per hunk that is not identical (group the trivial ones: imports, other context, slog → slf4j logging, in one short list). For each: what master does and what the backport does instead (quote the key lines), why: the branch's code at that point, the master commit it relies on and whether it is on ${branch}, the conflict and how it was resolved, the resolver's own notes; name commits and PRs (#12345). Say whether the difference keeps the intent of the master change and whether it is the smallest adaptation the branch needs; if master's version would have worked on the branch, say so plainly.
3. **Tests**: are master's tests in the backport as master has them; for each changed or left-out test, what it checks now compared with master, and whether it would still fail without the fix (reason from the code; say if it was shown by a run in the job logs).
4. **Verdict**: justified, questionable or wrong, and what to do (keep it, change a named hunk back to master's version, add a dependency, drop the pick).`}

Be concrete and cite evidence; when something cannot be determined, say what is missing instead of guessing. Then run node ${BPT} pick explain ${s} ${branch} ${pr} --file ${out} and finish with job done ${j.id} --summary "<${question ? 'the answer' : 'the verdict'} in one sentence>".`;
}

/** Start a job's process. Returns the child, or null if the job is left for an interactive session. */
export function launch(j, cfg) {
  const lp = logPath(j.id);
  const out = fs.openSync(lp, 'a');
  let child;
  if (j.runner === 'engine') {
    child = spawn(process.execPath, [BPT, 'job', 'run', String(j.id)], { stdio: ['ignore', out, out], detached: false });
  } else {
    if (cfg.runner === 'interactive') return null;
    const claudeSession = j.claude_session || crypto.randomUUID();
    const laneBranch = j.branch || j.args.branch;
    const lane = laneBranch ? db.get('SELECT worktree FROM lanes WHERE session_id = ? AND branch = ?', j.session_id, laneBranch) : null;
    const cwd = lane?.worktree && fs.existsSync(lane.worktree) ? lane.worktree : (fs.mkdirSync(sessionDir(j.session_id), { recursive: true }), sessionDir(j.session_id));
    const resume = j.args.reply && j.claude_session;
    const args = ['-p', resume ? j.args.reply : workerPrompt(j), '--output-format', 'stream-json', '--verbose',
      '--permission-mode', cfg.permissionMode || 'auto',
      '--add-dir', db.BPT_HOME, '--add-dir', cfg.repo,
      // Workers commit locally only. The engine pushes, and only on the user's or autopilot's request.
      '--disallowedTools', 'Bash(git push *)', 'Bash(/usr/bin/git push *)', 'Bash(git -C * push *)', 'Bash(/usr/bin/git -C * push *)',
      'Bash(gh pr create *)', 'Bash(gh pr merge *)', 'Bash(gh pr edit *)', 'Bash(gh pr comment *)', 'Bash(gh pr close *)',
      'Bash(gh pr review *)', 'Bash(gh issue *)', 'Bash(gh label *)',
      // Accepting a failing check, an adaptation or a review concern is the user's decision.
      'Bash(node * lane accept-*)', 'Bash(node * pick accept-*)'];
    if (resume) args.push('--resume', j.claude_session); else args.push('--session-id', claudeSession);
    if (cfg.model) args.push('--model', cfg.model);
    child = spawn(process.env.BPT_CLAUDE || 'claude', args, { cwd, stdio: ['ignore', out, out], env: { ...process.env, BPT_JOB: String(j.id) } });
    db.run('UPDATE jobs SET claude_session = ? WHERE id = ?', claudeSession, j.id);
  }
  db.run(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), pid = ?, log_path = ?, claimed_by = 'server' WHERE id = ?`, db.now(), child.pid, lp, j.id);
  child.on('exit', (code) => {
    fs.closeSync(out);
    const now = job(j.id);
    if (now.status === 'running') finish(j.id, code === 0 && j.runner === 'engine' ? 'done' : 'failed',
      { error: j.runner === 'claude' ? `worker exited (${code}) without reporting; see the log` : `exit ${code}` });
  });
  return child;
}

/** Send a user reply to a waiting Claude job: the worker's Claude Code session is resumed with it. */
export function reply(id, text) {
  const j = job(id);
  if (j.runner !== 'claude') throw new Error('only Claude jobs take replies');
  db.run(`UPDATE jobs SET status = 'queued', args = ?, finished_at = NULL WHERE id = ?`, db.S({ ...j.args, reply: text }), id);
  db.event(j.session_id, `Reply sent to job ${id}`, { branch: j.branch, job: id });
}

export function cancel(id, why = 'cancelled by the user') {
  const j = job(id);
  if (j.pid && j.status === 'running') { try { process.kill(j.pid, 'SIGTERM'); } catch { /* already gone */ } }
  finish(id, 'cancelled', { summary: why });
}

/** Human-readable lines from a job log (stream-json for Claude, plain text for the engine). */
export function readLog(id, offset = 0) {
  const j = job(id); if (!j.log_path || !fs.existsSync(j.log_path)) return { lines: [], offset };
  const buf = fs.readFileSync(j.log_path, 'utf8'); const chunk = buf.slice(offset);
  const lines = [];
  for (const raw of chunk.split('\n')) {
    if (!raw.trim()) continue;
    if (j.runner !== 'claude' || raw[0] !== '{') { lines.push({ kind: 'text', text: raw }); continue; }
    let o; try { o = JSON.parse(raw); } catch { lines.push({ kind: 'text', text: raw }); continue; }
    if (o.type === 'assistant') {
      for (const c of o.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) lines.push({ kind: 'say', text: c.text });
        if (c.type === 'tool_use') lines.push({ kind: 'tool', text: `${c.name}: ${toolSummary(c)}` });
      }
    } else if (o.type === 'result') {
      lines.push({ kind: 'result', text: `${o.subtype}${o.num_turns ? `, ${o.num_turns} turns` : ''}${o.duration_ms ? `, ${Math.round(o.duration_ms / 60000)} min` : ''}` });
    }
  }
  return { lines, offset: buf.length };
}

function toolSummary(c) {
  const i = c.input || {};
  return String(i.command || i.file_path || i.pattern || i.description || i.prompt || JSON.stringify(i)).split('\n')[0].slice(0, 240);
}
