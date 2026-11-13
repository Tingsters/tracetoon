/**
 * GitHub Copilot sessions, two stores:
 *
 * - Copilot CLI: ~/.copilot/session-state/<id>/events.jsonl (COPILOT_HOME
 *   overrides ~/.copilot). An event stream: `session.start` (context.cwd,
 *   branch), `user.message`, `assistant.message`, and `tool.execution_start` /
 *   `tool.execution_complete` paired by toolCallId (shell exit code in
 *   `shellExecution.exitCode`).
 * - Copilot in VS Code: <VS Code user dir>/workspaceStorage/<hash>/chatSessions/
 *   <id>.jsonl. An operation log over one session object: kind 0 is the initial
 *   state, kind 1 sets the value at path `k`, kind 2 appends `v` to the array at
 *   `k` (truncated to `i` first), kind 3 deletes `k`. Replayed, it holds
 *   `requests[]`, each with the prompt (`message.text`) and `response[]` parts:
 *   markdown, `toolInvocationSerialized` (run_in_terminal carries the command
 *   line) and `textEditGroup` (the inserted text per file).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { headTail, parseApplyPatch, splitLines } from '../../trace/diffLines.ts';
import { discoveryIndex } from '../../trace/discovery.ts';
import type {
  SessionRef,
  TraceAdapter,
  TraceRecord,
  TraceSession,
} from '../../trace/types.ts';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export const copilotHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.COPILOT_HOME || join(homedir(), '.copilot');

/** VS Code's user folder (TRACETOON_VSCODE_USER_DIR overrides it, for tests). */
export function vscodeUserDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRACETOON_VSCODE_USER_DIR) return env.TRACETOON_VSCODE_USER_DIR;
  if (process.platform === 'win32')
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Code', 'User');
}

const EDIT_TOOLS = new Set([
  'apply_patch',
  'edit',
  'create',
  'str_replace_editor',
  'write',
]);
const SHELL_TOOLS = new Set(['powershell', 'bash', 'shell']);
const CLI_KNOWN =
  /^(session|user|assistant|tool|hook|system|instruction|subagent|skill|permission|abort)\./;

/* ------------------------------------------------------------ Copilot CLI */

/** Parse one Copilot CLI events.jsonl into records. Exported for tests. */
export function parseCopilotCliLines(content: string, into: TraceSession): void {
  const starts = new Map<
    string,
    { name: string; args: unknown; ts?: string; model?: string }
  >();
  let cwd: string | undefined;
  let branch: string | undefined;
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
    const type = str(o.type) ?? '?';
    const d: Obj = isObj(o.data) ? o.data : {};
    const ts = str(o.timestamp);
    if (!CLI_KNOWN.test(type)) {
      into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
      continue;
    }
    const base = () => ({ ts, cwd, branch });
    switch (type) {
      case 'session.start':
        cwd = str(d.context?.cwd) ?? cwd;
        branch = str(d.context?.branch) ?? branch;
        break;
      case 'user.message': {
        const text = str(d.content)?.trim();
        if (text && !isSyntheticPrompt(text))
          into.records.push({ kind: 'prompt', text, ...base() });
        break;
      }
      case 'assistant.message': {
        const text = str(d.content)?.trim();
        if (text)
          into.records.push({ kind: 'assistant', text, model: str(d.model), ...base() });
        break;
      }
      case 'tool.execution_start':
        if (str(d.toolCallId))
          starts.set(d.toolCallId, {
            name: str(d.toolName) ?? '',
            args: d.arguments,
            ts,
            model: str(d.model),
          });
        break;
      case 'tool.execution_complete': {
        const call = starts.get(d.toolCallId);
        if (!call) break;
        starts.delete(d.toolCallId);
        const at = { ts: call.ts, cwd, branch, model: call.model };
        const output = str(d.result?.content) ?? '';
        if (SHELL_TOOLS.has(call.name) && isObj(call.args) && str(call.args.command)) {
          const exit = d.shellExecution?.exitCode;
          into.records.push({
            kind: 'command',
            cmd: call.args.command,
            isError:
              d.success === false || (typeof exit === 'number' ? exit !== 0 : undefined),
            output: headTail(output),
            ...at,
          });
        } else if (EDIT_TOOLS.has(call.name) && d.success !== false) {
          into.records.push(...editsFrom(call.name, call.args, at));
        }
        break;
      }
    }
  }
  for (const call of starts.values())
    if (SHELL_TOOLS.has(call.name) && isObj(call.args) && str(call.args.command))
      into.records.push({
        kind: 'command',
        cmd: call.args.command,
        pending: true,
        ts: call.ts,
        cwd,
        branch,
        model: call.model,
      });
}

function editsFrom(
  name: string,
  args: unknown,
  at: { ts?: string; cwd?: string; branch?: string; model?: string },
): TraceRecord[] {
  const root = at.cwd ?? '.';
  const envelope =
    typeof args === 'string'
      ? args
      : isObj(args)
        ? (str(args.input) ?? str(args.patch))
        : undefined;
  if (name === 'apply_patch' && envelope)
    return parseApplyPatch(envelope).map((f) => ({
      kind: 'edit' as const,
      file: resolve(root, f.moveTo ?? f.path),
      added: f.added,
      removed: f.removed,
      ...(f.op === 'Add' ? { created: true } : {}),
      ...at,
    }));
  if (!isObj(args)) return [];
  const file = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  if (!file) return [];
  if (name === 'create' || name === 'write')
    return [
      {
        kind: 'edit',
        file: resolve(root, file),
        added: splitLines(str(args.file_text) ?? str(args.content) ?? ''),
        removed: [],
        created: true,
        ...at,
      },
    ];
  return [
    {
      kind: 'edit',
      file: resolve(root, file),
      added: splitLines(str(args.new_str) ?? str(args.newString) ?? ''),
      removed: splitLines(str(args.old_str) ?? str(args.oldString) ?? ''),
      ...at,
    },
  ];
}

function cliSessions(): { path: string; sessionId: string; mtimeMs: number }[] {
  const root = join(copilotHome(), 'session-state');
  if (!existsSync(root)) return [];
  const out: { path: string; sessionId: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(root)) {
    // Current layout: <id>/events.jsonl. Older releases wrote <id>.jsonl.
    const dir = join(root, name, 'events.jsonl');
    const flat = name.endsWith('.jsonl') ? join(root, name) : undefined;
    const path = existsSync(dir) ? dir : flat;
    if (!path) continue;
    try {
      out.push({
        path,
        sessionId: flat ? basename(name, '.jsonl') : name,
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch {
      /* vanished */
    }
  }
  return out;
}

/* ---------------------------------------------------------- VS Code chats */

/** Replay a VS Code chat session operation log into its final object. Exported for tests. */
export function replayChatSession(content: string): { state?: Obj; skipped: number } {
  let state: Obj | undefined;
  let skipped = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const op = JSON.parse(line);
      if (op.kind === 0) {
        state = op.v;
        continue;
      }
      if (!state || !Array.isArray(op.k) || !op.k.length) throw new Error('no state');
      const parent = op.k.slice(0, -1).reduce((o: any, p: any) => o[p], state);
      const last = op.k[op.k.length - 1];
      if (op.kind === 1) parent[last] = op.v;
      else if (op.kind === 2) {
        const arr = parent[last];
        if (!Array.isArray(arr)) throw new Error('not an array');
        if (typeof op.i === 'number') arr.length = Math.min(arr.length, op.i);
        arr.push(...(Array.isArray(op.v) ? op.v : [op.v]));
      } else if (op.kind === 3) delete parent[last];
      else throw new Error('unknown op');
    } catch {
      skipped++;
    }
  }
  return { state, skipped };
}

const uriPath = (u: unknown): string | undefined => {
  if (!isObj(u)) return undefined;
  if (str(u.fsPath)) return u.fsPath;
  try {
    return str(u.external) ? fileURLToPath(u.external) : undefined;
  } catch {
    return undefined;
  }
};

/** Parse a replayed VS Code chat session into records. Exported for tests. */
export function parseVscodeChat(
  content: string,
  into: TraceSession,
  workspace?: string,
): void {
  const { state, skipped } = replayChatSession(content);
  if (skipped)
    into.warnings.push(
      `Skipped ${skipped} chat log operation(s) that could not be applied.`,
    );
  if (!state) return;
  into.title ??= str(state.customTitle);
  for (const q of Array.isArray(state.requests) ? state.requests : []) {
    if (!isObj(q)) continue;
    const ts =
      typeof q.timestamp === 'number' ? new Date(q.timestamp).toISOString() : undefined;
    const model = str(q.modelId);
    const text = str(q.message?.text)?.trim();
    if (text && !isSyntheticPrompt(text))
      into.records.push({ kind: 'prompt', text, ts, cwd: workspace });
    let answer = '';
    for (const p of Array.isArray(q.response) ? q.response : []) {
      if (!isObj(p)) continue;
      if (p.kind === undefined && str(p.value)) answer += p.value;
      else if (p.kind === 'textEditGroup') {
        const file = uriPath(p.uri);
        const inserted = (Array.isArray(p.edits) ? p.edits.flat() : [])
          .map((e: unknown) => (isObj(e) ? (str(e.text) ?? '') : ''))
          .join('');
        if (file && inserted)
          into.records.push({
            kind: 'edit',
            file,
            added: splitLines(inserted),
            removed: [],
            ts,
            cwd: workspace,
            model,
          });
      } else if (
        p.kind === 'toolInvocationSerialized' &&
        p.toolSpecificData?.kind === 'terminal'
      ) {
        const t = p.toolSpecificData;
        const cmd = str(t.commandLine?.toolEdited) ?? str(t.commandLine?.original);
        const exit = t.terminalCommandState?.exitCode;
        if (cmd)
          into.records.push({
            kind: 'command',
            cmd,
            isError: typeof exit === 'number' ? exit !== 0 : undefined,
            ts,
            cwd: uriPath(t.cwd) ?? workspace,
            model,
          });
      }
    }
    if (answer.trim())
      into.records.push({
        kind: 'assistant',
        text: answer.trim(),
        ts,
        cwd: workspace,
        model,
      });
  }
}

function vscodeSessions(): {
  path: string;
  sessionId: string;
  mtimeMs: number;
  workspace?: string;
}[] {
  const root = join(vscodeUserDir(), 'workspaceStorage');
  if (!existsSync(root)) return [];
  const out: { path: string; sessionId: string; mtimeMs: number; workspace?: string }[] =
    [];
  for (const hash of readdirSync(root)) {
    const dir = join(root, hash, 'chatSessions');
    if (!existsSync(dir)) continue;
    let workspace: string | undefined;
    try {
      const folder = JSON.parse(
        readFileSync(join(root, hash, 'workspace.json'), 'utf8'),
      ).folder;
      workspace = typeof folder === 'string' ? fileURLToPath(folder) : undefined;
    } catch {
      /* multi-root or remote workspace */
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        out.push({
          path,
          sessionId: basename(name, '.jsonl'),
          mtimeMs: statSync(path).mtimeMs,
          workspace,
        });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- adapters */

function makeAdapter(
  id: string,
  label: string,
  home: () => string | undefined,
  list: () => { path: string; sessionId: string; mtimeMs: number; workspace?: string }[],
  parse: (content: string, into: TraceSession, workspace?: string) => void,
): TraceAdapter {
  return {
    id,
    label,
    home,
    count: () => list().length,
    discover(query) {
      const index = discoveryIndex(query, id);
      const out: SessionRef[] = [];
      for (const f of list()) {
        const info = index.inspect(f.path);
        if (!info) continue;
        const active =
          query.currentSessionPath &&
          resolve(f.path) === resolve(query.currentSessionPath);
        if (
          (active || Math.max(info.recent, f.mtimeMs) >= query.sinceMs) &&
          (info.match || active)
        )
          out.push({
            agent: id,
            sessionId: f.sessionId,
            path: f.path,
            mtimeMs: Math.max(f.mtimeMs, info.recent),
            cwd: f.workspace,
          });
      }
      index.save();
      return out;
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
      try {
        parse(readFileSync(ref.path, 'utf8'), session, ref.cwd);
      } catch (e) {
        session.warnings.push(`Could not read ${label} session: ${(e as Error).message}`);
      }
      session.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      return session;
    },
  };
}

export const copilotCliAdapter = makeAdapter(
  'copilot-cli',
  'Copilot CLI',
  () => (existsSync(join(copilotHome(), 'session-state')) ? copilotHome() : undefined),
  cliSessions,
  (content, into) => parseCopilotCliLines(content, into),
);

export const copilotVscodeAdapter = makeAdapter(
  'copilot-vscode',
  'Copilot in VS Code',
  () =>
    existsSync(join(vscodeUserDir(), 'workspaceStorage')) ? vscodeUserDir() : undefined,
  vscodeSessions,
  parseVscodeChat,
);
