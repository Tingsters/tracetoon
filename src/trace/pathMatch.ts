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

/** Whether `p` is one of the roots or inside one. */
export function underAnyRoot(p: string | undefined, roots: string[]): boolean {
  if (!p) return false;
  return roots.some((r) => isPathUnder(p, r));
}

/** The root containing `p`, if any (longest match wins, for nested worktrees). */
export function rootOf(p: string, roots: string[]): string | undefined {
  return roots.filter((r) => isPathUnder(p, r)).sort((a, b) => b.length - a.length)[0];
}
