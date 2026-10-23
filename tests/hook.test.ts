import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decide, writesPr } from '../src/hook/prHook.ts';
import {
  hookCommand,
  hookStatus,
  hookTargets,
  installHooks,
  uninstallHooks,
} from '../src/hook/install.ts';
import { switchState } from '../src/hook/switches.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';

const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const claude = (command: string, cwd = '.') => ({ tool_input: { command }, cwd });

let savedConfig: string | undefined;
beforeEach(() => {
  savedConfig = process.env.TRACETOON_CONFIG;
  process.env.TRACETOON_CONFIG = join(tempDir('tracetoon-cfg-'), 'config.json');
});
afterEach(() => {
  if (savedConfig === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = savedConfig;
});
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  CI: '',
  TRACETOON: '',
  ...extra,
});

describe('which commands are PR writes', () => {
  test.each([
    ['gh pr create --title x --body y', true],
    ['cd repo && gh pr create --fill', true],
    ['git push -u origin feat && gh pr create', true],
    ['GH_TOKEN=abc gh pr create', true],
    ['"C:/Program Files/GitHub CLI/gh.exe" pr create', true],
    ['& gh pr new', true],
    ['gh pr edit 5 --body-file b.md', true],
    ['gh pr edit 5 -t "New title"', true],
    ['gh pr edit 5', true],
    ['gh pr edit 5 --add-label bug', false],
    ['gh pr view 5', false],
    ['gh pr list', false],
    ['gh pr merge 5 --merge', false],
    ['echo "gh pr create"', false],
    ['git commit -m "use gh pr create later"', false],
  ])('%s -> %p', (cmd, expected) => {
    expect(writesPr(cmd)).toBe(expected);
  });
});

describe('hook decisions', () => {
  test('denies in each agent format', () => {
    const c = JSON.parse(decide('claude', claude('gh pr create'), env())!);
    expect(c.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(c.hookSpecificOutput.permissionDecisionReason).toContain('tracetoon skill');
    expect(
      JSON.parse(decide('codex', claude('gh pr create'), env())!).hookSpecificOutput
        .permissionDecision,
    ).toBe('deny');
    const a = JSON.parse(
      decide(
        'antigravity',
        { toolCall: { args: { CommandLine: JSON.stringify('gh pr create') } } },
        env(),
      )!,
    );
    expect(a).toMatchObject({ decision: 'deny' });
  });

  test('lets everything else through', () => {
    expect(decide('claude', claude('ls -la'), env())).toBeUndefined();
    expect(decide('claude', claude('gh pr view'), env())).toBeUndefined();
    expect(decide('claude', {}, env())).toBeUndefined();
    expect(decide('claude', 'nonsense', env())).toBeUndefined();
  });

  test('every bypass and switch turns it off', () => {
    expect(decide('claude', claude('TRACETOON=0 gh pr create'), env())).toBeUndefined();
    expect(
      decide('claude', claude("$env:TRACETOON='0'; gh pr create"), env()),
    ).toBeUndefined();
    expect(
      decide('claude', claude('set TRACETOON=0 && gh pr create'), env()),
    ).toBeUndefined();
    expect(
      decide('claude', claude('gh pr create'), env({ TRACETOON: '0' })),
    ).toBeUndefined();
    expect(decide('claude', claude('gh pr create'), env({ CI: 'true' }))).toBeUndefined();
    expect(
      decide('claude', claude('gh pr create'), env({ CI: 'true', TRACETOON: '1' })),
    ).toBeDefined();
  });

  test('repo, personal and user settings, with any off winning', () => {
    const repo = makeRepo();
    const at = (s: string) => decide('claude', claude(s, repo.root), env());
    expect(at('gh pr create')).toBeDefined();
    git(repo.root, ['config', 'tracetoon.enabled', 'false']);
    expect(switchState(repo.root, env())).toMatchObject({
      enabled: false,
      decidedBy: 'local',
    });
    expect(at('gh pr create')).toBeUndefined();
    git(repo.root, ['config', '--unset', 'tracetoon.enabled']);
    mkdirSync(join(repo.root, '.github'), { recursive: true });
    writeFileSync(
      join(repo.root, '.github', 'tracetoon.json'),
      JSON.stringify({ enabled: false }),
    );
    expect(switchState(repo.root, env())).toMatchObject({
      enabled: false,
      decidedBy: 'repo',
    });
    writeFileSync(
      join(repo.root, '.github', 'tracetoon.json'),
      JSON.stringify({ enabled: true }),
    );
    writeFileSync(process.env.TRACETOON_CONFIG!, JSON.stringify({ enabled: false }));
    expect(switchState(repo.root, env())).toMatchObject({
      enabled: false,
      decidedBy: 'user',
    });
  });
});

describe('installing the hook', () => {
  function home() {
    const h = tempDir('tracetoon-home-');
    mkdirSync(join(h, '.claude'), { recursive: true });
    mkdirSync(join(h, '.codex'), { recursive: true });
    mkdirSync(join(h, '.gemini', 'antigravity-cli'), { recursive: true });
    return h;
  }
  const existingClaude = {
    model: 'opus',
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'other-tool check' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'showtail hook stop' }] }],
    },
  };

  test('merges next to existing hooks, idempotently, and uninstalls cleanly', () => {
    const h = home();
    const targets = hookTargets(h, {});
    writeFileSync(
      join(h, '.claude', 'settings.json'),
      JSON.stringify(existingClaude, null, 2),
    );
    writeFileSync(join(h, '.gemini', 'config.json'), '{}');
    mkdirSync(join(h, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      join(h, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({ 'showtail-cli': { enabled: true } }),
    );

    const first = installHooks('/opt/tracetoon/bin', targets);
    expect(first.map((c) => c.result)).toEqual(['installed', 'installed', 'installed']);
    expect(first[1]!.note).toContain('/hooks');
    expect(installHooks('/opt/tracetoon/bin', targets).map((c) => c.result)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);

    const settings = JSON.parse(
      readFileSync(join(h, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toEqual(existingClaude.hooks.Stop);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[1]).toMatchObject({
      matcher: 'Bash|PowerShell',
      hooks: [{ command: '/opt/tracetoon/bin hook pre-pr --agent claude' }],
    });
    const agy = JSON.parse(
      readFileSync(join(h, '.gemini', 'config', 'hooks.json'), 'utf8'),
    );
    expect(Object.keys(agy)).toEqual(['showtail-cli', 'tracetoon']);
    expect(agy.tracetoon.PreToolUse[0].matcher).toBe('run_command');
    expect(existsSync(join(h, '.claude', 'settings.json.tracetoon.bak'))).toBe(true);
    expect(hookStatus(targets).map((s) => s.installed)).toEqual([true, true, true]);

    expect(uninstallHooks(targets).map((c) => c.result)).toEqual([
      'removed',
      'removed',
      'removed',
    ]);
    expect(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))).toEqual(
      existingClaude,
    );
    expect(existsSync(join(h, '.codex', 'hooks.json'))).toBe(false); // created by us, now empty
    expect(
      JSON.parse(readFileSync(join(h, '.gemini', 'config', 'hooks.json'), 'utf8')),
    ).toEqual({ 'showtail-cli': { enabled: true } });
  });

  test('never touches a file it cannot parse, and skips missing agents', () => {
    const h = tempDir('tracetoon-home-');
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', 'settings.json'), '{ not json');
    const changes = installHooks('/x/tracetoon', hookTargets(h, {}));
    expect(changes[0]).toMatchObject({ result: 'skipped' });
    expect(changes[0]!.note).toContain('left untouched');
    expect(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
    expect(changes.slice(1).map((c) => c.note)).toEqual([
      'not installed',
      'not installed',
    ]);
  });

  test('hook commands use forward slashes and quote paths with spaces', () => {
    expect(
      hookCommand(
        'codex',
        'C:\\Users\\me\\AppData\\Local\\tracetoon\\cache\\1.0.0\\tracetoon-windows-x64.exe',
      ),
    ).toBe(
      'C:/Users/me/AppData/Local/tracetoon/cache/1.0.0/tracetoon-windows-x64.exe hook pre-pr --agent codex',
    );
    expect(hookCommand('claude', ['C:\\Program Files\\bun.exe', 'C:\\src\\cli.ts'])).toBe(
      '"C:/Program Files/bun.exe" C:/src/cli.ts hook pre-pr --agent claude',
    );
  });
});

describe('hook end to end', () => {
  test('the CLI reads stdin and answers like an agent hook', () => {
    const run = (payload: unknown, extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, [CLI, 'hook', 'pre-pr', '--agent', 'claude'], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: env(extra),
      });
    const denied = run(claude('gh pr create --fill'));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const allowed = run(claude('git status'));
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
    const garbage = spawnSync(
      process.execPath,
      [CLI, 'hook', 'pre-pr', '--agent', 'claude'],
      { input: 'not json', encoding: 'utf8', env: env() },
    );
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  });
});
