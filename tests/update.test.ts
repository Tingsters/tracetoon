import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { applyRelease, stagedBinary } from '../src/update/apply.ts';
import { installLayout, updatable } from '../src/update/layout.ts';
import { parseReleases, pickRelease, type Release } from '../src/update/release.ts';
import { compareVersions, parseVersion } from '../src/update/version.ts';
import { updateCmd } from '../src/commands/update.ts';
import { run } from '../src/util/exec.ts';
import { tempDir } from './helpers.ts';

// Update state goes beside the user config: keep it out of the real one.
process.env.TRACETOON_CONFIG = join(tempDir('tracetoon-config-'), 'config.json');

describe('version ordering', () => {
  test('orders release candidates numerically, not as text', () => {
    expect(compareVersions('v1.0.0-rc.2', 'v1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.24', '1.0.0-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.24', '1.0.0-rc.24')).toBe(0);
  });
  test('a release outranks its candidates and a higher core wins', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.1-rc.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.a')).toBeLessThan(0);
  });
  test('rejects things that are not versions', () => {
    expect(parseVersion('latest')).toBeUndefined();
    expect(() => compareVersions('latest', '1.0.0')).toThrow();
  });
});

describe('release selection', () => {
  const list = parseReleases([
    { tag_name: 'v1.0.0-rc.10', published_at: '2026-11-03T00:00:00Z', prerelease: true },
    { tag_name: 'v1.0.0-rc.2', published_at: '2026-11-01T00:00:00Z', prerelease: true },
    { tag_name: 'v0.9.0', published_at: '2026-10-01T00:00:00Z', prerelease: false },
    { tag_name: 'v2.0.0', published_at: null, draft: true },
    { tag_name: 'nightly', published_at: '2026-11-05T00:00:00Z' },
  ]);
  test('skips drafts and tags that are not versions', () => {
    expect(list.map((r) => r.tag)).toEqual(['v1.0.0-rc.10', 'v1.0.0-rc.2', 'v0.9.0']);
  });
  test('latest includes candidates, stable does not', () => {
    expect(pickRelease(list, 'latest')?.tag).toBe('v1.0.0-rc.10');
    expect(pickRelease(list, 'stable')?.tag).toBe('v0.9.0');
    expect(pickRelease([], 'latest')).toBeUndefined();
  });
});

describe('what update may replace', () => {
  test('only the installer-placed binary', () => {
    const home = tempDir('tracetoon-home-');
    const layout = installLayout(
      { XDG_DATA_HOME: join(home, 'data') },
      home,
      'linux',
      'x64',
    );
    expect(layout.asset).toBe('tracetoon-linux-x64');
    mkdirSync(join(layout.stable, '..'), { recursive: true });
    writeFileSync(layout.stable, 'x');
    expect(updatable(layout, layout.stable, {}).ok).toBe(true);
    const bundle = updatable(layout, '/usr/bin/bun', {}, false);
    expect(!bundle.ok && bundle.reason).toContain('plugin');
    const source = updatable(layout, '/usr/bin/bun', {}, true);
    expect(!source.ok && source.reason).toContain('source checkout');
    const other = updatable(layout, '/tmp/tracetoon-linux-x64', {});
    expect(!other.ok && other.reason).toContain('not the installed one');
    const external = updatable(layout, layout.stable, { TRACETOON_BIN: '/x' });
    expect(!external.ok && external.reason).toContain('TRACETOON_BIN');
  });
  test('Windows layout follows LOCALAPPDATA', () => {
    const layout = installLayout({ LOCALAPPDATA: 'C:\\L' }, 'C:\\U', 'win32', 'arm64');
    expect(layout.asset).toBe('tracetoon-windows-arm64.exe');
    expect(layout.stable).toMatch(/tracetoon.bin.tracetoon\.exe$/);
  });

  test('the staged binary keeps its .exe extension last, so Windows can run it', () => {
    expect(stagedBinary('C:\\L\\tracetoon\\bin\\tracetoon.exe', 'a1')).toBe(
      'C:\\L\\tracetoon\\bin\\tracetoon.new-a1.exe',
    );
    expect(stagedBinary('/h/.local/bin/tracetoon', 'a1')).toBe(
      '/h/.local/bin/tracetoon.new-a1',
    );
  });

  test.skipIf(process.platform !== 'win32')(
    'a staged copy of an executable runs on Windows',
    () => {
      // `tracetoon.exe.new-<id>` is refused ("Executable not found"); the staged name must run.
      const dir = tempDir();
      const staged = stagedBinary(join(dir, 'tracetoon.exe'), 't');
      copyFileSync(process.execPath, staged);
      expect(run(staged, ['--version']).ok).toBe(true);
    },
  );
});

const canRun =
  process.platform !== 'win32' &&
  run('python3', ['--version']).ok &&
  run('sh', ['-c', 'true']).ok;

describe.skipIf(!canRun)('update against a fake release server', () => {
  const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  const served: Record<string, Record<string, Uint8Array | string>> = {};
  let releases: unknown[] = [];

  function fakeRelease(tag: string, opts: { buildId?: string; tamper?: boolean } = {}) {
    const version = tag.replace(/^v/, '');
    const dir = tempDir('tracetoon-rel-');
    const skill = join(dir, 'tracetoon');
    mkdirSync(join(skill, 'bin'), { recursive: true });
    mkdirSync(join(skill, 'assets'));
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: tracetoon\n---\n${version}\n`);
    writeFileSync(join(skill, 'VERSION'), `${version}\n`);
    writeFileSync(
      join(skill, 'build.json'),
      JSON.stringify({ buildId: `build-${version}` }),
    );
    writeFileSync(join(skill, 'bin', 'tracetoon'), '#!/bin/sh\n');
    writeFileSync(join(skill, 'assets', 'font.txt'), `font ${version}`);
    expect(
      run('python3', ['-m', 'zipfile', '-c', join(dir, 'skill.zip'), 'tracetoon'], {
        cwd: dir,
      }).ok,
    ).toBe(true);
    const zip = new Uint8Array(readFileSync(join(dir, 'skill.zip')));
    const id = opts.buildId ?? `build-${version}`;
    const binary = `#!/bin/sh\ncase "$1" in\n  --version) echo ${version} ;;\n  build-info) echo '{"buildId":"${id}"}' ;;\n  *) exit 0 ;;\nesac\n`;
    const name = installLayout().asset;
    served[tag] = {
      'tracetoon-skill.zip': zip,
      [name]: opts.tamper ? binary + '# tampered\n' : binary,
      'checksums.txt': `${sha(zip)}  tracetoon-skill.zip\n${sha(binary)}  ${name}\n`,
    };
  }

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === '/releases') return Response.json(releases);
        const m = /^\/download\/([^/]+)\/(.+)$/.exec(pathname);
        const body = m && served[m[1]!]?.[m[2]!];
        return body === undefined
          ? new Response('no', { status: 404 })
          : new Response(body);
      },
    });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  /** A machine with an old install: stable binary, assets, and a Claude Code skill. */
  function machine() {
    const home = tempDir('tracetoon-home-');
    const env = {
      XDG_DATA_HOME: join(home, 'data'),
      TRACETOON_UPDATE_URL: url,
    } as NodeJS.ProcessEnv;
    const layout = installLayout(env, home);
    mkdirSync(join(layout.stable, '..'), { recursive: true });
    writeFileSync(layout.stable, '#!/bin/sh\necho old\n');
    chmodSync(layout.stable, 0o755);
    mkdirSync(layout.assets, { recursive: true });
    writeFileSync(join(layout.assets, 'font.txt'), 'font old');
    const skill = join(home, '.claude', 'skills', 'tracetoon');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'old skill');
    writeFileSync(join(skill, 'VERSION'), '0.0.1\n');
    return { home, env, layout, skill };
  }
  const release = (tag: string): Release => ({
    tag,
    version: tag.replace(/^v/, ''),
    prerelease: true,
    publishedAt: '2026-11-01T00:00:00Z',
    notes: '',
  });
  const strays = (dir: string) => readdirSync(dir).filter((f) => /\.(new|old)-/.test(f));

  test('replaces the binary, assets and skill together and records the install', async () => {
    fakeRelease('v9.0.0-rc.1');
    const m = machine();
    const done = await applyRelease(release('v9.0.0-rc.1'), m.layout, m.home, m.env);
    expect(done.skills.map((s) => s.agent)).toEqual(['Claude Code']);
    expect(readFileSync(m.layout.stable, 'utf8')).toContain('echo 9.0.0-rc.1');
    expect(readFileSync(join(m.layout.assets, 'font.txt'), 'utf8')).toBe(
      'font 9.0.0-rc.1',
    );
    expect(readFileSync(join(m.skill, 'VERSION'), 'utf8').trim()).toBe('9.0.0-rc.1');
    expect(JSON.parse(readFileSync(m.layout.receipt, 'utf8')).tag).toBe('v9.0.0-rc.1');
    expect(strays(join(m.layout.stable, '..'))).toEqual([]);
    expect(strays(m.layout.homeRoot)).toEqual([]);
    expect(strays(join(m.skill, '..'))).toEqual([]);
  });

  test('a tampered download changes nothing', async () => {
    fakeRelease('v9.0.0-rc.2', { tamper: true });
    const m = machine();
    await expect(
      applyRelease(release('v9.0.0-rc.2'), m.layout, m.home, m.env),
    ).rejects.toThrow(/checksum mismatch/);
    expect(readFileSync(m.layout.stable, 'utf8')).toContain('echo old');
    expect(readFileSync(join(m.skill, 'VERSION'), 'utf8').trim()).toBe('0.0.1');
    expect(strays(join(m.layout.stable, '..'))).toEqual([]);
  });

  test('a runtime that is not the skill build changes nothing', async () => {
    fakeRelease('v9.0.0-rc.3', { buildId: 'some-other-build' });
    const m = machine();
    await expect(
      applyRelease(release('v9.0.0-rc.3'), m.layout, m.home, m.env),
    ).rejects.toThrow(/builds differ/);
    expect(readFileSync(m.layout.stable, 'utf8')).toContain('echo old');
    expect(existsSync(m.layout.receipt)).toBe(false);
    expect(readFileSync(join(m.layout.assets, 'font.txt'), 'utf8')).toBe('font old');
  });

  for (const part of ['binary', 'assets', 'skill'] as const) {
    test(`a failure after the ${part} swap puts every part back`, async () => {
      fakeRelease('v9.0.0-rc.4');
      const m = machine();
      const boom = () => {
        throw new Error(`simulated failure after ${part}`);
      };
      await expect(
        applyRelease(release('v9.0.0-rc.4'), m.layout, m.home, m.env, (p) => {
          if (p === part) boom();
        }),
      ).rejects.toThrow(/simulated failure/);
      expect(readFileSync(m.layout.stable, 'utf8')).toContain('echo old');
      expect(readFileSync(join(m.layout.assets, 'font.txt'), 'utf8')).toBe('font old');
      expect(readFileSync(join(m.skill, 'VERSION'), 'utf8').trim()).toBe('0.0.1');
      expect(readFileSync(join(m.skill, 'SKILL.md'), 'utf8')).toBe('old skill');
      expect(existsSync(m.layout.receipt)).toBe(false);
      expect(strays(join(m.layout.stable, '..'))).toEqual([]);
      expect(strays(m.layout.homeRoot)).toEqual([]);
      expect(strays(join(m.skill, '..'))).toEqual([]);
    });
  }

  test('an unwritable receipt does not undo a finished update', async () => {
    fakeRelease('v9.0.0-rc.5');
    const m = machine();
    mkdirSync(m.layout.receipt); // a directory where the file goes: writing fails
    await applyRelease(release('v9.0.0-rc.5'), m.layout, m.home, m.env);
    expect(readFileSync(m.layout.stable, 'utf8')).toContain('echo 9.0.0-rc.5');
    expect(readFileSync(join(m.skill, 'VERSION'), 'utf8').trim()).toBe('9.0.0-rc.5');
  });

  test('--check reports without touching anything', async () => {
    releases = [
      {
        tag_name: 'v9.0.0-rc.1',
        published_at: '2026-11-01T00:00:00Z',
        prerelease: true,
        body: 'notes',
      },
    ];
    const m = machine();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (
      out.push(String(s)),
      true
    )) as typeof process.stdout.write;
    const before = process.exitCode;
    try {
      await updateCmd({ check: true, json: true, exitCode: true }, m.env, m.home);
    } finally {
      process.stdout.write = write;
    }
    const code = process.exitCode;
    process.exitCode = before ?? 0; // assigning undefined does not reset it under Bun
    const report = JSON.parse(out.join(''));
    expect(report).toMatchObject({
      latest: '9.0.0-rc.1',
      updateAvailable: true,
      notes: 'notes',
    });
    expect(code).toBe(10);
    expect(readFileSync(m.layout.stable, 'utf8')).toContain('echo old');
  });

  test('refuses outside an installed binary, and when disabled', async () => {
    const m = machine();
    // From source the refusal names the checkout; from the bundle, the plugin.
    await expect(updateCmd({ to: '9.0.0-rc.1' }, m.env, m.home)).rejects.toThrow(
      /source checkout|bundle/,
    );
    await expect(
      updateCmd({ check: true }, { ...m.env, TRACETOON_DISABLE_UPDATES: '1' }, m.home),
    ).rejects.toThrow(/disabled/);
    await expect(updateCmd({ to: '8.8.8' }, m.env, m.home)).rejects.toThrow(
      /No published release/,
    );
  });
});
