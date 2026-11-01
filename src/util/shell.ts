/**
 * Splits a shell command line into the commands it runs (`a && b; c | d`),
 * leaving quoted strings and heredoc bodies alone. Agents often run scripts
 * inline (`python -c "..."`, `cat <<'EOF' ... EOF`), and a line inside one is
 * text, not a command: `print('bun test')` must not count as a test run.
 */
export interface ShellSegment {
  command: string;
  before?: '&&' | '||' | ';' | '|' | '\n';
}

export function shellSegments(cmd: string): ShellSegment[] {
  const parts: ShellSegment[] = [];
  let before: ShellSegment['before'];
  let cur = '';
  let quote: '"' | "'" | '`' | undefined;
  // A heredoc's body starts at the end of its line; skip from there to here.
  let bodyAt = -1;
  let bodyEnd = -1;
  const push = (next: ShellSegment['before']) => {
    if (cur.trim()) parts.push({ command: cur.trim(), before });
    cur = '';
    before = next;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (quote === '"' && ch === '`' && /["'$`]/.test(cmd[i + 1] ?? '')) {
        cur += ch + cmd[++i];
        continue;
      }
      if (ch === '\\' && quote !== "'" && i + 1 < cmd.length) {
        cur += ch + cmd[++i];
        continue;
      }
      if (ch === quote) quote = undefined;
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += ch + cmd[++i];
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    const here =
      bodyAt < 0 ? /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(cmd.slice(i)) : null;
    if (here) {
      cur += here[0];
      i += here[0].length - 1;
      const start = cmd.indexOf('\n', i + 1);
      if (start >= 0) {
        const end = new RegExp(`\\n[\\t ]*${here[2]}[\\t ]*(?=\\n|$)`).exec(
          cmd.slice(start),
        );
        bodyAt = start;
        bodyEnd = end ? start + end.index + end[0].length : cmd.length;
      }
      continue;
    }
    if (ch === '\n' && i === bodyAt) {
      push('\n');
      i = bodyEnd - 1;
      bodyAt = -1;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(two as '&&' | '||');
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      push(ch as ';' | '|' | '\n');
      continue;
    }
    cur += ch;
  }
  push(undefined);
  return parts;
}

export function splitCommands(cmd: string): string[] {
  return shellSegments(cmd).map((part) => part.command);
}
