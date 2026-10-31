/**
 * Ways an agent can open or rewrite a GitHub PR besides `gh pr create/edit`:
 * other PR CLIs (hub, git-extras, Git Town), direct calls to the GitHub API
 * (gh/hub api, curl, wget, HTTPie, PowerShell), and gh aliases that expand to
 * a PR write. Stacking tools (Graphite, git-spice) are deliberately not
 * matched: they manage whole stacks of PRs, which Tracetoon doesn't replace.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { splitCommands } from '../util/shell.ts';

/** Shell words, quotes removed. Good enough for flags, URLs and JSON payloads. */
export function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((s) =>
    s.replace(/^["']|["']$/g, ''),
  );
}

/** The program and its arguments, without env prefixes or wrappers. */
export function commandWords(segment: string): { program: string; args: string[] } {
  const args = words(segment);
  if (args[0] === '&') args.shift();
  while (
    /^[A-Za-z_][\w]*=/.test(args[0] ?? '') ||
    /^(sudo|command|exec|time)$/.test(args[0] ?? '')
  )
    args.shift();
  const program = basename((args.shift() ?? '').replace(/\\/g, '/'))
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return { program, args };
}

/** A REST path or URL that creates or edits a PR, and the repo it names. */
const PULLS_PATH = /(?:^|\/)repos\/([^/\s]+\/[^/\s?#]+)\/pulls(?:\/\d+)?\/?(?:[?#]|$)/;
const PR_MUTATION = /\b(?:createPullRequest|updatePullRequest)\b/;

export function pullsRepo(text: string): string | undefined {
  return PULLS_PATH.exec(text)?.[1]?.toLowerCase();
}

export interface PrWrite {
  /** `owner/name`, when the command names the repository. */
  repo?: string;
  /** A `git -C <dir>` target, relative to the command's folder. */
  dir?: string;
}

/**
 * A PATCH to one PR that only changes its state (closing or reopening it) is
 * not a description write; Tracetoon leaves it alone like `gh pr close`.
 */
function stateOnly(url: string, args: string[]): boolean {
  if (!/\/pulls\/\d+\/?(?:[?#]|$)/.test(url)) return false;
  // Judge the payload only, never the URL (a repo can be named "state").
  const payload = args.filter(
    (a) => a !== url && !pullsRepo(a) && !/^https?:\/\//i.test(a),
  );
  // A payload read from a file can't be seen from here; count it as a write.
  if (payload.some((a) => /(^|=|:)@/.test(a) || a === '--input' || a === '--body-file'))
    return false;
  const text = payload.join(' ');
  return /\bstate\b/i.test(text) && !/\b(title|body)\b/i.test(text);
}

/** `gh api` / `hub api`: a non-GET call to the pulls endpoint or a PR mutation. */
function apiWrite(args: string[]): PrWrite | undefined {
  const methodAt = args.findIndex((a) => a === '-X' || a === '--method');
  const joined = args.map((a) => /^(?:-X|--method=)(.+)$/.exec(a)?.[1]).find(Boolean);
  const method = (
    (methodAt >= 0 ? args[methodAt + 1] : joined) ??
    (args.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a))
      ? 'POST'
      : 'GET')
  ).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const path = args.find((a) => pullsRepo(a));
  if (path)
    return method === 'PATCH' && stateOnly(path, args)
      ? undefined
      : { repo: pullsRepo(path) };
  if (args.some((a) => PR_MUTATION.test(a))) return {};
}

/** GitHub's REST and GraphQL APIs, on github.com or GitHub Enterprise; not other forges. */
const GITHUB_API = /^https?:\/\/(?:api\.github\.com\/|[^/\s]+\/api\/(?:v3\/|graphql\b))/i;

/** The value of a flag given as `-X VALUE`, `-X=VALUE`, `-X:VALUE` or (short flags) `-XVALUE`. */
function flagValue(
  args: string[],
  names: RegExp,
  joinedShort?: string,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^(-[^=:\s]+)(?:[=:](.+))?$/.exec(a);
    if (m && names.test(m[1]!)) return (m[2] ?? args[i + 1])?.toUpperCase();
    if (joinedShort && a.startsWith(joinedShort) && a.length > joinedShort.length)
      return a.slice(joinedShort.length).toUpperCase();
  }
}

/** curl, wget, HTTPie and PowerShell web calls that write a PR. */
function httpWrite(program: string, rawArgs: string[]): PrWrite | undefined {
  // PowerShell also takes `-Uri:https://...`; read the value after the colon.
  const args = rawArgs.map((a) => a.replace(/^-[a-z]+:(?=https?:\/\/)/i, ''));
  const urls = args.filter((a) => GITHUB_API.test(a));
  const url = urls.find((u) => pullsRepo(u));
  const graphql =
    urls.some((u) => /\/graphql\b/i.test(u)) && args.some((a) => PR_MUTATION.test(a));
  if (!url && !graphql) return;
  let method: string | undefined;
  if (program === 'curl') {
    // Flags are case-sensitive: -x is --proxy, not -X. -G/--get sends data as a query.
    if (args.some((a) => a === '-G' || a === '--get')) method = 'GET';
    else
      method =
        flagValue(args, /^(-X|--request)$/, '-X') ??
        (args.some((a) =>
          /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form)(=|$)|^-[dF].+/.test(
            a,
          ),
        )
          ? 'POST'
          : 'GET');
  } else if (program === 'wget') {
    method =
      flagValue(args, /^--method$/) ??
      (args.some((a) => /^--(post-data|post-file|body-data|body-file)(=|$)/.test(a))
        ? 'POST'
        : 'GET');
  } else if (['http', 'https', 'xh', 'xhs'].includes(program)) {
    const positional = args.find((a) => !a.startsWith('-'));
    // Data items (`k=v`, `k:=json`, `k@file`) make a POST; `k==v` is a query parameter.
    method = /^(GET|POST|PUT|PATCH|DELETE)$/i.test(positional ?? '')
      ? positional!.toUpperCase()
      : args.some((a) => /^[\w.-]+(?::=|=(?!=)|@)/.test(a) && !GITHUB_API.test(a))
        ? 'POST'
        : 'GET';
  } else {
    // Invoke-RestMethod / Invoke-WebRequest (irm, iwr): GET unless -Method says
    // otherwise. PowerShell accepts any unambiguous prefix and `-Method:Post`.
    method = flagValue(args, /^-me(t(h(o(d)?)?)?)?$/i) ?? 'GET';
  }
  if (!method || method === 'GET' || method === 'HEAD') return;
  if (url && method === 'PATCH' && stateOnly(url, args)) return;
  const repo = url ? pullsRepo(url) : undefined;
  return repo ? { repo } : {};
}

const HTTP_PROGRAMS = [
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'xhs',
  'invoke-restmethod',
  'invoke-webrequest',
  'irm',
  'iwr',
];

/**
 * A PR write by any recognized means other than `gh pr create/edit` itself
 * (which the caller checks). Undefined when the segment writes no PR.
 */
export function otherPrWrite(segment: string, depth = 0): PrWrite | undefined {
  const { program, args } = commandWords(segment);
  if (program === 'gh' || program === 'hub') {
    if (args[0] === 'api') return apiWrite(args.slice(1));
    if (program === 'hub' && args[0] === 'pull-request') return {};
    if (program === 'gh') {
      const expansion = ghAlias(args[0]);
      if (expansion && depth < 3) return aliasWrite(expansion, args.slice(1), depth + 1);
    }
    return;
  }
  if (program === 'git' || program === 'git-town') {
    let dir: string | undefined;
    const rest = [...args];
    if (program === 'git')
      while (rest[0]?.startsWith('-')) {
        const flag = rest.shift();
        if (flag === '-C' && rest[0]) dir = rest.shift();
        else if (flag === '-c') rest.shift();
      }
    const sub = program === 'git-town' ? ['town', ...rest] : rest;
    // git-extras `git pull-request`; Git Town `git town propose` (formerly new-pull-request).
    if (
      sub[0] === 'pull-request' ||
      (sub[0] === 'town' && ['propose', 'new-pull-request'].includes(sub[1] ?? ''))
    )
      return dir ? { dir } : {};
    return;
  }
  if (HTTP_PROGRAMS.includes(program)) return httpWrite(program, args);
}

/** The PR-writing check for an expanded gh alias, with the user's extra arguments. */
function aliasWrite(
  expansion: string,
  extra: string[],
  depth: number,
): PrWrite | undefined {
  // A `!` alias is a shell command line: any of its commands may write the PR.
  const command = expansion.startsWith('!')
    ? `${expansion.slice(1)} ${extra.join(' ')}`
    : `gh ${expansion} ${extra.join(' ')}`;
  for (const segment of splitCommands(command)) {
    const seg = segment.trim();
    if (GH_PR_WRITE.test(seg)) return {};
    const other = otherPrWrite(seg, depth);
    if (other) return other;
  }
}
const GH_PR_WRITE =
  /^gh\s+pr\s+(?:create|new)\b|^gh\s+pr\s+edit\b(?:(?!\s-).)*$|^gh\s+pr\s+edit\b.*\s(?:--title|-t|--body|-b|--body-file|-F)(?:\s|=|$)/;

let aliasCache:
  { path: string; mtime: number; aliases: Record<string, string> } | undefined;

/** gh's own config: GH_CONFIG_DIR, then the platform default. */
function ghConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GH_CONFIG_DIR) return join(env.GH_CONFIG_DIR, 'config.yml');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh', 'config.yml');
  if (process.platform === 'win32' && env.AppData)
    return join(env.AppData, 'GitHub CLI', 'config.yml');
  return join(homedir(), '.config', 'gh', 'config.yml');
}

/** The expansion of a user-defined gh alias, read from gh's config.yml. */
export function ghAlias(
  name: string | undefined,
  path = ghConfigPath(),
): string | undefined {
  if (!name || name.startsWith('-')) return;
  try {
    if (!existsSync(path)) return;
    const { mtimeMs } = statSync(path);
    if (aliasCache?.path !== path || aliasCache.mtime !== mtimeMs)
      aliasCache = {
        path,
        mtime: mtimeMs,
        aliases: parseAliases(readFileSync(path, 'utf8')),
      };
    return aliasCache.aliases[name];
  } catch {
    return;
  }
}

/** The `aliases:` block of gh's config.yml (simple `name: expansion` entries). */
export function parseAliases(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^aliases:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break; // next top-level key
    const m = /^\s+([^:#\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2').trim();
  }
  return out;
}
