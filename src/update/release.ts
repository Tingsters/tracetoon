/** Finding the release to install: GitHub's releases list, or a test server named by TRACETOON_UPDATE_URL. */
import { compareVersions, isPrerelease, parseVersion } from './version.ts';

export interface Release {
  tag: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  notes: string;
}

export type Channel = 'stable' | 'latest';

const REPO = 'Tingsters/tracetoon';

export function sources(env: NodeJS.ProcessEnv = process.env) {
  const base = env.TRACETOON_UPDATE_URL?.replace(/\/+$/, '');
  return base
    ? {
        list: `${base}/releases`,
        download: (tag: string, file: string) => `${base}/download/${tag}/${file}`,
      }
    : {
        list: `https://api.github.com/repos/${REPO}/releases?per_page=30`,
        download: (tag: string, file: string) =>
          `https://github.com/${REPO}/releases/download/${tag}/${file}`,
      };
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'tracetoon-update', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

export const fetchText = async (url: string) => (await get(url)).text();
export const fetchBytes = async (url: string) =>
  new Uint8Array(await (await get(url)).arrayBuffer());

/** Parse a releases list. Drafts and tags that are not versions are skipped. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) return [];
  const out: Release[] = [];
  for (const r of json as Record<string, unknown>[]) {
    const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
    if (!parseVersion(tag) || r.draft || typeof r.published_at !== 'string') continue;
    out.push({
      tag,
      version: tag.replace(/^v/, ''),
      prerelease: r.prerelease === true || isPrerelease(tag),
      publishedAt: r.published_at,
      notes: typeof r.body === 'string' ? r.body : '',
    });
  }
  return out;
}

/**
 * The newest published release in the channel. GitHub lists by tag name (rc.10 before
 * rc.2), so order by publish time, with the version breaking ties.
 */
export function pickRelease(releases: Release[], channel: Channel): Release | undefined {
  return releases
    .filter((r) => channel === 'latest' || !r.prerelease)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) || compareVersions(b.tag, a.tag),
    )[0];
}

export async function listReleases(env: NodeJS.ProcessEnv = process.env) {
  return parseReleases(JSON.parse(await fetchText(sources(env).list)));
}
