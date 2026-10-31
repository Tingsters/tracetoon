/** `tracetoon on|off|status` and `tracetoon hook install|uninstall`. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoConfigPath, setUserConfig } from '../config.ts';
import {
  hookStatus,
  installHooks,
  uninstallHooks,
  type HookChange,
} from '../hook/install.ts';
import { repoRoot, switchState } from '../hook/switches.ts';
import { git } from '../util/exec.ts';
import { selfProgram, userCommand } from '../util/userCommand.ts';
export { userCommand } from '../util/userCommand.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import { taskSummary } from '../workflow/state.ts';
import { BUILD_INFO } from '../version.ts';

export interface ScopeOpts extends OutOpts {
  repo?: boolean;
  local?: boolean;
}

function setRepoEnabled(root: string, enabled: boolean): string {
  const p = repoConfigPath(root);
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(p)) data = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new UserError(`${p} is not valid JSON; fix it first.`);
  }
  data.enabled = enabled;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return p;
}

export function setEnabledCmd(cwd: string, enabled: boolean, opts: ScopeOpts): void {
  let where: string;
  if (opts.repo || opts.local) {
    const root = repoRoot(cwd);
    if (!root) throw new UserError('Not inside a git repository.');
    if (opts.repo) {
      where = `${setRepoEnabled(root, enabled)} (commit it to apply for everyone)`;
    } else {
      const r = enabled
        ? git(root, ['config', '--unset', 'tracetoon.enabled'])
        : git(root, ['config', 'tracetoon.enabled', 'false']);
      // `--unset` exits 5 when the key isn't set, which is fine when turning on.
      if (!r.ok && !(enabled && r.code === 5))
        throw new UserError(`git config failed: ${r.stderr.trim()}`);
      where = 'this repo, on this machine only (git config tracetoon.enabled)';
    }
  } else {
    setUserConfig('enabled', String(enabled));
    where = 'your Tracetoon settings (every repo)';
  }
  const state = switchState(cwd);
  emit(opts, { enabled: state.enabled, decidedBy: state.decidedBy, changed: where }, () =>
    [
      `Tracetoon turned ${enabled ? 'on' : 'off'} in ${where}.`,
      state.enabled === enabled
        ? ''
        : `Note: it is still ${state.enabled ? 'on' : 'off'} here because ${state.why}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export function statusCmd(cwd: string, opts: OutOpts): void {
  const state = switchState(cwd);
  const hooks = hookStatus();
  const command = userCommand();
  const root = repoRoot(cwd);
  const gitDir = root
    ? git(root, ['rev-parse', '--absolute-git-dir']).stdout.trim()
    : undefined;
  const workflowTasks = gitDir ? taskSummary(gitDir) : [];
  emit(
    opts,
    {
      ...state,
      hooks,
      command,
      build: BUILD_INFO,
      tasks: workflowTasks,
    },
    () =>
      [
        `Tracetoon is ${state.enabled ? 'ON' : 'OFF'} here: ${state.why}.`,
        `In your own terminal, run it as: ${command.run}`,
        'PR hook:',
        ...hooks
          .filter((h) => h.present)
          .map(
            (h) =>
              `  ${h.label.padEnd(12)} ${h.installed ? (h.problem ? 'installed, NOT ACTIVE' : 'configured') : 'not installed'}${h.installed && !h.completionInstalled ? '; completion hooks missing' : ''}${
                h.problem ? `\n               ${h.problem}` : ''
              }`,
          ),
        state.enabled
          ? 'Turn off: tracetoon off [--repo | --local], or TRACETOON=0 for one command.'
          : 'Turn on: tracetoon on [--repo | --local].',
        ...workflowTasks
          .filter((t) => ['preparing', 'blocked'].includes(t.state))
          .map(
            (t) =>
              `Task ${t.run}: ${t.state}${t.reason ? ` (${t.reason})` : ''}. ${t.nextAction}`,
          ),
      ].join('\n'),
  );
}

function report(opts: OutOpts, changes: HookChange[]): void {
  emit(
    opts,
    { changes },
    () =>
      changes
        .filter((c) => c.result !== 'skipped' || c.note !== 'not installed')
        .map(
          (c) =>
            `  ${c.label.padEnd(12)} ${c.result}: ${c.file}${c.note ? `\n               ${c.note}` : ''}`,
        )
        .join('\n') || '  no agents found',
  );
}

export function hookInstallCmd(opts: OutOpts & { program?: string }): void {
  report(opts, installHooks(opts.program ? [opts.program] : selfProgram()));
}

export function hookUninstallCmd(opts: OutOpts): void {
  report(opts, uninstallHooks());
}
