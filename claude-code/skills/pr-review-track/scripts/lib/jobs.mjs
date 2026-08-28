// The job queue's state machine, as pure functions over plain objects.
//
// Nothing here touches the filesystem. The rules that matter — what may start,
// what a dead session leaves behind, when a retry is the wrong answer — are
// exactly the things worth deciding without a temp store in the way.
//
// The queue itself is not a file: it is every tracked PR whose pr.json carries
// a `job`. Archiving a PR therefore takes its job with it, and no reconciling
// pass between two records of the same thing can ever be needed.

import { randomBytes } from 'node:crypto';

export const JOB_KINDS = new Set(['review', 're-review', 'revise']);

/** What you asked for just now outranks a batch you set going earlier. */
export const PRIORITY = { now: 0, batch: 10 };

/** Two starts. A third would spend the budget again on a failure that repeats. */
export const RETRY_CAP = 2;

export const mintToken = () => randomBytes(12).toString('hex');

export function newJob({ kind, priority = 'batch', instructions = null, since = null, tier = null, now = Date.now() } = {}) {
  if (!JOB_KINDS.has(kind)) throw new Error(`not a job kind: ${kind}`);
  if (!(priority in PRIORITY)) throw new Error(`not a priority: ${priority}`);
  return {
    kind,
    state: 'queued',
    priority: PRIORITY[priority],
    queuedAt: new Date(now).toISOString(),
    startedAt: null,
    committedAt: null,
    owner: null,
    attempts: 0,
    tier,
    payload: { instructions, since },
    lastError: null,
  };
}

export function orderQueue(entries) {
  return [...entries].sort(
    (a, b) => (a.job.priority - b.job.priority) || (Date.parse(a.job.queuedAt) - Date.parse(b.job.queuedAt)),
  );
}

export function startedJob(job, { session, token, now = Date.now() }) {
  return {
    ...job,
    state: 'running',
    startedAt: new Date(now).toISOString(),
    committedAt: null,
    owner: { session, attemptToken: token },
    attempts: job.attempts + 1,
  };
}

export function failedJob(job, { error, now = Date.now() } = {}) {
  const parked = job.attempts >= RETRY_CAP;
  return {
    ...job,
    state: parked ? 'failed' : 'queued',
    owner: null,
    startedAt: parked ? job.startedAt : null,
    lastError: String(error ?? 'failed'),
    failedAt: new Date(now).toISOString(),
  };
}

export function finishedJob(job, { outcome, now = Date.now() } = {}) {
  return {
    kind: job.kind,
    outcome: String(outcome ?? '').trim() || 'done',
    attempts: job.attempts,
    finishedAt: new Date(now).toISOString(),
  };
}

/**
 * Decide what this session should do next, without doing any of it.
 *
 * Reaping is a consequence of one drainer per repository rather than a
 * mechanism of its own: a running job owned by a different session can only
 * mean that session is gone, so no heartbeat and no timeout are involved.
 *
 * The one case that is not a retry is a job that already wrote its file.
 * Re-running that would regenerate a draft for nothing, or — worse — re-apply a
 * revision to bytes it already revised, shortening comments that were shortened
 * once already.
 */
export function planNext(entries, { session, maxConcurrent = 4, max = Infinity, now = Date.now(), mintToken: mint = mintToken } = {}) {
  const recovered = [];
  const reaped = [];
  const running = [];
  const queue = [];

  for (const e of entries) {
    if (!e.job) continue;
    // `failed` is parked for a human. Picking it back up is `job add`, which is
    // somebody deciding to spend on it again.
    if (e.job.state === 'failed') continue;

    if (e.job.state === 'running') {
      if (e.job.owner?.session === session) { running.push(e); continue; }
      if (e.job.committedAt) {
        recovered.push({
          ...e,
          lastJob: finishedJob(e.job, { outcome: 'recovered — its draft was written before the session ended', now }),
        });
        continue;
      }
      const next = failedJob(e.job, { error: 'the session running it ended', now });
      reaped.push({ ...e, job: next });
      if (next.state === 'queued') queue.push({ ...e, job: next });
      continue;
    }
    queue.push(e);
  }

  const slots = Math.max(0, Math.min(maxConcurrent - running.length, max));
  const start = orderQueue(queue).slice(0, slots)
    .map((e) => ({ ...e, job: startedJob(e.job, { session, token: mint(), now }) }));

  return { start, reaped, recovered, running };
}
