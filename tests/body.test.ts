import { describe, expect, test } from 'bun:test';
import { disclosureLine } from '../src/commands/publish.ts';
import {
  contentHash,
  encodeMeta,
  managedBlock,
  regionContent,
  regionEdited,
  type PrMeta,
} from '../src/github/body.ts';

const meta = (content: string): PrMeta => ({
  v: 1,
  tool: 'tracetoon@test',
  sessions: [],
  digest: 'x',
  generatedAt: '2026-10-24T00:00:00Z',
  contentSha: contentHash(content),
});

describe('edits on GitHub', () => {
  const content =
    'Fixes the empty export.\n\n<p align="center"><img src="{{tracetoon:comic-src}}"></p>';

  test('an untouched block reads as unedited, even after the image URL is filled in', () => {
    const posted = managedBlock(content, meta(content)).replace(
      '{{tracetoon:comic-src}}',
      'https://github.com/acme/demo/blob/abc/comic.png?raw=true',
    );
    expect(regionContent(posted)).toContain('Fixes the empty export.');
    expect(regionEdited(posted)).toBe(false);
  });

  test('a changed sentence reads as edited', () => {
    const edited = managedBlock(content, meta(content)).replace(
      'empty export',
      'empty CSV export',
    );
    expect(regionEdited(edited)).toBe(true);
  });

  test('older blocks without a hash are unknown, not edited', () => {
    const { contentSha: _, ...old } = meta(content);
    void _;
    expect(
      regionEdited(
        `<!-- tracetoon:start -->\n${content}\n${encodeMeta(old)}\n<!-- tracetoon:end -->`,
      ),
    ).toBeUndefined();
  });
});

describe('disclosure', () => {
  const digest = {
    disclosure: {
      agents: ['Claude Code'],
      models: ['claude-opus-5-5'],
      suggestedTrailers: ['Assisted-by: Claude Code:claude-opus-5-5'],
      existingTrailers: [],
    },
  };

  test('one short line, no match percentages', () => {
    const line = disclosureLine(digest);
    expect(line).toContain('Assisted-by: Claude Code:claude-opus-5-5');
    expect(line).not.toMatch(/%/);
    expect(line.split('\n')).toHaveLength(1);
  });

  test('can be turned off, and is empty without agents', () => {
    expect(disclosureLine(digest, 'none')).toBe('');
    expect(
      disclosureLine({
        disclosure: { ...digest.disclosure, suggestedTrailers: [], agents: [] },
      }),
    ).toBe('');
  });
});
