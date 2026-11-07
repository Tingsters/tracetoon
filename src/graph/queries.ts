/**
 * Named questions agents ask the evidence graph. Each runs Cypher on the loaded
 * graph; TypeScript only groups and orders rows so results are deterministic and
 * compact. Results are sections of rows, printed as TOON by `tracetoon query`.
 */
import { GraphError, type GraphEngine } from './engine.ts';
import { shownCommand } from './briefRender.ts';
import { SCHEMA_DOC } from './model.ts';

export interface Section {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface NamedQuery {
  name: string;
  args: string;
  help: string;
  run(g: GraphEngine, args: string[]): Section[];
}

const CHECK_KINDS = ['test', 'build', 'typecheck', 'lint', 'eval'];
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const byDiff = (a: string, b: string) =>
  Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
const factOrder = (a: string, b: string) =>
  a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a.localeCompare(b);
const section = (title: string, columns: string[], rows: Record<string, unknown>[]) => ({
  title,
  columns,
  rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))),
});

/** Resolve a target to a file path or hunk id; accepts `path`, `path:line`, `H3`, `diff:120`. */
function target(
  g: GraphEngine,
  raw: string | undefined,
): { file?: string; hunk?: string } {
  if (!raw)
    throw new GraphError('Give a file path, a hunk (H3) or a diff line (diff:120).');
  if (/^H\d+$/.test(raw)) return { hunk: raw };
  const diff = /^diff:(\d+)/.exec(raw);
  const line = diff ? undefined : /^(.+?):(\d+)$/.exec(raw);
  if (diff || line) {
    const hunks = g.run(
      'MATCH (h:Hunk) RETURN h.id AS id, h.diff AS diff, h.file AS file, h.start AS start, h.end AS end',
    ).rows;
    const n = Number((diff ?? line)![diff ? 1 : 2]);
    const hit = hunks.find((h) => {
      if (diff) {
        const [a, b] = String(h.diff).slice(5).split('-').map(Number);
        return n >= a! && n <= (b ?? a!);
      }
      return h.file === line![1] && n >= Number(h.start) && n <= Number(h.end);
    });
    if (!hit) throw new GraphError(`No hunk at ${raw}.`);
    return { hunk: String(hit.id) };
  }
  const path = raw.replace(/^\.\//, '');
  const found = g.run(
    'MATCH (f:File) WHERE f.id = $p OR f.id ENDS WITH $s RETURN f.id AS id',
    {
      p: path,
      s: `/${path}`,
    },
  ).rows;
  if (!found.length) throw new GraphError(`No file ${raw} in this run's evidence graph.`);
  if (found.length > 1)
    throw new GraphError(
      `${raw} matches ${found.map((f) => f.id).join(', ')}; give the full path.`,
    );
  return { file: String(found[0]!.id) };
}

/** Per prompt: the turn's surviving edits into the target, its decisions and plans. */
function turnsInto(g: GraphEngine, t: { file?: string; hunk?: string }): Section {
  const rows = g.run(
    `${t.hunk ? 'MATCH (h0:Hunk {id: $id})<-[:SURVIVES_IN]-(e:Edit)' : 'MATCH (:File {id: $id})<-[:EDITS]-(e:Edit)'}-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (e)-[s:SURVIVES_IN]->(h:Hunk)
     OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
     OPTIONAL MATCH (x)-[:IN_TURN]->(p) WHERE x:Decision OR x:Plan
     RETURN p.id AS prompt, p.text AS text, p.pushback AS pushback, e.id AS edit,
            e.surviving AS surviving, h.diff AS diff, h.file AS hfile, collect(DISTINCT x.id) AS facts`,
    { id: t.hunk ?? t.file },
  ).rows;
  type Turn = {
    prompt: string;
    text: string;
    pushback: boolean;
    edits: Map<string, number>;
    diffs: string[];
    facts: string[];
  };
  const turns = new Map<string, Turn>();
  for (const r of rows) {
    const key = String(r.prompt ?? '(no prompt)');
    const turn: Turn = turns.get(key) ?? {
      prompt: key,
      text: String(r.text ?? ''),
      pushback: !!r.pushback,
      edits: new Map(),
      diffs: [],
      facts: [],
    };
    turn.edits.set(String(r.edit), Number(r.surviving ?? 0));
    if (r.diff && (!t.file || r.hfile === t.file)) turn.diffs.push(String(r.diff));
    turn.facts.push(...((r.facts as string[]) ?? []));
    turns.set(key, turn);
  }
  return section(
    'turns',
    [
      'prompt',
      'pushback',
      'edits',
      'survivingLines',
      'deadEndEdits',
      'diff',
      'facts',
      'text',
    ],
    [...turns.values()]
      .sort((a, b) => factOrder(a.prompt, b.prompt))
      .map((t) => ({
        prompt: t.prompt,
        pushback: t.pushback || null,
        edits: t.edits.size,
        survivingLines: [...t.edits.values()].reduce((a, b) => a + b, 0),
        deadEndEdits: [...t.edits.values()].filter((n) => n === 0).length,
        diff: uniq(t.diffs).sort(byDiff),
        facts: uniq(t.facts).sort(factOrder),
        text: t.text,
      })),
  );
}

/** Check runs (test, build, …) of included sessions after a file's last captured edit. */
export function checksAfterLastEdit(
  g: GraphEngine,
  file?: string,
): {
  file: string;
  role: string;
  lastEdit: string | null;
  after: { id: string; outcome: string; kind: string }[];
}[] {
  // Two indexed lookups, then the time comparison here: a files × runs join in
  // Cypher grows with their product.
  const files = g.run(
    `MATCH (f:File {inPr: true}) ${file ? 'WHERE f.id = $file' : ''}
     OPTIONAL MATCH (f)<-[:EDITS]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     RETURN f.id AS file, f.role AS role, max(e.t) AS lastEdit, count(e) AS edits,
            collect(CASE WHEN e.via = 'shell' THEN e.t END) AS shellTimes,
            collect(CASE WHEN e.via IS NULL THEN e.t END) AS toolTimes`,
    { file: file ?? null },
  ).rows;
  const runs = g
    .run(
      `MATCH (r:Run)-[:IN_SESSION]->(:Session {band: 'included'})
       WHERE r.t IS NOT NULL AND r.kind IN $kinds AND r.revision <> 'after later work'
       RETURN r.id AS id, r.outcome AS outcome, r.kind AS kind, r.t AS t`,
      { kinds: CHECK_KINDS },
    )
    .rows.map((r) => ({
      id: String(r.id),
      outcome: String(r.outcome),
      kind: String(r.kind),
      t: String(r.t),
    }));
  const out = new Map<
    string,
    {
      file: string;
      role: string;
      lastEdit: string | null;
      after: { id: string; outcome: string; kind: string; t: string }[];
    }
  >();
  for (const f of files) {
    const lastEdit = Number(f.edits) ? ((f.lastEdit as string | null) ?? null) : null;
    out.set(String(f.file), {
      file: String(f.file),
      role: String(f.role),
      lastEdit,
      // A run in the same command as a shell edit (sed … && bun test) shares its
      // timestamp; chained after the edit, it saw it.
      after: lastEdit
        ? runs.filter(
            (r) =>
              r.t > lastEdit ||
              (r.t === lastEdit &&
                ((f.shellTimes as string[]) ?? []).includes(lastEdit) &&
                !((f.toolTimes as string[]) ?? []).includes(lastEdit)),
          )
        : [],
    });
  }
  return [...out.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((f) => ({
      ...f,
      after: f.after
        .sort((a, b) => b.t.localeCompare(a.t) || factOrder(a.id, b.id))
        .map(({ t: _t, ...r }) => r),
    }));
}

export function unexplainedHunks(g: GraphEngine): Record<string, unknown>[] {
  return g
    .run(
      `MATCH (h:Hunk)-[:OF]->(f:File)
       WHERE f.role IN ['behavior', 'tests']
         AND NOT EXISTS { MATCH (:Session {band: 'included'})<-[:IN_SESSION]-(:Edit)-[:SURVIVES_IN]->(h) }
       OPTIONAL MATCH (c:Commit)-[:TOUCHES]->(f)
       OPTIONAL MATCH (s:Session)-[:MADE]->(c)
       RETURN h.id AS hunk, h.diff AS diff, f.id AS file, h.added AS added, h.removed AS removed,
              collect(DISTINCT c.id) AS commits, count(DISTINCT s) AS sessionCommits`,
    )
    .rows.map((r): Record<string, unknown> => ({
      ...r,
      commits: ((r.commits as string[]) ?? []).sort(),
      removalOnly: Number(r.added) === 0 || null,
    }))
    .sort((a, b) => byDiff(String(a.diff), String(b.diff)));
}

const clipText = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const refs = (xs: string[], cap: number) =>
  xs.length > cap ? [...xs.slice(0, cap), `+${xs.length - cap} more`] : xs;

/**
 * Everything a description needs, in the order it is written: the change units
 * (with the symbols that own them), why each was made, what checked it and when,
 * what the evidence does not establish, and what not to claim. Each row cites
 * its evidence; nothing in it is inferred beyond the graph.
 */
export function brief(g: GraphEngine): Section[] {
  return briefParts(g).sections;
}

/**
 * The brief plus what `render` needs to write the Validation section itself:
 * behavior or test files with no recorded passing check after their last
 * captured edit.
 */
export function briefParts(g: GraphEngine): { sections: Section[]; unchecked: string[] } {
  const changes = g
    .run(
      `MATCH (c:Change)
       RETURN c.id AS id, c.key AS key, c.files AS files, c.roles AS roles, c.symbols AS symbols,
              c.added AS added, c.removed AS removed, c.branches AS branches`,
    )
    .rows.sort((a, b) => Number(String(a.id).slice(2)) - Number(String(b.id).slice(2)));
  const hunkRows = g.run(
    `MATCH (c:Change)-[:HAS]->(h:Hunk)
     OPTIONAL MATCH (h)<-[:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (h)<-[:INTRODUCED]-(k:Commit)
     RETURN c.id AS change, h.id AS hunk, h.file AS file, h.diff AS diff, h.scope AS scope,
            h.touched AS symbols, h.branches AS branches, count(DISTINCT e) AS edits,
            collect(DISTINCT k.id) AS commits`,
  ).rows;
  const fileRole = new Map(
    g
      .run('MATCH (f:File {inPr: true}) RETURN f.id AS id, f.role AS role')
      .rows.map((r) => [String(r.id), String(r.role)]),
  );
  const asked = g.run(
    `MATCH (c:Change)-[a:ASKED_BY]->(p:Prompt)
     OPTIONAL MATCH (x)-[:IN_TURN]->(p) WHERE x:Decision OR x:Plan
     RETURN c.id AS change, p.id AS id, p.text AS text, p.pushback AS pushback, a.how AS how,
            collect(DISTINCT x.id) AS facts`,
  ).rows;
  const turnFacts = new Map(
    g
      .run(
        `MATCH (x)-[:IN_TURN]->(:Prompt) WHERE x:Decision OR x:Plan
         RETURN x.id AS id, coalesce(x.excerpt, x.text) AS text`,
      )
      .rows.map((r) => [String(r.id), String(r.text ?? '')]),
  );
  const said = g.run(
    `MATCH (c:Change)-[:EXPLAINED_BY]->(k:Commit)
     OPTIONAL MATCH (k)-[:SAYS]->(m:CommitClaim)
     RETURN c.id AS change, k.id AS commit, k.subject AS subject,
            collect(DISTINCT {id: m.id, text: m.text, result: m.assertsResult}) AS claims`,
  ).rows;
  const commitScope = new Map<string, string[]>();
  for (const h of hunkRows)
    for (const k of (h.commits as string[]) ?? [])
      commitScope.set(k, uniq([...(commitScope.get(k) ?? []), String(h.file)]));

  const changeRows = changes.map((c) => {
    const hs = hunkRows
      .filter((h) => h.change === c.id)
      .sort((a, b) => byDiff(String(a.diff), String(b.diff)));
    const files = (c.files as string[]) ?? [];
    const where = files.map((f) => {
      const syms = uniq(
        hs.filter((h) => h.file === f).flatMap((h) => (h.symbols as string[]) ?? []),
      ).slice(0, 6);
      return syms.length ? `${f} (${syms.join(', ')})` : f;
    });
    return {
      change: c.id,
      groupedBy: String(c.key).split(':')[0],
      where,
      added: c.added,
      removed: c.removed,
      diff: refs(
        hs.map((h) => String(h.diff)),
        10,
      ),
      commits: uniq(hs.flatMap((h) => (h.commits as string[]) ?? [])).sort(),
      requests: uniq(
        asked.filter((a) => a.change === c.id).map((a) => String(a.id)),
      ).sort(factOrder),
    };
  });

  // Each request and commit sentence once; changes cite them by ref.
  const requests: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const a of [...asked].sort((x, y) => factOrder(String(x.id), String(y.id)))) {
    if (seen.has(String(a.id))) continue;
    seen.add(String(a.id));
    requests.push({
      ref: a.id,
      kind: a.pushback ? 'user request (pushback)' : 'user request',
      text: clipText(a.text, 600),
    });
    for (const f of ((a.facts as string[]) ?? []).sort(factOrder))
      if (!seen.has(f)) {
        seen.add(f);
        requests.push({
          ref: f,
          kind: `${f.startsWith('P') ? 'plan' : 'decision'} in the turn of ${String(a.id)}`,
          text: clipText(turnFacts.get(f), 400),
        });
      }
  }
  const commitText: Record<string, unknown>[] = [];
  const commitsSeen = new Set<string>();
  for (const k of [...said].sort((x, y) =>
    String(x.commit).localeCompare(String(y.commit)),
  )) {
    if (commitsSeen.has(String(k.commit))) continue;
    commitsSeen.add(String(k.commit));
    const scope = (commitScope.get(String(k.commit)) ?? []).sort().join(' ');
    commitText.push({ ref: `commit:${String(k.commit)}`, about: scope, text: k.subject });
    for (const m of ((k.claims as { id: string; text: string; result: boolean }[]) ?? [])
      .filter((m) => m.id && !m.result)
      .sort((x, y) => Number(x.id.split('#')[1]) - Number(y.id.split('#')[1])))
      commitText.push({
        ref: m.id,
        about: `commit ${String(k.commit)} only`,
        text: m.text,
      });
  }
  for (const r of changeRows) {
    const links = asked.filter((a) => a.change === r.change);
    (r as Record<string, unknown>).requests = links
      .sort((x, y) => factOrder(String(x.id), String(y.id)))
      .map((a) =>
        a.how === 'its edits survive here'
          ? String(a.id)
          : `${String(a.id)} (${String(a.how)})`,
      );
    if (!links.length && !(r.commits as string[]).length)
      (r as Record<string, unknown>).requests = [
        'none captured: say what it does, not why',
      ];
  }

  const receipts = g
    .run(
      'MATCH (v:Receipt) RETURN v.id AS id, v.kind AS kind, v.outcome AS outcome, v.summary AS summary, v.when AS when, v.cmd AS cmd',
    )
    .rows.sort((a, b) => factOrder(String(a.id), String(b.id)));
  const runs = g
    .run(
      `MATCH (r:Run)-[:IN_SESSION]->(:Session {band: 'included'})
       WHERE r.kind IN $kinds
       OPTIONAL MATCH (r)-[:LATER_EDIT]->(f:File)
       RETURN r.id AS id, r.kind AS kind, r.outcome AS outcome, r.summary AS summary,
              r.when AS when, r.cmd AS cmd, r.t AS t, r.revision AS revision,
              collect(DISTINCT f.id) AS later`,
      { kinds: CHECK_KINDS },
    )
    .rows.filter((r) => r.revision !== 'after later work')
    .sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
  // The last run of each command is what the session ended on; earlier ones are history.
  // Keyed by the command as shown, so `tsc` and `tsc 2>&1` are one command;
  // re-inserted so the map's order is the order of each command's last run.
  const lastOf = new Map<string, Record<string, unknown>>();
  for (const r of runs) {
    const key = shownCommand(r.cmd);
    lastOf.delete(key);
    lastOf.set(key, r);
  }
  // Runs that saw the final edits are what counts; an earlier, stale run is kept
  // only when no later run of its kind exists, as the best evidence there is.
  const current = (r: Record<string, unknown>) =>
    r.revision === 'no later edits seen' && !((r.later as string[]) ?? []).length;
  for (const [cmd, r] of [...lastOf])
    if (!current(r) && [...lastOf.values()].some((x) => current(x) && x.kind === r.kind))
      lastOf.delete(cmd);
  const staleKinds = new Map<string, string>();
  for (const [cmd, r] of lastOf) if (!current(r)) staleKinds.set(String(r.kind), cmd);
  for (const [cmd, r] of [...lastOf])
    if (!current(r) && staleKinds.get(String(r.kind)) !== cmd) lastOf.delete(cmd);
  const validation: Record<string, unknown>[] = (
    [
      ...receipts.map((v) => ({ ...v, editedAfter: [] as string[] })),
      ...[...lastOf.values()]
        .sort((a, b) => factOrder(String(a.id), String(b.id)))
        .map((r) => ({
          ...r,
          editedAfter: refs(((r.later as string[]) ?? []).sort(), 5),
        })),
    ] as Record<string, unknown>[]
  ).map((r) => ({
    check: r.id,
    kind: r.kind,
    outcome: r.outcome,
    result: ((r.summary as string[]) ?? []).join('; ') || null,
    when: (r.editedAfter as string[]).length
      ? 'before later edits to the files in editedAfter'
      : r.when,
    editedAfter: r.editedAfter,
    cmd: r.cmd,
  }));
  for (const m of g
    .run(
      'MATCH (m:CommitClaim {assertsResult: true}) RETURN m.id AS id, m.commit AS commit, m.text AS text',
    )
    .rows.sort((a, b) => String(a.id).localeCompare(String(b.id))))
    validation.push({
      check: m.id,
      kind: 'commit message',
      outcome: 'asserted',
      result: null,
      when: `not a run: commit ${String(m.commit)} says so`,
      editedAfter: [],
      cmd: m.text,
    });

  const checks = new Map(checksAfterLastEdit(g).map((c) => [c.file, c]));
  // A file no captured edit explains still has a last-change time: its commits'.
  const committed = new Map<string, string>();
  for (const r of g.run(
    `MATCH (k:Commit)-[:TOUCHES]->(f:File) WHERE k.t IS NOT NULL RETURN f.id AS file, max(k.t) AS t`,
  ).rows)
    committed.set(String(r.file), String(r.t));
  const passedAfter = (t: string) =>
    runs
      .filter((r) => r.outcome === 'passed' && String(r.t ?? '') > t)
      .map((r) => String(r.id));
  const freshPass = receipts
    .filter((v) => v.outcome === 'passed')
    .map((v) => String(v.id));
  const limits: Record<string, unknown>[] = [];
  const uncheckedAll: string[] = [];
  for (const c of changes) {
    const hs = hunkRows.filter((h) => h.change === c.id);
    const behavior = ((c.files as string[]) ?? []).filter((f) =>
      ['behavior', 'tests'].includes(fileRole.get(f) ?? ''),
    );
    const unchecked = behavior.filter((f) => {
      const k = checks.get(f);
      if (k?.lastEdit) return !k.after.some((x) => x.outcome === 'passed');
      const t = committed.get(f);
      return !t || !passedAfter(t).length;
    });
    uncheckedAll.push(...unchecked);
    if (unchecked.length)
      limits.push({
        change: c.id,
        limit: freshPass.length
          ? `No logged passing check after the last captured edit of ${unchecked.join(', ')}; fresh ${freshPass.join(', ')} passed on the submitted code, which shows the suite passes, not that it exercises this change.`
          : `No recorded passing test, build, lint or typecheck run after the last captured edit of ${unchecked.join(', ')}: say "no recorded run", not "untested" or "not exercised".`,
      });
    const unexplained = hs.filter(
      (h) =>
        !Number(h.edits) &&
        !((h.commits as string[]) ?? []).length &&
        ['behavior', 'tests'].includes(fileRole.get(String(h.file)) ?? ''),
    );
    if (unexplained.length)
      limits.push({
        change: c.id,
        limit: `${unexplained.length} hunk(s) with no captured edit or commit link (${refs(
          unexplained.map((h) => String(h.diff)),
          4,
        ).join(' ')}): read them in the patch before describing them.`,
      });
    // An instruction, not a fact: no count (the line test is rough) and no
    // wording a writer could copy into the PR as a claim about the code.
    if (Number(c.branches) > 0)
      limits.push({
        change: c.id,
        limit: `Before writing "always", "only", "no longer" or "all" about ${(() => {
          const where = uniq(
            hs
              .filter((h) => Number(h.branches) > 0)
              .map((h) => String(((h.symbols as string[]) ?? [])[0] ?? h.file)),
          ).slice(0, 5);
          return where.length ? where.join(', ') : 'this change';
        })()}, read its conditions in the patch; say it only if every path does it.`,
      });
    if (!asked.some((a) => a.change === c.id) && !said.some((x) => x.change === c.id))
      limits.push({
        change: c.id,
        limit: 'No captured motivation: do not supply one (e.g. "found while testing").',
      });
  }

  const avoid = [
    'Limits and these rules are instructions for you, not content for the PR: never copy their wording into the description.',
    "Don't write test, build, lint or typecheck results yourself: put the line `<!-- tracetoon:validation -->` where the validation section belongs, and `render` writes it from the validation rows.",
    'Tag each sentence that states a fact with the refs it rests on, e.g. `[CH1, S1]` (any ref from the brief: changes, requests, commit messages, validation rows); `render` removes the tags and lists sentences with no tag or an unknown ref.',
    "Tracetoon's line matching (matched %, unmatched lines, commits made in sessions) is not authorship: don't report who wrote what as percentages or counts.",
    'A commit-message sentence speaks for its own commit only: never generalize it to other commits ("all of these were found while…").',
    'Results that appear only in a commit message (validation rows marked "asserted") are not runs: attribute them to that commit message or leave them out.',
    "Checks listed with files edited after them did not see those edits: don't present them as testing the final code.",
    'A check dated after the last captured edit ran after the last edit the logs show, not necessarily on the final code: say that, and never "on the final code" or "after all changes".',
    'Absence of a recorded run is not evidence a check was never run or that code is untested: write "no recorded run", never "not tested", "not exercised" or "never ran".',
    'Quote run results exactly as the validation rows give them (command and counts); never add a count, suite or file the row does not show.',
    'Point reviewers at the symbol that owns a behavior (from changes.where), not at the largest file.',
    "A commit message listing several changes doesn't say which file implements each: tie a sentence to a file or symbol only where the diff shows that behavior there.",
  ].map((rule) => ({ rule }));

  const sections = [
    section(
      'changes',
      ['change', 'groupedBy', 'where', 'added', 'removed', 'diff', 'commits', 'requests'],
      changeRows,
    ),
    section('requests', ['ref', 'kind', 'text'], requests),
    section('commitMessages', ['ref', 'about', 'text'], commitText),
    section(
      'validation',
      ['check', 'kind', 'outcome', 'result', 'when', 'editedAfter', 'cmd'],
      validation,
    ),
    section('limits', ['change', 'limit'], limits),
    section('avoid', ['rule'], avoid),
  ];
  return { sections, unchecked: uniq(uncheckedAll).sort() };
}

export const QUERIES: NamedQuery[] = [
  {
    name: 'brief',
    args: '',
    help: 'Start here. The PR as a reviewer needs it: change units with the symbols that own them, why each was made (requests, plans, commit-message sentences scoped to their commit), checks with when they ran, limits the evidence leaves open, and what not to claim.',
    run: (g) => brief(g),
  },
  {
    name: 'schema',
    args: '',
    help: 'Node labels, relationships and properties, for writing your own --cypher.',
    run: () => [
      section(
        'nodes',
        ['label', 'properties'],
        Object.entries(SCHEMA_DOC.nodes).map(([label, properties]) => ({
          label,
          properties,
        })),
      ),
      section(
        'relationships',
        ['type', 'pattern'],
        Object.entries(SCHEMA_DOC.relationships).map(([type, pattern]) => ({
          type,
          pattern,
        })),
      ),
      section(
        'notes',
        ['note'],
        SCHEMA_DOC.notes.map((note) => ({ note })),
      ),
    ],
  },
  {
    name: 'outline',
    args: '',
    help: 'Every changed file: role, size, hunks, the prompts whose edits survive in it, the commits that touched it, and checks run after its last edit; then every commit, marking those with a message body to expand.',
    run: (g) => {
      const rows = g.run(
        `MATCH (f:File {inPr: true})
         OPTIONAL MATCH (h:Hunk)-[:OF]->(f)
         WITH f, count(h) AS hunks
         OPTIONAL MATCH (f)<-[:EDITS]-(e:Edit)-[:IN_TURN]->(p:Prompt)
           WHERE e.surviving > 0 AND EXISTS { MATCH (e)-[:IN_SESSION]->(:Session {band: 'included'}) }
         WITH f, hunks, collect(DISTINCT p.id) AS prompts
         OPTIONAL MATCH (c:Commit)-[:TOUCHES]->(f)
         RETURN f.id AS file, f.role AS role, f.added AS added, f.removed AS removed, f.unmatched AS unmatched,
                hunks, prompts, collect(DISTINCT c.id) AS commits`,
      ).rows;
      const checks = new Map(checksAfterLastEdit(g).map((c) => [c.file, c]));

      const rank = (role: unknown) => ({ behavior: 0, tests: 1 })[String(role)] ?? 2;
      return [
        section(
          'files',
          [
            'file',
            'role',
            'added',
            'removed',
            'hunks',
            'unmatched',
            'prompts',
            'commits',
            'checksAfterLastEdit',
          ],
          rows
            .sort(
              (a, b) =>
                rank(a.role) - rank(b.role) ||
                Number(b.added) - Number(a.added) ||
                String(a.file).localeCompare(String(b.file)),
            )
            .map((r) => {
              const c = checks.get(String(r.file));
              return {
                ...r,
                prompts: ((r.prompts as string[]) ?? []).sort(factOrder),
                commits: ((r.commits as string[]) ?? []).sort(),
                checksAfterLastEdit: !c?.lastEdit
                  ? 'no captured edit'
                  : c.after.length
                    ? c.after.slice(0, 3).map((x) => `${x.id}:${x.outcome}`)
                    : 'none',
              };
            }),
        ),
        section(
          'commits',
          ['commit', 'subject', 'hasBody'],
          g
            .run(
              'MATCH (c:Commit) RETURN c.id AS commit, c.subject AS subject, c.body AS body',
            )
            .rows.sort((a, b) => String(a.commit).localeCompare(String(b.commit)))
            .map((r) => ({
              ...r,
              hasBody: r.body ? `yes; tracetoon expand commit:${String(r.commit)}` : null,
            })),
        ),
      ];
    },
  },
  {
    name: 'why',
    args: '<path|path:line|H#|diff:N>',
    help: 'Where a file or hunk came from: the prompts whose edits survive in it (with diff refs and the decisions/plans of that turn), every hunk with whether a captured edit explains it, and the commits that touched it with their message bodies.',
    run: (g, [raw]) => {
      const t = target(g, raw);
      const file =
        t.file ??
        String(
          g.run('MATCH (h:Hunk {id: $id}) RETURN h.file AS f', { id: t.hunk }).rows[0]?.f,
        );
      const out = [turnsInto(g, t)];
      // Every hunk of the target, not only those a captured edit explains: an
      // unexplained hunk still has to be read in the patch.
      out.push(
        section(
          'hunks',
          ['hunk', 'diff', 'added', 'removed', 'prompts', 'explained'],
          g
            .run(
              `MATCH (h:Hunk)-[:OF]->(:File {id: $file})
               ${t.hunk ? 'WHERE h.id = $hunk' : ''}
               OPTIONAL MATCH (h)<-[:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
               OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
               RETURN h.id AS hunk, h.diff AS diff, h.added AS added, h.removed AS removed,
                      collect(DISTINCT p.id) AS prompts, count(e) AS edits`,
              { file, hunk: t.hunk ?? null },
            )
            .rows.map((r): Record<string, unknown> => ({
              ...r,
              prompts: ((r.prompts as string[]) ?? []).sort(factOrder),
              explained:
                Number(r.edits) > 0
                  ? 'captured edit'
                  : 'no captured edit; read the patch',
            }))
            .sort((a, b) => byDiff(String(a.diff), String(b.diff))),
        ),
      );
      out.push(
        section(
          'commits',
          ['commit', 'subject', 'madeInSession', 'body'],
          g
            .run(
              `MATCH (c:Commit)-[:TOUCHES]->(:File {id: $file})
               OPTIONAL MATCH (s:Session)-[:MADE]->(c)
               RETURN c.id AS commit, c.subject AS subject, s.id AS madeInSession, c.body AS body`,
              { file },
            )
            .rows.sort((a, b) => String(a.commit).localeCompare(String(b.commit))),
        ),
      );
      const c = checksAfterLastEdit(g, file)[0];
      out.push(
        section(
          'checks',
          ['file', 'lastEdit', 'after'],
          [
            {
              file,
              lastEdit: c?.lastEdit ?? 'no captured edit',
              after: c?.after.map((x) => `${x.id}:${x.kind}:${x.outcome}`) ?? [],
            },
          ],
        ),
      );
      return out;
    },
  },
  {
    name: 'verified',
    args: '[path]',
    help: 'Per changed file: its last captured edit and the check runs after it (latest first). Log evidence only; never proof the submitted content passes.',
    run: (g, [raw]) => {
      const file = raw ? target(g, raw).file : undefined;
      return [
        section(
          'files',
          ['file', 'role', 'lastEdit', 'checksAfter'],
          checksAfterLastEdit(g, file).map((c) => ({
            file: c.file,
            role: c.role,
            lastEdit: c.lastEdit ?? 'no captured edit',
            checksAfter: c.after.map((x) => `${x.id}:${x.kind}:${x.outcome}`),
          })),
        ),
      ];
    },
  },
  {
    name: 'unverified',
    args: '',
    help: 'Behavior and test files with no passing check after their last captured edit, or with no captured edit at all.',
    run: (g) => [
      section(
        'files',
        ['file', 'role', 'lastEdit', 'why'],
        checksAfterLastEdit(g)
          .filter((c) => ['behavior', 'tests'].includes(c.role))
          .filter((c) => !c.lastEdit || !c.after.some((x) => x.outcome === 'passed'))
          .map((c) => ({
            file: c.file,
            role: c.role,
            lastEdit: c.lastEdit ?? null,
            why: !c.lastEdit
              ? 'no captured edit (shell, another tool or by hand)'
              : c.after.length
                ? `only ${c.after.map((x) => `${x.id}:${x.outcome}`).join(', ')} after the last edit`
                : 'no check ran after the last edit',
          })),
      ),
    ],
  },
  {
    name: 'unexplained',
    args: '',
    help: 'Behavior and test hunks no captured agent edit survives in, with the commits that touched their file.',
    run: (g) => [
      section(
        'hunks',
        [
          'hunk',
          'diff',
          'file',
          'added',
          'removed',
          'removalOnly',
          'commits',
          'sessionCommits',
        ],
        unexplainedHunks(g),
      ),
    ],
  },
  {
    name: 'turn',
    args: '<S#>',
    help: 'What one prompt led to: files and hunks its edits survive in, dead-end edits, and the decisions, plans and runs of that turn.',
    run: (g, [id]) => {
      if (!id || !/^S\d+$/.test(id)) throw new GraphError('Give a prompt id such as S3.');
      const p = g.run(
        'MATCH (p:Prompt {id: $id}) RETURN p.text AS text, p.pushback AS pushback, p.t AS t',
        { id },
      ).rows[0];
      if (!p) throw new GraphError(`No prompt ${id} in this run's evidence graph.`);
      const edits = g.run(
        `MATCH (e:Edit)-[:IN_TURN]->(:Prompt {id: $id})
         OPTIONAL MATCH (e)-[:SURVIVES_IN]->(h:Hunk)
         RETURN e.file AS file, e.id AS edit, e.surviving AS surviving, collect(h.diff) AS diffs`,
        { id },
      ).rows;
      const files = new Map<
        string,
        {
          file: string;
          edits: number;
          surviving: number;
          deadEnds: number;
          diff: string[];
        }
      >();
      for (const e of edits) {
        const f = files.get(String(e.file)) ?? {
          file: String(e.file),
          edits: 0,
          surviving: 0,
          deadEnds: 0,
          diff: [],
        };
        f.edits++;
        f.surviving += Number(e.surviving ?? 0);
        if (!Number(e.surviving)) f.deadEnds++;
        f.diff.push(...((e.diffs as string[]) ?? []));
        files.set(f.file, f);
      }
      const facts = g.run(
        `MATCH (x)-[:IN_TURN]->(:Prompt {id: $id}) WHERE x:Decision OR x:Plan OR x:Run
         RETURN x.id AS id, labels(x)[0] AS kind, coalesce(x.text, x.cmd) AS text, x.outcome AS outcome`,
        { id },
      ).rows;
      return [
        section(
          'prompt',
          ['id', 't', 'pushback', 'text'],
          [{ id, ...p, pushback: p.pushback || null }],
        ),
        section(
          'files',
          ['file', 'edits', 'surviving', 'deadEnds', 'diff'],
          [...files.values()]
            .sort((a, b) => a.file.localeCompare(b.file))
            .map((f) => ({ ...f, diff: uniq(f.diff).sort(byDiff) })),
        ),
        section(
          'facts',
          ['id', 'kind', 'outcome', 'text'],
          facts.sort((a, b) => factOrder(String(a.id), String(b.id))),
        ),
      ];
    },
  },
  {
    name: 'stale',
    args: '<R#>',
    help: 'The PR files a session edited after a run, so that run did not see them.',
    run: (g, [id]) => {
      if (!id || !/^R\d+$/.test(id)) throw new GraphError('Give a run id such as R2.');
      const r = g.run(
        'MATCH (r:Run {id: $id}) RETURN r.cmd AS cmd, r.outcome AS outcome, r.revision AS revision, r.t AS t',
        { id },
      ).rows[0];
      if (!r) throw new GraphError(`No run ${id} in this run's evidence graph.`);
      const files = g.run(
        'MATCH (:Run {id: $id})-[:LATER_EDIT]->(f:File) RETURN f.id AS file, f.role AS role',
        { id },
      ).rows;
      return [
        section('run', ['id', 'cmd', 'outcome', 'revision', 't'], [{ id, ...r }]),
        section(
          'editedAfter',
          ['file', 'role'],
          files.sort((a, b) => String(a.file).localeCompare(String(b.file))),
        ),
      ];
    },
  },
  {
    name: 'dead-ends',
    args: '',
    help: 'Edits none of whose lines survive in the PR, by file and prompt: abandoned approaches and rewritten code.',
    run: (g) => [
      section(
        'edits',
        ['file', 'prompt', 'edits', 'linesAdded'],
        g
          .run(
            `MATCH (e:Edit) WHERE e.surviving = 0 AND e.added > 0
             OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
             RETURN e.file AS file, p.id AS prompt, count(e) AS edits, sum(e.added) AS linesAdded`,
          )
          .rows.sort(
            (a, b) =>
              String(a.file).localeCompare(String(b.file)) ||
              factOrder(String(a.prompt ?? ''), String(b.prompt ?? '')),
          ),
      ),
    ],
  },
  {
    name: 'pushback',
    args: '',
    help: 'Prompts typed while rejecting the agent’s action, with the files edited in that turn and the next prompt.',
    run: (g) => {
      const rows = g.run(
        `MATCH (p:Prompt {pushback: true})
         OPTIONAL MATCH (e:Edit)-[:IN_TURN]->(p)
         OPTIONAL MATCH (p)-[:NEXT]->(n:Prompt)
         RETURN p.id AS prompt, p.text AS text, collect(DISTINCT e.file) AS files, n.id AS next`,
      ).rows;
      return [
        section(
          'prompts',
          ['prompt', 'files', 'next', 'text'],
          rows
            .map((r): Record<string, unknown> => ({
              ...r,
              files: ((r.files as string[]) ?? []).sort(),
            }))
            .sort((a, b) => factOrder(String(a.prompt), String(b.prompt))),
        ),
      ];
    },
  },
];

export function findQuery(name: string): NamedQuery | undefined {
  return QUERIES.find((q) => q.name === name);
}

/** A raw read query from an agent. The database is in memory and per command, but keep it read-only. */
export function rawQuery(
  g: GraphEngine,
  cypher: string,
  params: Record<string, unknown> = {},
): Section[] {
  if (
    /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV)\b/i.test(
      cypher.replace(/'[^']*'|"[^"]*"/g, "''"),
    )
  )
    throw new GraphError('Only read queries are allowed (MATCH … RETURN).');
  const r = g.run(cypher, params);
  return [section('rows', r.columns, r.rows)];
}
