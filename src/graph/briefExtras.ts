/**
 * Brief rows built from facts the other sections already hold, kept apart so
 * the main brief query stays readable:
 * - open points a writer should state (`limits` rows): no passing run after
 *   the last commit, a failed publishing command, added remote-call branches
 *   no recorded run shows running live;
 * - the entry point: the changed function that owns the behavior, by the
 *   other changed symbols its new lines call;
 * - the cap on `limits` rows.
 * Generic rules over graph facts only; each row is short and cites its refs.
 */
import type { GraphEngine } from './engine.ts';
import { fileRole as pathRole } from '../digest/build.ts';
import { unitRole } from './build.ts';

type Row = Record<string, unknown>;

/** At most this many `limits` rows: each needs a clause in the PR. */
export const MAX_LIMITS = 6;

const shortSha = (s: unknown) => String(s ?? '').slice(0, 12);

/**
 * "No passing run after the last commit", when it holds: the session's check
 * runs (this PR's turns) all came before the last commit, or none passed after.
 * The process rows say the same per kind; as a limit a writer states it.
 */
export function noPassAfterCommitRow(g: GraphEngine, scopedRuns: Row[]): Row | undefined {
  if (!scopedRuns.length) return undefined;
  const last = g
    .run('MATCH (k:Commit) WHERE k.t IS NOT NULL RETURN k.id AS id, k.t AS t')
    .rows.sort(
      (a, b) =>
        String(b.t).localeCompare(String(a.t)) ||
        String(a.id).localeCompare(String(b.id)),
    )[0];
  if (!last) return undefined;
  const passed = scopedRuns.filter((r) => r.outcome === 'passed');
  if (passed.some((r) => String(r.t ?? '') > String(last.t))) return undefined;
  const lastPass =
    [...passed]
      .sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')))
      .filter((r) => r.kind === 'test')
      .at(-1) ?? passed.at(-1);
  return {
    change: null,
    kind: 'open',
    limit: `No passing check run was recorded after the last commit (${shortSha(last.id)})${
      lastPass
        ? `; the last pass (${String(lastPass.id)}, ${String(lastPass.kind)}) came before it`
        : ''
    }.`,
  };
}

/** Commands that publish, push or deploy: their failure leaves open what reached the remote. */
const PUBLISHING =
  /^(?:gh\s+(?:pr|release|repo|workflow)|git\s+push|(?:npm|pnpm|bun|yarn(?:\s+npm)?)\s+publish|cargo\s+publish|twine\s+upload|poetry\s+publish|gem\s+push|docker\s+push|helm\s+(?:install|upgrade)|kubectl\s+(?:apply|rollout)|terraform\s+apply|vercel|netlify|fly(?:ctl)?\s+deploy|wrangler|firebase\s+deploy|\S+\s+deploy)\b/i;

/** `failedCmds` entries are `<cmd> (failed N of M)`; older graphs have only `failedCommand`. */
const parseFailed = (s: string) => {
  const m = /^(.*?)\s+\(failed (\d+) of (\d+)\)$/.exec(s);
  return m
    ? { cmd: m[1]!, failures: Number(m[2]), count: Number(m[3]) }
    : { cmd: s, failures: 1, count: 0 };
};

/** A failed command that publishes, pushes or deploys, from the included sessions. */
export function failedPublishRows(g: GraphEngine): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const s of g
    .run(
      `MATCH (s:Session {band: 'included'})
       RETURN s.id AS id, s.agent AS agent, s.failedCmds AS cmds, s.failedCommand AS one`,
    )
    .rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const cmds = Array.isArray(s.cmds)
      ? (s.cmds as string[])
      : s.one
        ? [String(s.one)]
        : [];
    for (const c of cmds.map(parseFailed)) {
      if (!PUBLISHING.test(c.cmd.trim()) || seen.has(c.cmd)) continue;
      seen.add(c.cmd);
      const again = c.count > c.failures;
      out.push({
        change: null,
        kind: 'open',
        limit: again
          ? `\`${c.cmd}\` failed ${c.failures} of ${c.count} times in the ${String(s.agent)} session; which attempt published or pushed what isn't recorded.`
          : `\`${c.cmd}\` failed in the ${String(s.agent)} session; whether or how the work was then published or pushed isn't recorded.`,
      });
    }
  }
  return out.slice(0, 2);
}

/** Words of code that reaches a remote service or external program. */
const REMOTE_CODE = new Set([
  'fetch',
  'http',
  'https',
  'axios',
  'socket',
  'websocket',
  'webhook',
  'bearer',
  'authorization',
  'grpc',
  'curl',
]);
/** Words of a path or name about a remote route. */
const REMOTE_NAME =
  /\b(?:providers?|routes?|remote|clients?|api|http|network|endpoints?|servers?|upload|download|webhooks?|services?|gateway|fetch)\b/i;
const splitName = (s: string) =>
  s
    .replace(/\.[^./]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z]+/g, ' ');

/**
 * Added branches in a source file that calls out to a remote service (its
 * changed lines fetch, use http or a socket, and its path or symbols name a
 * provider, route, client or API) and that no recorded check run's command
 * names: tests and checks don't show those paths running against the real
 * service. Conservative: both signals, added branches, at most two files.
 */
export function remotePathRows(
  hunkRows: Row[],
  fileRole: Map<string, string>,
  scopedRuns: Row[],
): Row[] {
  const byFile = new Map<string, Row[]>();
  for (const h of hunkRows) {
    const f = String(h.file);
    if (unitRole(f, fileRole.get(f) ?? pathRole(f)) !== 'src') continue;
    byFile.set(f, [...(byFile.get(f) ?? []), h]);
  }
  const cmds = scopedRuns.map((r) => String(r.cmd ?? '')).join('\n');
  const out: { file: string; change: string; branches: number; syms: string[] }[] = [];
  for (const [file, hs] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    const branches = hs.reduce((n, h) => n + Number(h.branches ?? 0), 0);
    if (!branches) continue;
    const words = new Set(hs.flatMap((h) => ((h.words as string[]) ?? []).map(String)));
    if (![...REMOTE_CODE].some((w) => words.has(w))) continue;
    const syms = [
      ...new Set(
        hs
          .filter((h) => Number(h.branches ?? 0) > 0)
          .flatMap((h) => ((h.symbols as string[]) ?? []).map(String)),
      ),
    ].filter((x) => /[a-z][A-Z]|_/.test(x) || x.length >= 8);
    const named = [file.split('/').pop() ?? '', ...syms].map(splitName).join(' ');
    if (!REMOTE_NAME.test(named)) continue;
    const stem = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    if (
      stem.length >= 3 &&
      new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(cmds)
    )
      continue;
    const top = [...hs].sort(
      (a, b) => Number(b.branches ?? 0) - Number(a.branches ?? 0),
    )[0]!;
    out.push({ file, change: String(top.change), branches, syms: syms.slice(0, 3) });
  }
  return out
    .sort((a, b) => b.branches - a.branches || a.file.localeCompare(b.file))
    .slice(0, 2)
    .map((x) => ({
      change: x.change,
      kind: 'open',
      limit: `${x.file} adds branches that call a remote service${x.syms.length ? ` (${x.syms.map((s) => `\`${s}\``).join(', ')})` : ''}; no recorded check run shows those paths running against the real service.`,
    }));
}

/**
 * At most MAX_LIMITS rows. Over the cap, the lowest-priority rows go first:
 * the remote-path rows, then the "no request recorded" row, then the tail.
 */
export function capLimits(
  existing: Row[],
  extra: Row[],
  remote: Row[],
  max = MAX_LIMITS,
): Row[] {
  let all = [...existing, ...extra, ...remote];
  const drop = (pred: (r: Row) => boolean) => {
    while (all.length > max) {
      const i = all.findLastIndex(pred);
      if (i < 0) return;
      all.splice(i, 1);
    }
  };
  drop((r) => remote.includes(r));
  drop((r) => /^No user request was recorded/.test(String(r.limit ?? '')));
  return all.slice(0, max);
}

/** Added code of a hunk's `code` lines: `+ x`, or the new side of `- a ⇒ + b`. */
const addedCode = (code: unknown) =>
  ((code as string[]) ?? [])
    .map(String)
    .map((l) => (l.includes('⇒') ? l.split('⇒').pop()!.trim() : l))
    .filter((l) => l.startsWith('+ '))
    .map((l) => l.slice(2))
    .join('\n');

const NAME = /^[A-Za-z_$][\w$]{2,}$/;
/** A function or value name: starts lowercase, not ALL_CAPS. */
const CALLABLE = /^[a-z_$][\w$]*[a-z][\w$]*$/;
const uniqStr = (xs: string[]) => [...new Set(xs)];
const MIN_CALLS = 2;

/**
 * Where a reviewer starts: the changed function in a shipped source file
 * (not a test or script) whose new lines call the most changed symbols of
 * other files (it owns the behavior they implement), named with its file. A hunk belongs to the function git names after its @@
 * (the one it starts in), else the first it touches. Needs MIN_CALLS distinct
 * calls; otherwise the most-referenced changed symbol from the head scan, if
 * a source file defines it. Undefined when neither holds.
 */
export function entryRow(g: GraphEngine): Row | undefined {
  const hunks = g
    .run(
      `MATCH (c:Change)-[:HAS]->(h:Hunk)-[:OF]->(f:File)
       RETURN c.id AS change, h.id AS id, h.file AS file, f.role AS role, h.scope AS scope,
              h.touched AS touched, h.fresh AS fresh, h.symbols AS symbols, h.code AS code,
              h.diff AS diff, h.branches AS branches`,
    )
    .rows.filter((h) => unitRole(String(h.file), String(h.role ?? '')) === 'src')
    .sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));
  if (!hunks.length) return undefined;
  const definedIn = new Map<string, string>();
  for (const h of hunks)
    for (const s of [
      ...((h.symbols as string[]) ?? []),
      ...((h.fresh as string[]) ?? []),
      ...((h.touched as string[]) ?? []),
    ])
      if (NAME.test(String(s)) && String(s).length >= 4 && !definedIn.has(String(s)))
        definedIn.set(String(s), String(h.file));
  const refsOf = new Map(
    g
      .run(
        `MATCH (x:HeadRef) WHERE x.kind <> 'still mentions' RETURN x.term AS term, x.files AS files, x.kind AS kind, x.definedIn AS definedIn`,
      )
      .rows.map((r) => [String(r.term), r]),
  );
  const owners = new Map<
    string,
    {
      name: string;
      file: string;
      change: string;
      calls: Set<string>;
      diff: string[];
      branches: number;
    }
  >();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const h of hunks) {
    const owner = [h.scope, ...((h.touched as string[]) ?? [])]
      .map((x) => (x == null ? '' : String(x)))
      .find((x) => NAME.test(x));
    if (!owner) continue;
    const code = addedCode(h.code);
    const key = `${String(h.file)}#${owner}`;
    const o = owners.get(key) ?? {
      name: owner,
      file: String(h.file),
      change: String(h.change),
      calls: new Set<string>(),
      diff: [],
      branches: 0,
    };
    // Calls into other files' changed code: the function that wires the
    // change together, not a helper calling its neighbours.
    // Functions and values only: a type (`ProviderId`) or constant is not a call.
    for (const [name, file] of definedIn)
      if (
        name !== owner &&
        file !== String(h.file) &&
        CALLABLE.test(name) &&
        new RegExp(`\\b${esc(name)}\\s*[(),\\]]`).test(code)
      )
        o.calls.add(name);
    o.diff.push(String(h.diff));
    o.branches += Number(h.branches ?? 0);
    owners.set(key, o);
  }
  const refFiles = (n: string) => Number(refsOf.get(n)?.files ?? 0);
  const ranked = [...owners.values()]
    .filter((o) => o.calls.size >= MIN_CALLS)
    .sort(
      (a, b) =>
        b.calls.size - a.calls.size ||
        refFiles(b.name) - refFiles(a.name) ||
        b.branches - a.branches ||
        a.file.localeCompare(b.file) ||
        a.name.localeCompare(b.name),
    );
  const best = ranked[0];
  if (best) {
    // The next owner in the same file, often the one choosing between paths.
    const next = ranked.find((o) => o !== best && o.file === best.file);
    const called = [...best.calls].sort();
    const elsewhere = [
      ...new Set(called.map((c) => definedIn.get(c)!).filter((f) => f !== best.file)),
    ];
    return {
      kind: 'entry',
      fact: `Start at \`${best.name}\` in ${best.file}: its changed lines call ${called
        .slice(0, 4)
        .map((c) => `\`${c}\``)
        .join(', ')}${called.length > 4 ? ` and ${called.length - 4} more` : ''}${
        elsewhere.length ? ` (from ${elsewhere.slice(0, 2).join(', ')})` : ''
      }${
        next
          ? `; then \`${next.name}\` there (calls ${[...next.calls]
              .sort()
              .slice(0, 3)
              .map((c) => `\`${c}\``)
              .join(', ')})`
          : ''
      }.`,
      cites: uniqStr([
        best.change,
        ...best.diff.slice(0, 2),
        ...(next ? [next.change, next.diff[0]!] : []),
      ]),
    };
  }
  const top = [...refsOf.values()].find((r) => r.kind === 'most referenced');
  const file = top ? ((top.definedIn as string[]) ?? []).map(String)[0] : undefined;
  if (!top || !file || unitRole(file, pathRole(file)) !== 'src') return undefined;
  const h = hunks.find((x) => x.file === file);
  return {
    kind: 'entry',
    fact: `Start at \`${String(top.term)}\` in ${file}: the changed symbol most named elsewhere (${Number(top.files)} other file(s)).`,
    cites: h ? [String(h.change), String(h.diff)] : [],
  };
}
