import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { isPathUnder } from '@showtail/agent-traces/paths/pathUtil';

const win = process.platform === 'win32';

/** The spellings a path can take inside a log file: native, forward-slash, JSON-escaped. */
function spellings(root: string): string[] {
  const fwd = root.replace(/\\/g, '/');
  const back = root.replace(/\//g, '\\');
  // native, forward slashes, JSON-escaped once, and twice (Antigravity IDE args)
  const forms = new Set([
    root,
    fwd,
    back,
    back.replace(/\\/g, '\\\\'),
    back.replace(/\\/g, '\\\\\\\\'),
  ]);
  // Git Bash / MSYS spelling of a Windows drive path: C:\x -> /c/x
  const drive = /^([A-Za-z]):\//.exec(fwd);
  if (drive) forms.add(`/${drive[1]!.toLowerCase()}${fwd.slice(2)}`);
  return [...forms].map((f) => (win ? f.toLowerCase() : f));
}

/** Whether raw log text mentions any of the roots in any common spelling. */
export function mentionsAnyRoot(text: string, roots: string[]): boolean {
  const hay = win ? text.toLowerCase() : text;
  return roots.some((r) => spellings(r).some((s) => includesPath(hay, s)));
}

/** `needle` occurs in `hay` as a whole path: not followed by more name characters. */
function includesPath(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const next = hay[i + needle.length];
    if (next === undefined || !/[A-Za-z0-9_.-]/.test(next)) return true;
  }
  return false;
}

/**
 * The directory a command really runs in when it starts by changing directory
 * (`cd x && ...`, `pushd x`, `Set-Location x`). Agents log a command with the
 * directory the shell was in *before* it ran, so without this a
 * `cd ../other-repo && bun test` is filed under the wrong repository.
 */
export function leadingCd(cmd: string, cwd: string | undefined): string | undefined {
  const m =
    /^\s*(?:cd|pushd|Set-Location|sl)\s+(?:-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(
      cmd,
    );
  if (!m) return undefined;
  let dir = m[1]!.replace(/^["']|["']$/g, '');
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\'))
    dir = homedir() + dir.slice(1);
  // Git Bash spelling of a Windows drive path: /c/x -> C:/x
  const msys = win ? /^\/([A-Za-z])(\/|$)/.exec(dir) : null;
  if (msys) dir = `${msys[1]!.toUpperCase()}:/${dir.slice(3)}`;
  if (isAbsolute(dir)) return resolve(dir);
  return cwd ? resolve(cwd, dir) : undefined;
}

/** Whether `p` is one of the roots or inside one. */
export function underAnyRoot(p: string | undefined, roots: string[]): boolean {
  if (!p) return false;
  return roots.some((r) => isPathUnder(p, r));
}

/** The root containing `p`, if any (longest match wins, for nested worktrees). */
export function rootOf(p: string, roots: string[]): string | undefined {
  return roots.filter((r) => isPathUnder(p, r)).sort((a, b) => b.length - a.length)[0];
}
