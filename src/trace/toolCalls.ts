/**
 * Counting tool calls, so a host renaming one does not pass unnoticed.
 *
 * Adapters dispatch on a tool name the host chooses, and hosts rename tools
 * between releases. A rename used to be silent: the dispatch fell through, the
 * adapter produced no edit and no command, and `doctor --probe` still reported
 * every record type recognized, because the record types had not changed — only
 * the tool names inside them.
 *
 * Listing the tool names we know would move that problem down a level rather
 * than solve it, since hosts add tools constantly and the list would go stale.
 * Instead each adapter counts the calls it walks past, and `probe` compares that
 * against the evidence produced: calls but no edits and no commands means the
 * mapping has broken, whatever the tools are called. `unknownTools` is only the
 * diagnostic that names the suspect.
 */
import type { TraceSession } from './types.ts';

/** One tool call seen, whether or not the dispatch below handles it. */
export function sawToolCall(into: TraceSession): void {
  into.toolCalls = (into.toolCalls ?? 0) + 1;
}

/**
 * A tool call no branch of the dispatch converted, by its name.
 *
 * That covers both halves of a host changing its tool surface: a name the
 * adapter does not know, and a name it does know whose arguments it could no
 * longer read — Antigravity CLI 1.5.8 did both at once, renaming `write_to_file`
 * to `write_file` and `TargetFile` to `Path`. Never an alarm on its own, since a
 * host adding a tool lands here too.
 */
export function sawUnknownTool(into: TraceSession, name: string | undefined): void {
  if (!name) return;
  const tools = (into.unknownTools ??= {});
  tools[name] = (tools[name] ?? 0) + 1;
}
