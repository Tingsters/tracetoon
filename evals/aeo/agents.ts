/**
 * How to run each agent CLI headlessly. To add an agent: add a HostId in
 * fixture.ts (it must be a host in src/integrations/registry.ts, which says
 * where its skill lives), a stdout parser and adapter ids in score.ts, and an
 * entry here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Fixture, HostId } from './fixture.ts';

export interface AgentContext {
  prompt: string;
  web: boolean;
  fixture: Fixture;
  /** The CLI's own help text, for flags that differ between versions. */
  help: string;
}

export interface AgentSpec {
  id: HostId;
  label: string;
  bin: string;
  /** Arguments that print help listing the headless flags. */
  helpArgs: string[];
  /** Environment variables, any one of which authenticates it. */
  keys: string[];
  /** Files under the real HOME that hold a local login (copied only with --copy-credentials). */
  credentials: { from: string; to: string }[];
  /** Whether --web off can actually remove web tools. */
  webToggle: boolean;
  args(ctx: AgentContext): string[];
  /** Extra setup in the fixture before the run (config files). */
  prepare?(ctx: AgentContext): void;
}

const has = (help: string, flag: string) => help.includes(flag);

export const AGENTS: Record<HostId, AgentSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    helpArgs: ['--help'],
    keys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    credentials: [{ from: '.claude/.credentials.json', to: '.claude/.credentials.json' }],
    webToggle: true,
    args({ prompt, web }) {
      const a = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
      // The fixture is a throwaway temp world, so no permission prompts at all;
      // anything else would measure the permission system, not discovery.
      a.push('--permission-mode', 'bypassPermissions');
      if (!web) a.push('--disallowedTools', 'WebFetch,WebSearch');
      if (process.env.AEO_CLAUDE_MODEL) a.push('--model', process.env.AEO_CLAUDE_MODEL);
      return a;
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    helpArgs: ['exec', '--help'],
    keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    credentials: [{ from: '.codex/auth.json', to: '.codex/auth.json' }],
    webToggle: true,
    args({ prompt, web, fixture, help }) {
      const a = ['exec', '--json', '-C', fixture.repo];
      if (has(help, '--full-auto')) a.push('--full-auto');
      else
        a.push(
          '--sandbox',
          process.env.AEO_CODEX_SANDBOX ?? 'workspace-write',
          '-c',
          'approval_policy="never"',
        );
      // The remote and the temp HOME live next to the repo.
      if (has(help, '--add-dir')) a.push('--add-dir', fixture.dir);
      if (web && has(help, '--search')) a.push('--search');
      if (!web) a.push('-c', 'web_search="disabled"');
      if (
        fixture.condition === 'skill+hook' &&
        has(help, '--dangerously-bypass-hook-trust')
      )
        a.push('--dangerously-bypass-hook-trust');
      if (process.env.AEO_CODEX_MODEL) a.push('--model', process.env.AEO_CODEX_MODEL);
      a.push(prompt);
      return a;
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    helpArgs: ['run', '--help'],
    keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    credentials: [
      { from: '.local/share/opencode/auth.json', to: '.local/share/opencode/auth.json' },
    ],
    webToggle: true,
    args({ prompt, help }) {
      const a = ['run', '--format', 'json'];
      if (has(help, '--auto')) a.push('--auto');
      const model = process.env.AEO_OPENCODE_MODEL ?? process.env.OPENCODE_MODEL;
      if (model) a.push('--model', model);
      a.push(prompt);
      return a;
    },
    prepare({ web, fixture }) {
      if (web) return;
      const dir = join(fixture.env.XDG_CONFIG_HOME!, 'opencode');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'opencode.json'),
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          tools: { webfetch: false, websearch: false },
          permission: { webfetch: 'deny', websearch: 'deny' },
        }),
      );
    },
  },
};

/** The CLI's absolute path, or undefined when it is not installed. */
export function resolveBin(bin: string): string | undefined {
  return Bun.which(bin) ?? undefined;
}

export function helpText(path: string, args: string[]): string {
  const r = runSync(path, args, 20_000);
  return `${r.stdout}\n${r.stderr}`;
}

export function version(path: string): string | undefined {
  const r = runSync(path, ['--version'], 20_000);
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : undefined;
}

function runSync(path: string, args: string[], timeout: number) {
  const cmd = /\.(cmd|bat)$/i.test(path);
  const r = cmd
    ? spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', `"${[path, ...args].map(quoteCmd).join(' ')}"`],
        {
          encoding: 'utf8',
          timeout,
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      )
    : spawnSync(path, args, { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Quote one argument for cmd.exe running a .cmd shim. */
export function quoteCmd(a: string): string {
  if (/^[\w.:\\/=,-]+$/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Why an agent cannot run here (missing key and no usable local login), or undefined. */
export function authProblem(
  spec: AgentSpec,
  copyCredentials: boolean,
): string | undefined {
  if (spec.keys.some((k) => process.env[k])) return undefined;
  const files = spec.credentials.filter((c) => existsSync(join(homedir(), c.from)));
  if (!files.length)
    return `no ${spec.keys.join(' / ')} and no local login file to reuse`;
  if (!copyCredentials)
    return `no ${spec.keys.join(' / ')}; pass --copy-credentials to reuse the local login`;
  // A token close to expiry would be refreshed inside the fixture, and a refresh can
  // rotate the refresh token the real login still holds. Only reuse fresh tokens.
  if (spec.id === 'claude') {
    try {
      const c = JSON.parse(readFileSync(join(homedir(), files[0]!.from), 'utf8'));
      const exp = Number(c?.claudeAiOauth?.expiresAt ?? 0);
      if (exp && exp - Date.now() < 30 * 60_000)
        return 'local Claude login expires within 30 minutes; refresh it (run claude once) and retry';
    } catch {
      return 'could not read the local Claude login';
    }
  }
  return undefined;
}
