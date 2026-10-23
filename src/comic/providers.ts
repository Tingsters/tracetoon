/**
 * Image models for panel art, used when the host agent can't draw images itself.
 * Only story beats and character descriptions are sent, never code, paths or
 * prompts from the logs, and only after the user agrees once per provider.
 */
import { BEAT_MEANING, type Panel, type SeriesBible } from './types.ts';

export type ProviderId = 'gemini' | 'openai';

export interface Reference {
  mime: string;
  data: Uint8Array;
}

export function artPrompt(panel: Panel, bible: SeriesBible, index: number): string {
  const who = panel.characters
    .map((pc) => {
      const c = bible.cast.find((m) => m.id === pc.cast);
      if (!c) return '';
      return `${c.name} (${c.description}; main colors ${c.palette.slice(0, 2).join(' and ')}) on the ${pc.position}${pc.expression ? `, looking ${pc.expression}` : ''}${pc.pose ? `, ${pc.pose}` : ''}`;
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

export function providerAvailable(id: ProviderId): boolean {
  return id === 'gemini'
    ? !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
    : !!process.env.OPENAI_API_KEY;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 120_000,
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

/** Gemini image models (Nano Banana family) via the Generative Language API. */
async function gemini(prompt: string, refs: Reference[]): Promise<Uint8Array> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = process.env.TRACETOON_GEMINI_MODEL || 'gemini-3.1-flash-image';
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          ...refs.map((r) => ({
            inline_data: {
              mime_type: r.mime,
              data: Buffer.from(r.data).toString('base64'),
            },
          })),
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    },
  };
  const json = (await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key! },
      body: JSON.stringify(body),
    },
  )) as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[];
      };
    }[];
  };
  for (const part of json.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data ?? part.inline_data?.data;
    if (data) return new Uint8Array(Buffer.from(data, 'base64'));
  }
  throw new Error('Gemini returned no image (it may have declined the prompt).');
}

/** OpenAI image models: generations, or edits when there are reference images. */
async function openai(prompt: string, refs: Reference[]): Promise<Uint8Array> {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.TRACETOON_OPENAI_MODEL || 'gpt-image-2';
  let json: unknown;
  if (refs.length) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    refs
      .slice(0, 4)
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
      body: JSON.stringify({ model, prompt, size: '1024x1024', n: 1 }),
    });
  }
  const b64 = (json as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image.');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function generateImage(
  id: ProviderId,
  prompt: string,
  refs: Reference[] = [],
): Promise<Uint8Array> {
  // Tests replace the network with a local stand-in.
  if (process.env.TRACETOON_FAKE_IMAGE) {
    const { readFileSync } = await import('node:fs');
    return new Uint8Array(readFileSync(process.env.TRACETOON_FAKE_IMAGE));
  }
  return id === 'gemini' ? gemini(prompt, refs) : openai(prompt, refs);
}
