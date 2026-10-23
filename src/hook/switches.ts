/**
 * Whether Tracetoon should handle PRs here. Default on; any "off" wins:
 *   1. TRACETOON=0 in the environment (also the per-command bypass)
 *   2. CI (CI=true), unless TRACETOON=1 asks for it explicitly
 *   3. the repo's shared setting:   .github/tracetoon.json {"enabled": false}
 *   4. the repo's personal setting: git config tracetoon.enabled false
 *   5. the user's setting:          tracetoon config set enabled false
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userConfigPath, repoConfigPath } from '../config.ts';
import { git } from '../util/exec.ts';

export type Decider = 'env' | 'ci' | 'repo' | 'local' | 'user' | 'default';

export interface SwitchState {
  enabled: boolean;
  decidedBy: Decider;
  /** Plain-language explanation, for `status` and the skill. */
  why: string;
}

const OFF = /^(0|false|off|no)$/i;
const ON = /^(1|true|on|yes)$/i;

function readEnabled(path: string): boolean | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { enabled?: unknown }).enabled;
    return typeof v === 'boolean' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function repoRoot(cwd: string): string | undefined {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.trim() : undefined;
}

export function switchState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SwitchState {
  const t = env.TRACETOON?.trim();
  if (t && OFF.test(t))
    return { enabled: false, decidedBy: 'env', why: 'TRACETOON=0 is set' };
  const ci = env.CI?.trim();
  if (ci && ON.test(ci) && !(t && ON.test(t))) {
    return {
      enabled: false,
      decidedBy: 'ci',
      why: 'running in CI (set TRACETOON=1 to use it there)',
    };
  }
  const root = repoRoot(cwd);
  if (root) {
    if (readEnabled(repoConfigPath(root)) === false) {
      return {
        enabled: false,
        decidedBy: 'repo',
        why: `this repo turns it off in ${join('.github', 'tracetoon.json')}`,
      };
    }
    const local = git(root, ['config', '--get', 'tracetoon.enabled']);
    if (local.ok && OFF.test(local.stdout.trim())) {
      return {
        enabled: false,
        decidedBy: 'local',
        why: 'turned off for this repo on this machine (git config tracetoon.enabled)',
      };
    }
  }
  if (readEnabled(userConfigPath()) === false) {
    return {
      enabled: false,
      decidedBy: 'user',
      why: 'turned off in your Tracetoon settings',
    };
  }
  return { enabled: true, decidedBy: 'default', why: 'default setting' };
}
