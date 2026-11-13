/**
 * Every host integration is self-contained (no host folder imports another), and
 * every hook integration honours the same contract: idempotent install, clean
 * uninstall, a parseable deny, and its own payloads recognized.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  ADAPTERS,
  HOOK_IDS,
  INTEGRATIONS,
  currentSessionId,
  isHostSessionVar,
  resolveHookHost,
  skillTargets,
} from '../src/integrations/registry.ts';
import type { HookCommands } from '../src/integrations/types.ts';
import { decide, DENY_REASON } from '../src/hook/prHook.ts';
import { tempDir } from './helpers.ts';

const SRC = resolve(import.meta.dir, '../src');
const HOSTS = resolve(SRC, 'integrations');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const imports = (file: string) =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    ),
  ].map((m) => resolve(file, '..', m[1]!));
const hostOf = (file: string) => {
  const rel = relative(HOSTS, file);
  return rel.startsWith('..') || !rel.includes(sep) ? undefined : rel.split(sep)[0];
};

/** One payload per hook host, in that host's own shape, running `command`. */
const PAYLOADS: Record<string, (command: string, cwd: string) => unknown> = {
  claude: (command, cwd) => ({
    session_id: 's1',
    transcript_path: '/t.jsonl',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  }),
  codex: (command, cwd) => ({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command, workdir: cwd },
  }),
  factory: (command, cwd) => ({
    session_id: 's1',
    transcript_path: '/t.jsonl',
    cwd,
    permission_mode: 'auto-medium',
    hook_event_name: 'PreToolUse',
    tool_name: 'Execute',
    tool_input: { command, summary: 'run it', riskLevel: 'low' },
  }),
  // Copilot CLI's camelCase payload; toolArgs is an object for shell tools.
  copilot: (command, cwd) => ({
    sessionId: 's1',
    timestamp: 1794569002608,
    cwd,
    toolCallId: 'call_1',
    toolName: 'powershell',
    toolArgs: { command, description: 'run it' },
  }),
  antigravity: (command, cwd) => ({
    conversationId: 'c1',
    transcriptPath: '/t.jsonl',
    workspacePaths: [cwd],
    toolCall: {
      name: 'run_command',
      args: { CommandLine: JSON.stringify(command), Cwd: cwd },
    },
  }),
};

const env = () => ({ TRACETOON_CONFIG: join(tempDir('tt-cfg-'), 'config.json') });

describe('isolation', () => {
  test('no host folder imports another host folder', () => {
    const bad: string[] = [];
    for (const file of files(HOSTS)) {
      const own = hostOf(file);
      if (!own) continue;
      for (const target of imports(file)) {
        const other = hostOf(target);
        if (other && other !== own)
          bad.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('only the registry imports host folders', () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      if (hostOf(file) || file === join(HOSTS, 'registry.ts')) continue;
      for (const target of imports(file))
        if (hostOf(target))
          bad.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
    }
    expect(bad).toEqual([]);
  });

  test('ids, trace ids and hook config files are unique', () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const traceIds = ADAPTERS.map((a) => a.id);
    expect(new Set(traceIds).size).toBe(traceIds.length);
    const home = tempDir();
    const hookFiles = INTEGRATIONS.flatMap((i) =>
      i.hook ? [i.hook.file(home, {})] : [],
    );
    expect(new Set(hookFiles).size).toBe(hookFiles.length);
  });
});

describe('hook contract', () => {
  const commands: HookCommands = {
    prePr: '/opt/tracetoon/bin/tracetoon hook pre-pr --agent X',
    lifecycle: (e) =>
      `/opt/tracetoon/bin/tracetoon hook lifecycle --agent X --event ${e}`,
    argv: {
      prePr: ['/opt/tracetoon/bin/tracetoon', 'hook', 'pre-pr', '--agent', 'X'],
      lifecycle: (e) => [
        '/opt/tracetoon/bin/tracetoon',
        'hook',
        'lifecycle',
        '--agent',
        'X',
        '--event',
        e,
      ],
    },
  };
  const foreign = { other: { hooks: [{ command: 'not-ours' }] }, hooks: {} };

  for (const i of INTEGRATIONS.filter((i) => i.hook)) {
    const hook = i.hook!;
    test(`${i.label}: install is idempotent and uninstall restores the config`, () => {
      const once = hook.apply(foreign, commands);
      expect(hook.apply(once, commands)).toEqual(once);
      expect(hook.installedCommand(once)).toBe(commands.prePr);
      expect(JSON.stringify(once)).toContain('not-ours');
      const removed = hook.apply(once, undefined);
      expect(hook.installedCommand(removed)).toBeUndefined();
      expect(removed.other).toEqual(foreign.other);
      expect(JSON.stringify(removed)).not.toContain('tracetoon');
    });

    test(`${i.label}: has a payload fixture, parses it and denies in its own format`, () => {
      const make = PAYLOADS[i.id];
      expect(make).toBeDefined();
      const p = hook.parse(make!('gh pr create', tempDir()));
      expect(p?.command).toBe('gh pr create');
      expect(p?.sessionId).toBeTruthy();
      expect(() => JSON.parse(hook.deny('no'))).not.toThrow();
      expect(hook.parse('nonsense')).toBeUndefined();
      expect(hook.parse({})).toBeUndefined();
    });
  }
});

describe('cross-host hooks', () => {
  test('each host recognizes only its own payloads, or the shared Claude-style shape', () => {
    for (const [id, make] of Object.entries(PAYLOADS)) {
      const resolved = resolveHookHost(id, make('ls', tempDir()));
      expect(resolved?.host.id).toBe(id);
    }
  });

  test("a payload in another host's shape is answered in that host's format", () => {
    // Hosts that also run hooks registered for Claude Code send their own payloads.
    const answer = decide(
      'claude',
      PAYLOADS.antigravity!('gh pr create', tempDir()),
      env(),
    );
    expect(JSON.parse(answer!)).toEqual({ decision: 'deny', reason: DENY_REASON });
  });

  test('an unrecognized payload is let through', () => {
    expect(
      decide('claude', { something: 'else', command: 'gh pr create' }, env()),
    ).toBeUndefined();
  });

  test('every hook id has a command-line value', () => {
    expect(HOOK_IDS).toEqual(INTEGRATIONS.filter((i) => i.hook).map((i) => i.id));
  });
});

describe('environment', () => {
  test('the nested host session wins', () => {
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: 'a', CODEX_THREAD_ID: 'b' })).toBe(
      'b',
    );
    expect(currentSessionId({ CLAUDE_SESSION_ID: 'a' })).toBe('a');
    expect(currentSessionId({})).toBeUndefined();
  });

  test('host session variables are recognized', () => {
    for (const name of [
      'CODEX_THREAD_ID',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_X',
      'AI_AGENT',
    ])
      expect(isHostSessionVar(name)).toBe(true);
    expect(isHostSessionVar('PATH')).toBe(false);
  });

  test('hosts that share a skill folder get one target', () => {
    const home = tempDir();
    const targets = skillTargets(home, { PATH: '' });
    const dirs = targets.map((t) => t.dir);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('Factory Droid', () => {
  const factory = INTEGRATIONS.find((i) => i.id === 'factory')!;

  test("adds to settings.json when the user's hooks are there, so hooks.json never hides them", () => {
    const home = tempDir();
    const dir = join(home, '.factory');
    mkdirSync(dir, { recursive: true });
    expect(factory.hook!.file(home, {})).toBe(join(dir, 'hooks.json'));
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        model: 'x',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
      }),
    );
    expect(factory.hook!.file(home, {})).toBe(join(dir, 'settings.json'));
    const data = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    const next = factory.hook!.apply(data, {
      prePr: 'tracetoon hook pre-pr --agent factory',
      lifecycle: (e) => `tracetoon hook lifecycle --agent factory --event ${e}`,
    });
    expect(next.model).toBe('x');
    expect(next.hooks.Stop).toEqual(data.hooks.Stop);
    expect(next.hooks.PreToolUse[0].matcher).toBe('Execute');
    expect(next.PreToolUse).toBeUndefined();
  });

  test('spec mode counts as plan mode, and FACTORY_SESSION_ID wins over an outer Claude Code', () => {
    const p = factory.hook!.parse({
      ...(PAYLOADS.factory!('ls', '/r') as object),
      permission_mode: 'spec',
    });
    expect(p?.planMode).toBe(true);
    expect(
      currentSessionId({ CLAUDE_CODE_SESSION_ID: 'outer', FACTORY_SESSION_ID: 'droid' }),
    ).toBe('droid');
  });
});

describe('Copilot', () => {
  test('the blocking lifecycle observer only matches shell and GitHub tools', () => {
    const copilot = INTEGRATIONS.find((i) => i.id === 'copilot')!;
    const data = copilot.hook!.apply(
      {},
      {
        prePr: 'tracetoon hook pre-pr --agent copilot',
        lifecycle: (e) => `tracetoon hook lifecycle --agent copilot --event ${e}`,
        argv: {
          prePr: ['tracetoon', 'hook', 'pre-pr', '--agent', 'copilot'],
          lifecycle: (e) => [
            'tracetoon',
            'hook',
            'lifecycle',
            '--agent',
            'copilot',
            '--event',
            e,
          ],
        },
      },
    );
    const matchers: string[] = data.hooks.preToolUse.map(
      (g: { matcher?: string }) => g.matcher,
    );
    expect(matchers.every(Boolean)).toBe(true);
    const lifecycle = new RegExp(`^(?:${matchers[1]})$`);
    for (const tool of ['powershell', 'bash', 'github-mcp-server-create_pull_request'])
      expect(lifecycle.test(tool)).toBe(true);
    for (const tool of ['view', 'apply_patch', 'grep'])
      expect(lifecycle.test(tool)).toBe(false);
  });
});
