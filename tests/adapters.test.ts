import { describe, expect, test } from 'bun:test';
import { commandText, parseCodexLines } from '../src/trace/codex.ts';
import {
  cleanUserContent,
  parseAntigravityLines,
  unwrapArg,
} from '../src/trace/antigravity.ts';
import { linesFromUnifiedDiff, parseApplyPatch } from '../src/trace/diffLines.ts';
import { foldSubagents } from '../src/pipeline.ts';
import type { TraceSession } from '../src/trace/types.ts';

const session = (id = 's'): TraceSession => ({
  agent: 'codex',
  sessionId: id,
  source: 'x',
  records: [],
  unknownTypes: {},
  warnings: [],
});
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const T = (n: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, n)).toISOString();

describe('diff helpers', () => {
  test('unified diff and apply_patch bodies', () => {
    expect(linesFromUnifiedDiff('@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n')).toEqual({
      added: ['new'],
      removed: ['old'],
    });
    expect(linesFromUnifiedDiff('+only added\n')).toEqual({
      added: ['only added'],
      removed: [],
    });
    const files = parseApplyPatch(
      '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n-y\n+z\n*** Delete File: d.ts\n*** End Patch',
    );
    expect(files.map((f) => [f.op, f.path, f.moveTo, f.added, f.removed])).toEqual([
      ['Add', 'a.ts', undefined, ['x'], []],
      ['Update', 'b.ts', 'c.ts', ['z'], ['y']],
      ['Delete', 'd.ts', undefined, [], []],
    ]);
  });
});

describe('Codex adapter', () => {
  test('reads the current item_completed format', () => {
    const s = session();
    parseCodexLines(
      jsonl([
        { timestamp: T(0), type: 'session_meta', payload: { id: 's', cwd: '/home/u' } },
        {
          timestamp: T(1),
          type: 'turn_context',
          payload: { cwd: '/home/u', model: 'gpt-test' },
        },
        {
          timestamp: T(2),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'UserMessage',
              content: [{ type: 'text', text: 'Fix the parser' }],
            },
          },
        },
        {
          timestamp: T(3),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'Plan', text: '1. read\n2. fix' },
          },
        },
        {
          timestamp: T(4),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              command: ['pwsh.exe', '-Command', 'cargo test'],
              cwd: '/repo',
              aggregated_output: 'ok',
              exit_code: 0,
            },
          },
        },
        {
          timestamp: T(5),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'FileChange',
              status: 'completed',
              changes: {
                '/repo/src/p.rs': {
                  type: 'update',
                  unified_diff: '@@ -1 +1 @@\n-bad()\n+good()\n',
                },
                '/repo/src/new.rs': { type: 'add', content: 'fn new() {}\n' },
              },
            },
          },
        },
        {
          timestamp: T(6),
          type: 'token_usage_record',
          payload: {
            usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
          },
        },
        {
          timestamp: T(7),
          type: 'retained_context',
          payload: {
            type: 'verified_answer',
            questions: [{ question: 'Which DB?', answer: 'Postgres' }],
          },
        },
        {
          timestamp: T(8),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'AgentMessage', content: [{ type: 'text', text: 'Done' }] },
          },
        },
        { timestamp: T(9), type: 'mystery_type', payload: {} },
      ]),
      s,
    );
    const by = (k: string) => s.records.filter((r) => r.kind === k);
    expect(by('prompt')).toMatchObject([{ text: 'Fix the parser', cwd: '/home/u' }]);
    expect(by('plan')).toHaveLength(1);
    expect(by('command')).toMatchObject([
      { cmd: 'cargo test', cwd: '/repo', isError: false, output: 'ok' },
    ]);
    const edits = by('edit') as any[];
    expect(
      edits.map((e) => [
        e.file.replace(/\\/g, '/').replace(/^[A-Z]:/, ''),
        e.added,
        e.removed,
      ]),
    ).toEqual([
      ['/repo/src/p.rs', ['good()'], ['bad()']],
      ['/repo/src/new.rs', ['fn new() {}'], []],
    ]);
    expect(by('usage')).toMatchObject([
      { model: 'gpt-test', usage: { input: 60, cacheRead: 40, output: 7 } },
    ]);
    expect(by('decision')).toMatchObject([{ text: 'Which DB? → Postgres' }]);
    expect(by('assistant')).toMatchObject([{ text: 'Done', model: 'gpt-test' }]);
    expect(s.unknownTypes).toEqual({ mystery_type: 1 });
  });

  test('reads the older apply_patch / shell format and marks subagents', () => {
    const s = session('child');
    parseCodexLines(
      jsonl([
        {
          timestamp: T(0),
          type: 'session_meta',
          payload: {
            id: 'child',
            cwd: '/repo',
            source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
          },
        },
        {
          timestamp: T(1),
          type: 'event_msg',
          payload: { type: 'user_message', message: 'look into X' },
        },
        {
          timestamp: T(2),
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: 'c1',
            input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch',
          },
        },
        {
          timestamp: T(3),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            call_id: 'c2',
            arguments: JSON.stringify({
              command: ['bash', '-lc', 'npm test'],
              workdir: '/repo',
            }),
          },
        },
        {
          timestamp: T(4),
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'c2',
            output: 'Exit code: 1\nfailed',
          },
        },
      ]),
      s,
    );
    expect(s.parentSessionId).toBe('parent');
    expect(s.records.find((r) => r.kind === 'prompt')).toMatchObject({
      text: 'look into X',
      delegated: true,
    });
    expect(s.records.find((r) => r.kind === 'edit')).toMatchObject({
      added: ['y'],
      removed: ['x'],
    });
    expect(s.records.find((r) => r.kind === 'command')).toMatchObject({
      cmd: 'npm test',
      isError: true,
      cwd: '/repo',
    });
  });

  test('command text unwraps shell wrappers', () => {
    expect(commandText(['C:\\pwsh.exe', '-Command', 'git status'])).toBe('git status');
    expect(commandText(['bash', '-lc', 'ls -la'])).toBe('ls -la');
    expect(commandText(['git', 'log'])).toBe('git log');
  });

  test('subagent sessions fold into their parent', () => {
    const parent = session('parent');
    parent.records.push({ kind: 'prompt', text: 'p', ts: T(0) });
    const child = session('child');
    child.parentSessionId = 'parent';
    child.records.push({ kind: 'prompt', text: 'c', delegated: true, ts: T(1) });
    const orphan = session('orphan');
    orphan.parentSessionId = 'missing';
    const out = foldSubagents([parent, child, orphan]);
    expect(out.map((s) => s.sessionId)).toEqual(['parent', 'orphan']);
    expect(out[0]!.records).toHaveLength(2);
  });
});

describe('Antigravity adapter', () => {
  test('confirms edits on CODE_ACTION, drops failed ones, pairs commands', () => {
    const s = session();
    s.agent = 'antigravity-ide';
    const enc = (v: string) => JSON.stringify(v); // IDE double-encodes argument values
    parseAntigravityLines(
      jsonl([
        {
          step_index: 0,
          type: 'USER_INPUT',
          created_at: T(0),
          content:
            '<USER_REQUEST>Add a theme toggle</USER_REQUEST><ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
        },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: T(1),
          source: 'MODEL',
          content: 'On it',
          tool_calls: [
            {
              name: 'write_to_file',
              args: {
                TargetFile: enc('/repo/theme.js'),
                CodeContent: enc('export const dark = true;\n'),
              },
            },
          ],
        },
        {
          step_index: 2,
          type: 'CODE_ACTION',
          status: 'DONE',
          created_at: T(2),
          content: 'Created file',
        },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          created_at: T(3),
          tool_calls: [
            {
              name: 'replace_file_content',
              args: {
                TargetFile: '/repo/a.js',
                TargetContent: 'a',
                ReplacementContent: 'b',
              },
            },
          ],
        },
        {
          step_index: 4,
          type: 'ERROR_MESSAGE',
          status: 'ERROR',
          created_at: T(4),
          content: 'target not found',
        },
        {
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          created_at: T(5),
          tool_calls: [
            {
              name: 'write_to_file',
              args: { TargetFile: '/brain/abc/task.md', CodeContent: '# Task' },
            },
          ],
        },
        { step_index: 6, type: 'CODE_ACTION', status: 'DONE', created_at: T(6) },
        {
          step_index: 7,
          type: 'PLANNER_RESPONSE',
          created_at: T(7),
          tool_calls: [
            { name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/repo' } },
          ],
        },
        {
          step_index: 8,
          type: 'RUN_COMMAND',
          status: 'DONE',
          created_at: T(8),
          content: '5 passing',
        },
      ]),
      s,
      {
        history: [
          { display: 'Add a theme toggle', ms: Date.parse(T(0)), workspace: '/repo' },
        ],
        brainDir: '/brain/abc',
      },
    );
    const edits = s.records.filter((r) => r.kind === 'edit') as any[];
    expect(edits).toHaveLength(1);
    expect(edits[0].added).toEqual(['export const dark = true;']);
    expect(s.records.find((r) => r.kind === 'prompt')).toMatchObject({
      text: 'Add a theme toggle',
      cwd: '/repo',
    });
    expect(s.records.find((r) => r.kind === 'command')).toMatchObject({
      cmd: 'npm test',
      cwd: '/repo',
      isError: false,
    });
  });

  test('helpers', () => {
    expect(cleanUserContent('<USER_REQUEST>hi</USER_REQUEST>')).toBe('hi');
    expect(unwrapArg('"\\"C:\\\\\\\\x\\""')).toBe('"C:\\\\x"');
    expect(unwrapArg('"plain"')).toBe('plain');
    expect(unwrapArg('not wrapped')).toBe('not wrapped');
  });
});
