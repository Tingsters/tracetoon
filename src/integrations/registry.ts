/**
 * Every host Tracetoon integrates with. This is the only module that imports
 * the host folders; everything else asks the registry.
 */
import { homedir } from 'node:os';
import type { TraceAdapter } from '../trace/types.ts';
import type { Env, HookPayload, Integration } from './types.ts';
import { integration as claude } from './claude-code/index.ts';
import { integration as codex } from './codex/index.ts';
import { integration as antigravity } from './antigravity/index.ts';
import { integration as geminiCli } from './gemini-cli/index.ts';
import { integration as factory } from './factory/index.ts';
import { integration as copilot } from './copilot/index.ts';
import { integration as cursor } from './cursor/index.ts';
import { integration as opencode } from './opencode/index.ts';
import { integration as kilo } from './kilo/index.ts';
import { integration as kiro } from './kiro/index.ts';
import { integration as cline } from './cline/index.ts';
import { integration as junie } from './junie/index.ts';
import { integration as devin } from './devin/index.ts';
import { integration as goose } from './goose/index.ts';
import { integration as qwen } from './qwen/index.ts';
import { integration as crush } from './crush/index.ts';

/** In display order. Hook targets, skill installs and doctor follow it. */
export const INTEGRATIONS: readonly Integration[] = [
  claude,
  codex,
  antigravity,
  factory,
  copilot,
  cursor,
  opencode,
  kilo,
  kiro,
  cline,
  junie,
  devin,
  goose,
  qwen,
  crush,
  geminiCli,
];

/**
 * Which host's session variable wins when several are set. A host started from
 * inside another one (Codex run from Claude Code) inherits the outer variables,
 * so the hosts most often nested come first.
 */
const SESSION_ORDER = ['codex', 'factory', 'copilot', 'cursor', 'kiro', 'claude'];

export const ADAPTERS: TraceAdapter[] = INTEGRATIONS.flatMap((i) => i.traces);

/** Hosts with a hook, by the id their installed hooks pass as `--agent`. */
export const HOOK_IDS: string[] = INTEGRATIONS.filter((i) => i.hook).map((i) => i.id);

export function integration(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

/** The display name for a trace surface id (`claude-code`, `antigravity-ide`, ...). */
export function traceLabel(agentId: string): string {
  return ADAPTERS.find((a) => a.id === agentId)?.label ?? agentId;
}

/** The host session this process runs in, from the environment hosts give tool calls. */
export function currentSessionId(env: Env = process.env): string | undefined {
  const ordered = [
    ...SESSION_ORDER.map(integration).filter((i): i is Integration => !!i),
    ...INTEGRATIONS.filter((i) => !SESSION_ORDER.includes(i.id)),
  ];
  for (const i of ordered)
    for (const name of i.sessionEnv ?? []) if (env[name]) return env[name];
  return undefined;
}

/** A variable some host sets to describe its own session, not the code under test. */
export function isHostSessionVar(name: string): boolean {
  return name === 'AI_AGENT' || INTEGRATIONS.some((i) => i.hostEnv?.test(name));
}

/**
 * The host that sent a hook payload. Usually the one the hook was registered
 * for; but some hosts also run hooks registered for another (Copilot and Cursor
 * read Claude Code's settings), so a payload in another host's shape is answered
 * in that host's format. Undefined when no host recognizes it.
 */
export function resolveHookHost(
  declared: string,
  raw: unknown,
): { host: Integration; payload: HookPayload } | undefined {
  const first = integration(declared);
  const order = [...(first ? [first] : []), ...INTEGRATIONS.filter((i) => i !== first)];
  for (const host of order) {
    const payload = host.hook?.parse(raw);
    if (payload) return { host, payload };
  }
  return undefined;
}

/** Where the skill goes for each host that is present, one entry per folder. */
export function skillTargets(
  home = homedir(),
  env: Env = process.env,
): { labels: string[]; dir: string }[] {
  const out: { labels: string[]; dir: string }[] = [];
  for (const i of INTEGRATIONS) {
    const t = i.skill?.(home, env);
    if (!t?.present) continue;
    const seen = out.find((o) => o.dir === t.dir);
    if (seen) seen.labels.push(i.label);
    else out.push({ labels: [i.label], dir: t.dir });
  }
  return out;
}

/** Every skill folder a host could use, present or not (for doctor and uninstall). */
export function allSkillDirs(
  home = homedir(),
  env: Env = process.env,
): { label: string; dir: string }[] {
  const out: { label: string; dir: string }[] = [];
  for (const i of INTEGRATIONS) {
    const t = i.skill?.(home, env);
    if (!t) continue;
    const seen = out.find((o) => o.dir === t.dir);
    if (!seen) out.push({ label: i.label, dir: t.dir });
  }
  return out;
}

/** Hosts we know about but can't read yet, for `doctor`. */
export const PLANNED: { id: string; label: string; envVar: string; dir: string }[] = [];
