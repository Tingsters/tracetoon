/**
 * SVG → PNG with resvg compiled to WebAssembly: no native modules, works in Bun,
 * Node and the compiled binary. The .wasm file and fonts ship in the skill's
 * `assets/` folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

/** The skill's assets folder, wherever Tracetoon is running from. */
export function assetsDir(): string | undefined {
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  const candidates = [
    process.env.TRACETOON_ASSETS,
    join(here, '..', 'assets'), // dist/tracetoon.mjs → assets
    join(dirname(process.execPath), '..', 'assets'), // compiled binary in bin/
    join(dirname(process.execPath), 'assets'),
    join(here, '..', '..', 'plugin', 'skills', 'tracetoon', 'assets'), // src/comic → repo
    join(process.argv[1] ? dirname(resolve(process.argv[1])) : here, '..', 'assets'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(join(p, 'resvg.wasm')));
}

let ready: Promise<void> | undefined;

async function init(dir: string): Promise<void> {
  ready ??= initWasm(readFileSync(join(dir, 'resvg.wasm'))).catch((e: Error) => {
    // initWasm may only run once per process; a second call is harmless.
    if (!/already/i.test(e.message)) throw e;
  });
  return ready;
}

export async function svgToPng(svg: string, width?: number): Promise<Uint8Array> {
  const dir = assetsDir();
  if (!dir)
    throw new Error(
      'Rendering assets (resvg.wasm, fonts) not found; set TRACETOON_ASSETS.',
    );
  await init(dir);
  const fonts = ['ComicNeue_700Bold.ttf', 'ComicNeue_400Regular.ttf']
    .map((f) => join(dir, 'fonts', f))
    .filter(existsSync)
    .map((p) => new Uint8Array(readFileSync(p)));
  const r = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { fontBuffers: fonts, defaultFontFamily: 'Comic Neue', loadSystemFonts: false },
  });
  return r.render().asPng();
}
