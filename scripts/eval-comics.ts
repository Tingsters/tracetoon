/** Local synthetic visual gallery. Art is drawn explicitly through the normal consented CLI. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COMIC_STORIES } from '../tests/fixtures/comic-stories.ts';
import { composePage, esc, type PanelImage } from '../src/comic/compose.ts';
import { comicSummary } from '../src/comic/composition.ts';
import { checkScript, errors } from '../src/comic/script.ts';
import { svgToPng } from '../src/comic/raster.ts';
import { git } from '../src/util/exec.ts';

const root = process.cwd();
const dir = git(root, ['rev-parse', '--absolute-git-dir']);
if (!dir.ok) throw new Error('Run this script inside the Tracetoon repository.');
const gitDir = dir.stdout.trim();
const base = join(gitDir, 'tracetoon', 'comic-gallery');
const cli = resolve(process.env.TRACETOON_TEST_CLI ?? 'src/cli.ts');
const command = process.argv[2] ?? 'prepare';
if (!['prepare', 'gallery'].includes(command)) throw new Error('Use prepare or gallery.');
mkdirSync(base, { recursive: true });
const rows: string[] = [];
const inventory: unknown[] = [];
for (const item of COMIC_STORIES) {
  const problems = errors(checkScript(item.script));
  if (problems.length) throw new Error(`${item.id}: ${JSON.stringify(problems)}`);
  const id = `comic-gallery-${item.id}`;
  const run = join(gitDir, 'tracetoon', 'runs', id);
  if (command === 'prepare') {
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'comic.json'), JSON.stringify(item.script, null, 2) + '\n');
    const context = spawnSync(
      process.execPath,
      [cli, 'context', '--run', id, '--offline', '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    if (context.status !== 0) throw new Error(context.stderr || context.stdout);
    console.log(
      `${id}: prepared. Draw with comic art --run ${id}; then comic render --run ${id}.`,
    );
    continue;
  }
  const image = join(run, 'out', 'comic.png');
  const colors = ['#d9e8ec', '#f8e4d4', '#e4deec', '#e8e6cb', '#d5e7df', '#dce1f0'];
  // These are intentionally schematic original vectors, not imitation comic art.
  const panels: PanelImage[] = item.script.panels.map((_, i) => ({
    mime: 'image/svg+xml',
    data: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${colors[i % colors.length]}"/><circle cx="430" cy="560" r="140" fill="#93acb4"/><path d="M0 740L800 420V800H0Z" fill="#bfd0d4"/></svg>`,
    ),
  }));
  const overlay = composePage(item.script, panels);
  const proof = join(base, `${item.id}-overlay.png`);
  writeFileSync(proof, await svgToPng(overlay, 1600));
  const summary = comicSummary(item.script);
  inventory.push({ id, story: item.story, ...summary, artPresent: existsSync(image) });
  rows.push(
    `<article><h2>${esc(item.script.title)}</h2><p>${esc(item.story)}</p><p class="meta">${esc(`${summary.layoutFamily} · ${summary.panelCount} panels · title ${summary.titleTreatment} · cast ${summary.castKinds?.join(', ') || 'none'}`)}</p>${existsSync(image) ? `<a href="${pathToFileURL(image).href}"><img alt="${esc(item.script.altText)}" src="${pathToFileURL(image).href}"></a>` : '<p>Finished art is not drawn yet.</p>'}<p>${esc(item.script.designReason ?? '')}</p><details><summary>Overlay geometry proof — schematic art</summary><img alt="The same composition rendered with overlay lettering and schematic art" src="${pathToFileURL(proof).href}"></details></article>`,
  );
}
if (command === 'gallery') {
  const file = join(base, 'index.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tracetoon visual evaluation</title><style>body{--preview:760px;background:#edf0f2;color:#172029;font:16px/1.5 system-ui;margin:24px}body.phone{--preview:360px}header{max-width:1000px;margin:0 auto 28px}button{padding:10px 16px;margin-right:8px;cursor:pointer}.gallery{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:28px}article{background:white;padding:20px;border-radius:14px;width:min(var(--preview),calc(100vw - 88px));box-shadow:0 3px 14px #17202914}h2{margin-top:0}img{display:block;width:100%;height:auto}.meta{font-size:14px;color:#52616c}details{margin-top:18px}summary{cursor:pointer}</style></head><body><header><h1>Six stories, different visual decisions</h1><p>These are synthetic PR scenarios for visual evaluation. Check story fidelity, reading order, lettering, composition and the payoff. The schematic overlay proofs verify geometry; they are not finished comic art.</p><button onclick="document.body.classList.remove('phone')">PR column · 760px</button><button onclick="document.body.classList.add('phone')">Phone · 360px</button></header><main class="gallery">${rows.join('\n')}</main></body></html>`,
  );
  writeFileSync(join(base, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  console.log(pathToFileURL(file).href);
}
