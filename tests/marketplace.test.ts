import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';

const root = join(import.meta.dir, '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('Claude Code marketplace route', () => {
  const market = json('.claude-plugin/marketplace.json');
  test('lists the plugin from this repo and leaves versioning to plugin.json', () => {
    expect(market.plugins).toHaveLength(1);
    const [entry] = market.plugins;
    expect(entry.source).toBe('./plugin');
    // Claude Code warns when both carry a version, and plugin.json wins silently.
    expect(entry).not.toHaveProperty('version');
    expect(existsSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });
  test('the plugin version follows package.json, so each release triggers an update', () => {
    expect(json('plugin/.claude-plugin/plugin.json').version).toBe(pkg.version);
  });
  test('the plugin carries the bundle the launcher falls back to', () => {
    expect(existsSync(join(root, 'plugin/skills/tracetoon/dist/tracetoon.mjs'))).toBe(
      true,
    );
    expect(existsSync(join(root, 'plugin/skills/tracetoon/bin/tracetoon'))).toBe(true);
  });
  test('the release workflow moves the release branch without forcing', () => {
    const wf = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(wf).toContain('refs/heads/release');
    expect(wf).not.toMatch(/push[^\n]*(--force|-f\b)/);
  });
});
