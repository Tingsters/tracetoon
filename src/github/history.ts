/**
 * The only thing Tracetoon reads back from earlier PRs: which art styles the
 * repo's recent comics used, so a new comic picks something different. Each
 * PR carries its style in its own metadata; nothing else is remembered.
 */
import type { PrTruth } from '../git/pr.ts';
import { gh } from '../util/exec.ts';
import { decodeMeta } from './body.ts';

/** How many recent PRs to look at. */
const LOOK_BACK = 20;

export function repoWeb(truth: PrTruth): string | undefined {
  if (process.env.TRACETOON_REPO_WEB) return process.env.TRACETOON_REPO_WEB;
  return truth.remote
    ? `https://github.com/${truth.remote.owner}/${truth.remote.name}`
    : undefined;
}

/** Styles of this repo's latest comics, newest first (empty offline or without gh). */
export function recentStyles(truth: PrTruth, opts: { offline?: boolean } = {}): string[] {
  if (opts.offline) return [];
  const r = gh(truth.toplevel, [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(LOOK_BACK),
    '--search',
    '"tracetoon:meta" in:body',
    '--json',
    'number,body',
  ]);
  if (!r.ok) return [];
  try {
    const rows = JSON.parse(r.stdout) as { number: number; body: string }[];
    return rows
      .sort((a, b) => b.number - a.number)
      .map((p) => decodeMeta(p.body)?.style)
      .filter((s): s is string => !!s)
      .slice(0, 5);
  } catch {
    return [];
  }
}
