/**
 * Runs a command for a test and returns its exit code, even when Bun on Windows
 * fails to exit after the command is finished: `bun spawn-guard.ts <cmd> <args...>`.
 *
 * The tracetoon CLI writes its exit code to $TRACETOON_EXIT_FILE just before it
 * exits. If that file appears and the process is still alive 3 seconds later, the
 * process is killed and its recorded code is returned. A command that exits on its
 * own, or never finishes, behaves as without the guard.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const doneFile = process.env.TRACETOON_EXIT_FILE;
const child = spawn(command!, args, { stdio: 'inherit', windowsHide: true });
let ended = false;
const end = (code: number) => {
  if (ended) return;
  ended = true;
  process.exit(code);
};
child.once('exit', (code, signal) => end(code ?? (signal ? 1 : 0)));
child.once('error', () => end(1));
if (doneFile) {
  const poll = setInterval(() => {
    if (!existsSync(doneFile)) return;
    clearInterval(poll);
    setTimeout(() => {
      let code = 0;
      try {
        code = Number(readFileSync(doneFile, 'utf8')) || 0;
      } catch {
        // keep 0
      }
      if (child.pid) {
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
          });
        else child.kill('SIGKILL');
      }
      end(code);
    }, 3000);
  }, 200);
}
