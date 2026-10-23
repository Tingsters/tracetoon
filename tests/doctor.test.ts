import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRuntime, skillInstalls } from '../src/commands/doctor.ts';
import { tempDir } from './helpers.ts';

describe('doctor', () => {
  test('recognizes the prebuilt binary by its file name', () => {
    expect(describeRuntime('C:\\cache\\1.0.0\\tracetoon-windows-x64.exe', '1.3.14')).toBe(
      'prebuilt binary',
    );
    expect(
      describeRuntime('/home/u/.cache/tracetoon/1.0.0/tracetoon-linux-arm64', '1.3.14'),
    ).toBe('prebuilt binary');
    expect(describeRuntime('/usr/local/bin/bun', '1.3.14')).toBe('bun 1.3.14');
    expect(describeRuntime('/usr/bin/node', undefined)).toMatch(/^node v/);
  });

  test('lists where the skill is installed, with versions', () => {
    const home = tempDir('tracetoon-home-');
    const put = (dir: string, version?: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: tracetoon\n---\n');
      if (version) writeFileSync(join(dir, 'VERSION'), `${version}\n`);
    };
    put(join(home, '.claude', 'skills', 'tracetoon'), '1.0.0-rc.3');
    put(join(home, '.gemini', 'config', 'skills', 'tracetoon'));
    mkdirSync(join(home, '.agents', 'skills', 'tracetoon'), { recursive: true }); // no SKILL.md: not an install
    const installs = skillInstalls(home, {});
    expect(installs.map((i) => [i.agent, i.version])).toEqual([
      ['Claude Code', '1.0.0-rc.3'],
      ['Antigravity', null],
    ]);
  });
});
