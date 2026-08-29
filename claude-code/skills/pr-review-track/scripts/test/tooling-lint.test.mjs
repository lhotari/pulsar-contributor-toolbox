// node --test scripts/test/tooling-lint.test.mjs
//
// The pipeline-mechanics lint. It reaches GitHub for nothing, so all of it is
// pinned in-process; the one test that proves `preflight` consults it at all
// lives in `submit.test.mjs`.
//
// Three halves have to be pinned together or the suite cannot tell "the lint
// works" from "the lint memorised four sentences":
//
//   1. DISCLOSURE IS LEGAL. Saying that AI assisted, and naming the models, is
//      deliberate practice here and what the ASF Generative Tooling guidance
//      asks for. Every fixture in that test is verbatim text the maintainer has
//      actually posted to apache/pulsar, cited to the comment it came from.
//   2. THE FOUR REAL LEAKS. The passages this session drafted and had to fix.
//      They are the recall floor: rescoping the lint must not lose one.
//   3. ORDINARY PULSAR PROSE. The measured false positives of the bare-word
//      blocklist this lint replaced — tiered storage, SASL rounds, `*Validator`
//      types, "single-pass authentication" — each cited to where it came from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseActionFile } from '../lib/actionfile.mjs';
import { toolingLint } from '../lib/submit.mjs';

const PRT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prt.mjs');

/** An action file with one review body. */
function toolingFile(body, { doc = '', event = 'COMMENT', extra = '' } = {}) {
  return `Status: draft

<!-- prt:doc
repo: apache/pulsar
pr: 1
head: abc123${doc}
-->

<!-- prt:context -->

**Draft produced by:** Codex gpt-5.6-sol (round 1, native reviewer) · Opus (adjudicated) (full-repo)

<!-- /prt -->

<!-- prt:verdict
event: ${event}
-->

<!-- prt:body -->
${body}
<!-- /prt -->
${extra}`;
}

const labels = (text) => toolingLint(parseActionFile(text)).map((h) => h.label).sort();

// ------------------------------------------------------------ 1. disclosure
//
// The lint blocks the pipeline's internal mechanics, NOT the fact that AI ran.
// Every string here was posted to apache/pulsar by the maintainer; an earlier
// version of this lint refused 72 of his comments, and that was the bug.

test('a deliberate AI-assistance disclosure is not a leak', () => {
  const disclosures = [
    // pull/26197#issuecomment-5048315727 — on somebody else's PR, so this is
    // reviewer provenance, the class the old lint called private.
    'I ran an AI-assisted review of this PR (Claude as the local reviewer plus OpenAI Codex `gpt-5.6-sol` as a second independent pass; both sets of findings were cross-verified against the actual sources before posting)',
    'I performed a local review with Claude Code Fable 5 and it found these findings.',
    '<sub>*Assisted-by: Claude (Opus 5).*</sub>',
    '<sub>Prepared with the assistance of Claude Code (Opus 5).</sub>',
    // pull/25822#issuecomment-4500269281
    'These are findings from a local Claude Code review. Please check before merging — they are suggestions, not blockers.',
    // The model name alone, however it is re-embedded. Naming which model ran
    // is disclosure; naming the effort it ran at is mechanics.
    'Run under `gpt-5.6-sol` against a full checkout.',
    'GPT-5.6 flagged this one, and I verified it against ManagedLedgerImpl.',
    'AGENTS.md line 3 lists the assistants; consider adding Windsurf while you are here.',
  ];
  for (const body of disclosures) assert.deepEqual(labels(toolingFile(body)), [], body);
});

// ----------------------------------------------------------- 2. the real leaks
//
// Verbatim from the four drafts this session had to fix. Losing any one of them
// is the regression this file exists to catch.

test('the four real leaks from the live store are each still caught', () => {
  const leaks = {
    'pr-26433': '**Review scope.** Tier `lean` — the caller supplied the tier, it was not measured. That means **one** independent reviewer (Codex `gpt-5.6-sol`, effort `xhigh`) plus a second Codex pass framed to refute, adjudicated in the main session against a full checkout at the PR head (`2a1f44d`). This is *not* the two-model consensus pipeline; every finding below carries its own agreement line.',
    'pr-26434': '*Review depth: this was a single-reviewer pass with an independent adversarial second pass over the same checkout, not a two-model consensus review.*',
    'pr-26422': 'For transparency: this was a Codex-only review (one independent reviewer plus an adversarial second pass, adjudicated here), not the two-model consensus pipeline.',
    'pr-24809': 'One smaller thing I am not raising as a finding, because the two reviewers split on it and I could not substantiate the impact.',
  };
  assert.deepEqual(labels(toolingFile(leaks['pr-26433'])), ['adjudication', 'consensus', 'effort', 'pipeline-shape', 'refutation', 'tier']);
  assert.deepEqual(labels(toolingFile(leaks['pr-26434'])), ['consensus', 'pipeline-shape']);
  assert.deepEqual(labels(toolingFile(leaks['pr-26422'])), ['adjudication', 'consensus', 'pipeline-shape']);
  assert.deepEqual(labels(toolingFile(leaks['pr-24809'])), ['reviewer-split']);
});

test('the other pipeline mechanics the ruling names are caught too', () => {
  // Rounds and roles. `round` and `validator-role` catch none of the four
  // leaks above, so without these they would be untested arms.
  assert.deepEqual(labels(toolingFile('Raised by the round-3 refute pass, then re-derived by hand.')), ['refutation', 'round']);
  assert.deepEqual(labels(toolingFile('Codex gpt-5.6-sol (round 1, native reviewer) read the full checkout.')), ['round']);
  // Real text from pr-25939, which sits in `prt:notes` today — one edit away
  // from being outgoing, which is exactly how this leak travels.
  assert.deepEqual(labels(toolingFile('Mechanism confirmed, but one validator enumerated every production construction of CompletionException at head.')), ['validator-role']);
  assert.deepEqual(labels(toolingFile('Cross-validation round: both passes reached the same conclusion.')), ['refutation']);
});

test('a paraphrased split survives being reworded', () => {
  // The narrow `reviewers? (split|disagreed)` form this replaced caught 3 of
  // these 11; it now catches 10. Each is a paraphrase an adversarial pass
  // produced from the pr-24809 sentence.
  const caught = [
    'the two reviewers split on it',
    'the two reviewers were split on it',
    'the reviewers had split on it',
    'the two reviewers ultimately disagreed',
    'the reviewers, in the end, disagreed',
    'the two reviews split on it',
    'my two reviewers split on it',
    'the reviewer pair split on it',
    'both readers of the diff split on it',
    'the second reviewer disagreed',
  ];
  for (const body of caught) assert.deepEqual(labels(toolingFile(body)), ['reviewer-split'], body);

  // The eleventh is given up knowingly: `passes` is out of the noun set so that
  // pip-483.md's "It runs in two passes — split first (short cooldown)" stays
  // postable. Pinned so the trade is visible rather than forgotten.
  assert.deepEqual(labels(toolingFile('the two passes split on it')), []);
});

// -------------------------------------------------------- 3. ordinary prose
//
// Each of these was a measured false positive of a bare-word blocklist, or is
// live Pulsar text a review of that very file has to be able to quote.

test('ordinary Pulsar prose is not pipeline mechanics', () => {
  const benign = [
    // ARCHITECTURE.md: "organized in dependency tiers (Tier 0 has no internal
    // deps, higher tiers build on lower ones)"; ManagedLedger.java: "2nd tier
    // storage". `\btier\b` alone hits 35 Pulsar paragraphs.
    'This module belongs in Tier 2 in `settings.gradle.kts`, not Tier 4, and the offload path sends it to 2nd tier storage.',
    // 30+ in-tree Java types end in `Validator`; ValidatorImpls.java reads
    // "Each validator in the list of validators must inherit …".
    'The two validators disagree about null here: `NotNullValidator` runs before `PositiveNumberValidator`, and each validator in the list must inherit from `Validator`.',
    // AGENTS.md:29 asks a maintainer to request this trailer FROM THE AUTHOR.
    // Author provenance is public by ASF policy — that is the same disclosure
    // the first test protects, pointed the other way.
    'If this was AI-generated, please add an `Assisted-by:` trailer per the ASF Generative Tooling guidance.',
    // HttpAuthenticationDriverTest.java: "round 0 succeeds (-> 401), round 1's
    // respond throws"; SaslAuthenticationV5HttpTest.java: "Round 1 carried the
    // initial SASL token; round 2 echoed the server id".
    'Round 1 carries the initial SASL token and round 2 echoes the server id, so the 2 rounds of snapshots are unaffected.',
    // pip-478.md, throughout.
    'For single-pass credentials the client attaches `Authorization: <scheme> <credential>` on the first request.',
    // pip-478.md again: "Neither axis is cross-validated against the other".
    'Neither axis is cross-validated against the other, so pinning only `jsseProvider=BCJSSE` is accepted silently.',
    // pip-483.md.
    'It runs in two passes — split first (short cooldown), then merge (long cooldown).',
    // Ordinary prose about human reviewers, and about a second look at code.
    'I would like a second reviewer on the metadata-store change before this merges.',
    'Both reviewers on the earlier PR asked for the same rename.',
    'The second pass only ever sees ledgers registered after the snapshot, so the two passes are not sequenced.',
    // "best effort basis(minimal impact on existing clients)" — pull/24478.
    'When the metadata store is unstable, Pulsar should behave as-is on a best effort basis(minimal impact on existing clients).',
  ];
  for (const body of benign) assert.deepEqual(labels(toolingFile(body)), [], body);
});

// ------------------------------------------------------------- the mechanics

test('the hatch names what it excuses, and a bare yes excuses nothing', () => {
  // One hit the human judges benign and one they do not, in the same file.
  // Acknowledging the first must not silence the second — the failure a
  // whole-file boolean has.
  const mixed = toolingFile(
    'The rollout is staged: Tier 2 first, then the standard tier.\n\nSeparately: the reviewers split on the pooling question.',
  );
  assert.deepEqual(labels(mixed), ['reviewer-split', 'tier']);
  assert.deepEqual(labels(mixed.replace('head: abc123', 'head: abc123\ntooling-reviewed: tier')), ['reviewer-split']);
  assert.deepEqual(labels(mixed.replace('head: abc123', 'head: abc123\ntooling-reviewed: tier, reviewer-split')), []);

  // `security-reviewed: yes` is a whole-file judgement; this one is per-label,
  // and every label is printed in the refusal, so the blunt form is refused.
  assert.deepEqual(labels(mixed.replace('head: abc123', 'head: abc123\ntooling-reviewed: yes')), ['reviewer-split', 'tier']);
});

test('the lint scans exactly what planActions will post, no more', () => {
  // Under REPLY the summary is not sent to GitHub, so a leaky body is not a
  // leak — and blocking on it would train the human to hatch a benign hit.
  const thread = `
<!-- prt:thread
id: t1
node-id: RT_1
post: true
-->
Thanks — that resolves it.
<!-- /prt -->`;
  const replyRound = toolingFile('This was not the two-model consensus pipeline.', { event: 'REPLY', extra: thread });
  assert.deepEqual(labels(replyRound), [], 'the body is not planned under REPLY, so it is not scanned');

  // The same bytes become postable the moment the verdict changes, and the
  // lint is re-evaluated at every submit, so nothing is grandfathered in.
  assert.deepEqual(labels(replyRound.replace('event: REPLY', 'event: COMMENT')), ['consensus', 'pipeline-shape']);

  // A thread reply is in scope under REPLY, and the hit names the block.
  const leakyThread = replyRound.replace('Thanks — that resolves it.', 'The two reviewers split on this one.');
  assert.deepEqual(
    toolingLint(parseActionFile(leakyThread)).map((h) => [h.label, h.where]),
    [['reviewer-split', ['t1']]],
  );
});

test('the reviewer provenance in prt:context is never itself a hit', () => {
  // `**Draft produced by:** Codex gpt-5.6-sol (round 1, native reviewer) · Opus
  // (adjudicated)` sits in every fixture in this file and would fire `round`
  // and `adjudication` if the scan ever widened past `planActions`. That the
  // whole file above is clean is the assertion; this makes it explicit.
  assert.deepEqual(labels(toolingFile('The retry path looks right to me.')), []);
});


// ------------------------------------------- 4. what `prt validate` says about it
//
// The mark and the exit code are the two things a script reads, and they answer
// one question: will this file post? A pipeline-mechanics hit is not a parse
// error, so `validate` used to print `✓` and exit 0 over a file `prt submit`
// refuses — "won't post" no longer implied exit 1, which is the direction a
// batch loop gates on.

test('validate fails a file that submit will refuse, and names the hatch that clears it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-vlint-'));
  // No `gh` on PATH, so the anchor check fails and only WARNS — which keeps this
  // test about the lint's effect on the verdict, and off the network.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-nogh-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ reviewer: 'me' }));
    const dir = path.join(root, 'o', 'r', 'pr-1');
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
      schema: 1, repo: 'o/r', number: 1, title: 't', author: 'someone', state: 'OPEN',
      analysis: { number: 1, threadCounts: {}, threads: [] },
    }));
    const run = () => spawnSync(process.execPath, [PRT, 'validate', '1', '--repo', 'o/r', '--root', root], {
      encoding: 'utf8', env: { ...process.env, PATH: empty },
    });

    const clean = toolingFile('The retry path looks right to me.');
    fs.writeFileSync(path.join(dir, 'review.md'), clean);
    const ok = run();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^✓ #1 /m);

    const leaky = toolingFile('This came out of a two-model review at effort `xhigh`.');
    assert.deepEqual(labels(leaky), ['effort', 'pipeline-shape'], 'the fixture really does leak');
    fs.writeFileSync(path.join(dir, 'review.md'), leaky);
    const bad = run();
    assert.equal(bad.status, 1, 'a file submit refuses is a file validate fails');
    assert.match(bad.stdout, /^✗ #1 /m, 'and the mark says so too');
    // The remedy is the one the submit-time refusal names, so a human who takes
    // this line seriously does not have to trip a submit to learn how to clear it.
    assert.match(bad.stdout, /tooling-reviewed: effort, pipeline-shape/);
    assert.match(bad.stdout, /a bare `yes` excuses nothing/);

    // And the hatch it names does clear it — mark, exit code and all.
    fs.writeFileSync(path.join(dir, 'review.md'),
      leaky.replace('head: abc123', 'head: abc123\ntooling-reviewed: effort, pipeline-shape'));
    const hatched = run();
    assert.equal(hatched.status, 0, hatched.stdout + hatched.stderr);
    assert.match(hatched.stdout, /^✓ #1 /m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
