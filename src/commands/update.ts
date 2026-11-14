/** `tracetoon update`: check for a newer release and install it in place. */
import { homedir } from 'node:os';
import { loadConfig } from '../config.ts';
import { TOOL_VERSION } from '../version.ts';
import { applyRelease } from '../update/apply.ts';
import { installLayout, updatable } from '../update/layout.ts';
import {
  listReleases,
  pickRelease,
  type Channel,
  type Release,
} from '../update/release.ts';
import { readState, takeLock, writeState } from '../update/state.ts';
import { compareVersions, parseVersion } from '../update/version.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export interface UpdateOpts extends OutOpts {
  check?: boolean;
  to?: string;
  channel?: string;
  exitCode?: boolean;
  /** Print nothing (background runs). */
  quiet?: boolean;
  /** A background install: only when the user chose autoUpdate=install. */
  auto?: boolean;
}

/** Exit code of `update --check --exit-code` when a newer release exists. */
export const UPDATE_AVAILABLE = 10;

export async function updateCmd(
  opts: UpdateOpts,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<void> {
  if (env.TRACETOON_DISABLE_UPDATES === '1')
    throw new UserError('Updates are disabled here (TRACETOON_DISABLE_UPDATES=1).');
  const config = loadConfig();
  if (opts.auto && (config.autoUpdate !== 'install' || opts.check || opts.to)) return;
  const channel = (opts.channel ?? config.updateChannel) as Channel;
  if (channel !== 'stable' && channel !== 'latest')
    throw new UserError('--channel must be stable or latest.');
  // One updater at a time; a background install yields to a running one.
  const unlock = opts.check ? undefined : takeLock(env);
  if (!opts.check && !unlock) {
    if (opts.auto) return;
    throw new UserError('Another update is already running. Try again in a few minutes.');
  }
  try {
    await update(opts, env, home, channel);
  } finally {
    unlock?.();
  }
}

async function update(
  opts: UpdateOpts,
  env: NodeJS.ProcessEnv,
  home: string,
  channel: Channel,
): Promise<void> {
  const say: typeof emit = opts.quiet ? () => {} : emit;

  let releases: Release[];
  try {
    releases = await listReleases(env);
  } catch (e) {
    throw new UserError(`Could not look up releases: ${(e as Error).message}`);
  }

  // Remember what the channel's newest release is, for the next session's notice.
  const newest = pickRelease(releases, channel);
  writeState(env, {
    checkedAt: new Date().toISOString(),
    channel,
    latest: newest?.version,
    tag: newest?.tag,
  });

  let target: Release | undefined;
  if (opts.to) {
    const want = opts.to.replace(/^v/, '');
    if (!parseVersion(want)) throw new UserError(`Not a version: ${opts.to}`);
    target = releases.find((r) => r.version === want);
    if (!target)
      throw new UserError(`No published release v${want}. Run: tracetoon update --check`);
  } else {
    target = pickRelease(releases, channel);
    if (!target)
      throw new UserError(
        channel === 'stable'
          ? 'No stable release exists yet. Use --channel latest to include release candidates.'
          : 'No published release found.',
      );
  }

  const order = compareVersions(target.version, TOOL_VERSION);
  const available = order > 0;
  const report = {
    current: TOOL_VERSION,
    latest: target.version,
    tag: target.tag,
    channel,
    updateAvailable: available,
    notes: target.notes,
  };

  if (opts.check) {
    say(opts, report, () =>
      available
        ? `Tracetoon ${TOOL_VERSION} -> ${target.version} is available. Run: tracetoon update`
        : `Tracetoon ${TOOL_VERSION} is up to date.`,
    );
    if (available && opts.exitCode) process.exitCode = UPDATE_AVAILABLE;
    return;
  }

  // Eligibility first: a copy `update` can never replace (a source checkout or a
  // plugin bundle) needs to hear how to update itself even when its version already
  // matches the newest release, which is the normal state right after one ships.
  const layout = installLayout(env, home);
  const ok = updatable(layout, process.execPath, env);
  if (!ok.ok) throw new UserError(ok.reason);

  // An explicit --to may go backwards (rollback); a plain update never does.
  if (order === 0 || (order < 0 && !opts.to)) {
    emit(
      opts,
      { ...report, updated: false },
      () => `Tracetoon ${TOOL_VERSION} is up to date.`,
    );
    return;
  }

  let applied;
  try {
    applied = await applyRelease(target, layout, home, env);
  } catch (e) {
    throw new UserError(`Update failed: ${(e as Error).message}`);
  }
  say(opts, { ...report, updated: true, ...applied }, () =>
    [
      `Updated Tracetoon ${TOOL_VERSION} -> ${target.version}.`,
      ...applied.skills.map((s) => `  skill: ${s.agent} (${s.dir})`),
      applied.hooks
        ? '  hooks: registered again'
        : '  hooks: could not be re-registered; run: tracetoon hook install',
      'Reload your agent so it picks up the new skill; Codex may ask you to trust the hooks in /hooks.',
    ].join('\n'),
  );
}
