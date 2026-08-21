#!/usr/bin/env node
// budget — how hard am I allowed to think right now?
//
// Claude Code does not expose its subscription limits to a script, but it does
// leave a complete accounting of what was spent: every assistant message in
// ~/.claude/projects/**/*.jsonl carries a `usage` block, a `timestamp` and a
// `model`. That is enough to answer the question that actually matters — am I
// burning faster than the window can carry? — by the method the limits
// themselves imply: assume the allowance is meant to be spent evenly across the
// window, and compare where I am against where the clock is.
//
//   pace = (fraction of the budget already spent) / (fraction of the window elapsed)
//
// pace 1.0 means dead on schedule. 1.5 means I will run out at two thirds of the
// week. The review pipeline reads that number and decides how much Claude to
// spend versus how much to hand to Codex, whose quota is separate.
//
//   node budget.mjs               human-readable report
//   node budget.mjs --json        machine-readable, for a skill to route on
//   node budget.mjs --no-cache    force a rescan (results are cached 60s)
//   node budget.mjs --set-weekly 2000M --set-daily 400M
//
// Exit code is 0 normally, 3 when the tier is `codex` — so a shell caller can
// branch without parsing anything.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS = process.env.PRBUDGET_PROJECTS || path.join(HOME, '.claude', 'projects');
const CONFIG = process.env.PRBUDGET_CONFIG || path.join(HOME, '.claude', 'pr-review', 'budget.json');
// Scanning a week of transcripts costs a few seconds. A batch of ten reviews
// asking the same question ten times would spend a minute learning nothing new.
const CACHE = path.join(path.dirname(CONFIG), 'budget-cache.json');
const CACHE_TTL_MS = 60_000;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Windows the subscription actually meters on. The 5-hour session window is the
 * one that bites first and recovers fastest; the weekly one is the one that
 * ruins a Thursday.
 */
const WINDOWS = [
  { key: 'session', label: '5h', ms: 5 * HOUR, budgetKey: 'sessionBudget' },
  { key: 'daily', label: '24h', ms: DAY, budgetKey: 'dailyBudget' },
  { key: 'weekly', label: '7d', ms: 7 * DAY, budgetKey: 'weeklyBudget' },
];

/**
 * Not all tokens cost the same. This mirrors the usual pricing shape — output
 * is the expensive one, a cache read is nearly free — so that "weighted tokens"
 * tracks what a limit actually meters rather than raw volume. It is an
 * approximation, and it only ever has to be good enough to rank pace.
 */
const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

const DEFAULT_CONFIG = {
  // null = unknown. With no budget set, pacing falls back to comparing against
  // this user's own trailing 28-day baseline, which answers "is today unusual?"
  // rather than "will I run out" — useful, but say which one you are looking at.
  sessionBudget: null,
  dailyBudget: null,
  weeklyBudget: null,
  // Pace at which each tier takes over. Tuned so that `standard` is the normal
  // state and `lean` starts before the wall, not at it.
  thresholds: { standard: 0.9, lean: 1.15, codex: 1.6 },
  // Models whose spend counts against the Claude allowance.
  countModels: ['claude-'],
};

function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    } catch (e) {
      process.stderr.write(`[budget] ignoring unreadable ${CONFIG}: ${e.message}\n`);
    }
  }
  return { ...DEFAULT_CONFIG, ...user, thresholds: { ...DEFAULT_CONFIG.thresholds, ...(user.thresholds ?? {}) } };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Accept 2000M / 1.5B / 750000 as a token count. */
export function parseTokens(s) {
  const m = /^([\d.]+)\s*([kmb])?$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a token count: ${s}`);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

function fmt(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

function weighted(u) {
  return (
    (u.input_tokens ?? 0) * WEIGHTS.input +
    (u.cache_creation_input_tokens ?? 0) * WEIGHTS.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * WEIGHTS.cacheRead +
    (u.output_tokens ?? 0) * WEIGHTS.output
  );
}

/**
 * Read every usage record newer than `sinceMs`. Only files whose mtime is in
 * range are opened — with ~900 transcripts a week that is the difference
 * between two seconds and a minute.
 */
export function collect(sinceMs, { projects = PROJECTS, countModels = ['claude-'] } = {}) {
  const records = [];
  if (!fs.existsSync(projects)) return records;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs >= sinceMs) files.push(p);
      }
    }
  };
  const files = [];
  walk(projects);

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      // Cheap reject before the expensive parse: most lines are not assistant
      // messages, and JSON.parse over a million of them is the whole runtime.
      if (line.length < 40 || !line.includes('"usage"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage;
      const ts = rec?.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (!u || !Number.isFinite(ts) || ts < sinceMs) continue;
      const model = rec.message.model ?? 'unknown';
      if (!countModels.some((p) => model.startsWith(p))) continue;
      records.push({ ts, model, cost: weighted(u), output: u.output_tokens ?? 0 });
    }
  }
  return records;
}

function sumSince(records, from) {
  let cost = 0;
  let output = 0;
  let n = 0;
  const byModel = {};
  for (const r of records) {
    if (r.ts < from) continue;
    cost += r.cost;
    output += r.output;
    n += 1;
    byModel[r.model] = (byModel[r.model] ?? 0) + r.cost;
  }
  return { cost, output, requests: n, byModel };
}

/**
 * The window's own elapsed fraction. A rolling window is always "full", so the
 * meaningful clock is the calendar one the allowance resets on: how far into
 * today, or into the week, are we?
 */
function elapsedFraction(windowKey, now) {
  const d = new Date(now);
  if (windowKey === 'session') {
    // The 5-hour window rolls continuously; treat it as always fully elapsed,
    // which makes pace equal "share of the allowance already spent".
    return 1;
  }
  if (windowKey === 'daily') {
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    return Math.max(0.02, (now - start.getTime()) / DAY);
  }
  // Weekly: reset on Monday 00:00 local.
  const start = new Date(d);
  const dow = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - dow);
  start.setHours(0, 0, 0, 0);
  return Math.max(0.02, (now - start.getTime()) / (7 * DAY));
}

/** Cached report, so a batch of reviews pays the scan once. */
export function cachedReport({ maxAgeMs = CACHE_TTL_MS, config = loadConfig() } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - Date.parse(c.now) < maxAgeMs) return { ...c, cached: true };
  } catch { /* no usable cache */ }
  const r = report({ config });
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(r));
  } catch { /* a cache we cannot write is not an error */ }
  return { ...r, cached: false };
}

export function report({ now = Date.now(), config = loadConfig() } = {}) {
  // 28 days of history so the no-budget fallback has a baseline to compare to.
  const baselineDays = 28;
  const records = collect(now - baselineDays * DAY, { countModels: config.countModels });

  const rows = [];
  for (const w of WINDOWS) {
    const used = sumSince(records, now - w.ms);
    const budget = config[w.budgetKey];
    const elapsed = elapsedFraction(w.key, now);

    let pace = null;
    let basis = 'none';
    let projected = null;

    if (budget) {
      const spentFraction = used.cost / budget;
      pace = spentFraction / elapsed;
      projected = elapsed > 0 ? used.cost / elapsed : null;
      basis = 'budget';
    } else {
      // No configured limit: compare this window against the same length of
      // time averaged over the trailing 28 days. This answers "am I unusually
      // hot right now", which is a weaker claim than "I will run out" — the
      // report labels it so nobody mistakes one for the other.
      const all = sumSince(records, now - baselineDays * DAY).cost;
      const typical = (all / (baselineDays * DAY)) * w.ms;
      if (typical > 0) {
        pace = used.cost / typical;
        basis = 'baseline';
      }
    }

    rows.push({
      window: w.key,
      label: w.label,
      windowMs: w.ms,
      elapsed,
      budget,
      basis,
      usedCost: Math.round(used.cost),
      usedOutput: used.output,
      requests: used.requests,
      byModel: Object.fromEntries(Object.entries(used.byModel).map(([k, v]) => [k, Math.round(v)])),
      pace: pace === null ? null : Number(pace.toFixed(2)),
      projected: projected === null ? null : Math.round(projected),
    });
  }

  const paces = rows.map((r) => r.pace).filter((p) => p !== null);
  const worst = paces.length ? Math.max(...paces) : null;
  const anyBudget = rows.some((r) => r.basis === 'budget');

  const t = config.thresholds;
  let tier;
  let why;
  if (worst === null) {
    tier = 'standard';
    why = 'no usage history to judge from — using the default tier';
  } else if (!anyBudget) {
    // Baseline mode is a softer signal: being busier than usual is not the same
    // as being about to run out. So it takes a much larger multiple to reach the
    // top tier than a real budget would.
    if (worst >= t.codex * 2) {
      tier = 'codex';
      why = `burning ${worst}× the trailing 28-day rate — far outside normal, treat Claude as scarce`;
    } else if (worst >= t.codex) {
      tier = 'lean';
      why = `burning ${worst}× the trailing 28-day rate (no budget configured, so this alone cannot justify more than lean)`;
    } else if (worst >= t.lean) {
      tier = 'standard';
      why = `burning ${worst}× the trailing 28-day rate`;
    } else {
      tier = 'full';
      why = `running at ${worst}× the trailing 28-day rate`;
    }
  } else if (worst >= t.codex) {
    tier = 'codex';
    why = `pace ${worst}× — the allowance runs out at ${Math.round((1 / worst) * 100)}% of the window`;
  } else if (worst >= t.lean) {
    tier = 'lean';
    why = `pace ${worst}× — ahead of schedule, trim Claude usage`;
  } else if (worst >= t.standard) {
    tier = 'standard';
    why = `pace ${worst}× — roughly on schedule`;
  } else {
    tier = 'full';
    why = `pace ${worst}× — comfortably under`;
  }

  const hottest = rows.reduce((a, b) => ((b.pace ?? -1) > (a.pace ?? -1) ? b : a), rows[0]);

  return { now: new Date(now).toISOString(), tier, why, worstPace: worst, basis: anyBudget ? 'budget' : 'baseline', hottestWindow: hottest?.window ?? null, windows: rows, config: { thresholds: t, sessionBudget: config.sessionBudget, dailyBudget: config.dailyBudget, weeklyBudget: config.weeklyBudget } };
}

const TIER_ADVICE = {
  full: 'Full pipeline: Fable and Codex review independently, both cross-validate.',
  standard: 'Fable and Codex review independently; Codex alone cross-validates.',
  lean: 'Codex reviews; Opus adjudicates inline. No Fable subagent, no second round.',
  codex: 'Codex does the reviewing and the refuting. Opus only adjudicates, on a trimmed brief.',
};

function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();

  for (const [flag, key] of [['--set-weekly', 'weeklyBudget'], ['--set-daily', 'dailyBudget'], ['--set-session', 'sessionBudget']]) {
    const i = args.indexOf(flag);
    if (i !== -1) {
      const v = args[i + 1];
      cfg[key] = v === 'none' || v === 'null' ? null : parseTokens(v);
      saveConfig(cfg);
      process.stdout.write(`${key} = ${cfg[key] === null ? 'unset' : fmt(cfg[key])} (weighted tokens)\n  ${CONFIG}\n`);
      return;
    }
  }

  const r = args.includes('--no-cache') ? report({ config: cfg }) : cachedReport({ config: cfg });

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    process.stdout.write(`window  elapsed   spent      pace   basis\n`);
    for (const w of r.windows) {
      const pace = w.pace === null ? '   —' : `${w.pace.toFixed(2)}×`;
      const flag = w.pace !== null && w.pace >= cfg.thresholds.lean ? '  ← ahead of pace' : '';
      process.stdout.write(
        `${pad(w.label, 7)} ${pad(`${Math.round(w.elapsed * 100)}%`, 9)} ${pad(fmt(w.usedCost), 10)} ${pad(pace, 6)} ${w.basis}${flag}\n`,
      );
    }
    process.stdout.write(`\ntier: ${r.tier.toUpperCase()} — ${r.why}\n`);
    process.stdout.write(`${TIER_ADVICE[r.tier]}\n`);
    if (r.basis === 'baseline') {
      process.stdout.write(
        `\nNo budget configured, so pace compares against your own trailing 28-day rate.\n` +
          `For real limit-awareness, read the numbers from /usage and set them:\n` +
          `  node budget.mjs --set-weekly 2000M --set-daily 400M\n`,
      );
    }
  }
  if (r.tier === 'codex') process.exitCode = 3;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
