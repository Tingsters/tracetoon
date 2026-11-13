/**
 * Registers PR routing plus passive session and observation hooks with every
 * host that has a hook (see src/integrations). Each host owns its config file
 * and format; this module only reads, asks the host to merge, and writes.
 *
 * Only Tracetoon's own entries are ever touched (recognized by "tracetoon … hook
 * pre-pr/lifecycle" in the command), re-running replaces them instead of adding more, a
 * file that isn't valid JSON is left alone, and each file is backed up once
 * (<file>.tracetoon.bak) before the first change.
 */
import { homedir } from 'node:os';
import { INTEGRATIONS, integration } from '../integrations/registry.ts';
import type { HookCommands, HookIntegration, Json } from '../integrations/types.ts';
import { readStrict, writeConfig } from './config.ts';

export interface HookTarget {
  /** The host id hooks pass as `--agent`. */
  agent: string;
  label: string;
  file: string;
  /** The agent is installed on this machine. */
  present: boolean;
}

export function hookTargets(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): HookTarget[] {
  return INTEGRATIONS.filter((i) => i.hook).map((i) => ({
    agent: i.id,
    label: i.label,
    file: i.hook!.file(home, env),
    present: i.hook!.present(home, env),
  }));
}

const hookOf = (t: HookTarget): HookIntegration => {
  const hook = integration(t.agent)?.hook;
  if (!hook) throw new Error(`no hook integration for ${t.agent}`);
  return hook;
};

/** The shell command each agent runs. Forward slashes work in bash, cmd and PowerShell. */
export function hookCommand(agent: string, program: string | string[]): string {
  const parts = (Array.isArray(program) ? program : [program]).map((p) => {
    const f = p.replace(/\\/g, '/');
    return /\s/.test(f) ? `"${f}"` : f;
  });
  return `${parts.join(' ')} hook pre-pr --agent ${agent}`;
}

function commandsFor(agent: string, program: string | string[]): HookCommands {
  const prePr = hookCommand(agent, program);
  return {
    prePr,
    lifecycle: (event) =>
      prePr.replace(/hook pre-pr --agent/, 'hook lifecycle --agent') +
      ` --event ${event}`,
  };
}

export interface HookChange {
  agent: string;
  label: string;
  file: string;
  result: 'installed' | 'removed' | 'unchanged' | 'skipped';
  note?: string;
}

export function installHooks(
  program: string | string[],
  targets = hookTargets(),
): HookChange[] {
  return targets.map((t) => {
    const base = { agent: t.agent, label: t.label, file: t.file };
    if (!t.present) return { ...base, result: 'skipped', note: 'not installed' };
    let data: Json;
    try {
      data = readStrict(t.file);
    } catch (e) {
      return {
        ...base,
        result: 'skipped',
        note: `could not read it (${(e as Error).message}); left untouched`,
      };
    }
    const hook = hookOf(t);
    const next = hook.apply(data, commandsFor(t.agent, program));
    if (JSON.stringify(next) === JSON.stringify(data))
      return { ...base, result: 'unchanged' };
    writeConfig(t.file, next);
    return { ...base, result: 'installed', note: hook.installNote?.(t.file, next) };
  });
}

export function uninstallHooks(targets = hookTargets()): HookChange[] {
  return targets.map((t) => {
    const base = { agent: t.agent, label: t.label, file: t.file };
    let data: Json;
    try {
      data = readStrict(t.file);
    } catch {
      return { ...base, result: 'skipped', note: 'could not read it; left untouched' };
    }
    const next = hookOf(t).apply(data, undefined);
    if (JSON.stringify(next) === JSON.stringify(data))
      return { ...base, result: 'unchanged' };
    writeConfig(t.file, next);
    return { ...base, result: 'removed' };
  });
}

export interface HookState {
  agent: string;
  label: string;
  present: boolean;
  installed: boolean;
  file: string;
  /** Something that stops the hook from running even though it's installed. */
  problem?: string;
  /** @deprecated Legacy installation information; completion hooks are no longer required. */
  completionInstalled?: boolean;
  /** Configured command; installation is not proof the host trusted/reloaded it. */
  command?: string;
  coverage?: string;
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
    const text = JSON.stringify(data);
    const installed =
      !unreadable && text.includes('hook pre-pr') && /tracetoon/i.test(text);
    const hook = hookOf(t);
    const state: HookState = {
      agent: t.agent,
      label: t.label,
      present: t.present,
      installed,
      file: t.file,
      completionInstalled:
        text.includes('hook lifecycle') && text.includes('--event Stop'),
      command: hook.installedCommand(data),
      coverage:
        'PR creation through recognized shell commands and GitHub connectors; existing PR operations, pushes and read-only commands are left alone. Arbitrary network scripts are not intercepted.',
    };
    if (unreadable) state.problem = `${t.file} is not valid JSON`;
    else if (installed) state.problem = hook.problem?.(t.file, data);
    if (state.problem === undefined) delete state.problem;
    return state;
  });
}
