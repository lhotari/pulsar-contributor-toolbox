// Workflow script template for a time-boxed, tiered review. Pass it inline to the Workflow tool after filling the
// ALL-CAPS placeholders and the three switches below (PROFILE, HAS_PREVIOUS_REVIEW, WORKTREE). Plain JavaScript:
// no TypeScript, no Date.now(), no filesystem. Deadlines come in through `args` (see SKILL.md "Deadlines"):
//   args = { findDeadlineEpoch, verifyDeadlineEpoch, hardDeadlineEpoch, agentMinutes, verifyMinutes }
//
// Sizing (see SKILL.md): 10 min -> 5-7 lenses, verify <= 8; 15 min -> 7-9 lenses, verify <= 12;
// 30 min -> 9-12 lenses, verify <= 20 plus a completeness critic.

export const meta = {
  name: 'timeboxed-review',
  description: 'Time-boxed tiered review of REVIEW_TARGET_DESCRIPTION',
  phases: [
    { title: 'Find', detail: 'independent lenses with models from the profile' },
    { title: 'Verify', detail: 'the profile\'s verify model refutes medium-or-higher findings, high severity first' },
  ],
}

// Switches.
const PROFILE = 'normal'              // 'normal' | 'high' | 'tight', see SKILL.md "Model policy"
const HAS_PREVIOUS_REVIEW = true      // false for a first review: the checklist lens checks stated claims instead
const WT = 'WORKTREE_PATH'            // the WORKTREE line printed by scripts/freeze-and-path.sh

const D = args || {}
const deadlineText = D.findDeadlineEpoch
  ? `Wall-clock deadline for your work: epoch ${D.findDeadlineEpoch} (about ${D.agentMinutes || 4} minutes from launch).
Run \`date +%s\` after each major read. Once past the deadline, stop reading, return what you have, set truncated=true.
Always set finished_at_epoch from \`date +%s\` just before you return.`
  : `TIME BOX: about ${D.agentMinutes || 4} minutes of work. Set finished_at_epoch from \`date +%s\` just before you return.`

// Everything every agent must know. Keep it factual.
const CTX = `
You are reviewing REVIEW_TARGET_DESCRIPTION, frozen in a detached git worktree at ${WT} (commit REVISION; base
BASE_REVISION). Work ONLY inside that directory with read-only commands (cat, sed -n, grep -rn with the repository's
source patterns SOURCE_PATTERNS, git show, git log, git diff). Do NOT edit files, run builds or tests, push, or post
anything. Cite every claim as file:line at REVISION. Prefer a few precise, source-cited findings over many vague ones.
${deadlineText}

What changed (oldest first): COMMIT_LIST_WITH_ONE_LINE_SUMMARIES
${HAS_PREVIOUS_REVIEW
  ? `Previous review: PREVIOUS_REVIEW_PATH (its recommended actions are the checklist). Response: RESPONSE_PATH.
Premises from the previous review that the response disputes; treat as OPEN questions, not facts: DISPUTED_PREMISES`
  : `First review. Stated claims to check against the code: CLAIMS_SOURCE (PR description, design document or commit messages).`}
User instructions for this review: USER_INSTRUCTIONS
Repository conventions to apply: STYLE_RULES (from its CLAUDE.md, CONTRIBUTING or coding guide).
Test conventions to apply: TEST_RULES (for example: no sleeps, no access to private state by reflection or unsafe
tricks, resources released; adapt to the language).
Key files at ${WT}: KEY_FILES_WITH_APPROXIMATE_LINES

Return ONLY the structured object.
`

const FINDING = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', enum: ['defect', 'gap', 'regression-risk', 'doc-issue', 'test-issue', 'confirmation', 'premise-correction'] },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    claim: { type: 'string' },
    evidence: { type: 'string', description: 'file:line citations at the frozen revision and the concrete facts' },
    recommendation: { type: 'string' },
  },
  required: ['id', 'title', 'kind', 'severity', 'claim', 'evidence', 'recommendation'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string', description: 'Two to four sentences' },
    findings: { type: 'array', maxItems: 6, items: FINDING },
    finished_at_epoch: { type: 'number' },
    truncated: { type: 'boolean' },
  },
  required: ['lens', 'summary', 'findings', 'finished_at_epoch'],
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
          item: { type: 'string', description: 'The earlier action, response row or stated claim, quoted briefly' },
          status: { type: 'string', enum: ['verified', 'partially-verified', 'not-verified', 'contradicted', 'deferred-to-follow-up'] },
          evidence: { type: 'string', description: 'file:line at the frozen revision, commit hash, or doc location' },
          note: { type: 'string' },
        },
        required: ['item', 'status', 'evidence'],
      },
    },
    finished_at_epoch: { type: 'number' },
    truncated: { type: 'boolean' },
  },
  required: ['lens', 'summary', 'items', 'finished_at_epoch'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'partially-confirmed', 'refuted', 'unverifiable'] },
    reasoning: { type: 'string', description: 'Source-cited at the frozen revision' },
    corrected_claim: { type: 'string' },
    severity_adjustment: { type: 'string', enum: ['keep', 'raise', 'lower'] },
    finished_at_epoch: { type: 'number' },
  },
  required: ['verdict', 'reasoning', 'severity_adjustment', 'finished_at_epoch'],
}

// Model profile (SKILL.md "Model policy"). Roles: lookup (very trivial), task (focused review), taskHard (difficult
// focused review), brain (concurrency, disputed premises, contrarian), core (the core-change lens), verify.
const PROFILES = {
  normal: {
    lookup:   { model: 'sonnet', effort: 'medium' },
    task:     { model: 'opus',   effort: 'medium' },
    taskHard: { model: 'opus',   effort: 'high' },
    brain:    { model: 'fable',  effort: 'high' },
    core:     { model: 'fable',  effort: 'xhigh' },
    verify:   { model: 'fable',  effort: 'high' },
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
    taskHard: { model: 'opus',   effort: 'medium' },
    brain:    { model: 'opus',   effort: 'medium' },
    core:     { model: 'opus',   effort: 'high' },
    verify:   { model: 'opus',   effort: 'medium' },
    verifyCap: 4,
  },
}
const P = PROFILES[PROFILE]
// Verify cap by time box overrides the profile default: 10 min 8, 15 min 12, 30 min 20 (halved under tight).
const VERIFY_CAP = P.verifyCap

// One entry per lens with its role. Replace the placeholders; add lenses for the repository type (see SKILL.md
// "Lens sets"). Every lens must be independent of the others.
const LENSES = [
  {
    key: 'checklist', role: 'lookup', schema: CHECKLIST_SCHEMA,
    prompt: HAS_PREVIOUS_REVIEW
      ? `LENS: Mechanical checklist. For EVERY recommended action in the previous review and EVERY row of the response's
disposition table, verify against the frozen source (not the response text) with file:line or test-method evidence, or
mark contradicted. Also verify: origin and local heads, that any amended commit changed only its message, that docs and
configuration files agree, and that stated validation artifacts exist and say what the response says. Presence only.`
      : `LENS: Stated claims. For EVERY behavioural claim in CLAIMS_SOURCE, verify against the frozen source with file:line
evidence, or mark contradicted or not-verified. Also verify that docs and configuration files agree with the code and
that commit messages describe what the diff does. Presence only; other lenses judge correctness.`,
  },
  {
    key: 'core-change', role: 'core', schema: FINDINGS_SCHEMA,
    prompt: `LENS: CORE_CHANGE_TITLE. Read REGION_LIST. Answer with line-by-line evidence: CORE_QUESTIONS (for concurrent
code: lost wakeup, double owner, lock order, ownership of resources, state after failure; for sequential code: invariants,
error paths, boundary conditions, compatibility of persisted or wire formats; for docs: every statement against the code
it describes). Report confirmations briefly.`,
  },
  {
    key: 'tests', role: 'task', schema: FINDINGS_SCHEMA,
    prompt: `LENS: Test quality. Scope with "git diff BASE_REVISION..REVISION" restricted to test sources (TEST_PATH_PATTERNS).
For each new or changed test: pins the claimed behaviour; deterministic (no sleeps; bounded waits only); follows
TEST_RULES; resources released; assertions specific; a real negative control (would it fail against the previous code?).
Flag test rows that silently do not run in CI, assertions that are tautological, and timing-dependent waits. Cite lines.`,
  },
  {
    key: 'docs-hygiene', role: 'lookup', schema: FINDINGS_SCHEMA,
    prompt: `LENS: Documentation and hygiene. Check every behavioural statement in API docs, configuration docs and files, the
PR description and DOC_DRAFTS against the code at the frozen revision; list each statement that is false, stale or
unsupported. Check commit messages against the repository's title convention and for accuracy. Scan the diff against
STYLE_RULES.`,
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
const missing = LENSES.filter((l, i) => !results[i]).map(l => l.key)
if (missing.length) log(`WARNING: lenses returned null: ${missing.join(', ')}`)
const truncated = LENSES.filter((l, i) => results[i] && results[i].truncated).map(l => l.key)
if (truncated.length) log(`Lenses that hit their deadline: ${truncated.join(', ')}`)
const checklist = byKey['checklist']

const findings = LENSES.filter(l => l.key !== 'checklist').flatMap(l => {
  const r = byKey[l.key]
  return r ? (r.findings || []).map(f => ({ ...f, lens: l.key, lensModel: P[l.role].model, lensEffort: P[l.role].effort })) : []
})
// Checklist rows that contradict the earlier record are claims too; verify up to three of them.
const contradicted = (checklist ? checklist.items : [])
  .filter(i => i.status === 'contradicted' || i.status === 'not-verified').slice(0, 3)
  .map((i, n) => ({ id: `CK${n + 1}`, title: `Checklist: ${i.item}`, kind: 'gap', severity: 'medium', claim: `Status ${i.status}: ${i.note || ''}`,
    evidence: i.evidence, recommendation: 'Confirm or refute the row against source', lens: 'checklist', lensModel: P.lookup.model, lensEffort: P.lookup.effort }))

// Deadline handling: verify what the clock allows, high severity first, deduplicated.
const latestFinish = Math.max(0, ...results.filter(Boolean).map(r => r.finished_at_epoch || 0))
let cap = VERIFY_CAP
let verifyMinutes = D.verifyMinutes || 3
let verifySkipped = false
if (D.hardDeadlineEpoch && latestFinish >= D.hardDeadlineEpoch) {
  verifySkipped = true
  log('Find phase passed the hard deadline; verification skipped, all findings reported as unverified')
} else if (D.verifyDeadlineEpoch && latestFinish >= D.verifyDeadlineEpoch) {
  cap = Math.max(2, Math.ceil(cap / 2))
  verifyMinutes = Math.max(1, Math.ceil(verifyMinutes / 2))
  log(`Find phase ran late; verify cap reduced to ${cap} and verifier box to ${verifyMinutes} min`)
}
const rank = { high: 0, medium: 1, low: 2 }
const normalize = t => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const seen = new Set()
const candidates = [...findings, ...contradicted]
  .filter(f => f.severity !== 'low' && f.kind !== 'confirmation')
  .sort((a, b) => rank[a.severity] - rank[b.severity])
  .filter(f => { const k = normalize(f.title).slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true })
const capped = verifySkipped ? [] : candidates.slice(0, cap)
if (candidates.length > capped.length) log(`Verification covers ${capped.length} of ${candidates.length} candidates`)

phase('Verify')
const verified = await parallel(capped.map(f => () => {
  const effort = (f.severity === 'high' && PROFILE !== 'tight') ? 'xhigh' : P.verify.effort
  return agent(CTX + `\n\nYou are an adversarial verifier. Try to REFUTE this finding strictly against the frozen source at REVISION (and earlier revisions via git show where the finding compares revisions). Reproduce any interleaving line by line. If the claim is only partly right, give the corrected claim. TIME BOX: ${verifyMinutes} minutes.\n\nFINDING (lens ${f.lens}, ${f.severity}, ${f.kind}): ${f.title}\nClaim: ${f.claim}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`,
    { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: P.verify.model, effort })
    .then(v => ({ ...f, verifierModel: P.verify.model, verifierEffort: effort,
      verdict: v || { verdict: 'unverifiable', reasoning: 'verifier returned null', severity_adjustment: 'keep' } }))
}))
const verifiedIds = new Set(capped.map(f => f.id + f.lens))
return {
  profile: PROFILE,
  timing: { latestFinishEpoch: latestFinish, verifySkipped, verifyCapUsed: capped.length, truncatedLenses: truncated, missingLenses: missing },
  lensSummaries: LENSES.map(l => ({ lens: l.key, model: P[l.role].model, effort: P[l.role].effort, summary: byKey[l.key] ? byKey[l.key].summary : null })),
  checklist,
  verified: verified.filter(Boolean),
  unverified: [...findings, ...contradicted].filter(f => !verifiedIds.has(f.id + f.lens)),
}
