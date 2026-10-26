/** Explicit local content evaluation. Never requests images or scores humor. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { COMIC_CONTENT_CASES } from '../tests/fixtures/comic-content.ts';
import { composePage, esc, type PanelImage } from '../src/comic/compose.ts';
import { comicSummary } from '../src/comic/composition.ts';
import { checkScript, errors } from '../src/comic/script.ts';
import type { ComicScript } from '../src/comic/types.ts';
import { svgToPng } from '../src/comic/raster.ts';
import { git } from '../src/util/exec.ts';
interface Manifest {
  v: 1;
  cases: { id: string; baseline: string; candidate: string }[];
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^\d{8}-\d{6}(-\d+)?$/.test(id);
function allocate(gitDir: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(0, 15)
    .replace('T', '-');
  let id = stamp;
  for (let n = 1; existsSync(join(gitDir, 'tracetoon', 'runs', id)); n++)
    id = `${stamp}-${n}`;
  mkdirSync(join(gitDir, 'tracetoon', 'runs', id), { recursive: true });
  return id; // No latest pointer, pending state, or pruning side effects.
}
export async function evaluateComics(
  root: string,
  command: string,
  selected: string[] = [],
) {
  if (!['prepare', 'gallery', 'blind'].includes(command))
    throw new Error(
      'Use prepare, blind, or gallery, optionally followed by scenario ids.',
    );
  const result = git(root, ['rev-parse', '--absolute-git-dir']);
  if (!result.ok) throw new Error('Run this script inside a git repository.');
  const gitDir = result.stdout.trim(),
    base = join(gitDir, 'tracetoon', 'comic-gallery');
  mkdirSync(base, { recursive: true });
  const manifestFile = join(base, 'manifest.json');
  const manifest: Manifest = existsSync(manifestFile)
    ? JSON.parse(readFileSync(manifestFile, 'utf8'))
    : { v: 1, cases: [] };
  if (
    manifest.v !== 1 ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.some(
      (c) =>
        !COMIC_CONTENT_CASES.some((s) => s.id === c.id) ||
        !validId(c.baseline) ||
        !validId(c.candidate),
    ) ||
    new Set(manifest.cases.flatMap((c) => [c.baseline, c.candidate])).size !==
      manifest.cases.length * 2
  )
    throw new Error(
      'Invalid evaluation manifest; run ids must be valid, unique scratch runs.',
    );
  if (selected.some((id) => !COMIC_CONTENT_CASES.some((c) => c.id === id)))
    throw new Error('Unknown comic scenario.');
  const rows: { key: string; html: string }[] = [],
    inventory: unknown[] = [];
  for (const item of COMIC_CONTENT_CASES.filter(
    (c) => !selected.length || selected.includes(c.id),
  )) {
    let entry = manifest.cases.find((c) => c.id === item.id);
    if (!entry && command === 'prepare') {
      entry = { id: item.id, baseline: allocate(gitDir), candidate: allocate(gitDir) };
      manifest.cases.push(entry);
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    }
    if (!entry) throw new Error(`Prepare ${item.id} before making its gallery.`);
    for (const variant of ['baseline', 'candidate'] as const) {
      const id = entry[variant],
        run = join(gitDir, 'tracetoon', 'runs', id),
        scriptFile = join(run, 'comic.json');
      if (command === 'prepare') {
        mkdirSync(run, { recursive: true });
        if (variant === 'baseline' && item.script && !existsSync(scriptFile))
          writeFileSync(scriptFile, JSON.stringify(item.script, null, 2) + '\n');
        if (!existsSync(join(run, 'context.json')))
          writeFileSync(
            join(run, 'context.json'),
            JSON.stringify({
              comic: { recentComics: [], recentStyles: [] },
              contribution: { offline: true },
            }) + '\n',
          );
        writeFileSync(
          join(run, 'scenario.json'),
          JSON.stringify(
            {
              synthetic: true,
              id: item.id,
              variant,
              facts: item.facts,
              watchFor: item.watchFor,
              control: item.control,
            },
            null,
            2,
          ) + '\n',
        );
        console.log(
          `${item.id} ${variant}: ${id}. ${existsSync(scriptFile) ? 'Script present.' : 'Have a drafter write comic.json from scenario.json.'} Check, then explicitly draw with comic art --run ${id}; comic render --run ${id}.`,
        );
        continue;
      }
      const image = join(run, 'out', 'comic.png'),
        present = existsSync(image);
      inventory.push({
        scenario: item.id,
        variant,
        run: id,
        artPresent: present,
        control: item.control,
      });
      const key = createHash('sha256')
        .update(item.id + variant)
        .digest('hex');
      const imageHtml = present
        ? `<a href="${pathToFileURL(image).href}"><img alt="Comic sample" src="${pathToFileURL(image).href}"></a>`
        : '<p>Art has not been drawn.</p>';
      if (command === 'blind') {
        if (present) rows.push({ key, html: `<article>${imageHtml}</article>` });
        continue;
      }
      let proofHtml = '';
      if (existsSync(scriptFile)) {
        const script: ComicScript = JSON.parse(readFileSync(scriptFile, 'utf8'));
        const problems = errors(checkScript(script));
        if (problems.length)
          throw new Error(`${item.id} ${variant}: ${JSON.stringify(problems)}`);
        const panels: PanelImage[] = script.panels.map(() => ({
          mime: 'image/svg+xml',
          data: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#d9e8ec"/><circle cx="430" cy="560" r="140" fill="#93acb4"/></svg>',
          ),
        }));
        const proof = join(base, `${item.id}-${variant}-overlay.png`);
        writeFileSync(proof, await svgToPng(composePage(script, panels), 1600));
        proofHtml = `<p>${esc(JSON.stringify(comicSummary(script)))}</p><details><summary>Schematic geometry proof, not finished art</summary><img alt="Geometry proof" src="${pathToFileURL(proof).href}"></details>`;
      }
      rows.push({
        key,
        html: `<article><h2>${esc(item.id)} · ${variant}</h2>${imageHtml}<details><summary>Facts and reader probes — read after image-first review</summary><p>${esc(item.story)}</p><ul>${[...item.facts, ...item.watchFor].map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>${proofHtml}</article>`,
      });
    }
  }
  if (command === 'prepare') return manifestFile;
  if (command === 'blind') rows.sort((a, b) => a.key.localeCompare(b.key));
  const file = join(base, command === 'blind' ? 'blind.html' : 'index.html');
  const html = rows
    .map((row, i) => row.html.replace('<article>', `<article><p>Sample ${i + 1}</p>`))
    .join('\n');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tracetoon comic evaluation</title><style>body{--preview:760px;background:#edf0f2;color:#172029;font:16px/1.5 system-ui;margin:24px}body.phone{--preview:360px}header{max-width:1000px;margin:auto}button{padding:10px;margin:8px;cursor:pointer}.gallery{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:28px}article{background:white;padding:20px;border-radius:14px;width:min(var(--preview),calc(100vw - 88px))}img{display:block;width:100%;height:auto}summary{cursor:pointer}</style></head><body><header><h1>Comic content evaluation</h1><p>${command === 'blind' ? 'Read only the pictures first. Record visible events, inference and the perceived joke separately.' : 'Compare image-first observations with facts and scripts. Controls include deliberate flaws. Structural checks are not humor scores.'}</p><button onclick="document.body.classList.remove('phone')">PR column · 760px</button><button onclick="document.body.classList.add('phone')">Phone · 360px</button></header><main class="gallery">${html}</main></body></html>`,
  );
  writeFileSync(join(base, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  return file;
}
