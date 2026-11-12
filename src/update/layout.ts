/** Where the installer puts things, and whether this process is one `update` may replace. */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { FROM_SOURCE } from '../version.ts';

export interface Layout {
  homeRoot: string;
  stable: string;
  assets: string;
  receipt: string;
  asset: string; // release file name of this platform's binary
}

export function installLayout(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Layout {
  const win = platform === 'win32';
  const os = win ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  const homeRoot =
    win && env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, 'tracetoon')
      : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'tracetoon');
  const exe = win ? '.exe' : '';
  return {
    homeRoot,
    stable: join(homeRoot, 'bin', `tracetoon${exe}`),
    assets: join(homeRoot, 'assets'),
    receipt: join(homeRoot, 'install.json'),
    asset: `tracetoon-${os}-${cpu}${exe}`,
  };
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** `update` replaces only the binary the installer placed. Anything else is told how to update. */
export function updatable(
  layout: Layout,
  execPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  fromSource = FROM_SOURCE,
): Eligibility {
  if (env.TRACETOON_BIN)
    return {
      ok: false,
      reason:
        'TRACETOON_BIN points at a runtime you manage yourself. Replace it, or unset it to use the installed one.',
    };
  if (existsSync(layout.stable) && real(execPath) === real(layout.stable))
    return { ok: true };
  if (!/^tracetoon(-[a-z]+-[a-z0-9]+)?(\.exe)?$/i.test(basename(execPath)))
    return {
      ok: false,
      reason: fromSource
        ? 'This copy runs from a source checkout (bun src/cli.ts). Pull the checkout to update it, ' +
          'or install the binary: ' +
          'curl -fsSL https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.sh | sh'
        : 'This copy runs from a bundle (a Claude Code plugin). ' +
          'Update the plugin with /plugin marketplace update, or install the binary: ' +
          'curl -fsSL https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.sh | sh',
    };
  return {
    ok: false,
    reason: `This binary (${execPath}) is not the installed one (${layout.stable}). Run the installed tracetoon, or re-run the installer.`,
  };
}
