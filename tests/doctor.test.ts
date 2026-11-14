import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DRIFT_MIN_TOOL_CALLS,
  describeRuntime,
  readerLostEvidence,
  skillInstalls,
} from '../src/commands/doctor.ts';
import { tempDir } from './helpers.ts';

describe('doctor', () => {
  test('recognizes the prebuilt binary by its file name', () => {
    expect(describeRuntime('C:\\cache\\1.0.0\\tracetoon-windows-x64.exe', '1.3.14')).toBe(
      'prebuilt binary',
    );
    expect(
      describeRuntime('/home/u/.cache/tracetoon/1.0.0/tracetoon-linux-arm64', '1.3.14'),
    ).toBe('prebuilt binary');
    expect(
      describeRuntime('C:/x/AppData/Local/tracetoon/bin/tracetoon.exe', '1.3.14'),
    ).toBe('prebuilt binary');
    expect(describeRuntime('/usr/local/bin/bun', '1.3.14')).toBe('bun 1.3.14');
    expect(describeRuntime('/usr/bin/node', null)).toMatch(/^node v/);
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

describe('reader evidence check', () => {
  const at = (toolCalls: number, edits: number, commands: number) =>
    readerLostEvidence({ toolCalls, edits, commands });

  test('a reader that converts nothing has lost its tool mapping', () => {
    // Antigravity CLI 1.5.8: the session held prompts and replies, but the
    // renamed write tool meant no edit and no command came out of it.
    expect(at(DRIFT_MIN_TOOL_CALLS, 0, 0)).toBe(true);
    expect(at(500, 0, 0)).toBe(true);
  });

  test('converting either kind is enough; a host need not do both', () => {
    expect(at(500, 1, 0)).toBe(false); // wrote files, ran nothing
    expect(at(500, 0, 1)).toBe(false); // ran tests, wrote nothing
    expect(at(500, 49, 643)).toBe(false);
  });

  test('too little tool use to judge says nothing', () => {
    // A fresh install, or a corpus of read-only sessions, must stay quiet.
    expect(at(DRIFT_MIN_TOOL_CALLS - 1, 0, 0)).toBe(false);
    expect(at(0, 0, 0)).toBe(false);
  });

  test('a host adding tools does not read as drift', () => {
    // Unknown tool names never enter this decision: only the evidence does, so
    // new tools cannot make the check go off the way a name list would.
    expect(at(1000, 2, 2)).toBe(false);
  });
});
