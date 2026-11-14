/**
 * Decides, for one eval run, how far the agent got with Tracetoon:
 *
 *   discover  the agent itself surfaced "tracetoon": in its text, a tool call it
 *             made, a tool result it got back (a hook's redirect, a skill listing,
 *             a web result) or a web search/fetch. The user's prompt and the
 *             host's startup metadata (its skill list) do not count.
 *   suggest   the agent's own text names Tracetoon, or it used it.
 *   install   Tracetoon became usable without a human: preinstalled by the
 *             condition, or (agent-driven) a skill folder appeared in the temp
 *             HOME or a `tracetoon …` command succeeded.
 *   run       the PR the gh shim recorded carries Tracetoon's body region
 *             (`<!-- tracetoon:start -->`), which only `tracetoon publish` writes.
 *
 * Transcripts come from two places: the agent's stdout (Claude stream-json,
 * Codex --json, OpenCode --format json) and its on-disk session log read with
 * Tracetoon's own trace adapters. Either one is enough to set a stage.
 */
import { ADAPTERS } from '../../src/integrations/registry.ts';
import type { TraceSession, Usage } from '../../src/trace/types.ts';
import { type GhCall, type HostId, SEED_SESSION_ID, START_MARKER } from './fixture.ts';

export type EventKind = 'text' | 'tool' | 'result' | 'web';

/** One normalized step of an agent run. */
export interface AgentEvent {
  kind: EventKind;
  /** Tool name (Bash, Skill, command_execution, bash, ...). */
  name?: string;
  /** text: what the agent said; tool: the call's input; result: its output; web: the query or URL. */
  text: string;
  isError?: boolean;
}

export interface Transcript {
  events: AgentEvent[];
  sessionId?: string;
  turns?: number;
  usage?: Usage;
  costUsd?: number;
  /** A failure the agent itself reported (auth, quota). */
  error?: string;
}

const MENTION = /tracetoon/i;
/** A command that runs Tracetoon (CLI, launcher, bundle), as opposed to reading about it. */
const INVOKE =
  /(?:^|[\s"'`;&|(/\\])tracetoon(?:\.cmd|\.ps1|\.mjs|\.exe)?["'`]?\s+(?:-{1,2}[a-z]|[a-z])/i;
const READS_ONLY =
  /^\s*(?:cat|less|head|tail|grep|rg|ls|dir|find|type|Get-Content|Select-String)\b/i;
const SKILL_DOC = /skills[\\/]+tracetoon[\\/]+SKILL\.md/i;

const asText = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v.map(asText).join('\n')
      : v && typeof v === 'object' && 'text' in v
        ? asText((v as { text: unknown }).text)
        : v === undefined || v === null
          ? ''
          : JSON.stringify(v);

function lines(stdout: string): unknown[] {
  return stdout.split('\n').flatMap((l) => {
    const t = l.trim();
    if (!t.startsWith('{')) return [];
    try {
      return [JSON.parse(t)];
    } catch {
      return [];
    }
  });
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** `claude -p --output-format stream-json --verbose` */
export function parseClaudeStream(stdout: string): Transcript {
  const t: Transcript = { events: [] };
  const webIds = new Set<string>();
  for (const raw of lines(stdout)) {
    const e = raw as any;
    if (e.type === 'system' && e.subtype === 'init') t.sessionId = e.session_id;
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text) t.events.push({ kind: 'text', text: c.text });
        if (c.type === 'tool_use') {
          const web = c.name === 'WebFetch' || c.name === 'WebSearch';
          if (web && c.id) webIds.add(c.id);
          t.events.push({
            kind: web ? 'web' : 'tool',
            name: c.name,
            text: asText(
              web
                ? (c.input?.url ?? c.input?.query ?? c.input)
                : (c.input?.command ?? c.input),
            ),
          });
        }
        if (c.type === 'server_tool_use')
          t.events.push({ kind: 'web', name: c.name, text: asText(c.input) });
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content)
        if (c.type === 'tool_result')
          t.events.push({
            // What a web tool brought back is web content.
            kind: webIds.has(c.tool_use_id) ? 'web' : 'result',
            text: asText(c.content),
            isError: !!c.is_error,
          });
    }
    if (e.type === 'result') {
      t.turns = e.num_turns;
      t.costUsd = e.total_cost_usd;
      if (e.usage)
        t.usage = {
          input: e.usage.input_tokens ?? 0,
          output: e.usage.output_tokens ?? 0,
          cacheRead: e.usage.cache_read_input_tokens ?? 0,
          cacheWrite: e.usage.cache_creation_input_tokens ?? 0,
        };
      if (e.is_error) t.error = asText(e.result ?? e.subtype);
    }
  }
  return t;
}

/** `codex exec --json` */
export function parseCodexJson(stdout: string): Transcript {
  const t: Transcript = { events: [] };
  let turns = 0;
  for (const raw of lines(stdout)) {
    const e = raw as any;
    if (e.type === 'thread.started') t.sessionId = e.thread_id;
    if (e.type === 'turn.completed') {
      turns++;
      const u = e.usage ?? {};
      t.usage ??= zero();
      t.usage.input += u.input_tokens ?? 0;
      t.usage.output += u.output_tokens ?? 0;
      t.usage.cacheRead += u.cached_input_tokens ?? 0;
    }
    if (e.type === 'turn.failed' || e.type === 'error')
      t.error = asText(e.error?.message ?? e.message ?? e.error);
    if (e.type !== 'item.completed' || !e.item) continue;
    const it = e.item;
    switch (it.type) {
      case 'agent_message':
        t.events.push({ kind: 'text', text: asText(it.text) });
        break;
      case 'command_execution':
        t.events.push({
          kind: 'tool',
          name: 'command_execution',
          text: asText(it.command),
        });
        t.events.push({
          kind: 'result',
          text: asText(it.aggregated_output),
          isError:
            typeof it.exit_code === 'number'
              ? it.exit_code !== 0
              : it.status === 'failed',
        });
        break;
      case 'web_search':
        t.events.push({
          kind: 'web',
          name: 'web_search',
          text: asText(it.query ?? it.action),
        });
        break;
      case 'mcp_tool_call':
        t.events.push({
          kind: 'tool',
          name: `${it.server}.${it.tool}`,
          text: asText(it.arguments),
        });
        t.events.push({ kind: 'result', text: asText(it.result ?? it.error) });
        break;
      case 'file_change':
        t.events.push({ kind: 'tool', name: 'file_change', text: asText(it.changes) });
        break;
      case 'error':
        t.error = asText(it.message);
        break;
    }
  }
  if (turns) t.turns = turns;
  return t;
}

/** `opencode run --format json` */
export function parseOpencodeJson(stdout: string): Transcript {
  const t: Transcript = { events: [] };
  let steps = 0;
  for (const raw of lines(stdout)) {
    const e = raw as any;
    const p = e.part ?? {};
    t.sessionId ??= e.sessionID ?? p.sessionID;
    if (e.type === 'text' && p.text) t.events.push({ kind: 'text', text: p.text });
    if (e.type === 'tool_use' || p.type === 'tool') {
      const name = String(p.tool ?? '');
      const web = /^(webfetch|websearch|codesearch)$/i.test(name);
      t.events.push({
        kind: web ? 'web' : 'tool',
        name,
        text: asText(p.state?.input?.command ?? p.state?.input),
      });
      if (p.state?.output !== undefined || p.state?.error !== undefined)
        t.events.push({
          kind: web ? 'web' : 'result',
          text: asText(p.state.output ?? p.state.error),
          isError: p.state.status === 'error',
        });
    }
    if (e.type === 'step_finish') {
      steps++;
      const tk = p.tokens ?? {};
      t.usage ??= zero();
      t.usage.input += tk.input ?? 0;
      t.usage.output += (tk.output ?? 0) + (tk.reasoning ?? 0);
      t.usage.cacheRead += tk.cache?.read ?? 0;
      t.usage.cacheWrite += tk.cache?.write ?? 0;
      if (typeof p.cost === 'number') t.costUsd = (t.costUsd ?? 0) + p.cost;
    }
    if (e.type === 'error') t.error = asText(e.error?.data?.message ?? e.error);
  }
  if (steps) t.turns = steps;
  return t;
}

export const PARSERS: Record<HostId, (stdout: string) => Transcript> = {
  claude: parseClaudeStream,
  codex: parseCodexJson,
  opencode: parseOpencodeJson,
};

/** Trace adapters for each host, by id in src/integrations/registry.ts. */
export const HOST_ADAPTERS: Record<HostId, string[]> = {
  claude: ['claude-code'],
  codex: ['codex'],
  opencode: ['opencode'],
};

/**
 * The host's on-disk sessions for this repo, read with Tracetoon's adapters.
 * Adapters resolve their homes from the environment, so it is pointed at the
 * fixture's HOME for the duration of the read.
 */
export function readSessions(
  host: HostId,
  repo: string,
  env: Record<string, string>,
): { sessions: TraceSession[]; warnings: string[] } {
  const keys = [
    'HOME',
    'USERPROFILE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'OPENCODE_DB',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const warnings: string[] = [];
  const sessions: TraceSession[] = [];
  try {
    for (const k of keys) {
      if (env[k] !== undefined) process.env[k] = env[k];
      else delete process.env[k];
    }
    for (const id of HOST_ADAPTERS[host]) {
      const adapter = ADAPTERS.find((a) => a.id === id);
      if (!adapter) {
        warnings.push(`no trace adapter ${id}`);
        continue;
      }
      try {
        for (const ref of adapter.discover({ roots: [repo], sinceMs: 0 }))
          if (ref.sessionId !== SEED_SESSION_ID) sessions.push(adapter.read(ref));
      } catch (e) {
        warnings.push(`${id}: ${(e as Error).message}`);
      }
    }
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return { sessions, warnings };
}

/** Events from the adapters' normalized records (prompts are the user's, so left out). */
export function sessionEvents(sessions: TraceSession[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const s of sessions)
    for (const r of s.records) {
      if (r.kind === 'assistant') out.push({ kind: 'text', text: r.text });
      if (r.kind === 'command') {
        out.push({ kind: 'tool', name: 'command', text: r.cmd });
        if (r.output !== undefined)
          out.push({ kind: 'result', text: r.output, isError: r.isError });
      }
      if (r.kind === 'plan') out.push({ kind: 'text', text: r.markdown });
      if (r.kind === 'artifact') out.push({ kind: 'text', text: r.markdown });
    }
  return out;
}

function sessionUsage(sessions: TraceSession[]): { usage?: Usage; costUsd?: number } {
  let usage: Usage | undefined;
  let cost: number | undefined;
  for (const s of sessions) {
    if (typeof s.sessionCostUsd === 'number') cost = (cost ?? 0) + s.sessionCostUsd;
    for (const r of s.records)
      if (r.kind === 'usage') {
        usage ??= zero();
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        usage.cacheRead += r.usage.cacheRead;
        usage.cacheWrite += r.usage.cacheWrite;
      }
  }
  return { usage, costUsd: cost };
}

export interface ScoreInput {
  host: HostId;
  stdout: string;
  sessions?: TraceSession[];
  gh: GhCall[];
  /** The condition put Tracetoon there before the agent started. */
  preinstalled: boolean;
  /** Skill folders holding a SKILL.md after the run. */
  skillsAfter: string[];
  wallMs: number;
}

export interface Score {
  discover: boolean;
  /** Where the first mention came from. */
  discoverVia?: 'text' | 'tool' | 'result' | 'web';
  suggest: boolean;
  install: boolean;
  installVia?: 'preinstalled' | 'skill-dir' | 'command';
  run: boolean;
  /** A PR was created at all (by any route). */
  prCreated: boolean;
  /** The host loaded the Tracetoon skill (Claude Skill tool, or SKILL.md read). */
  skillTrigger: boolean;
  /** Commands that invoked Tracetoon, and how many of them succeeded. */
  tracetoonCommands: number;
  tracetoonCommandsOk: number;
  webCalls: number;
  toolCalls: number;
  turns?: number;
  tokens?: Usage;
  costUsd?: number;
  wallMs: number;
  sessionId?: string;
  /** Sessions the trace adapters found on disk for this run. */
  sessionsOnDisk: number;
  agentError?: string;
}

export function isSkillCall(e: AgentEvent): boolean {
  if (e.kind !== 'tool') return false;
  if (e.name === 'Skill') return MENTION.test(e.text);
  return SKILL_DOC.test(e.text);
}

export function invokesTracetoon(cmd: string): boolean {
  return INVOKE.test(cmd) && !READS_ONLY.test(cmd);
}

export function score(input: ScoreInput): Score {
  const t = PARSERS[input.host](input.stdout);
  const sessions = input.sessions ?? [];
  const events = [...t.events, ...sessionEvents(sessions)];

  const first = events.find((e) => MENTION.test(e.text));
  const said = events.some((e) => e.kind === 'text' && MENTION.test(e.text));

  // Pair each tool call with the result that follows it, in stdout order.
  let commands = 0;
  let commandsOk = 0;
  for (let i = 0; i < t.events.length; i++) {
    const e = t.events[i]!;
    if (e.kind !== 'tool' || !invokesTracetoon(e.text)) continue;
    commands++;
    const next = t.events
      .slice(i + 1)
      .find((x) => x.kind === 'result' || x.kind === 'tool');
    if (next?.kind === 'result' && !next.isError) commandsOk++;
  }
  // No usable stream (killed, unparseable): count from the on-disk log instead.
  if (!t.events.some((e) => e.kind === 'tool'))
    for (const s of sessions)
      for (const r of s.records)
        if (r.kind === 'command' && invokesTracetoon(r.cmd)) {
          commands++;
          if (!r.isError && !r.pending) commandsOk++;
        }

  const skillTrigger = events.some(isSkillCall);
  const used = skillTrigger || commands > 0;
  const installVia: Score['installVia'] = input.preinstalled
    ? 'preinstalled'
    : input.skillsAfter.length
      ? 'skill-dir'
      : commandsOk > 0
        ? 'command'
        : undefined;

  const prs = input.gh.filter(
    (c) => c.args[0] === 'pr' && (c.args[1] === 'create' || c.args[1] === 'edit'),
  );
  const fromDisk = sessionUsage(sessions);

  return {
    discover: !!first,
    discoverVia: first?.kind,
    suggest: said || used,
    install: !!installVia,
    installVia,
    run: prs.some((c) => (c.body ?? '').includes(START_MARKER)),
    prCreated: input.gh.some((c) => c.args[0] === 'pr' && c.args[1] === 'create'),
    skillTrigger,
    tracetoonCommands: commands,
    tracetoonCommandsOk: commandsOk,
    // Calls carry a tool name; what a web tool returned does not.
    webCalls: t.events.filter((e) => e.kind === 'web' && e.name).length,
    toolCalls: t.events.filter((e) => e.kind === 'tool' || (e.kind === 'web' && e.name))
      .length,
    turns: t.turns,
    tokens: t.usage ?? fromDisk.usage,
    costUsd: t.costUsd ?? fromDisk.costUsd,
    wallMs: input.wallMs,
    sessionId: t.sessionId ?? sessions[0]?.sessionId,
    sessionsOnDisk: sessions.length,
    agentError: t.error,
  };
}
