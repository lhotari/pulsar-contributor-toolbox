// One-time migration from pr-review-track's file store (~/.claude/pr-review-track): every repository it tracked
// joins the desk, and every unsubmitted review.md (draft/hold) becomes a draft review round with its body,
// inline comments, thread replies and conversation replies. skip → ignored. Nothing is posted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as db from './db.mjs';
import { addRepo } from './repos.mjs';
import { track, refreshItem } from './triage.mjs';
import { importFindings } from './review.mjs';

const PRT_ROOT = process.env.PRT_ROOT || path.join(os.homedir(), '.claude', 'pr-review-track');

export async function importPrt({ root = PRT_ROOT, repo = null, log = console.log } = {}) {
  const { parseActionFile } = await import('../../../pr-review-track/scripts/lib/actionfile.mjs');
  const out = { repos: 0, drafts: 0, ignored: 0, skipped: [] };
  for (const owner of fs.readdirSync(root).filter((d) => !d.startsWith('_') && fs.statSync(path.join(root, d)).isDirectory())) {
    for (const name of fs.readdirSync(path.join(root, owner))) {
      const slug = `${owner}/${name}`; const dir = path.join(root, owner, name);
      if (!fs.statSync(dir).isDirectory() || (repo && repo !== slug)) continue;
      const prs = fs.readdirSync(dir).filter((d) => /^pr-\d+$/.test(d));
      if (!prs.length) continue;
      if (!db.get('SELECT 1 FROM repos WHERE slug = ?', slug)) { addRepo(slug, {}); out.repos++; }
      for (const d of prs) {
        const number = Number(d.slice(3));
        const file = path.join(dir, d, 'review.md');
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        const parsed = parseActionFile(text);
        if (!['draft', 'hold', 'skip'].includes(parsed.status)) continue;
        if (db.currentReview(slug, number)) { out.skipped.push(`${slug}#${number}: already on the desk`); continue; }
        try {
          await track(slug, number);
          const pr = db.pr(slug, number);
          if (pr.state !== 'OPEN') { out.skipped.push(`${slug}#${number}: ${pr.state.toLowerCase()}`); continue; }
          if (parsed.status === 'skip') {
            db.run(`UPDATE items SET hold = 'ignored', hold_note = 'skipped in pr-review-track' WHERE repo = ? AND number = ?`, slug, number);
            refreshItem(slug, number); out.ignored++; continue;
          }
          const head = parsed.doc.head;
          if (!head) { out.skipped.push(`${slug}#${number}: review.md has no head`); continue; }
          // The diff the draft was written against, from prt's cache, so the anchors validate at that commit.
          const cached = path.join(dir, d, 'cache', 'diff.patch');
          const target = path.join(db.prDir(slug, number), `diff-${head}.patch`);
          if (head !== pr.head_sha && fs.existsSync(cached) && !fs.existsSync(target)) fs.copyFileSync(cached, target);
          if (head !== pr.head_sha && !fs.existsSync(target)) { out.skipped.push(`${slug}#${number}: head moved and no cached diff`); continue; }
          const findings = {
            schema: 1, repo: slug, pr: number, head, kind: parsed.doc.kind || 'initial',
            summary: parsed.bodyText || '', recommendedEvent: parsed.event === 'REPLY' || parsed.event === 'NONE' ? 'COMMENT' : parsed.event,
            reviewers: ['imported from pr-review-track'],
            findings: parsed.inline.map((c) => ({ id: c.id, path: c.path, line: c.subject === 'range' ? c.startLine : c.line,
              endLine: c.subject === 'range' ? c.line : null, side: c.side, subject: c.subject === 'file' ? 'file' : 'line', body: c.body, post: c.post })),
            threadAssessments: parsed.threads.map((t) => ({ threadId: t.threadNodeId, assessment: 'IMPORTED', reply: t.post ? t.body : null, resolve: t.resolve })),
            issueCommentAssessments: parsed.issueComments.map((c) => ({ url: null, reply: c.body })),
          };
          const r = await importFindings(slug, number, findings, { kind: findings.kind });
          db.run(`UPDATE reviews SET meta = json_set(meta, '$.importedFrom', ?) WHERE id = ?`, file, r.review);
          if (parsed.status === 'hold') db.run(`UPDATE items SET note = COALESCE(note, 'held in pr-review-track') WHERE repo = ? AND number = ?`, slug, number);
          refreshItem(slug, number);
          out.drafts++; log(`${slug}#${number}: imported ${r.comments} comment(s)`);
        } catch (e) { out.skipped.push(`${slug}#${number}: ${e.message}`); }
      }
    }
  }
  return out;
}
