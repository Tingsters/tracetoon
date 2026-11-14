import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTEGRATIONS } from '../src/integrations/registry.ts';
import {
  MCP_DESCRIPTION_MAX,
  MCP_NAME,
  pitch,
  root,
  stale,
  supportedLabels,
} from '../scripts/agent-surfaces.ts';
import pkg from '../package.json';

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
    ])
      expect(read(file)).not.toMatch(directive);
    expect(read('README.md')).not.toMatch(/<!--[^>]*\b(agent|assistant|AI)\b[^>]*-->/i);
  });

  test('server.json lists the npm package for the MCP Registry under package.json mcpName', () => {
    const server = JSON.parse(read('server.json'));
    expect(server.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/,
    );
    expect(server.name).toBe(MCP_NAME);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect((pkg as { mcpName?: string }).mcpName).toBe(MCP_NAME);
    expect(server.description.length).toBeLessThanOrEqual(MCP_DESCRIPTION_MAX);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({
        registryType: 'npm',
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: 'stdio' },
        packageArguments: [{ type: 'positional', value: 'mcp' }],
      }),
    ]);
    const wf = read('.github/workflows/release.yml');
    expect(wf).toContain("vars.MCP_REGISTRY_PUBLISH != ''");
    expect(wf).toContain('mcp-publisher publish');
  });

  test('the Claude Code plugin starts the MCP server through the skill launcher', () => {
    const mcp = JSON.parse(read('plugin/.mcp.json'));
    expect(mcp.mcpServers.tracetoon).toEqual({
      command: '${CLAUDE_PLUGIN_ROOT}/skills/tracetoon/bin/tracetoon',
      args: ['mcp'],
    });
    expect(existsSync(join(root, 'plugin/skills/tracetoon/bin/tracetoon'))).toBe(true);
  });
});
