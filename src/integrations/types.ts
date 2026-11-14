/**
 * One integration per agent host (Claude Code, Codex, Antigravity, ...).
 *
 * Each host lives in its own folder under src/integrations/<host>/ and exports a
 * single `integration`. A host folder may import core modules (src/trace, src/hook,
 * src/util) but never another host's folder; only registry.ts imports them all.
 * tests/integrations.test.ts enforces this.
 */
import type { TraceAdapter } from '../trace/types.ts';

export type Json = Record<string, any>;
export type Env = NodeJS.ProcessEnv;

/** A host's hook payload, reduced to what Tracetoon needs. */
export interface HookPayload {
  /** The shell command the tool is about to run, if it is a shell tool. */
  command?: string;
  /** The working directory the host reports for the call or session. */
  cwd?: string;
  sessionId?: string;
  transcript?: string;
  /** The host's own tool name (for connector tools such as GitHub MCP servers). */
  toolName?: string;
  /** The tool's arguments, as an object. */
  toolInput: Record<string, any>;
  /** Workspace folders the host has open, most relevant first. */
  workspaceRoots: string[];
  /** The host is in plan mode: nothing is executed for real. */
  planMode: boolean;
  /** The call comes from a subagent, not the session the user talks to. */
  subagent: boolean;
}

/** The commands Tracetoon registers with a host. */
export interface HookCommands {
  /** `<program> hook pre-pr --agent <id>` */
  prePr: string;
  /** `<program> hook lifecycle --agent <id> --event <event>` */
  lifecycle(event: string): string;
  /**
   * The same commands as argument lists (program first, forward slashes, no
   * quoting), for hosts that start a program directly instead of through a
   * shell (Copilot's `exec` and `args`).
   */
  argv?: { prePr: string[]; lifecycle(event: string): string[] };
}

export interface HookIntegration {
  /** The config file Tracetoon edits for this host. No two hosts share one. */
  file(home: string, env: Env): string;
  /** Whether the host is installed on this machine. */
  present(home: string, env: Env): boolean;
  /**
   * The config with Tracetoon's entries added (commands) or removed (undefined).
   * Entries that are not Tracetoon's are kept as they are.
   */
  apply(data: Json, commands: HookCommands | undefined): Json;
  /** The installed pre-pr command, if Tracetoon's hook is in the config. */
  installedCommand(data: Json): string | undefined;
  /**
   * This host's payload in neutral form, or undefined when the payload is not in
   * this host's shape (another host ran a hook it inherited, for example).
   */
  parse(raw: unknown): HookPayload | undefined;
  /** The answer that blocks the tool call, in this host's format. */
  deny(reason: string): string;
  /**
   * For a host that ignores a JSON answer and blocks on the hook's exit status
   * (Kiro): the status to exit with. The `deny` text then goes to stderr, which
   * is what such hosts show the agent, instead of stdout.
   */
  blockExitCode?: number;
  /**
   * For a host whose hook is a source file Tracetoon owns outright (OpenCode's
   * plugins) rather than a JSON config: the whole file, and the pre-pr command a
   * written file runs. With `text`, the engine writes and removes the file
   * itself and `apply` / `installedCommand` are not used.
   */
  text?: {
    render(commands: HookCommands): string;
    command(text: string): string | undefined;
    /**
     * Further files Tracetoon owns beside the main one, by file name in the same
     * folder (Cline reads one script per event). Each must be recognized by
     * `command`, so a file of that name Tracetoon didn't write is never replaced.
     */
    siblings?: Record<string, (commands: HookCommands) => string>;
  };
  /** Something to tell the user after installing (a trust or restart step). */
  installNote?(file: string, data: Json): string | undefined;
  /** Something that stops an installed hook from running. */
  problem?(file: string, data: Json): string | undefined;
}

export interface SkillTarget {
  /** The host is installed, so the skill should be installed for it. */
  present: boolean;
  /** The skill folder, ending in /tracetoon. Hosts may share one. */
  dir: string;
}

export interface Integration {
  /** The id hooks are registered under (`--agent <id>`). Stable: installed hooks name it. */
  id: string;
  label: string;
  /**
   * supported: logs, hook and skill. skill-only: runs the skill; logs aren't read.
   * legacy: kept for existing users of a retired host.
   */
  status: 'supported' | 'skill-only' | 'legacy';
  /** One adapter per log store this host writes. */
  traces: TraceAdapter[];
  hook?: HookIntegration;
  skill?(home: string, env: Env): SkillTarget;
  /** Environment variables that hold the current session id, most specific first. */
  sessionEnv?: string[];
  /**
   * Environment variables the host sets to describe its own session (ids, effort,
   * attended flags). They change mid-task, so check receipts leave them out.
   */
  hostEnv?: RegExp;
}
