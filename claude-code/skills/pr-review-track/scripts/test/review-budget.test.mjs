import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the real planner with local usage fixtures, without account access.
function runPlan(t, usage, json = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(new URL('../review-budget.sh', import.meta.url), path.join(dir, 'review-budget.sh'));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usage));
  fs.writeFileSync(path.join(dir, 'codex-usage.sh'), '#!/bin/sh\ncat "$(dirname "$0")/usage.json"\n', { mode: 0o755 });
  const result = spawnSync('bash', [path.join(dir, 'review-budget.sh'), '--codex-only', ...(json ? ['--json'] : [])], { encoding: 'utf8' });
  assert.equal(result.stderr, '');
  return result;
}

const solHigh = { model: 'gpt-6.1-sol', effort: 'high' };
for (const [percent, budget, thoughtful] of [
  [10, 'rich', { model: 'gpt-6-astra', effort: 'xhigh' }],
  [60, 'normal', { model: 'gpt-6-astra', effort: 'high' }],
  [80, 'tight', solHigh],
  [95, 'critical', solHigh],
]) {
  test(`${budget}: first scan and lightweight work keep their defaults`, (t) => {
    // A completed window makes raw utilization determine the tier.
    const result = runPlan(t, { primary: { windowDurationMins: 300, usedPercent: percent, resetsAt: Math.floor(Date.now() / 1000) } });
    assert.equal(result.status, budget === 'critical' ? 4 : 0);
    const plan = JSON.parse(result.stdout).codex;
    assert.equal(plan.budget, budget);
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.firstScan, solHigh);
    assert.deepEqual(plan.thoughtful, thoughtful);
    assert.deepEqual(plan.simple, { model: 'gpt-6.1-sol', effort: 'low' });
  });
}

test('a reached spend control remains blocked despite cheaper defaults', (t) => {
  const result = runPlan(t, { spendControlReached: true });
  assert.equal(result.status, 4);
  const plan = JSON.parse(result.stdout).codex;
  assert.equal(plan.blocked, true);
  assert.equal(plan.budget, 'critical');
  assert.deepEqual(plan.thoughtful, solHigh);
});

test('text output exposes the first-scan pair', (t) => {
  const result = runPlan(t, {}, false);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /first scan: gpt-6\.1-sol --effort high/);
  assert.match(result.stdout, /simple: +gpt-6\.1-sol --effort low/);
});
