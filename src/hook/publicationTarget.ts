/** Resolve recognized publication commands without treating quoted examples as commands. */
import { resolve } from 'node:path';
import { commandFrom, writesPr } from './prHook.ts';
import { otherPrWrite, commandWords, createsPullRequest } from './prCommands.ts';
import { repoRoot } from './switches.ts';
import { splitCommands } from '../util/shell.ts';
import { git } from '../util/exec.ts';

type Payload = Record<string, any>;
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
    if (!/github/i.test(tool)) return;
    const operation = String(
      input.operation ?? input.action ?? input.method ?? '',
    ).toLowerCase();
    const creates =
      /(?:create_pull_request|create_pr)$/.test(tool) ||
      (/pull_request_write$/.test(tool) && operation === 'create') ||
      (/(?:request|fetch|api)$/.test(tool) &&
        operation === 'post' &&
        (/\/repos\/[^/]+\/[^/]+\/pulls\/?(?:[?#]|$)/.test(
          input.url ?? input.path ?? '',
        ) ||
          (/\/graphql\b/.test(input.url ?? input.path ?? '') &&
            createsPullRequest(
              typeof input.query === 'string'
                ? input.query
                : typeof input.body === 'string'
                  ? input.body
                  : JSON.stringify(input.body ?? ''),
            ))));
    const pushes = /(?:push_files|git_push|create_or_update_file)$/.test(tool);
    if (!creates && !pushes) return;
    const target = connectorRepo(input);
    return {
      roots: target ? forRepo(target) : cwd ? forDirectory(cwd) : known,
      kind: creates ? 'pr' : 'push',
    };
  }
  let folder = cwd ?? process.cwd();
  let publication = false;
  let prWrite = false;
  const targets = new Set<string>();
  for (const segment of splitCommands(command)) {
    const { program, args } = commandWords(segment);
    if (['cd', 'pushd', 'set-location', 'sl'].includes(program)) {
      if (/^(--|-Path|-LiteralPath)$/i.test(args[0] ?? '')) args.shift();
      if (args[0]) folder = resolve(folder, args[0]);
      continue;
    }
    // Other PR CLIs, API calls and gh aliases: the repo they name, or this folder.
    const other = otherPrWrite(segment);
    if (other) {
      prWrite = true;
      publication = true;
      const roots = other.repo
        ? forRepo(other.repo)
        : forDirectory(resolve(folder, other.dir ?? '.'));
      for (const root of roots) targets.add(root);
      continue;
    }
    // `gh api` and `hub api` are judged by the recognizer alone, so both hooks
    // agree (updates to existing PRs are not creation).
    if ((program === 'gh' || program === 'hub') && args[0] === 'api') continue;
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
      if (!writesPr(segment)) continue;
      prWrite = true;
      const repoAt = args.findIndex((a) => a === '-R' || a === '--repo');
      const named =
        repoAt >= 0
          ? args[repoAt + 1]
          : args.find((a) => a.startsWith('--repo='))?.slice(7);
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
