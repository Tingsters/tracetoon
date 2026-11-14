/**
 * AEO eval runner: how often do coding agents discover, suggest, install and
 * run Tracetoon when asked to open a PR?
 *
 *   bun evals/aeo/run.ts --agents claude,codex,opencode --tiers 1,2,3,4 \
 *     --conditions clean,skill,skill+hook --trials 5 --out evals/aeo/results/<name>.json
 *
 * Every agent × tier × condition × web × trial gets a fresh fixture (fixture.ts).
 * Real agents cost real money: see README.md before running the full matrix.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AGENTS,
  authProblem,
  helpText,
  quoteCmd,
  resolveBin,
  version,
  type AgentSpec,
} from './agents.ts';
import {
  CONDITIONS,
  createFixture,
  ensureBundle,
  installedSkills,
  readGhLog,
  REPO_ROOT,
  type Condition,
  type HostId,
} from './fixture.ts';
import { aggregate, markdown, type Results, type RunResult } from './report.ts';
import { readSessions, score } from './score.ts';

interface Tier {
  tier: number;
  name: string;
  prompt: string;
}
export const TIERS: Tier[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'prompts.json'), 'utf8'),
).tiers;

const HOSTS = Object.keys(AGENTS) as HostId[];

export interface Options {
  agents: HostId[];
  tiers: number[];
  conditions: Condition[];
  web: boolean[];
  trials: number;
  out: string;
  dryRun: boolean;
  timeoutMs: number;
  copyCredentials: boolean;
  keep: boolean;
}

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      agents: { type: 'string', default: 'claude' },
      tiers: { type: 'string', default: '1,2,3,4' },
      conditions: { type: 'string', default: 'clean,skill,skill+hook' },
      web: { type: 'string', default: 'on' },
      trials: { type: 'string', default: '1' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '10' },
      'copy-credentials': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'usage: bun evals/aeo/run.ts [--agents claude,codex,opencode] [--tiers 1,2,3,4]\n' +
        '  [--conditions clean,skill,skill+hook,agents-md] [--web on|off|both] [--trials N]\n' +
        '  [--timeout MINUTES] [--out evals/aeo/results/<name>.json] [--dry-run]\n' +
        '  [--copy-credentials] [--keep]',
    );
    process.exit(0);
  }
  const csv = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const agents = csv(values.agents!);
  for (const a of agents)
    if (!HOSTS.includes(a as HostId))
      throw new Error(`unknown agent ${a} (known: ${HOSTS.join(', ')})`);
  const conditions = csv(values.conditions!);
  for (const c of conditions)
    if (!CONDITIONS.includes(c as Condition))
      throw new Error(`unknown condition ${c} (known: ${CONDITIONS.join(', ')})`);
  if (conditions.includes('mcp'))
    throw new Error('condition "mcp" is reserved for a later phase and not implemented');
  const tiers = csv(values.tiers!).map(Number);
  for (const t of tiers)
    if (!TIERS.some((x) => x.tier === t)) throw new Error(`unknown tier ${t}`);
  const web =
    values.web === 'both' ? [true, false] : values.web === 'off' ? [false] : [true];
  const date = new Date().toISOString().slice(0, 10);
  return {
    agents: agents as HostId[],
    tiers,
    conditions: conditions as Condition[],
    web,
    trials: Math.max(1, Number(values.trials) || 1),
    out: resolve(values.out ?? join(import.meta.dir, 'results', `run-${date}.json`)),
    dryRun: !!values['dry-run'],
    timeoutMs: Math.max(1, Number(values.timeout) || 10) * 60_000,
    copyCredentials: !!values['copy-credentials'],
    keep: !!values.keep,
  };
}

/** Replace machine-specific paths and the user name in anything we write. */
export function scrubber(extra: Record<string, string> = {}): (s: string) => string {
  const pairs: [string, string][] = [...Object.entries(extra)];
  pairs.push([REPO_ROOT, '<tracetoon>'], [homedir(), '~']);
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    /* none */
  }
  const variants = (p: string) => [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\')];
  const all = pairs
    .filter(([p]) => p.length > 3)
    .flatMap(([p, r]) => variants(p).map((v) => [v, r] as [string, string]))
    .sort((a, b) => b[0].length - a[0].length);
  return (s: string) => {
    let out = s;
    for (const [p, r] of all) out = out.split(p).join(r);
    if (user.length > 2) out = out.replace(new RegExp(`\\b${user}\\b`, 'gi'), '<user>');
    return out;
  };
}

function scrubDeep<T>(value: T, scrub: (s: string) => string): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)]),
    ) as T;
  return value;
}

function killTree(pid: number): void {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
}

/** Run a command with output to files; kill its whole tree at the timeout. */
async function runAgent(
  path: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; outDir: string },
): Promise<{
  code: number | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}> {
  mkdirSync(opts.outDir, { recursive: true });
  const outFile = join(opts.outDir, 'stdout.jsonl');
  const errFile = join(opts.outDir, 'stderr.txt');
  const out = openSync(outFile, 'w');
  const err = openSync(errFile, 'w');
  const started = Date.now();
  const viaCmd = /\.(cmd|bat)$/i.test(path);
  const child = viaCmd
    ? spawn(
        'cmd.exe',
        ['/d', '/s', '/c', `"${[path, ...args].map(quoteCmd).join(' ')}"`],
        {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['ignore', out, err],
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      )
    : spawn(path, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', out, err],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killTree(child.pid);
  }, opts.timeoutMs);
  const code = await new Promise<number | null>((done) => {
    child.on('exit', (c) => done(c));
    child.on('error', () => done(null));
  });
  clearTimeout(timer);
  closeSync(out);
  closeSync(err);
  return {
    code,
    timedOut,
    ms: Date.now() - started,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

function tracetoonInfo(): Results['tracetoon'] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    version: pkg.version,
    commit: sha.status === 0 ? sha.stdout.trim() : undefined,
  };
}

function save(results: Results, out: string): void {
  results.summary = aggregate(results.runs);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  writeFileSync(out.replace(/\.json$/, '') + '.md', markdown(results));
}

export async function main(argv: string[]): Promise<Results> {
  const opts = parseOptions(argv);
  const name = opts.out
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.json$/, '');
  const runsDir = opts.out.replace(/\.json$/, '') + '-runs';
  const results: Results = {
    name,
    startedAt: new Date().toISOString(),
    tracetoon: tracetoonInfo(),
    agents: {},
    matrix: {
      agents: opts.agents,
      tiers: opts.tiers,
      conditions: opts.conditions,
      web: opts.web,
      trials: opts.trials,
      timeoutMs: opts.timeoutMs,
    },
    runs: [],
  };

  const ready: { spec: AgentSpec; path: string; help: string }[] = [];
  for (const id of opts.agents) {
    const spec = AGENTS[id];
    const path = resolveBin(spec.bin);
    if (!path) {
      results.agents[id] = { skipped: `${spec.bin} is not installed` };
      console.log(`skip ${spec.label}: ${spec.bin} is not on PATH`);
      continue;
    }
    const problem = authProblem(spec, opts.copyCredentials);
    results.agents[id] = { version: version(path) };
    if (problem && !opts.dryRun) {
      results.agents[id]!.skipped = problem;
      console.log(`skip ${spec.label}: ${problem}`);
      continue;
    }
    ready.push({ spec, path, help: helpText(path, spec.helpArgs) });
  }

  const cells: {
    spec: AgentSpec;
    path: string;
    help: string;
    tier: (typeof TIERS)[number];
    condition: Condition;
    web: boolean;
    trial: number;
  }[] = [];
  for (const a of ready)
    for (const tier of TIERS.filter((t) => opts.tiers.includes(t.tier)))
      for (const condition of opts.conditions)
        for (const web of opts.web) {
          if (!web && !a.spec.webToggle) continue;
          for (let trial = 1; trial <= opts.trials; trial++)
            cells.push({ ...a, tier, condition, web, trial });
        }

  if (opts.dryRun) {
    console.log(`${cells.length} run(s) planned; nothing executed (--dry-run).`);
    for (const c of cells) {
      const args = c.spec.args({
        prompt: c.tier.prompt,
        web: c.web,
        help: c.help,
        fixture: {
          dir: '<fixture>',
          repo: '<fixture>/repo',
          condition: c.condition,
          env: {},
        } as never,
      });
      console.log(
        `${c.spec.id} t${c.tier.tier} ${c.condition} web=${c.web ? 'on' : 'off'} #${c.trial}: ${c.spec.bin} ${args.map((x) => JSON.stringify(x)).join(' ')}`,
      );
    }
    return results;
  }

  if (opts.conditions.some((c) => c === 'skill' || c === 'skill+hook'))
    ensureBundle(true);
  save(results, opts.out);
  let i = 0;
  for (const c of cells) {
    i++;
    const label = `${c.spec.id}-t${c.tier.tier}-${c.condition.replace('+', '-')}-web${c.web ? 'on' : 'off'}-${c.trial}`;
    console.log(`[${i}/${cells.length}] ${label}`);
    const notes: string[] = [];
    let fixture;
    try {
      fixture = createFixture({
        host: c.spec.id,
        condition: c.condition,
        credentials:
          opts.copyCredentials && !c.spec.keys.some((k) => process.env[k])
            ? c.spec.credentials
            : [],
      });
    } catch (e) {
      notes.push(`fixture failed: ${(e as Error).message}`);
      console.log(`  ${notes[0]}`);
      continue;
    }
    const scrub = scrubber({ [fixture.dir]: '<fixture>' });
    try {
      const ctx = { prompt: c.tier.prompt, web: c.web, fixture, help: c.help };
      c.spec.prepare?.(ctx);
      const outDir = join(runsDir, label);
      const r = await runAgent(c.path, c.spec.args(ctx), {
        cwd: fixture.repo,
        env: fixture.env,
        timeoutMs: opts.timeoutMs,
        outDir,
      });
      const gh = readGhLog(fixture.ghLog);
      const { sessions, warnings } = readSessions(c.spec.id, fixture.repo, fixture.env);
      notes.push(...warnings);
      if (r.timedOut) notes.push(`timed out after ${opts.timeoutMs / 60_000} min`);
      if (r.code !== 0 && !r.timedOut)
        notes.push(
          `exit ${r.code}: ${r.stderr.trim().split('\n').slice(-1)[0] ?? ''}`.slice(
            0,
            300,
          ),
        );
      const s = score({
        host: c.spec.id,
        stdout: r.stdout,
        sessions,
        gh,
        preinstalled: fixture.preinstalled,
        skillsAfter: installedSkills(fixture),
        wallMs: r.ms,
      });
      // Keep the raw material next to the results (scrubbed, never committed by CI).
      writeFileSync(join(outDir, 'stdout.jsonl'), scrub(r.stdout));
      writeFileSync(join(outDir, 'stderr.txt'), scrub(r.stderr));
      writeFileSync(
        join(outDir, 'gh.jsonl'),
        scrub(gh.map((g) => JSON.stringify(g)).join('\n')),
      );
      writeFileSync(
        join(outDir, 'sessions.json'),
        scrub(JSON.stringify(sessions, null, 1)),
      );
      const run: RunResult = scrubDeep(
        {
          agent: c.spec.id,
          tier: c.tier.tier,
          condition: c.condition,
          web: c.web,
          trial: c.trial,
          exitCode: r.code,
          timedOut: r.timedOut,
          score: s,
          notes,
        },
        scrub,
      );
      results.runs.push(run);
      console.log(
        `  discover=${s.discover} suggest=${s.suggest} install=${s.install} run=${s.run} pr=${s.prCreated} ${(r.ms / 1000).toFixed(0)}s${s.costUsd !== undefined ? ` $${s.costUsd.toFixed(3)}` : ''}`,
      );
    } finally {
      if (!opts.keep) fixture.cleanup();
      else console.log(`  kept ${fixture.dir}`);
    }
    save(results, opts.out);
  }
  results.finishedAt = new Date().toISOString();
  save(results, opts.out);
  console.log(`\nwrote ${opts.out} and ${opts.out.replace(/\.json$/, '.md')}`);
  return results;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
