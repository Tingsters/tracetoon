/**
 * The hook protocol Claude Code introduced and other hosts copied (Codex, Factory
 * Droid): `hooks.<Event>` lists of `{ matcher, hooks: [{ type, command }] }`
 * groups, snake_case payloads (`tool_input`, `session_id`, `transcript_path`), and
 * `hookSpecificOutput.permissionDecision` answers. Hosts that speak it build
 * their integration from these helpers instead of from each other.
 */
import type { HookCommands, HookPayload, Json } from '../integrations/types.ts';
import { prePrIn, withoutOurGroups } from './config.ts';

/**
 * Tracetoon's entries in a Claude-style config: PR routing on the shell tool
 * (`matcher`), plus passive SessionStart, PreToolUse and PostToolUse observers.
 * Stop entries from older releases are removed.
 */
export function applyClaudeStyle(
  data: Json,
  commands: HookCommands | undefined,
  matcher: string,
  /** `top`: the file is only the event map (Factory's hooks.json), not `{ hooks: {...} }`. */
  layout: 'nested' | 'top' = 'nested',
): Json {
  if (layout === 'top')
    return applyClaudeStyle({ hooks: data }, commands, matcher).hooks ?? {};
  const handler = (event: string) => ({
    type: 'command',
    command: commands!.lifecycle(event),
    timeout: 10,
  });
  const hooks: Json = { ...(data.hooks ?? {}) };
  const pre = withoutOurGroups(hooks.PreToolUse);
  if (commands)
    pre.push(
      { matcher, hooks: [{ type: 'command', command: commands.prePr, timeout: 10 }] },
      { matcher: '.*', hooks: [handler('PreToolUse')] },
    );
  if (pre.length) hooks.PreToolUse = pre;
  else delete hooks.PreToolUse;
  for (const event of ['SessionStart', 'PostToolUse', 'Stop']) {
    const kept = withoutOurGroups(hooks[event]);
    if (commands && event !== 'Stop')
      kept.push(
        event === 'PostToolUse'
          ? { matcher: '.*', hooks: [handler(event)] }
          : { hooks: [handler(event)] },
      );
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  const out = { ...data };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

export const installedClaudeStyle = (data: Json, layout: 'nested' | 'top' = 'nested') =>
  prePrIn((layout === 'top' ? data : data.hooks)?.PreToolUse);

const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

/** A Claude-style payload, or undefined when the payload has none of its fields. */
export function parseClaudeStyle(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (
    !('tool_input' in p) &&
    !('tool_name' in p) &&
    !('session_id' in p) &&
    !('hook_event_name' in p) &&
    !('transcript_path' in p)
  )
    return undefined;
  const rawInput = p.tool_input;
  const toolInput: Json =
    typeof rawInput === 'string'
      ? { input: rawInput }
      : rawInput && typeof rawInput === 'object'
        ? rawInput
        : {};
  return {
    command: str(toolInput.command),
    cwd: str(toolInput.workdir) ?? str(toolInput.cwd) ?? str(p.cwd) ?? str(p.workspace),
    sessionId: str(p.session_id),
    transcript: str(p.transcript_path),
    toolName: str(p.tool_name),
    toolInput,
    workspaceRoots: [],
    planMode: p.permission_mode === 'plan',
    subagent: !!(p.is_subagent || p.parent_session_id),
  };
}

export const denyClaudeStyle = (reason: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
