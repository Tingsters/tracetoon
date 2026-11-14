/**
 * JetBrains Junie (CLI) sessions: ~/.junie/sessions/<id>/ (JUNIE_HOME replaces
 * ~/.junie for Tracetoon), listed in sessions/index.jsonl with the
 * `projectDir` each one worked in.
 *
 * `events.jsonl` holds `{ kind, event: { agentEvent }, timestampMs }` lines.
 * Junie re-sends a block each time its status changes and repeats finished
 * blocks at the end, so only the last COMPLETED version of each `stepId` counts:
 * `FileChangesBlockUpdatedEvent` (whole `beforeContent` / `afterContent` per
 * file), `TerminalBlockUpdatedEvent` (`command`, `output`, `exitCode`) and
 * `ResultBlockUpdatedEvent` (the final summary). The prompt isn't an event: it
 * is the issue description inside state.json's `blob`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { splitLines } from '../../trace/diffLines.ts';
import { discoveryIndex } from '../../trace/discovery.ts';
import type { SessionRef, TraceAdapter, TraceSession } from '../../trace/types.ts';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length ? v : undefined;

export const junieHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.JUNIE_HOME || join(homedir(), '.junie');

/** Events that carry nothing for a PR description. */
const IGNORED = new Set([
  'AgentCurrentStatusUpdatedEvent',
  'CurrentDirectoryUpdatedEvent',
  'EnvironmentVariablesUpdatedEvent',
  'LlmResponseMetadataEvent',
  'TipSuggestionCreatedEvent',
  'AgentTaskNameUpdatedEvent',
  'ToolBlockUpdatedEvent',
  'ContextWindowReportEvent',
  'AgentPatchCreatedEvent',
  'AgentStateUpdatedEvent',
]);

/** The lines that differ between two versions of a file, trimming shared ends. */
export function changedLines(before: string, after: string) {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return {
    removed: a.slice(start, a.length - end),
    added: b.slice(start, b.length - end),
  };
}

/** Parse one session's events into records. Exported for tests. */
export function parseJunieEvents(
  content: string,
  into: TraceSession,
  cwd?: string,
  prompts: string[] = [],
): void {
  // The last COMPLETED version of each step, in the order steps first appeared.
  const steps = new Map<string, { kind: string; ts?: string; e: Obj }>();
  let firstTs: string | undefined;
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
    const ts =
      typeof o.timestampMs === 'number'
        ? new Date(o.timestampMs).toISOString()
        : undefined;
    firstTs ??= ts;
    if (o.kind === 'TaskStartedEvent' || o.kind === 'TaskState') continue;
    const e = o.event?.agentEvent;
    if (o.kind !== 'SessionA2uxEvent' || !isObj(e)) {
      const t = str(o.kind) ?? '?';
      into.unknownTypes[t] = (into.unknownTypes[t] ?? 0) + 1;
      continue;
    }
    const kind = str(e.kind) ?? '?';
    if (IGNORED.has(kind)) continue;
    if (
      kind === 'FileChangesBlockUpdatedEvent' ||
      kind === 'TerminalBlockUpdatedEvent' ||
      kind === 'ResultBlockUpdatedEvent'
    ) {
      const id = str(e.stepId) ?? `${kind}:${steps.size}`;
      const done =
        e.status === undefined ||
        e.status === 'COMPLETED' ||
        kind === 'ResultBlockUpdatedEvent';
      const seen = steps.get(id);
      if (!seen) steps.set(id, { kind, ts, e });
      else if (done) steps.set(id, { kind, ts: seen.ts, e });
      continue;
    }
    if (kind === 'AgentPlanUpdatedEvent') continue;
    into.unknownTypes[kind] = (into.unknownTypes[kind] ?? 0) + 1;
  }
  for (const text of prompts)
    if (!isSyntheticPrompt(text))
      into.records.push({ kind: 'prompt', text, ts: firstTs, cwd });
  for (const { kind, ts, e } of steps.values()) {
    if (kind === 'FileChangesBlockUpdatedEvent') {
      if (e.status && e.status !== 'COMPLETED') continue; // never finished
      for (const c of Array.isArray(e.changes) ? e.changes.filter(isObj) : []) {
        const file = str(c.afterAbsolutePath) ?? str(c.beforeAbsolutePath);
        const after = str(c.afterContent?.text);
        if (!file || after === undefined) continue;
        const before = str(c.beforeContent?.text);
        const { added, removed } = changedLines(before ?? '', after);
        into.records.push({
          kind: 'edit',
          file,
          added,
          removed,
          ...(before === undefined ? { created: true } : {}),
          ts,
          cwd,
        });
      }
    } else if (kind === 'TerminalBlockUpdatedEvent' && str(e.command)) {
      const finished = e.status === 'COMPLETED' || e.status === 'FAILED';
      into.records.push({
        kind: 'command',
        cmd: e.command,
        ts,
        cwd,
        ...(finished ? {} : { pending: true }),
        ...(e.status === 'FAILED' || (typeof e.exitCode === 'number' && e.exitCode !== 0)
          ? { isError: true }
          : {}),
        ...(str(e.output) ? { output: e.output.slice(0, 4000) } : {}),
      });
    } else if (kind === 'ResultBlockUpdatedEvent' && str(e.result) && !e.cancelled) {
      into.records.push({ kind: 'assistant', text: e.result.trim(), ts, cwd });
    }
  }
}

/** The prompts a session was given, oldest first, from state.json. */
export function juniePrompts(stateText: string): string[] {
  try {
    const state = JSON.parse(stateText);
    const blob = state?.event?.agentEvent?.blob;
    const inner = typeof blob === 'string' ? JSON.parse(blob) : blob;
    const previous: unknown[] = Array.isArray(inner?.previousPromptDescriptions)
      ? inner.previousPromptDescriptions
      : [];
    const current = str(inner?.lastAgentState?.issue?.description);
    return [...previous, current]
      .map((p) => (isObj(p) ? str(p.description) : str(p)))
      .filter((p): p is string => !!p)
      .filter((p, i, all) => all.indexOf(p) === i);
  } catch {
    return [];
  }
}

interface Found {
  path: string;
  sessionId: string;
  mtimeMs: number;
  cwd?: string;
}

function sessions(): Found[] {
  const root = join(junieHome(), 'sessions');
  if (!existsSync(root)) return [];
  const projects = new Map<string, string>();
  try {
    for (const line of readFileSync(join(root, 'index.jsonl'), 'utf8').split(/\r?\n/)) {
      try {
        const o = JSON.parse(line);
        if (str(o?.sessionId) && str(o?.projectDir))
          projects.set(o.sessionId, o.projectDir);
      } catch {
        /* a partial line */
      }
    }
  } catch {
    /* no index: the events still name their paths */
  }
  const out: Found[] = [];
  for (const id of readdirSync(root)) {
    const path = join(root, id, 'events.jsonl');
    try {
      out.push({
        path,
        sessionId: id,
        mtimeMs: statSync(path).mtimeMs,
        cwd: projects.get(id),
      });
    } catch {
      /* not a session folder */
    }
  }
  return out;
}

export const junieAdapter: TraceAdapter = {
  id: 'junie',
  label: 'Junie',
  home: () => (existsSync(join(junieHome(), 'sessions')) ? junieHome() : undefined),
  count: () => sessions().length,
  discover(query) {
    const index = discoveryIndex(query, 'junie');
    const out: SessionRef[] = [];
    for (const f of sessions()) {
      const info = index.inspect(f.path);
      if (!info) continue;
      // A session that only ran commands may never name the repository in its
      // events, but the index records the project it worked in.
      const inRoot =
        !!f.cwd &&
        query.roots.some((r) => {
          const a = resolve(f.cwd!).toLowerCase();
          const b = resolve(r).toLowerCase();
          return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
        });
      if (Math.max(info.recent, f.mtimeMs) >= query.sinceMs && (info.match || inRoot))
        out.push({
          agent: 'junie',
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
      agent: 'junie',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    let prompts: string[] = [];
    try {
      prompts = juniePrompts(readFileSync(join(dirname(ref.path), 'state.json'), 'utf8'));
    } catch {
      /* no state yet */
    }
    try {
      parseJunieEvents(readFileSync(ref.path, 'utf8'), session, ref.cwd, prompts);
    } catch (e) {
      session.warnings.push(`Could not read Junie session: ${(e as Error).message}`);
    }
    return session;
  },
};
