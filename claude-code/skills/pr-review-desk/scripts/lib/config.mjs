// Per-repository configuration: who counts as a priority author, how PRs are scored, and which rules
// decide what gets an AI review without asking. Stored in repos.config; anything missing comes from here.

export const DEFAULTS = {
  // Authors that always sort first, in order (prt's priorityAuthors).
  priorityAuthors: ['merlimat'],
  // Never shown in the backlog.
  ignoreAuthors: ['dependabot[bot]', 'github-actions[bot]', 'renovate[bot]'],
  ignoreTitle: [],                      // regexes; e.g. "^\\[improve\\]\\[ci\\]"
  ignoreLabels: [],
  // How many open PRs sync looks at (most recently updated first), on top of every PR I engaged with.
  poolSize: 150,
  includeDrafts: false,
  // Extra weights on top of prt's ranking. Committers (write access or ASF/org membership) get a boost.
  weights: {
    committer: 150,                     // author has write access to the repo, or is an org MEMBER/OWNER
    categories: { fix: 40, revert: 40, pip: 25, feat: 15, improve: 10, deps: 0, test: -10, ci: -10, doc: -20, cleanup: -15 },
    labels: {},                         // label → weight, e.g. {"release/blocker": 300}
    paths: [],                          // [{ pattern: "^pulsar-broker/src/main/.*/service/", weight: 30, why: "broker service" }]
  },
  // Rules applied on every sync. Nothing here can post: the human always checks and submits.
  auto: {
    scan: true,                         // deterministic security scan of every new head (no tokens)
    review: {                           // initial AI reviews, only while the repo's Autopilot switch is on
      minScore: 250,
      maxQueued: 2,                     // queued + running review jobs for the repo
      maxPerDay: 8,
      committersOnly: false,
      skipDrafts: true,
      maxLines: 3000,
      requireScan: 'scanned',           // the scan must not have flagged the PR
    },
    reReview: {                         // follow-up reviews, also only while Autopilot is on
      onHeadMoved: true,
      onAuthorReply: true,
      maxQueued: 2,
    },
    // Budget gate: pause automatic reviews when either quota is in this state.
    pauseWhenClaudeTier: ['codex'],
    pauseWhenCodexBudget: ['critical'],
  },
  // Claude Code workers.
  runner: 'headless',                   // headless (claude -p) | interactive (a Claude Code session claims jobs)
  maxClaudeWorkers: 2,
  model: null,                          // model for the worker harness (null: Claude Code default)
  permissionMode: 'auto',
  syncMinutes: 15,
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function effective(config) { return merge(DEFAULTS, config || {}); }

/** Shallow-validates a config patch from the UI or CLI; returns the merged stored config. */
export function apply(stored, patch) {
  const next = merge(stored || {}, patch || {});
  const eff = effective(next);
  if (!['headless', 'interactive'].includes(eff.runner)) throw new Error(`runner must be headless or interactive`);
  for (const re of [...eff.ignoreTitle, ...eff.weights.paths.map((p) => p.pattern)]) {
    try { new RegExp(re); } catch (e) { throw new Error(`bad regex ${re}: ${e.message}`); }
  }
  return next;
}
