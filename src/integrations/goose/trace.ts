/**
 * Goose sessions, in SQLite: sessions/sessions.db in Goose's data folder
 * (%APPDATA%\Block\goose\data on Windows, ~/.local/share/goose elsewhere;
 * GOOSE_DATA_DIR overrides it; `goose info` prints the path).
 *
 * `sessions` holds `working_dir`, `name` and `updated_at`; `messages` holds one
 * row per message with `role`, `created_timestamp` (seconds) and `content_json`,
 * an array of blocks: `text`, `toolRequest` (`toolCall.value.name` and
 * `arguments`) and `toolResponse` (`toolResult.value` with `isError` and,
 * for shell, `structuredContent.exit_code`). Goose's own context notes arrive as
 * user text starting `<turn-context>`. Tools: `shell` (`command`), `write`
 * (`path`, `content`) and `edit` (`path`, `before`, `after`).
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
import { openReadOnly } from '../../util/sqlite.ts';

type Obj = Record<string, any>;
type CommandRecord = Extract<TraceRecord, { kind: 'command' }>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export function gooseDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.GOOSE_DATA_DIR) return env.GOOSE_DATA_DIR;
  if (process.platform === 'win32')
    return join(
      env.APPDATA || join(home, 'AppData', 'Roaming'),
      'Block',
      'goose',
      'data',
    );
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'goose');
}

const dbPath = () => join(gooseDataDir(), 'sessions', 'sessions.db');

/** Tools that don't change the repository. */
const QUIET = new Set([
  'load_skill',
  'read',
  'tree',
  'search',
  'todo_write',
  'todo_read',
]);

export interface GooseMessage {
  role: string;
  created_timestamp: number;
  content_json: string;
}

/** Turn one session's messages into records. Exported for tests. */
export function parseGooseMessages(
  rows: GooseMessage[],
  into: TraceSession,
  cwd?: string,
): void {
  const pending = new Map<string, CommandRecord>();
  for (const row of rows) {
    let blocks: unknown;
    try {
      blocks = JSON.parse(row.content_json);
    } catch {
      into.warnings.push('Skipped a message that is not JSON.');
      continue;
    }
    const ts =
      typeof row.created_timestamp === 'number'
        ? new Date(row.created_timestamp * 1000).toISOString()
        : undefined;
    for (const b of Array.isArray(blocks) ? blocks.filter(isObj) : []) {
      if (b.type === 'text') {
        const text = str(b.text)?.trim();
        if (!text) continue;
        if (row.role === 'user') {
          if (!text.startsWith('<turn-context>') && !isSyntheticPrompt(text))
            into.records.push({ kind: 'prompt', text, ts, cwd });
        } else if (row.role === 'assistant')
          into.records.push({ kind: 'assistant', text, ts, cwd });
      } else if (b.type === 'toolRequest') {
        const call = b.toolCall?.value;
        if (!isObj(call)) continue;
        const name = str(call.name) ?? '';
        const args = isObj(call.arguments) ? call.arguments : {};
        const file = str(args.path);
        const at = (f: string) => resolve(cwd ?? '.', f);
        if (name === 'shell' && str(args.command)) {
          const record: CommandRecord = {
            kind: 'command',
            cmd: args.command,
            ts,
            cwd,
            pending: true,
          };
          into.records.push(record);
          if (str(b.id)) pending.set(b.id, record);
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
            added: splitLines(str(args.after) ?? ''),
            removed: splitLines(str(args.before) ?? ''),
            ts,
            cwd,
          });
        } else if (!QUIET.has(name)) {
          const t = `tool:${name || '?'}`;
          into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
        }
      } else if (b.type === 'toolResponse') {
        const record = str(b.id) ? pending.get(b.id) : undefined;
        if (!record) continue;
        pending.delete(b.id);
        delete record.pending;
        const result = b.toolResult?.value;
        const exit = result?.structuredContent?.exit_code;
        if (
          b.toolResult?.status === 'error' ||
          result?.isError === true ||
          (typeof exit === 'number' && exit !== 0)
        )
          record.isError = true;
        const text = Array.isArray(result?.content)
          ? result.content
              .map((c: Obj) => (typeof c?.text === 'string' ? c.text : ''))
              .join('\n')
          : '';
        if (text.trim()) record.output = text.slice(0, 4000);
      } else if (b.type !== 'thinking' && b.type !== 'redactedThinking') {
        const t = str(b.type) ?? '?';
        into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      }
    }
  }
}

const within = (dir: string, root: string) => {
  const a = resolve(dir).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** Goose stores times as "YYYY-MM-DD HH:MM:SS" in UTC. */
const utc = (t: string) => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);

export const gooseAdapter: TraceAdapter = {
  id: 'goose',
  label: 'Goose',
  home: () => (existsSync(dbPath()) ? gooseDataDir() : undefined),
  count() {
    try {
      const db = existsSync(dbPath()) ? openReadOnly(dbPath()) : undefined;
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
    let rows: { id: string; working_dir: string; updated_at: string }[] = [];
    try {
      const db = existsSync(dbPath()) ? openReadOnly(dbPath()) : undefined;
      if (!db) return [];
      try {
        rows = db.all('select id, working_dir, updated_at from sessions');
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
    const out: SessionRef[] = [];
    for (const r of rows) {
      const mtimeMs = utc(r.updated_at);
      if (Number.isFinite(mtimeMs) && mtimeMs < query.sinceMs) continue;
      if (!query.all && !query.roots.some((root) => within(r.working_dir, root)))
        continue;
      out.push({
        agent: 'goose',
        sessionId: r.id,
        path: `${dbPath()}#${r.id}`,
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
        cwd: r.working_dir,
      });
    }
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'goose',
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
          'This runtime cannot read SQLite, so the Goose session was skipped.',
        );
        return session;
      }
      try {
        const name = db.all<{ name: string }>(
          'select name from sessions where id = ?',
          ref.sessionId,
        )[0]?.name;
        if (name) session.title = name;
        parseGooseMessages(
          db.all<GooseMessage>(
            'select role, created_timestamp, content_json from messages where session_id = ? order by id',
            ref.sessionId,
          ),
          session,
          ref.cwd,
        );
      } finally {
        db.close();
      }
    } catch (e) {
      session.warnings.push(`Could not read the Goose session: ${(e as Error).message}`);
    }
    return session;
  },
};
