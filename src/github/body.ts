import { createHash } from 'node:crypto';
/**
 * The part of a PR body Tracetoon owns. Everything between the start and end
 * markers is ours to replace; anything a human wrote outside them is kept.
 */

export const START = '<!-- tracetoon:start -->';
export const END = '<!-- tracetoon:end -->';
const META_RE = /<!-- tracetoon:meta (\{[\s\S]*?\}) -->/;

export interface PrMeta {
  v: 1;
  /** The comic's art style, so later comics in the repo pick a different one. */
  style?: string;
  /** Hash of the block's text as posted, to notice later edits on GitHub. */
  contentSha?: string;
  /** Hash of the title as posted, so a title someone edits on GitHub is kept. */
  titleSha?: string;
}

/** JSON that can never end an HTML comment early (no `--`, no `>`). */
export function encodeMeta(meta: PrMeta): string {
  const json = JSON.stringify(meta).replace(/-/g, '\\u002d').replace(/>/g, '\\u003e');
  return `<!-- tracetoon:meta ${json} -->`;
}

export function decodeMeta(body: string): PrMeta | undefined {
  const m = META_RE.exec(body);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!) as PrMeta;
  } catch {
    return undefined;
  }
}

/** Defuse @mentions in generated text so a quoted prompt can't ping anyone. */
export function defuseMentions(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/(^|[^\w`])@([A-Za-z0-9][\w-]*)/g, '$1@\u200b$2'),
    )
    .join('');
}

export function managedBlock(content: string, meta: PrMeta): string {
  return `${START}\n${content.trim()}\n\n${encodeMeta(meta)}\n${END}`;
}

/** Replace our block in an existing body, or append it after the human's text. */
export function mergeIntoBody(existing: string | undefined, block: string): string {
  const body = existing ?? '';
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  if (s >= 0 && e > s) return body.slice(0, s) + block + body.slice(e + END.length);
  const human = body.trim();
  return human ? `${human}\n\n${block}\n` : `${block}\n`;
}

/** The text inside our block, without the metadata comment. */
export function regionContent(body: string): string | undefined {
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  if (s < 0 || e <= s) return undefined;
  return body
    .slice(s + START.length, e)
    .replace(META_RE, '')
    .trim();
}

/** A short, stable hash of region text, ignoring line-ending and edge whitespace. */
/** Hash of a title, ignoring spacing. */
export function titleHash(title: string): string {
  return createHash('sha256')
    .update(title.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);
}

export function contentHash(text: string): string {
  // Image sources are filled in at publish (the comic's hosted URL), after the
  // hash is taken, so they don't count as edits.
  const norm = text
    .replace(/\r\n/g, '\n')
    .replace(/src="[^"]*"/g, 'src=""')
    .trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * Whether someone edited our block on GitHub since Tracetoon last posted it.
 * Undefined when there's no block or the metadata predates the hash.
 */
export function regionEdited(body: string): boolean | undefined {
  const meta = decodeMeta(body);
  const text = regionContent(body);
  if (!meta?.contentSha || text === undefined) return undefined;
  return contentHash(text) !== meta.contentSha;
}

/** The human-written part of a body (outside our block). */
export function humanPart(body: string): string {
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  if (s >= 0 && e > s) return (body.slice(0, s) + body.slice(e + END.length)).trim();
  return body.trim();
}
