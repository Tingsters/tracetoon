/** Normalized, agent-neutral view of what happened in an agent session. */

export type AgentId = 'claude-code' | 'codex' | 'antigravity-cli' | 'antigravity-ide';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Fields every record may carry: when it happened and where the agent was. */
interface Base {
  ts?: string;
  cwd?: string;
  branch?: string;
  /** The model in effect when this happened, if the agent records it. */
  model?: string;
}

export type TraceRecord =
  | (Base & {
      kind: 'prompt';
      text: string;
      /** Written by a parent agent to a subagent, not typed by the user. */
      delegated?: boolean;
    })
  | (Base & { kind: 'assistant'; text: string })
  | (Base & { kind: 'plan'; markdown: string; approved?: boolean })
  | (Base & { kind: 'decision'; text: string })
  | (Base & {
      kind: 'edit';
      /** Absolute path of the edited file. */
      file: string;
      added: string[];
      removed: string[];
      created?: boolean;
    })
  | (Base & {
      kind: 'command';
      cmd: string;
      isError?: boolean;
      /** Start of the command's output. Used only for matching (e.g. commit SHAs); never shown. */
      output?: string;
    })
  | (Base & {
      kind: 'link';
      prUrl?: string;
      prNumber?: number;
      prRepository?: string;
      worktreePath?: string;
      worktreeBranch?: string;
    })
  | (Base & { kind: 'usage'; usage: Usage })
  | (Base & {
      kind: 'artifact';
      /** e.g. "walkthrough", "task", "implementation_plan". */
      name: string;
      markdown: string;
      /** The agent's own one-line summary of the artifact, when it keeps one. */
      summary?: string;
    });

export type RecordKind = TraceRecord['kind'];

/** A session log found on disk, before it is fully read. */
export interface SessionRef {
  agent: AgentId;
  sessionId: string;
  path: string;
  mtimeMs: number;
  cwd?: string;
}

export interface TraceSession {
  agent: AgentId;
  sessionId: string;
  source: string;
  title?: string;
  records: TraceRecord[];
  /** Whole-session cost reported by the agent, when it records one. */
  sessionCostUsd?: number;
  /** Record types this adapter did not recognize, with counts. */
  unknownTypes: Record<string, number>;
  warnings: string[];
  /** Set on a subagent's own log: the session that spawned it. */
  parentSessionId?: string;
}

export interface DiscoverQuery {
  /** Repository roots (main checkout plus worktrees). */
  roots: string[];
  /** Ignore logs last written before this time (ms since epoch). */
  sinceMs: number;
  /**
   * Extra strings that make a log relevant even if it never names a root: the
   * PR's short commit SHAs, which find sessions that worked in a deleted worktree.
   */
  needles?: string[];
}

export interface TraceAdapter {
  id: AgentId;
  label: string;
  /** Where this agent's logs live on this machine, or undefined if absent. */
  home(): string | undefined;
  /** How many session logs exist on this machine (for `doctor`). */
  count(): number;
  discover(q: DiscoverQuery): SessionRef[];
  read(ref: SessionRef): TraceSession;
}
