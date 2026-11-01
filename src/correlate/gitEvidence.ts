/** Literal Git operations and their directories. This never evaluates shell text. */
import { basename } from 'node:path';
import { pathKey } from '@showtail/agent-traces/paths/pathUtil';
import { leadingCd } from '../trace/pathMatch.ts';
import { shellSegments, type ShellSegment } from '../util/shell.ts';

export interface GitOperation {
  verb: string;
  args: string[];
  cwd?: string;
  command: string;
  index: number;
  before?: ShellSegment['before'];
}

/** Quoted literal arguments, including Bash and PowerShell quote escapes. */
function literalWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if ((quote !== "'" && ch === '$') || (!quote && (ch === '(' || ch === ')'))) return;
    if (quote !== "'" && ch === '`') {
      if (!next || !/["'$`]/.test(next)) return;
      word += next;
      started = true;
      i++;
    } else if (quote !== "'" && ch === '\\' && next && /["'\\\s$`]/.test(next)) {
      word += next;
      started = true;
      i++;
    } else if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return;
  if (started) words.push(word);
  return words;
}

function directory(path: string, cwd?: string): string | undefined {
  // Reuse tilde, MSYS-drive and native path normalization without shell expansion.
  if (path.includes('"')) return;
  return leadingCd(`cd "${path}"`, cwd);
}

export function gitOperations(command: string, cwd?: string): GitOperation[] {
  const segments = shellSegments(command);
  // Alternative branches, substitutions and subshells do not have one provable cwd.
  if (segments.some((s) => s.before === '||')) return [];
  const operations: GitOperation[] = [];
  const stack: (string | undefined)[] = [];
  let folder = cwd;
  for (const [index, segment] of segments.entries()) {
    const words = literalWords(segment.command);
    if (!words) {
      // An opaque command might change directories; don't carry an inferred cwd on.
      return [];
    }
    if (words[0] === '&') words.shift();
    while (
      /^[A-Za-z_][\w]*=/.test(words[0] ?? '') ||
      /^(sudo|command|exec|time)$/.test(words[0] ?? '')
    )
      words.shift();
    const program = basename((words.shift() ?? '').replace(/\\/g, '/'))
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (['cd', 'pushd', 'set-location', 'sl'].includes(program)) {
      if (segment.before === '|' || segments[index + 1]?.before === '|') return [];
      if (/^(--|-Path|-LiteralPath)$/i.test(words[0] ?? '')) words.shift();
      if (program === 'pushd') stack.push(folder);
      folder = words.length === 1 ? directory(words[0]!, folder) : undefined;
      continue;
    }
    if (program === 'popd') {
      folder = stack.pop();
      continue;
    }
    if (program !== 'git') continue;
    let at = folder;
    while (words[0]?.startsWith('-')) {
      const flag = words.shift()!;
      if (flag === '-C') {
        const target = words.shift();
        at = target === undefined ? undefined : directory(target, at);
      } else if (flag === '-c' || flag === '--config-env') {
        words.shift();
      } else if (
        !/^--(?:no-pager|paginate|literal-pathspecs|no-optional-locks)$/.test(flag)
      ) {
        return []; // Alternate git/worktree directories require more evidence.
      }
    }
    const verb = words.shift();
    if (!verb) continue;
    operations.push({
      verb,
      args: words,
      cwd: at,
      command: `git ${verb} ${words.join(' ')}`,
      index,
      before: segment.before,
    });
  }
  return operations;
}

export function commitMessage(operation: GitOperation): string | undefined {
  if (operation.verb !== 'commit') return;
  const args = operation.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (arg === '-F' || arg.startsWith('--file') || arg === '-C' || arg === '-c') return;
    if (arg === '--message') return args[i + 1]?.split(/\r?\n/)[0];
    if (arg.startsWith('--message='))
      return arg.slice('--message='.length).split(/\r?\n/)[0];
    const short = /^-[aqsv]*m(.*)$/.exec(arg);
    if (short) return (short[1] || args[i + 1])?.split(/\r?\n/)[0];
  }
}

/** Aggregated output can be assigned only when every Git operation uses one cwd. */
export function oneGitDirectory(operations: GitOperation[]): boolean {
  return (
    operations.length > 0 &&
    new Set(operations.map((op) => (op.cwd ? pathKey(op.cwd) : ''))).size === 1
  );
}

/** A bounded read of HEAD after one commit, connected only by successful && steps. */
export function confirmsHead(
  command: string,
  operations: GitOperation[],
  producer: GitOperation,
): boolean {
  return operations.some((op) => {
    if (op.index <= producer.index) return false;
    const head =
      op.verb === 'rev-parse'
        ? op.args.join(' ') === 'HEAD'
        : op.verb === 'log' &&
          op.args.includes('--oneline') &&
          (op.args.includes('-1') || op.args.includes('--max-count=1')) &&
          op.args.every((arg) =>
            ['--oneline', '-1', '--max-count=1', 'HEAD'].includes(arg),
          );
    return head && followsSuccess(command, producer, op);
  });
}

export function followsSuccess(
  command: string,
  producer: GitOperation,
  consumer: GitOperation,
): boolean {
  return (
    consumer.index > producer.index &&
    shellSegments(command)
      .slice(producer.index + 1, consumer.index + 1)
      .every((s) => s.before === '&&')
  );
}
