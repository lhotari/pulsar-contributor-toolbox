// Deterministic security pre-scan of a PR diff. It runs before any model reads the PR and before any
// checkout exists, so a PR built to infect the reviewer's machine is red-flagged without anything from it
// being executed. It is a tripwire, not a verdict: "scanned" still needs the model's gate (pr-review's
// critical security gate) before a worker may build or run tests, and "flagged" blocks execution until
// the human looks at the evidence and decides.

// Files whose change alters what runs on the reviewer's machine during a build or a test run.
const SURFACES = [
  [/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|.*\.gradle(\.kts)?)$/, 'build script'],
  [/(^|\/)(gradlew(\.bat)?|mvnw(\.cmd)?)$|(^|\/)gradle\/wrapper\/|(^|\/)\.mvn\//, 'build wrapper'],
  [/(^|\/)buildSrc\/|(^|\/)build-logic\/|(^|\/)gradle\/.*\.versions\.toml$|(^|\/)libs\.versions\.toml$/, 'build logic / version catalog'],
  [/^\.github\/(workflows|actions)\//, 'CI workflow'],
  [/(^|\/)(Makefile|CMakeLists\.txt|.*\.cmake|configure(\.ac)?|meson\.build|BUILD(\.bazel)?|WORKSPACE)$/, 'native build'],
  [/(^|\/)(package\.json|\.npmrc|yarn\.lock|pnpm-lock\.yaml|package-lock\.json)$/, 'npm package'],
  [/(^|\/)(setup\.py|setup\.cfg|pyproject\.toml|conftest\.py|tox\.ini|requirements[^/]*\.txt|Pipfile)$/, 'python package/test hook'],
  [/(^|\/)(go\.mod|go\.sum|Cargo\.toml|build\.rs)$/, 'go/rust build'],
  [/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.dockerignore)$/, 'container build'],
  [/\.(sh|bash|zsh|ps1|bat|cmd|command)$/, 'shell script'],
  [/(^|\/)\.(git(attributes|modules|config)|husky\/|pre-commit-config\.yaml|envrc|tool-versions)/, 'repo hook/config'],
  [/(^|\/)\.(idea|vscode)\//, 'IDE config (can run tasks)'],
  [/(^|\/)src\/test\/resources\/.*\.(sh|py|jar|so|dylib|dll|exe)$/, 'executable test resource'],
];

const BINARY_EXT = /\.(jar|war|class|so|dylib|dll|exe|bin|node|wasm|pyc|zip|tar|tgz|gz|7z|rar)$/i;

// Bidi controls, zero-width characters, line/paragraph separators, BOM and soft hyphen (built from code
// points so this file itself stays plain ASCII).
const HIDDEN_UNICODE = new RegExp(`[${[[0x202a, 0x202e], [0x2066, 0x2069], [0x200b, 0x200f], [0x2028, 0x2029], [0xfeff, 0xfeff], [0xad, 0xad]]
  .map(([a, b]) => (a === b ? `\\u${a.toString(16).padStart(4, '0')}` : `\\u${a.toString(16).padStart(4, '0')}-\\u${b.toString(16).padStart(4, '0')}`)).join('')}]`);

// Patterns in ADDED lines. high → flagged (blocks execution), medium → reported with the surface.
const PATTERNS = [
  ['high', 'download piped to a shell', /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i],
  ['high', 'reverse shell shape', /\/dev\/tcp\/|\bnc\b[^\n]*\s-e\s|\bbash\s+-i\b|\bmkfifo\b[^\n]*\bnc\b|socat\b[^\n]*exec:/i],
  ['high', 'decode-and-execute', /base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|\beval\s*\(\s*(atob|Buffer\.from|base64|decode)|exec\s*\(\s*(base64|codecs|zlib)\.|FromBase64String[^\n]*Invoke-Expression|\bIEX\b/i],
  ['high', 'credential or key material access', /~\/\.(ssh|aws|gnupg|docker\/config|kube\/config|netrc|npmrc|pypirc|m2\/settings|gradle\/gradle\.properties)|\bid_(rsa|ed25519|ecdsa)\b|\.git-credentials|aws_secret_access_key|\bkeychain\b[^\n]*\b(find|dump)-/i],
  ['high', 'crypto miner', /stratum\+tcp|\bxmrig\b|\bminerd\b|cryptonight/i],
  ['high', 'CI secret exfiltration shape', /\$\{\{\s*secrets\.[^}]+\}\}[^\n]*\b(curl|wget|nc)\b|\bpull_request_target\b|ACTIONS_(RUNTIME|ID)_TOKEN|GITHUB_TOKEN[^\n]*\b(curl|wget|base64)\b/i],
  ['high', 'hidden or bidirectional unicode (Trojan Source)', HIDDEN_UNICODE],
  ['high', 'persistence', /\bcrontab\b|\blaunchctl\b|LaunchAgents|\.bashrc|\.zshrc|\.profile\b|systemctl\s+enable|autostart/i],
  ['high', 'destructive command', /\brm\s+-rf\s+(\/|~|\$HOME|\$\{?HOME)|\bmkfs\.|\bdd\s+if=[^\n]*of=\/dev\//i],
  ['medium', 'runs a process', /\bRuntime\.getRuntime\(\)\.exec\b|\bnew\s+ProcessBuilder\b|\bchild_process\b|\bsubprocess\.(Popen|run|call)|\bos\.system\(|\bexec\s*\{|commandLine\s*[(=]|<exec\b|maven-antrun-plugin|exec-maven-plugin/],
  ['medium', 'downloads at build or test time', /\b(curl|wget)\s+(-[a-zA-Z]+\s+)*https?:\/\/|new\s+URL\([^)]*\)\.(openStream|openConnection)|download\s*\{|\bsrc\(\s*['"]https?:/],
  ['medium', 'new artifact repository', /<repository>|maven\s*\{\s*url|mavenCentral\(\)\s*\}?\s*maven|repositories\s*\{[^\n]*https?:|--index-url|--extra-index-url|registry\s*=\s*https?:/],
  ['medium', 'wrapper distribution URL', /distributionUrl\s*=|wrapperUrl\s*=/],
  ['medium', 'chmod +x', /\bchmod\s+(\+x|[0-7]*7[0-7]{2})\b/],
  ['medium', 'environment or secret access', /System\.getenv\(\s*\)|process\.env\b(?!\.[A-Z_]+\b)|os\.environ\b(?!\[)|\bprintenv\b|\benv\s*\|/],
  ['medium', 'package install hook', /"(preinstall|postinstall|prepare|install)"\s*:|cmdclass\s*=/],
];

const LONG_BLOB = /[A-Za-z0-9+/]{240,}={0,2}|\b[0-9a-fA-F]{400,}\b/;

/**
 * @param files parsed diff (prt parseDiff Map)
 * @returns {{level:'none'|'surface'|'flagged', surfaces:[{path,why}], hits:[{severity,rule,path,line,text}], stats}}
 */
export function scanDiff(files) {
  const surfaces = [];
  const hits = [];
  let added = 0;
  for (const f of files.values()) {
    const p = f.path;
    for (const [re, why] of SURFACES) if (re.test(p)) { surfaces.push({ path: p, why }); break; }
    if (f.binary || BINARY_EXT.test(p)) {
      const sev = f.status === 'deleted' ? null : BINARY_EXT.test(p) ? 'high' : 'medium';
      if (sev) hits.push({ severity: sev, rule: `binary file ${f.status}`, path: p, line: null, text: '' });
    }
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind !== '+') continue;
        added++;
        const text = l.text;
        for (const [severity, rule, re] of PATTERNS) {
          if (re.test(text)) hits.push({ severity, rule, path: p, line: l.newNo, text: text.trim().slice(0, 240) });
        }
        if (LONG_BLOB.test(text) && !/\.(lock|sum|svg|json|txt|md|csv|pem|crt)$/i.test(p)) {
          hits.push({ severity: 'medium', rule: 'long encoded blob', path: p, line: l.newNo, text: `${text.trim().slice(0, 80)}…` });
        }
        if (text.length > 1500 && !/\.(json|svg|lock|txt|csv|md)$/i.test(p)) {
          hits.push({ severity: 'medium', rule: 'very long line (minified or obfuscated?)', path: p, line: l.newNo, text: `${text.length} chars` });
        }
      }
    }
  }
  // A medium hit inside an execution surface is the classic shape: a build or CI change that runs or
  // downloads something. Promote it.
  const surfacePaths = new Set(surfaces.map((s) => s.path));
  for (const h of hits) {
    if (h.severity === 'medium' && surfacePaths.has(h.path)
        && /runs a process|downloads|repository|wrapper distribution|install hook|chmod|encoded blob/.test(h.rule)) {
      h.severity = 'high'; h.rule += ' in an execution surface';
    }
  }
  // Long lists are noise: keep the first few per rule.
  const perRule = new Map();
  const kept = hits.filter((h) => { const n = (perRule.get(h.rule) || 0) + 1; perRule.set(h.rule, n); return n <= 5; });
  const level = kept.some((h) => h.severity === 'high') ? 'flagged' : surfaces.length || kept.length ? 'surface' : 'none';
  return { level, surfaces, hits: kept, stats: { files: files.size, added, hitCount: hits.length } };
}

/** One line for lists. */
export function scanSummary(scan) {
  if (!scan) return 'not scanned';
  if (scan.level === 'unavailable') return `not scanned: ${scan.error}`;
  if (scan.level === 'none') return 'no execution surfaces changed';
  const high = scan.hits.filter((h) => h.severity === 'high');
  if (high.length) return `FLAGGED: ${[...new Set(high.map((h) => h.rule))].join('; ')}`;
  return `changes ${[...new Set(scan.surfaces.map((s) => s.why))].join(', ') || 'nothing executable'}${scan.hits.length ? `; ${scan.hits.length} note(s)` : ''}`;
}
