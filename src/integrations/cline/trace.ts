/**
 * Cline sessions (CLI 3.x and the SDK it shares): ~/.cline/data/sessions/<id>/
 * (CLINE_DATA_DIR replaces ~/.cline/data). `<id>.json` holds `cwd`,
 * `workspace_root`, `source`, `status` and `metadata.title`; `<id>.messages.json`
 * holds `{ messages: [{ role, content, ts }] }` with Anthropic-style blocks.
 *
 * The prompt is wrapped in `<user_input mode="…">`; lines starting "[SYSTEM]"
 * are Cline's own nudges. Edits are `editor` calls (`path`, `new_text`, and
 * `old_text` unless the file is new); commands are `run_commands` (`commands`, a
 * list) whose `tool_result` lists `{ query, result, success }` per command.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

export const clineDataDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLINE_DATA_DIR || join(homedir(), '.cline', 'data');

/** Tools that don't change the repository or describe the work. */
const QUIET = new Set([
  'read_files',
  'search_files',
  'list_files',
  'submit_and_exit',
  'ask_question',
]);

/** The typed prompt, without Cline's wrapper. */
function promptOf(text: string): string | undefined {
  if (text.startsWith('[SYSTEM]')) return undefined;
  const m = /<user_input[^>]*>([\s\S]*?)<\/user_input>/.exec(text);
  return (m ? m[1]! : text).trim() || undefined;
}

/** Parse one session's messages into records. Exported for tests. */
export function parseClineMessages(
  content: string,
  into: TraceSession,
  cwd?: string,
): void {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    into.warnings.push('The messages file is not JSON.');
    return;
  }
  const messages: unknown[] = Array.isArray(doc)
    ? doc
    : isObj(doc) && Array.isArray(doc.messages)
      ? doc.messages
      : [];
  const pending = new Map<string, CommandRecord[]>();
  for (const m of messages) {
    if (!isObj(m)) {
      into.warnings.push('Skipped a message that is not an object.');
      continue;
    }
    const ts = typeof m.ts === 'number' ? new Date(m.ts).toISOString() : str(m.ts);
    const blocks: Obj[] = Array.isArray(m.content)
      ? m.content.filter(isObj)
      : typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : [];
    for (const b of blocks) {
      if (b.type === 'text' && str(b.text)) {
        if (m.role === 'user') {
          const text = promptOf(b.text);
          if (text && !isSyntheticPrompt(text))
            into.records.push({ kind: 'prompt', text, ts, cwd });
        } else if (m.role === 'assistant')
          into.records.push({ kind: 'assistant', text: b.text.trim(), ts, cwd });
      } else if (b.type === 'tool_use' && isObj(b.input)) {
        const input = b.input;
        const name = str(b.name) ?? '';
        if (name === 'editor' && str(input.path)) {
          const file = resolve(cwd ?? '.', input.path);
          const created = !str(input.old_text);
          into.records.push({
            kind: 'edit',
            file,
            added: splitLines(str(input.new_text) ?? ''),
            removed: splitLines(str(input.old_text) ?? ''),
            ...(created ? { created: true } : {}),
            ts,
            cwd,
          });
        } else if (name === 'run_commands' && Array.isArray(input.commands)) {
          const records = input.commands
            .filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)
            .map((cmd: string): CommandRecord => ({
              kind: 'command',
              cmd,
              ts,
              cwd,
              pending: true,
            }));
          into.records.push(...records);
          if (str(b.id)) pending.set(b.id, records);
        } else if (name === 'execute_command' && str(input.command)) {
          // The single-command shell tool: its result is plain text.
          const record: CommandRecord = {
            kind: 'command',
            cmd: input.command,
            ts,
            cwd,
            pending: true,
          };
          into.records.push(record);
          if (str(b.id)) pending.set(b.id, [record]);
        } else if (!QUIET.has(name)) {
          into.unknownTypes[`tool:${name}`] =
            (into.unknownTypes[`tool:${name}`] ?? 0) + 1;
        }
      } else if (b.type === 'tool_result') {
        const records = str(b.tool_use_id) ? pending.get(b.tool_use_id) : undefined;
        if (!records) continue;
        pending.delete(b.tool_use_id);
        const results: Obj[] = Array.isArray(b.content)
          ? b.content.filter(isObj)
          : str(b.content)
            ? [{ result: b.content, success: b.is_error === true ? false : undefined }]
            : [];
        records.forEach((r, i) => {
          delete r.pending;
          const result = results.find((x) => x.query === r.cmd) ?? results[i];
          if (!result) return;
          if (result.success === false) r.isError = true;
          if (str(result.result)) r.output = result.result.slice(0, 4000);
        });
      } else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') {
        const t = str(b.type) ?? '?';
        into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      }
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
  const root = join(clineDataDir(), 'sessions');
  if (!existsSync(root)) return [];
  const out: Found[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const path = join(dir, `${id}.messages.json`);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      let cwd: string | undefined;
      try {
        const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
        cwd = str(meta?.cwd) ?? str(meta?.workspace_root);
      } catch {
        /* the messages still name their paths */
      }
      out.push({ path, sessionId: id, mtimeMs, cwd });
    } catch {
      /* no messages yet */
    }
  }
  return out;
}

export const clineAdapter: TraceAdapter = {
  id: 'cline',
  label: 'Cline',
  home: () => (existsSync(join(clineDataDir(), 'sessions')) ? clineDataDir() : undefined),
  count: () => sessions().length,
  discover(query) {
    const index = discoveryIndex(query, 'cline');
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
          agent: 'cline',
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
      agent: 'cline',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    try {
      const meta = JSON.parse(
        readFileSync(join(dirname(ref.path), `${ref.sessionId}.json`), 'utf8'),
      );
      if (str(meta?.metadata?.title)) session.title = meta.metadata.title;
    } catch {
      /* the title is optional */
    }
    try {
      parseClineMessages(readFileSync(ref.path, 'utf8'), session, ref.cwd);
    } catch (e) {
      session.warnings.push(`Could not read Cline session: ${(e as Error).message}`);
    }
    return session;
  },
};
