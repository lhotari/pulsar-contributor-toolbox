// node --test scripts/test/guarantees.test.mjs
//
// The sentences this skill states as guarantees, each pinned by the thing it
// claims about.
//
// This file exists because the same defect was caught three rounds running: a
// comment or a doc sentence asserting a safety property the code did not have.
// `askHandlingLine` said state was "derived at render time and never stored"
// while a derived line sat on disk; the pipeline lint said "scoping it is what
// makes it safe"; `prt validate` said its exit code answered "will this file
// post?" while consulting one refusal out of four. Every one of those was a
// true-sounding sentence with nothing underneath it, and prose does not fail a
// suite.
//
// So each test below quotes the sentence it defends. A claim with a test behind
// it stops being a comment and becomes a contract: weaken the code and the
// suite says which sentence just became a lie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseActionFile, collectAsks, askState, questionHash, promoteShorthand,
  carryAsks, relocateResolvedAsks, askHandlingLine, unpromotedNotes, tokenize,
  HUMAN_DOC_KEYS,
} from '../lib/actionfile.mjs';
import { maxAskOrdinal } from '../lib/actionfile.mjs';
import { contentRefusals } from '../lib/submit.mjs';
import { readState, writeState } from '../lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '../..');
const PRT = path.join(SKILL, 'scripts/prt.mjs');
const CFG = { securityLint: true, toolingLint: true };

// A store with one PR, and a `gh` that is either absent (so the anchor check
// warns and stays off the network) or the fake shim.
function withStore(review, fn, { gh = null, number = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-guar-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-bin-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ reviewer: 'me' }));
    const dir = path.join(root, 'o', 'r', `pr-${number}`);
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
      schema: 1, repo: 'o/r', number, title: 't', author: 'someone', state: 'OPEN',
      analysis: { number, threadCounts: {}, threads: [] },
    }));
    fs.writeFileSync(path.join(dir, 'review.md'), review);
    let env = { ...process.env, PATH: bin };
    if (gh) {
      const scenario = path.join(root, 'gh.json');
      fs.writeFileSync(scenario, JSON.stringify({ rules: gh }));
      const shim = path.join(bin, 'gh');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(SKILL, 'scripts/test/helpers/fake-gh.mjs')}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
      env = { ...env, PATH: `${bin}:${process.env.PATH}`, PRT_FAKE_GH: scenario };
    }
    const run = (args) => spawnSync(process.execPath, [PRT, ...args, '--repo', 'o/r', '--root', root], { encoding: 'utf8', env });
    return fn({ root, dir, run, file: path.join(dir, 'review.md') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

const DOC = (extra = '', gen = 1) => `Status: draft

<!-- prt:doc
repo: o/r
pr: 1
generation: ${gen}
head: abc123${extra}
-->
`;
const VERDICT = `
<!-- prt:verdict
event: COMMENT
-->
`;
const BODY = (text = 'The retry path looks right to me.') => `
<!-- prt:body -->
${text}
<!-- /prt -->
`;
const file = ({ doc = '', body, extra = '', gen = 1 } = {}) => DOC(doc, gen) + VERDICT + BODY(body) + extra;


// ---------------------------------------------------------------------------
// 1. `prt validate`, in both directions.
//
//   commands.md: "`✗` and exit 1 mean `prt submit` will refuse this file."
//   commands.md: "`✓` and exit 0 do not promise the reverse. They mean nothing
//                 in the *bytes* stops the post."
//   SKILL.md   : "`✗` means `prt submit` would refuse this file, and every
//                 `error:` and `refuses:` line under it is one of the reasons."
//
// The defect: `validate` grew its own copy of the pipeline-mechanics lint and
// none of the other three, so it printed `✓` and exited 0 over a file carrying
// "remote code execution", an unanswered note, or a note quoted back into the
// review — which is exactly what a batch loop gates on.

const REFUSALS = {
  'a security disclosure': file({ body: 'This is a remote code execution hole and it is exploitable without auth.' }),
  'an unanswered note of the human\'s': file({
    extra: '\n<!-- prt:ask\nid: a1\nre: body\n-->\ndo not post this until i have checked\n<!-- /prt -->\n',
  }),
  'a private note quoted back into the review': file({
    body: 'do not post this until i have checked the numbers again with the author please',
    extra: '\n<!-- prt:ask\nid: a1\nre: body\n-->\n'
      + 'do not post this until i have checked the numbers again with the author please\n<!-- /prt -->\n'
      + '\n<!-- prt:answer\nto: a1\ndisposition: addressed\nin: g1\n-->\nQuoted it.\n<!-- /prt -->\n',
  }),
  'pipeline mechanics': file({ body: 'This came out of a two-model review at effort `xhigh`.' }),
};

test('every refusal `prt submit` can decide from the bytes also fails `prt validate`', () => {
  for (const [what, text] of Object.entries(REFUSALS)) {
    const reasons = contentRefusals(parseActionFile(text), CFG);
    assert.ok(reasons.length, `the fixture for ${what} really does trip a submit refusal`);
    withStore(text, ({ run }) => {
      const r = run(['validate', '1']);
      assert.equal(r.status, 1, `${what}: a file submit refuses is a file validate fails\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^✗ #1 /m, `${what}: and the mark says so too`);
      // The same sentence, hatch included, so clearing it never needs a submit.
      for (const reason of reasons) {
        assert.ok(r.stdout.includes(`    refuses: ${reason}`), `${what}: validate prints the submit-time reason verbatim`);
      }
    });
  }
});

test('a file with none of them is `✓` and exit 0', () => {
  withStore(file({}), ({ run }) => {
    const r = run(['validate', '1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^✓ #1 /m);
    assert.doesNotMatch(r.stdout, /refuses:/);
  });
});

test('`validate` and `preflight` read one list of refusals, not two', () => {
  // The structural half of the guarantee above. `preflight` may only add
  // reasons that need the network; anything decidable from the bytes has to
  // come from `contentRefusals`, or the two commands can disagree again.
  const src = fs.readFileSync(path.join(SKILL, 'scripts/lib/submit.mjs'), 'utf8');
  const preflight = src.slice(src.indexOf('export async function preflight'), src.indexOf('export function contentRefusals'));
  for (const lint of ['securityLint(', 'toolingLint(', 'askQuoteLint(', 'blockingAsks(']) {
    assert.ok(!preflight.includes(lint), `preflight must reach ${lint} only through contentRefusals`);
  }
  const cli = fs.readFileSync(PRT, 'utf8');
  const validate = cli.slice(cli.indexOf('COMMANDS.validate'), cli.indexOf('COMMANDS.submit'));
  assert.ok(validate.includes('contentRefusals(parsed, base.cfg)'), 'and validate runs that same list');
  for (const lint of ['securityLint(', 'toolingLint(', 'askQuoteLint(']) {
    assert.ok(!validate.includes(lint), `validate must not grow its own copy of ${lint}`);
  }
});

test('`on-anchor-fail` is read the way the submitter reads it', () => {
  // The other direction of the same drift. A `demote`/`drop` comment whose
  // anchor is gone does NOT stop the post — `preflight` only refuses on
  // `block` — so failing the verdict over it would exit 1 on a file that
  // submits cleanly.
  const DIFF = ['diff --git a/T.java b/T.java', 'index 1..2 100644', '--- a/T.java', '+++ b/T.java',
    '@@ -1,2 +1,2 @@', ' one', '+two', ''].join('\n');
  const rules = [
    { when: { args: ['graphql'], body: 'viewer' }, stdout: '{"data":{"viewer":{"login":"me"}}}' },
    { when: { args: ['pr', 'diff'] }, stdout: DIFF },
  ];
  const inline = (onFail) => `
<!-- prt:inline
id: i1
path: T.java
line: 900
side: RIGHT
on-anchor-fail: ${onFail}
post: true
-->
This line is nowhere near the diff.
<!-- /prt -->
`;
  withStore(file({ extra: inline('block') }), ({ run }) => {
    const r = run(['validate', '1']);
    assert.equal(r.status, 1, `block is fatal at submit, so it is fatal here\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /error: {3}inline "i1"/);
  }, { gh: rules });

  for (const soft of ['demote', 'drop']) {
    withStore(file({ extra: inline(soft) }), ({ run }) => {
      const r = run(['validate', '1']);
      assert.equal(r.status, 0, `${soft} does not stop a submit, so it must not fail the verdict\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, new RegExp(`warning: inline "i1".*on-anchor-fail: ${soft}`));
    }, { gh: rules });
  }
});


// ---------------------------------------------------------------------------
// 2. "Every `@ai` line you type is named."
//
//   SKILL.md        : "Every `@ai` line you type is **named**: wherever it sits,
//                      it is a parse error, so `prt validate` exits 1 and
//                      nothing submits past it."
//   action-file.md  : "That is the invariant, and it holds for every `@ai` line,
//                      in every placement: named by an error, and never
//                      overwritten without a word."
//
// The doc names this test as the reason to believe the sentence, so the two
// have to stay in step: every placement a human can reach, one table.

const NOTE = '@ai STOP, do not post this yet';
const PLACEMENTS = {
  'a gap': DOC() + `\n${NOTE}\n` + VERDICT + BODY(),
  'a posted body': DOC() + VERDICT + BODY(`Summary line.\n${NOTE}`),
  "a block's header": DOC() + VERDICT + `\n<!-- prt:body\n${NOTE}\n-->\nSummary.\n<!-- /prt -->\n`,
  'prt:log': DOC() + VERDICT + BODY() + `\n<!-- prt:log -->\ng1 drafted\n${NOTE}\n<!-- /prt -->\n`,
  'a block of an unknown kind': DOC() + VERDICT + BODY() + `\n<!-- prt:scratchpad -->\n${NOTE}\n<!-- /prt -->\n`,
  'a block whose terminator is missing': DOC() + VERDICT + BODY() + `\n<!-- prt:notes -->\n${NOTE}\n`,
  'a prt:ask body, under the question': DOC() + VERDICT + BODY()
    + `\n<!-- prt:ask\nid: a1\nre: body\nq: ${questionHash('the question')}\n-->\nthe question\n${NOTE}\n<!-- /prt -->\n`,
  'a prt:answer body': DOC() + VERDICT + BODY()
    + `\n<!-- prt:ask\nid: a1\nre: body\nq: ${questionHash('the question')}\n-->\nthe question\n<!-- /prt -->\n`
    + `\n<!-- prt:answer\nto: a1\ndisposition: addressed\nin: g1\n-->\nDone.\n${NOTE}\n<!-- /prt -->\n`,
};

test('an `@ai` line is a parse error in every placement a human can type it', () => {
  for (const [where, text] of Object.entries(PLACEMENTS)) {
    const p = parseActionFile(text);
    assert.ok(
      p.errors.some((e) => /@ai|un-promoted/.test(e)),
      `${where}: nothing named the note. errors were ${JSON.stringify(p.errors)}`,
    );
    assert.ok(unpromotedNotes(text).some((n) => n.text.includes('STOP')), `${where}: and \`prt ask\` lists it`);
    assert.ok(unpromotedNotes(text).every((n) => n.remedy), `${where}: with an edit that fixes it`);
  }
});

test('and `prt validate` exits 1 on each of them, with an `!` row from `prt ask`', () => {
  for (const [where, text] of Object.entries(PLACEMENTS)) {
    withStore(text, ({ run }) => {
      const v = run(['validate', '1']);
      assert.equal(v.status, 1, `${where}: validate must fail\n${v.stdout}${v.stderr}`);
      const a = run(['ask', '1']);
      assert.match(a.stdout, /! un-promoted/, `${where}: and prt ask must show the ! row`);
    });
  }
});

test('`--promote` never reports a clear file over one that has a note', () => {
  // `promoted` and `refused` both come from the LIFT, and the lift never looks
  // inside `prt:log`, a block's header, a broken block or an unknown kind — so
  // both counters read 0 and the all-clear used to fire over exactly the notes
  // `prt validate` was refusing the file for.
  for (const where of ['prt:log', "a block's header", 'a block of an unknown kind']) {
    withStore(PLACEMENTS[where], ({ run }) => {
      const r = run(['ask', '1', '--promote']);
      assert.doesNotMatch(r.stdout, /no un-promoted @ai notes/, `${where}: a file with a note is never told it has none`);
      assert.match(r.stdout, /NOT PROMOTED/, `${where}: it is named, with its own remedy`);
    });
  }
  // And the all-clear still exists, for a file that really is clear.
  withStore(file({}), ({ run }) => {
    assert.match(run(['ask', '1', '--promote']).stdout, /no un-promoted @ai notes/);
  });
});


// ---------------------------------------------------------------------------
// 3. "State is derived, never stored."
//
//   action-file.md: "A stored `state:` field and an answer body are two facts
//                    that can disagree — 'addressed' with nothing to show for
//                    it. Deriving makes that unrepresentable."

const Q = 'this one is wrong, the null check is upstream';
const askPair = ({ q = true, extraFields = '', question = Q, answered = true } = {}) => file({
  extra: `\n<!-- prt:ask\nid: a1\nre: body${extraFields ? `\n${extraFields}` : ''}${q ? `\nq: ${questionHash(Q)}` : ''}\n-->\n${question}\n<!-- /prt -->\n`
    + (answered ? '\n<!-- prt:answer\nto: a1\ndisposition: addressed\nin: g1\n-->\nFixed it.\n<!-- /prt -->\n' : ''),
});

test('no field a human or a model can write closes an ask; only an answer does', () => {
  const derived = (text) => {
    const p = parseActionFile(text);
    return askState(p.asks[0], p.answers).state;
  };
  assert.equal(derived(askPair({})), 'addressed', 'the answer block is what closes it');
  assert.equal(derived(askPair({ answered: false })), 'open', 'and removing it reopens it');
  assert.equal(
    derived(askPair({ answered: false, extraFields: 'state: addressed\ndisposition: addressed' })),
    'open',
    'a hand-written state:/disposition: field on the ask is not a second place state lives',
  );
});

test('every ask this tool creates carries the stamp the reopen is derived from', () => {
  // The rewrite-reopen guarantee rests entirely on `q:` being there. It is
  // written at the one moment the tool can honestly say "these are the words I
  // wrote" — creation — so the property to pin is that creation always does it.
  const promoted = promoteShorthand(file({ extra: '\n@ai please look at the null check again\n' }), { startOrdinal: 1, generation: 1 });
  assert.equal(promoted.promoted.length, 1);
  const p = parseActionFile(promoted.text);
  assert.ok(p.asks[0].q, 'a promoted note carries `q:`');
  assert.equal(p.asks[0].q, questionHash(p.asks[0].question), 'and it stamps the words it actually wrote');

  // And a regeneration copies it rather than recomputing it, or every round
  // would launder an edit the human had just made.
  const edited = promoted.text.replace('please look at the null check again', 'STOP, the null check is still wrong');
  const pe = parseActionFile(edited);
  assert.equal(askState(pe.asks[0], pe.answers).state, 'open', 'unanswered, so still just open');
  const carried = carryAsks(edited, { generation: 2 });
  assert.equal(carried.asks[0].q, promoted.promoted[0].q ?? p.asks[0].q, 'the stamp survives the carry unchanged');
});

test('rewriting an answered question reopens it, and a regeneration cannot re-close it', () => {
  const edited = askPair({}).replace(Q, 'STOP - the tier text is still in i7, do not post');
  const pe = parseActionFile(edited);
  assert.equal(askState(pe.asks[0], pe.answers).state, 'edited');
  assert.ok(contentRefusals(pe, CFG).some((r) => /was rewritten after it was answered/.test(r)), 'and the submit refuses it');
  const carried = carryAsks(edited, { generation: 2 });
  assert.equal(carried.asks[0].q, questionHash(Q), 'the carried stamp still names the OLD wording, so it stays open');
});

test('an `edited` note the human marked `blocking: no` is named, and does not fail the verdict', () => {
  // The one member of the family `prt submit` does not refuse. It must still be
  // said out loud, or a rewritten question would be silent again — but as a
  // warning, because the verdict means "submit refuses this".
  const text = askPair({ extraFields: 'blocking: no' }).replace(Q, 'STOP, still wrong');
  const p = parseActionFile(text);
  assert.equal(collectAsks(text).asks[0].state, 'edited');
  assert.deepEqual(contentRefusals(p, CFG), [], 'blocking: no means it does not stop a submit');
  withStore(text, ({ run }) => {
    const r = run(['validate', '1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /warning: note "a1" was rewritten after it was answered/);
  });
});


// ---------------------------------------------------------------------------
// 4. "Adding your own words to a handling line is safe."
//
//   action-file.md: "a line that *begins* with what the state derives to now is
//                    read as that line plus your sentence … nothing is
//                    rewritten. Only a line that no longer derives at all is
//                    replaced."
//
// The defect: the trigger was any byte difference, so appending a reaction to
// the line — the natural place to push back on what the model just reported —
// was replaced on the next `--tidy`, under a message naming the one thing that
// had not changed.

test('`--tidy` leaves a handling line the human appended to, and says so when it does replace one', () => {
  const filed = relocateResolvedAsks(askPair({})).text;
  assert.match(filed, /^\*a1 · addressed · g1\* — Fixed it\./m, 'the pair is filed under a derived line');

  const reacted = filed.replace(
    askHandlingLine(parseActionFile(filed).asks[0], parseActionFile(filed).answers),
    (l) => `${l}  <- I disagree, revisit this next round.`,
  );
  const again = relocateResolvedAsks(reacted);
  assert.deepEqual(again.refreshed, [], 'nothing to refresh: the derived half already reads correctly');
  assert.match(again.text, /<- I disagree, revisit this next round\./, 'and the human keeps their sentence');
  assert.equal(relocateResolvedAsks(again.text).text, again.text, 'still a byte-for-byte no-op on a second run');

  // A line that genuinely stopped deriving is still rewritten — with the words
  // it replaced named, when they were not the tool's own.
  const flipped = reacted.replace('disposition: addressed', 'disposition: declined');
  const r = relocateResolvedAsks(flipped);
  assert.equal(r.refreshed.length, 1);
  assert.equal(r.refreshed[0].state, 'declined');
  assert.equal(r.refreshed[0].replaced, 'Fixed it.  <- I disagree, revisit this next round.',
    'the run names the bytes it took, rather than only the state it set');
});


// ---------------------------------------------------------------------------
// 5. "The model cannot write a paragraph that contradicts the file it is
//    writing into."
//
//   action-file.md: "`drop-inline` is cross-checked against the round `in:`
//                    names."
//
// The defect: the check ran against the CURRENT file in every round, so once
// the dropped finding legitimately left `findings.json` an honest answer
// stopped parsing — and because `carryAsks` refuses to regenerate over notes it
// cannot read, the `prt draft` that would have retired the pair was refused
// too. The file wedged permanently, on the one PR the feature was built for.

const dropClaim = ({ gen, wroteIn, inlinePresent }) => file({
  gen,
  extra: (inlinePresent ? '\n<!-- prt:inline\nid: i1\npath: T.java\nline: 1\npost: false\ndropped-by: a1\n-->\nGone.\n<!-- /prt -->\n' : '')
    + `\n<!-- prt:ask\nid: a1\nre: body\nq: ${questionHash('drop i1 please')}\n-->\ndrop i1 please\n<!-- /prt -->\n`
    + `\n<!-- prt:answer\nto: a1\ndisposition: addressed\ndid: drop-inline i1\nin: ${wroteIn}\n-->\nDropped it.\n<!-- /prt -->\n`,
});

test('a drop-inline claim is checked in the round that wrote it, and only there', () => {
  // Round 1, comment present and disarmed: the honest case, and it parses.
  assert.deepEqual(parseActionFile(dropClaim({ gen: 1, wroteIn: 'g1', inlinePresent: true })).errors, []);

  // Round 1, no such comment: the model claimed a drop it did not make.
  const lying = parseActionFile(dropClaim({ gen: 1, wroteIn: 'g1', inlinePresent: false }));
  assert.equal(lying.errors.length, 1);
  assert.match(lying.errors[0], /inline "i1": the answer at line \d+ says `did: drop-inline i1`, but this file has no inline "i1"/);

  // Round 2, the finding is gone from findings.json so the comment is not
  // regenerated: the same bytes now describe what dropping i1 MEANS.
  const carriedOn = dropClaim({ gen: 2, wroteIn: 'g1', inlinePresent: false });
  assert.deepEqual(parseActionFile(carriedOn).errors, [], 'an honest answer keeps parsing a round later');
});

test('and a stale drop-inline claim never stops the regeneration that would retire it', () => {
  // The amplifier: `carryAsks` classes a parse error naming `prt:answer` as a
  // note-safety failure and refuses, so the wedge outlived every command that
  // could have cleared it. Both halves are pinned: the honest carried claim
  // parses, and even the dishonest one is a claim about an inline rather than a
  // note this tool cannot read.
  for (const [what, text] of [
    ['carried honestly', dropClaim({ gen: 2, wroteIn: 'g1', inlinePresent: false })],
    ['written wrong this round', dropClaim({ gen: 2, wroteIn: 'g2', inlinePresent: false })],
  ]) {
    const carried = carryAsks(text, { generation: 2 });
    assert.deepEqual(carried.structuralErrors, [], `${what}: prt draft must still be able to regenerate`);
    assert.equal(carried.asks.length, 1, `${what}: and the human's words come with it`);
  }
});


// ---------------------------------------------------------------------------
// 6. The `## Resolved notes` framing states what the section IS, not what its
//    contents are.
//
//   action-file.md / actionfile.mjs: the section is bytes, the state above it is
//   derived, and between a human's edit and the next reconciling command the two
//   disagree. The old framing — "each one has an answer, so none of them blocks
//   a submit" — was a flat assertion about live state, printed onto disk, and it
//   was false in exactly that window.

test('the resolved-notes framing says nothing that a deleted answer makes false', () => {
  const filed = relocateResolvedAsks(askPair({})).text;
  const heading = filed.slice(filed.indexOf('## Resolved notes'));
  const framing = heading.split('\n').filter((l) => l.startsWith('*') && l.endsWith('*')).join(' ');

  // The window the old sentence lied in: the answer is gone, the pair has not
  // moved yet, and `prt submit` now refuses over a note filed under this
  // heading.
  const gutted = filed.replace(/<!-- prt:answer[\s\S]*?<!-- \/prt -->\n/, '');
  assert.ok(contentRefusals(parseActionFile(gutted), CFG).some((r) => /a1.*is still open/.test(r)),
    'the note really does block the submit while the section still shows it');
  assert.ok(gutted.includes(framing.split(' ').slice(0, 4).join(' ')), 'and the framing is still on disk, unchanged');

  assert.doesNotMatch(framing, /none of them blocks a submit/, 'no claim about what the file currently allows');
  assert.match(framing, /reconciles this/, 'it names the command that makes it true instead');

  // And the reconciliation the framing promises does happen.
  const r = relocateResolvedAsks(gutted);
  assert.deepEqual(r.reopened.map((x) => x.id), ['a1']);
});


// ---------------------------------------------------------------------------
// 7. "`carriedDoc` can add a line here, and can never rewrite one of those."
//
//   render.mjs: the allow-list is "a second lock on the same door, so that a
//   caller handing the renderer a whole previous `prt:doc` cannot smuggle a
//   stale `head:` or `diff-fingerprint:` past the submitter's preflight."
//
// The lock is the *disjointness* of two sets, and nothing but this test says
// so. The danger it guards is real and measured: a duplicate key in a sentinel
// resolves last-wins, so one precondition name added to `HUMAN_DOC_KEYS` would
// let a carried value override the measured one — and those keys are exactly
// what `preflight` re-checks against live GitHub.

test('the doc keys a previous generation can carry never include a precondition', () => {
  const PRECONDITIONS = ['head', 'base-ref', 'base', 'diff-fingerprint', 'repo', 'pr', 'generation', 'reviewed-at'];
  for (const key of HUMAN_DOC_KEYS) {
    assert.ok(!PRECONDITIONS.includes(key), `\`${key}\` is carried across a regeneration and must not be a precondition`);
  }
  assert.deepEqual([...HUMAN_DOC_KEYS].sort(), ['ask-quote-reviewed', 'security-reviewed', 'tooling-reviewed'],
    'only the three human acknowledgements travel; adding a fourth is a decision, not a detail');

  // Why it matters: last-wins. If the allow-list ever did contain `head`, the
  // carried line would be emitted after the measured one and would be the one
  // `preflight` compared against GitHub.
  const dup = 'Status: draft\n\n<!-- prt:doc\nrepo: o/r\npr: 1\nhead: MEASURED\nhead: CARRIED\n-->\n';
  assert.equal(parseActionFile(dup).doc.head, 'CARRIED', 'a duplicate sentinel key resolves to the last one');
});


// ---------------------------------------------------------------------------
// 8. "`parseActionFile` never throws."
//
//   submit.mjs: "FAILING CLOSED COSTS NOTHING HERE. `parseActionFile` never
//   throws and the worst a file it cannot read parses to is no actions, no
//   actions trip no lint, and every hatch is …"
//
// The whole fail-closed argument for the lints rests on this. A throw inside
// `capture()` is not a refusal with a reason — it is a stack trace over a file
// the human armed.

test('no byte sequence makes the parser or its readers throw', () => {
  const seeds = ['', ' ', '﻿', 'Status: draft', '<!-- prt:', '<!-- prt:ask\n', '-->', '<!-- /prt -->',
    ...Object.values(PLACEMENTS), ...Object.values(REFUSALS), askPair({}), file({})];
  const bits = ['<!-- prt:', '-->', '<!-- /prt -->', 'prt:ask', 'id: a1', '@ai x', ' ', '\r', 'q: sha256:zz',
    'in: g', '﻿', 'did: drop-inline i9', 'to: a1', 'disposition: ', '<!-- prt:doc', '## Resolved notes'];
  let rng = 20260829;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let cases = 0;
  for (const seed of seeds) {
    const lines = seed.split('\n');
    for (let i = 0; i < 200; i++) {
      const l = [...lines];
      for (let o = 0, ops = 1 + Math.floor(rand() * 4); o < ops; o++) {
        const at = Math.floor(rand() * (l.length + 1));
        const what = rand();
        if (what < 0.4) l.splice(at, 0, bits[Math.floor(rand() * bits.length)]);
        else if (what < 0.7) l.splice(at, 1);
        else if (l[at] !== undefined) l[at] = l[at].slice(0, Math.floor(rand() * (l[at].length + 1)));
      }
      const text = l.join('\n');
      cases++;
      try {
        tokenize(text);
        const p = parseActionFile(text);
        collectAsks(text);
        contentRefusals(p, CFG);
        unpromotedNotes(text);
        relocateResolvedAsks(text);
      } catch (e) {
        assert.fail(`threw ${e.message} on:\n${text.slice(0, 600)}`);
      }
    }
  }
  assert.ok(cases >= 4000, `the fuzz really ran (${cases} cases)`);
});


// ---------------------------------------------------------------------------
// 9. "A retired id is never reissued."
//
//   action-file.md: "assigned by promotion, from a high-water mark kept in the
//                    PR's `state.json` — so a retired id is not reissued once
//                    the ask itself has left the file."
//   prt.mjs       : "or a `follows:` chain in an archived file would point at
//                    somebody else's question."
//
// `maxAskOrdinal` reads the text, and a retired ask is exactly the one that is
// no longer in the text — so the property lives in the two call sites taking a
// max with the stored floor, and nothing but a test says they both still do.

test('the ask-id floor survives the asks themselves leaving the file', () => {
  withStore(file({ extra: '\n@ai first question\n' }), ({ root, run, file: reviewPath }) => {
    const first = run(['ask', '1', '--promote']);
    assert.match(first.stdout, /→ ask a1 /, first.stdout + first.stderr);
    assert.equal(readState(root, 'o/r', 1)?.asks?.ordinalFloor, 1, 'promotion records the high-water mark');

    // The human answers it, and a later generation retires the pair: the id is
    // now only in history/, which is where a `follows:` chain can still name it.
    const answered = fs.readFileSync(reviewPath, 'utf8')
      + '\n<!-- prt:answer\nto: a1\ndisposition: addressed\nin: g1\n-->\nDone.\n<!-- /prt -->\n';
    assert.deepEqual(carryAsks(answered, { generation: 3, keepClosedFor: 1 }).asks, [], 'a1 really is retired');

    // Nothing in the file mentions a1 any more...
    fs.writeFileSync(reviewPath, file({ extra: '\n@ai a completely different question\n' }));
    assert.equal(maxAskOrdinal(fs.readFileSync(reviewPath, 'utf8')), 0, 'and the text alone would hand out a1 again');

    // ...but the stored floor is what the next promotion counts from.
    const second = run(['ask', '1', '--promote']);
    assert.match(second.stdout, /→ ask a2 /, `a retired id must never be reissued\n${second.stdout}${second.stderr}`);

    // And the guarantee is exactly as strong as that stored number: drop it and
    // the id comes back. This is the sentence the doc has to keep saying.
    writeState(root, 'o/r', 1, { ...readState(root, 'o/r', 1), asks: { ordinalFloor: 0 } });
    fs.writeFileSync(reviewPath, file({ extra: '\n@ai a third question\n' }));
    assert.match(run(['ask', '1', '--promote']).stdout, /→ ask a1 /,
      'with no stored floor the file alone reissues — which is why the doc names state.json');
  });
});
