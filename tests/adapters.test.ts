import { describe, expect, test } from 'bun:test';
import { commandText, parseCodexLines } from '../src/integrations/codex/trace.ts';
import {
  cleanUserContent,
  parseAntigravityLines,
  unwrapArg,
} from '../src/integrations/antigravity/trace.ts';
import { linesFromUnifiedDiff, parseApplyPatch } from '../src/trace/diffLines.ts';
import { parseFactoryLines } from '../src/integrations/factory/trace.ts';
import {
  parseCopilotCliLines,
  parseVscodeChat,
  replayChatSession,
} from '../src/integrations/copilot/trace.ts';
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

describe('Factory Droid adapter', () => {
  // Shapes from a real `droid exec` session: a Script tool runs nested calls, each
  // logged as its own tool_use/tool_result pair with JSON-encoded inputs/results.
  const msg = (id: string, n: number, role: string, content: unknown[], extra = {}) => ({
    type: 'message',
    id,
    timestamp: T(n),
    message: { role, content, ...extra },
  });
  const lines = jsonl([
    { type: 'session_start', id: 'f1', title: 'Fix add', version: 2, cwd: '/repo' },
    msg('context-1', 1, 'user', [
      { type: 'text', text: '<system-reminder>\ntools</system-reminder>' },
    ]),
    msg('u1', 2, 'user', [{ type: 'text', text: 'Fix add() and run the test.' }]),
    msg(
      'a1',
      3,
      'assistant',
      [
        { type: 'thinking', thinking: '...', signature: 'x' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'Script',
          input: { script: 'tools.ApplyPatch(...)' },
        },
      ],
      { modelId: 'gpt-6-sol' },
    ),
    msg('repl-tool-call:p-1', 4, 'assistant', [
      {
        type: 'tool_use',
        id: 'p-1',
        name: 'ApplyPatch',
        input: JSON.stringify({
          input:
            '*** Begin Patch\n*** Update File: calc.py\n@@\n def add(a, b):\n-    return a - b\n+    return a + b\n*** Add File: test_calc.py\n+assert add(1, 2) == 3\n*** End Patch',
        }),
      },
    ]),
    msg('repl-tool-result:p-1', 5, 'user', [
      { type: 'tool_result', tool_use_id: 'p-1', content: '"{\\"success\\":true}"' },
    ]),
    msg('repl-tool-call:e-1', 6, 'assistant', [
      {
        type: 'tool_use',
        id: 'e-1',
        name: 'Execute',
        input: JSON.stringify({ command: 'python test_calc.py', riskLevel: 'low' }),
      },
    ]),
    msg('repl-tool-result:e-1', 7, 'user', [
      {
        type: 'tool_result',
        tool_use_id: 'e-1',
        content: '"Traceback ...\n\n[Process exited with code 1]"',
      },
    ]),
    msg('repl-tool-call:e-2', 8, 'assistant', [
      {
        type: 'tool_use',
        id: 'e-2',
        name: 'Execute',
        input: JSON.stringify({ command: 'git status --short' }),
      },
    ]),
    msg('repl-tool-result:e-2', 9, 'user', [
      {
        type: 'tool_result',
        tool_use_id: 'e-2',
        content: '" M calc.py\n\n[Process exited with code 0]"',
      },
    ]),
    msg('r1', 10, 'user', [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'text', text: 'done' }],
        is_error: false,
      },
    ]),
    msg('repl-tool-call:e-3', 11, 'assistant', [
      { type: 'tool_use', id: 'e-3', name: 'Execute', input: { command: 'bun test' } },
    ]),
    msg('a2', 12, 'assistant', [{ type: 'text', text: 'Fixed add().' }], {
      modelId: 'gpt-6-sol',
    }),
    { type: 'agent_turn_outcome', turnId: 'u1', reason: 'completed' },
    { type: 'brand_new_record' },
  ]);

  test('reads prompts, nested patch edits and commands with exit codes', () => {
    const s = session('f1');
    parseFactoryLines(lines, s);
    expect(s.title).toBe('Fix add');
    const prompts = s.records.filter((r) => r.kind === 'prompt');
    expect(prompts.map((r) => r.kind === 'prompt' && r.text)).toEqual([
      'Fix add() and run the test.',
    ]);
    const edits = s.records.filter((r) => r.kind === 'edit');
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({
      added: ['    return a + b'],
      removed: ['    return a - b'],
    });
    expect(edits[1]).toMatchObject({ added: ['assert add(1, 2) == 3'], created: true });
    const commands = s.records.filter((r) => r.kind === 'command');
    expect(
      commands.map(
        (c) => c.kind === 'command' && [c.cmd, c.isError ?? null, !!c.pending],
      ),
    ).toEqual([
      ['python test_calc.py', true, false],
      ['git status --short', false, false],
      ['bun test', null, true],
    ]);
    expect(s.records.find((r) => r.kind === 'assistant')).toMatchObject({
      text: 'Fixed add().',
      model: 'gpt-6-sol',
    });
    expect(s.unknownTypes).toEqual({ brand_new_record: 1 });
  });
});

describe('Copilot adapters', () => {
  test('CLI: pairs tool starts and completions, reads exit codes and apply_patch', () => {
    const ev = (type: string, n: number, data: object) => ({
      type,
      id: `e${n}`,
      timestamp: T(n),
      data,
    });
    const s = session('c1');
    parseCopilotCliLines(
      jsonl([
        ev('session.start', 0, {
          sessionId: 'c1',
          context: { cwd: '/repo', branch: 'fix-add' },
        }),
        ev('user.message', 1, { content: 'Fix add() and test it.' }),
        ev('assistant.message', 2, {
          content: '',
          model: 'gpt-6-luna',
          toolRequests: [{}],
        }),
        ev('tool.execution_start', 3, {
          toolCallId: 'p1',
          toolName: 'apply_patch',
          arguments:
            '*** Begin Patch\n*** Update File: calc.py\n@@\n-    return a - b\n+    return a + b\n*** End Patch',
          model: 'gpt-6-luna',
        }),
        ev('hook.start', 4, { hookType: 'preToolUse' }),
        ev('tool.execution_complete', 5, {
          toolCallId: 'p1',
          success: true,
          fileEdits: [],
        }),
        ev('tool.execution_start', 6, {
          toolCallId: 'x1',
          toolName: 'powershell',
          arguments: { command: 'python test_calc.py', description: 'test' },
        }),
        ev('tool.execution_complete', 7, {
          toolCallId: 'x1',
          success: true,
          shellExecution: { exitCode: 1 },
          result: { content: 'AssertionError' },
        }),
        ev('tool.execution_start', 8, {
          toolCallId: 'v1',
          toolName: 'view',
          arguments: { path: 'calc.py' },
        }),
        ev('tool.execution_complete', 9, { toolCallId: 'v1', success: true }),
        ev('tool.execution_start', 10, {
          toolCallId: 'x2',
          toolName: 'bash',
          arguments: { command: 'bun test' },
        }),
        ev('assistant.message', 11, { content: 'Fixed.', model: 'gpt-6-luna' }),
        ev('brand.new', 12, {}),
      ]),
      s,
    );
    expect(s.records.find((r) => r.kind === 'prompt')).toMatchObject({
      text: 'Fix add() and test it.',
      cwd: '/repo',
      branch: 'fix-add',
    });
    expect(s.records.filter((r) => r.kind === 'edit')).toMatchObject([
      { added: ['    return a + b'], removed: ['    return a - b'] },
    ]);
    expect(
      s.records.flatMap((r) =>
        r.kind === 'command' ? [[r.cmd, r.isError ?? null, !!r.pending]] : [],
      ),
    ).toEqual([
      ['python test_calc.py', true, false],
      ['bun test', null, true],
    ]);
    expect(s.records.filter((r) => r.kind === 'assistant')).toHaveLength(1);
    expect(s.unknownTypes).toEqual({ 'brand.new': 1 });
  });

  test('VS Code: replays the chat operation log, then reads prompts, terminal commands and edits', () => {
    const log = jsonl([
      {
        kind: 0,
        v: { version: 3, customTitle: 'Fix add', sessionId: 'v1', requests: [] },
      },
      {
        kind: 2,
        k: ['requests'],
        v: [
          {
            requestId: 'r1',
            timestamp: Date.parse(T(1)),
            modelId: 'copilot/auto',
            message: { text: 'Fix add()' },
            response: [],
          },
        ],
      },
      { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'Working on it. ' }] },
      {
        kind: 2,
        k: ['requests', 0, 'response'],
        v: [
          {
            kind: 'toolInvocationSerialized',
            toolId: 'run_in_terminal',
            toolSpecificData: {
              kind: 'terminal',
              commandLine: { original: 'cd /repo; pytest', toolEdited: 'pytest' },
              cwd: { fsPath: '/repo' },
              terminalCommandState: { exitCode: 0 },
            },
          },
          {
            kind: 'textEditGroup',
            uri: { fsPath: '/repo/calc.py' },
            edits: [[{ text: 'def add(a, b):\n    return a + b\n', range: {} }]],
          },
        ],
      },
      // A later rewrite of the last part: truncate to index 2, then append.
      { kind: 2, k: ['requests', 0, 'response'], i: 3, v: [{ value: 'Done.' }] },
      { kind: 1, k: ['customTitle'], v: 'Fix add()' },
      { kind: 1, k: ['missing', 'path'], v: 1 },
    ]);
    expect(replayChatSession(log).skipped).toBe(1);
    const s = session('v1');
    parseVscodeChat(log, s, '/repo');
    expect(s.title).toBe('Fix add()');
    expect(s.warnings).toHaveLength(1);
    expect(s.records.find((r) => r.kind === 'prompt')).toMatchObject({
      text: 'Fix add()',
      cwd: '/repo',
    });
    expect(s.records.find((r) => r.kind === 'command')).toMatchObject({
      cmd: 'pytest',
      isError: false,
    });
    expect(s.records.find((r) => r.kind === 'edit')).toMatchObject({
      file: '/repo/calc.py',
      added: ['def add(a, b):', '    return a + b'],
      removed: [],
    });
    expect(s.records.find((r) => r.kind === 'assistant')).toMatchObject({
      text: 'Working on it. Done.',
    });
  });
});

describe('session lines that are JSON but not objects', () => {
  test('are skipped, and the rest of the session is still read', () => {
    for (const parse of [parseCopilotCliLines, parseFactoryLines]) {
      const s = session('n');
      expect(() =>
        parse(
          [
            'null',
            '42',
            JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
          ].join('\n'),
          s,
        ),
      ).not.toThrow();
      expect(s.warnings.length).toBe(2);
    }
  });
});
