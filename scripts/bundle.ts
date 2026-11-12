// Builds the single-file bundle the skill ships (plugin/skills/tracetoon/dist/tracetoon.mjs).
// The output is made pure ASCII: every non-ASCII character becomes a \u escape, so
// the file reads the same in any runtime whatever encoding it assumes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildManifest, recordOutput } from './build-info.ts';

const manifest = buildManifest();

const out = resolve(
  import.meta.dir,
  '..',
  'plugin',
  'skills',
  'tracetoon',
  'dist',
  'tracetoon.mjs',
);
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '..', 'src', 'cli.ts')],
  target: manifest.recipe.bundle.target,
  minify: manifest.recipe.bundle.minify,
  format: manifest.recipe.bundle.format,
  // The build identity is compiled in; src/version.ts falls back to `source` without it.
  define: { [manifest.recipe.identity]: JSON.stringify(manifest) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
let code = await result.outputs[0]!.text();
if (manifest.recipe.bundle.ascii)
  code = code.replace(/[^\x00-\x7f]/gu, (ch) =>
    [...ch]
      .map((c) => {
        const cp = c.codePointAt(0)!;
        if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, '0')}`;
        const v = cp - 0x10000;
        return `\\u${(0xd800 + (v >> 10)).toString(16)}\\u${(0xdc00 + (v & 0x3ff)).toString(16)}`;
      })
      .join(''),
  );
code = code.replace(/^#!.*\n/, '');
// dist/ isn't committed, so a fresh clone doesn't have the directory yet.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `#!/usr/bin/env node\n${code}`);
const size = readFileSync(out).length;
console.log(`bundle: ${out} (${(size / 1024).toFixed(0)} KB, ASCII only)`);
recordOutput(out, 'node-esm', manifest.buildId);
