import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/util/exec.ts';
import { tempDir } from './helpers.ts';

const launcher = join(import.meta.dir, '..', 'plugin/skills/tracetoon/bin/tracetoon');

describe.skipIf(process.platform === 'win32')('skill launcher messages', () => {
  test('the no-runtime error prints the update command instead of running it', () => {
    // A skill folder with no matching runtime, and a `tracetoon` on PATH that would
    // leave a marker if anything ran it (shell command substitution would).
    const root = tempDir('tracetoon-launcher-');
    const skill = join(root, 'skill');
    mkdirSync(join(skill, 'bin'), { recursive: true });
    copyFileSync(launcher, join(skill, 'bin', 'tracetoon'));
    chmodSync(join(skill, 'bin', 'tracetoon'), 0o755);
    writeFileSync(join(skill, 'VERSION'), '0.0.1\n');
    writeFileSync(join(skill, 'build.json'), '{"buildId": "no-such-build"}\n');
    const fake = join(root, 'path');
    mkdirSync(fake);
    const marker = join(root, 'ran');
    writeFileSync(join(fake, 'tracetoon'), `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(join(fake, 'tracetoon'), 0o755);
    const r = run('sh', [join(skill, 'bin', 'tracetoon'), 'status'], {
      env: {
        PATH: `${fake}:/usr/bin:/bin`,
        HOME: root,
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Run `tracetoon update`');
    expect(existsSync(marker)).toBe(false);
  });

  test('a copy with no build.json says how to build it', () => {
    // Build outputs aren't committed, so a skill folder from a source checkout has none.
    const root = tempDir('tracetoon-launcher-');
    const skill = join(root, 'skill');
    mkdirSync(join(skill, 'bin'), { recursive: true });
    copyFileSync(launcher, join(skill, 'bin', 'tracetoon'));
    writeFileSync(join(skill, 'VERSION'), '0.0.1\n');
    const r = run('sh', [join(skill, 'bin', 'tracetoon'), 'status'], {
      env: { PATH: '/usr/bin:/bin', HOME: root, XDG_CACHE_HOME: join(root, 'cache') },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('has no build');
    expect(r.stderr).toContain('bun run bundle');
  });

  test('the launcher is valid shell', () => {
    expect(run('sh', ['-n', launcher]).ok).toBe(true);
  });
});
