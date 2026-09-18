// Workflow script template for a time-boxed, tiered review. Pass it inline to the Workflow tool after
// filling the ALL-CAPS placeholders. Plain JavaScript: no TypeScript, no Date.now(), no filesystem.
//
// Sizing (see SKILL.md): 10 min -> 5-7 lenses, verify <= 8; 15 min -> 7-9 lenses, verify <= 12;
// 30 min -> 9-12 lenses, verify <= 20 plus a completeness critic.

export const meta = {
  name: 'timeboxed-review',
  description: 'Time-boxed tiered review of REVIEW_TARGET_DESCRIPTION',
  phases: [
    { title: 'Find', detail: 'independent lenses; Sonnet for lookups, Opus for focused review, Fable for concurrency and contrarian' },
    { title: 'Verify', detail: 'Fable refutes each medium-or-higher finding against the frozen source' },
  ],
}

// Everything every agent must know. Keep it factual: revision, frozen path, what changed, where the
// previous review and the responses are, key files with approximate line numbers, disputed premises.
const WT = '/tmp/claude-1000/review-REVISION'
const CTX = `
You are reviewing REVIEW_TARGET_DESCRIPTION, frozen in a detached git worktree at ${WT} (commit REVISION;
merge-base with the default branch BASE_REVISION). Work ONLY inside that directory with read-only commands
(cat, sed -n, grep -rn with the repository's source patterns SOURCE_PATTERNS, git show, git log, git diff). Do NOT
edit files, run builds or tests, push, or post anything. Cite every claim as file:line at REVISION.
Repository conventions to apply: STYLE_RULES (from its CLAUDE.md, CONTRIBUTING or coding guide).
TIME BOX: about AGENT_MINUTES minutes of work. Prefer a few precise, source-cited findings over many vague ones.

What changed since the previous review (oldest first):
 COMMIT_LIST_WITH_ONE_LINE_SUMMARIES

Previous review: PREVIOUS_REVIEW_PATH (its recommended actions are the checklist).
Author or other agent response: RESPONSE_PATH.
Premises from the previous review that the response disputes; treat as OPEN questions, not facts:
 DISPUTED_PREMISES

Key files at ${WT}:
 KEY_FILES_WITH_APPROXIMATE_LINES

Return ONLY the structured object. Findings must say whether they are a defect, a gap, a regression risk, a
documentation issue, a test issue, or a confirmation, with severity and a concrete recommendation.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string', description: 'Two to four sentences' },
    findings: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['defect', 'gap', 'regression-risk', 'doc-issue', 'test-issue', 'confirmation', 'premise-correction'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'file:line citations at the frozen revision and the concrete interleaving or facts' },
          recommendation: { type: 'string' },
        },
        required: ['id', 'title', 'kind', 'severity', 'claim', 'evidence', 'recommendation'],
      },
    },
  },
  required: ['lens', 'summary', 'findings'],
}

const CHECKLIST_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The earlier action or disposition row, quoted briefly' },
          status: { type: 'string', enum: ['verified', 'partially-verified', 'not-verified', 'contradicted', 'deferred-to-follow-up'] },
          evidence: { type: 'string', description: 'file:line at the frozen revision, commit hash, or doc location' },
          note: { type: 'string' },
        },
        required: ['item', 'status', 'evidence'],
      },
    },
  },
  required: ['lens', 'summary', 'items'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'partially-confirmed', 'refuted', 'unverifiable'] },
    reasoning: { type: 'string', description: 'Source-cited at the frozen revision' },
    corrected_claim: { type: 'string' },
    severity_adjustment: { type: 'string', enum: ['keep', 'raise', 'lower'] },
  },
  required: ['verdict', 'reasoning', 'severity_adjustment'],
}

// Model profile, chosen from the usage reading and the user's request (see SKILL.md "Model policy"):
// 'normal' when usage is at most 75%; 'high' when the user asks for high effort or a thorough review;
// 'tight' when usage is above 75% or the user asks for quick or cheap.
const PROFILE = 'normal'
const PROFILES = {
  normal: {
    lookup:   { model: 'sonnet', effort: 'medium' },
    task:     { model: 'opus',   effort: 'medium' },   // raise to 'high' or 'xhigh' by task difficulty
    taskHard: { model: 'opus',   effort: 'xhigh' },
    brain:    { model: 'fable',  effort: 'high' },     // 'xhigh' for the core-change lens
    core:     { model: 'fable',  effort: 'xhigh' },
    verify:   { model: 'fable',  effort: 'high' },     // 'xhigh' for verifiers of high-severity findings
    verifyCap: 8,
  },
  high: {
    lookup:   { model: 'sonnet', effort: 'high' },
    task:     { model: 'fable',  effort: 'high' },
    taskHard: { model: 'fable',  effort: 'high' },
    brain:    { model: 'fable',  effort: 'xhigh' },
    core:     { model: 'fable',  effort: 'xhigh' },
    verify:   { model: 'fable',  effort: 'xhigh' },
    verifyCap: 8,
  },
  tight: {
    lookup:   { model: 'sonnet', effort: 'low' },
    task:     { model: 'sonnet', effort: 'medium' },
    taskHard: { model: 'opus',   effort: 'medium' },   // only the single hardest task
    brain:    { model: 'opus',   effort: 'medium' },
    core:     { model: 'opus',   effort: 'high' },
    verify:   { model: 'opus',   effort: 'medium' },
    verifyCap: 4,
  },
}
const P = PROFILES[PROFILE]

// One entry per lens with its role in the profile.
const LENSES = [
  {
    key: 'checklist', role: 'lookup', schema: CHECKLIST_SCHEMA,
    prompt: `LENS: Mechanical checklist (Sonnet). For EVERY recommended action in the previous review and EVERY row of the
response's disposition table, verify against the frozen source (not the response text) with file:line or test-method
evidence, or mark contradicted. Also verify: origin and local heads, that any amended commit changed only its message,
that docs and conf files agree, and that stated validation artifacts exist and say what the response says. Presence only.`,
  },
  {
    key: 'core-change', role: 'core', schema: FINDINGS_SCHEMA,
    prompt: `LENS: CORE_CHANGE_TITLE. Read REGION_LIST. Construct interleavings and answer with line-by-line evidence:
QUESTION_LIST (lost wakeup, double owner, lock order, resource ownership, state left inconsistent on failure, what a
revert would cost). Report confirmations briefly.`,
  },
  {
    key: 'tests', role: 'task', schema: FINDINGS_SCHEMA,
    prompt: `LENS: Test quality. Scope with "git diff BASE_OR_PREVIOUS..HEAD" restricted to the repository's test sources
(TEST_PATH_PATTERNS, for example '*Test*.java', '*_test.go', 'tests/**'). For each new or changed test: pins the claimed
behaviour; deterministic (no sleeps; bounded waits only); no reflection or unsafe access into private state; resources
released; assertions specific; a real negative control (would it fail against the previous code?). Flag rows that
silently do not run in CI, assertions that are tautological, and timing-dependent waits. Cite lines.`,
  },
  {
    key: 'docs-hygiene', role: 'lookup', schema: FINDINGS_SCHEMA,
    prompt: `LENS: Documentation, configuration and hygiene. Check every behavioural statement in API docs, config docs,
conf files, the PR body and the local PR-body draft against the code at the frozen revision; list each statement that is
false, stale or unsupported. Check commit messages for the repository's title convention, trailers and accuracy. Scan
the diff for the repository's own style rules (STYLE_RULES, taken from its CLAUDE.md, CONTRIBUTING or coding guide:
for example line length, log levels, license headers, import or include conventions).`,
  },
  {
    key: 'contrarian', role: 'brain', schema: FINDINGS_SCHEMA,
    prompt: `LENS: Contrarian regression hunt. Try to break the change. Hypotheses to confirm or refute with source:
HYPOTHESIS_LIST. Also: anything else in the diff that looks wrong, and whether any commit bundles unrelated work.`,
  },
]

phase('Find')
log(`Profile ${PROFILE}; running ${LENSES.length} lenses`)
const results = await parallel(LENSES.map(l => () =>
  agent(CTX + '\n\n' + l.prompt, { label: `find:${l.key}`, phase: 'Find', schema: l.schema, model: P[l.role].model, effort: P[l.role].effort })
))
const byKey = {}
LENSES.forEach((l, i) => { byKey[l.key] = results[i] })
const checklist = byKey['checklist']
const findings = LENSES.filter(l => l.key !== 'checklist').flatMap(l => {
  const r = byKey[l.key]
  return r ? (r.findings || []).map(f => ({ ...f, lens: l.key })) : []
})
const missing = LENSES.filter((l, i) => !results[i]).map(l => l.key)
if (missing.length) log(`WARNING: lenses returned null: ${missing.join(', ')}`)

// Verify only what could change the verdict; low-severity items and confirmations pass through labelled.
const toVerify = findings.filter(f => f.severity !== 'low' && f.kind !== 'confirmation')
const capped = toVerify.slice(0, P.verifyCap)
if (toVerify.length > capped.length) log(`Verification capped at ${P.verifyCap} of ${toVerify.length} non-low findings`)
log(`Collected ${findings.length} findings; verifying ${capped.length} with ${P.verify.model}`)

phase('Verify')
const verified = await parallel(capped.map(f => () =>
  agent(CTX + `\n\nYou are an adversarial verifier. Try to REFUTE this finding strictly against the frozen source at REVISION (and earlier revisions via git show where the finding compares revisions). Reproduce any interleaving line by line. If the claim is only partly right, give the corrected claim. TIME BOX: three minutes.\n\nFINDING (lens ${f.lens}, ${f.severity}, ${f.kind}): ${f.title}\nClaim: ${f.claim}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`,
    { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: P.verify.model,
      effort: (f.severity === 'high' && PROFILE !== 'tight') ? 'xhigh' : P.verify.effort })
    .then(v => ({ ...f, verdict: v || { verdict: 'unverifiable', reasoning: 'verifier returned null', severity_adjustment: 'keep' } }))
))
const verifiedIds = new Set(capped.map(f => f.id + f.lens))
return {
  profile: PROFILE,
  lensSummaries: LENSES.map(l => ({ lens: l.key, model: P[l.role].model, effort: P[l.role].effort, summary: byKey[l.key] ? byKey[l.key].summary : null })),
  checklist,
  verified: verified.filter(Boolean),
  unverified: findings.filter(f => !verifiedIds.has(f.id + f.lens)),
}
