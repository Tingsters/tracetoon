/** Discover sessions, read them, and match them against the PR. */
import {
  matchSession,
  prLineIndex,
  windowFor,
  type SessionMatch,
} from './correlate/correlate.ts';
import { prTruth, type PrTruth, type TruthOptions } from './git/pr.ts';
import { ADAPTERS } from './trace/registry.ts';
import type { TraceSession } from './trace/types.ts';
import { join } from 'node:path';
import { tasks } from './workflow/state.ts';

export interface ScanResult {
  truth: PrTruth;
  matches: SessionMatch[];
  warnings: string[];
}

/**
 * Fold subagent logs into the session that spawned them, so a parent and its
 * helpers read as one piece of work. A subagent whose parent wasn't found stays
 * on its own.
 */
export function foldSubagents(sessions: TraceSession[]): TraceSession[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const out: TraceSession[] = [];
  for (const s of sessions) {
    const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    if (parent && parent !== s) {
      parent.records.push(...s.records);
      parent.warnings.push(...s.warnings);
      for (const [k, v] of Object.entries(s.unknownTypes)) {
        parent.unknownTypes[k] = (parent.unknownTypes[k] ?? 0) + v;
      }
    } else out.push(s);
  }
  for (const s of out) s.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  return out;
}

export function scan(cwd: string, opts: TruthOptions = {}): ScanResult {
  const truth = prTruth(cwd, opts);
  const window = windowFor(truth);
  const prLines = prLineIndex(truth);
  const warnings: string[] = [];
  const needles = truth.commits.map((c) => c.sha.slice(0, 7));
  const sessions: TraceSession[] = [];
  const activeTranscript = tasks(truth.gitDir).find(
    (t) =>
      t.task.branch === truth.head && t.task.state !== 'published' && t.task.transcript,
  )?.task.transcript;
  for (const adapter of ADAPTERS) {
    if (!adapter.home()) continue;
    for (const ref of adapter.discover({
      roots: truth.roots,
      sinceMs: window.startMs,
      needles,
      cacheDir: join(truth.gitDir, 'tracetoon', 'discovery'),
      currentSessionPath: activeTranscript,
    })) {
      const session = adapter.read(ref);
      warnings.push(...session.warnings);
      sessions.push(session);
    }
  }
  const matches = foldSubagents(sessions).map((s) =>
    matchSession(s, truth, window, prLines),
  );
  matches.sort((a, b) => b.score - a.score);
  return { truth, matches, warnings };
}
