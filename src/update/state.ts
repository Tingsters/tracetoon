/**
 * What the last update check found, and the SessionStart notice built from it.
 * A session never waits on the network: it reads this file, and a stale one is
 * refreshed by a detached `tracetoon update --check` process.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadConfig, userConfigPath } from '../config.ts';
import { readLocal, writeLocal } from '../util/localJson.ts';
import { TOOL_VERSION } from '../version.ts';
import { installLayout, updatable } from './layout.ts';
import { compareVersions } from './version.ts';

export interface UpdateState {
  /** When the releases list was last read. */
  checkedAt?: string;
  latest?: string;
  tag?: string;
  channel?: string;
  /** When a check process was last started, so a failing one is not respawned every session. */
  spawnedAt?: string;
  notifiedAt?: string;
  notifiedVersion?: string;
}

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const RESPAWN_AFTER_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;

const dir = (env: NodeJS.ProcessEnv) => dirname(env.TRACETOON_CONFIG ?? userConfigPath());
export const statePath = (env: NodeJS.ProcessEnv = process.env) =>
  join(dir(env), 'update-state.json');
const lockPath = (env: NodeJS.ProcessEnv) => join(dir(env), 'update.lock');

export const readState = (env: NodeJS.ProcessEnv = process.env): UpdateState =>
  readLocal<UpdateState>(statePath(env)) ?? {};

export function writeState(env: NodeJS.ProcessEnv, patch: Partial<UpdateState>): void {
  writeLocal(statePath(env), { ...readState(env), ...patch });
}

/** One updater at a time (a background install and a user's `update` must not interleave). */
export function takeLock(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): (() => void) | undefined {
  const p = lockPath(env);
  try {
    if (existsSync(p) && now - Number(readFileSync(p, 'utf8')) < LOCK_STALE_MS)
      return undefined;
  } catch {
    /* unreadable lock: treat as stale */
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(now));
  return () => rmSync(p, { force: true });
}

/** Run `tracetoon <args>` detached, however this process was started. */
function spawnSelf(args: string[], env: NodeJS.ProcessEnv): void {
  const binary = /^tracetoon(-[a-z]+-[a-z0-9]+)?(\.exe)?$/i.test(
    basename(process.execPath),
  );
  const argv = binary ? args : [process.argv[1]!, ...args];
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.on('error', () => {});
  child.unref();
}

export interface NoticeDeps {
  now?: number;
  /** Whether this process is the installed binary, which is all `update` can replace. */
  eligible?: boolean;
  spawn?: (args: string[]) => void;
}

/** The SessionStart output about updates, or nothing. Only reads local files. */
export function updateNotice(
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: NoticeDeps = {},
): string | undefined {
  if (env.TRACETOON_NO_UPDATE_CHECK === '1' || env.TRACETOON_DISABLE_UPDATES === '1')
    return;
  const config = loadConfig();
  if (config.autoUpdate === 'off') return;
  const eligible =
    deps.eligible ?? updatable(installLayout(env), process.execPath, env).ok;
  if (!eligible) return;
  const now = deps.now ?? Date.now();
  const start = deps.spawn ?? ((args: string[]) => spawnSelf(args, env));
  const state = readState(env);

  const stale =
    !state.checkedAt ||
    state.channel !== config.updateChannel ||
    now - Date.parse(state.checkedAt) > CHECK_EVERY_MS;
  if (
    stale &&
    (!state.spawnedAt || now - Date.parse(state.spawnedAt) > RESPAWN_AFTER_MS)
  ) {
    writeState(env, { spawnedAt: new Date(now).toISOString() });
    start(['update', '--check', '--quiet']);
  }

  if (
    !state.latest ||
    state.channel !== config.updateChannel ||
    compareVersions(state.latest, TOOL_VERSION) <= 0
  )
    return;

  let text: string;
  if (config.autoUpdate === 'install') {
    if (!existsSync(lockPath(env))) start(['update', '--auto', '--quiet']);
    text = `Tracetoon ${state.latest} is being installed in the background (you have ${TOOL_VERSION}). Reload your agent when it finishes.`;
  } else {
    text = `Tracetoon ${state.latest} is available (you have ${TOOL_VERSION}). Run: tracetoon update`;
  }
  // Said once a day per version, not at every resume or clear.
  if (
    state.notifiedVersion === state.latest &&
    state.notifiedAt &&
    now - Date.parse(state.notifiedAt) < CHECK_EVERY_MS
  )
    return;
  writeState(env, {
    notifiedAt: new Date(now).toISOString(),
    notifiedVersion: state.latest,
  });
  // Antigravity's handling of SessionStart output is unverified, so it gets none.
  if (agent !== 'claude' && agent !== 'codex') return;
  return JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `${text} If the user asks to update, run \`tracetoon update --check --json\`, summarize what changed, confirm with them, then run \`tracetoon update\`. Do not update on your own.`,
    },
  });
}
