/**
 * The trace digest: a compact, redacted JSON summary of how the PR was made, sized
 * to fit an LLM's context. The host agent writes the PR description from this.
 */
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import {
  attribute,
  evidenceLine,
  prLineIndex,
  type SessionMatch,
} from '../correlate/correlate.ts';
import { rootOf } from '../trace/pathMatch.ts';
import type { PrTruth } from '../git/pr.ts';
import type { Usage } from '../trace/types.ts';
import { clip, makeScrubber, type Scrubber } from './sanitize.ts';
import { TOOL_VERSION } from '../version.ts';
import { detectInterop, type Interop } from '../git/interop.ts';

export interface DigestSession {
  ref: string;
  agent: string;
  title?: string;
  models: string[];
  span: { start?: string; end?: string };
  usage: Usage | null;
  sessionCostUsd?: number;
  score: number;
  band: 'included' | 'ambiguous';
  reasons: string[];
  /** What the user typed. */
  prompts: { t?: string; text: string; ledToEdits: boolean }[];
  /** Tasks the agent handed to its own subagents. */
  delegations: { t?: string; text: string }[];
  /** Short SHAs of PR commits made during this session. */
  commitsMade: string[];
  plans: { t?: string; approved?: boolean; excerpt: string }[];
  /** Documents the agent kept for the session (Antigravity task, plan, walkthrough). */
  artifacts: { name: string; summary?: string; excerpt: string }[];
  decisions: { t?: string; text: string }[];
  commands: { cmd: string; count: number; failures: number; isTest: boolean }[];
  milestones: string[];
  filesEdited: string[];
  discardedEdits: number;
  unknownRecordTypes: Record<string, number>;
}

export interface TraceDigest {
  v: 1;
  tool: string;
  generatedAt: string;
  repo: { owner?: string; name?: string };
  pr: {
    number?: number;
    url?: string;
    title?: string;
    base: string;
    head: string;
    mergeBase: string;
    usedWorkingTree: boolean;
    commits: { sha: string; subject: string; trailers: Record<string, string[]> }[];
  };
  stats: {
    filesChanged: number;
    added: number;
    removed: number;
    evidenceLines: number;
    agentMatchedPct: number;
    unmatchedPct: number;
    /** PR commits made during the included sessions (catches shell-driven edits). */
    commitsMadeInSessions: number;
    commits: number;
  };
  sessions: DigestSession[];
  files: {
    path: string;
    added: number;
    removed: number;
    sessions: { ref: string; lines: number }[];
    unmatchedLines: number;
  }[];
  disclosure: {
    agents: string[];
    models: string[];
    suggestedTrailers: string[];
    existingTrailers: string[];
  };
  /** Provenance other tools recorded in the repo (Entire checkpoints, git-ai notes). */
  interop: Interop;
  privacy: { redactions: number; droppedForeignRecords: number; sessionIdsHashed: true };
  notes: string[];
  truncated: string[];
}

/** Test runners, matched against the program at the start of a command segment. */
const TEST_RUNNERS = [
  /^(bun|npm|yarn|pnpm|deno)\s+(run\s+)?test\b/,
  /^npx\s+(jest|vitest|mocha|playwright\s+test)\b/,
  /^(python3?\s+-m\s+)?(pytest|unittest|tox|nox)\b/,
  /^(jest|vitest|mocha|rspec|phpunit|ctest)\b/,
  /^(go|cargo|dotnet|swift|mix|zig)\s+test\b/,
  /^(mvn|gradle|\.\/gradlew|gradlew)\b.*\btest\b/,
  /^make\s+(test|check)\b/,
];

export function isTestCommand(cmd: string): boolean {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim().replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, ''))
    .some((s) => TEST_RUNNERS.some((re) => re.test(s)));
}

/** A short grouping key for a shell command: the program and its first argument. */
export function commandKey(cmd: string): string {
  const segments = cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(cd|set|export|pushd)\b/.test(s));
  const first = segments[0] ?? cmd.trim();
  const tokens = first
    .replace(/^[A-Z_][A-Z0-9_]*=\S*\s+/g, '')
    .split(/\s+/)
    .filter((t) => !/^-/.test(t));
  return tokens.slice(0, 2).join(' ') || first.slice(0, 40);
}

export function hashId(salt: string, id: string): string {
  return 'h:' + createHash('sha256').update(`${salt}\0${id}`).digest('hex').slice(0, 12);
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'antigravity-cli': 'Antigravity CLI',
  'antigravity-ide': 'Antigravity',
};

function sessionDigest(
  m: SessionMatch,
  ref: string,
  truth: PrTruth,
  prSets: Map<string, Set<string>>,
  scrub: Scrubber,
): DigestSession {
  const recs = m.kept;
  const models = new Set<string>();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  const prompts: DigestSession['prompts'] = [];
  const delegations: DigestSession['delegations'] = [];
  const artifacts: DigestSession['artifacts'] = [];
  const plans: DigestSession['plans'] = [];
  const decisions: DigestSession['decisions'] = [];
  const cmdGroups = new Map<
    string,
    { count: number; failures: number; isTest: boolean }
  >();
  const milestones: string[] = [];
  const files = new Set<string>();
  let testFailedEarlier = false;
  let current: { ledToEdits: boolean } | undefined;

  for (const r of recs) {
    if (r.model && !r.model.startsWith('<')) models.add(r.model);
    switch (r.kind) {
      case 'prompt': {
        if (r.delegated) {
          delegations.push({ t: r.ts, text: clip(scrub.text(r.text), 200) });
          break;
        }
        const p = { t: r.ts, text: clip(scrub.text(r.text), 400), ledToEdits: false };
        prompts.push(p);
        current = p;
        break;
      }
      case 'assistant':
        if (r.model) models.add(r.model);
        break;
      case 'usage':
        if (r.model && !r.model.startsWith('<')) models.add(r.model);
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        usage.cacheRead += r.usage.cacheRead;
        usage.cacheWrite += r.usage.cacheWrite;
        sawUsage = true;
        break;
      case 'plan':
        plans.push({
          t: r.ts,
          approved: r.approved,
          excerpt: clip(scrub.text(r.markdown), 1500),
        });
        if (r.approved) milestones.push('plan approved');
        break;
      case 'decision':
        decisions.push({ t: r.ts, text: clip(scrub.text(r.text), 300) });
        break;
      case 'edit': {
        const root = rootOf(r.file, m.roots);
        const rel = root ? relative(root, r.file).split(/[\\/]/).join('/') : undefined;
        if (rel) files.add(rel);
        if (current && rel) {
          const set = prSets.get(rel);
          if (
            set &&
            r.added.some((l) => {
              const e = evidenceLine(l);
              return !!e && set.has(e);
            })
          )
            current.ledToEdits = true;
        }
        break;
      }
      case 'command': {
        const key = clip(scrub.text(commandKey(r.cmd)), 60);
        const test = isTestCommand(r.cmd);
        const g = cmdGroups.get(key) ?? { count: 0, failures: 0, isTest: test };
        g.count++;
        if (r.isError) g.failures++;
        cmdGroups.set(key, g);
        if (test && r.isError) testFailedEarlier = true;
        if (test && !r.isError && testFailedEarlier) {
          milestones.push('tests went from failing to passing');
          testFailedEarlier = false;
        }
        break;
      }
      case 'link':
        if (r.prNumber) milestones.push(`linked to PR #${r.prNumber}`);
        break;
      case 'artifact':
        artifacts.push({
          name: r.name,
          summary: r.summary ? clip(scrub.text(r.summary), 300) : undefined,
          excerpt: clip(scrub.text(r.markdown), 1500),
        });
        break;
    }
  }
  if (files.size) milestones.push(`edited ${files.size} file(s)`);
  if (m.commitsMade.length)
    milestones.push(`made ${m.commitsMade.length} of the PR's commits`);
  if (m.discardedEdits)
    milestones.push(`${m.discardedEdits} edit(s) did not survive into the PR`);

  const times = recs
    .map((r) => r.ts)
    .filter((t): t is string => !!t)
    .sort();
  return {
    ref,
    agent: AGENT_LABEL[m.session.agent] ?? m.session.agent,
    title: m.session.title ? clip(scrub.text(m.session.title), 80) : undefined,
    models: [...models],
    span: { start: times[0], end: times[times.length - 1] },
    usage: sawUsage ? usage : null,
    sessionCostUsd: m.session.sessionCostUsd,
    score: m.score,
    band: m.band === 'included' ? 'included' : 'ambiguous',
    reasons: m.reasons,
    prompts,
    delegations: delegations.slice(0, 10),
    commitsMade: m.commitsMade.map((s) => s.slice(0, 12)),
    plans,
    artifacts,
    decisions,
    commands: [...cmdGroups.entries()]
      .map(([cmd, g]) => ({ cmd, ...g }))
      .sort((a, b) => Number(b.isTest) - Number(a.isTest) || b.count - a.count)
      .slice(0, 15),
    milestones: [...new Set(milestones)],
    filesEdited: [...files].sort(),
    discardedEdits: m.discardedEdits,
    unknownRecordTypes: m.session.unknownTypes,
  };
}

const estimateTokens = (o: unknown) => Math.ceil(JSON.stringify(o).length / 4);

/** Trim the digest until it fits the token budget, least important content first. */
function fitBudget(d: TraceDigest, budget: number): void {
  const steps: [string, () => boolean][] = [
    [
      'plan excerpts shortened to 600 chars',
      () => shrink((s) => s.plans.forEach((p) => (p.excerpt = clip(p.excerpt, 600)))),
    ],
    [
      'prompts that led to no surviving edits dropped',
      () =>
        shrink((s) => (s.prompts = s.prompts.filter((p, i) => p.ledToEdits || i === 0))),
    ],
    [
      'prompts shortened to 200 chars',
      () => shrink((s) => s.prompts.forEach((p) => (p.text = clip(p.text, 200)))),
    ],
    [
      'artifact excerpts shortened to 500 chars',
      () => shrink((s) => s.artifacts.forEach((a) => (a.excerpt = clip(a.excerpt, 500)))),
    ],
    ['delegations dropped', () => shrink((s) => (s.delegations = []))],
    ['decisions dropped', () => shrink((s) => (s.decisions = []))],
    [
      'commands limited to 5 per session',
      () => shrink((s) => (s.commands = s.commands.slice(0, 5))),
    ],
    ['file list limited to 40', () => ((d.files = d.files.slice(0, 40)), true)],
    [
      'plan excerpts shortened to 200 chars',
      () => shrink((s) => s.plans.forEach((p) => (p.excerpt = clip(p.excerpt, 200)))),
    ],
  ];
  function shrink(f: (s: DigestSession) => void): boolean {
    d.sessions.forEach(f);
    return true;
  }
  for (const [label, step] of steps) {
    if (estimateTokens(d) <= budget) return;
    step();
    d.truncated.push(label);
  }
}

/**
 * A forked or resumed session repeats its parent's history. Keep each prompt, plan
 * and decision only in the highest-scoring session that has it.
 */
function dedupeAcrossSessions(sessions: DigestSession[]): void {
  const seen = new Set<string>();
  const fresh = <T extends { t?: string }>(items: T[], text: (x: T) => string): T[] =>
    items.filter((x) => {
      const k = `${x.t ?? ''}|${text(x)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  for (const s of sessions) {
    s.prompts = fresh(s.prompts, (p) => p.text);
    s.delegations = fresh(s.delegations, (p) => p.text);
    s.plans = fresh(s.plans, (p) => p.excerpt);
    s.decisions = fresh(s.decisions, (p) => p.text);
  }
}

export interface BuildOptions {
  budgetTokens?: number;
  /** Session ids the user chose to include or exclude, overriding the bands. */
  include?: string[];
  exclude?: string[];
}

export function buildDigest(
  truth: PrTruth,
  matches: SessionMatch[],
  opts: BuildOptions = {},
): TraceDigest {
  const scrub = makeScrubber(truth.roots);
  const salt = truth.remote?.url ?? truth.toplevel;
  const prLines = prLineIndex(truth);
  const prSets = new Map([...prLines.byFile].map(([k, v]) => [k, new Set(v)]));

  const want = (m: SessionMatch) => {
    const h = hashId(salt, m.session.sessionId);
    if (opts.exclude?.some((x) => x === h || x === m.session.sessionId)) return false;
    if (opts.include?.some((x) => x === h || x === m.session.sessionId)) return true;
    return m.band !== 'excluded';
  };
  const chosen = matches.filter(want).sort((a, b) => b.score - a.score);
  const refOf = new Map(
    chosen.map((m) => [m.session.sessionId, hashId(salt, m.session.sessionId)]),
  );
  const sessions = chosen.map((m) => {
    const s = sessionDigest(m, refOf.get(m.session.sessionId)!, truth, prSets, scrub);
    if (opts.include?.some((x) => x === s.ref || x === m.session.sessionId))
      s.band = 'included';
    return s;
  });
  dedupeAcrossSessions(sessions);
  const commitsInSessions = new Set(chosen.flatMap((m) => m.commitsMade));

  const attribution = attribute(truth, prLines, chosen);
  const evidence = attribution.reduce((n, f) => n + f.evidenceLines, 0);
  const unmatched = attribution.reduce((n, f) => n + f.unmatched, 0);
  const pct = (x: number) => (evidence ? Math.round((x / evidence) * 100) : 0);

  const agents = [
    ...new Set(sessions.filter((s) => s.band === 'included').map((s) => s.agent)),
  ];
  const models = [
    ...new Set(sessions.filter((s) => s.band === 'included').flatMap((s) => s.models)),
  ];
  const existingTrailers = [
    ...new Set(
      truth.commits.flatMap((c) =>
        Object.entries(c.trailers)
          .filter(([k]) =>
            /^(co-authored-by|assisted-by|generated-by|ai-used-for)$/i.test(k),
          )
          .flatMap(([k, vs]) => vs.map((v) => `${k}: ${v}`)),
      ),
    ),
  ];
  const suggestedTrailers = sessions
    .filter((s) => s.band === 'included')
    .flatMap((s) =>
      (s.models.length ? s.models : ['unknown-model']).map(
        (m) => `Assisted-by: ${s.agent}:${m}`,
      ),
    );

  const notes: string[] = [];
  if (truth.usedWorkingTree)
    notes.push('No commits ahead of base yet; the digest describes uncommitted changes.');
  if (!sessions.length) notes.push('No agent sessions matched this change.');
  if (sessions.some((s) => s.band === 'ambiguous')) {
    notes.push(
      'Some sessions are ambiguous: confirm with the user before describing them as part of this PR.',
    );
  }

  const digest: TraceDigest = {
    v: 1,
    tool: `tracetoon@${TOOL_VERSION}`,
    generatedAt: new Date().toISOString(),
    repo: { owner: truth.remote?.owner, name: truth.remote?.name },
    pr: {
      number: truth.pr?.number,
      url: truth.pr?.url,
      title: truth.pr ? scrub.text(truth.pr.title) : undefined,
      base: truth.base,
      head: truth.head,
      mergeBase: truth.mergeBase.slice(0, 12),
      usedWorkingTree: truth.usedWorkingTree,
      commits: truth.commits.map((c) => ({
        sha: c.sha.slice(0, 12),
        subject: scrub.text(c.subject),
        trailers: c.trailers,
      })),
    },
    stats: {
      filesChanged: truth.files.length,
      added: truth.files.reduce((n, f) => n + f.added.length, 0),
      removed: truth.files.reduce((n, f) => n + f.removed.length, 0),
      evidenceLines: evidence,
      agentMatchedPct: pct(evidence - unmatched),
      unmatchedPct: pct(unmatched),
      commitsMadeInSessions: commitsInSessions.size,
      commits: truth.commits.length,
    },
    sessions,
    files: attribution.map((f) => ({
      path: scrub.text(f.path),
      added: f.added,
      removed: f.removed,
      sessions: [...f.bySession].map(([id, lines]) => ({ ref: refOf.get(id)!, lines })),
      unmatchedLines: f.unmatched,
    })),
    disclosure: {
      agents,
      models,
      suggestedTrailers: [...new Set(suggestedTrailers)],
      existingTrailers,
    },
    interop: detectInterop(truth),
    privacy: {
      redactions: 0,
      droppedForeignRecords: chosen.reduce((n, m) => n + m.droppedForeign, 0),
      sessionIdsHashed: true,
    },
    notes,
    truncated: [],
  };
  fitBudget(digest, opts.budgetTokens ?? 12000);
  digest.privacy.redactions = scrub.redactions;
  return digest;
}
