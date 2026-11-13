/**
 * Sessions in an OpenCode-format SQLite store (OpenCode, and Kilo CLI, which is
 * built on it). Hosts that write this store build their adapter from here
 * instead of from each other.
 *
 * Tables: `session` (id, parent_id, directory, title, time_created,
 * time_updated), `message` (session_id, time_created, data: JSON with role,
 * modelID or model.modelID, path.cwd) and `part` (message_id, session_id,
 * time_created, data: JSON). Part types: `text` (prompt or reply), `tool`
 * ({ tool, state: { status, input, output, metadata.exit, time.start } }), and
 * bookkeeping (`step-start`, `step-finish`, `reasoning`, `patch`, ...).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { openReadOnly, type ReadOnlyDb } from '../util/sqlite.ts';
import { headTail, parseApplyPatch, splitLines } from './diffLines.ts';
import { mentionsAnyRoot } from './pathMatch.ts';
import type { SessionRef, TraceAdapter, TraceRecord, TraceSession } from './types.ts';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;
const json = (text: unknown): Obj => {
  try {
    const v = JSON.parse(String(text));
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
};

const BOOKKEEPING = new Set([
  'step-start',
  'step-finish',
  'reasoning',
  'patch',
  'snapshot',
  'file',
  'agent',
  'compaction',
  'subtask',
  'retry',
]);

/** One ref path names the database and the session: `<db>#<session id>`. */
const refPath = (db: string, id: string) => `${db}#${id}`;
const splitRef = (path: string) => {
  const i = path.lastIndexOf('#');
  return { db: path.slice(0, i), id: path.slice(i + 1) };
};

function withDb<T>(path: string, fallback: T, use: (db: ReadOnlyDb) => T): T {
  if (!existsSync(path)) return fallback;
  let db: ReadOnlyDb | undefined;
  try {
    // A file that exists but isn't a readable database reads as empty too.
    db = openReadOnly(path);
    return db ? use(db) : fallback;
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

/** Records from one session's messages and parts. Exported for tests. */
export function opencodeRecords(
  messages: { id: string; time_created: number; data: string }[],
  parts: { message_id: string; time_created: number; data: string }[],
  into: TraceSession,
  directory?: string,
): void {
  const byMessage = new Map<string, Obj>();
  for (const m of messages) byMessage.set(m.id, json(m.data));
  for (const p of parts) {
    const part = json(p.data);
    const msg = byMessage.get(p.message_id) ?? {};
    const role = str(msg.role);
    const cwd = str(msg.path?.cwd) ?? directory;
    const model = str(msg.modelID) ?? str(msg.model?.modelID);
    const at = (ms: unknown) =>
      new Date(typeof ms === 'number' ? ms : p.time_created).toISOString();
    const type = str(part.type) ?? '?';
    if (type === 'text') {
      const text = str(part.text)?.trim();
      if (!text || part.synthetic) continue;
      if (role === 'user') {
        if (!isSyntheticPrompt(text))
          into.records.push({ kind: 'prompt', text, ts: at(part.time?.start), cwd });
      } else
        into.records.push({
          kind: 'assistant',
          text,
          ts: at(part.time?.start),
          cwd,
          model,
        });
      continue;
    }
    if (type !== 'tool') {
      if (!BOOKKEEPING.has(type))
        into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
      continue;
    }
    const state: Obj = isObj(part.state) ? part.state : {};
    const input: Obj = isObj(state.input) ? state.input : {};
    const base = { ts: at(state.time?.start), cwd, model };
    const done = state.status === 'completed';
    const tool = str(part.tool) ?? '';
    if (tool === 'bash' && str(input.command)) {
      const exit = state.metadata?.exit;
      into.records.push({
        kind: 'command',
        cmd: input.command,
        isError:
          state.status === 'error' || (typeof exit === 'number' ? exit !== 0 : undefined),
        output: headTail(str(state.output) ?? str(state.metadata?.output) ?? ''),
        pending: state.status === 'pending' || state.status === 'running' || undefined,
        ...base,
      });
      continue;
    }
    if (!done) continue;
    const file = str(input.filePath) ?? str(input.path);
    const edit = (
      f: string,
      added: string[],
      removed: string[],
      created?: boolean,
    ): TraceRecord => ({
      kind: 'edit',
      file: resolve(cwd ?? '.', f),
      added,
      removed,
      ...(created ? { created: true } : {}),
      ...base,
    });
    if (tool === 'edit' && file)
      into.records.push(
        edit(
          file,
          splitLines(str(input.newString) ?? ''),
          splitLines(str(input.oldString) ?? ''),
        ),
      );
    else if (tool === 'write' && file)
      into.records.push(
        edit(
          file,
          splitLines(str(input.content) ?? ''),
          [],
          state.metadata?.exists === false,
        ),
      );
    else if (tool === 'multiedit' && file && Array.isArray(input.edits))
      for (const e of input.edits.filter(isObj))
        into.records.push(
          edit(
            file,
            splitLines(str(e.newString) ?? ''),
            splitLines(str(e.oldString) ?? ''),
          ),
        );
    else if (
      (tool === 'patch' || tool === 'apply_patch') &&
      (str(input.patchText) ?? str(input.input))
    )
      for (const f of parseApplyPatch(str(input.patchText) ?? str(input.input)!))
        into.records.push(edit(f.moveTo ?? f.path, f.added, f.removed, f.op === 'Add'));
  }
}

/** A trace adapter over one OpenCode-format database. */
export function opencodeStoreAdapter(
  id: string,
  label: string,
  dbPath: () => string,
): TraceAdapter {
  const sessions = (db: ReadOnlyDb) =>
    db.all<{
      id: string;
      parent_id: string | null;
      directory: string;
      title: string;
      time_updated: number;
    }>('select id, parent_id, directory, title, time_updated from session');
  return {
    id,
    label,
    home: () => (existsSync(dbPath()) ? dbPath() : undefined),
    count: () => withDb(dbPath(), 0, (db) => sessions(db).length),
    discover(query) {
      const path = dbPath();
      return withDb<SessionRef[]>(path, [], (db) => {
        const out: SessionRef[] = [];
        for (const s of sessions(db)) {
          const active = query.currentSessionPath === refPath(path, s.id);
          if (!active && s.time_updated < query.sinceMs) continue;
          let match = !!query.all || mentionsAnyRoot(s.directory ?? '', query.roots);
          if (!match) {
            const text = db
              .all<{ data: string }>('select data from part where session_id = ?', s.id)
              .map((p) => p.data)
              .join('\n');
            match =
              mentionsAnyRoot(text, query.roots) ||
              (query.needles ?? []).some((n) => n && text.includes(n));
          }
          if (match || active)
            out.push({
              agent: id,
              sessionId: s.id,
              path: refPath(path, s.id),
              mtimeMs: s.time_updated,
              cwd: s.directory,
            });
        }
        return out;
      });
    },
    read(ref) {
      const session: TraceSession = {
        agent: id,
        sessionId: ref.sessionId,
        source: ref.path,
        records: [],
        unknownTypes: {},
        warnings: [],
      };
      const { db: path, id: sessionId } = splitRef(ref.path);
      const ok = withDb(path, false, (db) => {
        const [s] = db.all<{
          title: string;
          parent_id: string | null;
          directory: string;
        }>('select title, parent_id, directory from session where id = ?', sessionId);
        if (!s) return false;
        session.title = s.title;
        if (s.parent_id) session.parentSessionId = s.parent_id;
        opencodeRecords(
          db.all(
            'select id, time_created, data from message where session_id = ? order by time_created',
            sessionId,
          ),
          db.all(
            'select message_id, time_created, data from part where session_id = ? order by time_created, id',
            sessionId,
          ),
          session,
          s.directory,
        );
        return true;
      });
      if (!ok)
        session.warnings.push(
          `Could not read ${label} session ${sessionId} from ${path}.`,
        );
      session.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      return session;
    },
  };
}
