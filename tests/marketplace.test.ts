import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';
import { git } from '../src/util/exec.ts';
import { BUILT } from '../.github/scripts/release-branch.ts';

const root = join(import.meta.dir, '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('Claude Code marketplace route', () => {
  const market = json('.claude-plugin/marketplace.json');
  test('serves plugin/ from the release branch and leaves versioning to plugin.json', () => {
    expect(market.plugins).toHaveLength(1);
    const [entry] = market.plugins;
    // main has no bundle; `release` adds it to each tagged source tree.
    expect(entry.source).toEqual({
      source: 'git-subdir',
      url: 'https://github.com/Tracetoon/tracetoon.git',
      path: 'plugin',
      ref: 'release',
    });
    // Claude Code warns when both carry a version, and plugin.json wins silently.
    expect(entry).not.toHaveProperty('version');
    expect(existsSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });
  test('the plugin version follows package.json, so each release triggers an update', () => {
    expect(json('plugin/.claude-plugin/plugin.json').version).toBe(pkg.version);
  });
  test('build outputs are never committed to main', () => {
    // Every source change regenerates them, so committing them made every PR conflict.
    const tracked = git(root, ['ls-files', '--', ...BUILT]);
    expect(tracked.ok).toBe(true);
    expect(tracked.stdout.trim()).toBe('');
    for (const path of BUILT)
      expect(git(root, ['check-ignore', '-q', '--', path]).ok).toBe(true);
    expect(existsSync(join(root, 'plugin/skills/tracetoon/bin/tracetoon'))).toBe(true);
  });
  test('the release workflow publishes the bundle on the release branch without forcing', () => {
    const wf = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(wf).toContain('.github/scripts/release-branch.ts');
    expect(wf).not.toMatch(/push[^\n]*(--force|-f\b)/);
    expect(wf).not.toContain('$GITHUB_SHA:refs/heads/release');
  });
});
