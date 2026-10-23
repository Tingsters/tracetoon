import { spawnSync } from 'node:child_process';

export interface ExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program without a shell. Never throws; a missing program gives ok=false. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): ExecResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error)
    return { ok: false, code: -1, stdout: '', stderr: String(r.error.message) };
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Git with the same hardening Showtail uses: no fsmonitor, no ext protocol. */
export function git(cwd: string, args: string[], input?: string): ExecResult {
  return run(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'core.quotepath=off',
      ...args,
    ],
    { cwd, input },
  );
}

export function gh(cwd: string, args: string[]): ExecResult {
  // Tests point this at a script that stands in for the GitHub CLI.
  const fake = process.env.TRACETOON_GH_SCRIPT;
  const [cmd, argv] = fake ? [process.execPath, [fake, ...args]] : ['gh', args];
  return run(cmd, argv, {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });
}
