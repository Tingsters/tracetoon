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
  /** Comic theme for later milestones. */
  theme: 'pets' | 'mecha' | 'scifi';
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
}

export const DEFAULTS: Config = {
  yolo: false,
  theme: 'pets',
  promptQuoting: 'paraphrase',
  disclosure: 'assisted-by',
  budgetTokens: 12000,
  hosting: 'auto',
  imageConsent: [],
  comic: true,
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

function readJson(p: string): Partial<Config> {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>) : {};
  } catch {
    return {};
  }
}

export function loadConfig(root?: string): Config {
  return {
    ...DEFAULTS,
    ...readJson(userConfigPath()),
    ...(root ? readJson(repoConfigPath(root)) : {}),
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
