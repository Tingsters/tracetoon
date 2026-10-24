/** A small page script for tests, with its own made-up characters. */
import type { ComicScript } from '../src/comic/types.ts';

export function pageScript(over: Partial<ComicScript> = {}): ComicScript {
  return {
    v: 2,
    title: 'The Link You Can Click',
    headline: 'CLICK HERE, HUMAN',
    synopsis: 'The preview path becomes a link you can click.',
    altText: 'Before: a path nobody can open. After: a link that opens.',
    format: 'before-after',
    layout: 'BEFORE on the left, AFTER on the right',
    style: 'sunday-strip',
    palette: 'full-color',
    characters: [
      { name: 'Dev', description: 'a tired developer in a hoodie, round glasses' },
      { name: 'Link', description: 'a cheerful glowing blue hyperlink with tiny arms' },
    ],
    panels: [
      {
        scene: 'Dev squints at a terminal path',
        characters: [{ name: 'Dev', position: 'left', expression: 'worried' }],
        dialogue: [
          { speaker: 'caption', text: 'BEFORE' },
          { speaker: 'Dev', text: 'Where is this file?' },
        ],
      },
      {
        scene: 'Link waves from the screen, glowing',
        characters: [{ name: 'Link', position: 'right', expression: 'proud' }],
        dialogue: [
          { speaker: 'caption', text: 'AFTER' },
          { speaker: 'caption', kind: 'sign', text: 'file:///preview.html' },
        ],
      },
    ],
    ...over,
  };
}
