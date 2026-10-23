/** A small v2 page script for tests. */
import type { ComicScript, SeriesBible } from '../src/comic/types.ts';

export function pageScript(
  bible: SeriesBible,
  over: Partial<ComicScript> = {},
): ComicScript {
  const id = (role: string) => bible.cast.find((c) => c.role === role)!.id;
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
    panels: [
      {
        scene: 'Sam squints at a terminal path',
        characters: [{ cast: id('human'), position: 'left', expression: 'worried' }],
        dialogue: [
          { speaker: 'caption', text: 'BEFORE' },
          { speaker: id('human'), text: 'Where is this file?' },
        ],
      },
      {
        scene: 'Kit points at a glowing link',
        characters: [{ cast: id('agent'), position: 'right', expression: 'proud' }],
        dialogue: [
          { speaker: 'caption', text: 'AFTER' },
          { speaker: 'caption', kind: 'sign', text: 'file:///preview.html' },
        ],
      },
    ],
    ...over,
  };
}
