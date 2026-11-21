// Does the backport do what the master commit set out to do? Checks that need no judgement:
//
// Dependency upgrades. Master builds with Gradle (gradle/libs.versions.toml); branch-4.x build with Maven. A version
// the master commit changes in libs.versions.toml must be in effect in the branch's Maven build (the version Maven
// resolves for those coordinates is the new one, or newer), and the distribution LICENSE files must name the new jar.
// A resolution that drops the Gradle change without making it in Maven fails here.
import fs from 'node:fs';
import path from 'node:path';
import * as g from './git.mjs';

const TOML = 'gradle/libs.versions.toml';

/** "1.10.2" vs "1.9" → 1; non-numeric parts compare as strings. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/); const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'; const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    const c = nx && ny ? Number(x) - Number(y) : x.localeCompare(y);
    if (c) return Math.sign(c);
  }
  return 0;
}

const unquote = (s) => s.trim().replace(/^"|"$/g, '');

/** {versions: {key: v}, libraries: [{module, ref, version}]} from a libs.versions.toml text. */
export function parseCatalog(text) {
  const versions = {}; const libraries = []; let section = '';
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const s = line.match(/^\[(.+)\]$/); if (s) { section = s[1]; continue; }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/); if (!kv) continue;
    if (section === 'versions') { versions[kv[1]] = unquote(kv[2].replace(/^\{\s*strictly\s*=\s*/, '').replace(/\}$/, '')); continue; }
    if (section !== 'libraries') continue;
    const v = kv[2];
    const module = v.match(/module\s*=\s*"([^"]+)"/)?.[1]
      || (v.match(/group\s*=\s*"([^"]+)"/) && v.match(/name\s*=\s*"([^"]+)"/) ? `${v.match(/group\s*=\s*"([^"]+)"/)[1]}:${v.match(/name\s*=\s*"([^"]+)"/)[1]}` : null)
      || (v.startsWith('"') ? unquote(v).split(':').slice(0, 2).join(':') : null);
    const ref = v.match(/version\.ref\s*=\s*"([^"]+)"/)?.[1] || null;
    const version = v.match(/(?:^|[\s{,])version\s*=\s*"([^"]+)"/)?.[1] || (v.startsWith('"') ? unquote(v).split(':')[2] || null : null);
    if (module) libraries.push({ key: kv[1], module, ref, version });
  }
  return { versions, libraries };
}

/** The dependency versions a master commit changes: [{module, from, to}]. */
export function upgradesIn(repo, master) {
  const before = g.git(repo, ['show', `${master}^:${TOML}`], { allowFail: true });
  const after = g.git(repo, ['show', `${master}:${TOML}`], { allowFail: true });
  if (!before.ok || !after.ok || before.out === after.out) return [];
  const a = parseCatalog(before.out); const b = parseCatalog(after.out);
  const ver = (cat, lib) => (lib.ref ? cat.versions[lib.ref] : lib.version);
  const out = [];
  for (const lib of b.libraries) {
    const old = a.libraries.find((x) => x.module === lib.module);
    const from = old ? ver(a, old) : null; const to = ver(b, lib);
    if (to && from && from !== to) out.push({ module: lib.module, from, to });
  }
  return out;
}

function poms(dir) {
  const r = g.git(dir, ['ls-files', '*pom.xml'], { allowFail: true });
  return (r.out || '').split('\n').filter((f) => f && f.endsWith('pom.xml'));
}

/** The versions the branch's Maven build declares for group:artifact: [{file, version}] (properties resolved). */
export function mavenVersions(dir, module) {
  const [group, artifact] = module.split(':');
  const files = poms(dir); const props = {}; const hits = [];
  const texts = files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [, t] of texts) {
    const block = t.match(/<properties>([\s\S]*?)<\/properties>/g) || [];
    for (const b of block) for (const m of b.matchAll(/<([\w.-]+)>\s*([^<\s]+)\s*<\/\1>/g)) props[m[1]] ??= m[2];
  }
  const resolve = (v) => { for (let i = 0; i < 5 && /\$\{([^}]+)\}/.test(v); i++) v = v.replace(/\$\{([^}]+)\}/g, (_, p) => props[p] ?? `\${${p}}`); return v; };
  for (const [f, t] of texts) {
    for (const m of t.matchAll(/<(dependency|plugin)>([\s\S]*?)<\/\1>/g)) {
      const body = m[2];
      if (!new RegExp(`<artifactId>\\s*${artifact.replace(/[.]/g, '\\.')}\\s*</artifactId>`).test(body)) continue;
      const gid = body.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/)?.[1];
      if (gid && resolve(gid) !== group) continue;
      const v = body.match(/<version>\s*([^<\s]+)\s*<\/version>/)?.[1];
      if (v) hits.push({ file: f, version: resolve(v), declared: v });
    }
  }
  return hits;
}

/** LICENSE files of the distributions that list a jar of group:artifact, with the versions they name. */
export function licenseVersions(dir, module) {
  const [group, artifact] = module.split(':');
  const r = g.git(dir, ['ls-files', 'distribution/*LICENSE*'], { allowFail: true });
  const out = [];
  const re = new RegExp(`${group.replace(/[.]/g, '\\.')}-${artifact.replace(/[.]/g, '\\.')}-(\\d[\\w.\\-]*?)\\.jar`, 'g');
  for (const f of (r.out || '').split('\n').filter(Boolean)) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of t.matchAll(re)) out.push({ file: f, version: m[1] });
  }
  return out;
}

/**
 * Check one pick at the worktree's HEAD. Returns {ok, checks: [...], problems: [...]}; a dependency that the
 * branch's Maven build does not declare at all is reported (`unmanaged`) but does not fail.
 */
export function intentCheck({ repo, master, dir }) {
  const checks = []; const problems = [];
  for (const u of upgradesIn(repo, master)) {
    const maven = mavenVersions(dir, u.module);
    const lic = licenseVersions(dir, u.module);
    const c = { ...u, maven, license: lic };
    if (!maven.length) c.unmanaged = true;
    const behind = maven.filter((x) => !/\$\{/.test(x.version) && compareVersions(x.version, u.to) < 0);
    const licBehind = lic.filter((x) => compareVersions(x.version, u.to) < 0);
    for (const x of behind) problems.push(`${u.module} is ${x.version} in ${x.file}; the master commit upgrades it ${u.from} → ${u.to} (in ${TOML}), so the Maven build must use ${u.to}`);
    for (const x of licBehind) problems.push(`${x.file} lists ${u.module} ${x.version}; it must name the ${u.to} jar`);
    checks.push(c);
  }
  return { ok: !problems.length, checks, problems };
}
