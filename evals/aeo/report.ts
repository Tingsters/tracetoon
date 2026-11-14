/**
 * Aggregates eval runs into rates per agent × tier × condition × web, and
 * renders them as a markdown table.
 *
 *   bun evals/aeo/report.ts evals/aeo/results/<name>.json   # rewrites <name>.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Condition, HostId } from './fixture.ts';
import type { Score } from './score.ts';

export interface RunResult {
  agent: HostId;
  tier: number;
  condition: Condition;
  web: boolean;
  trial: number;
  exitCode: number | null;
  timedOut: boolean;
  score: Score;
  notes: string[];
}

export interface Results {
  name: string;
  startedAt: string;
  finishedAt?: string;
  tracetoon: { version: string; commit?: string };
  agents: Partial<Record<HostId, { version?: string; skipped?: string }>>;
  matrix: {
    agents: HostId[];
    tiers: number[];
    conditions: Condition[];
    web: boolean[];
    trials: number;
    timeoutMs: number;
  };
  runs: RunResult[];
  summary?: Cell[];
}

export const STAGES = ['discover', 'suggest', 'install', 'run'] as const;

export interface Cell {
  agent: HostId;
  tier: number;
  condition: Condition;
  web: boolean;
  n: number;
  discover: number;
  suggest: number;
  install: number;
  /** Installs the agent did itself (not preinstalled by the condition). */
  agentInstall: number;
  run: number;
  prCreated: number;
  skillTrigger: number;
  timedOut: number;
  errors: number;
  meanWallMs: number;
  meanCostUsd?: number;
  meanTokens?: number;
}

export function aggregate(runs: RunResult[]): Cell[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of runs) {
    const key = JSON.stringify([r.agent, r.tier, r.condition, r.web]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const cells: Cell[] = [];
  for (const rs of groups.values()) {
    const first = rs[0]!;
    const count = (f: (s: Score) => boolean) => rs.filter((r) => f(r.score)).length;
    const mean = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
    const costs = rs.flatMap((r) =>
      typeof r.score.costUsd === 'number' ? [r.score.costUsd] : [],
    );
    const tokens = rs.flatMap((r) =>
      r.score.tokens
        ? [
            r.score.tokens.input +
              r.score.tokens.output +
              r.score.tokens.cacheRead +
              r.score.tokens.cacheWrite,
          ]
        : [],
    );
    cells.push({
      agent: first.agent,
      tier: first.tier,
      condition: first.condition,
      web: first.web,
      n: rs.length,
      discover: count((s) => s.discover),
      suggest: count((s) => s.suggest),
      install: count((s) => s.install),
      agentInstall: count((s) => s.install && s.installVia !== 'preinstalled'),
      run: count((s) => s.run),
      prCreated: count((s) => s.prCreated),
      skillTrigger: count((s) => s.skillTrigger),
      timedOut: rs.filter((r) => r.timedOut).length,
      errors: rs.filter((r) => r.score.agentError || (r.exitCode ?? 1) !== 0).length,
      meanWallMs: mean(rs.map((r) => r.score.wallMs)) ?? 0,
      meanCostUsd: mean(costs),
      meanTokens: mean(tokens),
    });
  }
  return cells.sort(
    (a, b) =>
      a.agent.localeCompare(b.agent) ||
      a.tier - b.tier ||
      a.condition.localeCompare(b.condition) ||
      Number(b.web) - Number(a.web),
  );
}

const rate = (k: number, n: number) =>
  n ? `${k}/${n} (${Math.round((100 * k) / n)}%)` : '–';

export function markdown(results: Results): string {
  const cells = results.summary ?? aggregate(results.runs);
  const out: string[] = [];
  out.push(`# AEO eval: ${results.name}`, '');
  out.push(
    `Tracetoon ${results.tracetoon.version}${results.tracetoon.commit ? ` (${results.tracetoon.commit})` : ''}, started ${results.startedAt}${results.finishedAt ? `, finished ${results.finishedAt}` : ''}.`,
    '',
  );
  const agentLines = Object.entries(results.agents).map(
    ([id, a]) =>
      `- ${id}: ${a?.skipped ? `skipped (${a.skipped})` : (a?.version ?? 'unknown version')}`,
  );
  if (agentLines.length) out.push('Agents:', '', ...agentLines, '');
  out.push(
    'Tiers: 1 unprompted, 2 hinted, 3 category, 4 named (control). Install counts runs where Tracetoon was usable; "(agent)" is the part the agent installed itself.',
    '',
  );
  out.push(
    '| agent | tier | condition | web | n | discover | suggest | install (agent) | run | PR created | skill trigger | timeouts | errors | wall s | cost $ | tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const c of cells)
    out.push(
      `| ${c.agent} | ${c.tier} | ${c.condition} | ${c.web ? 'on' : 'off'} | ${c.n} | ${rate(c.discover, c.n)} | ${rate(c.suggest, c.n)} | ${rate(c.install, c.n)} (${c.agentInstall}) | ${rate(c.run, c.n)} | ${rate(c.prCreated, c.n)} | ${rate(c.skillTrigger, c.n)} | ${c.timedOut} | ${c.errors} | ${(c.meanWallMs / 1000).toFixed(0)} | ${c.meanCostUsd === undefined ? '–' : c.meanCostUsd.toFixed(3)} | ${c.meanTokens === undefined ? '–' : Math.round(c.meanTokens)} |`,
    );
  if (!cells.length) out.push('| (no runs) |||||||||||||||| ');
  const notes = results.runs.flatMap((r) =>
    r.notes.map((n) => `- ${r.agent} t${r.tier} ${r.condition} #${r.trial}: ${n}`),
  );
  if (notes.length) out.push('', 'Notes:', '', ...notes);
  return out.join('\n') + '\n';
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: bun evals/aeo/report.ts <results.json>');
    process.exit(2);
  }
  const results = JSON.parse(readFileSync(file, 'utf8')) as Results;
  results.summary = aggregate(results.runs);
  writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  writeFileSync(file.replace(/\.json$/, '.md'), markdown(results));
  console.log(markdown(results));
}
