/**
 * Art style ideas. A comic can use any art style: one of these by id (it
 * expands to a tested prompt), or the agent's own description. Each comic
 * picks a style that suits the PR and differs from the repo's recent comics.
 */
import type { Palette } from './types.ts';

export interface Style {
  id: string;
  name: string;
  /** The style block for image prompts. */
  prompt: string;
  /** Palettes that suit it; the first is the default. */
  palettes: Palette[];
  /** Moods it is good at, to help pick. */
  moods: string[];
  /** Lettering direction for the image model. */
  lettering: string;
}

export const STYLES: Style[] = [
  {
    id: 'manga-ink',
    name: 'Manga ink',
    prompt:
      'black-and-white manga page, crisp ink linework, screentone shading, speed lines and impact bursts, dramatic angles, expressive eyes',
    palettes: ['bw-accent', 'limited'],
    moods: ['dramatic', 'intense', 'heroic', 'victory'],
    lettering: 'hand-lettered manga captions in boxes, bold brush-script headline',
  },
  {
    id: 'shonen-action',
    name: 'Shonen action',
    prompt:
      'full-color shonen anime action page, dynamic poses, motion blur, glowing energy effects, bold cel shading',
    palettes: ['full-color'],
    moods: ['epic', 'battle', 'comeback', 'speed'],
    lettering: 'big angled sound effects, bold outlined headline',
  },
  {
    id: 'mecha-anime',
    name: 'Mecha anime',
    prompt:
      'mecha anime style, detailed robots and cockpits, holographic HUD panels, cinematic lighting',
    palettes: ['full-color', 'bw-accent'],
    moods: ['systems', 'infrastructure', 'launch', 'precision'],
    lettering: 'HUD labels and readouts on screens, condensed sci-fi headline',
  },
  {
    id: 'chibi-anime',
    name: 'Chibi anime',
    prompt:
      'cute chibi anime style, big heads, small bodies, soft cel shading, pastel colors',
    palettes: ['full-color'],
    moods: ['cozy', 'silly', 'small fix', 'wholesome'],
    lettering: 'rounded bubbly lettering, playful headline',
  },
  {
    id: 'noir',
    name: 'Film noir',
    prompt:
      'film noir graphic novel, heavy black shadows, venetian-blind light, rain, chiaroscuro, trench coats',
    palettes: ['bw-accent', 'limited'],
    moods: ['mystery', 'debugging', 'investigation', 'suspense'],
    lettering: 'typewriter caption boxes, hard-boiled narration, stark serif headline',
  },
  {
    id: 'silver-age',
    name: 'Silver-age comic',
    prompt:
      '1960s American comic book, Ben-Day halftone dots, bold primary colors, thick outlines, heroic poses',
    palettes: ['full-color', 'limited'],
    moods: ['heroic', 'rescue', 'big win', 'retro'],
    lettering:
      'classic comic lettering in white balloons, exclamation-heavy, burst headline',
  },
  {
    id: 'ligne-claire',
    name: 'Ligne claire',
    prompt:
      'ligne claire European comic style, clean uniform outlines, flat colors, detailed tidy backgrounds, no hatching',
    palettes: ['full-color'],
    moods: ['adventure', 'exploration', 'clever', 'travel'],
    lettering: 'neat hand lettering in clean balloons, elegant headline',
  },
  {
    id: 'sunday-strip',
    name: 'Sunday newspaper strip',
    prompt:
      'classic Sunday newspaper comic strip, simple expressive cartoon characters, warm flat colors, slight paper texture',
    palettes: ['full-color', 'limited'],
    moods: ['gag', 'everyday', 'relatable', 'small fix'],
    lettering: 'friendly hand-lettered balloons, strip title in a banner',
  },
  {
    id: 'rubber-hose',
    name: '1930s rubber hose',
    prompt:
      '1930s rubber-hose cartoon, bendy limbs, pie-cut eyes, white gloves, sepia film grain, bouncy motion',
    palettes: ['limited', 'duotone'],
    moods: ['slapstick', 'chaos', 'silly', 'retro'],
    lettering: 'vintage title card lettering, bouncy balloons',
  },
  {
    id: 'storybook-watercolor',
    name: 'Storybook watercolor',
    prompt:
      "children's storybook watercolor illustration, soft washes, pencil linework, gentle light",
    palettes: ['full-color'],
    moods: ['gentle', 'cleanup', 'care', 'wholesome'],
    lettering: 'handwritten storybook captions, whimsical headline',
  },
  {
    id: 'claymation',
    name: 'Claymation',
    prompt:
      'stop-motion claymation diorama, plasticine characters with fingerprints, miniature set, soft studio lighting',
    palettes: ['full-color'],
    moods: ['handmade', 'building', 'silly', 'craft'],
    lettering: 'cut-paper signs and labels in the set, chunky headline',
  },
  {
    id: 'pixel-16bit',
    name: '16-bit pixel art',
    prompt:
      '16-bit pixel art like a 1990s console game, crisp pixels, limited palette, game UI elements',
    palettes: ['limited', 'full-color'],
    moods: ['quest', 'level up', 'boss fight', 'retro'],
    lettering: 'pixel font dialogue boxes like an RPG, "LEVEL CLEAR" style headline',
  },
  {
    id: 'risograph',
    name: 'Risograph zine',
    prompt:
      'risograph-printed zine, two overprinted ink colors, grainy texture, slight misregistration, bold shapes',
    palettes: ['duotone'],
    moods: ['indie', 'tooling', 'docs', 'craft'],
    lettering: 'chunky grotesque type, stamped labels',
  },
  {
    id: 'pulp-scifi',
    name: 'Pulp sci-fi',
    prompt:
      '1950s pulp science fiction magazine art, ray guns, rocket fins, painted gouache, dramatic sky',
    palettes: ['full-color', 'limited'],
    moods: ['launch', 'future', 'bold claim', 'adventure'],
    lettering: 'pulp magazine cover headline, starburst blurbs',
  },
  {
    id: 'ukiyo-e',
    name: 'Ukiyo-e woodblock',
    prompt:
      'Japanese ukiyo-e woodblock print, flat color areas, carved outlines, stylized waves and clouds, washi paper texture',
    palettes: ['limited'],
    moods: ['calm', 'refactor', 'balance', 'migration'],
    lettering: 'vertical cartouche labels, brush headline',
  },
  {
    id: 'atomic-flat',
    name: 'Mid-century flat',
    prompt:
      'mid-century modern illustration, atomic-age shapes, flat geometric characters, starbursts, cream background',
    palettes: ['limited', 'full-color'],
    moods: ['optimistic', 'product', 'feature', 'clean'],
    lettering: 'retro display type, small caption labels',
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    prompt:
      'technical blueprint, white linework on cyan blueprint paper, callouts, dimension lines, exploded views',
    palettes: ['duotone'],
    moods: ['architecture', 'internals', 'how it works', 'design'],
    lettering: 'drafting stencil labels and callouts, title block headline',
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    prompt:
      'vaporwave aesthetic, neon pink and cyan, synthwave sun, chrome text, grid horizon, retro computer windows',
    palettes: ['full-color'],
    moods: ['performance', 'speed', 'nostalgia', 'ui'],
    lettering: 'chrome and neon headline, window-title labels',
  },
];

export const styleById = (id: string | undefined) => STYLES.find((s) => s.id === id);

/** Style ideas not used recently (and not `current`), least recently used last. */
export function freshStyles(recent: string[] = [], current?: string): Style[] {
  const pool = STYLES.filter((s) => s.id !== current);
  return [
    ...pool.filter((s) => !recent.includes(s.id)),
    ...pool.filter((s) => recent.includes(s.id)),
  ];
}

/** The style block for a prompt: a known idea's tested prompt, or the text as written. */
export function styleText(style: string): string {
  return styleById(style)?.prompt ?? style.trim();
}

/** Lettering direction for a style: the idea's, or a neutral default. */
export function styleLettering(style: string): string {
  return (
    styleById(style)?.lettering ??
    'clean hand-lettered comic text that suits the art style, easy to read at phone size'
  );
}

/** How a palette reads in a prompt. */
export function paletteText(palette: Palette, accent?: string): string {
  switch (palette) {
    case 'bw-accent':
      return `black and white with a single accent color (${accent ?? 'red'}) used sparingly for emphasis`;
    case 'duotone':
      return `two-color print (${accent ? `black and ${accent}` : 'two inks'})`;
    case 'limited':
      return 'limited palette of 3 to 4 colors';
    default:
      return 'full color';
  }
}
