// The build check every committed pick passes before the lane moves on: the Maven modules the pick changed (and the
// modules they need, built and packaged in the same reactor, so nothing is installed into ~/.m2) compile, the test methods the pick
// added or changed pass, and checkstyle passes for the changed Java files.
//
// Maven: session config `mvn` (a command), else $BPT_MVN, else the worktree's ./mvnw. A worktree without either
// (a Gradle branch) is not checked here; the verify job covers it. Session config buildCheck=false turns it off,
// buildCheckTests=false keeps compile and checkstyle but skips the tests, buildTimeoutMinutes (default 90).
// The intent check (lib/intent.mjs, e.g. Gradle dependency upgrades in effect in Maven) runs before this, in lane.buildPick.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as db from './db.mjs';

const SKIPS = ['-Dspotbugs.skip=true', '-Dlicense.skip=true', '-DnarPluginPhase=none', '-Dmaven.javadoc.skip=true'];

export function mavenCommand(dir, cfg = {}) {
  const c = cfg.mvn || process.env.BPT_MVN;
  if (c) return c;
  return fs.existsSync(path.join(dir, 'mvnw')) ? './mvnw' : null;
}

/** The Maven module of each changed file: the nearest directory with a pom.xml ("." for the root pom itself). */
export function modulesOf(dir, files) {
  const mods = new Set();
  for (const f of files) {
    let d = path.dirname(f);
    while (d !== '.' && d !== '/' && !fs.existsSync(path.join(dir, d, 'pom.xml'))) d = path.dirname(d);
    if (d !== '.') mods.add(d);
    else if (f === 'pom.xml') mods.add('.');
  }
  return [...mods].sort();
}

function mvn(dir, cmd, args, logFile, timeoutMin) {
  fs.appendFileSync(logFile, `\n$ ${cmd} ${args.join(' ')}\n`);
  const fd = fs.openSync(logFile, 'a');
  const r = spawnSync('bash', ['-c', `${cmd} "$@"`, 'mvn', ...args], { cwd: dir, stdio: ['ignore', fd, fd], timeout: timeoutMin * 60_000 });
  fs.closeSync(fd);
  return { ok: r.status === 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
}

const tail = (file, n = 6000) => { const s = fs.readFileSync(file, 'utf8'); return s.length > n ? s.slice(-n) : s; };

/**
 * Run the check in `dir` (the lane worktree at its HEAD). `files`: the pick's changed files; `dtest`: {module: -Dtest}.
 * Returns {ok, stage, modules, tests, log, output, at} or {ok: true, skipped}.
 */
export function buildCheck({ dir, files, dtest = {}, cfg = {}, name = 'build', log = () => {} }) {
  const cmd = mavenCommand(dir, cfg);
  if (cfg.buildCheck === false) return { ok: true, skipped: 'buildCheck is off for this session' };
  if (!cmd) return { ok: true, skipped: 'no Maven wrapper in the worktree' };
  const modules = modulesOf(dir, files);
  if (!modules.length) return { ok: true, skipped: 'no Maven module changed' };
  const runTests = cfg.buildCheckTests !== false;
  const tests = runTests ? Object.entries(dtest).filter(([m, v]) => v && fs.existsSync(path.join(dir, m, 'pom.xml'))) : [];
  const reactor = [...new Set([...modules, ...tests.map(([m]) => m)])];
  const logDir = path.join(db.BPT_HOME, 'logs'); fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`); fs.writeFileSync(logFile, '');
  const timeout = Number(cfg.buildTimeoutMinutes || 90);
  const base = { modules: reactor, tests: tests.map(([, v]) => v).join(','), log: logFile, at: db.now() };
  const fail = (stage, r) => ({ ...base, ok: false, stage: r.timedOut ? `${stage} (timed out after ${timeout} min)` : stage, output: tail(logFile) });

  // 1. Compile main and test code of the changed modules and run the changed tests, in one reactor with -am. The
  //    reactor goes to `package`: shaded modules (zookeeper-with-patched-admin) and dependency:unpack (functions
  //    worker) need the packaged jars of upstream modules; `test` alone fails on branch-4.2.
  log(`build check: ${tests.length ? 'compile and test' : 'compile'} ${reactor.join(', ')}${tests.length ? ` (-Dtest=${base.tests})` : ''}`);
  const testArgs = tests.length ? ['package', `-Dtest=${base.tests}`, '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false',
    '-DexcludedGroups=', '-DtestRetryCount=0', '-DtestFailFast=false', '-DredirectTestOutputToFile=true'] : ['package', '-DskipTests'];
  let r = mvn(dir, cmd, ['-B', '-ntp', '-T', '1C', '-pl', reactor.join(','), '-am', ...testArgs, '-Dcheckstyle.skip=true', ...SKIPS], logFile, timeout);
  if (!r.ok) return fail(tests.length ? 'compile or tests' : 'compile', r);

  // 2. Checkstyle for the changed Java files (initialize sets pulsar.basedir, which the checkstyle config needs).
  const java = files.filter((f) => f.endsWith('.java') && fs.existsSync(path.join(dir, f)));
  const javaModules = modulesOf(dir, java).filter((m) => m !== '.');
  if (javaModules.length) {
    log(`build check: checkstyle ${java.length} file(s) in ${javaModules.join(', ')}`);
    const includes = [...new Set(java.map((f) => `**/${path.basename(f)}`))].join(',');
    r = mvn(dir, cmd, ['-B', '-ntp', '-pl', javaModules.join(','), 'initialize', 'checkstyle:check', `-Dcheckstyle.includes=${includes}`], logFile, timeout);
    if (!r.ok) return fail('checkstyle', r);
  }
  return { ...base, ok: true, output: tail(logFile, 1500) };
}
