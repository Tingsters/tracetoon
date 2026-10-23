/**
 * Provenance other tools may already have recorded in the repo. Tracetoon never
 * requires them; when present they are reported so the description can mention
 * them (and a reviewer knows where to find full transcripts).
 *
 * - Entire (entire.io): an `Entire-Checkpoint: <id>` trailer per commit, with the
 *   checkpoint stored under `refs/entire/checkpoints/...`.
 * - git-ai: line-authorship notes under `refs/notes/ai`.
 */
import type { PrTruth } from './pr.ts';
import { git } from '../util/exec.ts';

export interface Interop {
  entire?: { checkpoints: string[]; commitsWithCheckpoint: number; refsPresent: boolean };
  gitAi?: { commitsWithNotes: number };
}

export function detectInterop(truth: PrTruth): Interop {
  const out: Interop = {};
  const checkpoints = truth.commits.flatMap((c) =>
    Object.entries(c.trailers)
      .filter(([k]) => k.toLowerCase() === 'entire-checkpoint')
      .flatMap(([, v]) => v),
  );
  if (checkpoints.length) {
    const refs = git(truth.toplevel, [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      'refs/entire/',
    ]);
    out.entire = {
      checkpoints: [...new Set(checkpoints)].slice(0, 20),
      commitsWithCheckpoint: truth.commits.filter((c) =>
        Object.keys(c.trailers).some((k) => k.toLowerCase() === 'entire-checkpoint'),
      ).length,
      refsPresent: refs.ok && refs.stdout.trim().length > 0,
    };
  }
  const notes = git(truth.toplevel, ['notes', '--ref=ai', 'list']);
  if (notes.ok && notes.stdout.trim()) {
    const annotated = new Set(
      notes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/)[1])
        .filter(Boolean),
    );
    const n = truth.commits.filter((c) => annotated.has(c.sha)).length;
    if (n) out.gitAi = { commitsWithNotes: n };
  }
  return out;
}
