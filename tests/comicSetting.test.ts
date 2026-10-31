import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comicMode, loadConfig, setUserConfig } from '../src/config.ts';
import { comicDecision } from '../src/comic/decision.ts';
import { detectAiPolicy } from '../src/github/repoContext.ts';
import {
  clearComicStatus,
  readComicStatus,
  writeComicStatus,
} from '../src/comic/status.ts';
import { tempDir } from './helpers.ts';

let savedConfig: string | undefined;
beforeEach(() => {
  savedConfig = process.env.TRACETOON_CONFIG;
  process.env.TRACETOON_CONFIG = join(tempDir(), 'config.json');
});
afterEach(() => {
  if (savedConfig === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = savedConfig;
});

describe('comicMode', () => {
  test('maps old booleans and passes valid modes through', () => {
    expect(comicMode(true)).toBe('allowed');
    expect(comicMode(false)).toBe('off');
    expect(comicMode('true')).toBe('allowed');
    expect(comicMode('false')).toBe('off');
    for (const m of ['off', 'allowed', 'always'] as const) expect(comicMode(m)).toBe(m);
  });
  test('anything else is allowed', () => {
    for (const v of [undefined, null, 0, 'sometimes', {}, ['off']])
      expect(comicMode(v)).toBe('allowed');
  });
});

describe('loadConfig comic', () => {
  test('defaults to allowed', () => {
    expect(loadConfig(tempDir()).comic).toBe('allowed');
  });
  test('repo json with comic: false reads as off', () => {
    const root = tempDir();
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github', 'tracetoon.json'), '{"comic": false}');
    expect(loadConfig(root).comic).toBe('off');
  });
  test('user json boolean and repo overlay', () => {
    writeFileSync(process.env.TRACETOON_CONFIG!, '{"comic": false}');
    expect(loadConfig().comic).toBe('off');
    const root = tempDir();
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github', 'tracetoon.json'), '{"comic": "always"}');
    expect(loadConfig(root).comic).toBe('always');
  });
  test('config set stores a mode', () => {
    expect(setUserConfig('comic', 'always').comic).toBe('always');
    expect(loadConfig().comic).toBe('always');
    expect(setUserConfig('comic', 'false').comic).toBe('off');
  });
});

describe('comicDecision', () => {
  const ban = {
    media: 'prohibited',
    mediaSource: { file: 'CONTRIBUTING.md', line: 7 },
  };
  const none = { media: 'none' };
  test('off never includes', () => {
    for (const p of [ban, none])
      expect(comicDecision('off', p)).toEqual({
        include: false,
        state: 'off',
        reason: 'comic is off in your settings',
      });
  });
  test('allowed follows the repo', () => {
    expect(comicDecision('allowed', none)).toEqual({ include: true });
    const d = comicDecision('allowed', ban);
    expect(d.include).toBe(false);
    expect(d.state).toBe('policy');
    expect(d.reason).toBe(
      "this repo's contributing rules forbid images in PRs (CONTRIBUTING.md:7)",
    );
    expect(comicDecision('allowed', { media: 'prohibited' }).reason).toBe(
      "this repo's contributing rules forbid images in PRs",
    );
  });
  test('always ignores the repo', () => {
    expect(comicDecision('always', ban)).toEqual({ include: true });
    expect(comicDecision('always', none)).toEqual({ include: true });
  });
});

describe('detectAiPolicy media bans', () => {
  const policyFor = (line: string) => {
    const root = tempDir();
    writeFileSync(join(root, 'CONTRIBUTING.md'), `# Contributing\n\n${line}\n`);
    return detectAiPolicy(root);
  };
  test.each([
    "Please don't include images, GIFs or comics in pull requests.",
    'Do not add AI-generated art or infographics to PR descriptions.',
  ])('bans: %s', (line) => {
    const p = policyFor(line);
    expect(p.media).toBe('prohibited');
    expect(p.mediaSource).toEqual({ file: 'CONTRIBUTING.md', line: 3, text: line });
    expect(p.excerpts.filter((e) => e.text === line)).toHaveLength(1);
  });
  test.each([
    'Do not commit images to src/.',
    'No binary images in the repository.',
    'We love the comics people draw about this project in their issues.',
    // A rule about issues says nothing about PRs.
    "Please don't attach screenshots to issues; paste the error text instead.",
    "Contributors: please don't attach screenshots to issues.",
  ])('no ban: %s', (line) => {
    const p = policyFor(line);
    expect(p.media).toBe('none');
    expect(p.mediaSource).toBeUndefined();
  });
  test('AI-term media bans still work and record their source', () => {
    const p = policyFor(
      'AI-generated media (images, art, video, audio) is not allowed for external contributions.',
    );
    expect(p.media).toBe('prohibited');
    expect(p.mediaSource?.line).toBe(3);
  });
});

describe('comic status', () => {
  test('round trip, trimmed detail, and clear', () => {
    const dir = tempDir();
    const run = { id: 'r', dir };
    expect(readComicStatus(run)).toBeUndefined();
    writeComicStatus(run, { state: 'no-route', detail: 'no image route set up' });
    const s = readComicStatus(run)!;
    expect(s.state).toBe('no-route');
    expect(s.detail).toBe('no image route set up');
    expect(Number.isNaN(Date.parse(s.at))).toBe(false);
    writeComicStatus(run, { state: 'failed', detail: 'x'.repeat(300), at: '2026-01-01' });
    expect(readComicStatus(run)).toEqual({
      state: 'failed',
      detail: 'x'.repeat(120),
      at: '2026-01-01',
    });
    clearComicStatus(run);
    expect(existsSync(join(dir, 'comic-status.json'))).toBe(false);
    expect(readComicStatus(run)).toBeUndefined();
  });
});
