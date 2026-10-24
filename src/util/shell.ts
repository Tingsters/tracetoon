/**
 * Splits a shell command line into the commands it runs (`a && b; c | d`),
 * leaving quoted strings and heredoc bodies alone. Agents often run scripts
 * inline (`python -c "..."`, `cat <<'EOF' ... EOF`), and a line inside one is
 * text, not a command: `print('bun test')` must not count as a test run.
 */
export function splitCommands(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | '`' | undefined;
  // A heredoc's body starts at the end of its line; skip from there to here.
  let bodyAt = -1;
  let bodyEnd = -1;
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
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
      push();
      i = bodyEnd - 1;
      bodyAt = -1;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push();
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return parts;
}
