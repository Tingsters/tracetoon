import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { afterAll, mock } from 'bun:test';
import * as childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.ts';

// The shipped SKILL's `cheap` / `auto` resolve per host agent; tests (and the
// CLIs they start) see the same host wherever the suite runs.
process.env.TRACETOON_HOST_AGENT ??= 'claude';

const made: string[] = [];
// Remove each test file's temp folders when it finishes, so repeated runs
// don't fill the temp filesystem. TRACETOON_KEEP_TMP=1 keeps them for debugging.
afterAll(() => {
  if (process.env.TRACETOON_KEEP_TMP) return;
  for (const d of made.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

/** A fresh temp folder, as a long path (Windows tmpdir can be an 8.3 short name). */
export function tempDir(prefix = 'tracetoon-test-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A git repo with one base commit on `main` and a `feature` branch checked out. */
export function makeRepo(): {
  root: string;
  commit: (file: string, content: string, msg: string) => string;
} {
  const root = tempDir('tracetoon-repo-');
  const g = (...args: string[]) => {
    const r = git(root, args);
    if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'dev@example.com');
  g('config', 'user.name', 'Dev');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  return {
    root,
    commit(file, content, msg) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), content);
      g('add', '.');
      g('commit', '-q', '-m', msg);
      return g('rev-parse', 'HEAD');
    },
  };
}

/** Builds Claude Code JSONL lines with sensible defaults. */
export class ClaudeLog {
  lines: unknown[] = [];
  private n = 0;
  constructor(
    private cwd: string,
    private branch = 'feature',
    private start = Date.now() - 60 * 60_000,
  ) {}
  private ts(): string {
    return new Date(this.start + this.n++ * 1000).toISOString();
  }
  private base() {
    return {
      cwd: this.cwd,
      gitBranch: this.branch,
      sessionId: 's',
      timestamp: this.ts(),
      uuid: `u${this.n}`,
    };
  }
  at(cwd: string): this {
    this.cwd = cwd;
    return this;
  }
  prompt(text: string): this {
    this.lines.push({
      type: 'user',
      ...this.base(),
      message: { role: 'user', content: text },
    });
    return this;
  }
  reply(text: string, model = 'claude-test-1'): this {
    this.lines.push({
      type: 'assistant',
      ...this.base(),
      message: {
        id: `m${this.n}`,
        model,
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    return this;
  }
  private tool(
    name: string,
    input: unknown,
    result: { content: string; isError?: boolean; toolUseResult?: unknown },
  ): this {
    const id = `t${this.n}`;
    this.lines.push({
      type: 'assistant',
      ...this.base(),
      message: {
        id: `m${this.n}`,
        model: 'claude-test-1',
        content: [{ type: 'tool_use', id, name, input }],
      },
    });
    this.lines.push({
      type: 'user',
      ...this.base(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: result.content,
            is_error: result.isError,
          },
        ],
      },
      toolUseResult: result.toolUseResult,
    });
    return this;
  }
  write(filePath: string, content: string): this {
    return this.tool(
      'Write',
      { file_path: filePath, content },
      {
        content: 'ok',
        toolUseResult: { type: 'create', filePath, content, structuredPatch: [] },
      },
    );
  }
  edit(filePath: string, oldString: string, newString: string): this {
    const lines = [
      ...oldString.split('\n').map((l) => `-${l}`),
      ...newString.split('\n').map((l) => `+${l}`),
    ];
    return this.tool(
      'Edit',
      { file_path: filePath, old_string: oldString, new_string: newString },
      {
        content: 'ok',
        toolUseResult: {
          filePath,
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines },
          ],
        },
      },
    );
  }
  bash(command: string, stdout = '', isError = false, tool = 'Bash'): this {
    return this.tool(
      tool,
      { command },
      { content: stdout, isError, toolUseResult: { stdout, stderr: '' } },
    );
  }
  /** A PowerShell tool call (handled like Bash). */
  shell(command: string, stdout = ''): this {
    return this.bash(command, stdout, false, 'PowerShell');
  }
  /** A shell command that changed files (sed, a script): Claude Code records `bashEditDiff`. */
  bashEdit(command: string, files: { filePath: string; added: string[] }[]): this {
    return this.tool(
      'Bash',
      { command },
      {
        content: '',
        toolUseResult: {
          stdout: '',
          stderr: '',
          bashEditDiff: {
            files: files.map((f) => ({
              filePath: f.filePath,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 0,
                  newStart: 1,
                  newLines: f.added.length,
                  lines: f.added.map((l) => `+${l}`),
                },
              ],
            })),
          },
        },
      },
    );
  }
  /** A tool call still running: its result isn't in the log yet. */
  pending(command: string): this {
    this.lines.push({
      type: 'assistant',
      ...this.base(),
      message: {
        id: `m${this.n}`,
        model: 'claude-test-1',
        content: [
          { type: 'tool_use', id: `t${this.n}`, name: 'Bash', input: { command } },
        ],
      },
    });
    return this;
  }
  /** `submitted`: the plan text Claude Code records in the result (can differ from the input). */
  plan(plan: string, approved = true, submitted?: string): this {
    return this.tool(
      'ExitPlanMode',
      { plan },
      {
        content: approved
          ? 'User has approved your plan.'
          : 'User rejected. the user said: shorter',
        ...(submitted ? { toolUseResult: { plan: submitted } } : {}),
      },
    );
  }
  raw(obj: unknown): this {
    this.lines.push(obj);
    return this;
  }
  text(): string {
    return this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }
  /** Write to `<claudeHome>/projects/<dir>/<sessionId>.jsonl`. */
  save(claudeHome: string, sessionId: string, dir = 'proj'): string {
    const d = join(claudeHome, 'projects', dir);
    mkdirSync(d, { recursive: true });
    const p = join(d, `${sessionId}.jsonl`);
    writeFileSync(p, this.text());
    return p;
  }
}

let spawned = 0;
/**
 * Run a command to completion with its stdout and stderr redirected to files.
 * With pipes, spawnSync on Windows returns only once every holder of the pipe
 * has closed it, so a leftover descendant of the command stalls the caller even
 * though the command itself finished. With files it returns when the command exits.
 */
export function spawnToFiles(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): { status: number | null; stdout: string; stderr: string; error?: Error; ms: number } {
  const dir = tempDir('tracetoon-out-');
  const outFile = join(dir, `${++spawned}.out`);
  const errFile = join(dir, `${spawned}.err`);
  const out = openSync(outFile, 'w');
  const err = openSync(errFile, 'w');
  const started = Date.now();
  try {
    const r = spawnSync(command, args, { ...options, stdio: ['ignore', out, err] });
    return {
      status: r.status,
      stdout: readFileSync(outFile, 'utf8'),
      stderr: readFileSync(errFile, 'utf8'),
      error: r.error,
      ms: Date.now() - started,
    };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

// Run the tracetoon CLI through tests/spawn-guard.ts, so a Bun that does not exit after the
// command finished (seen on Windows CI) cannot stall a test. Every test file runs this preload.
const GUARD = join(import.meta.dir, 'spawn-guard.ts');
const realSpawnSync = childProcess.spawnSync;
let guarded = 0;
let doneDir: string | undefined;
mock.module('node:child_process', () => ({
  ...childProcess,
  spawnSync: (command: string, args?: readonly string[], options?: SpawnSyncOptions) => {
    if (
      command === process.execPath &&
      Array.isArray(args) &&
      /(?:^|[\\/])(?:cli\.ts|tracetoon\.mjs)$/.test(String(args[0]))
    ) {
      doneDir ??= tempDir('tracetoon-exit-');
      const doneFile = join(doneDir, String(++guarded));
      return realSpawnSync(process.execPath, [GUARD, command, ...args], {
        ...options,
        env: { ...(options?.env ?? process.env), TRACETOON_EXIT_FILE: doneFile },
      });
    }
    return (realSpawnSync as (...a: unknown[]) => unknown)(command, args, options);
  },
}));
