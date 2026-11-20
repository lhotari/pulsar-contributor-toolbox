# pr-review-desk design

## Pieces

```
SKILL.md                 routing for the user's session and the worker contract
scripts/prd.mjs          CLI (no command posts to GitHub)
scripts/lib/db.mjs       SQLite schema (node:sqlite), helpers; PRD_HOME (default ~/.claude/pr-review-desk)
scripts/lib/prt.mjs      re-exports from pr-review-track/scripts/lib: gh (retries), batched GraphQL, pending-review
                         mutations, diff anchors, permalinks, ranking, analyzePr, the outgoing-text lints
scripts/lib/config.mjs   per-repo rules and their defaults
scripts/lib/triage.mjs   sync, scoring, categories, committer detection, lanes, the scan entry point
scripts/lib/scan.mjs     deterministic security scan of a diff
scripts/lib/review.mjs   findings → draft, edits, stage (pending review), sync from GitHub, submit, discard
scripts/lib/jobs.mjs     Claude Code jobs: queue, worker prompt and deny lists, worktrees, budget
scripts/lib/autopilot.mjs  background loop: sync when due, scan new heads, apply the auto-review rules
scripts/lib/server.mjs   HTTP API + static UI (127.0.0.1, Host check, token header, CSP)
scripts/lib/importprt.mjs  one-time migration from pr-review-track's files
scripts/web/             the UI (no dependencies)
test/                    end-to-end test with a stateful fake gh
```

## Tables

- `repos` — slug, local checkout and remote (for worktrees), enabled, autopilot, config JSON.
- `prs` — GitHub facts plus `analysis` (prt's analyzePr: my last review and SHA, my threads with states, new comments).
- `items` — the desk's view: lane, score + reasons, category/component, flags (committer, review-requested, first-timer, priority-author, rule-ignored), scan + gate (per head), the human's hold and note.
- `reviews` — one row per round: kind, status (draft → staged → submitted, or discarded), the head it read, body, recommended and chosen event, GitHub review ids, meta (reviewers, coverage, tier, dropped findings, thread assessments, warnings), acknowledged lint labels.
- `comments` — inline / file / reply / issue; body and the AI's original; include flag; source (ai, human, github); state (local, staged, posted, removed, failed); GitHub ids; anchor error.
- `jobs` — Claude Code work with the pinned head, scratch dir, worktree, log, Claude session (for resuming with the human's answer).
- `events`, `authors` (write-permission cache), `meta` (token, login, budget reading, server pid).

## Stage / submit

- **Stage**: lints over everything that would post (staged text is outgoing text) → fresh PR node and head → adopt the user's existing pending review if there is one (GitHub allows one per reviewer and PR), else `addPullRequestReview` at the reviewed commit → `addPullRequestReviewThread` per comment, `addPullRequestReviewThreadReply` per reply → read the review's comments back for node ids. A failure marks that comment `failed` with GitHub's message; the rest stay staged.
- **Edits after staging**: `updatePullRequestReviewComment` / `deletePullRequestReviewComment`. Re-anchoring a staged comment means removing it and adding a new one.
- **Sync from GitHub**: the pending review's comments; ours are matched by id (body edits come back, deletions mark `removed`), new ones are imported as `source: github`. A review that is no longer pending was submitted on GitHub; a 404 means it was discarded there.
- **Submit**: head check (moved → explicit confirmation; comments stay on the reviewed commit), lints, stage what is not staged, sync, `POST …/reviews/{id}/events` with the human's event and body, then conversation replies (`issues/{n}/comments`) and thread resolutions.

## Extending

- A new score input: add it to `scoreItem` in triage.mjs with a reason string, and a weight to `config.mjs` DEFAULTS.
- A new auto rule: `ruleCandidates` in autopilot.mjs; keep it explainable (the UI's preview lists what matches).
- A new scan rule: `PATTERNS` or `SURFACES` in scan.mjs; add a case to the test. Keep high severity for shapes that have no business in a PR.
- Another job type: `TYPES` and `workerPrompt` in jobs.mjs, an action in server.mjs, a button in app.js, a section in SKILL.md.
