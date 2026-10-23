/**
 * Image models for comic art. Two kinds:
 *  - APIs (OpenAI, Gemini), when the user has a key;
 *  - agent CLIs already on the machine (Codex, Antigravity), which draw with the
 *    image tool of the user's own subscription, so no key is needed.
 * Only story beats and character descriptions are sent, never code, paths or
 * prompts from the logs, and only after the user agrees once per provider.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BEAT_MEANING, type CastMember, type Panel, type SeriesBible } from './types.ts';

export type ProviderId = 'openai' | 'gemini' | 'codex' | 'antigravity';
export const PROVIDERS: ProviderId[] = ['openai', 'gemini', 'codex', 'antigravity'];

export interface Reference {
  mime: string;
  data: Uint8Array;
  /** What the image shows, e.g. "Kit (character reference)". */
  label?: string;
}

/** One image to make. */
export interface ImageJob {
  prompt: string;
  refs: Reference[];
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Where the prompts go, for the consent question. */
  sendsTo: string;
  available: boolean;
  /** Why it isn't available, or how it is set up. */
  detail: string;
}

// ---------------------------------------------------------------- prompts

/** Who a character is, species first, so a human never comes out as an animal. */
function kind(c: CastMember): string {
  return c.species === 'human' ? 'a human person, not an animal' : `a ${c.species}`;
}

function castLine(c: CastMember): string {
  return `${c.name} (${kind(c)}): ${c.description}; main colors ${c.palette.slice(0, 2).join(' and ')}`;
}

export function artPrompt(panel: Panel, bible: SeriesBible, index: number): string {
  const who = panel.characters
    .map((pc) => {
      const c = bible.cast.find((m) => m.id === pc.cast);
      if (!c) return '';
      return `${castLine(c)}, on the ${pc.position}${pc.expression ? `, looking ${pc.expression}` : ''}${pc.pose ? `, ${pc.pose}` : ''}`;
    })
    .filter(Boolean)
    .join('; ');
  return [
    `${bible.style}.`,
    `Panel ${index + 1} of 4 (${BEAT_MEANING[panel.beat]}) of a four-panel comic.`,
    `Scene: ${panel.scene}.`,
    who ? `Characters: ${who}.` : '',
    panel.camera ? `Camera: ${panel.camera} shot.` : '',
    panel.artPrompt ? `${panel.artPrompt}.` : '',
    'Square image. Keep the top third as plain, uncluttered background so speech bubbles can be added later.',
    'Keep every character consistent with the reference images if any are given.',
    `Strictly: ${bible.negative}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A character reference portrait, made once per series and reused by every episode. */
export function castPrompt(c: CastMember, bible: SeriesBible): string {
  return [
    `${bible.style}.`,
    `Character reference portrait of ${castLine(c)}.`,
    'Full body, facing the viewer, friendly neutral pose, centered, plain white background, nothing else in the image.',
    'Square image.',
    `Strictly: ${bible.negative}.`,
  ].join(' ');
}

// ---------------------------------------------------------- availability

/** Where a program is on PATH, if anywhere. */
export function onPath(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(
    process.platform === 'win32' ? ';' : ':',
  )) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return undefined;
}

const codexBin = () => process.env.TRACETOON_CODEX_BIN || onPath('codex');
const agyBin = () => process.env.TRACETOON_AGY_BIN || onPath('agy');
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const openaiKey = () => process.env.OPENAI_API_KEY;

export const OPENAI_MODEL = () =>
  process.env.TRACETOON_OPENAI_MODEL || 'gpt-image-2.5-flare';
export const GEMINI_MODEL = () =>
  process.env.TRACETOON_GEMINI_MODEL || 'gemini-nano-banana-2.1';

export function providerInfo(id: ProviderId): ProviderInfo {
  switch (id) {
    case 'openai':
      return {
        id,
        label: `OpenAI API (${OPENAI_MODEL()})`,
        sendsTo: 'OpenAI, billed to your API key',
        available: !!openaiKey(),
        detail: openaiKey() ? 'OPENAI_API_KEY is set' : 'set OPENAI_API_KEY',
      };
    case 'gemini':
      return {
        id,
        label: `Gemini API (${GEMINI_MODEL()})`,
        sendsTo: 'Google, billed to your API key',
        available: !!geminiKey(),
        detail: geminiKey() ? 'GEMINI_API_KEY is set' : 'set GEMINI_API_KEY',
      };
    case 'codex': {
      const bin = codexBin();
      return {
        id,
        label: 'Codex CLI image tool',
        sendsTo: 'OpenAI through your Codex login (uses your Codex usage limits)',
        available: !!bin,
        detail: bin ? `codex found` : 'install and sign in to the Codex CLI',
      };
    }
    case 'antigravity': {
      const bin = agyBin();
      return {
        id,
        label: 'Antigravity CLI image tool (experimental)',
        sendsTo: 'Google through your Antigravity login (uses your Antigravity quota)',
        available: !!bin,
        detail: bin ? 'agy found' : 'install and sign in to the Antigravity CLI',
      };
    }
  }
}

export function providerAvailable(id: ProviderId): boolean {
  return providerInfo(id).available;
}

// ---------------------------------------------------------------- APIs

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 180_000,
): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/** The first base64 image anywhere in a response, whatever the exact shape. */
export function findImageData(json: unknown): string | undefined {
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    // Interactions API: { type: "image", data }; generateContent: { inlineData: { data } }
    if (o.type === 'image' && typeof o.data === 'string') return o.data;
    for (const k of ['inlineData', 'inline_data']) {
      const d = o[k] as { data?: unknown } | undefined;
      if (d && typeof d.data === 'string') return d.data;
    }
    if (typeof o.b64_json === 'string') return o.b64_json;
    for (const child of Object.values(o).reverse()) stack.push(child);
  }
  return undefined;
}

/** Gemini image models (Nano Banana family) via the Interactions API. */
async function gemini(job: ImageJob): Promise<Uint8Array> {
  const body = {
    model: GEMINI_MODEL(),
    input: [
      { type: 'text', text: job.prompt },
      ...job.refs.slice(0, 14).map((r) => ({
        type: 'image',
        mime_type: r.mime,
        data: Buffer.from(r.data).toString('base64'),
      })),
    ],
    response_format: { type: 'image', aspect_ratio: '1:1', image_size: '1K' },
  };
  const json = await fetchJson(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey()! },
      body: JSON.stringify(body),
    },
  );
  const data = findImageData(json);
  if (!data)
    throw new Error('Gemini returned no image (it may have declined the prompt).');
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** OpenAI image models: generations, or edits when there are reference images. */
async function openai(job: ImageJob): Promise<Uint8Array> {
  const key = openaiKey()!;
  let json: unknown;
  if (job.refs.length) {
    const form = new FormData();
    form.append('model', OPENAI_MODEL());
    form.append('prompt', job.prompt);
    form.append('size', '1024x1024');
    job.refs
      .slice(0, 8)
      .forEach((r, i) =>
        form.append('image[]', new Blob([r.data], { type: r.mime }), `ref${i}.png`),
      );
    json = await fetchJson('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
  } else {
    json = await fetchJson('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL(),
        prompt: job.prompt,
        size: '1024x1024',
        n: 1,
      }),
    });
  }
  const b64 = findImageData(json);
  if (!b64) throw new Error('OpenAI returned no image.');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------- agent CLIs

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    // Script stand-ins (tests) run with this runtime. Windows .cmd shims need a
    // shell, so every argument we pass is a plain flag or a quoted path; long
    // prompts always go through stdin or a file, never the command line.
    const script = /\.(ts|js|mjs)$/i.test(bin);
    const shell = !script && process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const quoted = shell
      ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a))
      : args;
    const child = spawn(
      script ? process.execPath : bin,
      script ? [bin, ...quoted] : quoted,
      {
        cwd,
        shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolveRun({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      resolveRun({ code: -1, stdout, stderr: stderr + String(e) });
    });
  });
}

/** Write references to files an agent CLI can attach or open. */
function writeRefs(dir: string, refs: Reference[]): { path: string; label: string }[] {
  return refs.map((r, i) => {
    const ext =
      r.mime === 'image/jpeg' ? 'jpg' : r.mime === 'image/webp' ? 'webp' : 'png';
    const path = join(dir, `reference-${i + 1}.${ext}`);
    writeFileSync(path, r.data);
    return { path, label: r.label ?? `reference ${i + 1}` };
  });
}

/** The instructions an agent CLI gets: draw each prompt with its image tool, in order. */
export function agentBatchPrompt(
  jobs: ImageJob[],
  refLabels: string[],
  saveTo?: string[],
): string {
  const lines = [
    `Use your image generation tool to make ${jobs.length} separate image(s), one for each numbered prompt below, in order.`,
    refLabels.length
      ? `The attached images are references: ${refLabels.map((l, i) => `image ${i + 1} is ${l}`).join('; ')}. Keep every character exactly consistent with them, and keep the images consistent with each other.`
      : 'Keep the characters and style consistent across all images.',
    'Do not edit any files, do not run commands other than what is needed to save the images, and do not add text to the images.',
    saveTo
      ? 'Save each image to the exact path given with its prompt.'
      : 'When all images are done, reply with only their absolute file paths, one per line, in order.',
    '',
    ...jobs.map(
      (j, i) => `${i + 1}. ${j.prompt}${saveTo ? `\n   Save to: ${saveTo[i]}` : ''}`,
    ),
  ];
  return lines.filter((l, i) => l !== '' || i > 0).join('\n');
}

function imagesIn(dir: string, since = 0): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_EXT.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).mtimeMs >= since)
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/**
 * Codex CLI: one `codex exec` session draws every job with the built-in image
 * tool (gpt-image through the user's Codex login). Images land in
 * $CODEX_HOME/generated_images/<thread id>/.
 */
async function codexBatch(jobs: ImageJob[]): Promise<Uint8Array[]> {
  const bin = codexBin();
  if (!bin) throw new Error('The Codex CLI is not installed.');
  const work = mkdtempSync(join(tmpdir(), 'tracetoon-codex-'));
  const refs = writeRefs(work, jobs[0]?.refs ?? []);
  const prompt = agentBatchPrompt(
    jobs,
    refs.map((r) => r.label),
  );
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json'];
  for (const r of refs) args.push('--image', r.path);
  args.push('-'); // read the prompt from stdin
  const res = await run(bin, args, work, 20 * 60_000, prompt);
  const events = res.stdout.split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const thread = events.find((e) => e.type === 'thread.started')?.thread_id as
    string | undefined;
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  let files = thread ? imagesIn(join(home, 'generated_images', thread)) : [];
  if (files.length < jobs.length) {
    // Fall back to the paths Codex printed.
    const said = events
      .filter((e) => e.type === 'item.completed')
      .map((e) => (e.item as { type?: string; text?: string } | undefined) ?? {})
      .filter((i) => i.type === 'agent_message')
      .flatMap((i) => (i.text ?? '').split(/\r?\n/))
      .map((l) => l.trim().replace(/^[-*\d.\s`]+|`$/g, ''))
      .filter((l) => IMAGE_EXT.test(l) && existsSync(l));
    if (said.length > files.length) files = said;
  }
  if (files.length < jobs.length) {
    const why =
      res.code === 0
        ? ''
        : ` (codex exited ${res.code}: ${res.stderr.trim().split('\n').pop() ?? ''})`;
    throw new Error(`Codex made ${files.length} of ${jobs.length} image(s)${why}.`);
  }
  return files.slice(-jobs.length).map((f) => new Uint8Array(readFileSync(f)));
}

/**
 * Antigravity CLI (experimental): `agy -p` draws each job with its image tool
 * and saves it to a path we give, inside a scratch folder it works in.
 */
async function antigravityBatch(jobs: ImageJob[]): Promise<Uint8Array[]> {
  const bin = agyBin();
  if (!bin) throw new Error('The Antigravity CLI is not installed.');
  const work = mkdtempSync(join(tmpdir(), 'tracetoon-agy-'));
  const out = join(work, 'out');
  mkdirSync(out, { recursive: true });
  const refs = writeRefs(work, jobs[0]?.refs ?? []);
  const saveTo = jobs.map((_, i) => join(out, `image-${i + 1}.png`));
  const labels = refs.map((r) => `${r.label} (${r.path})`);
  const prompt = agentBatchPrompt(jobs, labels, saveTo);
  // agy needs permission to use its tools without a person at the keyboard;
  // it runs in an empty scratch folder with only the reference images.
  writeFileSync(join(work, 'prompt.md'), prompt, 'utf8');
  const res = await run(
    bin,
    [
      '-p',
      'Read prompt.md in the current folder and do exactly what it says.',
      '--dangerously-skip-permissions',
    ],
    work,
    20 * 60_000,
  );
  const files = saveTo.filter((p) => existsSync(p));
  if (files.length < jobs.length) {
    const extra = imagesIn(out).filter((p) => !files.includes(p));
    files.push(...extra);
  }
  if (files.length < jobs.length) {
    throw new Error(
      `Antigravity made ${files.length} of ${jobs.length} image(s)${res.code ? ` (agy exited ${res.code})` : ''}.`,
    );
  }
  return files.slice(0, jobs.length).map((f) => new Uint8Array(readFileSync(f)));
}

// ---------------------------------------------------------------- entry

/** Make one image per job. API providers go one by one; agent CLIs do all in one session. */
export async function generateImages(
  id: ProviderId,
  jobs: ImageJob[],
): Promise<Uint8Array[]> {
  if (!jobs.length) return [];
  // Tests replace the network with a local stand-in.
  if (process.env.TRACETOON_FAKE_IMAGE) {
    return jobs.map(
      () => new Uint8Array(readFileSync(process.env.TRACETOON_FAKE_IMAGE!)),
    );
  }
  if (id === 'codex') return codexBatch(jobs);
  if (id === 'antigravity') return antigravityBatch(jobs);
  const out: Uint8Array[] = [];
  for (const job of jobs)
    out.push(id === 'gemini' ? await gemini(job) : await openai(job));
  return out;
}

/** Sniff an image's type from its first bytes. */
export function imageMime(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57) return 'image/webp';
  return 'image/png';
}
