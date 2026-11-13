/**
 * Codex's hook trust check, mirrored so `doctor` can tell when Codex would skip Tracetoon's hooks.
 *
 * Codex records each trusted hook in config.toml as
 *   [hooks.state.'<hooks.json path>:<event>:<group>:<handler>']
 *   trusted_hash = "sha256:…"
 * and runs a hook only while that hash equals the hash of the hook's current, normalized
 * declaration. A changed hook (a release that changes a matcher, timeout or argument, or an
 * install from another path) therefore leaves a stale record that Codex treats as "modified" and skips until the user
 * trusts it again in /hooks. The hash (codex-rs/hooks/src/engine/discovery.rs, `hook_hash`
 * and `version_for_toml`) is SHA-256 over compact JSON with sorted keys of
 *   { event_name, matcher?, hooks: [ normalized handler ] }.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOurs } from '../../hook/config.ts';
import type { Json } from '../types.ts';

/** Events whose matcher Codex keeps in the identity (`matcher_pattern_for_event`). */
const KEEPS_MATCHER = new Set([
  'pre_tool_use',
  'permission_request',
  'post_tool_use',
  'session_start',
  'session_end',
  'subagent_start',
  'subagent_stop',
  'pre_compact',
  'post_compact',
]);
/** Events that may carry additionalContextLimit; Codex drops it elsewhere. */
const CONTEXT_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'user_prompt_submit',
  'subagent_start',
]);
/** Codex's default additionalContext spill threshold, omitted from the identity. */
const DEFAULT_CONTEXT_LIMIT = 2500;
/** Session-end-like events normalize timeouts differently; Tracetoon installs none. */
const OTHER_TIMEOUTS = new Set(['session_end', 'interrupt']);

/** `PreToolUse` → `pre_tool_use`, Codex's key label. */
const eventLabel = (event: string) =>
  event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Json)[k])]),
    );
  return value;
}

/** Codex's trust hash for one command handler, or undefined when Tracetoon can't mirror it. */
export function codexHookHash(
  event: string,
  matcher: unknown,
  handler: Json,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const label = eventLabel(event);
  if (OTHER_TIMEOUTS.has(label) || handler?.type !== 'command') return undefined;
  const windows =
    typeof handler.commandWindows === 'string' ? handler.commandWindows : undefined;
  const command = platform === 'win32' && windows ? windows : handler.command;
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const timeout = typeof handler.timeout === 'number' ? handler.timeout : 600;
  const normalized: Json = {
    type: 'command',
    command,
    timeout: Math.max(1, timeout),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === 'string')
    normalized.statusMessage = handler.statusMessage;
  const limit = handler.additionalContextLimit;
  if (
    CONTEXT_EVENTS.has(label) &&
    typeof limit === 'number' &&
    limit !== DEFAULT_CONTEXT_LIMIT
  )
    normalized.additionalContextLimit = limit;
  const identity: Json = { event_name: label, hooks: [normalized] };
  if (KEEPS_MATCHER.has(label) && typeof matcher === 'string') identity.matcher = matcher;
  const json = JSON.stringify(sortKeys(identity));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

export interface HookState {
  trustedHash?: string;
  enabled?: boolean;
}

/** TOML string: '…' is literal; "…" takes the usual escapes. */
function tomlString(raw: string): string | undefined {
  if (raw.startsWith("'")) return raw.endsWith("'") ? raw.slice(1, -1) : undefined;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string; // the escapes Codex writes are JSON's
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The `[hooks.state.'<key>']` tables Codex writes, keyed by their key. */
export function readHookStates(toml: string): Map<string, HookState> {
  const states = new Map<string, HookState>();
  let current: HookState | undefined;
  for (const line of toml.split(/\r?\n/)) {
    const header =
      /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*('[^']*'|"(?:[^"\\]|\\.)*")\s*\]\s*(?:#.*)?$/.exec(
        line,
      );
    if (header) {
      const key = tomlString(header[1]!);
      current = key === undefined ? undefined : {};
      if (key !== undefined) states.set(key, current!);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const hash = /^\s*trusted_hash\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(line);
    if (hash) current.trustedHash = tomlString(hash[1]!);
    const enabled = /^\s*enabled\s*=\s*(true|false)\b/.exec(line);
    if (enabled) current.enabled = enabled[1] === 'true';
  }
  return states;
}

/** Compare paths the way they appear in Codex's keys (Windows: either slash, any case). */
const samePath = (a: string, b: string, platform: NodeJS.Platform) =>
  platform === 'win32'
    ? a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
    : a === b;

export type Trust = 'trusted' | 'untrusted' | 'modified' | 'disabled';

/**
 * How Codex sees each Tracetoon handler in hooks.json: trusted, never trusted, changed since it
 * was trusted, or turned off. Empty when Tracetoon has no handler there.
 */
export function codexTrust(
  file: string,
  data: Json,
  toml: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Trust[] {
  const states = readHookStates(toml ?? '');
  const byIndex = new Map<string, HookState>();
  for (const [key, state] of states) {
    const m = /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(key);
    if (m && samePath(m[1]!, file, platform))
      byIndex.set(`${m[2]}:${m[3]}:${m[4]}`, state);
  }
  const result: Trust[] = [];
  const hooks: Json = data?.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group: Json, g: number) => {
      if (!Array.isArray(group?.hooks)) return;
      group.hooks.forEach((handler: Json, h: number) => {
        if (!isOurs(handler?.command)) return;
        const current = codexHookHash(event, group.matcher, handler, platform);
        if (current === undefined) return;
        const state = byIndex.get(`${eventLabel(event)}:${g}:${h}`);
        if (state?.enabled === false) result.push('disabled');
        else if (!state?.trustedHash) result.push('untrusted');
        else result.push(state.trustedHash === current ? 'trusted' : 'modified');
      });
    });
  }
  return result;
}

/** The doctor problem for Codex's view of Tracetoon's hooks, if any. */
export function codexTrustProblem(file: string, data: Json): string | undefined {
  let toml: string | undefined;
  try {
    toml = readFileSync(join(dirname(file), 'config.toml'), 'utf8');
  } catch {
    toml = undefined;
  }
  const trust = codexTrust(file, data, toml);
  if (trust.includes('modified'))
    return 'changed since you trusted it, so Codex skips it: run /hooks in Codex and trust the Tracetoon hook again';
  if (trust.includes('untrusted'))
    return 'not trusted yet: run /hooks in Codex and trust the Tracetoon hook';
  if (trust.includes('disabled'))
    return 'turned off in Codex: run /hooks in Codex and turn the Tracetoon hook back on';
  return undefined;
}
