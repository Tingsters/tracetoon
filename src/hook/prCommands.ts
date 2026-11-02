/**
 * Ways an agent can create a GitHub PR besides `gh pr create`:
 * other PR CLIs (hub, git-extras, Git Town), direct calls to the GitHub API
 * (gh/hub api, curl, wget, HTTPie, PowerShell), and gh aliases that expand to
 * PR creation. Stacking tools (Graphite, git-spice) are deliberately not
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

/** Only the collection endpoint creates a PR; numbered PRs and subresources do not. */
const PULLS_PATH = /(?:^|\/)repos\/([^/\s]+\/[^/\s?#]+)\/pulls\/?(?:[?#]|$)/;
/** Ignore GraphQL strings/comments, including descriptions that merely name a mutation. */
export function createsPullRequest(text: string): boolean {
  const jsonQuery = /"query"\s*:\s*("(?:\\.|[^"\\])*")/.exec(text);
  const shellQuery = /\bquery=(['"])((?:\\.|(?!\1)[\s\S])*)\1/.exec(text);
  if (jsonQuery) {
    try {
      text = JSON.parse(jsonQuery[1]!);
    } catch {
      return false;
    }
  } else if (shellQuery) {
    text =
      shellQuery[1] === '"' ? shellQuery[2]!.replace(/\\(["\\])/g, '$1') : shellQuery[2]!;
  }
  const query = text.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\r\n]*/g, '');
  return /\bmutation\b[\s\S]*\bcreatePullRequest\s*\(/.test(query);
}

// Skip option values so a title/body containing "--help" is still a creation.
const VALUE_FLAG =
  /^(--title|-t|--body|-b|--body-file|-F|--head|-H|--base|-B|--repo|-R|--reviewer|-r|--assignee|-a|--label|-l|--milestone|-m|--project|-p|--template|-T|--recover|--field|-f|--raw-field|--input|--data|-d|--json|--raw|--request|-X|--method|--header|-h|--headers|--auth|--auth-type|--proxy|--output|-o|--uri|-Uri|-Body|-Method|-Headers|-C|-c)$/;
export function previewOnly(args: string[], shortHelp = false): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (['--help', '--version', '--dry-run'].includes(arg) || (shortHelp && arg === '-h'))
      return true;
    if (VALUE_FLAG.test(arg)) i++;
  }
  return false;
}
export function ghCreatesPr(args: string[]): boolean {
  return (
    args[0] === 'pr' &&
    ['create', 'new'].includes(args[1] ?? '') &&
    !previewOnly(args.slice(2), true)
  );
}

export function pullsRepo(text: string): string | undefined {
  return PULLS_PATH.exec(text)?.[1]?.toLowerCase();
}

export interface PrWrite {
  /** `owner/name`, when the command names the repository. */
  repo?: string;
  /** A `git -C <dir>` target, relative to the command's folder. */
  dir?: string;
}

/** `gh api` / `hub api`: POST to the collection or a creation mutation. */
function apiWrite(args: string[], raw: string): PrWrite | undefined {
  const methodAt = args.findIndex((a) => a === '-X' || a === '--method');
  const joined = args.map((a) => /^(?:-X|--method=)(.+)$/.exec(a)?.[1]).find(Boolean);
  const method = (
    (methodAt >= 0 ? args[methodAt + 1] : joined) ??
    (args.some((a) => /^(?:-[fF].*|--(?:field|raw-field|input)(?:=.*)?)$/.test(a))
      ? 'POST'
      : 'GET')
  ).toUpperCase();
  if (method !== 'POST') return;
  const path = args.find((a) => pullsRepo(a));
  if (path) return { repo: pullsRepo(path) };
  if (args.includes('graphql') && createsPullRequest(raw)) return {};
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
function httpWrite(program: string, rawArgs: string[], raw: string): PrWrite | undefined {
  // PowerShell also takes `-Uri:https://...`; read the value after the colon.
  const args = rawArgs.map((a) => a.replace(/^-[a-z]+:(?=https?:\/\/)/i, ''));
  const urls = args.filter((a) => GITHUB_API.test(a));
  const url = urls.find((u) => pullsRepo(u));
  const graphql = urls.some((u) => /\/graphql\b/i.test(u)) && createsPullRequest(raw);
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
    method = httpieMethod(args);
  } else {
    // Invoke-RestMethod / Invoke-WebRequest (irm, iwr): GET unless -Method says
    // otherwise. PowerShell accepts any unambiguous prefix and `-Method:Post`.
    method = flagValue(args, /^-me(t(h(o(d)?)?)?)?$/i) ?? 'GET';
  }
  if (method !== 'POST') return;
  const repo = url ? pullsRepo(url) : undefined;
  return repo ? { repo } : {};
}

// HTTPie's option values can precede METHOD and URL. They are not positional
// arguments: e.g. `http --raw '{...}' PATCH URL` or `http -A bearer -a TOKEN GET URL`.
const HTTPIE_VALUE_FLAG =
  /^(--raw|--auth|-a|--auth-type|-A|--session|--session-read-only|--proxy|--cert|--cert-key|--verify|--timeout|--max-redirects|--print|-p|--pretty|--style|--output|-o|--default-scheme|--format-options|--response-mime|--response-charset|--ssl|--ssl-ciphers|--max-headers|--boundary)$/;

function httpieMethod(args: string[]): string {
  const positional: string[] = [];
  let raw = false;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('-')) {
      const name = arg.split('=', 1)[0]!;
      if (name === '--raw') raw = true;
      if (HTTPIE_VALUE_FLAG.test(name) && !arg.includes('=')) i++;
      continue;
    }
    positional.push(arg);
  }
  if (/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(positional[0] ?? ''))
    return positional[0]!.toUpperCase();
  // Raw bodies, files and data items imply POST; `k==v` is a query parameter.
  return raw || positional.some((a) => /^(?:@|[\w.-]+(?::=|=(?!=)|@))/.test(a))
    ? 'POST'
    : 'GET';
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
 * PR creation by any recognized means other than `gh pr create` itself
 * (which the caller checks). Undefined when the segment writes no PR.
 */
export function otherPrWrite(segment: string, depth = 0): PrWrite | undefined {
  const { program, args } = commandWords(segment);
  // A shell alias appends arguments to its last command, which may not be
  // the command that creates the PR. Classify the expansion before its flags.
  if (program === 'gh') {
    const expansion = ghAlias(args[0]);
    if (expansion && depth < 3) return aliasWrite(expansion, args.slice(1), depth + 1);
  }
  if (previewOnly(args, program === 'gh')) return;
  if (program === 'gh' || program === 'hub') {
    if (args[0] === 'api') return apiWrite(args.slice(1), segment);
    if (program === 'hub' && args[0] === 'pull-request') return {};
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
  if (HTTP_PROGRAMS.includes(program)) return httpWrite(program, args, segment);
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
    const { program, args } = commandWords(seg);
    if (program === 'gh' && ghCreatesPr(args)) return {};
    const other = otherPrWrite(seg, depth);
    if (other) return other;
  }
}

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
