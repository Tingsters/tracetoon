/** Comic pages (v2): free formats, styles that suit the cast, model lettering. */
import { describe, expect, test } from 'bun:test';
import { defaultBible } from '../src/comic/bible.ts';
import { composePage, imageSize, pageWithFooter } from '../src/comic/compose.ts';
import { pagePrompt } from '../src/comic/providers.ts';
import { checkScript, errors, pageText } from '../src/comic/script.ts';
import { fittingStyles, styleById, styleClash } from '../src/comic/styles.ts';
import { pageScript } from './pageScript.ts';

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('page scripts', () => {
  const pets = defaultBible('ser_test', 'pets', ['Claude Code']);
  const office = defaultBible('ser_test', 'office', ['Claude Code']);

  test('a page in a free format passes', () => {
    expect(errors(checkScript(pageScript(pets), pets))).toEqual([]);
  });

  test('v1 4-koma rules still apply to v1 scripts only', () => {
    const p = checkScript({ ...pageScript(pets), v: 1 }, pets);
    expect(p.some((x) => x.problem.includes('exactly 4 panels'))).toBe(true);
  });

  test('panel count, headline and word limits', () => {
    const many = pageScript(pets, {
      format: 'custom',
      panels: Array.from({ length: 7 }, () => pageScript(pets).panels[0]!),
    });
    expect(errors(checkScript(many, pets)).map((p) => p.where)).toContain('panels');
    const loud = pageScript(pets, { headline: 'one two three four five six seven' });
    expect(errors(checkScript(loud, pets)).map((p) => p.where)).toContain('headline');
    const wordy = pageScript(pets);
    wordy.panels[0]!.dialogue = Array.from({ length: 4 }, () => ({
      speaker: 'caption',
      text: 'twelve words that go on and on and on and on still',
    }));
    expect(
      errors(checkScript(wordy, pets)).some((p) =>
        p.problem.includes('reads on a phone'),
      ),
    ).toBe(true);
    expect(
      errors(checkScript(pageScript(pets, { format: 'custom', layout: '' }), pets))[0]!
        .where,
    ).toBe('layout');
  });

  test('animal casts never get anime styles unless the user opts in', () => {
    const manga = pageScript(pets, { style: 'manga-ink', palette: 'bw-accent' });
    const clash = errors(checkScript(manga, pets)).find((p) => p.where === 'style');
    expect(clash?.problem).toContain('furries');
    expect(errors(checkScript(manga, pets, { allowAnimalAnime: true }))).toEqual([]);
    expect(errors(checkScript(manga, pets, { pinnedStyle: 'manga-ink' }))).toEqual([]);
    // A human cast can have manga.
    expect(
      errors(
        checkScript(
          pageScript(office, { style: 'manga-ink', palette: 'bw-accent' }),
          office,
        ),
      ),
    ).toEqual([]);
    expect(styleClash(styleById('ligne-claire')!, pets.cast)).toBeUndefined();
    expect(fittingStyles(pets.cast).some((s) => s.anime)).toBe(false);
  });

  test('recent styles warn but do not block; a pinned style is required', () => {
    const p = checkScript(pageScript(pets), pets, { recentStyles: ['sunday-strip'] });
    expect(p.find((x) => x.where === 'style')?.severity).toBe('warning');
    expect(errors(p)).toEqual([]);
    expect(
      errors(checkScript(pageScript(pets), pets, { pinnedStyle: 'noir' }))[0]!.where,
    ).toBe('style');
    expect(fittingStyles(pets.cast, ['sunday-strip']).at(-1)!.id).toBe('sunday-strip');
  });

  test('the page prompt carries every word verbatim, the layout and the style', () => {
    const s = pageScript(pets);
    const prompt = pagePrompt(s, pets, ['Kit (character reference)']);
    for (const t of pageText(s)) expect(prompt).toContain(`"${t}"`);
    expect(prompt).toContain('BEFORE on the left, AFTER on the right');
    expect(prompt).toContain(styleById('sunday-strip')!.prompt);
    expect(prompt).toContain('wide landscape 16:9');
    expect(prompt).toContain('Kit (character reference)');
    expect(prompt).not.toContain('no text, no letters');
  });

  test('a whole page gets an exact footer bar', () => {
    expect(imageSize(PNG)).toEqual({ w: 1, h: 1 });
    const svg = pageWithFooter({ mime: 'image/png', data: PNG }, 'acme/widgets #42');
    expect(svg).toContain('acme/widgets #42');
    expect(svg).toContain('made with Tracetoon');
  });

  test('overlay lettering lays out any number of panels', () => {
    for (const n of [1, 2, 3, 5, 6]) {
      const s = pageScript(pets, {
        format: 'custom',
        layout: 'grid',
        panels: Array.from({ length: n }, () => pageScript(pets).panels[0]!),
      });
      const svg = composePage(s, pets, [], { footer: 'acme/widgets #42' });
      expect(svg.match(/<clipPath/g)?.length).toBe(n);
      expect(svg).toContain('CLICK HERE, HUMAN');
      expect(svg).toContain('acme/widgets #42');
    }
  });
});

describe('skill docs stay in sync', () => {
  test('styles.md matches the style catalog', async () => {
    const { readFileSync } = await import('node:fs');
    const { STYLES_MD } = await import('../scripts/gen-styles.ts');
    const doc = readFileSync(
      new URL('../plugin/skills/tracetoon/references/styles.md', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(doc).toBe(STYLES_MD);
  });

  test("the comic guide's example passes comic check", async () => {
    const { readFileSync } = await import('node:fs');
    const guide = readFileSync(
      new URL('../plugin/skills/tracetoon/references/comic-guide.md', import.meta.url),
      'utf8',
    );
    const json = /```json\n(\{\n  "v": 2[\s\S]*?\n\})\n```/.exec(
      guide.replace(/\r\n/g, '\n'),
    )![1]!;
    const pets = defaultBible('ser_test', 'pets', ['Claude Code']);
    expect(checkScript(JSON.parse(json), pets)).toEqual([]);
  });

  test('the share caption fits a post', async () => {
    const { shareCaption } = await import('../src/commands/publish.ts');
    const pets = defaultBible('ser_test', 'pets', ['Claude Code']);
    const long = pageScript(pets, { synopsis: 'word '.repeat(200) });
    const c = shareCaption(long, 'T', 'https://github.com/acme/widgets/pull/42');
    expect(c.length).toBeLessThanOrEqual(280);
    expect(c.startsWith('CLICK HERE, HUMAN — ')).toBe(true);
    expect(c.endsWith('https://github.com/acme/widgets/pull/42 #tracetoon')).toBe(true);
  });
});

describe('character sheets and style', () => {
  test('only sequels attach character sheets; standalone pages draw the cast fresh', async () => {
    const { keepsCast } = await import('../src/commands/comic.ts');
    const pets = defaultBible('ser_test', 'pets', ['Claude Code']);
    expect(keepsCast(pageScript(pets))).toBe(false);
    expect(keepsCast(pageScript(pets, { continuity: { mode: 'sequel', of: [3] } }))).toBe(
      true,
    );
    const fresh = pagePrompt(pageScript(pets, { style: 'pulp-scifi' }), pets);
    expect(fresh).toContain('classic cartoon animals true to the Pulp sci-fi style');
    expect(fresh).toContain('Draw every character fresh');
    const office = defaultBible('ser_test', 'office', ['Claude Code']);
    expect(pagePrompt(pageScript(office, { style: 'manga-ink' }), office)).not.toContain(
      'cartoon animals',
    );
  });
});
