import { existsSync, readFileSync } from 'node:fs';
import { graphEngineAvailable } from '../graph/engine.ts';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { hostHome } from '@showtail/agent-traces/paths/hostHome';
import { hookStatus } from '../hook/install.ts';
import { switchState } from '../hook/switches.ts';
import { ADAPTERS, PLANNED, allSkillDirs } from '../integrations/registry.ts';
import { gh, git, run } from '../util/exec.ts';
import { TOOL_VERSION, BUILD_INFO, FROM_SOURCE } from '../version.ts';
import { loadConfig, userConfigPath } from '../config.ts';
import { readLocal } from '../util/localJson.ts';
import { readState } from '../update/state.ts';
import { compareVersions } from '../update/version.ts';
import { emit, type OutOpts } from './output.ts';
import { nextStep, routeStatuses } from '../comic/routes.ts';
import { resolveTarget, targetLine, type Target } from '../github/target.ts';

/**
 * Whether the signed-in gh account can push to this repo, so a 403 shows up
 * before any work instead of at publish. Undefined when it can't be told.
 */
export function pushAccess(
  cwd: string,
  repo?: string,
): { repo: string; account?: string; canPush: boolean } | undefined {
  const view = gh(cwd, [
    'repo',
    'view',
    ...(repo ? [repo] : []),
    '--json',
    'nameWithOwner,viewerPermission',
  ]);
  if (!view.ok) return undefined;
  try {
    const { nameWithOwner, viewerPermission } = JSON.parse(view.stdout) as {
      nameWithOwner?: string;
      viewerPermission?: string;
    };
    if (!nameWithOwner || !viewerPermission) return undefined;
    const who = gh(cwd, ['api', 'user', '--jq', '.login']);
    return {
      repo: nameWithOwner,
      account: who.ok ? who.stdout.trim() || undefined : undefined,
      canPush: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(viewerPermission.toUpperCase()),
    };
  } catch {
    return undefined;
  }
}

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
): {
  agent: string;
  dir: string;
  version: string | null;
  buildId: string | null;
  matchesRuntime: boolean;
}[] {
  const places = allSkillDirs(home, env).map((p) => ({ agent: p.label, dir: p.dir }));
  return places
    .filter((p) => existsSync(join(p.dir, 'SKILL.md')))
    .map((p) => {
      let version: string | null = null;
      try {
        version = readFileSync(join(p.dir, 'VERSION'), 'utf8').trim() || null;
      } catch {
        /* older installs have no VERSION file */
      }
      const buildId =
        readLocal<{ buildId: string }>(join(p.dir, 'build.json'))?.buildId ?? null;
      return {
        ...p,
        version,
        buildId,
        matchesRuntime: buildId === BUILD_INFO.buildId && version === TOOL_VERSION,
      };
    });
}

export interface DoctorCheck {
  /** Stable id agents can branch on. */
  id: string;
  ok: boolean;
  /** error: publishing can't work until it's fixed; warn: something is missing; info: worth knowing. */
  severity: 'error' | 'warn' | 'info';
  message: string;
  /** The exact command (or action) that fixes it. */
  fix?: string;
  /** Only the user can do the fix (sign in, install, permission, or a choice that is theirs). */
  humanRequired: boolean;
}

/** Exit code of `doctor --strict` (without --probe) when a required check fails. */
export const DOCTOR_STRICT_EXIT = 6;

/** Everything doctor finds, without printing it. */
export function doctorReport(cwd: string, opts: { probe?: boolean } = {}) {
  const runtime = describeRuntime();
  const hooks = hookStatus().filter((h) => h.present);
  const hookRuntimes = hooks.map((h) => {
    const prefix = h.command?.split(/\s+hook pre-pr\b/)[0];
    const argv = prefix
      ?.match(/"[^"]*"|'[^']*'|[^\s]+/g)
      ?.map((s) => s.replace(/^["']|["']$/g, ''));
    const result = argv?.length
      ? run(argv[0]!, [...argv.slice(1), 'build-info', '--json'], { timeoutMs: 2000 })
      : undefined;
    let build: typeof BUILD_INFO | null = null;
    try {
      if (result?.ok) build = JSON.parse(result.stdout);
    } catch {
      /* legacy runtime */
    }
    return {
      agent: h.agent,
      command: h.command ?? null,
      build,
      matchesRuntime: build?.buildId === BUILD_INFO.buildId,
    };
  });
  const installs = skillInstalls();
  const gitV = version(git(cwd, ['--version']).stdout);
  const ghOut = gh(cwd, ['--version']);
  const ghV = ghOut.ok ? version(ghOut.stdout) : undefined;
  const ghAuth = ghV ? gh(cwd, ['auth', 'status']).ok : false;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const target: Target | undefined = top.ok && ghAuth ? resolveTarget(cwd) : undefined;
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
  const cfg = loadConfig();
  const known = readState();
  const update = {
    autoUpdate: cfg.autoUpdate,
    channel: cfg.updateChannel,
    latest: known.latest ?? null,
    checkedAt: known.checkedAt ?? null,
    available:
      !!known.latest &&
      known.channel === cfg.updateChannel &&
      compareVersions(known.latest, TOOL_VERSION) > 0,
  };
  const report = {
    tool: `tracetoon ${TOOL_VERSION}`,
    update,
    runtime,
    runtimeInfo: {
      ...BUILD_INFO,
      executable: process.execPath,
      entrypoint: process.argv[1] ?? null,
      launcher: process.env.TRACETOON_LAUNCHER ?? null,
    },
    hookRuntimes,
    lastHookError:
      readLocal(join(dirname(userConfigPath()), 'last-hook-error.json')) ?? null,
    observedHooks: readLocal(join(dirname(userConfigPath()), 'hook-health.json')) ?? {},
    git: gitV ?? null,
    gh: ghV ?? null,
    ghAuthenticated: ghAuth,
    ghAttach: atLeast(ghV, '2.99.0'),
    repo: top.ok ? top.stdout.trim() : null,
    agents: [...agents, ...planned],
    installs,
    switch: switchState(cwd),
    prHook: hooks,
    ...(opts.probe ? { unknownRecordTypes: probe() } : {}),
    imageProviders: routeStatuses(top.ok ? top.stdout.trim() : undefined),
    // The branch is pushed to origin; the PR is opened in the target repo.
    target: target ?? null,
    push:
      top.ok && ghAuth ? (pushAccess(cwd, target?.origin ?? target?.repo) ?? null) : null,
    evidenceGraph: graphEngineAvailable(),
  };
  const comics = nextStep(
    report.imageProviders,
    loadConfig(report.repo ?? undefined).comic,
  );
  const checks = doctorChecks(report, installs, hookRuntimes);
  return {
    ok: checks.every((c) => c.ok || c.severity !== 'error'),
    checks,
    ...report,
    comics,
  };
}

type Found = {
  git: string | null;
  gh: string | null;
  ghAuthenticated: boolean;
  repo: string | null;
  push: { canPush: boolean } | null;
  prHook: { label: string; installed: boolean; problem?: string }[];
  update: { available: boolean; latest: string | null };
  evidenceGraph: { ok: boolean; reason?: string };
  unknownRecordTypes?: Record<string, Record<string, number>>;
};

/** The pass/fail list agents read from `doctor --json`, built from what doctor found. */
function doctorChecks(
  report: Found,
  installs: ReturnType<typeof skillInstalls>,
  hookRuntimes: { agent: string; matchesRuntime: boolean }[],
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (c: Omit<DoctorCheck, 'humanRequired'> & { humanRequired?: boolean }) =>
    checks.push({ ...c, humanRequired: c.humanRequired ?? false });
  add({
    id: 'git',
    ok: !!report.git,
    severity: 'error',
    message: report.git ? `git ${report.git}` : 'git is not installed',
    ...(report.git
      ? {}
      : { fix: 'Install git: https://git-scm.com', humanRequired: true }),
  });
  add({
    id: 'gh',
    ok: !!report.gh,
    severity: 'error',
    message: report.gh
      ? `GitHub CLI ${report.gh}`
      : 'The GitHub CLI (gh) is not installed; publishing needs it',
    ...(report.gh
      ? {}
      : { fix: 'Install the GitHub CLI: https://cli.github.com', humanRequired: true }),
  });
  if (report.gh)
    add({
      id: 'gh-auth',
      ok: report.ghAuthenticated,
      severity: 'error',
      message: report.ghAuthenticated ? 'gh is signed in' : 'gh is not signed in',
      ...(report.ghAuthenticated ? {} : { fix: 'gh auth login', humanRequired: true }),
    });
  add({
    id: 'repo',
    ok: !!report.repo,
    severity: 'warn',
    message: report.repo ? 'inside a git repository' : 'not inside a git repository',
    ...(report.repo ? {} : { fix: 'cd into the repository, then rerun' }),
  });
  if (report.push)
    add({
      id: 'push-access',
      ok: report.push.canPush,
      severity: 'error',
      message: report.push.canPush
        ? 'the signed-in gh account can push to the target repository'
        : "the signed-in gh account can't push to the target repository",
      ...(report.push.canPush
        ? {}
        : { fix: 'gh auth switch (or push to a fork)', humanRequired: true }),
    });
  const stale = FROM_SOURCE ? [] : installs.filter((i) => !i.matchesRuntime);
  add({
    id: 'skill-installed',
    ok: installs.length > 0 && !stale.length,
    severity: 'warn',
    message: !installs.length
      ? 'the skill is not installed for any agent'
      : stale.length
        ? `the skill for ${stale.map((i) => i.agent).join(', ')} is from a different build`
        : `the skill is installed for ${installs.map((i) => i.agent).join(', ')}`,
    ...(!installs.length
      ? { fix: 'tracetoon setup' }
      : stale.length
        ? { fix: 'tracetoon update', humanRequired: true }
        : {}),
  });
  const missing = report.prHook.filter((h) => !h.installed || h.problem);
  add({
    id: 'pr-hook',
    ok: !missing.length,
    severity: report.prHook.length ? 'warn' : 'info',
    message: !report.prHook.length
      ? 'no agent with a PR hook was found'
      : missing.length
        ? `the PR hook is missing or inactive for ${missing.map((h) => h.label).join(', ')}`
        : 'the PR hook is installed',
    ...(missing.length ? { fix: 'tracetoon hook install' } : {}),
  });
  const oldHooks = FROM_SOURCE ? [] : hookRuntimes.filter((h) => !h.matchesRuntime);
  if (oldHooks.length)
    add({
      id: 'hook-runtime',
      ok: false,
      severity: 'warn',
      message: `the hook runtime for ${oldHooks.map((h) => h.agent).join(', ')} differs from this one`,
      fix: 'tracetoon update',
      humanRequired: true,
    });
  add({
    id: 'update',
    ok: !report.update.available,
    severity: 'info',
    message: report.update.available
      ? `update available: ${report.update.latest}`
      : 'no newer release known',
    // Updating is the user's call.
    ...(report.update.available ? { fix: 'tracetoon update', humanRequired: true } : {}),
  });
  add({
    id: 'evidence-graph',
    ok: report.evidenceGraph.ok,
    severity: 'warn',
    message: report.evidenceGraph.ok
      ? 'evidence graph ready'
      : `evidence graph unavailable: ${report.evidenceGraph.reason ?? 'unknown reason'}`,
  });
  if (report.unknownRecordTypes) {
    const unknown = Object.entries(report.unknownRecordTypes).filter(
      ([, t]) => Object.keys(t).length,
    );
    add({
      id: 'record-types',
      ok: !unknown.length,
      severity: 'warn',
      message: unknown.length
        ? `unknown log record types for ${unknown.map(([a]) => a).join(', ')}`
        : 'all log record types recognized',
    });
  }
  return checks;
}

export function doctor(
  cwd: string,
  opts: OutOpts & { probe?: boolean; strict?: boolean },
): void {
  const full = doctorReport(cwd, opts);
  const { checks: _checks, ok: _ok, comics, ...report } = full;
  const { runtime, installs, hookRuntimes, update } = report;
  const gitV = report.git;
  const ghV = report.gh;
  const ghAuth = report.ghAuthenticated;
  const inRepo = !!report.repo;
  emit(opts, full, () => {
    const yes = (b: boolean) => (b ? 'yes' : 'no');
    const lines = [
      `${report.tool} on ${runtime}`,
      `git ${gitV ?? 'not found'} | gh ${ghV ?? 'not found'} (signed in: ${yes(ghAuth)}, --attach: ${yes(report.ghAttach)})`,
      `repo: ${report.repo ?? 'not inside a git repository'}`,
      `evidence graph: ${report.evidenceGraph.ok ? 'ready (Relate, WebAssembly)' : `unavailable: ${report.evidenceGraph.reason}`}`,
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
        // A source checkout has no build of its own to compare installed skills with.
        const stale =
          !i.matchesRuntime && !FROM_SOURCE
            ? ' (different or unknown build: run tracetoon update to bring runtime and skill together)'
            : '';
        return `  ${i.agent.padEnd(14)} ${i.version ?? 'unknown version'}${stale}`;
      }),
      update.available
        ? `update available: ${update.latest} (you have ${TOOL_VERSION}); run: tracetoon update`
        : `updates: ${update.autoUpdate}, ${update.channel} channel${update.checkedAt ? `, last checked ${update.checkedAt.slice(0, 10)}` : ', not checked yet'}`,
      `tracetoon here: ${report.switch.enabled ? 'on' : 'off'} (${report.switch.why})`,
      `PR hook: ${
        report.prHook
          .map(
            (h) => `${h.label} ${h.installed ? (h.problem ? 'inactive' : 'yes') : 'no'}`,
          )
          .join(', ') || 'no agents found'
      }${report.prHook.some((h) => !h.installed) ? ' (add with: tracetoon hook install)' : ''}`,
      ...report.prHook.filter((h) => h.problem).map((h) => `  ${h.label}: ${h.problem}`),
      // From source there is no build to compare the installed hooks with.
      ...hookRuntimes
        .filter((h) => !h.matchesRuntime && !FROM_SOURCE)
        .map(
          (h) =>
            `  ${h.agent} hook runtime differs or predates build identity; run: tracetoon update.`,
        ),
    );
    const found = report.imageProviders.filter((p) => p.available);
    lines.push(
      `comic art: ${
        found
          .map(
            (p) =>
              `${p.id} (${p.ready === 'not ready' ? "can't draw" : p.approved ? 'approved' : 'needs your OK'})`,
          )
          .join(', ') || 'no image route'
      }`,
      `  next: ${comics.text}`,
    );
    if (inRepo && ghAuth) lines.push(targetLine(report.target ?? undefined));
    if (report.push && !report.push.canPush)
      lines.push(
        `push access: ${report.push.account ?? 'this gh account'} can't push to ${report.push.repo}. Publishing will fail: switch accounts (gh auth switch), or push to a fork.`,
      );
    if (!ghV) lines.push('Install the GitHub CLI (gh) to create or update PRs.');
    else if (!ghAuth) lines.push('Run `gh auth login` to let Tracetoon post PRs.');
    return lines.join('\n');
  });
  const unknown = report.unknownRecordTypes ?? {};
  if (opts.probe) {
    if (opts.strict && Object.values(unknown).some((t) => Object.keys(t).length))
      process.exitCode = 5;
  } else if (opts.strict && !full.ok) process.exitCode = DOCTOR_STRICT_EXIT;
}
