/** Added and removed lines from the diff formats agents write. */

export interface LineChange {
  added: string[];
  removed: string[];
}

/** One file's unified diff (`@@` hunks; `+++`/`---` headers ignored). */
export function linesFromUnifiedDiff(diff: string): LineChange {
  const added: string[] = [];
  const removed: string[] = [];
  let inHunk = !/^(---|\+\+\+|@@|diff )/m.test(diff); // a bare +/- body has no headers
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) {
      if (/^(\+\+\+|---) (a\/|b\/|\/dev\/null)/.test(line)) continue;
    }
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

export interface PatchFile extends LineChange {
  path: string;
  op: 'Add' | 'Update' | 'Delete';
  moveTo?: string;
}

/** A Codex `apply_patch` envelope (`*** Begin Patch` … `*** End Patch`). */
export function parseApplyPatch(envelope: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | undefined;
  for (const raw of envelope.split(/\r?\n/)) {
    const h = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(raw);
    if (h) {
      cur = { path: h[2]!.trim(), op: h[1] as PatchFile['op'], added: [], removed: [] };
      files.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(raw);
    if (mv && cur) {
      cur.moveTo = mv[1]!.trim();
      continue;
    }
    if (raw.startsWith('*** ')) {
      cur = undefined;
      continue;
    }
    if (!cur || raw.startsWith('@@')) continue;
    if (raw.startsWith('+')) cur.added.push(raw.slice(1));
    else if (raw.startsWith('-')) cur.removed.push(raw.slice(1));
  }
  return files;
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
