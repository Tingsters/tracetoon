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
    let note: string | undefined;
    if (t.agent === 'codex') note = codexNote(t);
    if (t.agent === 'antigravity') {
      const bad = antigravityInvalidBlocks(next).filter((n) => n !== 'tracetoon');
      note = bad.length
        ? `Warning: Antigravity ignores this whole file because of an invalid block from another tool (${bad.join(', ')}). Fix or remove it to activate the hook.`
        : 'Restart the Antigravity IDE to load it.';
    }
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

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const HANDLER_EVENTS = new Set([
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'Stop',
]);

/**
 * Named blocks in Antigravity's hooks.json that Antigravity will reject. One bad
 * block makes it ignore the whole file, Tracetoon's hook included, so this is
 * worth telling the user about. Tool events take matcher blocks with a `hooks`
 * list; the other events take handlers (with `command`) directly.
 */
export function antigravityInvalidBlocks(data: Json): string[] {
  const bad: string[] = [];
  for (const [name, block] of Object.entries(data)) {
    if (!block || typeof block !== 'object') {
      bad.push(name);
      continue;
    }
    const handlerOk = (h: unknown) => !!h && typeof (h as Json).command === 'string';
    const ok = Object.entries(block as Json).every(([event, list]) => {
      if (event === 'enabled') return typeof list === 'boolean';
      if (!Array.isArray(list))
        return !TOOL_EVENTS.has(event) && !HANDLER_EVENTS.has(event);
      if (TOOL_EVENTS.has(event))
        return list.every((m) => m && Array.isArray(m.hooks) && m.hooks.every(handlerOk));
      if (HANDLER_EVENTS.has(event)) return list.every(handlerOk);
      return true;
    });
    if (!ok) bad.push(name);
  }
  return bad;
}

/** Whether Codex has trusted Tracetoon's hook (`/hooks`), from ~/.codex/config.toml. */
function codexTrusted(t: HookTarget, data: Json): boolean | undefined {
  const groups: Json[] = Array.isArray(data.hooks?.PreToolUse)
    ? data.hooks.PreToolUse
    : [];
  const i = groups.findIndex(
    (g) => Array.isArray(g?.hooks) && g.hooks.some((h: Json) => isOurs(h?.command)),
  );
  if (i < 0) return undefined;
  try {
    const toml = readFileSync(join(dirname(t.file), 'config.toml'), 'utf8');
    return toml.includes(`hooks.json:pre_tool_use:${i}:0'`);
  } catch {
    return false;
  }
}

export interface HookState {
  agent: HookAgent;
  label: string;
  present: boolean;
  installed: boolean;
  file: string;
  /** Something that stops the hook from running even though it's installed. */
  problem?: string;
}

/** Whether each agent currently has the Tracetoon hook, and whether it will actually run. */
export function hookStatus(targets = hookTargets()): HookState[] {
  return targets.map((t) => {
    let data: Json = {};
    let unreadable = false;
    try {
      data = readStrict(t.file);
    } catch {
      unreadable = true;
    }
    const installed =
      !unreadable &&
      JSON.stringify(data).includes('hook pre-pr') &&
      /tracetoon/i.test(JSON.stringify(data));
    const state: HookState = {
      agent: t.agent,
      label: t.label,
      present: t.present,
      installed,
      file: t.file,
    };
    if (unreadable) state.problem = `${t.file} is not valid JSON`;
    else if (installed && t.agent === 'antigravity') {
      const bad = antigravityInvalidBlocks(data).filter((n) => n !== 'tracetoon');
      if (bad.length) {
        state.problem = `Antigravity ignores the whole hooks file because of an invalid block from another tool (${bad.join(', ')}); fix or remove it to activate the hook`;
      }
    } else if (installed && t.agent === 'codex' && codexTrusted(t, data) === false) {
      state.problem = 'not trusted yet: run /hooks in Codex and trust the Tracetoon hook';
    }
    return state;
  });
}
