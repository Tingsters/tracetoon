import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateComics } from '../scripts/comic-evaluation.ts';
import { findRun, pruneRuns, KEEP_RUNS } from '../src/run.ts';
import { makeRepo } from './helpers.ts';
import { COMIC_CONTENT_CASES } from './fixtures/comic-content.ts';

describe('local comic content evaluation', () => {
  test('creates valid paired runs without moving latest or overwriting candidate work', async () => {
    const repo = makeRepo();
    const file = await evaluateComics(repo.root, 'prepare', ['documentation-only']);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const pair = manifest.cases[0];
    expect(pair.baseline).not.toBe(pair.candidate);
    const gitDir = join(repo.root, '.git');
    const candidate = findRun(gitDir, pair.candidate);
    expect(existsSync(join(gitDir, 'tracetoon', 'runs', 'latest'))).toBe(false);
    writeFileSync(join(candidate.dir, 'comic.json'), '{"author":"keep this"}');
    await evaluateComics(repo.root, 'prepare', ['documentation-only']);
    expect(readFileSync(join(candidate.dir, 'comic.json'), 'utf8')).toContain(
      'keep this',
    );
    mkdirSync(join(candidate.dir, 'out'));
    writeFileSync(
      join(candidate.dir, 'out', 'comic.png'),
      Buffer.from('synthetic image fixture'),
    );
    const page = await evaluateComics(repo.root, 'blind', ['documentation-only']);
    const html = readFileSync(page, 'utf8');
    expect(html).toContain('<img alt="Comic sample"');
    expect(html).not.toContain('documentation-only');
    expect(html).not.toContain('production outcome');
    expect(html).not.toContain('candidate');
    for (let i = 0; i <= KEEP_RUNS; i++)
      mkdirSync(join(gitDir, 'tracetoon', 'runs', `20990101-000000-${i}`));
    pruneRuns(gitDir);
    expect(existsSync(candidate.dir)).toBe(true);
    expect(existsSync(findRun(gitDir, pair.baseline).dir)).toBe(true);
  });
  test('retains flawed originals, static controls and distinct held-out facts', () => {
    expect(COMIC_CONTENT_CASES).toHaveLength(8);
    expect(
      COMIC_CONTENT_CASES.filter((c) => c.control === 'negative-control'),
    ).toHaveLength(3);
    expect(COMIC_CONTENT_CASES.find((c) => c.id === 'single')?.control).toBe(
      'static-control',
    );
    expect(
      COMIC_CONTENT_CASES.filter((c) => c.control === 'held-out').every((c) => !c.script),
    ).toBe(true);
  });
  test('rejects path traversal in a saved scenario manifest', async () => {
    const repo = makeRepo();
    const file = await evaluateComics(repo.root, 'prepare', ['documentation-only']);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    value.cases[0].candidate = '../outside';
    writeFileSync(file, JSON.stringify(value));
    expect(evaluateComics(repo.root, 'blind', ['documentation-only'])).rejects.toThrow(
      'Invalid evaluation manifest',
    );
  });
});
