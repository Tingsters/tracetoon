/** Resolve recognized publication commands without treating quoted examples as commands. */
import { basename, resolve } from 'node:path';
import { commandFrom, writesPr } from './prHook.ts';
import { repoRoot } from './switches.ts';
import { splitCommands } from '../util/shell.ts';
import { git } from '../util/exec.ts';

type Payload = Record<string, any>;
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((s) =>
    s.replace(/^["']|["']$/g, ''),
  );
}
function remoteName(url: string): string | undefined {
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url)?.[1]?.toLowerCase();
}
function connectorRepo(input: Record<string, any>): string | undefined {
  const value = input.repository ?? input.repo_full_name ?? input.repo;
  if (typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value))
    return value.toLowerCase();
  if (typeof input.owner === 'string' && typeof value === 'string')
    return `${input.owner}/${value}`.toLowerCase();
  const url = input.url ?? input.path;
  return typeof url === 'string'
    ? /(?:^|\/)repos\/([^/]+\/[^/]+)\/pulls/.exec(url)?.[1]?.toLowerCase()
    : undefined;
}
export function publicationTargets(
  p: Payload,
  knownRoots: string[],
): { roots: string[]; kind: 'push' | 'pr' } | undefined {
  const { command, cwd } = commandFrom(p);
  const input = p.tool_input ?? p.toolCall?.args ?? p.tool_call?.args ?? {};
  const known = [...new Set(knownRoots)];
  const forRepo = (name: string) =>
    known.filter(
      (root) =>
        remoteName(git(root, ['remote', 'get-url', 'origin']).stdout.trim()) ===
        name.toLowerCase(),
    );
  const forDirectory = (folder: string) => {
    const root = repoRoot(folder);
    return root ? [root] : [];
  };
  if (!command) {
    const tool = String(p.tool_name ?? p.toolCall?.name ?? p.tool_call?.name ?? '');
    const mutation =
      /github.*(?:(?:create|update|edit)_(?:pull_request|pr)|pull_request_write|push_files|git_push|create_or_update_file)/i.test(
        tool,
      ) ||
      (/github.*(?:request|fetch|api)/i.test(tool) &&
        /^(POST|PATCH|PUT)$/i.test(input.method ?? '') &&
        /\/pulls(?:\/\d+)?$/.test(input.url ?? input.path ?? ''));
    if (!mutation) return;
    const target = connectorRepo(input);
    return {
      roots: target ? forRepo(target) : cwd ? forDirectory(cwd) : known,
      kind: /pull_request|_pr\b|(?:request|fetch|api)/i.test(tool) ? 'pr' : 'push',
    };
  }
  let folder = cwd ?? process.cwd();
  let publication = false;
  let prWrite = false;
  const targets = new Set<string>();
  for (const segment of splitCommands(command)) {
    const args = words(segment);
    if (args[0] === '&') args.shift();
    while (
      /^[\w_]+=/.test(args[0] ?? '') ||
      /^(sudo|command|exec|time)$/.test(args[0] ?? '')
    )
      args.shift();
    const program = basename((args.shift() ?? '').replace(/\\/g, '/'))
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (['cd', 'pushd', 'set-location', 'sl'].includes(program)) {
      if (/^(--|-Path|-LiteralPath)$/i.test(args[0] ?? '')) args.shift();
      if (args[0]) folder = resolve(folder, args[0]);
      continue;
    }
    let targetFolder = folder;
    if (program === 'git') {
      while (args[0]?.startsWith('-')) {
        const flag = args.shift();
        if (flag === '-C' && args[0]) targetFolder = resolve(targetFolder, args.shift()!);
        else if (flag === '-c') args.shift();
      }
      if (args[0]?.toLowerCase() !== 'push') continue;
      const endFlags = args.indexOf('--');
      if (
        args
          .slice(1, endFlags < 0 ? undefined : endFlags)
          .some((a) => a === '--dry-run' || a === '-n')
      )
        continue;
    } else if (program === 'gh') {
      const api = args[0] === 'api';
      const methodAt = args.findIndex((a) => a === '-X' || a === '--method');
      const method =
        methodAt >= 0
          ? args[methodAt + 1]?.toUpperCase()
          : args.some((a) => ['-f', '-F', '--field', '--raw-field'].includes(a))
            ? 'POST'
            : 'GET';
      const apiWrite =
        api &&
        method !== 'GET' &&
        args.some(
          (a) =>
            /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls(?:\/\d+)?$/.test(a) ||
            /\b(?:createPullRequest|updatePullRequest)\b/.test(a),
        );
      if (!writesPr(segment) && !apiWrite) continue;
      prWrite = true;
      const repoAt = args.findIndex((a) => a === '-R' || a === '--repo');
      const named =
        repoAt >= 0
          ? args[repoAt + 1]
          : (args.find((a) => a.startsWith('--repo='))?.slice(7) ??
            (apiWrite
              ? args
                  .map((a) => /(?:^|\/)repos\/([^/]+\/[^/]+)\/pulls/.exec(a)?.[1])
                  .find(Boolean)
              : undefined));
      publication = true;
      if (named) {
        for (const root of forRepo(named)) targets.add(root);
        continue;
      }
    } else continue;
    publication = true;
    for (const root of forDirectory(targetFolder)) targets.add(root);
  }
  return publication ? { roots: [...targets], kind: prWrite ? 'pr' : 'push' } : undefined;
}
