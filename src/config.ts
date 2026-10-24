/**
 * Settings: user-level (`~/.config/tracetoon/config.json`, or
 * `%APPDATA%\tracetoon\config.json` on Windows) overlaid by the repo's
 * `.github/tracetoon.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  /** Skip the preview step when every safety check passes. Default false. */
  yolo: boolean;
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
  /** Make a comic at all. */
  comic: boolean;
  /** Pin one art style for every comic (a style idea id or any description), or `auto` to vary. */
  style: string;
  /** Use Tracetoon for PRs at all. Off here, or in any other switch, wins. */
  enabled: boolean;
}

export const DEFAULTS: Config = {
  enabled: true,
  yolo: false,
  promptQuoting: 'paraphrase',
  disclosure: 'assisted-by',
  budgetTokens: 12000,
  hosting: 'auto',
  imageConsent: [],
  comic: true,
  style: 'auto',
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

export function loadConfig(root?: string): Config {
  const user = readJson(userConfigPath());
  // Only the user can approve sending prompts to an image service: a repo's
  // config file can't do it for them.
  const { imageConsent: _ignored, ...repo } = root ? readJson(repoConfigPath(root)) : {};
  return {
    ...DEFAULTS,
    ...user,
    ...repo,
    imageConsent: user.imageConsent ?? DEFAULTS.imageConsent,
  };
}

export function setUserConfig(key: keyof Config, raw: string): Config {
  const p = userConfigPath();
  const cur = readJson(p);
  const def = DEFAULTS[key];
  const value =
    typeof def === 'boolean'
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
  return { ...DEFAULTS, ...next };
}
