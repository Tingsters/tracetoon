/**
 * Qwen Code sessions: ~/.qwen/projects/<encoded project>/chats/<session>.jsonl
 * (QWEN_DATA_DIR replaces ~/.qwen for Tracetoon). Every line carries
 * `timestamp`, `cwd`, `gitBranch` and a `type`: `user` (real prompts have
 * `provenance: "real_user"`), `assistant`, `tool_result` or `system`.
 * Messages hold Gemini-style `parts`: `text` (`thought: true` for reasoning),
 * `functionCall` (`id`, `name`, `args`) and `functionResponse` (`id`,
 * `response.output` or `response.error`), with `toolCallResult.status` on the
 * result line. Tools: `run_shell_command` (`command`, `directory`),
 * `write_file` (`file_path`, `content`) and `edit` (`old_string`, `new_string`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { splitLines } from '../../trace/diffLines.ts';
import { discoveryIndex } from '../../trace/discovery.ts';
import type {
  SessionRef,
  TraceAdapter,
  TraceRecord,
  TraceSession,
} from '../../trace/types.ts';

type Obj = Record<string, any>;
type CommandRecord = Extract<TraceRecord, { kind: 'command' }>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export const qwenHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.QWEN_DATA_DIR || join(homedir(), '.qwen');

/** Tools that don't change the repository. */
const QUIET = new Set([
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'search_file_content',
  'grep_search',
  'web_fetch',
  'web_search',
  'todo_write',
  'save_memory',
  'skill',
]);

/**
 * The command's own output. Qwen wraps it as "Command: …\nDirectory: …\nOutput:
 * …\nError: …\nExit Code: …"; git's `[branch sha]` line must start a line for
 * the commit to be recognized, so the wrapper is taken off.
 */
export function commandOutput(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /^Command: [\s\S]*?\nOutput: ([\s\S]*?)(?:\nError: [\s\S]*)?$/.exec(text);
  return (m ? m[1]! : text).trim() || undefined;
}

/** Parse one chat file into records. Exported for tests. */
export function parseQwenLines(content: string, into: TraceSession): void {
  const pending = new Map<string, CommandRecord>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: Obj;
    try {
      o = JSON.parse(line);
    } catch {
      into.warnings.push('Skipped a line that is not JSON.');
      continue;
    }
    if (!isObj(o)) {
      into.warnings.push('Skipped a line that is not a JSON object.');
      continue;
    }
    const ts = str(o.timestamp);
    const cwd = str(o.cwd);
    const branch = str(o.gitBranch);
    const parts: Obj[] = Array.isArray(o.message?.parts)
      ? o.message.parts.filter(isObj)
      : [];
    if (o.type === 'system') continue;
    if (o.type === 'user') {
      if (o.provenance && o.provenance !== 'real_user') continue;
      const text = parts
        .map((p) => (typeof p.text === 'string' && !p.thought ? p.text : ''))
        .join('\n')
        .trim();
      if (text && !isSyntheticPrompt(text))
        into.records.push({ kind: 'prompt', text, ts, cwd, branch });
      continue;
    }
    if (o.type === 'tool_result') {
      for (const p of parts) {
        const r = p.functionResponse;
        if (!isObj(r)) continue;
        const record = str(r.id) ? pending.get(r.id) : undefined;
        if (!record) continue;
        pending.delete(r.id);
        delete record.pending;
        if (o.toolCallResult?.status === 'error' || r.response?.error !== undefined)
          record.isError = true;
        const out = commandOutput(str(r.response?.output) ?? str(r.response?.error));
        if (out) record.output = out.slice(0, 4000);
      }
      continue;
    }
    if (o.type !== 'assistant') {
      const t = str(o.type) ?? '?';
      into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      continue;
    }
    for (const p of parts) {
      if (typeof p.text === 'string' && !p.thought && p.text.trim())
        into.records.push({ kind: 'assistant', text: p.text.trim(), ts, cwd, branch });
      const call = p.functionCall;
      if (!isObj(call)) continue;
      const name = str(call.name) ?? '';
      const args = isObj(call.args) ? call.args : {};
      const file = str(args.file_path) ?? str(args.path);
      const at = (f: string) => resolve(cwd ?? '.', f);
      if (name === 'run_shell_command' && str(args.command)) {
        const record: CommandRecord = {
          kind: 'command',
          cmd: args.command,
          ts,
          cwd: str(args.directory) ?? cwd,
          branch,
          pending: true,
        };
        into.records.push(record);
        if (str(call.id)) pending.set(call.id, record);
      } else if (name === 'write_file' && file) {
        into.records.push({
          kind: 'edit',
          file: at(file),
          added: splitLines(str(args.content) ?? ''),
          removed: [],
          ts,
          cwd,
          branch,
        });
      } else if ((name === 'edit' || name === 'replace') && file) {
        into.records.push({
          kind: 'edit',
          file: at(file),
          added: splitLines(str(args.new_string) ?? ''),
          removed: splitLines(str(args.old_string) ?? ''),
          ts,
          cwd,
          branch,
        });
      } else if (!QUIET.has(name)) {
        const t = `tool:${name || '?'}`;
        into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      }
    }
  }
}

interface Found {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

function chats(): Found[] {
  const root = join(qwenHome(), 'projects');
  if (!existsSync(root)) return [];
  const out: Found[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project, 'chats');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        out.push({
          path,
          sessionId: basename(name, '.jsonl'),
          mtimeMs: statSync(path).mtimeMs,
        });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/** The working folder a chat names on its first line, if any. */
function cwdOf(path: string): string | undefined {
  try {
    const first = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    return str(JSON.parse(first)?.cwd);
  } catch {
    return undefined;
  }
}

export const qwenAdapter: TraceAdapter = {
  id: 'qwen',
  label: 'Qwen Code',
  home: () => (existsSync(join(qwenHome(), 'projects')) ? qwenHome() : undefined),
  count: () => chats().length,
  discover(query) {
    const index = discoveryIndex(query, 'qwen');
    const out: SessionRef[] = [];
    for (const f of chats()) {
      const info = index.inspect(f.path);
      if (!info) continue;
      if (Math.max(info.recent, f.mtimeMs) >= query.sinceMs && info.match)
        out.push({
          agent: 'qwen',
          sessionId: f.sessionId,
          path: f.path,
          mtimeMs: Math.max(f.mtimeMs, info.recent),
          cwd: cwdOf(f.path),
        });
    }
    index.save();
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'qwen',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    try {
      parseQwenLines(readFileSync(ref.path, 'utf8'), session);
    } catch (e) {
      session.warnings.push(`Could not read Qwen Code chat: ${(e as Error).message}`);
    }
    return session;
  },
};
