/** Discover sessions, read them, and match them against the PR. */
import {
  matchSession,
  prLineIndex,
  windowFor,
  type SessionMatch,
} from './correlate/correlate.ts';
import { prTruth, type PrTruth, type TruthOptions } from './git/pr.ts';
import { ADAPTERS } from './trace/registry.ts';

export interface ScanResult {
  truth: PrTruth;
  matches: SessionMatch[];
  warnings: string[];
}

export function scan(cwd: string, opts: TruthOptions = {}): ScanResult {
  const truth = prTruth(cwd, opts);
  const window = windowFor(truth);
  const prLines = prLineIndex(truth);
  const matches: SessionMatch[] = [];
  const warnings: string[] = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.home()) continue;
    for (const ref of adapter.discover({ roots: truth.roots, sinceMs: window.startMs })) {
      const session = adapter.read(ref);
      warnings.push(...session.warnings);
      matches.push(matchSession(session, truth, window, prLines));
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return { truth, matches, warnings };
}
