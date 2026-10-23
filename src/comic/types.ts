/** The comic's data: who is in it (the series bible) and what happens (the script). */

/**
 * A theme is the setting and the cast. The art style is chosen per comic (see
 * styles.ts), and must suit the cast: anime and manga styles never get animal
 * casts unless the user asks for it.
 */
export type Theme = 'pets' | 'mecha' | 'scifi' | 'office' | 'heist' | 'fantasy';
export const THEMES: Theme[] = ['pets', 'mecha', 'scifi', 'office', 'heist', 'fantasy'];

/** Body shapes the built-in SVG artist can draw. */
export type Species =
  | 'fox'
  | 'cat'
  | 'otter'
  | 'dog'
  | 'human'
  | 'beetle'
  | 'mecha'
  | 'drone'
  | 'robot'
  | 'kaiju'
  | 'alien';

export interface CastMember {
  id: string;
  name: string;
  /** `agent` (stands for an AI agent), `human` (the developer), `extra`. */
  role: 'agent' | 'human' | 'extra';
  /** For agents: the agent this character stands for, e.g. "Claude Code". */
  agent?: string;
  species: Species;
  /** Appearance, for image models. */
  description: string;
  /** Main colors, hex. The first is the body color. */
  palette: string[];
}

/** Everything that stays the same from one episode to the next. */
export interface SeriesBible {
  v: 1;
  series: string;
  title: string;
  theme: Theme;
  /** Style prompt shared by every panel. */
  style: string;
  /** Things image models must avoid. */
  negative: string;
  cast: CastMember[];
  /** Cast id → path (on the assets branch) of a reference portrait. */
  references?: Record<string, string>;
}

export type Beat = 'ki' | 'sho' | 'ten' | 'ketsu';
export const BEATS: Beat[] = ['ki', 'sho', 'ten', 'ketsu'];
export const BEAT_MEANING: Record<Beat, string> = {
  ki: 'setup',
  sho: 'development',
  ten: 'twist',
  ketsu: 'resolution',
};

export type Expression =
  | 'happy'
  | 'excited'
  | 'worried'
  | 'surprised'
  | 'determined'
  | 'thinking'
  | 'sleepy'
  | 'proud'
  | 'angry';
export const EXPRESSIONS: Expression[] = [
  'happy',
  'excited',
  'worried',
  'surprised',
  'determined',
  'thinking',
  'sleepy',
  'proud',
  'angry',
];

export interface PanelCharacter {
  cast: string;
  position: 'left' | 'center' | 'right';
  expression?: Expression;
  pose?: string;
}

export interface Dialogue {
  /** A cast id, or "caption" for narration (also used for signs and screens). */
  speaker: string;
  /** Exact words. With model lettering they are drawn into the art verbatim. */
  text: string;
  /** `sign`: words on something in the scene (a screen, a sign, a label). */
  kind?: 'speech' | 'thought' | 'caption' | 'sfx' | 'sign';
}

export interface Panel {
  /** Story beat. Required for v1 (4-koma) scripts, optional for pages. */
  beat?: Beat;
  /** What the panel shows, in a sentence. */
  scene: string;
  camera?: 'wide' | 'medium' | 'close';
  characters: PanelCharacter[];
  dialogue: Dialogue[];
  /** Optional extra direction for image models. */
  artPrompt?: string;
}

export type Aspect = '4:3' | '1:1' | '16:9' | '3:4';
export const ASPECTS: Aspect[] = ['4:3', '1:1', '16:9', '3:4'];

export type Palette = 'full-color' | 'bw-accent' | 'duotone' | 'limited';
export const PALETTES: Palette[] = ['full-color', 'bw-accent', 'duotone', 'limited'];

/** How this comic relates to earlier ones. Only a sequel gets a "previously". */
export interface Continuity {
  mode: 'standalone' | 'sequel' | 'new-arc';
  /** For a sequel: the PR numbers it follows. */
  of?: number[];
}

/**
 * The comic. v1 is the original fixed 4-koma (four panels, beats ki/sho/ten/
 * ketsu, Tracetoon draws the bubbles). v2 is a page brief: a format and layout
 * the agent chooses, 1-6 panels, a style and palette, and text the image model
 * letters into the art.
 */
export interface ComicScript {
  v: 1 | 2;
  /** Episode title (used in the PR and the transcript). */
  title: string;
  /** v2: the big title drawn into the art; up to 6 words. Defaults to `title`. */
  headline?: string;
  /** v2: a format id from formats.ts, or "custom". */
  format?: string;
  /** v2: how the page is composed, in the agent's words. */
  layout?: string;
  /** v2: page shape. Default 4:3. */
  aspect?: Aspect;
  /** v2: a style id from styles.ts. */
  style?: string;
  /** v2: color treatment. Default: the style's first palette. */
  palette?: Palette;
  /** v2: one accent color for `bw-accent` / `duotone`, e.g. "red". */
  accent?: string;
  /** v2: default standalone. */
  continuity?: Continuity;
  /** One or two sentences: what this episode was about (feeds "previously on"). */
  synopsis: string;
  /** Describes the whole comic for screen readers. */
  altText: string;
  panels: Panel[];
}
