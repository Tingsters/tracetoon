/**
 * The comic's data: one page brief per PR. Each comic invents its own
 * characters and picks its own art direction. Only compact creative choices
 * are read back to notice repetition; characters are never carried forward.
 */

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

/** A character invented for this comic. */
export interface Character {
  /** How panels and dialogue refer to it, and the name in the transcript. */
  name: string;
  /** What it looks like, for the image model. */
  description: string;
  /** Creative category, not an identity inferred from the description. */
  kind?: CastKind;
}

export type CastKind = 'human' | 'creature' | 'object';
export const CAST_KINDS: CastKind[] = ['human', 'creature', 'object'];
export type StyleFamily =
  | 'ink'
  | 'flat-color'
  | 'painted'
  | 'print'
  | 'dimensional'
  | 'pixel'
  | 'technical'
  | 'custom';
export const STYLE_FAMILIES: StyleFamily[] = [
  'ink',
  'flat-color',
  'painted',
  'print',
  'dimensional',
  'pixel',
  'technical',
  'custom',
];
export const LAYOUT_FAMILIES = [
  'single',
  'comparison',
  'sequence',
  'vertical',
  'asymmetric',
  'hero-inset',
  'diagonal',
  'custom',
] as const;
export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];
export type TitleMode = 'none' | 'integrated' | 'heading';
/** Coordinates are fractions of the page, before the branding footer. */
export interface FrameBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PanelFrame extends FrameBounds {
  /** Polygon points in the frame's own 0–1 space. */
  clip?: [number, number][];
  border?: 'line' | 'none';
  /** Safe lettering area in the frame's own 0–1 space. Required for polygon dialogue. */
  textBox?: FrameBounds;
  /** This later frame deliberately sits inside an earlier frame. */
  inset?: boolean;
}
export interface Composition {
  family: LayoutFamily;
  /** In story/reading order. Omit to use the family's geometry (except custom). */
  frames?: PanelFrame[];
  title: { mode: TitleMode; box?: FrameBounds };
}
/** Only these compact creative choices are read back from published PRs. */
export interface ComicSummary {
  style?: string;
  styleFamily?: StyleFamily;
  layoutFamily?: LayoutFamily;
  panelCount?: number;
  titleTreatment?: TitleMode;
  /** Missing means unknown; [] means deliberately characterless. */
  castKinds?: CastKind[];
}

/** A character's place in one panel. */
export interface PanelCharacter {
  /** A name from the comic's `characters`. */
  name: string;
  position: 'left' | 'center' | 'right';
  expression?: Expression;
  pose?: string;
}

export interface Dialogue {
  /** A character's name, or "caption" for narration (also used for signs and screens). */
  speaker: string;
  /** Exact words. With model lettering they are drawn into the art verbatim. */
  text: string;
  /** `sign`: words on something in the scene (a screen, a sign, a label). */
  kind?: 'speech' | 'thought' | 'caption' | 'sfx' | 'sign';
}

export interface Panel {
  /** Optional story beat. */
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

/**
 * The comic: a page brief. A format and layout the agent chooses, 1-6 panels,
 * characters made up for this PR, any art style, and text the image model
 * letters into the art.
 */
export interface ComicScript {
  v: 2;
  /** Comic title (used in the PR and the transcript). */
  title: string;
  /** The big title drawn into the art; up to 6 words. Defaults to `title`. */
  headline?: string;
  /** A format id from formats.ts, or "custom". */
  format: string;
  /** How the page is composed, in the agent's words. */
  layout?: string;
  /** Shared geometry for model lettering and overlay lettering; absent means legacy layout. */
  composition?: Composition;
  /** A broad visual family so renaming a style does not disguise repetition. */
  styleFamily?: StyleFamily;
  /** Local art-direction rationale; never included in public PR metadata. */
  designReason?: string;
  /** Page shape. Default: the format's. */
  aspect?: Aspect;
  /** Any art style: an idea from styles.ts by id, or the agent's own description. */
  style: string;
  /** Color treatment. Default: the style's first palette, or full color. */
  palette?: Palette;
  /** One accent color for `bw-accent` / `duotone`, e.g. "red". */
  accent?: string;
  /** Who appears, invented for this comic (may be empty). */
  characters: Character[];
  /** One or two sentences: what this comic is about (the share caption). */
  synopsis: string;
  /** Describes the whole comic for screen readers. */
  altText: string;
  panels: Panel[];
}
