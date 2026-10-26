/**
 * Codex adapter. Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (or
 * `$CODEX_HOME`). Handles both the current format, where work arrives as
 * `event_msg` / `item_completed` items (UserMessage, AgentMessage,
 * CommandExecution, FileChange, Plan), and the older one (`user_message`,
 * `agent_message`, `apply_patch`, `shell`, `update_plan`).
 *
 * Many Codex sessions run with the home folder as cwd, so each record keeps the
 * most specific location available: a command's own cwd, or the edited file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { codex } from '@showtail/agent-traces';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import {
  headTail,
  linesFromUnifiedDiff,
  parseApplyPatch,
  splitLines,
} from './diffLines.ts';
import { mentionsAnyRoot } from './pathMatch.ts';
import type { SessionRef, TraceAdapter, TraceSession } from './types.ts';
import { discoveryIndex } from './discovery.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const KNOWN = new Set([
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'compacted',
  'token_usage_record',
  'world_state',
  'inter_agent_communication_metadata',
  'retained_context',
]);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isObj(c) ? (str(c.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** The command a shell wrapper runs: `[pwsh, -Command, "git status"]` → `git status`. */
export function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || !command.length) return undefined;
  const parts = command.filter((c): c is string => typeof c === 'string');
  const flag = parts.findIndex((p) => /^-(c|Command|lc|ic)$/i.test(p) || p === '/c');
  return flag >= 0 && parts[flag + 1] ? parts.slice(flag + 1).join(' ') : parts.join(' ');
}

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Plan text from an `update_plan` call: `{ explanation?, plan: [{ step, status }] }`. */
function planFromArgs(args: unknown): string | undefined {
  const a = parseJson(args);
  if (!isObj(a) || !Array.isArray(a.plan)) return undefined;
  const steps = a.plan
    .map((p) =>
      isObj(p) ? `- [${p.status === 'completed' ? 'x' : ' '}] ${str(p.step) ?? ''}` : '',
    )
    .filter((s) => s.length > 6);
  const head = str(a.explanation);
  return [head, ...steps].filter(Boolean).join('\n') || undefined;
}

/** Parse one rollout file's content. Exported for tests. */
export function parseCodexLines(content: string, into: TraceSession): void {
  let cwd: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  let delegated = false;
  const seenPrompts = new Set<string>();
  const seenReplies = new Set<string>();
  const pendingCalls = new Map<
    string,
    { name: string; args: unknown; ts?: string; cwd?: string }
  >();

  const where = (ts: string | undefined, at?: string) => ({
    ts,
    cwd: at ?? cwd,
    branch,
    model,
  });
  const addPrompt = (text: string, ts?: string) => {
    const t = text.trim();
    if (!t || isSyntheticPrompt(t) || t.startsWith('<environment_context>')) return;
    const key = `${t}`;
    if (seenPrompts.has(key)) return;
    seenPrompts.add(key);
    into.records.push({
      kind: 'prompt',
      text: t,
      ...where(ts),
      ...(delegated ? { delegated: true } : {}),
    });
  };
  const addReply = (text: string, ts?: string) => {
    const t = text.trim();
    if (!t || seenReplies.has(t)) return;
    seenReplies.add(t);
    into.records.push({ kind: 'assistant', text: t, ...where(ts) });
  };
  const addEdit = (
    path: string,
    change: { added: string[]; removed: string[] },
    ts?: string,
    created?: boolean,
  ) => {
    const file = resolve(cwd ?? '.', path);
    into.records.push({
      kind: 'edit',
      file,
      ...change,
      ...(created ? { created } : {}),
      ...where(ts, dirname(file)),
    });
  };

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const type = str(o.type) ?? '';
    const ts = str(o.timestamp);
    const p = isObj(o.payload) ? o.payload : {};
    if (!KNOWN.has(type)) {
      into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
      continue;
    }

    if (type === 'session_meta') {
      cwd = str(p.cwd) ?? cwd;
      if (isObj(p.git)) branch = str(p.git.branch) ?? branch;
      if (isObj(p.source) && 'subagent' in p.source) {
        delegated = true;
        const spawn =
          isObj(p.source.subagent) && isObj(p.source.subagent.thread_spawn)
            ? p.source.subagent.thread_spawn
            : {};
        into.parentSessionId =
          str(spawn.parent_thread_id) ?? str(p.parent_thread_id) ?? into.parentSessionId;
      }
      if (str(p.agent_nickname) && !into.title) into.title = str(p.agent_nickname);
      continue;
    }
    if (type === 'turn_context') {
      cwd = str(p.cwd) ?? cwd;
      model = str(p.model) ?? model;
      continue;
    }
    if (type === 'token_usage_record' && isObj(p.usage)) {
      const u = p.usage;
      into.records.push({
        kind: 'usage',
        usage: {
          input: num(u.input_tokens) - num(u.cached_input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cached_input_tokens),
          cacheWrite: num(u.cache_write_input_tokens),
        },
        ...where(ts),
      });
      continue;
    }
    if (
      type === 'retained_context' &&
      p.type === 'verified_answer' &&
      Array.isArray(p.questions)
    ) {
      const text = p.questions
        .map((q) => (isObj(q) ? `${str(q.question) ?? ''} → ${str(q.answer) ?? ''}` : ''))
        .filter(Boolean)
        .join('\n');
      if (text) into.records.push({ kind: 'decision', text, ...where(ts) });
      continue;
    }

    if (type === 'event_msg') {
      const et = str(p.type);
      if (et === 'user_message') addPrompt(str(p.message) ?? '', ts);
      else if (et === 'agent_message') addReply(str(p.message) ?? '', ts);
      else if (et === 'item_completed' && isObj(p.item)) {
        const it = p.item;
        switch (it.type) {
          case 'UserMessage':
            addPrompt(textOf(it.content), ts);
            break;
          case 'AgentMessage':
            addReply(textOf(it.content), ts);
            break;
          case 'Plan':
            if (str(it.text))
              into.records.push({ kind: 'plan', markdown: str(it.text)!, ...where(ts) });
            break;
          case 'CommandExecution': {
            const cmd = commandText(it.command);
            if (!cmd) break;
            const exit = typeof it.exit_code === 'number' ? it.exit_code : undefined;
            const output = headTail(
              str(it.aggregated_output) ??
                `${str(it.stdout) ?? ''}\n${str(it.stderr) ?? ''}`,
            );
            into.records.push({
              kind: 'command',
              cmd,
              isError: exit !== undefined ? exit !== 0 : it.status === 'failed',
              output,
              ...where(ts, str(it.cwd)),
            });
            break;
          }
          case 'FileChange': {
            if (it.status === 'failed' || it.status === 'declined' || !isObj(it.changes))
              break;
            for (const [path, c] of Object.entries(it.changes)) {
              if (!isObj(c)) continue;
              if (c.type === 'add')
                addEdit(
                  path,
                  { added: splitLines(str(c.content) ?? ''), removed: [] },
                  ts,
                  true,
                );
              else if (c.type === 'delete')
                addEdit(
                  path,
                  { added: [], removed: splitLines(str(c.content) ?? '') },
                  ts,
                );
              else
                addEdit(
                  str(c.move_path) ?? path,
                  linesFromUnifiedDiff(str(c.unified_diff) ?? ''),
                  ts,
                );
            }
            break;
          }
        }
      }
      continue;
    }

    if (type === 'response_item') {
      const rt = str(p.type);
      const callId = str(p.call_id);
      if ((rt === 'custom_tool_call' || rt === 'function_call') && callId) {
        pendingCalls.set(callId, {
          name: str(p.name) ?? '',
          args: p.input ?? p.arguments,
          ts,
          cwd,
        });
        const name = str(p.name);
        if (name === 'update_plan') {
          const md = planFromArgs(p.arguments);
          if (md) into.records.push({ kind: 'plan', markdown: md, ...where(ts) });
        }
        if (name === 'apply_patch' && typeof p.input === 'string') {
          for (const f of parseApplyPatch(p.input)) {
            addEdit(f.moveTo ?? f.path, f, ts, f.op === 'Add');
          }
        }
        continue;
      }
      if ((rt === 'function_call_output' || rt === 'custom_tool_call_output') && callId) {
        const call = pendingCalls.get(callId);
        pendingCalls.delete(callId);
        if (
          !call ||
          !/^(shell|shell_command|local_shell|container\.exec)$/.test(call.name)
        )
          continue;
        const args = parseJson(call.args);
        const cmd = isObj(args) ? commandText(args.command) : undefined;
        if (!cmd) continue;
        const out = typeof p.output === 'string' ? p.output : textOf(p.output);
        const exit =
          /Exit code:\s*(\d+)/i.exec(out)?.[1] ?? /"exit_code":\s*(\d+)/.exec(out)?.[1];
        into.records.push({
          kind: 'command',
          cmd,
          isError: exit !== undefined ? exit !== '0' : undefined,
          output: headTail(out),
          ...where(call.ts, isObj(args) ? str(args.workdir) : undefined),
        });
      }
    }
  }
}

/** Thread titles from `session_index.jsonl` ({ id, thread_name }). */
function threadTitles(): Map<string, string> {
  const map = new Map<string, string>();
  const p = join(dirname(codex.codexSessionsDir()), 'session_index.jsonl');
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    try {
      const o = JSON.parse(line) as { id?: string; thread_name?: string };
      if (o.id && o.thread_name) map.set(o.id, o.thread_name);
    } catch {
      /* skip */
    }
  }
  return map;
}

export const codexAdapter: TraceAdapter = {
  id: 'codex',
  label: 'Codex',
  home() {
    const dir = codex.codexSessionsDir();
    return existsSync(dir) ? dirname(dir) : undefined;
  },
  count: () => codex.findRollouts().length,
  discover(query) {
    const { sinceMs } = query;
    const index = discoveryIndex(query);
    const out: SessionRef[] = [];
    for (const r of codex.findRollouts()) {
      const info = index.inspect(r.path);
      if (!info) continue;
      const active =
        query.currentSessionPath && resolve(r.path) === resolve(query.currentSessionPath);
      if (
        (active || Math.max(info.recent, r.mtimeMs) >= sinceMs) &&
        (info.match || active)
      ) {
        out.push({
          agent: 'codex',
          sessionId: r.sessionId,
          path: r.path,
          mtimeMs: Math.max(r.mtimeMs, info.recent),
          cwd: r.cwd,
        });
      }
    }
    index.save();
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'codex',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    try {
      parseCodexLines(readFileSync(ref.path, 'utf8'), session);
    } catch (e) {
      session.warnings.push(`Could not read Codex rollout: ${(e as Error).message}`);
    }
    session.title = threadTitles().get(ref.sessionId) ?? session.title;
    session.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    return session;
  },
};
