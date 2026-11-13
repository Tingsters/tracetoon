/**
 * Cursor agent transcripts, written by the IDE and the `agent` CLI alike:
 * ~/.cursor/projects/<encoded workspace>/agent-transcripts/<id>/<id>.jsonl
 * (CURSOR_HOME overrides ~/.cursor for Tracetoon). Subagents write
 * `subagents/*.jsonl` beside it.
 *
 * Lines are `{ role, message: { content: [...] } }` with Anthropic-style `text`
 * and `tool_use` blocks, plus `{ type: "turn_ended" }` markers. The transcript
 * keeps no tool results, ids or per-line timestamps: a user turn's text wraps
 * the prompt in <user_query> after a <timestamp> line, and that time is used for
 * the whole turn. Commands therefore carry no exit code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { splitLines } from '../../trace/diffLines.ts';
import { discoveryIndex } from '../../trace/discovery.ts';
import type { SessionRef, TraceAdapter, TraceSession } from '../../trace/types.ts';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export const cursorHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.CURSOR_HOME || join(homedir(), '.cursor');

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** "Friday, Nov 13, 2026, 3:47 AM (UTC-8)" as an ISO time. Exported for tests. */
export function cursorTimestamp(text: string): string | undefined {
  const m =
    /(\w{3})\w*\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/i.exec(
      text,
    );
  if (!m) return undefined;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[1]!.toLowerCase());
  if (month < 0) return undefined;
  let hour = Number(m[4]) % 12;
  if (m[6]!.toUpperCase() === 'PM') hour += 12;
  const offset = Number(m[7]) * 60 + Math.sign(Number(m[7]) || 1) * Number(m[8] ?? 0);
  const utc =
    Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60_000;
  return new Date(utc).toISOString();
}

/** The typed prompt in a user turn, without Cursor's wrappers. */
function promptOf(text: string): string {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  return (q ? q[1]! : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/, '')).trim();
}

/** Parse one Cursor transcript into records. Exported for tests. */
export function parseCursorLines(
  content: string,
  into: TraceSession,
  cwd?: string,
): void {
  let ts: string | undefined;
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
    if (o.type === 'turn_ended') continue;
    const role = str(o.role);
    const parts: Obj[] = Array.isArray(o.message?.content)
      ? o.message.content.filter(isObj)
      : [];
    if (role !== 'user' && role !== 'assistant') {
      const t = str(o.type) ?? str(o.role) ?? '?';
      into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      continue;
    }
    if (role === 'user') {
      const raw = parts
        .map((p) => (p.type === 'text' ? (str(p.text) ?? '') : ''))
        .join('\n');
      ts = cursorTimestamp(raw) ?? ts;
      const text = promptOf(raw);
      if (text && !isSyntheticPrompt(text))
        into.records.push({ kind: 'prompt', text, ts, cwd });
      continue;
    }
    for (const p of parts) {
      if (p.type === 'text' && str(p.text))
        into.records.push({ kind: 'assistant', text: p.text.trim(), ts, cwd });
      if (p.type !== 'tool_use' || !isObj(p.input)) continue;
      const input = p.input;
      const file = str(input.path) ?? str(input.file_path) ?? str(input.target_file);
      const at = (f: string) => resolve(cwd ?? '.', f);
      switch (p.name) {
        case 'Shell':
        case 'run_terminal_cmd':
          if (str(input.command))
            into.records.push({
              kind: 'command',
              cmd: input.command,
              ts,
              cwd: str(input.working_directory) ?? cwd,
            });
          break;
        case 'StrReplace':
        case 'search_replace':
          if (file)
            into.records.push({
              kind: 'edit',
              file: at(file),
              added: splitLines(str(input.new_string) ?? ''),
              removed: splitLines(str(input.old_string) ?? ''),
              ts,
              cwd,
            });
          break;
        case 'Write':
        case 'write':
          if (file)
            into.records.push({
              kind: 'edit',
              file: at(file),
              added: splitLines(str(input.contents) ?? str(input.content) ?? ''),
              removed: [],
              created: true,
              ts,
              cwd,
            });
          break;
        case 'MultiStrReplace':
          if (file && Array.isArray(input.edits))
            for (const e of input.edits.filter(isObj))
              into.records.push({
                kind: 'edit',
                file: at(file),
                added: splitLines(str(e.new_string) ?? ''),
                removed: splitLines(str(e.old_string) ?? ''),
                ts,
                cwd,
              });
          break;
      }
    }
  }
}

interface Found {
  path: string;
  sessionId: string;
  mtimeMs: number;
  parent?: string;
}

function transcripts(): Found[] {
  const root = join(cursorHome(), 'projects');
  if (!existsSync(root)) return [];
  const out: Found[] = [];
  const add = (path: string, sessionId: string, parent?: string) => {
    try {
      out.push({ path, sessionId, mtimeMs: statSync(path).mtimeMs, parent });
    } catch {
      /* vanished */
    }
  };
  for (const project of readdirSync(root)) {
    const dir = join(root, project, 'agent-transcripts');
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir)) {
      const main = join(dir, id, `${id}.jsonl`);
      if (existsSync(main)) add(main, id);
      const subs = join(dir, id, 'subagents');
      if (existsSync(subs))
        for (const name of readdirSync(subs))
          if (name.endsWith('.jsonl'))
            add(join(subs, name), basename(name, '.jsonl'), id);
    }
  }
  return out;
}

/** The workspace folder a transcript's tool calls work in, if any names one. */
function workspaceOf(path: string): string | undefined {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /"(?:working_directory|target_directory)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
        line,
      );
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

export const cursorAdapter: TraceAdapter = {
  id: 'cursor',
  label: 'Cursor',
  home: () => (existsSync(join(cursorHome(), 'projects')) ? cursorHome() : undefined),
  count: () => transcripts().length,
  discover(query) {
    const index = discoveryIndex(query, 'cursor');
    const out: SessionRef[] = [];
    for (const f of transcripts()) {
      const info = index.inspect(f.path);
      if (!info) continue;
      const active =
        query.currentSessionPath && resolve(f.path) === resolve(query.currentSessionPath);
      if (
        (active || Math.max(info.recent, f.mtimeMs) >= query.sinceMs) &&
        (info.match || active)
      )
        out.push({
          agent: 'cursor',
          sessionId: f.sessionId,
          path: f.path,
          mtimeMs: Math.max(f.mtimeMs, info.recent),
          cwd: workspaceOf(f.path),
        });
    }
    index.save();
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'cursor',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    const parent = /[\\/]agent-transcripts[\\/]([^\\/]+)[\\/]subagents[\\/]/.exec(
      ref.path,
    );
    if (parent) session.parentSessionId = parent[1];
    try {
      parseCursorLines(readFileSync(ref.path, 'utf8'), session, ref.cwd);
    } catch (e) {
      session.warnings.push(`Could not read Cursor transcript: ${(e as Error).message}`);
    }
    return session;
  },
};
