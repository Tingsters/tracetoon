/** The comic's data: who is in it (the series bible) and what happens (the script). */

export type Theme = 'pets' | 'mecha' | 'scifi';
export const THEMES: Theme[] = ['pets', 'mecha', 'scifi'];

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
  /** A cast id, or "caption" for narration. */
  speaker: string;
  text: string;
  kind?: 'speech' | 'thought' | 'caption' | 'sfx';
}

export interface Panel {
  beat: Beat;
  /** What the panel shows, in a sentence. */
  scene: string;
  camera?: 'wide' | 'medium' | 'close';
  characters: PanelCharacter[];
  dialogue: Dialogue[];
  /** Optional extra direction for image models. */
  artPrompt?: string;
}

export interface ComicScript {
  v: 1;
  title: string;
  /** One or two sentences: what this episode was about (feeds "previously on"). */
  synopsis: string;
  /** Describes the whole comic for screen readers. */
  altText: string;
  panels: Panel[];
}
