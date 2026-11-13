import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where a program is on PATH, if anywhere. */
export function onPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(
    process.platform === 'win32' ? ';' : ':',
  )) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* unreadable entry */
      }
    }
  }
  return undefined;
}
