/**
 * Art styles. Each comic picks one (the agent chooses; Tracetoon blocks clashes
 * and repeats). A style says which casts it suits: anime and manga styles never
 * get animal casts by default, because animal characters drawn in anime style
 * read as "furry", which nobody asked for.
 */
import type { CastMember, Palette, Species } from './types.ts';

/** What kind of body a character has, for style fit. */
export type CastKind = 'human' | 'robot' | 'creature' | 'animal';

export function castKind(species: Species): CastKind {
  switch (species) {
    case 'human':
      return 'human';
    case 'mecha':
    case 'drone':
    case 'robot':
      return 'robot';
    case 'fox':
    case 'cat':
    case 'otter':
    case 'dog':
      return 'animal';
    default:
      return 'creature';
  }
}

export interface Style {
  id: string;
  name: string;
  /** The style block for image prompts. */
  prompt: string;
  /** Palettes that suit it; the first is the default. */
  palettes: Palette[];
  /** Moods it is good at, to help pick. */
  moods: string[];
  /** Kinds of cast it suits. Creatures (small bugs, imps) fit everywhere. */
  casts: CastKind[];
  /** Lettering direction for the image model. */
  lettering: string;
  /** Anime or manga look (never with animal casts unless the user opts in). */
  anime?: boolean;
}

const ALL: CastKind[] = ['human', 'robot', 'creature', 'animal'];
const NO_ANIMALS: CastKind[] = ['human', 'robot', 'creature'];

export const STYLES: Style[] = [
  {
    id: 'manga-ink',
    name: 'Manga ink',
    prompt:
      'black-and-white manga page, crisp ink linework, screentone shading, speed lines and impact bursts, dramatic angles, expressive eyes',
    palettes: ['bw-accent', 'limited'],
    moods: ['dramatic', 'intense', 'heroic', 'victory'],
    casts: NO_ANIMALS,
    lettering: 'hand-lettered manga captions in boxes, bold brush-script headline',
    anime: true,
  },
  {
    id: 'shonen-action',
    name: 'Shonen action',
    prompt:
      'full-color shonen anime action page, dynamic poses, motion blur, glowing energy effects, bold cel shading',
    palettes: ['full-color'],
    moods: ['epic', 'battle', 'comeback', 'speed'],
    casts: NO_ANIMALS,
    lettering: 'big angled sound effects, bold outlined headline',
    anime: true,
  },
  {
    id: 'mecha-anime',
    name: 'Mecha anime',
    prompt:
      'mecha anime style, detailed robots and cockpits, holographic HUD panels, cinematic lighting',
    palettes: ['full-color', 'bw-accent'],
    moods: ['systems', 'infrastructure', 'launch', 'precision'],
    casts: NO_ANIMALS,
    lettering: 'HUD labels and readouts on screens, condensed sci-fi headline',
    anime: true,
  },
  {
    id: 'chibi-anime',
    name: 'Chibi anime',
    prompt:
      'cute chibi anime style, big heads, small bodies, soft cel shading, pastel colors',
    palettes: ['full-color'],
    moods: ['cozy', 'silly', 'small fix', 'wholesome'],
    casts: NO_ANIMALS,
    lettering: 'rounded bubbly lettering, playful headline',
    anime: true,
  },
  {
    id: 'noir',
    name: 'Film noir',
    prompt:
      'film noir graphic novel, heavy black shadows, venetian-blind light, rain, chiaroscuro, trench coats',
    palettes: ['bw-accent', 'limited'],
    moods: ['mystery', 'debugging', 'investigation', 'suspense'],
    casts: ALL,
    lettering: 'typewriter caption boxes, hard-boiled narration, stark serif headline',
  },
  {
    id: 'silver-age',
    name: 'Silver-age comic',
    prompt:
      '1960s American comic book, Ben-Day halftone dots, bold primary colors, thick outlines, heroic poses',
    palettes: ['full-color', 'limited'],
    moods: ['heroic', 'rescue', 'big win', 'retro'],
    casts: ALL,
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
    casts: ALL,
    lettering: 'neat hand lettering in clean balloons, elegant headline',
  },
  {
    id: 'sunday-strip',
    name: 'Sunday newspaper strip',
    prompt:
      'classic Sunday newspaper comic strip, simple expressive cartoon characters, warm flat colors, slight paper texture',
    palettes: ['full-color', 'limited'],
    moods: ['gag', 'everyday', 'relatable', 'small fix'],
    casts: ALL,
    lettering: 'friendly hand-lettered balloons, strip title in a banner',
  },
  {
    id: 'rubber-hose',
    name: '1930s rubber hose',
    prompt:
      '1930s rubber-hose cartoon, bendy limbs, pie-cut eyes, white gloves, sepia film grain, bouncy motion',
    palettes: ['limited', 'duotone'],
    moods: ['slapstick', 'chaos', 'silly', 'retro'],
    casts: ALL,
    lettering: 'vintage title card lettering, bouncy balloons',
  },
  {
    id: 'storybook-watercolor',
    name: 'Storybook watercolor',
    prompt:
      "children's storybook watercolor illustration, soft washes, pencil linework, gentle light",
    palettes: ['full-color'],
    moods: ['gentle', 'cleanup', 'care', 'wholesome'],
    casts: ALL,
    lettering: 'handwritten storybook captions, whimsical headline',
  },
  {
    id: 'claymation',
    name: 'Claymation',
    prompt:
      'stop-motion claymation diorama, plasticine characters with fingerprints, miniature set, soft studio lighting',
    palettes: ['full-color'],
    moods: ['handmade', 'building', 'silly', 'craft'],
    casts: ALL,
    lettering: 'cut-paper signs and labels in the set, chunky headline',
  },
  {
    id: 'pixel-16bit',
    name: '16-bit pixel art',
    prompt:
      '16-bit pixel art like a 1990s console game, crisp pixels, limited palette, game UI elements',
    palettes: ['limited', 'full-color'],
    moods: ['quest', 'level up', 'boss fight', 'retro'],
    casts: ALL,
    lettering: 'pixel font dialogue boxes like an RPG, "LEVEL CLEAR" style headline',
  },
  {
    id: 'risograph',
    name: 'Risograph zine',
    prompt:
      'risograph-printed zine, two overprinted ink colors, grainy texture, slight misregistration, bold shapes',
    palettes: ['duotone'],
    moods: ['indie', 'tooling', 'docs', 'craft'],
    casts: ALL,
    lettering: 'chunky grotesque type, stamped labels',
  },
  {
    id: 'pulp-scifi',
    name: 'Pulp sci-fi',
    prompt:
      '1950s pulp science fiction magazine art, ray guns, rocket fins, painted gouache, dramatic sky',
    palettes: ['full-color', 'limited'],
    moods: ['launch', 'future', 'bold claim', 'adventure'],
    casts: ALL,
    lettering: 'pulp magazine cover headline, starburst blurbs',
  },
  {
    id: 'ukiyo-e',
    name: 'Ukiyo-e woodblock',
    prompt:
      'Japanese ukiyo-e woodblock print, flat color areas, carved outlines, stylized waves and clouds, washi paper texture',
    palettes: ['limited'],
    moods: ['calm', 'refactor', 'balance', 'migration'],
    casts: NO_ANIMALS,
    lettering: 'vertical cartouche labels, brush headline',
  },
  {
    id: 'atomic-flat',
    name: 'Mid-century flat',
    prompt:
      'mid-century modern illustration, atomic-age shapes, flat geometric characters, starbursts, cream background',
    palettes: ['limited', 'full-color'],
    moods: ['optimistic', 'product', 'feature', 'clean'],
    casts: ALL,
    lettering: 'retro display type, small caption labels',
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    prompt:
      'technical blueprint, white linework on cyan blueprint paper, callouts, dimension lines, exploded views',
    palettes: ['duotone'],
    moods: ['architecture', 'internals', 'how it works', 'design'],
    casts: ALL,
    lettering: 'drafting stencil labels and callouts, title block headline',
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    prompt:
      'vaporwave aesthetic, neon pink and cyan, synthwave sun, chrome text, grid horizon, retro computer windows',
    palettes: ['full-color'],
    moods: ['performance', 'speed', 'nostalgia', 'ui'],
    casts: ALL,
    lettering: 'chrome and neon headline, window-title labels',
  },
];

export const styleById = (id: string | undefined) => STYLES.find((s) => s.id === id);

/** Why a style doesn't suit these characters, if it doesn't. */
export function styleClash(
  style: Style,
  cast: Pick<CastMember, 'name' | 'species'>[],
  opts: { allowAnimalAnime?: boolean } = {},
): string | undefined {
  for (const c of cast) {
    const kind = castKind(c.species);
    if (style.casts.includes(kind)) continue;
    if (kind === 'animal' && style.anime && opts.allowAnimalAnime) continue;
    return `${style.name} doesn't suit ${c.name} (${kind}: ${c.species})${
      style.anime && kind === 'animal'
        ? '; animal characters in an anime style come out as furries. Pick a cartoon style, or set allowAnimalAnime if the user wants this'
        : ''
    }`;
  }
  return undefined;
}

/** Styles that suit this cast, least recently used first. */
export function fittingStyles(
  cast: Pick<CastMember, 'name' | 'species'>[],
  recent: string[] = [],
  opts: { allowAnimalAnime?: boolean } = {},
): Style[] {
  const fits = STYLES.filter((s) => !styleClash(s, cast, opts));
  return [
    ...fits.filter((s) => !recent.includes(s.id)),
    ...fits.filter((s) => recent.includes(s.id)),
  ];
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
