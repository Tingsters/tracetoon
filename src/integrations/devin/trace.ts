/**
 * Devin CLI sessions, in SQLite: sessions.db in Devin's data folder
 * (%APPDATA%\devin\cli on Windows, ~/Library/Application Support/devin/cli on
 * macOS, $XDG_DATA_HOME/devin/cli on Linux; DEVIN_DATA_DIR overrides it).
 *
 * `sessions` holds `working_directory`, `title`, `last_activity_at` (seconds)
 * and `main_chain_id`; `message_nodes` holds a tree of chat messages per
 * session, and the conversation is the path from `main_chain_id` back to the
 * root. Messages are OpenAI-style: `user` prompts (`metadata.is_user_input`),
 * `assistant` text with `tool_calls` (`write`: `file_path`, `content`; `edit`:
 * `old_string`, `new_string`; `exec`: `command`, `workdir`), and `tool` results
 * ending in "Exit code: N".
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { splitLines } from '../../trace/diffLines.ts';
import type {
  SessionRef,
  TraceAdapter,
  TraceRecord,
  TraceSession,
} from '../../trace/types.ts';
import { sawToolCall, sawUnknownTool } from '../../trace/toolCalls.ts';
import { openReadOnly } from '../../util/sqlite.ts';

type Obj = Record<string, any>;
type CommandRecord = Extract<TraceRecord, { kind: 'command' }>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export function devinDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEVIN_DATA_DIR) return env.DEVIN_DATA_DIR;
  if (process.platform === 'win32')
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'devin', 'cli');
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'devin', 'cli');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'devin', 'cli');
}

const dbPath = () => join(devinDataDir(), 'sessions.db');

/** Tools that don't change the repository. */
const QUIET = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'web_search',
  'web_fetch',
  'run_subagent',
]);

/** Turn one session's main chain of messages into records. Exported for tests. */
export function parseDevinChain(
  messages: unknown[],
  into: TraceSession,
  cwd?: string,
): void {
  const pending = new Map<string, CommandRecord>();
  for (const m of messages) {
    if (!isObj(m)) {
      into.warnings.push('Skipped a message that is not an object.');
      continue;
    }
    const ts = str(m.metadata?.created_at);
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (m.metadata?.is_user_input === false) continue;
      if (content && !isSyntheticPrompt(content))
        into.records.push({ kind: 'prompt', text: content, ts, cwd });
      continue;
    }
    if (m.role === 'tool') {
      const record = str(m.tool_call_id) ? pending.get(m.tool_call_id) : undefined;
      if (!record) continue;
      pending.delete(m.tool_call_id);
      delete record.pending;
      const exit = /Exit code:\s*(-?\d+)\s*$/.exec(content);
      if (exit && exit[1] !== '0') record.isError = true;
      if (content) record.output = content.slice(0, 4000);
      continue;
    }
    if (m.role !== 'assistant') {
      const t = `role:${str(m.role) ?? '?'}`;
      into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      continue;
    }
    if (content) into.records.push({ kind: 'assistant', text: content, ts, cwd });
    for (const call of Array.isArray(m.tool_calls) ? m.tool_calls.filter(isObj) : []) {
      const args = isObj(call.arguments) ? call.arguments : {};
      const name = str(call.name) ?? '';

      sawToolCall(into);
      const file = str(args.file_path) ?? str(args.path);
      const at = (f: string) => resolve(cwd ?? '.', f);
      if (name === 'exec' && str(args.command)) {
        const record: CommandRecord = {
          kind: 'command',
          cmd: args.command,
          ts,
          cwd: str(args.workdir) ?? cwd,
          pending: true,
        };
        into.records.push(record);
        if (str(call.id)) pending.set(call.id, record);
      } else if (name === 'write' && file) {
        into.records.push({
          kind: 'edit',
          file: at(file),
          added: splitLines(str(args.content) ?? ''),
          removed: [],
          ts,
          cwd,
        });
      } else if (name === 'edit' && file) {
        into.records.push({
          kind: 'edit',
          file: at(file),
          added: splitLines(str(args.new_string) ?? ''),
          removed: splitLines(str(args.old_string) ?? ''),
          ts,
          cwd,
        });
      } else if (!QUIET.has(name)) {
        sawUnknownTool(into, name);
      }
    }
  }
}

const within = (dir: string, root: string) => {
  const a = resolve(dir).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

interface Row {
  id: string;
  working_directory: string;
  last_activity_at: number;
}

export const devinAdapter: TraceAdapter = {
  id: 'devin',
  label: 'Devin',
  home: () => (existsSync(dbPath()) ? devinDataDir() : undefined),
  count() {
    if (!existsSync(dbPath())) return 0;
    try {
      const db = openReadOnly(dbPath());
      if (!db) return 0;
      try {
        return Number(
          db.all<{ n: number }>('select count(*) as n from sessions')[0]?.n ?? 0,
        );
      } finally {
        db.close();
      }
    } catch {
      return 0;
    }
  },
  discover(query) {
    if (!existsSync(dbPath())) return [];
    let rows: Row[] = [];
    try {
      const db = openReadOnly(dbPath());
      if (!db) return [];
      try {
        rows = db.all<Row>(
          'select id, working_directory, last_activity_at from sessions where last_activity_at >= ?',
          Math.floor(query.sinceMs / 1000),
        );
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
    return rows
      .filter(
        (r) => query.all || query.roots.some((root) => within(r.working_directory, root)),
      )
      .map((r) => ({
        agent: 'devin',
        sessionId: r.id,
        path: `${dbPath()}#${r.id}`,
        mtimeMs: r.last_activity_at * 1000,
        cwd: r.working_directory,
      }));
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'devin',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    try {
      const db = openReadOnly(ref.path.replace(/#[^#]*$/, ''));
      if (!db) {
        session.warnings.push(
          'This runtime cannot read SQLite, so the Devin session was skipped.',
        );
        return session;
      }
      try {
        const head = db.all<{ title: string | null; main_chain_id: number | null }>(
          'select title, main_chain_id from sessions where id = ?',
          ref.sessionId,
        )[0];
        if (head?.title) session.title = head.title;
        const nodes = new Map(
          db
            .all<{
              node_id: number;
              parent_node_id: number | null;
              chat_message: string;
            }>(
              'select node_id, parent_node_id, chat_message from message_nodes where session_id = ?',
              ref.sessionId,
            )
            .map((n) => [n.node_id, n]),
        );
        const chain: unknown[] = [];
        const seen = new Set<number>();
        for (let id = head?.main_chain_id ?? null; id !== null && !seen.has(id);) {
          seen.add(id);
          const node = nodes.get(id);
          if (!node) break;
          try {
            chain.unshift(JSON.parse(node.chat_message));
          } catch {
            session.warnings.push('Skipped a message that is not JSON.');
          }
          id = node.parent_node_id;
        }
        parseDevinChain(chain, session, ref.cwd);
      } finally {
        db.close();
      }
    } catch (e) {
      session.warnings.push(`Could not read the Devin session: ${(e as Error).message}`);
    }
    return session;
  },
};
