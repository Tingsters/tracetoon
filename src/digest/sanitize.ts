/**
 * Everything that leaves the digest goes through here: secret and personal-data
 * redaction from @showtail/agent-traces, then path scrubbing so the home folder,
 * username and other repos never appear.
 */
import { homedir } from 'node:os';
import { sanitizeForShare } from '@showtail/agent-traces/privacy/sanitize';

export interface Scrubber {
  text(s: string): string;
  readonly redactions: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All spellings of a path we might see in logs, longest first. */
function variants(p: string): string[] {
  const fwd = p.replace(/\\/g, '/');
  const back = p.replace(/\//g, '\\');
  const set = new Set([p, fwd, back, back.replace(/\\/g, '\\\\')]);
  const drive = /^([A-Za-z]):\//.exec(fwd);
  if (drive) set.add(`/${drive[1]!.toLowerCase()}${fwd.slice(2)}`);
  return [...set].sort((a, b) => b.length - a.length);
}

export function makeScrubber(roots: string[], home = homedir()): Scrubber {
  let redactions = 0;
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  const rootRes = roots
    .slice()
    .sort((a, b) => b.length - a.length)
    .flatMap(variants)
    .map((v) => new RegExp(`${escapeRe(v)}(?=[\\\\/]|\\b|$)[\\\\/]?`, flags));
  const homeRes = variants(home).map((v) => new RegExp(escapeRe(v), flags));
  const user = home.split(/[\\/]/).filter(Boolean).pop();
  const userRe =
    user && user.length >= 3 ? new RegExp(`\\b${escapeRe(user)}\\b`, flags) : undefined;
  // Absolute paths left after the repo and home are replaced belong to something else.
  const winAbs = /\b[A-Za-z]:[\\/][^\s'"`<>|)]*/g;
  const posixAbs = /(?<![\w.~])\/(?:Users|home|private|var|tmp|mnt|c|d)\/[^\s'"`<>|)]*/g;
  return {
    get redactions() {
      return redactions;
    },
    text(s: string): string {
      const r = sanitizeForShare(s);
      redactions += r.hits;
      let out = r.text;
      for (const re of rootRes) out = out.replace(re, '');
      for (const re of homeRes) out = out.replace(re, '~');
      out = out.replace(winAbs, '<outside-repo>').replace(posixAbs, '<outside-repo>');
      if (userRe) out = out.replace(userRe, '<user>');
      return out;
    },
  };
}

export function clip(s: string, max: number): string {
  const flat = s.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
