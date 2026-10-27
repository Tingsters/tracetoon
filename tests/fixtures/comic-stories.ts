/** Synthetic PR stories for visual evaluation, never represented as real session evidence. */
import type {
  ComicAnchor,
  ComicScript,
  Composition,
  Panel,
} from '../../src/comic/types.ts';

const panel = (scene: string, text: string, speaker = 'caption'): Panel => ({
  scene,
  characters: [],
  dialogue: text ? [{ speaker, text }] : [],
});
const script = (
  id: string,
  story: string,
  over: Partial<ComicScript>,
  panels: Panel[],
) => ({
  id,
  story,
  script: {
    v: 2 as const,
    title: id,
    synopsis: story,
    altText: story,
    format: 'custom',
    style: 'manga-ink',
    characters: [],
    panels,
    ...over,
  } as ComicScript,
});

export const COMIC_STORIES = [
  script(
    'single',
    'A one-line fix closes a leaking resource handle.',
    {
      title: 'The Last Drip',
      style: 'precise technical pen drawing, red accent, elegant negative space',
      styleFamily: 'technical',
      palette: 'bw-accent',
      accent: 'red',
      composition: {
        family: 'single',
        title: { mode: 'none' },
        frames: [{ x: 0, y: 0, w: 1, h: 1, border: 'none' }],
      },
      designReason:
        'One visual contradiction carries the resource-leak joke; characters and a headline would distract.',
    },
    [
      panel(
        'An enormous immaculate machine is nearly submerged by water from one tiny forgotten open tap. A small closed-handle wrench rests beside it. The composition is one striking technical cartoon with a callout pointing at the tap.',
        'One tiny handle.',
      ),
    ],
  ),

  script(
    'comparison',
    'A confusing save workflow becomes one clear action.',
    {
      title: 'Save Me',
      headline: 'SAVE ME',
      aspect: '16:9',
      style:
        'warm editorial gouache, coral and sea-glass colors, expressive fictional people',
      styleFamily: 'painted',
      palette: 'limited',
      characters: [
        {
          name: 'Mara',
          kind: 'human',
          description: 'a fictional designer with short dark curls and a rust-red shirt',
        },
      ],
      composition: {
        family: 'comparison',
        title: { mode: 'integrated', box: { x: 0.06, y: 0.82, w: 0.32, h: 0.12 } },
      },
      designReason:
        'Matched before/after staging lets the simpler workflow be the punchline; the cast is human because the frustration is human.',
    },
    [
      {
        ...panel(
          'Mara faces an absurd wall of unlabeled levers and switches, trying to save a tiny drawing. Leave the bottom-left title area clear.',
          'I only wanted to save.',
          'Mara',
        ),
        characters: [{ name: 'Mara', position: 'left', expression: 'worried' }],
      },
      {
        ...panel(
          'Same Mara, same room, now one friendly large save button. Her shoulders relax; the framing matches the left panel.',
          'Oh.',
          'Mara',
        ),
        characters: [{ name: 'Mara', position: 'right', expression: 'happy' }],
      },
    ],
  ),

  script(
    'vertical',
    'Retries stop hammering a service and wait between attempts.',
    {
      title: 'A Little Patience',
      aspect: '3:4',
      style: 'manga-ink',
      palette: 'bw-accent',
      accent: 'blue',
      characters: [
        {
          name: 'Robin',
          kind: 'human',
          description:
            'a fictional tired engineer with cropped hair, rolled sleeves and a striped tie',
        },
      ],
      composition: { family: 'vertical', title: { mode: 'none' } },
      designReason:
        'Four vertical beats use pauses to make backoff visible, with a human reaction rather than a creature mascot.',
    },
    [
      {
        ...panel(
          'Wide establishing shot: Robin leans toward a stubborn door-sized service bell.',
          'One quick retry.',
          'Robin',
        ),
        characters: [{ name: 'Robin', position: 'left', expression: 'determined' }],
      },
      panel(
        'Close-up: a finger frantically presses the service bell; jittery black action lines fill the panel.',
        'Nope.',
      ),
      panel(
        'A silent beat with the bell at rest and a tiny sand timer quietly running. Lots of white space.',
        '',
      ),
      {
        ...panel(
          'Wide payoff: the service door opens while Robin calmly sips tea beside the untouched bell.',
          'Backoff. Then breathe.',
          'Robin',
        ),
        characters: [{ name: 'Robin', position: 'right', expression: 'happy' }],
      },
    ],
  ),

  script(
    'asymmetric',
    'Concurrent requests stop claiming the same last seat.',
    {
      title: 'One Seat',
      headline: 'ONE SEAT',
      aspect: '3:4',
      style:
        'mid-century cut-paper editorial illustration, charcoal, cream and mustard yellow',
      styleFamily: 'flat-color',
      palette: 'limited',
      characters: [
        {
          name: 'Ivo',
          kind: 'human',
          description: 'a fictional ticket clerk with dark braids and a mustard vest',
        },
        {
          name: 'Ren',
          kind: 'human',
          description:
            'a fictional ticket clerk with round glasses and a charcoal waistcoat',
        },
      ],
      composition: { family: 'asymmetric', title: { mode: 'heading' } },
      designReason:
        'Four small setup beats build the race; a much larger fifth panel makes the single-owner result unmistakable.',
    },
    [
      panel(
        'Close-up of the final empty theater seat under a warm spotlight.',
        'Last seat.',
      ),
      {
        ...panel('Ivo reaches for the seat ticket from the left.', 'Mine!', 'Ivo'),
        characters: [{ name: 'Ivo', position: 'left', expression: 'excited' }],
      },
      {
        ...panel(
          'Ren reaches for the very same seat ticket from the right.',
          'Mine!',
          'Ren',
        ),
        characters: [{ name: 'Ren', position: 'right', expression: 'excited' }],
      },
      panel(
        'Close-up of a very small orderly turnstile appearing between the two reaching hands.',
        'One at a time.',
      ),
      {
        ...panel(
          'Large payoff: one clerk sits comfortably while the other waits politely behind the tiny turnstile; the surrounding empty theater is comically huge.',
          'One seat. One owner.',
        ),
        characters: [
          { name: 'Ivo', position: 'left', expression: 'happy' },
          { name: 'Ren', position: 'right', expression: 'thinking' },
        ],
      },
    ],
  ),

  script(
    'hero-inset',
    'A configuration migration changes labels while preserving values.',
    {
      title: 'Everything In Its Place',
      headline: 'EVERYTHING IN ITS PLACE',
      aspect: '4:3',
      style:
        'isometric handcrafted paper-and-wood miniature, soft studio light, precise little mechanisms',
      styleFamily: 'dimensional',
      palette: 'full-color',
      composition: {
        family: 'hero-inset',
        title: { mode: 'integrated', box: { x: 0.065, y: 0.81, w: 0.5, h: 0.12 } },
      },
      designReason:
        'A large migration machine establishes context; two detail insets prove what changed and what stayed. No cast is needed.',
    },
    [
      panel(
        'Large hero scene: a beautifully made little sorting machine carries colorful glass marbles from an old drawer to a new drawer. Leave its lower-left face clear for the integrated title.',
        'Same contents.',
      ),
      panel(
        'Inset close-up: a small wooden drawer label is replaced with a new label, without showing extra lettering.',
        'New labels.',
      ),
      panel(
        'Inset close-up: the original glass marbles all sit intact in the new drawer.',
        'Nothing lost.',
      ),
    ],
  ),

  script(
    'diagonal',
    'Shutdown now stops orphaned background jobs.',
    {
      title: 'Closing Time',
      aspect: '16:9',
      style:
        'crisp pixel-art ghost story, cool midnight blue and mint light, readable bitmap lettering',
      styleFamily: 'pixel',
      palette: 'limited',
      characters: [
        {
          name: 'Job',
          kind: 'creature',
          description:
            'a small translucent fictional ghost in a ragged office tie, representing an orphaned zombie job',
        },
      ],
      composition: { family: 'diagonal', title: { mode: 'none' } },
      designReason:
        'The ghost is specifically a zombie-job metaphor, not a default animal developer; the diagonal cut separates trapped work from its release.',
    },
    [
      {
        ...panel(
          'Upper-left triangular frame: Job is stuck inside a glowing monitor after the office has closed, still trying to type.',
          'Still here?',
          'Job',
        ),
        characters: [{ name: 'Job', position: 'left', expression: 'worried' }],
      },
      {
        ...panel(
          'Lower-right triangular frame: after a clean shutdown, Job happily floats through an open window into the night. Follow the diagonal motion toward the bottom-right.',
          'Finally off call.',
          'Job',
        ),
        characters: [{ name: 'Job', position: 'right', expression: 'happy' }],
      },
    ],
  ),
];

/**
 * What ties each synthetic story to its change: the anchor plus one label.
 * The stories above stay as written so evaluation keeps them as unanchored
 * baselines; tests and candidates use `anchoredStory`.
 */
const ANCHORS: Record<
  string,
  { anchor: ComicAnchor; label: { panel: number; points: string; text: string } }
> = {
  single: {
    anchor: {
      change: 'Closes a resource handle that was left open and leaked.',
      terms: ['open handle'],
      mapping: [{ visual: 'the tiny open tap', technical: 'the leaked resource handle' }],
    },
    label: { panel: 0, points: 'the tiny open tap', text: 'open handle' },
  },
  comparison: {
    anchor: {
      change: 'Replaces a confusing multi-step save workflow with one Save action.',
      terms: ['Save'],
      mapping: [{ visual: 'the large save button', technical: 'the single Save action' }],
    },
    label: { panel: 1, points: 'the large save button', text: 'Save' },
  },
  vertical: {
    anchor: {
      change:
        'Retries wait with backoff between attempts instead of hammering the service.',
      terms: ['backoff'],
      mapping: [{ visual: 'the sand timer', technical: 'retry backoff delay' }],
    },
    label: { panel: 2, points: 'the sand timer', text: 'backoff' },
  },
  asymmetric: {
    anchor: {
      change: 'A lock stops concurrent requests from claiming the same last seat.',
      terms: ['seat lock'],
      mapping: [{ visual: 'the tiny turnstile', technical: 'the seat lock' }],
    },
    label: { panel: 3, points: 'the tiny turnstile', text: 'seat lock' },
  },
  'hero-inset': {
    anchor: {
      change: 'A migration renames configuration keys and keeps their values.',
      terms: ['config keys'],
      mapping: [{ visual: 'the drawer labels', technical: 'configuration keys' }],
    },
    label: { panel: 1, points: 'the new drawer label', text: 'config keys' },
  },
  diagonal: {
    anchor: {
      change: 'Shutdown now stops orphaned background jobs.',
      terms: ['orphaned job'],
      mapping: [{ visual: 'the ghost', technical: 'an orphaned background job' }],
    },
    label: { panel: 0, points: 'the ghost', text: 'orphaned job' },
  },
};

/** A story's script with its anchor and label: what a current drafter writes. */
export function anchoredStory(id: string): ComicScript {
  const story = COMIC_STORIES.find((c) => c.id === id)!;
  const { anchor, label } = ANCHORS[id]!;
  const s = structuredClone(story.script);
  s.anchor = structuredClone(anchor);
  s.panels[label.panel]!.dialogue.push({
    speaker: 'caption',
    kind: 'label',
    points: label.points,
    text: label.text,
  });
  return s;
}
