/**
 * Page formats. The agent picks the one that makes the best image for this PR;
 * `custom` lets it describe its own layout.
 */
import type { Aspect } from './types.ts';

export interface Format {
  id: string;
  name: string;
  /** When it works best. */
  useWhen: string;
  /** A layout sketch for the image model; the agent's `layout` refines it. */
  layout: string;
  panels: [min: number, max: number];
  aspect: Aspect;
}

export const FORMATS: Format[] = [
  {
    id: 'strip',
    name: 'Gag strip',
    useWhen: 'a single joke with a punchline: something went funny along the way',
    layout:
      'a horizontal row of panels read left to right; the last panel lands the punchline',
    panels: [2, 4],
    aspect: '16:9',
  },
  {
    id: '4koma',
    name: '4-koma',
    useWhen: 'a story with a clear twist: setup, development, twist, resolution',
    layout: 'four panels: setup, development, twist, resolution',
    panels: [4, 4],
    aspect: '4:3',
  },
  {
    id: 'before-after',
    name: 'Before / after',
    useWhen: 'the change is easy to see: something broken or slow becomes fixed or fast',
    layout:
      'split page: BEFORE on the left, AFTER on the right, optionally a narrow FIX panel between them',
    panels: [2, 3],
    aspect: '16:9',
  },
  {
    id: 'splash',
    name: 'Splash page',
    useWhen: 'one big moment says it all: a launch, a rescue, a victory',
    layout:
      'one full-page scene with a huge headline; at most one small inset or caption box',
    panels: [1, 2],
    aspect: '4:3',
  },
  {
    id: 'mission-briefing',
    name: 'Mission briefing',
    useWhen: 'a tricky multi-part fix: objectives, obstacles, outcome',
    layout:
      'a briefing board: a large hero panel plus 2 to 4 numbered mission cards with short labels',
    panels: [3, 5],
    aspect: '4:3',
  },
  {
    id: 'movie-poster',
    name: 'Movie poster',
    useWhen: 'a big feature or a dramatic rescue that deserves a blockbuster',
    layout:
      'a movie poster: the cast posed heroically, a title treatment, a tagline, and a credits block of short labels',
    panels: [1, 1],
    aspect: '3:4',
  },
  {
    id: 'manual-page',
    name: 'Instruction manual',
    useWhen: 'a new workflow or setup: show the steps',
    layout:
      'a flat-pack instruction manual page: 3 to 6 numbered steps with simple pictures and tiny labels',
    panels: [3, 6],
    aspect: '4:3',
  },
  {
    id: 'newspaper-sunday',
    name: 'Sunday funnies',
    useWhen: 'an everyday, relatable story with a few beats',
    layout:
      'a Sunday comics page: a title banner, then panels of varied widths in two rows',
    panels: [4, 6],
    aspect: '4:3',
  },
  {
    id: 'trading-card',
    name: 'Trading card',
    useWhen: 'a new capability or tool: show its stats and powers',
    layout:
      'a collectible trading card: a framed character portrait, a name plate, 2 to 3 ability lines and a stats box',
    panels: [1, 1],
    aspect: '3:4',
  },
  {
    id: 'custom',
    name: 'Custom',
    useWhen: 'none of the above fits: describe the page in `layout`',
    layout: '',
    panels: [1, 6],
    aspect: '4:3',
  },
];

export const formatById = (id: string | undefined) => FORMATS.find((f) => f.id === id);
