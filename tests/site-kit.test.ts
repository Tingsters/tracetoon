import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json';
import { unzip } from '../src/update/apply.ts';
import { pitch } from '../scripts/agent-surfaces.ts';
import { AI_AGENTS, PAGES, writeSiteKit, zip } from '../scripts/site-kit.ts';

const work = mkdtempSync(join(tmpdir(), 'tracetoon-site-kit-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const SITE = 'https://tracetoon.ai/';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A released skill archive in miniature: everything under tracetoon/. */
function fakeSkillZip(): string {
  const file = join(work, 'tracetoon-skill.zip');
  writeFileSync(
    file,
    zip([
      {
        name: 'tracetoon/SKILL.md',
        data: Buffer.from(
          '---\nname: tracetoon\ndescription: Create a PR.\n---\n\n# T\n',
        ),
      },
      { name: 'tracetoon/bin/tracetoon', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { name: 'tracetoon/references/drafting.md', data: Buffer.from('# Drafting\n') },
    ]),
  );
  return file;
}

describe('site kit', () => {
  const dir = join(work, 'kit');
  const kit = writeSiteKit(dir);
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  test('writes the pages, indexes and site files', () => {
    for (const p of [
      ...Object.values(PAGES),
      'llms.txt',
      'llms-full.txt',
      'robots.txt',
      'sitemap-agents.xml',
      'jsonld.json',
      'head.html',
      'README.md',
    ])
      expect(existsSync(join(dir, p))).toBe(true);
    expect([...kit.keys()].some((p) => p.startsWith('.well-known/'))).toBe(false);
  });

  test('llms.txt points at tracetoon.ai pages that the kit contains', () => {
    const llms = read('llms.txt');
    const links = [...llms.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? '');
    const site = links.filter((l) => l.startsWith(SITE));
    // Everything but the GitHub releases page lives on the site.
    expect(links.filter((l) => !l.startsWith(SITE))).toEqual([
      'https://github.com/Tracetoon/tracetoon/releases',
    ]);
    for (const link of site)
      expect(existsSync(join(dir, link.slice(SITE.length)))).toBe(true);
    expect(llms).not.toContain('raw.githubusercontent.com/Tracetoon/tracetoon/main/docs');
    expect(read('llms-full.txt').startsWith(llms.trimEnd())).toBe(true);
  });

  test('markdown pages keep no links that only resolve inside the repository', () => {
    for (const page of Object.values(PAGES))
      for (const [, link = ''] of read(page).matchAll(/\]\(([^)\s]+)\)/g)) {
        expect(link).toMatch(/^(https?:|#)/);
        if (link.startsWith(SITE))
          expect(existsSync(join(dir, link.slice(SITE.length)))).toBe(true);
      }
    expect(read('index.md')).not.toContain('<p');
    expect(read('index.md')).toContain('## ⚡ Quick start');
  });

  test('robots.txt allows every listed AI agent and names the sitemap', () => {
    const robots = read('robots.txt');
    expect(robots).not.toMatch(/^Disallow:\s*\/\s*$/m);
    for (const agent of [
      'ClaudeBot',
      'Claude-User',
      'Claude-SearchBot',
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'Google-Extended',
      'PerplexityBot',
    ])
      expect(AI_AGENTS).toContain(agent);
    for (const agent of AI_AGENTS) {
      // The agent's group (its User-agent lines up to the blank line) allows /.
      const group = robots
        .slice(robots.indexOf(`User-agent: ${agent}\n`))
        .split('\n\n')[0];
      expect(group).toContain('Allow: /');
    }
    expect(robots).toContain('Sitemap: https://tracetoon.ai/sitemap-agents.xml');
    expect(robots).toContain('https://tracetoon.ai/llms.txt');
    for (const p of Object.values(PAGES))
      expect(read('sitemap-agents.xml')).toContain(`<loc>${SITE}${p}</loc>`);
  });

  test('jsonld.json is a SoftwareApplication for this release', () => {
    const ld = JSON.parse(read('jsonld.json'));
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toContain('SoftwareApplication');
    expect(ld.description).toBe(pitch());
    expect(ld.applicationCategory).toBe('DeveloperApplication');
    expect(ld.softwareVersion).toBe(pkg.version);
    expect(ld.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
    for (const key of [
      'name',
      'operatingSystem',
      'license',
      'url',
      'downloadUrl',
      'codeRepository',
    ])
      expect(typeof ld[key]).toBe('string');
    expect(read('head.html')).toContain(JSON.stringify(ld, null, 2));
    expect(read('head.html')).toContain('rel="alternate" type="text/markdown"');
  });
});

describe('site kit with the released skill', () => {
  const skillZip = fakeSkillZip();
  const dir = join(work, 'kit-skill');
  const packed = join(work, 'tracetoon-site-kit.zip');
  writeSiteKit(dir, { skillZip, zipPath: packed });

  test('publishes an agent-skills index whose digest matches the re-rooted archive', () => {
    const index = JSON.parse(
      readFileSync(join(dir, '.well-known/agent-skills/index.json'), 'utf8'),
    );
    expect(index.$schema).toBe(
      'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    );
    const [skill] = index.skills;
    expect(skill).toMatchObject({
      name: 'tracetoon',
      type: 'archive',
      description: 'Create a PR.',
      url: '/.well-known/agent-skills/tracetoon.zip',
    });
    const archive = readFileSync(join(dir, '.well-known/agent-skills/tracetoon.zip'));
    expect(skill.digest).toBe(`sha256:${sha256(archive)}`);
    // SKILL.md sits at the archive root, bytes unchanged.
    const out = join(work, 'unpacked-skill');
    unzip(join(dir, '.well-known/agent-skills/tracetoon.zip'), out);
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).toContain('name: tracetoon');
    expect(existsSync(join(out, 'bin/tracetoon'))).toBe(true);
    expect(existsSync(join(out, 'tracetoon'))).toBe(false);
  });

  test('the same inputs give the same archive bytes', () => {
    const again = join(work, 'kit-skill-again');
    writeSiteKit(again, { skillZip });
    const a = readFileSync(join(dir, '.well-known/agent-skills/index.json'), 'utf8');
    expect(readFileSync(join(again, '.well-known/agent-skills/index.json'), 'utf8')).toBe(
      a,
    );
  });

  test('--zip packs the whole kit', () => {
    const out = join(work, 'unpacked-kit');
    unzip(packed, out);
    for (const p of [
      'llms.txt',
      'robots.txt',
      'index.md',
      '.well-known/agent-skills/index.json',
    ])
      expect(readFileSync(join(out, p))).toEqual(readFileSync(join(dir, p)));
  });
});

describe('site kit release workflow', () => {
  const wf = readFileSync(
    join(import.meta.dir, '..', '.github/workflows/site-kit.yml'),
    'utf8',
  );
  test('adds the kit to a published release without touching the verified assets', () => {
    expect(wf).toContain('workflows: [release]');
    expect(wf).toContain('sha256sum -c');
    expect(wf).toContain('--skill-zip release/tracetoon-skill.zip');
    expect(wf).toContain('gh release upload "$TAG" tracetoon-site-kit.zip --clobber');
    // Only the kit is uploaded; the verified assets are only downloaded.
    expect(wf.match(/gh release upload/g)).toHaveLength(1);
    expect(wf).not.toContain('gh release create');
  });
});
