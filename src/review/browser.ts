/** A local browser transport for hosts that do not hyperlink file references. */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoFile } from '../util/repoFiles.ts';

const STATE = 'browser-preview.json';
const HEARTBEAT_MS = 10_000;
const MAX_AGE_MS = 30_000;
export interface BrowserPreview {
  url: string;
  artifacts: { preview: string; description: string; comic: string };
}
interface BrowserState {
  url: string;
  pid: number;
  heartbeat: number;
}

/** Status/hooks only read local state; they never start a server or probe a port. */
export function activeBrowserPreview(dir: string): BrowserPreview | undefined {
  try {
    const state = JSON.parse(readFileSync(join(dir, STATE), 'utf8')) as BrowserState;
    const url = new URL(state.url);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      !/^\/[a-f0-9]{48}\/$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      !Number.isFinite(state.heartbeat) ||
      Date.now() - state.heartbeat > MAX_AGE_MS ||
      state.heartbeat > Date.now() + MAX_AGE_MS
    )
      return;
    process.kill(state.pid, 0);
    return browserLinks(url.href);
  } catch {
    return;
  }
}

function browserLinks(url: string): BrowserPreview {
  return {
    url,
    artifacts: {
      preview: url,
      description: `${url}description.md`,
      comic: `${url}comic.png`,
    },
  };
}

/** Foreground like a dev server: the host keeps this process alive during review.
 * Only three named, rendered artifacts are exposed, never a repository directory.
 */
export async function serveBrowserPreview(
  dir: string,
  options: { idleMs?: number } = {},
): Promise<BrowserPreview & { close: () => Promise<void> }> {
  // Validate the page before binding or advertising a listener.
  readRepoFile(dir, 'preview.html');
  const token = randomBytes(24).toString('hex');
  const routes = new Map<string, [string, string]>([
    [`/${token}/`, ['preview.html', 'text/html; charset=utf-8']],
    [`/${token}/description.md`, ['final-body.md', 'text/plain; charset=utf-8']],
    [`/${token}/comic.png`, ['out/comic.png', 'image/png']],
  ]);
  let lastAccess = Date.now();
  let origin: string;
  const server = createServer((req, res) => {
    const route = routes.get(req.url ?? '');
    if (
      !route ||
      req.headers.host !== origin ||
      (req.method !== 'GET' && req.method !== 'HEAD')
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = readRepoFile(dir, route[0]);
      lastAccess = Date.now();
      res.writeHead(200, {
        'Content-Type': route[1],
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local preview port');
  origin = `127.0.0.1:${address.port}`;
  const links = browserLinks(`http://${origin}/${token}/`);
  const heartbeat = () =>
    writeFileSync(
      join(dir, STATE),
      JSON.stringify({
        url: links.url,
        pid: process.pid,
        heartbeat: Date.now(),
      } satisfies BrowserState),
    );
  let closed = false;
  let timer: ReturnType<typeof setInterval>;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    try {
      const state = JSON.parse(readFileSync(join(dir, STATE), 'utf8'));
      if (state.url === links.url) unlinkSync(join(dir, STATE));
    } catch {
      /* another preview or already removed */
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  const shutdown = () => {
    void close();
  };
  timer = setInterval(
    () => {
      if (Date.now() - lastAccess >= (options.idleMs ?? 60 * 60_000)) shutdown();
      else {
        try {
          heartbeat();
        } catch {
          shutdown();
        }
      }
    },
    Math.min(HEARTBEAT_MS, options.idleMs ?? HEARTBEAT_MS),
  );
  timer.unref();
  try {
    heartbeat();
  } catch (e) {
    await close();
    throw e;
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...links, close };
}
