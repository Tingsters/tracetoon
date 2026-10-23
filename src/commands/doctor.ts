import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { claude } from '@showtail/agent-traces';
import { hostHome } from '@showtail/agent-traces/paths/hostHome';
import { ADAPTERS, PLANNED } from '../trace/registry.ts';
import { gh, git } from '../util/exec.ts';
import { TOOL_VERSION } from '../version.ts';
import { emit, type OutOpts } from './output.ts';

function version(out: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
}

function atLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function doctor(cwd: string, opts: OutOpts): void {
  const runtime =
    typeof (globalThis as { Bun?: { version: string } }).Bun !== 'undefined'
      ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
      : `node ${process.version}`;
  const gitV = version(git(cwd, ['--version']).stdout);
  const ghOut = gh(cwd, ['--version']);
  const ghV = ghOut.ok ? version(ghOut.stdout) : undefined;
  const ghAuth = ghV ? gh(cwd, ['auth', 'status']).ok : false;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const agents = ADAPTERS.map((a) => {
    const home = a.home();
    const sessions =
      a.id === 'claude-code' && home ? claude.findTranscripts().length : undefined;
    return { id: a.id, label: a.label, supported: true, found: !!home, sessions };
  });
  const planned = PLANNED.map((p) => ({
    id: p.id,
    label: p.label,
    supported: false,
    found:
      existsSync(hostHome(p.envVar, p.dir)) ||
      existsSync(join(hostHome(p.envVar, p.dir), 'sessions')),
  }));
  const report = {
    tool: `tracetoon ${TOOL_VERSION}`,
    runtime,
    git: gitV ?? null,
    gh: ghV ?? null,
    ghAuthenticated: ghAuth,
    ghAttach: atLeast(ghV, '2.99.0'),
    repo: top.ok ? top.stdout.trim() : null,
    agents: [...agents, ...planned],
    imageProviders: {
      gemini: !!process.env.GEMINI_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
    },
  };
  emit(opts, report, () => {
    const yes = (b: boolean) => (b ? 'yes' : 'no');
    const lines = [
      `${report.tool} on ${runtime}`,
      `git ${gitV ?? 'not found'} | gh ${ghV ?? 'not found'} (signed in: ${yes(ghAuth)}, --attach: ${yes(report.ghAttach)})`,
      `repo: ${report.repo ?? 'not inside a git repository'}`,
      'agents:',
      ...report.agents.map(
        (a) =>
          `  ${a.label.padEnd(14)} ${a.found ? 'logs found' : 'no logs'}${
            'sessions' in a && a.sessions !== undefined ? ` (${a.sessions} sessions)` : ''
          }${a.supported ? '' : ' (support coming soon)'}`,
      ),
    ];
    if (!ghV) lines.push('Install the GitHub CLI (gh) to create or update PRs.');
    else if (!ghAuth) lines.push('Run `gh auth login` to let Tracetoon post PRs.');
    return lines.join('\n');
  });
}
