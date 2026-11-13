/** Reading and writing agent config files without touching what isn't Tracetoon's. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Json } from '../integrations/types.ts';

/** A hook command Tracetoon registered (recognized by "tracetoon … hook pre-pr/lifecycle"). */
export const isOurs = (command: unknown): command is string =>
  typeof command === 'string' &&
  /tracetoon/i.test(command) &&
  /hook (?:pre-pr|lifecycle)\b/.test(command);

/** A JSON object from the file; {} if missing or empty. Throws on anything else. */
export function readStrict(file: string): Json {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text); // throws on invalid JSON: never overwrite what we can't read
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  return parsed as Json;
}

/** Write the config, backing the original up once; an empty object removes the file. */
export function writeConfig(file: string, data: Json): void {
  if (existsSync(file) && !existsSync(`${file}.tracetoon.bak`))
    copyFileSync(file, `${file}.tracetoon.bak`);
  if (Object.keys(data).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Matcher groups ({ matcher, hooks: [...] }) with Tracetoon's handlers taken out. */
export function withoutOurGroups(groups: unknown): Json[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => {
    if (!g || !Array.isArray(g.hooks)) return [g];
    const kept = g.hooks.filter((h: Json) => !isOurs(h?.command));
    if (kept.length === g.hooks.length) return [g];
    return kept.length ? [{ ...g, hooks: kept }] : [];
  });
}

/** Tracetoon's pre-pr command in a list of matcher groups. */
export function prePrIn(groups: unknown): string | undefined {
  if (!Array.isArray(groups)) return undefined;
  return groups
    .flatMap((g: Json) => (Array.isArray(g?.hooks) ? g.hooks : []))
    .find((h: Json) => isOurs(h?.command) && h.command.includes('hook pre-pr'))?.command;
}
