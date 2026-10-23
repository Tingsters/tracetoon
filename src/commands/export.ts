/**
 * `tracetoon export --agent-trace`: write the PR's attribution as an Agent Trace
 * record (https://agent-trace.dev, v0.1): for each file, which line ranges match
 * which agent and model. Lines that match no agent are listed as unknown.
 */
import { createHash, randomUUID } from 'node:crypto';
import { evidenceLine } from '../correlate/correlate.ts';
import { scan } from '../pipeline.ts';
import { newRun, writeJson } from '../run.ts';
import { git } from '../util/exec.ts';
import { TOOL_VERSION } from '../version.ts';
import { emit, type OutOpts } from './output.ts';

interface Range {
  start_line: number;
  end_line: number;
}

function ranges(lines: number[]): Range[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last.end_line + 1) last.end_line = n;
    else out.push({ start_line: n, end_line: n });
  }
  return out;
}

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'antigravity-cli': 'Antigravity CLI',
  'antigravity-ide': 'Antigravity',
};

export function exportCmd(
  cwd: string,
  opts: OutOpts & { base?: string; offline?: boolean },
): void {
  const { truth, matches } = scan(cwd, { base: opts.base, noGh: opts.offline });
  const included = matches.filter((m) => m.band === 'included');
  const head = git(truth.toplevel, ['rev-parse', 'HEAD']).stdout.trim();
  const salt = truth.remote?.url ?? truth.toplevel;
  const files = truth.files
    .map((f) => {
      const byContributor = new Map<
        string,
        { model?: string; agent: string; session: string; lines: number[] }
      >();
      const unknown: number[] = [];
      f.added.forEach((line, i) => {
        const at = f.addedAt?.[i];
        if (at === undefined) return;
        const ev = evidenceLine(line);
        const owner = ev
          ? included.find((m) => m.addedByFile.get(f.path)?.has(ev))
          : undefined;
        if (!owner) {
          if (ev) unknown.push(at);
          return;
        }
        const model = owner.kept.find((r) => r.model)?.model;
        const key = owner.session.sessionId;
        const entry = byContributor.get(key) ?? {
          model,
          agent: AGENT_NAMES[owner.session.agent] ?? owner.session.agent,
          session:
            'h:' +
            createHash('sha256').update(`${salt}\0${key}`).digest('hex').slice(0, 12),
          lines: [],
        };
        entry.lines.push(at);
        byContributor.set(key, entry);
      });
      const conversations = [...byContributor.values()].map((c) => ({
        contributor: { type: 'ai', model_id: c.model ?? null, tool: c.agent },
        ranges: ranges(c.lines),
        related: [{ type: 'session', id: c.session }],
      }));
      if (unknown.length)
        conversations.push({
          contributor: { type: 'unknown', model_id: null, tool: '' },
          ranges: ranges(unknown),
          related: [],
        });
      return { path: f.path, conversations };
    })
    .filter((f) => f.conversations.length);
  const record = {
    version: '0.1.0',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    vcs: { type: 'git', revision: head },
    tool: { name: 'tracetoon', version: TOOL_VERSION },
    files,
  };
  const run = newRun(truth.gitDir);
  const path = writeJson(run, 'agent-trace.json', record);
  emit(
    opts,
    { path, files: files.length },
    () => `Agent Trace record written to ${path} (${files.length} file(s))`,
  );
}
