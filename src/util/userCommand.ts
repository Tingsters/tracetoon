import { join, dirname, resolve } from 'node:path';
import { onPath } from '../comic/providers.ts';
import { describeRuntime } from '../commands/doctor.ts';

export function terminalCommand(parts: string[], platform = process.platform): string {
  const quote = (part: string) =>
    /^[\w./:\\-]+$/.test(part)
      ? part
      : platform === 'win32'
        ? `'${part.replaceAll("'", "''")}'`
        : `'${part.replaceAll("'", "'\\''")}'`;
  const result = parts.map(quote).join(' ');
  return platform === 'win32' && quote(parts[0] ?? '').startsWith("'")
    ? `& ${result}`
    : result;
}

export function selfProgram(): string[] {
  if (describeRuntime() === 'prebuilt binary') return [process.execPath];
  return [process.execPath, resolve(process.argv[1] ?? '')];
}

export function userCommand(): { onPath: boolean; run: string } {
  if (onPath('tracetoon')) return { onPath: true, run: 'tracetoon' };
  const assets = process.env.TRACETOON_ASSETS;
  const parts = assets
    ? [
        join(
          dirname(assets),
          'bin',
          process.platform === 'win32' ? 'tracetoon.cmd' : 'tracetoon',
        ),
      ]
    : selfProgram();
  return { onPath: false, run: terminalCommand(parts) };
}
