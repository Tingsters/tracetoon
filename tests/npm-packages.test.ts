// npm packages are repackaged from verified release assets: one per platform
// binary plus the `tracetoon` wrapper, with no install scripts.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildNpmPackages, npmPlatform } from '../.github/scripts/npm-packages.ts';
import { SUPPORTED_TARGETS } from '../.github/scripts/release-assets.ts';
import { MCP_NAME } from '../scripts/agent-surfaces.ts';
import { tempDir } from './helpers.ts';
import { releaseFixture } from './release-fixture.ts';

setDefaultTimeout(60_000);

const pkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const LIFECYCLE = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepack',
  'postpack',
];

/** This machine's release target, if the release has a binary for it. */
const here = SUPPORTED_TARGETS.find(
  (t) => npmPlatform(t).id === `${process.platform}-${process.arch}`,
);

/**
 * A stand-in binary for this machine: a shell script on macOS and Linux, a copy of
 * the Bun executable on Windows (run as `tracetoon.exe -e <script>`). Either prints
 * its arguments and TRACETOON_SKILL_DIR, then exits 7.
 */
function fakeBinary(): string {
  const dir = tempDir();
  if (process.platform === 'win32') {
    const exe = join(dir, 'fake.exe');
    cpSync(process.execPath, exe);
    return exe;
  }
  const script = join(dir, 'fake');
  writeFileSync(
    script,
    '#!/bin/sh\necho "args: $*"\necho "skill=$TRACETOON_SKILL_DIR"\nexit 7\n',
    { mode: 0o755 },
  );
  return script;
}
const FAKE_ARGS = [
  '-e',
  'console.log("args: " + process.argv.slice(1).join(" ")); console.log("skill=" + process.env.TRACETOON_SKILL_DIR); process.exit(7)',
];

function build(binaries?: Record<string, string>) {
  const f = releaseFixture({ version: '1.2.3-rc.4', binaries });
  const out = join(f.root, 'npm');
  return {
    ...f,
    npm: out,
    packages: buildNpmPackages(f.out, f.skill, out, '1.2.3-rc.4'),
  };
}

/** Lay the packages out the way npm installs them; `platform: false` leaves the binary package out. */
function install(npm: string, id: string | undefined, platform = true) {
  const root = tempDir();
  const modules = join(root, 'node_modules');
  cpSync(join(npm, 'tracetoon'), join(modules, 'tracetoon'), { recursive: true });
  if (platform && id) {
    mkdirSync(join(modules, '@tracetoon'), { recursive: true });
    cpSync(join(npm, `cli-${id}`), join(modules, '@tracetoon', `cli-${id}`), {
      recursive: true,
    });
  }
  return join(modules, 'tracetoon');
}

const runners = [
  ['bun', process.execPath],
  ...(spawnSync('node', ['--version']).status === 0 ? [['node', 'node']] : []),
] as const;

describe('npm packages from the verified release', () => {
  test('one package per release platform, then the wrapper, all at the release version', () => {
    const { npm, packages } = build();
    expect(packages.map((p) => p.name)).toEqual([
      '@tracetoon/cli-linux-x64',
      '@tracetoon/cli-linux-arm64',
      '@tracetoon/cli-darwin-x64',
      '@tracetoon/cli-darwin-arm64',
      '@tracetoon/cli-win32-x64',
      'tracetoon',
    ]);
    for (const target of SUPPORTED_TARGETS) {
      const { id, os, cpu } = npmPlatform(target);
      const dir = join(npm, `cli-${id}`);
      const p = pkg(dir);
      expect(p).toMatchObject({
        name: `@tracetoon/cli-${id}`,
        version: '1.2.3-rc.4',
        os: [os],
        cpu: [cpu],
        license: 'Apache-2.0',
        files: ['bin/'],
      });
      expect(p.repository.url).toBe('git+https://github.com/Tracetoon/tracetoon.git');
      const binary = join(dir, 'bin', os === 'win32' ? 'tracetoon.exe' : 'tracetoon');
      // The exact release bytes, not a rebuild.
      expect(readFileSync(binary, 'utf8')).toBe('synthetic binary ' + target);
    }
    expect(npmPlatform('windows-x64').id).toBe('win32-x64');
    const wrapper = pkg(join(npm, 'tracetoon'));
    expect(wrapper.version).toBe('1.2.3-rc.4');
    expect(wrapper.bin).toEqual({ tracetoon: 'bin/tracetoon.js' });
    expect(wrapper.mcpName).toBe(MCP_NAME);
    // Pinned exactly: a wrapper never runs a binary from another release.
    expect(wrapper.optionalDependencies).toEqual(
      Object.fromEntries(packages.slice(0, -1).map((p) => [p.name, '1.2.3-rc.4'])),
    );
    expect(existsSync(join(npm, 'tracetoon', 'README.md'))).toBe(true);
    expect(
      readFileSync(join(npm, 'tracetoon', 'skill', 'tracetoon', 'SKILL.md'), 'utf8'),
    ).toBe('# Synthetic skill');
  });

  test('no package has install scripts (Bun blocks them)', () => {
    const { packages } = build();
    for (const p of packages) {
      const json = pkg(p.dir);
      expect(json.scripts).toBeUndefined();
      for (const hook of LIFECYCLE) expect(json.scripts?.[hook]).toBeUndefined();
      // npm runs node-gyp for a binding.gyp even without scripts.
      expect(existsSync(join(p.dir, 'binding.gyp'))).toBe(false);
    }
  });

  test('refuses assets that differ from the verified set or the requested version', () => {
    const f = releaseFixture({ version: '1.2.3-rc.4' });
    expect(() => buildNpmPackages(f.out, f.skill, join(f.root, 'a'), '1.2.3')).toThrow(
      'not 1.2.3',
    );
    writeFileSync(join(f.skill, 'SKILL.md'), 'changed');
    expect(() => buildNpmPackages(f.out, f.skill, join(f.root, 'b'))).toThrow(
      'retained inventory',
    );
    const g = releaseFixture();
    writeFileSync(join(g.out, 'tracetoon-linux-x64'), 'rebuilt');
    expect(() => buildNpmPackages(g.out, g.skill, join(g.root, 'c'))).toThrow(
      'checksum mismatch',
    );
  });

  test.skipIf(!here)(
    'the wrapper runs this platform binary with the shipped skill and passes its exit code on',
    () => {
      const { npm } = build({ [here!]: fakeBinary() });
      const wrapper = install(npm, npmPlatform(here!).id);
      if (process.platform !== 'win32') {
        const binary = join(
          wrapper,
          '..',
          '@tracetoon',
          `cli-${npmPlatform(here!).id}`,
          'bin',
          'tracetoon',
        );
        expect(statSync(binary).mode & 0o111).not.toBe(0);
      }
      for (const [, runner] of runners) {
        const r = spawnSync(
          runner,
          [join(wrapper, 'bin', 'tracetoon.js'), ...FAKE_ARGS],
          {
            encoding: 'utf8',
            env: { ...process.env, TRACETOON_SKILL_DIR: '' },
          },
        );
        expect(r.stderr).toBe('');
        expect(r.status).toBe(7);
        expect(r.stdout).toContain('args: ');
        expect(r.stdout).toContain(
          `skill=${join(wrapper, 'bin', '..', 'skill', 'tracetoon')}`,
        );
      }
    },
  );

  test('a missing platform package fails with exit 3 and other ways to install', () => {
    const { npm } = build();
    const wrapper = install(npm, here && npmPlatform(here).id, false);
    for (const [, runner] of runners) {
      const r = spawnSync(runner, [join(wrapper, 'bin', 'tracetoon.js'), 'doctor'], {
        encoding: 'utf8',
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('npm install tracetoon');
      expect(r.stderr).toContain('docs/agents/install.md');
      if (here)
        expect(r.stderr).toContain(
          `@tracetoon/cli-${npmPlatform(here).id} is not installed`,
        );
    }
  });
});
