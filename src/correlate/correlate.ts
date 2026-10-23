/**
 * Decide which agent sessions (and which parts of them) produced this PR.
 *
 * 1. Keep only the records that belong to this repo: in the time window, and run
 *    inside a repo root, on the PR branch, or editing a file in the repo. Work a
 *    session did in other repos never reaches the digest.
 * 2. Score each session from edit survival (its added lines still in the PR diff),
 *    a PR link, branch, time overlap, working directory and repo-touching commands.
 * 3. Attribute each PR line to the sessions whose edits match it.
 */
import { dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isPathUnder, pathKey } from '@showtail/agent-traces/paths/pathUtil';
import type { PrTruth } from '../git/pr.ts';
import { mentionsAnyRoot, rootOf, underAnyRoot } from '../trace/pathMatch.ts';
import type { TraceRecord, TraceSession } from '../trace/types.ts';

export const INCLUDE_AT = 0.5;
export const AMBIGUOUS_AT = 0.25;
/** Lines this short or punctuation-only are too common to count as evidence. */
const MIN_LINE_CHARS = 4;

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** Commits bound the window: 8h before the first, 30m after the last (or now). */
export function windowFor(truth: PrTruth, nowMs = Date.now()): TimeWindow {
  if (truth.commits.length === 0)
    return { startMs: nowMs - 7 * 24 * 3600_000, endMs: nowMs };
  const first = Math.min(...truth.commits.map((c) => c.authorTime));
  const last = Math.max(...truth.commits.map((c) => c.commitTime));
  return {
    startMs: first - 8 * 3600_000,
    endMs: truth.dirty ? nowMs : last + 30 * 60_000,
  };
}

/** Whitespace-normalized line, or undefined if it's too trivial to be evidence. */
export function evidenceLine(line: string): string | undefined {
  const n = line.replace(/\s+/g, ' ').trim();
  if (n.length < MIN_LINE_CHARS) return undefined;
  if (!/[A-Za-z0-9]/.test(n)) return undefined;
  return n;
}

export type Band = 'included' | 'ambiguous' | 'excluded';

export interface SessionMatch {
  session: TraceSession;
  /** Records that belong to this repo and window. */
  kept: TraceRecord[];
  droppedForeign: number;
  score: number;
  band: Band;
  reasons: string[];
  signals: {
    survival: number;
    matchedLines: number;
    agentAddedLines: number;
    prLink: boolean;
    branch: boolean;
    timeOverlap: number;
    cwdInRepo: boolean;
    commandsTouchRepo: boolean;
  };
  /** Full SHAs of PR commits this session made. */
  commitsMade: string[];
  /** Repo roots used for this session, including former worktrees it worked in. */
  roots: string[];
  /** Repo-relative file -> normalized lines this session added there. */
  addedByFile: Map<string, Set<string>>;
  /** Edits whose lines did not survive into the PR. */
  discardedEdits: number;
}

function inWindow(ts: string | undefined, w: TimeWindow): boolean {
  if (!ts) return true;
  const t = Date.parse(ts);
  return !Number.isFinite(t) || (t >= w.startMs && t <= w.endMs);
}

function repoRel(truth: PrTruth, abs: string): string | undefined {
  const root = rootOf(abs, truth.roots);
  return root ? relative(root, abs).split(/[\\/]/).join('/') : undefined;
}

function belongs(r: TraceRecord, truth: PrTruth, w: TimeWindow): boolean {
  if (r.kind === 'link') {
    if (r.prNumber !== undefined && truth.pr) return r.prNumber === truth.pr.number;
    return underAnyRoot(r.worktreePath, truth.roots);
  }
  if (!inWindow(r.ts, w)) return false;
  if (underAnyRoot(r.cwd, truth.roots)) return true;
  if (r.branch && r.branch === truth.head && truth.head !== 'HEAD') {
    // Same branch name in an unrelated repo is possible; require no conflicting cwd.
    return !r.cwd;
  }
  if (r.kind === 'edit') return underAnyRoot(r.file, truth.roots);
  if (r.kind === 'command') return mentionsAnyRoot(r.cmd, truth.roots);
  return false;
}

/** Prompts and replies have no path; keep them when their turn did repo work. */
function keepConversation(records: TraceRecord[], keepFlags: boolean[]): void {
  let turnStart = -1;
  const flush = (end: number) => {
    if (turnStart < 0) return;
    const any = keepFlags.slice(turnStart, end).some(Boolean);
    if (!any) return;
    for (let i = turnStart; i < end; i++) {
      const k = records[i]!.kind;
      if (k === 'prompt' || k === 'assistant' || k === 'usage' || k === 'decision')
        keepFlags[i] = true;
    }
  };
  records.forEach((r, i) => {
    if (r.kind === 'prompt') {
      flush(i);
      turnStart = i;
    }
  });
  flush(records.length);
}

/**
 * A prompt typed in the folder that directly contains the repo (a workspace folder
 * like ~/Development) is usually about the repo: keep it as context when it comes
 * before the session's repo work. Only one level up, so a session in the home
 * folder about other projects never leaks in.
 */
function keepParentFolderPrompts(
  records: TraceRecord[],
  keepFlags: boolean[],
  truth: PrTruth,
  w: TimeWindow,
): void {
  const parents = new Set(truth.roots.map((r) => pathKey(dirname(resolve(r)))));
  let lastKept = -1;
  keepFlags.forEach((k, i) => {
    if (k && records[i]!.kind !== 'link') lastKept = i;
  });
  for (let i = 0; i < lastKept; i++) {
    const r = records[i]!;
    if (keepFlags[i] || !r.cwd) continue;
    const isUserPrompt = r.kind === 'prompt' && !r.delegated;
    if (!isUserPrompt && r.kind !== 'plan' && r.kind !== 'decision') continue;
    if (inWindow(r.ts, w) && parents.has(pathKey(r.cwd))) keepFlags[i] = true;
  }
}

function shaPatterns(truth: PrTruth): RegExp[] {
  return truth.commits.map((c) => new RegExp(`\\b${c.sha.slice(0, 7).toLowerCase()}`));
}

/**
 * Folders (outside today's roots) where commands printed a PR commit SHA: worktrees
 * or clones of this repo that may since have been removed. Never the home folder or
 * a folder that contains the repo, so `git -C repo log` from a parent adds nothing.
 */
export function formerRootsOf(
  records: TraceRecord[],
  truth: PrTruth,
  home = homedir(),
): string[] {
  const pats = shaPatterns(truth);
  if (!pats.length) return [];
  const out = new Set<string>();
  for (const r of records) {
    if (r.kind !== 'command' || !r.cwd || !r.output) continue;
    if (underAnyRoot(r.cwd, truth.roots)) continue;
    if (pathKey(r.cwd) === pathKey(home)) continue;
    if (truth.roots.some((root) => isPathUnder(root, r.cwd!))) continue;
    const text = r.output.toLowerCase();
    if (pats.some((p) => p.test(text))) out.add(resolve(r.cwd));
  }
  return [...out];
}

/** PR commits whose SHA shows up in output of commands the session ran (git commit/push/log). */
export function commitsMadeBy(kept: TraceRecord[], truth: PrTruth): string[] {
  const out = kept
    .filter((r): r is Extract<TraceRecord, { kind: 'command' }> => r.kind === 'command')
    .map((r) => r.output ?? '')
    .join('\n')
    .toLowerCase();
  if (!out) return [];
  return truth.commits
    .map((c) => c.sha)
    .filter((sha) => new RegExp(`\\b${sha.slice(0, 7).toLowerCase()}`).test(out));
}

export function prLineIndex(truth: PrTruth): {
  byFile: Map<string, string[]>;
  total: number;
} {
  const byFile = new Map<string, string[]>();
  let total = 0;
  for (const f of truth.files) {
    const lines = f.added.map(evidenceLine).filter((l): l is string => !!l);
    byFile.set(f.path, lines);
    total += lines.length;
  }
  return { byFile, total };
}

export function matchSession(
  session: TraceSession,
  truth: PrTruth,
  w: TimeWindow,
  prLines: ReturnType<typeof prLineIndex>,
): SessionMatch {
  const records = session.records;
  // A PR commit's SHA in command output proves the session worked on this repo,
  // even from a worktree that no longer exists. Treat such folders as repo roots.
  const commitsMade = commitsMadeBy(records, truth);
  const formerRoots = formerRootsOf(records, truth);
  const view: PrTruth = formerRoots.length
    ? { ...truth, roots: [...truth.roots, ...formerRoots] }
    : truth;
  const flags = records.map((r) => belongs(r, view, w));
  keepConversation(records, flags);
  keepParentFolderPrompts(records, flags, view, w);
  const kept = records.filter((_, i) => flags[i]);
  const droppedForeign = records.length - kept.length;

  const addedByFile = new Map<string, Set<string>>();
  let discardedEdits = 0;
  for (const r of kept) {
    if (r.kind !== 'edit') continue;
    const rel = repoRel(view, r.file);
    if (!rel) continue;
    const set = addedByFile.get(rel) ?? new Set<string>();
    let survived = false;
    const prSet = new Set(prLines.byFile.get(rel) ?? []);
    for (const l of r.added) {
      const e = evidenceLine(l);
      if (!e) continue;
      set.add(e);
      if (prSet.has(e)) survived = true;
    }
    if (!survived && r.added.length > 0) discardedEdits++;
    addedByFile.set(rel, set);
  }

  let agentAddedLines = 0;
  let matchedLines = 0;
  for (const [file, set] of addedByFile) {
    agentAddedLines += set.size;
    const pr = new Set(prLines.byFile.get(file) ?? []);
    for (const l of set) if (pr.has(l)) matchedLines++;
  }
  const survival = agentAddedLines ? matchedLines / agentAddedLines : 0;
  const prLink = kept.some(
    (r) => r.kind === 'link' && truth.pr !== undefined && r.prNumber === truth.pr.number,
  );
  const branch = kept.some((r) => r.branch === truth.head && truth.head !== 'HEAD');
  const cwdInRepo = kept.some((r) => underAnyRoot(r.cwd, view.roots));
  const commandsTouchRepo = kept.some(
    (r) => r.kind === 'command' && mentionsAnyRoot(r.cmd, view.roots),
  );

  const times = kept.map((r) => (r.ts ? Date.parse(r.ts) : NaN)).filter(Number.isFinite);
  let timeOverlap = 0;
  if (times.length && truth.commits.length) {
    // How much of the session's repo work falls in the stretch leading up to the
    // commits (from 2h before the first to 30m after the last).
    const s0 = Math.min(...times);
    const s1 = Math.max(...times);
    const c0 = Math.min(...truth.commits.map((c) => c.authorTime)) - 2 * 3600_000;
    const c1 = Math.max(...truth.commits.map((c) => c.commitTime)) + 30 * 60_000;
    const inter = Math.max(0, Math.min(s1, c1) - Math.max(s0, c0));
    timeOverlap = s1 > s0 ? inter / (s1 - s0) : s0 >= c0 && s0 <= c1 ? 1 : 0;
  } else if (times.length) timeOverlap = 1;

  // One surviving line is weak evidence, unless it is most of a small PR.
  const coverage = prLines.total ? matchedLines / prLines.total : 0;
  const editEvidence = survival * Math.min(1, Math.max(matchedLines / 5, coverage));
  const reasons: string[] = [];
  let score: number;
  if (prLink) {
    score = 1;
    reasons.push(`session linked itself to PR #${truth.pr!.number}`);
  } else if (commitsMade.length) {
    score = 0.9;
    reasons.push(
      `session made ${commitsMade.length} of the PR's ${truth.commits.length} commit(s)`,
    );
  } else {
    score =
      0.5 * editEvidence +
      0.15 * (branch ? 1 : 0) +
      0.15 * timeOverlap +
      0.1 * (cwdInRepo ? 1 : 0) +
      0.1 * (commandsTouchRepo ? 1 : 0);
  }
  if (matchedLines) {
    reasons.push(
      `${matchedLines} of its ${agentAddedLines} added lines are in the PR diff`,
    );
  } else if (agentAddedLines) {
    reasons.push(`its ${agentAddedLines} added lines are not in the PR diff`);
  }
  if (branch) reasons.push(`worked on branch ${truth.head}`);
  if (cwdInRepo) reasons.push('ran inside this repository');
  if (commandsTouchRepo) reasons.push('ran commands against this repository');
  if (timeOverlap > 0)
    reasons.push(`time overlap with commits ${(timeOverlap * 100).toFixed(0)}%`);
  if (kept.filter((r) => r.kind !== 'link').length === 0) score = 0;

  const band: Band =
    score >= INCLUDE_AT ? 'included' : score >= AMBIGUOUS_AT ? 'ambiguous' : 'excluded';
  return {
    session,
    kept,
    droppedForeign,
    score: Math.round(score * 100) / 100,
    band,
    reasons,
    signals: {
      survival,
      matchedLines,
      agentAddedLines,
      prLink,
      branch,
      timeOverlap,
      cwdInRepo,
      commandsTouchRepo,
    },
    addedByFile,
    discardedEdits,
    commitsMade,
    roots: view.roots,
  };
}

export interface FileAttribution {
  path: string;
  added: number;
  removed: number;
  /** Evidence lines (non-trivial added lines) in this file. */
  evidenceLines: number;
  bySession: Map<string, number>;
  unmatched: number;
}

/** For each PR file: how many of its added lines match each session's edits. */
export function attribute(
  truth: PrTruth,
  prLines: ReturnType<typeof prLineIndex>,
  matches: SessionMatch[],
): FileAttribution[] {
  return truth.files.map((f) => {
    const lines = prLines.byFile.get(f.path) ?? [];
    const bySession = new Map<string, number>();
    let unmatched = 0;
    for (const l of lines) {
      let hit = false;
      for (const m of matches) {
        if (m.addedByFile.get(f.path)?.has(l)) {
          bySession.set(
            m.session.sessionId,
            (bySession.get(m.session.sessionId) ?? 0) + 1,
          );
          hit = true;
        }
      }
      if (!hit) unmatched++;
    }
    return {
      path: f.path,
      added: f.added.length,
      removed: f.removed.length,
      evidenceLines: lines.length,
      bySession,
      unmatched,
    };
  });
}
