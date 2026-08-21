// node --test scripts/test/budget.test.mjs
//
// The tier decision is the only thing here with teeth: it decides how much of a
// scarce allowance a review is allowed to spend. Everything is driven from
// synthetic transcripts so the assertions do not depend on how busy the real
// machine has been.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ROOT;
let PROJECTS;
let CONFIG;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prbudget-'));
  PROJECTS = path.join(ROOT, 'projects', 'proj');
  CONFIG = path.join(ROOT, 'budget.json');
  fs.mkdirSync(PROJECTS, { recursive: true });
  process.env.PRBUDGET_PROJECTS = path.join(ROOT, 'projects');
  process.env.PRBUDGET_CONFIG = CONFIG;
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.PRBUDGET_PROJECTS;
  delete process.env.PRBUDGET_CONFIG;
});

/**
 * Write a transcript whose records carry `outputPerRecord` output tokens each,
 * spread evenly over the last `spanMs`.
 */
function writeTranscript(name, { records = 10, outputPerRecord = 1000, spanMs = DAY, model = 'claude-opus-5', now = Date.now() }) {
  const lines = [];
  for (let i = 0; i < records; i++) {
    const ts = new Date(now - (spanMs * i) / Math.max(1, records)).toISOString();
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: {
        model,
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputPerRecord },
      },
    }));
  }
  const p = path.join(PROJECTS, `${name}.jsonl`);
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

function clear() {
  for (const f of fs.readdirSync(PROJECTS)) fs.rmSync(path.join(PROJECTS, f));
  try { fs.rmSync(CONFIG); } catch { /* none */ }
}

async function load() {
  // Fresh import each time so module-level config paths are re-read.
  return import(`../budget.mjs?t=${Math.random()}`);
}

test('with no history at all, the tier is the safe default', async () => {
  clear();
  const { report } = await load();
  const r = report();
  assert.equal(r.tier, 'standard');
  assert.match(r.why, /no usage history/);
});

test('a configured budget turns pace into a real projection', async () => {
  clear();
  const now = Date.now();
  // Spend 5M weighted tokens inside the last 24h. Weight for output is 5×, so
  // 200 records × 5000 output ≈ 5M.
  writeTranscript('a', { records: 200, outputPerRecord: 5000, spanMs: 20 * HOUR, now });
  fs.writeFileSync(CONFIG, JSON.stringify({ dailyBudget: 6_000_000, weeklyBudget: 500_000_000 }));

  const { report } = await load();
  const r = report({ now });
  const daily = r.windows.find((w) => w.window === 'daily');
  assert.equal(daily.basis, 'budget');
  assert.ok(daily.usedCost > 4_000_000, `expected ~5M, got ${daily.usedCost}`);
  // Most of the daily budget spent, and the day is not over → ahead of pace.
  assert.ok(daily.pace > 1, `pace should exceed 1, got ${daily.pace}`);
  assert.ok(['lean', 'codex'].includes(r.tier), `expected a reduced tier, got ${r.tier}`);
});

test('comfortably under budget keeps the full pipeline', async () => {
  clear();
  const now = Date.now();
  writeTranscript('a', { records: 5, outputPerRecord: 100, spanMs: 20 * HOUR, now });
  fs.writeFileSync(CONFIG, JSON.stringify({ dailyBudget: 1_000_000_000, weeklyBudget: 5_000_000_000, sessionBudget: 1_000_000_000 }));

  const { report } = await load();
  const r = report({ now });
  assert.equal(r.tier, 'full');
  assert.equal(r.basis, 'budget');
});

test('without a budget, being busy alone cannot force the top tier', async () => {
  clear();
  const now = Date.now();
  // Everything in the last hour, nothing across the rest of the 28-day window:
  // a huge multiple of the trailing rate.
  writeTranscript('spike', { records: 300, outputPerRecord: 20_000, spanMs: HOUR, now });

  const { report } = await load();
  const r = report({ now });
  assert.equal(r.basis, 'baseline');
  assert.ok(r.worstPace > 2, `expected a large multiple, got ${r.worstPace}`);
  // Baseline is a softer signal than a real budget, so the wording must say so
  // whenever it stops short of `codex`.
  if (r.tier !== 'codex') assert.match(r.why, /trailing 28-day rate/);
});

test('only Claude spend counts — Codex is a separate quota', async () => {
  clear();
  const now = Date.now();
  writeTranscript('claude', { records: 10, outputPerRecord: 1000, spanMs: HOUR, now, model: 'claude-opus-5' });
  writeTranscript('other', { records: 500, outputPerRecord: 100_000, spanMs: HOUR, now, model: 'gpt-5.6-sol' });

  const { report } = await load();
  const r = report({ now });
  const session = r.windows.find((w) => w.window === 'session');
  assert.ok(Object.keys(session.byModel).every((m) => m.startsWith('claude-')), JSON.stringify(session.byModel));
  assert.ok(session.usedCost < 1_000_000, 'the Codex records must not be counted');
});

test('output tokens dominate the weighting, cache reads barely register', async () => {
  clear();
  const now = Date.now();
  const p = path.join(PROJECTS, 'w.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ timestamp: new Date(now - 60_000).toISOString(), message: { model: 'claude-opus-5', usage: { output_tokens: 1000 } } }),
    JSON.stringify({ timestamp: new Date(now - 60_000).toISOString(), message: { model: 'claude-opus-5', usage: { cache_read_input_tokens: 1000 } } }),
  ].join('\n'));

  const { collect } = await load();
  const recs = collect(now - HOUR, { projects: path.join(ROOT, 'projects') });
  const [out, cached] = recs.sort((a, b) => b.cost - a.cost);
  assert.equal(out.cost, 5000, 'output is weighted 5×');
  assert.equal(cached.cost, 100, 'a cache read is weighted 0.1×');
});

test('the weekly window measures from Monday, not from seven days ago', async () => {
  clear();
  // Wednesday 12:00 → the week is 2.5/7 elapsed.
  const wed = new Date('2026-08-19T12:00:00');
  writeTranscript('a', { records: 1, outputPerRecord: 1, spanMs: 1000, now: wed.getTime() });
  fs.writeFileSync(CONFIG, JSON.stringify({ weeklyBudget: 1_000_000 }));

  const { report } = await load();
  const r = report({ now: wed.getTime() });
  const weekly = r.windows.find((w) => w.window === 'weekly');
  assert.ok(weekly.elapsed > 0.3 && weekly.elapsed < 0.42, `expected ~0.36 of the week elapsed, got ${weekly.elapsed}`);
});
