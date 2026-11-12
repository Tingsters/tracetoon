import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { updateCmd } from '../src/commands/update.ts';
import { readState, takeLock, updateNotice, writeState } from '../src/update/state.ts';
import { TOOL_VERSION } from '../src/version.ts';
import { tempDir } from './helpers.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const newer = '99.0.0';

let env: NodeJS.ProcessEnv;
let config: string;
const setConfig = (c: object) => writeFileSync(config, JSON.stringify(c));

beforeEach(() => {
  const dir = tempDir('tracetoon-update-notice-');
  config = join(dir, 'config.json');
  env = { TRACETOON_CONFIG: config };
  process.env.TRACETOON_CONFIG = config; // loadConfig reads the process environment
});

function notice(agent: string, now = NOW, eligible = true) {
  const spawned: string[][] = [];
  const out = updateNotice(agent, env, { now, eligible, spawn: (a) => spawned.push(a) });
  return { out, spawned };
}

describe('update notice', () => {
  test('first session: starts a background check, says nothing yet', () => {
    const { out, spawned } = notice('claude');
    expect(out).toBeUndefined();
    expect(spawned).toEqual([['update', '--check', '--quiet']]);
    // A check that never finishes is not restarted at every session.
    expect(notice('claude', NOW + 60_000).spawned).toEqual([]);
    expect(notice('claude', NOW + 2 * 3600_000).spawned).toHaveLength(1);
  });

  test('says a newer release exists once a day, for hosts known to show it', () => {
    writeState(env, { checkedAt: iso(NOW - 1000), channel: 'latest', latest: newer });
    const first = notice('claude');
    expect(first.spawned).toEqual([]); // fresh check: nothing to refresh
    const parsed = JSON.parse(first.out!);
    expect(parsed.systemMessage).toContain(`Tracetoon ${newer} is available`);
    expect(parsed.systemMessage).toContain('tracetoon update');
    expect(parsed.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'Do not update on your own',
    );
    expect(notice('claude', NOW + 3600_000).out).toBeUndefined(); // already said today
    expect(notice('codex', NOW + 25 * 3600_000).out).toBeDefined(); // said again next day
  });

  test('stays silent where output is unverified, and when current', () => {
    writeState(env, { checkedAt: iso(NOW), channel: 'latest', latest: newer });
    expect(notice('antigravity').out).toBeUndefined();
    writeState(env, {
      latest: TOOL_VERSION,
      notifiedAt: undefined,
      notifiedVersion: undefined,
    });
    expect(notice('claude').out).toBeUndefined();
  });

  test('ignores a result found for a different channel', () => {
    setConfig({ updateChannel: 'stable' });
    writeState(env, { checkedAt: iso(NOW), channel: 'latest', latest: newer });
    const { out, spawned } = notice('claude');
    expect(out).toBeUndefined();
    expect(spawned).toEqual([['update', '--check', '--quiet']]);
  });

  test('every opt-out is honored', () => {
    writeState(env, {
      checkedAt: iso(NOW - 3 * 86400_000),
      channel: 'latest',
      latest: newer,
    });
    setConfig({ autoUpdate: 'off' });
    expect(notice('claude')).toEqual({ out: undefined, spawned: [] });
    setConfig({});
    for (const name of ['TRACETOON_NO_UPDATE_CHECK', 'TRACETOON_DISABLE_UPDATES']) {
      env[name] = '1';
      expect(notice('claude')).toEqual({ out: undefined, spawned: [] });
      delete env[name];
    }
    // Not the installed binary (plugin, checkout): `update` could not act on it.
    expect(notice('claude', NOW, false)).toEqual({ out: undefined, spawned: [] });
  });

  test('autoUpdate=install starts one background install instead of asking', () => {
    setConfig({ autoUpdate: 'install' });
    writeState(env, { checkedAt: iso(NOW), channel: 'latest', latest: newer });
    const { out, spawned } = notice('claude');
    expect(spawned).toEqual([['update', '--auto', '--quiet']]);
    expect(JSON.parse(out!).systemMessage).toContain('being installed in the background');
    // While an updater holds the lock, no second one starts.
    const release = takeLock(env, NOW);
    writeState(env, { notifiedAt: undefined, notifiedVersion: undefined });
    expect(notice('claude', NOW + 1000).spawned).toEqual([]);
    // A lock left behind by a killed updater does not block installs for ever.
    writeState(env, { notifiedAt: undefined, notifiedVersion: undefined });
    expect(notice('claude', NOW + 16 * 60_000).spawned).toEqual([
      ['update', '--auto', '--quiet'],
    ]);
    release!();
  });
});

describe('update lock', () => {
  test('one holder at a time; a stale lock is replaced', () => {
    const release = takeLock(env, NOW)!;
    expect(takeLock(env, NOW + 1000)).toBeUndefined();
    expect(takeLock(env, NOW + 16 * 60_000)).toBeDefined();
    release();
  });
});

describe('settings', () => {
  test('a repo cannot change how this machine updates', () => {
    setConfig({ autoUpdate: 'off', updateChannel: 'stable' });
    const repo = tempDir('tracetoon-repo-');
    mkdirSync(join(repo, '.github'));
    writeFileSync(
      join(repo, '.github', 'tracetoon.json'),
      JSON.stringify({ autoUpdate: 'install', updateChannel: 'latest', comic: 'off' }),
    );
    const c = loadConfig(repo);
    expect(c.autoUpdate).toBe('off');
    expect(c.updateChannel).toBe('stable');
    expect(c.comic).toBe('off'); // other repo settings still apply
  });

  test('defaults: notify on the latest channel; junk values fall back', () => {
    expect(loadConfig()).toMatchObject({ autoUpdate: 'notify', updateChannel: 'latest' });
    setConfig({ autoUpdate: 'sometimes', updateChannel: 7 });
    expect(loadConfig()).toMatchObject({ autoUpdate: 'notify', updateChannel: 'latest' });
  });
});

describe('background install guard', () => {
  test('--auto does nothing unless the user chose install', async () => {
    // No release server is reachable: reaching the network would throw.
    env.TRACETOON_UPDATE_URL = 'http://127.0.0.1:9';
    setConfig({ autoUpdate: 'notify' });
    await updateCmd({ auto: true, quiet: true }, env);
    setConfig({ autoUpdate: 'off' });
    await updateCmd({ auto: true, quiet: true }, env);
    expect(readState(env).checkedAt).toBeUndefined();
  });
});
