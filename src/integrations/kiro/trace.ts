/**
 * Kiro sessions, written by the Kiro IDE and Kiro CLI (v3) alike:
 * ~/.kiro/sessions/<workspace hash>/sess_<id>/ (KIRO_HOME overrides ~/.kiro for
 * Tracetoon), with sessions opened without a folder under `_global`.
 *
 * `session.json` holds the title, `workspacePaths` and `createdAt`.
 * `messages.jsonl` holds one `{ id, timestamp, payload }` line per event:
 * `user` prompts, `assistant` text (`operationType` `Say`; `Reasoning` is
 * redacted to "..."), `tool_call` (`toolName`, `args`, `status`) and its
 * `tool_result` (`content`, `success`), plus turn and usage bookkeeping.
 * Edits are `fs_write` (`path`, `text`; a whole file) and `str_replace`
 * (`path`, `oldStr`, `newStr`). Shell commands are `execute_pwsh` or
 * `execute_bash` (`command`, `cwd`); their result ends with "Exit Code: N".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { splitLines } from '../../trace/diffLines.ts';
import { discoveryIndex } from '../../trace/discovery.ts';
import type {
  SessionRef,
  TraceAdapter,
  TraceRecord,
  TraceSession,
} from '../../trace/types.ts';

type CommandRecord = Extract<TraceRecord, { kind: 'command' }>;

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export const kiroHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.KIRO_HOME || join(homedir(), '.kiro');

/** Bookkeeping lines that carry nothing for a PR description. */
const IGNORED = new Set([
  'agent_note',
  'turn_start',
  'turn_end',
  'session_start',
  'session_metadata',
  'session_event',
  'usage_summary',
  'pending_interaction',
  'interaction_resolved',
  'ContextualHookInvoked',
]);
const SHELL = new Set(['execute_pwsh', 'execute_bash', 'execute_cmd', 'shell']);

/** Parse one session's messages.jsonl into records. Exported for tests. */
export function parseKiroLines(content: string, into: TraceSession, cwd?: string): void {
  // Results arrive after their call; commands are pushed first and completed later.
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
    if (!isObj(o) || !isObj(o.payload)) {
      into.warnings.push('Skipped a line without a payload object.');
      continue;
    }
    const p = o.payload;
    const ts = str(o.timestamp);
    const type = str(p.type) ?? '?';
    if (IGNORED.has(type)) continue;
    switch (type) {
      case 'user': {
        const text = str(p.content)?.trim();
        if (text && !isSyntheticPrompt(text))
          into.records.push({ kind: 'prompt', text, ts, cwd });
        break;
      }
      case 'assistant': {
        const text = str(p.content)?.trim();
        if (p.operationType !== 'Reasoning' && text && text !== '...')
          into.records.push({ kind: 'assistant', text, ts, cwd });
        break;
      }
      case 'tool_call': {
        const name = str(p.toolName) ?? '';
        const args = isObj(p.args) ? p.args : {};
        // A call the user or a hook refused never ran.
        if (p.status === 'denied' || p.status === 'rejected') break;
        const file = str(args.path);
        const at = (f: string) => resolve(cwd ?? '.', f);
        if (SHELL.has(name) && str(args.command)) {
          const record: CommandRecord = {
            kind: 'command',
            cmd: args.command,
            ts,
            cwd: str(args.cwd) ?? cwd,
            pending: true,
          };
          into.records.push(record);
          if (str(p.toolCallId)) pending.set(p.toolCallId, record);
        } else if (name === 'fs_write' && file) {
          into.records.push({
            kind: 'edit',
            file: at(file),
            added: splitLines(str(args.text) ?? ''),
            removed: [],
            created: p.actionType === 'create' || undefined,
            ts,
            cwd,
          });
        } else if (name === 'str_replace' && file) {
          into.records.push({
            kind: 'edit',
            file: at(file),
            added: splitLines(str(args.newStr) ?? ''),
            removed: splitLines(str(args.oldStr) ?? ''),
            ts,
            cwd,
          });
        }
        break;
      }
      case 'tool_result': {
        const record = str(p.toolCallId) ? pending.get(p.toolCallId) : undefined;
        if (!record) break;
        pending.delete(p.toolCallId);
        delete record.pending;
        const content = str(p.content) ?? '';
        const exit = /Exit Code:\s*(-?\d+)\s*$/.exec(content);
        if (p.success === false || (exit && exit[1] !== '0')) record.isError = true;
        const output = content
          .replace(/^Output:\n/, '')
          .replace(/\n*Exit Code:\s*-?\d+\s*$/, '');
        if (output.trim()) record.output = output.slice(0, 4000);
        break;
      }
      default:
        into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
    }
  }
}

interface Found {
  path: string;
  sessionId: string;
  mtimeMs: number;
  cwd?: string;
}

function sessions(): Found[] {
  const root = join(kiroHome(), 'sessions');
  if (!existsSync(root)) return [];
  const out: Found[] = [];
  for (const workspace of readdirSync(root)) {
    let ids: string[];
    try {
      ids = readdirSync(join(root, workspace));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!id.startsWith('sess_')) continue;
      const dir = join(root, workspace, id);
      const path = join(dir, 'messages.jsonl');
      try {
        const mtimeMs = statSync(path).mtimeMs;
        let cwd: string | undefined;
        try {
          const meta = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
          cwd = Array.isArray(meta?.workspacePaths)
            ? meta.workspacePaths.find((p: unknown) => typeof p === 'string' && p.length)
            : undefined;
        } catch {
          /* no metadata: the messages still name their paths */
        }
        out.push({ path, sessionId: id, mtimeMs, cwd });
      } catch {
        /* no messages yet */
      }
    }
  }
  return out;
}

export const kiroAdapter: TraceAdapter = {
  id: 'kiro',
  label: 'Kiro',
  home: () => (existsSync(join(kiroHome(), 'sessions')) ? kiroHome() : undefined),
  count: () => sessions().length,
  discover(query) {
    const index = discoveryIndex(query, 'kiro');
    const out: SessionRef[] = [];
    for (const f of sessions()) {
      const info = index.inspect(f.path);
      if (!info) continue;
      const active =
        query.currentSessionPath && resolve(f.path) === resolve(query.currentSessionPath);
      if (
        (active || Math.max(info.recent, f.mtimeMs) >= query.sinceMs) &&
        (info.match || active)
      )
        out.push({
          agent: 'kiro',
          sessionId: f.sessionId,
          path: f.path,
          mtimeMs: Math.max(f.mtimeMs, info.recent),
          cwd: f.cwd,
        });
    }
    index.save();
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'kiro',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    try {
      const meta = JSON.parse(readFileSync(join(ref.path, '..', 'session.json'), 'utf8'));
      if (typeof meta?.title === 'string') session.title = meta.title;
    } catch {
      /* the title is optional */
    }
    try {
      parseKiroLines(readFileSync(ref.path, 'utf8'), session, ref.cwd);
    } catch (e) {
      session.warnings.push(`Could not read Kiro session: ${(e as Error).message}`);
    }
    return session;
  },
};
