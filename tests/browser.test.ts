import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeBrowserPreview, serveBrowserPreview } from '../src/review/browser.ts';
import { previewHandoff } from '../src/review/handoff.ts';
import { tempDir } from './helpers.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
function fixture() {
  const dir = tempDir('tracetoon-browser-');
  mkdirSync(join(dir, 'out'));
  writeFileSync(
    join(dir, 'preview.html'),
    '<html><body>Local review<img src="data:image/png;base64,AA=="></body></html>',
  );
  writeFileSync(join(dir, 'final-body.md'), 'Reviewed description');
  writeFileSync(join(dir, 'out/comic.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(dir, 'digest.json'), 'Private context');
  return dir;
}

test('real HTTP links open the rendered page and named artifacts; updated renders remain visible', async () => {
  const dir = fixture();
  const browser = await serveBrowserPreview(dir);
  closers.push(browser.close);
  expect(new URL(browser.url).hostname).toBe('127.0.0.1');
  expect(activeBrowserPreview(dir)?.url).toBe(browser.url);
  const handoff = previewHandoff({
    root: dir,
    command: 'tracetoon',
    url: browser.url,
    filePath: join(dir, 'preview.html'),
    run: 'run',
  });
  expect(handoff.markdown).toContain(`[OPEN YOUR LOCAL PR PREVIEW](${browser.url})`);
  // Codex 0.164.0 terminal_hyperlinks.rs only promotes http/https destinations.
  expect(new URL(browser.url).protocol).toBe('http:');
  const page = await fetch(browser.url);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).toContain('data:image/png;base64,');
  expect(await (await fetch(browser.artifacts.description)).text()).toBe(
    'Reviewed description',
  );
  expect(
    new Uint8Array(await (await fetch(browser.artifacts.comic)).arrayBuffer()),
  ).toEqual(new Uint8Array([137, 80, 78, 71]));
  const head = await fetch(browser.url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  writeFileSync(join(dir, 'preview.html'), 'Refreshed review');
  expect(await (await fetch(browser.url)).text()).toBe('Refreshed review');
  await browser.close();
  expect(activeBrowserPreview(dir)).toBeUndefined();
});

test('HTTP transport exposes no directory, private run context, arbitrary paths or writes', async () => {
  const dir = fixture();
  const browser = await serveBrowserPreview(dir);
  closers.push(browser.close);
  for (const url of [
    new URL('/', browser.url).href,
    `${browser.url}digest.json`,
    `${browser.url}../digest.json`,
    `${browser.url}%2e%2e/digest.json`,
    `${browser.url}__proto__`,
  ])
    expect((await fetch(url)).status).toBe(404);
  expect((await fetch(browser.url, { method: 'POST', body: 'overwrite' })).status).toBe(
    404,
  );
  expect(
    (await fetch(browser.url, { headers: { Host: 'unrelated.example' } })).status,
  ).toBe(404);
  expect(readFileSync(join(dir, 'preview.html'), 'utf8')).toContain('Local review');
});

test('server expiry removes its advertised URL; stale and foreign state is never an active link', async () => {
  const dir = fixture();
  const browser = await serveBrowserPreview(dir, { idleMs: 100 });
  closers.push(browser.close);
  await Bun.sleep(250);
  expect(activeBrowserPreview(dir)).toBeUndefined();
  for (const state of [
    { url: browser.url, pid: process.pid, heartbeat: Date.now() - 60_000 },
    { url: 'https://example.com/private/', pid: process.pid, heartbeat: Date.now() },
    { url: browser.url, pid: -1, heartbeat: Date.now() },
  ]) {
    writeFileSync(join(dir, 'browser-preview.json'), JSON.stringify(state));
    expect(activeBrowserPreview(dir)).toBeUndefined();
  }
});
