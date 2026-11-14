/**
 * Crush (Charm) sessions: one SQLite crush.db per project, in the project's
 * `.crush` folder. The projects Crush has opened are listed in projects.json in
 * its data folder (%LOCALAPPDATA%\crush on Windows, $XDG_DATA_HOME/crush or
 * ~/.local/share/crush elsewhere; CRUSH_DATA_DIR overrides it), each with its
 * `path` and `data_dir`.
 *
 * `sessions` holds `title` and `updated_at` (seconds); `messages` holds `role`,
 * `created_at` (seconds) and `parts`, a JSON array of `{ type, data }`: `text`,
 * `reasoning`, `tool_call` (`id`, `name`, `input` as a JSON string),
 * `tool_result` (`tool_call_id`, `content`, `is_error`) and `finish`. Tools:
 * `bash` (`command`, `working_dir`), `write` (`file_path`, `content`), `edit`
 * (`old_string`, `new_string`) and `multiedit` (`edits`). Bash results end
 * with "Exit code N" on failure and a `<cwd>` note.
 */
import { existsSync, readFileSync } from 'node:fs';
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
import { openReadOnly } from '../../util/sqlite.ts';

type Obj = Record<string, any>;
type CommandRecord = Extract<TraceRecord, { kind: 'command' }>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export function crushDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.CRUSH_DATA_DIR) return env.CRUSH_DATA_DIR;
  if (process.platform === 'win32')
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'crush');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'crush');
}

/** Tools that don't change the repository. */
const QUIET = new Set([
  'view',
  'ls',
  'glob',
  'grep',
  'fetch',
  'sourcegraph',
  'diagnostics',
  'todos',
]);

export interface CrushMessage {
  role: string;
  created_at: number;
  parts: string;
}

/** A bash result without Crush's `<cwd>` note. */
const withoutCwd = (text: string) =>
  text.replace(/\n*<cwd>[\s\S]*?<\/cwd>\s*$/, '').trim();

/** Turn one session's messages into records. Exported for tests. */
export function parseCrushMessages(
  rows: CrushMessage[],
  into: TraceSession,
  cwd?: string,
): void {
  const pending = new Map<string, CommandRecord>();
  for (const row of rows) {
    let parts: unknown;
    try {
      parts = JSON.parse(row.parts);
    } catch {
      into.warnings.push('Skipped a message that is not JSON.');
      continue;
    }
    const ts =
      typeof row.created_at === 'number'
        ? new Date(row.created_at * 1000).toISOString()
        : undefined;
    for (const p of Array.isArray(parts) ? parts.filter(isObj) : []) {
      const d = isObj(p.data) ? p.data : {};
      if (p.type === 'text') {
        const text = str(d.text)?.trim();
        if (!text) continue;
        if (row.role === 'user') {
          if (!isSyntheticPrompt(text))
            into.records.push({ kind: 'prompt', text, ts, cwd });
        } else if (row.role === 'assistant')
          into.records.push({ kind: 'assistant', text, ts, cwd });
      } else if (p.type === 'tool_call') {
        let input: Obj = {};
        try {
          const parsed = typeof d.input === 'string' ? JSON.parse(d.input) : d.input;
          if (isObj(parsed)) input = parsed;
        } catch {
          /* a partial call */
        }
        const name = str(d.name) ?? '';
        const file = str(input.file_path);
        const at = (f: string) => resolve(cwd ?? '.', f);
        if (name === 'bash' && str(input.command)) {
          const record: CommandRecord = {
            kind: 'command',
            cmd: input.command,
            ts,
            cwd: str(input.working_dir) ?? cwd,
            pending: true,
          };
          into.records.push(record);
          if (str(d.id)) pending.set(d.id, record);
        } else if (name === 'write' && file) {
          into.records.push({
            kind: 'edit',
            file: at(file),
            added: splitLines(str(input.content) ?? ''),
            removed: [],
            ts,
            cwd,
          });
        } else if (name === 'edit' && file) {
          into.records.push({
            kind: 'edit',
            file: at(file),
            added: splitLines(str(input.new_string) ?? ''),
            removed: splitLines(str(input.old_string) ?? ''),
            ts,
            cwd,
          });
        } else if (name === 'multiedit' && file && Array.isArray(input.edits)) {
          for (const e of input.edits.filter(isObj))
            into.records.push({
              kind: 'edit',
              file: at(file),
              added: splitLines(str(e.new_string) ?? ''),
              removed: splitLines(str(e.old_string) ?? ''),
              ts,
              cwd,
            });
        } else if (!QUIET.has(name)) {
          const t = `tool:${name || '?'}`;
          into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
        }
      } else if (p.type === 'tool_result') {
        const record = str(d.tool_call_id) ? pending.get(d.tool_call_id) : undefined;
        if (!record) continue;
        pending.delete(d.tool_call_id);
        delete record.pending;
        const content = withoutCwd(str(d.content) ?? '');
        const exit = /Exit code (-?\d+)\s*$/.exec(content);
        if (d.is_error === true || (exit && exit[1] !== '0')) record.isError = true;
        if (content && content !== 'no output') record.output = content.slice(0, 4000);
      } else if (p.type !== 'reasoning' && p.type !== 'finish') {
        const t = str(p.type) ?? '?';
        into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      }
    }
  }
}

interface Project {
  path: string;
  db: string;
}

function projects(): Project[] {
  try {
    const data = JSON.parse(readFileSync(join(crushDataDir(), 'projects.json'), 'utf8'));
    return (Array.isArray(data?.projects) ? data.projects : [])
      .filter((p: Obj) => isObj(p) && str(p.path))
      .map((p: Obj) => ({
        path: p.path,
        db: join(str(p.data_dir) ?? join(p.path, '.crush'), 'crush.db'),
      }))
      .filter((p: Project) => existsSync(p.db));
  } catch {
    return [];
  }
}

const within = (dir: string, root: string) => {
  const a = resolve(dir).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

function query<T>(db: string, sql: string, ...params: unknown[]): T[] {
  try {
    const handle = openReadOnly(db);
    if (!handle) return [];
    try {
      return handle.all<T>(sql, ...params);
    } finally {
      handle.close();
    }
  } catch {
    return [];
  }
}

export const crushAdapter: TraceAdapter = {
  id: 'crush',
  label: 'Crush',
  home: () =>
    existsSync(join(crushDataDir(), 'projects.json')) ? crushDataDir() : undefined,
  count: () =>
    projects().reduce(
      (n, p) =>
        n +
        Number(
          query<{ n: number }>(p.db, 'select count(*) as n from sessions')[0]?.n ?? 0,
        ),
      0,
    ),
  discover(q) {
    const out: SessionRef[] = [];
    for (const p of projects()) {
      if (!q.all && !q.roots.some((root) => within(p.path, root))) continue;
      const rows = query<{ id: string; updated_at: number }>(
        p.db,
        'select id, updated_at from sessions where parent_session_id is null and updated_at >= ?',
        Math.floor(q.sinceMs / 1000),
      );
      for (const r of rows)
        out.push({
          agent: 'crush',
          sessionId: r.id,
          path: `${p.db}#${r.id}`,
          mtimeMs: r.updated_at * 1000,
          cwd: p.path,
        });
    }
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'crush',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    const db = ref.path.replace(/#[^#]*$/, '');
    const title = query<{ title: string }>(
      db,
      'select title from sessions where id = ?',
      ref.sessionId,
    )[0]?.title;
    if (title) session.title = title;
    parseCrushMessages(
      query<CrushMessage>(
        db,
        'select role, created_at, parts from messages where session_id = ? order by created_at, rowid',
        ref.sessionId,
      ),
      session,
      ref.cwd,
    );
    return session;
  },
};
