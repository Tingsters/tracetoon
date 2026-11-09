/**
 * Search links for the evidence graph: `TIED_TO {score, rankers}` from a commit
 * sentence (CommitClaim), a commit subject (Commit), a request (Prompt) or a
 * plan paragraph (Plan) to the hunks whose text it describes, for the facts no
 * structural link places (docs and scripts hunks, sentences that share few
 * rare words with one file).
 *
 * Built once at prepare time, while the patch is at hand, and stored in the
 * graph like any other relationship, so `query brief` needs no search engine.
 *
 * Rankers, as in the relational arm (src/relational/retrieve.ts):
 * - `bm25`: SQLite FTS5 over each hunk's file path, symbol names and changed
 *   lines (porter stemming, identifiers split into words);
 * - `mention`: hunks that define or change a name the text uses, or are in a
 *   file it names;
 * - `vec` (Graph search: bm25+vector): cosine of potion-code-16M-v2 embeddings.
 *
 * A commit's sentences only see that commit's hunks (INTRODUCED, else the hunks
 * of the files it TOUCHES), so a sentence never borrows another commit's code.
 * A hit becomes a link only when two rankers agree, the text names the hunk's
 * symbol or path, the embedding alone is close (as relational), or BM25 alone
 * is dominant: the top hit, clearly ahead of the next one, sharing at least
 * three of the text's rarer words. Ranking noise never becomes evidence.
 */
import { initSqlWasm, openDb } from '../relational/sqlite.ts';
import { cosine, embeddingModel, initEmbeddings } from '../relational/embed.ts';
import {
  ftsOr,
  identWords,
  mentionedNames,
  mentionedPaths,
  terms,
} from '../relational/text.ts';
import { readJson, writeJson, type Run } from '../run.ts';
import { patchHunks, type PatchHunk } from './build.ts';
import { evidenceLines, literalTokens, stem } from './codeEvidence.ts';
import type { EvidenceGraph, NodeLabel } from './model.ts';

export type GraphSearch = 'bm25' | 'bm25+vector' | 'none';
export const GRAPH_SEARCHES: readonly GraphSearch[] = ['bm25', 'bm25+vector', 'none'];
export const SEARCH_FILE = 'graph-search.json';
/** What a run gets when neither a flag, the SKILL line nor the run folder says. */
export const DEFAULT_GRAPH_SEARCH: GraphSearch = 'bm25';

/** A `--graph-search` value or SKILL `Graph search:` line, checked; undefined when none. */
export function parseGraphSearch(value: unknown): GraphSearch | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if ((GRAPH_SEARCHES as readonly string[]).includes(v)) return v as GraphSearch;
  throw new Error(
    `Unknown graph search "${String(value)}": use ${GRAPH_SEARCHES.join(', ')}.`,
  );
}

/** The search mode stored for this run, if prepare stored one. */
export function storedGraphSearch(run: Run): GraphSearch | undefined {
  try {
    return parseGraphSearch(readJson<{ search?: string }>(run, SEARCH_FILE)?.search);
  } catch {
    return undefined;
  }
}

export function saveRunGraphSearch(run: Run, search: GraphSearch): void {
  writeJson(run, SEARCH_FILE, { search });
}

/**
 * Load what the mode needs (SQLite, and the embedding model for vectors) before
 * a synchronous graph build. Never throws: without SQLite the graph is built
 * without search links.
 */
export async function initGraphSearch(mode: GraphSearch | undefined): Promise<void> {
  if (!mode || mode === 'none') return;
  try {
    await initSqlWasm();
  } catch {
    return;
  }
  if (mode === 'bm25+vector') initEmbeddings();
}

/** Hits per ranker for a query over `n` candidate hunks (relational's rule). */
const topK = (n: number) => Math.min(8, Math.max(2, Math.ceil(n / 5)));
/** A BM25 hit agrees only at half the query's best score or more. */
const BM25_BAR = 0.5;
/** BM25 alone links only its top hit, and only this far ahead of the next one. */
const BM25_ALONE_LEAD = 0.67;
/** …sharing at least this many of the query's words with the hunk. */
const BM25_ALONE_WORDS = 3;
/** …and links at most this many hunks of its file. */
const SAME_FILE = 2;
/** A vector-only hit needs at least this cosine (relational's VEC_ALONE). */
const VEC_ALONE = 0.55;
/** Links kept per source (a request or a plan keeps its best). */
const MAX_LINKS = 4;
/** Paragraphs searched per request or plan. */
const MAX_PARAS = 24;

interface Query {
  label: NodeLabel;
  id: string;
  text: string;
  /** Hunk ids the query may link to; undefined = every hunk. */
  scope?: Set<string>;
}

/** Long prose as the paragraphs worth searching (blank-line separated). */
export function paragraphs(text: string, max = MAX_PARAS): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.replace(/[#*`\-\s]/g, '').length > 30)
    .slice(0, max)
    .map((p) => (p.length > 900 ? p.slice(0, 900) : p));
}

/** The text a hunk is indexed by: path, symbols, then its changed lines. */
export function hunkBody(h: PatchHunk, maxChars = 2400): string {
  const head = [h.file, h.scope, ...h.symbols, ...h.touched, ...h.dropped]
    .filter(Boolean)
    .join(' ');
  const lines = [
    ...(h.minus ?? []).map((l) => `-${l.trim().slice(0, 200)}`),
    ...(h.plus ?? []).map((l) => `+${l.trim().slice(0, 200)}`),
  ]
    .join('\n')
    .slice(0, maxChars);
  return `${head}\n${lines}`;
}

export interface SearchStats {
  queries: number;
  links: number;
  vectors: boolean;
}

export interface SearchInput {
  graph: EvidenceGraph;
  patch: string;
  /** Full request and plan texts by fact id (the graph's own are clipped). */
  prompts?: { id: string; text: string }[];
  plans?: { id: string; text: string }[];
  mode: GraphSearch;
}

/**
 * Add each hunk's key lines and the TIED_TO search links (key lines only when
 * SQLite is not loaded). Mode `none` adds nothing: the graph, and so the
 * brief, is as without search. Mutates the graph; returns what it did, or
 * undefined when no search ran.
 */
export function addSearchLinks(input: SearchInput): SearchStats | undefined {
  const { graph } = input;
  if (input.mode === 'none') return undefined;
  const hunkNodes = new Map(
    graph.nodes.filter((n) => n.label === 'Hunk').map((n) => [n.id, n]),
  );
  const hunks = patchHunks(input.patch).filter((h) => hunkNodes.has(h.id));
  // Key lines for the brief: added comments, values, conditions (codeEvidence.ts).
  for (const h of hunks) {
    const node = hunkNodes.get(h.id)!;
    const lines = evidenceLines(h.minus ?? [], h.plus ?? [], h.file);
    if (lines.length) node.props.keyLines = lines;
    const literals = literalTokens(h.minus ?? [], h.plus ?? []);
    if (literals.length) node.props.literals = literals;
  }
  if (!hunks.length) return undefined;
  let db;
  try {
    db = openDb();
  } catch {
    return undefined; // SQLite not loaded: no search links, the rest is unchanged
  }
  try {
    return searchInto(db, input, hunks);
  } finally {
    db.close();
  }
}

function searchInto(
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  db: any,
  input: SearchInput,
  all: PatchHunk[],
): SearchStats {
  const { graph } = input;
  const role = new Map(
    graph.nodes
      .filter((n) => n.label === 'File')
      .map((n) => [n.id, String(n.props.role)]),
  );
  // Generated files (a bundle) match everything and explain nothing.
  const hunks = all.filter((h) => role.get(h.file) !== 'generated');
  const bodies = new Map(hunks.map((h) => [h.id, hunkBody(h)]));
  const fileOf = new Map(hunks.map((h) => [h.id, h.file]));
  db.exec(
    `CREATE VIRTUAL TABLE hunk_fts USING fts5(hunk_id UNINDEXED, body, tokenize = 'porter unicode61');`,
  );
  const ins = db.prepare('INSERT INTO hunk_fts (hunk_id, body) VALUES (?, ?)');
  try {
    for (const h of hunks) {
      const body = bodies.get(h.id)!;
      ins.bind([h.id, `${body}\n${identWords(body).join(' ')}`]).stepReset();
    }
  } finally {
    ins.finalize();
  }
  const words = new Map(hunks.map((h) => [h.id, new Set(identWords(bodies.get(h.id)!))]));
  const stems = new Map([...words].map(([id, ws]) => [id, new Set([...ws].map(stem))]));
  const df = new Map<string, number>();
  // Document frequency by stem, so "pins" meets a hunk's "pinned".
  for (const ws of stems.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);

  // Queries: commit subjects and sentences (scoped to the commit), requests and plans.
  const queries: Query[] = [];
  const introduced = new Map<string, Set<string>>();
  const touches = new Map<string, Set<string>>();
  for (const r of graph.rels) {
    if (r.type === 'INTRODUCED' && bodies.has(r.to.id)) {
      const s = introduced.get(r.from.id) ?? new Set<string>();
      s.add(r.to.id);
      introduced.set(r.from.id, s);
    }
    if (r.type === 'TOUCHES') {
      const s = touches.get(r.from.id) ?? new Set<string>();
      for (const h of hunks) if (h.file === r.to.id) s.add(h.id);
      touches.set(r.from.id, s);
    }
  }
  const scopeOf = (sha: string) => {
    const s = introduced.get(sha);
    if (s?.size) return s;
    const t = touches.get(sha);
    return t?.size ? t : undefined;
  };
  // Tests describe behavior; the code that does it is what a commit's text links to.
  const code = (scope: Set<string> | undefined) => {
    const out = new Set(
      [...(scope ?? [])].filter((id) => role.get(fileOf.get(id)!) !== 'tests'),
    );
    return out.size ? out : undefined;
  };
  const commitQueries = (
    label: NodeLabel,
    id: string,
    text: string,
    scope: Set<string> | undefined,
  ) => {
    if (!scope || !text.trim()) return;
    queries.push({ label, id, text, scope });
    // A sentence joining several changes ("a; b", "a, and b") is also asked part by part.
    const parts = text
      .split(/;\s+|,\s+and\s+|\s+—\s+/)
      .filter((p) => p.trim().split(/\s+/).length >= 4);
    if (parts.length >= 2)
      for (const p of parts) queries.push({ label, id, text: p, scope });
  };
  for (const n of graph.nodes) {
    if (n.label === 'Commit')
      commitQueries('Commit', n.id, String(n.props.subject ?? ''), code(scopeOf(n.id)));
    else if (n.label === 'CommitClaim' && n.props.assertsResult !== true)
      commitQueries(
        'CommitClaim',
        n.id,
        String(n.props.text ?? ''),
        code(scopeOf(String(n.props.commit))),
      );
  }
  const factIds = new Set(
    graph.nodes
      .filter((n) => n.label === 'Prompt' || n.label === 'Plan')
      .map((n) => n.id),
  );
  for (const [label, list] of [
    ['Prompt', input.prompts ?? []],
    ['Plan', input.plans ?? []],
  ] as const)
    for (const f of list)
      if (factIds.has(f.id))
        for (const p of paragraphs(f.text)) queries.push({ label, id: f.id, text: p });

  const model = input.mode === 'bm25+vector' ? embeddingModel() : undefined;
  const vectors = model
    ? new Map(hunks.map((h) => [h.id, model.embed(bodies.get(h.id)!)]))
    : undefined;

  // Names a hunk defines or changes, and its file, for exact mentions.
  const names = new Map<string, Set<string>>();
  for (const h of hunks)
    for (const n of [
      ...h.symbols,
      ...h.touched,
      ...h.dropped,
      ...(h.scope ? [h.scope] : []),
    ]) {
      const s = names.get(n) ?? new Set<string>();
      s.add(h.id);
      names.set(n, s);
    }

  const fts = db.prepare(
    `SELECT hunk_id, bm25(hunk_fts) AS s FROM hunk_fts WHERE hunk_fts MATCH ? ORDER BY s, hunk_id LIMIT ?`,
  );
  // Best link per (source, hunk).
  const best = new Map<
    string,
    { label: NodeLabel; id: string; hunk: string; score: number; rankers: string[] }
  >();
  try {
    for (const q of queries) {
      const allowed = (id: string) => !q.scope || q.scope.has(id);
      const n = q.scope ? q.scope.size : hunks.length;
      const k = topK(n);
      type Hit = { strong: boolean; strength: number; rank: number; raw?: number };
      const hit = new Map<string, Partial<Record<'bm25' | 'vec' | 'mention', Hit>>>();
      const put = (id: string, r: 'bm25' | 'vec' | 'mention', h: Hit) => {
        const x = hit.get(id) ?? {};
        x[r] = h;
        hit.set(id, x);
      };
      // BM25, rarest words first; filtered to the scope after ranking over all hunks.
      const qWords = [...new Set(terms(q.text))]
        .filter((w) => df.has(stem(w)))
        .sort((a, b) => df.get(stem(a))! - df.get(stem(b))! || a.localeCompare(b));
      const m = ftsOr(qWords);
      let ranked: [string, number][] = [];
      if (m) {
        fts.bind([m, 256]);
        while (fts.step()) ranked.push([fts.get(0) as string, -Number(fts.get(1))]);
        fts.reset();
        ranked = ranked.filter(([id]) => allowed(id));
      }
      const bm = ranked.slice(0, k);
      const top = bm[0]?.[1] ?? 0;
      bm.forEach(([id, s], rank) =>
        put(id, 'bm25', {
          strong: top > 0 && s >= BM25_BAR * top,
          strength: top > 0 ? s / top : 0,
          rank,
        }),
      );
      // Mentions: names the text uses that a hunk defines or changes, or a path it names.
      const ment = new Map<string, number>();
      for (const name of mentionedNames(q.text))
        for (const id of names.get(name) ?? [])
          if (allowed(id)) ment.set(id, (ment.get(id) ?? 0) + 2);
      for (const p of mentionedPaths(q.text))
        for (const h of hunks)
          if (allowed(h.id) && (h.file === p || h.file.endsWith(`/${p}`)))
            ment.set(h.id, (ment.get(h.id) ?? 0) + 1);
      const mlist = [...ment]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, k);
      const mtop = mlist[0]?.[1] ?? 1;
      mlist.forEach(([id, s], rank) =>
        put(id, 'mention', { strong: true, strength: s / mtop, rank }),
      );
      // Vectors: exact kNN, the bar one standard deviation above the query's mean.
      if (model && vectors) {
        const qv = model.embed(q.text);
        const scored = hunks
          .filter((h) => allowed(h.id))
          .map((h) => [h.id, cosine(qv, vectors.get(h.id)!)] as [string, number]);
        if (scored.length > 1) {
          const mean = scored.reduce((a, [, c]) => a + c, 0) / scored.length;
          const sd = Math.sqrt(
            scored.reduce((a, [, c]) => a + (c - mean) ** 2, 0) / scored.length,
          );
          scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
          const vt = scored[0]![1];
          scored.slice(0, k).forEach(([id, c], rank) =>
            put(id, 'vec', {
              strong: c >= mean + sd,
              strength:
                vt > mean ? Math.max(0, Math.min(1, (c - mean) / (vt - mean))) : 0,
              rank,
              raw: c,
            }),
          );
        }
      }
      // BM25 alone: its top hit, clearly ahead of the best hit in any other
      // file and sharing enough of the text's words; the same file's other
      // strong hits come with it.
      const alone = new Set<string>();
      if (bm.length && top > 0) {
        const lead = bm[0]![0];
        const rival =
          ranked.find(([id]) => fileOf.get(id) !== fileOf.get(lead))?.[1] ?? 0;
        const group = bm
          .filter(
            ([id, sc]) => fileOf.get(id) === fileOf.get(lead) && sc >= BM25_BAR * top,
          )
          .slice(0, SAME_FILE)
          .map(([id]) => id);
        // Words the text shares with those hunks together (a file's hunks split them).
        const qStems = new Set(qWords.map(stem));
        const shared = [...qStems].filter((w) =>
          group.some((id) => stems.get(id)!.has(w)),
        ).length;
        if (rival <= BM25_ALONE_LEAD * top && shared >= BM25_ALONE_WORDS)
          for (const id of group) alone.add(id);
      }
      // Acceptance.
      for (const [id, x] of hit) {
        const strong = (['bm25', 'vec', 'mention'] as const).filter((r) => x[r]?.strong);
        let ok = strong.length >= 2 || !!x.mention;
        if (!ok && x.vec?.strong) ok = (x.vec.raw ?? 0) >= VEC_ALONE;
        if (!ok) ok = alone.has(id);
        if (!ok) continue;
        const rankers = strong.length ? [...strong] : (['bm25'] as string[]);
        const score =
          Math.round(
            (strong.reduce((a, r) => a + (x[r]?.strength ?? 0), 0) / 3 ||
              (x.bm25?.strength ?? 0) / 3) * 100,
          ) / 100;
        const key = `${q.label}|${q.id}|${id}`;
        const prev = best.get(key);
        if (!prev || score > prev.score)
          best.set(key, { label: q.label, id: q.id, hunk: id, score, rankers });
      }
    }
  } finally {
    fts.finalize();
  }

  // At most MAX_LINKS per source, strongest first.
  const bySource = new Map<
    string,
    { label: NodeLabel; id: string; hunk: string; score: number; rankers: string[] }[]
  >();
  for (const l of best.values()) {
    const k = `${l.label}|${l.id}`;
    bySource.set(k, [...(bySource.get(k) ?? []), l]);
  }
  let links = 0;
  for (const list of bySource.values())
    for (const l of list
      .sort((a, b) => b.score - a.score || hunkNum(a.hunk) - hunkNum(b.hunk))
      .slice(0, MAX_LINKS)) {
      graph.rels.push({
        type: 'TIED_TO',
        from: { label: l.label, id: l.id },
        to: { label: 'Hunk', id: l.hunk },
        props: { score: l.score, rankers: l.rankers },
      });
      links++;
    }
  graph.stats.rels = graph.rels.length;
  return { queries: queries.length, links, vectors: !!model };
}

const hunkNum = (id: string) => Number(id.replace(/\D/g, '')) || 0;
