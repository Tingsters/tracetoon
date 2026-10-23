/**
 * Registers the PR hook with each agent found on the machine, and removes it.
 *
 *   Claude Code  ~/.claude/settings.json        PreToolUse, matcher Bash|PowerShell
 *   Codex        ~/.codex/hooks.json            PreToolUse, matcher Bash
 *   Antigravity  ~/.gemini/config/hooks.json    a "tracetoon" block, matcher run_command
 *
 * Only Tracetoon's own entries are ever touched (recognized by "tracetoon … hook
 * pre-pr" in the command), re-running replaces them instead of adding more, a
 * file that isn't valid JSON is left alone, and each file is backed up once
 * (<file>.tracetoon.bak) before the first change.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HookAgent } from './prHook.ts';

export interface HookTarget {
  agent: HookAgent;
  label: string;
  file: string;
  /** The agent is installed on this machine. */
  present: boolean;
}

export function hookTargets(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): HookTarget[] {
  const claude = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const codex = env.CODEX_HOME || join(home, '.codex');
  const gemini = env.GEMINI_HOME || join(home, '.gemini');
  return [
    {
      agent: 'claude',
      label: 'Claude Code',
      file: join(claude, 'settings.json'),
      present: existsSync(claude),
    },
    {
      agent: 'codex',
      label: 'Codex',
      file: join(codex, 'hooks.json'),
      present: existsSync(codex),
    },
    {
      agent: 'antigravity',
      label: 'Antigravity',
      file: join(gemini, 'config', 'hooks.json'),
      present:
        existsSync(join(gemini, 'antigravity-cli')) ||
        existsSync(join(gemini, 'antigravity-ide')),
    },
  ];
}

const isOurs = (command: unknown) =>
  typeof command === 'string' &&
  /tracetoon/i.test(command) &&
  command.includes('hook pre-pr');

/** The shell command each agent runs. Forward slashes work in bash, cmd and PowerShell. */
export function hookCommand(agent: HookAgent, program: string | string[]): string {
  const parts = (Array.isArray(program) ? program : [program]).map((p) => {
    const f = p.replace(/\\/g, '/');
    return /\s/.test(f) ? `"${f}"` : f;
  });
  return `${parts.join(' ')} hook pre-pr --agent ${agent}`;
}

type Json = Record<string, any>;

function readStrict(file: string): Json {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text); // throws on invalid JSON: never overwrite what we can't read
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  return parsed as Json;
}

function write(file: string, data: Json): void {
  if (existsSync(file) && !existsSync(`${file}.tracetoon.bak`))
    copyFileSync(file, `${file}.tracetoon.bak`);
  if (Object.keys(data).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function withoutOurGroups(groups: unknown): Json[] {
  if (!Array.isArray(groups)) return [];
  return groups.filter(
    (g) =>
      !(g && Array.isArray(g.hooks) && g.hooks.some((h: Json) => isOurs(h?.command))),
  );
}

function setPreToolUse(data: Json, group: Json | undefined): Json {
  const hooks: Json = { ...(data.hooks ?? {}) };
  const kept = withoutOurGroups(hooks.PreToolUse);
  const next = group ? [...kept, group] : kept;
  if (next.length) hooks.PreToolUse = next;
  else delete hooks.PreToolUse;
  const out = { ...data };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

function apply(target: HookTarget, data: Json, command: string | undefined): Json {
  if (target.agent === 'antigravity') {
    const out = { ...data };
    delete out.tracetoon;
    if (command) {
      out.tracetoon = {
        enabled: true,
        PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command }] }],
      };
    }
    return out;
  }
  const matcher = target.agent === 'claude' ? 'Bash|PowerShell' : 'Bash';
  return setPreToolUse(
    data,
    command ? { matcher, hooks: [{ type: 'command', command, timeout: 10 }] } : undefined,
  );
}

export interface HookChange {
  agent: HookAgent;
  label: string;
  file: string;
  result: 'installed' | 'removed' | 'unchanged' | 'skipped';
  note?: string;
}

function codexNote(target: HookTarget): string {
  const toml = join(dirname(target.file), 'config.toml');
  try {
    if (/^\s*hooks\s*=\s*false/m.test(readFileSync(toml, 'utf8'))) {
      return 'Codex hooks are turned off in config.toml ([features] hooks = false); Tracetoon leaves that alone.';
    }
  } catch {
    /* no config.toml */
  }
  return 'In Codex, run /hooks once and trust the Tracetoon hook.';
}

export function installHooks(
  program: string | string[],
  targets = hookTargets(),
): HookChange[] {
  return targets.map((t) => {
    if (!t.present)
      return {
        agent: t.agent,
        label: t.label,
        file: t.file,
        result: 'skipped',
        note: 'not installed',
      };
    let data: Json;
    try {
      data = readStrict(t.file);
    } catch (e) {
      return {
        agent: t.agent,
        label: t.label,
        file: t.file,
        result: 'skipped',
        note: `could not read it (${(e as Error).message}); left untouched`,
      };
    }
    const next = apply(t, data, hookCommand(t.agent, program));
    if (JSON.stringify(next) === JSON.stringify(data)) {
      return { agent: t.agent, label: t.label, file: t.file, result: 'unchanged' };
    }
    write(t.file, next);
    const note =
      t.agent === 'codex'
        ? codexNote(t)
        : t.agent === 'antigravity'
          ? 'Restart the Antigravity IDE to load it.'
          : undefined;
    return { agent: t.agent, label: t.label, file: t.file, result: 'installed', note };
  });
}

export function uninstallHooks(targets = hookTargets()): HookChange[] {
  return targets.map((t) => {
    let data: Json;
    try {
      data = readStrict(t.file);
    } catch {
      return {
        agent: t.agent,
        label: t.label,
        file: t.file,
        result: 'skipped',
        note: 'could not read it; left untouched',
      };
    }
    const next = apply(t, data, undefined);
    if (JSON.stringify(next) === JSON.stringify(data)) {
      return { agent: t.agent, label: t.label, file: t.file, result: 'unchanged' };
    }
    write(t.file, next);
    return { agent: t.agent, label: t.label, file: t.file, result: 'removed' };
  });
}

/** Whether each agent currently has the Tracetoon hook. */
export function hookStatus(targets = hookTargets()): {
  agent: HookAgent;
  label: string;
  present: boolean;
  installed: boolean;
  file: string;
}[] {
  return targets.map((t) => {
    let installed = false;
    try {
      installed = isOurs(
        readFileSync(t.file, 'utf8').match(/"command":\s*"([^"]*hook pre-pr[^"]*)"/)?.[1],
      );
    } catch {
      /* missing file */
    }
    return {
      agent: t.agent,
      label: t.label,
      present: t.present,
      installed,
      file: t.file,
    };
  });
}
