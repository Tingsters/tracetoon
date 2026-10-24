/**
 * Optional, skippable notes for the author, shown beside the draft. Each names
 * something a reviewer may want that the captured evidence doesn't cover, says
 * what *was* captured, and never claims something wasn't done (it may have
 * happened outside the logs). Nothing here blocks or asks before drafting.
 */
import type { TraceDigest } from './build.ts';
import type { ClaimFinding } from './claims.ts';

export interface ContextNote {
  topic: 'validation' | 'ui' | 'rationale' | 'attribution' | 'review';
  text: string;
}

const UI_FILE =
  /\.(css|scss|sass|less|html|tsx|jsx|vue|svelte|xaml|storyboard|swiftui)$/i;
const CAUSAL =
  /\b(because|so that|in order to|to avoid|to keep|since|which means|otherwise|so the|so it)\b/i;
const REVIEW_POINTER =
  /\b(start (with|at|in|by)|where to (start|look)|review(ing|ers?)? (should|could)? ?(start|focus|look))/i;
const VISUAL =
  /\b(screenshot|by eye|visually|in the browser|manually checked|looked at)\b/i;

export function contextNotes(
  digest: Pick<TraceDigest, 'sessions' | 'files' | 'stats'>,
  body: string,
  claims: ClaimFinding[] = [],
): ContextNote[] {
  const notes: ContextNote[] = [];
  const included = digest.sessions.filter((s) => s.band === 'included');
  const runs = included
    .flatMap((s) => s.runs ?? [])
    .filter((r) => r.revision !== 'after later work');
  const behavior = digest.files.filter((f) => (f.role ?? 'behavior') === 'behavior');
  const behaviorAdded = behavior.reduce((n, f) => n + f.added, 0);

  if (behavior.length && !runs.length)
    notes.push({
      topic: 'validation',
      text: 'No test, build or check result was captured for this change. If you ran checks elsewhere (CI, another terminal), add a line saying what ran.',
    });
  const tests = runs.filter((r) => r.kind === 'test');
  const lastTest = tests[tests.length - 1];
  if (lastTest && lastTest.revision === 'before later edits' && !/\bbefore\b/i.test(body))
    notes.push({
      topic: 'validation',
      text: `The last captured test run (${lastTest.cmd}) was before the final edits. Re-run it, or say it passed before them.`,
    });
  if (digest.files.some((f) => UI_FILE.test(f.path)) && !VISUAL.test(body))
    notes.push({
      topic: 'ui',
      text: 'This changes UI files and no visual check was captured. If you looked at it, add what you checked or a screenshot.',
    });
  const decided = included.some(
    (s) => s.decisions.length || s.plans.some((p) => p.approved),
  );
  if (behavior.length && !decided && !CAUSAL.test(body))
    notes.push({
      topic: 'rationale',
      text: "The trace doesn't record why this approach was taken. Add a sentence if reviewers will wonder.",
    });
  if (digest.stats.unmatchedPct > 50)
    notes.push({
      topic: 'attribution',
      text: `About ${digest.stats.unmatchedPct}% of the added lines aren't matched to captured agent edits (formatters, shell edits, other tools or hand edits). Say so if parts were written another way and it helps reviewers.`,
    });
  if (behaviorAdded > 300 && !REVIEW_POINTER.test(body))
    notes.push({
      topic: 'review',
      text: 'This is a large change; a line on where to start reviewing helps.',
    });
  // Claims the check couldn't establish are already marked beside the text.
  void claims;
  return notes;
}

/**
 * An outline of the evidence for authors who write the description themselves
 * (or must, by the repo's policy). Facts only, grouped; no prose to copy.
 */
export function evidenceNotes(
  digest: Pick<TraceDigest, 'sessions' | 'files' | 'pr'>,
): string {
  const included = digest.sessions.filter((s) => s.band === 'included');
  const lines: string[] = ['# Notes to write from', ''];
  const asks = included.flatMap((s) =>
    s.prompts.filter((p) => p.ledToEdits || p.pushback),
  );
  if (asks.length) {
    lines.push('## What was asked (your prompts that shaped the change)');
    for (const p of asks)
      lines.push(
        `- ${p.text.replace(/\s+/g, ' ').slice(0, 200)}${p.pushback ? ' _(pushback)_' : ''}`,
      );
    lines.push('');
  }
  const decisions = included.flatMap((s) =>
    s.decisions.flatMap((d) => d.questions ?? []),
  );
  if (decisions.length) {
    lines.push('## Decisions you made');
    for (const q of decisions)
      lines.push(
        `- ${q.question} → ${q.answer ?? '(answer not recorded)'}${q.ownWords ? ' _(in your own words)_' : ''}`,
      );
    lines.push('');
  }
  const plans = included.flatMap((s) => s.plans);
  if (plans.length) {
    lines.push('## Plans');
    for (const p of plans)
      lines.push(
        `- ${p.approved === false ? 'Sent back' : p.approved ? 'Approved' : 'Proposed'}: ${p.excerpt.split('\n')[0]!.replace(/^#+\s*/, '')}`,
      );
    lines.push('');
  }
  const runs = included
    .flatMap((s) => s.runs ?? [])
    .filter((r) => r.revision !== 'after later work');
  const lastByKind = new Map(
    runs.map((r) => [`${r.kind}:${r.cmd.split(' ').slice(0, 2).join(' ')}`, r]),
  );
  if (lastByKind.size) {
    lines.push('## Checks captured (last run of each)');
    for (const r of lastByKind.values())
      lines.push(
        `- \`${r.cmd}\`: ${r.outcome}${r.summary.length ? ` (${r.summary.join(', ')})` : ''}; ${r.revision}`,
      );
    lines.push('');
  }
  const byRole = new Map<string, string[]>();
  for (const f of digest.files) {
    const role = f.role ?? 'behavior';
    byRole.set(role, [...(byRole.get(role) ?? []), f.path]);
  }
  lines.push('## What changed, by role');
  for (const [role, paths] of byRole)
    lines.push(
      `- ${role}: ${paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', ')}`,
    );
  if (digest.pr.dirty)
    lines.push('', '_Uncommitted changes existed when this was made._');
  return lines.join('\n') + '\n';
}
