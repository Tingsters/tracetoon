import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTEGRATIONS } from '../src/integrations/registry.ts';
import { pitch, root, stale, supportedLabels } from '../scripts/agent-surfaces.ts';
import pkg from '../package.json';
import { git } from '../src/util/exec.ts';

const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const RAW = 'https://raw.githubusercontent.com/Tracetoon/tracetoon/main/';

/** The SKILL.md frontmatter as key -> raw value (single-line values only). */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('SKILL.md has no frontmatter');
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([a-z_-]+):\s?(.*)$/.exec(line);
    if (kv?.[1]) out[kv[1]] = kv[2] ?? '';
  }
  return out;
}

describe('agent surfaces', () => {
  test('generated files match the registry (run bun scripts/agent-surfaces.ts)', () => {
    expect(stale()).toEqual([]);
  });

  test('SKILL.md frontmatter follows the Agent Skills limits', () => {
    const fm = frontmatter(read('plugin/skills/tracetoon/SKILL.md'));
    expect(fm.name).toBe('tracetoon'); // must match the folder name
    expect(fm.name).toMatch(/^[a-z0-9-]{1,64}$/);
    const description = fm.description ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(fm.license).toBe('Apache-2.0');
    expect((fm.compatibility ?? '').length).toBeLessThanOrEqual(500);
    expect(fm.compatibility).toContain('gh');
  });

  test('every supported host is named wherever agents and people look', () => {
    const readme = read('README.md');
    const llms = read('llms.txt');
    const market = JSON.parse(read('.claude-plugin/marketplace.json'));
    for (const label of supportedLabels()) {
      expect(readme).toContain(label.replace(/ CLI$/, ''));
      expect(llms).toContain(label);
      expect(market.plugins[0].description).toContain(label);
    }
    expect(market.plugins[0].description).toBe(pitch());
    expect(supportedLabels().length).toBe(
      INTEGRATIONS.filter((i) => i.status === 'supported').length,
    );
  });

  test('links in llms.txt and docs/agents point at files in this repository', () => {
    const files = [
      'llms.txt',
      'AGENTS.md',
      'docs/agents/install.md',
      'docs/agents/faq.md',
      'docs/agents/errors.md',
      'docs/agents/cli.md',
    ];
    for (const file of files) {
      const text = read(file);
      for (const [, target = ''] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
        if (target.startsWith(RAW))
          expect(existsSync(join(root, target.slice(RAW.length)))).toBe(true);
        else if (!/^https?:/.test(target))
          expect(existsSync(join(root, file, '..', target))).toBe(true);
      }
    }
  });

  test('CLAUDE.md only imports AGENTS.md', () => {
    expect(read('CLAUDE.md').trim()).toBe('@AGENTS.md');
  });

  test('instructions to agents live only in the files meant for agents', () => {
    // Guardrail: no hidden directives aimed at assistants in human-facing text
    // or in what Tracetoon publishes.
    const directive =
      /\b(AI|assistant|LLM|language model)s?[,:]?\s+(you must|always|ignore|disregard)\b/i;
    for (const file of [
      'README.md',
      'CONTRIBUTING.md',
      'plugin/.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'plugin/plugin.json',
      'plugin/.cursor-plugin/plugin.json',
      'gemini-extension.json',
    ])
      expect(read(file)).not.toMatch(directive);
    expect(read('README.md')).not.toMatch(/<!--[^>]*\b(agent|assistant|AI)\b[^>]*-->/i);
  });
});

describe('vendor catalog manifests', () => {
  const json = (p: string) => JSON.parse(read(p));
  const MANIFESTS = [
    'plugin/plugin.json',
    'plugin/.codex-plugin/plugin.json',
    'plugin/.cursor-plugin/plugin.json',
    '.agents/plugins/marketplace.json',
    '.cursor-plugin/marketplace.json',
    'gemini-extension.json',
    'catalog/agentfinder/Tracetoon/tracetoon.json',
  ];
  const plugin = (p: string) => join(root, 'plugin', p);

  test('every manifest parses and carries the shared pitch and package version', () => {
    for (const path of MANIFESTS) expect(() => json(path)).not.toThrow();
    for (const path of [
      'plugin/plugin.json',
      'plugin/.codex-plugin/plugin.json',
      'plugin/.cursor-plugin/plugin.json',
      'plugin/.claude-plugin/plugin.json',
      'gemini-extension.json',
    ]) {
      expect(json(path).name).toBe('tracetoon');
      expect(json(path).version).toBe(pkg.version);
      expect(json(path).description).toBe(pitch());
    }
    expect(json('.cursor-plugin/marketplace.json').metadata.version).toBe(pkg.version);
    expect(json('catalog/agentfinder/Tracetoon/tracetoon.json').description).toBe(
      pitch(),
    );
  });

  test('plugin/plugin.json follows Agent Plugins 1.0.0 and Kiro power rules', () => {
    const m = json('plugin/plugin.json');
    // plugin.schema.json: $schema and name required, no other top-level keys.
    expect(m.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(m.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    const allowed = [
      '$schema',
      'name',
      'version',
      'description',
      'author',
      'homepage',
      'repository',
      'license',
      'keywords',
      'extensions',
    ];
    for (const key of Object.keys(m)) expect(allowed).toContain(key);
    for (const key of Object.keys(m.author))
      expect(['name', 'email', 'url']).toContain(key);
    // Kiro (kiro.dev/docs/powers/create) also requires version, description,
    // author.name and keywords; keywords activate the power.
    expect(m.author.name.length).toBeGreaterThan(0);
    expect(m.keywords).toContain('pull request');
    // Components are discovered from their default folders.
    expect(existsSync(plugin('skills/tracetoon/SKILL.md'))).toBe(true);
  });

  test('the Codex manifests have the fields and limits the submission portal checks', () => {
    const codex = json('plugin/.codex-plugin/plugin.json');
    const ui = codex.interface;
    expect(json('plugin/plugin.json').extensions['com.openai'].interface).toEqual(ui);
    expect(codex.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(codex.name.length).toBeLessThanOrEqual(64);
    expect(codex.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(codex.description.length).toBeLessThanOrEqual(4000);
    expect(codex.author.name.length).toBeLessThanOrEqual(120);
    expect(codex.skills).toBe('./skills/');
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    expect(ui.category.length).toBeGreaterThan(0);
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const p of ui.defaultPrompt) expect(p.length).toBeLessThanOrEqual(128);
    expect(ui.brandColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(ui.websiteURL).toMatch(/^https:\/\//);
    for (const icon of [ui.composerIcon, ui.logo]) {
      expect(icon).toMatch(/^\.\//);
      expect(existsSync(plugin(icon))).toBe(true);
    }
    const market = json('.agents/plugins/marketplace.json');
    expect(market.plugins).toHaveLength(1);
    const [entry] = market.plugins;
    expect(entry.name).toBe(codex.name);
    expect(entry.source).toEqual({
      source: 'git-subdir',
      url: 'https://github.com/Tracetoon/tracetoon.git',
      path: './plugin',
      ref: 'release', // main has no build
    });
    expect(entry.policy).toEqual({
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    });
    expect(entry.category.length).toBeGreaterThan(0);
  });

  test('the Cursor plugin and marketplace match cursor/plugin-template', () => {
    const p = json('plugin/.cursor-plugin/plugin.json');
    expect(p.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(existsSync(plugin(p.logo))).toBe(true);
    const market = json('.cursor-plugin/marketplace.json');
    expect(market.owner.name.length).toBeGreaterThan(0);
    const [entry] = market.plugins;
    expect(entry.name).toBe(p.name);
    expect(existsSync(join(root, entry.source, '.cursor-plugin', 'plugin.json'))).toBe(
      true,
    );
  });

  test('the Gemini extension bundles the skill through skills/', () => {
    const ext = json('gemini-extension.json');
    expect(ext.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(existsSync(join(root, ext.contextFileName))).toBe(true);
    // Gemini reads <extension>/skills/<name>/SKILL.md; a link keeps one copy.
    const entry = git(root, ['ls-files', '-s', '--', 'skills']).stdout.trim();
    expect(entry).toMatch(/^120000 [0-9a-f]+ 0\tskills$/);
    const blob = entry.split(/\s+/)[1] ?? '';
    expect(git(root, ['cat-file', 'blob', blob]).stdout).toBe('plugin/skills');
  });

  test('the agent finder entry follows the catalog CONTRIBUTING schema', () => {
    const e = json('catalog/agentfinder/Tracetoon/tracetoon.json');
    expect(e.identifier).toBe('urn:ai:github.com:Tracetoon:tracetoon:tracetoon');
    expect(e.mediaType).toBe('application/ai-skill');
    expect(e.displayName.length).toBeGreaterThan(0);
    expect(e.url).toBe(
      `https://github.com/Tracetoon/tracetoon/blob/release/${e.metadata.repoPath}`,
    );
    expect(e.metadata.sourceSet).toBe('Tracetoon/tracetoon');
    expect(existsSync(join(root, e.metadata.repoPath))).toBe(true);
  });

  test('listings.md names files that exist and marks every catalog unsubmitted', () => {
    const text = read('docs/agents/listings.md');
    const rows = text
      .split('\n')
      .filter((l) => /^\| [^-]/.test(l) && !l.startsWith('| Catalog'));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row).toMatch(/\| not (submitted|applicable)/);
      const backed = row.split(' | ')[1] ?? '';
      for (const [, path = ''] of backed.matchAll(/`([^`\s]+)`/g))
        expect(existsSync(join(root, path))).toBe(true);
    }
    for (const path of MANIFESTS) expect(text).toContain(`\`${path}\``);
  });
});
