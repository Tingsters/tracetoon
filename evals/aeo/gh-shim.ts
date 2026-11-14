/**
 * Stands in for the GitHub CLI during AEO eval runs (based on tests/fake-gh.ts).
 * Records every call as one JSON line in $AEO_GH_LOG and answers offline, so
 * an agent can "open a PR" without ever reaching GitHub.
 *
 * Tracetoon reaches it through TRACETOON_GH_SCRIPT; the agent's shell reaches
 * it through the `gh` / `gh.cmd` wrappers fixture.ts puts first on PATH.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.AEO_GH_LOG;
const state = process.env.AEO_GH_STATE;
const REPO = 'acme/demo';
const URL = `https://github.com/${REPO}/pull/1`;

function flag(...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

function readBody(): string | undefined {
  const file = flag('--body-file', '-F');
  if (file === '-') {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return undefined;
    }
  }
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
  return flag('--body', '-b');
}

interface Pr {
  number: number;
  url: string;
  title?: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
  state: 'OPEN';
}

function prs(): Pr[] {
  try {
    return state && existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [];
  } catch {
    return [];
  }
}

const [a, b] = args;
const body = a === 'pr' && (b === 'create' || b === 'edit') ? readBody() : undefined;
if (log)
  appendFileSync(
    log,
    JSON.stringify({ ts: new Date().toISOString(), args, body, cwd: process.cwd() }) +
      '\n',
  );

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);

if (a === '--version' || a === 'version') {
  out('gh version 2.99.0 (aeo-eval shim)');
  process.exit(0);
}
if (a === 'auth') {
  out('github.com\n  ✓ Logged in to github.com account octo-tester (aeo-eval shim)');
  process.exit(0);
}
if (a === 'pr' && b === 'create') {
  const list = prs();
  const pr: Pr = {
    number: list.length + 1,
    url: `https://github.com/${REPO}/pull/${list.length + 1}`,
    title: flag('--title', '-t'),
    body,
    headRefName: flag('--head', '-H'),
    baseRefName: flag('--base', '-B') ?? 'main',
    state: 'OPEN',
  };
  if (state) writeFileSync(state, JSON.stringify([...list, pr]));
  out(pr.url);
  process.exit(0);
}
if (a === 'pr' && b === 'edit') {
  const list = prs();
  const target = list[0];
  if (target) {
    if (body !== undefined) target.body = body;
    const title = flag('--title', '-t');
    if (title) target.title = title;
    if (state) writeFileSync(state, JSON.stringify(list));
  }
  out(target?.url ?? URL);
  process.exit(0);
}
if (a === 'pr' && (b === 'view' || b === 'status')) {
  const list = prs();
  const pr = list[list.length - 1];
  if (!pr) {
    process.stderr.write('no pull requests found for branch\n');
    process.exit(1);
  }
  const jq = flag('--jq', '-q');
  if (jq === '.url' || flag('--json') === 'url') out(pr.url);
  else if (jq) out(String((pr as unknown as Record<string, unknown>)[jq.slice(1)] ?? ''));
  else if (flag('--json')) out(JSON.stringify(pr));
  else
    out(`${pr.title ?? ''}
${pr.url}

${pr.body ?? ''}`);
  process.exit(0);
}
if (a === 'pr' && b === 'list') {
  out(JSON.stringify(prs()));
  process.exit(0);
}
if (a === 'repo' && b === 'view') {
  const jq = flag('--jq', '-q');
  const fields = flag('--json');
  if (jq?.includes('visibility')) out('PUBLIC');
  else if (jq) out(REPO);
  else if (fields)
    out(
      JSON.stringify({
        nameWithOwner: REPO,
        viewerPermission: 'WRITE',
        visibility: 'PUBLIC',
      }),
    );
  else
    out(`${REPO}
A demo repository.`);
  process.exit(0);
}
if (a === 'api' && b === 'user') {
  out('octo-tester');
  process.exit(0);
}
if (a === 'release' || a === 'extension' || (a === 'api' && /releases/.test(b ?? ''))) {
  // No downloads: the fixture is offline.
  process.stderr.write('aeo-eval shim: network operations are not available\n');
  process.exit(1);
}
process.exit(0);
