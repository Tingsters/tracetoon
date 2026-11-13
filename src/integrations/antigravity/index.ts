/**
 * Antigravity (CLI `agy` and IDE): ~/.gemini, or GEMINI_HOME. Hooks go in a named
 * "tracetoon" block of ~/.gemini/config/hooks.json; payloads are camelCase
 * (`toolCall.args.CommandLine`, `conversationId`, `transcriptPath`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { prePrIn } from '../../hook/config.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookPayload, Integration, Json } from '../types.ts';
import { antigravityCliAdapter, antigravityIdeAdapter } from './trace.ts';

const gemini = (h: string, env: Env) => env.GEMINI_HOME || join(h, '.gemini');
const present = (h: string, env: Env) =>
  existsSync(join(gemini(h, env), 'antigravity-cli')) ||
  existsSync(join(gemini(h, env), 'antigravity-ide'));

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const HANDLER_EVENTS = new Set([
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'Stop',
]);

/**
 * Named blocks in Antigravity's hooks.json that Antigravity will reject. One bad
 * block makes it ignore the whole file, Tracetoon's hook included, so this is
 * worth telling the user about. Tool events take matcher blocks with a `hooks`
 * list; the other events take handlers (with `command`) directly.
 */
export function antigravityInvalidBlocks(data: Json): string[] {
  const bad: string[] = [];
  for (const [name, block] of Object.entries(data)) {
    if (!block || typeof block !== 'object') {
      bad.push(name);
      continue;
    }
    const handlerOk = (h: unknown) => !!h && typeof (h as Json).command === 'string';
    const ok = Object.entries(block as Json).every(([event, list]) => {
      if (event === 'enabled') return typeof list === 'boolean';
      if (!Array.isArray(list))
        return !TOOL_EVENTS.has(event) && !HANDLER_EVENTS.has(event);
      if (TOOL_EVENTS.has(event))
        return list.every((m) => m && Array.isArray(m.hooks) && m.hooks.every(handlerOk));
      if (HANDLER_EVENTS.has(event)) return list.every(handlerOk);
      return true;
    });
    if (!ok) bad.push(name);
  }
  return bad;
}

const othersInvalid = (data: Json) =>
  antigravityInvalidBlocks(data).filter((n) => n !== 'tracetoon');

const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

function parse(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  const call = p.toolCall ?? p.tool_call;
  if (
    !call &&
    !('conversationId' in p) &&
    !('workspacePaths' in p) &&
    !('transcriptPath' in p)
  )
    return undefined;
  const args = call?.args;
  const toolInput: Json =
    typeof args === 'string'
      ? { input: args }
      : args && typeof args === 'object'
        ? args
        : {};
  let command: unknown = toolInput.CommandLine;
  if (typeof command === 'string' && /^\s*".*"\s*$/s.test(command)) {
    try {
      const unwrapped = JSON.parse(command); // the IDE double-encodes args
      if (typeof unwrapped === 'string') command = unwrapped;
    } catch {
      /* keep as is */
    }
  }
  return {
    command: str(command),
    cwd: str(toolInput.Cwd) ?? str(p.cwd) ?? str(p.workspace),
    sessionId: str(p.conversationId),
    transcript: str(p.transcriptPath),
    toolName: str(call?.name),
    toolInput,
    workspaceRoots: Array.isArray(p.workspacePaths)
      ? p.workspacePaths.filter((w: unknown) => typeof w === 'string')
      : [],
    planMode: p.permissionMode === 'plan',
    subagent: !!(p.is_subagent || p.parent_session_id),
  };
}

export const integration: Integration = {
  id: 'antigravity',
  label: 'Antigravity',
  status: 'supported',
  traces: [antigravityCliAdapter, antigravityIdeAdapter],
  hook: {
    file: (h, env) => join(gemini(h, env), 'config', 'hooks.json'),
    present,
    apply(data, commands) {
      const out = { ...data };
      delete out.tracetoon;
      if (commands) {
        const handler = (event: string) => ({
          type: 'command',
          command: commands.lifecycle(event),
          timeout: 10,
        });
        out.tracetoon = {
          enabled: true,
          PreToolUse: [
            {
              matcher: 'run_command',
              hooks: [{ type: 'command', command: commands.prePr }],
            },
            { matcher: '.*', hooks: [handler('PreToolUse')] },
          ],
          SessionStart: [handler('SessionStart')],
          PostToolUse: [{ matcher: '.*', hooks: [handler('PostToolUse')] }],
        };
      }
      return out;
    },
    installedCommand: (data) => prePrIn(data.tracetoon?.PreToolUse),
    parse,
    deny: (reason) => JSON.stringify({ decision: 'deny', reason }),
    installNote(_file, data) {
      const bad = othersInvalid(data);
      return bad.length
        ? `Warning: Antigravity ignores this whole file because of an invalid block from another tool (${bad.join(', ')}). Fix or remove it to activate the hook.`
        : 'Restart the Antigravity IDE to load it.';
    },
    problem(_file, data) {
      const bad = othersInvalid(data);
      return bad.length
        ? `Antigravity ignores the whole hooks file because of an invalid block from another tool (${bad.join(', ')}); fix or remove it to activate the hook`
        : undefined;
    },
  },
  skill: (h, env) => ({
    present: present(h, env) || !!onPath('agy', env),
    dir: join(gemini(h, env), 'config', 'skills', 'tracetoon'),
  }),
};
