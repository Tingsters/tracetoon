/** Comic pages: free formats, made-up characters, any art style, model lettering. */
import { describe, expect, test } from 'bun:test';
import { composePage, imageSize, pageWithFooter } from '../src/comic/compose.ts';
import { artPrompt, pagePrompt } from '../src/comic/providers.ts';
import { checkScript, errors, pageText, transcript } from '../src/comic/script.ts';
import { freshStyles, styleById } from '../src/comic/styles.ts';
import { pageScript } from './pageScript.ts';

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('page scripts', () => {
  test('a page in a free format, with its own characters, passes', () => {
    expect(errors(checkScript(pageScript()))).toEqual([]);
  });

  test('the old fixed 4-panel format (v1) gets a clear error', () => {
    const p = errors(checkScript({ ...pageScript(), v: 1 }));
    expect(p[0]!.problem).toContain('was removed');
  });

  test("characters must be the comic's own, each described once", () => {
    const stranger = pageScript();
    stranger.panels[0]!.characters = [{ name: 'Kit', position: 'left' }];
    stranger.panels[0]!.dialogue = [{ speaker: 'Kit', text: 'Hi!' }];
    const p = errors(checkScript(stranger));
    expect(p.map((x) => x.where)).toEqual([
      'panels[0].characters[0].name',
      'panels[0].dialogue[0].speaker',
    ]);
    expect(p[0]!.problem).toContain("isn't in this comic's characters (dev, link)");
    const vague = pageScript({ characters: [{ name: 'Dev', description: '' }] });
    expect(errors(checkScript(vague)).map((x) => x.where)).toContain(
      'characters[0].description',
    );
    // No characters at all is fine: scenes and captions only.
    const none = pageScript({ characters: [] });
    none.panels.forEach((p) => {
      p.characters = [];
      p.dialogue = p.dialogue.filter((d) => d.speaker === 'caption');
    });
    expect(errors(checkScript(none))).toEqual([]);
  });

  test('panel count, headline and word limits', () => {
    const many = pageScript({
      format: 'custom',
      panels: Array.from({ length: 7 }, () => pageScript().panels[0]!),
    });
    expect(errors(checkScript(many)).map((p) => p.where)).toContain('panels');
    const loud = pageScript({ headline: 'one two three four five six seven' });
    expect(errors(checkScript(loud)).map((p) => p.where)).toContain('headline');
    const wordy = pageScript();
    wordy.panels[0]!.dialogue = Array.from({ length: 4 }, () => ({
      speaker: 'caption',
      text: 'twelve words that go on and on and on and on still',
    }));
    expect(
      errors(checkScript(wordy)).some((p) => p.problem.includes('reads on a phone')),
    ).toBe(true);
    expect(
      errors(checkScript(pageScript({ format: 'custom', layout: '' })))[0]!.where,
    ).toBe('layout');
  });

  test('any art style: an idea by id, or free text; recent ones warn', () => {
    const own = pageScript({ style: '1970s Saturday-morning cel animation' });
    expect(errors(checkScript(own))).toEqual([]);
    expect(pagePrompt(own)).toContain('Art style: 1970s Saturday-morning cel animation');
    expect(pagePrompt(pageScript())).toContain(styleById('sunday-strip')!.prompt);
    expect(errors(checkScript(pageScript({ style: '' })))[0]!.where).toBe('style');
    const p = checkScript(pageScript(), { recentStyles: ['Sunday-Strip'] });
    expect(p.find((x) => x.where === 'style')?.severity).toBe('warning');
    expect(errors(p)).toEqual([]);
    expect(errors(checkScript(pageScript(), { pinnedStyle: 'noir' }))[0]!.where).toBe(
      'style',
    );
    expect(freshStyles(['noir'], 'sunday-strip').at(-1)!.id).toBe('noir');
    expect(freshStyles([], 'sunday-strip').some((s) => s.id === 'sunday-strip')).toBe(
      false,
    );
  });

  test('the page prompt carries every word, the characters, the layout and the style', () => {
    const s = pageScript();
    const prompt = pagePrompt(s);
    for (const t of pageText(s)) expect(prompt).toContain(`"${t}"`);
    expect(prompt).toContain('BEFORE on the left, AFTER on the right');
    expect(prompt).toContain('wide landscape 16:9');
    expect(prompt).toContain('Dev: a tired developer in a hoodie, round glasses');
    expect(prompt).not.toMatch(/\bKit\b|fox|character reference/);
    expect(artPrompt(s.panels[1]!, 1, s)).toContain(
      'Link: a cheerful glowing blue hyperlink with tiny arms, on the right',
    );
    expect(transcript(s)).toContain('**Dev:** Where is this file?');
  });

  test('a whole page gets an exact footer bar', () => {
    expect(imageSize(PNG)).toEqual({ w: 1, h: 1 });
    const svg = pageWithFooter({ mime: 'image/png', data: PNG }, 'acme/widgets #42');
    expect(svg).toContain('acme/widgets #42');
    expect(svg).toContain('made with Tracetoon');
  });

  test('overlay lettering lays out any number of panels', () => {
    for (const n of [1, 2, 3, 5, 6]) {
      const s = pageScript({
        format: 'custom',
        layout: 'grid',
        panels: Array.from({ length: n }, () => pageScript().panels[0]!),
      });
      const svg = composePage(s, [], { footer: 'acme/widgets #42' });
      expect(svg.match(/<clipPath/g)?.length).toBe(n);
      expect(svg).toContain('CLICK HERE, HUMAN');
      expect(svg).toContain('acme/widgets #42');
    }
  });
});

describe('skill docs stay in sync', () => {
  test('styles.md matches the style ideas', async () => {
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
    expect(checkScript(JSON.parse(json))).toEqual([]);
  });

  test('the share caption fits a post', async () => {
    const { shareCaption } = await import('../src/commands/publish.ts');
    const long = pageScript({ synopsis: 'word '.repeat(200) });
    const c = shareCaption(long, 'T', 'https://github.com/acme/widgets/pull/42');
    expect(c.length).toBeLessThanOrEqual(280);
    expect(c.startsWith('CLICK HERE, HUMAN — ')).toBe(true);
    expect(c.endsWith('https://github.com/acme/widgets/pull/42 #tracetoon')).toBe(true);
  });
});

describe('agent CLI wrapper prompt', () => {
  test('never forbids the lettering a page prompt asks for', async () => {
    const { agentBatchPrompt } = await import('../src/comic/providers.ts');
    const wrapped = agentBatchPrompt(
      [{ prompt: pagePrompt(pageScript()), refs: [] }],
      [],
    );
    expect(wrapped).not.toMatch(/do not add text|no text/i);
    expect(wrapped).toContain('"CLICK HERE, HUMAN"');
  });
});
