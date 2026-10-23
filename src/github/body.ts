/**
 * The part of a PR body Tracetoon owns. Everything between the start and end
 * markers is ours to replace; anything a human wrote outside them is kept.
 */

export const START = '<!-- tracetoon:start -->';
export const END = '<!-- tracetoon:end -->';
const META_RE = /<!-- tracetoon:meta (\{[\s\S]*?\}) -->/;

export interface PrMeta {
  v: 1;
  tool: string;
  /** Salted hashes of the session ids that went into this description. */
  sessions: string[];
  /** Short hash of the digest the description was written from. */
  digest: string;
  generatedAt: string;
  /** Filled in by later milestones (comic series, sagas). */
  series?: string;
  episode?: number;
  saga?: string;
  theme?: string;
  synopsis?: string;
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

/** The human-written part of a body (outside our block). */
export function humanPart(body: string): string {
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  if (s >= 0 && e > s) return (body.slice(0, s) + body.slice(e + END.length)).trim();
  return body.trim();
}
