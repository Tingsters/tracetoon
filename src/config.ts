/**
 * Settings: user-level (`~/.config/tracetoon/config.json`, or
 * `%APPDATA%\tracetoon\config.json` on Windows) overlaid by the repo's
 * `.github/tracetoon.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Whether PRs get a comic: never, unless the repo's rules forbid images in PRs, or always. */
export type ComicMode = 'off' | 'allowed' | 'always';
export const COMIC_MODES = ['off', 'allowed', 'always'] as const;

/** A comic setting from any source: old booleans and `true`/`false` strings still work. */
export function comicMode(v: unknown): ComicMode {
  if (v === false || v === 'false') return 'off';
  if (v === true || v === 'true') return 'allowed';
  return (COMIC_MODES as readonly unknown[]).includes(v) ? (v as ComicMode) : 'allowed';
}

export interface Config {
  /** Quote the user's prompts verbatim in the PR ("verbatim") or paraphrase ("paraphrase"). */
  promptQuoting: 'verbatim' | 'paraphrase';
  /** Trailer style to suggest: kernel-style Assisted-by, Co-Authored-By, or none. */
  disclosure: 'assisted-by' | 'co-authored-by' | 'none';
  /** Digest token budget. */
  budgetTokens: number;
  /** Where the comic image is hosted: the assets branch, a GitHub attachment, or decide automatically. */
  hosting: 'auto' | 'branch' | 'attach';
  /** Image providers the user agreed to send comic prompts to. */
  imageConsent: string[];
  /** Make a comic: `off`, `allowed` (unless the repo forbids images in PRs), or `always`. */
  comic: ComicMode;
  /** Pin one art style for every comic (a style idea id or any description), or `auto` to vary. */
  style: string;
  /** Use Tracetoon for PRs at all. Off here, or in any other switch, wins. */
  enabled: boolean;
  /** Updates: `off` never looks, `notify` says so when a newer release exists, `install` also installs it. */
  autoUpdate: AutoUpdate;
  /** `latest` includes release candidates; `stable` only full releases. */
  updateChannel: UpdateChannel;
}

export const AUTO_UPDATES = ['off', 'notify', 'install'] as const;
export type AutoUpdate = (typeof AUTO_UPDATES)[number];
export const UPDATE_CHANNELS = ['stable', 'latest'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const DEFAULTS: Config = {
  enabled: true,
  promptQuoting: 'paraphrase',
  disclosure: 'assisted-by',
  budgetTokens: 12000,
  hosting: 'auto',
  imageConsent: [],
  comic: 'allowed',
  style: 'auto',
  autoUpdate: 'notify',
  updateChannel: 'latest',
};

export function userConfigPath(): string {
  if (process.env.TRACETOON_CONFIG) return process.env.TRACETOON_CONFIG;
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'tracetoon', 'config.json');
}

export function repoConfigPath(root: string): string {
  return join(root, '.github', 'tracetoon.json');
}

/** A config file's known settings; anything else (old `theme`, say) is ignored. */
function readJson(p: string): Partial<Config> {
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).filter(([k]) => k in DEFAULTS),
    ) as Partial<Config>;
  } catch {
    return {};
  }
}

function oneOf<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

export function loadConfig(root?: string): Config {
  const user = readJson(userConfigPath());
  // Only the user can approve sending prompts to an image service: a repo's
  // config file can't do it for them.
  // Likewise only the user decides whether and how this machine updates its own programs.
  const {
    imageConsent: _consent,
    autoUpdate: _auto,
    updateChannel: _channel,
    ...repo
  } = root ? readJson(repoConfigPath(root)) : {};
  return {
    ...DEFAULTS,
    ...user,
    ...repo,
    comic: comicMode(repo.comic ?? user.comic ?? DEFAULTS.comic),
    imageConsent: user.imageConsent ?? DEFAULTS.imageConsent,
    autoUpdate: oneOf(AUTO_UPDATES, user.autoUpdate, DEFAULTS.autoUpdate),
    updateChannel: oneOf(UPDATE_CHANNELS, user.updateChannel, DEFAULTS.updateChannel),
  };
}

export function setUserConfig(key: keyof Config, raw: string): Config {
  const p = userConfigPath();
  const cur = readJson(p);
  const def = DEFAULTS[key];
  const value =
    key === 'comic'
      ? comicMode(raw)
      : typeof def === 'boolean'
        ? raw === 'true'
        : typeof def === 'number'
          ? Number(raw)
          : Array.isArray(def)
            ? raw
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : raw;
  const next = { ...cur, [key]: value };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { ...DEFAULTS, ...next, comic: comicMode(next.comic ?? DEFAULTS.comic) };
}
