import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostHome } from '@showtail/agent-traces/paths/hostHome';
import { hookStatus } from '../hook/install.ts';
import { switchState } from '../hook/switches.ts';
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

/** Unknown record types in each agent's most recent sessions: early warning of format changes. */
function probe(limit = 15): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const a of ADAPTERS) {
    if (!a.home()) continue;
    const refs = a
      .discover({ roots: [], sinceMs: 0, all: true })
      .sort((x, y) => y.mtimeMs - x.mtimeMs)
      .slice(0, limit);
    const unknown: Record<string, number> = {};
    for (const ref of refs) {
      for (const [k, v] of Object.entries(a.read(ref).unknownTypes))
        unknown[k] = (unknown[k] ?? 0) + v;
    }
    out[a.id] = unknown;
  }
  return out;
}

/** How Tracetoon is running: the prebuilt binary, or the bundle under bun or node. */
export function describeRuntime(
  execPath = process.execPath,
  bunVersion: string | null = (globalThis as { Bun?: { version: string } }).Bun
    ?.version ?? null,
): string {
  // The installed binary (bin/tracetoon[.exe]) or a release binary (tracetoon-<os>-<arch>).
  if (/[\\/]tracetoon(-[a-z]+-[a-z0-9]+)?(\.exe)?$/i.test(execPath))
    return 'prebuilt binary';
  return bunVersion ? `bun ${bunVersion}` : `node ${process.version}`;
}

/** Where the installer puts the skill for each agent. */
export function skillInstalls(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): { agent: string; dir: string; version: string | null }[] {
  const gemini = env.GEMINI_HOME || join(home, '.gemini');
  const places = [
    {
      agent: 'Claude Code',
      dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills', 'tracetoon'),
    },
    { agent: 'Codex', dir: join(home, '.agents', 'skills', 'tracetoon') },
    { agent: 'Antigravity', dir: join(gemini, 'config', 'skills', 'tracetoon') },
    { agent: 'Gemini CLI', dir: join(gemini, 'skills', 'tracetoon') },
  ];
  return places
    .filter((p) => existsSync(join(p.dir, 'SKILL.md')))
    .map((p) => {
      let version: string | null = null;
      try {
        version = readFileSync(join(p.dir, 'VERSION'), 'utf8').trim() || null;
      } catch {
        /* older installs have no VERSION file */
      }
      return { ...p, version };
    });
}

export function doctor(
  cwd: string,
  opts: OutOpts & { probe?: boolean; strict?: boolean },
): void {
  const runtime = describeRuntime();
  const installs = skillInstalls();
  const gitV = version(git(cwd, ['--version']).stdout);
  const ghOut = gh(cwd, ['--version']);
  const ghV = ghOut.ok ? version(ghOut.stdout) : undefined;
  const ghAuth = ghV ? gh(cwd, ['auth', 'status']).ok : false;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const agents = ADAPTERS.map((a) => {
    const home = a.home();
    const sessions = home ? a.count() : undefined;
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
    installs,
    switch: switchState(cwd),
    prHook: hookStatus().filter((h) => h.present),
    ...(opts.probe ? { unknownRecordTypes: probe() } : {}),
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
    if (report.unknownRecordTypes) {
      for (const [agent, types] of Object.entries(report.unknownRecordTypes)) {
        const list = Object.entries(types).map(([k, v]) => `${k} x${v}`);
        lines.push(
          `  ${agent}: ${list.length ? `unknown record types: ${list.join(', ')}` : 'all record types recognized'}`,
        );
      }
    }
    lines.push(
      installs.length
        ? 'skill installed for:'
        : 'skill not installed for any agent (run the installer)',
      ...installs.map((i) => {
        const stale =
          i.version && i.version !== TOOL_VERSION
            ? ' (older version: re-run the installer)'
            : '';
        return `  ${i.agent.padEnd(14)} ${i.version ?? 'unknown version'}${stale}`;
      }),
      `tracetoon here: ${report.switch.enabled ? 'on' : 'off'} (${report.switch.why})`,
      `PR hook: ${
        report.prHook
          .map(
            (h) => `${h.label} ${h.installed ? (h.problem ? 'inactive' : 'yes') : 'no'}`,
          )
          .join(', ') || 'no agents found'
      }${report.prHook.some((h) => !h.installed) ? ' (add with: tracetoon hook install)' : ''}`,
      ...report.prHook.filter((h) => h.problem).map((h) => `  ${h.label}: ${h.problem}`),
    );
    lines.push(
      `image providers: ${['gemini', 'openai'].filter((p) => report.imageProviders[p as 'gemini']).join(', ') || 'none (built-in comic art will be used)'}`,
    );
    if (!ghV) lines.push('Install the GitHub CLI (gh) to create or update PRs.');
    else if (!ghAuth) lines.push('Run `gh auth login` to let Tracetoon post PRs.');
    return lines.join('\n');
  });
  const unknown = report.unknownRecordTypes ?? {};
  if (opts.strict && Object.values(unknown).some((t) => Object.keys(t).length))
    process.exitCode = 5;
}
