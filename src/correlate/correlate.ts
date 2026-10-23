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

/**
 * Commits bound the window: 8h before the first, 5m after the last. Work after
 * the last commit belongs to whatever comes next (git and the agents' logs share
 * this machine's clock, so a few minutes of slack is enough). Uncommitted
 * changes aren't part of the PR, so they don't stretch the window.
 */
export function windowFor(truth: PrTruth, nowMs = Date.now()): TimeWindow {
  if (truth.commits.length === 0) {
    // Uncommitted work: anything before the base commit is already in it.
    const week = nowMs - 7 * 24 * 3600_000;
    const base = truth.mergeBaseTime ? truth.mergeBaseTime - 30 * 60_000 : week;
    return { startMs: Math.max(week, base), endMs: nowMs };
  }
  const first = Math.min(...truth.commits.map((c) => c.authorTime));
  const last = Math.max(...truth.commits.map((c) => c.commitTime));
  return {
    startMs: first - 8 * 3600_000,
    endMs: last + 5 * 60_000,
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

/**
 * A file's path inside the repo, or undefined when it's outside every root or in
 * git's own folder (where Tracetoon's run files live).
 */
export function repoRel(truth: Pick<PrTruth, 'roots'>, abs: string): string | undefined {
  const root = rootOf(abs, truth.roots);
  if (!root) return undefined;
  const rel = relative(root, abs).split(/[\\/]/).join('/');
  return rel === '.git' || rel.startsWith('.git/') ? undefined : rel;
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

/** A user prompt that opens a turn (not a subagent task, not feedback on a rejected tool call). */
function isTurnStart(r: TraceRecord): boolean {
  return r.kind === 'prompt' && !r.delegated && !r.feedback;
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
    if (isTurnStart(r)) {
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

type CommandRecord = Extract<TraceRecord, { kind: 'command' }>;

/**
 * When the session made each commit: its SHA in a command's output (git commit,
 * git log, git push), or its subject in the message of a `git commit` command
 * (quiet commits print no SHA). Returns SHA -> time of the first such command.
 */
export function commitMoments(
  records: TraceRecord[],
  commits: { sha: string; subject: string }[],
): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const commands = records.filter((r): r is CommandRecord => r.kind === 'command');
  for (const c of commits) {
    const sha = new RegExp(`\\b${c.sha.slice(0, 7).toLowerCase()}`);
    const subject =
      c.subject.trim().length >= 12 ? c.subject.trim().toLowerCase() : undefined;
    for (const r of commands) {
      const byOutput = r.output ? sha.test(r.output.toLowerCase()) : false;
      const bySubject =
        !!subject &&
        /\bgit\b[^\n]*\bcommit\b/i.test(r.cmd) &&
        r.cmd.toLowerCase().includes(subject);
      if (byOutput || bySubject) {
        found.set(c.sha, r.ts);
        break;
      }
    }
  }
  return found;
}

/** PR commits the session made. */
export function commitsMadeBy(records: TraceRecord[], truth: PrTruth): string[] {
  return [...commitMoments(records, truth.commits).keys()];
}

/**
 * The moment this session last committed work that is already in the base
 * branch. Anything the session finished before then belongs to earlier PRs.
 */
export function earlierWorkCutoff(
  records: TraceRecord[],
  truth: PrTruth,
): number | undefined {
  const base = truth.baseCommits ?? [];
  if (!base.length) return undefined;
  // Only base commits made before this PR's own work began count. Work merged
  // into the base later (another PR, then `git merge main` into this branch)
  // must not push the cutoff past this PR's edits.
  const firstOwn = truth.commits.length
    ? Math.min(...truth.commits.map((c) => c.authorTime))
    : Number.POSITIVE_INFINITY;
  const times = [...commitMoments(records, base).values()]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t) && t < firstOwn);
  return times.length ? Math.max(...times) : undefined;
}

/**
 * Drop records from turns that ended before the cutoff. A turn that crosses it
 * keeps its conversation (the request may have started this PR too) but loses
 * work done before the cutoff.
 */
function dropEarlierWork(records: TraceRecord[], flags: boolean[], cutoff: number): void {
  const starts = records.map((r, i) => (isTurnStart(r) ? i : -1)).filter((i) => i >= 0);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const at = (r: TraceRecord) => (r.ts ? Date.parse(r.ts) : NaN);
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]!;
    const to = starts[k + 1] ?? records.length;
    // A turn's work is its edits; commands after them (tests, publishing) don't
    // make an earlier piece of work part of this PR.
    const turn = records.slice(from, to);
    const edits = turn.filter((r) => r.kind === 'edit');
    const times = (edits.length ? edits : turn).map(at).filter(Number.isFinite);
    const end = times.length ? Math.max(...times) : NaN;
    for (let i = from; i < to; i++) {
      const r = records[i]!;
      if (r.kind === 'link' || r.kind === 'artifact') continue;
      if (Number.isFinite(end) && end <= cutoff) flags[i] = false;
      else if (
        at(r) <= cutoff &&
        !['prompt', 'plan', 'decision', 'assistant', 'usage'].includes(r.kind)
      ) {
        flags[i] = false;
      }
    }
  }
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
  const cutoff = earlierWorkCutoff(records, truth);
  if (cutoff !== undefined) dropEarlierWork(records, flags, cutoff);
  // A session's own plan/task/walkthrough files describe the session as a whole:
  // keep them whenever the session did work in this repo.
  if (flags.some((f, i) => f && records[i]!.kind !== 'link')) {
    records.forEach((r, i) => {
      if (r.kind === 'artifact') flags[i] = true;
    });
  }
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

  // Two ways edits prove a session belongs: most of what it wrote is in the PR
  // (survival; one line is weak evidence unless it's most of a small PR), or it
  // wrote most of what the PR adds (coverage; long sessions whose earlier work
  // already merged have low survival but high coverage).
  const coverage = prLines.total ? matchedLines / prLines.total : 0;
  const editEvidence = Math.max(
    survival * Math.min(1, Math.max(matchedLines / 5, coverage)),
    coverage,
  );
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
  if (!agentAddedLines && !commitsMade.length && !prLink) {
    // Looking around a repo (reading, running tools) is not the same as building
    // the change. Planning-only sessions on the PR branch still reach "ambiguous".
    score *= 0.6;
    reasons.push('made no edits or commits here');
  }
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
