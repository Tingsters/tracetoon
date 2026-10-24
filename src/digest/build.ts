/**
 * The trace digest: a compact, redacted JSON summary of how the PR was made, sized
 * to fit an LLM's context. The host agent writes the PR description from this.
 */
import { createHash } from 'node:crypto';
import {
  attribute,
  evidenceLine,
  prLineIndex,
  repoRel,
  type SessionMatch,
} from '../correlate/correlate.ts';
import type { PrTruth } from '../git/pr.ts';
import type { Usage } from '../trace/types.ts';
import { clip, makeScrubber, type Scrubber } from './sanitize.ts';
import { TOOL_VERSION } from '../version.ts';
import { detectInterop, type Interop } from '../git/interop.ts';
import { splitCommands } from '../util/shell.ts';

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
  /**
   * What the user typed. `id` (S1, S2…) lets text cite it. `ledToEdits`: led to
   * edits that survive in the PR. `pushback`: typed while rejecting the agent's
   * action, so it steers or corrects what the agent was doing.
   */
  prompts: {
    id?: string;
    t?: string;
    text: string;
    ledToEdits: boolean;
    pushback?: boolean;
  }[];
  /** Tasks the agent handed to its own subagents. */
  delegations: { t?: string; text: string }[];
  /** Short SHAs of PR commits made during this session. */
  commitsMade: string[];
  /** `approved: false` means sent back; that alone doesn't mean its design was rejected. */
  plans: { id?: string; t?: string; approved?: boolean; excerpt: string }[];
  /** Documents the agent kept for the session (Antigravity task, plan, walkthrough). */
  artifacts: { name: string; summary?: string; excerpt: string }[];
  /**
   * Questions the user answered. `questions` (when the log has them) keeps the
   * options and the exact answer. An option that wasn't picked is only that:
   * not picked. `ownWords`: the user answered in their own words.
   */
  decisions: {
    id?: string;
    t?: string;
    text: string;
    questions?: {
      question: string;
      options: string[];
      answer?: string;
      ownWords?: boolean;
    }[];
  }[];
  commands: { cmd: string; count: number; failures: number; isTest: boolean }[];
  /** Individual verification runs (tests, builds, linters, type checks, evals). */
  runs: Run[];
  milestones: string[];
  filesEdited: string[];
  discardedEdits: number;
  unknownRecordTypes: Record<string, number>;
}

/**
 * One verification run, as captured. `outcome` says what the log shows and
 * `basis` how we know: the command's exit status, its output, or neither (e.g.
 * a pipe hid the status). `revision` relates the run to the final change and is
 * never certified by timestamps alone:
 *  - `before later edits`: files in the PR were edited after this run;
 *  - `no later edits seen`: no edit to PR files was captured after it (edits
 *    outside the logs, or a dirty tree, are still possible);
 *  - `after later work`: it ran after the PR's last commit and after further
 *    edits to PR files, so it tested code that isn't this PR (the session kept
 *    going); it is not evidence about this PR either way;
 *  - `unknown`: no timestamp to compare.
 */
export interface Run {
  id?: string;
  t?: string;
  cmd: string;
  kind: 'test' | 'build' | 'lint' | 'typecheck' | 'eval' | 'other';
  outcome: 'passed' | 'failed' | 'unknown';
  basis: 'exit status' | 'output' | 'none';
  /** Up to three result lines from the output, e.g. "96 pass", "0 fail". */
  summary: string[];
  revision: 'before later edits' | 'no later edits seen' | 'after later work' | 'unknown';
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
    /** Uncommitted changes existed when the digest was made: runs may have tested code that isn't in the PR. */
    dirty?: boolean;
    commits: {
      sha: string;
      subject: string;
      trailers: Record<string, string[]>;
      time?: string;
    }[];
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
    /** What the file is for, to help point reviewers at the logic first. */
    role?: FileRole;
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
  /** Other PR numbers the included sessions linked themselves to (Claude pr-link). */
  linkedPrs: number[];
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

/** The part of a chained command that runs tests, if any. */
export function testSegment(cmd: string): string | undefined {
  return splitCommands(cmd)
    .map((s) => s.replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, ''))
    .find((s) => TEST_RUNNERS.some((re) => re.test(s)));
}

export function isTestCommand(cmd: string): boolean {
  return testSegment(cmd) !== undefined;
}

/**
 * Whether test output reports failures. Needed because a piped run
 * (`bun test | tail`) exits with the last program's status, not the tests'.
 */
export function testOutputFailed(output: string | undefined): boolean {
  if (!output) return false;
  return (
    /(^|\s)([1-9]\d*) (fail|failed|failing|failures?)\b/im.test(output) || // bun, pytest, mocha, vitest
    /^Tests?:.*\b[1-9]\d* failed/im.test(output) || // jest
    /^(FAIL|not ok)\b/m.test(output) || // jest file lines, TAP
    /^test result: FAILED/m.test(output) || // cargo
    /^--- FAIL:/m.test(output) // go
  );
}

export type FileRole = 'behavior' | 'tests' | 'docs' | 'config' | 'generated' | 'version';

/** A rough role for a changed file, from its path. */
export function fileRole(path: string): FileRole {
  const p = path.toLowerCase();
  if (
    /(^|\/)(dist|build|vendor|node_modules)\/|\.min\.(js|css)$|(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock)$/.test(
      p,
    )
  )
    return 'generated';
  if (/(^|\/)(version|version\.txt)$|(^|\/)src\/version\.ts$/.test(p)) return 'version';
  if (
    /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/.test(
      p,
    )
  )
    return 'tests';
  if (/\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//.test(p)) return 'docs';
  if (
    /\.(json|ya?ml|toml|ini|cfg|lock)$|(^|\/)\.github\/|(^|\/)\.[a-z]+rc(\.[a-z]+)?$/.test(
      p,
    )
  )
    return 'config';
  return 'behavior';
}

const VERIFY: [Run['kind'], RegExp][] = [
  ['typecheck', /^((bun|npx|pnpm|yarn)\s+(x\s+)?)?(tsc|mypy|pyright)\b/],
  [
    'lint',
    /^((bun|npx|pnpm|yarn)\s+(x\s+)?)?(eslint|prettier\s+--check|ruff\s+(check|format\s+--check)|biome\s+(check|lint)|clippy|golangci-lint)\b|^cargo\s+clippy\b|^go\s+vet\b/,
  ],
  [
    'build',
    /^((bun|npm|pnpm|yarn)\s+run\s+(build|bundle|compile)\b|cargo\s+build\b|go\s+build\b|make(\s|$)|bun\s+build\b)/,
  ],
  ['eval', /^(bun|node|python3?|deno)\s+(run\s+)?\S*(eval|bench)\S*/],
];

/** The part of a command that verifies something, and what kind of check it is. */
export function verificationSegment(
  cmd: string,
): { seg: string; kind: Run['kind'] } | undefined {
  const test = testSegment(cmd);
  if (test) return { seg: test, kind: 'test' };
  for (const s of splitCommands(cmd).map((x) =>
    x.replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, ''),
  )) {
    for (const [kind, re] of VERIFY) if (re.test(s)) return { seg: s, kind };
  }
  return undefined;
}

const RESULT_LINE =
  /(\b\d+\s+(pass|passed|passing|fail|failed|failing|errors?|warnings?)\b|\b\d+\/\d+\s+checks?\b|^Tests?:\s|\btest result:|All matched files use|Found \d+ errors?)/i;

/** What a captured run shows, and how we know. */
export function runOutcome(
  cmd: string,
  seg: string,
  isError: boolean | undefined,
  output: string | undefined,
  kind: Run['kind'],
): Pick<Run, 'outcome' | 'basis' | 'summary'> {
  const summary = (output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => RESULT_LINE.test(l))
    .slice(-3)
    .map((l) => l.slice(0, 120));
  const isTest = kind === 'test';
  if (isTest && testOutputFailed(output))
    return { outcome: 'failed', basis: 'output', summary };
  // A failing check stops an && chain, so the tool reports an error. After
  // `;` or a pipe, the exit status belongs to a later command.
  const after = cmd
    .slice(cmd.indexOf(seg) + seg.length)
    .replace(/\d*>&\d+/g, '') // redirections like 2>&1 aren't separators
    .trimStart();
  const masked = /^(;|\|(?!\|))/.test(after) || /^[^&|;]*(;|\|(?!\|))/.test(after);
  // With the status masked, an error belongs to a later command (e.g. a grep
  // that found nothing), so judge by the output instead.
  if (isError === true && !masked)
    return { outcome: 'failed', basis: 'exit status', summary };
  if (!masked) return { outcome: 'passed', basis: 'exit status', summary };
  // Type checkers print nothing when they pass.
  if (kind === 'typecheck' && !/error/i.test(output ?? ''))
    return { outcome: 'passed', basis: 'output', summary };
  if (
    summary.length &&
    !summary.some((l) => /\b[1-9]\d*\s+(fail|failed|failing|errors?)\b/i.test(l))
  )
    return { outcome: 'passed', basis: 'output', summary };
  return { outcome: 'unknown', basis: 'none', summary };
}

/** A short grouping key for a shell command: the program and its first argument. */
export function commandKey(cmd: string): string {
  const segments = splitCommands(cmd).filter((s) => !/^(cd|set|export|pushd)\b/.test(s));
  const first = segments[0] ?? cmd.trim();
  const tokens = first
    .replace(/^[A-Z_][A-Z0-9_]*=\S*\s+/g, '')
    .split(/\s+/)
    .filter((t) => !/^(-|<|>|\d>)/.test(t)); // flags, heredocs and redirections
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
  const runs: Run[] = [];
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
        const p: DigestSession['prompts'][number] = {
          t: r.ts,
          text: clip(scrub.text(r.text), 400),
          ledToEdits: false,
          ...(r.feedback ? { pushback: true } : {}),
        };
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
        decisions.push({
          t: r.ts,
          text: clip(scrub.text(r.text), 300),
          ...(r.questions?.length
            ? {
                questions: r.questions.map((q) => ({
                  question: clip(scrub.text(q.question), 200),
                  options: q.options.map((o) => clip(scrub.text(o), 80)),
                  ...(q.answer !== undefined
                    ? { answer: clip(scrub.text(q.answer), 400) }
                    : {}),
                  ...(q.ownWords !== undefined ? { ownWords: q.ownWords } : {}),
                })),
              }
            : {}),
        });
        break;
      case 'edit': {
        const rel = repoRel({ roots: m.roots }, r.file);
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
        const verify = verificationSegment(r.cmd);
        if (verify) {
          runs.push({
            t: r.ts,
            cmd: clip(scrub.text(verify.seg), 120),
            kind: verify.kind,
            ...runOutcome(r.cmd, verify.seg, r.isError, r.output, verify.kind),
            revision: 'unknown',
          });
        }
        const seg = testSegment(r.cmd);
        const test = seg !== undefined;
        const key = clip(scrub.text(commandKey(seg ?? r.cmd)), 60);
        const failed = r.isError === true || (test && testOutputFailed(r.output));
        const g = cmdGroups.get(key) ?? { count: 0, failures: 0, isTest: test };
        g.count++;
        if (failed) g.failures++;
        cmdGroups.set(key, g);
        if (test && failed) testFailedEarlier = true;
        if (test && !failed && testFailedEarlier) {
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
  // Relate each run to later edits of files in the PR (never certifies a revision).
  const prEditTimes = recs
    .filter((r) => r.kind === 'edit' && r.ts)
    .filter((r) => {
      const rel = repoRel({ roots: m.roots }, (r as { file: string }).file);
      return !!rel && prSets.has(rel);
    })
    .map((r) => Date.parse(r.ts!));
  // The PR's last commit, when it is a committed range (not the working tree).
  const headTime = truth.usedWorkingTree
    ? undefined
    : Math.max(0, ...truth.commits.map((c) => c.commitTime ?? 0)) || undefined;
  for (const run of runs) {
    if (!run.t) continue;
    const at = Date.parse(run.t);
    run.revision =
      headTime !== undefined &&
      at > headTime &&
      prEditTimes.some((e) => e > headTime && e < at)
        ? 'after later work'
        : prEditTimes.some((e) => e > at)
          ? 'before later edits'
          : 'no later edits seen';
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
    runs: runs.slice(-25),
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
      'runs limited to the last 10 per session',
      () => shrink((s) => (s.runs = s.runs.slice(-10))),
    ],
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

/** Give prompts, decisions, plans and runs short ids (S1, D1, P1, R1) the text can cite. */
function numberFacts(sessions: DigestSession[]): void {
  const n = { S: 0, D: 0, P: 0, R: 0 };
  for (const s of sessions) {
    for (const p of s.prompts) p.id = `S${++n.S}`;
    for (const d of s.decisions) d.id = `D${++n.D}`;
    for (const p of s.plans) p.id = `P${++n.P}`;
    for (const r of s.runs) r.id = `R${++n.R}`;
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
  numberFacts(sessions);
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
  if (truth.dirty && !truth.usedWorkingTree)
    notes.push(
      'The working tree had uncommitted changes: a run in the session may have tested code that is not in the PR.',
    );
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
      ...(truth.dirty ? { dirty: true } : {}),
      commits: truth.commits.map((c) => ({
        sha: c.sha.slice(0, 12),
        subject: scrub.text(c.subject),
        trailers: c.trailers,
        ...(c.commitTime ? { time: new Date(c.commitTime).toISOString() } : {}),
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
      role: fileRole(f.path),
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
    linkedPrs: [
      ...new Set(
        chosen
          .filter((m) => m.band !== 'excluded')
          .flatMap((m) => m.kept)
          .flatMap((r) =>
            r.kind === 'link' && r.prNumber && r.prNumber !== truth.pr?.number
              ? [r.prNumber]
              : [],
          ),
      ),
    ],
    notes,
    truncated: [],
  };
  fitBudget(digest, opts.budgetTokens ?? 12000);
  digest.privacy.redactions = scrub.redactions;
  return digest;
}
