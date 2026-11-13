/**
 * Factory Droid sessions: ~/.factory/sessions/<encoded cwd>/<session id>.jsonl
 * (FACTORY_HOME overrides ~/.factory).
 *
 * The first line is `session_start` ({ id, title, cwd }); the rest are `message`
 * lines ({ message: { role, content[], modelId } }) with Anthropic-style
 * `tool_use` / `tool_result` blocks, plus `agent_turn_outcome` markers. A
 * `Script` tool call runs nested tool calls; each nested call is logged as its
 * own `tool_use` / `tool_result` pair, so the Script wrapper itself is skipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { headTail, parseApplyPatch, splitLines } from '../../trace/diffLines.ts';
import { discoveryIndex } from '../../trace/discovery.ts';
import type { SessionRef, TraceAdapter, TraceSession } from '../../trace/types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

const KNOWN_TYPES = new Set(['session_start', 'message', 'agent_turn_outcome']);
/** Tools whose calls are read; the rest (Read, Glob, Grep, LS, Script, ...) are not evidence. */
const SKIPPED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'Script',
  'FetchUrl',
  'WebSearch',
]);

export const factoryHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_HOME || join(homedir(), '.factory');
const sessionsDir = (env?: NodeJS.ProcessEnv) => join(factoryHome(env), 'sessions');

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    // Nested results are stored JSON-encoded ("\"Command completed...\"").
    if (/^".*"$/s.test(content)) {
      try {
        const s = JSON.parse(content);
        if (typeof s === 'string') return s;
      } catch {
        /* as is */
      }
    }
    return content;
  }
  if (Array.isArray(content))
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

interface Call {
  name: string;
  input: Obj;
  ts?: string;
  model?: string;
}

/** Parse one Factory session file into records. Exported for tests. */
export function parseFactoryLines(content: string, into: TraceSession): void {
  const calls = new Map<string, Call>();
  let cwd: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: Obj;
    try {
      o = JSON.parse(line);
    } catch {
      into.warnings.push('Skipped a line that is not JSON.');
      continue;
    }
    const type = str(o.type) ?? '?';
    if (!KNOWN_TYPES.has(type)) {
      into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
      continue;
    }
    if (type === 'session_start') {
      cwd = str(o.cwd);
      into.title ??= str(o.title);
      continue;
    }
    if (type !== 'message' || !isObj(o.message)) continue;
    const msg = o.message;
    const ts = str(o.timestamp);
    const model = str(msg.modelId);
    const role = str(msg.role);
    const parts = Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
    // Context the host injects ("context-…" ids, <system-reminder> blocks) is not typed by the user.
    const injected = (str(o.id) ?? '').startsWith('context-');
    if (role === 'user' && !injected) {
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => str(p.text) ?? '')
        .join('\n')
        .trim();
      if (text && !text.startsWith('<system-reminder>') && !isSyntheticPrompt(text))
        into.records.push({ kind: 'prompt', text, ts, cwd });
    }
    for (const p of parts) {
      if (role === 'assistant' && p.type === 'text' && str(p.text))
        into.records.push({ kind: 'assistant', text: str(p.text)!, ts, cwd, model });
      if (p.type === 'tool_use' && str(p.id) && str(p.name)) {
        let input: unknown = p.input;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = { input };
          }
        }
        calls.set(str(p.id)!, {
          name: str(p.name)!,
          input: isObj(input) ? input : {},
          ts,
          model,
        });
      }
      if (p.type === 'tool_result' && str(p.tool_use_id)) {
        const call = calls.get(str(p.tool_use_id)!);
        if (!call || SKIPPED_TOOLS.has(call.name)) continue;
        calls.delete(str(p.tool_use_id)!);
        record(into, call, p, cwd);
      }
    }
  }
  // Calls with no result yet: commands still running.
  for (const call of calls.values())
    if (call.name === 'Execute' && str(call.input.command))
      into.records.push({
        kind: 'command',
        cmd: str(call.input.command)!,
        pending: true,
        ts: call.ts,
        cwd,
        model: call.model,
      });
}

function record(into: TraceSession, call: Call, result: Obj, cwd?: string): void {
  const base = { ts: call.ts, cwd, model: call.model };
  const output = textOf(result.model_content ?? result.content);
  const failed = result.is_error === true;
  const { name, input } = call;
  if (name === 'Execute' && str(input.command)) {
    const exit = /\[Process exited with code (-?\d+)\]/.exec(output)?.[1];
    into.records.push({
      kind: 'command',
      cmd: str(input.command)!,
      isError: failed || (exit !== undefined ? exit !== '0' : undefined),
      output: headTail(output),
      ...base,
    });
    return;
  }
  if (failed) return;
  const envelope = str(input.input) ?? str(input.patch);
  if (name === 'ApplyPatch' && envelope) {
    for (const f of parseApplyPatch(envelope))
      into.records.push({
        kind: 'edit',
        file: resolve(cwd ?? '.', f.moveTo ?? f.path),
        added: f.added,
        removed: f.removed,
        ...(f.op === 'Add' ? { created: true } : {}),
        ...base,
      });
    return;
  }
  const file = str(input.file_path) ?? str(input.path);
  if (!file) return;
  if (name === 'Create')
    into.records.push({
      kind: 'edit',
      file: resolve(cwd ?? '.', file),
      added: splitLines(str(input.content) ?? ''),
      removed: [],
      created: true,
      ...base,
    });
  else if (name === 'Edit' || name === 'MultiEdit')
    into.records.push({
      kind: 'edit',
      file: resolve(cwd ?? '.', file),
      added: splitLines(str(input.new_str) ?? str(input.new_string) ?? ''),
      removed: splitLines(str(input.old_str) ?? str(input.old_string) ?? ''),
      ...base,
    });
}

interface Found {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

function sessionFiles(): Found[] {
  const root = sessionsDir();
  if (!existsSync(root)) return [];
  const out: Found[] = [];
  for (const dir of readdirSync(root)) {
    const folder = join(root, dir);
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(folder, name);
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

/** The session's cwd, from its first (session_start) line. */
function startCwd(path: string): string | undefined {
  try {
    const first = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    const o = JSON.parse(first);
    return o?.type === 'session_start' ? str(o.cwd) : undefined;
  } catch {
    return undefined;
  }
}

export const factoryAdapter: TraceAdapter = {
  id: 'factory-droid',
  label: 'Factory Droid',
  home: () => (existsSync(sessionsDir()) ? factoryHome() : undefined),
  count: () => sessionFiles().length,
  discover(query) {
    const index = discoveryIndex(query, 'factory-droid');
    const out: SessionRef[] = [];
    for (const f of sessionFiles()) {
      const info = index.inspect(f.path);
      if (!info) continue;
      const active =
        query.currentSessionPath && resolve(f.path) === resolve(query.currentSessionPath);
      if (
        (active || Math.max(info.recent, f.mtimeMs) >= query.sinceMs) &&
        (info.match || active)
      )
        out.push({
          agent: 'factory-droid',
          sessionId: f.sessionId,
          path: f.path,
          mtimeMs: Math.max(f.mtimeMs, info.recent),
          cwd: startCwd(f.path),
        });
    }
    index.save();
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'factory-droid',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    try {
      parseFactoryLines(readFileSync(ref.path, 'utf8'), session);
    } catch (e) {
      session.warnings.push(`Could not read Factory session: ${(e as Error).message}`);
    }
    session.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    return session;
  },
};
