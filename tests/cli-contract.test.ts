// The agent-facing CLI contract: JSON envelopes, exit codes, the command list,
// doctor checks, publish --dry-run and setup. Runs against the source, the bundle
// (TRACETOON_TEST_CLI) or the native executable (TRACETOON_TEST_BINARY).
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

setDefaultTimeout(120_000);

let env: NodeJS.ProcessEnv;
let home: string;
let ghLog: string;

beforeEach(() => {
  home = tempDir('tracetoon-contract-home-');
  const scratch = tempDir('tracetoon-contract-');
  ghLog = join(scratch, 'gh.log');
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CODEX_HOME: join(home, 'codex'),
    GEMINI_HOME: join(home, 'gemini'),
    ANTIGRAVITY_HOME: join(home, 'antigravity'),
    FACTORY_HOME: join(home, 'factory'),
    COPILOT_HOME: join(home, 'copilot'),
    CURSOR_HOME: join(home, 'cursor'),
    KIRO_HOME: join(home, 'kiro'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    TRACETOON_VSCODE_USER_DIR: join(home, 'vscode'),
    TRACETOON_CONFIG: join(scratch, 'config.json'),
    TRACETOON_GH_SCRIPT: FAKE_GH,
    // A compiled binary can't run the fake gh script itself.
    TRACETOON_TEST_RUNNER: process.execPath,
    FAKE_GH_LOG: ghLog,
  };
});

function cli(cwd: string, ...args: string[]) {
  const program = process.env.TRACETOON_TEST_BINARY
    ? [process.env.TRACETOON_TEST_BINARY]
    : [
        process.execPath,
        process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts'),
      ];
  const r = spawnSync(program[0]!, [...program.slice(1), ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const ghCalls = (): { args: string[] }[] =>
  existsSync(ghLog)
    ? readFileSync(ghLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe('CLI contract', () => {
  test('usage errors print a JSON envelope and exit 2; help and version exit 0', () => {
    const dir = tempDir();
    const unknown = cli(dir, '--json', 'no-such-command');
    expect(unknown.code).toBe(2);
    expect(unknown.json).toMatchObject({
      schemaVersion: 1,
      errorCode: 'USAGE',
      retryable: false,
      humanRequired: false,
    });
    expect(unknown.json.error).toContain('no-such-command');
    const option = cli(dir, '--json', 'doctor', '--no-such-option');
    expect(option.code).toBe(2);
    expect(option.json.errorCode).toBe('USAGE');
    // Without --json the message goes to stderr, as before.
    const text = cli(dir, 'no-such-command');
    expect(text.code).toBe(2);
    expect(text.stderr).toContain('unknown command');
    expect(cli(dir, '--version').code).toBe(0);
    expect(cli(dir, '--help').code).toBe(0);
    expect(cli(dir, 'publish', '--help').code).toBe(0);
  });

  test('errors carry errorCode, fix, retryable and humanRequired next to error', () => {
    const outside = cli(tempDir(), '--json', 'scan', '--offline');
    expect(outside.code).toBe(1);
    expect(typeof outside.json.error).toBe('string');
    expect(outside.json).toMatchObject({
      schemaVersion: 1,
      errorCode: 'NOT_A_GIT_REPO',
      retryable: false,
      humanRequired: false,
    });
    expect(outside.json.fix).toBeTruthy();
    const repo = makeRepo();
    const noRun = cli(repo.root, '--json', 'publish');
    expect(noRun.code).toBe(1);
    expect(noRun.json.errorCode).toBe('RUN_NOT_FOUND');
    expect(noRun.json.fix).toBe('tracetoon prepare --json');
  });

  test('JSON objects carry schemaVersion; arrays stay arrays', () => {
    const dir = tempDir();
    const info = cli(dir, '--json', 'build-info');
    expect(info.code).toBe(0);
    expect(info.json.schemaVersion).toBe(1);
    expect(typeof info.json.buildId).toBe('string');
    const integrations = cli(dir, '--json', 'integrations');
    expect(Array.isArray(integrations.json)).toBe(true);
    const guide = cli(dir, '--json', 'guide');
    expect(guide.json.schemaVersion).toBe(1);
    expect(guide.json.guide).toContain('## Using Tracetoon');
  });

  test('commands --json lists every command with the ones that act outside the machine', () => {
    const r = cli(tempDir(), '--json', 'commands');
    expect(r.code).toBe(0);
    expect(r.json.schemaVersion).toBe(1);
    const all: any[] = [];
    const walk = (list: any[]) => {
      for (const c of list) {
        all.push(c);
        walk(c.subcommands);
      }
    };
    walk(r.json.commands);
    const byName = (name: string) => all.find((c) => c.command === name);
    expect(byName('publish').effects).toEqual(['publishes']);
    expect(byName('publish').options.map((o: any) => o.flags)).toContain('--dry-run');
    expect(byName('comic art').effects).toContain('sends-data');
    expect(byName('update').effects).toEqual(['installs']);
    expect(byName('doctor').effects).toBeUndefined();
    for (const name of ['setup', 'guide', 'feedback', 'commands'])
      expect(byName(name)).toBeDefined();
  });

  test('doctor --json lists checks with severity and fixes; --strict exits 6 on a failed required check', () => {
    const repo = makeRepo();
    const ok = cli(repo.root, '--json', 'doctor');
    expect(ok.code).toBe(0);
    expect(ok.json.schemaVersion).toBe(1);
    expect(typeof ok.json.ok).toBe('boolean');
    const ids = ok.json.checks.map((c: any) => c.id);
    for (const id of ['git', 'gh', 'gh-auth', 'repo', 'skill-installed', 'update'])
      expect(ids).toContain(id);
    for (const c of ok.json.checks) {
      expect(['error', 'warn', 'info']).toContain(c.severity);
      expect(typeof c.humanRequired).toBe('boolean');
    }
    // Older fields stay.
    expect(ok.json.ghAuthenticated).toBe(true);
    env.FAKE_GH_PERMISSION = 'READ';
    const denied = cli(repo.root, '--json', 'doctor', '--strict');
    const push = denied.json.checks.find((c: any) => c.id === 'push-access');
    expect(push).toMatchObject({ ok: false, severity: 'error', humanRequired: true });
    expect(denied.json.ok).toBe(false);
    expect(denied.code).toBe(6);
  });

  test('publish --dry-run reports what it would post without pushing or posting', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    const GREET = 'export const greet = (name: string) => `Hello, ${name}!`;\n';
    new ClaudeLog(repo.root)
      .prompt('Add greeting')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(env.CLAUDE_CONFIG_DIR!, 's1');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');
    const d = cli(repo.root, '--json', 'digest', '--offline');
    expect(d.code).toBe(0);
    expect(cli(repo.root, '--json', 'context', '--offline').code).toBe(0);
    const runDir = d.json.runDir as string;
    writeFileSync(join(runDir, 'body.md'), '## Summary\nAdds a greeting helper.\n');
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting helper\n');
    expect(cli(repo.root, '--json', 'render').code).toBe(0);

    const dry = cli(repo.root, '--json', 'publish', '--dry-run', '--push');
    expect(dry.json.error).toBeUndefined();
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({
      schemaVersion: 1,
      dryRun: true,
      mode: 'create',
      action: 'create',
      title: 'Add greeting helper',
    });
    expect(dry.json.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    const commands = dry.json.commands.map((c: string[]) => c.join(' '));
    expect(commands.some((c: string) => c.startsWith('git push'))).toBe(true);
    expect(commands.some((c: string) => c.startsWith('gh pr create'))).toBe(true);
    // Nothing was posted, pushed or recorded.
    expect(
      ghCalls().filter(
        (c) => c.args[0] === 'pr' && ['create', 'edit'].includes(c.args[1]!),
      ),
    ).toEqual([]);
    expect(git(remote, ['branch', '--list']).stdout).not.toContain('feature');
    for (const file of ['publish-progress.json', 'published.json', 'posted-body.md'])
      expect(existsSync(join(runDir, file))).toBe(false);
  });

  test('setup installs the shipped skill into each agent and changes nothing the second time', () => {
    mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
    const dir = tempDir();
    const first = cli(dir, '--json', 'setup', '--agent', 'claude');
    expect(first.json.error).toBeUndefined();
    expect(first.code).toBe(0);
    expect(first.json.installed).toEqual([
      {
        agents: ['Claude Code'],
        dir: join(env.CLAUDE_CONFIG_DIR!, 'skills', 'tracetoon'),
        action: 'installed',
      },
    ]);
    expect(
      existsSync(join(env.CLAUDE_CONFIG_DIR!, 'skills', 'tracetoon', 'SKILL.md')),
    ).toBe(true);
    const claudeHook = first.json.hooks.find((h: any) => h.agent === 'claude');
    expect(claudeHook.result).toBe('installed');
    expect(first.json.restartRequired).toBe(true);

    const again = cli(dir, '--json', 'setup', '--agent', 'claude');
    expect(again.code).toBe(0);
    expect(again.json.installed.map((i: any) => i.action)).toEqual(['unchanged']);
    expect(again.json.hooks.find((h: any) => h.agent === 'claude').result).toBe(
      'unchanged',
    );
    expect(again.json.restartRequired).toBe(false);

    // Every present agent, skill only: a second run leaves all of them unchanged.
    const all = cli(dir, '--json', 'setup', '--no-hook');
    expect(all.code).toBe(0);
    expect(all.json.hooks).toEqual([]);
    const allAgain = cli(dir, '--json', 'setup', '--no-hook');
    expect(allAgain.json.installed.length).toBeGreaterThan(0);
    for (const i of allAgain.json.installed) expect(i.action).toBe('unchanged');
  });
});
