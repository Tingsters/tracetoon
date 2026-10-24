/**
 * `tracetoon images`: the image routes for comics on this machine, whether each
 * can draw and is approved, and the next step. `--approve` records the user's
 * OK; `--test` draws one small picture (no repo content) to prove a route works
 * before a real PR depends on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  generateImages,
  PROVIDERS,
  providerInfo,
  type ProviderId,
} from '../comic/providers.ts';
import { nextStep, routeStatuses, usable, type RouteStatus } from '../comic/routes.ts';
import { loadConfig, setUserConfig, userConfigPath } from '../config.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export interface ImagesOpts extends OutOpts {
  approve?: string;
  /** A route to test, or `true` to test the route given to --approve. */
  test?: string | boolean;
  consent?: boolean;
  /** One line, for the installers. */
  brief?: boolean;
}

const TEST_PROMPT =
  'A small friendly cartoon robot waving hello, simple flat colors, plain white background. No text, no letters.';
const TEST_TIMEOUT_MS = 5 * 60_000;

function routeId(raw: string): ProviderId {
  if (!PROVIDERS.includes(raw as ProviderId))
    throw new UserError(
      `Unknown image route "${raw}". Use one of: ${PROVIDERS.join(', ')}.`,
    );
  return raw as ProviderId;
}

function approve(id: ProviderId): void {
  const have = loadConfig().imageConsent;
  if (!have.includes(id)) setUserConfig('imageConsent', [...have, id].join(','));
}

const mark = (r: RouteStatus) =>
  !r.available
    ? 'not found'
    : r.ready === 'not ready'
      ? "found, can't draw"
      : r.ready === 'ready'
        ? 'ready'
        : 'found (untested)';

export async function imagesCmd(opts: ImagesOpts): Promise<void> {
  let tested:
    | { route: ProviderId; ok: boolean; image?: string; seconds: number; error?: string }
    | undefined;

  if (opts.approve) {
    const id = routeId(opts.approve);
    const info = providerInfo(id);
    if (!info.available || info.ready === 'not ready')
      throw new UserError(`${info.label} can't draw: ${info.detail}.`);
    approve(id);
  }

  if (opts.test !== undefined && opts.test !== false) {
    // `--approve codex --test` tests the route just approved.
    const id = routeId(typeof opts.test === 'string' ? opts.test : (opts.approve ?? ''));
    const info = providerInfo(id);
    if (!info.available || info.ready === 'not ready')
      throw new UserError(`${info.label} can't draw: ${info.detail}.`);
    if (!loadConfig().imageConsent.includes(id)) {
      if (!opts.consent)
        throw new UserError(
          `Testing ${info.label} sends a fixed test prompt (no code, no repo content) to ${info.sendsTo}. Ask the user once, then re-run with --consent (this also approves it for comics).`,
          4,
        );
      approve(id);
    }
    const started = Date.now();
    try {
      const [img] = await Promise.race([
        generateImages(id, [{ prompt: TEST_PROMPT, refs: [], aspect: '1:1' }]),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('no image after 5 minutes')),
            TEST_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
      const image = join(dirname(userConfigPath()), `test-${id}.png`);
      mkdirSync(dirname(image), { recursive: true });
      writeFileSync(image, img!);
      tested = {
        route: id,
        ok: true,
        image,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    } catch (e) {
      tested = {
        route: id,
        ok: false,
        seconds: Math.round((Date.now() - started) / 1000),
        error: (e as Error).message,
      };
    }
  }

  const routes = routeStatuses();
  const next = nextStep(routes);
  if (opts.brief) {
    emit(opts, { routes, next }, () =>
      next.text.startsWith('Comics') ? next.text : `Comics: ${next.text}`,
    );
    return;
  }
  emit(opts, { routes, next, tested }, () =>
    [
      'Image routes for comics (first usable approved one is used):',
      ...routes.map(
        (r) =>
          `  ${r.id.padEnd(12)} ${mark(r).padEnd(18)} ${(r.approved ? 'approved' : 'not approved').padEnd(12)}  ${r.detail}${usable(r) ? `; ${r.cost}` : ''}`,
      ),
      tested
        ? tested.ok
          ? `Test: ${tested.route} drew a picture in ${tested.seconds}s -> ${tested.image}`
          : `Test: ${tested.route} failed after ${tested.seconds}s: ${tested.error}`
        : '',
      `Next: ${next.text}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  if (tested && !tested.ok) process.exitCode = 1;
}
