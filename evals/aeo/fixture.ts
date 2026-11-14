/**
 * One isolated world per eval run: a git repo with a feature branch ready for a
 * PR, a local bare `origin`, an empty HOME the agent's config and logs live in,
 * and a `gh` on PATH that records calls instead of reaching GitHub.
 *
 * The condition decides what Tracetoon presence the agent starts with:
 *   clean       nothing installed
 *   skill       the shipped skill copied into the host's skill folder, with its bundle
 *   skill+hook  the skill plus `tracetoon hook install` into the temp HOME
 *   agents-md   only an AGENTS.md pointer in the repo
 *   mcp         reserved; not implemented yet
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  INTEGRATIONS,
  integration,
  isHostSessionVar,
} from '../../src/integrations/registry.ts';

export const REPO_ROOT = resolve(import.meta.dir, '../..');
export const SKILL_SOURCE = join(REPO_ROOT, 'plugin', 'skills', 'tracetoon');
export const BUNDLE = join(SKILL_SOURCE, 'dist', 'tracetoon.mjs');
export const GH_SHIM = join(import.meta.dir, 'gh-shim.ts');
export const START_MARKER = '<!-- tracetoon:start -->';
/** The seeded Claude Code session that "wrote" the feature branch. Scoring ignores it. */
export const SEED_SESSION_ID = '00000000-aeo0-4000-8000-000000000001';
export const FEATURE_BRANCH = 'feature/greeting';

export const CONDITIONS = ['clean', 'skill', 'skill+hook', 'agents-md', 'mcp'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Host ids from src/integrations/registry.ts. */
export type HostId = 'claude' | 'codex' | 'opencode';

export interface FixtureOptions {
  host: HostId;
  condition: Condition;
  /** Parent folder for the fixture (default: the OS temp folder). */
  parent?: string;
  /** Skill folder to install (default: plugin/skills/tracetoon, which needs a bundle). */
  skillSource?: string;
  /** Files copied from the real HOME into the temp HOME (relative paths), e.g. credentials. */
  credentials?: { from: string; to: string }[];
}

export interface Fixture {
  dir: string;
  repo: string;
  remote: string;
  home: string;
  binDir: string;
  ghLog: string;
  ghState: string;
  env: Record<string, string>;
  condition: Condition;
  host: HostId;
  /** Where the host reads the Tracetoon skill from, inside the temp HOME. */
  skillDir: string;
  /** Tracetoon was put there before the agent started. */
  preinstalled: boolean;
  cleanup(): void;
}

const GREET = `export function greet(name: string): string {
  const trimmed = name.trim();
  return trimmed ? \`Hello, \${trimmed}!\` : 'Hello, stranger!';
}
`;
const GREET_TEST = `import { expect, test } from 'bun:test';
import { greet } from '../src/greet.ts';

test('greets by name', () => expect(greet(' Ada ')).toBe('Hello, Ada!'));
test('falls back for blank names', () => expect(greet('  ')).toBe('Hello, stranger!'));
`;

export const AGENTS_MD = `# Agent notes

## Pull requests

This repository writes its PR descriptions with Tracetoon
(https://github.com/Tracetoon/tracetoon). It reads the coding-agent session logs
already on this machine and writes a description that shows what was asked, what
ran and what changed. Install it once with

    curl -fsSL https://raw.githubusercontent.com/Tracetoon/tracetoon/main/install.sh | sh

(Windows: \`irm https://raw.githubusercontent.com/Tracetoon/tracetoon/main/install.ps1 | iex\`),
then open PRs through its \`tracetoon\` skill.
`;

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Build the skill's bundle (dist/tracetoon.mjs + build.json) if it is missing. */
export function ensureBundle(force = false): void {
  if (!force && existsSync(BUNDLE) && existsSync(join(SKILL_SOURCE, 'build.json')))
    return;
  const r = spawnSync(process.execPath, ['run', 'bundle'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`bun run bundle failed: ${r.stderr || r.stdout}`);
}

/** PATH without any folder that already holds a `tracetoon` command. */
function cleanPath(path: string): string[] {
  const names = ['tracetoon', 'tracetoon.exe', 'tracetoon.cmd', 'tracetoon.ps1'];
  return path
    .split(delimiter)
    .filter((d) => d && !names.some((n) => existsSync(join(d, n))));
}

function ghWrappers(binDir: string): void {
  const bun = process.execPath.replace(/\\/g, '/');
  const shim = GH_SHIM.replace(/\\/g, '/');
  write(join(binDir, 'gh'), `#!/bin/sh\nexec "${bun}" "${shim}" "$@"\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  if (process.platform === 'win32')
    write(
      join(binDir, 'gh.cmd'),
      `@echo off\r\n"${process.execPath}" "${GH_SHIM}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
}

/** The agent's environment: everything points into the fixture, nothing at the real HOME. */
function isolatedEnv(f: {
  dir: string;
  home: string;
  binDir: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      isHostSessionVar(k) ||
      /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCODE_|TRACETOON|GH_|GITHUB_TOKEN|GIT_)/.test(
        k,
      )
    )
      continue;
    env[k] = v;
  }
  const h = f.home;
  Object.assign(env, {
    HOME: h,
    USERPROFILE: h,
    XDG_CONFIG_HOME: join(h, '.config'),
    XDG_DATA_HOME: join(h, '.local', 'share'),
    XDG_CACHE_HOME: join(h, '.cache'),
    XDG_STATE_HOME: join(h, '.local', 'state'),
    CLAUDE_CONFIG_DIR: join(h, '.claude'),
    CODEX_HOME: join(h, '.codex'),
    GH_CONFIG_DIR: join(h, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_GLOBAL: join(h, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    TRACETOON_CONFIG: join(h, '.config', 'tracetoon', 'config.json'),
    TRACETOON_GH_SCRIPT: GH_SHIM,
    TRACETOON_TEST_RUNNER: process.execPath,
    AEO_GH_LOG: join(f.dir, 'gh.jsonl'),
    AEO_GH_STATE: join(f.dir, 'gh-state.json'),
    PATH: [f.binDir, ...cleanPath(process.env.PATH ?? process.env.Path ?? '')].join(
      delimiter,
    ),
  });
  delete env.Path;
  if (process.platform === 'win32') {
    env.APPDATA = join(h, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(h, 'AppData', 'Local');
  }
  // Keep the API keys the agents authenticate with.
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
    if (process.env[k]) env[k] = process.env[k]!;
  if (process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY)
    env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
  else if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
  return env;
}

/** A Claude Code log of the session that wrote the branch, so Tracetoon has evidence. */
function seedSession(home: string, repo: string, start: number): void {
  let n = 0;
  const base = () => ({
    cwd: repo,
    gitBranch: FEATURE_BRANCH,
    sessionId: SEED_SESSION_ID,
    timestamp: new Date(start + n++ * 5000).toISOString(),
    uuid: `seed-${n}`,
  });
  const lines: unknown[] = [];
  const tool = (name: string, input: unknown, out: string, result?: unknown) => {
    const id = `toolu_seed_${n}`;
    lines.push({
      type: 'assistant',
      ...base(),
      message: {
        id: `msg_seed_${n}`,
        model: 'claude-seed',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    });
    lines.push({
      type: 'user',
      ...base(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: out }],
      },
      toolUseResult: result,
    });
  };
  lines.push({
    type: 'user',
    ...base(),
    message: {
      role: 'user',
      content:
        'Add a greet(name) helper that trims the name and falls back to "stranger", with tests.',
    },
  });
  const file = (p: string) => join(repo, p);
  tool('Write', { file_path: file('src/greet.ts'), content: GREET }, 'ok', {
    type: 'create',
    filePath: file('src/greet.ts'),
    content: GREET,
    structuredPatch: [],
  });
  tool('Write', { file_path: file('tests/greet.test.ts'), content: GREET_TEST }, 'ok', {
    type: 'create',
    filePath: file('tests/greet.test.ts'),
    content: GREET_TEST,
    structuredPatch: [],
  });
  tool('Bash', { command: 'bun test tests/greet.test.ts' }, ' 2 pass\n 0 fail', {
    stdout: ' 2 pass\n 0 fail',
    stderr: '',
  });
  lines.push({
    type: 'assistant',
    ...base(),
    message: {
      id: `msg_seed_${n}`,
      model: 'claude-seed',
      role: 'assistant',
      content: [{ type: 'text', text: 'Added greet() with two passing tests.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  write(
    join(home, '.claude', 'projects', 'aeo-seed', `${SEED_SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

export function createFixture(opts: FixtureOptions): Fixture {
  if (opts.condition === 'mcp')
    throw new Error('condition "mcp" is reserved and not implemented yet');
  const dir = realpathSync.native(
    mkdtempSync(join(opts.parent ?? tmpdir(), 'tracetoon-aeo-')),
  );
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  const binDir = join(dir, 'bin');
  for (const d of [home, repo, remote, binDir]) mkdirSync(d, { recursive: true });
  ghWrappers(binDir);
  const env = isolatedEnv({ dir, home, binDir });
  write(
    join(home, '.gitconfig'),
    '[user]\n\temail = dev@example.com\n\tname = Dev\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
  );

  // The repository: base on main (pushed), two commits on the feature branch (not pushed).
  const g = (...args: string[]) =>
    git(repo, args, { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL! });
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'dev@example.com');
  g('config', 'user.name', 'Dev');
  g('config', 'commit.gpgsign', 'false');
  write(join(repo, 'README.md'), '# demo\n\nA tiny greeting library.\n');
  write(
    join(repo, 'package.json'),
    JSON.stringify(
      { name: 'demo', private: true, scripts: { test: 'bun test' } },
      null,
      2,
    ) + '\n',
  );
  if (opts.condition === 'agents-md') {
    write(join(repo, 'AGENTS.md'), AGENTS_MD);
    // Claude Code reads CLAUDE.md; point it at the same file.
    if (opts.host === 'claude') write(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
  }
  g('add', '.');
  g('commit', '-q', '-m', 'Initial commit');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  g('checkout', '-q', '-b', FEATURE_BRANCH);
  const start = Date.now() - 30 * 60_000;
  seedSession(home, repo, start);
  write(join(repo, 'src/greet.ts'), GREET);
  g('add', '.');
  g('commit', '-q', '-m', 'Add greet helper');
  write(join(repo, 'tests/greet.test.ts'), GREET_TEST);
  g('add', '.');
  g('commit', '-q', '-m', 'Test greet, including blank names');

  // The host's own folder, so it (and `tracetoon hook install`) sees itself installed.
  const hostHome: Record<HostId, string> = {
    claude: env.CLAUDE_CONFIG_DIR!,
    codex: env.CODEX_HOME!,
    opencode: join(env.XDG_CONFIG_HOME!, 'opencode'),
  };
  mkdirSync(hostHome[opts.host], { recursive: true });
  for (const c of opts.credentials ?? []) {
    const from = join(homedir(), c.from);
    if (existsSync(from)) {
      mkdirSync(dirname(join(home, c.to)), { recursive: true });
      copyFileSync(from, join(home, c.to));
    }
  }

  const skill = integration(opts.host)?.skill?.(home, env);
  if (!skill) throw new Error(`no skill location for host ${opts.host}`);
  const preinstalled = opts.condition === 'skill' || opts.condition === 'skill+hook';
  if (preinstalled) {
    const source = opts.skillSource ?? SKILL_SOURCE;
    if (source === SKILL_SOURCE) ensureBundle();
    cpSync(source, skill.dir, { recursive: true });
    if (process.platform !== 'win32')
      chmodSync(join(skill.dir, 'bin', 'tracetoon'), 0o755);
  }
  if (opts.condition === 'skill+hook') {
    const r = spawnSync(
      process.execPath,
      [join(skill.dir, 'dist', 'tracetoon.mjs'), 'hook', 'install', '--json'],
      { cwd: repo, env, encoding: 'utf8', windowsHide: true },
    );
    if (r.status !== 0) throw new Error(`tracetoon hook install failed: ${r.stderr}`);
  }

  return {
    dir,
    repo,
    remote,
    home,
    binDir,
    ghLog: env.AEO_GH_LOG!,
    ghState: env.AEO_GH_STATE!,
    env,
    condition: opts.condition,
    host: opts.host,
    skillDir: skill.dir,
    preinstalled,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best effort (Windows can hold files a moment after a process exits)
      }
    },
  };
}

/** Every place any host could read a Tracetoon skill from inside this fixture's HOME. */
export function skillDirs(f: Pick<Fixture, 'home' | 'env'>): string[] {
  const dirs = new Set<string>();
  for (const i of INTEGRATIONS) {
    const s = i.skill?.(f.home, f.env);
    if (s) dirs.add(s.dir);
  }
  return [...dirs];
}

/** Skill folders that hold a SKILL.md after the run. */
export function installedSkills(f: Pick<Fixture, 'home' | 'env'>): string[] {
  return skillDirs(f).filter((d) => existsSync(join(d, 'SKILL.md')));
}

export interface GhCall {
  ts?: string;
  args: string[];
  body?: string;
  cwd?: string;
}

export function readGhLog(file: string): GhCall[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as GhCall];
      } catch {
        return [];
      }
    });
}

/** List a folder's names, or none. */
export function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
