#!/usr/bin/env node
// A stand-in for the `gh` CLI, so the transaction machine can be tested without
// touching GitHub.
//
// Every critical defect this skill has had lived in submit.mjs — capture,
// preflight, execute, recover — and none of it is reachable from a pure unit
// test, because all of it is defined by what happens around a network call that
// fails at the wrong moment. This process makes those moments reproducible: it
// replays canned responses, records every call, and can be told to die
// mid-request.
//
// Driven by $PRT_FAKE_GH pointing at a JSON scenario:
//
// {
//   "callLog": "/tmp/calls.jsonl",
//   "rules": [
//     { "when": { "args": ["graphql"], "body": "viewer" },
//       "stdout": "{\"data\":{\"viewer\":{\"login\":\"me\"}}}" },
//     { "when": { "args": ["--method", "POST"], "arg": "pulls/1/reviews" },
//       "stdout": "{\"id\":1,\"state\":\"COMMENTED\",\"html_url\":\"u\"}",
//       "once": true },
//     { "when": { "arg": "pulls/1/reviews" }, "die": true }
//   ]
// }
//
// Rules are matched in order; `once` retires a rule after it fires. `die`
// exits without output, simulating a killed process (the ambiguous case).
// An unmatched call exits 1 with a message naming what was asked for, so a
// missing rule fails loudly rather than silently returning nothing.

import fs from 'node:fs';

const scenarioPath = process.env.PRT_FAKE_GH;
if (!scenarioPath) {
  process.stderr.write('fake-gh: PRT_FAKE_GH is not set\n');
  process.exit(64);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const args = process.argv.slice(2);

let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

const joined = args.join(' ');

function matches(when) {
  if (!when) return true;
  if (when.args && !when.args.every((a) => args.includes(a))) return false;
  if (when.arg && !joined.includes(when.arg)) return false;
  if (when.body && !`${joined}\n${stdin}`.includes(when.body)) return false;
  if (when.notBody && `${joined}\n${stdin}`.includes(when.notBody)) return false;
  return true;
}

// Record the call before acting on it: a test asserting "this was never posted"
// needs the log to be written even when the process is about to die.
if (scenario.callLog) {
  fs.appendFileSync(
    scenario.callLog,
    `${JSON.stringify({ args, stdin: stdin || null, at: new Date().toISOString() })}\n`,
  );
}

const fired = JSON.parse(process.env.PRT_FAKE_GH_FIRED ?? '[]');
const firedPath = `${scenarioPath}.fired`;
let already = [];
try {
  already = JSON.parse(fs.readFileSync(firedPath, 'utf8'));
} catch {
  already = fired;
}

for (let i = 0; i < scenario.rules.length; i++) {
  const rule = scenario.rules[i];
  if (rule.once && already.includes(i)) continue;
  if (!matches(rule.when)) continue;

  if (rule.once) {
    already.push(i);
    fs.writeFileSync(firedPath, JSON.stringify(already));
  }
  if (rule.die) process.exit(137); // as if SIGKILLed mid-request
  if (rule.stderr) process.stderr.write(rule.stderr);
  if (rule.stdout) process.stdout.write(rule.stdout);
  process.exit(rule.exit ?? 0);
}

process.stderr.write(`fake-gh: no rule matched: gh ${joined}\n`);
process.exit(1);
